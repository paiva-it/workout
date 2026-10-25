# Persistence and historical integrity

Use Mongoose with explicit schemas, validation and indexes. The attached TypeScript contracts define the canonical session fields; implement DTO validation as well. Dates are BSON Dates internally and ISO UTC strings over JSON. All schema-bearing documents include `schemaVersion`, created/updated timestamps and a revision where mutable.

## Collections

| Collection | Required data / indexes |
|---|---|
| users | Unique normalized username, Argon2id hash, display name, timezone, units, equipment, program selection/start/held phase, private profile. Hash excluded from normal queries and serialization. |
| authSessions | Unique hash of a cryptographically random session token, userId, createdAt, expiresAt, revokedAt. TTL expiresAt; also explicitly check expiry at every request. |
| trainingPacks | Immutable, self-contained imported pack; unique `(packId, version)`, canonical SHA-256 content hash, importedAt/importedBy. Reject files above 2 MiB. |
| catalogState | One small active-version manifest with revision and active pack references. Updates are atomic compare-and-swap. |
| trainingSessions | One document per workout with copied plan/exercises, phases, actual sets, notes, timestamps, pause intervals, timer state, source, status, local date and audit deltas for completed-session corrections. Index `(ownerId, startedAt)` and `(ownerId, exercises.exerciseId, startedAt)`. Unique `(ownerId, clientSessionId)`. Unique partial index on ownerId where `isActive:true`. |
| bodyMeasurements | ownerId, clientMeasurementId, massGrams, actual timestamp or date-only self-report, timezone/localDate/offset, source/context, note, revision, deletedAt and correction history. Unique `(ownerId, clientMeasurementId)`, index `(ownerId, localDate)`. |
| requestDedup / rateLimits | Only when needed for cross-request idempotency and abuse control; short TTL. An operation replay must have the same payload hash or return 409. Never TTL-delete workouts or weight history. |

No replica set is required for this MVP. Keep session mutations within one document and use a single-document active catalog pointer to avoid a dependency on Mongo multi-document transactions. Mongo TTL cleanup is asynchronous: expiry checks cannot rely on the cleaner running immediately.

## Versioned plan import

Validate the entire pack before changing anything: JSON schema, bounds, unique IDs, all references, YouTube IDs, repetitions/time units, load semantics, phase references and no script/HTML content. Do not fetch arbitrary imported URLs server-side. Accept only supported YouTube watch links/IDs; render all imported text as text.

Create an immutable `trainingPacks` document first. A repeat with identical canonical JSON (sorted keys, normalized JSON encoding) and the same packId/version is a no-op. A repeat with different content at the same version is 409, never an overwrite. After successful insertion, atomically update the active catalog manifest to the selected pack version using its revision. If activation loses a race, return a reviewable conflict; the unactivated pack is harmless and can be activated on retry.

Exercise and plan IDs are stable semantic keys. Every changed definition needs a higher definition version, and every changed pack needs a higher pack version. A new version may keep unchanged definitions at their old versions. Across active packs, duplicated `(exerciseId, version)` is permitted only if definitions are identical; conflicting definitions are rejected. Changed movement identity requires a new exercise ID. New sets/reps require a new plan version. Video metadata changes belong in a new pack version. Resolve all references inside the supplied self-contained pack; do not depend on an invisible external exercise catalog.

`GET /plans` and `/exercises` read the active manifest and DB packs. Do not seed on every API startup. A separate CLI or authenticated import applies seeds idempotently. Old pack versions remain available to existing records. Archiving a plan removes it from selection, not history; do not hard-delete referenced content.

## Each training session is independent

Copy the full selected plan and resolved exercise definitions, video metadata, equipment, unit convention, version IDs and applied phase overrides at session creation. Preserve the original plan prescription plus any session-only modifications. Renaming, archiving or replacing a plan must not modify existing sessions, including an active one.

Use stable UUIDs for session, exercise occurrence and set IDs. An exercise appearing twice in a workout has two occurrence IDs. Do not use array position as identity. Document revision controls writes; operation ID plus payload hash controls replay. Keep `isActive` synchronized with state in the same atomic write.

Recommended status transitions: `in_progress -> paused -> in_progress`, either active status to `completed` / `partial` / `abandoned`. Historical corrections do not reactivate the session. Completed-session corrections require a reason, preserve changed prior values in the same document, and update correctedAt/revision. If a session is hidden/deleted, soft-delete it and retain its data until explicit irreversible deletion is requested.

## Load rules for future analysis

Canonical weight = integer grams. UI v1 = kg; never use floating-point kg as the canonical storage unit. Store entered unit and original display string if useful for audit. `load.basis` is one of `per_dumbbell`, `single_dumbbell`, `barbell_total`, `external_total`, `bodyweight`, `none`. Store `implementCount` and `valueGrams`; bodyweight/unloaded has `valueGrams:null`, count 0, optional added/assisted grams. A change from bodyweight to loaded exercise is explicit, never inferred from a number alone.

For 2 x 10 kg dumbbells, enter **10 kg each**, count 2. A simultaneous set of 12 reps moves 20 kg of external load per repetition, giving 240 kg-reps under this limited volume convention. A single-arm row at 10 kg x 12 left and right gives two 120 kg-rep records. A 10 kg goblet squat x 12 gives 120 kg-reps. A barbell load includes the bar. No volume estimate is produced for push-ups, walking, holds, or unknown/assisted bodyweight.

Volume is only an optional derived value for later; it is not a universal measure of training quality and must not be compared indiscriminately across exercises/variants. Preserve actual reps, loads, sides, setup and set types so future calculations can be corrected. Do not store an invented push-up load based on body mass or fabricate an estimated 1RM. Defaults remain `null` until entered; zero and null mean different things.

## Time semantics

For each session/measurement store `startedAt` or `measuredAt` UTC, original IANA timezone, `localDate` (YYYY-MM-DD) and UTC offset minutes. For date-only self-report use `measuredAt:null`, `datePrecision:'day'` and the reported date; do not invent midnight. Never group historical records by the user's new current timezone. Prefer calendar-date filtering on stored localDate; time ranges are separate explicit UTC filters.

DST test: Europe/Lisbon `2026-10-25T00:30:00Z` and `2026-10-25T01:30:00Z` both display 01:30 local, with offsets +60 and 0 minutes respectively. They must remain distinct events. Date-only data cannot be silently upgraded to exact timestamps. Manual entry of an ambiguous local time must ask which offset/occurrence was intended.

## Exports

Authenticated JSON export includes a format version, exportedAt, definitions referenced by records, sessions, all actual set fields, body measurements, unit/time conventions and corrections. Exclude password hashes, auth sessions and infrastructure secrets. An optional flat CSV export uses one row per actual set and a separate measurement CSV; JSON is the lossless reference. Charts remain out of scope.
