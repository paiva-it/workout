import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Param, Post, Patch, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { applyPhase, localParts, programPosition, type Exercise, type Plan, type PlanItem, type Program, type Video } from '@workout/contracts';
import { TrainingSession, User, out } from './db.js';
import { activeCatalog, loadPack, resolvePlan } from './catalog.js';
import { fail, hashPayload, parse, zInt, zIso, zNote, zTz, zUuid, type AuthedUser } from './common.js';

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- lean session documents
const LOADED = ['per_dumbbell', 'single_dumbbell', 'barbell_total', 'external_total'];
const MUTABLE = ['status', 'isActive', 'endedAt', 'pauses', 'elapsedSeconds', 'activeSeconds', 'warmupChecklist', 'restTimer', 'exercises', 'metadata', 'corrections', 'correctedAt'] as const;
const KEEP_OPERATIONS = 2000;

// ---------- Session construction ----------
function makeSets(occ: Doc, type: 'working' | 'warmup', round: number, perSide: boolean) {
  const p = occ.appliedPrescription;
  const target = type === 'working' ? { metric: p.target.metric, min: p.target.min, max: p.target.max, rir: p.rir } : { metric: p.target.metric, min: Math.min(5, p.target.min), max: Math.max(5, Math.min(10, p.target.max)), rir: null };
  const blank = { roundIndex: round, type, status: 'pending', target, actualReps: null, actualDurationSeconds: null, actualLoad: null, actualRir: null, failedAttempt: false, completedAt: null, recordedAt: null, notes: null, skipReason: null };
  return perSide ? [{ id: randomUUID(), side: 'left', ...blank }, { id: randomUUID(), side: 'right', ...blank }] : [{ id: randomUUID(), side: 'both', ...blank }];
}
function makeOccurrence(item: PlanItem, ex: Exercise, video: Video | undefined, phase: Doc | null) {
  const eff = applyPhase(item, phase as never);
  const occ: Doc = {
    id: randomUUID(), planItemId: item.id, exerciseId: ex.id, exerciseVersion: ex.version, exerciseSnapshot: { ...ex, video: video ?? null },
    originalExerciseSnapshot: null, originalPrescription: item,
    appliedPrescription: { workingSets: eff.workingSets, rir: eff.rir, target: item.target, restSeconds: item.restSeconds, restAfter: item.restAfter, variant: item.defaultVariant, notes: item.notes },
    variantKey: item.defaultVariant, setup: { inclineSupportHeightMm: null, supportDescription: null, benchAngleDegrees: null, notes: null },
    loadBasis: ex.defaultLoadBasis, implementCount: ex.defaultImplementCount, optional: item.optional, sets: [], notes: null, skipped: false, skipReason: null,
  };
  for (let r = 1; r <= eff.workingSets; r++) occ.sets.push(...makeSets(occ, 'working', r, item.target.perSide));
  return occ;
}
const programPlanIds = (p: Program) => new Set([...(p.schedule ?? []), ...p.phases.flatMap((ph) => [...(ph.schedule ?? []), ...(ph.alternatingSchedules ?? []).flat()])].map((e) => e.planId));

