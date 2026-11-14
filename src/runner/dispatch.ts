import { createHostSampler, writeHostTelemetry, writeRuntimeObservation } from './telemetry.ts';
import { writeAgentActivity, expireAgentActivity } from './activity-store.ts';
import { reconcileIterations, createIterationTask } from '../iteration/execution.ts';
import { DispatchTimings } from "../diagnostics.ts";
import { RUNNER_BEAT_MS, writeBoardView, writeRunnerHeartbeat } from "../board.ts";
import { beatNodeRelease } from "../node-release.ts";
import { openUserPaths, scratchKeepReason } from "../dispatcher/scratch-gc.ts";
import { pruneOperationalData } from "../data-retention.ts";
import { magpieSessionRows, recordPendingTaskCosts } from "../task-cost.ts";
import { consolidateDue } from "../lane-notes-consolidate.ts";
import { settleCompanyTurn, TurnInterruptions } from "./turn-closeout.ts";
// Runs the company dispatcher tick loop inside the plugin subprocess and wakes it early on
// Paseo lifecycle events, replacing the org.surrealck.company-dispatcher launchd service.
import type { RuntimeEventSource as PluginServerContext } from "./host.ts";
import type { RuntimeHost as PaseoApi } from "./host.ts";
import { company, currentHost, noteHost, type Company } from "./company.ts";
import { isCompanyAgent } from "./company-agent.ts";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { serviceHome } from "./env.ts";
import { subscribeWake, TickGate } from "../cloud/wake.ts";
import { sweepArchiveBatches, sweepInstanceDirs } from "../dispatcher/lifecycle-gc.ts";
import { magpieBase, missingFrom, poolRoom, readMagpieQuotas, type MagpieUsageEntry } from "../dispatcher/magpie-quota.ts";
import { readProviderQuotas, readQuotaEntries } from "../dispatcher/quota-store.ts";
import { magpieAuthorization, magpieQuotaAuthorization } from "../model-routing/employee-env.ts";
import { MAGPIE_BASE } from "../model-routing/magpie-contract.ts";
export { readProviderQuotas };

type ProviderUsageEntry = {
  providerId: string;
  displayName: string;
  planLabel: string | null;
  status: "error" | "unavailable" | "available";
  windows?: Array<{ id: string; label: string; remainingPct?: number | null; resetsAt?: string | null; tone?: string }>;
  balances?: Array<{ id: string; label: string; remaining?: number | null; limit?: number | null; unit?: string; tone?: string }>;
};

function providerQuotaSummary(entry: ProviderUsageEntry): string {
  const parts: string[] = [];
  for (const w of entry.windows ?? []) {
    if (w.remainingPct == null) continue;
    const reset = w.resetsAt ? `，${w.resetsAt.slice(5, 16).replace("T", " ")} 重置` : "";
    parts.push(`${w.label} 剩余 ${Math.round(w.remainingPct)}%${reset}`);
  }
  for (const b of entry.balances ?? []) {
    if (b.remaining == null) continue;
    parts.push(`${b.label} 剩 ${b.remaining}${b.limit != null ? `/${b.limit}` : ""} ${b.unit ?? ""}`);
  }
  return parts.length ? parts.join("；") : `状态 ${entry.status}`;
}

/** Lowest remaining percentage across windows and balances; undefined when the provider reports no numbers. */
function lowestRemainingPct(entry: ProviderUsageEntry): number | undefined {
  return poolRoom(windowPcts(entry, "all"));
}

/** Long billing windows get a much lower circuit-breaker floor than the 5h/session window. */
const isLongWindow = (id: string) => /week|month|billing|cycle/i.test(id);

function windowPcts(entry: ProviderUsageEntry, scope: "short" | "long" | "all"): Array<{ id: string; pct: number }> {
  const pcts: Array<{ id: string; pct: number }> = [];
  for (const w of entry.windows ?? []) {
    if (w.remainingPct == null) continue;
    if (scope === "all" || isLongWindow(w.id) === (scope === "long")) pcts.push({ id: w.id, pct: w.remainingPct });
  }
  if (scope !== "long") {
    for (const b of entry.balances ?? []) {
      if (b.remaining != null && b.limit != null && b.limit > 0) pcts.push({ id: b.id, pct: (b.remaining / b.limit) * 100 });
    }
  }
  return pcts;
}

function splitLowestPct(entry: ProviderUsageEntry): { session: number | undefined; weekly: number | undefined } {
  return { session: poolRoom(windowPcts(entry, "short")), weekly: poolRoom(windowPcts(entry, "long")) };
}

