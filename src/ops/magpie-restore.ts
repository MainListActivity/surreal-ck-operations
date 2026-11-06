// Controlled plan/apply restore for the local Magpie routing group and the sealed supplier
// username binding. The 2026-10-28 FV06 route sample could not produce evidence because
// `group/work` was missing from the gateway routing config and no `SUPPLIER_MAGPIE_USERNAME`
// was sealed; no tool could repair either. This module runs inside the ops broker (the same
// proxy that already reads the gateway), so the credential-bearing config never leaves this
// process: plan answers only safe ids, hashes and a bounded validity window, and apply performs
// at most one CAS-guarded append plus the sealed binding — never a rewrite of existing groups,
// providers, credentials or default routing, and never a gateway restart.
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CompanyError } from '../core-errors.ts';
import { opsFetch, type Fetcher } from './fetcher.ts';
import { canonical, sha256 } from './proof-contract.ts';
import { redactJson } from './redact.ts';
import { supplierUsernameSecretName } from './supplier.ts';
import {
  MAGPIE_ADAPTER, MAGPIE_GROUP, MAGPIE_PROVIDER, MAX_CONFIG_BYTES, PROVIDERS_FILE,
  baseId, parseCatalog, parseQuotaRows, providerOf, readSource, resolveEndpoint, safeRef,
  sampleMagpieRoute, type Gap, type SourceRecord,
} from './magpie.ts';

/** Only the company's Magpie supplier alias may be repaired; the sealed key is derived from it. */
export const MAGPIE_RESTORE_ALIAS = 'MAGPIE' as const;
/** A plan is a bounded snapshot: after this window apply refuses and the owner re-plans. */
export const MAGPIE_RESTORE_PLAN_TTL_MS = 15 * 60_000;
const PLAN_CLOCK_SKEW_MS = 60_000;
const MAX_MEMBERS = 20;
const MAX_LISTED = 20;
const MAX_JOURNAL_ENTRIES = 20;
const BUDGET_MS = 45_000;
const LOCK_STALE_MS = 60_000;
const LOCK_ATTEMPTS = 10;
const BACKUP_PREFIX = 'providers.json.bak-';

interface RestoreIo {
  fetch?: Fetcher;
  now?: () => number;
  base?: string;
  endpointSource?: 'env' | 'stash' | 'default' | 'injected';
  /** Test seam; production edits the gateway's own file. */
  configPath?: string;
  /** Test seam shared with the sampler; production reads the config file. */
  readProviders?: () => Promise<string>;
  /** Test seam; production keeps plan/idempotency state in the service home. */
  journalPath?: string;
  /** Where the post-apply read-only sample writes its receipt. */
  evidenceDir: string;
}

export interface MagpieRestorePlanInput extends RestoreIo {
  project: string;
  env: string;
  taskId: string;
  purpose: string;
  readSealed: (name: string) => Promise<string | undefined>;
}

export interface MagpieRestoreApplyInput extends MagpieRestorePlanInput {
  planDigest: string;
  planIssuedAt: string;
  expectedConfigSha256: string;
  accountHash: string;
  members: string[];
  idempotencyKey: string;
  /** Seals the supplier username without ever returning it to the caller. */
  sealUsername: (name: string, value: string) => Promise<void>;
}

export interface MagpieRestorePlanResult {
  mode: 'plan';
  adapter: typeof MAGPIE_ADAPTER;
  provider: typeof MAGPIE_PROVIDER;
  alias: typeof MAGPIE_RESTORE_ALIAS;
  purpose: string;
  group: typeof MAGPIE_GROUP;
  config: { sha256: string; bytes: number; groupPresent: boolean; existingMembers: string[] | null };
  groups: Array<{ id: string; memberCount: number }>;
  unsafeGroupIds: number;
  providers: Array<{ id: string; routing: string }>;
  accounts: Array<{ accountHash: string; accountRef: string; provider: string }>;
  binding: { status: 'missing' | 'matched' | 'mismatch'; accountHash?: string };
  proposedAccount?: { accountHash: string; provider: string };
  candidates?: { provider: string; models: string[]; modelCount: number; omitted: number };
  snapshots: { catalogSha256: string | null; quotasSha256: string | null };
  sources: SourceRecord[];
  planDigest: string;
  issuedAt: string;
  expiresAt: string;
  gatewayReload: 'unknown';
  /** This release publishes the read-only plan only; apply is refused before any write. */
  writeAvailable: false;
  recovery: { interrupted: Array<{ at: string; planDigestPrefix: string; backupFile: string | null; wroteConfig: boolean }> };
  notes: string[];
}

export interface MagpieRestoreApplyResult {
  mode: 'apply';
  adapter: typeof MAGPIE_ADAPTER;
  provider: typeof MAGPIE_PROVIDER;
  alias: typeof MAGPIE_RESTORE_ALIAS;
  purpose: string;
  group: typeof MAGPIE_GROUP;
  status: 'applied' | 'unchanged' | 'refused';
  replayed: boolean;
  /** True when this call finished a write that the same key had already made before an interruption. */
  recovered?: boolean;
  refusal?: { code: string; detail: string };
  groupOperation?: 'created' | 'unchanged';
  bindingOperation?: 'sealed' | 'already-bound';
  config?: { sha256Before: string; sha256After: string };
  backupFile?: string | null;
  account?: { accountHash: string; accountRef: string; provider: string };
  members?: string[];
  sampled?: { status: 'sampled' | 'blocked'; gaps: Gap[]; routeDigest: string | null; accountRef: string | null; documentSha256: string | null };
  phases: Array<{ phase: string; at: string; detail?: string }>;
  notes: string[];
}

interface ConfigFile { text: string; sha256: string; bytes: number; mode: number; path: string }
interface GroupRow { id: string; memberCount: number; members: string[] | null; extra: Record<string, unknown> }
interface ParsedConfig { data: Record<string, unknown>; groupRows: GroupRow[]; unsafeGroupIds: number; providerRows: Array<{ id: string; routing: string }> }
interface AccountRow { user: string; provider: string; accountHash: string; accountRef: string }