// ---------- Mutation engine: owner + revision predicate, operation-id replay, single-document atomic write ----------
async function mutate(user: AuthedUser, id: string, operationId: string, payload: unknown, expectedRevision: number | null, fn: (d: Doc, now: Date) => boolean | void | Promise<boolean | void>, opts: { closed?: boolean } = {}) {
  const payloadHash = hashPayload(payload);
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await TrainingSession.findOne({ _id: id, ownerId: user.id, deletedAt: null }).lean<Doc>();
    if (!doc) throw fail(404, 'NOT_FOUND', 'Session not found');
    const known = doc.appliedOperations.find((o: Doc) => o.operationId === operationId);
    if (known) {
      if (known.payloadHash !== payloadHash) throw fail(409, 'OPERATION_REUSED', 'This operation ID was already used with a different payload');
      return { session: view(doc), replayed: true };
    }
    if (expectedRevision != null && doc.revision !== expectedRevision) throw fail(409, 'REVISION_CONFLICT', 'The workout changed elsewhere. Review before applying your change.', { session: view(doc) });
    if (!opts.closed && !doc.isActive) throw fail(409, 'SESSION_CLOSED', 'This workout is already finished');
    const next = structuredClone(doc);
    if ((await fn(next, new Date())) === false) return { session: view(doc), replayed: false };
    const $set = Object.fromEntries(MUTABLE.map((k) => [k, next[k]]));
    const r = await TrainingSession.updateOne(
      { _id: id, ownerId: user.id, revision: doc.revision },
      { $set, $inc: { revision: 1 }, $push: { appliedOperations: { $each: [{ operationId, payloadHash, appliedRevision: doc.revision + 1 }], $slice: -KEEP_OPERATIONS } } },
    );
    if (r.modifiedCount === 1) return { session: view((await TrainingSession.findById(id).lean<Doc>())!), replayed: false };
    if (expectedRevision != null) continue; // re-read: the race winner may have been this very operation (replay)
  }
  throw fail(409, 'REVISION_CONFLICT', 'The workout changed elsewhere. Review before applying your change.');
}
const view = (d: Doc) => { const { appliedOperations: _a, createPayloadHash: _c, ...rest } = d; void _a; void _c; return out(rest); };

const findOcc = (d: Doc, occId: string) => d.exercises.find((o: Doc) => o.id === occId) ?? (() => { throw fail(404, 'NOT_FOUND', 'Exercise not in this session'); })();
const findSet = (o: Doc, setId: string) => o.sets.find((s: Doc) => s.id === setId) ?? (() => { throw fail(404, 'NOT_FOUND', 'Set not in this exercise'); })();
const clampTime = (d: Doc, at: Date | undefined, now: Date) => {
  if (!at) return now;
  if (at.getTime() > now.getTime() + 60_000 || at.getTime() < new Date(d.startedAt).getTime()) throw fail(422, 'VALIDATION', 'Timestamp outside the workout', { fieldErrors: { at: 'Out of range' } });
  return at;
};

// ---------- Operations ----------
const zGrams = zInt(0, 1_000_000);
const SetActual = z.strictObject({
  type: z.literal('setActual'), exerciseOccurrenceId: zUuid, setId: zUuid, status: z.enum(['pending', 'done', 'skipped']),
  actualReps: zInt(0, 1000).nullable(), actualDurationSeconds: zInt(0, 86400).nullable(), valueGrams: zGrams.nullable(),
  addedGrams: zGrams.default(0), assistanceGrams: zGrams.default(0), actualRir: zInt(0, 10).nullable(), failedAttempt: z.boolean().default(false),
  notes: zNote(1000).default(null), skipReason: zNote(1000).default(null), completedAt: zIso.optional(),
});
const UpdateExercise = z.strictObject({
  type: z.literal('updateExercise'), exerciseOccurrenceId: zUuid, variantKey: z.string().trim().min(1).max(100).optional(), notes: zNote(1000).optional(),
  loadBasis: z.enum(['per_dumbbell', 'single_dumbbell', 'barbell_total', 'external_total', 'bodyweight', 'none']).optional(), implementCount: zInt(0, 2).optional(),
  setup: z.strictObject({ inclineSupportHeightMm: zInt(0, 3000).nullable(), supportDescription: zNote(200), benchAngleDegrees: zInt(0, 90).nullable(), notes: zNote(1000) }).optional(),
});
const UpdateSessionNotes = z.strictObject({
  type: z.literal('updateSessionNotes'),
  metadata: z.strictObject({ energy: zInt(1, 5).nullable(), soreness: zInt(0, 10).nullable(), sleepMinutes: zInt(0, 1440).nullable(), sessionRpe: zInt(0, 10).nullable(), notes: zNote(4000) }),
});
const Op = z.discriminatedUnion('type', [
  SetActual,
  z.strictObject({ type: z.literal('addSet'), exerciseOccurrenceId: zUuid, setType: z.enum(['working', 'warmup']) }),
  z.strictObject({ type: z.literal('removePendingSet'), exerciseOccurrenceId: zUuid, setType: z.enum(['working', 'warmup']), roundIndex: zInt(1, 100) }),
  z.strictObject({ type: z.literal('skipExercise'), exerciseOccurrenceId: zUuid, skipped: z.boolean(), reason: zNote(1000).default(null) }),
  z.strictObject({ type: z.literal('substituteExercise'), exerciseOccurrenceId: zUuid, exerciseId: z.string().max(100) }),
  z.strictObject({ type: z.literal('addOptionalExercise'), planItemId: z.string().max(100) }),
  UpdateExercise,
  UpdateSessionNotes,
  z.strictObject({ type: z.literal('updateWarmup'), stepId: z.string().max(100), completed: z.boolean() }),
  z.strictObject({ type: z.literal('updateRestTimer'), action: z.enum(['start', 'clear']), durationSeconds: zInt(0, 1800).optional(), exerciseOccurrenceId: zUuid.optional(), roundIndex: zInt(1, 100).optional() }),
]);
type OpT = z.infer<typeof Op>;
const Envelope = z.strictObject({ operationId: zUuid, expectedRevision: zInt(1, 1e9), op: z.unknown() });

