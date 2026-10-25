import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { localToInstants, parseKgToGrams } from '@workout/contracts';
import { api, ApiError, fmtDuration, fmtTime, kg, outbox, useApi, useOutbox, type OutboxItem } from '../api';
import { Details, ErrorBox, Field, isLoaded, LOAD_LABEL, loadHint, Loading, rirText, targetText, Video } from '../ui';
import { useAuth } from '../main';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- server session snapshot
const useNow = (ms = 1000) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
};
/** Show not-yet-acknowledged set edits on top of the last acknowledged server state. */
function overlay(s: Any, pending: OutboxItem[]) {
  if (!s || !pending.length) return s;
  const d = structuredClone(s);
  for (const p of pending) {
    if (p.kind !== 'patch' || p.op.type !== 'setActual') continue;
    const set = d.exercises.find((o: Any) => o.id === p.op.exerciseOccurrenceId)?.sets.find((x: Any) => x.id === p.op.setId);
    if (set) Object.assign(set, { status: p.op.status, actualReps: p.op.actualReps, actualDurationSeconds: p.op.actualDurationSeconds, actualRir: p.op.actualRir, notes: p.op.notes, failedAttempt: p.op.failedAttempt, actualLoad: p.op.valueGrams == null ? set.actualLoad && { ...set.actualLoad, valueGrams: null } : { ...(set.actualLoad ?? {}), valueGrams: p.op.valueGrams }, _unsynced: true });
  }
  return d;
}
const activeSecs = (s: Any, now: number) => {
  const end = s.endedAt ? new Date(s.endedAt).getTime() : now;
  const paused = s.pauses.reduce((t: number, p: Any) => t + ((p.endedAt ? new Date(p.endedAt).getTime() : end) - new Date(p.startedAt).getTime()), 0);
  return Math.max(0, (end - new Date(s.startedAt).getTime() - paused) / 1000);
};

export default function Workout() {
  const { id = '' } = useParams();
  const ob = useOutbox();
  const [loadErr, setLoadErr] = useState<Error | null>(null);
  useEffect(() => {
    api('GET', `/sessions/${id}`).then((s) => { outbox.setSession(s); void outbox.flush(); }, setLoadErr);
  }, [id]);
  const pending = ob.queue.filter((q) => q.sessionId === id);
  const s = useMemo(() => overlay(ob.session?.id === id ? ob.session : null, pending), [ob.session, id, pending]);
  if (loadErr) return <ErrorBox error={loadErr} />;
  if (!s) return <Loading />;
  if (!s.isActive) return <Navigate to={`/history/${s.id}`} replace />;
  return <ActiveWorkout s={s} pendingCount={pending.length} />;
}

