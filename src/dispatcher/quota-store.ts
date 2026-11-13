/**
 * Reading the quota snapshot the plugin persists.
 *
 * The plugin writes one `company_meta` row per provider (`quota_<providerId>`). These two
 * readers are the only places the dispatcher and the owner pages get that snapshot from, and
 * they live in `src/` — not in the plugin — so the fork tests can exercise them without the
 * plugin runtime or its vendored copy.
 */
import type { Surreal } from 'surrealdb';
import type { ProviderQuota } from '../contracts.ts';

/**
 * Rows are selected by the record id's *name*, not by the printed id. The two look equivalent
 * and are not: SurrealDB prints a record id whose name needs quoting inside angle brackets
 * (`company_meta:⟨quota_factory-droid⟩`), so a prefix test on `<string>id` silently skipped
 * exactly the providers whose id contains a hyphen — `factory-droid` among them. That is how a
 * spent Factory month stayed invisible to the breaker even after magpie reported it.
 */
export const QUOTA_ROWS = `string::starts_with(<string>record::id(id), 'quota_')`;

/** ProviderQuota rows the dispatcher's circuit breaker consumes; shared with the roster preview. */
export async function readProviderQuotas(db: Surreal): Promise<ProviderQuota[]> {
  const [rows] = await db.query<[Array<{ provider?: string; summary?: string; lowest_pct?: number; session_pct?: number; weekly_pct?: number; status?: string; fetched_at?: string; at?: unknown }>]>(
    `SELECT provider, summary, lowest_pct, session_pct, weekly_pct, status, fetched_at, at FROM company_meta WHERE ${QUOTA_ROWS};`);
  return (rows ?? []).map(r => ({
    provider: r.provider ?? "", summary: r.summary ?? "", lowestPct: r.lowest_pct,
    sessionPct: r.session_pct, weeklyPct: r.weekly_pct, status: r.status,
    // Freshness = when WE last verified the row, not the upstream snapshot time:
    // a frozen Paseo usage cache would otherwise keep fetched_at old forever and
    // the circuit breaker would fail open on dead data.
    fetchedAt: String(r.at ?? "") || r.fetched_at,
  }));
}

/** The stored usage entries themselves, for callers that need the windows rather than the summary. */
export async function readQuotaEntries<T>(db: Surreal): Promise<T[]> {
  const [rows] = await db.query<[Array<{ payload?: T }>]>(
    `SELECT payload FROM company_meta WHERE ${QUOTA_ROWS};`);
  return (rows ?? []).map(r => r.payload).filter((p): p is T => !!p);
}
