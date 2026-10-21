// The clock of one request (SYS01 M1). A snapshot-backed answer reaches its caller within REPLY_CEILING_MS of the request's arrival,
// whatever runs before the core is called: the transport stamps the arrival and names the tool, the core counts its builds and reads
// from that arrival, and the transport cuts the answer at the same moment. A cut answer is refused as recoverable temporarily_unavailable.
import { AsyncLocalStorage } from 'node:async_hooks';
import { CompanyError } from './core-errors.ts';
import { REPLY_CEILING_MS, untilAt } from './snapshot-store.ts';

interface Arrival { arrivedAt: number; tool?: string }

const arrivals = new AsyncLocalStorage<Arrival>();

/** The tools whose answers are snapshot-backed listings, and so bound by the reply ceiling. */
export const SNAPSHOT_TOOLS: ReadonlySet<string> = new Set(['get_context', 'get_task_history', 'list_worktrees']);

/** Serves one request that arrived at `arrivedAt` (default: now). A request already being served keeps its own arrival. */
export function arriving<T>(serve: () => T, arrivedAt = Date.now()): T {
  return arrivals.getStore() === undefined ? arrivals.run({ arrivedAt }, serve) : serve();
}

/** Names the tool the request being served calls, so that its ceiling applies. */
export function noteTool(tool: string | undefined): void {
  const arrival = arrivals.getStore();
  if (arrival) arrival.tool = tool;
}

/** The tool the request being served calls, if any. */
export function currentTool(): string | undefined {
  return arrivals.getStore()?.tool;
}

/** When the request being served arrived; now when none is being served (tests and measurements call the core directly). */
export function arrivedAt(): number {
  return arrivals.getStore()?.arrivedAt ?? Date.now();
}

/**
 * Answers a snapshot-backed call within the reply ceiling of its arrival, or refuses it as recoverable. The work does not start past
 * the ceiling, and it is cut at it. A build inside the work ends by its own deadline, which lies before the ceiling.
 */
export async function withinReplyCeiling<T>(work: () => Promise<T>): Promise<T> {
  const at = arrivedAt() + REPLY_CEILING_MS;
  const refused = (): CompanyError => new CompanyError('temporarily_unavailable',
    `the answer was not ready within ${Math.round(REPLY_CEILING_MS / 1000)} seconds of the request; narrow the query (state, goalId, role, since or fields) or read it in pages, then retry`, true);
  if (Date.now() >= at) throw refused();
  const answer = await untilAt(work().then(value => ({ value })), at);
  if (answer === undefined) throw refused();
  return answer.value;
}