function ActiveWorkout({ s, pendingCount }: { s: Any; pendingCount: number }) {
  const ob = useOutbox();
  const now = useNow();
  const [finishing, setFinishing] = useState(false);
  const enqueue = (op: Record<string, unknown>) => outbox.enqueue({ sessionId: s.id, kind: 'patch', op });
  const paused = s.status === 'paused';
  const ctx = s.programContext;
  const optionalItems = s.planSnapshot.items.filter((i: Any) => i.optional && !s.exercises.some((o: Any) => o.planItemId === i.id));
  const status = ob.status === 'conflict' ? 'Conflict - review' : ob.status === 'offline' ? `Offline - pending sync (${pendingCount})` : ob.status === 'saving' || pendingCount ? 'Saving…' : 'Saved';

  return (
    <div className="stack workout">
      <header className="workout-head">
        <div>
          <h1>{s.planSnapshot.name}</h1>
          <p className="muted small">{paused ? 'Paused' : 'Active'} {fmtDuration(activeSecs(s, now))} · started {fmtTime(s.startedAt, s.timezone)}{s.source === 'manual_backfill' ? ' · manual entry' : ''}</p>
        </div>
        <span className={`save ${ob.status}`} role="status" aria-live="polite">{status}</span>
      </header>
      {ob.error && <p className="error small" role="alert">Not saved: {ob.error}</p>}
      {ob.conflict && <Conflict />}
      {ctx && <p className="card accent small">Week {ctx.programWeek} · {ctx.phaseName} · {ctx.workingSetCap ? `max ${ctx.workingSetCap} working set(s)` : 'listed sets'} · {rirText(ctx.rir)}</p>}
      <div className="row wrap">
        <button className="btn" onClick={() => outbox.enqueue({ sessionId: s.id, kind: paused ? 'resume' : 'pause', at: new Date().toISOString() })}>{paused ? 'Resume' : 'Pause'}</button>
        <button className="btn primary" onClick={() => setFinishing(true)}>Finish…</button>
      </div>
      {paused && <p className="card small">Paused. Your sets are saved; resume when ready.</p>}

      <Details summary={`Warm-up (${s.warmupChecklist.filter((w: Any) => w.completed).length}/${s.warmupChecklist.length})`} open={!s.warmupChecklist.some((w: Any) => w.completed)}>
        <ul className="checklist">
          {s.planSnapshot.warmup.steps.map((step: Any) => {
            const st = s.warmupChecklist.find((w: Any) => w.stepId === step.id);
            return (
              <li key={step.id}>
                <label className="check">
                  <input type="checkbox" checked={!!st?.completed} onChange={(e) => enqueue({ type: 'updateWarmup', stepId: step.id, completed: e.target.checked })} />
                  <span><strong>{step.label}</strong>{step.reps ? ` × ${step.reps}` : ''}{step.durationSeconds ? ` · ${Math.round(step.durationSeconds / 60)} min` : ''}<br /><span className="muted small">{step.notes}</span></span>
                </label>
              </li>
            );
          })}
        </ul>
        <p className="muted small">Warm-up steps never count as working sets. Log loaded ramp-up sets with “+ Warm-up set”.</p>
        <Video video={s.planSnapshot.videoDefinitions[s.planSnapshot.warmup.videoId]} label="General warm-up reference" />
      </Details>

      {s.exercises.map((occ: Any) => <ExerciseCard key={occ.id} s={s} occ={occ} enqueue={enqueue} />)}

      {optionalItems.length > 0 && (
        <section className="card stack">
          <h2>Optional work</h2>
          {ctx && !ctx.allowOptional ? <p className="muted small">Not part of this phase. It stays off until a later phase.</p> : optionalItems.map((i: Any) => (
            <button key={i.id} className="btn" onClick={() => enqueue({ type: 'addOptionalExercise', planItemId: i.id })}>+ Add optional: {s.planSnapshot.exerciseDefinitions[i.exerciseId].name}</button>
          ))}
        </section>
      )}
      <SessionNotes s={s} enqueue={enqueue} />
      <RestTimer s={s} now={now} enqueue={enqueue} />
      {finishing && <FinishDialog s={s} pendingCount={pendingCount} onClose={() => setFinishing(false)} />}
    </div>
  );
}

function Conflict() {
  const { conflict } = useOutbox();
  if (!conflict) return null;
  const op = conflict.item.kind === 'patch' ? conflict.item.op : { type: conflict.item.kind };
  return (
    <div className="card conflict stack" role="alert">
      <h2>Conflict - review</h2>
      <p className="small">This workout was changed elsewhere (another tab or device). Server version: revision {conflict.server?.revision}, last updated {conflict.server && new Date(conflict.server.updatedAt).toLocaleTimeString()}.</p>
      <p className="small">Your unsaved change: <code>{String(op.type)}</code>{op.actualReps != null ? ` · ${op.actualReps} reps` : ''}{op.valueGrams != null ? ` · ${kg(op.valueGrams as number)} kg` : ''}</p>
      <div className="row wrap">
        <button className="btn primary" onClick={() => outbox.resolve('reapply')}>Apply my change on top</button>
        <button className="btn" onClick={() => outbox.resolve('discard')}>Keep server version</button>
      </div>
    </div>
  );
}