interface RestoreFacts {
  config: ConfigFile;
  parsed: ParsedConfig;
  groupWork: { present: boolean; members: string[] | null };
  accounts: AccountRow[];
  binding: { status: 'missing' | 'matched' | 'mismatch'; accountHash?: string };
  catalogSha256: string | null;
  quotasSha256: string | null;
  catalog: ReturnType<typeof parseCatalog>;
  sources: SourceRecord[];
  gaps: Gap[];
}

const accountRef = (hash: string): string => `mgp${hash.slice(0, 24)}`;
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[:.]/g, '-');
const nonce = (): string => Math.random().toString(36).slice(2, 8);

function configPathOf(io: RestoreIo): string { return io.configPath ?? PROVIDERS_FILE; }

/** Read the gateway config without following a symlink; the bound keeps one bad file from being consumed. */
function readConfig(path: string): ConfigFile {
  let info;
  try { info = lstatSync(path); } catch { throw new CompanyError('not_found', 'Magpie providers.json is missing; a plan cannot establish the current routing config'); }
  if (info.isSymbolicLink()) throw new CompanyError('invalid', 'Magpie providers.json is a symlink; refusing to read or replace it');
  if (!info.isFile()) throw new CompanyError('invalid', 'Magpie providers.json is not a regular file');
  if (info.size < 1 || info.size > MAX_CONFIG_BYTES) throw new CompanyError('invalid', `Magpie providers.json is outside the 1..${MAX_CONFIG_BYTES} byte bound`);
  const text = readFileSync(path, 'utf8');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_CONFIG_BYTES) throw new CompanyError('invalid', `Magpie providers.json is outside the 1..${MAX_CONFIG_BYTES} byte bound`);
  return { text, sha256: sha256(text), bytes, mode: info.mode & 0o777, path };
}

/** Group ids follow the gateway's own `group/<name>` naming; only identifier-safe ids are ever listed. */
const safeGroupId = (value: string): boolean => /^[A-Za-z0-9_/-]{1,128}$/.test(value);

/** Parse the observed config shape only; an unknown shape is refused rather than guessed. */
function parseConfig(text: string): ParsedConfig {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new CompanyError('invalid', 'Magpie providers.json is not valid JSON; refusing to guess its schema'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CompanyError('invalid', 'Magpie providers.json is not a JSON object; refusing to guess its schema');
  const obj = data as Record<string, unknown>;
  const groups = Array.isArray(obj.groups) ? obj.groups : [];
  const groupRows: GroupRow[] = [];
  let unsafeGroupIds = 0;
  for (const raw of groups) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { unsafeGroupIds += 1; continue; }
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== 'string' || !safeGroupId(row.id)) { unsafeGroupIds += 1; continue; }
    const members = Array.isArray(row.members)
      ? row.members.filter((member): member is string => typeof member === 'string' && member.length > 0)
      : null;
    // Inherit only scalar, identifier-like fields from a sibling group (for example affinity);
    // the schema itself is never invented.
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'id' || key === 'members') continue;
      if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) continue;
      if (typeof value === 'string' && value.length <= 200) extra[key] = value;
      else if (typeof value === 'number' || typeof value === 'boolean') extra[key] = value;
    }
    groupRows.push({ id: row.id, memberCount: Array.isArray(row.members) ? row.members.length : 0, members, extra });
  }
  const providerRows: Array<{ id: string; routing: string }> = [];
  const providers = Array.isArray(obj.providers) ? obj.providers : [];
  for (const raw of providers) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== 'string' || !safeRef(row.id)) continue;
    providerRows.push({ id: row.id, routing: typeof row.routing === 'string' && safeRef(row.routing) ? row.routing : 'smart' });
  }
  return { data: obj, groupRows, unsafeGroupIds, providerRows };
}

/** Quota rows become account hashes only; the gateway username stays in memory for the seal step. */
function accountsOf(rows: Array<Record<string, unknown>>): AccountRow[] {
  const seen = new Set<string>();
  const out: AccountRow[] = [];
  for (const row of rows) {
    const user = typeof row.user === 'string' && row.user ? row.user : null;
    const provider = typeof row.provider === 'string' && safeRef(row.provider) ? row.provider : null;
    if (!user || !provider) continue;
    const hash = sha256(`magpie|${provider}|${user}`);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({ user, provider, accountHash: hash, accountRef: accountRef(hash) });
  }
  return out.sort((a, b) => a.provider === b.provider ? (a.user < b.user ? -1 : a.user > b.user ? 1 : 0) : a.provider < b.provider ? -1 : 1);
}

function catalogProvider(id: string, row: Record<string, unknown> | undefined): string | null {
  return providerOf(id)
    ?? (typeof row?.owned_by === 'string' ? row.owned_by : undefined)
    ?? (typeof row?.provider === 'string' ? row.provider : undefined)
    ?? null;
}

/** Same-provider catalog suggestions for the owner; never an automatic authorization. */
function candidatesOf(catalog: ReturnType<typeof parseCatalog>, provider: string): { models: string[]; modelCount: number } {
  const models: string[] = [];
  for (const [id, row] of catalog.byId) {
    if (catalogProvider(id, row) !== provider) continue;
    if (!/^[A-Za-z0-9_./-]{1,200}$/.test(id)) continue;
    models.push(id);
  }
  return { models: models.sort(), modelCount: models.length };
}

interface GatewaySnapshot {
  endpoint: { base: string; source: string; endpoint: string } | null;
  sources: SourceRecord[];
  catalog: ReturnType<typeof parseCatalog>;
  quotaRows: Array<Record<string, unknown>>;
  catalogSha256: string | null;
  quotasSha256: string | null;
}

