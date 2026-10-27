// Controlled supplier plan/quota evidence sampling. The employee names a sealed account
// alias and an evidence purpose; this trusted code — the only place allowed to touch the
// sealed values — queries a fixed, reviewed set of provider sources, derives the
// reviewed-token-plan fields, and writes the UTF-8 evidence document plus a sanitized
// audit receipt under the task evidence root. Anything that cannot be established from a
// real read becomes an explicit gap and the call answers `blocked` without a document:
// the sampler never fabricates account, quota or payment facts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describeTransportFailure, opsFetch, type Fetcher } from './fetcher.ts';
import {
  evidenceSchema, sha256, PLAN_HTML_FLAT_ALGORITHM, REVIEWED_QUOTA_AMOUNT, REVIEWED_QUOTA_WINDOW_SECONDS,
  TOKEN_PLAN_PLAN_TYPE_FREE, type TokenPlanEvidenceV3,
} from './proof-contract.ts';
import { clip, redactJson } from './redact.ts';

/**
 * The fixed SenseNova adapter (v3). v3 records the official page as a promotional, account-bound
 * observation only: the page no longer states a quota number, so the quota facts come from the
 * authenticated console pools and the allowed cap stays at the reviewed 60k points / 5h bound.
 * Callers can never steer the sampler to another host, path, method or body.
 */
export const SUPPLIER_ADAPTER = 'sensenova-token-plan/3';
export const SUPPLIER_PROVIDER = 'sensenova';
const API_BASE = 'https://token.sensenova.cn/v1';
const CONSOLE_API = 'https://platform.sensenova.cn/lite/console/v1';
const PLAN_PAGE = 'https://www.sensenova.cn/token-plan';
const BOUND_MODEL = 'sensenova-6.8-flash-lite';
const BOUND_PRICE_REVISION = 'sensenova-token-plan-2026-10-10';
const PLAN_NAME = 'SenseNova Token Plan Free · 公测 · 限时账号绑定';
/**
 * The reviewed cap. GM FV06 ruling: the authenticated account pools observe 120000/5h and
 * 1200000/7d, but those are observations only — the allowed upper bound never rises above this
 * reviewed 60k points / 5h constant.
 */
const QUOTA = { unit: 'points', amount: REVIEWED_QUOTA_AMOUNT, windowSeconds: REVIEWED_QUOTA_WINDOW_SECONDS } as const;
/** The reviewed service binding every generated document asserts. */
export const SUPPLIER_SERVICE = {
  endpoint: API_BASE, model: BOUND_MODEL, priceRevision: BOUND_PRICE_REVISION, planSourceUrl: PLAN_PAGE,
} as const;
const STEP_TIMEOUT_MS = 12_000;
const BUDGET_MS = 45_000;
const MIN_STEP_MS = 1_500;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_DOC_AGE_MS = 24 * 60 * 60 * 1000;
/** api-keys listing page size and the page ceiling; hitting the ceiling without a match fails closed. */
const API_KEY_PAGE_SIZE = 50;
const API_KEY_MAX_PAGES = 10;

/**
 * Guessed payment-surface URIs under the console API, probed every sample purely as
 * observation. A 404 here proves nothing about account payment settings (RFC9110
 * §15.5.5: 404 only says the resource was not found or is not disclosed); a live
 * surface is still worth flagging for human review. These records are receipt
 * evidence and must never feed the payment-fact verdict.
 */
const PAYMENT_SURFACE_PATHS = [
  '/billing', '/billingAccounts', '/billing/balance', '/recharge', '/recharge/settings',
  '/wallet', '/orders', '/payment-methods', '/auto-recharge', '/bills', '/finance/invoices',
] as const;

/**
 * Registry of authoritative account-level payment-state sources. The revised contract
 * no longer asserts account payment bindings or supplier auto-topup state, so nothing
 * reads this list today; it stays as the single registration point in case the
 * provider ever ships an official account-level payment-state API. Probed 2026-10-12
 * across the Lite console API and SenseCore IAM: the user record carries no payment
 * fields, no billing-account/payment resource exists, role bindings are not readable,
 * and the provider's own client bundle contains zero billing endpoints. An entry
 * lands here only via a code change carrying its own verification contract; guessed
 * 404 URIs never qualify.
 */
export const ACCOUNT_PAYMENT_SOURCES: readonly string[] = [];

/**
 * Console-session auto-issuance chain (probed 2026-10-12, Ory Hydra layout):
 *   GET {AUTH_HOST}/oauth2/auth (client nova, PKCE S256)
 *     ->302-> {IAM_API}/auth/login?login_challenge=<c>
 *   GET {IAM_API}/auth/checkChallenge -> POST {IAM_API}/auth/nova/login
 *     -> {redirect*} -> manual redirect hops (allowlisted hosts only) -> code on CALLBACK
 *   POST {AUTH_HOST}/oauth2/token -> bearer for the console reads.
 * Password is posted plaintext with is_encrypt=false, the SPA's own fallback when the
 * JWKS host (signin.sensecore.cn) is unreachable; that host is deliberately NOT in the
 * allowlist below so no JWE is attempted.
 */
const AUTH_HOST = 'https://platform.sensenova.cn';
const AUTH_CALLBACK = 'https://platform.sensenova.cn';
const IAM_API = 'https://iam.sensecoreapi.cn/iam/authn/v1';
const OAUTH_CLIENT = 'nova';
const OAUTH_SCOPE = 'openid offline offline_access';
const AUTH_HOST_ALLOWLIST = new Set(['platform.sensenova.cn', 'iam.sensecoreapi.cn']);
const AUTH_MAX_REDIRECT_HOPS = 8;

/** Sealed secret naming: the only materialization paths the broker accepts for a supplier alias. */
export const supplierApiKeySecretName = (alias: string) => `SUPPLIER_${alias}_API_KEY`;
export const supplierConsoleSecretName = (alias: string) => `SUPPLIER_${alias}_CONSOLE_TOKEN`;
export const supplierUsernameSecretName = (alias: string) => `SUPPLIER_${alias}_USERNAME`;
export const supplierPasswordSecretName = (alias: string) => `SUPPLIER_${alias}_PASSWORD`;
/** Which kinds of sealed material a supplier alias currently supports (for ops_info). */
export const supplierAliasFromSecretName = (name: string): { alias: string; kind: 'apiKey' | 'consoleToken' | 'username' | 'password' } | undefined => {
  const hit = /^SUPPLIER_([A-Z0-9][A-Z0-9_]*)_(API_KEY|CONSOLE_TOKEN|USERNAME|PASSWORD)$/.exec(name);
  if (!hit) return undefined;
  const suffix = hit[2]!;
  const kind = suffix === 'API_KEY' ? 'apiKey' : suffix === 'CONSOLE_TOKEN' ? 'consoleToken' : suffix === 'USERNAME' ? 'username' : 'password';
  return { alias: hit[1]!, kind };
};

