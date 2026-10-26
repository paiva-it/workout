import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { applyPhase, isFixedProgram, isSectionStep, localToInstants, type SectionStep, type Exercise, type Plan, type Program, type Video as VideoT } from '@workout/contracts';
import { ApiError, useApi } from '../api';
import { Details, Effort, ErrorBox, Field, LOAD_LABEL, Loading, rirText, targetText, Video } from '../ui';
import { useAuth } from '../main';
import { startSession } from './Today';
import { dosage, StepCard } from '../sections';

type Summary = { id: string; version: number; packId: string; packVersion: number; name: string; kind: string; focus: string[]; estimatedDurationMinutes: [number, number]; itemCount: number; sections: { warmup: number; cooldown: number } | null };

export function Plans() {
  const [kind, setKind] = useState('');
  const [maxMinutes, setMax] = useState('');
  const { data, error, loading } = useApi<Summary[]>(`/plans?kind=${kind}&maxMinutes=${maxMinutes}`);
  return (
    <div className="stack">
      <h1>Plans</h1>
      <div className="row wrap">
        <Field label="Type">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All</option><option value="restart">Restart</option><option value="focus">Focus</option><option value="recovery">Recovery</option>
          </select>
        </Field>
        <Field label="Max minutes">
          <select value={maxMinutes} onChange={(e) => setMax(e.target.value)}>
            <option value="">Any</option><option value="30">30</option><option value="45">45</option><option value="60">60</option>
          </select>
        </Field>
      </div>
      {loading && <Loading />}
      <ErrorBox error={error} />
      <ul className="cards">
        {data?.map((p) => (
          <li key={p.id} className="card">
            <Link to={`/plans/${p.id}`} className="block-link">
              <h2>{p.name}</h2>
              <p className="muted small">{p.kind} · {p.focus.join(', ').replace(/_/g, ' ')} · {p.estimatedDurationMinutes[0]}–{p.estimatedDurationMinutes[1]} min</p>
              <p className="small">{p.sections ? `Warm-up ${p.sections.warmup} · Workout ${p.itemCount} · Cooldown ${p.sections.cooldown}` : `${p.itemCount} exercises`}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PlanDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const { data, error, loading } = useApi<{ plan: Plan; exercises: Record<string, Exercise>; videos: Record<string, VideoT>; packId: string; packVersion: number }>(`/plans/${id}`);
  const today = useApi('/today');
  const programs = useApi<Program[]>('/programs');
  const [err, setErr] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [past, setPast] = useState('');
  const [offsetChoice, setOffsetChoice] = useState(0);
  if (loading || today.loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  const { plan, exercises, videos } = data;
  const pos = today.data?.position;
  const program = programs.data?.find((p) => p.id === pos?.programId);
  const inProgram = program && [...(program.schedule ?? []), ...program.phases.flatMap((ph) => [...(ph.schedule ?? []), ...(ph.alternatingSchedules ?? []).flat()])].some((e) => e.planId === plan.id);
  const phase = inProgram ? pos.phase : null;
  const fixed = program ? isFixedProgram(program) : false;
  const structured = plan.warmup.steps.length > 0 && isSectionStep(plan.warmup.steps[0]);
  const pastInstants = past ? localToInstants(past, user.timezone) : [];

  async function start(extra: Record<string, unknown> = {}) {
    setErr('');
    try {
      const s = await startSession({ planId: plan.id, planVersion: plan.version, packId: data!.packId, packVersion: data!.packVersion }, user.timezone, extra);
      nav(`/workout/${s.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.body.code === 'ACTIVE_SESSION_EXISTS') setActive(e.body.activeSessionId as string);
      else setErr((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <Link to="/plans">← Plans</Link>
      <h1>{plan.name}</h1>
      <p className="muted">{plan.estimatedDurationMinutes[0]}–{plan.estimatedDurationMinutes[1]} min · version {plan.version}</p>
      {fixed ? null : phase ? (
        <p className="card accent small">Program phase applied when you start: <strong>{phase.name}</strong> — {phase.workingSetCap ? `max ${phase.workingSetCap} working set(s)` : 'listed sets'}, {rirText(phase.rir)}{phase.allowOptional ? ', optional work available' : ', no optional work'}.</p>
      ) : (
        <p className="muted small">Not part of your current program phase: listed sets and effort apply.</p>
      )}
      {active ? (
        <div className="card accent stack" role="alert">
          <p>You already have an unfinished workout. Resume it, or finish/abandon it from the workout screen first.</p>
          <Link className="btn primary" to={`/workout/${active}`}>Go to unfinished workout</Link>
        </div>
      ) : (
        <button className="btn primary" onClick={() => start()}>Start now</button>
      )}
      <ErrorBox error={err} />
      <Video video={videos[plan.exampleVideoId]} label={plan.exampleVideoLabel} />

      {structured && (
        <>
          <h2>Warm-up · {plan.warmup.durationMinutes[0]}–{plan.warmup.durationMinutes[1]} min</h2>
          {(plan.warmup.steps as SectionStep[]).map((st) => <StepCard key={st.id} step={st} exercise={exercises[st.exerciseId]} video={videos[exercises[st.exerciseId].videoId]} />)}
        </>
      )}
      {!structured && <Details summary={`Warm-up · ${plan.warmup.durationMinutes[0]}–${plan.warmup.durationMinutes[1]} min`}>
        <ol>{(plan.warmup.steps as { id: string; label: string; reps?: number; durationSeconds?: number; notes: string }[]).map((s) => <li key={s.id}><strong>{s.label}</strong>{s.reps ? ` × ${s.reps}` : ''}{s.durationSeconds ? ` · ${Math.round(s.durationSeconds / 60)} min` : ''} — <span className="muted">{s.notes}</span></li>)}</ol>
        <Video video={videos[plan.warmup.videoId]} />
      </Details>}

      <h2>{structured ? 'Workout' : 'Exercises'}</h2>
      {plan.items.map((item) => {
        const ex = exercises[item.exerciseId];
        const eff = applyPhase(item, phase);
        const bi = plan.workoutBlocks?.findIndex((b) => b.itemIds.includes(item.id)) ?? -1;
        const block = plan.workoutBlocks?.[bi];
        return (
          <div key={item.id} className="stack">
          {block?.itemIds[0] === item.id && (
            <section className="card inset stack block-head">
              <h3>{block.name}</h3>
              <p className="target">Repeat {block.rounds} round{block.rounds > 1 ? 's' : ''}: {block.itemIds.map((i) => exercises[plan.items.find((x) => x.id === i)!.exerciseId].name).join(' → ')}</p>
              <p className="small">Rest {block.restBetweenExercisesSeconds}s between exercises, {block.restBetweenRoundsSeconds}s between rounds{bi === plan.workoutBlocks!.length - 1 ? '; then cooldown.' : `, ${block.restAfterBlockSeconds}s after the block.`}</p>
              {block.notes && <p className="muted small">{block.notes}</p>}
            </section>
          )}
          <section className="card stack">
            <h3>{ex.name}{item.optional && <span className="tag">optional</span>}</h3>
            {block ? <>
              <p className="target">{ex.repsMeaning === 'alternating_total' ? dosage(item.target, ex.repsMeaning) : targetText(item.target)} each round</p>
              <p className="small"><Effort rir={eff.rir} metric={item.target.metric} /></p>
            </> : <p>
              {eff.workingSets !== item.workingSets ? <><s>{item.workingSets}</s> {eff.workingSets}</> : eff.workingSets} × {ex.repsMeaning === 'alternating_total' ? dosage(item.target, ex.repsMeaning) : targetText(item.target)}
              {eff.rir && ` · ${rirText(eff.rir)}`} · rest {item.restSeconds}s
            </p>}
            <p className="muted small">Load: {LOAD_LABEL[ex.defaultLoadBasis]} · equipment: {ex.equipment.join(', ').replace(/_/g, ' ')} · variant: {item.defaultVariant}</p>
            {item.notes && <p className="small">{item.notes}</p>}
            <Details summary="Cues, regression and video">
              <ul>{ex.cues.map((c) => <li key={c}>{c}</li>)}</ul>
              <p className="small"><strong>Easier option:</strong> {ex.regression}</p>
              <Video video={videos[ex.videoId]} />
            </Details>
          </section>
          </div>
        );
      })}
      {structured && (
        <>
          <h2>Cooldown · {plan.cooldown.durationMinutes[0]}–{plan.cooldown.durationMinutes[1]} min</h2>
          {plan.cooldown.steps!.map((st) => <StepCard key={st.id} step={st} exercise={exercises[st.exerciseId]} video={videos[exercises[st.exerciseId].videoId]} />)}
        </>
      )}
      <Details summary={structured ? 'Cooldown guidance and plan notes' : 'Cool-down and notes'}>
        <ul>{plan.cooldown.instructions.map((c) => <li key={c}>{c}</li>)}</ul>
        <ul>{plan.notes.map((n) => <li key={n} className="small">{n}</li>)}</ul>
      </Details>
      <Details summary="Log a past workout (manual entry)">
        <Field label={`Start time (${user.timezone})`}><input type="datetime-local" value={past} onChange={(e) => setPast(e.target.value)} /></Field>
        {past && pastInstants.length === 0 && <p className="error small">That local time does not exist (clock change). Pick another.</p>}
        {pastInstants.length === 2 && (
          <fieldset className="stack">
            <legend className="small">This time happened twice (clock change). Which one?</legend>
            {pastInstants.map((d, i) => (
              <label key={i} className="row"><input type="radio" name="occ" checked={offsetChoice === i} onChange={() => setOffsetChoice(i)} /> {i === 0 ? 'First (summer time)' : 'Second (winter time)'} — {d.toISOString()}</label>
            ))}
          </fieldset>
        )}
        <button className="btn" disabled={!pastInstants.length} onClick={() => start({ source: 'manual_backfill', startedAt: pastInstants[Math.min(offsetChoice, pastInstants.length - 1)].toISOString() })}>Start manual entry</button>
      </Details>
    </div>
  );
}
