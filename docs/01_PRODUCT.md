# Product specification

## Outcome and scope

A single-user personal training log that works quickly on a phone in a garage. The source repository is public; the app's user data and API are private. English US UI, kilograms, Europe/Lisbon default timezone. Retain an owner ID on every private record even with one initial user. No signup, sharing or invitation features.

The MVP includes plan browsing, phase-aware workouts, individual-set logging, session history, bodyweight records, account settings, JSON plan imports and raw-data export. It excludes charts, rankings, estimated calories, nutrition and AI actions. Textual previous-set references are part of the MVP, not an analytics dashboard.

## Screens

| Screen | Required behavior |
|---|---|
| Login | Username/password, show/hide password, generic errors, password manager support, no public personal details. |
| Today | Resume active workout first; next program session; select another plan; latest saved sessions; quick bodyweight entry. |
| Plans | List all DB plans, type/focus/duration filters, detail with warm-up, targets, equipment, cues, video and start. Show program/phase overrides before starting. |
| Workout | Warm-up checklist, exercise cards, actual set rows, previous comparable result, timer, notes, saved state, pause/resume, partial finish. |
| History | Calendar or date-grouped list, filters for plan/exercise/status, detail with actual set rows, date/duration and notes. Correction with an audit reason. No charts. |
| Body Weight | Add/edit/soft-delete measured weight with date/time; show chronological list. Distinguish a date-only self-report from a measured weigh-in. |
| Settings | Program selection/start date/phase, kg units, timezone, confirmed equipment, password change/logout, JSON import and raw export. |

Use only a few visible fields while lifting. Reps, load and completion are primary. RIR, notes and optional session metadata can be expanded. Do not ask for a health questionnaire every session or show implementation details in the workout flow. Explain RIR as 'how many more good reps you could have done.'

## Workout behavior

1. Starting copies the chosen immutable plan and exercise definitions into a session, applies the selected program phase, and creates **pending** set rows. It must not create completed reps or assume a load.
2. Offer last comparable load as a one-tap suggestion. Matching uses exercise ID, definition version/compatible movement identity, variant, side, equipment/load basis and relevant setup such as incline height. Display the previous date. Do not use the exercise name alone to match results.
3. User enters actual reps and load, then marks a set done. Save each change with stable client IDs, revision checking and visible confirmation. Optional RIR is 0-10; blank means unknown, not zero. Marking done starts the prescribed rest timer, unless disabled.
4. Separate warm-up sets from working sets. Warm-up checklists are not counted as working sets. For left/right exercises, show paired inputs; one prescribed set means one left and one right record, linked by a round index. Missing right-side work stays missing, never copied automatically.
5. Allow add/remove pending set, skip with optional reason, exercise substitution from the catalog, and notes. A substitution stores the original prescription and the actual selected exercise snapshot. Never relabel a row as a different movement without preserving identity.
6. Optional plan items start omitted. 'Add optional exercise' explicitly adds them if the current phase allows it. Phase overrides win over nominal plan sets and RIR. Target values remain separate from actual values.
7. Keep only one active session per user, including paused sessions; starting another offers resume, finish partial, or abandon. Completed and abandoned sessions remain in history and never get reused as a new day's workout.
8. Finish shows completed and missing work. User can finish partial and retain pending/skipped distinctions. Set `completed` if all required planned work was resolved as done; otherwise `partial`. An abandoned session is not a completed training day.

Phase application is deterministic: effective working sets = min(listed sets, phase cap), or listed sets when cap is null. For an item with a non-null RIR target, effective RIR bounds are the elementwise maximum of item and phase bounds, so deliberately easier items stay easier. Items with null RIR (holds/mobility) retain null. `allowOptional` means the phase permits user opt-in; it never adds optional work automatically. First two split weeks disallow it; later weeks allow it. Continuing the full-body program beyond week 4 is supported by its indefinite final phase. Within an alternating phase, choose schedule `(programWeek - phaseStartWeek) modulo scheduleCount`.

## Dates, timing and recovery

The selected program start date is chosen by the user on first use, not the date this pack was prepared. Phase weeks are counted from that date in the user's timezone, but user may hold/repeat a phase. No automatic jump to five lifting days. A missed day never creates fabricated completion or forces catch-up volume.

The live timer uses timestamps, not a counter that becomes wrong when the browser sleeps. Store pause intervals and rest timer expiry. Record elapsed and active duration separately. If forgotten overnight, prompt for a corrected finish time; never silently count the entire night as active exercise. Session date remains the start local date even when finishing after midnight. Backdated entries are supported and labeled manual.

## Reliability

Use the server as authority. Keep an IndexedDB draft/outbox for temporary disconnection, with stable operation IDs and serialized replay. No full offline app/PWA build is required. Display 'Saved', 'Saving', 'Offline - pending sync', or 'Conflict - review'; never display 'Saved' before acknowledgement. Save events survive refresh. Pause/restart must not duplicate sets or workouts. A conflict must show local and server versions instead of silently overwriting another tab. Clear private local caches on logout, after warning about unsynced edits.

## Weight entry and metadata

Support decimal point and decimal comma and normalize to integer grams on the API. A measured entry needs its actual local date/time and timezone; imported self-reports may be date-only. Optional context: morning/evening/unknown, before food, scale label and note. Multiple weigh-ins in a day are allowed. Do not impose a target bodyweight, infer height/BMI, or overwrite previous values when a new one is entered.

Optional session fields: energy 1-5, soreness 0-10, sleep minutes, perceived overall exertion 0-10 and notes. All may remain null. Avoid collecting unrelated personal information.

## Videos

Every plan has a primary demonstration and every catalog exercise references a video. For walking/mobility, the label explicitly identifies the general warm-up reference. Show title/channel and the usage note. Load the YouTube player only after a click, use `youtube-nocookie.com`, no autoplay, and keep an ordinary 'Open on YouTube' link. Do not download, rehost or claim authors endorsed the plans. If playback/embedding fails, keep the instructions and link available and allow replacing the video via a new pack version. Do not silently substitute an unrelated exercise.

## Design acceptance

360px mobile through desktop; 44px or larger primary tap targets; labels always visible; numeric keyboard; no horizontal scrolling; accessible focus and validation; contrast compliant with WCAG AA. Use a single restrained accent, not a gamified or punitive streak system. A completed set should be identifiable without color alone. On a phone, reps and weight remain directly editable without opening a large modal for every set.
