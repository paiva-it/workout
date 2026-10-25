import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Header, Patch, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { isFixedProgram, localParts, nextScheduled, programPosition, weekdayIndex } from '@workout/contracts';
import { BodyMeasurement, TrainingPack, TrainingSession, User, out } from './db.js';
import { activeCatalog } from './catalog.js';
import { safeUser } from './auth.js';
import { summarize } from './sessions.js';
import { fail, parse, zInt, zLocalDate, zTz } from './common.js';

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- lean projections
const ProgramDto = z.strictObject({ expectedRevision: zInt(1, 1e9), programId: z.string().max(100).nullable(), startDate: zLocalDate.nullable(), heldPhaseIndex: zInt(0, 19).nullable() });
const SettingsDto = z.strictObject({
  expectedRevision: zInt(1, 1e9), displayName: z.string().trim().max(80).optional(), timezone: zTz.optional(),
  equipment: z.array(z.string().trim().min(1).max(80)).max(30).optional(), restTimerEnabled: z.boolean().optional(),
});

async function casUser(id: string, rev: number, $set: Record<string, unknown>) {
  const u = await User.findOneAndUpdate({ _id: id, revision: rev }, { $set, $inc: { revision: 1 } }, { returnDocument: 'after' }).lean();
  if (!u) throw fail(409, 'REVISION_CONFLICT', 'Settings changed elsewhere; reload');
  return safeUser(u);
}

@Controller()
export class MeController {
  @Patch('me/program')
  async program(@Req() req: Request, @Body() body: unknown) {
    const dto = parse(ProgramDto, body);
    if (dto.programId) {
      const p = (await activeCatalog()).programs.find((x) => x.id === dto.programId);
      if (!p) throw fail(422, 'VALIDATION', 'Unknown program', { fieldErrors: { programId: 'Unknown' } });
      if (dto.heldPhaseIndex != null && !p.phases[dto.heldPhaseIndex]) throw fail(422, 'VALIDATION', 'Unknown phase', { fieldErrors: { heldPhaseIndex: 'Unknown' } });
    }
    return casUser(req.user!.id, dto.expectedRevision, { program: { programId: dto.programId, startDate: dto.startDate, heldPhaseIndex: dto.heldPhaseIndex } });
  }

  @Patch('me/settings')
  async settings(@Req() req: Request, @Body() body: unknown) {
    const { expectedRevision, ...rest } = parse(SettingsDto, body);
    return casUser(req.user!.id, expectedRevision, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
  }

  /** Everything the Today screen needs in one round trip. */
  @Get('today')
  async today(@Req() req: Request) {
    const u = (await User.findById(req.user!.id).lean())!;
    const c = await activeCatalog();
    const today = localParts(new Date(), u.timezone).localDate;
    const [active, recent, latestWeight] = await Promise.all([
      TrainingSession.findOne({ ownerId: u._id, isActive: true }, { status: 1, planRef: 1, 'planSnapshot.name': 1, startedAt: 1, revision: 1 }).lean<Doc>(),
      TrainingSession.find({ ownerId: u._id, isActive: false, deletedAt: null }, { 'planSnapshot.name': 1, planRef: 1, status: 1, localDate: 1, startedAt: 1, activeSeconds: 1, exercises: 1, programContext: 1 }).sort({ startedAt: -1 }).limit(12).lean<Doc[]>(),
      BodyMeasurement.findOne({ ownerId: u._id, deletedAt: null }).sort({ localDate: -1, measuredAt: -1, createdAt: -1 }).lean(),
    ]);
    const program = u.program?.programId ? c.programs.find((p) => p.id === u.program!.programId) ?? null : null;
    let position = null, next = null, doneThisWeek = 0;
    const pos = program && programPosition(program, { programId: program.id, startDate: u.program?.startDate ?? null, heldPhaseIndex: u.program?.heldPhaseIndex ?? null }, today);
    if (program && pos) {
      const weekStart = new Date(Date.parse(today) - weekdayIndex(today) * 86400000).toISOString().slice(0, 10);
      // Count finished (not abandoned) program sessions since this week's Monday; missed ones are never owed.
      doneThisWeek = recent.filter((s) => s.localDate >= weekStart && s.status !== 'abandoned' && (s.programContext as { programId?: string } | null)?.programId === program.id).length;
      const entry = nextScheduled(pos, doneThisWeek);
      const plan = entry && c.plans.find((p) => p.id === entry.planId);
      const fixed = isFixedProgram(program);
      const names = Object.fromEntries(c.plans.map((p) => [p.id, p.name]));
      position = { programId: program.id, programName: program.name, programWeek: pos.programWeek, phaseIndex: pos.phaseIndex, phase: pos.phase, fixed, held: !fixed && u.program?.heldPhaseIndex != null,
        schedule: pos.schedule.map((s) => ({ ...s, planName: names[s.planId] ?? s.planId })) };
      next = plan ? { weekday: entry!.weekday, planId: plan.id, planVersion: plan.version, packId: plan.packId, packVersion: plan.packVersion, name: plan.name, estimatedDurationMinutes: plan.estimatedDurationMinutes } : null;
    }
    return {
      today, user: safeUser(u), program: program && { id: program.id, name: program.name }, position, next, doneThisWeek,
      active: active && { id: active._id, status: active.status, planName: (active.planSnapshot as { name: string }).name, startedAt: active.startedAt, revision: active.revision },
      recent: recent.slice(0, 5).map((s) => ({ id: s._id, planName: (s.planSnapshot as { name: string }).name, status: s.status, localDate: s.localDate, activeSeconds: s.activeSeconds, summary: summarize(s) })),
      latestWeight: latestWeight && out(latestWeight),
    };
  }

  @Get('exports/personal.json')
  @Header('Content-Disposition', 'attachment; filename="workout-export.json"')
  async export(@Req() req: Request, @Res() res: Response) {
    const ownerId = req.user!.id;
    const [u, sessions, measurements] = await Promise.all([
      User.findById(ownerId).lean(),
      TrainingSession.find({ ownerId }, { appliedOperations: 0, createPayloadHash: 0 }).sort({ startedAt: 1 }).lean(),
      BodyMeasurement.find({ ownerId }, { createPayloadHash: 0 }).sort({ localDate: 1 }).lean(),
    ]);
    const packIds = [...new Set(sessions.map((s) => { const r = s.planRef as { packId: string; packVersion: number }; return `${r.packId}@${r.packVersion}`; }))];
    const packs = await TrainingPack.find({ _id: { $in: packIds } }, { content: 1, contentHash: 1, packId: 1, version: 1 }).lean();
    res.json({
      formatVersion: 1, exportId: randomUUID(), exportedAt: new Date(),
      conventions: { mass: 'integer grams', load: 'actualLoad.valueGrams per implement for per_dumbbell (implementCount implements), single implement for single_dumbbell, total for barbell_total/external_total; null for bodyweight/none', time: 'UTC instants plus original IANA timezone, localDate and UTC offset minutes', nullMeansUnknown: true },
      user: u && safeUser(u), definitions: packs.map(out), sessions: sessions.map(out), bodyMeasurements: measurements.map(out),
    });
  }
}

@Controller('health')
export class HealthController {
  @Get('live')
  live() {
    return { status: 'ok' };
  }
  @Get('ready')
  async ready(@Res() res: Response) {
    const ok = mongoose.connection.readyState === 1 && (await mongoose.connection.db?.admin().ping().then(() => true, () => false));
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable' });
  }
}
