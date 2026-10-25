import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { parseKgToGrams } from '@workout/contracts';
import { api, fmtDate, fmtDuration, fmtTime, kg, useApi } from '../api';
import { ErrorBox, Field, isLoaded, LOAD_LABEL, Loading } from '../ui';
import { dosage, sectionSummaryText } from '../sections';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- server snapshots

export function History() {
  const [f, setF] = useState({ status: '', planId: '', exerciseId: '', from: '', to: '' });
  const [items, setItems] = useState<Any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const plans = useApi<Any[]>('/plans').data ?? [];
  const exercises = useApi<Any[]>('/exercises').data ?? [];
  const qs = (before?: string) => new URLSearchParams(Object.entries({ ...f, ...(before && { before }) }).filter(([, v]) => v)).toString();
  useEffect(() => {
    api('GET', `/sessions?${qs()}`).then((r) => { setItems(r.items); setCursor(r.nextCursor); }, (e) => setErr(e.message));
  }, [f]);
  const more = () => api('GET', `/sessions?${qs(cursor!)}`).then((r) => { setItems([...items, ...r.items]); setCursor(r.nextCursor); });
  const byDate = items.reduce((m: Record<string, Any[]>, s) => ((m[s.localDate] ??= []).push(s), m), {});
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="stack">
      <h1>History</h1>
      <div className="row wrap">
        <Field label="Status"><select value={f.status} onChange={set('status')}><option value="">All</option><option value="completed">Completed</option><option value="partial">Partial</option><option value="abandoned">Abandoned</option></select></Field>
        <Field label="Plan"><select value={f.planId} onChange={set('planId')}><option value="">All</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Exercise"><select value={f.exerciseId} onChange={set('exerciseId')}><option value="">All</option>{exercises.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="From"><input type="date" value={f.from} onChange={set('from')} /></Field>
        <Field label="To"><input type="date" value={f.to} onChange={set('to')} /></Field>
      </div>
      <ErrorBox error={err} />
      {!items.length && <p className="muted">No workouts match.</p>}
      {Object.entries(byDate).map(([date, list]) => (
        <section key={date} className="stack">
          <h2 className="date-head">{fmtDate(date)}</h2>
          {list.map((s) => (
            <Link key={s.id} to={`/history/${s.id}`} className="card block-link">
              <strong>{s.planName}</strong> <span className={`tag ${s.status}`}>{s.status}</span>{s.source === 'manual_backfill' && <span className="tag">manual</span>}
              <p className="muted small">{fmtTime(s.startedAt, s.timezone)} · {fmtDuration(s.activeSeconds)} active · {s.summary.done}/{s.summary.required} sets</p>
            </Link>
          ))}
        </section>
      ))}
      {cursor && <button className="btn" onClick={more}>Load more</button>}
    </div>
  );
}

