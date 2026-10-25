# Three-section plan and workout update

## Scope and format decision

The supplied schema 1 has warm-up text steps and cooldown instruction strings. It cannot reference a cooldown exercise/version, give it a side-specific time target or save actual performance against a stable movement identity. Rendering those strings as if they were typed exercise records would be brittle. Schema 2 solves this explicitly; it does not replace or rewrite schema 1.

| Existing concept | Schema 2 behavior |
|---|---|
| `plan.items` | Unchanged shape; exclusively working exercises. |
| `warmup.durationMinutes` and `videoId` | Retained. The general video is secondary to individual step videos. |
| `warmup.steps` | Typed `sectionStep` records referencing exercises and versions. |
| `cooldown.durationMinutes` and `instructions` | Retained for section summary and general guidance. |
| `cooldown.steps` | Required structured exercise records, not parsed from prose. |
| `exercise.repsMeaning` | Adds `alternating_total` for the new heel-touch, shoulder-tap and trunk-turn IDs only. |
| Programs | Existing format; one phase `[1, null]`, cap null, no automatic changes. |

Schema 1 and schema 2 are separate pinned JSON Schemas. Validate by `schemaVersion` and reject unsupported values. Preserve old snapshots as stored. The app may normalize them into a common **view model** for rendering without modifying the source documents.

## `sectionStep` contract

Every structured warm-up/cooldown step contains:

| Field | Meaning |
|---|---|
| id | Stable occurrence key, unique across all three sections of its plan. |
| exerciseId / exerciseVersion | A definition in the same pack; exact version match required. |
| sets | Number of preparation/cooldown sets, 1-5. Never a working-set count. |
| target | Existing `{metric,min,max,perSide}` shape. Duration is seconds. |
| restSeconds / restAfter | Existing meaning; a paired round rests after both sides. |
| defaultVariant | Setup/position for comparison and display. |
| role | `pulse_raise`, `mobility`, `rehearsal`, `easy_movement` or `stretch`. |
| linkedWorkoutItemId | Null or an item ID in the same plan, for a rehearsal of that exact working exercise. |
| notes | Plain-text instructions; no encoded HTML. |

Warm-up roles are pulse_raise/mobility/rehearsal. Cooldown roles are easy_movement/stretch. Rehearsals are intentionally easy and are never affected by program working-set caps or working-set RIR. A linked rehearsal must match the linked item's exercise ID and version. The total working volume and 'last time' feature must exclude all section activities.

For new bilateral repetition exercises, `alternating_total` means every alternating side action counts once. Twenty heel touches means twenty total, usually ten on each side, stored as one bilateral actual of 20; do not multiply by two or create duplicate left/right records. It is distinct from the existing `separate_sides` exercises, which have separate actual records. New schema validators should allow only `simultaneous_repetitions` or `alternating_total` for bilateral reps, `per_side` for separate-side reps, and `seconds` for durations. Do not change the immutable meaning of an existing exercise ID.

Allow `=` only inside the exact validated canonical YouTube URL. Continue forbidding `<`, `javascript:` and attribute-like input in ordinary text; a blanket equals-sign rejection would incorrectly reject every required watch URL. Imported strings render as text, not HTML. Keep size limits and all remaining v1 semantic checks.

## New session persistence

Keep the current working `exercises[]` array and its set structure to preserve queries and previous-result behavior. New sessions use session schema version 2 and add:

```ts
interface SectionActivity {
  id: string;                    // UUID, never array index
  planStepId: string;
  section: 'warmup' | 'cooldown';
  exerciseId: string;
  exerciseVersion: number;
  exerciseSnapshot: ExerciseDefinition;
  videoSnapshot: VideoDefinition;
  prescriptionSnapshot: SectionStep;
  variantKey: string;
  linkedWorkoutOccurrenceId: string | null;
  sets: SectionSet[];
  notes: string | null;
}
interface SectionSet {
  id: string;
  roundIndex: number;
  side: 'both' | 'left' | 'right';
  status: 'pending' | 'done' | 'skipped';
  completionMode: 'acknowledged' | 'measured' | null;
  actualReps: number | null;
  actualDurationSeconds: number | null;
  actualLoad: ExistingLoad | null;
  completedAt: string | null;
  recordedAt: string | null;
  skipReason: string | null;
}
interface SectionActivities {
  warmup: SectionActivity[];
  cooldown: SectionActivity[];
}
```

Store `sectionActivities` inside the same session document so each section mutation stays atomic with its revision and operation ledger. Copy all definitions/prescriptions from the selected pack at start; do not resolve historical cards from the current catalog later. Record the pack schema version with the session's plan reference/snapshot metadata as well as the session record schema version. These are separate concepts, even though both are 2 for new records in this release.

An explicit quick 'Done' acknowledgement stores `done + acknowledged` with actual numeric values remaining null. If the user records actual reps/time/load, store `measured` and validate the supplied values. Never copy targets into actuals or infer that a user performed an elapsed countdown. Each side can be completed/skipped separately; an explicit 'Mark both sides done' action may acknowledge both without inventing numeric actuals. Existing working-set validation remains strict.

