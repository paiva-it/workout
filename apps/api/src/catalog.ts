import { readFileSync } from 'node:fs';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Request } from 'express';
import { z } from 'zod';
import type { Exercise, Plan, Program, SectionStep, TrainingPack as Pack, Video } from '@workout/contracts';
import { CatalogState, TrainingPack } from './db.js';
import { canonicalJson, fail, parse, sha256 } from './common.js';

const contractsDir = process.env.PACK_SCHEMA_DIR ?? new URL('../../../contracts/', import.meta.url).pathname;
const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
// Both formats stay pinned side by side; `schemaVersion` picks one before validation (no stripping of unknown fields).
const SCHEMAS: Record<number, ReturnType<typeof ajv.compile>> = {
  1: ajv.compile(JSON.parse(readFileSync(contractsDir + 'training-pack.schema.json', 'utf8'))),
  2: ajv.compile(JSON.parse(readFileSync(contractsDir + 'training-pack.v2.schema.json', 'utf8'))),
};
const WARMUP_ROLES = ['pulse_raise', 'mobility', 'rehearsal'], COOLDOWN_ROLES = ['easy_movement', 'stretch'];
export const MAX_PACK_BYTES = 2 * 1024 * 1024;
const HTML = /<\s*\/?\s*[a-z!?]|javascript:|on\w+\s*=/i;
const URL_KEY = /\/videos\/\d+\/url$/;

