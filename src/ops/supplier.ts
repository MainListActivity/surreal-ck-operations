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
import { evidenceSchema, sha256, TOKEN_PLAN_PLAN_TYPE_FREE } from './proof-contract.ts';
import { clip, redactJson } from './redact.ts';

/**
 * The fixed SenseNova adapter (v2). Every endpoint, method and field below was reviewed
 * against the provider's public pages and console surface; callers can never steer the
 * sampler to another host, path, method or body.
 */
export const SUPPLIER_ADAPTER = 'sensenova-token-plan/2';
export const SUPPLIER_PROVIDER = 'sensenova';
const API_BASE = 'https://token.sensenova.cn/v1';
const CONSOLE_API = 'https://platform.sensenova.cn/lite/console/v1';
const PLAN_PAGE = 'https://www.sensenova.cn/token-plan';
const BOUND_MODEL = 'sensenova-6.8-flash-lite';
const BOUND_PRICE_REVISION = 'sensenova-token-plan-2026-10-10';
const PLAN_NAME = 'SenseNova Token Plan Free · 公测';
const QUOTA = { unit: 'points', amount: 60_000, windowSeconds: 18_000 } as const;
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
}
interface PoolFacts {
  poolType: string; name: string;
  limit5h: number | null; remaining5h: number | null; reset5h: number | null;
  limit7d: number | null; remaining7d: number | null; reset7d: number | null;
}
interface ProbeBody { status: number; ms: number; body: unknown; text: string }

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
  io: { fetcher: Fetcher; left: () => number }, record: SourceRecord,
): Promise<ProbeBody | null> {
  const started = Date.now();
  const ms = Math.min(STEP_TIMEOUT_MS, Math.max(io.left(), MIN_STEP_MS));
  record.ms = 0;
  try {
    const response = await io.fetcher(url, { ...init, signal: AbortSignal.timeout(ms) });
    record.status = response.status;
    record.ms = Date.now() - started;
    if (response.status >= 300 && response.status <= 399) {
      record.detail = 'redirect rejected by policy';
      return { status: response.status, ms: record.ms, body: null, text: '' };
    }
    const text = clip(await response.text().catch(() => ''), MAX_BODY_BYTES);
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* non-JSON is recorded by status only */ }
    return { status: response.status, ms: record.ms, body, text };
  } catch (error) {
    record.ms = Date.now() - started;
    record.detail = describeTransportFailure(error, ms).detail;
    return null;
  }
}

/**
 * Official plan-page applicability markers (zh page, reviewed 2026-10): the free beta is
 * fully open, paid tiers are only announced, and the 60k-points / 5-hour fact is stated.
 * If the copy changes (e.g. paid tiers launch) a marker disappears and the sampler blocks
 * for re-review instead of reusing stale applicability.
 */
