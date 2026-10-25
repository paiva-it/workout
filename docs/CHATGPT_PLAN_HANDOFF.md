# Handoff: create new training plans for the Workout app

Paste everything below the line into ChatGPT (or another assistant). Attach these files from the repo:

1. `contracts/training-pack.v2.schema.json` — the current import format (schema 2, JSON Schema 2020-12).
2. `data/training-pack.v2.json` — the pack currently live in the app (or the newest pack you imported since).
3. Optional, private: your export from **Settings → Export** (`workout-export.json`) so the plans can build on real results.
   Never paste it into a public place; it contains your training history and body weight.

Fill in the `[brackets]`. Then validate the answer (see **Before you import**, at the end).

---

## Your task

You are designing additional training plans for my personal workout-tracking app. The app imports plans as a
**training pack**: one self-contained JSON file that must match the attached `training-pack.schema.json` exactly and
pass the app's extra validation rules listed below. The app rejects the whole file on any error, so correctness
matters more than length.

### About me (fill in)

- Equipment I actually have: [e.g. adjustable dumbbells 2–24 kg in 2 kg steps, stable flat bench; no rack, no pull-up bar]
- Goal for the next block: [e.g. more upper-back and leg volume; stay at 3–4 sessions a week]
- Days and time available: [e.g. Mon/Wed/Fri/Sat, 45–60 min]
- Current limitations: [none / describe]
- Recent results: [summary, or "see attached export"]
- What I want: [e.g. a 4-week program after the restart; a 30-minute express full-body plan; replace the calf-raise video]

### What to return

1. **One JSON file**: the complete new pack (see *Which kind of pack* below). Valid JSON only: no comments, no trailing
   commas, no `...` placeholders.
2. A short **readable summary**: each plan's purpose, its exercises with sets × reps and effort, the weekly schedule, and
   what changed compared with the attached pack.
3. A **self-check list** stating that you went through every rule under *Validation rules* and *Versioning rules*.
4. A **video table** (id, YouTube id, title, channel, how you verified it). If you cannot open YouTube, say so and do not
   invent video IDs: reuse the videos already in the attached pack and tell me which new ones still need a link.

## How the app uses a pack

- A pack has `packId` + `version`. The app keeps every imported pack forever (old workouts point at them).
- **Only one version per `packId` is active.** Importing `home-return-foundation` version 2 *replaces* version 1 in the
  active catalog: anything you leave out of v2 disappears from the Plans screen and program list (old history stays
  intact). Different `packId`s are active side by side.
- If two active packs contain the same plan/exercise/program `id`, the higher `version` wins.
- Starting a workout copies the plan, its exercises and videos into that workout, so later pack versions never change
  past or in-progress workouts.
- Users pick a **program** in Settings by `id`. Keep existing program ids stable or the user has to choose again.

### Which kind of pack

Prefer **a new version of the existing pack**: copy the attached pack, set `"version"` to the current version + 1,
update `createdOn`, keep every existing video/exercise/plan/program unless I asked to remove or change it, and append the
new items. This keeps one catalog and avoids cross-pack conflicts.

Only if I ask for a separate collection, make a **new pack** with a new `packId`; it must still contain every exercise and
video its plans reference (copied byte-for-byte when you reuse an existing `id` + `version`).

## Validation rules (enforced on import)

**Shape**
- `schemaVersion: 1`, `language: "en-US"`, `units: "kg"`, `createdOn` as `YYYY-MM-DD`.
- No property that the schema does not list (`additionalProperties: false` everywhere). Every required property present.
- IDs (`packId`, video/exercise/plan/item/warm-up step/program ids): lowercase letters, digits and hyphens, starting with a
  letter or digit, 2–100 characters (`^[a-z0-9][a-z0-9-]{1,99}$`). Unique within their list: videos, exercises, plans,
  programs, and items inside one plan. Item ids must be unique within their plan; make them globally unique anyway
  (e.g. `upper-a-item-01`).
- Limits: file ≤ 2 MiB, ≤ 100 plans, ≤ 500 exercises, ≤ 500 videos, ≤ 50 programs; 1–30 items per plan; `workingSets`
  1–10; `restSeconds` 0–600; target `min`/`max` 1–86400 with `min ≤ max`; RIR pairs `[low, high]` with 0 ≤ low ≤ high ≤ 10;
  plan and warm-up/cool-down durations are `[min, max]` minute pairs (plan 1–240, warm-up/cool-down 1–30).
