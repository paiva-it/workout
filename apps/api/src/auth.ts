import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import argon2 from 'argon2';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AuthSession, User } from './db.js';
import { fail, parse, sendError, sha256 } from './common.js';

// OWASP-compliant starting point; benchmarked on the host (see README).
export const ARGON2 = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
const SESSION_MS = 7 * 24 * 3600 * 1000;
const secureCookies = () => process.env.COOKIE_SECURE !== 'false';
export const cookieName = () => (secureCookies() ? '__Host-workout_sid' : 'workout_sid');
const allowedOrigins = () => (process.env.APP_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const hashPassword = (pw: string) => argon2.hash(pw, ARGON2);
let dummyHash: Promise<string> | undefined;

// ponytail: in-memory limiter, fine for one app container; move to Mongo TTL docs if this ever scales out.
const attempts = new Map<string, number[]>();
const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { ip: Number(process.env.LOGIN_LIMIT_IP ?? 20), user: Number(process.env.LOGIN_LIMIT_USER ?? 8) };
function limited(key: string, max: number) {
  const now = Date.now();
  const xs = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, xs);
  return xs.length >= max;
}
const record = (key: string) => attempts.get(key)!.push(Date.now());

const PUBLIC = new Set(['POST /api/v1/auth/login', 'GET /api/v1/health/live', 'GET /api/v1/health/ready']);
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Origin + session + CSRF gate for every /api route. Runs before Nest routing. */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  res.set('Cache-Control', 'no-store');
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (mutating) {
    const origin = req.get('origin');
    if (!origin || !allowedOrigins().includes(origin)) return sendError(req, res, 403, 'ORIGIN', 'Origin not allowed');
    if (!req.is('application/json')) return sendError(req, res, 415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }
  if (PUBLIC.has(`${req.method} ${req.baseUrl}${req.path}`)) return next(); // mounted at /api, so path is relative
  try {
    const token = req.cookies?.[cookieName()];
    if (typeof token !== 'string' || token.length < 40) return sendError(req, res, 401, 'UNAUTHENTICATED', 'Sign in required');
    // Explicit expiry/revocation check: Mongo's TTL cleaner is asynchronous.
    const s = await AuthSession.findOne({ _id: sha256(token), revokedAt: null, expiresAt: { $gt: new Date() } }).lean();
    if (!s) return sendError(req, res, 401, 'UNAUTHENTICATED', 'Sign in required');
    if (mutating && !safeEq(String(req.get('x-csrf-token') ?? ''), s.csrfToken)) return sendError(req, res, 403, 'CSRF', 'Missing or invalid CSRF token');
    const u = await User.findById(s.userId).lean();
    if (!u) return sendError(req, res, 401, 'UNAUTHENTICATED', 'Sign in required');
    req.user = { id: u._id!, username: u.username, timezone: u.timezone, restTimerEnabled: u.restTimerEnabled };
    req.authSessionId = String(s._id);
    next();
  } catch (e) {
    next(e);
  }
}

export function safeUser(u: Record<string, unknown>) {
  const { _id, passwordHash: _p, ...rest } = u;
  void _p;
  return { id: _id, ...rest };
}

const LoginDto = z.strictObject({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(1024) });
const PasswordDto = z.strictObject({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(10, 'Use at least 10 characters').max(1024) });

@Controller('auth')
export class AuthController {
  @Post('login')
  @HttpCode(200)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const { username, password } = parse(LoginDto, body); // password is never trimmed
    const name = username.toLowerCase();
    const ipKey = `ip:${req.ip}`, userKey = `user:${name}`;
    if (limited(ipKey, LIMITS.ip) || limited(userKey, LIMITS.user)) throw fail(429, 'RATE_LIMITED', 'Too many attempts. Try again in a few minutes.');
    const u = await User.findOne({ username: name }).select('+passwordHash').lean();
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    const ok = u ? await argon2.verify(u.passwordHash, password) : (await argon2.verify(await dummyHash, password), false);
    if (!u || !ok) {
      record(ipKey); record(userKey);
      throw fail(401, 'INVALID_CREDENTIALS', 'Incorrect username or password');
    }
    attempts.delete(userKey);
    if (argon2.needsRehash(u.passwordHash, ARGON2)) await User.updateOne({ _id: u._id }, { passwordHash: await hashPassword(password) });
    // Rotate: any session cookie presented at login is revoked.
    const old = req.cookies?.[cookieName()];
    if (typeof old === 'string') await AuthSession.updateOne({ _id: sha256(old) }, { revokedAt: new Date() });
    const csrfToken = await issueSession(res, String(u._id));
    const { passwordHash: _h, ...user } = u;
    void _h;
    return { user: safeUser(user), csrfToken };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const [u, s] = await Promise.all([User.findById(req.user!.id).lean(), AuthSession.findById(req.authSessionId).lean()]);
    return { user: safeUser(u!), csrfToken: s!.csrfToken };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await AuthSession.updateOne({ _id: req.authSessionId }, { revokedAt: new Date() });
    res.clearCookie(cookieName(), cookieOpts());
    return { ok: true };
  }

  @Post('password')
  @HttpCode(200)
  async password(@Req() req: Request, @Body() body: unknown) {
    const { currentPassword, newPassword } = parse(PasswordDto, body);
    const u = await User.findById(req.user!.id).select('+passwordHash').lean();
    if (!u || !(await argon2.verify(u.passwordHash, currentPassword))) throw fail(422, 'INVALID_CREDENTIALS', 'Current password is incorrect', { fieldErrors: { currentPassword: 'Incorrect password' } });
    await User.updateOne({ _id: u._id }, { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() });
    const { modifiedCount } = await AuthSession.updateMany({ userId: u._id, _id: { $ne: req.authSessionId }, revokedAt: null }, { revokedAt: new Date() });
    console.info(`[${req.id}] password changed for user ${u._id}; revoked ${modifiedCount} other sessions`);
    return { ok: true, revokedSessions: modifiedCount };
  }
}

const cookieOpts = () => ({ httpOnly: true, secure: secureCookies(), sameSite: 'lax' as const, path: '/' });
async function issueSession(res: Response, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_MS);
  await AuthSession.create({ _id: sha256(token), userId, csrfToken, expiresAt });
  res.cookie(cookieName(), token, { ...cookieOpts(), expires: expiresAt });
  return csrfToken;
}

/** CLI-only: create the user if absent. Existing user => untouched (never resets a password). */
export async function bootstrapUser(username: string, password: string, displayName = '') {
  const name = username.trim().toLowerCase();
  if (await User.exists({ username: name })) return { created: false };
  await User.create({ _id: randomUUID(), username: name, passwordHash: await hashPassword(password), displayName, program: { programId: null, startDate: null, heldPhaseIndex: null } });
  return { created: true };
}
export async function resetPassword(username: string, password: string) {
  const u = await User.findOne({ username: username.trim().toLowerCase() }).lean();
  if (!u) return false;
  await User.updateOne({ _id: u._id }, { passwordHash: await hashPassword(password), passwordChangedAt: new Date() });
  await AuthSession.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
  return true;
}