function applySetActual(d: Doc, op: z.infer<typeof SetActual>, now: Date, user: AuthedUser | null) {
  const occ = findOcc(d, op.exerciseOccurrenceId);
  const set = findSet(occ, op.setId);
  const metric = set.target.metric;
  const basis = occ.loadBasis;
  if (op.status === 'done') {
    if (metric === 'reps' && !(op.actualReps && op.actualReps > 0) && !(op.failedAttempt && op.actualReps === 0)) throw fail(422, 'VALIDATION', 'Enter the reps you did (0 only as a failed attempt)', { fieldErrors: { actualReps: 'Required' } });
    if (metric === 'duration' && !(op.actualDurationSeconds && op.actualDurationSeconds > 0)) throw fail(422, 'VALIDATION', 'Enter the seconds you held', { fieldErrors: { actualDurationSeconds: 'Required' } });
    if (LOADED.includes(basis) && op.valueGrams == null) throw fail(422, 'VALIDATION', 'Enter the load you used', { fieldErrors: { valueGrams: 'Required' } });
  }
  const loaded = LOADED.includes(basis);
  if (!loaded && op.valueGrams != null) throw fail(422, 'VALIDATION', 'This exercise is logged without external load; change its load mode first', { fieldErrors: { valueGrams: 'Not applicable' } });
  const wasDone = set.status === 'done';
  Object.assign(set, {
    status: op.status, actualReps: op.actualReps, actualDurationSeconds: op.actualDurationSeconds, actualRir: op.actualRir, failedAttempt: op.failedAttempt, notes: op.notes,
    skipReason: op.status === 'skipped' ? op.skipReason : null,
    actualLoad: op.valueGrams == null && loaded ? null : { basis, valueGrams: loaded ? op.valueGrams : null, implementCount: loaded ? occ.implementCount : 0, addedGrams: op.addedGrams, assistanceGrams: op.assistanceGrams, enteredUnit: 'kg' },
    recordedAt: now,
    completedAt: op.status === 'done' ? (wasDone ? set.completedAt : op.completedAt ? clampTime(d, op.completedAt, now) : now) : null,
  });
  // Rest timer: after the set, or only once both sides of the round are done.
  const rest = occ.appliedPrescription.restSeconds;
  if (user?.restTimerEnabled !== false && op.status === 'done' && !wasDone && rest > 0) {
    const round = occ.sets.filter((s: Doc) => s.type === set.type && s.roundIndex === set.roundIndex);
    const ready = set.side === 'both' || occ.appliedPrescription.restAfter !== 'both_sides' || round.every((s: Doc) => s.status === 'done');
    if (ready) d.restTimer = { startedAt: set.completedAt, durationSeconds: rest, endsAt: new Date(new Date(set.completedAt).getTime() + rest * 1000), exerciseOccurrenceId: occ.id, roundIndex: set.roundIndex };
  }
}

