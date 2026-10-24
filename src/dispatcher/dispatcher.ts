import { FACTORY_PROVIDER, factoryFirst } from './provider-order.ts';
import { managedModel } from "../model-routing/policy.ts";
import type { OwnerDesk } from '../owner.ts';
import type { CompanyConfig, EmployeeDef, EmployeeInst, ManagerActionRow, ManagerWakeClaim, ManagerWakeRow, ProviderHealth, SupervisedTask, Workforce } from '../workforce.ts';
import { effectiveWeight, MANAGER_WAKE_PENDING_GRACE_SECONDS, MANAGER_WAKE_TURN_GRACE_SECONDS, managerWakeKey, weightedOrder } from '../workforce.ts';
import type { ClaimResult, WorktreeAssignment, ModelSlots, ProviderQuota, RetirementKind, Role, WriteScopeHolder } from '../contracts.ts';
import { REQUIRED_TRACKS } from '../core.ts';
import { UNATTENDED_MODE, type PaseoGateway, type PaseoWorkspaceInfo } from './paseo.ts';
import { evalPrompt, gmAttention, gmTriage, wake, type GmTodo, type PromptEnv } from './prompts.ts';
import { sweepWorktrees, type GitGateway } from './worktrees.ts';
import { agingLevel, agingText, localDate, renderBrief, type RoleCapacity } from '../owner-brief.ts';
import type { ReclaimResult } from './worktree-registry.ts';
import type { ReclaimTrigger } from './worktree-reclaim.ts';
import { jevNeedsOwner, jevRelease, jevTriage } from './decisions.ts';
import { jevEvalQuestions, parseJevEval, type JevClient, type JevScoreAnswers } from './jev.ts';
import { reclaimIdleSessions } from './idle-sessions.ts';
import { memoryBlocked, type HostResources } from './host.ts';
import type { ArtifactTrigger } from './artifact-reclaim.ts';
import type { ArtifactReclaimResult } from './artifact-sweeper.ts';
import { summarizeReclaim } from './artifact-sweeper.ts';
import { executeGate } from '../contributors.ts';
import { isRetireRefused } from '../retirement.ts';
import { independenceHit, independenceText, type IndependenceScope } from '../independence.ts';
import { BLOCK_TEXT, dispatchNoticeText, evaluateDispatch, globalBlock, holderLabel, managerActionKey, repoName, reviewPlanOf, type BlockCode, type DispatchPhase, type DispatchVerdict, type EvaluatedEntry, type GlobalBlock, type WorkflowState } from './dispatch-blocked.ts';
export type { BlockCode, DispatchPhase, DispatchVerdict } from './dispatch-blocked.ts';

/**
 * Weight factor for a prior hand of a review task (SYS-DISP IR01): they claimed execute but never wrote code with
 * decisive evidence, so their review is still independent and eligible — at a demoted weight, exactly the pre-SYS-DISP
 * rule. Only a strict independence source excludes them outright (see independence.ts).
 */
export const PRIOR_HAND_WEIGHT_FACTOR = 0.15;

/**
 * Deterministic order for an all-managed pool: the least recently woken instance first. A prior hand goes last, the same demotion
 * the weighted pick applies — never out of the pool, just after every fresh session. A session without a recorded wake sorts last:
 * nothing says it is the stalest. The caller passes `hands` for a review only; the execute path has no recusal set.
 */
export function managedRecencyOrder<T extends { id: string; lastWakeAt?: number }>(items: readonly T[], hands?: ReadonlySet<string>): T[] {
  return [...items].sort((a, b) =>
    Number(hands?.has(a.id) ?? false) - Number(hands?.has(b.id) ?? false) ||
    (a.lastWakeAt ?? Number.MAX_SAFE_INTEGER) - (b.lastWakeAt ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id));
}

/** Provider error text that means the subscription is out of budget or rate limited, not that the session is broken. */
export const EXHAUSTED_PATTERN = /usage cap reached|out of credits|add credits|credit balance|usage balance|balance exhausted|payment required|quota|usage limit|rate.?limit|too many requests|\b402\b|\b429\b|limit reached|insufficient|billing|exceeded your|try again (in|later)|model_usage_exhausted|usage_exhausted|credits exhausted|out of usage|at capacity/i;
const LEASE_SECONDS = 600;
const LOG_TAIL_ENTRIES = 60;
// Task-level cooldown after a claim denial; a version bump re-arms the task.
const CLAIM_DENY_COOLDOWN_MS = 5 * 60_000;
/** A failed in-place reload is retried on this interval, not on every poll. */
const RELOAD_RETRY_SECONDS = 300;
/** Two or more consecutive quota failures on a bound implementer, or an unknown reset, is persistent: a manager decision. */
const PERSISTENT_QUOTA_FAILURES = 2;
/** Pass-wide capacity gates and unknown state are not evidence that a manager todo is resolved. */
const GLOBAL_KEEP = new Set<BlockCode>(['paused', 'budget', 'resources', 'max_running', 'unknown']);
/** SYS03 AC04: holder notices delivered per pass, so a long backlog cannot turn one tick into hundreds of sends. */
const HOLDER_NOTICE_BATCH = 20;

/**
 * SYS03 AC04: the text a holder receives. Self-contained (task, episode, this attempt) and it points at the tool that
 * reads the newest decision, because the holder's own snapshot may predate it — the reminder itself is never the
 * authority on what happened to the episode.
 */
const holderNoticeText = (notice: { taskId: string; episode: string; kind: string; text: string; deliveries: number }): string =>
  `【公司通知·${notice.kind}】${notice.text}\n`
  + `任务 ${notice.taskId}，episode ${notice.episode}；这是第 ${notice.deliveries + 1} 次投递。\n`
  + `你手上的状态可能已经过时：先用 sck call disposition_status '{"taskId":"${notice.taskId}"}' 读这个任务最新的处置与决定，`
  + `按最新决定行事，不要基于旧提醒重复动作。`;

/** `unknown`: the roster or pool has no observation for the session. It is never shown or treated as busy. */
export type InstState = 'busy' | 'idle' | 'down' | 'exhausted' | 'unknown';

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
export function roleCapacity(defs: ReadonlyArray<Pick<EmployeeDef, 'role' | 'provider' | 'enabled' | 'quotaLimited'>>, quotaBlocked: ReadonlyMap<string, string>, health: ReadonlyMap<string, ProviderHealth>, now: number): RoleCapacity[] {
  const roles = new Map<string, RoleCapacity>();
  for (const def of defs.filter(d => d.enabled)) {
    const entry = roles.get(def.role) ?? { role: def.role, total: 0, usable: 0, down: [] };
    roles.set(def.role, entry); entry.total++;
    const h = health.get(def.provider);
    // A def exempt from quota gating keeps its seat usable even while the subscription is out.
    const why = def.quotaLimited === false ? undefined
      : quotaBlocked.get(def.provider) ?? (availabilityOf(h, now) === 'down' ? `额度耗尽或异常${h?.lastError ? `：${h.lastError.slice(0, 40)}` : ''}` : undefined);
    if (!why) entry.usable++;
    else if (!entry.down.some(d => d.startsWith(def.provider))) entry.down.push(`${def.provider} ${why}`);
  }
  return [...roles.values()].sort((a, b) => a.usable - b.usable || a.role.localeCompare(b.role));
}

/** Provider seat check: quota floor, health window, and the per-provider concurrency cap. */
export function providerCapacity(provider: string, providerMax: Record<string, number>, health: ReadonlyMap<string, ProviderHealth>, busyBy: ReadonlyMap<string, number>, now: number, quotaBlocked?: ReadonlyMap<string, string>, quotaExempt = false): boolean {
  const busy = busyBy.get(provider) ?? 0;
  // An exempt def opts out of the quota/health gates but never out of the seat cap: seats are
  // physical, and unbounded concurrency would starve every other def on the same provider.
  if (quotaExempt) return busy < (providerMax[provider] ?? 1);
  if (quotaBlocked?.has(provider)) return false;
  const availability = availabilityOf(health.get(provider), now);
  if (availability === 'down') return false;
  return availability === 'probe' ? busy === 0 : busy < (providerMax[provider] ?? 1);
}

/**
 * Execute gate: the bound implementer, or `unresolved` when several authors or several claim-only handlers leave no single
 * one (SYS-DISP IR01/Q1). `unknown` means the authorship history could not be read: every candidate waits as unknown
 * (never busy) until the history reads again.
 */
export interface ExecuteGate { implementer?: string; unresolved: boolean; unknown?: boolean }

/** The gate for a task whose authorship history is unreadable: nobody is chosen and nobody is treated as busy. */
const UNKNOWN_EXECUTE_GATE: ExecuteGate = { unresolved: true, unknown: true };

/**
 * The execute gate one pool read carries. Only the task's own executor role, outside review, is gated: a reviewer, or a
 * manager pool anchored on an engineering task, is not an execute pool and never sees the implementer gate.
 */
export function executeGateFor(gates: ReadonlyMap<string, ExecuteGate>, role: string,
  task?: Pick<SupervisedTask, 'id' | 'executorRole'>, excludeSubmitter = false): ExecuteGate | undefined {
  return task && !excludeSubmitter && role === task.executorRole ? gates.get(task.id) : undefined;
}

/** A candidate's block: its stable code, the owner-facing text, and the recovery time (ISO 8601) when one is provable. */
type Block = [BlockCode, string, string?];
/** A dispatch-blocked episode becomes an owner notice after this long, or at once when no candidate can ever qualify. */
const BLOCK_NOTICE_MS = 5 * 60_000;

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
  /** Machine code for `reason`; the dispatch-blocked evaluator groups and escalates by it. */
  code?: BlockCode;
  /** Recovery time of a quota block, ISO 8601. Absent when no time can be proven. */
  until?: string;
  /** Owner-facing annotation that does not block eligibility (for example a demoted prior hand). */
  note?: string;
}