function RestTimer({ s, now, enqueue }: { s: Any; now: number; enqueue: (op: Record<string, unknown>) => void }) {
  const alerted = useRef<string | null>(null);
  const t = s.restTimer;
  const left = t ? Math.ceil((new Date(t.endsAt).getTime() - now) / 1000) : 0;
  useEffect(() => {
    if (t && left <= 0 && alerted.current !== t.endsAt) {
      alerted.current = t.endsAt;
      try { if (localStorage.getItem('workout.restAlerts') === 'on') navigator.vibrate?.([200, 100, 200]); } catch { /* ignore */ }
    }
  }, [t, left]);
  if (!t || left < -30) return null;
  return (
    <div className="rest" role="timer" aria-live="off">
      <span className="rest-time">{left > 0 ? `Rest ${fmtDuration(left)}` : 'Rest over'}</span>
      {left > 0 && <button className="btn" onClick={() => enqueue({ type: 'updateRestTimer', action: 'start', durationSeconds: Math.min(1800, left + 30), exerciseOccurrenceId: t.exerciseOccurrenceId ?? undefined, roundIndex: t.roundIndex ?? undefined })}>+30s</button>}
      <button className="btn" onClick={() => enqueue({ type: 'updateRestTimer', action: 'clear' })}>{left > 0 ? 'Skip rest' : 'Dismiss'}</button>
    </div>
  );
}

function ExerciseCard({ s, occ, enqueue }: { s: Any; occ: Any; enqueue: (op: Record<string, unknown>) => void }) {
  const ex = occ.exerciseSnapshot;
  const p = occ.appliedPrescription;
  const loaded = isLoaded(occ.loadBasis);
  const [suggest, setSuggest] = useState<{ grams: number; n: number } | null>(null);
  const [substituting, setSub] = useState(false);
  const incline = occ.setup?.inclineSupportHeightMm;
  const prevQ = `/exercises/${occ.exerciseId}/previous?variantKey=${encodeURIComponent(occ.variantKey)}&loadBasis=${occ.loadBasis}&excludeSessionId=${s.id}${incline != null ? `&inclineSupportHeightMm=${incline}` : ''}`;
  const prev = useApi(prevQ).data?.previous;
  const rounds = (type: string) => [...new Set(occ.sets.filter((x: Any) => x.type === type).map((x: Any) => x.roundIndex))] as number[];
  const lastPending = (type: string) => rounds(type).filter((r) => occ.sets.filter((x: Any) => x.type === type && x.roundIndex === r).every((x: Any) => x.status === 'pending')).pop();
  const prevLoad = prev?.sets.find((x: Any) => x.actualLoad?.valueGrams != null)?.actualLoad?.valueGrams;

  return (
    <section className={`card stack exercise${occ.skipped ? ' skipped' : ''}`} aria-labelledby={`ex-${occ.id}`}>
      <h2 id={`ex-${occ.id}`}>{ex.name}{occ.optional && <span className="tag">optional</span>}{occ.skipped && <span className="tag">skipped</span>}</h2>
      {occ.originalExerciseSnapshot && <p className="small">Substituted for {occ.originalExerciseSnapshot.name}</p>}
      <p className="target">
        Target {p.workingSets} × {targetText(p.target)}{p.rir ? ` · ${rirText(p.rir)}` : ''} · rest {p.restSeconds}s
        {occ.originalPrescription.workingSets !== p.workingSets && <span className="muted small"> (phase cap; plan lists {occ.originalPrescription.workingSets})</span>}
      </p>
      {occ.originalPrescription.notes && <p className="small">{occ.originalPrescription.notes}</p>}
      <p className="muted small"><strong>{LOAD_LABEL[occ.loadBasis]}</strong> — {loadHint(occ.loadBasis, occ.implementCount)} Variant: {occ.variantKey}{incline != null ? ` · support ${incline} mm` : ''}</p>
      {prev ? (
        <div className="prev small">
          <span>Last time ({prev.localDate}): {prev.sets.map((x: Any) => `${x.side !== 'both' ? x.side[0].toUpperCase() + ' ' : ''}${x.actualReps ?? x.actualDurationSeconds + 's'}${x.actualLoad?.valueGrams != null ? ` × ${kg(x.actualLoad.valueGrams)} kg` : ''}`).join(', ')}</span>
          {loaded && prevLoad != null && <button className="btn small-btn" onClick={() => setSuggest({ grams: prevLoad, n: Date.now() })}>Use {kg(prevLoad)} kg as suggestion</button>}
        </div>
      ) : <p className="muted small">No previous comparable result.</p>}

      <div className="sets">
        {occ.sets.map((set: Any) => <SetRow key={set.id} occ={occ} set={set} enqueue={enqueue} suggest={suggest} />)}
      </div>
      <div className="row wrap">
        <button className="btn small-btn" onClick={() => enqueue({ type: 'addSet', exerciseOccurrenceId: occ.id, setType: 'working' })}>+ Set</button>
        <button className="btn small-btn" onClick={() => enqueue({ type: 'addSet', exerciseOccurrenceId: occ.id, setType: 'warmup' })}>+ Warm-up set</button>
        {lastPending('working') != null && <button className="btn small-btn" onClick={() => enqueue({ type: 'removePendingSet', exerciseOccurrenceId: occ.id, setType: 'working', roundIndex: lastPending('working') })}>− Remove last pending set</button>}
        <button className="btn small-btn" onClick={() => {
          if (occ.skipped) return enqueue({ type: 'skipExercise', exerciseOccurrenceId: occ.id, skipped: false, reason: null });
          const reason = prompt('Skip this exercise? Optional reason:');
          if (reason !== null) enqueue({ type: 'skipExercise', exerciseOccurrenceId: occ.id, skipped: true, reason: reason || null });
        }}>{occ.skipped ? 'Unskip' : 'Skip exercise'}</button>
        {occ.sets.every((x: Any) => x.status === 'pending') && <button className="btn small-btn" onClick={() => setSub(!substituting)}>Substitute</button>}
      </div>
      {substituting && <Substitute occ={occ} onPick={(exerciseId) => { enqueue({ type: 'substituteExercise', exerciseOccurrenceId: occ.id, exerciseId }); setSub(false); }} />}
      <Details summary="Technique, setup and load mode">
        <Setup occ={occ} enqueue={enqueue} />
      </Details>
      <Details summary="Cues and video">
        <ul>{ex.cues.map((c: string) => <li key={c}>{c}</li>)}</ul>
        <p className="small"><strong>Easier option:</strong> {ex.regression}</p>
        <Video video={ex.video} />
      </Details>
    </section>
  );
}

