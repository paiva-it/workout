/**
 * Operator CLI (runs inside the app container). Secrets are read from stdin only — never argv/env.
 *   node dist/cli.js import-pack <file.json>
 *   node dist/cli.js bootstrap-user   < bootstrap.env      (BOOTSTRAP_USERNAME=/BOOTSTRAP_PASSWORD= lines)
 *   node dist/cli.js import-profile   < profile.private.json
 *   node dist/cli.js reset-password <username>   (prompts without echo, or reads one line from stdin)
 *   node dist/cli.js migrate-program-selections <catalog-migration.json>   (after activating the pack it describes)
 *   node dist/cli.js activate-pack <packId> <version>   (rollback/roll-forward of the active pointer; stored packs only)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { BodyMeasurement, User, connectDb } from './db.js';
import { bootstrapUser, resetPassword } from './auth.js';
import { activateStoredPack, activeCatalog, getCatalogState, importPack, validatePack } from './catalog.js';
import { isFixedProgram } from '@workout/contracts';
import { hashPayload } from './common.js';

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
async function secretLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return (await stdin()).replace(/\r?\n$/, '');
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  let s = '';
  for await (const c of process.stdin) {
    const ch = (c as Buffer).toString('utf8');
    if (ch === '\r' || ch === '\n') break;
    if (ch === '\u0003') process.exit(130);
    s = ch === '\u007f' ? s.slice(0, -1) : s + ch;
  }
  process.stdin.setRawMode(false);
  process.stderr.write('\n');
  return s;
}
const envValue = (text: string, key: string) => {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(key + '='));
  if (!line) return null;
  let v = line.slice(key.length + 1);
  if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
  return v;
};
// Deterministic UUID-shaped id from an import key, so profile re-imports are idempotent.
const keyUuid = (k: string) => { const h = createHash('sha256').update(k).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

const [cmd, arg] = process.argv.slice(2);
await connectDb();
try {
  if (cmd === 'import-pack') {
    const { pack, errors } = validatePack(JSON.parse(readFileSync(arg, 'utf8')));
    if (!pack) throw new Error('Invalid pack:\n' + errors.join('\n'));
    const r = await importPack(pack, 'cli', (await getCatalogState()).revision);
    console.log(`import ${r.packId}@${r.version}: ${r.status}${r.activated ? ', activated' : ', already active'} (catalog revision ${r.catalogRevision})`);
  } else if (cmd === 'bootstrap-user') {
    const text = await stdin();
    const username = envValue(text, 'BOOTSTRAP_USERNAME'), password = envValue(text, 'BOOTSTRAP_PASSWORD');
    if (!username || !password) throw new Error('stdin must contain BOOTSTRAP_USERNAME= and BOOTSTRAP_PASSWORD= lines');
    const r = await bootstrapUser(username, password);
    console.log(r.created ? 'user created' : 'user already exists; unchanged');
  } else if (cmd === 'import-profile') {
    const p = JSON.parse(await stdin());
    const u = await User.findOne({ username: String(p.username).toLowerCase() }).lean();
    if (!u) throw new Error('user not found; run bootstrap-user first');
    if (u.profileImportKeys.includes(p.profileImportKey)) {
      console.log('profile already imported; unchanged');
    } else {
      // Remembered results stay notes (useForProgramming:false), never sessions. Health context stays private on the user.
      await User.updateOne({ _id: u._id }, {
        $set: { displayName: p.displayName ?? u.displayName, timezone: p.timezone ?? u.timezone, equipment: p.background?.equipmentConfirmed ?? u.equipment,
          profile: { ...(u.profile as object), ageYearsAtReport: p.ageYearsAtReport ?? null, reportedOn: p.reportedOn ?? null, background: p.background ?? null, historicalSelfReports: p.historicalSelfReports ?? [], healthContext: p.healthContextNotForPublicRepo ?? null },
          'program.programId': u.program?.programId ?? p.defaultProgramId ?? null },
        $addToSet: { profileImportKeys: p.profileImportKey }, $inc: { revision: 1 },
      });
      const bm = p.reportedBodyMass;
      if (bm?.massGrams) {
        const key = `${p.profileImportKey}:bodyMass`;
        const doc = { massGrams: bm.massGrams, measuredAt: null, datePrecision: 'day', localDate: bm.reportedDate, timezone: p.timezone ?? 'Europe/Lisbon', utcOffsetMinutes: null, source: 'self_report', context: { timeOfDay: 'unknown', beforeFood: null, scaleLabel: null, notes: 'Imported self-report (not a scale weigh-in)' } };
        await BodyMeasurement.updateOne({ ownerId: u._id, profileImportKey: key }, { $setOnInsert: { _id: keyUuid(key), ownerId: u._id, clientMeasurementId: keyUuid(key), profileImportKey: key, createPayloadHash: hashPayload(doc), ...doc } }, { upsert: true });
      }
      console.log('profile imported');
    }
  } else if (cmd === 'reset-password') {
    const pw = await secretLine('New password: ');
    if (pw.length < 10) throw new Error('password must be at least 10 characters');
    console.log((await resetPassword(arg, pw)) ? 'password reset; all sessions revoked' : 'user not found');
  } else if (cmd === 'activate-pack') {
    const r = await activateStoredPack(arg, Number(process.argv[4]));
    await mongoose.connection.collection('maintenanceLog').insertOne({ action: 'activate-pack', at: new Date(), ...r } as never);
    console.log(`active packs: ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)} (catalog revision ${r.revision})`);
  } else if (cmd === 'migrate-program-selections') {
    // Narrow, idempotent: remap only selections of programs that left the active catalog, and clear held phases
    // that a fixed (single open-ended phase) program no longer has. Workout snapshots are never touched.
    const m = JSON.parse(readFileSync(arg, 'utf8'));
    const remap: Record<string, string> = m.programSelectionRemap ?? {};
    const programs = new Map((await activeCatalog()).programs.map((p) => [p.id, p]));
    for (const to of Object.values(remap)) if (!programs.has(to)) throw new Error(`target program ${to} is not active; import the pack first`);
    const changes = [];
    for (const u of await User.find({}, { program: 1 }).lean()) {
      const before = { programId: u.program?.programId ?? null, startDate: u.program?.startDate ?? null, heldPhaseIndex: u.program?.heldPhaseIndex ?? null };
      const after = { ...before };
      if (before.programId && remap[before.programId] && !programs.has(before.programId)) after.programId = remap[before.programId];
      const target = after.programId ? programs.get(after.programId) : undefined;
      if (target && isFixedProgram(target)) after.heldPhaseIndex = null;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      await User.updateOne({ _id: u._id, revision: (await User.findById(u._id, { revision: 1 }).lean())!.revision }, { $set: { program: after }, $inc: { revision: 1 } });
      changes.push({ userId: u._id, before, after });
    }
    await mongoose.connection.collection('maintenanceLog').insertOne({ migrationId: m.migrationId, at: new Date(), changes } as never);
    console.log(`${m.migrationId}: ${changes.length} selection(s) changed${changes.length ? ' (before/after recorded in maintenanceLog for rollback)' : ''}`);
  } else {
    throw new Error('usage: cli.js import-pack <file> | bootstrap-user | import-profile | reset-password <username> | migrate-program-selections <file> | activate-pack <packId> <version>');
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
