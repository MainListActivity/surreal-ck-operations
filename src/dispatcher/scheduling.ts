/** Explicit approved delivery facts only; no title/prompt inference or model calls. */
export interface SchedulingFact {
  readyAt?: number; // milliseconds: latest entry into this runnable phase
  priority?: number; // owner's immutable requirement approval, 0 is highest
  requirement?: string;
  revision?: number;
}
export const FAIR_WAIT_MS = 30 * 60_000;
export interface SchedulingDecision extends SchedulingFact {
  priority: number;
  waitingMs: number;
  reason: 'aged' | 'approved_priority' | 'ordinary';
}
interface Work { task: { id: string; row: { created_at?: unknown } }; purpose: string }

export function schedulingDecision(item: Work, facts: ReadonlyMap<string, SchedulingFact>, now: number): SchedulingDecision {
  const fact = facts.get(item.task.id) ?? {};
  const created = Date.parse(String(item.task.row.created_at ?? ''));
  const readyAt = Number.isFinite(fact.readyAt) ? fact.readyAt! : Number.isFinite(created) ? created : now;
  const waitingMs = Math.max(0, now - readyAt);
  const approved = !!fact.requirement && Number.isInteger(fact.revision) && Number.isInteger(fact.priority)
    && fact.priority! >= 0 && fact.priority! <= 3;
  return { ...fact, readyAt, priority: approved ? fact.priority! : 2, waitingMs,
    reason: waitingMs >= FAIR_WAIT_MS ? 'aged' : approved ? 'approved_priority' : 'ordinary' };
}

/** Aged work is FIFO ahead of every fresh priority. New arrivals cannot overtake it indefinitely.
 * Admission/lease/independence checks remain the dispatcher's responsibility; no running work is preempted. */
export function orderWork<T extends Work>(items: readonly T[], facts: ReadonlyMap<string, SchedulingFact>, now: number): T[] {
  const decisions = new Map(items.map(item => [item.task.id, schedulingDecision(item, facts, now)]));
  return [...items].sort((a, b) => {
    const x = decisions.get(a.task.id)!, y = decisions.get(b.task.id)!;
    const aged = Number(y.reason === 'aged') - Number(x.reason === 'aged');
    return aged || (x.reason === 'aged' ? x.readyAt! - y.readyAt! : x.priority - y.priority
      || Number(b.purpose === 'review') - Number(a.purpose === 'review') || x.readyAt! - y.readyAt!)
      || a.task.id.localeCompare(b.task.id);
  });
}
