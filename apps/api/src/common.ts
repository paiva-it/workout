import { createHash, randomUUID } from 'node:crypto';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { isValidTimeZone } from '@workout/contracts';

export interface AuthedUser { id: string; username: string; timezone: string; restTimerEnabled: boolean }
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { id: string; user?: AuthedUser; authSessionId?: string }
  }
}

export class ApiException extends HttpException {
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super({ code, message, ...extra }, status);
  }
}
export const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>) => new ApiException(status, code, message, extra);

export function sendError(req: Request, res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  res.status(status).set('Cache-Control', 'no-store').json({ code, message, ...extra, requestId: req.id });
}

@Catch()
export class JsonErrorFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<Request>();
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof HttpException) {
      const body = err.getResponse();
      if (typeof body === 'object' && body && 'code' in body) return void res.status(err.getStatus()).json({ ...body, requestId: req.id });
      const status = err.getStatus();
      return sendError(req, res, status, status === 404 ? 'NOT_FOUND' : 'HTTP_' + status, status === 404 ? 'Not found' : err.message);
    }
    // Never echo internals; log only the error, not request bodies (they may hold passwords/notes).
    console.error(`[${req.id}]`, err instanceof Error ? err.stack : err);
    sendError(req, res, 500, 'INTERNAL', 'Unexpected server error');
  }
}

export function requestId(req: Request, res: Response, next: NextFunction) {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const fieldErrors: Record<string, string> = {};
  for (const i of r.error.issues) fieldErrors[i.path.join('.') || '_'] = i.message;
  throw fail(422, 'VALIDATION', 'Invalid input', { fieldErrors });
}

/** Sorted-key JSON: identical content -> identical string regardless of key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return '{' + Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hashPayload = (v: unknown) => sha256(canonicalJson(v));

// Shared zod pieces
export const zUuid = z.uuid();
export const zTz = z.string().max(64).refine(isValidTimeZone, 'Unknown IANA timezone');
export const zIso = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
export const zLocalDate = z.iso.date();
export const zNote = (max = 1000) => z.string().trim().max(max).nullable().transform((s) => (s ? s : null));
export const zInt = (min: number, max: number) => z.number().int().min(min).max(max);