function formatProviderUsage(entry: ProviderUsageEntry): string {
  const plan = entry.planLabel ? `（${entry.planLabel}）` : "";
  return `${entry.providerId}${plan} 提交时额度：${providerQuotaSummary(entry)}`;
}

let quotaRefreshedAt = 0;
/** Lifecycle GC (dead comm channels + cold archive) runs on its own slow clock. */
let gcRefreshedAt = 0;
const GC_MS = 30 * 60_000;
// Model family matchers: an `auto:<family>` def resolves to the newest id of that family
// among the provider's selectable models. Families are deliberately narrow so a provider
// publishing an unrelated line (e.g. gpt-7, or a renamed workhorse) never silently switches.
export const MODEL_FAMILY: Record<string, (id: string) => { family: string; version: string } | undefined> = {
  codex: (id) => {
    const m = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(id);
    return m ? { family: m[2]!, version: m[1]! } : undefined;
  },
  grok: (id) => {
    const m = /^grok-(\d+(?:\.\d+)*)$/.exec(id);
    return m ? { family: 'grok', version: m[1]! } : undefined;
  },
  devin: (id) => {
    const m = /^swe-(\d+(?:-\d+)*)-[a-z-]+$/.exec(id);
    return m ? { family: 'swe', version: m[1]!.replaceAll('-', '.') } : undefined;
  },
};

const versionNewer = (a: string, b: string): boolean => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
};

type ListedModel = { id: string; isSelectable?: boolean; isDefault?: boolean };

let modelsRefreshedAt = 0;

/**
 * Refreshes `auto:<family>` slot resolution: for every provider used by an auto def,
 * ask Paseo which models it offers and keep the newest of each family. The result lands
 * in company_meta:model_slots for the dispatcher; a failed provider keeps its previous
 * slot so one provider's outage cannot unstaff every role.
 */
export async function refreshModels(paseo: PaseoApi, ctx: Company): Promise<Record<string, string>> {
  noteHost(paseo);
  if (Date.now() - modelsRefreshedAt < 45_000) return readModelSlots(ctx);
  modelsRefreshedAt = Date.now();
  const [defRows] = await ctx.db.db.query<[Array<{ provider?: string; model?: string }>]>(
    `SELECT provider, model FROM employee_def WHERE string::starts_with(model ?? '', 'auto:');`);
  const providers = [...new Set((defRows ?? []).map(d => d.provider).filter(Boolean))] as string[];
  const slots: Record<string, string> = {};
  for (const provider of providers) {
    const match = MODEL_FAMILY[provider];
    if (!match) continue;
    const result = await paseo.providers.listModels(provider as never).catch(() => undefined);
    for (const m of ((result?.models ?? []) as ListedModel[])) {
      if (m.isSelectable === false) continue;
      const parsed = match(m.id);
      if (!parsed) continue;
      const key = `${provider}:${parsed.family}`;
      const cur = slots[key];
      const curVer = cur ? match(cur)?.version : undefined;
      if (!cur || (curVer && versionNewer(parsed.version, curVer))) slots[key] = m.id;
    }
  }
  const [existing] = await ctx.db.db.query<[Array<{ slots?: Record<string, string> }>]>(
    `SELECT slots FROM company_meta:model_slots;`);
  const prev = existing?.[0]?.slots ?? {};
  const merged = { ...prev, ...slots };
  if (JSON.stringify(merged) !== JSON.stringify(prev)) {
    await ctx.db.db.query(
      `UPSERT company_meta:model_slots CONTENT { slots: $slots, fetched_at: $fetched, at: time::now() };`,
      { slots: merged, fetched: new Date().toISOString() });
    const changes = Object.entries(merged).filter(([k, v]) => prev[k] !== v).map(([k, v]) => `${k}=${v}${prev[k] ? `（原 ${prev[k]}）` : ''}`);
    console.log(`model slots updated: ${changes.join('; ') || 'none'}`);
  }
  return merged;
}

export async function readModelSlots(ctx: Company): Promise<Record<string, string>> {
  const [rows] = await ctx.db.db.query<[Array<{ slots?: Record<string, string> }>]>(
    `SELECT slots FROM company_meta:model_slots;`);
  return rows?.[0]?.slots ?? {};
}

// Lifecycle hooks and RPC handlers are the only places a paseo handle is handed out;
// company.ts remembers the latest one so the tick loop can also refresh quota during quiet periods.

