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
  // Same identity contract as core's asId: a RecordId yields its bare id, and the fork's escaped `task:⟨uuid⟩`
  // rendering yields the uuid without the table prefix. The QA scope view is compared against bare ids in core
  // (the goal check) and used in page links, so a `goal:`-prefixed string would be refused as another goal.
  if (value instanceof RecordId) return String(value.id);
  const raw = String(value);
  const unescaped = raw.includes('⟨') ? raw.split('⟨').pop()!.replace('⟩', '') : raw;
  return unescaped.includes(':') ? unescaped.split(':').slice(1).join(':') : unescaped;
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
export interface QaDispatchAttempt { at?: string; ok?: boolean; error?: string }

/** Whole-pass dispatch availability, shared by the task read and the goal summary. */
export interface QaDispatchState {
  available: boolean; complete: boolean; checkedAt?: string; reason?: string;
  originalVerdicts?: number; originalReasons?: number; attemptAt?: string; attemptOk?: boolean;
}

/**
 * The last dispatch pass's availability, fail-closed. A missing observation, an incomplete snapshot, or a latest
 * write that failed or has no trusted success status is unavailable; the caller never presents it as complete.
 */
export const qaDispatchState = (observation: unknown, attempt?: QaDispatchAttempt): QaDispatchState => {
  const record = observation as { at?: string; verdicts?: unknown[]; complete?: boolean; reason?: string;
    originalVerdicts?: number; originalReasons?: number } | undefined;
  const base = {
    ...(record?.at ? { checkedAt: record.at } : {}),
    ...(record?.originalVerdicts !== undefined ? { originalVerdicts: record.originalVerdicts } : {}),
    ...(record?.originalReasons !== undefined ? { originalReasons: record.originalReasons } : {}),
    ...(attempt?.at ? { attemptAt: attempt.at } : {}),
    ...(attempt?.ok !== undefined ? { attemptOk: attempt.ok } : {}),
  };
  if (!record || !Array.isArray(record.verdicts)) {
    return { available: false, complete: false, reason: 'no dispatcher pass observation', ...base };
  }
  if (record.complete === false) {
    return { available: false, complete: false,
      reason: record.reason ?? 'the dispatch observation is incomplete; no partial snapshot is presented as complete', ...base };
  }
  if (attempt?.ok !== true) {
    return { available: false, complete: false,
      reason: attempt?.ok === false
        ? `the latest dispatch observation write failed${attempt.error ? `: ${attempt.error.slice(0, 200)}` : ''}; the stored snapshot is stale`
        : 'the dispatch observation has no trusted save status; availability is unknown',
      ...base };
  }
  return { available: true, complete: true, ...base };
};

/**
 * The last dispatcher pass's verdicts for one task, as the QA page sees them. The plugin writes the pass observation
 * (company_meta:dispatch_observation) so the MCP process reads the same conclusion instead of re-inventing one.
 * A complete observation keeps every verdict and every reason; an oversized pass is stored as complete=false with
 * no partial data, and a failed latest write leaves the previous snapshot explicitly stale. Absent, incomplete,
 * stale or task-not-in-pass is fail-closed: available=false, never a fabricated "dispatchable".
 */
export const qaDispatchFor = (observation: unknown, taskId: string, attempt?: QaDispatchAttempt): QaObservationDispatch => {
  const state = qaDispatchState(observation, attempt);
  const result = { source: 'dispatcher-pass', ...state };
  if (!state.complete) return result;
  const record = observation as { verdicts?: unknown[] } | undefined;
  const verdicts = (record?.verdicts ?? []).filter(value => (value as { taskId?: string })?.taskId === taskId);
  if (verdicts.length === 0) {
    return { ...result, available: false, reason: 'task was not in the latest dispatcher pass' };
  }
  return { ...result, available: true, verdicts: verdicts as QaObservationDispatch['verdicts'] };
};