/** One fact the sampler could not establish; why the call ended `blocked` or a field stayed null. */
interface Gap { field: string; source: string; detail: string }
interface SourceRecord {
  name: string; url: string; method: 'GET';
  status: number | null; ms: number | null;
  ok: boolean; detail?: string;
  /** Local UTC instant the response was received (v3 source freshness). */
  fetchedAt?: string;
  /** The origin's Date header, verbatim; v3 requires it for the official page. */
  httpDate?: string | null;
  etag?: string | null;
  rawSha256?: string;
  flatSha256?: string;
}
interface PoolFacts {
  poolType: string; name: string;
  limit5h: number | null; used5h: number | null; remaining5h: number | null; reset5h: number | null;
  limit7d: number | null; used7d: number | null; remaining7d: number | null; reset7d: number | null;
  used5hDerived: boolean; used7dDerived: boolean;
}
interface ProbeBody { status: number; ms: number; body: unknown; text: string; at: number; date: string | null; etag: string | null; truncated: boolean }

export interface SupplierSampleInput {
  project: string;
  env: string;
  taskId: string;
  alias: string;
  purpose: string;
  readSealed: (name: string) => Promise<string | undefined>;
  fetch?: Fetcher;
  now?: () => number;
  /** Task evidence root; document and receipt land here as <root>/supplier-plan-*.json. */
  evidenceDir: string;
}

export interface SupplierSampleResult {
  status: 'sampled' | 'blocked';
  provider: typeof SUPPLIER_PROVIDER;
  adapter: typeof SUPPLIER_ADAPTER;
  alias: string;
  purpose: string;
  accountRef: string | null;
  sampledAt: string;
  document?: Record<string, unknown>;
  documentSha256?: string;
  documentFile?: string;
  receiptFile?: string;
  receipt: {
    adapter: typeof SUPPLIER_ADAPTER;
    service: { endpoint: string; model: string; priceRevision: string };
    sources: SourceRecord[];
    derivations: Record<string, unknown>;
    pools: PoolFacts[];
    gaps: Gap[];
    notes: string[];
  };
  gaps: Gap[];
}

const bearer = (token: string): RequestInit => ({
  method: 'GET', redirect: 'manual',
  headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
});

const numberOrNull = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

/** reset_at fields are unix seconds on the console surface. */
const secondsOrNull = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/**
 * One bounded GET: no redirects followed, one per-source timeout inside a shared budget,
 * the body read is clipped so a hostile or drifting payload can never blow up memory or
 * echo large content. The record keeps status/timing only — bodies never leave the sampler.
 */
async function probe(
  name: string, url: string, init: RequestInit,
  io: { fetcher: Fetcher; left: () => number; now: () => number }, record: SourceRecord,
): Promise<ProbeBody | null> {
  const started = Date.now();
  const ms = Math.min(STEP_TIMEOUT_MS, Math.max(io.left(), MIN_STEP_MS));
  record.ms = 0;
  try {
    const response = await io.fetcher(url, { ...init, signal: AbortSignal.timeout(ms) });
    record.status = response.status;
    record.ms = Date.now() - started;
    const at = io.now();
    const date = response.headers.get('date');
    const etag = response.headers.get('etag');
    if (response.status >= 300 && response.status <= 399) {
      record.detail = 'redirect rejected by policy';
      return { status: response.status, ms: record.ms, body: null, text: '', at, date, etag, truncated: false };
    }
    const rawText = await response.text().catch(() => '');
    const text = clip(rawText, MAX_BODY_BYTES);
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* non-JSON is recorded by status only */ }
    return { status: response.status, ms: record.ms, body, text, at, date, etag, truncated: text.includes('[truncated ') };
  } catch (error) {
    record.ms = Date.now() - started;
    record.detail = describeTransportFailure(error, ms).detail;
    return null;
  }
}

/**
 * The documented v3 normalization: script/style bodies are dropped, every remaining tag becomes one
 * space, and all whitespace runs collapse. The exact flat text and its SHA256 are recorded in the
 * evidence document, so two verifiers can re-derive the same bytes from the captured raw page.
 */
export function flattenPlanHtml(text: string): string {
  return text
    .replace(/<script[^>]*>[\s\S]*?<\/script>|<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Official plan-page applicability markers for v3 (reviewed 2026-10-27): the page says the public
 * beta is free and time-limited, paid tiers are only announced, and it carries no quota number.
 * The quota number is deliberately an observation (`officialQuotaNumberObserved`), never a required
 * marker: the account-bound pool figures are the only quota evidence. This replaces the v2
 * `quota5h` marker (still kept in planPageMarkersV2 for old-document regression) instead of deleting
 * a failing check: the new copy has no number to match, and a missing limited-time marker blocks.
 */
export function planPageMarkersV3(flat: string): Record<string, boolean> {
  return {
    freeBetaOpen: flat.includes('公测期完全免费开放'),
    paidTiersUpcoming: flat.includes('付费档位即将上线'),
    limitedTimePromotion: /限时(?:放量|免费|开放|活动)/.test(flat),
    freeTierNamed: flat.includes('Free') && flat.includes('公测'),
    officialQuotaNumberObserved: /\d[\d,]{2,}\s*(?:积分|points?)/i.test(flat),
  };
}

/** v2's official-copy markers, retained so old sampled documents keep their original semantics. */
export function planPageMarkersV2(text: string): Record<string, boolean> {
  const flat = flattenPlanHtml(text);
  return {
    freeBetaOpen: flat.includes('公测期完全免费开放'),
    paidTiersUpcoming: flat.includes('付费档位即将上线'),
    quota5h: flat.includes('60,000') && flat.includes('5 小时'),
    freeTierNamed: flat.includes('Free') && flat.includes('公测'),
  };
}

/**
 * A promotional end date the page states explicitly, if any. When present it caps the evidence
 * lifetime; when absent the document records `unknown-promotional-end` instead of claiming the
 * activity is permanent.
 */
export function promotionalDeadline(flat: string): { at: string; text: string } | null {
  const match = /(?:活动)?(?:截止|截至)(?:日期|时间)?[:：]?\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(flat);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  // The plan page is a Chinese site and states a bare calendar date; interpret its end of day in
  // Asia/Shanghai (UTC+8), not UTC, so an evidence document never outlives the real campaign by
  // the eight-hour offset. The date itself is validated against the same UTC+8 calendar.
  const at = Date.UTC(year, month - 1, day, 15, 59, 59, 999);
  const local = new Date(at + 8 * 3_600_000);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return null;
  return { at: new Date(at).toISOString(), text: match[0].slice(0, 80) };
}

/** Parses the console pool-usage payload; null when the shape drifted beyond recognition. */
function parsePools(body: unknown): PoolFacts[] | null {
  if (!body || typeof body !== 'object') return null;
  const pools = (body as { pools?: unknown }).pools;
  if (!Array.isArray(pools)) return null;
  return pools.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object').map(p => {
    const w5 = (p.window_5h ?? {}) as Record<string, unknown>;
    const w7 = (p.window_7d ?? {}) as Record<string, unknown>;
    const limit5h = numberOrNull(w5.limit), remaining5h = numberOrNull(w5.remaining);
    const limit7d = numberOrNull(w7.limit), remaining7d = numberOrNull(w7.remaining);
    const reported5h = numberOrNull(w5.used);
    const reported7d = numberOrNull(w7.used);
    const derived = (limit: number | null, remaining: number | null) =>
      limit !== null && remaining !== null && remaining <= limit ? limit - remaining : null;
    return {
      poolType: typeof p.pool_type === 'string' ? p.pool_type : 'unknown',
      name: typeof p.name === 'string' ? p.name.slice(0, 80) : '',
      limit5h, used5h: reported5h ?? derived(limit5h, remaining5h), remaining5h, reset5h: secondsOrNull(w5.reset_at),
      used5hDerived: reported5h === null,
      limit7d, used7d: reported7d ?? derived(limit7d, remaining7d), remaining7d, reset7d: secondsOrNull(w7.reset_at),
      used7dDerived: reported7d === null,
    };
  });
}

