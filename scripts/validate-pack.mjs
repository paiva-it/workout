#!/usr/bin/env node
/** Dependency-free cross-reference/invariant validator. Also validate the JSON
 * Schema with Ajv 2020 + formats in the implementation. This is not an API. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2] || path.join(base, 'data/training-pack.v1.json');
const bytes = fs.readFileSync(input);
const p = JSON.parse(bytes);
const errors = [];
const check = (ok, message) => { if (!ok) errors.push(message); };
const index = (xs, label) => {
  const result = new Map();
  for (const x of xs) { check(!result.has(x.id), `${label}: duplicate ${x.id}`); result.set(x.id, x); }
  return result;
};
check(bytes.length <= 2 * 1024 * 1024, 'Pack exceeds 2 MiB');
check(p.schemaVersion === 1 && p.units === 'kg', 'Unsupported schema or units');
const videos = index(p.videos, 'videos'), exercises = index(p.exercises, 'exercises'), plans = index(p.plans, 'plans');
index(p.programs, 'programs');
for (const v of videos.values()) {
  check(/^[A-Za-z0-9_-]{11}$/.test(v.youtubeId), `Invalid YouTube ID: ${v.id}`);
  check(v.url === `https://www.youtube.com/watch?v=${v.youtubeId}`, `URL/ID mismatch: ${v.id}`);
  check(v.title.length > 0 && v.channel.length > 0, `Missing video metadata: ${v.id}`);
}
for (const e of exercises.values()) {
  check(videos.has(e.videoId), `Missing exercise video: ${e.id}`);
  check(e.defaultLoadBasis !== 'single_dumbbell' || e.defaultImplementCount === 1, `Single-dumbbell count: ${e.id}`);
  check(!['bodyweight','none'].includes(e.defaultLoadBasis) || e.defaultImplementCount === 0, `Unloaded count: ${e.id}`);
  check(e.metric !== 'duration' || e.repsMeaning === 'seconds', `Duration semantics: ${e.id}`);
  check(e.laterality !== 'separate_sides' || e.metric !== 'reps' || e.repsMeaning === 'per_side', `Side semantics: ${e.id}`);
}
for (const plan of plans.values()) {
  check(videos.has(plan.exampleVideoId), `Missing plan video: ${plan.id}`);
  check(videos.has(plan.warmup.videoId), `Missing warm-up video: ${plan.id}`);
  check(plan.estimatedDurationMinutes[0] <= plan.estimatedDurationMinutes[1], `Duration range: ${plan.id}`);
  index(plan.items, `${plan.id} items`);
  for (const item of plan.items) {
    const e = exercises.get(item.exerciseId);
    check(!!e, `Missing exercise: ${item.exerciseId}`);
    if (!e) continue;
    check(e.version === item.exerciseVersion, `Exercise version mismatch: ${item.id}`);
    check(item.target.metric === e.metric, `Metric mismatch: ${item.id}`);
    check(item.target.perSide === (e.laterality === 'separate_sides'), `Laterality mismatch: ${item.id}`);
    check(item.target.min > 0 && item.target.min <= item.target.max, `Target range: ${item.id}`);
    check(Number.isInteger(item.workingSets) && item.workingSets >= 1 && item.workingSets <= 10, `Sets: ${item.id}`);
    check(!item.targetRir || (item.targetRir[0] >= 0 && item.targetRir[0] <= item.targetRir[1] && item.targetRir[1] <= 10), `RIR: ${item.id}`);
  }
}
for (const program of p.programs) {
  const schedules = [program.schedule, ...program.phases.flatMap(x => [x.schedule, ...(x.alternatingSchedules || [])])].filter(Boolean);
  for (const schedule of schedules) {
    check(new Set(schedule.map(x=>x.weekday)).size === schedule.length, `Duplicate weekday: ${program.id}`);
    for (const entry of schedule) check(plans.has(entry.planId), `Missing scheduled plan: ${entry.planId}`);
  }
  for (const phase of program.phases) {
    check(phase.weeks[1] === null || phase.weeks[0] <= phase.weeks[1], `Week range: ${program.id}`);
    check(phase.rir[0] <= phase.rir[1], `Phase RIR range: ${program.id}`);
  }
}
// Public pack must remain generic. Match sensitive field classes, not secret values.
check(!/"(?:password|passwordHash|username|massGrams|healthContextNotForPublicRepo)"\s*:/.test(bytes.toString()), 'Personal/credential fields found in public pack');
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`PASS: ${plans.size} plans, ${exercises.size} exercises, ${videos.size} video references, ${p.programs.length} programs; references and semantics consistent.`);