/** Full validation: JSON Schema 2020-12 + cross-references + semantics + no markup. Never touches the DB. */
export function validatePack(raw: unknown): { pack: Pack | null; errors: string[] } {
  const errors: string[] = [];
  const bytes = Buffer.byteLength(JSON.stringify(raw ?? null));
  if (bytes > MAX_PACK_BYTES) return { pack: null, errors: ['Pack exceeds 2 MiB'] };
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  const validateSchema = typeof version === 'number' ? SCHEMAS[version] : undefined;
  if (!validateSchema) return { pack: null, errors: [`Unsupported schemaVersion ${JSON.stringify(version)} (supported: 1, 2)`] };
  if (!validateSchema(raw)) return { pack: null, errors: (validateSchema.errors ?? []).slice(0, 50).map((e) => `${e.instancePath || '/'} ${e.message}`) };
  const p = raw as Pack;
  const check = (ok: unknown, msg: string) => { if (!ok) errors.push(msg); };
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      check(!HTML.test(v), `Markup/script content not allowed at ${path}`);
      if (p.schemaVersion === 2) check(!v.includes('=') || URL_KEY.test(path), `'=' is only allowed in video URLs (${path})`);
    }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}/${i}`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}/${k}`);
  };
  walk(p, '');
  const index = <T extends { id: string }>(xs: T[], label: string) => {
    const m = new Map<string, T>();
    for (const x of xs) { check(!m.has(x.id), `${label}: duplicate ${x.id}`); m.set(x.id, x); }
    return m;
  };
  const videos = index(p.videos, 'videos'), exercises = index(p.exercises, 'exercises'), plans = index(p.plans, 'plans');
  index(p.programs, 'programs');
  for (const v of videos.values()) check(v.url === `https://www.youtube.com/watch?v=${v.youtubeId}`, `URL/ID mismatch: ${v.id}`);
  for (const e of exercises.values()) {
    check(videos.has(e.videoId), `Missing exercise video: ${e.id}`);
    check(e.defaultLoadBasis !== 'single_dumbbell' || e.defaultImplementCount === 1, `Single-dumbbell count: ${e.id}`);
    check(!['bodyweight', 'none'].includes(e.defaultLoadBasis) || e.defaultImplementCount === 0, `Unloaded count: ${e.id}`);
    check(e.defaultLoadBasis !== 'per_dumbbell' || [1, 2].includes(e.defaultImplementCount), `Per-dumbbell count: ${e.id}`);
    check(e.metric !== 'duration' || e.repsMeaning === 'seconds', `Duration semantics: ${e.id}`);
    check(e.laterality !== 'separate_sides' || e.metric !== 'reps' || e.repsMeaning === 'per_side', `Side semantics: ${e.id}`);
    check(e.repsMeaning !== 'alternating_total' || (e.metric === 'reps' && e.laterality === 'bilateral'), `alternating_total is only for bilateral reps: ${e.id}`);
    if (p.schemaVersion === 2 && e.metric === 'reps' && e.laterality === 'bilateral') check(['simultaneous_repetitions', 'alternating_total'].includes(e.repsMeaning), `Bilateral reps semantics: ${e.id}`);
  }
  for (const plan of plans.values()) {
    check(videos.has(plan.exampleVideoId), `Missing plan video: ${plan.id}`);
    check(videos.has(plan.warmup.videoId), `Missing warm-up video: ${plan.id}`);
    check(plan.estimatedDurationMinutes[0] <= plan.estimatedDurationMinutes[1], `Duration range: ${plan.id}`);
    index(plan.items, `${plan.id} items`);
    for (const item of plan.items) {
      const e = exercises.get(item.exerciseId);
      check(e, `Missing exercise: ${item.exerciseId} (${item.id})`);
      if (!e) continue;
      check(e.version === item.exerciseVersion, `Exercise version mismatch: ${item.id}`);
      check(item.target.metric === e.metric, `Metric mismatch: ${item.id}`);
      check(item.target.perSide === (e.laterality === 'separate_sides'), `Laterality mismatch: ${item.id}`);
      check(item.target.min <= item.target.max, `Target range: ${item.id}`);
      check(!item.targetRir || item.targetRir[0] <= item.targetRir[1], `RIR: ${item.id}`);
    }
    if (p.schemaVersion === 2) {
      const ids = new Set(plan.items.map((i) => i.id));
      const sections = [['warmup', plan.warmup.steps, WARMUP_ROLES], ['cooldown', plan.cooldown.steps ?? [], COOLDOWN_ROLES]] as const;
      for (const [name, steps, roles] of sections) {
        for (const st of steps as SectionStep[]) {
          check(!ids.has(st.id), `Duplicate step/item id in ${plan.id}: ${st.id}`);
          ids.add(st.id);
          check(roles.includes(st.role), `Role ${st.role} not allowed in ${name}: ${st.id}`);
          const e = exercises.get(st.exerciseId);
          check(e, `Missing exercise: ${st.exerciseId} (${st.id})`);
          if (!e) continue;
          check(e.version === st.exerciseVersion, `Exercise version mismatch: ${st.id}`);
          check(st.target.metric === e.metric, `Metric mismatch: ${st.id}`);
          check(st.target.perSide === (e.laterality === 'separate_sides'), `Laterality mismatch: ${st.id}`);
          check(st.target.min <= st.target.max, `Target range: ${st.id}`);
          if (st.linkedWorkoutItemId !== null) {
            const item = plan.items.find((i) => i.id === st.linkedWorkoutItemId);
            check(st.role === 'rehearsal', `Only rehearsals link to a work item: ${st.id}`);
            check(item && item.exerciseId === st.exerciseId && item.exerciseVersion === st.exerciseVersion, `Rehearsal must match its linked item's exercise and version: ${st.id}`);
          }
        }
      }
    }
  }
  for (const program of p.programs) {
    const schedules = [program.schedule, ...program.phases.flatMap((x) => [x.schedule, ...(x.alternatingSchedules ?? [])])].filter(Boolean);
    for (const s of schedules) {
      check(new Set(s!.map((x) => x.weekday)).size === s!.length, `Duplicate weekday: ${program.id}`);
      for (const entry of s!) check(plans.has(entry.planId), `Missing scheduled plan: ${entry.planId}`);
    }
    for (const ph of program.phases) {
      check(ph.weeks[1] === null || ph.weeks[0] <= ph.weeks[1], `Week range: ${program.id}`);
      check(ph.rir[0] <= ph.rir[1], `Phase RIR range: ${program.id}`);
      check(ph.schedule || ph.alternatingSchedules || program.schedule, `No schedule for phase ${ph.name}: ${program.id}`);
    }
  }
  check(!/"(?:password|passwordHash|username|massGrams|healthContextNotForPublicRepo)"\s*:/.test(JSON.stringify(p)), 'Personal/credential fields are not allowed in a pack');
  return { pack: errors.length ? null : p, errors };
}