async function readGateway(input: MagpieRestorePlanInput, now: () => number): Promise<GatewaySnapshot> {
  const fetcher = input.fetch ?? opsFetch;
  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  const endpoint = resolveEndpoint(input);
  const sources: SourceRecord[] = [];
  let catalog: ReturnType<typeof parseCatalog> = { byId: new Map(), byBase: new Map() };
  let quotaRows: Array<Record<string, unknown>> = [];
  let catalogSha256: string | null = null;
  let quotasSha256: string | null = null;
  if (!endpoint) return { endpoint: null, sources, catalog, quotaRows, catalogSha256, quotasSha256 };
  const reads = [['catalog', `${endpoint.base}/v1/models`], ['quotas', `${endpoint.base}/v1/magpie/quotas`]] as const;
  for (const [name, url] of reads) {
    const read = await readSource(name, url, { fetcher, left, now });
    sources.push(read.record);
    if (read.record.status === null || read.record.status < 200 || read.record.status > 299 || read.body === null) continue;
    if (name === 'catalog') { catalog = parseCatalog(read.body); catalogSha256 = read.record.rawSha256; }
    else { quotaRows = parseQuotaRows(read.body); quotasSha256 = read.record.rawSha256; }
  }
  return { endpoint, sources, catalog, quotaRows, catalogSha256, quotasSha256 };
}

function bindingOf(sealed: string | undefined, accounts: AccountRow[]): { status: 'missing' | 'matched' | 'mismatch'; accountHash?: string } {
  if (!sealed) return { status: 'missing' };
  const matches = accounts.filter(account => account.user === sealed);
  return matches.length === 1 ? { status: 'matched', accountHash: matches[0]!.accountHash } : { status: 'mismatch' };
}

/** The file is the source of truth for a write; the optional seam must mirror it. */
async function configTextOf(input: MagpieRestorePlanInput): Promise<string> {
  return input.readProviders ? input.readProviders() : readConfig(configPathOf(input)).text;
}

async function factsOf(input: MagpieRestorePlanInput, now: () => number): Promise<RestoreFacts> {
  const config = readConfig(configPathOf(input));
  const text = await configTextOf(input);
  if (sha256(text) !== config.sha256) {
    throw new CompanyError('conflict', 'the gateway config seam and the file on disk disagree; refusing to plan against two sources');
  }
  const parsed = parseConfig(text);
  const sealed = await input.readSealed(supplierUsernameSecretName(MAGPIE_RESTORE_ALIAS));
  const gateway = await readGateway(input, now);
  const accounts = accountsOf(gateway.quotaRows);
  const groupRow = parsed.groupRows.find(row => row.id === MAGPIE_GROUP) ?? null;
  const groupWork = { present: groupRow !== null, members: groupRow ? [...new Set(groupRow.members ?? [])].sort() : null };
  const gaps: Gap[] = [];
  if (!gateway.endpoint) gaps.push({ field: 'endpoint', source: 'magpie', detail: 'the Magpie gateway endpoint could not be resolved' });
  for (const source of gateway.sources) {
    if (source.status === null || source.status < 200 || source.status > 299) {
      gaps.push({ field: source.name === 'quotas' ? 'quota' : source.name, source: source.name, detail: source.detail ?? `HTTP ${source.status ?? 'unavailable'}` });
    }
  }
  return {
    config, parsed, groupWork, accounts,
    binding: bindingOf(sealed, accounts),
    catalogSha256: gateway.catalogSha256, quotasSha256: gateway.quotasSha256,
    catalog: gateway.catalog, sources: gateway.sources, gaps,
  };
}

/** The immutable plan material: apply recomputes it and refuses anything that moved. */
function planMaterial(facts: RestoreFacts, issuedAt: string, candidatesProvider: string | null): string {
  return sha256(canonical({
    v: 1,
    group: MAGPIE_GROUP,
    configSha256: facts.config.sha256,
    catalogSha256: facts.catalogSha256,
    quotasSha256: facts.quotasSha256,
    accounts: facts.accounts.map(account => ({ accountHash: account.accountHash, provider: account.provider })),
    binding: facts.binding.status,
    groupMembers: facts.groupWork.present ? facts.groupWork.members : null,
    candidatesProvider,
    issuedAt,
  }));
}

function suggestedProvider(facts: RestoreFacts): string | null {
  if (facts.binding.status === 'matched') return facts.accounts.find(account => account.accountHash === facts.binding.accountHash)?.provider ?? null;
  return facts.accounts.length === 1 ? facts.accounts[0]!.provider : null;
}

// ---- idempotency / crash journal (desensitized: hashes only, never a credential) ----

interface JournalEntry {
  keyHash: string;
  echo: string;
  planDigest: string;
  planIssuedAt: string;
  phase: 'started' | 'done' | 'failed';
  accountHash24?: string;
  expectedConfigSha256?: string;
  configShaAfter?: string;
  backupFile?: string | null;
  /** The exact JSON this apply appended, so a crash retry can prove the current file is its own write. */
  insertedGroup?: string;
  groupOperation?: 'created' | 'unchanged';
  bindingOperation?: 'sealed' | 'already-bound';
  /** The group in the file was written by this key before the interruption, not by this retry. */
  recoveredFromInterruptedWrite?: boolean;
  sampledStatus?: string;
  at: string;
  updatedAt: string;
}
interface Journal { version: 1; entries: Record<string, JournalEntry> }

const entryKey = (idempotencyKey: string): string => sha256(`magpie-restore|${idempotencyKey}`);

/** True only when the current file is exactly this key's backup plus this key's appended group. */
function ownWriteMatches(configPath: string, prior: JournalEntry, currentText: string): boolean {
  if (!prior.backupFile || !prior.insertedGroup || !prior.expectedConfigSha256) return false;
  const name = basename(prior.backupFile);
  if (!name.startsWith(BACKUP_PREFIX)) return false;
  try {
    const backupText = readFileSync(join(dirname(configPath), name), 'utf8');
    if (sha256(backupText) !== prior.expectedConfigSha256) return false;
    return spliceGroup(backupText, prior.insertedGroup) === currentText;
  } catch { return false; }
}

