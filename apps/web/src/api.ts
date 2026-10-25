import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };

export class ApiError extends Error {
  constructor(public status: number, public body: { code?: string; message?: string; fieldErrors?: Record<string, string>; [k: string]: unknown }) {
    super(body?.message ?? `HTTP ${status}`);
  }
}
export class NetworkError extends Error {}

/** Same-origin JSON call. Mutations always send a JSON body and the session-bound CSRF token. */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const mutating = method !== 'GET';
  let r: Response;
  try {
    r = await fetch('/api/v1' + path, {
      method, credentials: 'same-origin',
      headers: mutating ? { 'content-type': 'application/json', 'x-csrf-token': csrf } : {},
      body: mutating ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new NetworkError('Network unavailable');
  }
  const json = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('workout:unauthenticated'));
  if (!r.ok) throw new ApiError(r.status, json);
  return json as T;
}

/** Tiny fetch hook: data, error, reload. */
export function useApi<T = any>(path: string | null) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const load = useCallback(() => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true }));
    api<T>('GET', path).then((data) => setState({ data, error: null, loading: false }), (error) => setState({ data: null, error, loading: false }));
  }, [path]);
  useEffect(load, [load]);
  return { ...state, reload: load };
}

// ---------- Workout outbox: serialized, persisted, replay-safe (operation IDs) ----------
export type OutboxItem =
  | { operationId: string; sessionId: string; kind: 'patch'; op: Record<string, unknown> }
  | { operationId: string; sessionId: string; kind: 'pause' | 'resume'; at: string };
type NewItem = OutboxItem extends infer T ? (T extends OutboxItem ? Omit<T, 'operationId'> : never) : never;
export type SaveStatus = 'saved' | 'saving' | 'offline' | 'conflict' | 'error';
interface OutboxState { session: any; queue: OutboxItem[]; status: SaveStatus; conflict: { server: any; item: OutboxItem } | null; error: string | null } // eslint-disable-line @typescript-eslint/no-explicit-any

// ponytail: localStorage rather than IndexedDB — one small queue per device; switch if drafts ever outgrow ~5 MB.
const KEY = 'workout.outbox.v1';
const readQueue = (): OutboxItem[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; } };
let state: OutboxState = { session: null, queue: readQueue(), status: 'saved', conflict: null, error: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<OutboxState>) => {
  state = { ...state, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(state.queue)); } catch { /* private mode: in-memory only */ }
  listeners.forEach((l) => l());
};
let running = false;
let retry: ReturnType<typeof setTimeout> | undefined;

export const outbox = {
  get: () => state,
  subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
  setSession(session: any) { set({ session }); }, // eslint-disable-line @typescript-eslint/no-explicit-any
  enqueue(item: NewItem) {
    set({ queue: [...state.queue, { ...item, operationId: crypto.randomUUID() } as OutboxItem], error: null });
    void outbox.flush();
  },
  pendingFor: (sessionId: string) => state.queue.filter((q) => q.sessionId === sessionId),
  async flush() {
    if (running || state.status === 'conflict') return;
    running = true;
    clearTimeout(retry);
    try {
      while (state.queue.length) {
        const item = state.queue[0];
        if (!state.session || state.session.id !== item.sessionId) {
          try { outbox.setSession(await api('GET', `/sessions/${item.sessionId}`)); } catch (e) { if (e instanceof ApiError && e.status === 404) { set({ queue: state.queue.slice(1) }); continue; } throw e; }
        }
        set({ status: 'saving' });
        try {
          const r = item.kind === 'patch'
            ? await api('PATCH', `/sessions/${item.sessionId}`, { operationId: item.operationId, expectedRevision: state.session.revision, op: item.op })
            : await api('POST', `/sessions/${item.sessionId}/${item.kind}`, { operationId: item.operationId, at: item.at });
          set({ session: r.session, queue: state.queue.slice(1) });
        } catch (e) {
          if (e instanceof ApiError && e.body.code === 'REVISION_CONFLICT') {
            set({ status: 'conflict', conflict: { server: e.body.session, item }, session: e.body.session ?? state.session });
            return;
          }
          if (e instanceof ApiError && e.status < 500 && e.status !== 401 && e.status !== 429) {
            // Rejected for good (validation, closed workout): drop it and say why.
            set({ queue: state.queue.slice(1), status: 'error', error: e.message });
            continue;
          }
          throw e;
        }
      }
      if (state.status !== 'error') set({ status: 'saved' });
    } catch {
      set({ status: 'offline' });
      retry = setTimeout(() => void outbox.flush(), 4000);
    } finally {
      running = false;
    }
  },
  /** Conflict review: keep the server version (drop mine) or re-apply mine on top of it. */
  resolve(choice: 'discard' | 'reapply') {
    const c = state.conflict;
    if (!c) return;
    set({ conflict: null, status: 'saving', queue: choice === 'discard' ? state.queue.filter((q) => q !== c.item && q.operationId !== c.item.operationId) : state.queue });
    void outbox.flush();
  },
  clear() { set({ queue: [], session: null, status: 'saved', conflict: null, error: null }); },
};
window.addEventListener('online', () => void outbox.flush());
export const useOutbox = () => useSyncExternalStore(outbox.subscribe, outbox.get);

// ---------- Formatting ----------
export const kg = (g: number | null | undefined) => (g == null ? '' : `${+(g / 1000).toFixed(3)}`);
export const fmtDuration = (secs: number | null | undefined) => {
  if (secs == null) return '–';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = Math.floor(secs % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(s).padStart(2, '0')}`;
};
export const fmtTime = (iso: string | Date, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
export const fmtDate = (localDate: string) => new Date(localDate + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