async function applyOp(d: Doc, op: OpT, now: Date, user: AuthedUser) {
  switch (op.type) {
    case 'setActual': return applySetActual(d, op, now, user);
    case 'addSet': {
      const occ = findOcc(d, op.exerciseOccurrenceId);
      const rounds = occ.sets.filter((s: Doc) => s.type === op.setType).map((s: Doc) => s.roundIndex);
      if (occ.sets.filter((s: Doc) => s.type === op.setType).length >= 40) throw fail(422, 'VALIDATION', 'Too many sets');
      const sets = makeSets(occ, op.setType, Math.max(0, ...rounds) + 1, occ.exerciseSnapshot.laterality === 'separate_sides');
      if (op.setType === 'warmup') occ.sets.unshift(...sets); else occ.sets.push(...sets);
      return;
    }
    case 'removePendingSet': {
      const occ = findOcc(d, op.exerciseOccurrenceId);
      const round = occ.sets.filter((s: Doc) => s.type === op.setType && s.roundIndex === op.roundIndex);
      if (!round.length) throw fail(404, 'NOT_FOUND', 'Set not found');
      if (round.some((s: Doc) => s.status !== 'pending')) throw fail(409, 'NOT_PENDING', 'Only pending sets can be removed; mark it skipped instead');
      occ.sets = occ.sets.filter((s: Doc) => !round.includes(s));
      return;
    }
    case 'skipExercise': {
      const occ = findOcc(d, op.exerciseOccurrenceId);
      occ.skipped = op.skipped;
      occ.skipReason = op.skipped ? op.reason : null;
      return;
    }
    case 'substituteExercise': {
      const occ = findOcc(d, op.exerciseOccurrenceId);
      if (occ.sets.some((s: Doc) => s.status !== 'pending')) throw fail(409, 'NOT_PENDING', 'Substitute before logging any set of this exercise');
      const c = await activeCatalog();
      const ex = c.exercises.find((e) => e.id === op.exerciseId && !e.archived);
      if (!ex) throw fail(404, 'NOT_FOUND', 'Exercise not in the catalog');
      if (ex.metric !== occ.appliedPrescription.target.metric) throw fail(422, 'VALIDATION', 'Pick an exercise logged the same way (reps vs seconds)');
      occ.originalExerciseSnapshot ??= occ.exerciseSnapshot;
      const perSide = ex.laterality === 'separate_sides';
      Object.assign(occ, { exerciseId: ex.id, exerciseVersion: ex.version, exerciseSnapshot: { ...ex, video: c.videos.get(ex.videoId) ?? null }, loadBasis: ex.defaultLoadBasis, implementCount: ex.defaultImplementCount, variantKey: 'standard' });
      occ.appliedPrescription = { ...occ.appliedPrescription, target: { ...occ.appliedPrescription.target, perSide } };
      const workingRounds = new Set(occ.sets.filter((s: Doc) => s.type === 'working').map((s: Doc) => s.roundIndex)).size;
      occ.sets = [];
      for (let r = 1; r <= workingRounds; r++) occ.sets.push(...makeSets(occ, 'working', r, perSide));
      return;
    }
    case 'addOptionalExercise': {
      if (d.programContext && !d.programContext.allowOptional) throw fail(409, 'PHASE_DISALLOWS_OPTIONAL', 'The current phase does not include optional work');
      const item = (d.planSnapshot.items as PlanItem[]).find((i) => i.id === op.planItemId && i.optional);
      if (!item) throw fail(404, 'NOT_FOUND', 'Optional item not in this plan');
      if (d.exercises.some((o: Doc) => o.planItemId === item.id)) return false;
      const ex = d.planSnapshot.exerciseDefinitions[item.exerciseId] as Exercise;
      d.exercises.push(makeOccurrence(item, ex, d.planSnapshot.videoDefinitions[ex.videoId], d.programContext));
      return;
    }
    case 'updateExercise': {
      const occ = findOcc(d, op.exerciseOccurrenceId);
      if (op.loadBasis && op.loadBasis !== occ.loadBasis && occ.sets.some((s: Doc) => s.actualLoad?.valueGrams != null && s.status !== 'done')) throw fail(409, 'LOAD_MODE', 'Clear entered loads before changing the load mode');
      if (op.variantKey) occ.variantKey = op.variantKey;
      if (op.notes !== undefined) occ.notes = op.notes;
      if (op.setup) occ.setup = op.setup;
      if (op.loadBasis) {
        occ.loadBasis = op.loadBasis;
        occ.implementCount = ['bodyweight', 'none'].includes(op.loadBasis) ? 0 : op.loadBasis === 'per_dumbbell' ? (op.implementCount === 1 ? 1 : 2) : 1;
      } else if (op.implementCount != null && occ.loadBasis === 'per_dumbbell' && [1, 2].includes(op.implementCount)) occ.implementCount = op.implementCount;
      return;
    }
    case 'updateSessionNotes': d.metadata = op.metadata; return;
    case 'updateWarmup': {
      const step = d.warmupChecklist.find((s: Doc) => s.stepId === op.stepId);
      if (!step) throw fail(404, 'NOT_FOUND', 'Warm-up step not found');
      if (step.completed === op.completed) return false;
      Object.assign(step, { completed: op.completed, completedAt: op.completed ? now : null });
      return;
    }
    case 'updateRestTimer': {
      if (op.action === 'clear') { d.restTimer = null; return; }
      const secs = op.durationSeconds ?? 90;
      d.restTimer = { startedAt: now, durationSeconds: secs, endsAt: new Date(now.getTime() + secs * 1000), exerciseOccurrenceId: op.exerciseOccurrenceId ?? null, roundIndex: op.roundIndex ?? null };
      return;
    }
  }
}

