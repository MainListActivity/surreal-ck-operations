import type { Surreal } from 'surrealdb';

/**
 * Retention for the control plane's operational exhaust. Business history (task, goal, decision audit, scorecards,
 * model_scorecard) is never pruned here; these rules only drop rows whose only reader has a bounded window:
 *  - worktree_audit: read by list_worktree_audits for recent reclaim decisions;
 *  - idempotency: replayed only by a retry of the same write;
 *  - outbox: consumed by sequence; `revoked` rows also name eval participants until the task is scored;
 *  - model_execution: read by eval for tasks not yet scored; a scored task keeps its model_scorecard rollup;
 *  - ops_* audit: shown in the history of open tasks only.
 * Each rule deletes in bounded batches so one pass never holds a long transaction.
 */
export interface RetentionRule { table: string; days: number; where: string }

export const RETENTION_RULES: RetentionRule[] = [
  { table: 'worktree_audit', days: 14, where: 'at < $cutoff' },
  { table: 'idempotency', days: 14, where: 'at = NONE OR at < $cutoff' },
  { table: 'outbox', days: 14, where: "at < $cutoff AND (kind != 'revoked' OR task.evaluated_at != NONE)" },
  { table: 'model_execution', days: 7, where: 'at < $cutoff AND (task = NONE OR task.evaluated_at != NONE)' },
  { table: 'audit', days: 30, where: "string::starts_with(action, 'ops_') AND at < $cutoff AND (task = NONE OR task.state = 'done')" },
];

const BATCH = 2000;

export async function pruneOperationalData(db: Surreal, opts: { now?: Date; batches?: number; rules?: RetentionRule[] } = {}): Promise<Record<string, number>> {
  const now = opts.now ?? new Date();
  const removed: Record<string, number> = {};
  // Rows written before idempotency carried a timestamp take the stamp of the result they cached, when it has one;
  // the rest are older than any retry window and fall to the `at = NONE` arm.
  await db.query(`UPDATE idempotency SET at = result.updated_at ?? result.created_at
    WHERE at = NONE AND type::is_datetime(result.updated_at ?? result.created_at) RETURN NONE;`);
  for (const rule of opts.rules ?? RETENTION_RULES) {
    const cutoff = new Date(now.getTime() - rule.days * 86_400_000);
    let total = 0;
    for (let i = 0; i < (opts.batches ?? 50); i++) {
      const [ids] = await db.query<[unknown[]]>(`SELECT VALUE id FROM type::table($table) WHERE ${rule.where} LIMIT ${BATCH};`, { table: rule.table, cutoff });
      if (!ids?.length) break;
      await db.query('DELETE $ids RETURN NONE;', { ids });
      total += ids.length;
      if (ids.length < BATCH) break;
    }
    if (total) removed[rule.table] = total;
  }
  return removed;
}
