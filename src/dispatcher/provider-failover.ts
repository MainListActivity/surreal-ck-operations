/** Runtime-supplied terminal evidence only. Transport timeout/unknown is not a rejection. */
export function unavailableProvider(outcome: { kind: string; error?: { code?: string; message: string } }): boolean {
  return outcome.kind === 'failed' && /\b(?:502|503)\b|\boverloaded_error\b|\bserver_overloaded\b/i
    .test(`${outcome.error?.code ?? ''} ${outcome.error?.message ?? ''}`);
}
export const PROVIDER_FAILURE_WINDOW_SECONDS = 30 * 60;
export const PROVIDER_FAILURE_LIMIT = 3; // original attempt plus at most two alternate providers
export interface ProviderFailure {
  delivery: string;
  phase: 'doing' | 'review';
  provider: string;
  at: number; // server seconds
  cause: 'quota' | 'unavailable';
}
/** A per-task, per-phase rolling budget, retained in the task row across runner restarts. */
export function providerRetryBlock(failures: readonly ProviderFailure[] | undefined, provider: string, phase: 'doing' | 'review', now: number): { reason: string; until: string } | undefined {
  const recent = (failures ?? []).filter(f => f.phase === phase && f.at > now - PROVIDER_FAILURE_WINDOW_SECONDS);
  const own = recent.filter(f => f.provider === provider);
  const blocked = recent.length >= PROVIDER_FAILURE_LIMIT ? recent : own;
  if (!blocked.length) return;
  const until = Math.min(...blocked.map(f => f.at)) + PROVIDER_FAILURE_WINDOW_SECONDS;
  return { reason: recent.length >= PROVIDER_FAILURE_LIMIT
    ? '本任务本阶段 30 分钟内已发生 3 次明确供应商失败，暂停切换，等待预算恢复'
    : '本任务本阶段已确认该供应商失败，优先分流其他合格供应商；冷却结束后可再探测',
    until: new Date(until * 1000).toISOString() };
}
