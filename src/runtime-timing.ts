/** Wall time for a completed work phase; never inferred from tokens or tool counts. */
export interface TimingEvent {
  task: string;
  actor: string;
  action: string;
  phase: string;
  at: number;
  project: string;
  role: string;
  kind: string;
}
export interface PhaseDuration extends Pick<TimingEvent, 'task' | 'phase' | 'project' | 'role' | 'kind'> {
  seconds: number;
  at: number;
}
export interface RuntimeEstimate {
  status: 'estimated' | 'insufficient' | 'variable' | 'overrun' | 'unavailable';
  samples: number;
  lowerSeconds?: number;
  upperSeconds?: number;
}

/** Only uninterrupted claim→submit / claim→accept pairs. A new claim invalidates the old lease. */
export function phaseDurations(events: TimingEvent[], now: number): PhaseDuration[] {
  const open = new Map<string, TimingEvent>();
  const finished = new Map<string, PhaseDuration>();
  for (const e of [...events].filter(e => e.at <= now && e.at >= now - 30 * 86400000)
    .sort((a, b) => a.at - b.at)) {
    if (!e.task) continue;
    const start = open.get(e.task);
    open.delete(e.task);
    if (e.action === 'claim') { open.set(e.task, e); continue; }
    if (!start || start.actor !== e.actor || start.phase !== e.phase) continue;
    if (!(e.action === 'submit' && e.phase === 'execute') && !(e.action === 'accept' && e.phase === 'review')) continue;
    const seconds = (e.at - start.at) / 1000;
    // Reject clock errors, smoke probes and abandoned leases; one latest sample per task/phase.
    if (seconds < 15 || seconds > 6 * 3600 || !start.project || !start.role || !start.kind) continue;
    finished.set(`${e.task}:${e.phase}`, {
      task: e.task, phase: e.phase, project: start.project, role: start.role, kind: start.kind, seconds, at: e.at,
    });
  }
  return [...finished.values()];
}

/** Recent same-project/role/phase/kind interquartile range. It is a reference, not a deadline. */
export function estimateRemaining(
  target: Pick<PhaseDuration, 'task' | 'phase' | 'project' | 'role' | 'kind'>,
  elapsed: number | undefined,
  history: PhaseDuration[],
): RuntimeEstimate {
  const values = history.filter(h => h.task !== target.task && h.project === target.project &&
    h.role === target.role && h.phase === target.phase && h.kind === target.kind)
    .sort((a, b) => b.at - a.at).slice(0, 40).map(h => h.seconds).sort((a, b) => a - b);
  const samples = values.length;
  if (elapsed === undefined || !Number.isFinite(elapsed) || elapsed < 0) return {status: 'unavailable', samples};
  if (!target.project || samples < 5) return {status: 'insufficient', samples};
  const lower = values[Math.floor((samples - 1) * .25)]!;
  const upper = values[Math.ceil((samples - 1) * .75)]!;
  if (upper / lower > 4) return {status: 'variable', samples};
  if (elapsed >= upper) return {status: 'overrun', samples};
  return {status: 'estimated', samples, lowerSeconds: Math.max(0, lower - elapsed), upperSeconds: upper - elapsed};
}
