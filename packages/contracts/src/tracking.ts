/** Canonical session/measurement types (copied from contracts/tracking.ts). IDs are UUID strings,
 * JSON timestamps are ISO UTC. Validated at runtime by the API (zod), not by these types. */
export type UUID = string;
export type Instant = string;
export type LocalDate = string;
export type Side = 'both' | 'left' | 'right';
export type LoadBasis = 'per_dumbbell' | 'single_dumbbell' | 'barbell_total' | 'external_total' | 'bodyweight' | 'none';
export interface Load {
  basis: LoadBasis;
  valueGrams: number | null;
  implementCount: 0 | 1 | 2;
  addedGrams: number;
  assistanceGrams: number;
  enteredUnit: 'kg';
}
export interface SetRecord {
  id: UUID;
  roundIndex: number; // 1-based; left/right share an index but have different IDs.
  side: Side;
  type: 'warmup' | 'working';
  status: 'pending' | 'done' | 'skipped';
  target: { metric: 'reps' | 'duration'; min: number; max: number; rir: [number, number] | null };
  actualReps: number | null;
  actualDurationSeconds: number | null;
  actualLoad: Load | null;
  actualRir: number | null;
  failedAttempt: boolean;
  completedAt: Instant | null;
  recordedAt: Instant | null;
  notes: string | null;
  skipReason: string | null;
}
export interface DefinitionRef { id: string; version: number; packId: string; packVersion: number }
export interface ExerciseOccurrence {
  id: UUID;
  planItemId: string | null;
  exerciseId: string;
  exerciseVersion: number;
  exerciseSnapshot: Record<string, unknown>; // Implement a concrete type from the import schema.
  originalExerciseSnapshot: Record<string, unknown> | null; // Filled for substitution.
  originalPrescription: Record<string, unknown>;
  appliedPrescription: Record<string, unknown>; // Effective phase cap, RIR, variant, rest.
  variantKey: string;
  setup: { inclineSupportHeightMm: number | null; supportDescription: string | null; benchAngleDegrees: number | null; notes: string | null };
  optional: boolean;
  sets: SetRecord[];
  notes: string | null;
  skipped: boolean;
}
export interface TrainingSession {
  schemaVersion: 1;
  id: UUID;
  ownerId: UUID;
  clientSessionId: UUID;
  revision: number;
  planRef: DefinitionRef;
  planSnapshot: Record<string, unknown>;
  programContext: { programId: string; programVersion: number; programWeek: number; phaseName: string; workingSetCap: number | null; rir: [number, number]; allowOptional: boolean } | null;
  status: 'in_progress' | 'paused' | 'completed' | 'partial' | 'abandoned';
  isActive: boolean;
  source: 'live' | 'manual_backfill' | 'import';
  startedAt: Instant;
  endedAt: Instant | null;
  timezone: string;
  startUtcOffsetMinutes: number;
  localDate: LocalDate;
  pauses: { startedAt: Instant; endedAt: Instant | null }[];
  elapsedSeconds: number | null;
  activeSeconds: number | null;
  warmupChecklist: { stepId: string; completed: boolean; completedAt: Instant | null }[];
  restTimer: { startedAt: Instant; durationSeconds: number; endsAt: Instant; exerciseOccurrenceId: UUID; roundIndex: number } | null;
  exercises: ExerciseOccurrence[];
  metadata: { energy: number | null; soreness: number | null; sleepMinutes: number | null; sessionRpe: number | null; notes: string | null };
  appliedOperations: { operationId: UUID; payloadHash: string; appliedRevision: number }[];
  corrections: { at: Instant; actorId: UUID; reason: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
  deletedAt: Instant | null;
  createdAt: Instant;
  updatedAt: Instant;
}
export interface BodyMeasurement {
  schemaVersion: 1;
  id: UUID;
  ownerId: UUID;
  clientMeasurementId: UUID;
  profileImportKey: string | null;
  revision: number;
  massGrams: number;
  enteredUnit: 'kg';
  measuredAt: Instant | null;
  datePrecision: 'instant' | 'day';
  localDate: LocalDate;
  timezone: string;
  utcOffsetMinutes: number | null;
  source: 'scale_measurement' | 'self_report' | 'import';
  context: { timeOfDay: 'morning' | 'afternoon' | 'evening' | 'unknown'; beforeFood: boolean | null; scaleLabel: string | null; notes: string | null };
  corrections: { at: Instant; reason: string; previous: Record<string, unknown> }[];
  deletedAt: Instant | null;
  createdAt: Instant;
  updatedAt: Instant;
}