function readJournal(path: string): Journal {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Journal;
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') return parsed;
  } catch { /* absent or torn: start clean, the config CAS still protects the write */ }
  return { version: 1, entries: {} };
}

function writeJournal(path: string, journal: Journal): void {
  const entries = Object.entries(journal.entries);
  if (entries.length > MAX_JOURNAL_ENTRIES) {
    entries.sort((a, b) => a[1].at < b[1].at ? 1 : -1);
    journal.entries = Object.fromEntries(entries.slice(0, MAX_JOURNAL_ENTRIES));
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${nonce()}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

// ---- the config write: one CAS-guarded append, byte-preserving for everything else ----

/** Insert one group object into the top-level `groups` array without touching any other byte. */
export function spliceGroup(text: string, groupJson: string): string | null {
  // Locate a top-level "groups" key outside strings.
  let depth = 0, inString = false, escape = false, valueStart = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth === 1 && text.startsWith('"groups"', i)) {
        let j = i + 8;
        while (j < text.length && /\s/.test(text[j]!)) j++;
        if (text[j] === ':' && valueStart < 0) { valueStart = j + 1; break; }
      }
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  if (valueStart < 0) {
    // No top-level groups key: add one right after the opening brace, preserving the rest.
    const open = text.indexOf('{');
    if (open < 0) return null;
    const rest = text.slice(open + 1).trimStart();
    const separator = rest.startsWith('}') ? '' : ',';
    return `${text.slice(0, open + 1)}"groups":[${groupJson}]${separator}${text.slice(open + 1)}`;
  }
  let i = valueStart;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (text[i] !== '[') return null;
  const open = i;
  depth = 0; inString = false; escape = false;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const inner = text.slice(open + 1, i).trim();
        const separator = inner.length ? ',' : '';
        return `${text.slice(0, i)}${separator}${groupJson}${text.slice(i)}`;
      }
    }
  }
  return null;
}

const waitSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function acquireLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
      closeSync(fd);
      return () => { try { rmSync(lockPath, { force: true }); } catch { /* already gone */ } };
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) { rmSync(lockPath, { force: true }); continue; }
      } catch { continue; }
      waitSync(100);
    }
  }
  throw new CompanyError('conflict', 'another Magpie restore holds the config lock; retry after it finishes');
}