/** completed only when every required working set of every non-optional exercise is done. */
export function summarize(d: Doc) {
  let required = 0, done = 0, skipped = 0, pending = 0;
  for (const o of d.exercises) {
    for (const s of o.sets.filter((x: Doc) => x.type === 'working')) {
      if (!o.optional) required++;
      if (s.status === 'done') { if (!o.optional) done++; } else if (o.skipped || s.status === 'skipped') skipped++; else pending++;
    }
  }
  return { required, done, skipped, pending, complete: required > 0 && done === required };
}

const CreateDto = z.strictObject({
  clientSessionId: zUuid, planId: z.string().max(100), planVersion: zInt(1, 100000), packId: z.string().max(100), packVersion: zInt(1, 100000),
  applyProgram: z.boolean().default(true), startedAt: zIso.optional(), timezone: zTz, source: z.enum(['live', 'manual_backfill']).default('live'),
});
const TimeDto = z.strictObject({ operationId: zUuid, at: zIso.optional() });
const FinishDto = z.strictObject({ operationId: zUuid, expectedRevision: zInt(1, 1e9), outcome: z.enum(['finish', 'abandon']), endedAt: zIso.optional() });
const CorrectionDto = z.strictObject({ operationId: zUuid, expectedRevision: zInt(1, 1e9), reason: z.string().trim().min(3).max(1000), operations: z.array(z.discriminatedUnion('type', [SetActual, UpdateExercise, UpdateSessionNotes])).min(1).max(50) });

