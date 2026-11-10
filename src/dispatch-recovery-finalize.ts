import type { CompanyDatabase } from './database.ts';
import { RecordId } from 'surrealdb';
import { dispatchRecoverySnapshotSql } from './dispatch-recovery-inspection.ts';
import { dispatchFinalizationSql } from './dispatch-finalization.ts';

/** No external call. Approval must already exist from a trusted, separately confirmed
 * operator path. This API cannot mint approvals, cancel, adopt an unknown agent or resend.
 * Only a genuine committed business result qualifies for manual completion.
 */
export async function finalizeApprovedDispatch(db: CompanyDatabase, input: {
  request: string; agent: string; approval: string; operation: string; fingerprint: string;
}) {
  for (const key of ['request', 'approval', 'operation'] as const) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input[key])) throw new Error(`Exact ${key} required`);
  }
  if (!input.agent || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new Error('Exact agent and snapshot fingerprint required');
  const results = await db.db.query<unknown[]>(`BEGIN;
    LET $receipt = SELECT * FROM ONLY $receipt_id;
    IF $receipt != NONE {
      IF $receipt.request != $request OR $receipt.agent != $agent OR $receipt.approval != $approval_id OR $receipt.fingerprint != $fingerprint { THROW 'recovery replay identity conflict' };
      RETURN $receipt;
    } ELSE {
      LET $approval = SELECT * FROM ONLY $approval_id;
      IF $approval = NONE OR $approval.action != 'finalize_result' OR $approval.request != $request
        OR $approval.agent != $agent OR $approval.fingerprint != $fingerprint OR $approval.operation != $operation
        OR $approval.expires_at <= time::now() OR $approval.expires_at = NONE OR $approval.used_by != NONE
        OR $approval.confirmation_ref = NONE OR $approval.confirmation_ref = '' OR $approval.operator = NONE OR $approval.operator = '' {
        THROW 'recovery approval missing, expired or mismatched';
      };
      ${dispatchRecoverySnapshotSql}
      IF crypto::sha256(type::string($snapshot)) != $fingerprint { THROW 'recovery snapshot moved' };
      IF $a.result_confirmed != true OR $a.agent != $agent { THROW 'manual recovery requires committed result and exact agent' };
      ${dispatchFinalizationSql}
      CREATE ONLY $receipt_id CONTENT { request: $request, agent: $agent, approval: $approval_id, fingerprint: $fingerprint,
        operator: $approval.operator, confirmation_ref: $approval.confirmation_ref, action: 'finalize_result', at: time::now() };
      UPDATE ONLY $approval_id SET used_by = $receipt_id, used_at = time::now();
      RETURN SELECT * FROM ONLY $receipt_id;
    };
    COMMIT;`, { ...input, attempt: new RecordId('dispatch_attempt', input.request),
      approval_id: new RecordId('dispatch_recovery_approval', input.approval), receipt_id: new RecordId('dispatch_recovery_receipt', input.operation) });
  const receipt = results.find(value => value && typeof value === 'object' && 'action' in value);
  if (!receipt) throw new Error('Recovery returned no receipt; inspect the exact operation before retrying');
  return receipt;
}