function SetRow({ occ, set, enqueue, suggest }: { occ: Any; set: Any; enqueue: (op: Record<string, unknown>) => void; suggest: { grams: number; n: number } | null }) {
  const metric = set.target.metric;
  const loaded = isLoaded(occ.loadBasis);
  const ref = useRef<HTMLDivElement>(null);
  const fromSet = () => ({ reps: set.actualReps?.toString() ?? '', secs: set.actualDurationSeconds?.toString() ?? '', kg: kg(set.actualLoad?.valueGrams), rir: set.actualRir?.toString() ?? '', notes: set.notes ?? '', failed: !!set.failedAttempt });
  const [d, setD] = useState(fromSet);
  const [err, setErr] = useState('');
  // Adopt server values unless the user is typing in this row.
  useEffect(() => { if (!ref.current?.contains(document.activeElement)) setD(fromSet()); }, [set.actualReps, set.actualDurationSeconds, set.actualLoad?.valueGrams, set.actualRir, set.notes, set.status]);
  useEffect(() => { if (suggest && set.status === 'pending' && !d.kg) setD((x) => ({ ...x, kg: kg(suggest.grams) })); }, [suggest?.n]);

  function build(status: string) {
    const reps = d.reps === '' ? null : Number(d.reps);
    const secs = d.secs === '' ? null : Number(d.secs);
    const grams = loaded && d.kg !== '' ? parseKgToGrams(d.kg) : null;
    if (loaded && d.kg !== '' && grams == null) return setErr('Weight like 10 or 12.5'), null;
    if ((reps != null && (!Number.isInteger(reps) || reps < 0 || reps > 1000)) || (secs != null && (!Number.isInteger(secs) || secs < 0 || secs > 86400))) return setErr('Whole numbers only'), null;
    if (status === 'done') {
      if (metric === 'reps' && !(reps! > 0) && !(d.failed && reps === 0)) return setErr('Enter reps (0 only as a failed attempt)'), null;
      if (metric === 'duration' && !(secs! > 0)) return setErr('Enter seconds held'), null;
      if (loaded && grams == null) return setErr('Enter the weight'), null;
    }
    setErr('');
    return { type: 'setActual', exerciseOccurrenceId: occ.id, setId: set.id, status, actualReps: metric === 'reps' ? reps : null, actualDurationSeconds: metric === 'duration' ? secs : null, valueGrams: grams, actualRir: d.rir === '' ? null : Number(d.rir), failedAttempt: d.failed, notes: d.notes.trim() || null };
  }
  const save = (status = set.status) => { const op = build(status); if (op) enqueue(op); };
  const onBlur = () => setTimeout(() => {
    if (ref.current?.contains(document.activeElement)) return;
    const same = JSON.stringify(d) === JSON.stringify(fromSet());
    if (!same) save();
  }, 0);
  const done = set.status === 'done';
  const label = `${set.type === 'warmup' ? 'W' : 'Set '}${set.roundIndex}${set.side !== 'both' ? ` ${set.side === 'left' ? 'L' : 'R'}` : ''}`;
  const tgt = `${set.target.min === set.target.max ? set.target.min : `${set.target.min}–${set.target.max}`}`;

  return (
    <div ref={ref} className={`set ${set.status} ${set.type}`} onBlur={onBlur}>
      <span className="set-label">{label}<span className="muted small"> {set.type === 'warmup' ? 'warm-up' : `target ${tgt}`}</span></span>
      {metric === 'reps' ? (
        <label className="mini"><span>Reps</span><input inputMode="numeric" pattern="[0-9]*" value={d.reps} onChange={(e) => setD({ ...d, reps: e.target.value })} placeholder={tgt} aria-label={`${label} reps`} /></label>
      ) : (
        <label className="mini"><span>Seconds</span><input inputMode="numeric" pattern="[0-9]*" value={d.secs} onChange={(e) => setD({ ...d, secs: e.target.value })} placeholder={tgt} aria-label={`${label} seconds`} /></label>
      )}
      {loaded ? (
        <label className="mini"><span>{occ.loadBasis === 'per_dumbbell' && occ.implementCount === 2 ? 'kg each' : 'kg'}</span><input inputMode="decimal" value={d.kg} onChange={(e) => setD({ ...d, kg: e.target.value })} aria-label={`${label} ${LOAD_LABEL[occ.loadBasis]}`} /></label>
      ) : <span className="mini muted small">{occ.loadBasis === 'bodyweight' ? 'bodyweight' : '—'}</span>}
      <button className={`btn done-btn${done ? ' is-done' : ''}`} aria-pressed={done} onClick={() => save(done ? 'pending' : 'done')}>{done ? '✓ Done' : set.status === 'skipped' ? 'Skipped' : 'Done'}</button>
      {set._unsynced && <span className="muted small unsynced">unsynced</span>}
      <details className="set-more">
        <summary>More</summary>
        <div className="row wrap">
          <Field label="RIR" hint="How many more good reps you could have done. Blank = not recorded.">
            <select value={d.rir} onChange={(e) => setD({ ...d, rir: e.target.value })}><option value="">—</option>{Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>{i}</option>)}</select>
          </Field>
          <Field label="Set note"><input value={d.notes} maxLength={1000} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
          {metric === 'reps' && <label className="check"><input type="checkbox" checked={d.failed} onChange={(e) => setD({ ...d, failed: e.target.checked })} /> Failed attempt (0 reps)</label>}
          <button className="btn small-btn" onClick={() => save(set.status === 'skipped' ? 'pending' : 'skipped')}>{set.status === 'skipped' ? 'Unskip set' : 'Skip set'}</button>
        </div>
      </details>
      {err && <p className="error small set-err" role="alert">{err}</p>}
    </div>
  );
}