- Warm-up step: `id`, `label`, `notes` required; optional `reps` (1–100) or `durationSeconds` (1–1800). 1–20 steps.
- Cool-down: 1–10 instruction strings. Plan `notes`: 1–20 strings. `focus`: 1–10 strings. `cues`: 1–8 strings.
- Plain text only. **Never use `<` or `=` in any text**, never `javascript:`. (The app rejects anything that could look
  like markup or an HTML attribute, e.g. `on…=`. Write "at most", "equals", "less than" in words.)
- Never include personal fields or data: no `password`, `passwordHash`, `username`, `massGrams`, body weight, age or
  health information anywhere in the pack. The pack is public.

**Videos**
- `provider: "youtube"`, `youtubeId` exactly 11 characters `[A-Za-z0-9_-]`, and `url` exactly
  `https://www.youtube.com/watch?v=<youtubeId>` (no `youtu.be`, no extra parameters).
- `verification`: `"search_metadata_matched"` or `"playback_checked"`; `checkedOn` = the date you checked;
  `playbackVerified` / `embeddingVerified` must be honest (`false` unless you actually confirmed it).
- `usageNote` must say what the video is for (exact exercise demo vs general reference) and that the plan, not the video,
  sets the sets/reps/effort.
- Never reuse `PQ-F5uzxipQ` (private) or `oLu9kwDzBdg` (embedding disabled). All 36 videos used by the v2 plans were
  playback-checked in an embedded player on 2026-10-25 (`verification: "playback_checked"`).

**Exercises**
- `videoId` must exist in the pack's `videos`.
- `metric: "duration"` ⇒ `repsMeaning: "seconds"`.
- `laterality: "separate_sides"` with `metric: "reps"` ⇒ `repsMeaning: "per_side"`.
- `bilateral` reps exercises use `repsMeaning: "simultaneous_repetitions"`.
- Load basis and implement count must agree:

  | `defaultLoadBasis` | `defaultImplementCount` | meaning in the app |
  |---|---|---|
  | `per_dumbbell` | `2` | two dumbbells; user enters the weight of ONE ("10 kg each") |
  | `per_dumbbell` | `1` | one-arm dumbbell work; user enters that dumbbell |
  | `single_dumbbell` | `1` | one dumbbell held in both hands (goblet squat) |
  | `barbell_total` / `external_total` | `1` | total load (barbell includes the bar) |
  | `bodyweight` / `none` | `0` | no load entry; body mass is never added as load |

- `archived: false` for anything selectable (`true` hides it from new workouts but keeps history).
- Include `primaryMuscles` (1–10), `secondaryMuscles` (0–10), `movementPattern`, `equipment` (1–10), `cues`,
  and a `regression` (an easier option the user can switch to).
- The app shows a "support height (mm)" field only for exercises whose `id` contains `incline`.

**Plans and items**
- `exampleVideoId` and `warmup.videoId` must exist in `videos`. `exampleVideoLabel` must say it is an example exercise
  tutorial, not a video of the whole routine.
- Each item's `exerciseId` must exist in the same pack, and `exerciseVersion` must equal that exercise's `version`.
- `target.metric` must equal the exercise's `metric`; `target.perSide` must be `true` exactly when the exercise is
  `separate_sides` (and then use `restAfter: "both_sides"`; otherwise `"set"`).
- `targetRir`: `[low, high]` for strength work, `null` for holds/walking/mobility (no RIR).
- `optional: true` items are never added automatically; the user adds them only when the program phase allows it.
- `defaultVariant`: a short label such as `standard` or `bodyweight_supported`. `notes` may be `""`.
- `kind`: `restart`, `focus` or `recovery`.

**Programs**
- `weekStart: "monday"`; weeks are counted Monday-to-Sunday from the start date the user chooses.
- `startDatePolicy`: `choose_on_first_use` (recommended for a first program) or `explicit_selection_after_restart`.
- Every phase needs a schedule: its own `schedule`, its own `alternatingSchedules`, or the program-level `schedule`.
- Schedules: no weekday twice in one schedule; every `planId` must exist in the pack.
- Phase `weeks: [start, end]` with `start ≤ end`, or `[start, null]` for an open-ended last phase. Make phases
  continuous (1–1, 2–2, 3–4, 5–null) so every week has a phase.
