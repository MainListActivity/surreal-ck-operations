import { RecordId, type Surreal } from 'surrealdb';

/** A goal is a chain root: progress, the forecast and the defects are all read off the chain's tasks and audit trail. */
export type DefectState = 'fixing' | 'verifying' | 'fixed' | 'reopened' | 'dropped';

export interface Defect {
  id: string; taskId: string; taskTitle: string; problem: string; foundBy: string; foundAt: string;
  fix?: string; fixedBy?: string; fixedAt?: string; state: DefectState;
}
export interface Forecast {
  /** null: nothing has finished yet, so there is no pace to project from. */
  remainingMinutes: number | null; finishAt?: string;
  basis: 'chain' | 'company' | 'none'; samples: number; medianMinutes?: number;
  /** Open tasks stopped on the owner: the forecast assumes they clear at the normal pace. */
  ownerWaiting: number;
}
export interface Counts { done: number; doing: number; waiting: number; blocked: number; total: number }
export interface ChainProgress {
  root: string; title: string; counts: Counts; forecast: Forecast; defects: Defect[]; taskIds: string[];
}
export interface Progress { chains: ChainProgress[]; counts: Counts; forecast: Forecast; defects: Defect[] }

export interface ProgressTask { id: string; title: string; state: string; parent?: string; blockedTo?: string }
export interface ProgressEvent { task: string; action: string; actor: string; text: string; at: number }

const MINUTE = 60_000;
const TEXT_LIMIT = 2000;
/** Past its expected time a running task is still not finished: it keeps a quarter of the pace as remaining work. */
const OVERRUN_FLOOR = 0.25;
/** A dispatcher rollback is a lost channel, not a defect anyone found. */
const MECHANICAL = '【通道回滚】';
const RAISED = new Set(['return', 'owner_reject']);
const ACCEPTED = new Set(['accept', 'owner_approve']);

export const PROGRESS_ACTIONS = ['claim', 'submit', 'return', 'owner_reject', 'accept', 'owner_approve'];

const median = (values: number[]): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const actorName = (actor: string): string => actor.replace(/^employee:/, '').replace(/[⟨⟩`]/g, '');

function defectsOf(task: ProgressTask, events: ProgressEvent[]): Defect[] {
  const defects: Defect[] = [];
  for (const event of events) {
    const last = defects[defects.length - 1];
    if (RAISED.has(event.action) && !event.text.startsWith(MECHANICAL)) {
      if (last?.state === 'verifying') last.state = 'reopened';
      defects.push({ id: `${task.id}#${defects.length + 1}`, taskId: task.id, taskTitle: task.title, problem: event.text,
        foundBy: actorName(event.actor), foundAt: new Date(event.at).toISOString(), state: 'fixing' });
    } else if (event.action === 'submit' && last?.state === 'fixing') {
      last.fix = event.text; last.fixedBy = actorName(event.actor); last.fixedAt = new Date(event.at).toISOString(); last.state = 'verifying';
    } else if (ACCEPTED.has(event.action) && last?.state === 'verifying') last.state = 'fixed';
  }
  if (task.state === 'void') for (const d of defects) if (d.state === 'fixing' || d.state === 'verifying') d.state = 'dropped';
  return defects;
}

/** First claim to final acceptance: time waiting to be picked up says nothing about how long work takes. */
function cycleMinutes(events: ProgressEvent[]): number | undefined {
  const start = events.find(e => e.action === 'claim')?.at;
  const end = events.filter(e => ACCEPTED.has(e.action)).at(-1)?.at;
  return start !== undefined && end !== undefined && end >= start ? (end - start) / MINUTE : undefined;
}

const countOf = (tasks: ProgressTask[]): Counts => {
  const live = tasks.filter(t => t.state !== 'void');
  const n = (...states: string[]) => live.filter(t => states.includes(t.state)).length;
  return { done: n('done'), doing: n('doing', 'review'), waiting: n('ready', 'planned'), blocked: n('blocked'), total: live.length };
};

const addCounts = (rows: Counts[]): Counts => rows.reduce((sum, c) => ({ done: sum.done + c.done, doing: sum.doing + c.doing,
  waiting: sum.waiting + c.waiting, blocked: sum.blocked + c.blocked, total: sum.total + c.total }), { done: 0, doing: 0, waiting: 0, blocked: 0, total: 0 });

/** Sibling tasks run side by side, so a chain finishes with its longest branch, not the sum of its tasks. */
function longestBranch(root: string, kids: Map<string, string[]>, own: (id: string) => number): number {
  const seen = new Set<string>();
  const walk = (id: string): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return own(id) + Math.max(0, ...(kids.get(id) ?? []).map(walk));
  };
  return walk(root);
}