function Setup({ occ, enqueue }: { occ: Any; enqueue: (op: Record<string, unknown>) => void }) {
  const [variant, setVariant] = useState(occ.variantKey);
  const [setup, setSetup] = useState({ inclineSupportHeightMm: occ.setup?.inclineSupportHeightMm?.toString() ?? '', supportDescription: occ.setup?.supportDescription ?? '', notes: occ.setup?.notes ?? '' });
  const saveSetup = () => enqueue({ type: 'updateExercise', exerciseOccurrenceId: occ.id, variantKey: variant.trim() || occ.variantKey, setup: { inclineSupportHeightMm: setup.inclineSupportHeightMm === '' ? null : Math.round(Number(setup.inclineSupportHeightMm)) || null, supportDescription: setup.supportDescription || null, benchAngleDegrees: occ.setup?.benchAngleDegrees ?? null, notes: setup.notes || null } });
  return (
    <div className="stack">
      <Field label="Technique variant" hint="Changes which previous results count as comparable."><input value={variant} onChange={(e) => setVariant(e.target.value)} onBlur={saveSetup} /></Field>
      {occ.exerciseId.includes('incline') && (
        <Field label="Support height (mm)" hint="Height of the bench/box your hands are on."><input inputMode="numeric" value={setup.inclineSupportHeightMm} onChange={(e) => setSetup({ ...setup, inclineSupportHeightMm: e.target.value })} onBlur={saveSetup} /></Field>
      )}
      <Field label="Support / setup"><input value={setup.supportDescription} onChange={(e) => setSetup({ ...setup, supportDescription: e.target.value })} onBlur={saveSetup} /></Field>
      <Field label="Setup notes"><input value={setup.notes} onChange={(e) => setSetup({ ...setup, notes: e.target.value })} onBlur={saveSetup} /></Field>
      <Field label="Load mode" hint="Changing to/from bodyweight is always explicit.">
        <select value={`${occ.loadBasis}:${occ.implementCount}`} onChange={(e) => { const [basis, n] = e.target.value.split(':'); enqueue({ type: 'updateExercise', exerciseOccurrenceId: occ.id, loadBasis: basis, implementCount: Number(n) }); }}>
          <option value="per_dumbbell:2">Two dumbbells (kg each)</option>
          <option value="per_dumbbell:1">One dumbbell, one arm (kg)</option>
          <option value="single_dumbbell:1">One dumbbell held in both hands (kg)</option>
          <option value="barbell_total:1">Barbell (total incl. bar)</option>
          <option value="external_total:1">Other external load (total)</option>
          <option value="bodyweight:0">Bodyweight</option>
          <option value="none:0">No load</option>
        </select>
      </Field>
    </div>
  );
}

