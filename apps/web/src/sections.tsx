import { useEffect, useState } from 'react';
import { parseKgToGrams } from '@workout/contracts';
import { fmtDuration, kg } from './api';
import { Details, isLoaded, LOAD_LABEL, Video } from './ui';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- server snapshots
export type Section = 'warmup' | 'workout' | 'cooldown';
export const SECTION_LABEL: Record<Section, string> = { warmup: 'Warm-up', workout: 'Workout', cooldown: 'Cooldown' };
const ROLE_LABEL: Record<string, string> = { pulse_raise: 'Pulse raiser', mobility: 'Mobility', rehearsal: 'Light rehearsal - not a work set.', easy_movement: 'Easy movement', stretch: 'Stretch' };

/** "8–12 reps per side", "20–40 total reps (both sides)", "20–30 s per side". */
export function dosage(target: { metric: string; min: number; max: number; perSide: boolean }, repsMeaning?: string) {
  const n = target.min === target.max ? `${target.min}` : `${target.min}–${target.max}`;
  if (target.metric === 'duration') return `${n} s${target.perSide ? ' per side' : ''}`;
  if (repsMeaning === 'alternating_total') return `${n} total reps (both sides)`;
  return `${n} reps${target.perSide ? ' per side' : ''}`;
}

/** done = every planned side/set record done; skipped = all skipped; anything else is mixed or open. */
export function activityState(a: { sets: { status: string }[] }) {
  const st = a.sets.map((x) => x.status);
  if (st.every((x) => x === 'done')) return 'done';
  if (st.every((x) => x === 'skipped')) return 'skipped';
  if (st.every((x) => x !== 'pending')) return 'mixed';
  return st.some((x) => x !== 'pending') ? 'started' : 'pending';
}
export function sectionCounts(list: Any[]) {
  const states = list.map(activityState);
  return { total: list.length, done: states.filter((x) => x === 'done').length, skipped: states.filter((x) => x === 'skipped').length, open: states.filter((x) => x === 'pending' || x === 'started').length };
}
export function sectionSummaryText(name: string, list: Any[] | undefined) {
  if (!list) return `${name}: not recorded in this workout format`;
  const c = sectionCounts(list);
  if (c.total && c.skipped === c.total) return `${name} skipped`;
  if (c.total && list.every((a) => activityState(a) === 'pending')) return `${name}: not started`;
  return `${name}: ${c.done}/${c.total} done${c.skipped ? `, ${c.skipped} skipped` : ''}${c.total - c.done - c.skipped - c.open ? `, ${c.total - c.done - c.skipped - c.open} partly skipped` : ''}`;
}

/** Plan-detail card for a structured warm-up/cooldown step (read-only). */
export function StepCard({ step, exercise, video }: { step: Any; exercise: Any; video: Any }) {
  return (
    <section className="card stack">
      <h3>{exercise.name}</h3>
      <p className="small muted">{ROLE_LABEL[step.role]}</p>
      <p className="target">{step.sets} × {dosage(step.target, exercise.repsMeaning)}{step.restSeconds ? ` · rest ${step.restSeconds}s` : ''}</p>
      <p className="small">{step.notes}</p>
      <Details summary="Cues and video">
        <ul>{exercise.cues.map((c: string) => <li key={c}>{c}</li>)}</ul>
        <Video video={video} />
      </Details>
    </section>
  );
}

/** Active-workout card: quick Done/Skip per side or set, optional measured logging, optional countdown. */
export function ActivityCard({ activity: a, enqueue }: { activity: Any; enqueue: (op: Record<string, unknown>) => void }) {
  const ex = a.exerciseSnapshot, p = a.prescriptionSnapshot;
  const rounds = [...new Set(a.sets.map((x: Any) => x.roundIndex))] as number[];
  const base = { section: a.section, activityId: a.id };
  const state = activityState(a);
  return (
    <section className={`card stack exercise activity ${state}`} aria-labelledby={`act-${a.id}`}>
      <h2 id={`act-${a.id}`}>{ex.name} <span className="tag">{state === 'done' ? '✓ done' : state === 'skipped' ? 'skipped' : state === 'mixed' ? 'done/skipped' : 'to do'}</span></h2>
      <p className="small muted">{ROLE_LABEL[p.role]}</p>
      <p className="target">{p.sets} × {dosage(p.target, ex.repsMeaning)}</p>
      <p className="small">{p.notes}</p>
      {rounds.map((r) => {
        const sets = a.sets.filter((x: Any) => x.roundIndex === r);
        const pending = sets.filter((x: Any) => x.status === 'pending');
        return (
          <div key={r} className="stack">
            {sets.map((set: Any) => <ActivitySetRow key={set.id} a={a} set={set} label={`${p.sets > 1 ? `Set ${r}` : ''}${set.side !== 'both' ? ` ${set.side === 'left' ? 'Left' : 'Right'}` : ''}`.trim() || 'Activity'} enqueue={enqueue} />)}
            {sets.length === 2 && pending.length === 2 && (
              <button className="btn small-btn" onClick={() => enqueue({ type: 'acknowledgeSectionSet', ...base, setIds: sets.map((x: Any) => x.id) })}>Mark both sides done</button>
            )}
          </div>
        );
      })}
      <Details summary="Cues and video">
        <ul>{ex.cues.map((c: string) => <li key={c}>{c}</li>)}</ul>
        <p className="small"><strong>Easier option:</strong> {ex.regression}</p>
        <Video video={a.videoSnapshot} />
      </Details>
    </section>
  );
}