/** The account-bound plan record inside the pool-usage payload; null when absent or drifted. */
function parseAccountPlan(body: unknown): { id: string; name: string; type: string } | null {
  const plan = (body as { plan?: unknown } | null)?.plan;
  if (!plan || typeof plan !== 'object') return null;
  const p = plan as Record<string, unknown>;
  if (typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.type !== 'string') return null;
  return { id: p.id.slice(0, 80), name: p.name.slice(0, 80), type: p.type.slice(0, 80) };
}

/** The pool that governs the bound model: Flash-Lite dedicated first, the general pool otherwise. */
function governingPool(pools: PoolFacts[]): PoolFacts | undefined {
  return pools.find(p => p.poolType === 'dedicated') ?? pools.find(p => p.poolType === 'default') ?? pools[0];
}

type PoolWindowDocument = { limit: number; used: number; remaining: number; resetAt: string };
type PoolDocument = {
  poolType: string; name: string; accountBound: true;
  window5h: PoolWindowDocument; window7d: PoolWindowDocument;
  usedSource5h: 'reported' | 'derived'; usedSource7d: 'reported' | 'derived';
};
interface PoolAnalysis {
  ok: boolean;
  governing?: PoolFacts;
  basis?: 'dedicated-pool-for-bound-model' | 'default-pool' | 'single-pool';
  minRemaining: number | null;
  minResetMs: number | null;
  observedLimits: Array<{ poolType: string; limit5h: number | null; limit7d: number | null }>;
  documentPools: PoolDocument[];
  gaps: Gap[];
}

/**
 * The v3 pool contract. Both windows are mandatory for every pool; `used + remaining` must equal
 * the reported limit; duplicate pool types are ambiguous; a window already reset is stale. The
 * trusted remaining is the minimum across both windows of every applicable pool, so a large 7d
 * figure can never hide a nearly spent 5h window (or vice versa). Missing 7d facts never become
 * "unlimited": they block.
 */
function analyzePools(pools: PoolFacts[], sampledMs: number): PoolAnalysis {
  const gaps: Gap[] = [];
  const fail = (field: string, detail: string) => gaps.push({ field, source: 'poolUsage', detail });
  if (pools.length === 0) fail('quota', 'account shows no token-plan pools');
  if (new Set(pools.map(pool => pool.poolType)).size !== pools.length) fail('poolConsistency', 'duplicate pool types make the governing pool ambiguous');
  const documentPools: PoolDocument[] = [];
  let minRemaining: number | null = null;
  let minResetMs: number | null = null;
  for (const pool of pools) {
    const window = (label: '5h' | '7d', limit: number | null, used: number | null, remaining: number | null, reset: number | null, derived: boolean) => {
      if (limit === null || used === null || remaining === null || reset === null) {
        fail(label === '5h' ? 'quota5h' : 'quota7d', `pool ${pool.poolType} is missing a ${label} limit/used/remaining/reset fact; a missing window is never treated as unlimited`);
        return undefined;
      }
      if (limit <= 0 || remaining > limit || used > limit || used + remaining !== limit) {
        fail('poolConsistency', `pool ${pool.poolType} ${label} facts are inconsistent (limit=${limit}, used=${used}, remaining=${remaining})`);
        return undefined;
      }
      const resetMs = reset * 1000;
      if (resetMs <= sampledMs) {
        fail('poolWindow', `pool ${pool.poolType} ${label} window already reset at ${new Date(resetMs).toISOString()}`);
        return undefined;
      }
      minRemaining = minRemaining === null ? remaining : Math.min(minRemaining, remaining);
      minResetMs = minResetMs === null ? resetMs : Math.min(minResetMs, resetMs);
      return { limit, used, remaining, resetAt: new Date(resetMs).toISOString(), derived };
    };
    const w5 = window('5h', pool.limit5h, pool.used5h, pool.remaining5h, pool.reset5h, pool.used5hDerived);
    const w7 = window('7d', pool.limit7d, pool.used7d, pool.remaining7d, pool.reset7d, pool.used7dDerived);
    if (w5 && w7) {
      documentPools.push({
        poolType: pool.poolType, name: pool.name || pool.poolType, accountBound: true,
        window5h: { limit: w5.limit, used: w5.used, remaining: w5.remaining, resetAt: w5.resetAt },
        window7d: { limit: w7.limit, used: w7.used, remaining: w7.remaining, resetAt: w7.resetAt },
        usedSource5h: w5.derived ? 'derived' : 'reported', usedSource7d: w7.derived ? 'derived' : 'reported',
      });
    } else {
      // Keep the receipt's observed limits even when the document cannot be produced.
      documentPools.length = 0;
    }
  }
  const governing = governingPool(pools);
  if (!governing) fail('governingPool', 'no pool can govern the bound model');
  const basis = pools.length === 1 ? 'single-pool'
    : pools.some(pool => pool.poolType === 'dedicated') ? 'dedicated-pool-for-bound-model' : 'default-pool';
  const observedLimits = pools.map(pool => ({ poolType: pool.poolType, limit5h: pool.limit5h, limit7d: pool.limit7d }));
  return {
    ok: gaps.length === 0 && documentPools.length > 0 && governing !== undefined,
    ...(governing === undefined ? {} : { governing }),
    basis,
    minRemaining, minResetMs, observedLimits, documentPools, gaps,
  };
}