@Controller()
export class SessionsController {
  @Post('sessions')
  async create(@Req() req: Request, @Body() body: unknown) {
    const user = req.user!;
    const dto = parse(CreateDto, body);
    const createPayloadHash = hashPayload({ ...dto, startedAt: dto.startedAt?.toISOString() ?? null });
    const prior = await TrainingSession.findOne({ ownerId: user.id, clientSessionId: dto.clientSessionId }).lean<Doc>();
    if (prior) {
      if (prior.createPayloadHash !== createPayloadHash) throw fail(409, 'OPERATION_REUSED', 'clientSessionId already used with a different payload');
      return view(prior);
    }
    const active = await TrainingSession.findOne({ ownerId: user.id, isActive: true }, { _id: 1 }).lean();
    if (active) throw fail(409, 'ACTIVE_SESSION_EXISTS', 'Finish or abandon the current workout first', { activeSessionId: active._id });
    const now = new Date();
    const startedAt = dto.startedAt ?? now;
    if (dto.source === 'live' && Math.abs(startedAt.getTime() - now.getTime()) > 10 * 60_000) throw fail(422, 'VALIDATION', 'A live workout starts now; use a manual entry for past workouts', { fieldErrors: { startedAt: 'Not now' } });
    if (startedAt.getTime() > now.getTime() + 60_000) throw fail(422, 'VALIDATION', 'Start time is in the future', { fieldErrors: { startedAt: 'Future' } });
    const pack = await loadPack(dto.packId, dto.packVersion);
    const r = pack && resolvePlan(pack, dto.planId, dto.planVersion);
    if (!r) throw fail(404, 'NOT_FOUND', 'Plan version not found');
    const lp = localParts(startedAt, dto.timezone);
    const programContext = dto.applyProgram ? await programContextFor(user.id, r.plan, lp.localDate) : null;
    const plan: Plan = r.plan;
    const used = new Set(plan.items.map((i) => i.exerciseId));
    const exerciseDefinitions = Object.fromEntries(Object.entries(r.exercises).filter(([id]) => used.has(id)));
    const videoIds = new Set([plan.exampleVideoId, plan.warmup.videoId, ...Object.values(exerciseDefinitions).map((e) => e.videoId)]);
    const videoDefinitions = Object.fromEntries(Object.entries(r.videos).filter(([id]) => videoIds.has(id)));
    const doc = {
      _id: randomUUID(), ownerId: user.id, clientSessionId: dto.clientSessionId, createPayloadHash, revision: 1,
      planRef: { id: plan.id, version: plan.version, packId: r.packId, packVersion: r.packVersion },
      planSnapshot: { ...plan, exerciseDefinitions, videoDefinitions },
      programContext, status: 'in_progress', isActive: true, source: dto.source, startedAt, endedAt: null,
      timezone: dto.timezone, startUtcOffsetMinutes: lp.offsetMinutes, localDate: lp.localDate,
      warmupChecklist: plan.warmup.steps.map((s) => ({ stepId: s.id, completed: false, completedAt: null })),
      exercises: plan.items.filter((i) => !i.optional).map((i) => makeOccurrence(i, r.exercises[i.exerciseId], r.videos[r.exercises[i.exerciseId].videoId], programContext)),
    };
    try {
      await TrainingSession.create(doc as Doc);
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      const again = await TrainingSession.findOne({ ownerId: user.id, clientSessionId: dto.clientSessionId }).lean<Doc>();
      if (again && again.createPayloadHash === createPayloadHash) return view(again);
      const act = await TrainingSession.findOne({ ownerId: user.id, isActive: true }, { _id: 1 }).lean();
      throw fail(409, 'ACTIVE_SESSION_EXISTS', 'Finish or abandon the current workout first', { activeSessionId: act?._id ?? null });
    }
    return view((await TrainingSession.findById(doc._id).lean<Doc>())!);
  }

  @Get('sessions/active')
  async active(@Req() req: Request) {
    const d = await TrainingSession.findOne({ ownerId: req.user!.id, isActive: true }).lean<Doc>();
    return { session: d ? view(d) : null };
  }

