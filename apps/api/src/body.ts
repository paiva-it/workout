import { randomUUID } from 'node:crypto';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { localParts } from '@workout/contracts';
import { BodyMeasurement, out } from './db.js';
import { fail, hashPayload, parse, zInt, zIso, zLocalDate, zNote, zTz, zUuid } from './common.js';

const Context = z.strictObject({
  timeOfDay: z.enum(['morning', 'afternoon', 'evening', 'unknown']).default('unknown'),
  beforeFood: z.boolean().nullable().default(null), scaleLabel: zNote(80).default(null), notes: zNote(1000).default(null),
});
const CreateDto = z.strictObject({
  clientMeasurementId: zUuid, massGrams: zInt(1000, 1_000_000), measuredAt: zIso.nullable(), localDate: zLocalDate.optional(),
  timezone: zTz, source: z.enum(['scale_measurement', 'self_report']), context: Context.default({ timeOfDay: 'unknown', beforeFood: null, scaleLabel: null, notes: null }),
});
const PatchDto = z.strictObject({ expectedRevision: zInt(1, 1e9), reason: z.string().trim().min(3).max(1000), massGrams: zInt(1000, 1_000_000).optional(), measuredAt: zIso.optional(), timezone: zTz.optional(), context: Context.optional() });
const DeleteDto = z.strictObject({ expectedRevision: zInt(1, 1e9), reason: z.string().trim().min(3).max(1000) });

/** Instant entries derive local date/offset from the instant; date-only entries never get an invented time. */
function timeFields(measuredAt: Date | null, timezone: string, localDate?: string) {
  if (measuredAt) {
    const lp = localParts(measuredAt, timezone);
    return { measuredAt, datePrecision: 'instant' as const, localDate: lp.localDate, utcOffsetMinutes: lp.offsetMinutes, timezone };
  }
  if (!localDate) throw fail(422, 'VALIDATION', 'A date-only entry needs its date', { fieldErrors: { localDate: 'Required' } });
  return { measuredAt: null, datePrecision: 'day' as const, localDate, utcOffsetMinutes: null, timezone };
}
const view = (d: Record<string, unknown>) => { const { createPayloadHash: _c, ...rest } = d; void _c; return out(rest); };

@Controller('body-measurements')
export class BodyController {
  @Post()
  async create(@Req() req: Request, @Body() body: unknown): Promise<unknown> {
    const dto = parse(CreateDto, body);
    const ownerId = req.user!.id;
    if (dto.source === 'scale_measurement' && !dto.measuredAt) throw fail(422, 'VALIDATION', 'A scale weigh-in needs its date and time', { fieldErrors: { measuredAt: 'Required' } });
    if (dto.measuredAt && dto.measuredAt.getTime() > Date.now() + 5 * 60_000) throw fail(422, 'VALIDATION', 'Time is in the future', { fieldErrors: { measuredAt: 'Future' } });
    const createPayloadHash = hashPayload({ ...dto, measuredAt: dto.measuredAt?.toISOString() ?? null });
    const prior = await BodyMeasurement.findOne({ ownerId, clientMeasurementId: dto.clientMeasurementId }).lean();
    if (prior) {
      if (prior.createPayloadHash !== createPayloadHash) throw fail(409, 'OPERATION_REUSED', 'clientMeasurementId already used with a different payload');
      return view(prior);
    }
    const doc = { _id: randomUUID(), ownerId, clientMeasurementId: dto.clientMeasurementId, createPayloadHash, massGrams: dto.massGrams, source: dto.source, context: dto.context, ...timeFields(dto.measuredAt, dto.timezone, dto.localDate) };
    try {
      await BodyMeasurement.create(doc);
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      return this.create(req, body); // concurrent duplicate: resolves to the stored copy or a 409
    }
    return view((await BodyMeasurement.findById(doc._id).lean())!);
  }

  @Get()
  async list(@Req() req: Request, @Query() q: Record<string, string>) {
    const f: Record<string, unknown> = { ownerId: req.user!.id, deletedAt: null };
    if (q.from || q.to) f.localDate = { ...(q.from && { $gte: String(q.from) }), ...(q.to && { $lte: String(q.to) }) };
    if (q.before) f.createdAt = { $lt: new Date(String(q.before)) };
    const limit = Math.min(200, Number(q.limit) || 100);
    const docs = await BodyMeasurement.find(f).sort({ localDate: -1, measuredAt: -1, createdAt: -1 }).limit(limit).lean();
    return { items: docs.map(view) };
  }

  @Patch(':id')
  async patch(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(PatchDto, body);
    const d = await BodyMeasurement.findOne({ _id: id, ownerId: req.user!.id, deletedAt: null }).lean();
    if (!d) throw fail(404, 'NOT_FOUND', 'Measurement not found');
    if (d.revision !== dto.expectedRevision) throw fail(409, 'REVISION_CONFLICT', 'Changed elsewhere', { measurement: view(d) });
    const previous = { massGrams: d.massGrams, measuredAt: d.measuredAt, localDate: d.localDate, timezone: d.timezone, utcOffsetMinutes: d.utcOffsetMinutes, datePrecision: d.datePrecision, context: d.context };
    const $set: Record<string, unknown> = {};
    if (dto.massGrams) $set.massGrams = dto.massGrams;
    if (dto.context) $set.context = dto.context;
    if (dto.measuredAt || dto.timezone) Object.assign($set, timeFields(dto.measuredAt ?? d.measuredAt ?? null, dto.timezone ?? d.timezone, d.localDate));
    const r = await BodyMeasurement.findOneAndUpdate({ _id: id, ownerId: req.user!.id, revision: d.revision }, { $set, $inc: { revision: 1 }, $push: { corrections: { at: new Date(), reason: dto.reason, previous } } }, { returnDocument: 'after' }).lean();
    if (!r) throw fail(409, 'REVISION_CONFLICT', 'Changed elsewhere');
    return view(r);
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(DeleteDto, body);
    const r = await BodyMeasurement.findOneAndUpdate(
      { _id: id, ownerId: req.user!.id, deletedAt: null, revision: dto.expectedRevision },
      { $set: { deletedAt: new Date() }, $inc: { revision: 1 }, $push: { corrections: { at: new Date(), reason: dto.reason, previous: { deleted: false } } } },
      { returnDocument: 'after' },
    ).lean();
    if (!r) throw fail(409, 'REVISION_CONFLICT', 'Not found or changed elsewhere');
    return { ok: true };
  }
}
