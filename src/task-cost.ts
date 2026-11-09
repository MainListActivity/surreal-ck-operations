/**
 * Per-task cost: tokens, money and time each finished task consumed, read from the VPS magpie's per-request usage rows
 * and kept in task_cost.
 *
 * Attribution: every employee session sends x-magpie-session = sessionKey(task, employee) (model-routing/magpie-contract.ts).
 * A task's sessions are therefore the employees who claimed it (audit action 'claim'), and magpie's rows match by that
 * exact session. Requests magpie could not price are counted, never priced at zero silently (`unpriced`).
 */
import { RecordId, type Surreal } from 'surrealdb';
import { MAGPIE_BASE, sessionKey } from './model-routing/magpie-contract.ts';

export interface UsageRow {
  session?: string; t?: string; model?: string; in?: number; out?: number; cache_read?: number; cache_write?: number;
  ms?: number; status?: number; cost?: number; priced?: boolean;
}

export interface CostTotals {
  requests: number; failed: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  /** USD over the priced requests. */
  usd: number; unpriced: number; modelMs: number;
}

export interface TaskCost extends CostTotals {
  taskId: string;
  /** Wall time from creation to acceptance, in seconds; undefined when either end is unknown. */
  elapsedSeconds?: number;
  byEmployee: Record<string, CostTotals>;
  byModel: Record<string, { requests: number; usd: number }>;
  sessions: number;
  /** Sessions Magpie's window no longer covered (older than its retention): the totals are a lower bound then. */
  complete: boolean;
  source: 'magpie-requests';
}

export const emptyTotals = (): CostTotals => ({ requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, unpriced: 0, modelMs: 0 });

const n = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

export function addRow(into: CostTotals, row: UsageRow): void {
  into.requests++;
  if ((row.status ?? 200) >= 400) into.failed++;
  into.inputTokens += n(row.in); into.outputTokens += n(row.out);
  into.cacheReadTokens += n(row.cache_read); into.cacheWriteTokens += n(row.cache_write);
  into.modelMs += n(row.ms);
  if (row.priced === false) into.unpriced++;
  else into.usd += n(row.cost);
}

/** Roll Magpie rows up by session owner. Rows whose session belongs to no listed employee are ignored. */
export function rollUp(taskId: string, sessions: Map<string, string>, rows: Iterable<UsageRow>, elapsedSeconds?: number, complete = true): TaskCost {
  const total = emptyTotals();
  const byEmployee: Record<string, CostTotals> = {};
  const byModel: TaskCost['byModel'] = {};
  for (const row of rows) {
    const employee = row.session ? sessions.get(row.session) : undefined;
    if (!employee) continue;
    addRow(total, row);
    addRow(byEmployee[employee] ??= emptyTotals(), row);
    const model = row.model || 'unknown';
    const m = byModel[model] ??= { requests: 0, usd: 0 };
    m.requests++;
    if (row.priced !== false) m.usd += n(row.cost);
  }
  const round = (t: CostTotals) => { t.usd = Math.round(t.usd * 1e6) / 1e6; };
  round(total); for (const t of Object.values(byEmployee)) round(t);
  for (const m of Object.values(byModel)) m.usd = Math.round(m.usd * 1e6) / 1e6;
  return { taskId, ...total, ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}), byEmployee, byModel,
    sessions: sessions.size, complete, source: 'magpie-requests' };
}

export type UsageFetch = (session: string) => Promise<UsageRow[] | undefined>;

/**
 * Every magpie request row of one session in the 30-day window, paged; undefined when magpie cannot be read.
 * `headers` carries the employee key: the usage endpoint is authenticated like any other employee request.
 */
