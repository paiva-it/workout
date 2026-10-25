import { useState, type FormEvent } from 'react';
import { localParts, localToInstants, parseKgToGrams } from '@workout/contracts';
import { api, fmtDate, fmtTime, kg, useApi } from '../api';
import { ErrorBox, Field, Loading } from '../ui';
import { useAuth } from '../main';

type M = { id: string; revision: number; massGrams: number; measuredAt: string | null; datePrecision: string; localDate: string; timezone: string; utcOffsetMinutes: number | null; source: string; context: { timeOfDay: string; beforeFood: boolean | null; notes: string | null }; corrections: unknown[] };
const nowLocal = (tz: string) => { const p = localParts(new Date(), tz); return `${p.localDate}T${p.localTime}`; };

export default function Body() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi<{ items: M[] }>('/body-measurements');
  const [when, setWhen] = useState(nowLocal(user.timezone));
  const [occurrence, setOccurrence] = useState(0);
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const instants = localToInstants(when, user.timezone);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const grams = parseKgToGrams(String(f.get('kg') ?? ''));
    if (!grams || grams < 1000) return setMsg('Enter a weight like 80.5 or 80,5');
    if (!instants.length) return setMsg('That local time does not exist (clock change)');
    const last = data?.items[0];
    if (last && Math.abs(grams - last.massGrams) > last.massGrams * 0.05 && !confirm(`That differs from your last entry by ${kg(Math.abs(grams - last.massGrams))} kg. Save anyway?`)) return;
    try {
      await api('POST', '/body-measurements', {
        clientMeasurementId: crypto.randomUUID(), massGrams: grams, measuredAt: instants[Math.min(occurrence, instants.length - 1)].toISOString(), timezone: user.timezone, source: 'scale_measurement',
        context: { timeOfDay: f.get('timeOfDay'), beforeFood: f.get('beforeFood') === 'yes' ? true : f.get('beforeFood') === 'no' ? false : null, scaleLabel: null, notes: String(f.get('notes') ?? '').trim() || null },
      });
      form.reset();
      setMsg('Saved');
      reload();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <h1>Body weight</h1>
      <form className="card stack" onSubmit={submit}>
        <h2>Add a weigh-in</h2>
        <div className="row wrap">
          <Field label="Weight (kg)"><input name="kg" inputMode="decimal" required placeholder="80.5" /></Field>
          <Field label={`Date and time (${user.timezone})`}><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required /></Field>
        </div>
        {instants.length === 2 && (
          <fieldset className="stack">
            <legend className="small">That time happened twice (clock change). Which one?</legend>
            {instants.map((d, i) => <label key={i} className="row"><input type="radio" name="occ" checked={occurrence === i} onChange={() => setOccurrence(i)} /> {i === 0 ? 'First (summer time)' : 'Second (winter time)'} — {d.toISOString()}</label>)}
          </fieldset>
        )}
        <div className="row wrap">
          <Field label="Time of day"><select name="timeOfDay" defaultValue="unknown"><option value="unknown">Unknown</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option><option value="evening">Evening</option></select></Field>
          <Field label="Before food?"><select name="beforeFood" defaultValue=""><option value="">Not recorded</option><option value="yes">Yes</option><option value="no">No</option></select></Field>
        </div>
        <Field label="Note"><input name="notes" maxLength={1000} /></Field>
        <button className="btn primary">Save weigh-in</button>
        {msg && <p className="small" role="status">{msg}</p>}
      </form>
      {loading && <Loading />}
      <ErrorBox error={error} />
      <ul className="list">
        {data?.items.map((m) => (
          <li key={m.id} className="stack">
            <div>
              <strong>{kg(m.massGrams)} kg</strong> · {fmtDate(m.localDate)}{m.measuredAt ? ` ${fmtTime(m.measuredAt, m.timezone)}` : ''}
              {m.datePrecision === 'day' ? <span className="tag">date-only self-report</span> : <span className="tag">weigh-in</span>}
              {m.context?.timeOfDay !== 'unknown' && <span className="muted small"> {m.context.timeOfDay}</span>}
              {m.corrections.length > 0 && <span className="muted small"> · corrected</span>}
              <button className="btn small-btn" onClick={() => setEditing(editing === m.id ? null : m.id)}>Edit</button>
            </div>
            {m.context?.notes && <span className="muted small">{m.context.notes}</span>}
            {editing === m.id && <Edit m={m} done={() => { setEditing(null); reload(); }} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Edit({ m, done }: { m: M; done: () => void }) {
  const [v, setV] = useState({ kg: kg(m.massGrams), reason: '' });
  const [err, setErr] = useState('');
  const go = async (del: boolean) => {
    if (v.reason.trim().length < 3) return setErr('Give a reason');
    const grams = parseKgToGrams(v.kg);
    if (!del && !grams) return setErr('Invalid weight');
    try {
      if (del) await api('DELETE', `/body-measurements/${m.id}`, { expectedRevision: m.revision, reason: v.reason });
      else await api('PATCH', `/body-measurements/${m.id}`, { expectedRevision: m.revision, reason: v.reason, massGrams: grams });
      done();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="card inset stack">
      <div className="row wrap">
        <Field label="Weight (kg)"><input inputMode="decimal" value={v.kg} onChange={(e) => setV({ ...v, kg: e.target.value })} /></Field>
        <Field label="Reason (required)"><input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      </div>
      <ErrorBox error={err} />
      <div className="row wrap">
        <button className="btn primary" onClick={() => go(false)}>Save correction</button>
        <button className="btn" onClick={() => confirm('Delete this entry? It is hidden, not erased.') && go(true)}>Delete</button>
      </div>
    </div>
  );
}
