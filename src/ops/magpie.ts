// Controlled, read-only Magpie route snapshot. The local gateway is the owner's subscription
// proxy; this module never calls a model, never reads a provider credential value, and never
// writes to Magpie. It records what the gateway publicly serves on loopback (catalog, quota
// windows, historical usage) plus the routing groups it stores in providers.json, binds the
// company's sealed supplier identity to the serving account, and answers `blocked` with
// structured gaps whenever a required fact is missing. Unknown provider facts stay explicit
// (null / unknown) — they are never filled with zero, never refreshed from the host clock.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describeTransportFailure, opsFetch, wholeMs, type Fetcher } from './fetcher.ts';
import {
  evidenceSchema, sha256, canonical, magpieRouteDigest, magpieEvidenceEligible, MAGPIE_SNAPSHOT_ID, MAGPIE_SNAPSHOT_MAX_AGE_SECONDS,
  MAGPIE_EXECUTION_HEADROOM_SECONDS, MAGPIE_SOURCE_CLOCK_SKEW_MS, type MagpieEvidenceV4,
} from './proof-contract.ts';
import type { ProofFiles } from './proof-files.ts';
import { redactJson } from './redact.ts';
import { supplierPasswordSecretName, supplierUsernameSecretName } from './supplier.ts';
import { magpieBase } from '../dispatcher/magpie-quota.ts';

export const MAGPIE_ADAPTER = 'magpie-controlled-route/1';
export const MAGPIE_PROVIDER = 'magpie';
/** The one business route group the controlled adapter serves; shared with magpie-restore. */
export const MAGPIE_GROUP = 'group/work' as const;
const GROUP = MAGPIE_GROUP;
const STEP_TIMEOUT_MS = 12_000;
const BUDGET_MS = 45_000;
const MIN_STEP_MS = 1_500;
const MAX_BODY_BYTES = 512 * 1024;
export const MAX_CONFIG_BYTES = 256 * 1024;
const USAGE_LIMIT = 50;
export const PROVIDERS_FILE = join(homedir(), '.config', 'magpie', 'providers.json');

interface Gap { field: string; source: string; detail: string }
export type { Gap };
export type { SourceRecord };
interface SourceRecord {
  name: 'catalog' | 'quotas' | 'usage' | 'providers';
  kind: 'http' | 'local-config';
  locator: string;
  status: number | null;
  capturedAt: string;
  httpDate: string | null;
  clockSkewMs: number | null;
  ageSeconds: number | null;
  cacheControl: string | null;
  rawSha256: string | null;
  bodyBytes: number | null;
  readAt: string | null;
  monotonicMs: number | null;
  detail?: string;
}

export interface MagpieSampleInput {
  project: string;
  env: string;
  taskId: string;
  alias: string;
  purpose: string;
  readSealed: (name: string) => Promise<string | undefined>;
  fetch?: Fetcher;
  now?: () => number;
  /** Full gateway base (scheme+host+port); defaults to the production Magpie resolver. */
  base?: string;
  endpointSource?: 'env' | 'stash' | 'default' | 'injected';
  /** Test seam; production reads ~/.config/magpie/providers.json. */
  readProviders?: () => Promise<string>;
  evidenceDir: string;
}

export interface MagpieSampleResult {
  status: 'sampled' | 'blocked';
  provider: typeof MAGPIE_PROVIDER;
  adapter: typeof MAGPIE_ADAPTER;
  alias: string;
  purpose: string;
  accountRef: string | null;
  sampledAt: string;
  document?: Record<string, unknown>;
  documentSha256?: string;
  documentFile?: string;
  receiptFile?: string;
  receipt: {
    adapter: typeof MAGPIE_ADAPTER;
    group: typeof GROUP;
    endpoint: string | null;
    endpointSource: string;
    route: { digest: string | null; routable: Array<{ model: string; provider: string }>; servedModel: string | null };
    account: { provider: string | null; accountHash: string | null; binding: string };
    subscription: Record<string, unknown> | null;
    usage: Record<string, unknown> | null;
    pricing: Record<string, unknown> | null;
    sources: SourceRecord[];
    snapshot: Record<string, unknown>;
    gaps: Gap[];
    notes: string[];
  };
  gaps: Gap[];
}

const rawNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const intOrNull = (value: unknown): number | null => {
  const n = rawNumber(value);
  return n !== null && Number.isInteger(n) ? n : null;
};
const textOrNull = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value ? value.slice(0, max) : null;
const dateOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};
export const baseId = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
export const providerOf = (id: string): string | null => {
  const cut = id.lastIndexOf('/');
  return cut > 0 ? id.slice(0, cut) : null;
};
export const safeRef = (value: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function resolveEndpoint(input: Pick<MagpieSampleInput, 'base' | 'endpointSource'>): { base: string; source: 'env' | 'stash' | 'default' | 'injected'; endpoint: string } | null {
  const source = input.base ? (input.endpointSource ?? 'injected')
    : process.env.MAGPIE_ADDR?.trim() ? 'env' : 'default';
  const raw = input.base ?? magpieBase();
  const base = raw.replace(/\/+$/, '');
  try {
    const u = new URL(base);
    if (!(u.protocol === 'http:' || u.protocol === 'https:')) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname) || !u.port) return null;
    if (u.pathname !== '/' && u.pathname !== '') return null;
    const endpoint = `${base}/v1`;
    return { base, source, endpoint };
  } catch { return null; }
}

export async function readSource(
  name: SourceRecord['name'], url: string,
  io: { fetcher: Fetcher; left: () => number; now: () => number },
): Promise<{ record: SourceRecord; body: unknown; text: string }> {
  const startedWall = io.now();
  const mono = performance.now();
  const record: SourceRecord = {
    name, kind: 'http', locator: url, status: null, capturedAt: new Date(startedWall).toISOString(),
    httpDate: null, clockSkewMs: null, ageSeconds: null, cacheControl: null, rawSha256: null,
    bodyBytes: null, readAt: null, monotonicMs: null,
  };
  const ms = wholeMs(Math.min(STEP_TIMEOUT_MS, Math.max(io.left(), MIN_STEP_MS)));
  try {
    const response = await io.fetcher(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
    const at = io.now();
    record.status = response.status;
    record.capturedAt = new Date(at).toISOString();
    record.monotonicMs = performance.now() - mono;
    record.httpDate = dateOrNull(response.headers.get('date'));
    record.clockSkewMs = record.httpDate === null ? null : at - Date.parse(record.httpDate);
    const age = response.headers.get('age');
    record.ageSeconds = age !== null && /^\d+$/.test(age) ? Number(age) : null;
    record.cacheControl = textOrNull(response.headers.get('cache-control'));
    if (response.status < 200 || response.status > 299) {
      record.detail = `HTTP ${response.status}`;
      return { record, body: null, text: '' };
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      record.bodyBytes = declared;
      record.detail = `response exceeds the ${MAX_BODY_BYTES} byte read bound`;
      return { record, body: null, text: '' };
    }
    const raw = await response.text();
    record.bodyBytes = Buffer.byteLength(raw, 'utf8');
    record.rawSha256 = sha256(raw);
    if (record.bodyBytes > MAX_BODY_BYTES) {
      record.detail = `response exceeds the ${MAX_BODY_BYTES} byte read bound`;
      return { record, body: null, text: '' };
    }
    const body = (() => { try { return JSON.parse(raw); } catch { return null; } })();
    return { record, body, text: raw };
  } catch (error) {
    record.capturedAt = new Date(io.now()).toISOString();
    record.monotonicMs = performance.now() - mono;
    record.detail = describeTransportFailure(error, ms).detail;
    return { record, body: null, text: '' };
  }
}

interface ProviderConfig {
  members: string[];
  providerRouting: Record<string, string>;
  digest: string;
}
function parseProviders(text: string): ProviderConfig | null {
  try {
    const data = JSON.parse(text) as { groups?: unknown; providers?: unknown };
    const groups = Array.isArray(data.groups) ? data.groups : [];
    const group = groups.find((row): row is { id?: unknown; members?: unknown } => !!row && typeof row === 'object' && (row as { id?: unknown }).id === GROUP);
    if (!group || !Array.isArray(group.members)) return null;
    const members = [...new Set(group.members.filter((v): v is string => typeof v === 'string' && v.length > 0))];
    const providers = Array.isArray(data.providers) ? data.providers : [];
    const providerRouting = Object.fromEntries(providers.flatMap(row => {
      if (!row || typeof row !== 'object') return [];
      const id = (row as { id?: unknown }).id, routing = (row as { routing?: unknown }).routing;
      return typeof id === 'string' && safeRef(id) ? [[id, typeof routing === 'string' ? routing.slice(0, 40) : 'smart']] : [];
    }));
    if (!members.length) return null;
    const sorted = [...members].sort();
    return {
      members: sorted,
      providerRouting,
      digest: sha256(canonical({ group: GROUP, members: sorted, providers: providerRouting })),
    };
  } catch { return null; }
}

export function parseCatalog(body: unknown): { byId: Map<string, Record<string, unknown>>; byBase: Map<string, Record<string, unknown>> } {
  const rows = Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : [];
  const byId = new Map<string, Record<string, unknown>>(), byBase = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id) continue;
    byId.set(r.id, r);
    if (!byBase.has(baseId(r.id))) byBase.set(baseId(r.id), r);
  }
  return { byId, byBase };
}