  @Get('sessions')
  async list(@Req() req: Request, @Query() q: Record<string, string>) {
    const f: Doc = { ownerId: req.user!.id, deletedAt: null, isActive: false };
    if (q.from || q.to) f.localDate = { ...(q.from && { $gte: String(q.from) }), ...(q.to && { $lte: String(q.to) }) };
    if (q.planId) f['planRef.id'] = String(q.planId);
    if (q.exerciseId) f['exercises.exerciseId'] = String(q.exerciseId);
    if (q.status) f.status = String(q.status);
    if (q.before) f.startedAt = { $lt: new Date(String(q.before)) };
    const limit = Math.min(50, Number(q.limit) || 20);
    const docs = await TrainingSession.find(f, { 'planSnapshot.items': 0, 'planSnapshot.exerciseDefinitions': 0, 'planSnapshot.videoDefinitions': 0, 'planSnapshot.warmup': 0, appliedOperations: 0 }).sort({ startedAt: -1 }).limit(limit + 1).lean<Doc[]>();
    const items = docs.slice(0, limit).map((d) => ({
      id: d._id, planRef: d.planRef, planName: d.planSnapshot?.name, status: d.status, source: d.source, startedAt: d.startedAt, endedAt: d.endedAt, localDate: d.localDate,
      timezone: d.timezone, activeSeconds: d.activeSeconds, elapsedSeconds: d.elapsedSeconds, summary: summarize(d),
      exercises: d.exercises.map((o: Doc) => ({ exerciseId: o.exerciseId, name: o.exerciseSnapshot.name, done: o.sets.filter((s: Doc) => s.status === 'done' && s.type === 'working').length })),
    }));
    return { items, nextCursor: docs.length > limit ? items[items.length - 1].startedAt : null };
  }

  @Get('sessions/:id')
  async get(@Req() req: Request, @Param('id') id: string) {
    const d = await TrainingSession.findOne({ _id: id, ownerId: req.user!.id, deletedAt: null }).lean<Doc>();
    if (!d) throw fail(404, 'NOT_FOUND', 'Session not found');
    return view(d);
  }

  @Patch('sessions/:id')
  async patch(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const env = parse(Envelope, body);
    const op = parse(Op, env.op);
    return mutate(req.user!, id, env.operationId, { op }, env.expectedRevision, (d, now) => applyOp(d, op, now, req.user!));
  }

  @Post('sessions/:id/pause')
  @HttpCode(200)
  async pause(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(TimeDto, body);
    return mutate(req.user!, id, dto.operationId, { pause: dto.at?.toISOString() ?? null }, null, (d, now) => {
      if (d.status === 'paused') return false;
      d.pauses.push({ startedAt: clampTime(d, dto.at, now), endedAt: null });
      d.status = 'paused';
    });
  }

  @Post('sessions/:id/resume')
  @HttpCode(200)
  async resume(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(TimeDto, body);
    return mutate(req.user!, id, dto.operationId, { resume: dto.at?.toISOString() ?? null }, null, (d, now) => {
      if (d.status !== 'paused') return false;
      const open = d.pauses[d.pauses.length - 1];
      const at = clampTime(d, dto.at, now);
      open.endedAt = at < new Date(open.startedAt) ? new Date(open.startedAt) : at;
      d.status = 'in_progress';
    });
  }

  @Post('sessions/:id/finish')
  @HttpCode(200)
  async finish(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(FinishDto, body);
    return mutate(req.user!, id, dto.operationId, { ...dto, endedAt: dto.endedAt?.toISOString() ?? null }, dto.expectedRevision, (d, now) => finishDoc(d, dto.outcome, clampTime(d, dto.endedAt, now)));
  }

  @Post('sessions/:id/corrections')
  @HttpCode(200)
  async correct(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(CorrectionDto, body);
    return mutate(req.user!, id, dto.operationId, dto, dto.expectedRevision, async (d, now) => {
      if (d.isActive) throw fail(409, 'SESSION_ACTIVE', 'Edit the live workout directly; corrections are for finished workouts');
      const before: Doc = {}, after: Doc = {};
      for (const op of dto.operations) {
        const key = op.type === 'updateSessionNotes' ? 'metadata' : op.type === 'setActual' ? `set:${op.setId}` : `exercise:${op.exerciseOccurrenceId}`;
        const snap = () => (op.type === 'updateSessionNotes' ? d.metadata : op.type === 'setActual' ? findSet(findOcc(d, op.exerciseOccurrenceId), op.setId) : (({ sets: _s, ...o }) => o)(findOcc(d, op.exerciseOccurrenceId)));
        before[key] ??= structuredClone(snap());
        if (op.type === 'setActual') applySetActual(d, op, now, null);
        else if (op.type === 'updateSessionNotes') d.metadata = op.metadata;
        else await applyOp(d, op, now, req.user!);
        after[key] = structuredClone(snap());
      }
      d.corrections.push({ at: now, actorId: req.user!.id, reason: dto.reason, before, after });
      d.correctedAt = now;
      d.status = summarize(d).complete && d.status !== 'abandoned' ? 'completed' : d.status === 'completed' ? 'partial' : d.status;
    }, { closed: true });
  }

