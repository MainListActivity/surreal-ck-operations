export const dispatchRecoverySnapshotSql = `    LET $a = SELECT id, request, state, revision, employee, task, kind, delivery, fence, message, messageRevision,
      bodyHash, agent, activationRequired, activation_state, result_confirmed, result_action, result_version, result_audit
      FROM ONLY $attempt;
    IF $a = NONE { THROW 'dispatch attempt not found' };
    LET $t = SELECT id, state, version, current_employee, delivery_id, fence, lease_expires_at, dispatch_attempt, project, worktree
      FROM ONLY type::record('task', $a.task);
    LET $e = SELECT id, retired, revoked, paseo_agent_id, dispatch_attempt, active_task, wake_count
      FROM ONLY type::record('employee', $a.employee);
    LET $m = SELECT id, task, state, hold, dispatch_attempt, sent_to, sent_at,
      crypto::sha256(dispatch_body ?? '') AS dispatch_hash, crypto::sha256(sent_body ?? '') AS sent_hash
      FROM ONLY type::record('outbound_message', $a.message);
    LET $audit = IF $a.result_audit != NONE { SELECT id, task, actor, action, version FROM ONLY $a.result_audit } ELSE { NONE };
    LET $snapshot = { attempt: $a, task: $t, employee: $e, message: $m, audit: $audit };
`;
import type { CompanyDatabase } from './database.ts';
import { RecordId } from 'surrealdb';

/** Read-only operator evidence. No runtime calls, credential fields, bodies or mutation entry point.
 * A fingerprint identifies this observation, not an authorization token or execution CAS.
 * The eventual approved writer must recheck the entire read set in its own transaction.
 */
export async function inspectDispatchRecovery(db: CompanyDatabase, request: string) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(request)) throw new Error('Exact dispatch request ID required');
  const results = await db.db.query<Array<{
    request: string; fingerprint: string; snapshot: unknown; observed_at: unknown;
    runtime_evidence: string; cancellation: string; execution: string;
  } | undefined>>(`BEGIN;
    ${dispatchRecoverySnapshotSql}
    RETURN { request: $request, fingerprint: crypto::sha256(type::string($snapshot)), snapshot: $snapshot,
      observed_at: time::now(), runtime_evidence: 'unknown: exact request/turn receipt must be independently verified',
      cancellation: 'blocked: no authoritative non-execution or stopped-turn proof API',
      execution: 'disabled here: separate approved result-only finalizer required' };
    COMMIT;`, { attempt: new RecordId('dispatch_attempt', request), request });
  const report = results.find(value => value && typeof value === 'object' && 'fingerprint' in value);
  if (!report) throw new Error('Recovery inspection returned no snapshot');
  return report;
}