/** The employee key for the VPS magpie quota read. A configured local magpie gets none; a missing key file reads as no answer. */
function quotaHeaders(): Record<string, string> | undefined {
  if (magpieBase() !== MAGPIE_BASE) return undefined;
  try { return magpieQuotaAuthorization(serviceHome()); } catch { return undefined; }
}

/**
 * Persists the latest quota snapshot to company_meta for the dispatcher. Hooks carry a Paseo
 * handle; the tick loop may not have one yet (it only arrives with the first session event), so
 * the handle is optional: Paseo's list is skipped without it, and magpie — the source for the
 * providers Paseo never lists — is read either way. On a quiet company that is the only thing
 * keeping a spent subscription visible.
 */
let quotaEmptyLoggedAt = 0;
export async function refreshQuota(paseo: PaseoApi | undefined, ctx: Company): Promise<ProviderUsageEntry[]> {
  if (paseo) noteHost(paseo);
  if (Date.now() - quotaRefreshedAt < 45_000) return readQuotaEntries<ProviderUsageEntry>(ctx.db.db);
  quotaRefreshedAt = Date.now();
  const usage = paseo
    ? await paseo.providers.listUsage().catch((error) => { console.warn(`quota listUsage failed: ${(error as Error).message}`); return undefined; })
    : undefined;
  const providers = (usage as { fetchedAt?: string; providers?: ProviderUsageEntry[] } | undefined)?.providers ?? [];
  // Paseo reports only the providers it drives (claude/codex/grok on this machine). Magpie holds
  // every subscription the owner configured, so a provider whose allowance ran out is visible here
  // even when Paseo never mentions it — that is how Factory's spent month stayed invisible until
  // its sessions started failing. Paseo's numbers win wherever both report.
  const magpie = await readMagpieQuotas({ headers: quotaHeaders() }).catch(() => undefined);
  if (magpie?.length) {
    const extra = missingFrom(providers, magpie);
    if (extra.length) {
      providers.push(...extra.map(entry => ({
        providerId: entry.providerId,
        displayName: entry.displayName,
        planLabel: entry.planLabel,
        status: entry.status,
        windows: entry.windows.map(w => ({ id: w.id, label: w.label, remainingPct: w.remainingPct, resetsAt: w.resetsAt })),
      })));
      console.log(`quota refresh: +${extra.length} provider(s) from magpie (${extra.map(e => e.providerId).join(',')})`);
    }
  }
  if (!providers.length) {
    if (Date.now() - quotaEmptyLoggedAt > 300_000) {
      quotaEmptyLoggedAt = Date.now();
      console.log(`quota refresh: no provider usage entries${usage ? ` (keys: ${Object.keys(usage).join(',')})` : ' (no response)'}`);
    }
    return [];
  }
  const { RecordId } = await import("surrealdb");
  for (const entry of providers) {
    const split = splitLowestPct(entry);
    await ctx.db.db.query(
      `UPSERT $meta CONTENT { provider: $provider, summary: $summary, lowest_pct: $lowest, session_pct: $sessionPct, weekly_pct: $weeklyPct, status: $status, fetched_at: $fetched, payload: $entry, at: time::now() };`,
      { meta: new RecordId("company_meta", `quota_${entry.providerId}`), provider: entry.providerId,
        summary: providerQuotaSummary(entry), lowest: lowestRemainingPct(entry),
        sessionPct: split.session, weeklyPct: split.weekly, status: entry.status,
        fetched: usage?.fetchedAt, entry });
  }
  return providers;
}

// The quota readers moved to src/dispatcher/quota-store.ts (re-exported above): they select rows
// by record name, because a hyphenated provider id prints as `company_meta:⟨quota_factory-droid⟩`
// and an id-string prefix test skipped exactly those providers.

