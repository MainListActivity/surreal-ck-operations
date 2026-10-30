/** Factory runs its native agent first; this orders only candidates already admitted by staffing rules. */
export const FACTORY_PROVIDER = 'factory-droid';
export function factoryFirst<T extends {provider?: string}>(rows: readonly T[]): T[] {
  return [...rows].sort((a,b)=>Number(b.provider===FACTORY_PROVIDER)-Number(a.provider===FACTORY_PROVIDER));
}

/** At most three pending work items are reserved for Factory across all roles/projects. */
export const FACTORY_WAIT_LIMIT = 3;
export interface FactoryQueueItem { key: string; createdAt?: number }

/** Stable FIFO, reconstructed from task facts on every pass; no model calls or external state. */
export function factoryQueue(items: readonly FactoryQueueItem[]): Map<string, number> {
  const ordered = [...items].sort((a,b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key));
  return new Map(ordered.map((item,index) => [item.key,index+1]));
}

export function leaveFactoryQueue(queue: Map<string, number>, key: string): void {
  queue.delete(key);
  let position=0;
  for(const id of queue.keys()) queue.set(id,++position);
}