function ActivitySetRow({ a, set, label, enqueue }: { a: Any; set: Any; label: string; enqueue: (op: Record<string, unknown>) => void }) {
  const metric = a.prescriptionSnapshot.target.metric;
  const loaded = isLoaded(a.loadBasis);
  const base = { section: a.section, activityId: a.id };
  const [logging, setLogging] = useState(false);
  const [v, setV] = useState({ n: '', kg: '' });
  const [err, setErr] = useState('');
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [endsAt]);
  const left = endsAt ? Math.ceil((endsAt - now) / 1000) : null;
  function saveMeasured() {
    const n = Number(v.n);
    if (!Number.isInteger(n) || n <= 0) return setErr(metric === 'duration' ? 'Enter seconds' : 'Enter reps');
    const grams = loaded && v.kg ? parseKgToGrams(v.kg) : null;
    if (loaded && v.kg && grams == null) return setErr('Weight like 10 or 12.5');
    setErr('');
    setLogging(false);
    enqueue({ type: 'setSectionActual', ...base, setId: set.id, actualReps: metric === 'reps' ? n : null, actualDurationSeconds: metric === 'duration' ? n : null, valueGrams: grams });
  }
  const result = set.status === 'done'
    ? set.completionMode === 'measured' ? `✓ ${set.actualReps ?? `${set.actualDurationSeconds} s`}${set.actualLoad?.valueGrams != null ? ` × ${kg(set.actualLoad.valueGrams)} kg` : ''}` : '✓ Done'
    : set.status === 'skipped' ? 'Skipped' : null;
  return (
    <div className={`set ${set.status} activity-set`}>
      <span className="set-label">{label}{result && <span className={set.status === 'done' ? 'done-text' : 'muted'}> · {result}</span>}{set._unsynced && <span className="muted small"> · unsynced</span>}</span>
      {set.status === 'pending' ? (
        <div className="row wrap set-actions">
          <button className="btn done-btn" onClick={() => enqueue({ type: 'acknowledgeSectionSet', ...base, setIds: [set.id] })}>Done</button>
          <button className="btn small-btn" onClick={() => enqueue({ type: 'skipSectionSet', ...base, setIds: [set.id], reason: null })}>Skip</button>
          <button className="btn small-btn" aria-expanded={logging} onClick={() => setLogging(!logging)}>Log actual</button>
          {metric === 'duration' && (
            left != null && left > 0
              ? <button className="btn small-btn" onClick={() => setEndsAt(null)} aria-live="off">{fmtDuration(left)} · stop</button>
              : <button className="btn small-btn" onClick={() => setEndsAt(Date.now() + a.prescriptionSnapshot.target.max * 1000)}>{left != null ? "Time's up · restart" : `Start ${a.prescriptionSnapshot.target.max}s countdown`}</button>
          )}
        </div>
      ) : (
        <div className="row wrap set-actions">
          <button className="btn small-btn" onClick={() => enqueue({ type: 'resetSectionSet', ...base, setIds: [set.id] })}>Undo</button>
        </div>
      )}
      {logging && set.status === 'pending' && (
        <div className="row wrap set-actions">
          <label className="mini"><span>{metric === 'duration' ? 'Seconds' : a.exerciseSnapshot.repsMeaning === 'alternating_total' ? 'Total reps' : 'Reps'}</span><input inputMode="numeric" value={v.n} onChange={(e) => setV({ ...v, n: e.target.value })} aria-label={`${a.exerciseSnapshot.name} ${label} ${metric === 'duration' ? 'seconds' : 'reps'}`} /></label>
          {loaded && <label className="mini"><span>{LOAD_LABEL[a.loadBasis]}</span><input inputMode="decimal" value={v.kg} onChange={(e) => setV({ ...v, kg: e.target.value })} /></label>}
          <button className="btn small-btn align-end" onClick={saveMeasured}>Save</button>
        </div>
      )}
      {err && <p className="error small set-err" role="alert">{err}</p>}
    </div>
  );
}