/** When an employee's turn ends right after submit, stamp the provider's remaining quota into the task audit. */
async function snapshotSubmitUsage(paseo: PaseoApi, ctx: Company, agent: { id: string; provider?: string }): Promise<void> {
  const detail = await paseo.agents.ref(agent.id).refresh().catch(() => undefined);
  const labels = (detail as { agent?: { labels?: Record<string, string> } } | null | undefined)?.agent?.labels;
  const employeeId = labels?.employee_id;
  if (!employeeId) return;
  const { RecordId } = await import("surrealdb");
  const [tasks] = await ctx.db.db.query<[Array<{ id: InstanceType<typeof RecordId>; version?: number }>]>(
    `SELECT id, version FROM task WHERE current_employee = $e AND state = 'review';`,
    { e: new RecordId("employee", employeeId) });
  if (!tasks?.length) return;
  const providers = await refreshQuota(paseo, ctx);
  const fresh = providers.length ? providers : await readQuotaEntries<ProviderUsageEntry>(ctx.db.db);
  const entry = fresh.find(p => p.providerId === agent.provider);
  if (!entry) {
    console.log(`usage snapshot skipped: no ${agent.provider} usage entry`);
    return;
  }
  const evidence = formatProviderUsage(entry);
  for (const task of tasks) {
    const [dup] = await ctx.db.db.query<[unknown[]]>(
      `SELECT id FROM audit WHERE task = $task AND action = 'provider_usage' AND version = $version LIMIT 1;`,
      { task: task.id, version: task.version });
    if (dup?.length) continue;
    await ctx.db.db.query(
      `CREATE audit CONTENT { task: $task, actor: 'owner:paseo-plugin', action: 'provider_usage', evidence: $evidence, version: $version, payload: $payload, at: time::now() };`,
      { task: task.id, evidence, version: task.version, payload: entry });
    console.log(`usage snapshot for ${String(task.id).split("⟨").pop()?.replace("⟩", "")}: ${evidence}`);
  }
}

export const QA_DISPATCH_OBSERVATION_MAX_BYTES = 4 * 1024 * 1024;
export const QA_DISPATCH_ITEM_MAX_BYTES = 256 * 1024;
let lastObservation = '';
async function markDispatchAttempt(ctx: Company, at: string, ok: boolean, error = ''): Promise<void> {
  await ctx.db.db.query("UPSERT company_meta:dispatch_observation_status CONTENT { at: $at, ok: $ok, error: $error };",
    { at, ok, error: error.slice(0, 500) });
}
/**
 * Persist the last dispatch pass for the QA observation channel (SYS-DISP 7454fc89 / B3).
 * Every verdict and every reason is kept: the reader filters one subject and never receives a silently cut list.
 * A pass over the safe size, or one item over the per-item cap, is stored as complete=false with no partial data;
 * the reader then reports partial/unavailable with the original counts and the pass time. A failed write leaves the
 * previous snapshot in place and records the attempt as failed, so the reader can mark it stale instead of current.
 */
export async function persistDispatchObservation(ctx: Company): Promise<void> {
  const snapshot = ctx.dispatcher.dispatchSnapshot();
  if (!snapshot.at) return;
  const at = new Date(snapshot.at).toISOString();
  const attemptAt = new Date().toISOString();
  const originalVerdicts = snapshot.verdicts.length;
  const originalReasons = snapshot.verdicts.reduce((sum, verdict) => sum + verdict.reasons.length, 0);
  const itemTooLarge = snapshot.verdicts.some(verdict =>
    Buffer.byteLength(JSON.stringify(verdict)) > QA_DISPATCH_ITEM_MAX_BYTES ||
    verdict.reasons.some(reason => Buffer.byteLength(JSON.stringify(reason)) > QA_DISPATCH_ITEM_MAX_BYTES));
  let complete = true;
  let reason = '';
  if (itemTooLarge) {
    complete = false;
    reason = `a single dispatch verdict or reason exceeds the ${QA_DISPATCH_ITEM_MAX_BYTES}-byte safe item size; no partial snapshot was stored`;
  } else {
    const bytes = Buffer.byteLength(JSON.stringify({ at, verdicts: snapshot.verdicts, complete: true, originalVerdicts, originalReasons }));
    if (bytes > QA_DISPATCH_OBSERVATION_MAX_BYTES) {
      complete = false;
      reason = `the dispatch observation is ${bytes} bytes, over the ${QA_DISPATCH_OBSERVATION_MAX_BYTES}-byte safe size; no partial snapshot was stored`;
    }
  }
  const record = complete
    ? { at, verdicts: snapshot.verdicts, complete: true, originalVerdicts, originalReasons }
    : { at, verdicts: [], complete: false, originalVerdicts, originalReasons, reason };
  const json = JSON.stringify(record);
  try {
    if (json !== lastObservation) {
      await ctx.db.db.query(
        "UPSERT company_meta:dispatch_observation CONTENT { at: $at, verdicts: $verdicts, complete: $complete, originalVerdicts: $ov, originalReasons: $or, reason: $reason };",
        { at, verdicts: record.verdicts, complete: record.complete, ov: originalVerdicts, or: originalReasons, reason });
      lastObservation = json;
    }
    await markDispatchAttempt(ctx, attemptAt, true);
  } catch (error) {
    await markDispatchAttempt(ctx, attemptAt, false, (error as Error).message).catch(() => undefined);
    throw error;
  }
}