export interface StaffingInput {
  role: string;
  home: string;
  task?: SupervisedTask;
  /** Review work never goes to the submitter. */
  excludeSubmitter?: boolean;
  /**
   * Review recusal, only passed for review dispatch: a hard independence exclusion of every author
   * (submitted or executed this task) and the implementer. Nobody accepts their own delivery.
   */
  recusal?: ReviewRecusal;
  /**
   * Execute gate, only passed for execute dispatch: code work goes to the bound implementer alone.
   * A fresh task (no implementer, not ambiguous) has no gate; the first claimant becomes the implementer.
   */
  implementer?: ExecuteGate;
  /**
   * Independence scope of this task at this stage (SYS-DISP IR02): the registered identities it excludes, or unverifiable when the
   * source history cannot be read. Excluded candidates are never eligible, whatever their continuity, weight or fallback.
   */
  independence?: IndependenceScope;
  /**
   * Tasks whose effective policy contract no longer authorizes them (SYS06 AC02/RB01), keyed by task id: the reason string.
   * Read once per pass from the same source the claim gate and the ops broker read. A task here is held back for every
   * candidate — this is never a per-candidate judgement, and no candidate is ever reported as merely busy for it.
   */
  policyBlocks?: ReadonlyMap<string, string>;
  defs: EmployeeDef[];
  insts: EmployeeInst[];
  states: ReadonlyMap<string, InstState>;
  holding: ReadonlySet<string>;
  assigned?: ReadonlySet<string>;
  /**
   * Entry keys held back by review capacity (R1): an instance id, or `spawn:<defId>`. Logical only: nothing is leased,
   * and the execute pool of this task never picks them.
   */
  reserved?: ReadonlySet<string>;
  health: ReadonlyMap<string, ProviderHealth>;
  quotaBlocked: ReadonlyMap<string, string>;
  busyBy: ReadonlyMap<string, number>;
  providerMax: Record<string, number>;
  slots: ReadonlyMap<string, string>;
  /**
   * instId → the model the session is actually serving (Paseo's `ls -g`). Absent for a session
   * nobody observed: the pool then falls back to `inst.model`, which is only what the spawn asked
   * for and cannot see a model the provider switched under us.
   */
  runtimeModels?: ReadonlyMap<string, string>;
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
  /**
   * A provider in quota or health cooldown: the percent floor (no provable recovery time), or the health cooldown, which
   * ends at its recorded `until` (server seconds). Quota, never concurrency-full.
   */
  const quotaOf = (provider: string, exempt = false): Block | undefined => {
    if (exempt) return undefined;
    const floor = p.quotaBlocked.get(provider);
    if (floor) return ['quota', floor];
    const health = p.health.get(provider);
    if (availabilityOf(health, p.now) !== 'down') return undefined;
    const until = new Date((health?.until ?? 0) * 1000).toISOString();
    return ['quota', `${BLOCK_TEXT.quota}，恢复时间 ${until}`, until];
  };
  /** A session that is not ready: unknown, quota-exhausted, or busy/abnormal. Each one is a different owner action. */
  const notReady = (state: InstState | undefined, provider: string): Block => {
    if (state === undefined || state === 'unknown') return ['unknown', BLOCK_TEXT.unknown];
    if (state === 'exhausted') return quotaOf(provider) ?? ['quota', `${BLOCK_TEXT.quota}，恢复时间未知`];
    return ['session_busy', BLOCK_TEXT.session_busy];
  };
  const currentModel = (inst: EmployeeInst): boolean => {
    const def = p.defs.find(d => d.id === inst.def);
    if(managedModel(def))return true; // request routing is task-scoped at the company gateway
    const target = def && resolveSlot(def);
    // What the provider serves wins over what the spawn asked for: a subscription can switch the
    // model under a live session, and dispatching into it would run work on a model nobody chose.
    // Unknown is unknown — neither "fine" nor "drifted" without evidence.
    const served = p.runtimeModels?.get(inst.id) ?? inst.model;
    return !target || !served || served === target;
  };
  const cap = (provider: string, exempt = false) => providerCapacity(provider, p.providerMax, p.health, p.busyBy, p.now, p.quotaBlocked, exempt);
  /**
   * Quota, probe and full concurrency are separate codes: owners act on them differently. A passed cooldown admits one trial
   * session; while it runs, the rest wait as probe_busy, which never carries a recovery time.
   */
  const capHit = (provider: string, exempt = false, managed = false): Block | undefined => {
    if (managed) return undefined; // Magpie owns model/account capacity; maxRunning guards the Mac.
    if (!exempt) {
      const quota = quotaOf(provider);
      if (quota) return quota;
      if (availabilityOf(p.health.get(provider), p.now) === 'probe') {
        return (p.busyBy.get(provider) ?? 0) === 0 ? undefined : ['probe_busy', BLOCK_TEXT.probe_busy];
      }
    }
    return cap(provider, exempt) ? undefined : ['provider_capacity', BLOCK_TEXT.provider_capacity];
  };
  /**
   * Execute gate (engineering code work): only the bound implementer may take the task. An unreadable history and an
   * unresolved pool block everyone; a spawn is never the implementer (it is a new employee id), so spawns carry the same block.
   */
  const gate = (id: string | undefined): Block | undefined => {
    const until=p.task?.row?.model_route_until;
    const routing:Block|undefined=until&&until>p.now?['quota','模型组暂不可用，等待通道恢复',new Date(until*1000).toISOString()]:undefined;
    if (!p.implementer) return routing;
    if (p.implementer.unknown) return ['unknown', BLOCK_TEXT.unknown];
    if (p.implementer.unresolved) return ['implementer_unresolved', BLOCK_TEXT.implementer_unresolved];
    if (p.implementer.implementer && id !== p.implementer.implementer) return ['implementer_mismatch', BLOCK_TEXT.implementer_mismatch];
    return routing;
  };
  // Independence (SYS-DISP IR02): an excluded identity never takes the task — the employeeId itself, or the registered principal it
  // shares with an excluded one — and a scope that cannot be read blocks every candidate as unknown. A definition is not an
  // identity: a spawn of the same def is a new, independent employee.
  const independenceBlock = (employee: string | undefined, principal: string | undefined): Block | undefined => {
    const scope = p.independence;
    if (!scope) return undefined;
    if (scope.kind === 'unverifiable') {
      // A named source says whose history cannot be read: the candidate is unknown, never clear and never busy.
      return ['unknown', scope.source === undefined ? BLOCK_TEXT.unknown
        : `来源任务 ${scope.source} 的贡献者历史读取失败或不存在，不能判定独立性（不视为忙），恢复后自动重判`];
    }
    const hit = independenceHit(scope.index, employee, principal);
    return hit ? ['independence_conflict', independenceText(hit)] : undefined;
  };
  // Effective policy contract (SYS06 AC02/RB01): a task whose contract no longer authorizes it is held back for the whole pool,
  // before any per-candidate gate, so no candidate is reported as busy and no spawn is offered for it.
  const policyBlock: Block | undefined = (() => {
    const reason = p.task ? p.policyBlocks?.get(p.task.id) : undefined;
    return reason ? ['policy_blocked', reason] : undefined;
  })();
  // Track gating: a task with discipline X only routes to defs whose tracks list covers X.
  const trackOk = (task: SupervisedTask | undefined, tracks: string[] | undefined) =>
    trackOkFor(p.role as Role, task, tracks);
  const entries: StaffingEntry[] = [];
  for (const inst of p.insts) {
    if (inst.role !== p.role) continue;
    if ((inst.repoHome ?? inst.cwd ?? p.opsRepo) !== p.home) continue;
    const def = p.defs.find(d => d.id === inst.def);
    // Recusal and the execute gate come first: a candidate that can never take the task must not be reported as merely busy.
    const hit: Block | undefined =
      policyBlock ??
      gate(inst.id) ??
      independenceBlock(inst.id, inst.principal) ??
      (p.recusal?.authors.has(inst.id) ? ['author_recusal', BLOCK_TEXT.author_recusal] : undefined) ??
      (p.excludeSubmitter && inst.id === p.task?.submittedBy ? ['author_recusal', BLOCK_TEXT.author_recusal] : undefined) ??
      (p.reserved?.has(inst.id) ? ['review_capacity', BLOCK_TEXT.review_capacity] : undefined) ??
      ((inst.def && !def) || (def && !def.enabled) ? ['def_disabled', BLOCK_TEXT.def_disabled] : undefined) ??
      (!ready(inst) ? notReady(p.states.get(inst.id), inst.provider ?? '') : undefined) ??
      (p.assigned?.has(inst.id) ? ['assigned', BLOCK_TEXT.assigned] : undefined) ??
      (p.holding.has(inst.id) ? ['held', BLOCK_TEXT.held] : undefined) ??
      (p.sidecar && inst.credentialFile ? ['credential_file', BLOCK_TEXT.credential_file] : undefined) ??
      (!trackOk(p.task, def?.tracks) ? ['track_mismatch', BLOCK_TEXT.track_mismatch] : undefined) ??
      (!currentModel(inst) ? ['model_slot', BLOCK_TEXT.model_slot] : undefined) ??
      capHit(inst.provider ?? '', def?.quotaLimited === false, managedModel(def));
    // A prior hand (claim-only, never wrote code) stays eligible at a demoted weight: the pre-SYS-DISP review rule,
    // kept for ordinary tasks. A strict independence source still excludes them (independenceBlock above).
    const priorHand = !hit && (p.recusal?.hands.has(inst.id) ?? false);
    entries.push({ kind: 'reuse', key: inst.id, ref: inst.id, role: p.role,
      provider: inst.provider ?? '', model: inst.model ?? def?.model, def, inst,
      weight: (managedModel(def) ? 1 : effectiveWeight(def)) * (priorHand ? PRIOR_HAND_WEIGHT_FACTOR : 1),
      share: 0, eligible: !hit, reason: hit?.[1], code: hit?.[0], until: hit?.[2],
      note: priorHand ? '经手过本任务（未写码），降权兜底' : undefined });
  }
  for (const def of p.defs) {
    if (def.role !== p.role) continue;
    const resolved = resolveSlot(def);
    const seats = p.insts.filter(i => i.def === def.id && (i.repoHome ?? i.cwd ?? p.opsRepo) === p.home && !(p.sidecar && i.credentialFile)).length;
    const hit: Block | undefined =
      policyBlock ??
      gate(undefined) ??
      independenceBlock(undefined, undefined) ??
      (p.reserved?.has(`spawn:${def.id}`) ? ['review_capacity', BLOCK_TEXT.review_capacity] : undefined) ??
      (!def.enabled ? ['def_disabled', BLOCK_TEXT.def_disabled] : undefined) ??
      (!trackOk(p.task, def.tracks) ? ['track_mismatch', BLOCK_TEXT.track_mismatch] : undefined) ??
      (resolved === undefined ? ['model_slot', BLOCK_TEXT.model_slot] : undefined) ??
      (seats >= def.maxInstances ? ['seat_full', `编制席位已满（${seats}/${def.maxInstances} 个实例，仓库 ${repoName(p.home)}）`] : undefined) ??
      capHit(def.provider, def.quotaLimited === false, managedModel(def));
    entries.push({ kind: 'spawn', key: `spawn:${def.id}`, ref: def.id, role: p.role,
      provider: def.provider, model: resolved ?? def.model, def,
      weight: managedModel(def) ? 1 : effectiveWeight(def), share: 0, eligible: !hit, reason: hit?.[1], code: hit?.[0], until: hit?.[2] });
  }
  const total = entries.filter(e => e.eligible).reduce((s, e) => s + Math.max(0, e.weight), 0);
  for (const e of entries) e.share = e.eligible && total > 0 ? Math.max(0, e.weight) / total : 0;
  return entries;
}

/**
 * Same-role employees whose repository is not `home`. The pool never reads them (a hard repository filter, SYS-DISP R3), so a
 * verdict only states how many it left out.
 */
export function otherRepoCount(insts: readonly EmployeeInst[], role: string, home: string, opsRepo: string): number {
  return insts.filter(inst => inst.role === role && (inst.repoHome ?? inst.cwd ?? opsRepo) !== home).length;
}

/**
 * Review recusal (SYS-DISP IR01): hard exclusion for authors and the implementer — nobody accepts their own
 * delivery — and a demoted weight for `hands`, who held an execute lease but never wrote code. Reviewing,
 * returning or accepting never makes someone an author (contributors.ts).
 */
export interface ReviewRecusal {
  /** Submitted (or is the implementer, or an unknown-phase row): never reviews this task. */
  authors: ReadonlySet<string>;
  /** Claimed execute but never submitted: eligible at PRIOR_HAND_WEIGHT_FACTOR. */
  hands: ReadonlySet<string>;
}