export function magpieSessionRows(headers: Record<string, string>, base = MAGPIE_BASE, fetchImpl: typeof fetch = fetch): UsageFetch {
  return async session => {
    const out: UsageRow[] = [];
    for (let offset = 0, page = 0; page < 40; page++) {
      const q = new URLSearchParams({ period: '30d', offset: String(offset), limit: '500', q: session });
      let body: { rows?: UsageRow[]; total?: number };
      try {
        // A string join, not new URL(path, base): the URL constructor would drop the base path (/ofm) of the VPS relay.
        const res = await fetchImpl(`${base.replace(/\/+$/, '')}/v1/magpie/usage/requests?${q}`, { headers, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return undefined;
        body = await res.json() as typeof body;
      } catch { return undefined; }
      const rows = Array.isArray(body.rows) ? body.rows : [];
      // `q` is a text search: keep the exact session only.
      out.push(...rows.filter(row => row.session === session));
      offset += rows.length;
      if (!rows.length || offset >= (body.total ?? 0)) break;
    }
    return out;
  };
}

/**
 * Compute and persist one task's cost. Idempotent: the row is replaced. Returns undefined, writing nothing, when the
 * task has no employee claim recorded or magpie cannot be read (the next pass retries).
 */
export async function recordTaskCost(db: Surreal, taskId: string, fetchRows: UsageFetch): Promise<TaskCost | undefined> {
  const task = new RecordId('task', taskId);
  const [claims, , , time] = await db.query<[
    Array<{ actor: RecordId | string }>, unknown, unknown,
    { created?: number | null; done?: number | null } | undefined,
  ]>(`SELECT actor FROM audit WHERE task = $task AND action = 'claim' GROUP BY actor;
      LET $accepted = (SELECT VALUE at FROM audit WHERE task = $task AND action = 'accept' ORDER BY at DESC LIMIT 1)[0];
      LET $row = SELECT created_at FROM ONLY $task;
      RETURN { created: IF type::is_datetime($row.created_at) THEN time::unix($row.created_at) END,
        done: IF type::is_datetime($accepted) THEN time::unix($accepted) END };`,
    { task });
  const employees = [...new Set((claims ?? []).map(row => String(row.actor instanceof RecordId ? row.actor.id : row.actor).replace(/^employee:/, '')))];
  if (!employees.length) return undefined;
  const sessions = new Map<string, string>();
  for (const employee of employees) sessions.set(sessionKey(taskId, employee), employee);
  const rows: UsageRow[] = [];
  let complete = true;
  for (const session of sessions.keys()) {
    const got = await fetchRows(session);
    if (got === undefined) return undefined;
    if (!got.length) complete = false;
    rows.push(...got);
  }
  const elapsed = time?.created && time?.done && time.done >= time.created ? time.done - time.created : undefined;
  const cost = rollUp(taskId, sessions, rows, elapsed, complete);
  await db.query('UPSERT $id CONTENT { task: $task, cost: $cost, at: time::now() } RETURN NONE;',
    { id: new RecordId('task_cost', taskId), task, cost });
  return cost;
}

/** Cost rows of finished tasks not yet recorded, newest first, bounded; for the lifecycle pass. */
export async function recordPendingTaskCosts(db: Surreal, opts: { limit?: number; fetchRows: UsageFetch }): Promise<number> {
  const [ids] = await db.query<[RecordId[]]>(
    `SELECT VALUE id FROM task WHERE state = 'done' AND created_at > time::now() - 30d
       AND id NOT IN (SELECT VALUE task FROM task_cost) ORDER BY created_at DESC LIMIT $limit;`,
    { limit: opts.limit ?? 20 });
  let written = 0;
  for (const rid of ids ?? []) if (await recordTaskCost(db, String(rid.id), opts.fetchRows)) written++;
  return written;
}

export async function readTaskCost(db: Surreal, taskId: string): Promise<TaskCost | undefined> {
  const row = await db.select<{ cost?: TaskCost }>(new RecordId('task_cost', taskId));
  return row?.cost;
}

/** The owner's cost list: settled tasks in a window, newest first. */
export const COST_LIST_SQL = `SELECT task, task.title AS title, cost, at
  FROM task_cost WHERE at > time::now() - type::duration($span) ORDER BY at DESC LIMIT 200;`;
