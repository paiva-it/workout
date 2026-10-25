import { createContext, StrictMode, useCallback, useContext, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, ApiError, outbox, setCsrf } from './api';
import { Field } from './ui';
import Today from './pages/Today';
import { PlanDetail, Plans } from './pages/Plans';
import Workout from './pages/Workout';
import { History, HistoryDetail } from './pages/History';
import Body from './pages/Body';
import Settings from './pages/Settings';
import './styles.css';

type User = { id: string; username: string; displayName: string; timezone: string; revision: number; program: { programId: string | null; startDate: string | null; heldPhaseIndex: number | null }; equipment: string[]; restTimerEnabled: boolean };
const AuthCtx = createContext<{ user: User; refresh: () => Promise<void>; logout: () => Promise<void> }>(null!);
export const useAuth = () => useContext(AuthCtx);

function Login({ onLogin }: { onLogin: () => void }) {
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      const r = await api('POST', '/auth/login', { username: f.get('username'), password: f.get('password') });
      setCsrf(r.csrfToken);
      onLogin();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cannot reach the server');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <h1>Workout</h1>
      <form onSubmit={submit} className="card stack">
        <Field label="Username"><input name="username" autoComplete="username" required autoCapitalize="none" spellCheck={false} /></Field>
        <div className="row">
          <div className="grow"><Field label="Password"><input name="password" type={show ? 'text' : 'password'} autoComplete="current-password" required /></Field></div>
          <button type="button" className="btn ghost align-end" onClick={() => setShow(!show)} aria-pressed={show} aria-label={show ? 'Hide password' : 'Show password'}>{show ? 'Hide' : 'Show'}</button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}

function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const refresh = useCallback(async () => {
    try {
      const r = await api('GET', '/auth/me');
      setCsrf(r.csrfToken);
      setUser(r.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
      else setUser((u) => u ?? null);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onUnauth = () => setUser(null);
    window.addEventListener('workout:unauthenticated', onUnauth);
    return () => window.removeEventListener('workout:unauthenticated', onUnauth);
  }, [refresh]);
  const logout = useCallback(async () => {
    const pending = outbox.get().queue.length;
    if (pending && !confirm(`${pending} workout change(s) are not synced yet and will be lost. Log out anyway?`)) return;
    try { await api('POST', '/auth/logout'); } catch { /* cookie may already be gone */ }
    outbox.clear();
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
    setUser(null);
  }, []);

  if (user === undefined) return <p className="muted center">Loading…</p>;
  if (!user) return <Login onLogin={refresh} />;
  return (
    <AuthCtx.Provider value={{ user, refresh, logout }}>
      <BrowserRouter>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>Today</NavLink>
          <NavLink to="/plans">Plans</NavLink>
          <NavLink to="/history">History</NavLink>
          <NavLink to="/body">Weight</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <main className="page">
          <Routes>
            <Route path="/" element={<Today />} />
            <Route path="/plans" element={<Plans />} />
            <Route path="/plans/:id" element={<PlanDetail />} />
            <Route path="/workout/:id" element={<Workout />} />
            <Route path="/history" element={<History />} />
            <Route path="/history/:id" element={<HistoryDetail />} />
            <Route path="/body" element={<Body />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </BrowserRouter>
    </AuthCtx.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