/**
 * Persist the latest pass's owner board (W2): the queue and each employee's next rows, the values a dispatch message names,
 * and the comm dirs. The board reader joins it with the live database; it never reads the scheduler's memory.
 */
export async function persistBoardView(ctx: Company): Promise<void> {
  const board = ctx.dispatcher.dispatchSnapshot().board;
  if (board?.at) await writeBoardView(ctx.db.db, board, ctx.runnerId);
}

const sampleHost = createHostSampler();
let beatBusy = false;
let lastBeatAt: number | undefined;
/** 最近一次写入成功的执行端心跳时刻（毫秒），供 runner.status 使用；本进程还没写过则为 undefined。 */
export function lastRunnerBeatAt(): number | undefined { return lastBeatAt; }

/**
 * One runner heartbeat for the owner board (W2): this plugin process, its host and the installed release. A failure only warns;
 * the board then reads the runner as offline once the last beat ages out.
 */
function beatRunner(): void {
  if (beatBusy) return;
  beatBusy = true;
  void company()
    .then(async ctx => {
      await ctx.runtime.heartbeat?.();
      const version = await ctx.runnerVersion().catch(() => "unknown");
      await writeRunnerHeartbeat(ctx.db.db, { runner: ctx.runnerId ?? `plugin:${process.pid}`, host: hostname(), version });
      await writeHostTelemetry(ctx.db.db, ctx.runnerId ?? `plugin:${process.pid}`, ctx.nodeId, sampleHost())
        .catch(() => console.warn('host telemetry unavailable'));
      const observedAt = Date.now();
      try {
        const agents = await ctx.runtime.list();
        await Promise.all([...agents.values()].map(a => writeRuntimeObservation(ctx.db.db, a.id, a.status, observedAt, a.model)));
      } catch { console.warn('agent telemetry unavailable'); }
      try {
        const activities = ctx.runtime.activity?.() ?? [];
        const saved = await writeAgentActivity(ctx.db.db, ctx.runnerId ?? `plugin:${process.pid}`, activities);
        for (const a of saved) ctx.runtime.acknowledgeActivity?.(a.agent, a.turn);
        await expireAgentActivity(ctx.db.db);
      } catch { console.warn('agent activity upload deferred'); }
      // 节点记录：同一次心跳里登记本执行端的节点、主机与发行版本；失败只记 warn，与运行心跳一致。
      await beatNodeRelease(ctx.db, { node: ctx.nodeId, host: hostname(), platform: process.platform, version, sha: ctx.runnerSha, at: Math.floor(Date.now() / 1000) })
        .catch(error => console.warn(`node release heartbeat failed: ${(error as Error).message}`));
      lastBeatAt = Date.now();
    })
    .catch(error => console.warn(`runner heartbeat failed: ${(error as Error).message}`)).finally(() => { beatBusy = false; });
}

/** 云端周期 tick 的兜底间隔：LIVE 唤醒负责及时性，周期 tick 只防漏。 */
const CLOUD_FALLBACK_MS = 60_000;
type WakeClient = Parameters<typeof subscribeWake>[0];

/**
 * 在一个会话上订阅派工相关表的变化。订阅失败只记录并降级为周期 tick：绑定失败会让整次会话重建失败，
 * 不能因为一个通知订阅断掉整个会话。
 */
async function wakeOnLive(client: WakeClient, onChange: () => void): Promise<() => Promise<void>> {
  try {
    return await subscribeWake(client, () => onChange());
  } catch (error) {
    console.warn(`LIVE 唤醒订阅失败，本会话改由周期 tick 兜底：${(error as Error).message}`);
    return async () => {};
  }
}

export interface RunnerControl { (): void; done: Promise<void> }
export function startDispatch(server: PluginServerContext): RunnerControl {
  let stopped = false;
  const interruptions = new TurnInterruptions();
  let wake: (() => void) | undefined;
  let running = true;
  // 云端执行端：LIVE 变化经 TickGate 唤醒派工循环（合并，最短间隔 1 秒），周期 tick 作兜底。本机模式不用它。
  let cloudWake: TickGate | undefined;
  let cloudBinding: Promise<void> | undefined;
  let liveUnbind: (() => Promise<void>) | undefined;

  const nap = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(() => { wake = undefined; resolve(); }, ms);
    wake = () => { wake = undefined; clearTimeout(timer); resolve(); };
  });


