import { sameSubscription } from '../provider-admission.ts';

/** Factory runs its native agent first; this orders only candidates already admitted by staffing rules. */
export const FACTORY_PROVIDER = 'factory-droid';

/**
 * The subscription the boss prefers for new work. `company_meta:config.preferred_provider`
 * overrides it (workforce CompanyConfig.preferredProvider); '' means no preference and every
 * eligible candidate competes purely by weight.
 */
export type PreferredProvider = string;

export function factoryFirst<T extends {provider?: string}>(rows: readonly T[], provider: PreferredProvider = FACTORY_PROVIDER): T[] {
  // 优先订阅按订阅合并：factory-paseo 与 factory-droid 同一订阅，谁优先两边都算优先。
  return [...rows].sort((a,b)=>Number(sameSubscription(b.provider,provider))-Number(sameSubscription(a.provider,provider)));
}

/** Owner-facing text for a task held back while the preferred subscription still has quota. */
export function preferredWaitText(provider: string): string {
  return `优先订阅 ${provider} 仍有额度，本任务保留等待 ${provider}；已有 ${FACTORY_WAIT_LIMIT} 个等待任务后新任务可分流`;
}

/** At most three pending work items are reserved for the preferred provider across all roles/projects. */
export const FACTORY_WAIT_LIMIT = 3;
export interface FactoryQueueItem { key: string; createdAt?: number; rank?: number }

/** Stable FIFO, reconstructed from task facts on every pass; no model calls or external state. */
export function factoryQueue(items: readonly FactoryQueueItem[]): Map<string, number> {
  const ordered = [...items].sort((a,b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key));
  return new Map(ordered.map((item,index) => [item.key,index+1]));
}

export function leaveFactoryQueue(queue: Map<string, number>, key: string): void {
  queue.delete(key);
  let position=0;
  for(const id of queue.keys()) queue.set(id,++position);
}
