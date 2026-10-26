# Acceptance checklist

## Pack and migration

- [ ] Full application JSON Schema validation accepts the v3 pack. Pinned v1/v2 schemas remain unchanged and accept their reference packs; both reject v3.
- [ ] Four active plan IDs: arms/chest/legs v3, core v2. All 50 exercises and all videos equal their v2 definitions. Program return-to-training remains exactly v2.
- [ ] Ten blocks. Every work item belongs exactly once; flattening members matches items; workingSets equals rounds. Reject missing/duplicate/dangling members, repeated block IDs, invalid rounds/rest, and version conflicts.
- [ ] No round count multiplied by workingSets. A has 16, B 12, C 13 and D 12 prescribed exercise sets. With separate-side rows, there are respectively 19, 15, 17 and 16 actual rows.
- [ ] Identical reimport is a no-op. Current live content is reconciled rather than overwritten. Only applicable obsolete selections/caps are remapped; unrelated packs and current fixed-program preferences remain intact.
- [ ] Restart does not reactivate obsolete packs or reset accounts, bodyweight history or preferences.

## Workout flow

- [ ] Warm-up once -> grouped Workout -> Cooldown once. Each preparation/cooldown step has its own dosage, video and completion state.
- [ ] Plan A block 1 shows row + push-up for 3 rounds. Each round has one row left/right pair and one push-up set. Round 2 never overwrites round 1.
- [ ] Ordered blocks and round counts agree with the PDF/JSON. Targets show reps/time per exercise this round, not another nested set multiplier.
- [ ] Moving among rounds, editing older actuals, refresh, offline replay and resume preserve every actual and choose the next pending row correctly.
- [ ] Default effort wording is plain English; no mandatory RIR input. Holds have a position/technique cue. Loads remain manually entered and changed.
- [ ] 360px and desktop: readable targets, side labels, numeric inputs, focus order, large tap targets and visible save/conflict status.

## Rest and completion

- [ ] Plan A row left alone does not trigger the next-exercise timer. After both sides, rest 60s before push-ups. After push-ups in rounds 1/2, rest 120s before the next round. After round 3, use one 120s after-block rest, not 240s.
- [ ] Plan C block 1 uses 90s between exercises, 150s between rounds and one 150s after-block rest. Final workout block has no additional work rest.
- [ ] Replay/edit cannot duplicate/restart a rest boundary timer. Skipping/manual navigation cannot silently start it. Extending/ending timers is allowed; timer expiry never marks actuals done.
- [ ] A round with skipped work remains distinguishable as partial. Round-complete actions cannot create reps/weight or mark missing working actuals as performed.
- [ ] Continue to cooldown keeps the workout clock open. Final Finish closes it. All work performed plus cooldown skipped retains completed strength status; skipped/missing work is partial.

## Logging, history and deployment

- [ ] Left 12/right 10 rows stay distinct per round. Twenty taps means 20 total, not 40. Split squats use two dumbbells per side record; French extensions use one shared dumbbell.
- [ ] Warm-up/cooldown quick Done stores acknowledged with actuals null; measured entries validate normally. Preparation never becomes the last working result or contributes to working volume.
- [ ] New block snapshots reference the original working occurrence/set actuals; no second mutable copy is stored under blocks. Substitution retains occurrence/round identity and correct load semantics.
- [ ] Duplicate operation replay does not append sets or finish the opposite side. Same operation ID with changed payload conflicts. Stale concurrent edits are surfaced.
- [ ] Compare saved v1/v2 completed and active sessions before/after update: snapshots/actuals unchanged, old resume works and no block data is fabricated. New v3 snapshots survive subsequent catalog changes.
- [ ] Exports/restores include all formats and new block membership; no stripping, synthetic timestamps or invented historical sessions.
- [ ] Run typecheck, lint, meaningful schema/state/version tests, Mongo persistence and browser flow checks. Verify actual video playback and embedding separately; retain fallback links.
- [ ] Back up, deploy readers first, preview/activate conflict-free v3 and verify live HTTPS, four cards, blocks, section navigation, logging and history. Remove isolated synthetic smoke data.
- [ ] Keep schema-3 reader support during rollback; never restore an old dump over newly recorded sessions.

These are checks for Claude to perform in the actual repository and deployment. The package itself does not demonstrate that the live app was changed.
