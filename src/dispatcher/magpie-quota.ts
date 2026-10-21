/**
 * Magpie is the owner's local subscription gateway. It holds every provider's live remaining
 * allowance and serves it at `GET /v1/magpie/quotas` on loopback (measured 0.04 s, no auth).
 *
 * Paseo's own usage list reports only claude/codex/grok, so a Factory subscription whose
 * monthly allowance ran out never reached the dispatcher's quota breaker: the provider looked
 * healthy until its sessions failed with `model_usage_exhausted`, and that failure path then
 * retired the instance and struck the employee definition. Reading magpie closes the gap for
 * exactly the providers Paseo does not report.
 *
 * Everything here is pure except `readMagpieQuotas`, which fails open (`undefined`) so a
 * missing, slow or reconfigured magpie can never block dispatch.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One allowance window as magpie serves it. `remaining` is a 0-100 percentage. */
export interface MagpieWindow {
  name: string;
  used?: number | null;
  remaining?: number | null;
  resetsAt?: string | null;
  /** magpie's own verdict: "low" near the limit, "log" over it. Informational only. */
  holdsWhy?: string | null;
}

export interface MagpieProvider {
  provider: string;
  name?: string;
  user?: string;
  kind?: string;
  error?: string | null;
  windows?: MagpieWindow[];
  readAt?: string;
}

/**
 * The entry shape `plugin/server/dispatch.ts` already turns into a `company_meta:quota_*` row
 * (`ProviderUsageEntry`). Structural so the plugin can pass it through unchanged.
 */
export interface MagpieUsageEntry {
  providerId: string;
  displayName: string;
  planLabel: string | null;
  status: 'available' | 'unavailable' | 'error';
  windows: Array<{ id: string; label: string; remainingPct: number; resetsAt: string | null }>;
}

/** magpie names a provider after its CLI; the company names it by the def's `provider` field. */
const PROVIDER_ALIASES: Record<string, string> = { factory: 'factory-droid' };

const DEFAULT_BASE = 'http://127.0.0.1:3425';

/**
 * Window names → the ids `isLongWindow` (/week|month|billing|cycle/) already classifies.
 * "7 days" has to become `weekly` and "30 days" `monthly`: left as written they would read as
 * short windows and the weekly floor would never fire on the allowance that actually ran out.
 * The Factory Core allowance keeps its own prefix so the two lines stay distinguishable.
 */
export function windowId(name: string): string {
  const core = /^droid\s+core\s*[·:]\s*/i.test(name);
  const bare = name.replace(/^droid\s+core\s*[·:]\s*/i, '').trim();
  const match = /(\d+)\s*(hour|hours|day|days|week|weeks|month|months)\b/i.exec(bare);
  const count = match ? Number(match[1]) : 0;
  const unit = match ? match[2]!.toLowerCase() : '';
  let id: string;
  if (unit.startsWith('hour')) id = count === 5 ? 'five_hour' : `${count}_hour`;
  else if (unit.startsWith('week') || (unit.startsWith('day') && count === 7)) id = 'weekly';
  else if (unit.startsWith('month') || (unit.startsWith('day') && count >= 28)) id = 'monthly';
  else if (unit.startsWith('day')) id = `${count}_day`;
  else id = bare.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'window';
  return core ? `core_${id}` : id;
}

/** One magpie provider → the entry the quota pipeline stores; undefined when it reports nothing usable. */
export function toUsageEntry(provider: MagpieProvider): MagpieUsageEntry | undefined {
  const id = String(provider.provider ?? '').trim();
  // Federated ids (`remote-magpie/…`) never match a def.provider, and a slash is not a
  // provider id the company uses: dropping them keeps the roster free of dead rows.
  if (!id || id.includes('/')) return undefined;
  const windows = (provider.windows ?? [])
    .filter(w => typeof w.remaining === 'number' && Number.isFinite(w.remaining))
    .map(w => ({
      id: windowId(w.name),
      label: w.name,
      remainingPct: Math.max(0, Math.min(100, Number(w.remaining))),
      resetsAt: w.resetsAt ?? null,
    }));
  if (!windows.length) return undefined;
  return {
    providerId: PROVIDER_ALIASES[id] ?? id,
    displayName: provider.name ?? id,
    planLabel: provider.kind ?? null,
    status: provider.error ? 'error' : 'available',
    windows,
  };
}

export function usageEntriesFrom(providers: readonly MagpieProvider[]): MagpieUsageEntry[] {
  return providers.map(toUsageEntry).filter((e): e is MagpieUsageEntry => e !== undefined);
}

/**
 * Where magpie serves the gateway: `MAGPIE_ADDR` wins (magpie's own documented override),
 * then the address magpie last wired into Claude Code, then the built-in default.
 */
export function magpieBase(env: NodeJS.ProcessEnv = process.env, readFile: (path: string) => string = p => readFileSync(p, 'utf8')): string {
  const explicit = (env.MAGPIE_ADDR ?? '').trim();
  if (explicit) return /^https?:\/\//i.test(explicit) ? explicit : `http://${explicit}`;
  try {
    const stash = readFile(join(homedir(), '.config', 'magpie', 'stash.json'));
    const wired = (JSON.parse(stash) as Record<string, unknown>)['claude.wired_at'];
    if (typeof wired === 'string' && /^https?:\/\//i.test(wired)) return wired;
  } catch { /* magpie absent or never wired: fall through to the default */ }
  return DEFAULT_BASE;
}

export interface ReadMagpieOptions {
  base?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Reads magpie's live snapshot. `undefined` means "no answer" — not "no quota": the caller
 * keeps whatever the last good snapshot said, exactly like a failed Paseo usage read.
 */
export async function readMagpieQuotas(options: ReadMagpieOptions = {}): Promise<MagpieUsageEntry[] | undefined> {
  const base = options.base ?? magpieBase();
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const reply = await doFetch(`${base.replace(/\/+$/, '')}/v1/magpie/quotas`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });
    if (!reply.ok) return undefined;
    const body = await reply.json() as { data?: unknown } | unknown[];
    const providers = Array.isArray(body) ? body : (body as { data?: unknown }).data;
    if (!Array.isArray(providers)) return undefined;
    return usageEntriesFrom(providers as MagpieProvider[]);
  } catch {
    return undefined;
  }
}

/** Providers magpie reports that the Paseo usage list does not — the merge the plugin performs. */
export function missingFrom(paseo: readonly { providerId: string }[], magpie: readonly MagpieUsageEntry[]): MagpieUsageEntry[] {
  const known = new Set(paseo.map(p => p.providerId));
  return magpie.filter(entry => !known.has(entry.providerId));
}