  @Get('exercises/:id/previous')
  async previous(@Req() req: Request, @Param('id') exerciseId: string, @Query() q: Record<string, string>) {
    const docs = await TrainingSession.find(
      { ownerId: req.user!.id, deletedAt: null, status: { $in: ['completed', 'partial'] }, 'exercises.exerciseId': exerciseId, ...(q.excludeSessionId && { _id: { $ne: String(q.excludeSessionId) } }) },
      { exercises: 1, localDate: 1, startedAt: 1 },
    ).sort({ startedAt: -1 }).limit(30).lean<Doc[]>();
    const incline = q.inclineSupportHeightMm ? Number(q.inclineSupportHeightMm) : null;
    for (const d of docs) {
      const occ = d.exercises.find((o: Doc) => o.exerciseId === exerciseId && (!q.variantKey || o.variantKey === q.variantKey) && (!q.loadBasis || o.loadBasis === q.loadBasis) &&
        (q.inclineSupportHeightMm === undefined || (o.setup?.inclineSupportHeightMm ?? null) === incline) && o.sets.some((s: Doc) => s.status === 'done' && s.type === 'working'));
      if (occ) return { previous: { sessionId: d._id, localDate: d.localDate, startedAt: d.startedAt, variantKey: occ.variantKey, loadBasis: occ.loadBasis, setup: occ.setup, sets: occ.sets.filter((s: Doc) => s.status === 'done' && s.type === 'working') } };
    }
    return { previous: null };
  }
}

export function finishDoc(d: Doc, outcome: 'finish' | 'abandon', end: Date) {
  const start = new Date(d.startedAt);
  if (end < start) throw fail(422, 'VALIDATION', 'Finish time is before the start', { fieldErrors: { endedAt: 'Before start' } });
  for (const p of d.pauses) {
    if (!p.endedAt) p.endedAt = end < new Date(p.startedAt) ? new Date(p.startedAt) : end;
    if (new Date(p.startedAt) > end) throw fail(422, 'VALIDATION', 'Finish time is before a pause', { fieldErrors: { endedAt: 'Before a pause' } });
  }
  const paused = d.pauses.reduce((t: number, p: Doc) => t + (Math.min(new Date(p.endedAt).getTime(), end.getTime()) - new Date(p.startedAt).getTime()), 0);
  d.endedAt = end;
  d.elapsedSeconds = Math.round((end.getTime() - start.getTime()) / 1000);
  d.activeSeconds = Math.max(0, Math.round((end.getTime() - start.getTime() - paused) / 1000));
  d.status = outcome === 'abandon' ? 'abandoned' : summarize(d).complete ? 'completed' : 'partial';
  d.isActive = false;
  d.restTimer = null;
}

export async function programContextFor(userId: string, plan: Plan, localDate: string) {
  const u = await User.findById(userId).lean();
  const sel = u?.program;
  if (!sel?.programId || !sel.startDate) return null;
  const program = (await activeCatalog()).programs.find((p) => p.id === sel.programId);
  if (!program || !programPlanIds(program).has(plan.id)) return null;
  const pos = programPosition(program, { programId: sel.programId, startDate: sel.startDate, heldPhaseIndex: sel.heldPhaseIndex ?? null }, localDate)!;
  return { programId: program.id, programVersion: program.version, programWeek: pos.programWeek, phaseIndex: pos.phaseIndex, phaseName: pos.phase.name, workingSetCap: pos.phase.workingSetCap, rir: pos.phase.rir, allowOptional: pos.phase.allowOptional };
}