function Substitute({ occ, onPick }: { occ: Any; onPick: (id: string) => void }) {
  const { data } = useApi<Any[]>('/exercises');
  const options = (data ?? []).filter((e) => e.metric === occ.appliedPrescription.target.metric && e.id !== occ.exerciseId);
  return (
    <Field label="Replace with" hint="The original prescription is kept with this workout.">
      <select defaultValue="" onChange={(e) => e.target.value && onPick(e.target.value)}>
        <option value="">Choose an exercise…</option>
        {options.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
    </Field>
  );
}

function SessionNotes({ s, enqueue }: { s: Any; enqueue: (op: Record<string, unknown>) => void }) {
  const m = s.metadata ?? {};
  const [v, setV] = useState({ energy: m.energy ?? '', soreness: m.soreness ?? '', sleepMinutes: m.sleepMinutes ?? '', sessionRpe: m.sessionRpe ?? '', notes: m.notes ?? '' });
  const num = (x: string | number) => (x === '' ? null : Number(x));
  const range = (n: number, from = 0) => Array.from({ length: n - from + 1 }, (_, i) => i + from);
  return (
    <Details summary="Session notes (optional)">
      <div className="row wrap">
        <Field label="Energy 1–5"><select value={v.energy} onChange={(e) => setV({ ...v, energy: e.target.value })}><option value="">—</option>{range(5, 1).map((i) => <option key={i}>{i}</option>)}</select></Field>
        <Field label="Soreness 0–10"><select value={v.soreness} onChange={(e) => setV({ ...v, soreness: e.target.value })}><option value="">—</option>{range(10).map((i) => <option key={i}>{i}</option>)}</select></Field>
        <Field label="Overall effort 0–10"><select value={v.sessionRpe} onChange={(e) => setV({ ...v, sessionRpe: e.target.value })}><option value="">—</option>{range(10).map((i) => <option key={i}>{i}</option>)}</select></Field>
        <Field label="Sleep (minutes)"><input inputMode="numeric" value={v.sleepMinutes} onChange={(e) => setV({ ...v, sleepMinutes: e.target.value })} /></Field>
      </div>
      <Field label="Notes"><textarea value={v.notes} maxLength={4000} rows={3} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      <button className="btn" onClick={() => enqueue({ type: 'updateSessionNotes', metadata: { energy: num(v.energy), soreness: num(v.soreness), sleepMinutes: num(v.sleepMinutes), sessionRpe: num(v.sessionRpe), notes: v.notes.trim() || null } })}>Save notes</button>
    </Details>
  );
}

function FinishDialog({ s, pendingCount, onClose }: { s: Any; pendingCount: number; onClose: () => void }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const [err, setErr] = useState('');
  const work = s.exercises.flatMap((o: Any) => o.sets.filter((x: Any) => x.type === 'working').map((x: Any) => ({ ...x, occ: o })));
  const required = work.filter((x: Any) => !x.occ.optional);
  const doneN = required.filter((x: Any) => x.status === 'done').length;
  const missing = work.filter((x: Any) => x.status !== 'done');
  const lastDone = work.map((x: Any) => x.completedAt).filter(Boolean).sort().pop();
  const longAgo = Date.now() - new Date(s.startedAt).getTime() > 3 * 3600 * 1000;
  const toLocal = (iso: string) => { const d = new Date(iso); const p = new Intl.DateTimeFormat('sv-SE', { timeZone: s.timezone, dateStyle: 'short', timeStyle: 'short' }).format(d); return p.replace(' ', 'T'); };
  const [end, setEnd] = useState(longAgo && lastDone ? toLocal(lastDone) : '');
  async function finish(outcome: 'finish' | 'abandon') {
    setErr('');
    let endedAt: string | undefined;
    if (end) {
      const c = localToInstants(end, s.timezone);
      if (!c.length) return setErr('That local time does not exist');
      endedAt = c[c.length - 1].toISOString();
    }
    try {
      const r = await api('POST', `/sessions/${s.id}/finish`, { operationId: crypto.randomUUID(), expectedRevision: s.revision, outcome, endedAt });
      outbox.setSession(r.session);
      nav(`/history/${s.id}`);
    } catch (e) {
      setErr(e instanceof ApiError && e.body.code === 'REVISION_CONFLICT' ? 'The workout changed meanwhile; review and try again.' : (e as Error).message);
    }
  }
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="finish-title">
      <div className="card dialog stack">
        <h2 id="finish-title">Finish workout</h2>
        <p>{doneN} of {required.length} required working sets done{doneN === required.length && required.length ? ' — complete' : ' — will be saved as partial'}.</p>
        {missing.length > 0 && (
          <Details summary={`${missing.length} set(s) not done`}>
            <ul className="small">{missing.map((x: Any) => <li key={x.id}>{x.occ.exerciseSnapshot.name} set {x.roundIndex}{x.side !== 'both' ? ` ${x.side}` : ''}: {x.occ.skipped ? 'exercise skipped' : x.status}</li>)}</ul>
          </Details>
        )}
        {longAgo && <p className="small">Started a while ago. If you forgot to finish, set the real end time so the night is not counted as training.</p>}
        <Field label={`Finish time (${s.timezone})`} hint="Leave blank for now."><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        {pendingCount > 0 && <p className="error small">Waiting for {pendingCount} change(s) to sync before finishing.</p>}
        <ErrorBox error={err} />
        <div className="row wrap">
          <button className="btn primary" disabled={pendingCount > 0} onClick={() => finish('finish')}>Finish</button>
          <button className="btn" disabled={pendingCount > 0} onClick={() => confirm('Abandon this workout? It stays in history but does not count as a training day.') && finish('abandon')}>Abandon</button>
          <button className="btn ghost" onClick={onClose}>Keep going</button>
        </div>
        <p className="muted small">Times shown in {user.timezone}.</p>
      </div>
    </div>
  );
}
