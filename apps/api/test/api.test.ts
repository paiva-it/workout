/**
 * Black-box integration tests: the compiled server (dist/main.js) against a real, throwaway MongoDB database.
 * Needs TEST_MONGO_URI (default mongodb://127.0.0.1:27118) — see README. Synthetic user and data only.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const API = new URL('../', import.meta.url).pathname;
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://localhost:5173';
const DB = `workout_test_${Date.now()}`;
const MONGO_URI = `${process.env.TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27118'}/${DB}`;
const USER = 'tester', PASSWORD = 'correct horse battery';
const env = { ...process.env, MONGO_URI, PORT: String(PORT), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', TRUST_PROXY: 'loopback', LOGIN_LIMIT_IP: '30', LOGIN_LIMIT_USER: '8' };
const pack = JSON.parse(readFileSync(new URL('data/training-pack.v1.json', ROOT), 'utf8'));
let server: ChildProcess;

const cli = (args: string[], input = '') => spawnSync('node', ['dist/cli.js', ...args], { cwd: API, env, input, encoding: 'utf8' });

class Client {
  cookie = '';
  csrf = '';
  constructor(public ip = '10.0.0.1') {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(BASE + '/api/v1' + path, {
      method,
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': this.ip, ...(this.cookie && { cookie: this.cookie }), ...(this.csrf && { 'x-csrf-token': this.csrf }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(';');
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await r.text();
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers, setCookie: r.headers.getSetCookie() };
  }
  async login(password = PASSWORD) {
    const r = await this.req('POST', '/auth/login', { username: USER, password });
    if (r.status === 200) this.csrf = r.body.csrfToken;
    return r;
  }
}
const op = (c: Client, id: string, rev: number, o: unknown, operationId: string = randomUUID()) => c.req('PATCH', `/sessions/${id}`, { operationId, expectedRevision: rev, op: o });

beforeAll(async () => {
  expect(cli(['import-pack', '../../data/training-pack.v1.json']).status).toBe(0);
  expect(cli(['bootstrap-user'], `BOOTSTRAP_USERNAME=${USER}\nBOOTSTRAP_PASSWORD=${PASSWORD}\n`).stdout).toContain('user created');
  server = spawn('node', ['dist/main.js'], { cwd: API, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr!.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/v1/health/ready')).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await mongoose.connect(MONGO_URI);
}, 30_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await mongoose.connection.db?.dropDatabase();
  await mongoose.disconnect();
});

async function restartServer() {
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
  server = spawn('node', ['dist/main.js'], { cwd: API, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/v1/health/ready')).ok) return; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('auth and security', () => {
  it('logs in with the bootstrapped credentials, Argon2id stored, cookie attributes set', async () => {
    const c = new Client();
    const r = await c.login();
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('passwordHash');
    expect(r.setCookie[0]).toMatch(/^workout_sid=[\w-]{43};.*HttpOnly/i);
    expect(r.setCookie[0]).toMatch(/SameSite=Lax/i);
    expect(r.setCookie[0]).toMatch(/Path=\//);
    const raw = await mongoose.connection.db!.collection('users').findOne({ username: USER });
    expect(raw!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    const sess = await mongoose.connection.db!.collection('authSessions').findOne({});
    expect(sess!._id).toMatch(/^[0-9a-f]{64}$/); // only the digest is stored
    expect(r.setCookie[0]).not.toContain(sess!._id);
  });

  it('wrong password and unknown user get the same generic error', async () => {
    const a = await new Client('10.1.0.1').login('nope nope nope');
    const b = await new Client('10.1.0.1').req('POST', '/auth/login', { username: 'ghost', password: 'x' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
    expect(a.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('bootstrapping again never changes the password', async () => {
    expect(cli(['bootstrap-user'], `BOOTSTRAP_USERNAME=${USER}\nBOOTSTRAP_PASSWORD=something-else-entirely\n`).stdout).toContain('unchanged');
    expect((await new Client().login()).status).toBe(200);
  });

  it('public endpoints reveal nothing; private ones need a session', async () => {
    const anon = new Client();
    expect((await anon.req('GET', '/health/live')).body).toEqual({ status: 'ok' });
    for (const p of ['/plans', '/today', '/sessions', '/body-measurements', '/exports/personal.json', '/auth/me']) expect((await anon.req('GET', p)).status).toBe(401);
    expect((await anon.req('POST', '/auth/register', { username: 'x', password: 'y' })).status).toBe(401);
  });

  it('rejects missing CSRF and foreign Origin; requires JSON', async () => {
    const c = new Client();
    await c.login();
    const noCsrf = await c.req('POST', '/auth/logout', {}, { 'x-csrf-token': 'wrong' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF');
    const evil = await c.req('POST', '/auth/logout', {}, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.body.code).toBe('ORIGIN');
    const loginCsrf = await new Client().req('POST', '/auth/login', { username: USER, password: PASSWORD }, { origin: 'https://evil.example' });
    expect(loginCsrf.status).toBe(403);
    const form = await fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: `username=${USER}&password=x` });
    expect(form.status).toBe(415);
  });

  it('logout and expired sessions are rejected even before TTL cleanup', async () => {
    const c = new Client();
    await c.login();
    const cookie = c.cookie;
    expect((await c.req('POST', '/auth/logout', {})).status).toBe(200);
    expect((await fetch(BASE + '/api/v1/auth/me', { headers: { cookie } })).status).toBe(401);
    const d = new Client();
    await d.login();
    await mongoose.connection.db!.collection('authSessions').updateMany({ revokedAt: null }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await d.req('GET', '/auth/me')).status).toBe(401);
  });

  it('password change revokes other sessions; then it can be restored', async () => {
    const a = new Client(), b = new Client();
    await a.login(); await b.login();
    const ch = await a.req('POST', '/auth/password', { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' });
    expect(ch.status).toBe(200);
    expect((await b.req('GET', '/auth/me')).status).toBe(401);
    expect((await a.req('GET', '/auth/me')).status).toBe(200);
    expect((await a.req('POST', '/auth/password', { currentPassword: 'a brand new passphrase', newPassword: PASSWORD })).status).toBe(200);
  });

  it('throttles by account, and by client IP taken only from the trusted proxy hop', async () => {
    for (let i = 0; i < 30; i++) await new Client('10.9.9.9').req('POST', '/auth/login', { username: `nobody${i}`, password: 'x' });
    expect((await new Client('10.9.9.9').req('POST', '/auth/login', { username: 'nobody-x', password: 'x' })).status).toBe(429);
    expect((await new Client('10.9.9.10').req('POST', '/auth/login', { username: 'nobody-y', password: 'x' })).status).toBe(401);
  });

  it('unknown API routes are JSON 404s, not the SPA', async () => {
    const c = new Client();
    await c.login();
    const r = await c.req('GET', '/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NOT_FOUND');
    expect(r.body.requestId).toBeTruthy();
  });
});

describe('catalog import', () => {
  let c: Client;
  beforeAll(async () => { c = new Client('10.2.0.1'); await c.login(); });

  it('serves all 8 plans, 21 exercises and 2 programs from MongoDB', async () => {
    expect((await c.req('GET', '/plans')).body).toHaveLength(8);
    expect((await c.req('GET', '/exercises')).body).toHaveLength(21);
    expect((await c.req('GET', '/programs')).body).toHaveLength(2);
    const plan = await c.req('GET', '/plans/restart-a');
    expect(Object.keys(plan.body.videos)).toHaveLength(20);
  });

  it('same version + same content is a no-op; different content is 409; broken refs never activate', async () => {
    const same = await c.req('POST', '/plan-imports/preview', { pack });
    expect(same.body.status).toBe('noop');
    const changed = structuredClone(pack);
    changed.plans[0].items[0].workingSets = 3;
    const pv = await c.req('POST', '/plan-imports/preview', { pack: changed });
    expect(pv.body.status).toBe('conflict');
    const imp = await c.req('POST', '/plan-imports', { pack: changed, expectedCatalogRevision: pv.body.catalogRevision, previewHash: pv.body.contentHash });
    expect(imp.status).toBe(409);
    const broken = structuredClone(pack);
    broken.version = 2;
    broken.plans[0].items[0].exerciseId = 'does-not-exist';
    const bp = await c.req('POST', '/plan-imports/preview', { pack: broken });
    expect(bp.body.status).toBe('invalid');
    expect(bp.body.errors.join()).toContain('Missing exercise');
    const html = structuredClone(pack);
    html.version = 2;
    html.plans[0].name = '<img src=x onerror=alert(1)>';
    expect((await c.req('POST', '/plan-imports/preview', { pack: html })).body.status).toBe('invalid');
    expect((await c.req('POST', '/plan-imports/preview', { pack: { ...pack, extra: 1 } })).body.status).toBe('invalid');
  });

  it('a higher version with a new plan appears without code changes and leaves existing sessions untouched', async () => {
    const start = await c.req('POST', '/sessions', { clientSessionId: randomUUID(), planId: 'restart-a', planVersion: 1, packId: pack.packId, packVersion: 1, timezone: 'Europe/Lisbon', applyProgram: false });
    expect(start.status).toBe(201);
    const v2 = structuredClone(pack);
    v2.version = 2;
    const a = v2.plans.find((p: { id: string }) => p.id === 'restart-a');
    a.version = 2;
    a.name = 'Restart A v2';
    a.items[0].workingSets = 3;
    v2.plans.push({ ...structuredClone(a), id: 'brand-new-plan', version: 1, name: 'Brand new plan' });
    const pv = await c.req('POST', '/plan-imports/preview', { pack: v2 });
    expect(pv.body.status).toBe('new');
    expect(pv.body.counts.plans).toMatchObject({ new: 2, unchanged: 7 });
    const bad = await c.req('POST', '/plan-imports', { pack: v2, expectedCatalogRevision: pv.body.catalogRevision + 5, previewHash: pv.body.contentHash });
    expect(bad.body.code).toBe('CATALOG_CONFLICT');
    const imp = await c.req('POST', '/plan-imports', { pack: v2, expectedCatalogRevision: pv.body.catalogRevision, previewHash: pv.body.contentHash });
    expect(imp.status).toBe(200);
    expect(imp.body.activated).toBe(true);
    const plans = (await c.req('GET', '/plans')).body;
    expect(plans.map((p: { id: string }) => p.id)).toContain('brand-new-plan');
    expect(plans.find((p: { id: string }) => p.id === 'restart-a').version).toBe(2);
    const s = (await c.req('GET', `/sessions/${start.body.id}`)).body;
    expect(s.planSnapshot.name).toBe('Restart A - squat, push and pull');
    expect(s.planRef).toEqual({ id: 'restart-a', version: 1, packId: pack.packId, packVersion: 1, packSchemaVersion: 1 });
    expect((await c.req('GET', `/plans/restart-a?packId=${pack.packId}&packVersion=1`)).body.plan.version).toBe(1); // old version still resolvable
    await c.req('POST', `/sessions/${s.id}/finish`, { operationId: randomUUID(), expectedRevision: s.revision, outcome: 'abandon' });
  });

  it('rejects a lower pack version and oversized bodies', async () => {
    const pv = await c.req('POST', '/plan-imports/preview', { pack });
    expect(pv.body.status).toBe('conflict'); // v1 is stored and identical, but v2 is active: imports never downgrade
    expect(pv.body.errors[0]).toMatch(/never downgrades/);
    const big = await c.req('POST', '/plan-imports/preview', { pack: { ...pack, description: 'x'.repeat(3_200_000) } });
    expect(big.status).toBe(413);
  });
});

describe('workout logging', () => {
  let c: Client;
  let s: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  beforeAll(async () => {
    c = new Client('10.3.0.1');
    await c.login();
    const me = (await c.req('GET', '/auth/me')).body.user;
    await c.req('PATCH', '/me/program', { expectedRevision: me.revision, programId: 'return-to-training', startDate: new Date().toISOString().slice(0, 10), heldPhaseIndex: 0 });
  });
  const occOf = (id: string) => s.exercises.find((o: { exerciseId: string }) => o.exerciseId === id);
  const apply = async (o: unknown, opId?: string) => {
    const r = await op(c, s.id, s.revision, o, opId);
    if (r.status === 200) s = r.body.session;
    return r;
  };

  it('starts a phase-applied session with pending sets only; replays and second starts are safe', async () => {
    const clientSessionId = randomUUID();
    const body = { clientSessionId, planId: 'restart-a', planVersion: 1, packId: pack.packId, packVersion: 1, timezone: 'Europe/Lisbon' };
    const [r1, r2] = await Promise.all([c.req('POST', '/sessions', body), c.req('POST', '/sessions', body)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 201]);
    expect(r1.body.id).toBe(r2.body.id);
    s = r1.body;
    expect(s.programContext).toMatchObject({ programWeek: 1, workingSetCap: 1, rir: [4, 5], allowOptional: false });
    for (const o of s.exercises) {
      expect(o.sets.every((x: { status: string; actualReps: null }) => x.status === 'pending' && x.actualReps === null && x.actualLoad === null)).toBe(true);
      expect(new Set(o.sets.map((x: { roundIndex: number }) => x.roundIndex)).size).toBe(1);
    }
    const row = occOf('db-supported-row');
    expect(row.sets.map((x: { side: string }) => x.side)).toEqual(['left', 'right']);
    expect(row.appliedPrescription.rir).toEqual([4, 5]);
    expect(occOf('glute-bridge').appliedPrescription.rir).toBeNull();
    const other = await c.req('POST', '/sessions', { ...body, clientSessionId: randomUUID(), planId: 'restart-b' });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: 'ACTIVE_SESSION_EXISTS', activeSessionId: s.id });
    expect((await c.req('POST', '/sessions', { ...body, planId: 'restart-b' })).body.code).toBe('OPERATION_REUSED');
    expect((await c.req('GET', '/sessions/active')).body.session.id).toBe(s.id);
  });

  it('validates actuals: done needs reps and load; blank RIR stays null; bodyweight takes no load', async () => {
    const g = occOf('goblet-squat');
    const set = g.sets[0];
    const base = { type: 'setActual', exerciseOccurrenceId: g.id, setId: set.id, actualDurationSeconds: null, actualRir: null };
    expect((await apply({ ...base, status: 'done', actualReps: null, valueGrams: 10000 })).status).toBe(422);
    expect((await apply({ ...base, status: 'done', actualReps: 12, valueGrams: null })).status).toBe(422);
    expect((await apply({ ...base, status: 'done', actualReps: 12, valueGrams: 10.5 })).status).toBe(422);
    expect((await apply({ ...base, status: 'done', actualReps: 12, valueGrams: 10000, $set: { ownerId: 'x' } })).status).toBe(422);
    const ok = await apply({ ...base, status: 'done', actualReps: 12, valueGrams: 10000 });
    expect(ok.status).toBe(200);
    const saved = occOf('goblet-squat').sets[0];
    expect(saved).toMatchObject({ status: 'done', actualReps: 12, actualRir: null, actualLoad: { basis: 'single_dumbbell', valueGrams: 10000, implementCount: 1 } });
    expect(s.restTimer.durationSeconds).toBe(120);
    const bridge = occOf('glute-bridge');
    expect((await apply({ type: 'setActual', exerciseOccurrenceId: bridge.id, setId: bridge.sets[0].id, status: 'done', actualReps: 12, valueGrams: 5000, actualDurationSeconds: null, actualRir: null })).status).toBe(422);
    expect((await apply({ type: 'setActual', exerciseOccurrenceId: bridge.id, setId: bridge.sets[0].id, status: 'done', actualReps: 0, valueGrams: null, actualDurationSeconds: null, actualRir: null })).status).toBe(422);
    expect((await apply({ type: 'setActual', exerciseOccurrenceId: bridge.id, setId: bridge.sets[0].id, status: 'done', actualReps: 0, failedAttempt: true, valueGrams: null, actualDurationSeconds: null, actualRir: null })).status).toBe(200);
  });

  it('left/right are independent; rest starts only after both sides', async () => {
    const row = occOf('db-supported-row');
    const [l, r] = row.sets;
    await apply({ type: 'updateRestTimer', action: 'clear' });
    await apply({ type: 'setActual', exerciseOccurrenceId: row.id, setId: l.id, status: 'done', actualReps: 12, valueGrams: 10000, actualDurationSeconds: null, actualRir: 3 });
    expect(s.restTimer).toBeNull();
    const right = occOf('db-supported-row').sets[1];
    expect(right).toMatchObject({ status: 'pending', actualReps: null });
    await apply({ type: 'setActual', exerciseOccurrenceId: row.id, setId: r.id, status: 'done', actualReps: 10, valueGrams: 10000, actualDurationSeconds: null, actualRir: null });
    expect(s.restTimer).toMatchObject({ durationSeconds: 90, exerciseOccurrenceId: row.id });
    const sets = occOf('db-supported-row').sets;
    expect(sets.map((x: { actualReps: number }) => x.actualReps)).toEqual([12, 10]);
    expect(sets.map((x: { actualLoad: { implementCount: number } }) => x.actualLoad.implementCount)).toEqual([1, 1]);
  });

  it('operation replay is idempotent; reused ID with other payload is 409; stale revision is a conflict', async () => {
    const bench = occOf('db-bench-press');
    const o = { type: 'setActual', exerciseOccurrenceId: bench.id, setId: bench.sets[0].id, status: 'done', actualReps: 12, valueGrams: 10000, actualDurationSeconds: null, actualRir: 2 };
    const id = randomUUID();
    const rev = s.revision;
    const first = await op(c, s.id, rev, o, id);
    expect(first.status).toBe(200);
    const replay = await op(c, s.id, rev, o, id);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.session.revision).toBe(rev + 1);
    expect((await op(c, s.id, rev, { ...o, actualReps: 11 }, id)).body.code).toBe('OPERATION_REUSED');
    const stale = await op(c, s.id, rev, { type: 'updateWarmup', stepId: 'easy-march', completed: true });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('REVISION_CONFLICT');
    expect(stale.body.session.revision).toBe(rev + 1);
    s = first.body.session;
  });

  it('add/remove pending sets, warm-up sets stay separate, optional work honours the phase', async () => {
    const bench = occOf('db-bench-press');
    await apply({ type: 'addSet', exerciseOccurrenceId: bench.id, setType: 'warmup' });
    await apply({ type: 'addSet', exerciseOccurrenceId: bench.id, setType: 'working' });
    let b = occOf('db-bench-press');
    expect(b.sets.filter((x: { type: string }) => x.type === 'warmup')).toHaveLength(1);
    expect(b.sets.filter((x: { type: string }) => x.type === 'working')).toHaveLength(2);
    expect((await apply({ type: 'removePendingSet', exerciseOccurrenceId: bench.id, setType: 'working', roundIndex: 1 })).status).toBe(409);
    expect((await apply({ type: 'removePendingSet', exerciseOccurrenceId: bench.id, setType: 'working', roundIndex: 2 })).status).toBe(200);
    b = occOf('db-bench-press');
    expect(b.sets.filter((x: { type: string }) => x.type === 'working')).toHaveLength(1);
    const optional = s.planSnapshot.items.find((i: { optional: boolean }) => i.optional);
    if (optional) expect((await apply({ type: 'addOptionalExercise', planItemId: optional.id })).body.code).toBe('PHASE_DISALLOWS_OPTIONAL');
    expect((await apply({ type: 'updateExercise', exerciseOccurrenceId: bench.id, variantKey: 'floor', setup: { inclineSupportHeightMm: null, supportDescription: null, benchAngleDegrees: 0, notes: null } })).status).toBe(200);
  });

  it('pause/resume are idempotent and timed; data survives an API restart', async () => {
    const opId = randomUUID();
    const p1 = await c.req('POST', `/sessions/${s.id}/pause`, { operationId: opId });
    const p2 = await c.req('POST', `/sessions/${s.id}/pause`, { operationId: opId });
    expect(p1.body.session.status).toBe('paused');
    expect(p2.body.session.pauses).toHaveLength(1);
    expect((await c.req('POST', `/sessions/${s.id}/pause`, { operationId: randomUUID() })).body.session.pauses).toHaveLength(1);
    const r = await c.req('POST', `/sessions/${s.id}/resume`, { operationId: randomUUID() });
    expect(r.body.session.status).toBe('in_progress');
    expect(r.body.session.pauses[0].endedAt).toBeTruthy();
    await restartServer();
    const after = await c.req('GET', `/sessions/${s.id}`);
    expect(after.status).toBe(200);
    expect(after.body.exercises.find((o: { exerciseId: string }) => o.exerciseId === 'db-supported-row').sets.map((x: { actualReps: number }) => x.actualReps)).toEqual([12, 10]);
    s = after.body;
  });

  it('partial finish keeps missing work; previous comparable result is found by exercise + variant + basis', async () => {
    const fin = await c.req('POST', `/sessions/${s.id}/finish`, { operationId: randomUUID(), expectedRevision: s.revision, outcome: 'finish' });
    expect(fin.status).toBe(200);
    s = fin.body.session;
    expect(s.status).toBe('partial');
    expect(s.isActive).toBe(false);
    expect(s.elapsedSeconds).toBeGreaterThanOrEqual(s.activeSeconds);
    const pending = s.exercises.flatMap((o: { sets: { status: string }[] }) => o.sets).filter((x: { status: string }) => x.status === 'pending');
    expect(pending.length).toBeGreaterThan(0);
    expect((await op(c, s.id, s.revision, { type: 'updateWarmup', stepId: 'easy-march', completed: true })).body.code).toBe('SESSION_CLOSED');
    const prev = await c.req('GET', '/exercises/db-supported-row/previous?variantKey=standard&loadBasis=per_dumbbell');
    expect(prev.body.previous.sessionId).toBe(s.id);
    expect(prev.body.previous.sets.map((x: { side: string }) => x.side)).toEqual(['left', 'right']);
    expect((await c.req('GET', '/exercises/db-bench-press/previous?variantKey=standard')).body.previous).toBeNull(); // variant changed to floor
  });

  it('corrections need a reason and keep the prior values', async () => {
    const row = s.exercises.find((o: { exerciseId: string }) => o.exerciseId === 'db-supported-row');
    const fix = { type: 'setActual', exerciseOccurrenceId: row.id, setId: row.sets[1].id, status: 'done', actualReps: 11, valueGrams: 10000, actualDurationSeconds: null, actualRir: null };
    expect((await c.req('POST', `/sessions/${s.id}/corrections`, { operationId: randomUUID(), expectedRevision: s.revision, reason: '', operations: [fix] })).status).toBe(422);
    const r = await c.req('POST', `/sessions/${s.id}/corrections`, { operationId: randomUUID(), expectedRevision: s.revision, reason: 'Miscounted right side', operations: [fix] });
    expect(r.status).toBe(200);
    const corr = r.body.session.corrections[0];
    expect(corr.reason).toBe('Miscounted right side');
    expect(corr.before[`set:${row.sets[1].id}`].actualReps).toBe(10);
    expect(corr.after[`set:${row.sets[1].id}`].actualReps).toBe(11);
    expect(r.body.session.isActive).toBe(false);
  });

  it('two dates keep separate sessions; abandoned is not a training day; one session spans midnight with its start date', async () => {
    const start = await c.req('POST', '/sessions', { clientSessionId: randomUUID(), planId: 'restart-b', planVersion: 1, packId: pack.packId, packVersion: 1, timezone: 'Europe/Lisbon', source: 'manual_backfill', startedAt: '2026-10-20T22:30:00Z' });
    expect(start.status).toBe(201);
    expect(start.body).toMatchObject({ localDate: '2026-10-20', startUtcOffsetMinutes: 60, source: 'manual_backfill' });
    const fin = await c.req('POST', `/sessions/${start.body.id}/finish`, { operationId: randomUUID(), expectedRevision: start.body.revision, outcome: 'abandon', endedAt: '2026-10-21T00:10:00Z' });
    expect(fin.body.session).toMatchObject({ status: 'abandoned', localDate: '2026-10-20', elapsedSeconds: 6000 });
    const list = (await c.req('GET', '/sessions')).body.items;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(new Set(list.map((x: { id: string }) => x.id)).size).toBe(list.length);
    expect((await c.req('GET', '/sessions?status=abandoned&from=2026-10-20&to=2026-10-20')).body.items).toHaveLength(1);
  });

  it('timed holds use seconds, never reps', async () => {
    const st = await c.req('POST', '/sessions', { clientSessionId: randomUUID(), planId: 'shoulders-core', planVersion: 1, packId: pack.packId, packVersion: 1, timezone: 'Europe/Lisbon', applyProgram: false });
    const plank = st.body.exercises.find((o: { exerciseId: string }) => o.exerciseId === 'side-plank');
    expect(plank.sets[0].target.metric).toBe('duration');
    const bad = await op(c, st.body.id, st.body.revision, { type: 'setActual', exerciseOccurrenceId: plank.id, setId: plank.sets[0].id, status: 'done', actualReps: 10, actualDurationSeconds: null, valueGrams: null, actualRir: null });
    expect(bad.status).toBe(422);
    const ok = await op(c, st.body.id, st.body.revision, { type: 'setActual', exerciseOccurrenceId: plank.id, setId: plank.sets[0].id, status: 'done', actualReps: null, actualDurationSeconds: 25, valueGrams: null, actualRir: null });
    expect(ok.status).toBe(200);
    await c.req('POST', `/sessions/${st.body.id}/finish`, { operationId: randomUUID(), expectedRevision: ok.body.session.revision, outcome: 'abandon' });
  });
});

describe('body measurements and export', () => {
  let c: Client;
  beforeAll(async () => { c = new Client('10.4.0.1'); await c.login(); });
  const add = (b: Record<string, unknown>) => c.req('POST', '/body-measurements', { clientMeasurementId: randomUUID(), timezone: 'Europe/Lisbon', source: 'scale_measurement', ...b });

  it('keeps two same-day weigh-ins and both DST-repeated 01:30 instants', async () => {
    const a = await add({ massGrams: 80500, measuredAt: '2026-10-25T00:30:00Z' });
    const b = await add({ massGrams: 80000, measuredAt: '2026-10-25T01:30:00Z' });
    expect(a.body).toMatchObject({ localDate: '2026-10-25', utcOffsetMinutes: 60, datePrecision: 'instant' });
    expect(b.body).toMatchObject({ localDate: '2026-10-25', utcOffsetMinutes: 0 });
    const day = (await c.req('GET', '/body-measurements?from=2026-10-25&to=2026-10-25')).body.items;
    expect(day).toHaveLength(2);
  });

  it('date-only self-reports stay date-only; scale entries need a time; bounds enforced; replays dedupe', async () => {
    const self = await add({ source: 'self_report', massGrams: 80000, measuredAt: null, localDate: '2026-10-24' });
    expect(self.body).toMatchObject({ measuredAt: null, datePrecision: 'day', utcOffsetMinutes: null });
    expect((await add({ massGrams: 80000, measuredAt: null, localDate: '2026-10-24' })).status).toBe(422);
    expect((await add({ massGrams: 0, measuredAt: '2026-10-24T08:00:00Z' })).status).toBe(422);
    expect((await add({ massGrams: 80.5, measuredAt: '2026-10-24T08:00:00Z' })).status).toBe(422);
    const id = randomUUID();
    const body = { clientMeasurementId: id, massGrams: 79000, measuredAt: '2026-10-23T07:00:00Z' };
    const [x, y] = await Promise.all([add(body), add(body)]);
    expect(x.body.id).toBe(y.body.id);
    expect((await add({ ...body, massGrams: 78000 })).status).toBe(409);
  });

  it('corrections keep previous values; delete is soft and needs a reason', async () => {
    const m = (await add({ massGrams: 81000, measuredAt: '2026-10-22T07:00:00Z' })).body;
    const p = await c.req('PATCH', `/body-measurements/${m.id}`, { expectedRevision: 1, reason: 'Typo', massGrams: 80800 });
    expect(p.body.corrections[0].previous.massGrams).toBe(81000);
    expect((await c.req('DELETE', `/body-measurements/${m.id}`, { expectedRevision: 2, reason: '' })).status).toBe(422);
    expect((await c.req('DELETE', `/body-measurements/${m.id}`, { expectedRevision: 2, reason: 'Duplicate' })).status).toBe(200);
    const raw = await mongoose.connection.db!.collection('bodyMeasurements').findOne({ _id: m.id as never });
    expect(raw!.deletedAt).toBeTruthy();
  });

  it('timezone change does not regroup stored local dates', async () => {
    const me = (await c.req('GET', '/auth/me')).body.user;
    await c.req('PATCH', '/me/settings', { expectedRevision: me.revision, timezone: 'America/New_York' });
    expect((await c.req('GET', '/body-measurements?from=2026-10-25&to=2026-10-25')).body.items).toHaveLength(2);
    const me2 = (await c.req('GET', '/auth/me')).body.user;
    await c.req('PATCH', '/me/settings', { expectedRevision: me2.revision, timezone: 'Europe/Lisbon' });
  });

  it('export has sets, snapshots, weights, corrections and no secrets', async () => {
    const r = await c.req('GET', '/exports/personal.json');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const text = JSON.stringify(r.body);
    expect(r.body.formatVersion).toBe(1);
    expect(r.body.sessions.length).toBeGreaterThan(0);
    expect(r.body.sessions[0].planSnapshot).toBeTruthy();
    expect(r.body.bodyMeasurements.some((m: { corrections: unknown[] }) => m.corrections.length)).toBe(true);
    expect(r.body.definitions.length).toBeGreaterThan(0);
    for (const bad of ['passwordHash', 'argon2', 'csrfToken', PASSWORD]) expect(text).not.toContain(bad);
  });
});
