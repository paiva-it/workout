import { useState, type FormEvent } from 'react';
import { isFixedProgram, localParts, weekdayIndex, type Program } from '@workout/contracts';
import { api, useApi } from '../api';
import { ErrorBox, Field } from '../ui';
import { useAuth } from '../main';

const nextMonday = (tz: string) => {
  const today = localParts(new Date(), tz).localDate;
  const offset = (7 - weekdayIndex(today)) % 7;
  return new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
};

export default function Settings() {
  const { user, refresh, logout } = useAuth();
  const programs = useApi<Program[]>('/programs').data ?? [];
  const planNames: Record<string, string> = Object.fromEntries((useApi<{ id: string; name: string }[]>('/plans').data ?? []).map((p) => [p.id, p.name]));
  const [msg, setMsg] = useState<Record<string, string>>({});
  const say = (k: string, v: string) => setMsg((m) => ({ ...m, [k]: v }));
  const [prog, setProg] = useState({ programId: user.program?.programId ?? programs.find((p) => p.recommendedDefault)?.id ?? 'return-to-training', startDate: user.program?.startDate ?? nextMonday(user.timezone), held: user.program?.heldPhaseIndex?.toString() ?? '' });
  const selected = programs.find((p) => p.id === prog.programId);
  const [alerts, setAlerts] = useState(() => { try { return localStorage.getItem('workout.restAlerts') === 'on'; } catch { return false; } });

  async function saveProgram() {
    try {
      await api('PATCH', '/me/program', { expectedRevision: user.revision, programId: prog.programId, startDate: prog.startDate || null, heldPhaseIndex: prog.held === '' || (selected && isFixedProgram(selected)) ? null : Number(prog.held) });
      await refresh();
      say('program', 'Saved');
    } catch (e) { say('program', (e as Error).message); }
  }
  async function saveSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('PATCH', '/me/settings', { expectedRevision: user.revision, timezone: String(f.get('timezone')).trim(), equipment: String(f.get('equipment')).split(',').map((s) => s.trim()).filter(Boolean), restTimerEnabled: f.get('rest') === 'on' });
      await refresh();
      say('settings', 'Saved');
    } catch (err) { say('settings', (err as Error).message); }
  }
  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (f.get('newPassword') !== f.get('confirm')) return say('password', 'New passwords do not match');
    try {
      const r = await api('POST', '/auth/password', { currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') });
      form.reset();
      say('password', `Password changed. ${r.revokedSessions} other session(s) signed out.`);
    } catch (err) { say('password', (err as Error).message); }
  }

  return (
    <div className="stack">
      <h1>Settings</h1>
      <section className="card stack">
        <h2>Program</h2>
        <Field label="Program">
          <select value={prog.programId} onChange={(e) => setProg({ ...prog, programId: e.target.value, held: '' })}>
            {programs.map((p) => <option key={p.id} value={p.id}>{p.name}{p.recommendedDefault ? ' (recommended start)' : ''}</option>)}
          </select>
        </Field>
        {selected?.transitionPolicy && <p className="muted small">{selected.transitionPolicy}</p>}
        {selected?.missedDayPolicy && <p className="muted small">{selected.missedDayPolicy}</p>}
        {selected && isFixedProgram(selected) ? (
          <ul className="schedule small">{(selected.schedule ?? selected.phases[0].schedule ?? []).map((e) => <li key={e.weekday}><strong>{e.weekday[0].toUpperCase() + e.weekday.slice(1, 3)}</strong> {planNames[e.planId] ?? e.planId}</li>)}</ul>
        ) : <>
        <Field label="Start date" hint="Weeks start on Monday. Pick the Monday you start."><input type="date" value={prog.startDate} onChange={(e) => setProg({ ...prog, startDate: e.target.value })} /></Field>
        <Field label="Phase" hint="Hold or repeat an easier phase instead of following the calendar.">
          <select value={prog.held} onChange={(e) => setProg({ ...prog, held: e.target.value })}>
            <option value="">Follow the calendar</option>
            {selected?.phases.map((ph, i) => <option key={i} value={i}>Hold: {ph.name} (weeks {ph.weeks[0]}{ph.weeks[1] ? `–${ph.weeks[1]}` : '+'})</option>)}
          </select>
        </Field>
        </>}
        <button className="btn primary" onClick={saveProgram}>Save program</button>
        {msg.program && <p className="small" role="status">{msg.program}</p>}
      </section>

      <form className="card stack" onSubmit={saveSettings}>
        <h2>Preferences</h2>
        <p className="small">Units: kilograms.</p>
        <Field label="Timezone (IANA)" hint="Past records keep the timezone they were logged in."><input name="timezone" defaultValue={user.timezone} /></Field>
        <Field label="Confirmed equipment (comma separated)"><input name="equipment" defaultValue={user.equipment.join(', ')} /></Field>
        <label className="check"><input type="checkbox" name="rest" defaultChecked={user.restTimerEnabled} /> Start the rest timer when I mark a set done</label>
        <label className="check"><input type="checkbox" checked={alerts} onChange={(e) => { setAlerts(e.target.checked); try { localStorage.setItem('workout.restAlerts', e.target.checked ? 'on' : 'off'); } catch { /* ignore */ } }} /> Vibrate when rest ends (this device)</label>
        <button className="btn primary">Save preferences</button>
        {msg.settings && <p className="small" role="status">{msg.settings}</p>}
      </form>

      <Import />

      <section className="card stack">
        <h2>Export</h2>
        <p className="small">Lossless JSON of your workouts, sets, weigh-ins and the plan definitions they used. No passwords or session data.</p>
        <a className="btn" href="/api/v1/exports/personal.json" download>Download export</a>
      </section>

      <form className="card stack" onSubmit={changePassword}>
        <h2>Password</h2>
        <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
        <Field label="Current password"><input name="currentPassword" type="password" autoComplete="current-password" required /></Field>
        <Field label="New password" hint="At least 10 characters. Other devices get signed out."><input name="newPassword" type="password" autoComplete="new-password" minLength={10} required /></Field>
        <Field label="Repeat new password"><input name="confirm" type="password" autoComplete="new-password" required /></Field>
        <button className="btn">Change password</button>
        {msg.password && <p className="small" role="status">{msg.password}</p>}
      </form>

      <section className="card stack">
        <p className="small">Signed in as {user.username}</p>
        <button className="btn" onClick={logout}>Log out</button>
      </section>
    </div>
  );
}

