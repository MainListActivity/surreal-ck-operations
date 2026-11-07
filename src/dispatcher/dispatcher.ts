import { FACTORY_PROVIDER, FACTORY_WAIT_LIMIT, factoryFirst, factoryQueue, leaveFactoryQueue } from './provider-order.ts';
import { managedModel, employeeClientModel } from "../model-routing/policy.ts";
import type { OwnerDesk } from '../owner.ts';
import { LaneNoteStore } from '../lane-notes.ts';
import { OutboundMessageStore, renderMessage, type MessageStep, type OutboundMessage } from '../outbound-messages.ts';
import type { CompanyConfig, EmployeeDef, EmployeeInst, ProviderHealth, SupervisedTask, Workforce } from '../workforce.ts';
import { effectiveWeight, weightedOrder } from '../workforce.ts';
import type { ClaimResult, WorktreeAssignment, ModelSlots, ProviderQuota, RetirementKind, Role, WriteScopeHolder } from '../contracts.ts';
import { REQUIRED_TRACKS } from '../core.ts';
import { MAINTENANCE_WORKSPACE, UNATTENDED_MODE, goneSceneError, workspaceTitleOf, type PaseoGateway, type PaseoWorkspaceInfo } from './paseo.ts';
import { latestFindings } from './brief.ts';
import type { PromptEnv } from './prompts.ts';
import { sweepWorktrees, type GitGateway } from './worktrees.ts';
import { agingLevel, agingText, localDate, renderBrief, type RoleCapacity } from '../owner-brief.ts';
import type { ReclaimResult } from './worktree-registry.ts';
import type { ReclaimTrigger } from './worktree-reclaim.ts';
import { jevEvalQuestions, parseJevEval, type JevClient, type JevScoreAnswers } from './jev.ts';
import { continuitySession, finishedSessions, reclaimIdleSessions } from './idle-sessions.ts';
import { observeRuntimeIdle, reclaimMemoryLru } from './memory-lru.ts';
import { memoryBlocked, resourceBlocks, type HostResources } from './host.ts';
import type { ArtifactTrigger } from './artifact-reclaim.ts';
import type { ArtifactReclaimResult } from './artifact-sweeper.ts';
import { summarizeReclaim } from './artifact-sweeper.ts';
import { isRetireRefused } from '../retirement.ts';
import { BLOCK_TEXT, dispatchNoticeText, evaluateDispatch, globalBlock, repoName, reviewPlanOf, type BlockCode, type DispatchPhase, type DispatchVerdict, type EvaluatedEntry, type GlobalBlock, type WorkflowState } from './dispatch-blocked.ts';
export type { BlockCode, DispatchPhase, DispatchVerdict } from './dispatch-blocked.ts';

/**
 * Weight factor for a prior hand of a review task (SYS-DISP IR01): they claimed execute but never wrote code with
 * decisive evidence, so their review is still independent and eligible — at a demoted weight, exactly the pre-SYS-DISP
 * rule. Only a prior submitter on the task itself excludes them outright (prior_submitter).
 */
export const PRIOR_HAND_WEIGHT_FACTOR = 0.15;

/**
 * Deterministic order for an all-managed pool: the least recently woken instance first. A prior hand goes last, the same demotion
 * the weighted pick applies — never out of the pool, just after every fresh session. A session without a recorded wake sorts last:
 * nothing says it is the stalest. The caller passes `hands` for a review only; the execute path has no exclusion set.
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
/** A closed session holding work is resumed on this interval; until CLOSED_GRACE_SECONDS it is unknown, never down. */
const CLOSED_RELOAD_RETRY_SECONDS = 60;
const CLOSED_GRACE_SECONDS = 600;
/** A busy holder past stallMinutes keeps its turn while its timeline tail moved within this window. */
const ACTIVITY_WINDOW_SECONDS = 20 * 60;
/** Timeline activity extends a stalled busy holder up to this many stallMinutes without a checkpoint. */
const STALL_ACTIVITY_CAP = 3;
/** Two or more consecutive quota failures on the current holder, or an unknown reset, is persistent: a owner decision. */
const PERSISTENT_QUOTA_FAILURES = 2;
/** Pass-wide capacity gates and unknown state are not evidence that an owner todo is resolved. */
const GLOBAL_KEEP = new Set<BlockCode>(['paused', 'budget', 'resources', 'memory_pressure', 'disk_space', 'max_running', 'unknown']);
/** SYS03 AC04: holder notices delivered per pass, so a long backlog cannot turn one tick into hundreds of sends. */
const HOLDER_NOTICE_BATCH = 20;

/**
 * SYS03 AC04: the text a holder receives. Self-contained (task, episode, this attempt) and it points at the tool that
 * reads the newest decision, because the holder's own snapshot may predate it — the reminder itself is never the
 * authority on what happened to the episode.
 */
export const holderNoticeText = (notice: { taskId: string; episode: string; kind: string; text: string; deliveries: number; noticeKey: string }): string =>
  // 验收要求修订不是处置决定：持有人要读的是任务上下文里的修订正文，不是 disposition_status（那里不会有这次修订）。
  notice.kind === 'acceptance_amended'
    ? `【公司通知·验收要求修订】${notice.text}\n`
      + `任务 ${notice.taskId}，episode ${notice.episode}；这是第 ${notice.deliveries + 1} 次投递。\n`
      + `完整修订已追加到任务上下文：先 sck call read_task_text '{"taskId":"${notice.taskId}","field":"context"}' 读全文，按最新验收要求行事；`
      // JSON-escape the whole argument: noticeKey is opaque, and the text lands in a shell/JSON command line where a
      // raw control character would make the command unparsable. JSON.stringify keeps the argument valid JSON.
      + `读后用 sck call holder_notices '${JSON.stringify({ ids: [notice.noticeKey], ack: true })}' 回执。`
    : `【公司通知·${notice.kind}】${notice.text}\n`
      + `任务 ${notice.taskId}，episode ${notice.episode}；这是第 ${notice.deliveries + 1} 次投递。\n`
      + `你手上的状态可能已经过时：先用 sck call disposition_status '{"taskId":"${notice.taskId}"}' 读这个任务最新的处置与决定，`
      + `按最新决定行事，不要基于旧提醒重复动作。`;

/** `unknown`: the roster or pool has no observation for the session. It is never shown or treated as busy. */
export type InstState = 'busy' | 'idle' | 'sleeping' | 'down' | 'exhausted' | 'unknown';

// Provider admission (quota floors + health window) lives in src/provider-admission.ts so the FV06
// both readers of this pool read the exact same gate — the faces cannot drift.
import { availabilityOf, quotaBlockedProviders } from '../provider-admission.ts';
export { availabilityOf, quotaBlockedProviders };

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
  /** Internal planning pass: preserve static admission and quota, ignore temporary occupancy and provider preference. */
  qualificationOnly?: boolean;
  /** Global FIFO of work waiting for Factory; positions after three may use other providers. */
  factoryQueue?: ReadonlyMap<string, number>;
  role: string;
  home: string;
  task?: SupervisedTask;
  /** Review work never goes to the submitter. */
  excludeSubmitter?: boolean;
  /** Review exclusion: the task's prior submitters never review their own delivery (hard rule). `hands` = earlier claimants for rework demotion. */
  exclusion?: ReviewExclusion;
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

export function factoryWorkKey(role: string, task: SupervisedTask, review = false): string {
  const phase = review ? 'review' : task.state === 'blocked' || role !== task.executorRole ? 'owner' : 'execute';
  return `${task.id}:${role}:${phase}`;
}

