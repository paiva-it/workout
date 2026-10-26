import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyPhase, blockRest, effortCue, externalVolumeKgReps, localParts, localToInstants, nextScheduled, parseKgToGrams, programPosition, programWeek, type Load, type TrainingPack } from './index.js';

const root = new URL('../../../', import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL('fixtures/logging-cases.json', root), 'utf8'));
const pack: TrainingPack = JSON.parse(readFileSync(new URL('data/training-pack.v1.json', root), 'utf8'));
const program = (id: string) => pack.programs.find((p) => p.id === id)!;
const plan = (id: string) => pack.plans.find((p) => p.id === id)!;

describe('fixtures', () => {
  it.each(fixtures.cases)('volume $id', (c: { reps: number; load: Load; expectedExternalVolumeKgReps: number | null }) => {
    expect(externalVolumeKgReps(c.reps, c.load)).toBe(c.expectedExternalVolumeKgReps);
  });
  it.each(fixtures.parseCases)('parse $input', (c: { input: string; expectedGrams: number }) => {
    expect(parseKgToGrams(c.input)).toBe(c.expectedGrams);
  });
  it('rejects junk weights', () => {
    for (const s of ['', 'abc', '1e3', 'NaN', '-5', '80.5.5', 'Infinity']) expect(parseKgToGrams(s)).toBeNull();
    expect(parseKgToGrams('80')).toBe(80000);
  });
  it.each(fixtures.timeCases)('Lisbon DST $instantUtc', (c: { instantUtc: string; timezone: string; localDate: string; localTime: string; utcOffsetMinutes: number }) => {
    expect(localParts(new Date(c.instantUtc), c.timezone)).toEqual({ localDate: c.localDate, localTime: c.localTime, offsetMinutes: c.utcOffsetMinutes });
  });
  it('repeated local hour resolves to two distinct instants; gap resolves to none', () => {
    expect(localToInstants('2026-10-25T01:30', 'Europe/Lisbon').map((d) => d.toISOString())).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
    expect(localToInstants('2026-03-29T01:30', 'Europe/Lisbon')).toEqual([]);
    expect(localToInstants('2026-06-01T10:00', 'Europe/Lisbon').map((d) => d.toISOString())).toEqual(['2026-06-01T09:00:00.000Z']);
  });
});

describe('restart program phases', () => {
  const p = program('return-to-training');
  const pos = (today: string) => programPosition(p, { programId: p.id, startDate: '2026-10-26', heldPhaseIndex: null }, today)!;
  it('week 1: two sessions, one set, RIR 4-5, optional omitted', () => {
    const w = pos('2026-10-28');
    expect(w.programWeek).toBe(1);
    expect(w.schedule.map((s) => s.planId)).toEqual(['restart-a', 'restart-b']);
    for (const item of plan('restart-a').items) {
      const eff = applyPhase(item, w.phase);
      expect(eff.workingSets).toBe(1);
      if (item.targetRir) expect(eff.rir).toEqual([Math.max(4, item.targetRir[0]), Math.max(5, item.targetRir[1])]);
      else expect(eff.rir).toBeNull();
    }
    expect(w.phase.allowOptional).toBe(false);
  });
  it('week 2: three sessions, still one set', () => {
    const w = pos('2026-11-02');
    expect(w.programWeek).toBe(2);
    expect(w.schedule).toHaveLength(3);
    expect(applyPhase(plan('restart-b').items[0], w.phase).workingSets).toBe(1);
  });
  it('weeks 3-4 cap at two sets, RIR 3-4, alternate schedules', () => {
    const w3 = pos('2026-11-09'), w4 = pos('2026-11-16');
    expect([w3.programWeek, w4.programWeek]).toEqual([3, 4]);
    expect(w3.schedule.map((s) => s.planId)).toEqual(['restart-b', 'restart-a', 'restart-b']);
    expect(w4.schedule.map((s) => s.planId)).toEqual(['restart-a', 'restart-b', 'restart-a']);
    const item = { ...plan('restart-a').items[0], workingSets: 3, targetRir: [2, 3] as [number, number] };
    expect(applyPhase(item, w3.phase)).toEqual({ workingSets: 2, rir: [3, 4] });
  });
  it('week 9 stays in the indefinite final phase', () => {
    expect(pos('2026-12-21').phase.weeks).toEqual([5, null]);
  });
  it('held phase wins over the calendar', () => {
    expect(programPosition(p, { programId: p.id, startDate: '2026-10-26', heldPhaseIndex: 0 }, '2026-12-21')!.phase.workingSetCap).toBe(1);
  });
  it('missed days resume the sequence without stacking', () => {
    const w = pos('2026-10-30');
    expect(nextScheduled(w, 0)!.planId).toBe('restart-a');
    expect(nextScheduled(w, 1)!.planId).toBe('restart-b');
    expect(nextScheduled(w, 2)).toBeNull();
  });
});

