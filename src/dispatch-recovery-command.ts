import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import { dispatchRecoverySnapshotSql, inspectDispatchRecovery } from './dispatch-recovery-inspection.ts';
import { finalizeApprovedDispatch } from './dispatch-recovery-finalize.ts';

/** The CLI supplies a real terminal confirmation callback; no unattended approval flag. */
export async function confirmAndFinalizeDispatch(db: CompanyDatabase, request: string, operator: string,
  confirm: (report: Awaited<ReturnType<typeof inspectDispatchRecovery>>, phrase: string) => Promise<string>) {
  if (!operator.trim() || operator.length > 160) throw new Error('Operator identity required');
  const report = await inspectDispatchRecovery(db, request);
  const snapshot = report.snapshot as { attempt?: { agent?: string; result_confirmed?: boolean; state?: string } };
  const agent = snapshot.attempt?.agent;
  if (!agent || snapshot.attempt?.result_confirmed !== true || snapshot.attempt.state !== 'pending') throw new Error('Only an exact agent with a committed result can be manually finalized');
  const phrase = `FINALIZE ${request} ${report.fingerprint}`;
  if (await confirm(report, phrase) !== phrase) throw new Error('Confirmation canceled; no approval or finalization written');
  const operation = randomUUID(), approval = randomUUID();
  const input = { request, agent, fingerprint: report.fingerprint, operation, approval };
  // Recheck AFTER the user confirms. Never silently replace the approved fingerprint.
  try { await db.db.query(`BEGIN;
    ${dispatchRecoverySnapshotSql}
    IF crypto::sha256(type::string($snapshot)) != $fingerprint { THROW 'approved snapshot moved; inspect and confirm again' };
    IF $a.agent != $agent OR $a.result_confirmed != true OR $a.state != 'pending' { THROW 'approved result changed' };
    CREATE ONLY $approval_id CONTENT { request:$request, agent:$agent, fingerprint:$fingerprint, operation:$operation,
      action:'finalize_result', operator:$operator, confirmation_ref:$confirmation, expires_at:time::now()+5m };
    COMMIT;`, { ...input, operator, confirmation:`terminal:${operation}`, attempt:new RecordId('dispatch_attempt',request), approval_id:new RecordId('dispatch_recovery_approval',approval) });
  // If the response is lost, expose the precise operation. Never repeat the confirmation automatically.
  return { input, receipt: await finalizeApprovedDispatch(db,input) }; }
  catch (error) { throw new Error(`Recovery not confirmed; inspect dispatch_recovery_receipt:${operation} before retrying. Approval ${approval}. ${error instanceof Error ? error.message : String(error)}`); }
}
