/**
 * Per-task cost: tokens, money and time each finished task consumed, read from Magpie's per-request usage rows and
 * kept in task_cost so the numbers outlive model_execution retention.
 *
 * Attribution: the gateway sends every employee request with x-magpie-session = sck-<digest(task:employee:fence:phase:tier)>
 * (model-routing/gateway.ts), so a task's sessions are recomputed from its model_execution rows and Magpie's rows are
 * matched by exact session. Requests Magpie could not price are counted, never priced at zero silently (`unpriced`).
 */
import { RecordId, type Surreal } from 'surrealdb';
import { digest } from './model-routing/policy.ts';
import { magpieBase } from './dispatcher/magpie-quota.ts';

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

export const sessionOf = (s: { task: string; employee: string; fence: number; phase: string; tier: string }) =>
  `sck-${digest(`${s.task}:${s.employee}:${s.fence}:${s.phase}:${s.tier}`)}`;

/** Roll Magpie rows up by session owner. Rows whose session belongs to no listed lease are ignored. */
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

/** Every Magpie request row of one session in the 30-day window, paged; undefined when Magpie cannot be read. */
export function magpieSessionRows(base = magpieBase(), fetchImpl: typeof fetch = fetch): UsageFetch {
  return async session => {
    const out: UsageRow[] = [];
    for (let offset = 0, page = 0; page < 40; page++) {
      const q = new URLSearchParams({ period: '30d', offset: String(offset), limit: '500', q: session });
      let body: { rows?: UsageRow[]; total?: number };
      try {
        const res = await fetchImpl(new URL(`/v1/magpie/usage/requests?${q}`, base), { signal: AbortSignal.timeout(15_000) });
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
 * task has no leased model traffic recorded or Magpie cannot be read (the next pass retries).
 */
export async function recordTaskCost(db: Surreal, taskId: string, fetchRows: UsageFetch = magpieSessionRows()): Promise<TaskCost | undefined> {
  const task = new RecordId('task', taskId);
  const [leases, , , time] = await db.query<[
    Array<{ employee: string; fence: number; phase: string; tier: string }>, unknown, unknown,
    { created?: number | null; done?: number | null } | undefined,
  ]>(`SELECT employee, fence, phase, tier FROM model_execution WHERE task = $task AND phase != NONE AND tier != NONE GROUP BY employee, fence, phase, tier;
      LET $accepted = (SELECT VALUE at FROM audit WHERE task = $task AND action = 'accept' ORDER BY at DESC LIMIT 1)[0];
      LET $row = SELECT created_at FROM ONLY $task;
      RETURN { created: IF type::is_datetime($row.created_at) THEN time::unix($row.created_at) END,
        done: IF type::is_datetime($accepted) THEN time::unix($accepted) END };`,
    { task });
  if (!leases?.length) return undefined;
  const sessions = new Map<string, string>();
  for (const lease of leases) sessions.set(sessionOf({ task: taskId, ...lease }), lease.employee);
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
export async function recordPendingTaskCosts(db: Surreal, opts: { limit?: number; fetchRows?: UsageFetch } = {}): Promise<number> {
  const [ids] = await db.query<[RecordId[]]>(
    `SELECT VALUE id FROM task WHERE state = 'done' AND created_at > time::now() - 30d
       AND id NOT IN (SELECT VALUE task FROM task_cost) ORDER BY created_at DESC LIMIT $limit;`,
    { limit: opts.limit ?? 20 });
  const fetchRows = opts.fetchRows ?? magpieSessionRows();
  let written = 0;
  for (const rid of ids ?? []) if (await recordTaskCost(db, String(rid.id), fetchRows)) written++;
  return written;
}

export async function readTaskCost(db: Surreal, taskId: string): Promise<TaskCost | undefined> {
  const row = await db.select<{ cost?: TaskCost }>(new RecordId('task_cost', taskId));
  return row?.cost;
}

/** Median USD and elapsed seconds of other scored tasks of the same complexity; undefined below `min` samples. */
export async function costBaseline(db: Surreal, complexity: number, exceptTask: string, min = 5): Promise<{ usd: number; elapsedSeconds: number; samples: number } | undefined> {
  const [rows] = await db.query<[Array<{ usd?: number; elapsed?: number }>]>(
    `SELECT cost.usd AS usd, cost.elapsedSeconds AS elapsed FROM task_cost
       WHERE complexity = $complexity AND task != $task AND at > time::now() - 60d ORDER BY at DESC LIMIT 200;`,
    { complexity, task: new RecordId('task', exceptTask) });
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
  const usd = (rows ?? []).map(r => r.usd).filter((v): v is number => typeof v === 'number' && v > 0);
  const elapsed = (rows ?? []).map(r => r.elapsed).filter((v): v is number => typeof v === 'number' && v > 0);
  if (usd.length < min || elapsed.length < min) return undefined;
  return { usd: median(usd), elapsedSeconds: median(elapsed), samples: Math.min(usd.length, elapsed.length) };
}
