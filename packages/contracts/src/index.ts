export * from './tracking.js';
import type { Load } from './tracking.js';

// ---- Pack shapes (mirror contracts/training-pack.schema.json; Ajv on the API is the real check) ----
export type Weekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
export const WEEKDAYS: Weekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export interface Video { id: string; provider: 'youtube'; youtubeId: string; url: string; title: string; channel: string; checkedOn: string; verification: string; playbackVerified: boolean; embeddingVerified: boolean; usageNote: string }
export interface Exercise {
  id: string; version: number; name: string; primaryMuscles: string[]; secondaryMuscles: string[]; movementPattern: string;
  equipment: string[]; metric: 'reps' | 'duration'; laterality: 'bilateral' | 'separate_sides';
  repsMeaning: 'per_side' | 'simultaneous_repetitions' | 'seconds' | 'alternating_total'; defaultLoadBasis: Load['basis']; defaultImplementCount: number;
  videoId: string; cues: string[]; regression: string; archived: boolean;
}
export interface PlanItem {
  id: string; exerciseId: string; exerciseVersion: number; workingSets: number;
  target: { metric: 'reps' | 'duration'; min: number; max: number; perSide: boolean };
  restSeconds: number; restAfter: 'both_sides' | 'set'; targetRir: [number, number] | null; optional: boolean; defaultVariant: string; notes: string;
}
export interface WarmupStep { id: string; label: string; durationSeconds?: number; reps?: number; notes: string }
export type SectionRole = 'pulse_raise' | 'mobility' | 'rehearsal' | 'easy_movement' | 'stretch';
/** Schema 2: an exercise-linked warm-up/cooldown activity. Never a working set. */
export interface SectionStep {
  id: string; exerciseId: string; exerciseVersion: number; sets: number; target: PlanItem['target'];
  restSeconds: number; restAfter: 'both_sides' | 'set'; defaultVariant: string; role: SectionRole; linkedWorkoutItemId: string | null; notes: string;
}
export const isSectionStep = (s: WarmupStep | SectionStep): s is SectionStep => 'exerciseId' in s;
/** Schema 3: one set of each member in order, then repeat the whole block `rounds` times. */
export interface WorkoutBlock {
  id: string; name: string; rounds: number; itemIds: string[]; notes: string;
  restBetweenExercisesSeconds: number; restBetweenRoundsSeconds: number; restAfterBlockSeconds: number;
}
export interface Plan {
  id: string; version: number; name: string; kind: 'restart' | 'focus' | 'recovery'; focus: string[]; estimatedDurationMinutes: [number, number];
  exampleVideoId: string; exampleVideoLabel: string; warmup: { durationMinutes: [number, number]; videoId: string; steps: WarmupStep[] | SectionStep[] };
  items: PlanItem[]; cooldown: { durationMinutes: [number, number]; instructions: string[]; steps?: SectionStep[] }; notes: string[]; archived: boolean;
  workoutBlocks?: WorkoutBlock[];
}
export interface ScheduleEntry { weekday: Weekday; planId: string; fullRestAllowed?: boolean }
export interface Phase {
  weeks: [number, number | null]; name: string; schedule?: ScheduleEntry[]; alternatingSchedules?: ScheduleEntry[][];
  workingSetCap: number | null; allowOptional: boolean; rir: [number, number]; notes: string;
}
export interface Program {
  id: string; version: number; name: string; recommendedDefault: boolean; startDatePolicy: string; weekStart: 'monday';
  schedule?: ScheduleEntry[]; phases: Phase[]; transitionPolicy?: string; missedDayPolicy?: string;
}
export interface TrainingPack {
  schemaVersion: 1 | 2 | 3; packId: string; version: number; title: string; createdOn: string; language: 'en-US'; units: 'kg';
  description: string; assumptions: string[]; videos: Video[]; exercises: Exercise[]; plans: Plan[]; programs: Program[];
}

// ---- Units ----
/** "80,5" / "80.5" / "80" kg -> integer grams. null for blank/invalid. Max 3 decimals (gram precision). */
export function parseKgToGrams(input: string): number | null {
  const s = input.trim().replace(',', '.');
  if (!/^\d{1,4}(\.\d{1,3})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
}
export const gramsToKg = (g: number | null | undefined) => (g == null ? '' : String(g / 1000));

/** Optional external-load volume (kg-reps). null when no external load applies (bodyweight, none, holds). */
export function externalVolumeKgReps(reps: number | null, load: Pick<Load, 'basis' | 'valueGrams' | 'implementCount'> | null): number | null {
  if (!reps || !load || load.valueGrams == null) return null;
  if (load.basis === 'bodyweight' || load.basis === 'none') return null;
  const implements_ = load.basis === 'per_dumbbell' ? load.implementCount : 1;
  return (reps * load.valueGrams * implements_) / 1000;
}

// ---- Time ----
export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz.length > 0; } catch { return false; }
}
/** Local wall-clock parts and UTC offset (minutes east of UTC) of an instant in a zone. */
export function localParts(instant: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  const localDate = `${p.year}-${p.month}-${p.day}`;
  const localTime = `${p.hour}:${p.minute}`;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offsetMinutes = Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
  return { localDate, localTime, offsetMinutes };
}
/** All instants that display as `local` ("YYYY-MM-DDTHH:mm") in the zone: 0 (DST gap), 1, or 2 (repeated hour). */
export function localToInstants(local: string, timeZone: string): Date[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return [];
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const out = new Map<number, Date>();
  for (let off = -14 * 60; off <= 14 * 60; off += 15) {
    const d = new Date(naive - off * 60000);
    const lp = localParts(d, timeZone);
    if (`${lp.localDate}T${lp.localTime}` === local && lp.offsetMinutes === off) out.set(d.getTime(), d);
  }
  return [...out.values()].sort((a, b) => a.getTime() - b.getTime());
}
const dayNumber = (isoDate: string) => Date.UTC(+isoDate.slice(0, 4), +isoDate.slice(5, 7) - 1, +isoDate.slice(8, 10)) / 86400000;
/** Monday-based weekday index (0 = monday) for a calendar date. */
export const weekdayIndex = (isoDate: string) => (new Date(dayNumber(isoDate) * 86400000).getUTCDay() + 6) % 7;

