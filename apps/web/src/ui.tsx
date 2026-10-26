import { useState, type ReactNode } from 'react';
import { effortCue, type Video as VideoT } from '@workout/contracts';

/** Click-to-load, privacy-enhanced, no autoplay; the plain link always stays. */
export function Video({ video, label }: { video: VideoT | null | undefined; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!video) return null;
  return (
    <div className="video">
      {label && <p className="muted small">{label}</p>}
      {open ? (
        <div className="video-frame">
          <iframe src={`https://www.youtube-nocookie.com/embed/${video.youtubeId}?rel=0`} title={video.title} allow="encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" />
        </div>
      ) : (
        <button type="button" className="btn ghost" onClick={() => setOpen(true)}>▶ Load video: {video.title}</button>
      )}
      <p className="small">
        <span className="muted">{video.channel} · </span>
        <a href={video.url} target="_blank" rel="noopener noreferrer">Open on YouTube</a>
      </p>
      <p className="muted small">{video.usageNote}</p>
    </div>
  );
}

export function Details({ summary, children, open }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="details" open={open}>
      <summary>{summary}</summary>
      <div className="details-body">{children}</div>
    </details>
  );
}

export function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="muted small">{hint}</span>}
      {error && <span className="error small" role="alert">{error}</span>}
    </label>
  );
}

export const Loading = () => <p className="muted" aria-live="polite">Loading…</p>;
export const ErrorBox = ({ error }: { error: Error | null | string }) => (error ? <p className="error" role="alert">{typeof error === 'string' ? error : error.message}</p> : null);

export const LOAD_LABEL: Record<string, string> = {
  per_dumbbell: 'kg per dumbbell',
  single_dumbbell: 'kg (one dumbbell)',
  barbell_total: 'kg total incl. bar',
  external_total: 'kg total',
  bodyweight: 'Bodyweight',
  none: 'No load',
};
export const loadHint = (basis: string, count: number) =>
  basis === 'per_dumbbell' ? (count === 2 ? 'Enter the weight of ONE dumbbell; you hold two.' : 'One dumbbell; enter its weight.')
    : basis === 'single_dumbbell' ? 'Enter the weight of the single dumbbell you hold.'
      : basis === 'bodyweight' ? 'Bodyweight: no load entry. Body mass is never added as load.'
        : basis === 'none' ? 'Not loaded.' : 'Enter the total load.';
export const isLoaded = (basis: string) => ['per_dumbbell', 'single_dumbbell', 'barbell_total', 'external_total'].includes(basis);
export const rirText = (r: [number, number] | null | undefined, metric?: 'reps' | 'duration') => effortCue(r, metric);
/** Effort cue with the RIR shorthand explained on hover/long-press. */
export const Effort = ({ rir, metric }: { rir: [number, number] | null | undefined; metric?: 'reps' | 'duration' }) =>
  rir || metric === 'duration' ? <span title={rir ? `Technical shorthand: RIR ${rir[0]}–${rir[1]} (reps in reserve). Nothing to enter.` : undefined}>{effortCue(rir, metric)}</span> : null;
export const targetText = (t: { metric: string; min: number; max: number; perSide?: boolean }) =>
  `${t.min === t.max ? t.min : `${t.min}–${t.max}`} ${t.metric === 'duration' ? 's' : 'reps'}${t.perSide ? ' per side' : ''}`;
