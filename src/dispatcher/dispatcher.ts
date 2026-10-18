import type { OwnerDesk } from '../owner.ts';
import type { CompanyConfig, EmployeeDef, EmployeeInst, ProviderHealth, SupervisedTask, Workforce } from '../workforce.ts';
import { effectiveWeight, weightedOrder } from '../workforce.ts';
import type { ClaimResult, WorktreeAssignment, ModelSlots, ProviderQuota, Role } from '../contracts.ts';
import { REQUIRED_TRACKS } from '../core.ts';
import { UNATTENDED_MODE, type PaseoGateway, type PaseoWorkspaceInfo } from './paseo.ts';
import { evalPrompt, gmAttention, gmTriage, wake, type PromptEnv } from './prompts.ts';
import { sweepWorktrees, type GitGateway } from './worktrees.ts';
import { agingLevel, agingText, localDate, renderBrief, type RoleCapacity } from '../owner-brief.ts';
import type { ReclaimResult } from './worktree-registry.ts';
import type { ReclaimTrigger } from './worktree-reclaim.ts';
import { jevNeedsOwner, jevRelease, jevStaff, jevTriage, type RouteCandidate } from './decisions.ts';
import { jevEvalQuestions, parseJevEval, type JevClient, type JevScoreAnswers } from './jev.ts';
import type { HostResources } from './host.ts';

/** Provider error text that means the subscription is out of budget or rate limited, not that the session is broken. */
export const EXHAUSTED_PATTERN = /out of credits|add credits|credit balance|usage balance|balance exhausted|payment required|quota|usage limit|rate.?limit|too many requests|\b402\b|\b429\b|limit reached|insufficient|billing|exceeded your|try again (in|later)/i;
const LEASE_SECONDS = 600;
const LOG_TAIL_ENTRIES = 60;
// Task-level cooldown after a claim denial; a version bump re-arms the task.
const CLAIM_DENY_COOLDOWN_MS = 5 * 60_000;

export type InstState = 'busy' | 'idle' | 'down' | 'exhausted';

/** 'ok' healthy / 'probe' single trial session allowed / 'down' cooling off. */
const availabilityOf = (h: ProviderHealth | undefined, now: number): 'ok' | 'probe' | 'down' =>
  !h || h.state === 'healthy' ? 'ok' : now >= (h.until ?? 0) ? 'probe' : 'down';

