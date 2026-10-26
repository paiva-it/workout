/**
 * Schema-3 pack: exercise blocks repeated in rounds. Upgrade over live v2 data, block/round persistence on the flat
 * working sets, one rest timer per boundary, older sessions untouched. Real server + throwaway MongoDB, synthetic user.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ROOT = new URL('../../../', import.meta.url);
const API = new URL('../', import.meta.url).pathname;
const PORT = 4100 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://localhost:5173';
const DB = `workout_test_v3_${Date.now()}`;
const MONGO_URI = `${process.env.TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27118'}/${DB}`;
const env = { ...process.env, MONGO_URI, PORT: String(PORT), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false' };
const read = (p: string) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));
const v3 = read('data/training-pack.v3.json');
const cli = (args: string[], input = '') => spawnSync('node', ['dist/cli.js', ...args], { cwd: API, env, input, encoding: 'utf8' });
let server: ChildProcess;
let csrf = '', cookie = '';

async function req(method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', origin: ORIGIN, cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of r.headers.getSetCookie()) cookie = c.split(';')[0];
  const t = await r.text();
  let json: Any;
  try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, body: json };
}
const preview = (pack: unknown) => req('POST', '/plan-imports/preview', { pack }).then((r) => r.body);
const start = (planId: string, planVersion: number, packVersion: number) =>
  req('POST', '/sessions', { clientSessionId: randomUUID(), planId, planVersion, packId: v3.packId, packVersion, timezone: 'Europe/Lisbon' }).then((r) => r.body);
const finish = (s: Any, outcome = 'finish') => req('POST', `/sessions/${s.id}/finish`, { operationId: randomUUID(), expectedRevision: s.revision, outcome }).then((r) => r.body.session);
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
  expect(cli(['import-pack', '../../data/training-pack.v2.json']).status).toBe(0);
  expect(cli(['bootstrap-user'], 'BOOTSTRAP_USERNAME=v3tester\nBOOTSTRAP_PASSWORD=synthetic pass 123\n').status).toBe(0);
  await boot();
  await mongoose.connect(MONGO_URI);
  csrf = (await req('POST', '/auth/login', { username: 'v3tester', password: 'synthetic pass 123' })).body.csrfToken;
}, 30_000);
afterAll(async () => {
  server?.kill('SIGTERM');
  await mongoose.connection.db?.dropDatabase();
  await mongoose.disconnect();
});

describe('schema-3 validation', () => {
  const bad = async (mutate: (p: Any) => void) => { const p = structuredClone(v3); mutate(p); return preview(p); };
  const arms = (p: Any) => p.plans.find((x: Any) => x.id === 'arms');
  it('accepts v3; the pinned older schemas reject it', async () => {
    expect((await preview(v3)).status).toBe('new');
    expect((await preview({ ...v3, schemaVersion: 2 })).status).toBe('invalid');
    expect((await preview({ ...v3, schemaVersion: 1 })).status).toBe('invalid');
  });
  it('rejects missing, duplicate and dangling members, set/round mismatch, wrong order and colliding ids', async () => {
    expect((await bad((p) => arms(p).workoutBlocks[0].itemIds.pop())).errors.join()).toMatch(/every work item once/);
    expect((await bad((p) => arms(p).workoutBlocks[1].itemIds.push('arms-v2-work-01'))).errors.join()).toMatch(/more than one block/);
    expect((await bad((p) => { arms(p).workoutBlocks[0].itemIds[1] = 'nope-item'; })).errors.join()).toMatch(/missing item nope-item/);
    expect((await bad((p) => { arms(p).items[0].workingSets = 2; })).errors.join()).toMatch(/workingSets must equal/);
    expect((await bad((p) => arms(p).workoutBlocks[0].itemIds.reverse())).errors.join()).toMatch(/in item order/);
    expect((await bad((p) => { arms(p).workoutBlocks[0].id = arms(p).items[0].id; })).errors.join()).toMatch(/Duplicate block\/step\/item id/);
    expect((await bad((p) => { arms(p).workoutBlocks[0].rounds = 0; })).status).toBe('invalid');
    expect((await bad((p) => { arms(p).workoutBlocks[0].restBetweenRoundsSeconds = -1; })).status).toBe('invalid');
    expect((await bad((p) => { arms(p).workoutBlocks[0].rounds = 1.5; })).status).toBe('invalid');
  });
});

describe('upgrade over live v2 data', () => {
  let doneBefore: unknown, activeBefore: Any;
  it('captures a finished and an in-progress v2 session and a fixed-program selection', async () => {
    let s = await start('core', 1, 2);
    const o = s.exercises[0];
    s = (await req('PATCH', `/sessions/${s.id}`, { operationId: randomUUID(), expectedRevision: s.revision, op: { type: 'setActual', exerciseOccurrenceId: o.id, setId: o.sets[0].id, status: 'done', actualReps: 12, actualDurationSeconds: null, valueGrams: null, actualRir: null } })).body.session;
    doneBefore = await raw((await finish(s)).id);
    activeBefore = await start('arms', 2, 2);
    activeBefore = await raw(activeBefore.id);
    const me = (await req('GET', '/auth/me')).body.user;
    expect((await req('PATCH', '/me/program', { expectedRevision: me.revision, programId: 'return-to-training', startDate: '2026-10-19', heldPhaseIndex: null })).status).toBe(200);
  });
  it('previews with zero conflicts and activates four plans with the unchanged program', async () => {
    const pv = await preview(v3);
    expect(pv).toMatchObject({ status: 'new', errors: [] });
    expect(pv.counts.exercises).toEqual({ new: 0, unchanged: 50, conflicting: 0 });
    expect(pv.counts.programs).toEqual({ new: 0, unchanged: 1, conflicting: 0 });
    expect(pv.counts.plans).toEqual({ new: 4, unchanged: 0, conflicting: 0 }); // arms/chest/legs v3, core v2
    expect((await req('POST', '/plan-imports', { pack: v3, expectedCatalogRevision: pv.catalogRevision, previewHash: pv.contentHash })).body.activated).toBe(true);
    expect((await req('GET', '/plans')).body.map((p: Any) => `${p.id}@${p.version}`).sort()).toEqual(['arms@3', 'chest@3', 'core@2', 'legs@3']);
    expect((await req('GET', '/programs')).body.map((p: Any) => `${p.id}@${p.version}`)).toEqual(['return-to-training@2']);
    expect((await preview(v3)).status).toBe('noop');
    const changed = structuredClone(v3);
    changed.plans[0].workoutBlocks[0].restBetweenRoundsSeconds = 90;
    expect((await preview(changed)).status).toBe('conflict');
    expect(cli(['import-pack', '../../data/training-pack.v2.json']).status).toBe(1); // never downgrades
    expect(cli(['migrate-program-selections', '../../docs/revamp-2026-10-rounds/catalog-migration.json']).stdout).toMatch(/0 selection\(s\) changed/);
    expect((await req('GET', '/auth/me')).body.user.program).toEqual({ programId: 'return-to-training', startDate: '2026-10-19', heldPhaseIndex: null });
  });
  it('v2 sessions are unchanged; the in-progress one resumes straight-set with no blocks', async () => {
    expect(await raw((doneBefore as Any)._id)).toEqual(doneBefore);
    expect(await raw(activeBefore._id)).toEqual(activeBefore);
    const s = (await req('GET', '/sessions/active')).body.session;
    const o = s.exercises[0];
    let r = { status: 0, body: { session: s } as Any };
    for (const set of o.sets.slice(0, 2)) r = await req('PATCH', `/sessions/${s.id}`, { operationId: randomUUID(), expectedRevision: r.body.session.revision, op: { type: 'setActual', exerciseOccurrenceId: o.id, setId: set.id, status: 'done', actualReps: 11, actualDurationSeconds: null, valueGrams: 8000, actualRir: null } });
    expect(r.status).toBe(200);
    const after = await raw(s.id);
    expect(after!.schemaVersion).toBe(2);
    expect(after!.workoutBlocksSnapshot).toBeUndefined();
    expect(after!.exercises.flatMap((x: Any) => x.sets).some((x: Any) => 'blockSnapshotId' in x)).toBe(false);
    expect(r.body.session.restTimer).toMatchObject({ durationSeconds: o.appliedPrescription.restSeconds }); // legacy item rest still applies there
    await finish(r.body.session, 'abandon');
  });
});

describe('grouped workout', () => {
  let s: Any;
  const ops: Record<string, unknown>[] = [];
  const apply = async (o: Record<string, unknown>, operationId = randomUUID()) => {
    const r = await req('PATCH', `/sessions/${s.id}`, { operationId, expectedRevision: s.revision, op: o });
    if (r.status === 200) s = r.body.session;
    ops.push(o);
    return r;
  };
  const occ = (exerciseId: string) => s.exercises.find((o: Any) => o.exerciseId === exerciseId);
  const row = (exerciseId: string, round: number, side = 'both') => occ(exerciseId).sets.find((x: Any) => x.roundIndex === round && x.side === side && x.type === 'working');
  const done = (exerciseId: string, round: number, side = 'both', reps = 10, grams: number | null = 8000) =>
    apply({ type: 'setActual', exerciseOccurrenceId: occ(exerciseId).id, setId: row(exerciseId, round, side).id, status: 'done', actualReps: reps, actualDurationSeconds: null, valueGrams: grams, actualRir: null });
  const clear = () => apply({ type: 'updateRestTimer', action: 'clear' });

  it('snapshots blocks onto the flat occurrences: one set per member per round, never rounds x sets', async () => {
    s = await start('arms', 3, 3);
    expect(s.schemaVersion).toBe(3);
    expect(s.planRef).toMatchObject({ version: 3, packVersion: 3, packSchemaVersion: 3 });
    expect(s.workoutBlocksSnapshot.map((b: Any) => [b.planBlockId, b.prescriptionSnapshot.rounds, b.members.length])).toEqual([['arms-v3-block-01', 3, 2], ['arms-v3-block-02', 2, 2], ['arms-v3-block-03', 2, 3]]);
    const b1 = s.workoutBlocksSnapshot[0];
    expect(b1.members.map((m: Any) => s.exercises.find((o: Any) => o.id === m.exerciseOccurrenceId).exerciseId)).toEqual(['db-supported-row', 'floor-pushup']);
    expect(b1).not.toHaveProperty('sets');
    const work = s.exercises.flatMap((o: Any) => o.sets.filter((x: Any) => x.type === 'working'));
    expect(work).toHaveLength(19);
    expect(s.exercises.reduce((n: number, o: Any) => n + new Set(o.sets.map((x: Any) => x.roundIndex)).size, 0)).toBe(16);
    expect(work.every((x: Any) => s.workoutBlocksSnapshot.some((b: Any) => b.id === x.blockSnapshotId))).toBe(true);
    expect(occ('db-supported-row').sets.map((x: Any) => `${x.roundIndex}${x.side[0]}`)).toEqual(['1l', '1r', '2l', '2r', '3l', '3r']);
    expect(s.sectionActivities.warmup.length).toBeGreaterThan(0);
    expect(s.restTimer).toBeNull();
  });

  it('row left alone starts nothing; both sides -> 60s, then push-ups -> 120s between rounds', async () => {
    await done('db-supported-row', 1, 'left', 12);
    expect(s.restTimer).toBeNull();
    await done('db-supported-row', 1, 'right', 10);
    expect(s.restTimer).toMatchObject({ durationSeconds: 60, kind: 'exercise' });
    await done('floor-pushup', 1, 'both', 10, null);
    expect(s.restTimer).toMatchObject({ durationSeconds: 120, kind: 'round' });
  });

  it('round 2 never overwrites round 1; left/right stay distinct', async () => {
    await done('db-supported-row', 2, 'left', 11);
    await done('db-supported-row', 2, 'right', 9);
    expect([1, 2].map((r) => ['left', 'right'].map((side) => row('db-supported-row', r, side).actualReps))).toEqual([[12, 10], [11, 9]]);
  });

  it('replays are idempotent, a changed payload conflicts, edits and undo/redo never restart a boundary', async () => {
    const id = randomUUID();
    const o = { type: 'setActual', exerciseOccurrenceId: occ('floor-pushup').id, setId: row('floor-pushup', 2).id, status: 'done', actualReps: 9, actualDurationSeconds: null, valueGrams: null, actualRir: null };
    await apply(o, id);
    expect(s.restTimer).toMatchObject({ durationSeconds: 120, kind: 'round' });
    const rev = s.revision;
    expect((await apply(o, id)).body.replayed).toBe(true);
    expect(s.revision).toBe(rev);
    expect((await apply({ ...o, actualReps: 8 }, id)).body.code).toBe('OPERATION_REUSED');
    await clear();
    await apply({ ...o, actualReps: 8 }); // edit saved actuals
    await apply({ ...o, status: 'pending' });
    await apply(o); // redo
    expect(s.restTimer).toBeNull();
    expect(occ('db-supported-row').sets).toHaveLength(6);
  });

  it('final round uses one 120s after-block rest, not 240s', async () => {
    await done('db-supported-row', 3, 'left');
    await done('db-supported-row', 3, 'right');
    await done('floor-pushup', 3, 'both', 10, null);
    expect(s.restTimer).toMatchObject({ durationSeconds: 120, kind: 'block' });
  });

  it('skipping never starts a timer and leaves the round partial, not performed', async () => {
    await clear();
    const press = occ('db-seated-press');
    await apply({ type: 'setActual', exerciseOccurrenceId: press.id, setId: press.sets[0].id, status: 'skipped', actualReps: null, actualDurationSeconds: null, valueGrams: null, actualRir: null, skipReason: 'Shoulder' });
    expect(s.restTimer).toBeNull();
    expect(s.exercises.find((o: Any) => o.id === press.id).sets[0]).toMatchObject({ status: 'skipped', actualReps: null, actualLoad: null });
  });

  it('working sets follow rounds: add/remove working set is refused, warm-up ramp sets stay allowed', async () => {
    expect((await apply({ type: 'addSet', exerciseOccurrenceId: occ('floor-pushup').id, setType: 'working' })).body.code).toBe('BLOCK_ROUNDS');
    expect((await apply({ type: 'removePendingSet', exerciseOccurrenceId: occ('floor-pushup').id, setType: 'working', roundIndex: 3 })).body.code).toBe('BLOCK_ROUNDS');
    expect((await apply({ type: 'addSet', exerciseOccurrenceId: occ('db-supported-row').id, setType: 'warmup' })).status).toBe(200);
    expect(occ('db-supported-row').sets.find((x: Any) => x.type === 'warmup').blockSnapshotId).toBeUndefined();
  });

  it('substitution keeps the occurrence, block and rounds and switches the load convention', async () => {
    const fr = occ('db-french-extension');
    const r = await apply({ type: 'substituteExercise', exerciseOccurrenceId: fr.id, exerciseId: 'db-floor-triceps-extension' });
    expect(r.status).toBe(200);
    const sub = s.exercises.find((o: Any) => o.id === fr.id);
    expect(sub).toMatchObject({ exerciseId: 'db-floor-triceps-extension', loadBasis: 'per_dumbbell', implementCount: 2 });
    expect(sub.sets.map((x: Any) => [x.roundIndex, x.blockSnapshotId])).toEqual(fr.sets.map((x: Any) => [x.roundIndex, x.blockSnapshotId]));
  });

  it('the final member of the final block starts no rest; skipped work makes the result partial', async () => {
    await clear();
    const last = s.workoutBlocksSnapshot[2];
    const curl = s.exercises.find((o: Any) => o.id === last.members[2].exerciseOccurrenceId);
    for (const m of last.members) {
      const o = s.exercises.find((x: Any) => x.id === m.exerciseOccurrenceId);
      for (const set of o.sets.filter((x: Any) => x.roundIndex === 2 && x.type === 'working')) await apply({ type: 'setActual', exerciseOccurrenceId: o.id, setId: set.id, status: 'done', actualReps: 10, actualDurationSeconds: null, valueGrams: 6000, actualRir: null });
    }
    expect(s.restTimer?.exerciseOccurrenceId === curl.id ? s.restTimer : null).toBeNull();
    const fin = await finish(s);
    expect(fin.status).toBe('partial');
    expect(fin.isActive).toBe(false);
  });

  it('all work done + cooldown skipped = completed; Plan C rests 90/150/150', async () => {
    s = await start('legs', 3, 3);
    expect(s.workoutBlocksSnapshot[0].prescriptionSnapshot).toMatchObject({ rounds: 3, restBetweenExercisesSeconds: 90, restBetweenRoundsSeconds: 150, restAfterBlockSeconds: 150 });
    const kinds: string[] = [];
    for (const b of s.workoutBlocksSnapshot) for (let r = 1; r <= b.prescriptionSnapshot.rounds; r++) for (const m of b.members) {
      const o = s.exercises.find((x: Any) => x.id === m.exerciseOccurrenceId);
      for (const set of o.sets.filter((x: Any) => x.roundIndex === r && x.type === 'working')) {
        const loaded = !['bodyweight', 'none'].includes(o.loadBasis);
        await apply({ type: 'setActual', exerciseOccurrenceId: o.id, setId: set.id, status: 'done', actualReps: set.target.metric === 'reps' ? 10 : null, actualDurationSeconds: set.target.metric === 'duration' ? 30 : null, valueGrams: loaded ? 10000 : null, actualRir: null });
      }
      kinds.push(s.restTimer ? `${s.restTimer.kind}:${s.restTimer.durationSeconds}` : 'none');
      await clear();
    }
    expect(kinds.slice(0, 9)).toEqual(['exercise:90', 'exercise:90', 'round:150', 'exercise:90', 'exercise:90', 'round:150', 'exercise:90', 'exercise:90', 'block:150']);
    expect(kinds.at(-1)).toBe('none');
    const split = occ('db-split-squat');
    expect(split).toMatchObject({ loadBasis: 'per_dumbbell', implementCount: 2 });
    for (const a of s.sectionActivities.cooldown) for (const set of a.sets) await apply({ type: 'skipSectionSet', section: 'cooldown', activityId: a.id, setIds: [set.id], reason: null });
    const fin = await finish(s);
    expect(fin.status).toBe('completed');
    s = fin;
  });

  it('core: taps are one total, holds are seconds per side; rehearsals never become last time', async () => {
    const c = await start('core', 2, 3);
    const taps = c.exercises.find((o: Any) => o.exerciseSnapshot.repsMeaning === 'alternating_total');
    expect(taps.sets.every((x: Any) => x.side === 'both')).toBe(true);
    expect(c.exercises.reduce((n: number, o: Any) => n + o.sets.length, 0)).toBe(16);
    await finish(c, 'abandon');
    const prev = (await req('GET', '/exercises/goblet-squat/previous?variantKey=standard')).body.previous;
    expect(prev?.sessionId).toBe(s.id);
    expect(prev.sets.every((x: Any) => x.type === 'working')).toBe(true);
  });

  it('block snapshots survive a later catalog change; export keeps every format', async () => {
    const before = (await req('GET', `/sessions/${s.id}`)).body.workoutBlocksSnapshot;
    const v4 = structuredClone(v3);
    v4.version = 4;
    const legs = v4.plans.find((p: Any) => p.id === 'legs');
    legs.version = 4;
    legs.workoutBlocks[0].restBetweenRoundsSeconds = 120;
    const pv = await preview(v4);
    expect(pv.status).toBe('new');
    await req('POST', '/plan-imports', { pack: v4, expectedCatalogRevision: pv.catalogRevision, previewHash: pv.contentHash });
    expect((await req('GET', `/sessions/${s.id}`)).body.workoutBlocksSnapshot).toEqual(before);
    expect(cli(['activate-pack', v3.packId, '3']).status).toBe(0); // rollback restores the pointer, keeps sessions
    expect((await req('GET', '/plans')).body.find((p: Any) => p.id === 'legs').version).toBe(3);
    const e = (await req('GET', '/exports/personal.json')).body;
    expect([...new Set(e.sessions.map((x: Any) => x.schemaVersion))].sort()).toEqual([2, 3]);
    const g = e.sessions.find((x: Any) => x.id === s.id || x._id === s.id);
    expect(g.workoutBlocksSnapshot).toHaveLength(2);
    expect(g.exercises[0].sets[0].blockSnapshotId).toBe(g.workoutBlocksSnapshot[0].id);
  });

  it('a restart keeps v3 active', async () => {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
    await boot();
    expect((await req('GET', '/plans')).body.map((p: Any) => p.version).sort()).toEqual([2, 3, 3, 3]);
  });
});
