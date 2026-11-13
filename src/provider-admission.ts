/**
 * Provider admission, shared verbatim by the dispatcher's staffing pool and the roster preview:
 * a provider the dispatcher would not staff must not appear eligible anywhere else. Both faces
 * read the same provider_health rows and the same quota snapshot the plugin persists
 * (readProviderQuotas), so they cannot drift.
 */

/** Minimal structural shape of workforce.ts's ProviderHealth (no import cycle). */
export type AdmissionHealth = { state: 'healthy' | 'exhausted'; until?: number; lastError?: string };
/** Minimal structural shape of contracts.ts's ProviderQuota. */
export interface AdmissionQuotaRow { provider: string; sessionPct?: number; weeklyPct?: number; lowestPct?: number; fetchedAt?: string }

/**
 * Different company provider ids that bill the same vendor subscription: quota windows and
 * exhaustion cooldowns are shared. `factory-paseo` is the Paseo-mode face of the Factory
 * subscription that `factory-droid` runs natively; either one consuming quota blocks both. `devin-paseo`
 * is the sandboxed employee face of the owner's own `devin` Paseo provider.
 */
export const SUBSCRIPTION_ALIAS: Record<string, string> = { 'factory-paseo': 'factory-droid', 'devin-paseo': 'devin' };
/** Canonical subscription id of a company provider id. */
export function subscriptionId(provider: string): string { return SUBSCRIPTION_ALIAS[provider] ?? provider; }
/** Every provider id billing the same subscription, canonical first. */
export function subscriptionPeers(provider: string): string[] {
  const id = subscriptionId(provider);
  return [id, ...Object.keys(SUBSCRIPTION_ALIAS).filter(k => SUBSCRIPTION_ALIAS[k] === id)];
}
/** Same-subscription comparison for preferred-provider preference checks. */
export function sameSubscription(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && subscriptionId(a) === subscriptionId(b);
}
export interface AdmissionFloors { quotaFloorPct: number; quotaWeeklyFloorPct: number }

/** 'ok' healthy / 'probe' single trial session allowed / 'down' cooling off. */
export const availabilityOf = (h: AdmissionHealth | undefined, now: number): 'ok' | 'probe' | 'down' =>
  !h || h.state === 'healthy' ? 'ok' : now >= (h.until ?? 0) ? 'probe' : 'down';

/** Quota circuit breaker, shared by the dispatcher tick and the roster staffing preview. */
export function quotaBlockedProviders(rows: ReadonlyArray<AdmissionQuotaRow>, cfg: AdmissionFloors, now: number): Map<string, string> {
  const blocked = new Map<string, string>();
  if (cfg.quotaFloorPct <= 0 && cfg.quotaWeeklyFloorPct <= 0) return blocked;
  for (const q of rows) {
    const age = q.fetchedAt ? now - Date.parse(q.fetchedAt) : 0;
    if (age >= 15 * 60_000) continue;
    const hasSplit = q.sessionPct !== undefined || q.weeklyPct !== undefined;
    const session = hasSplit ? q.sessionPct : q.lowestPct;
    const hits: string[] = [];
    if (session !== undefined && session < cfg.quotaFloorPct) hits.push(`短窗口/余额 ${Math.round(session)}%<${cfg.quotaFloorPct}%`);
    if (q.weeklyPct !== undefined && q.weeklyPct < cfg.quotaWeeklyFloorPct) hits.push(`周/月额度 ${Math.round(q.weeklyPct)}%<${cfg.quotaWeeklyFloorPct}%`);
    if (hits.length) blocked.set(q.provider, `额度不足（${hits.join('，')}）`);
  }
  return blocked;
}

/**
 * The dispatcher's own per-def admission (the same gate roleCapacity applies): a def exempt from
 * quota gating keeps its seat; everyone else needs the quota floors clear and the health window
 * not cooling off. No seat-cap here: this gate only assigns an existing idle session, it spawns nothing.
 */
export function providerAdmission(input: { provider?: string; quotaLimited?: boolean },
  ctx: { health: ReadonlyMap<string, AdmissionHealth>; quotaRows: ReadonlyArray<AdmissionQuotaRow>; floors: AdmissionFloors; now: number }): { ok: boolean; reason?: string } {
  if (input.quotaLimited === false) return { ok: true };
  const provider = input.provider ?? '';
  const blocked = quotaBlockedProviders(ctx.quotaRows, ctx.floors, ctx.now);
  for (const peer of subscriptionPeers(provider)) {
    const reason = blocked.get(peer);
    if (reason) return { ok: false, reason };
  }
  for (const peer of subscriptionPeers(provider)) {
    const h = ctx.health.get(peer);
    if (availabilityOf(h, ctx.now) === 'down')
      return { ok: false, reason: `额度耗尽或异常${h?.lastError ? `：${h.lastError.slice(0, 40)}` : ''}` };
  }
  return { ok: true };
}