export const packHash = (p: Pack) => sha256(canonicalJson(p));
type Kind = 'videos' | 'exercises' | 'plans' | 'programs';
const KINDS: Kind[] = ['videos', 'exercises', 'plans', 'programs'];
const identity = (e: Exercise) => canonicalJson([e.metric, e.laterality, e.repsMeaning, e.defaultLoadBasis]);

/** Compare a validated pack with every stored pack. Read-only. */
export async function previewPack(p: Pack) {
  const contentHash = packHash(p);
  const stored = await TrainingPack.find().lean();
  const state = await getCatalogState();
  const errors: string[] = [];
  const same = stored.find((s) => s.packId === p.packId && s.version === p.version);
  let status: 'new' | 'noop' | 'conflict' = 'new';
  if (same) {
    if (same.contentHash === contentHash) status = 'noop';
    else { status = 'conflict'; errors.push(`Pack ${p.packId} version ${p.version} already exists with different content. Use a higher version.`); }
  }
  const maxStored = Math.max(0, ...stored.filter((s) => s.packId === p.packId).map((s) => s.version));
  if (!same && p.version < maxStored) { status = 'conflict'; errors.push(`Version ${p.version} is lower than stored version ${maxStored}.`); }
  const counts = Object.fromEntries(KINDS.map((k) => [k, { new: 0, unchanged: 0, conflicting: 0 }])) as Record<Kind, Record<'new' | 'unchanged' | 'conflicting', number>>;
  const existing = new Map<string, string>();
  const exerciseIdentity = new Map<string, string>();
  for (const s of stored) {
    const c = s.content as Pack;
    for (const k of KINDS) for (const d of c[k] as { id: string; version?: number }[]) existing.set(`${k}:${d.id}@${d.version ?? 0}`, canonicalJson(d));
    for (const e of c.exercises) exerciseIdentity.set(e.id, identity(e));
  }
  for (const k of KINDS) {
    for (const d of p[k] as { id: string; version?: number }[]) {
      // Videos have no version: any change to one belongs to a new pack version, so compare only within the same pack.
      const key = `${k}:${d.id}@${d.version ?? 0}`;
      const prev = existing.get(key);
      if (prev === undefined || (k === 'videos' && !same)) counts[k].new++;
      else if (prev === canonicalJson(d)) counts[k].unchanged++;
      else {
        counts[k].conflicting++;
        if (k !== 'videos') errors.push(`${k.slice(0, -1)} ${d.id} version ${d.version} differs from the stored definition; bump its version.`);
      }
    }
  }
  for (const e of p.exercises) {
    const prev = exerciseIdentity.get(e.id);
    if (prev && prev !== identity(e)) errors.push(`Exercise ${e.id} changes its logging identity (metric/sides/load basis); use a new exercise ID.`);
  }
  const active = state.activePacks.some((a) => a.packId === p.packId && a.version === p.version);
  const activeVersion = state.activePacks.find((a) => a.packId === p.packId)?.version ?? 0;
  if (!active && p.version < activeVersion) errors.push(`Version ${p.version} is older than active version ${activeVersion}; an import never downgrades (use the activate-pack maintenance command to roll back).`);
  if (errors.length && (status !== 'noop' || (!active && p.version < activeVersion))) status = 'conflict';
  return { status, errors, contentHash, packId: p.packId, version: p.version, title: p.title, counts, catalogRevision: state.revision, active };
}