function planPageMarkers(text: string): Record<string, boolean> {
  const flat = text.replace(/<script[^>]*>[\s\S]*?<\/script>|<style[^>]*>[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return {
    freeBetaOpen: flat.includes('公测期完全免费开放'),
    paidTiersUpcoming: flat.includes('付费档位即将上线'),
    quota5h: flat.includes('60,000') && flat.includes('5 小时'),
    freeTierNamed: flat.includes('Free') && flat.includes('公测'),
  };
}

/** Parses the console pool-usage payload; null when the shape drifted beyond recognition. */
function parsePools(body: unknown): PoolFacts[] | null {
  if (!body || typeof body !== 'object') return null;
  const pools = (body as { pools?: unknown }).pools;
  if (!Array.isArray(pools)) return null;
  return pools.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object').map(p => {
    const w5 = (p.window_5h ?? {}) as Record<string, unknown>;
    const w7 = (p.window_7d ?? {}) as Record<string, unknown>;
    return {
      poolType: typeof p.pool_type === 'string' ? p.pool_type : 'unknown',
      name: typeof p.name === 'string' ? p.name.slice(0, 80) : '',
      limit5h: numberOrNull(w5.limit), remaining5h: numberOrNull(w5.remaining), reset5h: secondsOrNull(w5.reset_at),
      limit7d: numberOrNull(w7.limit), remaining7d: numberOrNull(w7.remaining), reset7d: secondsOrNull(w7.reset_at),
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
    const res = await probe('models', `${API_BASE}/models`, bearer(apiKey), { fetcher, left }, record);
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

  // ---- source: official plan page (applicability of plan facts) ----
  const pageRecord = source('planPage', PLAN_PAGE);
  const page = await probe('planPage', PLAN_PAGE, { method: 'GET', redirect: 'manual', headers: { accept: 'text/html' } }, { fetcher, left }, pageRecord);
  const markers = page && page.status === 200 ? planPageMarkers(page.text) : null;
  if (page && page.status === 200 && markers) {
    pageRecord.ok = true;
    derivations.planPageMarkers = markers;
    for (const [key, hit] of Object.entries(markers)) {
      if (!hit) gaps.push({ field: 'planApplicability', source: 'planPage', detail: `official plan page marker ${key} no longer holds` });
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
      probe('apiKeys', `${CONSOLE_API}/metered/api-keys?page_size=${API_KEY_PAGE_SIZE}`, bearer(consoleToken), { fetcher, left }, keysRecord),
      probe('poolUsage', `${CONSOLE_API}/tokenplan/pool-usage`, bearer(consoleToken), { fetcher, left }, poolRecord),
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
          bearer(consoleToken), { fetcher, left }, keysRecord);
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
      PAYMENT_SURFACE_PATHS.map((path, i) => probe('paymentSurface', `${CONSOLE_API}${path}`, bearer(consoleToken), { fetcher, left }, surfaceRecords[i]!)),
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
  const applicabilityOk = markers !== null && Object.values(markers).every(Boolean);
  const accountBound = poolsOk && crossBound;
  derivations.accountBound = accountBound;
  derivations.applicabilityOk = applicabilityOk;
  // Only the authenticated console plan record, cross-bound to the sealed API key,
  // establishes FREE. Public copy, model liveness and HTTP 404s are not account facts.
  const accountPlanFree = accountBound && accountPlan?.type === TOKEN_PLAN_PLAN_TYPE_FREE;
  derivations.accountPlan = accountPlan;
  derivations.accountPlanFree = accountPlanFree;
  derivations.accountPlanSource = { source: 'poolUsage', accountBound, verified: accountPlanFree };
  derivations.consolePaymentSurfaceAbsent = paymentSurfaceAbsent;
  derivations.paymentStateSources = ACCOUNT_PAYMENT_SOURCES.length;
  derivations.removedAccountAssertions = ['noPaymentInstrument', 'autoTopupDisabled'];
  notes.push('the revised contract dropped the account-level payment assertions noPaymentInstrument/autoTopupDisabled; their absence is contractual, not a gap more probing could close');
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

  const governing = pools.length ? governingPool(pools) : undefined;
  let quotaRemaining: number | null = null;
  const quotaVerified = !!governing && governing.limit5h === QUOTA.amount;
  derivations.quotaHardCapVerified = quotaVerified;
  if (!quotaVerified) gaps.push({ field: 'quota', source: 'poolUsage', detail: 'governing pool hard cap missing or differs from reviewed official quota' });
  if (governing) {
    quotaRemaining = governing.remaining5h;
    if (quotaRemaining === null) {
      gaps.push({ field: 'quotaRemaining', source: 'poolUsage', detail: `governing pool ${governing.poolType} exposes no 5h remaining figure` });
    }
    if (governing.limit5h !== null && governing.limit5h !== QUOTA.amount) {
      notes.push(`governing pool 5h limit ${governing.limit5h} differs from certified ${QUOTA.amount}; document blocked for quota re-review`);
    }
  }

  let canDocument = !!accountRef && keyLive && modelListed && accountBound && accountPlanFree && applicabilityOk && quotaVerified;
  let document: Record<string, unknown> | undefined;
  let documentSha256: string | undefined;
  let documentFile: string | undefined;
  let expiresAt: string | undefined;

  const resets = [governing?.reset5h, governing?.reset7d].filter((v): v is number => typeof v === 'number');
  const expiryMs = Math.min(sampledMs + MAX_DOC_AGE_MS, ...(resets.length ? resets.map(s => s * 1000) : [sampledMs + MAX_DOC_AGE_MS]));
  if (expiryMs <= sampledMs) {
    // A window boundary the provider already passed would make any document born-expired;
    // report the stale facts even when the call is already blocked for other reasons.
    gaps.push({ field: 'expiresAt', source: 'poolUsage', detail: 'pool window reset already elapsed; sampled facts are stale on arrival' });
    canDocument = false;
  }
  if (canDocument) {
    expiresAt = new Date(expiryMs).toISOString();
    document = {
      schemaVersion: 2,
      type: 'reviewed-token-plan',
      accountRef: accountRef!,
      endpoint: API_BASE,
      model: BOUND_MODEL,
      priceRevision: BOUND_PRICE_REVISION,
      sampledAt,
      expiresAt,
      planName: PLAN_NAME,
      planSourceUrl: PLAN_PAGE,
      quotaUnit: QUOTA.unit,
      quotaAmount: QUOTA.amount,
      quotaWindowSeconds: QUOTA.windowSeconds,
      quotaRemaining,
      accountPlanType: accountPlan!.type,
      // The document's approval claim: it takes effect only through ops_internal_ai_prove's
      // independent task-service approval receipt, never on this field alone.
      serviceApproved: true,
    };
    const parsed = evidenceSchema.safeParse(document);
    if (!parsed.success) {
      gaps.push({ field: 'document', source: 'sampler', detail: 'generated document failed the reviewed-token-plan schema' });
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