- Phase `rir` `[low, high]`, `workingSetCap` (1–10 or `null` = listed sets), `allowOptional`, and `notes` are required.
- Optional: `transitionPolicy`, `missedDayPolicy`; `fullRestAllowed` on a schedule entry.

### How the app applies a phase (design with this in mind)

- Working sets in a workout = `min(item.workingSets, phase.workingSetCap)`, or the listed sets when the cap is `null`.
- Effort: if the item has `targetRir`, the workout uses the element-wise **maximum** of item and phase RIR
  (`[max(item.low, phase.low), max(item.high, phase.high)]`), so an item you made easier stays easier. Items with `null`
  RIR stay `null`.
- With `alternatingSchedules`, week *w* of a phase starting at week *s* uses schedule `(w - s) mod count`.
- "Next session" = the next schedule entry not yet done this week. Missed days are skipped, never stacked.
- The user can hold or repeat any phase, so each phase must make sense on its own.
- In a workout the user can substitute an exercise only with one using the same `metric` (reps vs seconds).

## Versioning rules (enforced on import)

- Same `packId` + same `version` + different content ⇒ **rejected**. Always bump the pack `version` for any change,
  including video-only changes.
- A pack `version` lower than one already imported ⇒ **rejected**.
- An exercise, plan or program that reuses an existing `id` **and** `version` must be **identical** to the stored one
  (same keys and values). To change sets, reps, rest, cues, notes, items or videos of an existing definition, increment
  that definition's `version`, and update every item's `exerciseVersion` that points at a changed exercise.
- Unchanged definitions keep their old version numbers.
- An exercise `id` must keep its `metric`, `laterality`, `repsMeaning` and `defaultLoadBasis` forever. A different
  movement or a different way of logging it (for example a one-arm version of a two-dumbbell exercise) needs a **new id**.
- Prefer reusing existing exercise ids when the movement and logging are the same, so history and "last time" stay
  comparable.

## Schema 2 additions (current format)

The live pack is `home-return-foundation` **version 2, `schemaVersion: 2`**. New packs should use schema 2:

- `warmup.steps` and `cooldown.steps` are exercise-linked activities (`sectionStep`): `id`, `exerciseId`,
  `exerciseVersion`, `sets` (1–5), `target`, `restSeconds`, `restAfter`, `defaultVariant`, `role`, `linkedWorkoutItemId`,
  `notes`. Warm-up roles: `pulse_raise`, `mobility`, `rehearsal`. Cooldown roles: `easy_movement`, `stretch`.
  `cooldown.steps` is required (1–10); `cooldown.instructions` stays as general guidance.
- Step ids must be unique across warm-up, items and cooldown of the same plan.
- `linkedWorkoutItemId` is `null`, or (only for a `rehearsal`) the id of a work item in the same plan with the **same**
  `exerciseId` and `exerciseVersion`.
- `repsMeaning` may be `alternating_total` for bilateral reps exercises where each alternating side action counts once
  (heel touches, shoulder taps): "20" means 20 in total. Bilateral reps use `simultaneous_repetitions` or
  `alternating_total`; separate-side reps use `per_side`; durations use `seconds`.
- In schema 2, `=` is allowed only inside video `url` values.
- Every exercise used in a section must be in `exercises` with its own video.
- The single program `return-to-training` (v2) has one open-ended phase (`weeks: [1, null]`, `workingSetCap: null`):
  the app hides week/phase controls for such programs. Keep that id so the user's selection carries over.

## Original catalog (pack `home-return-foundation` v1, schema 1 — superseded, for reference)