async function runLifecycleGc(ctx: Company): Promise<void> {
  // Until every GC reference source understands attempt fences, retain artifacts only;
  // this does not pause dispatch, lease maintenance, or execution-result ingestion.
  if ((await ctx.workforce.pendingDispatchAttempts()).length) return;
  const cfg = await ctx.workforce.config();
  const now = new Date();
  const commRoot = process.env.SCK_COMM_ROOT ?? join(serviceHome(), "comm");
  if (cfg.commDirGraceHours > 0) {
    const comm = await sweepInstanceDirs({
      root: commRoot, now, graceMs: cfg.commDirGraceHours * 3_600_000, keep: ctx.sidecar.liveInstanceIds(),
    });
    if (comm.removed.length) {
      console.log(`lifecycle gc comm: removed ${comm.removed.length} dead channels (${(comm.bytes / 1048576).toFixed(1)} MB)`);
    }
  }
  if (cfg.scratchGraceHours > 0) {
    // Failure to read either source retains scratch for this pass. A stale root
    // mtime alone is never authority to remove a still-open or registered tree.
    try {
      const [paths] = await ctx.db.db.query<[Array<{ path: string; repo?: string }>]>("SELECT path, repo FROM worktree;");
      const open = await openUserPaths();
      const scratch = await sweepInstanceDirs({
        root: join(dirname(commRoot), "scratch"), now, graceMs: cfg.scratchGraceHours * 3_600_000,
        keep: ctx.sidecar.liveInstanceIds(), protect: path => scratchKeepReason(path, { registered: paths.map(p => p.path).filter(Boolean), open, mergedRepos: [...new Set(paths.map(p => p.repo).filter((p): p is string => !!p))], activeAfterMs: now.getTime() - cfg.scratchGraceHours * 3_600_000 }),
      });
      if (scratch.removed.length || scratch.failed?.length) console.log(`lifecycle gc scratch: removed ${scratch.removed.length}, failed ${scratch.failed?.length ?? 0}, kept ${scratch.skipped} (${(scratch.bytes / 1048576).toFixed(1)} MB)`);
    } catch { console.warn("lifecycle gc scratch retained: reference/process inspection unavailable"); }
  }

  // Settle the cost of finished tasks before their raw request rows can be pruned.
  try {
    const costed = await recordPendingTaskCosts(ctx.db.db, { fetchRows: magpieSessionRows(magpieAuthorization(serviceHome())) });
    if (costed) console.log(`lifecycle gc task cost: ${costed} tasks settled`);
  } catch (error) { console.warn(`lifecycle gc task cost failed: ${(error as Error).message}`); }

  try {
    const pruned = await pruneOperationalData(ctx.db.db);
    if (Object.keys(pruned).length) console.log(`lifecycle gc data: ${JSON.stringify(pruned)}`);
  } catch (error) { console.warn(`lifecycle gc data failed: ${(error as Error).message}`); }

  // Lane notes: merge near-duplicates and age out the oldest past the soft target, at most once a day. Each pass is
  // recorded and can be undone from the console. A failed pass only warns; the next tick retries it.
  try {
    const consolidated = await consolidateDue(ctx.db.db, { now, actor: "system:consolidation" });
    if (consolidated?.changes.length) console.log(`lifecycle gc notes: ${consolidated.changes.length} note changes recorded as ${consolidated.id}`);
  } catch (error) { console.warn(`lifecycle gc notes consolidation failed: ${(error as Error).message}`); }

  if (cfg.archiveRetentionDays > 0) {
    const arch = await sweepArchiveBatches({
      root: join(serviceHome(), "archive"), now, retentionMs: cfg.archiveRetentionDays * 86_400_000,
    });
    if (arch.removed.length) {
      console.log(`lifecycle gc archive: removed ${arch.removed.length} batches (${(arch.bytes / 1048576).toFixed(1)} MB): ${arch.removed.join(", ")}`);
    }
  }
}

  const loop = async () => {
    let failures = 0;
    while (!stopped) {
      let wait = 20_000;
      const timing = new DispatchTimings();
      try {
        const ctx: Company = await timing.measure("init", () => company());
        wait = (await timing.measure("config", () => ctx.workforce.config())).pollSeconds * 1000;
        if (ctx.db.config.cloud) {
          // 云端：周期 tick 放宽到至少 60 秒，及时性交给 LIVE 唤醒。会话绑定失败会在下一轮重试。
          wait = Math.max(wait, CLOUD_FALLBACK_MS);
          cloudWake ??= new TickGate({ minGapMs: 1000, fallbackMs: CLOUD_FALLBACK_MS });
          const gate = cloudWake;
          cloudBinding ??= ctx.db.bindSession(client => wakeOnLive(client, () => gate.request())).then(
            unbind => { liveUnbind = unbind; },
            error => {
              cloudBinding = undefined;
              console.warn(`LIVE 唤醒未能建立，下一轮重试：${(error as Error).message}`);
            },
          );
          cloudWake.started();
        }
        // 运维作业：认领并执行排队中的 ops_job。不等待派工 tick，长作业不挡住派工。
        if (ctx.opsJobs) void ctx.opsJobs.drain().catch(error => console.warn(`ops job drain failed: ${(error as Error).message}`));
        // Refresh quota and model slots BEFORE the tick so a newly published model is
        // resolved, stale idle sessions are retired, and new work spawns on it in the
        // same dispatch pass instead of lagging one poll behind. Quota runs without a
        // Paseo handle too: magpie is the source for the providers Paseo never lists.
        if (Date.now() - quotaRefreshedAt > 300_000) {
          await timing.measure("quota", () => refreshQuota(currentHost(), ctx)).catch((error) => console.warn(`quota refresh failed: ${(error as Error).message}`));
        }
        const paseoHandle = currentHost();
        if (paseoHandle && Date.now() - modelsRefreshedAt > 300_000) {
          await timing.measure("models", () => refreshModels(paseoHandle, ctx)).catch((error) => console.warn(`model refresh failed: ${(error as Error).message}`));
        }
        if (Date.now() - gcRefreshedAt > GC_MS) {
          gcRefreshedAt = Date.now();
          await timing.measure("gc", () => runLifecycleGc(ctx)).catch((error) => console.warn(`lifecycle gc failed: ${(error as Error).message}`));
        }
        if (!(await ctx.workforce.config()).paused) {
          await timing.measure("iterations", () => reconcileIterations(ctx.db.db, {
            create: async input => {
              const credential = process.env.SCK_OWNER_TOKEN;
              if (!credential) throw new Error('owner credential unavailable');
              return createIterationTask(ctx.core, ctx.messages, credential, input);
            },
          })).catch(() => console.warn('iteration reconciliation failed'));
        }
        const uncertainWorkers = new Set((await ctx.workforce.pendingDispatchAttempts()).map(a => a.employee));
        for (const error of await ctx.workforce.recoverDispatchBindings()) console.warn(`dispatch recovery retained: ${error}`);
        if (uncertainWorkers.size) await ctx.sidecar.adopt((await ctx.workforce.insts()).filter(i => uncertainWorkers.has(i.id)));
        await ctx.sidecar.retryExecutions();
        const report = await timing.measure("tick", () => ctx.dispatcher.tick());
        await timing.measure("observation", () => persistDispatchObservation(ctx)).catch((error) => console.warn(`dispatch observation write failed: ${(error as Error).message}`));
        await timing.measure("board", () => persistBoardView(ctx)).catch((error) => console.warn(`board view write failed: ${(error as Error).message}`));
        failures = 0;
        const changed = report.commands || report.revoked.length || report.woke.length || report.retired.length ||
          report.exhausted.length || (report.recovered?.length ?? 0) || report.notices.length || (report.decisions?.length ?? 0) ||
          report.reclaimed;
        if (changed) console.log(`tick ${JSON.stringify(report)}`);
        await timing.measure("heartbeat", async () => { await ctx.db.db.query("UPSERT company_meta:dispatcher_heartbeat SET at = time::now();"); });
      } catch (error) {
        failures++;
        wait = Math.min(wait * 2 ** Math.min(failures, 5), 300_000);
        console.error(`tick failed: ${(error as Error).message}`);
        // A dropped SurrealDB socket never heals on its own; rebuild it so the next tick can run.
        await company().then(c => c.db.ensureConnected()).catch(() => {});
      } finally {
        console.log(`dispatch timing: ${JSON.stringify(timing.summary())}`);
      }
      if (stopped) break;
      await (cloudWake ? cloudWake.wait(wait) : nap(wait));
    }
  };
  const done = loop();
  // The runner beats on its own timer, not on the tick: a long pass must not make the runner read as offline.
  beatRunner();
  const runnerBeat = setInterval(beatRunner, RUNNER_BEAT_MS);

  // A finished turn usually means a checkpoint/submit/review landed; dispatch immediately
  // instead of waiting out the poll interval.
  const kick = () => {
    if (!stopped && running) {
      wake?.();
      cloudWake?.request();
    }
  };
  const removers = [
    server.on("agent.turn_started", (event, { paseo }) => {
      interruptions.turnStarted(event.agent.id, event.turnId);
      return isCompanyAgent(paseo, event.agent).then(async ok => {
        if (ok) {
          const ctx = await company();
          await writeRuntimeObservation(ctx.db.db, event.agent.id, 'running', Date.now())
            .catch(() => console.warn('agent telemetry unavailable'));
          await ctx.sidecar.turnStarted(event.agent.id, event.turnId ?? undefined);
          await ctx.workforce.clearIdleForAgent(event.agent.id);
        }
      }).catch((error: unknown) => console.warn(`idle activity update failed: ${(error as Error).message}`));
    }),
    server.on("agent.turn_ended", (event, { paseo }) => {
      event = { ...event, observedAt: Date.now() };
      noteHost(paseo);
      return isCompanyAgent(paseo, event.agent).then(async ok => {
        console.log(`turn_ended ${event.agent.title ?? event.agent.id} company=${ok}`);
        if (!ok) return;
        const ctx = await company();
        await writeRuntimeObservation(ctx.db.db, event.agent.id, 'idle', Date.now()).catch(() => undefined);
        // The sidecar ingests report.md/blocker.md and lands submit/block before
        // the usage snapshot looks for freshly-reviewed tasks.
        try {
          await settleCompanyTurn(ctx, { send: async (id, prompt) => { await paseo.agents.ref(id).send(prompt); } }, event, interruptions);
        } catch (error) {
          console.warn(`sidecar settle failed: ${(error as Error).message}`);
        }
        try {
          await snapshotSubmitUsage(paseo, ctx, event.agent);
        } catch (error) {
          console.warn(`usage snapshot failed: ${(error as Error).message}`);
        }
        kick();
      }).catch((error: unknown) => console.warn(`turn_ended handler failed: ${(error as Error).message}`));
    }),
    server.on("agent.archived", (event, { paseo }) => {
      noteHost(paseo);
      return isCompanyAgent(paseo, event.agent).then(async ok => {
        if (!ok) return;
        const ctx = await company();
        ctx.sidecar.detachAgent(event.agent.id);
        await refreshQuota(paseo, ctx).catch(() => {});
        await refreshModels(paseo, ctx).catch(() => {});
        kick();
      }).catch((error: unknown) => console.warn(`archived handler failed: ${(error as Error).message}`));
    }),
    server.on("workspace.archived", () => kick()),
    // Company employees run unattended: a permission prompt would stall the session
    // until a human notices, so the plugin answers allow immediately and logs it.
    // Owner-role approvals (spend, external comms) never arrive on this channel.
    server.on("agent.permission_requested", (event, { paseo }) => {
      noteHost(paseo);
      return isCompanyAgent(paseo, event.agent).then(async ok => {
        if (!ok) return;
        const request = event.request as { id?: string } | undefined;
        const summary = JSON.stringify(event.request).slice(0, 300);
        try {
          if (request?.id) {
            await paseo.agents.ref(event.agent.id).respondToPermission({
              requestId: request.id,
              response: { behavior: "allow" },
            });
            console.log(`auto-allowed permission for ${event.agent.title ?? event.agent.id}: ${summary}`);
          }
        } catch (error) {
          console.warn(`permission auto-answer failed for ${event.agent.id}: ${(error as Error).message} request=${summary}`);
        }
        const ctx = await company();
        await refreshQuota(paseo, ctx).catch(() => {});
        await refreshModels(paseo, ctx).catch(() => {});
      }).catch((error: unknown) => console.warn(`permission handler failed: ${(error as Error).message}`));
    }),
  ];

  const stop = () => {
    stopped = true;
    clearInterval(runnerBeat);
    interruptions.stop();
    wake?.();
    cloudWake?.stop();
    // 绑定若仍在进行，等它完成后拆除 LIVE 订阅。
    void cloudBinding?.then(() => liveUnbind?.()).catch(() => undefined);
    for (const remove of removers) remove();
  };
  return Object.assign(stop, { done });
}