describe('focus program', () => {
  const p = program('five-focus-days');
  it('first two weeks cap 2 / RIR 3-4; week 3 listed volume RIR 2-3 and optional allowed but not added', () => {
    const w1 = programPosition(p, { programId: p.id, startDate: '2026-11-23', heldPhaseIndex: null }, '2026-11-24')!;
    expect(w1.schedule.map((s) => s.planId)).toEqual(['chest', 'back', 'legs', 'shoulders-core', 'recovery', 'arms', 'recovery']);
    const chest = plan('chest').items.filter((i) => !i.optional);
    for (const i of chest) expect(applyPhase(i, w1.phase).workingSets).toBe(Math.min(2, i.workingSets));
    const w3 = programPosition(p, { programId: p.id, startDate: '2026-11-23', heldPhaseIndex: null }, '2026-12-08')!;
    expect(w3.programWeek).toBe(3);
    for (const i of chest) expect(applyPhase(i, w3.phase).workingSets).toBe(i.workingSets);
    expect(w3.phase.allowOptional).toBe(true);
  });
});

it('programWeek counts Monday-based weeks', () => {
  expect(programWeek('2026-10-25', '2026-10-25')).toBe(1); // Sunday start
  expect(programWeek('2026-10-25', '2026-10-26')).toBe(2);
});

describe('v2 fixed program', () => {
  const v2: TrainingPack = JSON.parse(readFileSync(new URL('data/training-pack.v2.json', root), 'utf8'));
  const p = v2.programs[0];
  it('needs no start date, never caps sets, and keeps the same week forever', () => {
    const a = programPosition(p, { programId: p.id, startDate: null, heldPhaseIndex: null }, '2026-10-27')!;
    const b = programPosition(p, { programId: p.id, startDate: '2026-01-05', heldPhaseIndex: null }, '2026-10-27')!;
    expect(a.schedule.map((s) => s.planId)).toEqual(['arms', 'legs', 'chest', 'core']);
    expect(b.schedule).toEqual(a.schedule);
    expect(a.phase.workingSetCap).toBeNull();
    for (const plan of v2.plans) for (const i of plan.items) expect(applyPhase(i, a.phase).workingSets).toBe(i.workingSets);
  });
  it('an obsolete held phase index cannot restore an old cap', () => {
    const held = programPosition(p, { programId: p.id, startDate: null, heldPhaseIndex: 2 }, '2026-10-27')!;
    expect(held.phase.workingSetCap).toBeNull();
  });
});

describe('schema-3 rounds', () => {
  const b = { rounds: 3, itemIds: ['row', 'push'], restBetweenExercisesSeconds: 60, restBetweenRoundsSeconds: 120, restAfterBlockSeconds: 120 };
  const last = { ...b, rounds: 2, restAfterBlockSeconds: 0 };
  it('one boundary per resolved member: exercise, round, block (never summed), end', () => {
    expect(blockRest([b, last], 0, 1, 0)).toEqual({ kind: 'exercise', seconds: 60 });
    expect(blockRest([b, last], 0, 2, 1)).toEqual({ kind: 'round', seconds: 120 });
    expect(blockRest([b, last], 0, 3, 1)).toEqual({ kind: 'block', seconds: 120 });
    expect(blockRest([b, last], 1, 2, 1)).toEqual({ kind: 'end', seconds: 0 });
  });
  it('plain-English effort; holds get a form cue', () => {
    expect(effortCue([2, 3])).toBe('Finish while you could still do 2-3 more good reps.');
    expect(effortCue([2, 3], 'duration')).toBe('Stop before your position starts to slip.');
    expect(effortCue(null)).toBe('');
  });
});