export async function sampleSupplierPlan(input: SupplierSampleInput): Promise<SupplierSampleResult> {
  const fetcher = input.fetch ?? opsFetch;
  const now = input.now ?? Date.now;
  const sampledMs = now();
  const sampledAt = new Date(sampledMs).toISOString();
  const gaps: Gap[] = [];
  const sources: SourceRecord[] = [];
  const notes: string[] = [];
  const derivations: Record<string, unknown> = {};
  const pools: PoolFacts[] = [];
  const secrets: string[] = [];
  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  const source = (name: string, url: string): SourceRecord => {
    const record: SourceRecord = { name, url, method: 'GET', status: null, ms: null, ok: false };
    sources.push(record);
    return record;
  };

  const apiKey = await input.readSealed(supplierApiKeySecretName(input.alias));
  const pastedToken = await input.readSealed(supplierConsoleSecretName(input.alias));
  const username = await input.readSealed(supplierUsernameSecretName(input.alias));
  const password = await input.readSealed(supplierPasswordSecretName(input.alias));
  for (const value of [apiKey, pastedToken, username, password]) if (value && value.length >= 6) secrets.push(value);

  // Console session: sealed username/password auto-issuance is the primary path
  // (fresh token, real lifetime read off the JWT); a manually pasted
  // SUPPLIER_<ALIAS>_CONSOLE_TOKEN stays as the documented fallback channel.
  let consoleToken: string | undefined;
  let consoleTokenSource: 'issued' | 'sealed' | undefined;
  let consoleSessionExpiresAt: string | null = null;
  let authHops: AuthHop[] | undefined;
  if (username && password) {
    const issued = await issueConsoleSession({ fetcher, left }, username, password, secrets);
    authHops = issued.hops;
    if (issued.session) {
      consoleToken = issued.session.token;
      consoleTokenSource = 'issued';
      consoleSessionExpiresAt = issued.session.expiresAtMs ? new Date(issued.session.expiresAtMs).toISOString() : null;
    } else if (issued.gap) {
      gaps.push(issued.gap);
    }
  }
  if (!consoleToken && pastedToken) {
    consoleToken = pastedToken;
    consoleTokenSource = 'sealed';
    if (authHops) notes.push('console session auto-issuance failed; sealed console token used as fallback');
  }
  const accountRef = apiKey ? `snv${sha256(`sensenova|${apiKey}`).slice(0, 24)}` : null;
  if (!apiKey) gaps.push({ field: 'accountRef', source: 'sealed-store', detail: `no sealed ${supplierApiKeySecretName(input.alias)} for alias ${input.alias}` });

  // ---- source: chat-surface models list (credential liveness + bound model availability) ----
  let keyLive = false;
  let modelListed = false;
  if (apiKey) {
    const record = source('models', `${API_BASE}/models`);
    const res = await probe('models', `${API_BASE}/models`, bearer(apiKey), { fetcher, left, now }, record);
    if (res && res.status === 200) {
      const ids = Array.isArray((res.body as { data?: unknown })?.data)
        ? ((res.body as { data: unknown[] }).data.map(row => (row as { id?: unknown })?.id).filter((v): v is string => typeof v === 'string'))
        : [];
      keyLive = true;
      modelListed = ids.includes(BOUND_MODEL);
      record.ok = true;
      if (!modelListed) gaps.push({ field: 'model', source: 'models', detail: `bound model ${BOUND_MODEL} is not in the account model list` });
    } else if (res && (res.status === 401 || res.status === 403)) {
      gaps.push({ field: 'apiKey', source: 'models', detail: `chat credential rejected (HTTP ${res.status})` });
    } else {
      gaps.push({ field: 'apiKey', source: 'models', detail: record.detail ?? `models probe unavailable (HTTP ${res?.status ?? 'n/a'})` });
    }
  }

  // ---- source: official plan page (promotional applicability + source freshness) ----
  const pageRecord = source('planPage', PLAN_PAGE);
  const page = await probe('planPage', PLAN_PAGE, { method: 'GET', redirect: 'manual', headers: { accept: 'text/html' } }, { fetcher, left, now }, pageRecord);
  const flat = page && page.status === 200 ? flattenPlanHtml(page.text) : '';
  const markers = page && page.status === 200 && flat ? planPageMarkersV3(flat) : null;
  const promotionalEnd = markers ? promotionalDeadline(flat) : null;
  const claimsPromotionalEnd = /(?:截止|截至)/.test(flat);
  let planSource: TokenPlanEvidenceV3['planSource'] | undefined;
  let normalization: TokenPlanEvidenceV3['normalization'] | undefined;
  if (page && page.status === 200 && markers && flat) {
    pageRecord.ok = true;
    pageRecord.fetchedAt = new Date(page.at).toISOString();
    pageRecord.httpDate = page.date;
    pageRecord.etag = page.etag;
    pageRecord.rawSha256 = sha256(page.text);
    pageRecord.flatSha256 = sha256(flat);
    derivations.planPageMarkers = markers;
    derivations.planPagePromotionalEnd = promotionalEnd;
    derivations.planPageRawSha256 = pageRecord.rawSha256;
    derivations.planPageFlatSha256 = pageRecord.flatSha256;
    derivations.planPageFlatAlgorithm = PLAN_HTML_FLAT_ALGORITHM;
    for (const key of ['freeBetaOpen', 'paidTiersUpcoming', 'limitedTimePromotion', 'freeTierNamed']) {
      if (!markers[key]) gaps.push({ field: 'planApplicability', source: 'planPage', detail: `official plan page marker ${key} no longer holds` });
    }
    if (page.truncated) gaps.push({ field: 'planSource', source: 'planPage', detail: 'official page exceeded the bounded body size; raw/flat hash would cover only a prefix' });
    if (!page.date) gaps.push({ field: 'sourceDate', source: 'planPage', detail: 'official page sent no HTTP Date header; source freshness cannot be corroborated' });
    else if (!Number.isFinite(Date.parse(page.date))) gaps.push({ field: 'sourceDate', source: 'planPage', detail: 'official page HTTP Date header is not a valid HTTP date' });
    else {
      const skew = page.at - Date.parse(page.date);
      derivations.planPageClockSkewMs = skew;
      if (Math.abs(skew) > 300_000) gaps.push({ field: 'sourceDate', source: 'planPage', detail: `local clock differs from HTTP Date by ${skew}ms (beyond the 5 minute bound)` });
      else planSource = {
        url: PLAN_PAGE, fetchedAt: new Date(page.at).toISOString(), httpDate: new Date(Date.parse(page.date)).toISOString(),
        clockSkewMs: skew, status: page.status, etag: page.etag, rawSha256: sha256(page.text),
      };
    }
    normalization = { algorithm: PLAN_HTML_FLAT_ALGORITHM, flatSha256: sha256(flat), flatChars: flat.length };
    if (promotionalEnd === null && claimsPromotionalEnd) {
      gaps.push({ field: 'promotionalEnd', source: 'planPage', detail: 'official page mentions a deadline that could not be parsed; refusing to assume an unbounded activity' });
    }
  } else {
    gaps.push({ field: 'planApplicability', source: 'planPage', detail: pageRecord.detail ?? `official plan page unreadable (HTTP ${page?.status ?? 'n/a'})` });
  }

  // ---- sources on the console session (account-bound) ----
  let poolsOk = false;
  let crossBound = false;
  let apiKeysComplete = false;
  let accountPlan: { id: string; name: string; type: string } | null = null;
  let paymentSurfaceAbsent = false;
  if (!consoleToken) {
    gaps.push({ field: 'consoleToken', source: 'sealed-store', detail: `no sealed ${supplierConsoleSecretName(input.alias)} and no sealed ${supplierUsernameSecretName(input.alias)}/${supplierPasswordSecretName(input.alias)}; account-bound quota and plan type are unverifiable` });
  } else {
    const keysRecord = source('apiKeys', `${CONSOLE_API}/metered/api-keys`);
    const poolRecord = source('poolUsage', `${CONSOLE_API}/tokenplan/pool-usage`);
    const [keysFirst, poolRes] = await Promise.all([
      probe('apiKeys', `${CONSOLE_API}/metered/api-keys?page_size=${API_KEY_PAGE_SIZE}`, bearer(consoleToken), { fetcher, left, now }, keysRecord),
      probe('poolUsage', `${CONSOLE_API}/tokenplan/pool-usage`, bearer(consoleToken), { fetcher, left, now }, poolRecord),
    ]);

    if (poolRes && poolRes.status === 200) {
      accountPlan = parseAccountPlan(poolRes.body);
      const parsed = parsePools(poolRes.body);
      if (parsed) {
        pools.push(...parsed);
        poolRecord.ok = true;
        poolsOk = parsed.length > 0;
        if (!poolsOk) gaps.push({ field: 'quota', source: 'poolUsage', detail: 'account shows no token-plan pools' });
      } else {
        gaps.push({ field: 'quota', source: 'poolUsage', detail: 'pool-usage response shape drifted (pools list missing)' });
      }
    } else if (poolRes && (poolRes.status === 401 || poolRes.status === 403)) {
      gaps.push({ field: 'consoleToken', source: 'poolUsage', detail: `console session rejected (HTTP ${poolRes.status})` });
    } else {
      gaps.push({ field: 'quota', source: 'poolUsage', detail: poolRecord.detail ?? `pool-usage unavailable (HTTP ${poolRes?.status ?? 'n/a'})` });
    }

    if (keysFirst && keysFirst.status === 200 && apiKey) {
      const seen = new Set<string>();
      let nextToken = '';
      let page = 0;
      let malformed = false;
      // Exact match only: the console returns full api_key values, so an entry equal to the
      // sealed chat key proves both credentials belong to the same supplier account.
      for (;;) {
        const body = page === 0 ? keysFirst.body : null;
        const res = page === 0 ? keysFirst : await probe(
          'apiKeys', `${CONSOLE_API}/metered/api-keys?page_size=${API_KEY_PAGE_SIZE}&page_token=${encodeURIComponent(nextToken)}`,
          bearer(consoleToken), { fetcher, left, now }, keysRecord);
        const payload = page === 0 ? body : res?.body;
        if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { api_keys?: unknown }).api_keys)) { malformed = true; break; }
        const rows = (payload as { api_keys: Array<Record<string, unknown>> }).api_keys;
        for (const row of rows) {
          if (row && typeof row === 'object' && row.api_key === apiKey) { crossBound = true; }
          if (typeof row?.id === 'string') seen.add(row.id);
        }
        const token = (payload as { next_page_token?: unknown }).next_page_token;
        if (crossBound || typeof token !== 'string' || !token) { apiKeysComplete = true; break; }
        page += 1;
        if (page >= API_KEY_MAX_PAGES) break;
        nextToken = token;
      }
      if (crossBound) {
        keysRecord.ok = true;
        derivations.apiKeyPages = page + 1;
      } else if (malformed) {
        gaps.push({ field: 'binding', source: 'apiKeys', detail: 'api-keys response shape drifted; account binding unverifiable' });
      } else if (!apiKeysComplete) {
        gaps.push({ field: 'binding', source: 'apiKeys', detail: `api-keys pagination exceeded ${API_KEY_MAX_PAGES} pages; match unverifiable` });
      } else {
        keysRecord.ok = true;
        derivations.apiKeyPages = page + 1;
        derivations.apiKeysListed = seen.size;
        gaps.push({ field: 'binding', source: 'apiKeys', detail: 'sealed chat credential is absent from the console account key list' });
      }
    } else if (keysFirst && (keysFirst.status === 401 || keysFirst.status === 403)) {
      gaps.push({ field: 'consoleToken', source: 'apiKeys', detail: `console session rejected (HTTP ${keysFirst.status})` });
    } else if (!apiKey) {
      // already reported as accountRef gap
    } else {
      gaps.push({ field: 'binding', source: 'apiKeys', detail: keysRecord.detail ?? `api-keys list unavailable (HTTP ${keysFirst?.status ?? 'n/a'})` });
    }

    // Payment-surface enumeration, observation only: record what each guessed
    // billing-ish console path answers under this session. A live surface means the
    // provider now ships payment features humans must review; uniform 404s are
    // recorded as observations only. The enumeration never certifies account payment
    // state and never gates the document — the official plan-page markers are the
    // paid-tier tripwire.
    const surfaceChecks: Array<{ path: string; status: number | null }> = [];
    const surfaceRecords = PAYMENT_SURFACE_PATHS.map(path => source('paymentSurface', `${CONSOLE_API}${path}`));
    const surfaceResults = await Promise.all(
      PAYMENT_SURFACE_PATHS.map((path, i) => probe('paymentSurface', `${CONSOLE_API}${path}`, bearer(consoleToken), { fetcher, left, now }, surfaceRecords[i]!)),
    );
    let surfaceDrift = false;
    for (let i = 0; i < PAYMENT_SURFACE_PATHS.length; i += 1) {
      const res = surfaceResults[i];
      surfaceChecks.push({ path: PAYMENT_SURFACE_PATHS[i]!, status: res?.status ?? null });
      if (!res || res.status !== 404) surfaceDrift = true;
      if (res && res.status === 404) surfaceRecords[i]!.ok = true;
    }
    paymentSurfaceAbsent = !surfaceDrift;
    derivations.paymentSurface = surfaceChecks;
    if (surfaceDrift) {
      const found = surfaceChecks.filter(c => c.status !== 404).map(c => `${c.path}=${c.status ?? 'transport'}`).join(', ');
      notes.push(`console payment surface not uniformly absent (${found}); receipt observation for human review, not a proof input`);
    }
  }

  // ---- derivations ----
  // The v3 official-copy gate: free beta + paid tiers still upcoming + a limited-time promotion +
  // the Free 公测 tier. The quota number is recorded as an observation and is never a required
  // marker, because the official copy no longer states one; the account-bound pools are the only
  // quota evidence.
  const requiredMarkers = ['freeBetaOpen', 'paidTiersUpcoming', 'limitedTimePromotion', 'freeTierNamed'] as const;
  const applicabilityOk = markers !== null && requiredMarkers.every(key => markers[key] === true);
  const accountBound = poolsOk && crossBound;
  derivations.accountBound = accountBound;
  derivations.applicabilityOk = applicabilityOk;
  derivations.officialQuotaNumberObserved = markers?.officialQuotaNumberObserved ?? false;
  // Only the authenticated console plan record, cross-bound to the sealed API key,
  // establishes FREE. Public copy, model liveness and HTTP 404s are not account facts.
  const accountPlanFree = accountBound && accountPlan?.type === TOKEN_PLAN_PLAN_TYPE_FREE;
  derivations.accountPlan = accountPlan;
  derivations.accountPlanFree = accountPlanFree;
  derivations.accountPlanSource = { source: 'poolUsage', accountBound, verified: accountPlanFree };
  derivations.consolePaymentSurfaceAbsent = paymentSurfaceAbsent;
  derivations.paymentStateSources = ACCOUNT_PAYMENT_SOURCES.length;
  derivations.removedAccountAssertions = ['noPaymentInstrument'];
  notes.push('v3 keeps autoTopupDisabled as our measurement-configuration assertion; payment-surface 404s remain observations and never prove the absence of payment capability');
  if (!accountPlanFree) {
    gaps.push({ field: 'accountPlanType', source: 'poolUsage', detail: accountPlan
      ? 'authenticated account plan is not verified FREE for the bound API key (product gap: account-plan-free)'
      : 'authenticated account plan source missing or unreadable; public copy and 404s cannot substitute (product gap: account-plan-free)' });
  }
  if (consoleTokenSource || authHops)
    derivations.consoleSession = { tokenSource: consoleTokenSource ?? 'unavailable', sessionExpiresAt: consoleSessionExpiresAt, hops: authHops ?? [] };
  if (apiKey && !keyLive && !gaps.some(g => g.source === 'models')) {
    gaps.push({ field: 'apiKey', source: 'models', detail: 'chat credential liveness unverified' });
  }

  const poolAnalysis = analyzePools(pools, sampledMs);
  gaps.push(...poolAnalysis.gaps);
  const quotaRemaining = poolAnalysis.minRemaining;
  // The allowed bound is the smaller of the reviewed 60k cap and every applicable pool's trusted
  // remaining. The observed 120k pool limit is recorded in pools/governing facts and never raises it.
  const quotaAmount = quotaRemaining === null ? null : Math.min(QUOTA.amount, quotaRemaining);
  derivations.poolsOk = poolAnalysis.ok;
  derivations.governingPool = poolAnalysis.governing ? { poolType: poolAnalysis.governing.poolType, basis: poolAnalysis.basis ?? null } : null;
  derivations.observedPoolLimits = poolAnalysis.observedLimits;
  derivations.quotaAllowedAmount = quotaAmount;
  derivations.quotaRemaining = quotaRemaining;
  derivations.quotaCapSource = 'min(reviewed 60000 points / 18000s, every applicable pool remaining)';
  if (quotaAmount === null || quotaAmount <= 0) {
    gaps.push({ field: 'quota', source: 'poolUsage', detail: 'no trusted remaining quota in every applicable pool; allowed upper bound cannot be established' });
  }

  const promotionalEndMs = promotionalEnd ? Date.parse(promotionalEnd.at) : null;
  // A page that mentions a deadline we could not parse is not treated as open-ended.
  const promotionalEndOk = !(claimsPromotionalEnd && promotionalEnd === null);
  const terminationRisk = promotionalEndMs === null ? 'unknown-promotional-end' : 'promotional-end-recorded';
  const resetsMs = pools.flatMap(pool => [pool.reset5h, pool.reset7d])
    .filter((value): value is number => typeof value === 'number').map(value => value * 1000);
  const expiryCandidates = [sampledMs + MAX_DOC_AGE_MS, ...resetsMs, ...(promotionalEndMs === null ? [] : [promotionalEndMs])];
  const expiryMs = Math.min(...expiryCandidates);
  if (promotionalEndMs !== null && promotionalEndMs <= sampledMs) {
    gaps.push({ field: 'promotionalEnd', source: 'planPage', detail: 'the recorded promotional activity already ended at sampling time' });
  }
  if (expiryMs <= sampledMs) {
    // A window boundary the provider already passed would make any document born-expired;
    // report the stale facts even when the call is already blocked for other reasons.
    gaps.push({ field: 'expiresAt', source: 'poolUsage', detail: 'pool window reset already elapsed; sampled facts are stale on arrival' });
  }

  let expiresAt: string | undefined;
  let document: Record<string, unknown> | undefined;
  let documentSha256: string | undefined;
  let documentFile: string | undefined;
  const canDocument = !!accountRef && keyLive && modelListed && applicabilityOk && accountBound && accountPlanFree
    && poolAnalysis.ok && quotaAmount !== null && quotaAmount > 0 && quotaRemaining !== null
    && planSource !== undefined && normalization !== undefined && promotionalEndOk
    && expiryMs > sampledMs && !(promotionalEndMs !== null && promotionalEndMs <= sampledMs);
  if (canDocument) {
    expiresAt = new Date(expiryMs).toISOString();
    document = {
      schemaVersion: 3,
      type: 'reviewed-token-plan',
      evidenceClass: 'promotional-account-bound',
      accountRef: accountRef!,
      endpoint: API_BASE,
      model: BOUND_MODEL,
      priceRevision: BOUND_PRICE_REVISION,
      sampledAt,
      expiresAt,
      planName: PLAN_NAME,
      planSourceUrl: PLAN_PAGE,
      planSource: planSource!,
      normalization: normalization!,
      accountPlanType: accountPlan!.type,
      accountBound: true,
      accountBoundSource: 'console-pool-usage-cross-bound-to-sealed-api-key',
      quotaUnit: QUOTA.unit,
      quotaAmount: quotaAmount!,
      quotaWindowSeconds: QUOTA.windowSeconds,
      quotaRemaining: quotaRemaining!,
      quotaSource: 'account-bound-observation',
      governingPool: { poolType: poolAnalysis.governing!.poolType, basis: poolAnalysis.basis! },
      pools: poolAnalysis.documentPools,
      autoTopupDisabled: true,
      promotional: true,
      revalidateBeforeUse: true,
      terminationRisk,
      promotionalEndsAt: promotionalEnd?.at ?? null,
      // The document's approval claim: it takes effect only through ops_internal_ai_prove's
      // independent task-service approval receipt, never on this field alone.
      serviceApproved: true,
    };
    const parsed = evidenceSchema.safeParse(document);
    if (!parsed.success) {
      gaps.push({ field: 'document', source: 'sampler', detail: 'generated document failed the reviewed-token-plan v3 schema' });
      document = undefined;
    } else {
      const bytes = Buffer.from(JSON.stringify(document, null, 2) + '\n', 'utf8');
      documentSha256 = sha256(bytes);
      mkdirSync(input.evidenceDir, { recursive: true, mode: 0o700 });
      documentFile = join(input.evidenceDir, `supplier-plan-${SUPPLIER_PROVIDER}-${sampledMs}.json`);
      writeFileSync(documentFile, bytes, { mode: 0o600 });
    }
  } else {
    notes.push('document not generated: one or more required facts could not be established; see gaps');
  }

  const receipt = {
    adapter: SUPPLIER_ADAPTER,
    service: { endpoint: SUPPLIER_SERVICE.endpoint, model: SUPPLIER_SERVICE.model, priceRevision: SUPPLIER_SERVICE.priceRevision },
    sources, derivations, pools, gaps, notes,
  };
  mkdirSync(input.evidenceDir, { recursive: true, mode: 0o700 });
  const receiptFile = join(input.evidenceDir, `supplier-plan-${SUPPLIER_PROVIDER}-${sampledMs}-receipt.json`);
  writeFileSync(receiptFile, Buffer.from(JSON.stringify(redactJson({
    ...receipt, alias: input.alias, purpose: input.purpose, taskId: input.taskId,
    accountRef, sampledAt, documentSha256: documentSha256 ?? null, generated: !!document,
  }, secrets), null, 2) + '\n', 'utf8'), { mode: 0o600 });

  return redactJson({
    status: document ? 'sampled' : 'blocked',
    provider: SUPPLIER_PROVIDER,
    adapter: SUPPLIER_ADAPTER,
    alias: input.alias,
    purpose: input.purpose,
    accountRef,
    sampledAt,
    ...(expiresAt ? { expiresAt } : {}),
    ...(document ? { document, documentSha256, documentFile } : {}),
    receiptFile,
    receipt,
    gaps,
  }, secrets) as SupplierSampleResult;
}
interface AuthHop {
  phase: string;
  host: string;
  status: number | null;
  ms: number;
  ok: boolean;
}