function Import() {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const parsed = () => { try { return JSON.parse(text); } catch { return undefined; } };
  async function doPreview() {
    setErr(''); setDone(''); setPreview(null);
    const pack = parsed();
    if (pack === undefined) return setErr('Not valid JSON');
    try { setPreview(await api('POST', '/plan-imports/preview', { pack })); } catch (e) { setErr((e as Error).message); }
  }
  async function doImport() {
    try {
      const r = await api('POST', '/plan-imports', { pack: parsed(), expectedCatalogRevision: preview.catalogRevision, previewHash: preview.contentHash });
      setDone(`${r.packId} v${r.version}: ${r.status === 'noop' ? 'already imported' : 'imported'}${r.activated ? ' and activated' : ''}.`);
      setPreview(null);
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <section className="card stack">
      <h2>Import plans</h2>
      <p className="small">Paste or load a training pack JSON (same format as the supplied pack). Nothing changes until you confirm.</p>
      <Field label="Pack file"><input type="file" accept="application/json,.json" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} /></Field>
      <Field label="Or paste JSON"><textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /></Field>
      <button className="btn" disabled={!text} onClick={doPreview}>Preview</button>
      <ErrorBox error={err} />
      {preview && (
        <div className="card inset stack" role="status">
          <p><strong>{preview.title ?? 'Pack'}</strong> {preview.packId} v{preview.version}: <strong>{preview.status}</strong></p>
          {preview.counts && <ul className="small">{Object.entries(preview.counts).map(([k, c]: [string, any]) => <li key={k}>{k}: {c.new} new, {c.unchanged} unchanged, {c.conflicting} conflicting</li>)}</ul>} {/* eslint-disable-line @typescript-eslint/no-explicit-any */}
          {preview.errors?.length > 0 && <ul className="error small">{preview.errors.map((e: string) => <li key={e}>{e}</li>)}</ul>}
          {['new', 'noop'].includes(preview.status) && <button className="btn primary" onClick={doImport}>{preview.status === 'noop' ? (preview.active ? 'Already active' : 'Activate') : 'Import and activate'}</button>}
        </div>
      )}
      {done && <p className="small" role="status">{done}</p>}
    </section>
  );
}