The existing warm-up checklist is used only for old snapshots. Do not store two authoritative copies for a new session. Existing warm-up **sets within a working exercise** retain their old meaning/type and remain excluded from working-set comparisons; do not move or duplicate them as part of this update. New prescribed rehearsal steps belong only to sectionActivities. If the user adds an extra old-style warm-up set, display it as such within the working exercise and still exclude it from volume/previous working results.

Reuse the existing ID, revision, payload-hash and operation-replay controls for section updates. Typed operation examples: setSectionActual, acknowledgeSectionSet, skipSectionSet, updateSectionNotes. Validate owner/session/section/activity/set identity server-side; do not allow arbitrary JSON paths. One duplicate replay must not append another set or mark the opposite side complete. A conflicting tab must see a conflict, not silently overwrite.

## Plan detail and active workout UI

Use the existing theme, components and typography. Do not introduce a separate design system.

| Area | Required behavior |
|---|---|
| Plan card | Name, focus, approximate total duration and section counts; four active cards from this pack. |
| Plan detail | Warm-up / Workout / Cooldown as visible headings or tabs. Show every exercise with its own demo, target, side/count convention and instructions. |
| Sticky navigator | Three labels with done/total activity counts. Clicking changes section without requiring the prior section to be complete. |
| Warm-up card | Exercise name, dosage, instructions, video and quick Done/Skip. Expand actual logging when wanted. Rehearsals say 'Light rehearsal - not a work set.' |
| Workout card | Preserve existing actual-set inputs and previous results. Show 'kg each' for paired dumbbells, 'one dumbbell' for goblet/French extension/bridge. |
| Cooldown card | Individual holds/easy movement with seconds and side controls. Countdown is optional and completion is explicit. |
| Section footer | Move to next section without resetting the session, workout clock or acknowledged data. |
| Workout footer | After working sets: Continue to cooldown. Finishing early is still possible through explicit review. |

Work-set completion and section completion are separate. If all required working sets are done and cooldown is skipped, retain the existing `completed` strength status and show 'Cooldown skipped' separately. Unfinished working sets produce `partial` as before. Skipped/unknown preparation does not claim a warm-up was performed. Do not let optional preparation logging block a workout save.

One resolved activity means all its planned side/set records are done or skipped. The done count includes only activities whose records are all done; mixed done/skipped activities must remain distinguishable. Never represent skipped as a green done tick. Use meaningful accessible labels rather than color alone. Old session cooldowns have 'Not recorded in this workout format' instead of fabricated pending/done records.

The overall session clock stays open through cooldown until final Finish. Retain UTC instants, original timezone/local date, pause intervals and saved timer expiry. It is useful to store section start/end timestamps as optional observed events, but never infer a continuous block from the order in which a user views tabs. A user can revisit any section and correct entries. Rest timer and exercise-duration countdown must be separate states; backgrounding does not reset either. Timer expiry alone does not save a completed set.

Keep 360px mobile usable: sticky section selector, large completion buttons, numeric inputs, no horizontal overflow. Videos should be collapsed until requested. Preserve direct YouTube links for blocked iframes. Use existing privacy-enhanced embed handling and auth protections.

## History, selection and exports

Schema-1 histories render their stored warm-up checklist, workout sets and cooldown prose. They can be resumed if active. Do not add new plan steps to them. Schema-2 histories render all three stored sections, including acknowledgement versus measured actuals, skips and corrections. The default previous-performance lookup returns done **working** sets only, not a rehearsal with the same exercise ID. Unit/variant/side matching remains intact.

The same-pack v2 activation removes five old plan IDs from the active catalog: restart-a, restart-b, back, shoulders-core and recovery. arms/chest/legs become version 2; core version 1 is added. Do not delete the old pack or any referenced definitions. Fifty catalog exercises are retained or available as alternatives; this is not fifty selectable plans.

Keep the existing `return-to-training` selection ID and use its new program definition for new sessions. Remap `five-focus-days` to it only for users whose selection belongs to this replaced collection. Clear obsolete held-phase values and set-cap overrides in current preferences, with migration audit/rollback information. Existing session program snapshots remain untouched. Hide phase controls for this one unchanging phase; no artificial week-based prompts.

Export format must include session schema/version information and sectionActivities while retaining existing fields. Import/restore code, if present, must handle both session formats. Do not strip unknown new section data on save or restore. Exports remain private; do not include real exports in the public repo.

## Deployment and rollback

Use `catalog-migration.json` as the runbook input, not an automatically executable destructive command. Back up first. Deploy a version supporting both pack/session formats; then preview/import/activate and remap only current obsolete preferences. Importing an identical already-stored v2 pack is a no-op. Same version with changed content is a conflict.

If current live definitions differ from the attached baseline, reconcile first and bump changed versions above actual stored versions; compare the exact diff before activation. Never downgrade live content or replace unrelated active packs. All final content changes must occur before the first successful import, or use a subsequent immutable version.

Rollback restores the previously captured **active catalog pointer** and preferences through a controlled maintenance command. Do not reimport a prohibited lower pack version, delete new workouts or restore an old database dump over newly logged data. Once schema-2 sessions exist, keep reader compatibility deployed even when restoring the old catalog. Do not roll back to code incapable of reading them.