// ---- Program / phase application ----
/** 1-based program week; weeks start on Monday, counted from the week containing startDate. */
export function programWeek(startDate: string, today: string): number {
  const startMonday = dayNumber(startDate) - weekdayIndex(startDate);
  const todayMonday = dayNumber(today) - weekdayIndex(today);
  return Math.max(1, Math.floor((todayMonday - startMonday) / 7) + 1);
}
export function phaseIndexForWeek(program: Program, week: number): number {
  const i = program.phases.findIndex((ph) => week >= ph.weeks[0] && (ph.weeks[1] === null || week <= ph.weeks[1]));
  return i === -1 ? program.phases.length - 1 : i;
}
export function scheduleFor(program: Program, phase: Phase, week: number): ScheduleEntry[] {
  const s = phase.schedule ?? (phase.alternatingSchedules ? phase.alternatingSchedules[(week - phase.weeks[0]) % phase.alternatingSchedules.length] : program.schedule) ?? [];
  return [...s].sort((a, b) => WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday));
}
/** Phase overrides: sets = min(listed, cap); RIR = elementwise max(item, phase) so easier items stay easier; null RIR stays null. */
export function applyPhase(item: PlanItem, phase: Pick<Phase, 'workingSetCap' | 'rir'> | null) {
  if (!phase) return { workingSets: item.workingSets, rir: item.targetRir };
  const workingSets = phase.workingSetCap == null ? item.workingSets : Math.min(item.workingSets, phase.workingSetCap);
  const rir: [number, number] | null = item.targetRir ? [Math.max(item.targetRir[0], phase.rir[0]), Math.max(item.targetRir[1], phase.rir[1])] : null;
  return { workingSets, rir };
}

export interface ProgramSelection { programId: string | null; startDate: string | null; heldPhaseIndex: number | null }
export interface ProgramPosition { programId: string; programVersion: number; programWeek: number; phaseIndex: number; phase: Phase; schedule: ScheduleEntry[] }
/** One open-ended phase: nothing changes week to week, so no start date or phase controls are needed. */
export const isFixedProgram = (p: Program) => p.phases.length === 1 && p.phases[0].weeks[0] === 1 && p.phases[0].weeks[1] === null;
export function programPosition(program: Program, sel: ProgramSelection, today: string): ProgramPosition | null {
  if (!sel.startDate && !isFixedProgram(program)) return null;
  const week = sel.startDate ? programWeek(sel.startDate, today) : 1;
  const phaseIndex = sel.heldPhaseIndex != null && program.phases[sel.heldPhaseIndex] ? sel.heldPhaseIndex : phaseIndexForWeek(program, week);
  const phase = program.phases[phaseIndex];
  // A held phase uses its own first week for alternation so the schedule stays defined.
  const schedWeek = sel.heldPhaseIndex != null ? Math.max(week, phase.weeks[0]) : week;
  return { programId: program.id, programVersion: program.version, programWeek: week, phaseIndex, phase, schedule: scheduleFor(program, phase, schedWeek) };
}
/** Next session in sequence: entry after the ones already done this program week. Missed days never stack. */
export function nextScheduled(pos: ProgramPosition, doneThisWeek: number): ScheduleEntry | null {
  return pos.schedule[doneThisWeek] ?? null;
}

/** Rest owed after `memberIndex` of `round` resolves: between exercises, between rounds, after the block, or none (end of workout). One boundary only, never summed. */
export function blockRest(blocks: Pick<WorkoutBlock, 'rounds' | 'itemIds' | 'restBetweenExercisesSeconds' | 'restBetweenRoundsSeconds' | 'restAfterBlockSeconds'>[], blockIndex: number, round: number, memberIndex: number) {
  const b = blocks[blockIndex];
  if (memberIndex < b.itemIds.length - 1) return { kind: 'exercise' as const, seconds: b.restBetweenExercisesSeconds };
  if (round < b.rounds) return { kind: 'round' as const, seconds: b.restBetweenRoundsSeconds };
  if (blockIndex < blocks.length - 1) return { kind: 'block' as const, seconds: b.restAfterBlockSeconds };
  return { kind: 'end' as const, seconds: 0 };
}
/** Plain-English effort cue; RIR stays internal metadata. Holds get a form cue instead of spare reps. */
export const effortCue = (rir: [number, number] | null | undefined, metric: 'reps' | 'duration' = 'reps') =>
  metric === 'duration' ? 'Stop before your position starts to slip.' : rir ? `Finish while you could still do ${rir[0] === rir[1] ? rir[0] : `${rir[0]}-${rir[1]}`} more good reps.` : '';

// ---- API error shape ----
export interface ApiError { code: string; message: string; fieldErrors?: Record<string, string>; requestId: string }