| exercise id | v | metric | sides | load basis | count | video |
|---|---|---|---|---|---|---|
| db-bench-press | 1 | reps | bilateral | per_dumbbell | 2 | v-bench |
| db-floor-press | 1 | reps | bilateral | per_dumbbell | 2 | v-floor |
| incline-pushup | 1 | reps | bilateral | bodyweight | 0 | v-incline-pushup |
| db-supported-row | 1 | reps | separate_sides | per_dumbbell | 1 | v-row |
| db-reverse-fly | 1 | reps | bilateral | per_dumbbell | 2 | v-reverse-fly |
| db-shrug | 1 | reps | bilateral | per_dumbbell | 2 | v-shrug |
| goblet-squat | 1 | reps | bilateral | single_dumbbell | 1 | v-squat |
| db-rdl | 1 | reps | bilateral | per_dumbbell | 2 | v-rdl |
| reverse-lunge | 1 | reps | separate_sides | bodyweight | 0 | v-lunge |
| calf-raise | 1 | reps | bilateral | bodyweight | 0 | v-calf |
| db-standing-press | 1 | reps | bilateral | per_dumbbell | 2 | v-press |
| db-lateral-raise | 1 | reps | bilateral | per_dumbbell | 2 | v-lateral |
| db-curl | 1 | reps | bilateral | per_dumbbell | 2 | v-curl |
| db-hammer-curl | 1 | reps | bilateral | per_dumbbell | 2 | v-hammer |
| db-floor-triceps-extension | 1 | reps | bilateral | per_dumbbell | 2 | v-triceps |
| db-close-floor-press | 1 | reps | bilateral | per_dumbbell | 2 | v-close-floor |
| dead-bug | 1 | reps | separate_sides | bodyweight | 0 | v-deadbug |
| side-plank | 1 | duration | separate_sides | bodyweight | 0 | v-sideplank |
| glute-bridge | 1 | reps | bilateral | bodyweight | 0 | v-bridge |
| easy-walk | 1 | duration | bilateral | none | 0 | v-warmup |
| gentle-mobility | 1 | duration | bilateral | none | 0 | v-warmup |

Plans (all v1; `*` = optional item): `restart-a` (goblet squat, bench, row, glute bridge, dead bug),
`restart-b` (RDL, incline push-up, row, standing press, calf raise, side plank), `chest` (bench, floor press,
incline push-up, dead bug*), `back` (row, reverse fly, shrug, curl), `legs` (goblet squat, RDL, reverse lunge, calf raise),
`shoulders-core` (standing press, lateral raise, row, dead bug, side plank), `arms` (curl, hammer curl, floor triceps
extension, close floor press, goblet squat, glute bridge*), `recovery` (easy walk, gentle mobility).

Programs: `return-to-training` (four-week restart, default, open-ended last phase) and `five-focus-days`
(chest/back/legs/shoulders-core/recovery/arms/recovery, Monday to Sunday).

## Reading my export (if attached)

`sessions[]` are workouts: `status` (`completed`, `partial`, `abandoned`; abandoned does not count), `localDate`,
`programContext` (program week and phase), and `exercises[].sets[]` with `type` (`warmup`/`working`), `status`
(`done`/`pending`/`skipped`), `side` (`both`/`left`/`right`), `actualReps`, `actualDurationSeconds`, `actualRir` (`null` =
not recorded, not zero) and `actualLoad.valueGrams`, where grams are **per dumbbell** for `per_dumbbell`, the single
dumbbell for `single_dumbbell`, and `null` for bodyweight. Base progressions on done working sets only. Do not treat
remembered old personal records as current ability, and do not put any of this data into the pack.

## Training design guidance

- Home setup: dumbbells and a flat bench unless I list more. No rack, safety arms, machines or adjustable bench unless I say so.
- Progress one variable at a time (load, reps or sets), keep most work 1–3 RIR from failure, and give each muscle group
  at least one easier day between hard sessions.
- Every plan: a warm-up (with a loaded ramp-up step before the first heavy exercise), a cool-down, realistic duration,
  and an easier regression for each exercise.
- Do not schedule catch-up workouts. Do not use old personal records to pick loads.

---

## Before you import (for me, not for ChatGPT)

1. Save the JSON as e.g. `training-pack.v2.json`. Quick structural check from the repo root:
   `node scripts/validate-pack.mjs training-pack.v2.json`
2. In the app: **Settings → Import plans → Preview**. The preview runs the full schema, reference and versioning checks
   and changes nothing. It must say `new` with `0 conflicting`; read the new/unchanged counts.
3. **Import and activate**, then open the new plans and click each video once (embeds can be blocked by the uploader;
   the "Open on YouTube" link stays).
4. If a program id changed or you want the new program, pick it in **Settings → Program**.

Optional video check before importing (prints 200 per embeddable video):

```sh
python3 -c "import json,sys,urllib.request,urllib.parse as u
for v in json.load(open(sys.argv[1]))['videos']:
  try: print(urllib.request.urlopen('https://www.youtube.com/oembed?url='+u.quote(v['url'])).status, v['id'])
  except Exception as e: print(getattr(e,'code',e), v['id'], '<- check')" training-pack.v2.json
```