export function buildProgress(tasks: ProgressTask[], events: ProgressEvent[], now: number): Progress {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const eventsOf = new Map<string, ProgressEvent[]>();
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    if (!eventsOf.has(event.task)) eventsOf.set(event.task, []);
    eventsOf.get(event.task)!.push(event);
  }
  const kids = new Map<string, string[]>();
  const roots: ProgressTask[] = [];
  for (const task of tasks) {
    // A parent past the read window still leaves a chain to report: its oldest visible task stands as the root.
    if (task.parent && byId.has(task.parent)) {
      if (!kids.has(task.parent)) kids.set(task.parent, []);
      kids.get(task.parent)!.push(task.id);
    } else roots.push(task);
  }
  const paces = new Map<string, number>();
  for (const task of tasks) {
    const minutes = task.state === 'done' ? cycleMinutes(eventsOf.get(task.id) ?? []) : undefined;
    if (minutes !== undefined) paces.set(task.id, minutes);
  }
  const companyPace = median([...paces.values()]);

  const chains = roots.map((root): ChainProgress => {
    const ids: string[] = [];
    const walk = (id: string) => { if (ids.includes(id)) return; ids.push(id); (kids.get(id) ?? []).forEach(walk); };
    walk(root.id);
    const members = ids.map(id => byId.get(id)!);
    const open = members.filter(t => t.state !== 'done' && t.state !== 'void');
    const own = ids.flatMap(id => paces.has(id) ? [paces.get(id)!] : []);
    const pace = median(own) ?? companyPace;
    const basis = own.length ? 'chain' : companyPace !== undefined ? 'company' : 'none';
    const forecastFor = (minutes: number | null): Forecast => ({
      remainingMinutes: minutes, basis, samples: own.length || paces.size, medianMinutes: pace === undefined ? undefined : Math.round(pace),
      ownerWaiting: open.filter(t => t.state === 'blocked' && t.blockedTo === 'owner').length,
      finishAt: minutes === null ? undefined : new Date(now + minutes * MINUTE).toISOString(),
    });
    const remainingOf = (id: string): number => {
      const task = byId.get(id)!;
      if (task.state === 'done' || task.state === 'void') return 0;
      const started = eventsOf.get(id)?.find(e => e.action === 'claim')?.at;
      const elapsed = started !== undefined && ['doing', 'review'].includes(task.state) ? (now - started) / MINUTE : 0;
      return Math.max(pace! - elapsed, pace! * OVERRUN_FLOOR);
    };
    const remaining = !open.length ? 0 : pace === undefined ? null : Math.ceil(longestBranch(root.id, kids, remainingOf));
    return { root: root.id, title: root.title, counts: countOf(members), forecast: forecastFor(remaining), taskIds: ids,
      defects: members.flatMap(t => defectsOf(t, eventsOf.get(t.id) ?? [])).sort((a, b) => b.foundAt.localeCompare(a.foundAt)) };
  });

  const active = chains.filter(c => c.forecast.remainingMinutes !== 0);
  const unknown = active.some(c => c.forecast.remainingMinutes === null);
  const remainingMinutes = unknown ? null : Math.max(0, ...active.map(c => c.forecast.remainingMinutes!));
  return {
    chains, counts: addCounts(chains.map(c => c.counts)),
    defects: chains.flatMap(c => c.defects).sort((a, b) => b.foundAt.localeCompare(a.foundAt)),
    forecast: {
      remainingMinutes, basis: companyPace === undefined ? 'none' : 'company', samples: paces.size,
      medianMinutes: companyPace === undefined ? undefined : Math.round(companyPace),
      ownerWaiting: chains.reduce((n, c) => n + c.forecast.ownerWaiting, 0),
      finishAt: remainingMinutes === null ? undefined : new Date(now + remainingMinutes * MINUTE).toISOString(),
    },
  };
}

const idOf = (value: unknown): string => value instanceof RecordId ? String(value.id) : String(value ?? '');
const timeOf = (value: unknown): number => {
  const date = value as { toDate?: () => Date };
  return typeof date?.toDate === 'function' ? date.toDate().getTime() : new Date(value as string).getTime();
};

export async function readProgress(db: Surreal, now = Date.now()): Promise<Progress> {
  const [tasks] = await db.query<[Array<{ id: RecordId; title?: string; state: string; parent?: RecordId; blocked_to?: string; created_at?: unknown }>]>(
    'SELECT id, title, state, parent, blocked_to, created_at FROM task ORDER BY created_at DESC LIMIT 300;');
  const rows = tasks ?? [];
  const [audit] = await db.query<[Array<{ task: RecordId; action: string; actor?: unknown; evidence?: unknown; at: unknown }>]>(
    'SELECT task, action, actor, evidence, at FROM audit WHERE task IN $ids AND action IN $actions;',
    { ids: rows.map(row => row.id), actions: PROGRESS_ACTIONS });
  return buildProgress(
    [...rows].reverse().map(row => ({ id: idOf(row.id), title: row.title ?? '', state: row.state, parent: row.parent ? idOf(row.parent) : undefined, blockedTo: row.blocked_to })),
    (audit ?? []).map(row => ({ task: idOf(row.task), action: row.action, actor: String(row.actor ?? ''),
      text: typeof row.evidence === 'string' ? row.evidence.slice(0, TEXT_LIMIT) : '', at: timeOf(row.at) })),
    now);
}