/** Immutable insert, then compare-and-swap activation of the catalog manifest. */
export async function importPack(p: Pack, actor: string, expectedCatalogRevision: number) {
  const preview = await previewPack(p);
  if (preview.status === 'conflict') throw fail(409, 'IMPORT_CONFLICT', preview.errors[0] ?? 'Import conflict', { errors: preview.errors });
  if (preview.status === 'new') {
    try {
      await TrainingPack.create({ _id: `${p.packId}@${p.version}`, packId: p.packId, version: p.version, contentHash: preview.contentHash, content: p, importedAt: new Date(), importedBy: actor });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      const again = await previewPack(p); // lost an insert race: identical content is fine, anything else conflicts
      if (again.status !== 'noop') throw fail(409, 'IMPORT_CONFLICT', 'Pack version was imported concurrently with different content');
    }
  }
  if (preview.active) return { ...preview, activated: false, catalogRevision: preview.catalogRevision };
  const state = await getCatalogState();
  const activePacks = [...state.activePacks.filter((a) => a.packId !== p.packId), { packId: p.packId, version: p.version }];
  const updated = await CatalogState.findOneAndUpdate({ _id: 'active', revision: expectedCatalogRevision }, { $set: { activePacks }, $inc: { revision: 1 } }, { returnDocument: 'after' }).lean();
  if (!updated) throw fail(409, 'CATALOG_CONFLICT', 'The catalog changed since preview. Preview again; the stored pack can be activated on retry.', { catalogRevision: state.revision });
  cache = null;
  return { ...preview, status: preview.status, activated: true, catalogRevision: updated.revision };
}

/** Maintenance-only rollback/roll-forward of the active pointer to an already stored pack version. */
export async function activateStoredPack(packId: string, version: number) {
  if (!(await TrainingPack.exists({ _id: `${packId}@${version}` }))) throw new Error(`pack ${packId}@${version} is not stored`);
  const state = await getCatalogState();
  const before = state.activePacks;
  const activePacks = [...before.filter((a) => a.packId !== packId), { packId, version }];
  const updated = await CatalogState.findOneAndUpdate({ _id: 'active', revision: state.revision }, { $set: { activePacks }, $inc: { revision: 1 } }, { returnDocument: 'after' }).lean();
  if (!updated) throw new Error('catalog changed concurrently; retry');
  cache = null;
  return { before, after: activePacks, revision: updated.revision };
}

export async function getCatalogState() {
  return (await CatalogState.findOneAndUpdate({ _id: 'active' }, { $setOnInsert: { revision: 0, activePacks: [] } }, { upsert: true, returnDocument: 'after' }).lean())!;
}

// ---- Resolution of the active catalog ----
type Tagged<T> = T & { packId: string; packVersion: number };
interface Catalog { revision: number; packs: Pack[]; plans: Tagged<Plan>[]; exercises: Tagged<Exercise>[]; programs: Tagged<Program>[]; videos: Map<string, Video> }
let cache: Catalog | null = null;
function newest<T extends { id: string; version: number }>(xs: T[]) {
  const m = new Map<string, T>();
  for (const x of xs) if (!m.has(x.id) || m.get(x.id)!.version < x.version) m.set(x.id, x);
  return [...m.values()];
}
export async function activeCatalog(): Promise<Catalog> {
  const state = await getCatalogState();
  if (cache && cache.revision === state.revision) return cache;
  const docs = await TrainingPack.find({ _id: { $in: state.activePacks.map((a) => `${a.packId}@${a.version}`) } }).lean();
  const packs = docs.map((d) => d.content as Pack);
  const tag = <T>(p: Pack, x: T): Tagged<T> => ({ ...x, packId: p.packId, packVersion: p.version });
  cache = {
    revision: state.revision,
    packs,
    plans: newest(packs.flatMap((p) => p.plans.map((x) => tag(p, x)))),
    exercises: newest(packs.flatMap((p) => p.exercises.map((x) => tag(p, x)))),
    programs: newest(packs.flatMap((p) => p.programs.map((x) => tag(p, x)))),
    videos: new Map(packs.flatMap((p) => p.videos.map((v) => [v.id, v] as const))),
  };
  return cache;
}
export async function loadPack(packId: string, version: number): Promise<Pack | null> {
  const d = await TrainingPack.findById(`${packId}@${version}`).lean();
  return d ? (d.content as Pack) : null;
}
/** Plan + the exercise/video definitions it references, all from one self-contained pack. */
export function resolvePlan(pack: Pack, planId: string, version?: number) {
  const plan = pack.plans.find((p) => p.id === planId && (version == null || p.version === version));
  if (!plan) return null;
  const exercises = Object.fromEntries(pack.exercises.map((e) => [e.id, e]));
  const videos = Object.fromEntries(pack.videos.map((v) => [v.id, v]));
  return { plan, exercises, videos, packId: pack.packId, packVersion: pack.version, packSchemaVersion: pack.schemaVersion };
}

