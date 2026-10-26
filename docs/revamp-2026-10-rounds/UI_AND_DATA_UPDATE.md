# Workout blocks, rounds and three-section logging

## Pack schema 3

Keep pinned schemas 1 and 2 unchanged and add schema 3. Validate using the `schemaVersion` discriminator. Preserve old snapshots; view-model normalization must not write fabricated data back to MongoDB.

`plan.items` stays the canonical prescription list. New `plan.workoutBlocks` contains:

```ts
interface WorkoutBlock {
  id: string;
  name: string;
  rounds: number; // positive integer
  itemIds: string[]; // ordered references to plan.items[].id
  restBetweenExercisesSeconds: number;
  restBetweenRoundsSeconds: number;
  restAfterBlockSeconds: number;
  notes: string;
}
```

Semantic validation beyond JSON Schema:

- Every work item belongs to exactly one block. Reject missing, duplicate or dangling memberships and duplicate block IDs.
- `item.workingSets` equals its block's `rounds`. A round creates ONE set for each member, or a left/right pair for separate-side exercises. Never allocate rounds times workingSets.
- Flattening block member lists yields exactly the ordered `plan.items` IDs. Blocks reference item occurrences, not bare exercise IDs.
- Block IDs cannot collide with warm-up/work/cooldown occurrence IDs. Keep all existing reference, side, metric, variant, text-safety and immutable-version validation.
- Warm-up/cooldown steps retain schema-2 typed exercise references. They are not assigned to work blocks and are not repeated on every round.
- Only canonical validated YouTube URLs may contain the required equals sign; imported prose renders as plain text.

This update changes only three previous work-set counts to make consistent rounds: Plan A push-ups 2 to 3 and curls 3 to 2; Plan D crunches 3 to 2. All other work-set counts and all rep/time targets remain unchanged. Total prescribed exercise sets: A 16, B 12, C 13, D 12. Separate-side sets retain two actual rows per prescribed set. There are 10 blocks across 4 plans.

## Rest behavior: one timer per boundary

For schema-3 sessions use block rest fields. Existing item `restSeconds/restAfter` remain legacy fallback metadata; do not add them to block rests.

| Event | Scheduled rest |
|---|---|
| Non-final member is resolved in the current round | Between-exercises rest |
| Last member resolved, another round remains | Between-rounds rest |
| Last member of final round resolved, another block remains | After-block rest ONLY |
| Last member of final workout block resolved | No workout rest; Continue to cooldown |

For a per-side movement, both side rows must be resolved before moving to the next exercise/rest boundary. Allow an optional manual pause between sides. 'Resolved' means done or explicitly skipped; the UI must still distinguish a partial/skipped round from all-performed. Skipping or manually navigating should not auto-start a countdown without an explicit continue action. Completing the final pending member can offer/start the applicable timer using existing settings. Editing already-saved actuals must not restart it. Persist the rest boundary identity so replay cannot start duplicate timers.

The listed pauses are normal guidance, not a race. Let the user extend or stop a timer. Do not force transitions at expiry or save actuals from elapsed time. At the last round, after-block rest replaces between-round rest, not the sum of both. Rest timers and exercise-duration countdowns are separate states.

## New session shape

Use session schema version 3 for new grouped sessions. Preserve the current flat working `exercises[]` array and its authoritative set records. Add an immutable `workoutBlocksSnapshot` containing block identity, ordered member-to-occurrence mapping, rounds and rest prescription. Each working set gains a block snapshot ID and one-based round index. Map that round index to the existing set ordinal consistently; do not reuse array positions as IDs.

```ts
interface SessionBlockSnapshot {
  id: string; // stable session UUID
  planBlockId: string;
  prescriptionSnapshot: WorkoutBlock;
  members: { planItemId: string; exerciseOccurrenceId: string }[];
}
// Existing working actual-set row, extended:
// blockSnapshotId: string; roundIndex: number;
// existing UUID, side, status, reps/duration, load, timestamps and notes remain.
```

Store these snapshots in the same session document. Block/round completion is derived from referenced working-set states; it is not a second mutable completion authority. A round that has skipped members is resolved but partial. Preserve stable IDs through edits, reloads, offline replay and resume. Store actual performed order/timestamps as observed, never infer execution time from navigation or array order. No bulk round action can fabricate actual reps, durations or loads.