export function HistoryDetail() {
  const { id } = useParams();
  const { data: s, error, loading, reload } = useApi<Any>(`/sessions/${id}`);
  const [editing, setEditing] = useState<string | null>(null);
  if (loading && !s) return <Loading />;
  if (error || !s) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <Link to="/history">← History</Link>
      <h1>{s.planSnapshot.name}</h1>
      <p>
        <span className={`tag ${s.status}`}>{s.status}</span> {fmtDate(s.localDate)} · {fmtTime(s.startedAt, s.timezone)}–{s.endedAt ? fmtTime(s.endedAt, s.timezone) : '…'} ({s.timezone})
      </p>
      <p className="muted small">Active {fmtDuration(s.activeSeconds)} · elapsed {fmtDuration(s.elapsedSeconds)}{s.pauses.length ? ` · ${s.pauses.length} pause(s)` : ''}{s.source === 'manual_backfill' ? ' · manual entry' : ''} · plan v{s.planRef.version}</p>
      {s.programContext && <p className="small">Week {s.programContext.programWeek} · {s.programContext.phaseName}</p>}
      {s.metadata?.notes && <p className="card small">{s.metadata.notes}</p>}
      <p className="small">{sectionSummaryText('Warm-up', s.sectionActivities?.warmup)} · {sectionSummaryText('Cooldown', s.sectionActivities?.cooldown)}</p>
      {s.sectionActivities ? <SectionHistory title="Warm-up" list={s.sectionActivities.warmup} /> : <LegacyWarmup s={s} />}
      <h2>Workout</h2>
      {s.exercises.map((o: Any) => (
        <section key={o.id} className="card stack">
          <h2>{o.exerciseSnapshot.name}{o.skipped && <span className="tag">skipped</span>}</h2>
          {o.originalExerciseSnapshot && <p className="small">Substituted for {o.originalExerciseSnapshot.name}</p>}
          <p className="muted small">{LOAD_LABEL[o.loadBasis]} · variant {o.variantKey}{o.setup?.inclineSupportHeightMm != null ? ` · support ${o.setup.inclineSupportHeightMm} mm` : ''}</p>
          <table className="sets-table">
            <thead><tr><th>Set</th><th>Status</th><th>Actual</th><th>RIR</th><th></th></tr></thead>
            <tbody>
              {o.sets.map((x: Any) => (
                <tr key={x.id}>
                  <td>{x.type === 'warmup' ? 'W' : ''}{x.roundIndex}{x.side !== 'both' ? ` ${x.side[0].toUpperCase()}` : ''}</td>
                  <td>{x.status === 'done' ? '✓ done' : x.status}</td>
                  <td>{x.actualReps ?? (x.actualDurationSeconds != null ? `${x.actualDurationSeconds}s` : '–')}{x.actualLoad?.valueGrams != null ? ` × ${kg(x.actualLoad.valueGrams)} kg` : ''}{x.failedAttempt ? ' (failed)' : ''}</td>
                  <td>{x.actualRir ?? '–'}</td>
                  <td><button className="btn small-btn" onClick={() => setEditing(editing === x.id ? null : x.id)}>Correct</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {o.sets.filter((x: Any) => x.id === editing).map((x: Any) => <Correction key={x.id} s={s} occ={o} set={x} done={() => { setEditing(null); reload(); }} />)}
        </section>
      ))}
      {s.sectionActivities ? <SectionHistory title="Cooldown" list={s.sectionActivities.cooldown} /> : (
        <section className="card stack">
          <h2>Cooldown</h2>
          <p className="muted small">Not recorded in this workout format.</p>
          {s.planSnapshot.cooldown?.instructions && <ul className="small">{s.planSnapshot.cooldown.instructions.map((c: string) => <li key={c}>{c}</li>)}</ul>}
        </section>
      )}
      {s.corrections.length > 0 && (
        <section className="card stack">
          <h2>Corrections</h2>
          <ul className="small">{s.corrections.map((c: Any, i: number) => <li key={i}>{new Date(c.at).toLocaleString()} — {c.reason}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

function Correction({ s, occ, set, done }: { s: Any; occ: Any; set: Any; done: () => void }) {
  const [v, setV] = useState({ reps: set.actualReps?.toString() ?? '', secs: set.actualDurationSeconds?.toString() ?? '', kg: kg(set.actualLoad?.valueGrams), status: set.status, reason: '' });
  const [err, setErr] = useState('');
  async function submit() {
    if (v.reason.trim().length < 3) return setErr('Give a reason (at least 3 characters)');
    const grams = isLoaded(occ.loadBasis) && v.kg ? parseKgToGrams(v.kg) : null;
    try {
      await api('POST', `/sessions/${s.id}/corrections`, {
        operationId: crypto.randomUUID(), expectedRevision: s.revision, reason: v.reason,
        operations: [{ type: 'setActual', exerciseOccurrenceId: occ.id, setId: set.id, status: v.status, actualReps: v.reps === '' ? null : Number(v.reps), actualDurationSeconds: v.secs === '' ? null : Number(v.secs), valueGrams: grams, actualRir: set.actualRir, failedAttempt: set.failedAttempt, notes: set.notes }],
      });
      done();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="stack card inset">
      <div className="row wrap">
        {set.target.metric === 'reps' ? <Field label="Reps"><input inputMode="numeric" value={v.reps} onChange={(e) => setV({ ...v, reps: e.target.value })} /></Field> : <Field label="Seconds"><input inputMode="numeric" value={v.secs} onChange={(e) => setV({ ...v, secs: e.target.value })} /></Field>}
        {isLoaded(occ.loadBasis) && <Field label={LOAD_LABEL[occ.loadBasis]}><input inputMode="decimal" value={v.kg} onChange={(e) => setV({ ...v, kg: e.target.value })} /></Field>}
        <Field label="Status"><select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}><option value="done">done</option><option value="pending">pending</option><option value="skipped">skipped</option></select></Field>
      </div>
      <Field label="Reason (required)"><input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      <ErrorBox error={err} />
      <button className="btn primary" onClick={submit}>Save correction</button>
    </div>
  );
}

const setResult = (x: Any) => x.status === 'skipped' ? 'skipped' : x.status === 'pending' ? 'not done'
  : x.completionMode === 'measured' ? `done: ${x.actualReps ?? `${x.actualDurationSeconds} s`}${x.actualLoad?.valueGrams != null ? ` × ${kg(x.actualLoad.valueGrams)} kg` : ''}` : 'done (no numbers recorded)';

function SectionHistory({ title, list }: { title: string; list: Any[] }) {
  return (
    <section className="card stack">
      <h2>{title}</h2>
      <ul className="list small">
        {list.map((a) => (
          <li key={a.id}>
            <strong>{a.exerciseSnapshot.name}</strong> <span className="muted">{a.prescriptionSnapshot.sets} × {dosage(a.prescriptionSnapshot.target, a.exerciseSnapshot.repsMeaning)}</span>
            <br />{a.sets.map((x: Any) => `${x.side !== 'both' ? `${x.side} ` : ''}${setResult(x)}`).join(' · ')}
          </li>
        ))}
      </ul>
    </section>
  );
}

function LegacyWarmup({ s }: { s: Any }) {
  const done = s.warmupChecklist.filter((w: Any) => w.completed).length;
  return <p className="muted small">Warm-up checklist: {done}/{s.warmupChecklist.length} ticked (older workout format).</p>;
}