/** Shared audit-based recusal lookup. Unknown history must never become an empty set. */
export async function readReviewRecusal(
  workforce: Pick<Workforce, 'contributors'>, task: SupervisedTask,
  log: (message: string) => void = () => {},
): Promise<ReviewRecusal | undefined> {
  try {
    const facts = await workforce.contributors(task.id);
    return { authors: new Set(facts.excluded), hands: new Set(facts.hands) };
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
  /**
   * ready: a candidate can take the review now. blocked: no candidate qualifies, and entries say why (zero candidates are never
   * ready). history_unavailable: the author history could not be read, so every candidate reads as unknown.
   */
  status: 'ready' | 'blocked' | 'history_unavailable';
  entries: StaffingEntry[];
}

/** Task-scoped estimate; the public role/home pool stays independent of review recusal. */
export async function reviewStaffingPreviews(
  tasks: readonly SupervisedTask[],
  base: Omit<StaffingInput, 'role' | 'home' | 'task' | 'excludeSubmitter' | 'recusal' | 'independence'>,
  workforce: Pick<Workforce, 'contributors' | 'independenceScope'>,
): Promise<ReviewStaffingPreview[]> {
  const previews: ReviewStaffingPreview[] = [];
  for (const task of tasks.filter(t => t.state === 'review' && t.reviewerRole !== 'owner' && !t.currentEmployee)) {
    const recusal = await readReviewRecusal(workforce, task);
    const home = task.repoPath ?? base.opsRepo;
    const independence = task.independence ? await workforce.independenceScope(task.independence, 'review') : undefined;
    const entries = staffingPool({ ...base, role: task.reviewerRole, home, task,
      excludeSubmitter: true, recusal, independence });
    previews.push({ taskId: task.id, title: task.title, purpose: 'review', role: task.reviewerRole, home,
      status: recusal === undefined || independence?.kind === 'unverifiable' ? 'history_unavailable'
        : entries.some(entry => entry.eligible) ? 'ready' : 'blocked',
      entries: recusal === undefined
        ? entries.map(e => ({ ...e, eligible: false, share: 0, code: 'unknown' as const, reason: BLOCK_TEXT.unknown }))
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
  /**
   * Rewrites a live session's model to the one its definition asks for. A provider may switch the
   * model under a running subscription (Factory falls back to a cheaper model once the standard
   * allowance is spent); the session keeps its conversation and is never retired for that. Returns
   * true when the session now serves `model`. Undefined disables realignment: drift is then left
   * alone rather than turned into a retirement.
   */
  realignAgent?: (agentId: string, model: string) => Promise<boolean>;
  /**
   * System-initiated implementer replacement: hands an execute-phase engineering task to a live engineer when the bound
   * implementer's session is gone for good (the employee left, or the session is archived, quarantined, or parked in a
   * failure that cannot be restarted, or its repo no longer matches an explicit code-repo rebind). Returns true when the binding moved. Undefined disables the automatic successor:
   * the block then names the manager's takeover instead.
   */
  autoTakeover?: (input: { taskId: string; toEmployee: string; expectedVersion: number; reason: string }) => Promise<boolean>;
  /**
   * Terminal-task artifact reclaim (evidence/deliverables lifecycle). Bare call = periodic
   * normal-mode sweep; `{ targetFreeMb }` = pressure mode, oldest terminal work first until
   * the real free-disk probe reaches the target. Undefined disables artifact reclaim.
   */
  reclaimArtifacts?: (input?: { trigger?: ArtifactTrigger; targetFreeMb?: number; dryRun?: boolean; taskId?: string; emergency?: boolean }) =>
    Promise<ArtifactReclaimResult>;
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
  /** Write-scope preflight of the task's execute claim: the holders that would refuse it now, empty when none. Rejects when unreadable. */
  writeScope(task: SupervisedTask, employeeId?: string): Promise<WriteScopeHolder[]>;
  /** Why the last claim of this instance was denied (for example worktree_busy), until its next claim. */
  claimDenial(instId: string): string | undefined;
  /** Records the freshly spawned Paseo agentId for this instance. */
  readWorkspace?(inst: EmployeeInst, taskId?: string, project?: string): Promise<WorktreeAssignment | undefined>;
  releaseWorkspace?(inst: EmployeeInst): Promise<void>;
  bindAgent(instId: string, agentId: string): void;
  /** Absolute path of the instance's comm dir, for prompts (agents must not resolve env vars). */
  commDirFor(instId: string): string;
  /** Absolute path of the instance's scratch dir (temp clones/builds); spawn env alone is lost on resume. */
  scratchDirFor(instId: string): string;
  /** A spawn that succeeded but whose pre-claim is now orphaned. */
  releaseClaim(instId: string, taskId: string, reason: string): Promise<void>;
  /** Server-side lease was revoked: drop the local claim remnant so the instance can pick again. */
  dropLease?(instId: string, taskId?: string): void;
}

/** Jev-chosen override for one dispatch: force an existing instance, or skip reuse and spawn a chosen def. */

/**
 * Workspace anchor for task-less management dispatches (gm-attention, triage, eval).
 * `task` anchors by task identity: its repoPath picks the candidate home and its id
 * drives readWorkspace project resolution. `home`+`project` anchor a goal directly
 * when no task exists yet (triage): `home` is the resolved repo the candidate pool,
 * spawn cwd and repoHome bind to, `project` is the project id readWorkspace resolves.
 */
interface DispatchAnchor { task?: SupervisedTask; home?: string; project?: string }
/** Optional hooks around the only external Paseo actions (send/spawn), used by the manager-wake CAS. */
interface AssignHooks {
  beforeExternal?: (inst: EmployeeInst, kind: 'send' | 'spawn') => Promise<void> | void;
  afterExternal?: (inst: EmployeeInst, kind: 'send' | 'spawn', agentId: string) => Promise<void> | void;
}

/** One live session as the latest pass saw it: the raw Paseo status and the state the tick acted on. */
export interface ObservedSession { agentId?: string; status: string; state: InstState }
export interface SessionSnapshot { at: number; sessions: ReadonlyMap<string, ObservedSession> }

/** One ready work item as the pass saw it. `readySince` is unix milliseconds, absent when no audit row says when it became ready. */
export interface ReadyItem { taskId: string; title: string; role: string; discipline?: string; readySince?: number }

/**
 * The owner's view of one pass (SYS-DISP R4). Verdicts, pools, review previews and the ready queue are read from the pass that
 * produced them, so the roster, the pulse and the daily brief agree with the dispatch decisions and with each other. `at` is the
 * instant the snapshot was taken (unix milliseconds; 0 before the first pass).
 */
export interface DispatchSnapshot {
  at: number;
  verdicts: DispatchVerdict[];
  pools: Array<{ role: string; home: string; entries: StaffingEntry[] }>;
  reviewPools: ReviewStaffingPreview[];
  ready: ReadyItem[];
}

const emptySnapshot = (): DispatchSnapshot => ({ at: 0, verdicts: [], pools: [], reviewPools: [], ready: [] });

/** What a pass read before it decided. The snapshot is taken from these at the end of the tick, so every view shares them. */
export interface PassInputs {
  now: number;
  cfg: CompanyConfig;
  defs: EmployeeDef[];
  insts: EmployeeInst[];
  states: Map<string, InstState>;
  health: Map<string, ProviderHealth>;
  quotaBlocked: Map<string, string>;
  tasks: SupervisedTask[];
  slots: Map<string, string>;
  /** instId → served model, from the same `paseo.list()` read the pass used. */
  runtimeModels?: Map<string, string>;
  /** taskId → why the effective policy contract no longer authorizes it, read once in this pass (SYS06 AC02/RB01). */
  policyBlocks?: Map<string, string>;
}

export interface TickReport {
  commands: number;
  revoked: string[];
  extended: string[];
  woke: Array<{ task: string; employee: string; spawned: boolean }>;
  retired: string[];
  /** Instances whose retirement the shared gate refused this tick (SYS-DISP R1): nothing was written for them; see the log. */
  refused?: string[];
  exhausted: string[];
  notices: string[];
  evals: string[];
  /** Jev decisions taken this tick, e.g. "triage:<goal>=quick", "release:<task>", "reroute:<task>". */
  decisions: string[];
  /** Terminal-task artifacts trimmed this tick (see report.skipped === 'resources'). */
  reclaimed?: { tasks: number; files: number; freedBytes: number; trigger: ArtifactTrigger; pressure: boolean };
  /** Sessions put back on their definition's model this tick (provider drift, or the def moved on). */
  realigned?: string[];
  /** Sessions restarted in place after their provider's quota window reopened (see PaseoGateway.reload). */
  recovered?: string[];
  skipped?: 'paused' | 'budget' | 'resources';
}

/**
 * The snapshot of one pass (SYS-DISP R4): staffing pools, review previews and the ready queue, evaluated from the inputs that pass
 * read and the verdicts it recorded. The tick builds it at the end of every pass; tests build it from their own inputs, so the
 * owner-facing answers are measured against the same function the tick uses.
 */
export async function snapshotOf(p: PassInputs, opts: { opsRepo: string; sidecar: boolean; log?: (message: string) => void },
  verdicts: DispatchVerdict[], wf: Pick<Workforce, 'contributors' | 'readySince' | 'independenceScope'>, at = Date.now()): Promise<DispatchSnapshot> {
  const busyBy = new Map<string, number>();
  for (const inst of p.insts) {
    if (p.states.get(inst.id) !== 'busy') continue;
    busyBy.set(inst.provider ?? '', (busyBy.get(inst.provider ?? '') ?? 0) + 1);
  }
  const holding = new Set(p.tasks.filter(t => t.currentEmployee).map(t => t.currentEmployee!));
  const poolBase = { defs: p.defs, insts: p.insts, states: p.states, holding, health: p.health, quotaBlocked: p.quotaBlocked,
    busyBy, providerMax: p.cfg.providerMax, slots: p.slots, runtimeModels: p.runtimeModels, policyBlocks: p.policyBlocks,
    opsRepo: opts.opsRepo, sidecar: opts.sidecar, now: p.now };
  const homes = [...new Set([opts.opsRepo, ...p.insts.map(i => i.repoHome ?? i.cwd ?? opts.opsRepo), ...p.tasks.map(t => t.repoPath ?? opts.opsRepo)])];
  const roles = [...new Set([...p.defs.map(d => d.role), ...p.insts.map(i => i.role)])];
  const pools = roles.flatMap(role => homes.map(home => ({ role, home, entries: staffingPool({ ...poolBase, role, home }) })))
    .filter(pool => pool.entries.length > 0);
  const reviewPools = await reviewStaffingPreviews(p.tasks, poolBase, wf);
  const readyTasks = p.tasks.filter(t => t.state === 'ready');
  // A failed read leaves the waits unknown (no readySince), and the conclusions of the pass still stand.
  let since = new Map<string, number>();
  try {
    since = await wf.readySince(readyTasks.map(t => t.id));
  } catch (error) {
    opts.log?.(`ready-since read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ready = readyTasks.map((t): ReadyItem => ({
    taskId: t.id, title: t.title, role: t.executorRole as string, discipline: t.discipline, readySince: since.get(t.id),
  }));
  return { at, verdicts: [...verdicts], pools, reviewPools, ready };
}

export class Dispatcher {
  /** Last observed Paseo status per agent; a busy→idle transition is the recovery signal for a provider. */
  private readonly lastStatus = new Map<string, string>();
  /** agentId → when the last in-place reload was attempted; a failing restart is retried, not hammered. */
  private readonly reloadAt = new Map<string, number>();
  /** agentId → the served model already reported as waiting for its provider: one line per episode, not per tick. */
  private readonly driftWaitLogged = new Map<string, string>();
  /** The last quota-floor line written. A subscription can stay below the floor for days; one line per change, not per tick. */
  private lastQuotaFloor = '';
  private readonly onboarded = new Set<string>();
  // Claim denials are task-state refusals (already claimed, busy worktree, gone
  // task): every candidate would hit the same wall, so a fresh denial cools the
  // task for a while instead of spawning a disposable instance every tick.
  private readonly taskDeny = new Map<string, { at: number; version?: number }>();
  private lastSweep = 0;
  private readonly keptLogged = new Set<string>();
  /** Artifact reclaim cadence: slow and lazy in normal mode, prompt once disk is heading down. */
  private lastArtifactSweep = 0;
  private artifactPressure = false;

  constructor(private readonly deps: DispatcherDeps) {}
  private log(message: string) { this.deps.log?.(message); }

  /** Dispatch-blocked conclusions from the latest pass, keyed by task and phase. Dispatchable work is absent. */
  private readonly verdicts = new Map<string, DispatchVerdict>();
  /** Tasks whose claim lost the write scope to another writer in this pass: settled as write_scope, never as a wake failure. */
  private readonly scopeDenied = new Set<string>();

  /** Server-side dispatch-blocked conclusions from the latest pass; the roster, task cards and brief read these. */
  dispatchVerdicts(): DispatchVerdict[] {
    return [...this.verdicts.values()];
  }

  /**
   * The write scope an execute claim of this task needs, read before any spawn or claim (SYS-DISP R1). Undefined when it is
   * free. An unreadable scope is unknown: never free, never busy.
   */
  private async writeScopeBlock(task: SupervisedTask): Promise<GlobalBlock | undefined> {
    const sidecar = this.deps.sidecar;
    if (!sidecar) return undefined;
    try {
      const holders = await sidecar.writeScope(task, task.currentEmployee);
      return holders.length ? { code: 'write_scope', text: BLOCK_TEXT.write_scope, candidates: holders.map(holder => holderLabel(holder)) } : undefined;
    } catch (error) {
      this.log(`write scope of ${task.id} unreadable: ${(error as Error).message}`);
      return { code: 'unknown', text: BLOCK_TEXT.unknown };
    }
  }

  /** Candidate-level preflight before any spawn or claim: true when this candidate's claim would be refused for write scope. */
  private async scopeBlocked(task: SupervisedTask, employeeId?: string): Promise<boolean> {
    if (!this.deps.sidecar) return false;
    try {
      return (await this.deps.sidecar.writeScope(task, employeeId)).length > 0;
    } catch (error) {
      this.log(`write scope of ${task.id} unreadable: ${(error as Error).message}`);
      return true;
    }
  }

  /** The latest pass's view of every live session, so the roster and pulse show what the tick acted on. */
  private observed: SessionSnapshot = { at: 0, sessions: new Map() };

  sessionSnapshot(): SessionSnapshot {
    return this.observed;
  }

  /** The latest pass's snapshot. The owner-facing roster and pulse read it, never the live database, for dispatch conclusions. */
  private snapshot: DispatchSnapshot = emptySnapshot();

  dispatchSnapshot(): DispatchSnapshot {
    return this.snapshot;
  }

  /** Inputs of the pass in progress, set once the pass has read its sessions, tasks and gates (see pass). */
  private passInputs?: PassInputs;

  /**
   * Stores this pass's verdict for a work item and persists the episode start when the block is new or moved. A repeated
   * tick or a restart keeps the same start, so the waiting time never resets silently. `now` is server time in unix
   * seconds, like every other clock in the tick; only the verdict itself uses milliseconds.
   */
  private async recordVerdict(task: SupervisedTask, phase: DispatchPhase, home: string,
    entries: EvaluatedEntry[] | undefined, now: number, globalBlocks: GlobalBlock[] = [], otherRepo = 0): Promise<{ verdict: DispatchVerdict; since: number }> {
    const since = task.dispatchBlockedPhase === phase && task.dispatchBlockedSince ? task.dispatchBlockedSince : now;
    const verdict = evaluateDispatch({ taskId: task.id, goalId: task.goalId, title: task.title, phase, home, entries, globalBlocks, otherRepo,
      workflowState: task.state === 'review' ? 'review' : task.state === 'doing' ? 'doing' : 'ready',
      role: phase === 'execute' ? task.executorRole : task.reviewerRole, since: since * 1000, checkedAt: now * 1000 });
    this.verdicts.set(`${task.id}:${phase}`, verdict);
    if (task.dispatchBlockedPhase !== phase || task.dispatchBlockedSince !== since) {
      await this.deps.workforce.setDispatchBlock(task.id, phase, since);
    }
    return { verdict, since };
  }

  /**
   * A work item that could not be dispatched this pass. The owner notice is keyed per task and phase and raised only
   * once the block is material: no candidate can ever qualify, or five minutes have passed. Unknown state (`entries`
   * undefined) is material at once, because nobody can tell whether the work is merely busy.
   */
  private async settleBlocked(task: SupervisedTask, phase: DispatchPhase, home: string,
    entries: EvaluatedEntry[] | undefined, now: number, report: TickReport, globalBlocks: GlobalBlock[] = [], otherRepo = 0): Promise<void> {
    const { verdict, since } = await this.recordVerdict(task, phase, home, entries, now, globalBlocks, otherRepo);
    if (!verdict.feasible || now - since >= BLOCK_NOTICE_MS / 1000) {
      await this.notice(verdict.noticeKey, dispatchNoticeText(verdict), report);
    }
  }

  /**
   * A pass-wide gate blocks every queued item, and the candidates are not read while it applies. Budget and resources
   * already raise their own owner notice, so they only record verdicts. The concurrency cap has no notice of its own,
   * so it escalates like any other block once it has lasted five minutes (`notify`).
   */
  private async markGlobal(work: ReadonlyArray<{ task: SupervisedTask; purpose: DispatchPhase }>, block: GlobalBlock,
    now: number, report: TickReport, notify = false): Promise<void> {
    for (const item of work) {
      const home = item.task.repoPath ?? this.deps.env.opsRepo;
      const { verdict, since } = await this.recordVerdict(item.task, item.purpose, home, undefined, now, [block]);
      if (notify && now - since >= BLOCK_NOTICE_MS / 1000) await this.notice(verdict.noticeKey, dispatchNoticeText(verdict), report);
    }
  }

  /** Ends a dispatch-blocked episode after the work item was dispatched: verdict, persisted start and notice all clear. */
  private async clearBlocked(task: SupervisedTask, phase: DispatchPhase): Promise<void> {
    const key = `${task.id}:${phase}`;
    const had = this.verdicts.delete(key);
    const persisted = task.dispatchBlockedPhase === phase;
    if (!had && !persisted) return;
    if (persisted) await this.deps.workforce.setDispatchBlock(task.id, undefined);
    await this.deps.owner.resolveNotice(`dispatch-blocked:${key}`, { task: task.id, evidence: `dispatch-blocked ${phase} episode ended: dispatched` });
  }

  /**
   * Ends the episodes of work that left the queue this pass: leased, accepted, returned, or moved to another phase.
   * Persisted starts count too, so an episode that began before a restart is closed as well.
   */
  private async endStaleEpisodes(tasks: readonly SupervisedTask[], queued: ReadonlySet<string>): Promise<void> {
    const ended = new Map<string, { taskId: string; phase: DispatchPhase; persisted: boolean }>();
    for (const verdict of this.verdicts.values()) {
      const key = `${verdict.taskId}:${verdict.phase}`;
      if (!queued.has(key)) ended.set(key, { taskId: verdict.taskId, phase: verdict.phase, persisted: false });
    }
    for (const task of tasks) {
      if (!task.dispatchBlockedPhase) continue;
      const phase = task.dispatchBlockedPhase as DispatchPhase;
      if (!queued.has(`${task.id}:${phase}`)) ended.set(`${task.id}:${phase}`, { taskId: task.id, phase, persisted: true });
    }
    for (const [key, { taskId, phase, persisted }] of ended) {
      this.verdicts.delete(key);
      if (persisted) await this.deps.workforce.setDispatchBlock(taskId, undefined);
      await this.deps.owner.resolveNotice(`dispatch-blocked:${key}`, { task: taskId, evidence: `dispatch-blocked ${phase} episode ended: work left the queue` });
    }
  }

  /**
   * Implementer gate for each open engineering task: the explicit implementer when one is recorded, otherwise the audit
   * stream's view. Review-state tasks are included so their bound implementer stays available for rework; review dispatch
   * never applies a gate (see executeGateFor). A history that cannot be read maps to null, which the tick gates as unknown for that task only.
   */
  private async readExecuteGates(tasks: readonly SupervisedTask[]): Promise<Map<string, ExecuteGate | null>> {
    const { workforce: wf } = this.deps;
    const gates = new Map<string, ExecuteGate | null>();
    for (const task of tasks) {
      if (task.executorRole !== 'engineering' || !['ready', 'doing', 'blocked', 'review'].includes(task.state)) continue;
      if (task.implementer) {
        gates.set(task.id, { implementer: task.implementer, unresolved: false });
        continue;
      }
      try {
        gates.set(task.id, executeGate(await wf.contributors(task.id)));
      } catch (error) {
        this.log(`contributors read failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        gates.set(task.id, null);
      }
    }
    return gates;
  }

  /**
   * One dispatch pass, then the snapshot and the daily brief, both taken from that pass (SYS-DISP R1, R4). A pass that returns early
   * (paused, budget, resources) still gets its snapshot, so the owner sees the global gate that held it.
   */
  async tick(): Promise<TickReport> {
    this.passInputs = undefined;
    const report = await this.pass();
    // The pass set the inputs through `this`, which control-flow analysis cannot see across the await: the assertion is the contract.
    const inputs = this.passInputs as PassInputs | undefined;
    if (inputs) {
      this.snapshot = await this.buildSnapshot(inputs);
      await this.dailyBrief(inputs.now, inputs.cfg, report, this.snapshot.verdicts)
        .catch(error => this.log(`daily brief failed: ${(error as Error).message}`));
    }
    return report;
  }

  private async pass(): Promise<TickReport> {
    const { workforce: wf, owner, paseo } = this.deps;
    const report: TickReport = { commands: 0, revoked: [], extended: [], woke: [], retired: [], refused: [], exhausted: [], notices: [], evals: [], decisions: [], realigned: [], recovered: [] };
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
    /** instId → the model Paseo reports the session actually serves (not what the spawn asked for). */
    const runtimeModelOf = (inst: EmployeeInst): string | undefined =>
      inst.paseoAgentId ? agents.get(inst.paseoAgentId)?.model : undefined;
    const runtimeModels = new Map<string, string>();
    for (const inst of insts) {
      const served = runtimeModelOf(inst);
      if (served) runtimeModels.set(inst.id, served);
    }
    let health = await wf.providerHealth();
    const quotaByProvider = new Map<string, ProviderQuota>();
    for (const q of quotaRows) quotaByProvider.set(q.provider, q);
    // Quota circuit breaker: separate floors for short windows (session/5h + balances)
    // and long windows (week/month). Stale snapshots (>15min) fail open rather than
    // keeping a provider blocked forever.
    const quotaBlocked = quotaBlockedProviders(quotaRows, cfg, Date.now());
    const quotaFloorLine = [...quotaBlocked].map(([p, r]) => `${p} ${r}`).join('; ');
    if (quotaFloorLine !== this.lastQuotaFloor) {
      const clears = this.lastQuotaFloor !== '' && quotaFloorLine === '';
      this.lastQuotaFloor = quotaFloorLine;
      if (quotaFloorLine) this.log(`quota below floor: ${quotaFloorLine}`);
      else if (clears) this.log('quota recovered: every provider is above its floor');
    }
    // Early warning: a subscription that is nearly spent still dispatches, but the owner hears
    // about it while there is time to top it up, instead of discovering it when the company stops.
    if (cfg.quotaWarnPct > 0) {
      // A snapshot older than the breaker's own freshness window is no answer: the breaker fails
      // open on it, and a warning built on it would state a number nobody verified. Stale rows
      // raise no warning (an existing one clears as usual once the provider stops being listed).
      const fresh = (q: ProviderQuota) => {
        const age = q.fetchedAt ? Date.now() - Date.parse(q.fetchedAt) : 0;
        return age < 15 * 60_000;
      };
      const low = new Set<string>();
      for (const q of quotaRows) {
        if (quotaBlocked.has(q.provider) || !fresh(q)) continue;
        const pct = q.weeklyPct ?? q.lowestPct;
        if (pct === undefined || pct > cfg.quotaWarnPct) continue;
        low.add(q.provider);
        await this.notice(`quota-warn:${q.provider}`,
          `订阅 ${q.provider} 剩余 ${Math.round(pct)}%（低于提醒线 ${cfg.quotaWarnPct}%），${q.summary || '请查看用量'}。额度用尽后该订阅的会话会失败，建议现在充值或调整编制。`, report);
      }
      for (const notice of await owner.openNotices()) {
        if (!notice.key.startsWith('quota-warn:')) continue;
        if (!low.has(notice.key.slice('quota-warn:'.length))) await owner.resolveNotice(notice.key);
      }
    }

    // 1. Session health.
    const states = new Map<string, InstState>();
    const observedStatus = new Map<string, string>();
    for (const inst of insts) {
      if (!inst.paseoAgentId) {
        if (await this.retireGated(inst, 'spawn did not bind a Paseo agent', 'failure', report)) report.retired.push(inst.id);
        continue;
      }
      if (this.deps.sidecar && !inst.credentialFile && !this.deps.sidecar.canReuse(inst)) {
        // Infrastructure failure, not a model/provider or employee performance failure.
        // An archived session also loses its launch binding; the Paseo-reported archived
        // status is the trusted structured normal-end signal (FV06) — only a live
        // session whose binding is gone is real channel isolation.
        states.set(inst.id, 'down');
        const archived = (await paseo.status(inst.paseoAgentId).catch(() => undefined))?.status === 'archived';
        if (!await this.retireBroken(inst, archived ? '会话已归档（正常结束），通道绑定随之失效' : '通道隔离：会话启动绑定已失效，禁止复用旧会话', defs, report, false, archived ? 'archive' : 'failure')) continue;
        await paseo.stop(inst.paseoAgentId).catch(() => undefined);
        await paseo.archive(inst.paseoAgentId).catch(() => undefined);
        continue;
      }
      const status = agents.get(inst.paseoAgentId)?.status ?? (await paseo.status(inst.paseoAgentId))?.status ?? 'missing';
      if (status === 'unknown') {
        // The CLI could not answer (SYS-DISP B4): not idle, not busy, not missing. Keep the session and the last observed status.
        states.set(inst.id, 'unknown');
        observedStatus.set(inst.id, status);
        continue;
      }
      const previous = this.lastStatus.get(inst.paseoAgentId);
      this.lastStatus.set(inst.paseoAgentId, status);
      observedStatus.set(inst.id, status);
      if (status === 'running' || status === 'initializing' || status === 'busy') { states.set(inst.id, 'busy'); continue; }
      if (status === 'idle') {
        states.set(inst.id, 'idle');
        if ((previous === 'running' || previous === 'error') && inst.provider) {
          // A session ending says nothing about a quota window still open: the employee that reported
          // the block goes idle right after it. Only a passed reset (or the probe) clears exhaustion.
          const h = health.get(inst.provider);
          if (h?.state === 'exhausted' && (h.until ?? 0) <= now) await wf.markHealthy(inst.provider);
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
          // An exempt def keeps running through a spent subscription: its parked session is
          // restarted on the normal retry interval instead of waiting out the provider cooldown.
          const exempt = defs.find(d => d.id === inst.def)?.quotaLimited === false;
          if (fresh && !managedModel(defs.find(d => d.id === inst.def)) && !report.exhausted.includes(inst.provider)) {
            // A quota row that knows when the window resets beats the exponential backoff: the
            // provider is unusable until then, and probing earlier only burns another session.
            const resetsAt = quotaByProvider.get(inst.provider)?.resetsAt;
            const resetsAtSec = resetsAt ? Math.floor(Date.parse(resetsAt) / 1000) : undefined;
            await wf.markExhausted(inst.provider, error, Number.isFinite(resetsAtSec) ? resetsAtSec : undefined);
            report.exhausted.push(inst.provider);
            if (!exempt) continue;
          }
          // Not a fresh failure: the session has been parked in this error since an earlier turn,
          // and Paseo keeps it there until the underlying process restarts. Once the provider's
          // cooldown has passed, restart it in place — the agent, its conversation and its channel
          // survive, so the seat comes back without a retirement, a respawn or a new employee id.
          const cooldownOver = exempt || (!report.exhausted.includes(inst.provider) &&
            availabilityOf(health.get(inst.provider), now) !== 'down');
          if (cooldownOver && now - (this.reloadAt.get(inst.paseoAgentId) ?? 0) >= RELOAD_RETRY_SECONDS) {
            this.reloadAt.set(inst.paseoAgentId, now);
            try {
              await paseo.reload(inst.paseoAgentId);
              states.set(inst.id, 'idle');
              observedStatus.set(inst.id, 'idle');
              this.lastStatus.set(inst.paseoAgentId, 'idle');
              (report.recovered ??= []).push(inst.id);
              this.log(`recovered ${inst.id}: reloaded after ${inst.provider} quota reset`);
            } catch (reloadError) {
              this.log(`reload ${inst.id} failed: ${(reloadError as Error).message}`);
            }
          }
          continue;
        }
        states.set(inst.id, 'down');
        await this.retireBroken(inst, `session error: ${error.slice(0, 200) || 'unknown'}`, defs, report);
        continue;
      }
      if (status === 'archived') {
        // Trusted normal end (FV06): Paseo reports Archived=true authoritatively for an
        // archived session even though it no longer appears in the roster. Session rotation
        // and scene recycling retire a trusted kind before archiving; an archive that
        // reaches the dispatcher first (plugin listener, manual archive) still ends the
        // session normally and must not poison a formed approval with a failure kind.
        states.set(inst.id, 'down');
        await this.retireBroken(inst, 'Paseo 会话已归档（正常结束）', defs, report, false, 'archive');
        continue;
      }
      states.set(inst.id, 'down');
      await this.retireBroken(inst, `session ${status}`, defs, report, false);
    }
    health = await wf.providerHealth();
    const agentOf = new Map(insts.map(i => [i.id, i.paseoAgentId]));
    this.observed = { at: Date.now(), sessions: new Map([...states].map(([id, state]) =>
      [id, { agentId: agentOf.get(id), status: observedStatus.get(id) ?? state, state }] as const)) };
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
        await this.revoke(task, `员工 ${task.currentEmployee} 会话${state === 'idle' ? '空闲' : state === 'unknown' ? '状态未知' : '失联'}且超过 ${cfg.stallMinutes} 分钟没有 checkpoint`, inst, report);
      } else if (expired) {
        await this.revoke(task, `员工 ${task.currentEmployee} 结束本轮但未交接，租约已过期`, inst, report, 'expire');
      }
    }
    for (const inst of insts) {
      if (states.get(inst.id)!=='idle' || (!inst.def || defs.some(d=>d.id===inst.def && d.enabled))) continue;
      if (await this.retireGated(inst, '编制已停用或删除，旧会话完成后正常退出', 'rotation', report)) {
        report.retired.push(inst.id);
        if(inst.paseoAgentId) await paseo.archive(inst.paseoAgentId).catch(()=>undefined);
      }
    }
    insts = insts.filter(i => !report.retired.includes(i.id));

    // 2b. Jev decisions: goal triage, release go/no-go, owner-escalation routing. Undecided items stay with gm/product.
    if (this.deps.jev && cfg.jevDecisions) await this.jevDecisions(cfg, report);
    const tasks = await wf.tasks();
    // Execute gates for open engineering work are read before rotation, so a bound implementer's session is kept.
    const gates = await this.readExecuteGates(tasks);

    // 2c. Session rotation: a session that has run many turns carries an ever-growing context,
    // so every further turn costs more input tokens. Retire idle instances past the configured
    // size/count and let the next task spawn a fresh, cheap session.
    {
      const holding = new Set(tasks.filter(t => t.currentEmployee).map(t => t.currentEmployee!));
      // A retired session cannot take its open engineering task back (the implementer is bound), so keep bound sessions.
      // An unreadable gate hides which session is bound, so nothing is rotated in that pass (fail-closed).
      const bound = new Set([...gates.values()].flatMap(gate => gate?.implementer ? [gate.implementer] : []));
      const rotationSafe = ![...gates.values()].includes(null);
      if (rotationSafe) {
        const idleRetired = await reclaimIdleSessions({ instances: insts, states, held: holding, bound, now,
          minutes: cfg.sessionIdleMinutes ?? 120, workforce: wf, paseo,
          archiveScene: inst => this.archiveInstScene(inst), log: text => this.log(text),
        }).catch(error => { this.log(`idle cleanup failed safely: ${(error as Error).message}`); return [] as string[]; });
        report.retired.push(...idleRetired);
      }
      let inspected = 0;
      for (const inst of insts) {
        if (!rotationSafe) break;
        if (report.retired.includes(inst.id) || states.get(inst.id) !== 'idle' || holding.has(inst.id) || bound.has(inst.id) || !inst.paseoAgentId) continue;
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
        // Model drift is not a reason to retire anyone. A provider can switch the model under a
        // live subscription (Factory falls back to a cheaper model once the standard allowance is
        // spent) and can switch back when it recovers; the session, its conversation and its seat
        // all stay valid. Realign it in place, and when that is not possible leave it for the next
        // pass rather than throwing the session away.
        const def = defs.find(d => d.id === inst.def);
        const target = def?.model?.startsWith('group/sck-') ? undefined : def ? resolveModel(def) : undefined;
        const served = runtimeModels.get(inst.id) ?? inst.model;
        // Realign only once the subscription has recovered. A provider that switched models because
        // its standard allowance ran out switches back on its own at reset; asking every pass during
        // the fallback is a call that cannot take effect, and Factory keeps serving its fallback model
        // until then. While the provider is out, the drifted session is left alone — never retired.
        const providerReady = !inst.provider ||
          (availabilityOf(health.get(inst.provider), now) !== 'down' && !quotaBlocked.has(inst.provider));
        const staleModel = Boolean(target && served && served !== target);
        if (!staleModel) this.driftWaitLogged.delete(inst.paseoAgentId);
        if (staleModel && providerReady) {
          const realigned = this.deps.realignAgent
            ? await this.deps.realignAgent(inst.paseoAgentId!, target!).catch(() => false)
            : false;
          if (realigned) {
            this.driftWaitLogged.delete(inst.paseoAgentId);
            runtimeModels.set(inst.id, target!);
            (report.realigned ??= []).push(inst.id);
            this.log(`realigned ${inst.id}: ${served} → ${target}`);
          } else {
            this.log(`model drift on ${inst.id} (${served} vs ${target}) left in place: no realign path`);
          }
          continue;
        }
        if (staleModel) {
          // Waiting out a spent subscription can last days; one line per episode keeps the plugin log readable.
          if (this.driftWaitLogged.get(inst.paseoAgentId) !== served) {
            this.driftWaitLogged.set(inst.paseoAgentId, served!);
            this.log(`model drift on ${inst.id} (${served} vs ${target}) waits for ${inst.provider} to recover`);
          }
          continue;
        }
        if (!legacyEol && !overWakes && !(cfg.sessionMaxInputK > 0 && inputK > cfg.sessionMaxInputK)) continue;
        const reason = legacyEol ? '通道轮换：凭证文件实例在 sidecar 模式下不可再接任务'
          : overWakes ? `会话轮换：已派工 ${inst.wakeCount} 轮` : `会话轮换：上一轮 input ${Math.round(inputK)}k tokens`;
        if (!await this.retireGated(inst, reason, 'rotation', report)) continue;
        await paseo.archive(inst.paseoAgentId!).catch(() => undefined);
        await this.archiveInstScene(inst);
        report.retired.push(inst.id);
        this.log(`retired ${inst.id}: ${reason}`);
      }
      insts = insts.filter(i => !report.retired.includes(i.id));
      for (const id of report.retired) runtimeModels.delete(id);
    }

    // What this pass has read before it decides. The snapshot and the daily brief are taken from these at the end of the tick.
    this.passInputs = { now, cfg, defs, insts, states, health, quotaBlocked, tasks, slots: slotMap, runtimeModels };

    // 3. Owner inbox notices (gates, questions) and staffing gaps.
    await this.ownerNotices(tasks, report);
    await this.ownerAging(now, report).catch(error => this.log(`owner aging failed: ${(error as Error).message}`));

    // 4. Work that needs an employee.
    const holding = new Set(tasks.filter(t => t.currentEmployee).map(t => t.currentEmployee!));
    const work = [
      ...tasks.filter(t => t.state === 'review' && t.reviewerRole !== 'owner' && !t.currentEmployee)
        .map(t => ({ task: t, role: t.reviewerRole, purpose: 'review' as const })),
      ...tasks.filter(t => (t.state === 'ready' || t.state === 'doing') && !t.currentEmployee)
        .map(t => ({ task: t, role: t.executorRole as string, purpose: 'execute' as const })),
    ];
    // Independence scopes (SYS-DISP IR02): each work item whose policy names its stage reads its exclusion once per pass, from the same
    // audit stream the claim gate reads. An unreadable source blocks that task's pool as unknown; it is never read as clear.
    const independence = new Map<string, IndependenceScope>();
    for (const item of work) {
      const scope = item.task.independence ? await this.deps.workforce.independenceScope(item.task.independence, item.purpose) : undefined;
      if (scope) independence.set(`${item.purpose}:${item.task.id}`, scope);
    }
    // Effective policy contracts (SYS06 AC02/RB01): each work item's verdict is read once per pass, from the same policy rows
    // the claim gate and the ops broker read. A task that lost authorization is held back for every candidate.
    // The read only happens when a policy layer is really injected: a stand-in workforce has none, so it has no contract to
    // violate (the real Workforce always carries the method — the type requires it, only a test double can bypass it). A read
    // that does fail is held back too: an unreadable contract must never be read as "no restriction".
    const policyBlocks = new Map<string, string>();
    const verdictOf = typeof this.deps.workforce.policyDispatchVerdict === 'function'
      ? this.deps.workforce.policyDispatchVerdict.bind(this.deps.workforce)
      : undefined;
    if (verdictOf) {
      for (const item of work) {
        let verdict: Awaited<ReturnType<Workforce['policyDispatchVerdict']>>;
        try {
          verdict = await verdictOf(item.task.id);
        } catch (error) {
          this.log(`policy verdict read failed for ${item.task.id}: ${(error as Error).message}`);
          policyBlocks.set(item.task.id, `有效策略契约读取失败（${(error as Error).message}），按失败关闭拦下`);
          continue;
        }
        if (!verdict || verdict.verdict === 'clear') continue;
        policyBlocks.set(item.task.id, verdict.verdict === 'blocked' ? (verdict.reason ?? BLOCK_TEXT.policy_blocked)
          : `有效策略契约已变更（${verdict.hash?.slice(0, 16) ?? 'unknown'}），本次派工按旧契约读出，需重新领取`);
      }
    }
    this.passInputs.policyBlocks = policyBlocks;
    // Episodes of work that left the queue end here, before any pass-wide gate below returns early.
    await this.endStaleEpisodes(tasks, new Set(work.map(item => `${item.task.id}:${item.purpose}`)));
    const gmBlocked = tasks.filter(t => t.state === 'blocked' && t.blockedTo === 'gm');
    const usable = [...new Set(defs.filter(d => d.enabled).filter(d =>
      d.quotaLimited === false || (this.available(health.get(d.provider), now) !== 'down' && !quotaBlocked.has(d.provider)),
    ).map(d => d.provider))];
    if ((work.length || gmBlocked.length) && usable.length === 0) {
      const exhausted = [...health.values()].filter(h => h.state === 'exhausted')
        .map(h => `${h.provider}（预计 ${new Date((h.until ?? now) * 1000).toLocaleString('zh-CN')} 后重试）`);
      const text = `所有订阅都已耗尽或限流，公司暂停派工。请为以下订阅充值或等待额度恢复：${
        [...exhausted, ...[...quotaBlocked].map(([p, r]) => `${p}（${r}）`)].join('、') || '全部'}`;
      await this.notice('budget', text, report);
      await this.markGlobal(work, globalBlock('budget'), now, report);
      report.skipped = 'budget';
      return report;
    }
    await owner.resolveNotice('budget');
    if (cfg.paused) {
      await this.markGlobal(work, globalBlock('paused'), now, report);
      report.skipped = 'paused';
      return report;
    }

    // Host resource admission: below the configured free floors a spawn/wake would
    // starve every session already running on this host, so the entire dispatch
    // pass waits. Supervision above already ran — stalled leases still get reclaimed.
    // A probe error fails open (logged) rather than halting dispatch forever.
    const host = this.hostResources();
    const underFloor = Boolean(host && (memoryBlocked(host, cfg.minFreeMemMb) || host.freeDiskMb < cfg.minFreeDiskMb));
    const headroom = cfg.artifactHeadroomMb ?? 0;
    const pressure = Boolean(host && host.freeDiskMb < cfg.minFreeDiskMb + headroom);
    let reclaimAttempt: ArtifactReclaimResult | undefined;
    if (underFloor || pressure) {
      // Try to buy our way back with terminal-task artifacts before bailing out:
      // no new task can run until free space recovers, and reclaim takes real free
      // space away from nothing (clones only) while the probe is what decides.
      if (this.deps.reclaimArtifacts) {
        const targetFreeMb = cfg.minFreeDiskMb + (cfg.artifactHeadroomMb ?? 0);
        const reclaimed = reclaimAttempt = await this.deps.reclaimArtifacts({
          // Emergency: the config switch must not be able to deadlock dispatch; only the
          // env kill switch (SCK_ARTIFACT_RECLAIM=0) can, and then the notice says so.
          trigger: underFloor ? 'pressure' : 'sweep', targetFreeMb, dryRun: false, emergency: true,
        }).catch(error => { this.log(`artifact reclaim failed: ${(error as Error).message}`); return undefined; });
        if (reclaimed && (reclaimed.trimmed.length || reclaimed.removedFiles)) {
          this.log(`artifact reclaim ${reclaimed.runId}: ${summarizeReclaim(reclaimed)}`);
          report.reclaimed = { tasks: new Set(reclaimed.trimmed.map(t => t.taskId)).size, files: reclaimed.removedFiles, freedBytes: reclaimed.freedBytes, trigger: reclaimed.trigger, pressure: reclaimed.mode === 'pressure' };
          if (reclaimed.freeDiskMbAfter !== undefined) {
            const refreshed = this.hostResources();
            if (refreshed) Object.assign(host!, refreshed);
          }
        }
      }
    }
    if (host && (memoryBlocked(host, cfg.minFreeMemMb) || host.freeDiskMb < cfg.minFreeDiskMb)) {
      const why = reclaimAttempt?.disabled
        ? `；终态产物回收被${reclaimAttempt.disabledReason === 'env' ? '环境硬停（SCK_ARTIFACT_RECLAIM=0）' : '配置关闭（artifact_reclaim_enabled=false）'}，无法自动腾出空间`
        : '';
      await this.notice('resources',
        `宿主机资源不足，本轮暂停派工：内存压力 ${host.memoryPressure ?? '未知（按空闲内存判断）'}，空闲内存 ${host.freeMemMb} MB（下限 ${cfg.minFreeMemMb} MB）、空闲磁盘 ${(host.freeDiskMb / 1024).toFixed(1)} GB（下限 ${(cfg.minFreeDiskMb / 1024).toFixed(0)} GB）。在办任务不受影响，水位恢复后自动继续派工${why}。`, report);
      if (reclaimAttempt?.disabled) {
        await this.notice('resources-reclaim-blocked',
          `资源闸门正在阻塞全部派工，但终态产物回收不可用（${reclaimAttempt.disabledReason === 'env' ? 'SCK_ARTIFACT_RECLAIM=0 环境硬停' : 'artifact_reclaim_enabled=false'}）。空闲磁盘 ${host.freeDiskMb} MB，低于下限 ${cfg.minFreeDiskMb} MB。请恢复回收配置，或用 admin reclaim-artifacts --execute 手工回收。`, report, { force: true });
      } else {
        await owner.resolveNotice('resources-reclaim-blocked');
      }
      await this.markGlobal(work, globalBlock('resources'), now, report);
      report.skipped = 'resources';
      return report;
    }
    await owner.resolveNotice('resources');
    await owner.resolveNotice('resources-reclaim-blocked');

    const busyBy = new Map<string, number>();
    let running = 0;
    for (const inst of insts) {
      if (states.get(inst.id) !== 'busy') continue;
      running++;
      busyBy.set(inst.provider ?? '', (busyBy.get(inst.provider ?? '') ?? 0) + 1);
    }
    const assigned = new Set<string>();
    // Execute gates from the pre-rotation read. An unreadable history gates its task as unknown: candidates wait, never busy.
    const executeGates = new Map<string, ExecuteGate>();
    for (const [taskId, gate] of gates) executeGates.set(taskId, gate ?? UNKNOWN_EXECUTE_GATE);
    const rand = this.deps.rand ?? Math.random;
    // The candidate pool is evaluated by staffingPool — the same function the owner
    // page previews — so dispatch gating and the roster can never drift apart.
    const poolBase = { defs, states, holding, health, quotaBlocked, busyBy, policyBlocks,
      providerMax: cfg.providerMax, slots: slotMap, runtimeModels, opsRepo: this.deps.env.opsRepo,
      sidecar: !!this.deps.sidecar, now };
    const poolFor = (role: string, home: string, task?: SupervisedTask, excludeSubmitter = false, recusal?: ReviewRecusal,
      reserved?: ReadonlySet<string>) =>
      staffingPool({ ...poolBase, insts, role, home, task, excludeSubmitter, recusal, assigned, reserved,
        implementer: executeGateFor(executeGates, role, task, excludeSubmitter),
        independence: task ? independence.get(`${excludeSubmitter ? 'review' : 'execute'}:${task.id}`) : undefined });
    const eligibleInsts = (role: string, home: string, task?: SupervisedTask, excludeSubmitter = false,
      recusal?: ReviewRecusal, reserved?: ReadonlySet<string>) =>
      poolFor(role, home, task, excludeSubmitter, recusal, reserved).flatMap(e => e.kind === 'reuse' && e.eligible ? [e.inst!] : []);
    // Every pool read names whether it is review work, so the execute gate can never leak into a reviewer spawn.
    const eligibleDefs = (role: string, home: string, task?: SupervisedTask, forReview = false,
      reserved?: ReadonlySet<string>) =>
      poolFor(role, home, task, forReview, undefined, reserved).flatMap(e => e.kind === 'spawn' && e.eligible ? [e.def!] : []);
    /**
     * A bound implementer is struck when its session cannot take the task back: the employee is no longer live, or this
     * pass observed the session as down — archived, quarantined, or parked in a failure that cannot be restarted. Busy,
     * idle, exhausted and unknown are not struck unless an explicit code-repo rebind has left
     * that session outside the task's repository: waiting cannot move a repository-bound session.
     */
    const implementerUnavailableReason = (employeeId: string, task: SupervisedTask, home: string): string | undefined => {
      const inst = insts.find(i => i.id === employeeId);
      if (!inst || states.get(inst.id) === 'down' || (!!inst.def && !defs.some(d => d.id === inst.def && d.enabled)))
        return '员工退役/撤凭证，或会话归档、无法就地重启';
      // A manager's explicit code-repo correction changes the task's dispatch home, not the
      // existing session's home. That session is permanently outside this task's legal pool.
      // Do not loosen cross-repo admission or infer a correction from a project change alone.
      if (task.codeRepoPath === home && (inst.repoHome ?? inst.cwd ?? this.deps.env.opsRepo) !== home)
        return `任务代码仓已显式改绑为 ${home}，原实现人会话仍属于 ${inst.repoHome ?? inst.cwd ?? this.deps.env.opsRepo}`;
      return undefined;
    };
    /**
     * The binding outlives the employee: a struck implementer can never take its task back, and the execute gate keeps
     * every other engineer out, so the work would wait forever on someone who is gone. The system hands the code to a
     * live engineer of the same repository on its own — no manager, no owner decision — and the next pass dispatches to
     * it. With no candidate the verdict says so and the pass retries by itself. Returns true when the item was settled
     * here, so the caller leaves it to the next pass.
     */
    /**
     * The implementer the execute gate binds this task to, when it can be named: the explicit field first, then the derived one
     * (the sole author of a task that never recorded an explicit implementer). An unresolved or unreadable history names
     * nobody — the task waits there as unknown, never as struck.
     */
    const boundImplementer = (task: SupervisedTask): string | undefined => {
      if (task.implementer) return task.implementer;
      const gate = executeGates.get(task.id);
      return gate && !gate.unresolved && gate.implementer ? gate.implementer : undefined;
    };
    const replaceStruckImplementer = async (task: SupervisedTask, home: string): Promise<boolean> => {
      const implementer = boundImplementer(task);
      const unavailable = implementer && implementerUnavailableReason(implementer, task, home);
      if (!implementer || !unavailable) return false;
      const takeover = this.deps.autoTakeover;
      if (takeover) {
        let facts;
        try {
          facts = await wf.contributors(task.id);
        } catch (error) {
          this.log(`contributors read failed for ${task.id}: ${(error as Error).message}`);
          await this.settleBlocked(task, 'execute', home, undefined, now, report);
          return true;
        }
        // The successor is a live engineer of the same repo that is neither an author nor the struck implementer.
        const excluded = new Set<string>([...facts.excluded, implementer]);
        const successor = factoryFirst(staffingPool({ ...poolBase, insts, role: task.executorRole, home, task, implementer: undefined, assigned,
          independence: independence.get(`execute:${task.id}`) })
          .filter(entry => entry.kind === 'reuse' && entry.eligible && !excluded.has(entry.key))
          .sort((a,b)=>a.key.localeCompare(b.key)))[0]?.key;
        if (successor) {
          const moved = await takeover({ taskId: task.id, toEmployee: successor, expectedVersion: task.version,
            reason: `自动接替：原实现人 ${implementer} 已不可用（${unavailable}），系统把代码交给同仓在岗工程员工` })
            .catch(error => { this.log(`auto takeover of ${task.id} failed: ${(error as Error).message}`); return false; });
          if (moved) {
            report.decisions.push(`auto-takeover:${task.id}=${successor}`);
            this.log(`auto takeover ${task.id}: ${implementer} → ${successor} (implementer unavailable)`);
            await this.clearBlocked(task, 'execute');
            return true;
          }
        }
      }
      await this.settleBlocked(task, 'execute', home, [{ key: '*', eligible: false, code: 'implementer_unavailable' }], now, report);
      return true;
    };
    /**
     * A bound implementer whose provider has failed quota repeatedly, or whose reset time is unknown, cannot be relied
     * on to come back on its own. This is not a busy/capacity wait: the manager gets a takeover todo. A known short
     * cooldown stays a wait; one failure is not persistent.
     */
    const persistentQuotaImplementer = (task: SupervisedTask): { employee: string; until?: string; failures: number } | undefined => {
      const employee = task.implementer;
      if (!employee) return undefined;
      const inst = insts.find(i => i.id === employee);
      if (!inst) return undefined; // the struck path owns a vanished employee
      if (states.get(inst.id) !== 'exhausted') return undefined;
      const h = health.get(inst.provider ?? '');
      if (!h || h.state !== 'exhausted') return undefined;
      const def = defs.find(d => d.id === inst.def);
      if (def?.quotaLimited === false) return undefined;
      const failures = h.failures ?? 0;
      if (failures < PERSISTENT_QUOTA_FAILURES && h.until !== undefined) return undefined;
      return { employee, failures, until: h.until === undefined ? undefined : new Date(h.until * 1000).toISOString() };
    };
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
      recusal?: ReviewRecusal, anchorHome?: string, reserved?: ReadonlySet<string>) => {
      const home = task?.repoPath ?? anchorHome ?? this.deps.env.opsRepo;
      const eligible = eligibleInsts(role, home, task, excludeSubmitter, recusal, reserved);
      const factory = eligible.filter(i => i.provider === FACTORY_PROVIDER);
      const candidates = factory.length ? factory : eligible;
      // A prior hand is demoted in the weighted pick (PRIOR_HAND_WEIGHT_FACTOR), exactly as in the pool.
      const weight = (inst: EmployeeInst) => effectiveWeight(defs.find(d => d.id === inst.def))
        * (recusal?.hands.has(inst.id) ? PRIOR_HAND_WEIGHT_FACTOR : 1);
      // Continuity beats weights: the previous holder keeps the task when it is still available.
      // Review work never hits this: an author's former holder is already out; a claim-only
      // hand surviving as previousEmployee is continuity, not a conflict.
      const previous = candidates.find(i => i.id === task?.previousEmployee && states.get(i.id) === 'idle');
      if (previous) return previous;
      // A dead (exhausted) session cannot prove a provider recovered; probe with a live one when possible.
      const live = candidates.filter(i => states.get(i.id) === 'idle');
      const usable = live.length ? live : candidates;
      const pool = usable.filter(i => i.id !== avoid);
      const available = pool.length ? pool : usable;
      if (available.length && available.every(i => managedModel(defs.find(d => d.id === i.def))))
        return managedRecencyOrder(available, recusal?.hands)[0];
      return weightedOrder(available, weight, rand)[0];
    };
    const spawnable = (role: string, home: string, task?: SupervisedTask, forReview = false,
      reserved?: ReadonlySet<string>) =>
      eligibleDefs(role, home, task, forReview, reserved).every(managedModel)
        ? eligibleDefs(role, home, task, forReview, reserved).sort((a,b) => a.id.localeCompare(b.id))
        : weightedOrder(eligibleDefs(role, home, task, forReview, reserved), effectiveWeight, rand);

    // Legacy role-level staffing notices (staff:<role>) are superseded by per-task dispatch-blocked notices. Resolve any
    // still open from the previous version, including roles with no queued work, so no stale row is left in the inbox.
    for (const notice of await owner.openNotices()) {
      if (notice.key.startsWith('staff:')) await owner.resolveNotice(notice.key);
    }
    // Work is handled in queue order. Unreadable authorship fails closed for that item alone: it is recorded as unknown
    // and never guessed at, while the rest of the queue keeps moving. Items beyond the concurrency cap are recorded
    // after the loop as blocked by max_running.
    const unplaced: typeof work = [];
    for (const item of work) {
      if (running >= cfg.maxRunning) { unplaced.push(item); continue; }
      const home = item.task.repoPath ?? this.deps.env.opsRepo;
      // The binding outlives the employee: a struck implementer settles here, by automatic successor or by the block that says so.
      if (item.purpose === 'execute' && item.task.executorRole === 'engineering') {
        if (await replaceStruckImplementer(item.task, home)) continue;
        const quota = persistentQuotaImplementer(item.task);
        if (quota) {
          await this.settleBlocked(item.task, 'execute', home,
            [{ key: quota.employee, eligible: false, code: 'implementer_quota', until: quota.until,
              reason: `已连续 ${quota.failures} 次额度失败` }], now, report);
          continue;
        }
      }
      if (item.purpose === 'execute' && item.task.executorRole === 'engineering' && !executeGates.has(item.task.id)) {
        await this.settleBlocked(item.task, 'execute', home, undefined, now, report);
        continue;
      }
      const last = await wf.lastDispatch(item.task.id, item.task.version, item.purpose);
      if (last && now - last.at < cfg.redispatchMinutes * 60) continue;
      // SYS-DISP R1: a same-lane or overlapping write scope held by another writer is a reason of its own. The claim would be
      // refused, so nothing is spawned or claimed; the verdict names the holders and clears once they finish.
      if (item.purpose === 'execute') {
        const scope = await this.writeScopeBlock(item.task);
        if (scope) {
          await this.settleBlocked(item.task, 'execute', home, undefined, now, report, [scope]);
          continue;
        }
      }
      // SYS-DISP AC05 (R1): an engineering execute claim must leave the review that follows a legal path: a legal reuse
      // reviewer who is not the implementer, or a compliant spare seat. Otherwise nothing is claimed and the block goes to the
      // manager. The reserved reviewer is logical only: no review lease, and this task's execute pool may not pick it.
      let reserved: ReadonlySet<string> | undefined;
      if (item.purpose === 'execute' && item.task.executorRole === 'engineering' && item.task.reviewerRole !== 'owner') {
        const authors = await readReviewRecusal(wf, item.task, message => this.log(message));
        if (authors === undefined) {
          await this.settleBlocked(item.task, 'execute', home, undefined, now, report);
          continue;
        }
        // The future review of this task is judged with its review-stage independence too, so capacity is never reserved for a reviewer the policy excludes.
        const reviewScope = item.task.independence ? await this.deps.workforce.independenceScope(item.task.independence, 'review') : undefined;
        const reviewPlan = (recusal: ReviewRecusal, pool: EmployeeInst[] = insts) => reviewPlanOf(staffingPool({ ...poolBase,
          insts: pool, role: item.task.reviewerRole, home, task: item.task, excludeSubmitter: true, recusal, independence: reviewScope }));
        const plan = reviewPlan(authors);
        if (!plan.feasible) {
          const blocked = poolFor(item.role, home, item.task).map(entry => entry.eligible
            ? { ...entry, eligible: false, code: 'review_capacity' as const }
            : entry);
          await this.settleBlocked(item.task, 'execute', home,
            [...blocked, { key: '*', eligible: false, code: 'review_capacity' as const }], now, report, [],
            otherRepoCount(insts, item.role, home, this.deps.env.opsRepo));
          continue;
        }
        // An execute spawn takes a new seat of its def. That seat is not spare: the review must still have a reviewer
        // once it is counted, otherwise the spawn is held for this task.
        const held = new Set<string>(plan.reserve ? [plan.reserve] : []);
        for (const entry of poolFor(item.role, home, item.task)) {
          if (entry.kind !== 'spawn' || !entry.eligible) continue;
          const seat = { id: `pending:${entry.key}`, def: entry.ref, role: item.role, provider: entry.provider,
            model: entry.model, repoHome: home, cwd: home } as EmployeeInst;
          if (!reviewPlan({ authors: new Set([...authors.authors, seat.id]), hands: new Set() }, [...insts, seat]).feasible) held.add(entry.key);
        }
        if (held.size) {
          reserved = held;
          for (const key of held) report.decisions.push(`reserve:${item.task.id}=${key}`);
        }
      }
      // 验收独立性：review 派工先取本任务回避名单——提交过本任务的作者硬回避
      // （验收自己的交付等于没验收），仅 claim 过未提交的经手人降权兜底、不硬阻断。
      // 历史读失败时名单未知：记为 unknown 并留在队列，不派复核；读取恢复后自动继续。
      const recusal = item.purpose === 'review' ? await readReviewRecusal(wf, item.task, message => this.log(message)) : undefined;
      if (item.purpose === 'review' && recusal === undefined) {
        await this.settleBlocked(item.task, 'review', home, undefined, now, report);
        continue;
      }
      const pickItem = (role: string, task?: SupervisedTask, avoid?: string, excludeSubmitter = false,
        pickRecusal?: ReviewRecusal, anchorHome?: string) => pick(role, task, avoid, excludeSubmitter, pickRecusal, anchorHome, reserved);
      const spawnItem = (role: string, home: string, task?: SupervisedTask, forReview = false) =>
        spawnable(role, home, task, forReview, reserved);
      this.scopeDenied.delete(item.task.id);
      const result = await this.assign(item.role, item.task, last?.employee, pickItem, spawnItem,
        (inst, first, claim) => wake(inst, item.task, this.deps.env, first,
          { comm: !!this.deps.sidecar, claim, commDir: this.deps.sidecar?.commDirFor(inst.id), scratchDir: this.deps.sidecar?.scratchDirFor(inst.id) }), report, insts, item.purpose === 'review', slotMap, recusal);
      if (!result) {
        if (this.scopeDenied.delete(item.task.id)) {
          // The claim lost the write scope: the same reason the preflight gives, never a wake failure.
          const scope = (await this.writeScopeBlock(item.task)) ?? { code: 'write_scope' as const, text: BLOCK_TEXT.write_scope };
          await this.settleBlocked(item.task, item.purpose, home, undefined, now, report, [scope]);
          continue;
        }
        // Eligible candidates that still failed to wake or spawn are a runtime failure, not an empty pool. Entries held for
        // review capacity stay review_capacity here: they were never candidates, so they are not a wake failure.
        const entries = poolFor(item.role, home, item.task, item.purpose === 'review', recusal, reserved).map(entry => entry.eligible
          ? { ...entry, eligible: false, code: 'wake_failed' as const, reason: '唤醒或创建失败，下一轮重试' }
          : entry);
        await this.settleBlocked(item.task, item.purpose, home, entries, now, report, [],
          otherRepoCount(insts, item.role, home, this.deps.env.opsRepo));
        continue;
      }
      await this.clearBlocked(item.task, item.purpose);
      await wf.recordDispatch(item.task.id, item.task.version, item.purpose, result.id);
      running++;
      busyBy.set(result.provider ?? '', (busyBy.get(result.provider ?? '') ?? 0) + 1);
      assigned.add(result.id);
      report.woke.push({ task: item.task.id, employee: result.id, spawned: result.spawned });
    }
    if (unplaced.length) await this.markGlobal(unplaced, globalBlock('max_running'), now, report, true);

    // Manager actions: a ready/doing engineering task whose execute verdict needs a manager decision (unresolved
    // implementer, no automatic successor, or a persistent implementer quota failure) becomes a durable todo. The
    // same GmTodo feeds the gm prompt and the owner-facing verdict, so reason, action and time basis cannot drift.
    const tasksById = new Map(tasks.map(task => [task.id, task]));
    const workExecute = new Map(work.filter(item => item.purpose === 'execute').map(item => [item.task.id, item.task]));
    const managerActionCode = (verdict: DispatchVerdict): BlockCode | undefined => {
      const codes = verdict.reasons.map(reason => reason.code);
      if (codes.includes('implementer_unresolved')) return 'implementer_unresolved';
      if (codes.includes('implementer_quota')) return 'implementer_quota';
      if (codes.includes('implementer_unavailable')) return 'implementer_unavailable';
      return undefined;
    };
    type ManagerTodo = GmTodo & { purpose: string; key: string; episode: number; wakeEpisode: number; wakeReason: string; wakeDue: boolean };
    const managerTodos: ManagerTodo[] = [];
    for (const verdict of this.verdicts.values()) {
      if (verdict.phase !== 'execute') continue;
      const task = workExecute.get(verdict.taskId);
      if (!task || task.executorRole !== 'engineering') continue;
      const reasonCode = managerActionCode(verdict);
      if (!reasonCode) continue;
      const parsed = Date.parse(verdict.since ?? verdict.checkedAt);
      const episode = Number.isFinite(parsed) ? parsed : now * 1000;
      const key = managerActionKey(task.id, 'execute', episode, reasonCode);
      const purpose = `gm-manager-action:${key}`;
      let last: { at: number } | undefined;
      let wakeDue = false;
      try {
        last = await wf.lastDispatch(task.id, 0, purpose);
        wakeDue = !last || now - last.at >= cfg.redispatchMinutes * 60;
      } catch (error) {
        // Unknown throttle state is not a licence to wake again: keep the action and retry next pass.
        this.log(`manager action throttle read failed for ${task.id}: ${(error as Error).message}`);
      }
      managerTodos.push({ task, action: 'implementer_takeover', expectedVersion: task.version, reasonCode, verdict, episode, key, purpose,
        wakeEpisode: episode, wakeReason: reasonCode, wakeDue });
    }

    // Close todos that no longer describe the task; keep them on read failures and pass-wide gates.
    let openActions: ManagerActionRow[] | undefined;
    let managerReadFailed = false;
    if (typeof wf.openManagerActions === 'function') {
      try { openActions = await wf.openManagerActions(); }
      catch (error) { this.log(`manager action read failed: ${(error as Error).message}`); managerReadFailed = true; }
      if (openActions === undefined) {
        // Fail closed: without the persisted open set we cannot dedupe a new wake or prove an old todo is resolved.
        managerTodos.length = 0;
        managerReadFailed = true;
      }
    }
    if (openActions) {
      const currentByKey = new Map(managerTodos.map(todo => [todo.key, todo]));
      for (const action of openActions) {
        const current = currentByKey.get(action.key);
        if (current && current.task.implementer === action.implementer) continue;
        const task = tasksById.get(action.taskId);
        let resolution: string | undefined;
        if (!task || task.currentEmployee || !['ready', 'doing'].includes(task.state)) {
          resolution = 'task left the execute queue';
        } else if (task.implementer !== action.implementer) {
          resolution = 'implementer changed';
        } else {
          const verdict = this.verdicts.get(`${task.id}:execute`);
          const codes = verdict?.reasons.map(reason => reason.code) ?? [];
          // Unknown state and pass-wide gates are not evidence that the implementer problem is handled.
          if (verdict && codes.length && !codes.some(code => GLOBAL_KEEP.has(code)) && !codes.includes(action.reason as BlockCode)) {
            resolution = 'reason changed or cleared';
          }
        }
        if (resolution) {
          await wf.closeManagerAction(action, resolution).catch(error =>
            this.log(`manager action close failed for ${action.taskId}: ${(error as Error).message}`));
          if ((resolution === 'task left the execute queue' || resolution === 'implementer changed') && typeof wf.finishManagerWakesForTask === 'function') {
            await wf.finishManagerWakesForTask(action.taskId, resolution).catch(error =>
              this.log(`manager wake close failed for ${action.taskId}: ${(error as Error).message}`));
          }
        }
      }
    }

    // Persist current todos before waking: a wake without a durable todo cannot be deduped after a restart.
    for (const todo of managerTodos) {
      if (typeof wf.openManagerAction !== 'function') continue;
      try {
        await wf.openManagerAction({ taskId: todo.task.id, phase: 'execute', episode: todo.episode, reason: todo.reasonCode!,
          action: 'implementer_takeover', version: todo.task.version, repo: todo.task.repoPath ?? this.deps.env.opsRepo,
          implementer: todo.task.implementer });
      } catch (error) {
        this.log(`manager action open failed for ${todo.task.id}: ${(error as Error).message}`);
        todo.purpose = ''; // skip the wake below: it would have no durable todo
      }
    }

    type PendingGm = GmTodo & { purpose?: string; wakeEpisode: number; wakeReason: string;
      /** True when `wakeEpisode` is only a stand-in (the task version), not an episode start: see the SYS03 guard. */
      episodeUnknown?: boolean };
    const pendingGm: PendingGm[] = [];
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
      // Quota-gated block: gm hears about it once, stays quiet until the reset instant, then gets one
      // notice to resume. Inside the gate the 15-minute redispatch does not apply.
      const quotaUntil = task.quotaResetsAt;
      const gated = quotaUntil !== undefined && quotaUntil > now;
      if (gated && last) continue;
      const afterReset = quotaUntil !== undefined && !gated && (!last || last.at < quotaUntil);
      if (!gated && last && now - last.at < cfg.redispatchMinutes * 60 && !afterReset) continue;
      if (await this.breakLoop(task, cfg, report, gmLoopStats?.get(task.id)).catch(() => false)) continue;
      pendingGm.push({ task, action: 'resume', expectedVersion: task.version,
        wakeEpisode: task.dispatchBlockedSince ? task.dispatchBlockedSince * 1000 : task.version,
        episodeUnknown: !task.dispatchBlockedSince,
        wakeReason: 'blocked_to_gm' });
    }
    for (const todo of managerTodos) if (todo.purpose && todo.wakeDue) pendingGm.push(todo);

    // SYS03 AC01：拉起新会话前核验这个 episode 的最新处置状态。上一条待办可能已经被另一个经理处置完了
    // （resume/defer/依赖/retire/修复），或者正被另一位经理持活租约处理——这两种都不该再启动新会话。
    // 已被处置的旧待办连同它在飞的 manager wake 在本轮就关掉，所以下一轮它不会再变成"旧提醒"。
    // 读不到账本就整轮不发经理唤醒：宁可晚一轮，也不能凭一个读不到的 episode 再拉起一位经理。
    if (pendingGm.length && typeof wf.dispositionFacts === 'function') {
      const episodeKeys = [...new Set(pendingGm.map(todo => wf.episodeKey(todo.task.id, 'execute', todo.wakeEpisode)))];
      const taskIds = [...new Set(pendingGm.map(todo => todo.task.id))];
      let facts: Awaited<ReturnType<typeof wf.dispositionFacts>> | undefined;
      try { facts = await wf.dispositionFacts({ episodes: episodeKeys, tasks: taskIds }); }
      catch (error) { this.log(`disposition episode read failed: ${(error as Error).message}`); }
      if (!facts) {
        this.log('disposition episode state unavailable; suppressing all gm wake this pass');
        pendingGm.length = 0;
      } else {
        const kept: PendingGm[] = [];
        for (const todo of pendingGm) {
          // SYS03 AC01：episode 身份就是（任务, 阶段, 开始时刻）。只有身份相等，才谈得上"这个 episode 已被处置"。
          const exact = facts.byEpisode.get(wf.episodeKey(todo.task.id, 'execute', todo.wakeEpisode));
          // byTask 兜底只在"调度器认不出这次提醒的身份"时可用：门禁任务的持久起点会被调度器自己清掉
          // （见 dispositionFacts），提醒身上只剩任务版本号，按 episode 查必然落空。
          // 兜底只认**仍在处理中**（claimed）的行——活租约说明现在正有经理在处理这个门禁，不该再拉起第二位；
          // **decided 的行一律不兜底**：每个处置动作（resume/defer/retire/repair）都把任务带出经理门禁，
          // 所以"任务此刻还在门禁里 + 有一条已处置的行"只可能意味着那是一条旧 episode，而这个任务已经形成了
          // 全新的 episode；此时必须照常唤醒经理，否则这条提醒每轮都被旧处置压掉，任务永久饥饿（评审 AC01 缺口）。
          const fallback = exact ?? (todo.episodeUnknown ? facts.byTask.get(todo.task.id) : undefined);
          const row = exact ?? (fallback?.status === 'claimed' && fallback.holder && (fallback.leaseExpiresAt ?? 0) > now
            ? fallback : undefined);
          // 没有登记行是常态：这个 episode 还没有经理领过，照常唤醒。
          if (!row) { kept.push(todo); continue; }
          if (row.status === 'decided') {
            const resolution = `episode already disposed (${row.decision?.action ?? 'decided'})`;
            report.decisions.push(`gm-disposition-handled:${todo.task.id}`);
            await wf.resolveDecidedEpisode({ taskId: todo.task.id, phase: row.phase, episodeMs: row.sinceMs, resolution })
              .catch(error => this.log(`disposition episode close failed for ${todo.task.id}: ${(error as Error).message}`));
            continue;
          }
          // 活租约：决定还在路上，等同 MR02 的在飞 episode，不再拉起第二位经理。租约失效后这里自然放行。
          if (row.holder && (row.leaseExpiresAt ?? 0) > now) {
            report.decisions.push(`gm-disposition-held:${todo.task.id}`);
            continue;
          }
          kept.push(todo);
        }
        pendingGm.length = 0;
        pendingGm.push(...kept);
      }
    }

    // Every current episode, not only the ones whose throttle expired, keeps its in-flight
    // owner alive. Throttle controls a new wake; it must never release an old one.
    const activeWakeKeys = new Set<string>();
    for (const todo of managerTodos) activeWakeKeys.add(managerWakeKey(todo.task.id, 'execute', todo.wakeEpisode));
    for (const task of gmBlocked) activeWakeKeys.add(managerWakeKey(task.id, 'execute',
      task.dispatchBlockedSince ? task.dispatchBlockedSince * 1000 : task.version));
    for (const action of openActions ?? []) activeWakeKeys.add(managerWakeKey(action.taskId, 'execute', action.episode));

    // Restore the durable in-flight owner before any new external action. An unreadable
    // ownership set is not evidence that the previous GM is gone: fail closed for this pass.
    let wakeReadFailed = typeof wf.openManagerWakes !== 'function' || typeof wf.acquireManagerWake !== 'function';
    if (!wakeReadFailed) {
      let openWakes: ManagerWakeRow[] | undefined;
      try { openWakes = await wf.openManagerWakes!(); }
      catch (error) {
        this.log(`manager wake read failed: ${(error as Error).message}`);
      }
      if (openWakes === undefined) wakeReadFailed = true;
      else if (!managerReadFailed) {
        await this.reconcileManagerWakes(openWakes, activeWakeKeys, now, report);
      }
    }
    if (wakeReadFailed) {
      this.log('manager wake ownership unavailable; suppressing all gm wake this pass');
      pendingGm.length = 0;
    }

    const granted: Array<{ todo: PendingGm; claim: ManagerWakeClaim }> = [];
    for (const todo of pendingGm) {
      const home = todo.task.repoPath ?? this.deps.env.opsRepo;
      const noticeKey = `gm-unavailable:${home}`;
      // Use the exact same pools as assign, without acquiring a wake only to
      // immediately release it. This remains quiet across dispatcher restarts.
      if (!eligibleInsts('gm', home, undefined, false).length && !eligibleDefs('gm', home).length) {
        await this.notice(noticeKey, `项目 ${repoName(home)} 暂无可用经理；待办保留，检查经理编制、额度和容量。候选恢复后自动唤醒。`, report);
        continue;
      }
      await owner.resolveNotice(noticeKey);
      if (running >= cfg.maxRunning) continue;
      let claim: ManagerWakeClaim | undefined;
      try {
        claim = await wf.acquireManagerWake!({
          taskId: todo.task.id, phase: 'execute', episode: todo.wakeEpisode, reason: todo.wakeReason,
          version: todo.task.version, repo: todo.task.repoPath ?? this.deps.env.opsRepo,
        }, wf.newKey());
      } catch (error) {
        this.log(`manager wake acquire failed for ${todo.task.id}: ${(error as Error).message}`);
        continue;
      }
      if (!claim) {
        report.decisions.push(`gm-wake-held:${todo.task.id}`);
        continue;
      }
      granted.push({ todo, claim });
    }

    // An instance lives in one Paseo workspace (one project), so gm-attention dispatches
    // per repo: the group's readTask anchors pick home, per-project spawn quota,
    // readWorkspace resolution and the cwd/repoHome fallback on the repo the blocked
    // tasks actually belong to — a single anchorless assign would pin every project's
    // gm batch onto the ops repo tree. Only episodes that won the durable wake CAS are
    // in a group; an in-flight episode is never carried along in another GM's prompt.
    const gmGroups = new Map<string, Array<{ todo: PendingGm; claim: ManagerWakeClaim }>>();
    for (const item of granted) {
      const home = item.todo.task.repoPath ?? this.deps.env.opsRepo;
      const group = gmGroups.get(home);
      if (group) group.push(item); else gmGroups.set(home, [item]);
    }
    for (const group of gmGroups.values()) {
      if (running >= cfg.maxRunning) {
        for (const item of group) {
          await wf.finishManagerWake(item.claim, 'finished', 'max_running gate held the wake').catch(error =>
            this.log(`manager wake release failed for ${item.todo.task.id}: ${(error as Error).message}`));
        }
        continue;
      }
      let externalTouched = false;
      let externalStarted = false;
      const beforeExternal = async (inst: EmployeeInst, kind: 'send' | 'spawn') => {
        externalTouched = true;
        for (const item of group) {
          const marked = await wf.markManagerWakeRunning(item.claim, inst.id, kind === 'send' ? inst.paseoAgentId : undefined);
          if (!marked) throw new Error(`manager wake claim lost for ${item.todo.task.id}`);
        }
        externalStarted = true;
      };
      const afterExternal = async (inst: EmployeeInst, _kind: 'send' | 'spawn', agentId: string) => {
        for (const item of group) {
          const marked = await wf.markManagerWakeRunning(item.claim, inst.id, agentId);
          if (!marked) throw new Error(`manager wake binding lost for ${item.todo.task.id}`);
        }
      };
      let result: (EmployeeInst & { spawned: boolean }) | undefined;
      try {
        result = await this.assign('gm', undefined, undefined, pick, spawnable,
          (inst, first, claim, worktree) => gmAttention(inst, group.map(item => item.todo), this.deps.env, first, { comm: !!this.deps.sidecar, worktree, commDir: this.deps.sidecar?.commDirFor(inst.id), scratchDir: this.deps.sidecar?.scratchDirFor(inst.id) }), report, insts, false, slotMap, undefined, { task: group[0]!.todo.task }, { beforeExternal, afterExternal });
      } catch (error) {
        this.log(`manager wake assign failed: ${(error as Error).message}`);
      }
      if (!result) {
        for (const item of group) {
          if (externalTouched) {
            const reason = externalStarted ? 'external action result was not observed' : 'wake start write was uncertain';
            await wf.finishManagerWake(item.claim, 'unknown', reason, 'unknown').catch(error =>
              this.log(`manager wake unknown write failed for ${item.todo.task.id}: ${(error as Error).message}`));
            await this.notice(`manager-wake-unknown:${item.todo.task.id}`,
              `经理待办 ${item.todo.task.id} 的唤醒尝试已开始但结果未确认（${reason}）。待办与审计保留，本轮不会再次唤醒或 spawn 第二位 GM；恢复路径：等待 Paseo 状态明确，或人工确认会话后清理该 episode。`, report);
          } else {
            await wf.finishManagerWake(item.claim, 'finished', 'no external action was started').catch(error =>
              this.log(`manager wake release failed for ${item.todo.task.id}: ${(error as Error).message}`));
          }
        }
        continue;
      }
      for (const item of group) {
        const marked = await wf.markManagerWakeRunning(item.claim, result.id, result.paseoAgentId).catch(error => {
          this.log(`manager wake bind failed for ${item.todo.task.id}: ${(error as Error).message}`);
          return false;
        });
        if (!marked) {
          await wf.finishManagerWake(item.claim, 'unknown', 'wake binding update failed', 'unknown').catch(() => false);
        }
        if (item.todo.action === 'resume') await wf.recordDispatch(item.todo.task.id, item.todo.task.version, 'gm-attention', result.id);
        else if (item.todo.purpose) await wf.recordDispatch(item.todo.task.id, 0, item.todo.purpose, result.id);
      }
      running++;
      busyBy.set(result.provider ?? '', (busyBy.get(result.provider ?? '') ?? 0) + 1);
      assigned.add(result.id);
      report.woke.push(...group.map(item => ({ task: item.todo.task.id, employee: result!.id, spawned: result!.spawned })));
    }

    // SYS03 AC04：持久 outbox 的持有人通知。取消/依赖等待/恢复/撤租/接手/结果未知都已经和审计在同一个事务里落库，
    // 这里只负责把还没投递的通知送进仍在线、仍空闲的持有人会话——通道重连或插件重启后的补发走的是同一条路径。
    // 投递失败只把错误记在通知上、留待下一轮重试：已确认的决定不回滚，通知也不从待发队列里丢掉。
    if (running < cfg.maxRunning && typeof wf.pendingHolderNotices === 'function' && typeof wf.markHolderNotices === 'function') {
      let waiting: Awaited<ReturnType<typeof wf.pendingHolderNotices>> | undefined;
      try { waiting = await wf.pendingHolderNotices(HOLDER_NOTICE_BATCH); }
      catch (error) { this.log(`holder notice read failed: ${(error as Error).message}`); }
      for (const notice of waiting ?? []) {
        if (running >= cfg.maxRunning) break;
        // 持有人是员工 ID，会话只是它的一个实例：只投给这一轮还在线、空闲、且没被本轮派工的实例。
        const holder = insts.find(candidate => candidate.id === notice.holder && candidate.paseoAgentId
          && !assigned.has(candidate.id) && states.get(candidate.id) === 'idle');
        if (!holder) {
          // 会话不在线或正在别的活上：通知留着，下一轮再试，持有人也可以自己读 holder_notices。
          report.decisions.push(`holder-notice-wait:${notice.taskId}`);
          continue;
        }
        try {
          await paseo.send(holder.paseoAgentId!, holderNoticeText(notice));
          this.lastStatus.set(holder.paseoAgentId!, 'running');
          this.onboarded.add(holder.id);
          await wf.touchWake(holder.id);
          states.set(holder.id, 'busy');
          assigned.add(holder.id);
          running++;
          await wf.markHolderNotices([notice.noticeKey], { agent: holder.id });
          report.decisions.push(`holder-notice:${holder.id}:${notice.kind}`);
        } catch (error) {
          await wf.markHolderNotices([notice.noticeKey], { error: String((error as Error).message).slice(0, 200) }).catch(() => 0);
          this.log(`holder notice send failed for ${notice.holder}: ${(error as Error).message}`);
        }
      }
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
          (inst, first, claim, worktree) => gmTriage(inst, group, this.deps.env, first, { comm: !!this.deps.sidecar, worktree, commDir: this.deps.sidecar?.commDirFor(inst.id), scratchDir: this.deps.sidecar?.scratchDirFor(inst.id) }), report, insts, false, slotMap, undefined, { home, project: group[0].project });
        if (!result) continue;
        for (const goal of group) await wf.recordDispatch(`goal:${goal.id}`, 0, 'triage', result.id);
        running++;
        busyBy.set(result.provider ?? '', (busyBy.get(result.provider ?? '') ?? 0) + 1);
        assigned.add(result.id);
        report.woke.push(...group.map(g => ({ task: `goal:${g.id}`, employee: result.id, spawned: result.spawned })));
      }
    }

    await this.sweep(now);
    // Slow lazy pass over terminal-task artifacts: keeps evidence/deliverables from growing
    // without bound. Skipped when the resource gate already reclaimed above (pressure path).
    if (this.deps.reclaimArtifacts && !report.reclaimed) {
      // `now` here is server time in seconds, not epoch ms: keep the cadence clock local.
      const wall = Date.now();
      if (wall - this.lastArtifactSweep >= 30 * 60_000) {
        this.lastArtifactSweep = wall;
        const reclaimed = await this.deps.reclaimArtifacts({ trigger: 'sweep', dryRun: false }).catch(error => {
          this.log(`artifact reclaim failed: ${(error as Error).message}`); return undefined;
        });
        if (reclaimed && (reclaimed.trimmed.length || reclaimed.removedFiles)) {
          this.log(`artifact reclaim ${reclaimed.runId}: ${summarizeReclaim(reclaimed)}`);
          report.reclaimed = { tasks: new Set(reclaimed.trimmed.map(t => t.taskId)).size, files: reclaimed.removedFiles, freedBytes: reclaimed.freedBytes, trigger: reclaimed.trigger, pressure: false };
        }
      }
    }

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
        let fullHistory = task.row.model_eval_full_history===true;
        if (!dispatched && !fullHistory && jevReady && task.evalAttempts < 3) {
          const outcome = await this.jevEvaluate(task, cfg, report);
          if (outcome === 'done') { report.evals.push(task.id); continue; }
          if (outcome === 'retry') continue;
          if (outcome === 'full-history') fullHistory=true;
        }
        // quick-tier work is small by definition: the Jev verdict (even low-confidence) is good
        // enough, and a whole LLM judge session costs more than the task did. eval_quick_llm
        // re-enables escalation for quick tasks.
        const llmReady = fullHistory ? defs.some(d=>d.role==='eval' && d.enabled) : llmCapable && (cfg.evalQuickLlm || task.goalTier !== 'quick');
        if (!llmReady) {
          if (cfg.evalEngine === 'jev' || task.evalAttempts >= 3) {
            await this.notice(`eval-stuck:${task.id}`,
              `任务 ${task.id} 的绩效评审无法完成：${cfg.evalEngine === 'jev' ? 'eval_engine=jev 且 Jev 连续失败' : 'Jev 不可用/连续失败且没有启用的 eval 员工定义'}。检查 JEV_API_KEY 或改用 eval_engine=llm。`, report);
          }
          continue;
        }
        if (running >= cfg.maxRunning || dispatched) continue;
        const result = await this.assign('eval', undefined, last?.employee, pick, spawnable,
          (inst, first, claim, worktree) => evalPrompt(inst, task, this.deps.env, first, { comm: !!this.deps.sidecar, worktree, commDir: this.deps.sidecar?.commDirFor(inst.id), scratchDir: this.deps.sidecar?.scratchDirFor(inst.id) }), report, insts, false, slotMap, undefined, { task });
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
  private async jevEvaluate(task: SupervisedTask, cfg: CompanyConfig, report: TickReport): Promise<'done' | 'retry' | 'escalate' | 'full-history'> {
    const { workforce: wf, jev } = this.deps;
    if (!jev) return 'escalate';
    const attempts = await wf.bumpEvalAttempt(task.id);
    let parsed: JevScoreAnswers;
    try {
      const state = await wf.evalState(task.id);
      if(state.timelineTruncated && state.modelExecutions?.length) {
        await wf.requireFullModelEvaluation(task.id);
        return 'full-history'; // persisted across retries/restarts; eval reads complete paged history
      }
      const questions = jevEvalQuestions(state.participants);
      const modelJudgements: Array<{key:string;employee:string;model:string}> = [];
      for (const employee of state.participants) {
        const models = [...new Set((state.modelExecutions ?? []).filter(r=>r.employee===employee && r.model).map(r=>r.model!))];
        for (const model of models) {
          const key = `m${modelJudgements.length}`;
          modelJudgements.push({key,employee,model});
          questions[key] = {type:'score',instructions:`根据实际执行轮次和全部提交、退回、修复、最终验收记录，给员工 ${employee} 使用模型 ${model} 的实际贡献打1到5分。区分造成返工和修复返工，排除账号额度、网络等基础设施故障；不得按调用次数分配质量。证据不足时降低置信度。`,criteria:['1：严重缺陷造成返工','2：明显未达标','3：基本完成','4：可靠交付','5：高质量完成或有效修复']};
        }
      }
      const result = Object.keys(questions).length
        ? await jev.ask({
          task: { id: task.id, title: state.title, context: state.context, executorRole: state.executorRole, reviewerRole: state.reviewerRole },
          participants: state.participants,
          metrics: state.metrics,
          timeline: state.timeline,
          modelExecutions: state.modelExecutions,
        }, questions)
        : { model: jev.model, answers: {} };
      parsed = parseJevEval(state.participants, result.answers, cfg.jevFlagThreshold);
      for (const judgement of modelJudgements) {
        const answer = result.answers[judgement.key];
        const entry = parsed.scores.find(s=>s.employee===judgement.employee);
        if (entry && answer?.type==='score' && Number.isFinite(answer.score)) {
          (entry.modelScores ??= []).push({model:judgement.model,overall:Math.max(1,Math.min(5,answer.score!)),notes:'最终任务验收后的模型独立评价'});
          parsed.minConfidence = Math.min(parsed.minConfidence,answer.confidence ?? 0);
        } else parsed.minConfidence = 0;
      }
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

  /**
   * Reconcile persisted wake ownership against the external session state before a new
   * wake can be considered. running/initializing keeps ownership; idle after the turn
   * grace, archived, missing or error releases it for a controlled retry; unknown,
   * unreadable or mismatched evidence stays unknown and is never treated as idle.
   */
  private async reconcileManagerWakes(openWakes: ManagerWakeRow[], activeKeys: ReadonlySet<string>, now: number, report: TickReport): Promise<void> {
    const { workforce: wf, paseo, owner } = this.deps;
    for (const row of openWakes) {
      const claim = wf.wakeClaim(row);
      const noticeKey = `manager-wake-unknown:${row.taskId}`;
      if (!activeKeys.has(row.key)) {
        await wf.finishManagerWake(claim, 'finished', 'episode left the execute queue', row.lastStatus).catch(error =>
          this.log(`manager wake close failed for ${row.taskId}: ${(error as Error).message}`));
        await owner.resolveNotice(noticeKey).catch(() => undefined);
        continue;
      }
      // Pending with no external-start marker is only a crashed pre-assign attempt after a
      // conservative grace. A live concurrent dispatcher is inside that grace.
      if (row.state === 'pending' && !row.externalStartedAt) {
        if (now - (row.startedAt ?? 0) >= MANAGER_WAKE_PENDING_GRACE_SECONDS) {
          await wf.finishManagerWake(claim, 'finished', 'pending attempt expired before external action', row.lastStatus).catch(error =>
            this.log(`manager wake pending release failed for ${row.taskId}: ${(error as Error).message}`));
        }
        continue;
      }
      if (!row.agent) {
        const reason = row.externalStartedAt ? 'external action started without a bound agent' : 'agent not recorded';
        await wf.finishManagerWake(claim, 'unknown', reason, 'unknown').catch(error =>
          this.log(`manager wake unknown write failed for ${row.taskId}: ${(error as Error).message}`));
        await this.notice(noticeKey,
          `经理唤醒 ${row.taskId} 第 ${row.attempt} 次尝试无法核定 Paseo 会话（${reason}）。待办与审计保留，本轮不会再次唤醒；恢复路径：等待会话绑定恢复，或人工确认后清理该 episode。`, report);
        continue;
      }
      let observed: { status: string; pendingPermissions: number } | undefined;
      try {
        observed = await paseo.status(row.agent);
      } catch (error) {
        await wf.finishManagerWake(claim, 'unknown', `status read failed: ${(error as Error).message.slice(0, 120)}`, 'unknown').catch(() => false);
        await this.notice(noticeKey,
          `经理唤醒 ${row.taskId} 第 ${row.attempt} 次尝试状态读取失败。待办与审计保留，本轮不会再次唤醒；恢复路径：等待 Paseo 可读或人工确认。`, report);
        continue;
      }
      const status = observed?.status;
      if (status === 'running' || status === 'initializing') {
        await wf.markManagerWakeRunning(claim, row.employee ?? 'unknown', row.agent).catch(error =>
          this.log(`manager wake running write failed for ${row.taskId}: ${(error as Error).message}`));
        await owner.resolveNotice(noticeKey).catch(() => undefined);
        continue;
      }
      if (status === 'idle') {
        const since = row.externalStartedAt ?? row.startedAt ?? 0;
        if (since && now - since >= MANAGER_WAKE_TURN_GRACE_SECONDS) {
          await wf.finishManagerWake(claim, 'finished', 'session turn ended without resolving the manager todo', 'idle').catch(error =>
            this.log(`manager wake idle release failed for ${row.taskId}: ${(error as Error).message}`));
          await owner.resolveNotice(noticeKey).catch(() => undefined);
        }
        continue;
      }
      if (status === 'archived' || status === undefined) {
        await wf.finishManagerWake(claim, 'finished', status === 'archived' ? 'session archived' : 'session not found', status ?? 'missing').catch(error =>
          this.log(`manager wake invalid release failed for ${row.taskId}: ${(error as Error).message}`));
        await owner.resolveNotice(noticeKey).catch(() => undefined);
        continue;
      }
      if (status === 'error') {
        await wf.finishManagerWake(claim, 'finished', 'session error before resolving the manager todo', 'error').catch(error =>
          this.log(`manager wake error release failed for ${row.taskId}: ${(error as Error).message}`));
        await owner.resolveNotice(noticeKey).catch(() => undefined);
        continue;
      }
      await wf.finishManagerWake(claim, 'unknown', `unrecognized session state: ${status}`, 'unknown').catch(error =>
        this.log(`manager wake unknown state write failed for ${row.taskId}: ${(error as Error).message}`));
      await this.notice(noticeKey,
        `经理唤醒 ${row.taskId} 第 ${row.attempt} 次尝试处于未知状态（${status}）。待办与审计保留，本轮不会再次唤醒；恢复路径：等待 Paseo 状态明确，或人工确认会话后清理该 episode。`, report);
    }
  }

  private async assign(
    role: string, task: SupervisedTask | undefined, avoid: string | undefined,
    pick: (role: string, task?: SupervisedTask, avoid?: string, excludeSubmitter?: boolean, recusal?: ReviewRecusal, anchorHome?: string) => EmployeeInst | undefined,
    spawnable: (role: string, home: string, task?: SupervisedTask, forReview?: boolean) => EmployeeDef[],
    prompt: (inst: EmployeeInst, firstContact: boolean, claim?: ClaimResult, workspace?: WorktreeAssignment) => string,
    report: TickReport, insts: EmployeeInst[], forReview = false,
    slots?: Map<string, string>, recusal?: ReviewRecusal, anchor?: DispatchAnchor,
    hooks?: AssignHooks,
  ): Promise<(EmployeeInst & { spawned: boolean }) | undefined> {
    const { workforce: wf, paseo, env, sidecar } = this.deps;
    if (task && sidecar) {
      const deny = this.taskDeny.get(task.id);
      if (deny && deny.version === task.version && Date.now() - deny.at < CLAIM_DENY_COOLDOWN_MS) return undefined;
    }
    const defsOrdered = factoryFirst(spawnable(role, task?.repoPath ?? anchor?.task?.repoPath ?? anchor?.home ?? env.opsRepo, task, forReview));
    const candidate = pick(role, task ?? anchor?.task, avoid, forReview, recusal, anchor?.home);
    // A free Factory seat is used before an idle Claude session. Once Factory has no admitted
    // reuse or spawn candidate (quota, health, capacity, recusal), ordinary fallback takes over.
    const picked = candidate?.provider !== FACTORY_PROVIDER && defsOrdered.some(d=>d.provider===FACTORY_PROVIDER) ? undefined : candidate;
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
          // The candidate's own write-scope check first: a refused scope is no claim and no wake failure.
          if (await this.scopeBlocked(task, existing.id)) { this.scopeDenied.add(task.id); return undefined; }
          claim = await sidecar.claim(existing, task);
          if (!claim) {
            // A scope lost at claim time is task-wide, so it earns no cooldown: the next pass re-reads the holders.
            if (sidecar.claimDenial(existing.id) === 'worktree_busy') this.scopeDenied.add(task.id);
            else this.markDenied(task);
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
          // A refused retirement keeps this session: no respawn over it and no wake into the stale tree this pass.
          if (!await this.retireGated(existing, 'managed worktree workspace changed', 'rotation', report)) return undefined;
          await paseo.archive(existing.paseoAgentId!);
          sidecar!.detachAgent(existing.paseoAgentId!);
          report.retired.push(existing.id);
          const retiredAt = insts.indexOf(existing);
          if (retiredAt >= 0) insts.splice(retiredAt, 1);
          // Do not end the round here: fall through to the spawn path. A fresh
          // instance's claim re-resolves the same registered worktree, so its
          // spawn cwd matches by construction.
        } else {
          await hooks?.beforeExternal?.(existing, 'send');
          await paseo.send(existing.paseoAgentId!, prompt(existing, first, claim, workspace));
          await hooks?.afterExternal?.(existing, 'send', existing.paseoAgentId!);
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
    for (const def of defsOrdered) {
      const model = this.resolveModel(def, slots ?? new Map());
      if (!model) continue;
      // No seat is created for a task whose write scope is held: the preflight comes before the spawn.
      if (sidecar && task && await this.scopeBlocked(task)) { this.scopeDenied.add(task.id); return undefined; }
      const inst = await wf.spawnInst(def);
      const spawnEnv = sidecar ? sidecar.env(inst) : { SCK_EMPLOYEE_CREDENTIAL_FILE: wf.writeCredentialFile(inst, inst.credential!) };
      let claim: ClaimResult | undefined;
      let workspace: WorktreeAssignment | undefined;
      try {
        claim = sidecar && task ? await sidecar.claim(inst, task) : undefined;
        if (sidecar && !task) workspace = await sidecar.readWorkspace?.(inst, anchor?.task?.id, anchor?.project);
      }
      catch (error) {
        if (await this.retireGated(inst, 'allocation unavailable', 'failure', report)) {
          sidecar?.detachAgent(inst.paseoAgentId ?? '');
          report.retired.push(inst.id);
        }
        this.log(`allocation ${task?.id} waiting: ${(error as Error).message}`);
        return undefined;
      }
      if (sidecar && task && !claim) {
        // A scope lost at claim time is task-wide: no other def is tried, and the unbound seat is released.
        const scopeLost = sidecar.claimDenial(inst.id) === 'worktree_busy';
        if (scopeLost) this.scopeDenied.add(task.id); else this.markDenied(task);
        if (await this.retireGated(inst, scopeLost ? 'write scope held' : 'claim denied', 'failure', report)) report.retired.push(inst.id);
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
        await hooks?.beforeExternal?.(inst, 'spawn');
        const agentId = await paseo.spawn({
          title: `SCK · ${def.role} · ${inst.id}`, provider: def.provider, model, thinking: def.thinking,
          mode: UNATTENDED_MODE[def.provider], cwd: spawnCwd, workspaceTitle: instHome ? `SCK · ${inst.id}` : `SCK · ${def.id}`,
          labels: { company: 'surreal-ck', employee_id: inst.id, role: def.role, def: def.id },
          env: spawnEnv,
          prompt: prompt(inst, true, claim, workspace),
        });
        await hooks?.afterExternal?.(inst, 'spawn', agentId);
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
        if (await this.retireGated(inst, `spawn failed: ${message.slice(0, 200)}`, 'failure', report)) report.retired.push(inst.id);
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

  /**
   * Retires through the shared gate (SYS-DISP R1). A refusal writes nothing: the instance keeps its session, credential and lease,
   * so the caller must not archive, detach or respawn it, and the tick reports it as refused instead of retired. Returns false then.
   */
  private async retireGated(inst: EmployeeInst, reason: string, kind: RetirementKind, report: TickReport): Promise<boolean> {
    try {
      await this.deps.workforce.retire(inst.id, reason, kind);
      return true;
    } catch (error) {
      if (!isRetireRefused(error)) throw error;
      report.refused?.push(inst.id);
      this.log(`retire ${inst.id} refused (${reason}): ${(error as Error).message}`);
      return false;
    }
  }

  /** Returns false when the gate refused the retirement; the session is then left in place (see retireGated). */
  private async retireBroken(inst: EmployeeInst, reason: string, defs: EmployeeDef[], report: TickReport, countFailure = true, kind: RetirementKind = 'failure'): Promise<boolean> {
    if (!await this.retireGated(inst, reason, kind, report)) return false;
    if (inst.paseoAgentId) this.deps.sidecar?.detachAgent(inst.paseoAgentId);
    // The dead session is useless and its red "error" entry confuses the roster —
    // archive it (soft-delete, timeline kept) like session rotation already does.
    if (inst.paseoAgentId) await this.deps.paseo.archive(inst.paseoAgentId).catch(() => undefined);
    await this.archiveInstScene(inst);
    report.retired.push(inst.id);
    this.log(`retired ${inst.id}: ${reason}`);
    const def = defs.find(d => d.id === inst.def);
    if (def && countFailure) await this.countDefFailure(def, report);
    return true;
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

  /** The snapshot of this pass: the inputs it read, and the verdicts it recorded. */
  private async buildSnapshot(p: PassInputs): Promise<DispatchSnapshot> {
    const { workforce: wf, env } = this.deps;
    return snapshotOf(p, { opsRepo: env.opsRepo, sidecar: !!this.deps.sidecar, log: message => this.log(message) },
      [...this.verdicts.values()], wf);
  }

  /** One brief per local day, from the configured hour on; survives restarts via the stored notice key. `verdicts` are this pass's. */
  private async dailyBrief(now: number, cfg: CompanyConfig, report: TickReport, verdicts: DispatchVerdict[] = []) {
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
    const { summary, text } = renderBrief(await owner.briefData(now * 1000, date, capacity, verdicts));
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
