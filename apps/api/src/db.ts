import mongoose, { Schema } from 'mongoose';

const ts = { timestamps: true, versionKey: false } as const;
const sub = { _id: false, id: false } as const;
const Mixed = Schema.Types.Mixed;

const UserSchema = new Schema(
  {
    _id: String,
    schemaVersion: { type: Number, default: 1 },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    passwordChangedAt: { type: Date, default: null },
    displayName: { type: String, default: '' },
    timezone: { type: String, default: 'Europe/Lisbon' },
    units: { type: String, enum: ['kg'], default: 'kg' },
    equipment: { type: [String], default: [] },
    restTimerEnabled: { type: Boolean, default: true },
    program: new Schema({ programId: { type: String, default: null }, startDate: { type: String, default: null }, heldPhaseIndex: { type: Number, default: null } }, sub),
    profile: { type: Mixed, default: {} },
    profileImportKeys: { type: [String], default: [] },
    revision: { type: Number, default: 1 },
  },
  ts,
);

const AuthSessionSchema = new Schema(
  {
    _id: String, // sha256(token) hex; raw token only ever lives in the cookie
    userId: { type: String, required: true, index: true },
    csrfToken: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

const TrainingPackSchema = new Schema(
  {
    _id: String, // `${packId}@${version}`
    schemaVersion: { type: Number, default: 1 },
    packId: { type: String, required: true },
    version: { type: Number, required: true },
    contentHash: { type: String, required: true },
    content: { type: Mixed, required: true },
    importedAt: { type: Date, required: true },
    importedBy: { type: String, required: true },
  },
  { versionKey: false, minimize: false },
);
TrainingPackSchema.index({ packId: 1, version: 1 }, { unique: true });

const CatalogStateSchema = new Schema(
  { _id: String, revision: { type: Number, default: 0 }, activePacks: { type: [new Schema({ packId: String, version: Number }, sub)], default: [] } },
  ts,
);

const LoadSchema = new Schema({ basis: String, valueGrams: { type: Number, default: null }, implementCount: Number, addedGrams: Number, assistanceGrams: Number, enteredUnit: String }, sub);
const SetSchema = new Schema(
  {
    id: { type: String, required: true }, roundIndex: Number, side: { type: String, enum: ['both', 'left', 'right'] },
    type: { type: String, enum: ['warmup', 'working'] }, status: { type: String, enum: ['pending', 'done', 'skipped'] },
    target: Mixed, actualReps: { type: Number, default: null }, actualDurationSeconds: { type: Number, default: null },
    actualLoad: { type: LoadSchema, default: null }, actualRir: { type: Number, default: null }, failedAttempt: { type: Boolean, default: false },
    completedAt: { type: Date, default: null }, recordedAt: { type: Date, default: null }, notes: { type: String, default: null }, skipReason: { type: String, default: null },
  },
  { ...sub, minimize: false },
);
const OccurrenceSchema = new Schema(
  {
    id: { type: String, required: true }, planItemId: { type: String, default: null }, exerciseId: { type: String, required: true }, exerciseVersion: Number,
    exerciseSnapshot: Mixed, originalExerciseSnapshot: { type: Mixed, default: null }, originalPrescription: Mixed, appliedPrescription: Mixed,
    variantKey: String, setup: Mixed, loadBasis: String, implementCount: Number, optional: Boolean, sets: [SetSchema],
    notes: { type: String, default: null }, skipped: { type: Boolean, default: false }, skipReason: { type: String, default: null },
  },
  { ...sub, minimize: false },
);
const TrainingSessionSchema = new Schema(
  {
    _id: String,
    schemaVersion: { type: Number, default: 1 },
    ownerId: { type: String, required: true },
    clientSessionId: { type: String, required: true },
    createPayloadHash: { type: String, required: true },
    revision: { type: Number, default: 1 },
    planRef: Mixed,
    planSnapshot: Mixed,
    programContext: { type: Mixed, default: null },
    status: { type: String, enum: ['in_progress', 'paused', 'completed', 'partial', 'abandoned'], required: true },
    isActive: { type: Boolean, required: true },
    source: { type: String, enum: ['live', 'manual_backfill', 'import'], required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    timezone: { type: String, required: true },
    startUtcOffsetMinutes: { type: Number, required: true },
    localDate: { type: String, required: true },
    pauses: { type: [new Schema({ startedAt: Date, endedAt: { type: Date, default: null } }, sub)], default: [] },
    elapsedSeconds: { type: Number, default: null },
    activeSeconds: { type: Number, default: null },
    warmupChecklist: { type: [new Schema({ stepId: String, completed: Boolean, completedAt: { type: Date, default: null } }, sub)], default: [] },
    restTimer: { type: Mixed, default: null },
    exercises: [OccurrenceSchema],
    sectionActivities: { type: Mixed, default: undefined }, // schema-2 sessions only: { warmup: SectionActivity[], cooldown: SectionActivity[] }
    metadata: { type: Mixed, default: () => ({ energy: null, soreness: null, sleepMinutes: null, sessionRpe: null, notes: null }) },
    appliedOperations: { type: [new Schema({ operationId: String, payloadHash: String, appliedRevision: Number }, sub)], default: [] },
    corrections: { type: [Mixed], default: [] },
    correctedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { ...ts, minimize: false },
);
TrainingSessionSchema.index({ ownerId: 1, startedAt: -1 });
TrainingSessionSchema.index({ ownerId: 1, 'exercises.exerciseId': 1, startedAt: -1 });
TrainingSessionSchema.index({ ownerId: 1, clientSessionId: 1 }, { unique: true });
TrainingSessionSchema.index({ ownerId: 1 }, { unique: true, partialFilterExpression: { isActive: true }, name: 'one_active_session_per_owner' });

const BodyMeasurementSchema = new Schema(
  {
    _id: String,
    schemaVersion: { type: Number, default: 1 },
    ownerId: { type: String, required: true },
    clientMeasurementId: { type: String, required: true },
    createPayloadHash: { type: String, required: true },
    profileImportKey: { type: String, default: null },
    revision: { type: Number, default: 1 },
    massGrams: { type: Number, required: true, min: 1000, max: 1_000_000 },
    enteredUnit: { type: String, default: 'kg' },
    measuredAt: { type: Date, default: null },
    datePrecision: { type: String, enum: ['instant', 'day'], required: true },
    localDate: { type: String, required: true },
    timezone: { type: String, required: true },
    utcOffsetMinutes: { type: Number, default: null },
    source: { type: String, enum: ['scale_measurement', 'self_report', 'import'], required: true },
    context: Mixed,
    corrections: { type: [Mixed], default: [] },
    deletedAt: { type: Date, default: null },
  },
  { ...ts, minimize: false },
);
BodyMeasurementSchema.index({ ownerId: 1, clientMeasurementId: 1 }, { unique: true });
BodyMeasurementSchema.index({ ownerId: 1, localDate: -1 });

export const User = mongoose.model('User', UserSchema, 'users');
export const AuthSession = mongoose.model('AuthSession', AuthSessionSchema, 'authSessions');
export const TrainingPack = mongoose.model('TrainingPack', TrainingPackSchema, 'trainingPacks');
export const CatalogState = mongoose.model('CatalogState', CatalogStateSchema, 'catalogState');
export const TrainingSession = mongoose.model('TrainingSession', TrainingSessionSchema, 'trainingSessions');
export const BodyMeasurement = mongoose.model('BodyMeasurement', BodyMeasurementSchema, 'bodyMeasurements');

export async function connectDb(uri = process.env.MONGO_URI) {
  if (!uri) throw new Error('MONGO_URI is required');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  await Promise.all([User, AuthSession, TrainingPack, CatalogState, TrainingSession, BodyMeasurement].map((m) => m.init()));
}

/** Lean doc -> JSON shape: `_id` becomes `id`. */
export function out<T extends { _id?: unknown }>(doc: T): Omit<T, '_id'> & { id: string } {
  const { _id, ...rest } = doc;
  return { id: String(_id), ...rest };
}