export function factoryConfigured(defs: readonly EmployeeDef[], role: string, task?: SupervisedTask): boolean {
  return defs.some(def => def.enabled && def.provider === FACTORY_PROVIDER && def.role === role && trackOkFor(role as Role,task,def.tracks));
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
    (p.states.get(inst.id) === 'idle' || p.states.get(inst.id) === 'sleeping') ||
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
      if (p.qualificationOnly) return undefined;
      if (availabilityOf(p.health.get(provider), p.now) === 'probe') {
        return (p.busyBy.get(provider) ?? 0) === 0 ? undefined : ['probe_busy', BLOCK_TEXT.probe_busy];
      }
    }
    if (p.qualificationOnly) return undefined;
    return cap(provider, exempt) ? undefined : ['provider_capacity', BLOCK_TEXT.provider_capacity];
  };
  const gate = (_id?: string): Block | undefined => {
    const until=p.task?.row?.model_route_until;
    return until&&until>p.now?['quota','模型组暂不可用，等待通道恢复',new Date(until*1000).toISOString()]:undefined;
  };
  // Track gating: a task with discipline X only routes to defs whose tracks list covers X.
  const trackOk = (task: SupervisedTask | undefined, tracks: string[] | undefined) =>
    trackOkFor(p.role as Role, task, tracks);
  const inWorkspace = (inst: EmployeeInst): boolean => {
    if (!p.task) return true; // Repository-wide preview, not a dispatch decision.
    if (inst.workspaceScope) return inst.workspaceScope === 'maintenance';
    // Legacy sessions only continue already assigned work; never move them mid-flight.
    return !p.sidecar || [p.task.currentEmployee, p.task.previousEmployee].includes(inst.id);
  };
  const entries: StaffingEntry[] = [];
  for (const inst of p.insts) {
    if (inst.role !== p.role) continue;
    if ((inst.repoHome ?? inst.cwd ?? p.opsRepo) !== p.home) continue;
    if (!inWorkspace(inst)) continue;
    const def = p.defs.find(d => d.id === inst.def);
    // Prior-submitter exclusion and the execute gate come first: a candidate that can never take the task must not be reported as merely busy.
    const hit: Block | undefined =
      gate(inst.id) ??
      (p.exclusion?.authors.has(inst.id) ? ['prior_submitter', BLOCK_TEXT.prior_submitter] : undefined) ??
      (p.excludeSubmitter && inst.id === p.task?.submittedBy ? ['prior_submitter', BLOCK_TEXT.prior_submitter] : undefined) ??
      ((inst.def && !def) || (def && !def.enabled) ? ['def_disabled', BLOCK_TEXT.def_disabled] : undefined) ??
      (!p.qualificationOnly && !ready(inst) ? notReady(p.states.get(inst.id), inst.provider ?? '') : undefined) ??
      (!p.qualificationOnly && p.assigned?.has(inst.id) ? ['assigned', BLOCK_TEXT.assigned] : undefined) ??
      (!p.qualificationOnly && p.holding.has(inst.id) ? ['held', BLOCK_TEXT.held] : undefined) ??
      (p.sidecar && inst.credentialFile ? ['credential_file', BLOCK_TEXT.credential_file] : undefined) ??
      (!trackOk(p.task, def?.tracks) ? ['track_mismatch', BLOCK_TEXT.track_mismatch] : undefined) ??
      (!currentModel(inst) ? ['model_slot', BLOCK_TEXT.model_slot] : undefined) ??
      capHit(inst.provider ?? '', def?.quotaLimited === false, managedModel(def));
    // A prior hand (claim-only, never wrote code) stays eligible at a demoted weight: the pre-SYS-DISP review rule,
    // kept for ordinary tasks. A prior submitter on this task is still excluded (prior_submitter above).
    const priorHand = !hit && (p.exclusion?.hands.has(inst.id) ?? false);
    entries.push({ kind: 'reuse', key: inst.id, ref: inst.id, role: p.role,
      provider: inst.provider ?? '', model: inst.model ?? def?.model, def, inst,
      weight: (managedModel(def) ? 1 : effectiveWeight(def)) * (priorHand ? PRIOR_HAND_WEIGHT_FACTOR : 1),
      share: 0, eligible: !hit, reason: hit?.[1], code: hit?.[0], until: hit?.[2],
      note: priorHand ? '经手过本任务（未写码），降权兜底' : undefined });
  }
  for (const def of p.defs) {
    if (def.role !== p.role) continue;
    const resolved = resolveSlot(def);
    // A session waiting between turns is not using a seat: counting it would stall a role with few seats while its finished
    // sessions wait for review. maxRunning still bounds what actually runs on the host.
    const waiting = (i: EmployeeInst) => ['idle', 'sleeping'].includes(p.states.get(i.id) ?? '') && !p.holding.has(i.id) && !p.assigned?.has(i.id);
    const seats = p.insts.filter(i => i.def === def.id && (i.repoHome ?? i.cwd ?? p.opsRepo) === p.home &&
      inWorkspace(i) && !(p.sidecar && i.credentialFile) && !waiting(i)).length;
    const hit: Block | undefined =
      gate(undefined) ??
      (!def.enabled ? ['def_disabled', BLOCK_TEXT.def_disabled] : undefined) ??
      (!trackOk(p.task, def.tracks) ? ['track_mismatch', BLOCK_TEXT.track_mismatch] : undefined) ??
      (resolved === undefined ? ['model_slot', BLOCK_TEXT.model_slot] : undefined) ??
      (!p.qualificationOnly && seats >= def.maxInstances ? ['seat_full', `编制席位已满（${seats}/${def.maxInstances} 个实例，仓库 ${repoName(p.home)}）`] : undefined) ??
      capHit(def.provider, def.quotaLimited === false, managedModel(def));
    entries.push({ kind: 'spawn', key: `spawn:${def.id}`, ref: def.id, role: p.role,
      provider: def.provider, model: resolved ?? def.model, def,
      weight: managedModel(def) ? 1 : effectiveWeight(def), share: 0, eligible: !hit, reason: hit?.[1], code: hit?.[0], until: hit?.[2] });
  }
  const position = p.task ? p.factoryQueue?.get(factoryWorkKey(p.role,p.task,!!p.excludeSubmitter)) : undefined;
  const factoryOnly = !p.qualificationOnly &&
    (!p.task || !p.factoryQueue || (position !== undefined && position <= FACTORY_WAIT_LIMIT)) &&
    factoryConfigured(p.defs,p.role,p.task) && staffingPool({...p,qualificationOnly:true}).some(entry=>entry.provider===FACTORY_PROVIDER && entry.eligible);
  if(factoryOnly) for(const entry of entries) {
    if(entry.provider === FACTORY_PROVIDER || !entry.eligible) continue;
    entry.eligible=false;
    entry.code='factory_wait';
    entry.reason=position === undefined ? BLOCK_TEXT.factory_wait : `${BLOCK_TEXT.factory_wait}（第 ${position}/${FACTORY_WAIT_LIMIT} 个保留等待名额）`;
  }
  if(!p.qualificationOnly && position!==undefined && position>FACTORY_WAIT_LIMIT && !quotaOf(FACTORY_PROVIDER)) {
    for(const entry of entries) if(entry.provider!==FACTORY_PROVIDER && entry.eligible) {
      entry.note=[entry.note,`Factory 已保留 ${FACTORY_WAIT_LIMIT} 个等待项，本任务第 ${position} 项允许分流`].filter(Boolean).join('；');
    }
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
 * Review exclusion: a task's prior submitters never review it — nobody accepts their own
 * delivery — and a demoted weight for `hands`, who held an execute lease but never wrote code. Reviewing,
 * returning or accepting never makes someone an author (contributors.ts).
 */
export interface ReviewExclusion {
  /** Appears as actor of a submit audit row on this task: never reviews it. */
  authors: ReadonlySet<string>;
  /** Claimed execute but never submitted: eligible at PRIOR_HAND_WEIGHT_FACTOR. */
  hands: ReadonlySet<string>;
}

/** Shared audit-based exclusion lookup. Unknown history must never become an empty set. */
export async function readReviewExclusion(
  workforce: Pick<Workforce, 'contributors'>, task: SupervisedTask,
  log: (message: string) => void = () => {},
): Promise<ReviewExclusion | undefined> {
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

/** Task-scoped estimate; the public role/home pool stays independent of review exclusion. */
export async function reviewStaffingPreviews(
  tasks: readonly SupervisedTask[],
  base: Omit<StaffingInput, 'role' | 'home' | 'task' | 'excludeSubmitter' | 'exclusion'>,
  workforce: Pick<Workforce, 'contributors'>,
): Promise<ReviewStaffingPreview[]> {
  const previews: ReviewStaffingPreview[] = [];
  for (const task of tasks.filter(t => t.state === 'review' && t.reviewerRole !== 'owner' && !t.currentEmployee)) {
    const exclusion = await readReviewExclusion(workforce, task);
    const home = task.repoPath ?? base.opsRepo;
    const entries = staffingPool({ ...base, role: task.reviewerRole, home, task,
      excludeSubmitter: true, exclusion });
    previews.push({ taskId: task.id, title: task.title, purpose: 'review', role: task.reviewerRole, home,
      status: exclusion === undefined ? 'history_unavailable'
        : entries.some(entry => entry.eligible) ? 'ready' : 'blocked',
      entries: exclusion === undefined
        ? entries.map(e => ({ ...e, eligible: false, share: 0, code: 'unknown' as const, reason: BLOCK_TEXT.unknown }))
        : entries });
  }
  return previews;
}

export interface DispatcherDeps {
  workforce: Workforce;
  owner: OwnerDesk;
  /** Outbound message store. Injected; defaults to a store over workforce's DB when absent. */
  messages?: OutboundMessageStore;
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
   * System-initiated holder replacement: hands an execute-phase engineering task to a live engineer when the bound
   * holder's session is gone for good (the employee left, or the session is archived, quarantined, or parked in a
   * failure that cannot be restarted, or its repo no longer matches an explicit code-repo rebind). Returns true when the binding moved. Undefined disables the automatic successor:
   * the block then names the owner's takeover instead.
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
  /**
   * Adopted lease: re-establish the local claim (claim.json + channel proof) for a lease the
   * server already holds for this instance — it was assigned directly, so
   * no sidecar claim ran. Missing or failing = the wake still goes out but the channel may be cold.
   */
  adoptLease?(inst: EmployeeInst): Promise<void>;
  /**
   * FV06: bind a recovery read grant to the instance channel before a recovery wake. Refuses while an execution
   * lease is held; the grant stays issued/bound server-side and a later tick can retry.
   */
  adoptRecovery?(inst: EmployeeInst, grantId?: string): Promise<unknown>;
}

/** Jev-chosen override for one dispatch: force an existing instance, or skip reuse and spawn a chosen def. */

/**
 * Workspace anchor for task-less management dispatches (owner-attention, triage, eval).
 * `task` anchors by task identity: its repoPath picks the candidate home and its id
 * drives readWorkspace project resolution. `home`+`project` anchor a goal directly
 * when no task exists yet (triage): `home` is the resolved repo the candidate pool,
 * spawn cwd and repoHome bind to, `project` is the project id readWorkspace resolves.
 */
interface DispatchAnchor { task?: SupervisedTask; home?: string; project?: string }
interface PreparedOutbound { body: string; message: OutboundMessage; workdir?: string }
/** Optional hooks around the only external Paseo actions (send/spawn), used by the owner-wake CAS. */
interface AssignHooks {
  /** Durable successor CAS before allocating its lease. */
  beforeClaim?: (inst: EmployeeInst) => Promise<void>;
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
  factoryQueue?: Map<string, number>;
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
  /** FV06 recovery read grants woken this tick (grant ids only). */
  recovery?: string[];
  skipped?: 'paused' | 'budget' | 'resources';
}

/**
 * The snapshot of one pass (SYS-DISP R4): staffing pools, review previews and the ready queue, evaluated from the inputs that pass
 * read and the verdicts it recorded. The tick builds it at the end of every pass; tests build it from their own inputs, so the
 * owner-facing answers are measured against the same function the tick uses.
 */
export async function snapshotOf(p: PassInputs, opts: { opsRepo: string; sidecar: boolean; log?: (message: string) => void },
  verdicts: DispatchVerdict[], wf: Pick<Workforce, 'contributors' | 'readySince'>, at = Date.now()): Promise<DispatchSnapshot> {
  const busyBy = new Map<string, number>();
  for (const inst of p.insts) {
    if (p.states.get(inst.id) !== 'busy') continue;
    busyBy.set(inst.provider ?? '', (busyBy.get(inst.provider ?? '') ?? 0) + 1);
  }
  const holding = new Set(p.tasks.filter(t => t.currentEmployee).map(t => t.currentEmployee!));
  const poolBase = { defs: p.defs, insts: p.insts, states: p.states, holding, health: p.health, quotaBlocked: p.quotaBlocked,
    factoryQueue:p.factoryQueue, busyBy, providerMax: p.cfg.providerMax, slots: p.slots, runtimeModels: p.runtimeModels,
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
  /** agentId → when a closed session holding work was first seen; bounds how long it reads as unknown. */
  private readonly closedSince = new Map<string, number>();
  /** agentId → last timeline tail of a stalled busy holder, when it last changed, and the task it was holding. */
  private readonly activity = new Map<string, { tail: string; at: number; task: string }>();
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

  constructor(private readonly deps: DispatcherDeps) {
    // FV06 startup self-check: without the channel hook the 2a block is skipped whole, so recovery grants would sit
    // at issued with no wake and no trace. Say it once at start instead of silently doing nothing every tick.
    if (!this.deps.sidecar?.adoptRecovery) this.log('recovery wake disabled: sidecar hook missing');
  }
  private log(message: string) { this.deps.log?.(message); }
  /** Finished tasks' proposals take effect here, so every way a task can end goes through one path. Never blocks a pass. */
  private async settleLaneNotes(): Promise<void> {
    const database = (this.deps.workforce as unknown as { database?: { db?: unknown } }).database;
    if (!database?.db) return;
    try {
      const result = await new LaneNoteStore(database.db as never).settle();
      for (const lane of result.fullLanes) await this.deps.owner.raiseNotice(`lane_notes_full:${lane}`, `线 ${lane} 的笔记已到上限，新经验暂不生效，请在控制台删减`);
      for (const lane of result.openLanes) await this.deps.owner.resolveNotice(`lane_notes_full:${lane}`);
    } catch (error) { this.log(`lane notes settle failed: ${(error as Error).message}`); }
  }

  private messages?: OutboundMessageStore;
  private messagesTried = false;
  /** The store is optional: runtimes without one (tests, legacy) fall back to the built-in template. */
  private messageStore(): OutboundMessageStore | undefined {
    if (this.deps.messages) return this.deps.messages;
    if (this.messages) return this.messages;
    if (this.messagesTried) return undefined;
    this.messagesTried = true;
    try {
      const database = (this.deps.workforce as unknown as { database?: { db?: unknown } }).database;
      if (database?.db) this.messages = new OutboundMessageStore(database.db as never);
    } catch { this.messages = undefined; }
    return this.messages;
  }
  /**
   * The dispatch message is the latest draft's body, rendered with the receiving employee's real paths.
   * A held message raises the owner notice and returns null; no claim should be taken for it.
   * The store keeps the message in draft until the caller confirms the external send succeeded.
   */
  private async prepareOutbound(taskId: string, step: MessageStep, employeeId: string,
    workdir?: string, history?: ClaimResult['history'], opsRepo?: string): Promise<PreparedOutbound | null | undefined> {
    const store = this.messageStore();
    if (!store) return undefined;
    try {
      const prepared = await store.prepareSend(taskId, step, employeeId);
      if (!prepared) {
        await this.notice(`message-hold:${taskId}:${step}`,
          `任务 ${taskId} 的 ${step} 消息被标记「需要我放行」；请在消息流里放行后再派工。`,
          { commands: 0, revoked: [], extended: [], woke: [], retired: [], exhausted: [], notices: [], evals: [], decisions: [] });
        return null;
      }
      const findings = latestFindings(history);
      // Code dispatches name the task's own machine criterion id; plain steps carry no {acId} placeholder.
      const acId = step === 'execute' || step === 'rework' ? await store.machineCriterionId(taskId) : undefined;
      const body = renderMessage(prepared.body, {
        sckBin: this.deps.env.sckBin, commDir: this.deps.sidecar?.commDirFor(employeeId) ?? '$SCK_COMM_DIR',
        ...(findings ? { findingsFile: findings.file } : {}), taskId, ...(opsRepo ? { opsRepo } : {}),
        ...(acId ? { acId } : {}),
      });
      return { ...prepared, body, workdir };
    } catch (error) {
      // Fail closed: a legacy prompt here would bypass the owner's edit and hold.
      this.log(`outbound message read failed for ${taskId}: ${(error as Error).message}`);
      return null;
    }
  }

  /** The pre-claim hold check: the same draft the send path would read, without touching a lease. */
  private async heldMessage(taskId: string, step: MessageStep, report: TickReport): Promise<boolean> {
    const store = this.messageStore();
    if (!store) return false;
    try {
      if (!await store.isHeld(taskId, step)) return false;
      await this.notice(`message-hold:${taskId}:${step}`,
        `任务 ${taskId} 的 ${step} 消息被标记「需要我放行」；请在消息流里放行后再派工。`, report);
      return true;
    } catch (error) {
      this.log(`outbound hold read failed for ${taskId}: ${(error as Error).message}`);
      return true; // an unreadable hold gate fails closed: no claim, no version churn
    }
  }

  /** Render the table body with the workdir line. No write: the row stays draft until the external send landed. */
  private outboundBody(prepared: PreparedOutbound | null | undefined): string | null | undefined {
    if (!prepared) return prepared;
    return prepared.workdir ? `${prepared.body}\n工作目录：${prepared.workdir}` : prepared.body;
  }

  /** Lock the drafted message as sent, and close its hold notice, after the external send succeeded. */
  private async markOutbound(prepared: PreparedOutbound | null | undefined, employeeId: string): Promise<void> {
    if (!prepared) return;
    const store = this.messageStore();
    if (!store) return;
    try {
      await store.markSent(prepared.message.id, employeeId, prepared.message.body);
    } catch (error) {
      this.log(`outbound message sent-lock failed: ${(error as Error).message}`);
      return;
    }
    try {
      await this.deps.owner.resolveNotice(`message-hold:${prepared.message.taskId}:${prepared.message.step}`);
    } catch (error) {
      this.log(`failed to resolve message-hold notice for ${prepared.message.taskId}:${prepared.message.step}: ${(error as Error).message}`);
    }
  }


  /** Dispatch-blocked conclusions from the latest pass, keyed by task and phase. Dispatchable work is absent. */
  private readonly verdicts = new Map<string, DispatchVerdict>();
  /** Tasks whose claim lost the write scope to another writer in this pass: settled as write_scope, never as a wake failure. */
  private readonly scopeDenied = new Set<string>();

  /** Server-side dispatch-blocked conclusions from the latest pass; the roster, task cards and brief read these. */
  dispatchVerdicts(): DispatchVerdict[] {
    return [...this.verdicts.values()];
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
    const verdict = evaluateDispatch({ taskId: task.id, title: task.title, phase, home, entries, globalBlocks, otherRepo,
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
  private async markGlobal(work: ReadonlyArray<{ task: SupervisedTask; purpose: DispatchPhase }>, block: GlobalBlock | readonly GlobalBlock[],
    now: number, report: TickReport, notify = false): Promise<void> {
    for (const item of work) {
      const home = item.task.repoPath ?? this.deps.env.opsRepo;
      const { verdict, since } = await this.recordVerdict(item.task, item.purpose, home, undefined, now, Array.isArray(block)?block:[block as GlobalBlock]);
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

    const pendingTasks = this.deps.sidecar && insts.some(i => !i.paseoAgentId) ? await wf.tasks() : [];
    // 1. Session health.
    const states = new Map<string, InstState>();
    const observedStatus = new Map<string, string>();
    let openTasks: SupervisedTask[] | undefined;
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
        if (!inst.workspaceScope) await paseo.archive(inst.paseoAgentId).catch(() => undefined);
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
      if (status === 'closed') {
        openTasks ??= await wf.tasks();
        // Paseo's idle collector closes only the process; idle cleanup ends the session itself once it has waited long enough.
        // Leave unused runtimes asleep; send() restores the same persistence handle after a legal claim.
        if ((inst.workspaceScope || inst.runtimeSleepRequestedAt !== undefined) && !inst.activeTask && !openTasks.some(t => t.currentEmployee === inst.id) &&
            (!inst.def || defs.some(d => d.id === inst.def && d.enabled))) {
          states.set(inst.id, 'sleeping');
          this.closedSince.delete(inst.paseoAgentId);
          continue;
        }
        const resumed = await this.resumeClosed(inst, openTasks, now, report);
        if (resumed) {
          states.set(inst.id, resumed);
          if (resumed !== 'unknown') { observedStatus.set(inst.id, resumed); this.lastStatus.set(inst.paseoAgentId, resumed); }
          continue;
        }
      } else this.closedSince.delete(inst.paseoAgentId);
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
        if (stale && !(now - task.progressAt! <= cfg.stallMinutes * 60 * STALL_ACTIVITY_CAP &&
          await this.stillWorking(inst!.paseoAgentId!, task, cfg.stallMinutes, now))) {
          this.activity.delete(inst!.paseoAgentId!);
          await paseo.stop(inst!.paseoAgentId!).catch(() => undefined);
          await this.revoke(task, `员工 ${inst!.id} 超过 ${cfg.stallMinutes} 分钟没有任何 checkpoint，且会话已 ${ACTIVITY_WINDOW_SECONDS / 60} 分钟无动静或超过 ${cfg.stallMinutes * STALL_ACTIVITY_CAP} 分钟上限，已中止其会话`, inst, report);
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
        if(inst.paseoAgentId && !inst.workspaceScope) await paseo.archive(inst.paseoAgentId).catch(()=>undefined);
      }
    }
    insts = insts.filter(i => !report.retired.includes(i.id));

    // 2b. Jev decisions: goal triage, release go/no-go, owner-escalation routing. Undecided items stay with owner/product.
    const tasks = await wf.tasks();

    await observeRuntimeIdle({instances:insts,states,tasks,now,workforce:wf});
    await this.settleLaneNotes();

    // 2c. Session rotation: a session that has run many turns carries an ever-growing context,
    // so every further turn costs more input tokens. Retire idle instances past the configured
    // size/count and let the next task spawn a fresh, cheap session.
    {
      const holding = new Set(tasks.filter(t => t.currentEmployee).map(t => t.currentEmployee!));
      const bound = new Set<string>();
      const rotationHost = this.hostResources();
      const rotationSafe = !(rotationHost && memoryBlocked(rotationHost,cfg.minFreeMemMb));
      if (rotationSafe) {
        const idleRetired = await reclaimIdleSessions({ instances: insts, states, held: holding, bound, now,
          minutes: cfg.sessionIdleMinutes ?? 120, workforce: wf, paseo,
          archiveScene: inst => this.archiveInstScene(inst), log: text => this.log(text),
        }).catch(error => { this.log(`idle cleanup failed safely: ${(error as Error).message}`); return [] as string[]; });
        report.retired.push(...idleRetired);
      }
      if (rotationSafe && cfg.sessionPolicy === 'oneshot' && typeof wf.sessionTaskFacts === 'function') {
        const live = insts.filter(inst => inst.lastTask && !report.retired.includes(inst.id));
        const facts = live.length ? await wf.sessionTaskFacts([...new Set(live.map(inst => inst.lastTask!))])
          .catch(error => { this.log(`finished sessions unread: ${(error as Error).message}`); return undefined; }) : undefined;
        for (const inst of facts ? finishedSessions({ instances: live, states, held: holding, facts }) : []) {
          if (!await this.retireGated(inst, '一次性会话：任务已结束', 'rotation', report)) continue;
          await paseo.archive(inst.paseoAgentId!).catch(() => undefined);
          await this.archiveInstScene(inst);
          report.retired.push(inst.id);
          this.log(`retired ${inst.id}: task ${inst.lastTask} finished`);
        }
      }
      await this.closeFinishedWorkspaces(insts, report.retired)
        .catch(error => this.log(`workspace cleanup failed safely: ${(error as Error).message}`));
      let inspected = 0;
      for (const inst of insts) {
        if (!rotationSafe) break;
        if (report.retired.includes(inst.id) || states.get(inst.id) !== 'idle' || holding.has(inst.id) || bound.has(inst.id) || !inst.paseoAgentId) continue;
        // Sidecar mode: a credential-file instance can never take new work (the pool
        // refuses to claim for it), so an idle one only wastes a provider seat and
        // misleads Jev's staffing picks. Retire it on sight.
        const legacyEol = Boolean(this.deps.sidecar && inst.credentialFile);
        const maxWakes = cfg.sessionMaxWakesByRole?.[inst.role] ?? cfg.sessionMaxWakes;
        const overWakes = maxWakes > 0 && (inst.wakeCount ?? 0) >= maxWakes;
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
        const target = def ? resolveModel(def) : undefined;
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
    await this.ownerNotices(tasks, report, now);
    await this.ownerAging(now, report).catch(error => this.log(`owner aging failed: ${(error as Error).message}`));

    // 4. Work that needs an employee.
    const holding = new Set(tasks.filter(t => t.currentEmployee).map(t => t.currentEmployee!));
    const work = [
      ...tasks.filter(t => t.state === 'review' && t.reviewerRole !== 'owner' && !t.currentEmployee)
        .map(t => ({ task: t, role: t.reviewerRole, purpose: 'review' as const })),
      ...tasks.filter(t => (t.state === 'ready' || t.state === 'doing') && !t.currentEmployee)
        .map(t => ({ task: t, role: t.executorRole as string, purpose: 'execute' as const })),
    ];
    // Episodes of work that left the queue end here, before any pass-wide gate below returns early.
    await this.endStaleEpisodes(tasks, new Set(work.map(item => `${item.task.id}:${item.purpose}`)));
    const ownerBlocked: SupervisedTask[] = []; // owner retired: blocked-to-owner waits for the boss in the owner inbox
    const usable = [...new Set(defs.filter(d => d.enabled).filter(d =>
      d.quotaLimited === false || (this.available(health.get(d.provider), now) !== 'down' && !quotaBlocked.has(d.provider)),
    ).map(d => d.provider))];
    if ((work.length || ownerBlocked.length) && usable.length === 0) {
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
    let host = this.hostResources();
    if (host && memoryBlocked(host,cfg.minFreeMemMb) && (work.length || ownerBlocked.length)) {
      const slept = await reclaimMemoryLru({instances:insts,states,now,workforce:wf,paseo,log:text=>this.log(text)});
      if (slept) {
        states.set(slept.id,'sleeping');
        insts = insts.map(i=>i.id===slept.id?slept:i);
        this.passInputs.insts = insts;
        // One close per pass lets the kernel reclaim pages before sacrificing another warm context.
        const refreshed = this.hostResources();
        if (refreshed) host = refreshed;
      }
    }
    const headroom = cfg.artifactHeadroomMb ?? 0;
    const pressure = Boolean(host && host.freeDiskMb < cfg.minFreeDiskMb + headroom);
    let reclaimAttempt: ArtifactReclaimResult | undefined;
    if (pressure) {
      // Try to buy our way back with terminal-task artifacts before bailing out:
      // no new task can run until free space recovers, and reclaim takes real free
      // space away from nothing (clones only) while the probe is what decides.
      if (this.deps.reclaimArtifacts) {
        const targetFreeMb = cfg.minFreeDiskMb + (cfg.artifactHeadroomMb ?? 0);
        const reclaimed = reclaimAttempt = await this.deps.reclaimArtifacts({
          // Emergency: the config switch must not be able to deadlock dispatch; only the
          // env kill switch (SCK_ARTIFACT_RECLAIM=0) can, and then the notice says so.
          trigger: host && host.freeDiskMb < cfg.minFreeDiskMb ? 'pressure' : 'sweep', targetFreeMb, dryRun: false, emergency: true,
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
      const diskBlocked=host.freeDiskMb<cfg.minFreeDiskMb;
      const why = diskBlocked && reclaimAttempt?.disabled
        ? `；终态产物回收被${reclaimAttempt.disabledReason === 'env' ? '环境硬停（SCK_ARTIFACT_RECLAIM=0）' : '配置关闭（artifact_reclaim_enabled=false）'}，无法自动腾出空间`
        : '';
      await this.notice('resources',
        `宿主机资源不足，本轮暂停派工：内存压力 ${host.memoryPressure ?? '未知（按空闲内存判断）'}，空闲内存 ${host.freeMemMb} MB（下限 ${cfg.minFreeMemMb} MB）、空闲磁盘 ${(host.freeDiskMb / 1024).toFixed(1)} GB（下限 ${(cfg.minFreeDiskMb / 1024).toFixed(0)} GB）。在办任务不受影响，水位恢复后自动继续派工${why}。`, report);
      if (diskBlocked && reclaimAttempt?.disabled) {
        await this.notice('resources-reclaim-blocked',
          `资源闸门正在阻塞全部派工，但终态产物回收不可用（${reclaimAttempt.disabledReason === 'env' ? 'SCK_ARTIFACT_RECLAIM=0 环境硬停' : 'artifact_reclaim_enabled=false'}）。空闲磁盘 ${host.freeDiskMb} MB，低于下限 ${cfg.minFreeDiskMb} MB。请恢复回收配置，或用 admin reclaim-artifacts --execute 手工回收。`, report, { force: true });
      } else {
        await owner.resolveNotice('resources-reclaim-blocked');
      }
      await this.markGlobal(work, resourceBlocks(host,cfg.minFreeMemMb,cfg.minFreeDiskMb), now, report);
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
    const rand = this.deps.rand ?? Math.random;
    // The candidate pool is evaluated by staffingPool — the same function the owner
    // page previews — so dispatch gating and the roster can never drift apart.
    // Reserve only pending work; active owner turns are not waiting jobs.
    const activeOwnerTasks = new Set<string>();
    // no owner wake ownership: owner-blocked work stays in the owner inbox
    const factoryCanRoute = availabilityOf(health.get(FACTORY_PROVIDER),now) !== 'down' && !quotaBlocked.has(FACTORY_PROVIDER);
    const poolBase = { factoryQueue:undefined as Map<string,number>|undefined, defs, states, holding, health, quotaBlocked, busyBy,
      providerMax: cfg.providerMax, slots: slotMap, runtimeModels, opsRepo: this.deps.env.opsRepo,
      sidecar: !!this.deps.sidecar, now };
    const queueExclusions = new Map<string,ReviewExclusion|undefined>();
    for(const item of work.filter(item=>item.purpose==='review')) queueExclusions.set(item.task.id,await readReviewExclusion(wf,item.task,message=>this.log(message)));
    const factoryWaiting = factoryQueue([
      ...work.map(item=>({task:item.task,role:item.role,review:item.purpose==='review'})),
      
    ].filter(item=>factoryCanRoute && factoryConfigured(defs,item.role,item.task) &&
      (!item.review || queueExclusions.get(item.task.id)!==undefined) &&
      staffingPool({...poolBase,qualificationOnly:true,insts,role:item.role,home:item.task.repoPath??this.deps.env.opsRepo,task:item.task,
        excludeSubmitter:item.review,exclusion:item.review?queueExclusions.get(item.task.id):undefined,
                })
        .some(entry=>entry.provider===FACTORY_PROVIDER && entry.eligible))
      .map(item=>({key:factoryWorkKey(item.role,item.task,item.review),createdAt:Date.parse(String(item.task.row.created_at??''))||undefined})));
    this.passInputs.factoryQueue=factoryWaiting;
    poolBase.factoryQueue=factoryWaiting;
    // Reservation order takes precedence over the ordinary review-first order for queued Factory work.
    work.sort((a,b)=>(factoryWaiting.get(factoryWorkKey(a.role,a.task,a.purpose==='review'))??Infinity)-(factoryWaiting.get(factoryWorkKey(b.role,b.task,b.purpose==='review'))??Infinity));
    const poolFor = (role: string, home: string, task?: SupervisedTask, excludeSubmitter = false, exclusion?: ReviewExclusion) =>
      staffingPool({ ...poolBase, insts, role, home, task, excludeSubmitter, exclusion, assigned });
    const eligibleInsts = (role: string, home: string, task?: SupervisedTask, excludeSubmitter = false,
      exclusion?: ReviewExclusion) =>
      poolFor(role, home, task, excludeSubmitter, exclusion).flatMap(e => e.kind === 'reuse' && e.eligible ? [e.inst!] : []);
    // Every pool read names whether it is review work, so the execute gate can never leak into a reviewer spawn.
    const eligibleDefs = (role: string, home: string, task?: SupervisedTask, forReview = false) =>
      poolFor(role, home, task, forReview, undefined).flatMap(e => e.kind === 'spawn' && e.eligible ? [e.def!] : []);
    /**
     * A bound holder is struck when its session cannot take the task back: the employee is no longer live, or this
     * pass observed the session as down — archived, quarantined, or parked in a failure that cannot be restarted. Busy,
     * idle, exhausted and unknown are not struck unless the effective repository has left
     * that session outside the task's repository: waiting cannot move a repository-bound session.
     */
    const ready = (inst: EmployeeInst) => ['idle','sleeping'].includes(states.get(inst.id) ?? '') ||
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
      exclusion?: ReviewExclusion, anchorHome?: string) => {
      const home = task?.repoPath ?? anchorHome ?? this.deps.env.opsRepo;
      const eligible = eligibleInsts(role, home, task, excludeSubmitter, exclusion);
      // Oneshot: a task never lands on an unrelated session's context. No continuing session means a new one.
      if (cfg.sessionPolicy === 'oneshot' && task && role !== 'eval') return continuitySession(eligible, states, task, excludeSubmitter);
      const factory = eligible.filter(i => i.provider === FACTORY_PROVIDER);
      const candidates = factory.length ? factory : eligible;
      // A prior hand is demoted in the weighted pick (PRIOR_HAND_WEIGHT_FACTOR), exactly as in the pool.
      const weight = (inst: EmployeeInst) => effectiveWeight(defs.find(d => d.id === inst.def))
        * (exclusion?.hands.has(inst.id) ? PRIOR_HAND_WEIGHT_FACTOR : 1);
      // Continuity beats weights: the previous holder keeps the task when it is still available.
      // Review work never hits this: an author's former holder is already out; a claim-only
      // hand surviving as previousEmployee is continuity, not a conflict.
      // Rework continuity: the last submitter takes its own rework back when it is free; a claim-only
      // previous holder only counts when the task was never submitted.
      const continuation = task?.submittedBy ?? task?.previousEmployee;
      const previous = candidates.find(i => i.id === continuation && ['idle','sleeping'].includes(states.get(i.id) ?? ''));
      if (previous) return previous;
      // A dead (exhausted) session cannot prove a provider recovered; probe with a live one when possible.
      const live = candidates.filter(i => ['idle','sleeping'].includes(states.get(i.id) ?? ''));
      const usable = live.length ? live : candidates;
      const pool = usable.filter(i => i.id !== avoid);
      const available = pool.length ? pool : usable;
      if (available.length && available.every(i => managedModel(defs.find(d => d.id === i.def))))
        return managedRecencyOrder(available, exclusion?.hands)[0];
      return weightedOrder(available, weight, rand)[0];
    };
    const spawnable = (role: string, home: string, task?: SupervisedTask, forReview = false) =>
      eligibleDefs(role, home, task, forReview).every(managedModel)
        ? eligibleDefs(role, home, task, forReview).sort((a,b) => a.id.localeCompare(b.id))
        : weightedOrder(eligibleDefs(role, home, task, forReview), effectiveWeight, rand);

    // Legacy role-level staffing notices (staff:<role>) are superseded by per-task dispatch-blocked notices. Resolve any
    // still open from the previous version, including roles with no queued work, so no stale row is left in the inbox.
    for (const notice of await owner.openNotices()) {
      if (notice.key.startsWith('staff:')) await owner.resolveNotice(notice.key);
    }
    // Work is handled in queue order. Unreadable authorship fails closed for that item alone: it is recorded as unknown
    // and never guessed at, while the rest of the queue keeps moving. Items beyond the concurrency cap are recorded
    // after the loop as blocked by max_running.
    const unplaced: typeof work = [];
    const dispatchWorkItems = async (items: typeof work) => {
      for (const item of items) {
        if (running >= cfg.maxRunning) { unplaced.push(item); continue; }
        const home = item.task.repoPath ?? this.deps.env.opsRepo;
        const last = await wf.lastDispatch(item.task.id, item.task.version, item.purpose);
        if (last && now - last.at < cfg.redispatchMinutes * 60) continue;
        // 验收独立性：review 派工先取本任务回避名单——提交过本任务的作者硬回避
        // （验收自己的交付等于没验收），仅 claim 过未提交的经手人降权兜底、不硬阻断。
        // 历史读失败时名单未知：记为 unknown 并留在队列，不派复核；读取恢复后自动继续。
        const exclusion = item.purpose === 'review' ? queueExclusions.get(item.task.id) : undefined;
        if (item.purpose === 'review' && exclusion === undefined) {
          await this.settleBlocked(item.task, 'review', home, undefined, now, report);
          continue;
        }
        const pickItem = (role: string, task?: SupervisedTask, avoid?: string, excludeSubmitter = false,
          pickExclusion?: ReviewExclusion, anchorHome?: string) => pick(role, task, avoid, excludeSubmitter, pickExclusion, anchorHome);
        const spawnItem = (role: string, home: string, task?: SupervisedTask, forReview = false) =>
          spawnable(role, home, task, forReview);
        this.scopeDenied.delete(item.task.id);
        const result = await this.assign(item.role, item.task, last?.employee, pickItem, spawnItem,
          report, insts, item.purpose === 'review', slotMap, exclusion, undefined, undefined);
        if (!result) {
          // Eligible candidates that still failed to wake or spawn are a runtime failure, not an empty pool. Entries held for
          // non-eligible entries keep their own reason: they were never candidates, so they are not a wake failure.
          const entries = poolFor(item.role, home, item.task, item.purpose === 'review', exclusion).map(entry => entry.eligible
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
        leaveFactoryQueue(factoryWaiting,factoryWorkKey(item.role,item.task,item.purpose==='review'));
        report.woke.push({ task: item.task.id, employee: result.id, spawned: result.spawned });
      }
    };
    // Older owner work must get its chance before newer jobs borrow Factory capacity.
    const lateWork = work.filter(item => {
      const position=factoryWaiting.get(factoryWorkKey(item.role,item.task,item.purpose==='review'));
      return position!==undefined && [...factoryWaiting].some(([key,n])=>key.endsWith(':owner') && n<position);
    });
    const lateKeys=new Set(lateWork.map(item=>item.task.id));
    await dispatchWorkItems(work.filter(item=>!lateKeys.has(item.task.id)));
    if (unplaced.length) await this.markGlobal(unplaced, globalBlock('max_running'), now, report, true);

    // 老板岗位已撤销：执行窗口、依赖完成、阻塞与故障恢复都由老板在收件箱处理；调度器不再唤醒老板。
    // Factory 保留项在此按原有次序补派。
    const dispatchLateBefore = async (position = Infinity) => {
      const ready=lateWork.filter(item=>(factoryWaiting.get(factoryWorkKey(item.role,item.task,item.purpose==='review'))??Infinity)<position || position===Infinity);
      for(const item of ready) lateWork.splice(lateWork.indexOf(item),1);
      const before=unplaced.length;
      await dispatchWorkItems(ready);
      if(unplaced.length>before) await this.markGlobal(unplaced.slice(before),globalBlock('max_running'),now,report,true);
    };
    await dispatchLateBefore();

    // Jev 拿不准的目标留在老板收件箱，由老板通过 owner 接口分级；不再拉起老板分级会话。
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
        const fullHistory = task.row.model_eval_full_history===true;
        if (!dispatched && !fullHistory && jevReady && task.evalAttempts < 3) {
          const outcome = await this.jevEvaluate(task, cfg, report);
          if (outcome === 'done') { report.evals.push(task.id); continue; }
          if (outcome === 'retry') continue;
        }
      }
      // LLM eval is one batched message every eval_batch_hours (company_meta:config, default 24): it lists
      // at most 30 done task ids that are unscored or whose Jev verdict was low-confidence. No per-task
      // eval dispatch exists; the row is an owner-previewable outbound_message marked sent after the send.
      if (llmCapable && running < cfg.maxRunning) {
        const lastBatch = await wf.lastEvalBatchAt().catch(() => 0);
        if (Date.now() - lastBatch >= cfg.evalBatchHours * 3_600_000) {
          const batch = await wf.pendingEvalBatch(cfg.jevMinConfidence, 30).catch(() => []);
          const store = this.messageStore();
          if (batch.length && store) {
            const draft = await store.createDraft(batch[0].id, 'eval', 'eval', false, 'done',
              `按 agents/eval.md 的评分规则为以下完成任务的本轮参与员工逐个 record_score：${batch.map(task => task.id).join('、')}。`)
              .catch(() => undefined);
            if (draft && (draft.hold || draft.state === 'held')) {
              await this.notice(`message-hold:${batch[0].id}:eval`,
                `任务 ${batch[0].id} 的 eval 批量消息被标记「需要我放行」；请在消息流里放行后再派工。`, report);
            } else if (draft) {
              const body = renderMessage(draft.body, { sckBin: this.deps.env.sckBin, commDir: '$SCK_COMM_DIR',
                taskId: batch[0].id, opsRepo: this.deps.env.opsRepo });
              const prepared: PreparedOutbound = { message: draft, body };
              const result = await this.assign('eval', undefined, undefined, pick, spawnable,
                report, insts, false, slotMap, undefined, { task: batch[0] }, undefined, prepared);
              if (result) {
                await wf.recordDispatch(batch[0].id, batch[0].version, 'eval', result.id);
                running++;
                busyBy.set(result.provider ?? '', (busyBy.get(result.provider ?? '') ?? 0) + 1);
                assigned.add(result.id);
                report.evals.push(...batch.map(task => task.id));
                report.woke.push({ task: batch[0].id, employee: result.id, spawned: result.spawned });
              }
            }
          }
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
      const quickNoEscalate = false;
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

  /** `auto:<family>` resolves through the plugin-maintained slot map; literal model ids pin. */
  private resolveModel(def: EmployeeDef, slots: Map<string, string>): string | undefined {
    if (managedModel(def)) return employeeClientModel(def.role);
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
    pick: (role: string, task?: SupervisedTask, avoid?: string, excludeSubmitter?: boolean, exclusion?: ReviewExclusion, anchorHome?: string) => EmployeeInst | undefined,
    spawnable: (role: string, home: string, task?: SupervisedTask, forReview?: boolean) => EmployeeDef[],
    report: TickReport, insts: EmployeeInst[], forReview = false,
    slots?: Map<string, string>, exclusion?: ReviewExclusion, anchor?: DispatchAnchor,
    hooks?: AssignHooks, evalMessage?: PreparedOutbound,
  ): Promise<(EmployeeInst & { spawned: boolean }) | undefined> {
    const { workforce: wf, paseo, env, sidecar } = this.deps;
    const stepFor = (claim?: ClaimResult): MessageStep => task?.state === 'review' ? 'review'
      : claim?.history?.some(h => h.action === 'return' || h.action === 'owner_reject') ? 'rework' : 'execute';
    const nextStep = async (claim?: ClaimResult): Promise<MessageStep> => {
      if (!task) return stepFor(claim);
      return await this.messageStore()?.nextStep(task.id).catch(() => undefined) ?? stepFor(claim);
    };
    // The owner can hold a message before we claim: no lease, no version bump, no audit row this tick.
    // Both the reuse and spawn paths share this gate; the post-claim read stays as a backstop.
    const preStep = await nextStep(undefined);
    if (task && await this.heldMessage(task.id, preStep, report)) return undefined;
    if (task && sidecar) {
      const deny = this.taskDeny.get(task.id);
      if (deny && deny.version === task.version && Date.now() - deny.at < CLAIM_DENY_COOLDOWN_MS) return undefined;
    }
    const scopeTask = task ?? anchor?.task;
    const repoHome = scopeTask?.repoPath ?? anchor?.home ?? env.opsRepo;
    let defsOrdered = factoryFirst(spawnable(role, repoHome, scopeTask, forReview));
    const candidate = pick(role, scopeTask, avoid, forReview, exclusion, anchor?.home);
    // A free Factory seat is used before an idle Claude session. Once Factory has no admitted
    // reuse or spawn candidate (quota, health, capacity, exclusion), ordinary fallback takes over.
    // A session continuing its own work keeps it: its context is why it was picked.
    const continuing = candidate !== undefined && (await wf.config()).sessionPolicy === 'oneshot';
    const picked = !continuing && candidate?.provider !== FACTORY_PROVIDER && defsOrdered.some(d=>d.provider===FACTORY_PROVIDER) ? undefined : candidate;
    // A legacy credential-file session can't be sidecar-claimed for new work; let
    // it finish what it holds and fall through to spawning a comm-mode instance.
    const pending = sidecar && picked && !picked.paseoAgentId ? picked : undefined;
    if (pending) defsOrdered = (await wf.defs()).filter(d => d.id === pending.def && d.enabled);
    const existing = picked?.paseoAgentId && !(sidecar && task && picked.credentialFile) && (!sidecar || sidecar.canReuse(picked)) ? picked : undefined;
    if (existing) {
      const first = !this.onboarded.has(existing.id) && !existing.onboarded;
      let claim: ClaimResult | undefined;
      let workspace: WorktreeAssignment | undefined;
      try {
        if (sidecar && !task) workspace = await sidecar.readWorkspace?.(existing, anchor?.task?.id, anchor?.project);
        if (sidecar && task) {
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
        const sceneBound = !existing.workspaceScope && (!instHome || existing.cwd !== instHome);
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
          const prepared = evalMessage ?? (task ? await this.prepareOutbound(task.id, await nextStep(claim), existing.id,
            (claim?.worktree ?? workspace)?.worktreePath, claim?.history, env.opsRepo) : null);
          if (task && prepared === null) {
            if (claim) await sidecar!.releaseClaim(existing.id, task.id, '派工消息需要老板放行，已收回本次预领租约并等待放行');
            return undefined;
          }
          const body = this.outboundBody(prepared);
          if (task && body === null) {
            if (claim) await sidecar!.releaseClaim(existing.id, task.id, '派工消息读取失败，已收回本次预领租约等待重试');
            return undefined;
          }
          if (body === undefined) {
            if (claim && task) await sidecar!.releaseClaim(existing.id, task.id, '无待发消息行，已收回本次预领租约并等待生成');
            this.log(`no outbound message for ${task?.id ?? `dispatch:${role}`}; skip send to ${existing.id}`);
            return undefined;
          }
          await hooks?.beforeExternal?.(existing, 'send');
          await paseo.send(existing.paseoAgentId!, body!);
          await this.markOutbound(prepared ?? undefined, existing.id);
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
      const inst = pending ?? await wf.spawnInst(def, repoHome, sidecar ? 'maintenance' : undefined);
      let spawnEnv: Record<string, string>;
      let claim: ClaimResult | undefined;
      let workspace: WorktreeAssignment | undefined;
      try {
        await hooks?.beforeClaim?.(inst);
        spawnEnv = sidecar ? sidecar.env(inst) : { SCK_EMPLOYEE_CREDENTIAL_FILE: wf.writeCredentialFile(inst, inst.credential!) };
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
        // Goal conversations live at the repository root; private comm remains per employee.
        // Worktree allocation stays in claim.json and never changes the Paseo workspace.
        // Legacy instances keep their existing launch directory until normal retirement.
        const instHome = sidecar?.commDirFor(inst.id);
        const workspaceScope = inst.workspaceScope ?? (sidecar ? 'maintenance' : undefined);
        const spawnCwd = workspaceScope ? repoHome : instHome ?? (claim?.worktree ?? workspace)?.worktreePath ?? repoHome;
        // A workspace-scoped session keeps its repo-root cwd, but the workdir line must still name the claim's tree.
        const workdir = (claim?.worktree ?? workspace)?.worktreePath ?? spawnCwd;
        const prepared = evalMessage ?? (task ? await this.prepareOutbound(task.id, await nextStep(claim), inst.id,
          workdir, claim?.history, env.opsRepo) : null);
        if (task && prepared === null) {
          if (claim) await sidecar!.releaseClaim(inst.id, task.id, '派工消息需要老板放行，已收回本次预领租约并等待放行');
          return undefined;
        }
        const body = this.outboundBody(prepared);
        if (task && body === null) {
          if (claim) await sidecar!.releaseClaim(inst.id, task.id, '派工消息读取失败，已收回本次预领租约等待重试');
          return undefined;
        }
        if (task && body === undefined) {
          if (claim) await sidecar!.releaseClaim(inst.id, task.id, '无待发消息行，已收回本次预领租约并等待生成');
          this.log(`no outbound message for ${task.id}; skip spawn for ${inst.id}`);
          return undefined;
        }
        await hooks?.beforeExternal?.(inst, 'spawn');
        const container = await this.sessionWorkspace(task ?? anchor?.task, spawnCwd, repoHome);
        const agentId = await paseo.spawn({
          title: `SCK · ${def.role} · ${inst.id}`, provider: def.provider, model, thinking: def.thinking,
          mode: UNATTENDED_MODE[def.provider], cwd: spawnCwd,
          ...container,
          repoHome,
          labels: { company: 'surreal-ck', employee_id: inst.id, role: def.role, def: def.id },
          env: spawnEnv,
          prompt: body!,
        });
        await this.markOutbound(prepared ?? undefined, inst.id);
        await hooks?.afterExternal?.(inst, 'spawn', agentId);
        const cwd = spawnCwd;
        await wf.bind(inst.id, { agentId, cwd, repoHome, model, workspaceScope, paseoWorkspace: container.workspaceId });
        sidecar?.bindAgent(inst.id, agentId);
        const bound = { ...inst, paseoAgentId: agentId, cwd, repoHome, model, workspaceScope, paseoWorkspace: container.workspaceId };
        const prior = insts.findIndex(row => row.id === inst.id);
        if (prior >= 0) insts[prior] = bound; else insts.push(bound);
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

  /**
   * A Paseo daemon restart leaves every session `closed`: the process is gone, the conversation is not, and
   * `agent reload` brings it back from persistence. Read as down, a closed holder is struck and its code is
   * handed to another seat that is just as closed. A closed session that holds a lease or is bound to ready/doing
   * work is resumed in place instead; a lease holder is told to continue, since its interrupted turn will not. A
   * session with no work keeps the retirement path, so one restart does not relaunch every idle seat at once.
   * While resuming fails it stays unknown — not struck, not dispatched — for CLOSED_GRACE_SECONDS.
   */
  private async resumeClosed(inst: EmployeeInst, tasks: SupervisedTask[], now: number, report: TickReport): Promise<InstState | undefined> {
    const agent = inst.paseoAgentId!;
    const holding = tasks.find(t => t.currentEmployee === inst.id);
    if (!holding) {
      this.closedSince.delete(agent);
      return undefined;
    }
    const since = this.closedSince.get(agent) ?? now;
    this.closedSince.set(agent, since);
    if (now - (this.reloadAt.get(agent) ?? 0) >= CLOSED_RELOAD_RETRY_SECONDS) {
      this.reloadAt.set(agent, now);
      try {
        await this.deps.paseo.reload(agent);
        this.closedSince.delete(agent);
        (report.recovered ??= []).push(inst.id);
        this.log(`recovered ${inst.id}: closed session resumed in place${holding ? ` holding ${holding.id}` : ''}`);
        if (!holding) return 'idle';
        try {
          const delivered = await this.sendNotice(holding.id, 'notice', agent, inst.id,
            `公司服务重启打断了上一轮，任务 ${holding.id} 仍在你名下，从中断处继续。`);
          return delivered ? 'busy' : 'idle';
        } catch (error) {
          this.log(`resume notice to ${inst.id} failed: ${(error as Error).message}`);
          return 'idle';
        }
      } catch (error) {
        this.log(`resume closed ${inst.id} failed: ${(error as Error).message}`);
      }
    }
    return now - since < CLOSED_GRACE_SECONDS ? 'unknown' : undefined;
  }

  /**
   * progress_at moves only on checkpoint, so a long build or test run looks exactly like a hung turn. A busy holder
   * past stallMinutes keeps its turn while its timeline tail keeps changing; one whose tail stood still for
   * ACTIVITY_WINDOW_SECONDS is hung. The first stalled sighting of a task also asks the employee for a checkpoint.
   */
  private async stillWorking(agent: string, task: SupervisedTask, stallMinutes: number, now: number): Promise<boolean> {
    const tail = await this.deps.paseo.logsTail(agent, 20).catch(() => undefined);
    if (tail === undefined) return false;
    const seen = this.activity.get(agent);
    if (!seen || seen.task !== task.id) {
      this.activity.set(agent, { tail, at: now, task: task.id });
      await this.sendNotice(task.id, 'nudge', agent, task.currentEmployee ?? '',
        `任务 ${task.id} 已 ${stallMinutes} 分钟没有 checkpoint，到下一个节点调用 sck call checkpoint 写明进展。`);
      this.log(`stalled ${task.id}: busy holder still observed, checkpoint requested`);
      return true;
    }
    if (seen.tail !== tail) this.activity.set(agent, { tail, at: now, task: task.id });
    return now - this.activity.get(agent)!.at < ACTIVITY_WINDOW_SECONDS;
  }

  /**
   * System notices (resume, stall): every send still passes through outbound_message so the owner can
   * preview and hold it. The row is created, sent verbatim (no template), and marked sent only after
   * the external send succeeded; a send failure leaves the draft for the next pass.
   */
  private async sendNotice(taskId: string, step: MessageStep, agent: string, employeeId: string, text: string): Promise<boolean> {
    const store = this.messageStore();
    if (!store) return false;
    let messageId = '';
    try {
      const draft = await store.createDraft(taskId, step, 'system', false, 'doing', text);
      messageId = draft.id;
      const body = renderMessage(text, { sckBin: this.deps.env.sckBin, commDir: this.deps.sidecar?.commDirFor(employeeId) ?? '$SCK_COMM_DIR', taskId });
      await this.deps.paseo.send(agent, body);
      await store.markSent(messageId, employeeId, text);
      return true;
    } catch (error) {
      this.log(`${step} notice to ${agent} failed: ${(error as Error).message}`);
      return false;
    }
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
    // Revoke the identity and stop its process, keeping goal conversation history visible.
    if (inst.paseoAgentId && inst.workspaceScope && kind !== 'archive') await this.deps.paseo.stop(inst.paseoAgentId).catch(() => undefined);
    if (inst.paseoAgentId && !inst.workspaceScope) await this.deps.paseo.archive(inst.paseoAgentId).catch(() => undefined);
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

  /** A Paseo workspace holds the sessions of one goal: every task of a chain lands in its root's container. */
  private async sessionWorkspace(task: { id: string; title?: string } | undefined, cwd: string, repoHome: string): Promise<{ workspaceId?: string; workspaceTitle: string }> {
    const { paseo, workforce: wf } = this.deps;
    if (!task) return { workspaceTitle: MAINTENANCE_WORKSPACE };
    if (typeof wf.chainRoot !== 'function' || typeof paseo.createWorkspace !== 'function') return { workspaceTitle: workspaceTitleOf(task.title) };
    const root = await wf.chainRoot(task.id);
    const workspaceTitle = workspaceTitleOf(root.title);
    const known = root.workspaces.find(w => w.cwd === cwd);
    if (known && (await paseo.listWorkspaces()).some(w => w.workspaceId === known.id)) return { workspaceId: known.id, workspaceTitle };
    const workspaceId = await paseo.createWorkspace(workspaceTitle, cwd, repoHome);
    await wf.saveChainWorkspaces(root.id, [...root.workspaces.filter(w => w.cwd !== cwd), { cwd, id: workspaceId }]);
    return { workspaceId, workspaceTitle };
  }

  /** A finished goal's container goes once its last session is off the roster; archiving it ends whatever is still inside. */
  private async closeFinishedWorkspaces(insts: EmployeeInst[], retired: string[]) {
    const { paseo, workforce: wf } = this.deps;
    if (typeof wf.finishedChains !== 'function') return;
    const occupied = new Set(insts.filter(inst => !retired.includes(inst.id)).map(inst => inst.paseoWorkspace));
    for (const chain of await wf.finishedChains()) {
      const kept = chain.workspaces.filter(w => occupied.has(w.id));
      for (const workspace of chain.workspaces.filter(w => !occupied.has(w.id))) {
        try { await paseo.archiveWorkspace(workspace.id); }
        catch (error) { if (!goneSceneError(error)) { kept.push(workspace); this.log(`workspace ${workspace.id} kept: ${(error as Error).message}`); } }
      }
      if (kept.length !== chain.workspaces.length) await wf.saveChainWorkspaces(chain.id, kept);
    }
  }

  private async countDefFailure(def: EmployeeDef, report: TickReport) {
    const streak = await this.deps.workforce.defFailure(def.id);
    if (streak >= 3) {
      await this.deps.workforce.disableDef(def.id, `连续 ${streak} 次会话异常`);
      await this.notice(`def:${def.id}`, `员工定义 ${def.id}（${def.provider}/${def.model}）连续 ${streak} 次启动或运行异常，已自动停用。请检查该订阅/模型后在 employee_def 中重新启用。`, report);
    }
  }

  private async ownerNotices(tasks: SupervisedTask[], report: TickReport, nowSec: number = Date.now() / 1000) {
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

  /** True when the task kept bouncing between employee and owner and was handed to the owner instead of waking the owner again. */
  private async breakLoop(task: SupervisedTask, cfg: CompanyConfig, report: TickReport,
      prefetched?: { loops: number; reasons: string[] }): Promise<boolean> {
    if (cfg.blockLoopLimit <= 0) return false;
    const { owner } = this.deps;
    const { loops, reasons } = prefetched ?? await owner.blockLoops(task.id);
    if (loops < cfg.blockLoopLimit || !(await owner.escalateLooping(task, loops, reasons))) return false;
    report.decisions.push(`escalate-loop:${task.id}`);
    this.log(`task ${task.id} blocked on owner ${loops} times; loop recovery handled`);
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