interface IssuedSession {
  token: string;
  expiresAtMs: number | null;
  hops: AuthHop[];
}

const authGap = (detail: string, hops: AuthHop[]): { gap: Gap; hops: AuthHop[] } => ({
  gap: { field: 'consoleToken', source: 'auto-issuance', detail },
  hops,
});

const b64u = (buf: Buffer): string =>
  buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const randToken = (chars: number): string => b64u(randomBytes(48)).slice(0, chars);
const safeJson = (text: string | undefined): Record<string, unknown> | undefined => {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch { return undefined; }
};

/**
 * One bounded request inside the fixed two-host auth allowlist. Redirects are never
 * followed automatically — Location comes back for the caller to validate — and cookies
 * are relayed only to the same allowlisted host that set them, mirroring the browser
 * flow without ever widening the surface.
 */
async function authRequest(
  io: { fetcher: Fetcher; left: () => number },
  url: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
  hops: AuthHop[],
  phase: string,
  cookies: Map<string, Map<string, string>>,
): Promise<{ status: number; headers: Headers; text?: string; error?: string }> {
  const host = new URL(url).host;
  if (!AUTH_HOST_ALLOWLIST.has(host))
    return { status: 0, headers: new Headers(), error: `host not allowlisted: ${host}` };
  const ms = Math.min(STEP_TIMEOUT_MS, Math.max(io.left(), MIN_STEP_MS));
  const jar = cookies.get(host);
  const headers: Record<string, string> = { ...init.headers };
  if (jar && jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const started = Date.now();
  try {
    const res = await io.fetcher(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(ms),
    });
    const elapsed = Date.now() - started;
    hops.push({ phase, host, status: res.status, ms: elapsed, ok: res.status >= 200 && res.status < 400 });
    let jar2 = cookies.get(host);
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = /^([^=;]+)=([^;]*)/.exec(raw.trim());
      if (!pair) continue;
      if (!jar2) { jar2 = new Map(); cookies.set(host, jar2); }
      jar2.set(pair[1]!, pair[2]!);
    }
    const text = clip(await res.text().catch(() => ''), MAX_BODY_BYTES);
    return { status: res.status, headers: res.headers, text };
  } catch (error) {
    hops.push({ phase, host, status: null, ms: Date.now() - started, ok: false });
    return { status: 0, headers: new Headers(), error: describeTransportFailure(error, Date.now() - started).detail };
  }
}

