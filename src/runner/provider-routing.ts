import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export interface ProviderRoutes { version: 1; routes: Record<string, string> }
/** Explicit ownership, never automatic failover: an unavailable native node must not duplicate work in Paseo. */
export function readProviderRoutes(home: string): ProviderRoutes {
  let raw: string;
  try { raw = readFileSync(join(home, 'private', 'runtime-routes.json'), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {version: 1, routes: {}}; throw e; }
  const value = JSON.parse(raw);
  if (value?.version !== 1 || !value.routes || Array.isArray(value.routes) || typeof value.routes !== 'object' ||
    Object.entries(value.routes).some(([provider, runner]) => !['claude','factory-droid','codex','codex-cloud','devin-cloud','jules'].includes(provider) ||
      typeof runner !== 'string' || !/^native:[a-zA-Z0-9_-]+$/.test(runner))) throw new Error('runtime-routes.json 配置无效，停止新派工');
  return value;
}
export function ownsProvider(routes: ProviderRoutes, provider: string, runner?: string): boolean {
  return !routes.routes[provider] || routes.routes[provider] === runner;
}
