// QA 受限只读取证（SYS-DISP 7454fc89）的纯辅助：范围行→视图、哈希、TTL 常量与 dispatch 快照投影。
// 授权与读取逻辑在 core（同一评估器/同一 ACL 之外的单一路径），这里不接触数据库。
import { createHash } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { QaObservationDispatch, QaObservationScopeView } from './contracts.ts';

export const QA_OBSERVATION_MAX_SUBJECTS = 50;
export const QA_OBSERVATION_MIN_TTL_MS = 60_000;
export const QA_OBSERVATION_MAX_TTL_MS = 24 * 3_600_000;
export const QA_OBSERVATION_CODE_TTL_MS = 5 * 60_000;
export const QA_OBSERVATION_TOKEN_TTL_MS = 30 * 60_000;
/** A task context up to this size is returned inline; longer ones are read in byte segments with qa_observation_text. */
export const QA_OBSERVATION_CONTEXT_INLINE_BYTES = 8 * 1024;

/** The stored scope row. Kept structural so core can select it without another module's mapper. */
export interface QaObservationScopeRow {
  id: RecordId;
  goal: RecordId;
  deployment_task: RecordId;
  qa_employee: string;
  lease_holder: string;
  lease_fence: number;
  subjects: string[];
  status: string;
  expires_at: string;
  version: number;
  reason: string;
  created_by: string;
  created_at: string;
  revoked_at?: string;
  revoked_by?: string;
  revoked_reason?: string;
}

/** The stored session row: a one-time login code, then a browser-only restricted token (hashes only). */
export interface QaObservationSessionRow {
  id: RecordId;
  scope: RecordId;
  qa_employee: string;
  code_hash: string;
  token_hash?: string;
  state: string;
  code_expires_at: string;
  expires_at?: string;
  created_at: string;
  used_at?: string;
}

/** A SurrealDB record id as the bare id, with or without the ⟨⟩ wrapping. */
export const qaId = (value: unknown): string => {
  const text = String(value);
  return text.includes('⟨') ? text.split('⟨').pop()!.replace('⟩', '') : text;
};

export const qaHash = (value: string): string => createHash('sha256').update(value).digest('hex');

export const qaScopeView = (row: QaObservationScopeRow): QaObservationScopeView => ({
  id: qaId(row.id),
  goalId: qaId(row.goal),
  deploymentTaskId: qaId(row.deployment_task),
  qaEmployee: row.qa_employee,
  leaseHolder: row.lease_holder,
  leaseFence: row.lease_fence,
  subjects: [...(row.subjects ?? [])],
  status: row.status === 'revoked' ? 'revoked' : 'active',
  expiresAt: row.expires_at,
  version: row.version,
  reason: row.reason,
  createdAt: row.created_at,
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  ...(row.revoked_reason ? { revokedReason: row.revoked_reason } : {}),
});

/**
 * The last dispatcher pass's verdicts for one task, as the QA page sees them. The plugin writes the pass observation
 * (company_meta:dispatch_observation) so the MCP process reads the same conclusion instead of re-inventing one.
 * Absent or task-not-in-pass is fail-closed: available=false, never a fabricated "dispatchable".
 */
export const qaDispatchFor = (observation: unknown, taskId: string): QaObservationDispatch => {
  const record = observation as { at?: string; verdicts?: unknown[] } | undefined;
  if (!record || !Array.isArray(record.verdicts)) {
    return { available: false, source: 'dispatcher-pass', reason: 'no dispatcher pass observation' };
  }
  const verdicts = record.verdicts.filter(value => (value as { taskId?: string })?.taskId === taskId);
  if (verdicts.length === 0) {
    return { available: false, source: 'dispatcher-pass', checkedAt: record.at, reason: 'task was not in the latest dispatcher pass' };
  }
  return { available: true, source: 'dispatcher-pass', checkedAt: record.at, verdicts: verdicts as QaObservationDispatch['verdicts'] };
};