export function parseQuotaRows(body: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : [];
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
}

function parseUsageRows(body: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray((body as { rows?: unknown })?.rows) ? (body as { rows: unknown[] }).rows : [];
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
}

/**
 * Read-only snapshot of the local Magpie gateway for the `group/work` route. Returns a v4
 * evidence document only when every required fact is present; otherwise `blocked` with gaps.
 */
export async function sampleMagpieRoute(input: MagpieSampleInput): Promise<MagpieSampleResult> {
  const fetcher = input.fetch ?? opsFetch;
  const now = input.now ?? Date.now;
  const sampledMs = now();
  const sampledAt = new Date(sampledMs).toISOString();
  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  const gaps: Gap[] = [];
  const notes: string[] = [];
  const sources: SourceRecord[] = [];
  const fail = (field: string, source: string, detail: string) => gaps.push({ field, source, detail });

  const endpointInfo = resolveEndpoint(input);
  const endpoint = endpointInfo?.endpoint ?? null;
  if (!endpointInfo || !endpoint) fail('endpoint', 'magpie', 'Magpie base is not a credentialed loopback gateway with an explicit port');

  // Account binding material: compare the sealed supplier username in memory; only hashes leave.
  const sealedUsername = await input.readSealed(supplierUsernameSecretName(input.alias));
  const sealedPassword = await input.readSealed(supplierPasswordSecretName(input.alias));
  const secrets = [sealedUsername, sealedPassword].filter((v): v is string => !!v && v.length >= 6);

  // ---- providers.json (routing groups the gateway stores; only safe fields leave) ----
  let config: ProviderConfig | null = null;
  let configText = '';
  try {
    configText = input.readProviders
      ? await input.readProviders()
      : (() => {
          const info = lstatSync(PROVIDERS_FILE);
          if (!info.isFile() || info.size < 1 || info.size > MAX_CONFIG_BYTES) throw new Error('config is not a bounded regular file');
          return readFileSync(PROVIDERS_FILE, 'utf8');
        })();
    if (Buffer.byteLength(configText, 'utf8') > MAX_CONFIG_BYTES) throw new Error('config exceeds bound');
    config = parseProviders(configText);
    sources.push({
      name: 'providers', kind: 'local-config', locator: 'config:magpie/providers.json', status: 200,
      capturedAt: sampledAt, httpDate: null, clockSkewMs: null, ageSeconds: null, cacheControl: null,
      rawSha256: sha256(configText), bodyBytes: Buffer.byteLength(configText, 'utf8'), readAt: null, monotonicMs: 0,
    });
    if (!config) fail('route', 'providers', `${GROUP} is missing from the gateway routing groups`);
  } catch {
    fail('route', 'providers', 'Magpie providers.json is unreadable');
  }

  // ---- catalog / quotas / usage (bounded loopback reads) ----
  let catalogBody: unknown = null, quotaBody: unknown = null, usageBody: unknown = null;
  if (endpointInfo) {
    const reads = [
      ['catalog', `${endpointInfo.base}/v1/models`],
      ['quotas', `${endpointInfo.base}/v1/magpie/quotas`],
      ['usage', `${endpointInfo.base}/v1/magpie/usage/requests?period=7d&offset=0&limit=${USAGE_LIMIT}`],
    ] as const;
    for (const [name, url] of reads) {
      const read = await readSource(name, url, { fetcher, left, now });
      sources.push(read.record);
      if (name === 'catalog') catalogBody = read.body;
      if (name === 'quotas') quotaBody = read.body;
      if (name === 'usage') usageBody = read.body;
      if (read.record.status === null || read.record.status < 200 || read.record.status > 299) {
        fail(name === 'quotas' ? 'quota' : name, name, read.record.detail ?? `HTTP ${read.record.status ?? 'unavailable'}`);
      } else if (read.body === null) {
        fail(name === 'quotas' ? 'quota' : name, name, read.record.detail ?? 'response body was not usable JSON within the size bound');
      } else if (read.record.clockSkewMs !== null && Math.abs(read.record.clockSkewMs) > 300_000) {
        fail(name, name, 'source HTTP Date is more than five minutes from the local capture time');
      }
    }
  }

  const catalog = parseCatalog(catalogBody);
  const routable: Array<{ model: string; provider: string }> = [];
  if (config && catalog.byId.size) {
    for (const member of config.members) {
      const entry = catalog.byId.get(member) ?? catalog.byBase.get(baseId(member));
      if (!entry) { fail('routeDrift', 'catalog', `group member ${member} is not in the gateway catalog`); continue; }
      const provider = providerOf(member) ?? textOrNull(entry.owned_by) ?? textOrNull(entry.provider);
      if (!provider || !safeRef(provider)) { fail('routeDrift', 'catalog', `group member ${member} has no safe provider identity`); continue; }
      const model = baseId(member);
      if (!/^[A-Za-z0-9_.-]{1,160}$/.test(model)) { fail('routeDrift', 'catalog', `group member ${member} has an unsupported model id`); continue; }
      if (!routable.some(row => row.model === model)) routable.push({ model, provider });
    }
    if (!routable.length) fail('route', 'catalog', 'no group/work member is routable from the gateway catalog');
  }
  const routeDigest = routable.length ? magpieRouteDigest(routable) : null;

  // ---- account binding: the sealed supplier username must match exactly one gateway account ----
  const quotaRows = parseQuotaRows(quotaBody);
  const matches = sealedUsername ? quotaRows.filter(row => row.user === sealedUsername) : [];
  if (!sealedUsername) fail('accountBinding', 'sealed-store', `no sealed SUPPLIER_${input.alias}_USERNAME; the gateway account cannot be bound`);
  else if (matches.length === 0) fail('accountBinding', 'quotas', 'no Magpie account matches the sealed supplier username');
  else if (matches.length > 1) fail('accountBinding', 'quotas', 'more than one Magpie account matches the sealed supplier username');
  const accountRow = matches.length === 1 ? matches[0]! : null;
  const accountProvider = accountRow ? textOrNull(accountRow.provider, 128) : null;
  if (accountRow && (!accountProvider || !safeRef(accountProvider))) fail('accountBinding', 'quotas', 'matched Magpie account has no safe provider identity');
  const accountHash = accountRow && accountProvider ? sha256(`magpie|${accountProvider}|${String(accountRow.user)}`) : null;
  const identityHash = accountHash ? sha256(`magpie-identity|${accountHash}`) : null;
  const accountRef = accountHash ? `mgp${accountHash.slice(0, 24)}` : null;
  if (accountRef && !/^mgp[a-f0-9]{24}$/.test(accountRef)) fail('accountBinding', 'quotas', 'account reference is not canonical');
  if (accountProvider && routable.some(row => row.provider !== accountProvider)) {
    fail('accountBinding', 'catalog', 'the routable set spans a provider other than the bound account');
  }
  if (accountProvider && config && !(accountProvider in config.providerRouting)) {
    fail('accountBinding', 'providers', 'the bound account provider is not in the gateway routing configuration');
  }

  // ---- subscription / balance windows ----
  let subscription: MagpieEvidenceV4['subscription'] | null = null;
  let balance: MagpieEvidenceV4['balance'] | null = null;
  let quotaReadAt: string | null = null;
  if (accountRow && accountProvider) {
    quotaReadAt = dateOrNull(accountRow.readAt);
    if (quotaReadAt === null) fail('staleBalance', 'quotas', 'quota snapshot has no readable readAt; freshness cannot be established');
    else if (Date.parse(quotaReadAt) > sampledMs + 1_000) {
      fail('staleBalance', 'quotas', 'quota snapshot readAt is in the future relative to this capture');
    } else if (sampledMs - Date.parse(quotaReadAt) > MAGPIE_SNAPSHOT_MAX_AGE_SECONDS * 1000) {
      fail('staleBalance', 'quotas', `quota snapshot readAt is older than the snapshot maxAge; the local capture time does not refresh it`);
    }
    // Every reported window is accounted for: a row that cannot be represented in the v4 document
    // is a structured gap, never a silent drop. A dropped row could hide an exhausted or unknown
    // window behind a healthy sibling.
    const windows: MagpieEvidenceV4['subscription']['windows'] = [];
    const windowRows = Array.isArray(accountRow.windows) ? accountRow.windows : [];
    windowRows.forEach((value, index) => {
      if (!value || typeof value !== 'object') {
        fail('quota', 'quotas', `quota window #${index + 1} is not an object; its remaining quota cannot be established`);
        return;
      }
      const w = value as Record<string, unknown>;
      const name = textOrNull(w.name, 80) ?? `额度窗口 #${index + 1}`;
      const unlimited = w.unlimited === true;
      const resetsAt = dateOrNull(w.resetsAt);
      if (resetsAt === null && w.resetsAt !== undefined && w.resetsAt !== null) {
        fail('quota', 'quotas', `quota window ${name} has an unreadable resetsAt; its reset time cannot be established`);
        return;
      }
      const remainingPct = rawNumber(w.remaining);
      if (remainingPct === null || remainingPct > 100) {
        // An unlimited window has no quota to prove, but the v4 document still carries a numeric
        // percentage; inventing one would fabricate a balance, so the snapshot stays closed instead.
        fail('quota', 'quotas', unlimited
          ? `quota window ${name} is unlimited but has no readable remaining percentage; the v4 snapshot cannot represent it without inventing a number`
          : `quota window ${name} has no readable remaining percentage (0-100); an exhausted or unknown window is never dropped`);
        return;
      }
      windows.push({
        name, remainingPct, resetsAt,
        limit: rawNumber(w.limit), amount: rawNumber(w.amount), unit: textOrNull(w.unit, 40),
        unlimited,
      });
    });
    if (!windows.length && !windowRows.length) fail('quota', 'quotas', 'the bound account reports no quota window; usable remaining quota cannot be established');
    else {
      if (windows.some(w => !w.unlimited && w.remainingPct <= 0)) fail('quotaInsufficient', 'quotas', 'a quota window is exhausted; the snapshot cannot establish usable remaining quota');
      if (windows.some(w => w.resetsAt !== null && Date.parse(w.resetsAt) <= sampledMs)) fail('quotaExpired', 'quotas', 'a quota window already reset at capture time');
      const until = dateOrNull(accountRow.until);
      if (until !== null && Date.parse(until) <= sampledMs) fail('subscription', 'quotas', 'the subscription already expired at capture time');
      subscription = {
        provider: accountProvider,
        kind: (['subscription', 'plan', 'api'] as const).find(k => k === accountRow.kind) ?? 'unknown',
        until, renew: textOrNull(accountRow.renew, 40), readAt: quotaReadAt, windows,
      };
      balance = { absoluteAmount: null, unit: null, source: 'magpie-percentage-windows', disclosure: 'percentages are not an absolute balance' };
    }
  }

  // ---- usage association: a completed request whose served model is in the approved set ----
  let usage: MagpieEvidenceV4['usage'] | null = null;
  let servedModel: string | null = null;
  let pricingEntry: Record<string, unknown> | null = null;
  if (accountRow && accountProvider) {
    let unknownCompletion = 0;
    const candidates = parseUsageRows(usageBody).flatMap((row): Array<{ row: Record<string, unknown>; at: number }> => {
      const at = dateOrNull(row.t);
      // A row that claims to have completed after this capture (beyond the source-skew bound) is not evidence
      // of a served model; it must not be chosen just because its timestamp sorts first.
      if (at !== null && Date.parse(at) > sampledMs + MAGPIE_SOURCE_CLOCK_SKEW_MS) return [];
      const provider = textOrNull(row.provider, 128);
      const model = textOrNull(row.model, 160);
      if (!at || provider !== accountProvider || !model) return [];
      if (!routable.some(entry => entry.model === baseId(model))) return [];
      if (textOrNull(row.response_id) === null && textOrNull(row.id) === null) return [];
      if (row.route_id === undefined || row.route_id === null) return [];
      // Completion must be explicit: a missing, false or non-boolean done is an unknown state and
      // can never be associated as a completed usage row.
      if (row.done !== true) { unknownCompletion += 1; return []; }
      return [{ row, at: Date.parse(at) }];
    }).sort((a, b) => b.at - a.at);
    const hit = candidates[0];
    if (!hit) {
      fail('usage', 'usage', unknownCompletion
        ? `a matching Magpie request has no explicit done=true (${unknownCompletion} row(s)); an unknown completion state is not a completed usage association`
        : 'no completed Magpie request associates a served model in group/work with the bound account');
    } else {
      const row = hit.row;
      const inputTokens = intOrNull(row.in), outputTokens = intOrNull(row.out);
      if (inputTokens === null || outputTokens === null) fail('usage', 'usage', 'the associated request has no numeric input/output usage');
      if (inputTokens !== null && outputTokens !== null) {
        const priced = row.priced === true;
        const cost = priced ? rawNumber(row.cost) : null;
        if (priced && cost === null) fail('usage', 'usage', 'a priced request has no readable cost; it is not zero-filled');
        servedModel = baseId(String(row.model));
        usage = {
          requestId: textOrNull(row.response_id, 200) ?? textOrNull(row.id, 200) ?? 'unknown',
          runId: String(row.route_id).slice(0, 64),
          provider: accountProvider,
          servedModel,
          at: new Date(hit.at).toISOString(),
          providerKeyIdHash: typeof row.providerKeyId === 'string' ? sha256(`magpie-key|${row.providerKeyId}`) : null,
          usage: {
            input: inputTokens, output: outputTokens,
            cacheRead: intOrNull(row.cache_read), cacheWrite: intOrNull(row.cache_write),
            reasoning: intOrNull(row.reasoning) ?? intOrNull(row.reasoning_tokens),
            total: intOrNull(row.total),
          },
          cost: priced ? cost : null,
          costUnknown: !priced,
          priced,
        };
        pricingEntry = catalog.byBase.get(servedModel) ?? catalog.byId.get(String(row.model)) ?? null;
      }
    }
  }

  // ---- pricing observation (never converted into a reviewed certificate) ----
  let pricing: MagpieEvidenceV4['pricing'] | null = null;
  if (servedModel && pricingEntry) {
    const rawPricing = (pricingEntry.pricing && typeof pricingEntry.pricing === 'object') ? pricingEntry.pricing as Record<string, unknown> : null;
    const input = rawPricing ? rawNumber(rawPricing.input) : null;
    const output = rawPricing ? rawNumber(rawPricing.output) : null;
    // Zero-price evidence requires the source to state numeric zero input AND output. A `free`
    // flag with missing or non-zero prices is an unclear price, never a zero-price certificate.
    const zeroPrices = input === 0 && output === 0;
    if (pricingEntry.free === true && !zeroPrices) {
      fail('price', 'catalog', `served model ${servedModel} is marked free but does not state numeric zero input and output prices; a free claim without zero prices is not zero-price evidence`);
    } else if (input === null && output === null) {
      fail('price', 'catalog', `served model ${servedModel} has no catalog pricing and is not marked free`);
    } else {
      const currency = textOrNull(rawPricing?.currency, 8) ?? textOrNull(pricingEntry.currency, 8);
      const revision = `magpie-catalog-${sha256(canonical({ model: servedModel, pricing: rawPricing, free: zeroPrices })).slice(0, 12)}`;
      pricing = {
        priceRevision: revision, source: 'magpie-catalog', reviewed: false, free: zeroPrices,
        freeEvidence: zeroPrices ? 'magpie-catalog-zero' : 'none',
        inputPerToken: input, outputPerToken: output, currency,
        subscriptionCost: { disclosed: false },
        marginalCost: { unitInput: input, unitOutput: output },
      };
    }
  }

  // ---- capture window: TTL, known source expiry/reset, and the 90 minute execution headroom ----
  const expiryCandidates = [sampledMs + MAGPIE_SNAPSHOT_MAX_AGE_SECONDS * 1000];
  if (subscription?.until) expiryCandidates.push(Date.parse(subscription.until));
  if (subscription) for (const w of subscription.windows) if (w.resetsAt) expiryCandidates.push(Date.parse(w.resetsAt));
  const expiryMs = Math.min(...expiryCandidates.filter(Number.isFinite));
  if (expiryMs - sampledMs < MAGPIE_EXECUTION_HEADROOM_SECONDS * 1000) {
    fail('headroom', 'snapshot', `evidence window is shorter than the ${MAGPIE_EXECUTION_HEADROOM_SECONDS / 60} minute execution headroom; the sample is closed rather than extended`);
  }

  const bindingProven = !!(accountRow && sealedUsername && accountRow.user === sealedUsername && accountHash && identityHash);
  const blockedReasons: Array<'account-ownership' | 'price-not-reviewed'> = [];
  if (!bindingProven) blockedReasons.push('account-ownership');
  if (pricing && !pricing.reviewed) blockedReasons.push('price-not-reviewed');
  const canDocument = gaps.length === 0 && !!endpointInfo && !!endpoint && !!accountRef && !!accountProvider
    && !!subscription && !!usage && !!pricing && !!routeDigest && !!servedModel && routable.length > 0
    && bindingProven && expiryMs > sampledMs;

  let document: Record<string, unknown> | undefined;
  let documentSha256: string | undefined;
  let documentFile: string | undefined;
  if (canDocument) {
    const candidate = {
      schemaVersion: 4,
      type: 'magpie-controlled-route',
      evidenceClass: 'controlled-route-snapshot',
      accountRef: accountRef!,
      endpoint: endpoint!,
      priceRevision: pricing!.priceRevision,
      sampledAt,
      expiresAt: new Date(expiryMs).toISOString(),
      serviceApproved: true,
      account: {
        provider: accountProvider!, accountHash: accountHash!, identityHash: identityHash!,
        binding: 'company-sealed-account', ownership: 'company-sealed-account', source: 'magpie-quotas',
      },
      endpointBinding: { source: endpointInfo!.source, loopback: true },
      route: {
        group: GROUP, revision: config?.digest ?? null,
        revisionSource: config ? 'magpie-config-digest' : 'not-exposed', digest: routeDigest!,
        digestAlgorithm: 'canonical-json/1', routable,
        servedModel: servedModel!, servedModelSource: 'magpie-usage-requests',
        association: 'served-model-in-approved-routable-set', observedAt: usage!.at,
      },
      snapshot: {
        id: MAGPIE_SNAPSHOT_ID, capturedAt: sampledAt, maxAgeSeconds: MAGPIE_SNAPSHOT_MAX_AGE_SECONDS,
        invalidatesOn: ['route-digest-change', 'account-change', 'price-revision-change', 'quota-reset'],
      },
      sources: sources.map(s => ({
        name: s.name, kind: s.kind, locator: s.locator, status: s.status, capturedAt: s.capturedAt,
        httpDate: s.httpDate, clockSkewMs: s.clockSkewMs, ageSeconds: s.ageSeconds, cacheControl: s.cacheControl,
        rawSha256: s.rawSha256, bodyBytes: s.bodyBytes, readAt: s.name === 'quotas' ? quotaReadAt : null,
      })),
      subscription: subscription!,
      balance: balance!,
      usage: usage!,
      pricing: pricing!,
      approvalReadiness: { ready: blockedReasons.length === 0, blockedReasons },
    };
    const parsed = evidenceSchema.safeParse(candidate);
    if (!parsed.success) {
      fail('document', 'sampler', `generated document failed the magpie-controlled-route v4 schema: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    } else {
      const bytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n', 'utf8');
      document = candidate;
      documentSha256 = sha256(bytes);
      mkdirSync(input.evidenceDir, { recursive: true, mode: 0o700 });
      documentFile = join(input.evidenceDir, `magpie-route-${sampledMs}.json`);
      writeFileSync(documentFile, bytes, { mode: 0o600 });
      notes.push('pricing is source-observed but unreviewed; approvalReadiness stays false and no enable proof can use this document until a reviewed price decision exists');
    }
  } else {
    notes.push('document not generated: one or more required Magpie facts could not be established; see gaps');
  }

  const receipt = {
    adapter: MAGPIE_ADAPTER,
    group: GROUP,
    endpoint,
    endpointSource: endpointInfo?.source ?? 'unresolved',
    route: { digest: routeDigest, routable, servedModel },
    account: { provider: accountProvider, accountHash, binding: bindingProven ? 'company-sealed-account' : (sealedUsername ? 'mismatch' : 'unverified') },
    subscription: subscription ? { provider: subscription.provider, kind: subscription.kind, until: subscription.until, readAt: subscription.readAt, windowCount: subscription.windows.length } : null,
    usage: usage ? { requestId: usage.requestId, runId: usage.runId, servedModel: usage.servedModel, at: usage.at, priced: usage.priced, costUnknown: usage.costUnknown } : null,
    pricing: pricing ? { priceRevision: pricing.priceRevision, reviewed: pricing.reviewed, free: pricing.free, freeEvidence: pricing.freeEvidence, costUnknown: usage?.costUnknown ?? true } : null,
    sources,
    snapshot: {
      id: MAGPIE_SNAPSHOT_ID, capturedAt: sampledAt, maxAgeSeconds: MAGPIE_SNAPSHOT_MAX_AGE_SECONDS,
      expiresAt: new Date(expiryMs).toISOString(), executionHeadroomSeconds: MAGPIE_EXECUTION_HEADROOM_SECONDS,
      disclosure: 'local evidence freshness, not a provider commitment',
    },
    gaps,
    notes,
  };
  mkdirSync(input.evidenceDir, { recursive: true, mode: 0o700 });
  const receiptFile = join(input.evidenceDir, `magpie-route-${sampledMs}-receipt.json`);
  writeFileSync(receiptFile, Buffer.from(JSON.stringify(redactJson({
    ...receipt, alias: input.alias, purpose: input.purpose, taskId: input.taskId,
    accountRef, sampledAt, documentSha256: documentSha256 ?? null, generated: !!document,
  }, secrets), null, 2) + '\n', 'utf8'), { mode: 0o600 });

  return redactJson({
    status: document ? 'sampled' : 'blocked',
    provider: MAGPIE_PROVIDER,
    adapter: MAGPIE_ADAPTER,
    alias: input.alias,
    purpose: input.purpose,
    accountRef,
    sampledAt,
    ...(document ? { document, documentSha256, documentFile } : {}),
    receiptFile,
    receipt,
    gaps,
  }, secrets) as MagpieSampleResult;
}

export interface MagpieWindowResult {
  eligible: boolean;
  blockedReasons: string[];
  headroomSeconds: number;
  evidenceExpiresAt: string;
  window?: { approvalTask: string; configurationDigest: string; evidenceExpiresAt: string; minRemainingSeconds: number; notAfter: string };
}
/**
 * The window proxy adapter: the company's executionWindow interface is unchanged, so this
 * derives the exact object an owner may bind, or explains why no window can be issued. It
 * writes nothing; the owner still performs the controlled resume/window binding.
 */
export function magpieWindowFromEvidence(files: ProofFiles, approvalTask: string, now: number): MagpieWindowResult {
  const evidence = files.evidence;
  const evidenceExpiresAt = evidence.expiresAt;
  const headroomSeconds = Math.floor((Date.parse(evidenceExpiresAt) - now) / 1000);
  const sampleInFuture = Date.parse(evidence.sampledAt) > now;
  if (evidence.type !== 'magpie-controlled-route') {
    if (sampleInFuture) return { eligible: false, blockedReasons: ['sample-in-future'], headroomSeconds, evidenceExpiresAt };
    return { eligible: false, blockedReasons: ['not-magpie-evidence'], headroomSeconds, evidenceExpiresAt };
  }
  const reasons = new Set<string>(evidence.approvalReadiness.blockedReasons);
  if (sampleInFuture) reasons.add('sample-in-future');
  if (Date.parse(evidence.usage.at) > now) reasons.add('usage-in-future');
  if (!evidence.approvalReadiness.ready || !evidence.pricing.reviewed) reasons.add('price-not-reviewed');
  if (headroomSeconds < MAGPIE_EXECUTION_HEADROOM_SECONDS) reasons.add('insufficient-headroom');
  const notAfterMs = Date.parse(evidenceExpiresAt) - MAGPIE_EXECUTION_HEADROOM_SECONDS * 1000;
  if (notAfterMs <= now) reasons.add('insufficient-headroom');
  if (!magpieEvidenceEligible(evidence, now) && reasons.size === 0) reasons.add('evidence-not-eligible');
  if (reasons.size) return { eligible: false, blockedReasons: [...reasons], headroomSeconds, evidenceExpiresAt };
  return {
    eligible: true, blockedReasons: [], headroomSeconds, evidenceExpiresAt,
    window: {
      approvalTask, configurationDigest: files.manifest.configurationDigest, evidenceExpiresAt,
      minRemainingSeconds: MAGPIE_EXECUTION_HEADROOM_SECONDS, notAfter: new Date(notAfterMs).toISOString(),
    },
  };
}
