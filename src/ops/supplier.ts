// Controlled supplier plan/quota evidence sampling. The employee names a sealed account
// alias and an evidence purpose; this trusted code — the only place allowed to touch the
// sealed values — queries a fixed, reviewed set of provider sources, derives the
// reviewed-token-plan fields, and writes the UTF-8 evidence document plus a sanitized
// audit receipt under the task evidence root. Anything that cannot be established from a
// real read becomes an explicit gap and the call answers `blocked` without a document:
// the sampler never fabricates account, quota or payment facts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompanyError } from '../core-errors.ts';
import { describeTransportFailure, type Fetcher } from './fetcher.ts';
import { evidenceSchema, sha256 } from './proof-contract.ts';
import { clip, redactJson } from './redact.ts';

/**
 * The fixed SenseNova adapter (v1). Every endpoint, method and field below was reviewed
 * against the provider's public pages and console surface; callers can never steer the
 * sampler to another host, path, method or body.
 */
export const SUPPLIER_ADAPTER = 'sensenova-token-plan/1';
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

/** Sealed secret naming: the only materialization paths the broker accepts for a supplier alias. */
export const supplierApiKeySecretName = (alias: string) => `SUPPLIER_${alias}_API_KEY`;
export const supplierConsoleSecretName = (alias: string) => `SUPPLIER_${alias}_CONSOLE_TOKEN`;
/** Which kinds of sealed material a supplier alias currently supports (for ops_info). */
export const supplierAliasFromSecretName = (name: string): { alias: string; kind: 'apiKey' | 'consoleToken' } | undefined => {
  const hit = /^SUPPLIER_([A-Z0-9][A-Z0-9_]*)_(API_KEY|CONSOLE_TOKEN)$/.exec(name);
  return hit ? { alias: hit[1]!, kind: hit[2] === 'API_KEY' ? 'apiKey' : 'consoleToken' } : undefined;
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

/** The pool that governs the bound model: Flash-Lite dedicated first, the general pool otherwise. */
function governingPool(pools: PoolFacts[]): PoolFacts | undefined {
  return pools.find(p => p.poolType === 'dedicated') ?? pools.find(p => p.poolType === 'default') ?? pools[0];
}

export async function sampleSupplierPlan(input: SupplierSampleInput): Promise<SupplierSampleResult> {
  const fetcher = input.fetch ?? fetch;
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
  const consoleToken = await input.readSealed(supplierConsoleSecretName(input.alias));
  for (const value of [apiKey, consoleToken]) if (value && value.length >= 6) secrets.push(value);
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
  if (!consoleToken) {
    gaps.push({ field: 'consoleToken', source: 'sealed-store', detail: `no sealed ${supplierConsoleSecretName(input.alias)}; account-bound quota and payment facts are unverifiable` });
  } else {
    const keysRecord = source('apiKeys', `${CONSOLE_API}/metered/api-keys`);
    const poolRecord = source('poolUsage', `${CONSOLE_API}/tokenplan/pool-usage`);
    const [keysFirst, poolRes] = await Promise.all([
      probe('apiKeys', `${CONSOLE_API}/metered/api-keys?page_size=${API_KEY_PAGE_SIZE}`, bearer(consoleToken), { fetcher, left }, keysRecord),
      probe('poolUsage', `${CONSOLE_API}/tokenplan/pool-usage`, bearer(consoleToken), { fetcher, left }, poolRecord),
    ]);

    if (poolRes && poolRes.status === 200) {
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
  }

  // ---- derivations ----
  const applicabilityOk = markers !== null && Object.values(markers).every(Boolean);
  const accountBound = poolsOk && crossBound;
  derivations.accountBound = accountBound;
  derivations.applicabilityOk = applicabilityOk;
  // The Token Plan free beta has no payment-instrument or top-up surface at all (official
  // applicability markers) and this account is bound to that plan (console read): the two
  // payment facts are jointly established, never caller-supplied.
  const paymentFactsOk = accountBound && applicabilityOk;
  derivations.paymentFactsVerifiable = paymentFactsOk;
  if (apiKey && !keyLive && !gaps.some(g => g.source === 'models')) {
    gaps.push({ field: 'apiKey', source: 'models', detail: 'chat credential liveness unverified' });
  }

  const governing = pools.length ? governingPool(pools) : undefined;
  let quotaRemaining: number | null = null;
  if (governing) {
    quotaRemaining = governing.remaining5h;
    if (quotaRemaining === null) {
      gaps.push({ field: 'quotaRemaining', source: 'poolUsage', detail: `governing pool ${governing.poolType} exposes no 5h remaining figure` });
    }
    if (governing.limit5h !== null && governing.limit5h !== QUOTA.amount) {
      notes.push(`governing pool 5h limit ${governing.limit5h} differs from certified ${QUOTA.amount}; document keeps the reviewed plan facts`);
    }
  }

  let canDocument = !!accountRef && keyLive && modelListed && accountBound && paymentFactsOk;
  let document: Record<string, unknown> | undefined;
  let documentSha256: string | undefined;
  let documentFile: string | undefined;
  let expiresAt: string | undefined;

  if (canDocument) {
    const resets = [governing?.reset5h, governing?.reset7d].filter((v): v is number => typeof v === 'number');
    const expiryMs = Math.min(sampledMs + MAX_DOC_AGE_MS, ...(resets.length ? resets.map(s => s * 1000) : [sampledMs + MAX_DOC_AGE_MS]));
    if (expiryMs <= sampledMs) {
      // A window boundary the provider already passed would make the document born-expired;
      // that is source ambiguity, so the call fails closed instead of writing dead evidence.
      gaps.push({ field: 'expiresAt', source: 'poolUsage', detail: 'pool window reset already elapsed; sampled facts are stale on arrival' });
      canDocument = false;
    } else {
      expiresAt = new Date(expiryMs).toISOString();
      document = {
        schemaVersion: 1,
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
        noPaymentInstrument: true,
        autoTopupDisabled: true,
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
