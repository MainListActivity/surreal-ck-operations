/**
 * 接口错误：把内部错误映射为 {ok:false, error:{code,message}} 与 HTTP 状态。
 * 错误码与状态的对应见 README。未知错误不回显细节，只给通用中文提示。
 */
import { CompanyError } from '../../src/core-errors.ts';
import { PendingJob } from './jobs.ts';

export type ApiErrorCode =
  | 'unauthorized' | 'forbidden' | 'invalid' | 'not_found' | 'conflict' | 'pending' | 'upstream_error' | 'unavailable';

export const STATUS_OF: Readonly<Record<ApiErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  invalid: 400,
  not_found: 404,
  conflict: 409,
  pending: 202,
  upstream_error: 502,
  unavailable: 503,
};

const CODE_OF: Readonly<Record<string, ApiErrorCode>> = {
  unauthorized: 'unauthorized',
  login_failed: 'unauthorized',
  forbidden: 'forbidden',
  invalid: 'invalid',
  response_too_large: 'invalid',
  not_found: 'not_found',
  conflict: 'conflict',
  worktree_busy: 'conflict',
  already_claimed: 'conflict',
  lease_expired: 'conflict',
  self_review: 'conflict',
  checkpoint_limit: 'conflict',
  payment_approval_required: 'conflict',
  limit_reached: 'conflict',
  snapshot_gone: 'conflict',
  retire_refused: 'conflict',
  temporarily_unavailable: 'unavailable',
  not_configured: 'unavailable',
  unavailable: 'unavailable',
  upstream_error: 'upstream_error',
};

/** 把 CompanyError 的错误码映射为接口错误码；未知的 CompanyError 视为冲突，其它错误视为上游失败。 */
export function apiCodeOf(error: unknown): ApiErrorCode {
  if (error instanceof CompanyError) return CODE_OF[error.code] ?? 'conflict';
  return 'upstream_error';
}

export interface FailureBody {
  ok: false;
  error: { code: ApiErrorCode; message: string; jobId?: string };
}

/**
 * 生成错误响应的状态与正文。执行端超时（PendingJob）返回 202：error.message 即任务号（契约如此），error.jobId 同值，
 * 之后用 ops.job.get 取结果。
 */
export function failureOf(error: unknown): { status: number; body: FailureBody } {
  if (error instanceof PendingJob) {
    return {
      status: STATUS_OF.pending,
      body: { ok: false, error: { code: 'pending', message: error.jobId, jobId: error.jobId } },
    };
  }
  const code = apiCodeOf(error);
  const message = error instanceof CompanyError ? error.message : '服务暂时出错，请稍后重试';
  if (!(error instanceof CompanyError)) console.error('owner-end error', error instanceof Error ? error.message : 'unknown');
  return { status: STATUS_OF[code], body: { ok: false, error: { code, message } } };
}