const PreviewDto = z.strictObject({ pack: z.unknown() });
const ImportDto = z.strictObject({ pack: z.unknown(), expectedCatalogRevision: z.number().int().min(0), previewHash: z.string().length(64) });

@Controller()
export class CatalogController {
  @Get('plans')
  async plans(@Query('kind') kind?: string, @Query('focus') focus?: string, @Query('maxMinutes') maxMinutes?: string) {
    const c = await activeCatalog();
    return c.plans
      .filter((p) => !p.archived && (!kind || p.kind === kind) && (!focus || p.focus.includes(focus)) && (!maxMinutes || p.estimatedDurationMinutes[0] <= Number(maxMinutes)))
      .map((p) => ({ id: p.id, version: p.version, packId: p.packId, packVersion: p.packVersion, name: p.name, kind: p.kind, focus: p.focus, estimatedDurationMinutes: p.estimatedDurationMinutes, itemCount: p.items.length,
        sections: p.cooldown.steps ? { warmup: p.warmup.steps.length, cooldown: p.cooldown.steps.length } : null }));
  }

  @Get('plans/:id')
  async plan(@Param('id') id: string, @Query('version') version?: string, @Query('packId') packId?: string, @Query('packVersion') packVersion?: string) {
    const c = await activeCatalog();
    let r;
    if (packId && packVersion) {
      const pack = await loadPack(packId, Number(packVersion));
      r = pack && resolvePlan(pack, id, version ? Number(version) : undefined);
    } else {
      const active = c.plans.find((p) => p.id === id && (!version || p.version === Number(version)));
      const pack = active && c.packs.find((p) => p.packId === active.packId);
      r = pack && resolvePlan(pack, id, active.version);
    }
    if (!r) throw fail(404, 'NOT_FOUND', 'Plan not found');
    return r;
  }

  @Get('programs')
  async programs() {
    return (await activeCatalog()).programs;
  }

  @Get('exercises')
  async exercises() {
    const c = await activeCatalog();
    return c.exercises.filter((e) => !e.archived).map((e) => ({ ...e, video: c.videos.get(e.videoId) ?? null }));
  }

  @Post('plan-imports/preview')
  @HttpCode(200)
  async preview(@Body() body: unknown) {
    const { pack } = parse(PreviewDto, body);
    const v = validatePack(pack);
    if (!v.pack) return { status: 'invalid', errors: v.errors };
    return previewPack(v.pack);
  }

  @Post('plan-imports')
  @HttpCode(200)
  async import(@Req() req: Request, @Body() body: unknown) {
    const dto = parse(ImportDto, body);
    const v = validatePack(dto.pack);
    if (!v.pack) throw fail(422, 'INVALID_PACK', v.errors[0], { errors: v.errors });
    if (packHash(v.pack) !== dto.previewHash) throw fail(409, 'PREVIEW_MISMATCH', 'Pack content differs from the preview. Preview again.');
    return importPack(v.pack, req.user!.id, dto.expectedCatalogRevision);
  }
}
