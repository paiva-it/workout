# Acceptance checks for the existing app update

## Pack and migration

- [ ] The supplied dependency-free validator passes against the supplied baseline; the app's full JSON Schema 2020-12 validator also accepts the schema-2 pack.
- [ ] Schema 1 continues accepting the exact old pack. Schema 1 rejects the new pack instead of stripping new fields. Schema 2 rejects unknown fields and malformed structured steps.
- [ ] Exactly four active plan IDs from this collection: arms, chest, legs, core. The retained alternative exercise catalog must not create extra plan cards.
- [ ] arms/chest/legs are version 2, core version 1; program return-to-training is version 2. All 21 reused exercise definitions remain identical at version 1. Old stored pack and session snapshots are unchanged.
- [ ] Every new section exercise/version/video resolves. Every linked rehearsal points to the same movement/version in the same plan. Duplicate occurrence IDs across sections are rejected.
- [ ] The one program phase is open-ended, with no working-set cap or optional work. Week changes do not alter the routine. Obsolete phase/set-cap preferences cannot leak into a new session.
- [ ] A user on five-focus-days gets the specified idempotent selection remap after activation. A user on an unrelated pack's program is untouched. An already-active session keeps its original context.
- [ ] Identical pack reimport is a no-op. Changed content at a stored version is rejected. Preview changes no state. Live version conflicts are reconciled without overwriting stored definitions.
- [ ] App restart/redeploy does not import an obsolete seed, reactivate v1 or reset program/preferences/history.

## UI

- [ ] Plan detail and active workout clearly expose Warm-up, Workout and Cooldown, each with individual exercise cards and dosage.
- [ ] Each activity has its own instructional video/link. A rehearsal of an existing exercise uses the same movement demo but clear easy-effort instructions.
- [ ] Existing colors/components are reused; no unrelated login, dashboard or account redesign.
- [ ] Mobile width 360px and desktop checks: no horizontal overflow, readable numeric inputs, keyboard focus, large tap targets, clear done/skipped states and visible save status.
- [ ] All sections can be navigated freely. A pending warm-up does not trap the user or fabricate completion.
- [ ] The main work footer advances to cooldown without ending the session. Final Finish or explicit early finish preserves all actuals and records the final timestamp.
- [ ] Completing all work sets and skipping cooldown retains strength status completed with separate cooldown-skipped detail. Missing work sets produce partial.
- [ ] Single-phase program hides progression/phase controls and automatic weekly suggestions; loads remain manual.

## Logging and calculations

- [ ] A quick warm-up Done stores acknowledged completion and null actuals. A target of 10 never silently becomes 10 performed reps. Numeric logging remains optional for section activities.
- [ ] When actual duration/reps are entered, measured completion validates and persists them. Starting or finishing a countdown alone never marks an activity done.
- [ ] Warm-up and cooldown logging survive refresh, app backgrounding, API restart and offline outbox replay, using stable IDs and current revision rules.
- [ ] Replaying the same section operation twice does not create duplicate sets or complete the other side. Reusing the operation ID with changed content returns a conflict.
- [ ] One-arm row with left 12/right 10 stays distinct. Main rest starts after the pair is resolved; unilateral cooldown holds have independent side states.
- [ ] Twenty total shoulder taps is stored as 20 once, not 20 per side or 40. Same rule for heel touches and trunk turns. Existing unilateral dead-bug and row semantics remain unchanged.
- [ ] Paired 6 kg dumbbells for 12 simultaneous curls use load value 6000 grams and implement count 2. A French extension with one 6 kg dumbbell uses count 1. A two-dumbbell split squat uses count 2 on each side's record; never infer just one dumbbell from laterality.
- [ ] A rehearsal row cannot become the previous working-row result or contribute to working volume. Existing legacy warm-up sets also stay excluded.
- [ ] Substituting French extension with the lying two-dumbbell extension changes the load convention clearly and does not blindly copy its load. Switching to bodyweight has no body-mass load field.
- [ ] Overall workout time includes cooldown until final Finish; existing pause, UTC/timezone/local-date and DST behavior remains correct.

## Historical compatibility

- [ ] Capture one schema-1 completed session and one in-progress legacy session before the update. Afterward, deep-compare all stored snapshots and actuals; they remain unchanged.
- [ ] Resume the legacy active session successfully with its existing warm-up checklist and text cooldown. Do not add newly prescribed cooldown records to it.
- [ ] New schema-2 sessions retain their own activity and video snapshots after another pack update. New history shows acknowledged/actual/skipped preparation accurately.
- [ ] Old cooldowns show not-recorded/legacy text rather than invented actuals. Read-only normalization does not write back fabricated records.
- [ ] Export contains all new section data and version markers, while preserving old sessions. Any restore/import path accepts both formats and never strips new fields.
- [ ] Current bodyweight measurements, authentication data and account credentials are unchanged.

## Videos and deployment

- [ ] Validate all videos used by the four plans in a browser, including warm-up/cooldown activities. Record playback and embedding separately. An oEmbed response or metadata match alone is not a playback test.
- [ ] Previously private calf ID PQ-F5uzxipQ is absent from the new pack. Previously non-embeddable NHS ID oLu9kwDzBdg is not used in new plans. Reference copies may still contain both as historical evidence.
- [ ] Blocked player retains instructions and the ordinary YouTube link; no broken iframe prevents logging.
- [ ] Run typecheck, lint, meaningful schema/version/state tests, Mongo-backed persistence tests and browser flow checks. Report actual commands/results.
- [ ] Back up before activation, deploy dual-format code first, activate only a conflict-free pack, then perform the narrow preference migration.
- [ ] Verify live HTTPS site, four cards, section navigation/logging, history preservation and stable catalog after app restart.
- [ ] Do not restore old DB backups over new workouts to roll back. Retain schema-2 reader support if schema-2 sessions have been created.

These are implementation acceptance criteria for Claude. The ZIP itself is a checked data/specification handoff; it does not prove that application changes have been implemented or deployed.