On startup copy all exercise/video/prescription definitions and block mappings. Record pack schema and session schema independently. New packs cannot alter active or completed sessions. For substitutions, retain the work occurrence/block assignment and record the chosen exercise/variant/load identity using the existing supported substitution rules; do not copy incompatible loads silently.

## Preparation and cooldown from schema 2

Keep `sectionActivities: { warmup: SectionActivity[], cooldown: SectionActivity[] }` inside the same session document. Each activity has a stable UUID, planStepId, section, exercise/version and full exercise/video/prescription snapshots, variant, optional linked working occurrence and notes. Each side/set record has a UUID, roundIndex, side, status, completionMode, nullable actual reps/duration/load, completedAt, recordedAt and skipReason.

Quick Done stores `done + acknowledged` with actuals null. Explicit actual entry stores `measured` and validates the supplied values. A target or countdown never becomes an actual automatically. Side-specific stretches have independent side records. Quick Done for both sides must be explicit and must not invent durations. Working-set validation remains strict.

Rehearsals and cooldowns are excluded from working volume and previous working results, even when they reference the same movement. Legacy warm-up sets inside an exercise stay excluded too. Do not duplicate those into prescribed sectionActivities. All mutations reuse ownership checks, atomic revisions, payload hashes and the operation ledger. Reject arbitrary JSON paths, changed duplicate-operation payloads and stale-tab overwrites.

## UI and language

Keep the current theme and sticky Warm-up / Workout / Cooldown navigation, with separate done/skipped counts. A visible warm-up or cooldown heading contains real exercise cards, dosage, notes, videos and completion controls.

In Workout, show a block header, 'Round 1 of 3', ordered exercise cards and previous/next round controls. Include a compact summary for every round so saved results remain reviewable. The target says '10-15 reps per side this round'; the block says 'Repeat 3 rounds.' Avoid a confusing '3 x 10-15' on every round card. Keep editable actuals for each exercise, round and side, plus load labels ('kg each' or 'one dumbbell'), notes and previous comparable performance. Resolve the next pending row after resume; do not reconstruct it from a resettable cursor alone.

Show 'Finish while you could still do 2-3 more good reps' as the effort cue. Keep `targetRir` and program effort metadata internally for compatibility; the default flow does not require an RIR input. An optional explanation can say RIR means reps in reserve. Holds use a form-based cue. No phase wizard or automatic load/volume increases.

All rounds and sections are freely navigable. Finishing work leads to Continue to cooldown and keeps the session clock open. Final Finish ends it after cooldown or explicit skip/early finish. All required work done plus skipped cooldown is a completed strength session with separate cooldown status. Missing/skipped work yields the existing partial result. Done counts never treat skipped as performed; use text/icons as well as color.

Maintain 360px usability, visible save status, numeric keyboard inputs, focus order and large tap targets. Videos are collapsed until requested and retain ordinary YouTube fallback links when embedding fails.

## Historical compatibility, selection and deployment

Schema-1 sessions keep their old checklist/text cooldown; schema-2 sessions keep their structured sections and straight-set workout; schema-3 sessions show blocks. Never retrofit block IDs/rounds into historical or currently active v1/v2 sessions. They must remain resumable. Exports and any restore path retain all shapes, snapshot versions, actuals and timestamps without stripping new fields.

Previous results compare compatible working movements/variants/sides/loads, regardless of their block position. Alternating heel touches/taps count once in total; a pair of dumbbells is logged per dumbbell; French extensions/goblet squats/bridges use one dumbbell. Separate-side rows do not multiply shared implements incorrectly.

If upgrading from v1, deactivate omitted old plans through same-pack v3 activation and narrowly remap obsolete five-focus-days preferences as specified. If already on the fixed v2 program, preserve that selection and its start date; the program definition is unchanged. Existing session program context and unrelated packs/users are untouched. App restart must not reactivate obsolete seed packs.

Back up and capture live pointers/preferences, reconcile actual versions, deploy readers first, then preview and activate the final immutable pack. Do not import reference packs. Reimporting identical v3 is a no-op; changed same-version content is a conflict. Rollback restores captured catalog pointers/preferences while retaining all new sessions and schema-3 readers.
