import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { parseKgToGrams } from '@workout/contracts';
import { api, ApiError, fmtDate, fmtDuration, kg, useApi } from '../api';
import { ErrorBox, Field, Loading, rirText } from '../ui';
import { useAuth } from '../main';

export async function startSession(p: { planId: string; planVersion: number; packId: string; packVersion: number }, tz: string, extra: Record<string, unknown> = {}) {
  return api('POST', '/sessions', { clientSessionId: crypto.randomUUID(), planId: p.planId, planVersion: p.planVersion, packId: p.packId, packVersion: p.packVersion, timezone: tz, ...extra });
}

export default function Today() {
  const { user } = useAuth();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi('/today');
  const [err, setErr] = useState('');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const t = data;

  async function start() {
    setErr('');
    try {
      const s = await startSession(t.next, user.timezone);
      nav(`/workout/${s.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.body.code === 'ACTIVE_SESSION_EXISTS') nav(`/workout/${e.body.activeSessionId}`);
      else setErr((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <h1>Today</h1>
      {t.active && (
        <section className="card accent stack">
          <h2>{t.active.status === 'paused' ? 'Paused workout' : 'Workout in progress'}</h2>
          <p>{t.active.planName} · started {new Date(t.active.startedAt).toLocaleString('en-US', { timeZone: user.timezone })}</p>
          <Link className="btn primary" to={`/workout/${t.active.id}`}>Resume workout</Link>
        </section>
      )}

      <section className="card stack">
        {!t.position ? (
          <>
            <h2>{t.program ? 'Choose a start date' : 'Choose a program'}</h2>
            <p>{t.program ? `${t.program.name} counts weeks from the start date you pick. Nothing is scheduled until you choose.` : 'Pick a program in Settings to get a weekly schedule, or start any plan directly.'}</p>
            <Link className="btn primary" to="/settings">{t.program ? 'Set program start' : 'Choose program'}</Link>
          </>
        ) : (
          <>
            {t.position.fixed ? (
              <h2>{t.position.programName}</h2>
            ) : (
              <>
                <p className="muted small">{t.position.programName} · week {t.position.programWeek}{t.position.held ? ' (phase held)' : ''}</p>
                <h2>{t.position.phase.name}</h2>
                <p className="small">
                  {t.position.phase.workingSetCap ? `Up to ${t.position.phase.workingSetCap} working set${t.position.phase.workingSetCap > 1 ? 's' : ''} per exercise` : 'Listed sets'} · {rirText(t.position.phase.rir)}
                </p>
              </>
            )}
            <p className="muted small">{t.position.phase.notes}</p>
            <ul className="schedule small">{t.position.schedule.map((s: { weekday: string; planId: string; planName: string }) => <li key={s.weekday}><strong>{s.weekday[0].toUpperCase() + s.weekday.slice(1, 3)}</strong> {s.planName}</li>)}</ul>
            <p className="muted small">Other days: easy activity or rest.</p>
            {t.next ? (
              <>
                <h3>Next: {t.next.name}</h3>
                <p className="muted small">{t.next.estimatedDurationMinutes[0]}–{t.next.estimatedDurationMinutes[1]} min · {t.doneThisWeek} done this week. Missed days are never owed.</p>
                {!t.active && <button className="btn primary" onClick={start}>Start {t.next.name}</button>}
                <Link className="btn ghost" to={`/plans/${t.next.planId}`}>View plan</Link>
              </>
            ) : (
              <p>This week's sessions are done. Easy walking, mobility or rest.</p>
            )}
          </>
        )}
        <ErrorBox error={err} />
        <Link to="/plans">Pick another plan</Link>
      </section>

      <QuickWeight onSaved={reload} latest={t.latestWeight} />

      <section className="card stack">
        <h2>Recent</h2>
        {!t.recent.length && <p className="muted">No finished workouts yet.</p>}
        <ul className="list">
          {t.recent.map((s: { id: string; planName: string; status: string; localDate: string; activeSeconds: number; summary: { done: number; required: number } }) => (
            <li key={s.id}>
              <Link to={`/history/${s.id}`}>{fmtDate(s.localDate)} · {s.planName}</Link>
              <span className={`tag ${s.status}`}>{s.status}</span>
              <span className="muted small"> {s.summary.done}/{s.summary.required} sets · {fmtDuration(s.activeSeconds)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function QuickWeight({ onSaved, latest }: { onSaved: () => void; latest: { massGrams: number; localDate: string; datePrecision: string } | null }) {
  const { user } = useAuth();
  const [msg, setMsg] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const grams = parseKgToGrams(String(new FormData(form).get('kg') ?? ''));
    if (!grams || grams < 1000) return setMsg('Enter a weight like 80.5 or 80,5');
    if (latest && Math.abs(grams - latest.massGrams) > latest.massGrams * 0.05 && !confirm(`That is ${kg(Math.abs(grams - latest.massGrams))} kg different from your last entry. Save anyway?`)) return;
    try {
      await api('POST', '/body-measurements', { clientMeasurementId: crypto.randomUUID(), massGrams: grams, measuredAt: new Date().toISOString(), timezone: user.timezone, source: 'scale_measurement' });
      form.reset();
      setMsg('Saved');
      onSaved();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }
  return (
    <section className="card">
      <form onSubmit={submit} className="stack">
        <h2>Weigh-in now</h2>
        {latest && <p className="muted small">Last: {kg(latest.massGrams)} kg on {fmtDate(latest.localDate)}{latest.datePrecision === 'day' ? ' (date-only self-report)' : ''}</p>}
        <div className="row">
          <Field label="Body weight (kg)"><input name="kg" inputMode="decimal" autoComplete="off" placeholder="80.5" /></Field>
          <button className="btn primary align-end">Save</button>
        </div>
        {msg && <p className="small" role="status">{msg}</p>}
      </form>
    </section>
  );
}