/** Reads `exp` out of a JWT payload; undefined when the token is not a decodable JWT. */
const jwtExpMs = (token: string): number | undefined => {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
  } catch { return undefined; }
};

/**
 * Mint a console access token from the sealed username/password through the provider's
 * OAuth authorization chain. Never throws: every drift, rejection, captcha/risk-control
 * surface or transport fault becomes a gap and the sampler answers `blocked` instead of
 * fabricating a session. The issued token is pushed into `secrets` so every emitted
 * surface (receipt, result, audit echo) masks it; only issuance metadata lands on paper.
 */
export async function issueConsoleSession(
  io: { fetcher: Fetcher; left: () => number },
  username: string,
  password: string,
  secrets: string[],
): Promise<{ session?: IssuedSession; gap?: Gap; hops: AuthHop[] }> {
  const hops: AuthHop[] = [];
  const cookies = new Map<string, Map<string, string>>();
  const verifier = randToken(50);
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const state = randToken(24);

  const authorizeUrl =
    `${AUTH_HOST}/oauth2/auth?response_type=code&client_id=${OAUTH_CLIENT}` +
    `&code_challenge_method=S256&code_challenge=${challenge}` +
    `&redirect_uri=${encodeURIComponent(AUTH_CALLBACK)}` +
    `&scope=${encodeURIComponent(OAUTH_SCOPE)}&state=${state}&lang=zh-CN`;
  const authz = await authRequest(io, authorizeUrl, {}, hops, 'oauth2/auth', cookies);
  if (authz.error) return { ...authGap(`authorize transport failed: ${authz.error}`, hops) };
  const loginLoc = authz.headers.get('location') ?? '';
  let loginChallenge = '';
  try {
    const u = new URL(loginLoc);
    if (u.host === 'iam.sensecoreapi.cn' && u.pathname === '/iam/authn/v1/auth/login')
      loginChallenge = u.searchParams.get('login_challenge') ?? '';
  } catch { /* location unparseable */ }
  if (authz.status !== 302 || !loginChallenge)
    return { ...authGap(`authorize yielded no login challenge: HTTP ${authz.status}`, hops) };

  const chk = await authRequest(
    io, `${IAM_API}/auth/checkChallenge?challenge=${encodeURIComponent(loginChallenge)}`,
    {}, hops, 'checkChallenge', cookies);
  if (chk.error) return { ...authGap(`checkChallenge transport failed: ${chk.error}`, hops) };
  if (chk.status !== 200 || safeJson(chk.text)?.is_valid !== true)
    return { ...authGap(`login challenge rejected or expired: HTTP ${chk.status}`, hops) };

  const login = await authRequest(
    io, `${IAM_API}/auth/nova/login`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, challenge: loginChallenge, is_encrypt: false }),
    },
    hops, 'nova/login', cookies);
  if (login.error) return { ...authGap(`login transport failed: ${login.error}`, hops) };
  if (login.status !== 200)
    return { ...authGap(`login rejected: HTTP ${login.status} (bad credentials, captcha or risk-control)`, hops) };
  const loginBody = safeJson(login.text);
  if (Array.isArray(loginBody?.tenant_list) && loginBody.tenant_list.length)
    return { ...authGap('login requires an interactive tenant selection (tenant_list present)', hops) };
  const redirect =
    (typeof loginBody?.redirect_uri === 'string' && loginBody.redirect_uri) ||
    (typeof loginBody?.redirect_to === 'string' && loginBody.redirect_to) ||
    (typeof loginBody?.redirect === 'string' && loginBody.redirect) || '';
  if (!redirect.startsWith('https://'))
    return { ...authGap('login returned no usable redirect (captcha/risk-control or drifted shape)', hops) };

  let code = '';
  let next: string | undefined = redirect;
  for (let i = 0; i < AUTH_MAX_REDIRECT_HOPS && next; i += 1) {
    let u: URL;
    try { u = new URL(next); } catch {
      return { ...authGap('redirect hop was not an absolute URL', hops) };
    }
    if (u.protocol !== 'https:' || !AUTH_HOST_ALLOWLIST.has(u.host))
      return { ...authGap(`redirect hop escaped the allowlisted hosts: ${u.host}`, hops) };
    if (u.searchParams.get('code')) {
      if (u.origin !== AUTH_CALLBACK || (u.pathname !== '/' && u.pathname !== '') || u.searchParams.get('state') !== state)
        return { ...authGap('authorization code landed off the registered callback or state mismatched', hops) };
      code = u.searchParams.get('code')!;
      break;
    }
    const hop = await authRequest(io, u.toString(), {}, hops, `redirect#${i + 1}`, cookies);
    if (hop.error) return { ...authGap(`redirect hop transport failed: ${hop.error}`, hops) };
    const loc = hop.headers.get('location');
    if (loc) {
      try { next = new URL(loc, u).toString(); } catch { return { ...authGap('redirect location unparseable', hops) }; }
      continue;
    }
    return { ...authGap(`redirect chain stalled: HTTP ${hop.status} with no location`, hops) };
  }
  if (!code) return { ...authGap('redirect chain exhausted without an authorization code', hops) };

  const token = await authRequest(
    io, `${AUTH_HOST}/oauth2/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: OAUTH_CLIENT,
        code,
        redirect_uri: AUTH_CALLBACK,
        code_verifier: verifier,
        state,
      }).toString(),
    },
    hops, 'oauth2/token', cookies);
  if (token.error) return { ...authGap(`token exchange transport failed: ${token.error}`, hops) };
  if (token.status !== 200) return { ...authGap(`token exchange rejected: HTTP ${token.status}`, hops) };
  const tokenBody = safeJson(token.text);
  const accessToken = typeof tokenBody?.access_token === 'string' ? tokenBody.access_token : '';
  if (!accessToken) return { ...authGap('token exchange returned no access_token', hops) };

  secrets.push(accessToken);
  for (const jar of cookies.values()) for (const v of jar.values()) if (v.length >= 6) secrets.push(v);
  const expiresAtMs =
    jwtExpMs(accessToken) ??
    (typeof tokenBody?.expires_in === 'number' && tokenBody.expires_in > 0
      ? Date.now() + tokenBody.expires_in * 1000
      : null);
  return { session: { token: accessToken, expiresAtMs, hops }, hops };
}

