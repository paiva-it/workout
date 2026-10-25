# API contract and validation

Prefix `/api/v1`. Same-origin browser client with credentials. JSON response errors use `{code,message,fieldErrors?,requestId}`. Use 400/422 for invalid input, 401 for no session, 403 for CSRF/origin, 404 for absent or another owner's data, 409 for revision/import/idempotency conflicts, 413 for oversized import and 429 for throttling. Never return stack traces or credentials.

| Method/path | Purpose |
|---|---|
| POST /auth/login | Username/password; validate Origin; rate-limit; rotate/create opaque session cookie. |
| GET /auth/me | Safe user data + CSRF token; Cache-Control no-store. |
| POST /auth/logout | CSRF-protected revoke and cookie clear. |
| POST /auth/password | Current/new password; Argon2id rehash; invalidate other sessions; audit only event metadata. |
| GET /plans | Active DB-backed plan summaries, filters. |
| GET /plans/:id?version=N&packId=... | Definition and resolved exercises/videos. Omitted version selects active definition. |
| GET /programs | Both program definitions, phases and schedules. |
| PATCH /me/program | Set program, start date and held/repeated phase with profile revision. |
| GET /exercises | DB catalog with movement/load metadata and video references. |
| GET /exercises/:id/previous | Last comparable actual sets; filters for variant/side/load basis/setup; default completed/partial sessions only. |
| POST /sessions | `{clientSessionId,planId,planVersion,packId,packVersion,programContext?,startedAt,timezone,source}`; snapshot on server. Repeated clientSessionId with same payload returns the original session. |
| GET /sessions/active | At most one active/paused session. |
| GET /sessions | Cursor pagination, stored local date from/to, plan/exercise/status filters. |
| GET /sessions/:id | Full snapshot, prescribed and actual sets, timing and revision. |
| PATCH /sessions/:id | Typed operation, expected revision and stable operationId; atomic update. |
| POST /sessions/:id/pause | Idempotent timestamped pause. |
| POST /sessions/:id/resume | Idempotent timestamped resume. |
| POST /sessions/:id/finish | Review missing work, explicit completed/partial/abandoned, finish timestamp, revision and operationId. |
| POST /sessions/:id/corrections | Reason + allowlisted correction operations; preserve previous values atomically. |
| POST /body-measurements | Client UUID, grams, date/time/timezone, source and optional context. |
| GET /body-measurements | Cursor/date filtered list; do not collapse multiple entries into one per day. |
| PATCH /body-measurements/:id | Revision + correction reason; retain previous values. |
| DELETE /body-measurements/:id | CSRF/revision protected soft delete, reason. |
| POST /plan-imports/preview | Parse/validate proposed pack and return new/unchanged/conflicting counts and content hash. No DB mutation. |
| POST /plan-imports | Validated pack + expected catalog revision + preview hash; immutable insertion and atomic activation. |
| GET /exports/personal.json | Lossless private export, no auth or infrastructure secrets. |
| GET /health/live | Minimal liveness, public; no config details. |
| GET /health/ready | Private/internal readiness including DB; expose only sanitized status if public. |

Use one flexible PATCH endpoint with a discriminated operation union, not arbitrary Mongo operators. Operations include setActual, setStatus, addSet, removePendingSet, skipExercise, substituteExercise, updateSessionNotes, updateWarmup, updateRestTimer. Reject arbitrary paths, `$` keys, dotted keys, unknown fields and cross-owner IDs. The app never accepts ownerId as authoritative client input.

## Numeric and text limits

- Dates must parse, timezones must be real IANA names, finish >= start, and pauses must not overlap or run backward. Confirm unusual future dates; do not invent timestamps.
- Reps are integers 0-1000; durations are integers 0-86400 seconds. `done` strength work requires positive reps; a zero-rep failed attempt must be explicitly marked `failedAttempt:true`. Skipped/pending sets need not have actuals. Hold/walk completion requires a positive duration. Actual values are never populated from target ranges implicitly.
- External load is an integer number of grams, 0-1,000,000; values that are implausible for the selected exercise get a confirmation, not an automatic correction. Paired dumbbell count is 2, one-arm and goblet count is 1. Bodyweight added/assisted values are nonnegative and explicit.
- Body mass is an integer 1,000-1,000,000 grams; ask confirmation for unusually large/small changes. Missing is null, not 0. Optional RIR 0-10 and perceived exertion 0-10. No numeric NaN/Infinity/string injection.
- Notes <=4,000 characters per session, <=1,000 per exercise/set. Titles <=160 characters. Pack <=2 MiB, 100 plans, 500 exercises, 500 videos; bounded sets per item 1-10, items per plan <=30.
- Input strings are trimmed where appropriate, but never trim or normalize the password. Render imported text safely; no HTML content from packs.

## Race and replay behavior

Apply updates with `_id + ownerId + revision` predicate, increment revision and record the operation ID in the same atomic document update. Check known operation IDs before rejecting a retry's stale revision; identical replay returns the original acknowledgement/current canonical state without applying twice. A reused operation ID with a different payload is 409. Serialize the client outbox so each acknowledged revision becomes the base for the next request. Bound retained operation IDs per session; do not expire them while an active workout may still replay. Stable set IDs additionally prevent duplicate set insertion.

For concurrent tabs, the losing request gets the new server state and a conflict reason. It cannot overwrite without an explicit rebase/review. Unique partial active-session index resolves simultaneous starts. Creating another session while one is active returns the active session ID; do not silently abandon it.

## Rest timer

Persist `restStartedAt`, `restDurationSeconds` and `restEndsAt` in the session. Derive display from current time; no background interval accuracy assumptions. Pause/resume workout does not silently rewrite completed-set timestamps. Timer audio/haptics are opt-in. For paired left/right records, automatically start the main rest timer only after both sides are marked done; an optional between-side short break is separate.