/** Quota circuit breaker, shared by the tick and the roster staffing preview. */
export function quotaBlockedProviders(rows: ProviderQuota[], cfg: Pick<CompanyConfig, 'quotaFloorPct' | 'quotaWeeklyFloorPct'>, now: number): Map<string, string> {
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

/** Per role: how many enabled seats can take work right now (provider quota and health), and why the rest cannot. */
export function roleCapacity(defs: ReadonlyArray<Pick<EmployeeDef, 'role' | 'provider' | 'enabled'>>, quotaBlocked: ReadonlyMap<string, string>, health: ReadonlyMap<string, ProviderHealth>, now: number): RoleCapacity[] {
  const roles = new Map<string, RoleCapacity>();
  for (const def of defs.filter(d => d.enabled)) {
    const entry = roles.get(def.role) ?? { role: def.role, total: 0, usable: 0, down: [] };
    roles.set(def.role, entry); entry.total++;
    const h = health.get(def.provider);
    const why = quotaBlocked.get(def.provider) ?? (availabilityOf(h, now) === 'down' ? `额度耗尽或异常${h?.lastError ? `：${h.lastError.slice(0, 40)}` : ''}` : undefined);
    if (!why) entry.usable++;
    else if (!entry.down.some(d => d.startsWith(def.provider))) entry.down.push(`${def.provider} ${why}`);
  }
  return [...roles.values()].sort((a, b) => a.usable - b.usable || a.role.localeCompare(b.role));
}

/** Provider seat check: quota floor, health window, and the per-provider concurrency cap. */
export function providerCapacity(provider: string, providerMax: Record<string, number>, health: ReadonlyMap<string, ProviderHealth>, busyBy: ReadonlyMap<string, number>, now: number, quotaBlocked?: ReadonlyMap<string, string>): boolean {
  if (quotaBlocked?.has(provider)) return false;
  const availability = availabilityOf(health.get(provider), now);
  if (availability === 'down') return false;
  const busy = busyBy.get(provider) ?? 0;
  return availability === 'probe' ? busy === 0 : busy < (providerMax[provider] ?? 1);
}

/** One row of the staffing preview: an instance that could be reused, or a def that could spawn. */
export interface StaffingEntry {
  kind: 'reuse' | 'spawn';
  /** inst.id for reuse, `spawn:<defId>` for spawn. */
  key: string;
  ref: string;
  role: string;
  provider: string;
  model?: string;
  def?: EmployeeDef;
  inst?: EmployeeInst;
  /** effectiveWeight — exactly what weightedOrder picks by. */
  weight: number;
  /** Share of this candidate's weight among all eligible candidates in the same role+home pool. */
  share: number;
  eligible: boolean;
  reason?: string;
  /** Eligible but deprioritized (e.g. a claim-only prior holder reviewing a task it touched). */
  note?: string;
}

/** Weight multiplier for claim-only prior holders on review dispatch. */
export const PRIOR_HAND_WEIGHT_FACTOR = 0.15;

export interface StaffingInput {
  role: string;
  home: string;
  task?: SupervisedTask;
  /** Review work never goes to the submitter. */
  excludeSubmitter?: boolean;
  /**
   * Review recusal, only passed for review dispatch. `authors` (ever submitted
   * this task) are a hard independence exclusion — nobody accepts their own
   * delivery. `hands` (claimed but never submitted) are eligible at a demoted
   * weight: their review is still independent and starvation-blocking a task
   * behind them is worse than reusing session context they already hold.
   */
  recusal?: ReviewRecusal;
  defs: EmployeeDef[];
  insts: EmployeeInst[];
  states: ReadonlyMap<string, InstState>;
  holding: ReadonlySet<string>;
  assigned?: ReadonlySet<string>;
  health: ReadonlyMap<string, ProviderHealth>;
  quotaBlocked: ReadonlyMap<string, string>;
  busyBy: ReadonlyMap<string, number>;
  providerMax: Record<string, number>;
  slots: ReadonlyMap<string, string>;
  opsRepo: string;
  sidecar: boolean;
  now: number;
}

// Empty/absent tracks accept every discipline; untracked tasks keep plain role matching.
// Required-track roles (REQUIRED_TRACKS, e.g. screenwriter) are stricter: their tasks must
// carry exactly the required track and the def must list it — empty tracks grants nothing.
function trackOkFor(role: Role, task: SupervisedTask | undefined, tracks: string[] | undefined) {
  const required = REQUIRED_TRACKS[role];
  if (required !== undefined) return task?.discipline === required && (tracks ?? []).includes(required);
  return !task?.discipline || !tracks?.length || tracks.includes(task.discipline);
}

/**
 * The role+home candidate pool, evaluated with the exact predicates the tick uses.
 * Eligible entries carry weight + normalized share; ineligible ones carry `reason`.
 * The dispatcher consumes this for picks; the roster surfaces it verbatim, so the
 * owner page always previews the same numbers dispatch would use.
 */
export function staffingPool(p: StaffingInput): StaffingEntry[] {
  const resolveSlot = (def: EmployeeDef): string | undefined =>
    (def.model ?? '').startsWith('auto:') ? p.slots.get(`${def.provider}:${(def.model ?? '').slice(5)}`) : (def.model || undefined);
  const ready = (inst: EmployeeInst) =>
    p.states.get(inst.id) === 'idle' ||
    (p.states.get(inst.id) === 'exhausted' && availabilityOf(p.health.get(inst.provider ?? ''), p.now) === 'probe');
  const currentModel = (inst: EmployeeInst): boolean => {
    const def = p.defs.find(d => d.id === inst.def);
    const target = def && resolveSlot(def);
    return !target || !inst.model || inst.model === target;
  };
  const cap = (provider: string) => providerCapacity(provider, p.providerMax, p.health, p.busyBy, p.now, p.quotaBlocked);
  /** Distinguish quota circuit-break from full seats in the owner-facing reason. */
  const capReason = (provider: string): string | undefined =>
    p.quotaBlocked.get(provider) ?? (cap(provider) ? undefined : 'provider 无可用容量');
  // Track gating: a task with discipline X only routes to defs whose tracks list covers X.
  const trackOk = (task: SupervisedTask | undefined, tracks: string[] | undefined) =>
    trackOkFor(p.role as Role, task, tracks);
  const entries: StaffingEntry[] = [];
  for (const inst of p.insts) {
    if (inst.role !== p.role) continue;
    if ((inst.repoHome ?? inst.cwd ?? p.opsRepo) !== p.home) continue;
    const def = p.defs.find(d => d.id === inst.def);
    const reason =
      !ready(inst) ? '会话占用中/异常' :
      p.assigned?.has(inst.id) ? '本轮已分配' :
      p.holding.has(inst.id) ? '持有在办任务' :
      p.recusal?.authors.has(inst.id) ? '提交过本任务，验收回避' :
      (p.excludeSubmitter && inst.id === p.task?.submittedBy) ? '提交者回避' :
      (p.sidecar && inst.credentialFile) ? '凭证文件实例不可接新任务' :
      !trackOk(p.task, def?.tracks) ? '岗位轨不匹配' :
      !currentModel(inst) ? '模型槽位已漂移' :
      capReason(inst.provider ?? '');
    const priorHand = !reason && (p.recusal?.hands.has(inst.id) ?? false);
    entries.push({ kind: 'reuse', key: inst.id, ref: inst.id, role: p.role,
      provider: inst.provider ?? '', model: inst.model ?? def?.model, def, inst,
      weight: effectiveWeight(def) * (priorHand ? PRIOR_HAND_WEIGHT_FACTOR : 1),
      share: 0, eligible: !reason, reason, note: priorHand ? '经手过本任务，降权兜底' : undefined });
  }
  for (const def of p.defs) {
    if (def.role !== p.role) continue;
    const resolved = resolveSlot(def);
    const seats = p.insts.filter(i => i.def === def.id && (i.repoHome ?? i.cwd ?? p.opsRepo) === p.home && !(p.sidecar && i.credentialFile)).length;
    const reason =
      !def.enabled ? '编制停用' :
      !trackOk(p.task, def.tracks) ? '岗位轨不匹配' :
      resolved === undefined ? '模型槽位未解析' :
      seats >= def.maxInstances ? `实例数 ${seats}/${def.maxInstances} 已满` :
      capReason(def.provider);
    entries.push({ kind: 'spawn', key: `spawn:${def.id}`, ref: def.id, role: p.role,
      provider: def.provider, model: resolved ?? def.model, def,
      weight: effectiveWeight(def), share: 0, eligible: !reason, reason });
  }
  const total = entries.filter(e => e.eligible).reduce((s, e) => s + Math.max(0, e.weight), 0);
  for (const e of entries) e.share = e.eligible && total > 0 ? Math.max(0, e.weight) / total : 0;
  return entries;
}

/** Review recusal split: hard exclusion for authors, weight demotion for claim-only holders. */
export interface ReviewRecusal {
  /** submits>0 — wrote or accepted this task; reviewing own delivery is never allowed. */
  authors: ReadonlySet<string>;
  /** claims>0 without submits — held a lease, returned or revoked; eligible at demoted weight. */
  hands: ReadonlySet<string>;
}

/** Shared audit-based recusal lookup. Unknown history must never become an empty set. */
export async function readReviewRecusal(
  workforce: Pick<Workforce, 'evalState'>, task: SupervisedTask,
  log: (message: string) => void = () => {},
): Promise<ReviewRecusal | undefined> {
  try {
    const state = await workforce.evalState(task.id);
    const authors = new Set<string>();
    const hands = new Set<string>();
    for (const e of state.participants) {
      if ((state.metrics[e]?.submits ?? 0) > 0) authors.add(e);
      else if ((state.metrics[e]?.claims ?? 0) > 0) hands.add(e);
    }
    return { authors, hands };
  } catch (error) {
    log(`contributors read failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export interface ReviewStaffingPreview {
  taskId: string;
  title: string;
  purpose: 'review';
  role: string;
  home: string;
  status: 'ready' | 'history_unavailable';
  entries: StaffingEntry[];
}

/** Task-scoped estimate; the public role/home pool stays independent of review recusal. */
export async function reviewStaffingPreviews(
  tasks: readonly SupervisedTask[],
  base: Omit<StaffingInput, 'role' | 'home' | 'task' | 'excludeSubmitter' | 'recusal'>,
  workforce: Pick<Workforce, 'evalState'>,
): Promise<ReviewStaffingPreview[]> {
  const previews: ReviewStaffingPreview[] = [];
  for (const task of tasks.filter(t => t.state === 'review' && t.reviewerRole !== 'owner' && !t.currentEmployee)) {
    const recusal = await readReviewRecusal(workforce, task);
    const home = task.repoPath ?? base.opsRepo;
    const entries = staffingPool({ ...base, role: task.reviewerRole, home, task,
      excludeSubmitter: true, recusal });
    previews.push({ taskId: task.id, title: task.title, purpose: 'review', role: task.reviewerRole, home,
      status: recusal === undefined ? 'history_unavailable' : 'ready',
      entries: recusal === undefined
        ? entries.map(e => ({ ...e, eligible: false, share: 0, reason: '贡献者历史读取失败，等待安全候选' }))
        : entries });
  }
  return previews;
}

export interface DispatcherDeps {
  workforce: Workforce;
  owner: OwnerDesk;
  paseo: PaseoGateway;
  env: PromptEnv;
  notify?: (title: string, text: string) => Promise<void>;
  log?: (message: string) => void;
  /** Randomness source for weighted picks; injectable for tests. */
  rand?: () => number;
  /** Jev System One decision model; undefined disables the Jev evaluation path. */
  jev?: JevClient;
  /** Legacy regex sweeper (pre-WT01). Prefer reclaimWorktrees when the managed registry is enabled. */
  git?: GitGateway;
  /**
   * WT02 ownership reclaim. Called bare on the existing 10-minute sweep cadence; called with
   * treeId+repo+trigger at event points (lease revoke/expire) to evaluate a single tree.
   * Undefined disables reclaim.
   */
  reclaimWorktrees?: (input?: { trigger?: ReclaimTrigger; treeId?: string; repo?: string }) => Promise<ReclaimResult>;
  /** Remaining quota per provider (read from DB rows the Paseo plugin refreshes); feeds Jev staffing. */
  quota?: () => Promise<ProviderQuota[]>;
  /** Current "<provider>:<family>" → model id resolution for defs using `auto:<family>`; the Paseo plugin refreshes it. */
  models?: () => Promise<ModelSlots>;
  /**
   * Plugin sidecar mode: when set, the dispatcher never hands credentials to
   * agents. The bridge injects comm env at spawn, claims tasks on the
   * instance's behalf, and records the agentId↔instance binding.
   */
  sidecar?: SidecarBridge;
  /**
   * Host free-resource probe (memory + disk in MB). When provided, ticks below the
   * configured floors skip the whole dispatch pass; absent or throwing = no gate.
   */
  hostResources?: () => HostResources;
}

/** Narrow seam the Paseo plugin's per-agent supervisor implements. */
export interface SidecarBridge {
  /** Environment for a fresh spawn: comm dir + key, never credentials. */
  env(inst: EmployeeInst): Record<string, string>;
  /** A live launch binding in this plugin process; false after restart or detach. */
  canReuse(inst: EmployeeInst): boolean;
  /** Releases a session binding and all of its ops sessions. */
  detachAgent(agentId: string): void;
  /** Claims the task as the instance and stages claim.json; undefined = lost the race. */
  claim(inst: EmployeeInst, task: SupervisedTask): Promise<ClaimResult | undefined>;
  /** Records the freshly spawned Paseo agentId for this instance. */
  readWorkspace?(inst: EmployeeInst, taskId?: string, project?: string): Promise<WorktreeAssignment | undefined>;
  releaseWorkspace?(inst: EmployeeInst): Promise<void>;
  bindAgent(instId: string, agentId: string): void;
  /** Absolute path of the instance's comm dir, for prompts (agents must not resolve env vars). */
  commDirFor(instId: string): string;
  /** A spawn that succeeded but whose pre-claim is now orphaned. */
  releaseClaim(instId: string, taskId: string, reason: string): Promise<void>;
  /** Server-side lease was revoked: drop the local claim remnant so the instance can pick again. */
  dropLease?(instId: string, taskId?: string): void;
}

/** Jev-chosen override for one dispatch: force an existing instance, or skip reuse and spawn a chosen def. */
interface AssignPreference { instId?: string; defId?: string; skipReuse?: boolean }

/**
 * Workspace anchor for task-less management dispatches (gm-attention, triage, eval).
 * `task` anchors by task identity: its repoPath picks the candidate home and its id
 * drives readWorkspace project resolution. `home`+`project` anchor a goal directly
 * when no task exists yet (triage): `home` is the resolved repo the candidate pool,
 * spawn cwd and repoHome bind to, `project` is the project id readWorkspace resolves.
 */
interface DispatchAnchor { task?: SupervisedTask; home?: string; project?: string }

export interface TickReport {
  commands: number;
  revoked: string[];
  extended: string[];
  woke: Array<{ task: string; employee: string; spawned: boolean }>;
  retired: string[];
  exhausted: string[];
  notices: string[];
  evals: string[];
  /** Jev decisions taken this tick, e.g. "triage:<goal>=quick", "release:<task>", "reroute:<task>". */
  decisions: string[];
  skipped?: 'paused' | 'budget' | 'resources';
}

export class Dispatcher {
  /** Last observed Paseo status per agent; a busy→idle transition is the recovery signal for a provider. */
  private readonly lastStatus = new Map<string, string>();
  private readonly onboarded = new Set<string>();
  // Jev staff verdicts keyed by task+purpose: identical candidate sets would get
  // identical answers, so re-asking every tick only burns tokens. Re-ask only
  // when the candidate fingerprint changes, and drop candidates whose last
  // assign attempt failed for a cooldown window.
  private readonly staffCache = new Map<string, { fp: string; prefer?: AssignPreference }>();
  private readonly staffAvoid = new Map<string, Map<string, number>>();
  // Claim denials are task-state refusals (already claimed, busy worktree, gone
  // task): every candidate would hit the same wall, so a fresh denial cools the
  // task for a while instead of spawning a disposable instance every tick.
  private readonly taskDeny = new Map<string, { at: number; version?: number }>();
  private lastSweep = 0;
  private readonly keptLogged = new Set<string>();

  constructor(private readonly deps: DispatcherDeps) {}
  private log(message: string) { this.deps.log?.(message); }

  async tick(): Promise<TickReport> {
    const { workforce: wf, owner, paseo } = this.deps;
    const report: TickReport = { commands: 0, revoked: [], extended: [], woke: [], retired: [], exhausted: [], notices: [], evals: [], decisions: [] };
    report.commands = (await owner.applyPending()).length;
    const cfg = await wf.config();
    const [agents, defs, now, quotaRows, slotRows] = await Promise.all([paseo.list(), wf.defs(), wf.serverNow(),
      this.deps.quota ? this.deps.quota().catch((error) => { this.log(`quota read failed: ${(error as Error).message}`); return [] as ProviderQuota[]; })
        : Promise.resolve([] as ProviderQuota[]),
      this.deps.models ? this.deps.models().catch((error) => { this.log(`model slots read failed: ${(error as Error).message}`); return {}; })
        : Promise.resolve({} as ModelSlots)]);
    const slotMap = new Map(Object.entries(slotRows));
    /** `auto:<family>` defs resolve via the plugin-maintained slot map; literals pin. */
    const resolveModel = (def: EmployeeDef): string | undefined => this.resolveModel(def, slotMap);
    let insts = await wf.insts();
    let health = await wf.providerHealth();
    const quotaByProvider = new Map<string, ProviderQuota>();
    for (const q of quotaRows) quotaByProvider.set(q.provider, q);
    // Quota circuit breaker: separate floors for short windows (session/5h + balances)
    // and long windows (week/month). Stale snapshots (>15min) fail open rather than
    // keeping a provider blocked forever.
    const quotaBlocked = quotaBlockedProviders(quotaRows, cfg, Date.now());
    if (quotaBlocked.size) this.log(`quota below floor: ${[...quotaBlocked].map(([p, r]) => `${p} ${r}`).join('; ')}`);

    // 1. Session health.
    const states = new Map<string, InstState>();
    for (const inst of insts) {
      if (!inst.paseoAgentId) {
        await wf.retire(inst.id, 'spawn did not bind a Paseo agent', 'failure');
        report.retired.push(inst.id);
        continue;
      }
      if (this.deps.sidecar && !inst.credentialFile && !this.deps.sidecar.canReuse(inst)) {
        // Infrastructure failure, not a model/provider or employee performance failure.
        states.set(inst.id, 'down');
        await this.retireBroken(inst, '通道隔离：会话启动绑定已失效，禁止复用旧会话', defs, report, false);
        await paseo.stop(inst.paseoAgentId).catch(() => undefined);
        await paseo.archive(inst.paseoAgentId).catch(() => undefined);
        continue;
      }
      const status = agents.get(inst.paseoAgentId)?.status ?? (await paseo.status(inst.paseoAgentId))?.status ?? 'missing';
      const previous = this.lastStatus.get(inst.paseoAgentId);
      this.lastStatus.set(inst.paseoAgentId, status);
      if (status === 'running' || status === 'initializing') { states.set(inst.id, 'busy'); continue; }
      if (status === 'idle') {
        states.set(inst.id, 'idle');
        if ((previous === 'running' || previous === 'error') && inst.provider) {
          if (health.get(inst.provider)?.state === 'exhausted') await wf.markHealthy(inst.provider);
          if (inst.def) await wf.defHealthy(inst.def);
        }
        continue;
      }
      if (status === 'error') {
        const error = await paseo.lastError(inst.paseoAgentId);
        if (EXHAUSTED_PATTERN.test(error) && inst.provider) {
          states.set(inst.id, 'exhausted');
          // Only a fresh failure (a turn that ran into the limit) restarts the cooldown; a session that is
          // still sitting in the old error state must not keep doubling it, or the provider is never probed.
          const known = health.get(inst.provider)?.state === 'exhausted';
          const fresh = previous === undefined ? !known : previous !== 'error';
          if (fresh && !report.exhausted.includes(inst.provider)) {
            await wf.markExhausted(inst.provider, error);
            report.exhausted.push(inst.provider);
          }
          continue;
        }
        states.set(inst.id, 'down');
        await this.retireBroken(inst, `session error: ${error.slice(0, 200) || 'unknown'}`, defs, report);
        continue;
      }
      states.set(inst.id, 'down');
      await this.retireBroken(inst, `session ${status}`, defs, report, false);
    }
    health = await wf.providerHealth();
    const byId = new Map(insts.map(i => [i.id, i]));

    // 2. Lease supervision: extend live holders, revoke dead or stalled ones with a handover packet.
    for (const task of await wf.tasks()) {
      if (!task.currentEmployee) continue;
      const inst = byId.get(task.currentEmployee);
      const state = inst ? states.get(inst.id) : undefined;
      const expired = (task.leaseExpiresAt ?? 0) <= now;
      const stale = task.progressAt !== undefined && now - task.progressAt > cfg.stallMinutes * 60;
      if (state === 'busy') {
        if (stale) {
          await paseo.stop(inst!.paseoAgentId!).catch(() => undefined);
          await this.revoke(task, `员工 ${inst!.id} 超过 ${cfg.stallMinutes} 分钟没有任何 checkpoint，已中止其会话`, inst, report);
        } else if ((task.leaseExpiresAt ?? 0) - now < cfg.extendWithinSeconds &&
          await wf.extendLease(task.id, task.currentEmployee, LEASE_SECONDS)) {
          report.extended.push(task.id);
        }
        continue;
      }
      if (state === 'down' || state === 'exhausted') {
        await this.revoke(task, `员工 ${inst!.id} 的会话${state === 'exhausted' ? '所在订阅额度耗尽/限流' : '已中断'}`, inst, report);
      } else if (stale) {
        // A non-busy holder (typically a session whose turn ended mid-claim and went
        // idle) produces no work, yet the sidecar heartbeat keeps the server lease
        // fresh forever — `expired` never fires. Reclaim on progress stall instead:
        // progress_at moves only on checkpoint, so staleness means parked work.
        await this.revoke(task, `员工 ${task.currentEmployee} 会话${state === 'idle' ? '空闲' : '失联'}且超过 ${cfg.stallMinutes} 分钟没有 checkpoint`, inst, report);
      } else if (expired) {
        await this.revoke(task, `员工 ${task.currentEmployee} 结束本轮但未交接，租约已过期`, inst, report, 'expire');
      }
    }
    insts = insts.filter(i => !report.retired.includes(i.id));

    // 2b. Jev decisions: goal triage, release go/no-go, owner-escalation routing. Undecided items stay with gm/product.
    if (this.deps.jev && cfg.jevDecisions) await this.jevDecisions(cfg, report);
    const tasks = await wf.tasks();

    // 2c. Session rotation: a session that has run many turns carries an ever-growing context,
    // so every further turn costs more input tokens. Retire idle instances past the configured
    // size/count and let the next task spawn a fresh, cheap session.
    {
      const holding = new Set(tasks.filter(t => t.currentEmployee).map(t => t.currentEmployee!));
      let inspected = 0;
      for (const inst of insts) {
        if (states.get(inst.id) !== 'idle' || holding.has(inst.id) || !inst.paseoAgentId) continue;
        // Sidecar mode: a credential-file instance can never take new work (the pool
        // refuses to claim for it), so an idle one only wastes a provider seat and
        // misleads Jev's staffing picks. Retire it on sight.
        const legacyEol = Boolean(this.deps.sidecar && inst.credentialFile);
        const overWakes = cfg.sessionMaxWakes > 0 && (inst.wakeCount ?? 0) >= cfg.sessionMaxWakes;
        let inputK = 0;
        if (!legacyEol && !overWakes && cfg.sessionMaxInputK > 0 && (inst.wakeCount ?? 0) >= 3 && inspected < 8) {
          inspected++;
          inputK = ((await paseo.lastInputTokens(inst.paseoAgentId!).catch(() => undefined)) ?? 0) / 1000;
        }
        // Model staleness: an idle instance still on the previous resolved model would keep
        // serving new tasks with it, so rotate it out before dispatch. Insts whose model we
        // cannot read (undefined) stay; so do those of defs whose model is unresolvable now.
        const def = defs.find(d => d.id === inst.def);
        const target = def ? resolveModel(def) : undefined;
        const staleModel = Boolean(target && inst.model && inst.model !== target);
        if (!legacyEol && !overWakes && !(cfg.sessionMaxInputK > 0 && inputK > cfg.sessionMaxInputK) && !staleModel) continue;
        const reason = legacyEol ? '通道轮换：凭证文件实例在 sidecar 模式下不可再接任务'
          : staleModel ? `模型轮换：实例跑 ${inst.model}，编制已到 ${target}`
          : overWakes ? `会话轮换：已派工 ${inst.wakeCount} 轮` : `会话轮换：上一轮 input ${Math.round(inputK)}k tokens`;
        await wf.retire(inst.id, reason, 'rotation');
        await paseo.archive(inst.paseoAgentId!).catch(() => undefined);
        await this.archiveInstScene(inst);
        if (staleModel && def) {
          await this.notice(`model-upgrade:${def.id}:${target}`,
            `编制 ${def.id} 的模型已升级到 ${target}（实例 ${inst.id} 等空闲旧模型会话已轮换，新任务将用新模型起会话）。`, report);
        }
        report.retired.push(inst.id);
        this.log(`retired ${inst.id}: ${reason}`);
      }
      insts = insts.filter(i => !report.retired.includes(i.id));
    }

    // 3. Owner inbox notices (gates, questions) and staffing gaps.
    await this.ownerNotices(tasks, report);
    await this.ownerAging(now, report).catch(error => this.log(`owner aging failed: ${(error as Error).message}`));
    await this.dailyBrief(now, cfg, report).catch(error => this.log(`daily brief failed: ${(error as Error).message}`));

    // 4. Work that needs an employee.
    const holding = new Set(tasks.filter(t => t.currentEmployee).map(t => t.currentEmployee!));
    const work = [
      ...tasks.filter(t => t.state === 'review' && t.reviewerRole !== 'owner' && !t.currentEmployee)
        .map(t => ({ task: t, role: t.reviewerRole, purpose: 'review' })),
      ...tasks.filter(t => (t.state === 'ready' || t.state === 'doing') && !t.currentEmployee)
        .map(t => ({ task: t, role: t.executorRole as string, purpose: 'execute' })),
    ];
    const gmBlocked = tasks.filter(t => t.state === 'blocked' && t.blockedTo === 'gm');
    const usable = [...new Set(defs.filter(d => d.enabled).map(d => d.provider))]
      .filter(p => this.available(health.get(p), now) !== 'down' && !quotaBlocked.has(p));
    if ((work.length || gmBlocked.length) && usable.length === 0) {
      const exhausted = [...health.values()].filter(h => h.state === 'exhausted')
        .map(h => `${h.provider}（预计 ${new Date((h.until ?? now) * 1000).toLocaleString('zh-CN')} 后重试）`);
      const text = `所有订阅都已耗尽或限流，公司暂停派工。请为以下订阅充值或等待额度恢复：${
        [...exhausted, ...[...quotaBlocked].map(([p, r]) => `${p}（${r}）`)].join('、') || '全部'}`;
      await this.notice('budget', text, report);
      report.skipped = 'budget';
      return report;
    }
    await owner.resolveNotice('budget');
    if (cfg.paused) { report.skipped = 'paused'; return report; }

    // Host resource admission: below the configured free floors a spawn/wake would
    // starve every session already running on this host, so the entire dispatch
    // pass waits. Supervision above already ran — stalled leases still get reclaimed.
    // A probe error fails open (logged) rather than halting dispatch forever.
    const host = this.hostResources();
    if (host && (host.freeMemMb < cfg.minFreeMemMb || host.freeDiskMb < cfg.minFreeDiskMb)) {
      await this.notice('resources',
        `宿主机资源不足，本轮暂停派工：空闲内存 ${host.freeMemMb} MB（下限 ${cfg.minFreeMemMb} MB）、空闲磁盘 ${(host.freeDiskMb / 1024).toFixed(1)} GB（下限 ${(cfg.minFreeDiskMb / 1024).toFixed(0)} GB）。在办任务不受影响，水位恢复后自动继续派工。`, report);
      report.skipped = 'resources';
      return report;
    }
    await owner.resolveNotice('resources');

    const busyBy = new Map<string, number>();
    let running = 0;
    for (const inst of insts) {
      if (states.get(inst.id) !== 'busy') continue;
      running++;
      busyBy.set(inst.provider ?? '', (busyBy.get(inst.provider ?? '') ?? 0) + 1);
    }
    const assigned = new Set<string>();
    const rand = this.deps.rand ?? Math.random;
    // The candidate pool is evaluated by staffingPool — the same function the owner
    // page previews — so dispatch gating and the roster can never drift apart.
    const poolBase = { defs, states, holding, health, quotaBlocked, busyBy,
      providerMax: cfg.providerMax, slots: slotMap, opsRepo: this.deps.env.opsRepo,
      sidecar: !!this.deps.sidecar, now };
    const eligibleInsts = (role: string, home: string, task?: SupervisedTask, excludeSubmitter = false,
      recusal?: ReviewRecusal) =>
      staffingPool({ ...poolBase, insts, role, home, task, excludeSubmitter, recusal, assigned })
        .flatMap(e => e.kind === 'reuse' && e.eligible ? [e.inst!] : []);
    const eligibleDefs = (role: string, home: string, task?: SupervisedTask) =>
      staffingPool({ ...poolBase, insts, role, home, task })
        .flatMap(e => e.kind === 'spawn' && e.eligible ? [e.def!] : []);
    const ready = (inst: EmployeeInst) => states.get(inst.id) === 'idle' ||
      (states.get(inst.id) === 'exhausted' && availabilityOf(health.get(inst.provider ?? ''), now) === 'probe');
    // Surfacing: enabled auto defs whose family cannot be resolved right now would silently
    // starve their roles, so escalate once (clears automatically when resolution returns).
    const unresolved = defs.filter(d => d.enabled && (d.model ?? '').startsWith('auto:') && resolveModel(d) === undefined);
    if (unresolved.length) {
      await this.notice('model-unresolved',
        `员工编制 ${unresolved.map(d => `${d.id}（${d.provider}/${d.model}）`).join('、')} 的模型槽位无法解析，相关角色暂不可派工——检查 Paseo 插件的模型刷新或对应订阅。`, report);
    } else {
      await owner.resolveNotice('model-unresolved');
    }
    const pick = (role: string, task?: SupervisedTask, avoid?: string, excludeSubmitter = false,
      recusal?: ReviewRecusal, anchorHome?: string) => {
      const home = task?.repoPath ?? anchorHome ?? this.deps.env.opsRepo;
      const candidates = eligibleInsts(role, home, task, excludeSubmitter, recusal);
      const demote = (id: string) => recusal?.hands.has(id) ? PRIOR_HAND_WEIGHT_FACTOR : 1;
      const weight = (inst: EmployeeInst) => effectiveWeight(defs.find(d => d.id === inst.def)) * demote(inst.id);
      // Continuity beats weights: the previous holder keeps the task when it is still available.
      // Review work never hits this: an author's former holder is already out; a claim-only
      // hand surviving as previousEmployee is continuity, not a conflict.
      const previous = candidates.find(i => i.id === task?.previousEmployee && states.get(i.id) === 'idle');
      if (previous) return previous;
      // A dead (exhausted) session cannot prove a provider recovered; probe with a live one when possible.
      const live = candidates.filter(i => states.get(i.id) === 'idle');
      const usable = live.length ? live : candidates;
      const pool = usable.filter(i => i.id !== avoid);
      return weightedOrder(pool.length ? pool : usable, weight, rand)[0];
    };
    const spawnable = (role: string, home: string, task?: SupervisedTask) => weightedOrder(eligibleDefs(role, home, task), effectiveWeight, rand);
    // Jev 在合格候选人中挑人：候选=可复用实例+可新开 def，附带绩效、订阅额度与健康度。
    // Review 派工的作者在进 Jev 前就已从 reuse 候选剔除，经手人保留但打 prior 标记；
    // spawn 候选是编制而非实例——新实例会得到全新 employee id，不可能是历史贡献者。
    const routeEmployee = async (item: (typeof work)[number], recusal?: ReviewRecusal): Promise<AssignPreference | undefined> => {
      if (!this.deps.jev || !cfg.jevDecisions) return undefined;
      const home = item.task.repoPath ?? this.deps.env.opsRepo;
      const cacheKey = `${item.purpose}:${item.task.id}`;
      const avoided = this.staffAvoid.get(cacheKey);
      const dodged = (key: string) => (avoided?.get(key) ?? 0) > now;
      const reuse = eligibleInsts(item.role, home, item.task, item.purpose === 'review', recusal).filter(i => !dodged(i.id));
      const spawn = eligibleDefs(item.role, home, item.task).filter(d => !dodged(`spawn:${d.id}`));
      if (reuse.length + spawn.length < 2) return undefined;
      // Same candidate set → same verdict; only call Jev when the fingerprint moved.
      const fp = `${item.role}|${item.task.version}|` +
        [...reuse.map(i => i.id), ...spawn.map(d => `spawn:${d.id}`)].sort().join(',');
      const hit = this.staffCache.get(cacheKey);
      if (hit?.fp === fp) return hit.prefer;
      const describeHealth = (provider: string) => health.get(provider)?.state ?? 'ok';
      const candidates: RouteCandidate[] = [
        ...reuse.map(i => {
          const def = defs.find(d => d.id === i.def);
          return { key: i.id, kind: 'reuse' as const, provider: i.provider ?? def?.provider ?? '', model: i.model ?? def?.model ?? '',
            score: def?.avgScore, scored: def?.scored, quota: quotaByProvider.get(i.provider ?? def?.provider ?? '')?.summary,
            health: describeHealth(i.provider ?? def?.provider ?? ''), continued: i.id === item.task.previousEmployee,
            prior: recusal?.hands.has(i.id) || undefined };
        }),
        ...spawn.map(d => ({ key: `spawn:${d.id}`, kind: 'spawn' as const, provider: d.provider, model: resolveModel(d) ?? d.model ?? '',
          score: d.avgScore, scored: d.scored, quota: quotaByProvider.get(d.provider)?.summary,
          health: describeHealth(d.provider) })),
      ];
      const directions = (await owner.brief()).directions.map(d => d.text);
      const verdict = await jevStaff(this.deps.jev, {
        purpose: item.purpose, directions,
        task: { id: item.task.id, title: item.task.title, kind: item.task.kind, state: item.task.state,
          project: item.task.repoPath, context: item.task.row.context?.slice(0, 2000) },
        candidates,
      }).catch(error => { this.log(`jev staff failed: ${(error as Error).message}`); return { key: undefined, confidence: 0 }; });
      const inst = reuse.find(i => i.id === verdict.key);
      const def = spawn.find(d => `spawn:${d.id}` === verdict.key);
      if ((!inst && !def) || verdict.confidence < cfg.jevPickConfidence) {
        if (verdict.key) report.decisions.push(`staff:${item.task.id}=weighted(${verdict.confidence.toFixed(2)})`);
        this.staffCache.set(cacheKey, { fp });
        return undefined;
      }
      report.decisions.push(`staff:${item.task.id}=${verdict.key}@${verdict.confidence.toFixed(2)}`);
      this.log(`jev picked ${verdict.key} for ${item.task.id} (${verdict.confidence.toFixed(2)})`);
      const prefer = inst ? { instId: inst.id } : { defId: def!.id, skipReuse: true };
      this.staffCache.set(cacheKey, { fp, prefer });
      return prefer;
    };

    const explainStaffing = (role: string, home: string, task?: SupervisedTask): string => {
      const parts: string[] = [];
      const roleDefs = defs.filter(d => d.role === role);
      if (!roleDefs.length) parts.push('无该岗位编制');
      for (const d of roleDefs) {
        const name = `${d.provider}(${d.id})`;
        if (!d.enabled) { parts.push(`${name} 编制停用`); continue; }
        // Keep reason precedence in lockstep with staffingPool: a track-mismatched def is
        // never a real candidate, so saying '可新开' here would misread as a spawn bug.
        if (!trackOkFor(role as Role, task, d.tracks)) { parts.push(`${name} 岗位轨不匹配`); continue; }
        if (resolveModel(d) === undefined) { parts.push(`${name}/${d.model} 模型槽位未解析`); continue; }
        const qb = quotaBlocked.get(d.provider);
        if (qb) { parts.push(`${name} ${qb}`); continue; }
        const avail = this.available(health.get(d.provider), now);
        if (avail === 'down') {
          const until = health.get(d.provider)?.until;
          parts.push(`${name} 订阅冷却${until ? `至 ${new Date(until * 1000).toLocaleTimeString('zh-CN')}` : '中'}`);
          continue;
        }
        const busy = busyBy.get(d.provider) ?? 0;
        const cap = cfg.providerMax[d.provider] ?? 1;
        if (avail === 'probe' && busy > 0) { parts.push(`${name} 订阅待探测恢复，当前 ${busy} 个占用`); continue; }
        if (busy >= cap) {
          parts.push(`${name} 并发 ${busy}/${cap} 已满${d.provider in cfg.providerMax ? '' : '（provider_max 未配置该 provider，默认 1）'}`);
          continue;
        }
        const inRepo = insts.filter(i => i.def === d.id && (i.repoHome ?? i.cwd ?? this.deps.env.opsRepo) === home).length;
        if (inRepo >= d.maxInstances) { parts.push(`${name} 实例 ${inRepo}/${d.maxInstances} 已满且忙碌`); continue; }
        parts.push(`${name} 可新开但唤醒/创建失败`);
      }
      const count = (st: InstState) => insts.filter(i =>
        i.role === role && states.get(i.id) === st && (i.repoHome ?? i.cwd ?? this.deps.env.opsRepo) === home).length;
      const pool = `实例池：空闲 ${count('idle')}、忙碌 ${count('busy')}` +
        (count('exhausted') ? `、限流 ${count('exhausted')}` : '') + (count('down') ? `、异常 ${count('down')}` : '');
      return `${pool}；${parts.join('；') || '无该岗位编制'}`;
    };

    for (const item of work) {
      if (running >= cfg.maxRunning) break;
      const last = await wf.lastDispatch(item.task.id, item.task.version, item.purpose);
      if (last && now - last.at < cfg.redispatchMinutes * 60) continue;
      // 验收独立性：review 派工先取本任务回避名单——提交过本任务的作者硬回避
      // （验收自己的交付等于没验收），仅 claim 过未提交的经手人降权兜底、不硬阻断。
      // 历史读失败时名单未知，fail-closed：本轮跳过让任务留在队列；submittedBy
      // 拦截只覆盖当前提交人，挡不住非提交人的作者；读取恢复后自动继续。
      const recusal = item.purpose === 'review' ? await readReviewRecusal(wf, item.task, message => this.log(message)) : undefined;
      if (item.purpose === 'review' && recusal === undefined) {
        await this.notice(`contributors:${item.task.id}`,
          `任务 ${item.task.id} 继续等待验收：贡献者历史读取失败，回避名单未知，本轮不派复核，防止历史贡献者被重复派入验收。`, report);
        continue;
      }
      if (item.purpose === 'review') await owner.resolveNotice(`contributors:${item.task.id}`);
      const prefer = await routeEmployee(item, recusal);
      const result = await this.assign(item.role, item.task, last?.employee, pick, spawnable,
        (inst, first, claim) => wake(inst, item.task, this.deps.env, first,
          { comm: !!this.deps.sidecar, claim, commDir: this.deps.sidecar?.commDirFor(inst.id) }), report, insts, item.purpose === 'review', prefer, slotMap, recusal);
      if (!result) {
        if (prefer) {
          // Jev's pick just failed in assign; stop re-picking the same candidate
          // while the rest of the pool stays eligible.
          const cacheKey = `${item.purpose}:${item.task.id}`;
          this.staffCache.delete(cacheKey);
          const key = prefer.instId ?? `spawn:${prefer.defId}`;
          const map = this.staffAvoid.get(cacheKey) ?? new Map<string, number>();
          map.set(key, now + 30 * 60 * 1000);
          this.staffAvoid.set(cacheKey, map);
        }
        const home = item.task.repoPath ?? this.deps.env.opsRepo;
        const recused = item.purpose === 'review' && (recusal?.authors.size || recusal?.hands.size)
          ? `；验收回避：${[...recusal.authors].sort().join('、') || '无'} 提交过本任务（硬回避）` +
            (recusal.hands.size ? `，${[...recusal.hands].sort().join('、')} 仅经手未提交（降权兜底，仍可作为最后候选）` : '')
          : '';
        await this.notice(`staff:${item.role}`, `岗位 ${item.role} 暂无可用员工——${explainStaffing(item.role, home, item.task)}${recused}。任务 ${item.task.id} 等待中。`, report);
        continue;
      }
      await owner.resolveNotice(`staff:${item.role}`);
      this.staffCache.delete(`${item.purpose}:${item.task.id}`);
      this.staffAvoid.delete(`${item.purpose}:${item.task.id}`);
      await wf.recordDispatch(item.task.id, item.task.version, item.purpose, result.id);
      running++;
      busyBy.set(result.provider ?? '', (busyBy.get(result.provider ?? '') ?? 0) + 1);
      assigned.add(result.id);
      report.woke.push({ task: item.task.id, employee: result.id, spawned: result.spawned });
    }

    const pendingGm: SupervisedTask[] = [];
    // Batch audit reads up front: per-task blockLoops() would cost two round trips per
    // blocked task, and on the ~50KB/s WSS channel hundreds of sequential lookups keep
    // interactive RPCs queued past the daemon's 30s timeout.
    const gmLoopStats = gmBlocked.length && typeof owner.blockLoopStats === 'function'
      ? await owner.blockLoopStats(gmBlocked.map(t => t.id)).catch(() => new Map<string, { loops: number; reasons: string[] }>())
      : undefined;
    const gmLastDispatches = gmBlocked.length && typeof wf.lastDispatches === 'function'
      ? await wf.lastDispatches(gmBlocked.map(t => t.id), 'gm-attention').catch(() => new Map<string, { employee: string; at: number }>())
      : undefined;
    for (const task of gmBlocked) {
      const last = gmLastDispatches ? gmLastDispatches.get(`${task.id}:${task.version}`)
        : await wf.lastDispatch(task.id, task.version, 'gm-attention');
      if (last && now - last.at < cfg.redispatchMinutes * 60) continue;
      if (await this.breakLoop(task, cfg, report, gmLoopStats?.get(task.id)).catch(() => false)) continue;
      pendingGm.push(task);
    }
    // An instance lives in one Paseo workspace (one project), so gm-attention dispatches
    // per repo: the group's readTask anchors pick home, per-project spawn quota,
    // readWorkspace resolution and the cwd/repoHome fallback on the repo the blocked
    // tasks actually belong to — a single anchorless assign would pin every project's
    // gm batch onto the ops repo tree.
    const gmGroups = new Map<string, SupervisedTask[]>();
    for (const task of pendingGm) {
      const home = task.repoPath ?? this.deps.env.opsRepo;
      const group = gmGroups.get(home);
      if (group) group.push(task); else gmGroups.set(home, [task]);
    }
    for (const group of gmGroups.values()) {
      if (running >= cfg.maxRunning) break;
      const result = await this.assign('gm', undefined, undefined, pick, spawnable,
        (inst, first, claim, worktree) => gmAttention(inst, group, this.deps.env, first, { comm: !!this.deps.sidecar, worktree, commDir: this.deps.sidecar?.commDirFor(inst.id) }), report, insts, false, undefined, slotMap, undefined, { task: group[0] });
      if (!result) continue;
      for (const task of group) await wf.recordDispatch(task.id, task.version, 'gm-attention', result.id);
      running++;
      busyBy.set(result.provider ?? '', (busyBy.get(result.provider ?? '') ?? 0) + 1);
      assigned.add(result.id);
      report.woke.push(...group.map(t => ({ task: t.id, employee: result.id, spawned: result.spawned })));
    }

    const triage = await owner.triagePending();
    if (triage.length && running < cfg.maxRunning) {
      const due: typeof triage = [];
      for (const goal of triage) {
        const last = await wf.lastDispatch(`goal:${goal.id}`, 0, 'triage');
        if (!last || now - last.at >= cfg.redispatchMinutes * 60) due.push(goal);
      }
      // Same per-repo anchoring as gm-attention: a due goal's project decides which
      // shared worktree the gm triage session lands in. The goal has no task yet, so
      // the anchor carries the resolved repo home plus the project id readWorkspace
      // resolves; project-less goals stay on the ops repo tree.
      const triageGroups = new Map<string, typeof due>();
      for (const goal of due) {
        const home = goal.repoPath ?? this.deps.env.opsRepo;
        const group = triageGroups.get(home);
        if (group) group.push(goal); else triageGroups.set(home, [goal]);
      }
      for (const [home, group] of triageGroups) {
        if (running >= cfg.maxRunning) break;
        const result = await this.assign('gm', undefined, undefined, pick, spawnable,
          (inst, first, claim, worktree) => gmTriage(inst, group, this.deps.env, first, { comm: !!this.deps.sidecar, worktree, commDir: this.deps.sidecar?.commDirFor(inst.id) }), report, insts, false, undefined, slotMap, undefined, { home, project: group[0].project });
        if (!result) continue;
        for (const goal of group) await wf.recordDispatch(`goal:${goal.id}`, 0, 'triage', result.id);
        running++;
        busyBy.set(result.provider ?? '', (busyBy.get(result.provider ?? '') ?? 0) + 1);
        assigned.add(result.id);
        report.woke.push(...group.map(g => ({ task: `goal:${g.id}`, employee: result.id, spawned: result.spawned })));
      }
    }

    await this.sweep(now);

    // 5. Performance evaluation. Jev (System One decision model) scores the finished task in
    //    one ~500ms round trip; low-confidence or repeated failures escalate to an LLM eval
    //    employee, which stays the only path when Jev is not configured.
    if (cfg.evalEnabled) {
      const jevReady = this.deps.jev !== undefined && cfg.evalEngine !== 'llm';
      const llmCapable = cfg.evalEngine !== 'jev' && defs.some(d => d.role === 'eval' && d.enabled);
      for (const task of await wf.pendingEvaluations(3)) {
        // A recent eval dispatch (LLM or Jev in flight) pauses both engines for this task.
        const last = await wf.lastDispatch(task.id, task.version, 'eval');
        const dispatched = last && now - last.at < cfg.redispatchMinutes * 60;
        if (!dispatched && jevReady && task.evalAttempts < 3) {
          const outcome = await this.jevEvaluate(task, cfg, report);
          if (outcome === 'done') { report.evals.push(task.id); continue; }
          if (outcome === 'retry') continue;
        }
        // quick-tier work is small by definition: the Jev verdict (even low-confidence) is good
        // enough, and a whole LLM judge session costs more than the task did. eval_quick_llm
        // re-enables escalation for quick tasks.
        const llmReady = llmCapable && (cfg.evalQuickLlm || task.goalTier !== 'quick');
        if (!llmReady) {
          if (cfg.evalEngine === 'jev' || task.evalAttempts >= 3) {
            await this.notice(`eval-stuck:${task.id}`,
              `任务 ${task.id} 的绩效评审无法完成：${cfg.evalEngine === 'jev' ? 'eval_engine=jev 且 Jev 连续失败' : 'Jev 不可用/连续失败且没有启用的 eval 员工定义'}。检查 JEV_API_KEY 或改用 eval_engine=llm。`, report);
          }
          continue;
        }
        if (running >= cfg.maxRunning || dispatched) continue;
        const result = await this.assign('eval', undefined, last?.employee, pick, spawnable,
          (inst, first, claim, worktree) => evalPrompt(inst, task, this.deps.env, first, { comm: !!this.deps.sidecar, worktree, commDir: this.deps.sidecar?.commDirFor(inst.id) }), report, insts, false, undefined, slotMap, undefined, { task });
        if (result) {
          await wf.recordDispatch(task.id, task.version, 'eval', result.id);
          running++;
          busyBy.set(result.provider ?? '', (busyBy.get(result.provider ?? '') ?? 0) + 1);
          assigned.add(result.id);
          report.evals.push(task.id);
          report.woke.push({ task: task.id, employee: result.id, spawned: result.spawned });
        }
      }
    }
    return report;
  }

  /**
   * One Jev round trip scores every participant of a finished task.
   * Returns 'done' when scorecards were written, 'retry' to try again next tick,
   * 'escalate' to hand the task to the LLM eval role.
   */
  private async jevEvaluate(task: SupervisedTask, cfg: CompanyConfig, report: TickReport): Promise<'done' | 'retry' | 'escalate'> {
    const { workforce: wf, jev } = this.deps;
    if (!jev) return 'escalate';
    const attempts = await wf.bumpEvalAttempt(task.id);
    let parsed: JevScoreAnswers;
    try {
      const state = await wf.evalState(task.id);
      const questions = jevEvalQuestions(state.participants);
      const result = Object.keys(questions).length
        ? await jev.ask({
          task: { id: task.id, title: state.title, context: state.context, executorRole: state.executorRole, reviewerRole: state.reviewerRole },
          participants: state.participants,
          metrics: state.metrics,
          timeline: state.timeline,
        }, questions)
        : { model: jev.model, answers: {} };
      parsed = parseJevEval(state.participants, result.answers, cfg.jevFlagThreshold);
      const quickNoEscalate = task.goalTier === 'quick' && !cfg.evalQuickLlm;
      if (state.participants.length === 0 || parsed.minConfidence >= cfg.jevMinConfidence || cfg.evalEngine === 'jev' || quickNoEscalate) {
        const summary = `Jev 评审（${result.model}）：${parsed.topPerformer ? `本轮最佳 ${parsed.topPerformer}；` : ''}` +
          `${parsed.scores.map(s => `${s.employee} 综合 ${s.overall.toFixed(1)} 置信 ${s.confidence.toFixed(2)}`).join('；') || '无参与者'}` +
          (quickNoEscalate && parsed.minConfidence < cfg.jevMinConfidence ? '；置信度偏低，quick 目标按规则不升级 LLM 评审' : '');
        await wf.recordJevEvaluation(task.id, result.model, summary,
          parsed.scores.map(s => ({ ...s, flagged: parsed.flagged.includes(s.employee) })), state, parsed.topPerformer);
        for (const emp of parsed.flagged) {
          await this.notice(`eval-flag:${task.id}:${emp}`,
            `Jev 评审标记：任务 ${task.id} 中员工 ${emp} 的行为需要你关注（详见 scorecard）。`, report);
        }
        this.log(`jev evaluated ${task.id}: ${parsed.scores.length} scorecards, min confidence ${parsed.minConfidence.toFixed(2)}`);
        return 'done';
      }
      this.log(`jev low confidence on ${task.id} (${parsed.minConfidence.toFixed(2)} < ${cfg.jevMinConfidence}); escalating to eval employee`);
      return 'escalate';
    } catch (error) {
      this.log(`jev evaluation failed for ${task.id} (attempt ${attempts}): ${(error as Error).message}`);
      return attempts >= 3 ? 'escalate' : 'retry';
    }
  }

  /** Every 10 minutes: ownership reclaim (WT02) or legacy done-branch sweep. Dirty / protected trees stay with reasons. */
  private async sweep(now: number) {
    const { git, workforce: wf, env, reclaimWorktrees } = this.deps;
    if (now - this.lastSweep < 600) return;
    if (!reclaimWorktrees && !git) return;
    this.lastSweep = now;
    try {
      if (reclaimWorktrees) {
        const result = await reclaimWorktrees();
        for (const path of result.removed) this.log(`reclaimed worktree ${path} scan=${result.scanId}`);
        for (const kept of result.kept) {
          if (this.keptLogged.has(kept.path + kept.reason)) continue;
          this.keptLogged.add(kept.path + kept.reason);
          this.log(`kept worktree ${kept.path}: ${kept.reason}`);
        }
        for (const branch of result.branchesDeleted) this.log(`deleted merged branch ${branch}`);
        for (const retained of result.branchesRetained) this.log(`retained branch ${retained.branch}: ${retained.reason}`);
        return;
      }
      const result = await sweepWorktrees(git!, [env.opsRepo, ...(await wf.projectRepos())], await wf.doneTaskIds());
      for (const path of result.removed) this.log(`removed worktree ${path}`);
      for (const kept of result.kept) {
        if (this.keptLogged.has(kept.path)) continue;
        this.keptLogged.add(kept.path);
        this.log(`kept worktree ${kept.path}: ${kept.reason}`);
      }
    } catch (error) {
      this.log(`worktree sweep failed: ${(error as Error).message}`);
    }
  }

  private async jevDecisions(cfg: CompanyConfig, report: TickReport) {
    const { workforce: wf, owner } = this.deps;
    const jev = this.deps.jev!;
    const attempt = async (label: string, work: () => Promise<void>) => {
      try { await work(); } catch (error) { this.log(`jev ${label} failed: ${(error as Error).message}`); }
    };
    for (const goal of await owner.triagePending()) {
      // Once Jev was unsure and gm has been asked, gm owns the decision; do not re-ask Jev every tick.
      if (await wf.lastDispatch(`goal:${goal.id}`, 0, 'triage')) continue;
      await attempt(`triage ${goal.id}`, async () => {
        const { tier, confidence } = await jevTriage(jev, goal);
        if (!tier || confidence < cfg.jevMinConfidence) {
          this.log(`jev unsure about goal ${goal.id} (${tier ?? '?'} @${confidence.toFixed(2)}); leaving it to gm`);
          return;
        }
        await owner.triage(goal.id, tier, `jev（${jev.model}，置信度 ${confidence.toFixed(2)}）`);
        report.decisions.push(`triage:${goal.id}=${tier}`);
        this.log(`jev triaged goal ${goal.id} as ${tier} (${confidence.toFixed(2)})`);
      });
    }
    for (const task of await wf.tasks()) {
      if (task.kind === 'release' && task.state === 'review' && !task.currentEmployee && task.jevReleaseVersion !== task.version) {
        await attempt(`release ${task.id}`, async () => {
          const input = await wf.judgeInput(task.id);
          const { go, redLine } = await jevRelease(jev, input);
          const verdict = `Jev 上线判断（${jev.model}）：可以上线 ${go.toFixed(2)}，触碰红线 ${redLine.toFixed(2)}，阈值 ${cfg.jevReleaseThreshold}。`;
          if (go >= cfg.jevReleaseThreshold && redLine <= 1 - cfg.jevReleaseThreshold &&
            await wf.jevAccept(task.id, task.version, `${verdict}
结论：同意上线，工程可以合入并发布。`)) {
            report.decisions.push(`release:${task.id}`);
            this.log(`jev approved release ${task.id} (go ${go.toFixed(2)}, red line ${redLine.toFixed(2)})`);
          } else {
            await wf.jevAdvice(task.id, 'jev_release_version', task.version, `${verdict}
结论：Jev 不自动批准，由运营决定。`);
          }
        });
      }
      if (task.state === 'blocked' && task.blockedTo === 'owner' && !task.ownerRerouted && task.jevRouteVersion !== task.version) {
        await attempt(`route ${task.id}`, async () => {
          const input = await wf.judgeInput(task.id);
          const needs = await jevNeedsOwner(jev, input);
          const verdict = `Jev 升级路由（${jev.model}）：必须老板决定的概率 ${needs.toFixed(2)}，阈值 ${cfg.jevOwnerThreshold}。`;
          if (needs < cfg.jevOwnerThreshold && await wf.rerouteToGm(task.id, task.version,
            `${verdict}
这个问题不属于老板专属事项，改由经理决定。经理确实判断需要老板时，可让员工再次 report_blocker(to=owner)，不会再被改派。`)) {
            report.decisions.push(`reroute:${task.id}`);
            this.log(`jev rerouted owner question ${task.id} to gm (${needs.toFixed(2)})`);
          } else {
            await wf.jevAdvice(task.id, 'jev_route_version', task.version, `${verdict}
结论：保留给老板。`);
          }
        });
      }
    }
  }

  /** `auto:<family>` resolves through the plugin-maintained slot map; literal model ids pin. */
  private resolveModel(def: EmployeeDef, slots: Map<string, string>): string | undefined {
    const model = def.model ?? '';
    return model.startsWith('auto:') ? slots.get(`${def.provider}:${model.slice(5)}`) : model || undefined;
  }

  private available(h: ProviderHealth | undefined, now: number): 'ok' | 'probe' | 'down' {
    return availabilityOf(h, now);
  }

  /** A recovering provider gets a single probe session until a turn completes cleanly. */
  private capacity(provider: string, cfg: CompanyConfig, health: Map<string, ProviderHealth>, busyBy: Map<string, number>, now: number, quotaBlocked?: Map<string, string>): boolean {
    return providerCapacity(provider, cfg.providerMax, health, busyBy, now, quotaBlocked);
  }

  /** Record a task-side claim denial; keeps the map bounded to the cooldown horizon. */
  private markDenied(task: SupervisedTask): void {
    const now = Date.now();
    for (const [id, deny] of this.taskDeny) if (now - deny.at >= CLAIM_DENY_COOLDOWN_MS) this.taskDeny.delete(id);
    this.taskDeny.set(task.id, { at: now, version: task.version });
  }

  private async assign(
    role: string, task: SupervisedTask | undefined, avoid: string | undefined,
    pick: (role: string, task?: SupervisedTask, avoid?: string, excludeSubmitter?: boolean, recusal?: ReviewRecusal, anchorHome?: string) => EmployeeInst | undefined,
    spawnable: (role: string, home: string, task?: SupervisedTask) => EmployeeDef[],
    prompt: (inst: EmployeeInst, firstContact: boolean, claim?: ClaimResult, workspace?: WorktreeAssignment) => string,
    report: TickReport, insts: EmployeeInst[], forReview = false,
    prefer?: AssignPreference, slots?: Map<string, string>, recusal?: ReviewRecusal, anchor?: DispatchAnchor,
  ): Promise<(EmployeeInst & { spawned: boolean }) | undefined> {
    const { workforce: wf, paseo, env, sidecar } = this.deps;
    if (task && sidecar) {
      const deny = this.taskDeny.get(task.id);
      if (deny && deny.version === task.version && Date.now() - deny.at < CLAIM_DENY_COOLDOWN_MS) return undefined;
    }
    const preferred = prefer?.instId ? insts.find(i => i.id === prefer.instId && i.paseoAgentId) : undefined;
    const picked = prefer?.skipReuse ? undefined : preferred ?? pick(role, task ?? anchor?.task, avoid, forReview, recusal, anchor?.home);
    // A legacy credential-file session can't be sidecar-claimed for new work; let
    // it finish what it holds and fall through to spawning a comm-mode instance.
    const existing = picked && !(sidecar && task && picked.credentialFile) && (!sidecar || sidecar.canReuse(picked)) ? picked : undefined;
    if (existing) {
      const first = !this.onboarded.has(existing.id) && !existing.onboarded;
      let claim: ClaimResult | undefined;
      let workspace: WorktreeAssignment | undefined;
      try {
        if (sidecar && !task) workspace = await sidecar.readWorkspace?.(existing, anchor?.task?.id, anchor?.project);
        if (sidecar && task) {
          claim = await sidecar.claim(existing, task);
          if (!claim) {
            this.markDenied(task);
            this.log(`claim ${task.id} as ${existing.id} lost; skipping`);
            return undefined;
          }
        }
        // Home-bound insts park their session on a private comm dir outside any
        // task scene, so a worktree move is their normal case — wake, never
        // retire. The retire+respawn below only applies to legacy tree-bound
        // insts whose cwd still IS a worktree path.
        const instHome = sidecar?.commDirFor(existing.id);
        const sceneBound = !instHome || existing.cwd !== instHome;
        if ((claim?.worktree ?? workspace) && sceneBound && existing.cwd !== (claim?.worktree ?? workspace)!.worktreePath) {
          if (task) await sidecar!.releaseClaim(existing.id, task.id, '工作区路径变化，换新会话接管登记现场');
          else await sidecar?.releaseWorkspace?.(existing);
          claim = undefined;
          await wf.retire(existing.id, 'managed worktree workspace changed', 'rotation');
          await paseo.archive(existing.paseoAgentId!);
          sidecar!.detachAgent(existing.paseoAgentId!);
          report.retired.push(existing.id);
          const retiredAt = insts.indexOf(existing);
          if (retiredAt >= 0) insts.splice(retiredAt, 1);
          // Do not end the round here: fall through to the spawn path. A fresh
          // instance's claim re-resolves the same registered worktree, so its
          // spawn cwd matches by construction.
        } else {
          await paseo.send(existing.paseoAgentId!, prompt(existing, first, claim, workspace));
          this.onboarded.add(existing.id);
          this.lastStatus.set(existing.paseoAgentId!, 'running');
          await wf.touchWake(existing.id);
          this.log(`woke ${existing.id} for ${task?.id ?? `dispatch:${role}`}`);
          return { ...existing, spawned: false };
        }
      } catch (error) {
        this.log(`wake ${existing.id} failed: ${(error as Error).message}`);
        if (workspace) await sidecar?.releaseWorkspace?.(existing);
        if (claim && task) await sidecar!.releaseClaim(existing.id, task.id, `wake failed: ${(error as Error).message.slice(0, 120)}`);
        return undefined;
      }
    }
    const defsOrdered = spawnable(role, task?.repoPath ?? anchor?.task?.repoPath ?? anchor?.home ?? env.opsRepo, task);
    if (prefer?.defId) defsOrdered.sort((a, b) => Number(b.id === prefer.defId) - Number(a.id === prefer.defId));
    for (const def of defsOrdered) {
      const model = this.resolveModel(def, slots ?? new Map());
      if (!model) continue;
      const inst = await wf.spawnInst(def);
      const spawnEnv = sidecar ? sidecar.env(inst) : { SCK_EMPLOYEE_CREDENTIAL_FILE: wf.writeCredentialFile(inst, inst.credential!) };
      let claim: ClaimResult | undefined;
      let workspace: WorktreeAssignment | undefined;
      try {
        claim = sidecar && task ? await sidecar.claim(inst, task) : undefined;
        if (sidecar && !task) workspace = await sidecar.readWorkspace?.(inst, anchor?.task?.id, anchor?.project);
      }
      catch (error) {
        await wf.retire(inst.id, 'allocation unavailable', 'failure');
        sidecar?.detachAgent(inst.paseoAgentId ?? '');
        report.retired.push(inst.id);
        this.log(`allocation ${task?.id} waiting: ${(error as Error).message}`);
        return undefined;
      }
      if (sidecar && task && !claim) {
        this.markDenied(task);
        await wf.retire(inst.id, 'claim denied', 'failure');
        report.retired.push(inst.id);
        return undefined;
      }
      try {
        // Employee sessions must outlive their task scene: the agent cwd is the
        // instance's private comm dir, never a worktree path, so scene reclaim
        // archives only task workspaces. The task's registered tree is carried
        // in claim.json + the prompt instead. Legacy no-sidecar mode keeps the
        // tree-bound cwd it always had.
        const instHome = sidecar?.commDirFor(inst.id);
        const spawnCwd = instHome ?? (claim?.worktree ?? workspace)?.worktreePath ?? task?.repoPath ?? anchor?.task?.repoPath ?? anchor?.home ?? env.opsRepo;
        const agentId = await paseo.spawn({
          title: `SCK · ${def.role} · ${inst.id}`, provider: def.provider, model, thinking: def.thinking,
          mode: UNATTENDED_MODE[def.provider], cwd: spawnCwd, workspaceTitle: instHome ? `SCK · ${inst.id}` : `SCK · ${def.id}`,
          labels: { company: 'surreal-ck', employee_id: inst.id, role: def.role, def: def.id },
          env: spawnEnv,
          prompt: prompt(inst, true, claim, workspace),
        });
        const cwd = spawnCwd;
        const repoHome = task?.repoPath ?? anchor?.task?.repoPath ?? anchor?.home ?? env.opsRepo;
        await wf.bind(inst.id, { agentId, cwd, repoHome, model });
        sidecar?.bindAgent(inst.id, agentId);
        const bound = { ...inst, paseoAgentId: agentId, cwd, repoHome, model };
        insts.push(bound);
        this.onboarded.add(inst.id);
        this.lastStatus.set(agentId, 'running');
        await wf.touchWake(inst.id);
        this.log(`spawned ${inst.id} (${def.provider}/${model}${def.model?.startsWith('auto:') ? ` ← ${def.model}` : ''}) for ${task?.id ?? `dispatch:${role}`}`);
        return { ...bound, spawned: true };
      } catch (error) {
        const message = (error as Error).message;
        this.log(`spawn ${inst.id} failed: ${message}`);
        if (workspace) await sidecar?.releaseWorkspace?.(inst);
        if (claim) await sidecar!.releaseClaim(inst.id, task!.id, `spawn failed: ${message.slice(0, 120)}`);
        await wf.retire(inst.id, `spawn failed: ${message.slice(0, 200)}`, 'failure');
        report.retired.push(inst.id);
        // A quota-flavored spawn failure is the provider's problem, not the def's:
        // cool the provider down instead of eating a strike toward auto-disable.
        if (EXHAUSTED_PATTERN.test(message)) {
          await wf.markExhausted(def.provider, message);
          if (!report.exhausted.includes(def.provider)) report.exhausted.push(def.provider);
        } else {
          await this.countDefFailure(def, report);
        }
      }
    }
    return undefined;
  }

  /** Reads the host probe once; a broken probe fails open so a flaky stat can't deadlock dispatch. */
  private hostResources(): HostResources | undefined {
    if (!this.deps.hostResources) return undefined;
    try { return this.deps.hostResources(); }
    catch (error) { this.log(`host resources read failed: ${(error as Error).message}`); return undefined; }
  }

  private async revoke(task: SupervisedTask, reason: string, inst: EmployeeInst | undefined, report: TickReport, trigger: 'revoke' | 'expire' = 'revoke') {
    const cfg = await this.deps.workforce.config();
    const log = inst?.paseoAgentId ? await this.deps.paseo.logsTail(inst.paseoAgentId, LOG_TAIL_ENTRIES) : '';
    const handover = [
      '【交接包】前任员工未完成交接。以下是其会话最后的活动记录（自动截取，可能不完整）。',
      `前任会话：${inst?.id ?? task.currentEmployee}${inst?.paseoAgentId ? `（Paseo agentId ${inst.paseoAgentId}；完整时间线：paseo logs ${inst.paseoAgentId}）` : ''}`,
      '先核对任务分支/工作目录中的实际改动与已有 checkpoint，再继续；不要重复已完成且已验证的步骤。',
      log ? `\n---\n${log.slice(-cfg.handoverChars)}` : '（无可用会话日志）',
    ].join('\n');
    const holder = task.currentEmployee ?? inst?.id;
    if (await this.deps.workforce.revokeLease(task.id, task.currentEmployee!, reason, handover)) {
      report.revoked.push(task.id);
      // The sidecar may still hold a local claim whose heartbeat died first;
      // drop it or the instance stays un-claimable until the next restart.
      if (holder) this.deps.sidecar?.dropLease?.(holder, task.id);
      // Event point: a revoke/expire that released the scene's last reference reclaims it in
      // place; a recovery ref keeps the scene for the next holder. Never block the tick.
      const scene = task.row.worktree;
      if (scene) await this.deps.reclaimWorktrees?.({ trigger, treeId: scene.id, repo: scene.repo }).catch(() => undefined);
      this.log(`revoked ${task.id} from ${task.currentEmployee}: ${reason}`);
    }
  }

  private async retireBroken(inst: EmployeeInst, reason: string, defs: EmployeeDef[], report: TickReport, countFailure = true) {
    await this.deps.workforce.retire(inst.id, reason, 'failure');
    if (inst.paseoAgentId) this.deps.sidecar?.detachAgent(inst.paseoAgentId);
    // The dead session is useless and its red "error" entry confuses the roster —
    // archive it (soft-delete, timeline kept) like session rotation already does.
    if (inst.paseoAgentId) await this.deps.paseo.archive(inst.paseoAgentId).catch(() => undefined);
    await this.archiveInstScene(inst);
    report.retired.push(inst.id);
    this.log(`retired ${inst.id}: ${reason}`);
    const def = defs.find(d => d.id === inst.def);
    if (def && countFailure) await this.countDefFailure(def, report);
  }

  /**
   * Home-bound insts park a Paseo workspace on their private comm dir; retiring
   * must archive it or orphaned workspaces pile up in the Paseo roster.
   * Tree-bound insts leave their workspace to the scene cleaner instead.
   */
  private async archiveInstScene(inst: EmployeeInst) {
    const home = this.deps.sidecar?.commDirFor(inst.id);
    if (!home || inst.cwd !== home) return;
    const workspaces = await this.deps.paseo.listWorkspaces().catch(() => [] as PaseoWorkspaceInfo[]);
    for (const w of workspaces.filter(w => w.cwd === home)) {
      await this.deps.paseo.archiveWorkspace(w.workspaceId).catch(() => undefined);
    }
  }

  private async countDefFailure(def: EmployeeDef, report: TickReport) {
    const streak = await this.deps.workforce.defFailure(def.id);
    if (streak >= 3) {
      await this.deps.workforce.disableDef(def.id, `连续 ${streak} 次会话异常`);
      await this.notice(`def:${def.id}`, `员工定义 ${def.id}（${def.provider}/${def.model}）连续 ${streak} 次启动或运行异常，已自动停用。请检查该订阅/模型后在 employee_def 中重新启用。`, report);
    }
  }

  private async ownerNotices(tasks: SupervisedTask[], report: TickReport) {
    const { owner } = this.deps;
    const live = new Set<string>();
    for (const task of tasks) {
      if (task.state === 'review' && task.reviewerRole === 'owner') {
        const key = `gate:${task.id}:${task.version}`;
        live.add(key);
        await this.notice(key, `关口待你决定：${task.title}（任务 ${task.id}）。查看：company owner inbox`, report);
      } else if (task.state === 'blocked' && task.blockedTo === 'owner') {
        const key = `question:${task.id}:${task.version}`;
        live.add(key);
        await this.notice(key, `员工需要你回答：${task.title}（任务 ${task.id}）。查看：company owner inbox`, report);
      }
    }
    for (const notice of await owner.openNotices()) {
      if (/^(gate|question):/.test(notice.key) && !live.has(notice.key)) await owner.resolveNotice(notice.key);
    }
  }

  /** True when the task kept bouncing between employee and manager and was handed to the owner instead of waking the manager again. */
  private async breakLoop(task: SupervisedTask, cfg: CompanyConfig, report: TickReport,
      prefetched?: { loops: number; reasons: string[] }): Promise<boolean> {
    if (cfg.blockLoopLimit <= 0) return false;
    const { owner } = this.deps;
    const { loops, reasons } = prefetched ?? await owner.blockLoops(task.id);
    if (loops < cfg.blockLoopLimit || !(await owner.escalateLooping(task, loops, reasons))) return false;
    report.decisions.push(`escalate-loop:${task.id}`);
    this.log(`task ${task.id} blocked on manager ${loops} times; escalated to owner`);
    return true;
  }

  private lastAging = 0;
  private briefedOn = '';

  /** Re-raises gates and questions that have waited on the owner too long, with what they are holding up. */
  private async ownerAging(now: number, report: TickReport) {
    if (now - this.lastAging < 300) return;
    this.lastAging = now;
    const { owner } = this.deps;
    const live = new Set<string>();
    for (const item of await owner.waitingOnOwner()) {
      const hours = (now * 1000 - item.sinceMs) / 3_600_000;
      const level = agingLevel(hours);
      if (!level) continue;
      const key = `aging:${item.taskId}:${item.version}:${level}`;
      live.add(key);
      await this.notice(key, agingText(item, hours), report, { force: level >= 2 });
    }
    for (const notice of await owner.openNotices()) {
      if (notice.key.startsWith('aging:') && !live.has(notice.key)) await owner.resolveNotice(notice.key);
    }
  }

  /** One brief per local day, from the configured hour on; survives restarts via the stored notice key. */
  private async dailyBrief(now: number, cfg: CompanyConfig, report: TickReport) {
    if (cfg.ownerBriefHour < 0) return;
    const at = new Date(now * 1000);
    const date = localDate(at);
    if (at.getHours() < cfg.ownerBriefHour || this.briefedOn === date) return;
    const { owner } = this.deps;
    const key = `brief:${date}`;
    if (await owner.hasNotice(key)) { this.briefedOn = date; return; }
    const { workforce: wf } = this.deps;
    const quotaRows = await this.deps.quota?.().catch(() => [] as ProviderQuota[]) ?? [];
    const capacity = roleCapacity(await wf.defs(), quotaBlockedProviders(quotaRows, cfg, Date.now()), await wf.providerHealth(), now);
    const { summary, text } = renderBrief(await owner.briefData(now * 1000, date, capacity));
    await this.notice(key, text, report, { force: true, popup: summary });
    this.briefedOn = date;
    for (const notice of await owner.openNotices()) {
      if (notice.key.startsWith('brief:') && notice.key !== key) await owner.resolveNotice(notice.key);
    }
  }

  private async notice(key: string, text: string, report: TickReport, opts: { force?: boolean; popup?: string } = {}) {
    if (!(await this.deps.owner.raiseNotice(key, text))) return;
    report.notices.push(key);
    if (!this.deps.notify) return;
    // Jev triage: a calibrated noul decides whether this notice deserves an immediate
    // desktop popup; the notice always lands in the owner inbox regardless. Fail-open.
    const jev = this.deps.jev;
    if (jev && !opts.force) {
      try {
        const cfg = await this.deps.workforce.config();
        if (cfg.jevNotifyTriage) {
          const pending = (await this.deps.owner.openNotices()).length;
          const { answers } = await jev.ask(
            { notice: { key, text }, pendingInOwnerInbox: pending },
            { urgent: { type: 'noul', instructions: '这条公司系统提醒需要立即弹窗打扰老板吗？（充值、闸门决策、员工严重异常算紧急；常规状态汇报可等老板自己看收件箱）' } });
          const noul = answers.urgent;
          if (noul?.type === 'noul' && (noul.noul ?? 1) < 0.5) {
            this.log(`jev triaged notice ${key} as non-urgent (${noul.noul?.toFixed(2)})`);
            return;
          }
        }
      } catch { /* fail-open: still popup */ }
    }
    await this.deps.notify('Surreal CK 公司', opts.popup ?? text).catch(() => undefined);
  }
}
