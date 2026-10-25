/**
 * Schema-2 pack upgrade: dual-format validation, activation over a live v1 catalog, legacy sessions untouched and
 * resumable, structured warm-up/cooldown logging. Real server + throwaway MongoDB, synthetic user only.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const API = new URL('../', import.meta.url).pathname;
const PORT = 4000 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://localhost:5173';
const DB = `workout_test_v2_${Date.now()}`;
const MONGO_URI = `${process.env.TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27118'}/${DB}`;
const env = { ...process.env, MONGO_URI, PORT: String(PORT), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false' };
const read = (p: string) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));
const v1 = read('data/training-pack.v1.json');
const v2 = read('data/training-pack.v2.json');
const cli = (args: string[], input = '') => spawnSync('node', ['dist/cli.js', ...args], { cwd: API, env, input, encoding: 'utf8' });
let server: ChildProcess;
let csrf = '', cookie = '';

async function req(method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', origin: ORIGIN, cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of r.headers.getSetCookie()) cookie = c.split(';')[0];
  const t = await r.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, body: json };
}
const op = (s: { id: string; revision: number }, o: unknown, operationId: string = randomUUID()) => req('PATCH', `/sessions/${s.id}`, { operationId, expectedRevision: s.revision, op: o });
const start = (planId: string, planVersion: number, packVersion: number) =>
  req('POST', '/sessions', { clientSessionId: randomUUID(), planId, planVersion, packId: v1.packId, packVersion, timezone: 'Europe/Lisbon' });
const raw = (id: string) => mongoose.connection.db!.collection('trainingSessions').findOne({ _id: id as never });
async function boot() {
  server = spawn('node', ['dist/main.js'], { cwd: API, env, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/v1/health/ready')).ok) return; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  expect(cli(['import-pack', '../../data/training-pack.v1.json']).status).toBe(0);
  expect(cli(['bootstrap-user'], 'BOOTSTRAP_USERNAME=v2tester\nBOOTSTRAP_PASSWORD=synthetic pass 123\n').status).toBe(0);
  await boot();
  await mongoose.connect(MONGO_URI);
  const r = await req('POST', '/auth/login', { username: 'v2tester', password: 'synthetic pass 123' });
  csrf = r.body.csrfToken;
}, 30_000);
afterAll(async () => {
  server?.kill('SIGTERM');
  await mongoose.connection.db?.dropDatabase();
  await mongoose.disconnect();
});

describe('dual-format pack validation', () => {
  it('schema 1 keeps accepting the old pack and rejects the new one; unknown versions are refused', async () => {
    expect((await req('POST', '/plan-imports/preview', { pack: v1 })).body.status).toBe('noop');
    expect((await req('POST', '/plan-imports/preview', { pack: { ...v2, schemaVersion: 1 } })).body.status).toBe('invalid');
    const bad = await req('POST', '/plan-imports/preview', { pack: { ...v2, schemaVersion: 3 } });
    expect(bad.body.errors[0]).toMatch(/Unsupported schemaVersion/);
  });
  it('schema 2 rejects unknown step fields, duplicate occurrence ids, wrong rehearsal links and stray equals signs', async () => {
    const extra = structuredClone(v2);
    extra.plans[0].cooldown.steps[0].colour = 'red';
    expect((await req('POST', '/plan-imports/preview', { pack: extra })).body.status).toBe('invalid');
    const dup = structuredClone(v2);
    dup.plans[0].cooldown.steps[0].id = dup.plans[0].items[0].id;
    expect((await req('POST', '/plan-imports/preview', { pack: dup })).body.errors.join()).toMatch(/Duplicate step\/item id/);
    const link = structuredClone(v2);
    link.plans[0].warmup.steps.find((s: { role: string }) => s.role === 'rehearsal').linkedWorkoutItemId = link.plans[0].items[2].id;
    expect((await req('POST', '/plan-imports/preview', { pack: link })).body.errors.join()).toMatch(/Rehearsal must match/);
    const eq = structuredClone(v2);
    eq.plans[0].notes[0] = 'Sets = 3';
    expect((await req('POST', '/plan-imports/preview', { pack: eq })).body.errors.join()).toMatch(/only allowed in video URLs/);
    const role = structuredClone(v2);
    role.plans[0].cooldown.steps[0].role = 'rehearsal';
    expect((await req('POST', '/plan-imports/preview', { pack: role })).body.errors.join()).toMatch(/not allowed in cooldown/);
  });
});

describe('upgrade over live v1 data', () => {
  let legacyDone: any, legacyActive: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let doneBefore: unknown;

  it('captures a finished and an in-progress legacy session plus an obsolete program selection', async () => {
    let s = (await start('restart-b', 1, 1)).body;
    const rdl = s.exercises[0];
    s = (await op(s, { type: 'setActual', exerciseOccurrenceId: rdl.id, setId: rdl.sets[0].id, status: 'done', actualReps: 10, valueGrams: 8000, actualDurationSeconds: null, actualRir: null })).body.session;
    legacyDone = (await req('POST', `/sessions/${s.id}/finish`, { operationId: randomUUID(), expectedRevision: s.revision, outcome: 'finish' })).body.session;
    doneBefore = await raw(legacyDone.id);
    legacyActive = (await start('restart-a', 1, 1)).body;
    const me = (await req('GET', '/auth/me')).body.user;
    expect((await req('PATCH', '/me/program', { expectedRevision: me.revision, programId: 'five-focus-days', startDate: '2026-10-19', heldPhaseIndex: 1 })).status).toBe(200);
  });

  it('previews with zero conflicts, activates, and leaves exactly four plans', async () => {
    const pv = (await req('POST', '/plan-imports/preview', { pack: v2 })).body;
    expect(pv).toMatchObject({ status: 'new', errors: [] });
    expect(pv.counts.exercises).toEqual({ new: 29, unchanged: 21, conflicting: 0 });
    expect(pv.counts.plans).toEqual({ new: 4, unchanged: 0, conflicting: 0 });
    const imp = await req('POST', '/plan-imports', { pack: v2, expectedCatalogRevision: pv.catalogRevision, previewHash: pv.contentHash });
    expect(imp.body.activated).toBe(true);
    const plans = (await req('GET', '/plans')).body;
    expect(plans.map((p: { id: string; version: number }) => `${p.id}@${p.version}`).sort()).toEqual(['arms@2', 'chest@2', 'core@1', 'legs@2']);
    expect((await req('GET', '/programs')).body.map((p: { id: string; version: number }) => `${p.id}@${p.version}`)).toEqual(['return-to-training@2']);
    expect((await req('POST', '/plan-imports/preview', { pack: v2 })).body.status).toBe('noop');
    const changed = structuredClone(v2);
    changed.plans[0].items[0].workingSets = 4;
    expect((await req('POST', '/plan-imports/preview', { pack: changed })).body.status).toBe('conflict');
    expect(cli(['import-pack', '../../data/training-pack.v1.json']).status).toBe(1); // lower version can never reactivate
  });

  it('remaps the obsolete selection once and clears its held phase', async () => {
    const mig = '../../docs/revamp-2026-10/catalog-migration.json';
    expect(cli(['migrate-program-selections', mig]).stdout).toMatch(/1 selection\(s\) changed/);
    expect(cli(['migrate-program-selections', mig]).stdout).toMatch(/0 selection\(s\) changed/);
    const u = (await req('GET', '/auth/me')).body.user;
    expect(u.program).toEqual({ programId: 'return-to-training', startDate: '2026-10-19', heldPhaseIndex: null });
    const t = (await req('GET', '/today')).body;
    expect(t.position.fixed).toBe(true);
    expect(t.position.schedule.map((s: { planName: string }) => s.planName)).toEqual(['A - Arms, shoulders and back', 'C - Legs and glutes', 'B - Chest, shoulders and back', 'D - Abs and core']);
  });

  it('legacy history is byte-for-byte unchanged and the legacy active workout still resumes in its own format', async () => {
    expect(await raw(legacyDone.id)).toEqual(doneBefore);
    const s = (await req('GET', '/sessions/active')).body.session;
    expect(s.id).toBe(legacyActive.id);
    expect(s.programContext).toEqual(legacyActive.programContext);
    const w = await op(s, { type: 'updateWarmup', stepId: s.warmupChecklist[0].stepId, completed: true });
    expect(w.status).toBe(200);
    expect((await op(w.body.session, { type: 'acknowledgeSectionSet', section: 'warmup', activityId: randomUUID(), setIds: [randomUUID()] })).body.code).toBe('NO_SECTIONS');
    const after = await raw(s.id);
    expect(after!.sectionActivities).toBeUndefined();
    expect(after!.schemaVersion).toBe(1);
    await req('POST', `/sessions/${s.id}/finish`, { operationId: randomUUID(), expectedRevision: w.body.session.revision, outcome: 'abandon' });
  });
});

describe('structured sections', () => {
  let s: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const apply = async (o: unknown, id?: string) => { const r = await op(s, o, id); if (r.status === 200) s = r.body.session; return r; };
  const act = (section: 'warmup' | 'cooldown', exerciseId: string) => s.sectionActivities[section].find((a: { exerciseId: string }) => a.exerciseId === exerciseId);

  it('starts with full section snapshots, linked rehearsals and no phase caps', async () => {
    s = (await start('core', 1, 2)).body;
    expect(s.schemaVersion).toBe(2);
    expect(s.planRef).toMatchObject({ id: 'core', version: 1, packVersion: 2, packSchemaVersion: 2 });
    expect(s.warmupChecklist).toEqual([]);
    expect(s.sectionActivities.warmup).toHaveLength(5);
    expect(s.sectionActivities.cooldown).toHaveLength(4);
    expect(s.programContext).toMatchObject({ programId: 'return-to-training', workingSetCap: null, rir: [2, 3] });
    expect(s.exercises.find((o: { exerciseId: string }) => o.exerciseId === 'floor-crunch').sets).toHaveLength(3);
    const rehearsal = act('warmup', 'dead-bug');
    const work = s.exercises.find((o: { exerciseId: string }) => o.exerciseId === 'dead-bug');
    expect(rehearsal.linkedWorkoutOccurrenceId).toBe(work.id);
    expect(rehearsal.sets.map((x: { side: string }) => x.side)).toEqual(['left', 'right']);
    expect(rehearsal.videoSnapshot.youtubeId).toHaveLength(11);
    expect(s.sectionActivities.warmup.every((a: { sets: { status: string; actualReps: null }[] }) => a.sets.every((x) => x.status === 'pending' && x.actualReps === null))).toBe(true);
  });

  it('a quick Done is an acknowledgement with null actuals; replays are idempotent; sides stay independent', async () => {
    const march = act('warmup', 'march-in-place');
    const ack = { type: 'acknowledgeSectionSet', section: 'warmup', activityId: march.id, setIds: [march.sets[0].id] };
    const id = randomUUID();
    const rev = s.revision;
    await apply(ack, id);
    expect(act('warmup', 'march-in-place').sets[0]).toMatchObject({ status: 'done', completionMode: 'acknowledged', actualDurationSeconds: null, actualReps: null });
    const again = await op({ id: s.id, revision: rev }, ack, id);
    expect(again.body.replayed).toBe(true);
    expect((await op(s, { ...ack, setIds: [march.sets[0].id, march.sets[0].id] }, id)).body.code).toBe('OPERATION_REUSED');
    const bug = act('warmup', 'dead-bug');
    await apply({ type: 'acknowledgeSectionSet', section: 'warmup', activityId: bug.id, setIds: [bug.sets[0].id] });
    expect(act('warmup', 'dead-bug').sets.map((x: { status: string }) => x.status)).toEqual(['done', 'pending']);
    await apply({ type: 'skipSectionSet', section: 'warmup', activityId: bug.id, setIds: [bug.sets[1].id], reason: null });
    expect(act('warmup', 'dead-bug').sets.map((x: { status: string }) => x.status)).toEqual(['done', 'skipped']);
  });

  it('measured values are validated and stored; load only where it applies', async () => {
    const cat = act('warmup', 'cat-camel');
    expect((await apply({ type: 'setSectionActual', section: 'warmup', activityId: cat.id, setId: cat.sets[0].id, actualReps: 0, actualDurationSeconds: null })).status).toBe(422);
    expect((await apply({ type: 'setSectionActual', section: 'warmup', activityId: cat.id, setId: cat.sets[0].id, actualReps: 6, actualDurationSeconds: null, valueGrams: 2000 })).status).toBe(422);
    await apply({ type: 'setSectionActual', section: 'warmup', activityId: cat.id, setId: cat.sets[0].id, actualReps: 6, actualDurationSeconds: null });
    expect(act('warmup', 'cat-camel').sets[0]).toMatchObject({ status: 'done', completionMode: 'measured', actualReps: 6 });
  });

  it('alternating totals are one record; working sets complete; skipped cooldown keeps "completed"', async () => {
    for (const o of s.exercises) {
      for (const set of o.sets) {
        const metric = set.target.metric;
        const reps = o.exerciseId === 'alternating-heel-touches' ? 20 : set.target.min;
        await apply({ type: 'setActual', exerciseOccurrenceId: o.id, setId: set.id, status: 'done', actualReps: metric === 'reps' ? reps : null, actualDurationSeconds: metric === 'duration' ? set.target.min : null, valueGrams: null, actualRir: null });
      }
    }
    const heel = s.exercises.find((o: { exerciseId: string }) => o.exerciseId === 'alternating-heel-touches');
    expect(heel.sets.map((x: { side: string; actualReps: number }) => [x.side, x.actualReps])).toEqual([['both', 20], ['both', 20]]);
    for (const a of s.sectionActivities.cooldown) await apply({ type: 'skipSectionSet', section: 'cooldown', activityId: a.id, setIds: [a.sets[0].id], reason: 'Out of time' }).then(() => a.sets[1] && apply({ type: 'skipSectionSet', section: 'cooldown', activityId: a.id, setIds: [a.sets[1].id], reason: null }));
    const fin = await req('POST', `/sessions/${s.id}/finish`, { operationId: randomUUID(), expectedRevision: s.revision, outcome: 'finish' });
    expect(fin.body.session.status).toBe('completed');
    expect(fin.body.session.sectionActivities.cooldown.every((a: { sets: { status: string }[] }) => a.sets.every((x) => x.status === 'skipped'))).toBe(true);
    s = fin.body.session;
  });

  it('rehearsals never become "last time"; working results do', async () => {
    const prev = (await req('GET', '/exercises/dead-bug/previous?variantKey=standard&loadBasis=bodyweight')).body.previous;
    expect(prev.sessionId).toBe(s.id);
    expect(prev.sets.every((x: { type: string }) => x.type === 'working')).toBe(true);
    expect(prev.sets).toHaveLength(4); // 2 working rounds x L/R, not the rehearsal
  });

  it('section corrections need a reason and keep the prior values', async () => {
    const cat = s.sectionActivities.warmup.find((a: { exerciseId: string }) => a.exerciseId === 'cat-camel');
    const r = await req('POST', `/sessions/${s.id}/corrections`, { operationId: randomUUID(), expectedRevision: s.revision, reason: 'Did eight', operations: [{ type: 'setSectionActual', section: 'warmup', activityId: cat.id, setId: cat.sets[0].id, actualReps: 8, actualDurationSeconds: null }] });
    expect(r.status).toBe(200);
    expect(r.body.session.corrections[0].before[`warmup:${cat.id}`][0].actualReps).toBe(6);
    expect(r.body.session.status).toBe('completed');
  });

  it('split squats log two dumbbells per side; French extension substitution switches load convention', async () => {
    const legs = (await start('legs', 2, 2)).body;
    const split = legs.exercises.find((o: { exerciseId: string }) => o.exerciseId === 'db-split-squat');
    expect(split).toMatchObject({ loadBasis: 'per_dumbbell', implementCount: 2 });
    expect(split.sets.map((x: { side: string }) => x.side)).toEqual(['left', 'right', 'left', 'right']);
    await req('POST', `/sessions/${legs.id}/finish`, { operationId: randomUUID(), expectedRevision: legs.revision, outcome: 'abandon' });
    let arms = (await start('arms', 2, 2)).body;
    const fr = arms.exercises.find((o: { exerciseId: string }) => o.exerciseId === 'db-french-extension');
    expect(fr).toMatchObject({ loadBasis: 'single_dumbbell', implementCount: 1 });
    arms = (await op(arms, { type: 'substituteExercise', exerciseOccurrenceId: fr.id, exerciseId: 'db-floor-triceps-extension' })).body.session;
    const sub = arms.exercises.find((o: { id: string }) => o.id === fr.id);
    expect(sub).toMatchObject({ exerciseId: 'db-floor-triceps-extension', loadBasis: 'per_dumbbell', implementCount: 2 });
    expect(sub.originalExerciseSnapshot.id).toBe('db-french-extension');
    expect(sub.sets.every((x: { actualLoad: null }) => x.actualLoad === null)).toBe(true);
    await req('POST', `/sessions/${arms.id}/finish`, { operationId: randomUUID(), expectedRevision: arms.revision, outcome: 'abandon' });
  });

  it('export carries both formats with their version markers', async () => {
    const e = (await req('GET', '/exports/personal.json')).body;
    const versions = new Set(e.sessions.map((x: { schemaVersion: number }) => x.schemaVersion));
    expect([...versions].sort()).toEqual([1, 2]);
    expect(e.sessions.find((x: { schemaVersion: number }) => x.schemaVersion === 2).sectionActivities.warmup.length).toBeGreaterThan(0);
    expect(e.definitions.map((d: { version: number }) => d.version).sort()).toEqual([1, 2]);
  });

  it('a restart neither re-imports seeds nor reactivates v1', async () => {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
    await boot();
    expect((await req('GET', '/plans')).body).toHaveLength(4);
  });
});