/** Atomic same-directory replace that keeps the original mode and never follows a symlink. */
function writeConfigAtomically(config: ConfigFile, nextText: string, expectedSha: string): string {
  const nextSha = sha256(nextText);
  const dir = dirname(config.path);
  const tmp = join(dir, `.${basename(config.path)}.restore-${process.pid}-${nonce()}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', config.mode);
    try { writeSync(fd, Buffer.from(nextText, 'utf8')); } finally { closeSync(fd); }
    chmodSync(tmp, config.mode);
    // CAS: a third party may have written between our read and our rename. Never overwrite it.
    if (sha256(readFileSync(config.path, 'utf8')) !== expectedSha) {
      throw new CompanyError('conflict', 'Magpie providers.json changed during the restore; refusing to overwrite the newer config');
    }
    if (!lstatSync(config.path).isFile()) throw new CompanyError('conflict', 'Magpie providers.json is no longer a regular file; refusing to replace it');
    renameSync(tmp, config.path);
    if (sha256(readFileSync(config.path, 'utf8')) !== nextSha) {
      throw new CompanyError('conflict', 'Magpie providers.json did not match the written bytes after the atomic replace');
    }
    return nextSha;
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
  }
}

function buildGroup(members: string[]): Record<string, unknown> {
  // Only the identity fields: inheriting a sibling group's scalar extras would guess the gateway
  // schema and silently import default semantics the company never chose.
  return { id: MAGPIE_GROUP, members: [...members] };
}

// ---- plan ----

export async function planMagpieRouteRestore(input: MagpieRestorePlanInput): Promise<MagpieRestorePlanResult> {
  const now = input.now ?? Date.now;
  const at = now();
  const facts = await factsOf(input, now);
  const candidatesProvider = suggestedProvider(facts);
  const candidates = candidatesProvider ? candidatesOf(facts.catalog, candidatesProvider) : null;
  const issuedAt = new Date(at).toISOString();
  const planDigest = planMaterial(facts, issuedAt, candidatesProvider);
  const journal = input.journalPath ? readJournal(input.journalPath) : { version: 1, entries: {} } as Journal;
  const interrupted = Object.values(journal.entries)
    .filter(entry => entry.phase === 'started')
    .map(entry => ({
      at: entry.at,
      planDigestPrefix: entry.planDigest.slice(0, 12),
      backupFile: entry.backupFile ?? null,
      wroteConfig: entry.expectedConfigSha256 !== undefined && entry.expectedConfigSha256 !== facts.config.sha256,
    }));
  const notes: string[] = [];
  if (facts.parsed.unsafeGroupIds) notes.push(`${facts.parsed.unsafeGroupIds} routing group id(s) are not safe identifiers and are not listed`);
  if (!facts.groupWork.present) notes.push(`${MAGPIE_GROUP} is missing from the gateway routing groups`);
  else notes.push(`${MAGPIE_GROUP} is already present with the listed members`);
  if (facts.binding.status === 'mismatch') notes.push('a sealed SUPPLIER_MAGPIE_USERNAME exists but matches no gateway account');
  if (facts.binding.status === 'missing') notes.push('no sealed SUPPLIER_MAGPIE_USERNAME; the gateway account cannot be bound');
  if (!candidatesProvider) notes.push('the gateway reports more than one account and none is bound');
  if (candidates) notes.push('candidate members are same-provider catalog suggestions only; the catalog is never auto-authorized');
  notes.push('a successful disk write is not proof the running gateway reloaded the config; this tool does not restart any daemon');
  notes.push('if sealing the username fails after the config write, the config is restored from the backup under CAS, but a previously sealed value cannot be removed through this tool (no generic secret management interface)');
  if (interrupted.length) notes.push('an earlier apply was interrupted; confirm the gateway state before re-applying');
  notes.push('this release publishes the read-only plan only: apply is refused with zero writes (writeAvailable=false), the write channel, real group schema and gateway reload semantics are unproven, and the account/route recovery is not complete');
  const value: MagpieRestorePlanResult = {
    mode: 'plan',
    adapter: MAGPIE_ADAPTER,
    provider: MAGPIE_PROVIDER,
    alias: MAGPIE_RESTORE_ALIAS,
    purpose: input.purpose,
    group: MAGPIE_GROUP,
    config: {
      sha256: facts.config.sha256,
      bytes: facts.config.bytes,
      groupPresent: facts.groupWork.present,
      existingMembers: facts.groupWork.members ? facts.groupWork.members.slice(0, MAX_LISTED) : null,
    },
    groups: facts.parsed.groupRows.slice(0, MAX_LISTED).map(row => ({ id: row.id, memberCount: row.memberCount })),
    unsafeGroupIds: facts.parsed.unsafeGroupIds,
    providers: facts.parsed.providerRows.slice(0, MAX_LISTED),
    accounts: facts.accounts.slice(0, MAX_LISTED).map(account => ({ accountHash: account.accountHash, accountRef: account.accountRef, provider: account.provider })),
    binding: facts.binding,
    ...(facts.accounts.length === 1 ? { proposedAccount: { accountHash: facts.accounts[0]!.accountHash, provider: facts.accounts[0]!.provider } } : {}),
    ...(candidates ? { candidates: { provider: candidatesProvider!, models: candidates.models.slice(0, MAX_LISTED), modelCount: candidates.modelCount, omitted: Math.max(0, candidates.modelCount - MAX_LISTED) } } : {}),
    snapshots: { catalogSha256: facts.catalogSha256, quotasSha256: facts.quotasSha256 },
    sources: facts.sources,
    planDigest,
    issuedAt,
    expiresAt: new Date(at + MAGPIE_RESTORE_PLAN_TTL_MS).toISOString(),
    gatewayReload: 'unknown',
    writeAvailable: false,
    recovery: { interrupted },
    notes,
  };
  return redactJson(value) as MagpieRestorePlanResult;
}

// ---- apply ----

/**
 * Resolve requested members to exact catalog ids of the selected provider. A base id that is
 * ambiguous (served under several providers) is refused rather than guessed.
 */
function resolveMembers(facts: RestoreFacts, provider: string, raw: string[]): { ids: string[]; refusal?: { code: string; detail: string } } {
  const ids: string[] = [];
  for (const value of raw) {
    const exact = facts.catalog.byId.get(value);
    const candidates: Array<readonly [string, Record<string, unknown>]> = exact ? [[value, exact] as const] : [...facts.catalog.byId];
    const matching = candidates.filter(([id, row]) => (exact ? id === value : baseId(id) === value) && catalogProvider(id, row) === provider);
    if (matching.length === 0) return { ids, refusal: { code: 'member-unknown', detail: `member ${String(value).slice(0, 160)} is not a catalog model of the bound account provider ${provider}` } };
    if (matching.length > 1) return { ids, refusal: { code: 'member-ambiguous', detail: `member ${String(value).slice(0, 160)} is served by more than one catalog id; name the full id` } };
    if (!ids.includes(matching[0]![0])) ids.push(matching[0]![0]);
  }
  if (!ids.length) return { ids, refusal: { code: 'member-unknown', detail: 'members must name at least one catalog model' } };
  return { ids: ids.sort() };
}

/**
 * The published apply entry. This release ships the read-only plan only: the write channel (a direct
 * `providers.json` replace versus Magpie's own SaveGroup API), the real group schema and the gateway
 * reload semantics are unproven, so every caller — the broker and any direct import — is refused
 * before any config, seal or journal access. Keeping the refusal here means a caller that bypasses
 * the broker still cannot write.
 */
export async function applyMagpieRouteRestore(_input: MagpieRestoreApplyInput): Promise<MagpieRestoreApplyResult> {
  throw new CompanyError('not_configured',
    'the Magpie route restore write capability is unavailable in this release: ops_magpie_route_restore publishes the read-only plan only (writeAvailable=false, gatewayReload=unknown) and the account/route recovery is not complete',
    false, { capability: 'magpie_route_restore_apply', writeAvailable: false, gatewayReload: 'unknown' });
}

/**
 * The unreleased apply implementation, retained with its journal and recovery evidence so a later
 * release can resume from a verified write channel. It is NOT a production entry: the broker imports
 * only the refusing entry above and no other `src/` module references this name (a regression test
 * guards that). Known residual, unchanged and out of this task's scope: the journal is read before
 * the lock is taken and written back as a whole inside it, so only a single cooperating writer is
 * assumed.
 */
export async function applyMagpieRouteRestoreRetained(input: MagpieRestoreApplyInput): Promise<MagpieRestoreApplyResult> {
  const now = input.now ?? Date.now;
  const at = now();
  const phases: Array<{ phase: string; at: string; detail?: string }> = [];
  const notes: string[] = [];
  const phase = (name: string, detail?: string) => phases.push({ phase: name, at: new Date(now()).toISOString(), ...(detail ? { detail } : {}) });
  const baseResult = {
    mode: 'apply' as const, adapter: MAGPIE_ADAPTER, provider: MAGPIE_PROVIDER, alias: MAGPIE_RESTORE_ALIAS,
    purpose: input.purpose, group: MAGPIE_GROUP,
  };

  if (!Array.isArray(input.members) || input.members.length < 1 || input.members.length > MAX_MEMBERS) throw new CompanyError('invalid', `members must list 1-${MAX_MEMBERS} catalog model ids`);
  for (const value of input.members) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_./-]{1,200}$/.test(value)) throw new CompanyError('invalid', 'members must be catalog model ids');
  }
  const issuedMs = Date.parse(input.planIssuedAt);
  if (typeof input.planIssuedAt !== 'string' || !Number.isFinite(issuedMs)) throw new CompanyError('invalid', 'planIssuedAt must be the ISO instant returned by plan');
  if (!/^[0-9a-f]{64}$/.test(input.planDigest)) throw new CompanyError('invalid', 'planDigest must be the SHA-256 returned by plan');
  if (!/^[0-9a-f]{64}$/.test(input.expectedConfigSha256)) throw new CompanyError('invalid', 'expectedConfigSha256 must be the plan config sha256');
  if (typeof input.accountHash !== 'string' || !/^(?:mgp)?[0-9a-f]{24,64}$/.test(input.accountHash)) throw new CompanyError('invalid', 'accountHash must be the plan account hash (or its mgp reference)');
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) throw new CompanyError('invalid', 'idempotencyKey must be 8-200 characters');
  const journalPath = input.journalPath;
  if (!journalPath) throw new CompanyError('invalid', 'the restore journal path is not configured');
  const keyHash = entryKey(input.idempotencyKey);

  const refuse = (code: string, detail: string, extra: Partial<MagpieRestoreApplyResult> = {}): MagpieRestoreApplyResult => {
    phase('refused', code);
    const journal = readJournal(journalPath);
    const prior = journal.entries[keyHash];
    // A fresh key records its failed attempt. An existing record — started, done or failed — keeps
    // its own plan identity and recovery facts (backup, inserted group, expected config): this
    // call's input must never corrupt the crash-recovery state a retry relies on.
    if (!prior) {
      journal.entries[keyHash] = {
        keyHash, echo: input.idempotencyKey.slice(0, 8), planDigest: input.planDigest, planIssuedAt: input.planIssuedAt,
        phase: 'failed', expectedConfigSha256: input.expectedConfigSha256, accountHash24: input.accountHash.replace(/^mgp/, '').slice(0, 24),
        at: new Date(at).toISOString(), updatedAt: new Date(now()).toISOString(),
      };
      writeJournal(journalPath, journal);
    }
    return redactJson({ ...baseResult, status: 'refused', replayed: false, refusal: { code, detail }, phases, notes, ...extra }) as MagpieRestoreApplyResult;
  };

  const journal = readJournal(journalPath);
  const prior = journal.entries[keyHash];
  if (prior && (prior.planIssuedAt !== input.planIssuedAt || prior.planDigest !== input.planDigest)) {
    return refuse('idempotency-conflict', 'this idempotencyKey was already used with a different plan');
  }
  if (prior?.expectedConfigSha256 !== undefined && prior.expectedConfigSha256 !== input.expectedConfigSha256) {
    return refuse('replay-mismatch', 'this idempotencyKey was recorded against a different expected config; the request does not match the recorded apply');
  }

  // Recompute the facts under the live gateway.
  const facts = await factsOf(input, now);
  phase('plan-rechecked', `config=${facts.config.sha256.slice(0, 12)}`);

  // A retry of our own interrupted or completed write (same key, same plan) is recognised from the
  // backup and the exact group JSON recorded in the journal, so a crash after the rename can be
  // finished without re-planning and without ever touching a third party's newer config.
  const ownWrite = prior ? ownWriteMatches(configPathOf(input), prior, facts.config.text) : false;
  // A completed apply replays from its recorded state: the plan digest (checked above) and the
  // recorded account pin the business identity, so a gateway quotas/catalog refresh or the plan
  // TTL elapsing must not break idempotency for work that is already in place.
  const completedReplay = prior?.phase === 'done';
  if (ownWrite) {
    phase('recovery-verified', `config=${facts.config.sha256.slice(0, 12)}`);
    notes.push('an earlier attempt with this idempotencyKey wrote this exact group; the retry only finishes the remaining phase');
  } else if (completedReplay) {
    if (prior?.configShaAfter !== facts.config.sha256) {
      return refuse('state-drifted', 'this idempotencyKey already completed but the config no longer matches its recorded result');
    }
    phase('replay-recognised', 'a completed apply with this idempotencyKey is replayed from the recorded state');
  } else {
    if (issuedMs > at + PLAN_CLOCK_SKEW_MS) return refuse('plan-invalid', 'planIssuedAt is in the future; run plan again');
    if (at - issuedMs > MAGPIE_RESTORE_PLAN_TTL_MS) return refuse('plan-expired', 'the plan window has expired; run plan again');
    if (planMaterial(facts, input.planIssuedAt, suggestedProvider(facts)) !== input.planDigest) {
      return refuse('plan-drifted', 'the config, catalog, quotas or binding moved since the plan; run plan again');
    }
    if (facts.config.sha256 !== input.expectedConfigSha256) {
      return refuse('config-drifted', 'Magpie providers.json does not match the planned sha256; run plan again');
    }
  }

  // The selected account must be exactly one gateway account.
  const wanted = input.accountHash.replace(/^mgp/, '');
  const selected = facts.accounts.filter(account => account.accountHash.startsWith(wanted));
  if (selected.length !== 1) {
    return refuse('account-ambiguous', selected.length === 0
      ? 'the selected accountHash matches no gateway account; run plan again'
      : 'the selected accountHash matches more than one gateway account; run plan again');
  }
  const account = selected[0]!;
  if (prior?.accountHash24 && !account.accountHash.startsWith(prior.accountHash24)) {
    return refuse('account-changed', 'the selected account differs from the account this idempotencyKey already used; start a new plan');
  }
  phase('account-selected', `account=${account.accountRef.slice(0, 12)} provider=${account.provider}`);
  if (facts.binding.status === 'mismatch') {
    return refuse('binding-mismatch', 'a sealed SUPPLIER_MAGPIE_USERNAME exists and matches no gateway account; refusing to overwrite an existing binding');
  }
  if (facts.binding.status === 'matched' && facts.binding.accountHash !== account.accountHash) {
    return refuse('binding-mismatch', 'a sealed SUPPLIER_MAGPIE_USERNAME is already bound to a different gateway account; refusing to write a route for another account or to overwrite the binding');
  }

  // Minimal explicit members, each an unambiguous catalog identity of the selected provider.
  const resolved = resolveMembers(facts, account.provider, input.members);
  if (resolved.refusal) return refuse(resolved.refusal.code, resolved.refusal.detail);
  const wantedMembers = resolved.ids;

  let groupOperation: 'created' | 'unchanged';
  // True when the current file is this key's own interrupted write: the group exists because this
  // key created it, so the retry must not report "no write" and must keep the original backup.
  let recoveredWrite = false;
  if (ownWrite && prior?.phase === 'done') {
    // A completed retry only replays when the whole recorded state is still in place.
    if (!facts.groupWork.present || facts.binding.status !== 'matched') {
      return refuse('state-drifted', 'this idempotencyKey already completed but the recorded state is gone; run plan again');
    }
  }
  if (!facts.groupWork.present) {
    if (ownWrite) return refuse('state-drifted', 'the journal records a group write but the group is no longer present; run plan again');
    groupOperation = 'created';
  } else {
    const existing = [...(facts.groupWork.members ?? [])].sort();
    if (existing.length !== wantedMembers.length || existing.some((member, index) => member !== wantedMembers[index])) {
      return refuse('group-conflict', `${MAGPIE_GROUP} already exists with different members; refusing to modify an existing group`);
    }
    for (const member of existing) {
      const entry = facts.catalog.byId.get(member) ?? facts.catalog.byBase.get(baseId(member));
      if (!entry) return refuse('group-conflict', `${MAGPIE_GROUP} contains ${String(member).slice(0, 160)}, which the catalog does not serve; refusing to treat it as identical`);
    }
    groupOperation = 'unchanged';
    if (ownWrite && prior?.phase !== 'done') {
      groupOperation = 'created';
      recoveredWrite = true;
    }
  }
  phase('group-decided', groupOperation);
  const bindingOperation: 'sealed' | 'already-bound' = facts.binding.status === 'matched' ? 'already-bound' : 'sealed';

  // A replayed key whose work is already in place returns the recorded outcome without writing.
  if (prior?.phase === 'done') {
    if (groupOperation !== 'unchanged' || bindingOperation !== 'already-bound') {
      return refuse('state-drifted', 'this idempotencyKey already completed but the current state no longer matches it; run plan again');
    }
    phase('idempotent-replay');
    const sampled = await sampleAfter(input, now);
    return redactJson({
      ...baseResult, status: 'unchanged', replayed: true,
      groupOperation, bindingOperation,
      config: { sha256Before: facts.config.sha256, sha256After: facts.config.sha256 },
      backupFile: prior.backupFile ?? null,
      account: { accountHash: account.accountHash, accountRef: account.accountRef, provider: account.provider },
      members: wantedMembers, sampled,
      phases, notes: [...notes, 'the same idempotencyKey already applied this plan; nothing was written or re-sealed'],
    }) as MagpieRestoreApplyResult;
  }

  const release = acquireLock(`${journalPath}.lock`);
  try {
    let configAfter = facts.config.sha256;
    let backupFile: string | null = null;

    if (groupOperation === 'created' && !recoveredWrite) {
      const fresh = readConfig(configPathOf(input)); // re-read under the lock
      if (fresh.sha256 !== input.expectedConfigSha256) return refuse('config-drifted', 'Magpie providers.json changed before the write; run plan again');
      if (sha256(await configTextOf(input)) !== fresh.sha256) return refuse('config-drifted', 'the gateway config seam disagrees with the file on disk; refusing to write');
      const parsed = parseConfig(fresh.text);
      if (parsed.groupRows.some(row => row.id === MAGPIE_GROUP)) return refuse('group-conflict', `${MAGPIE_GROUP} appeared after the plan; run plan again`);
      const groupJson = JSON.stringify(buildGroup(wantedMembers));
      const nextText = spliceGroup(fresh.text, groupJson);
      if (nextText === null) return refuse('config-schema-unknown', 'the providers.json group layout could not be located safely; refusing to rewrite the file');
      if (Buffer.byteLength(nextText, 'utf8') > MAX_CONFIG_BYTES) return refuse('config-too-large', 'the restored config would exceed the size bound');
      // Round-trip: everything except the appended group must be semantically identical.
      let nextData: Record<string, unknown>;
      try { nextData = JSON.parse(nextText) as Record<string, unknown>; } catch { return refuse('config-schema-unknown', 'the rewritten config did not parse; refusing to write'); }
      const nextGroups = Array.isArray(nextData.groups) ? [...nextData.groups] : [];
      const appendIndex = nextGroups.findIndex(row => !!row && typeof row === 'object' && (row as { id?: unknown }).id === MAGPIE_GROUP);
      if (appendIndex < 0) return refuse('config-schema-unknown', 'the appended group did not round-trip; refusing to write');
      nextGroups.splice(appendIndex, 1);
      const nextWithoutGroup: Record<string, unknown> = { ...nextData };
      if (nextGroups.length === 0 && !Object.hasOwn(parsed.data, 'groups')) delete nextWithoutGroup.groups;
      else nextWithoutGroup.groups = nextGroups;
      if (canonical(nextWithoutGroup) !== canonical(parsed.data)) {
        return refuse('config-schema-unknown', 'the rewrite would change more than the appended group; refusing to write');
      }
      const backupName = `${BACKUP_PREFIX}${stamp(now())}-${nonce()}`;
      journal.entries[keyHash] = { ...startedEntry(keyHash, input, account, at, now()), backupFile: backupName, insertedGroup: groupJson };
      writeJournal(journalPath, journal);
      writeFileSync(join(dirname(fresh.path), backupName), fresh.text, { mode: 0o600, flag: 'wx' });
      backupFile = backupName;
      phase('write-started', `backup=${backupName}`);
      configAfter = writeConfigAtomically(fresh, nextText, input.expectedConfigSha256);
      phase('written', `config=${configAfter.slice(0, 12)}`);
    } else if (recoveredWrite) {
      backupFile = prior?.backupFile ?? null;
      phase('recovery-completed', `${MAGPIE_GROUP} was written by this key before the interruption; the retry kept it and its backup`);
      notes.push('the route group exists because this idempotencyKey wrote it before the interruption; the retry did not rewrite it and kept the original 0600 backup pointer');
    } else {
      phase('unchanged', 'the route group already has exactly the planned members');
    }

    if (bindingOperation === 'sealed') {
      try {
        await input.sealUsername(supplierUsernameSecretName(MAGPIE_RESTORE_ALIAS), account.user);
        phase('binding-sealed');
      } catch (error) {
        // Compensation: put the config back only under the same CAS, never over a newer file.
        let restored = false;
        if (groupOperation === 'created' && backupFile) {
          try {
            const backupPath = join(dirname(configPathOf(input)), backupFile);
            if (sha256(readFileSync(configPathOf(input), 'utf8')) === configAfter) {
              const fresh = readConfig(configPathOf(input));
              writeConfigAtomically(fresh, readFileSync(backupPath, 'utf8'), configAfter);
              restored = true;
              phase('config-restored', 'sealed binding failed; the config was restored from the backup');
            } else {
              phase('restore-skipped', 'the config changed after the write; the backup is left in place for the owner');
            }
          } catch { phase('restore-failed', 'the backup could not be restored'); }
        }
        journal.entries[keyHash] = { ...startedEntry(keyHash, input, account, at, now()), phase: 'failed', configShaAfter: restored ? facts.config.sha256 : configAfter, backupFile, insertedGroup: journal.entries[keyHash]?.insertedGroup };
        writeJournal(journalPath, journal);
        const reason = (error as Error).message?.slice(0, 200) ?? 'unknown error';
        const residual = restored
          ? ''
          : groupOperation === 'created'
            ? `; the config remains changed (sha ${configAfter.slice(0, 12)}) because the backup could not be restored safely; the backup is kept`
            : '; the config was not changed by this apply';
        return refuse('binding-failed', `sealed binding was not set (${reason})${residual}`, {
          groupOperation, bindingOperation, backupFile,
          config: { sha256Before: facts.config.sha256, sha256After: restored ? facts.config.sha256 : configAfter },
          account: { accountHash: account.accountHash, accountRef: account.accountRef, provider: account.provider },
          members: wantedMembers,
        });
      }
    }

    const sampled = await sampleAfter(input, now);
    journal.entries[keyHash] = {
      ...startedEntry(keyHash, input, account, at, now()), phase: 'done', configShaAfter: configAfter, backupFile,
      insertedGroup: journal.entries[keyHash]?.insertedGroup,
      groupOperation, bindingOperation, recoveredFromInterruptedWrite: recoveredWrite, sampledStatus: sampled?.status,
    };
    writeJournal(journalPath, journal);
    phase('done', `sampled=${sampled?.status ?? 'n/a'}`);
    if (sampled?.status !== 'sampled') notes.push('the tool restored the planned facts but the read-only sample is still blocked; see sampled.gaps — this is not a claim that the route works');
    notes.push('a successful disk write is not proof the running gateway reloaded the config; this tool does not restart any daemon');
    return redactJson({
      ...baseResult,
      status: groupOperation === 'created' || bindingOperation === 'sealed' ? 'applied' : 'unchanged',
      replayed: false,
      ...(recoveredWrite ? { recovered: true } : {}),
      groupOperation, bindingOperation,
      config: { sha256Before: facts.config.sha256, sha256After: configAfter },
      backupFile,
      account: { accountHash: account.accountHash, accountRef: account.accountRef, provider: account.provider },
      members: wantedMembers,
      sampled,
      phases, notes,
    }) as MagpieRestoreApplyResult;
  } finally {
    release();
  }
}

function startedEntry(keyHash: string, input: MagpieRestoreApplyInput, account: AccountRow, at: number, current: number): JournalEntry {
  return {
    keyHash, echo: input.idempotencyKey.slice(0, 8), planDigest: input.planDigest, planIssuedAt: input.planIssuedAt,
    phase: 'started', expectedConfigSha256: input.expectedConfigSha256, accountHash24: account.accountHash.slice(0, 24),
    at: new Date(at).toISOString(), updatedAt: new Date(current).toISOString(),
  };
}

async function sampleAfter(input: MagpieRestoreApplyInput, now: () => number): Promise<MagpieRestoreApplyResult['sampled']> {
  const result = await sampleMagpieRoute({
    project: input.project, env: input.env, taskId: input.taskId, alias: MAGPIE_RESTORE_ALIAS, purpose: input.purpose,
    readSealed: input.readSealed, fetch: input.fetch, now,
    ...(input.base ? { base: input.base } : {}), ...(input.endpointSource ? { endpointSource: input.endpointSource } : {}),
    ...(input.readProviders ? { readProviders: input.readProviders } : {}),
    evidenceDir: input.evidenceDir,
  });
  return {
    status: result.status,
    gaps: result.gaps,
    routeDigest: result.receipt.route.digest,
    accountRef: result.accountRef,
    documentSha256: result.documentSha256 ?? null,
  };
}
