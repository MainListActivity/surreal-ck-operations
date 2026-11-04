import { taskTier } from './vendor/src/model-routing/policy.ts';
import type { RoutingLease } from './vendor/src/model-routing/gateway.ts';
// Per-agent sidecar pool. Each company employee instance gets a private comm
// directory and an in-memory credential held by the plugin; agents receive only
// SCK_COMM_DIR/SCK_COMM_KEY in their spawn env and never see auth material.
// The sidecar claims tasks on the instance's behalf (dispatcher calls claim()),
// keeps the lease alive while a turn runs, relays `sck call` requests through
// req/res files, and ingests report.md/blocker.md when a turn ends.
import { OpsCircuit } from "./ops-circuit";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { latestFindings, taskBrief } from "./vendor/src/dispatcher/brief.ts";
import { basename, dirname, join } from "node:path";
import {
  blockerPath, commDir, ensureCommDirs, readJsonFile, readTextFile, reportPath, reqDir, resDir,
  writeFileAtomic, type CommRequest, type CommResponse,
} from "./vendor/src/comm.ts";
import { serviceHome } from "./env";
import type { ActiveLease, ClaimResult, CompanyCore, Evidence, LeaseProof, RecoveryReadGrantRowView, TaskView, WorktreeAssignment, WriteScopeHolder } from "./vendor/src/contracts.ts";
import { RECOVERY_READ_TOOLS, RECOVERY_RESERVED_ARGS, type RecoveryReadRefusal, type RecoveryReadStopReason } from "./vendor/src/recovery-read.ts";
import type { EmployeeInst, SupervisedTask, Workforce } from "./vendor/src/workforce.ts";
import { fitAttachedNotices, guardRelayResponse, type NoticeCut } from "./vendor/src/response-budget.ts";
import { isPaged, parseReclaimInput, parseWorktreeInput, taskIdOf } from "./vendor/src/query-input.ts";
import { arriving, SNAPSHOT_TOOLS, withinReplyCeiling } from "./vendor/src/reply-clock.ts";

/** The release the service is running (the `active` symlink); undefined when it cannot be read. */
const qaRuntimeRelease = (): string | undefined => {
  try { return basename(realpathSync(join(serviceHome(), "active"))); } catch { return undefined; }
};
/** Stamp the actual running release onto a QA read answer; never a guessed value. */
const withQaRelease = <T extends { meta: object }>(value: T): T => {
  const release = qaRuntimeRelease();
  return (release ? { ...value, meta: { ...value.meta, runtimeRelease: release } } : value) as T;
};

const HEARTBEAT_MS = 60_000;
const SWEEP_MS = 400;
const BASE_TOOLS = [
  "get_context", "get_task_history", "list_worktrees", "reclaim_worktrees", "list_worktree_audits", "checkpoint", "submit", "review", "report_blocker",
  // SYS05 typed waits: enter (consumes the lease), trusted-event resolve, manager cancel/extend, read-only audit/cards.
  "wait_task", "resolve_wait", "cancel_wait", "extend_wait", "list_task_waits", "wait_handoff_cards", "wait_migration_preview", "wait_migration_apply",
  "create_task", "create_goal", "triage_goal", "create_delivery", "goal_phase_split",
  "record_owner_decision", "set_direction", "resume_task", "defer_task_until", "retire_task",
  // FV06 P1: gm-only read-only standby precheck (per-item {ok, code}); writes nothing, consumes no budget.
  "verify_standby",
  // FV06: gm-only append of real prerequisites to an existing dependency wait; sets manager continuation, never resumes.
  "append_dependency_prerequisites",
  "record_score", "get_model_evidence", "get_task_cost", "heartbeat", "deliverable_publish",
  // Manage capability (gm/product) only, enforced in core; writes land in audit.
  "def_list", "def_ensure", "project_disciplines_update",
  // gm only in core (rebind a blocked task to a registered project; audited, version-guarded).
  "task_project_update",
  // gm only in core (bind a blocked execute-phase task's code repo; audited, version-guarded).
  "bind_task_code_repo",
  // gm only in core (turn a blocked read-only engineering task into a code task in place; audited, version-guarded).
  "task_intent_update",
  // gm only in core (append the boss's acceptance-requirement amendment to an in-flight task; never touches its gates or lease).
  "task_acceptance_amend",
  // gm only in core (read-only acceptance-reference preview; compare-and-set repair of a quick goal's voided gate).
  "goal_acceptance_preview", "goal_acceptance_repair",
  // SYS07 goal governance: paged read-only console/scan/metrics, structured outcome and evidence, final-gate
  // preview/repair and explicit re-evaluation. Core enforces gm+manage; console/scan/metrics never write.
  "goal_console", "goal_governance_scan", "goal_metrics", "goal_outcome_register", "goal_evidence_record",
  "goal_finalize", "goal_final_gate_preview", "goal_final_gate_repair",
  // SYS01 bounded reads: gm-only company summary and byte-segment reads of long text (core enforces both).
  "get_admin_summary", "read_task_text", "read_worktree_refs", "record_acceptance_evidence", "acceptance_status", "acceptance_gate", "set_acceptance_gate",
  // SYS-INT mapping preview (read-only) and gm-only authorized import; core enforces both.
  "acceptance_mapping_preview", "acceptance_mapping_import",
  // SYS-INT controlled non-production deploy drill: host-executed (the service child), never the sandbox.
  "deploy_drill_run", "deploy_drill_status",
  // gm only in core (record a task's code implementer when the bound one cannot continue; compare-and-set, audited).
  "implementer_takeover",
  "qa_observation_grant", "qa_observation_revoke", "qa_observation_status", "qa_observation_session",
  "qa_observation_read", "qa_observation_timeline", "qa_observation_text",
  // SYS-INT 评审协同的持久事件唤醒：GM 订阅登记/关闭/只读，QA 结构化 scope 请求与撤销（core 判定角色、fence 与活租约）。
  "review_watch_register", "review_watch_close", "review_watch_status",
  "qa_review_scope_signal", "review_scope_signals",
  // Manage capability (gm/product) only in core: writes a task's independence policy under a compare-and-set; audited.
  "independence_set",
  // Manage capability only in core: registers an identity principal (the only cross-employee identity link); audited.
  "identity_principal_set",
  // gm only in core (read-only dry-run of who authored and reviewed each engineering task).
  "contributor_dryrun",
  // gm or qa in core (read-only preflight of one candidate against a task's independence policy; writes nothing).
  "independence_check",
  // SYS06 effective policy layer: gm/product only in core. Set/revoke one version of a typed machine policy, read the
  // current effective contract, dry-run a change, or isolate the in-flight tasks that lost authorization.
  "policy_set", "policy_revoke", "policy_list", "policy_effective", "policy_plan", "policy_enforce",
  // SYS03 经理处置账本：episode 认领/决定/释放、只读状态、持有人通知（core 判定角色与能力；产物落审计与通知 outbox）。
  "claim_disposition", "release_disposition", "disposition_status", "decide_disposition", "holder_notices",
  // SYS03 受控外部动作：取消 CI 运行走这个入口（core 判定经理/任务当事人），只读对账标 unknown_actor，归因只由 gm 带证据做。
  "cancel_ci_run", "reconcile_ci_runs", "attribute_ci_run", "list_external_actions",
  // SYS04: what the plugin process is actually running. Answered in the plugin host's own context, never from
  // the MCP face's tree or the `active` symlink, so it can serve as evidence of the loaded version.
  "plugin_runtime_diagnostics",
  // SYS04 故障诊断：任务持有人 / 验收人 / gm 只读预算状态；gm 解封已耗尽的恢复预算（core 判定）。
  "fault_status", "fault_lift",
  // FV06 终态任务恢复取证：gm+manage 签发/撤销，gm/被授权员工/源任务 reviewer 只读链与调用审计（core 判定）。
  "recovery_read_grant", "recovery_read_grant_revoke", "recovery_read_status",
];

/** Still named by tasks written before credentials left the agent; answer with where to go instead of a bare "unknown tool". */
const RETIRED_TOOLS = new Set(["get_secret", "put_secret"]);

/** How many unacked holder notices ride along with a successful reply. A notice text is bounded by the amend
 *  input (two 4000-char fields), so this keeps the added context small while still surfacing a backlog. */
const ATTACHED_NOTICE_LIMIT = 3;

/** What a successful reply carries besides its data: the unacked holder notices that fit its budget, and the cut when
 *  some were left out, by the budget or the per-reply limit (the cut notices stay unacked and are attached again on the next call). */
export interface AttachedNotices { notices?: unknown[]; noticesTruncated?: NoticeCut }

const hash = (text: string | undefined) => (text === undefined ? undefined : createHash("sha256").update(text).digest("hex"));

/** A leading blocker.md line that declares the subscription quota reset the way `report_blocker` takes it.
 *  The key tolerates case and `_` separators because this line is written by hand; the instant itself is
 *  handed to core.block unvalidated, so `parseQuotaResetsAt` stays the one validator both entries share. */
const BLOCKER_QUOTA_LINE = /^\s*quota_?resets_?at\s*[:：]\s*(.*)$/i;

/**
 * Reads the quota reset a blocker.md declares. The declaration is the file's first non-blank line — the
 * file entry point's equivalent of `report_blocker`'s `quotaResetsAt`:
 *
 *     quotaResetsAt: 2026-10-24T04:40:00Z
 *     正文…
 *
 * Only that line counts: a declaration further down (or one merely quoted in prose) must not silently
 * turn into hours of provider cooldown, so it is reported back through `misplaced` for the caller to log.
 * A line that declares the field with nothing after it is refused, exactly like a malformed call.
 */
export function blockerQuotaReset(text: string): { quotaResetsAt?: string; misplaced?: boolean } {
  const lines = text.split(/\r?\n/);
  const head = lines.findIndex(line => line.trim() !== "");
  if (head < 0) return {};
  const declared = BLOCKER_QUOTA_LINE.exec(lines[head]!);
  if (!declared) {
    return lines.some(line => BLOCKER_QUOTA_LINE.test(line))
      ? { misplaced: true }
      : {};
  }
  const value = declared[1]!.trim();
  if (value === "") {
    throw Object.assign(new Error(
      "blocker.md declares quotaResetsAt with no value; write `quotaResetsAt: <ISO 8601 with a timezone offset>` as its first line",
    ), { code: "invalid" });
  }
  return { quotaResetsAt: value };
}

/** Capability broker behind the `ops_*` tools (OpsBroker). Credentials and login tokens stay on its side. */
export interface OpsGateway {
  readonly tools: readonly string[];
  /** `proof` is injected by the channel only (never from user arguments): the recovery read grant binding. */
  call(credential: string, taskId: string, tool: string, args: Record<string, unknown>, proof?: { grantId: string; grantFence: number }): Promise<unknown>;
  /** The employee instance is done with its lease or gone: drop every session opened for it (and report cleanup). */
  release(employeeId: string): void | { sessions: number; browserSpaces: number; pending: number };
  /** FV06: drop only the local session handles a recovery read grant opened (no remote logout). */
  releaseGrant?(grantId: string): number;
}

export interface SidecarDeps {
  core: CompanyCore;
  workforce: Workforce;
  /** Absent in tests that do not exercise ops; `ops_*` tools are then unknown. */
  ops?: OpsGateway;
  /** ElevenLabs media studio (`media_*` tools): same gateway shape, the key stays in the plugin. */
  media?: OpsGateway;
  /** Browser-session media lane (`media_image`/`media_video`): drives the owner's logged-in web accounts. */
  browser?: OpsGateway;
  /** sync.so video studio (`sync_*` tools): same gateway shape; spend is approval-gated inside. */
  sync?: OpsGateway;
  /** Root under which per-instance comm dirs live. */
  runDir: string;
  /**
   * The registered source directory of this plugin, from the trusted host's own plugin registry
   * (`paseo plugin ls --json`). The Paseo host evaluates a CJS bundle with no module loader, so the
   * diagnostic cannot derive its own directory; it binds this registered tree instead. Resolved only
   * after core authorises the read.
   */
  pluginSource?: () => Promise<string | null>;
  log?: (message: string) => void;
  /** Injectable for tests. */
  heartbeatMs?: number;
  sweepMs?: number;
}

interface LiveClaim {
  instId: string;
  taskId: string;
  /** The server phase this lease was claimed for; review leases never submit a report.md. */
  phase: "doing" | "review";
  proof: LeaseProof;
  /** Hash of artifact content already consumed, so a stale file never submits twice. */
  reportHash?: string;
  blockerHash?: string;
  /** Turns that ended without any closeout artifact while this claim was live. */
  nudges?: number;
  routing?: RoutingLease;
  routingExpiresAt?: number;
}

/** What settle() found for a finished turn; `silent` carries the still-open round. */
export interface SettleResult {
  status: "ingested" | "no_claim" | "silent";
  silent?: { instId: string; taskId: string; nudges: number; phase: "doing" | "review" };
}

/**
 * FV06 recovery read binding: independent of `claims` (never a fake lease proof). It only authorizes the
 * grant's fixed ops calls; every write tool still requires a normal claim.
 */
export interface RecoveryClaim {
  instId: string;
  /** The terminal source task whose fault keys every call is charged to. */
  taskId: string;
  grantId: string;
  grantFence: number;
  alias: string;
  paths: string[];
  expiresAt: number;
  /**
   * The login handle the broker issued under this grant. It lives in this process only (never persisted as a token)
   * and is mirrored into claim.json so the next wake can carry it. A restart drops it, which is why a running chain
   * is closed as stopped(session_lost) rather than silently retried (d15cbecb §6.2).
   */
  sessionHandle?: string;
}

const ORPHAN_PREFIX = "orphaned-";
/**
 * task.md and findings/round-NN.md for the lease just taken: what the dispatch message points the employee at. The comm
 * dir outlives tasks, so an earlier task's findings are removed first.
 */
function stageBrief(dir: string, claim: ClaimResult): void {
  try { writeBrief(dir, claim); } catch (error) { console.warn(`task brief for ${claim.task?.id} not staged: ${(error as Error).message}`); }
}
function writeBrief(dir: string, claim: ClaimResult): void {
  rmSync(join(dir, "findings"), { recursive: true, force: true });
  writeFileAtomic(join(dir, "task.md"), taskBrief(claim));
  const findings = latestFindings(claim.history);
  if (!findings) return;
  mkdirSync(join(dir, "findings"), { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dir, findings.file), findings.text);
}

/** Preserved artifacts of earlier leases on the task; claim.json lists them for the next holder. */
function orphanedArtifacts(evidenceDir: string): string[] {
  try { return readdirSync(evidenceDir).filter(f => f.startsWith(ORPHAN_PREFIX) && f.endsWith(".md")).sort().map(f => join(evidenceDir, f)); }
  catch { return []; }
}

export class SidecarPool {
  private readonly launched = new Set<string>();
  private readonly quarantined = new Set<string>();
  private readonly creds = new Map<string, string>();
  private readonly keys = new Map<string, string>();
  private readonly routingUnconfirmed = new Set<string>();
  private readonly routingEmployees = new Map<string, {role:string}>();
  private readonly claims = new Map<string, LiveClaim>();
  /** FV06: recovery read bindings, kept strictly apart from execution claims (never exposed as lease proof). */
  private readonly recoveryClaims = new Map<string, RecoveryClaim>();
  private readonly recoveryCheckedAt = new Map<string, number>();
  /** instId → task of the last lease it held; names the task a report written after the lease ended belongs to. */
  private readonly lastTask = new Map<string, string>();
  private readonly instByAgent = new Map<string, string>();
  private readonly beats = new Map<string, ReturnType<typeof setInterval>>();
  private readonly active = new Set<string>();
  private readonly processing = new Set<string>();
  /** instId → the notice step last queued for that employee; each step waits for the one before it (see withNoticeGate). */
  private readonly noticeGates = new Map<string, Promise<void>>();
  private sweeper?: ReturnType<typeof setInterval>;

  /** Last claim denial code per instance: the dispatcher reads it after a lost claim (see claimDenial). */
  private readonly denials = new Map<string, string>();
  private readonly opsCircuit: OpsCircuit;
  constructor(private readonly deps: SidecarDeps) { this.opsCircuit = new OpsCircuit(deps.runDir); }
  private log(message: string) { this.deps.log?.(message); }

  routingSession(ref:string):{employee:string;comm:string;role?:string}|undefined {
    const employee=ref.startsWith('employee:')?ref.slice(9):this.instByAgent.get(ref);
    if(!employee||!this.launched.has(employee)||this.quarantined.has(employee))return;
    return {employee,comm:commDir(this.deps.runDir,employee),role:this.routingEmployees.get(employee)?.role};
  }

  /** Read-only projection of the sidecar's authoritative local claim; never queries the remote DB. */
  routingLease(ref:string):RoutingLease|undefined {
    const inst=ref.startsWith('employee:')?ref.slice(9):this.instByAgent.get(ref);
    if(!inst||this.quarantined.has(inst)||!this.launched.has(inst)||this.routingUnconfirmed.has(inst))return;
    const agent=[...this.instByAgent].find(([,id])=>id===inst)?.[0];
    const live=this.claims.get(inst);
    if(live){if(!live.routing||!(live.routingExpiresAt!>Date.now()))return;return {...live.routing,agent,fence:live.proof.fence};}
    const role=this.routingEmployees.get(inst)?.role;
    // A task lease authorizes task writes, not the employee's ability to speak.
    // submit/review consumes the lease before Claude's next call handles the tool result.
    // Keep authenticated sessions routable without attributing closeout/chat to the finished task.
    if(role)return {employee:inst,agent,task:'',fence:0,role,tier:taskTier({executor_role:role}),phase:role==='gm'||role==='eval'?'planning':'idle'};
  }

  /** Spawn env for a fresh instance: comm channel only. Minted credential stays in memory. */
  env(inst: EmployeeInst): Record<string, string> {
    this.routingEmployees.set(inst.id,{role:inst.role});
    if (this.quarantined.has(inst.id) || (inst.paseoAgentId && !this.canReuse(inst))) {
      throw Object.assign(new Error("session channel cannot be restored; retire the instance"), { code: "stale_channel" });
    }
    const dir = commDir(this.deps.runDir, inst.id);
    ensureCommDirs(dir);
    const scratch = this.scratchDirFor(inst.id);
    const held = this.keys.get(inst.id);
    if (held) return { SCK_COMM_DIR: dir, SCK_COMM_KEY: held, SCK_SCRATCH_DIR: scratch, TMPDIR: scratch };
    this.launched.add(inst.id);
    const key = randomBytes(16).toString("hex");
    this.keys.set(inst.id, key);
    this.active.add(inst.id);
    if (inst.credential) this.creds.set(inst.id, inst.credential);
    this.ensureSweeper();
    return { SCK_COMM_DIR: dir, SCK_COMM_KEY: key, SCK_SCRATCH_DIR: scratch, TMPDIR: scratch };
  }

  /** Per-instance scratch root: agents put clones/builds/temp media here, never in /tmp or the host dir.
   *  Derived from the comm root so an overridden SCK_COMM_ROOT (tests, alternate homes) keeps it in one place. */
  scratchDirFor(instId: string): string {
    const dir = join(dirname(this.deps.runDir), "scratch", instId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Instance ids this pool is currently answering for; everything else in comm/ is a dead channel. */
  liveInstanceIds(): Set<string> {
    return new Set([...this.active, ...this.quarantined, ...this.keys.keys()]);
  }

  /** Absolute comm dir path for prompts — agents must never need to resolve env vars. */
  commDirFor(instId: string): string {
    return commDir(this.deps.runDir, instId);
  }

  /**
   * Paseo injects spawn env only at session create — resume/refresh opens get
   * env=undefined, which silently strips SCK_COMM_DIR/SCK_COMM_KEY from the
   * process. Every open does carry PASEO_AGENT_ID though, so sck can re-enter
   * comm mode through this pointer file (dir + key, no auth material).
   */
  private bindDir(): string {
    return join(dirname(this.deps.runDir), "comm-agents");
  }

  private keyFor(instId: string): string {
    const held = this.keys.get(instId);
    if (held) return held;
    throw new Error("channel binding requires an existing launch key");
  }

  private writeBinding(agentId: string, instId: string): void {
    try {
      mkdirSync(this.bindDir(), { recursive: true, mode: 0o700 });
      writeFileSync(join(this.bindDir(), agentId), `${commDir(this.deps.runDir, instId)}\n${this.keyFor(instId)}\n`, { mode: 0o600 });
    } catch (error) {
      this.log(`bind file ${agentId} failed: ${(error as Error).message}`);
    }
  }

  private dropBinding(agentId: string): void {
    try { unlinkSync(join(this.bindDir(), agentId)); } catch { /* already gone */ }
  }

  /** Only a launch bound in this process can be reused, including management wakes. */
  canReuse(inst: EmployeeInst): boolean {
    return !this.quarantined.has(inst.id) && this.launched.has(inst.id) && this.keys.has(inst.id) &&
      !!inst.paseoAgentId && this.instByAgent.get(inst.paseoAgentId) === inst.id;
  }

  bindAgent(instId: string, agentId: string): void {
    if (!this.launched.has(instId) || this.quarantined.has(instId)) throw new Error("channel was not launched in this process");
    for (const [agent, inst] of this.instByAgent) if (inst === instId) {
      this.instByAgent.delete(agent);
      this.dropBinding(agent);
    }
    this.instByAgent.set(agentId, instId);
    this.writeBinding(agentId, instId);
  }

  private async credentialFor(instId: string): Promise<string> {
    const held = this.creds.get(instId);
    if (held) return held;
    return this.rotateCredential(instId);
  }

  /** Undelivered holder notices ride along with a successful reply, so an in-lease holder sees an acceptance amendment
   *  on its very next sck call (the dispatcher only redelivers to idle sessions, and a holder never has to poll
   *  holder_notices). Attaching is delivery: markAttached marks what the reply carries before the reply is written.
   *  The attached notices share the reply's budget: a notice that does not fit is left for the next call (it stays
   *  undelivered), and the reply records the cut. Best effort: a failed notice read must never fail the tool call it
   *  is attached to, and a data answer over the budget on its own is left to the guard to refuse. */
  private async attachNotices(instId: string, data: unknown): Promise<AttachedNotices> {
    const read = this.deps.core.dispositionNotices?.bind(this.deps.core);
    if (!read) return {};
    try {
      const pending = await read(await this.credentialFor(instId));
      if (!pending.length) return {};
      // The note is part of the notice body, so it is measured with the notice: the holder needs no ack for it.
      const noted = pending.map(notice => ({ ...notice, text: `【已随本次回包送达，无需 ack】${notice.text}` }));
      return fitAttachedNotices(data, noted, ATTACHED_NOTICE_LIMIT) ?? { notices: noted.slice(0, ATTACHED_NOTICE_LIMIT) };
    } catch (error) {
      this.log(`attach notices ${instId} failed: ${(error as Error).message}`);
      return {};
    }
  }

  /** Attaching is delivery (R2): each notice a reply carries is marked delivered with the receipt a holder's ack writes
   *  (agent = the employee), so neither the next reply nor the dispatcher's idle wake-up sends it again. Best effort: a
   *  failed mark is logged, and the call it rides on still succeeds. */
  private async markAttached(instId: string, notices: unknown[]): Promise<void> {
    const ack = this.deps.core.ackDispositionNotices?.bind(this.deps.core);
    const ids = notices.map(notice => (notice as { noticeKey?: unknown }).noticeKey).filter((key): key is string => typeof key === "string");
    if (!ack || ids.length === 0) return;
    try {
      await ack(await this.credentialFor(instId), { ids });
    } catch (error) {
      this.log(`mark attached notices ${instId} failed: ${(error as Error).message}`);
    }
  }

  /** Reading the pending notices, attaching them to a reply and marking them delivered is one step per employee. The sweep
   *  starts every request file as it arrives, so two calls in flight would otherwise both read the same notice and both carry
   *  it. Queued this way, the second call reads only what the first left undelivered. A failed step does not break the queue. */
  private withNoticeGate<T>(instId: string, step: () => Promise<T>): Promise<T> {
    const run = (this.noticeGates.get(instId) ?? Promise.resolve()).then(step);
    this.noticeGates.set(instId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async rotateCredential(instId: string): Promise<string> {
    // Plugin restart or adoption: re-issue. Retired instances fail here (revoked + retired row).
    const rotated = await this.deps.workforce.rotate(instId);
    this.creds.set(instId, rotated);
    return rotated;
  }

  async readWorkspace(inst: EmployeeInst, taskId?: string, project?: string): Promise<WorktreeAssignment | undefined> {
    const workspace = await this.deps.core.readWorkspace?.(await this.credentialFor(inst.id), taskId, project);
    if (workspace) writeFileAtomic(join(commDir(this.deps.runDir, inst.id), 'workspace.json'), JSON.stringify(workspace));
    return workspace;
  }
  async releaseWorkspace(inst: EmployeeInst): Promise<void> {
    await this.deps.core.releaseWorkspace?.(await this.credentialFor(inst.id));
  }

  private static isAuthError(error: unknown): boolean {
    return error instanceof Error && /invalid credential|unauthorized|forbidden/i.test(error.message);
  }

  /** Retry once with a re-issued credential when a call rejects auth — a concurrent adopter may have rotated it. */
  private async callWithCred<T>(instId: string, fn: (cred: string) => Promise<T>): Promise<T> {
    const cred = await this.credentialFor(instId);
    try {
      return await fn(cred);
    } catch (error) {
      if (!SidecarPool.isAuthError(error)) throw error;
      return await fn(await this.rotateCredential(instId));
    }
  }

  /**
   * Server-side truth for a held claim: the lease is alive only while the task
   * still names this instance its employee under the same delivery, unexpired.
   * Anything else (revoked, expired, re-claimed by another worker) is a stale
   * local remnant — drop it instead of letting it block every future pick.
   */
  private async staleClaim(held: LiveClaim): Promise<boolean> {
    try {
      const cred = await this.credentialFor(held.instId);
      const task = await this.deps.core.getTask(cred, held.taskId);
      return (task.state !== "doing" && task.state !== "review")
          || task.currentEmployee !== held.instId
          || task.deliveryId !== held.proof.deliveryId
          || (task.leaseExpiresAt !== undefined && Date.parse(task.leaseExpiresAt) <= Date.now());
    } catch {
      return true; // unreachable/removed task — never worth blocking dispatch on
    }
  }

  /** Why the last claim of this instance was denied (for example worktree_busy), until its next claim. */
  claimDenial(instId: string): string | undefined {
    return this.denials.get(instId);
  }

  /** Write-scope preflight through the core: read-only, under the same rules as the claim it precedes. */
  writeScope(task: SupervisedTask, employeeId?: string): Promise<WriteScopeHolder[]> {
    return this.deps.core.writeScopeOf(task.id, employeeId);
  }

  /** Claims the task as the instance and stages claim.json in its comm dir. */
  async claim(inst: EmployeeInst, task: SupervisedTask): Promise<ClaimResult | undefined> {
    // Legacy instances still carry a credential file their agent reads directly;
    // rotating it here would kill their in-flight work. They phase out naturally.
    if (inst.credentialFile) return undefined;
    if (this.quarantined.has(inst.id) || !this.launched.has(inst.id) || !this.keys.has(inst.id) ||
        (inst.paseoAgentId && !this.canReuse(inst))) {
      throw Object.assign(new Error("unhealthy session channel cannot claim"), { code: "stale_channel" });
    }
    const held = this.claims.get(inst.id);
    if (held) {
      // A local claim outliving its server lease (settle stopped heartbeats, a
      // supervisor revoked the lease) used to wedge here forever — verify and heal.
      if (!(await this.staleClaim(held))) {
        throw Object.assign(new Error("session already holds a lease"), { code: "already_claimed" });
      }
      this.log(`claim ${inst.id}: dropped stale lease on ${held.taskId}`);
      this.endLease(inst.id);
    }
    // 恢复读取与执行租约互斥：一旦要领执行租约，先关闭恢复绑定（grant 本身不撤销）。
    await this.closeRecovery(inst.id, "execution_claim");
    const cred = await this.credentialFor(inst.id);
    let result: ClaimResult;
    this.denials.delete(inst.id);
    try {
      result = await this.deps.core.claim(cred, task.id);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (["already_claimed", "forbidden", "no_available_task", "not_found", "worktree_busy"].includes(code)) {
        this.log(`claim ${task.id} denied for ${inst.id}: ${code} (${(error as Error).message?.slice(0, 160)})`);
        this.denials.set(inst.id, code);
        return undefined;
      }
      throw error;
    }
    this.deps.ops?.release(inst.id); // sessions never outlive the lease they were opened under
    this.deps.media?.release(inst.id);
    this.deps.sync?.release(inst.id);
    const dir = commDir(this.deps.runDir, inst.id);
    ensureCommDirs(dir);
    // Requests queued under the previous/no lease cannot consume this new one.
    for (const file of readdirSync(reqDir(dir))) {
      if (!file.endsWith(".json")) continue;
      try { unlinkSync(join(reqDir(dir), file)); } catch { continue; }
      writeFileAtomic(join(resDir(dir), file), JSON.stringify({ ok: false, error: "no_lease: request predates current claim" }));
    }
    // Evidence attachments (screenshots, exported reports, acceptance manuals) live
    // under the service home, keyed by task so handovers and reviewers share one
    // directory — deliberately outside any git repo so audits never bloat it.
    const evidenceDir = join(dirname(this.deps.runDir), "evidence", task.id);
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(dir, "claim.json"), JSON.stringify({ ...result, evidenceDir, orphanedArtifacts: orphanedArtifacts(evidenceDir) }));
    stageBrief(dir, result);
    // A new lease must not inherit a previous turn's artifacts: archive them so an
    // identical-looking new report still submits instead of matching a stale hash.
    this.archive(reportPath(dir), "stale");
    this.archive(blockerPath(dir), "stale");
    this.routingUnconfirmed.delete(inst.id);
    this.claims.set(inst.id, {
      instId: inst.id, taskId: task.id, phase: result.task.state === "review" ? "review" : "doing",
      routing: {employee:inst.id,task:task.id,fence:result.fence,role:inst.role,tier:taskTier({model_tier:result.task.modelTier,kind:result.task.kind,title:result.task.title,executor_role:inst.role,reviewer_role:result.task.reviewerRole}),phase:result.task.state==='review'?'review':'execute'},
      routingExpiresAt:Date.parse(result.leaseExpiresAt),
      proof: { taskId: task.id, deliveryId: result.deliveryId, fence: result.fence, expectedVersion: result.task.version },
    });
    this.startBeat(inst.id);
    this.log(`sidecar claimed ${task.id} for ${inst.id}`);
    return result;
  }

  /** Spawn/wake/workspace-handoff rollback after a pre-claim: hand the lease back without a
   * reviewer verdict — never routed through returnTask, which would fake a return and bounce
   * a review task back to doing. Cores without the release op let the lease expire on its own. */
  async releaseClaim(instId: string, _taskId: string, reason: string, options: { strict?: boolean } = {}): Promise<void> {
    const live = this.claims.get(instId);
    if (!options.strict) this.endLease(instId);
    if (!live) return;
    try {
      const cred = await this.credentialFor(instId);
      if (options.strict && !this.deps.core.release) throw new Error("core release unavailable");
      await this.deps.core.release?.(cred, live.proof, { text: `【通道回滚】${reason}`, idempotencyKey: `sidecar-release:${instId}:${live.proof.deliveryId}` });
      if (options.strict && this.claims.get(instId) === live) this.endLease(instId);
    } catch (error) {
      if (options.strict) throw error;
      this.log(`releaseClaim ${instId} failed (lease will expire): ${(error as Error).message}`);
    }
  }

  /** Turn ended: ingest the agent's artifacts, then let the lease live or die.
   * The keepalive is NOT stopped here — the claim may outlive this turn (multi-turn
   * work), and a claim whose beat died becomes an orphan no heartbeat can expire. */
  async settle(agentId: string, options: { infrastructureFailure?: boolean } = {}): Promise<SettleResult> {
    const instId = this.instByAgent.get(agentId);
    if (!instId) return { status: "no_claim" };
    const dir = commDir(this.deps.runDir, instId);
    const blocker = readTextFile(blockerPath(dir));
    const report = readTextFile(reportPath(dir));
    const live = this.claims.get(instId);
    if (!live) {
      await this.deps.core.releaseWorkspace?.(await this.credentialFor(instId)).catch(() => undefined);
      // No lease to act on; rename stale artifacts so they are not retried forever, keeping a copy
      // with the task so whoever claims it next can reuse work finished after the lease was lost.
      for (const [text, path] of [[blocker, blockerPath(dir)], [report, reportPath(dir)]] as const) {
        if (text !== undefined) this.orphan(instId, this.lastTask.get(instId), text, path);
      }
      return { status: "no_claim" };
    }
    // A review turn closes through `review` or report_blocker, never through a report.md
    // submit. Keep the lease and archive the non-closeout artifact instead of trying to
    // submit a review task (which would fail and then end a still-valid lease).
    if (live.phase === "review" && report !== undefined && hash(report) !== live.reportHash) {
      this.log(`review report.md is not a closeout for ${instId} on ${live.taskId}; archiving`);
      this.archive(reportPath(dir), "stale");
    }
    if (blocker !== undefined && hash(blocker) !== live.blockerHash) {
      await this.finish(instId, live, "gm", blocker, blockerPath(dir));
      return { status: "ingested" };
    }
    if (live.phase !== "review" && report !== undefined && hash(report) !== live.reportHash) {
      await this.finish(instId, live, undefined, report, reportPath(dir));
      return { status: "ingested" };
    }
    // Turn closed with the round still open: keep the lease while the caller decides
    // between a wake nudge and a server-side release; the count feeds that decision.
    if (!options.infrastructureFailure) live.nudges = (live.nudges ?? 0) + 1;
    this.log(`turn ended without new report/blocker: ${instId} on ${live.taskId} (silent turn ${live.nudges})`);
    return { status: "silent", silent: { instId, taskId: live.taskId, nudges: live.nudges ?? 0, phase: live.phase } };
  }

  private async finish(
    instId: string, live: LiveClaim, to: "gm" | undefined,
    text: string, path: string,
  ): Promise<void> {
    const upgradeSha = /^\s*companyUpgradeSha:\s*(\S+)\s*$/m.exec(text)?.[1];
    const recovery = /^\s*recoveryReason:\s*(\S+)\s*$/m.exec(text)?.[1];
    const evidence: Evidence = { ...(upgradeSha ? {companyUpgrade:{sha:upgradeSha}}:{}), ...(to && recovery ? { recoveryReason: recovery as Evidence["recoveryReason"] } : {}), text, idempotencyKey: `sidecar-file:${instId}:${live.proof.deliveryId}:${hash(text)}` };
    try {
      const cred = await this.credentialFor(instId);
      if (to) {
        // SYS-QUOTA: a blocker.md declares its quota reset on its leading line; the file entry and
        // `sck call report_blocker` must carry the same field, or the same block means two things
        // depending on how the employee wrote it. A declaration the parser cannot use is refused
        // (never dropped quietly): the block fails, the artifact is archived as `.failed-`, and the
        // reason is logged. A line further down stays prose and is reported instead of applied.
        const declared = blockerQuotaReset(text);
        if (declared.misplaced) {
          this.log(`sidecar ${live.taskId} for ${instId}: blocker.md mentions quotaResetsAt after its first line; ignored — the declaration only counts as the first line`);
        }
        await this.deps.core.block(cred, live.proof, to, evidence, declared.quotaResetsAt);
      }
      else await this.deps.core.submit(cred, live.proof, evidence);
      this.log(`sidecar ${to ? "blocked" : "submitted"} ${live.taskId} for ${instId}`);
      if (this.claims.get(instId) === live) {
        this.archiveIngested(path, text, "done");
        this.endLease(instId);
      }
    } catch (error) {
      this.log(`sidecar finish ${live.taskId} for ${instId} failed: ${(error as Error).message}`);
      if (this.claims.get(instId) === live) {
        this.archiveIngested(path, text, "failed");
        this.endLease(instId); // lease is already gone or foreign; do not retry
      }
    }
  }

  /** The instance still holds its local lease on the task. */
  holdsLease(instId: string, taskId: string): boolean { return this.claims.get(instId)?.taskId === taskId; }

  /**
   * The lease was ended elsewhere (dispatcher revoked it server-side, or the task
   * moved on): drop the matching local claim so the instance can claim again.
   * taskId guards against dropping a newer claim than the one being revoked.
   */
  dropLease(instId: string, taskId?: string): void {
    const live = this.claims.get(instId);
    if (!live || (taskId !== undefined && live.taskId !== taskId)) return;
    this.endLease(instId);
  }

  /** The instance no longer holds a lease: stop keepalive and drop every ops session opened under it. */
  private endLease(instId: string): void {
    const live = this.claims.get(instId);
    if (live) this.lastTask.set(instId, live.taskId);
    this.stopBeat(instId);
    this.claims.delete(instId);
    const cleanup = this.deps.ops?.release(instId);
    if (cleanup && typeof cleanup === 'object' && cleanup.pending > 0) {
      this.log(`lease end ${instId}: ${cleanup.pending} browser space(s) pending cleanup; no remote logout is claimed`);
    }
    this.deps.media?.release(instId);
    this.deps.sync?.release(instId);
    // claim.json describes a dead lease — remove it so a re-used/woken agent knows it holds nothing.
    try { unlinkSync(join(commDir(this.deps.runDir, instId), "claim.json")); } catch { /* already gone */ }
  }

  private archive(path: string, tag: string): void {
    try { renameSync(path, `${path}.${tag}-${Date.now().toString(36)}`); } catch { /* already gone */ }
  }

  /** Archive an artifact no lease can ingest, preserving a copy in the task's evidence dir when the task is known. */
  private orphan(instId: string, taskId: string | undefined, text: string, path: string, tag = "orphaned"): void {
    if (taskId) {
      try {
        const dir = join(dirname(this.deps.runDir), "evidence", taskId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const kept = join(dir, `${ORPHAN_PREFIX}${basename(path, ".md")}-${instId}-${Date.now().toString(36)}.md`);
        writeFileSync(kept, text, { mode: 0o600 });
        this.log(`preserved ${basename(path)} of ${instId} for ${taskId} at ${kept}`);
      } catch (error) {
        this.log(`preserve ${basename(path)} of ${instId} failed: ${(error as Error).message}`);
      }
    }
    this.archive(path, tag);
  }

  /** Caller must still own the captured lease. Also preserve content rewritten
   * within that lease so the next settle can ingest it. */
  private archiveIngested(path: string, ingested: string, tag: string): void {
    const current = readTextFile(path);
    if (current === undefined || current !== ingested) return;
    this.archive(path, tag);
  }

  /** Agent archived: drop the binding and credential; any live lease expires on its own. */
  detachAgent(agentId: string): void {
    const instId = this.instByAgent.get(agentId);
    this.instByAgent.delete(agentId);
    this.dropBinding(agentId);
    if (!instId) return;
    if ([...this.instByAgent.values()].includes(instId)) return;
    this.endLease(instId);
    this.routingUnconfirmed.delete(instId);
    this.launched.delete(instId);
    this.quarantined.add(instId);
    this.creds.delete(instId);
    this.keys.delete(instId);
    this.active.delete(instId);
  }

  /**
   * Restart loses the in-memory channel state, but the workforce record still
   * names the bound agent and rotate() re-issues a credential — enough to prove
   * ownership and re-key the channel instead of quarantining every instance.
   * The pointer file carries the fresh key to the agent's next sck call, so a
   * running session keeps working across reloads.
   */
  async adopt(insts: EmployeeInst[]): Promise<void> {
    for (const inst of insts) {
      this.routingEmployees.set(inst.id,{role:inst.role});
      if (inst.credentialFile || !inst.paseoAgentId || this.canReuse(inst)) continue;
      try {
        const cred = await this.deps.workforce.rotate(inst.id); // retired/revoked insts throw
        this.creds.set(inst.id, cred);
        this.keys.set(inst.id, randomBytes(16).toString("hex"));
        this.launched.add(inst.id);
        this.active.add(inst.id);
        this.quarantined.delete(inst.id);
        this.instByAgent.set(inst.paseoAgentId, inst.id);
        ensureCommDirs(commDir(this.deps.runDir, inst.id));
        this.writeBinding(inst.paseoAgentId, inst.id);
        this.log(`sidecar adopted ${inst.id}: channel re-keyed`);
      } catch (error) {
        // The workforce row is dead — keep the deny-only binding until retirement.
        this.launched.delete(inst.id);
        this.keys.delete(inst.id);
        this.creds.delete(inst.id);
        this.quarantined.add(inst.id);
        this.instByAgent.set(inst.paseoAgentId, inst.id);
        this.active.add(inst.id);
        this.dropBinding(inst.paseoAgentId);
        ensureCommDirs(commDir(this.deps.runDir, inst.id));
        this.log(`sidecar quarantined ${inst.id}: ${(error as Error).message}`);
      }
    }
    // Claims are process state: rebuild any lease still alive server-side so the
    // instance keeps its seat (and any artifacts it wrote) across the restart.
    for (const inst of insts) {
      if (!this.launched.has(inst.id) || this.claims.has(inst.id)) continue;
      // A failed/ambiguous lookup must not turn an in-flight employee into idle routing.
      this.routingUnconfirmed.add(inst.id);
      try { await this.rebuildClaim(inst); }
      catch (error) { this.log(`adopt lease check ${inst.id} failed: ${(error as Error).message}`); }
    }
    // FV06: recovery bindings are process state too; rebuild only the grants the server still reports active.
    for (const inst of insts) {
      if (!this.launched.has(inst.id)) continue;
      await this.rebuildRecovery(inst);
    }
    this.ensureSweeper();
  }

  /** FV06 P0 standby wake: a resume assigned this instance a lease server-side (no sidecar claim ran),
   *  so rebuild the local claim (channel proof + claim.json) from the authoritative server lease. */
  async adoptLease(inst: EmployeeInst): Promise<void> {
    if (!this.launched.has(inst.id)) throw new Error("unhealthy session channel cannot adopt a lease");
    await this.rebuildClaim(inst);
  }

  /**
   * FV06: bind a recovery read grant to this instance's channel. Never a fake lease: the binding lives in
   * `recoveryClaims`, authorizes only the grant's ops allowlist, and refuses while any execution claim exists.
   * The server remains the authority — the grant is re-read and rebound (issued → bound) on every wake/reload.
   */
  async adoptRecovery(inst: EmployeeInst, grantId?: string): Promise<RecoveryClaim | undefined> {
    if (!this.launched.has(inst.id)) throw new Error("unhealthy session channel cannot adopt a recovery grant");
    if (this.claims.has(inst.id)) throw Object.assign(new Error("execution lease is active; recovery read cannot bind"), { code: "lease_conflict" });
    const core = this.deps.core;
    if (!core.recoveryGrantFor || !core.recoveryGrantsFor || !core.recoveryReadBind) {
      throw Object.assign(new Error("core does not expose recovery read grants"), { code: "no_grant" });
    }
    const cred = await this.credentialFor(inst.id);
    let grant: RecoveryReadGrantRowView | undefined;
    if (grantId) {
      grant = await core.recoveryGrantFor(cred, grantId);
    } else {
      const grants = await core.recoveryGrantsFor(cred);
      if (grants.length === 0) return undefined;
      if (grants.length > 1) {
        this.log(`recovery adoption ambiguous for ${inst.id}: ${grants.length} active grants (${grants.map(g => g.id).join(", ")})`);
        return undefined;
      }
      grant = grants[0];
    }
    if (grant.employeeId !== inst.id) throw Object.assign(new Error("recovery grant belongs to another employee"), { code: "no_grant" });
    if (grant.state !== "issued" && grant.state !== "bound" && grant.state !== "running") {
      throw Object.assign(new Error(`recovery grant is ${grant.state}`), { code: "no_grant" });
    }
    if (Date.parse(grant.expiresAt) <= Date.now()) {
      await this.auditRecoveryRefusal(inst.id, { grantId: grant.id, taskId: grant.taskId, grantFence: grant.fence }, "expired", "channel");
      throw Object.assign(new Error("recovery grant expired"), { code: "no_grant" });
    }
    // A running chain has already spent its single login. If this process holds no handle for it (plugin reload,
    // restart, dropped session), the honest closure is stopped(session_lost): rebinding would send the employee into
    // GETs that can never be authorized, and re-login is not allowed. No automatic login ever happens here.
    const prior = this.recoveryClaims.get(inst.id);
    if (grant.state === "running" && (!prior || prior.grantId !== grant.id || !prior.sessionHandle)) {
      await this.stopRecovery(inst.id, grant.id, grant.fence, "session_lost");
      throw Object.assign(new Error("recovery login handle was lost; grant stopped (session_lost)"), { code: "no_grant" });
    }
    const bound = await core.recoveryReadBind(cred, { grantId: grant.id, fence: grant.fence });
    const claim: RecoveryClaim = {
      instId: inst.id, taskId: bound.taskId, grantId: bound.id, grantFence: bound.fence,
      alias: bound.alias, paths: [...bound.paths], expiresAt: Date.parse(bound.expiresAt),
      ...(prior?.grantId === bound.id && prior.sessionHandle ? { sessionHandle: prior.sessionHandle } : {}),
    };
    this.recoveryClaims.set(inst.id, claim);
    const dir = commDir(this.deps.runDir, inst.id);
    ensureCommDirs(dir);
    const evidenceDir = join(dirname(this.deps.runDir), "evidence", claim.taskId);
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    // claim.json carries a `recovery` section — never a lease proof: submit/review/checkpoint stay impossible.
    writeFileAtomic(join(dir, "claim.json"), JSON.stringify({
      recovery: { taskId: claim.taskId, grantId: claim.grantId, grantFence: claim.grantFence,
        alias: claim.alias, paths: claim.paths, expiresAt: new Date(claim.expiresAt).toISOString(),
        ...(claim.sessionHandle ? { sessionHandle: claim.sessionHandle } : {}) },
      evidenceDir, orphanedArtifacts: orphanedArtifacts(evidenceDir),
    }));
    this.log(`sidecar bound recovery grant ${claim.grantId} for ${inst.id} on source ${claim.taskId}`);
    return claim;
  }

  /** FV06: close the local binding (revoked/expired/source changed/execution claim). Drops only this grant's
   *  local sessions; it never logs in again and never claims a remote logout. A caller-confirmed terminal reason
   *  (session_lost) is written through to the grant so status shows it. */
  async closeRecovery(instId: string, reason: string, stopReason?: RecoveryReadStopReason): Promise<void> {
    const claim = this.recoveryClaims.get(instId);
    if (!claim) return;
    this.recoveryClaims.delete(instId);
    this.recoveryCheckedAt.delete(instId);
    try { this.deps.ops?.releaseGrant?.(claim.grantId); } catch { /* local cleanup only */ }
    try {
      const cred = await this.credentialFor(instId);
      await this.deps.core.recoveryReadClose?.(cred, { grantId: claim.grantId, fence: claim.grantFence, reason,
        ...(stopReason ? { stopReason } : {}) });
    } catch (error) {
      this.log(`recovery close ${claim.grantId} for ${instId} failed: ${(error as Error).message}`);
    }
    const path = join(commDir(this.deps.runDir, instId), "claim.json");
    const prior = readJsonFile<{ recovery?: { grantId?: string } }>(path);
    if (prior?.recovery?.grantId === claim.grantId) {
      try { unlinkSync(path); } catch { /* already gone */ }
    }
    this.log(`sidecar closed recovery grant ${claim.grantId} for ${instId}: ${reason}`);
  }

  /**
   * Close a grant the channel never bound in this process (a running chain whose handle died with the previous
   * process). Writes stopped(session_lost) to the server and removes any stale claim.json for that grant.
   */
  private async stopRecovery(instId: string, grantId: string, fence: number, stopReason: RecoveryReadStopReason): Promise<void> {
    try {
      const cred = await this.credentialFor(instId);
      await this.deps.core.recoveryReadClose?.(cred, { grantId, fence, reason: stopReason, stopReason });
      this.log(`sidecar stopped recovery grant ${grantId} for ${instId}: ${stopReason}`);
    } catch (error) {
      this.log(`recovery stop ${grantId} for ${instId} failed: ${(error as Error).message}`);
    }
    const path = join(commDir(this.deps.runDir, instId), "claim.json");
    const prior = readJsonFile<{ recovery?: { grantId?: string } }>(path);
    if (prior?.recovery?.grantId === grantId) {
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  }

  /** The handle is already handed to the employee in the tool result; mirroring it into claim.json adds no new exposure. */
  private captureRecoverySession(instId: string, value: unknown): void {
    const claim = this.recoveryClaims.get(instId);
    const session = value && typeof value === "object" && "session" in value
      ? (value as { session?: unknown }).session : undefined;
    if (!claim || typeof session !== "string" || session.length === 0) return;
    claim.sessionHandle = session;
    const dir = commDir(this.deps.runDir, instId);
    const evidenceDir = join(dirname(this.deps.runDir), "evidence", claim.taskId);
    writeFileAtomic(join(dir, "claim.json"), JSON.stringify({
      recovery: { taskId: claim.taskId, grantId: claim.grantId, grantFence: claim.grantFence,
        alias: claim.alias, paths: claim.paths, expiresAt: new Date(claim.expiresAt).toISOString(),
        sessionHandle: session },
      evidenceDir, orphanedArtifacts: orphanedArtifacts(evidenceDir),
    }));
    this.log(`sidecar stored recovery session for grant ${claim.grantId} (${instId})`);
  }

  /** A refusal the sidecar made before the broker saw the call: same closed enum, attached to the source task. */
  private async auditRecoveryRefusal(instId: string, grant: { grantId?: string; taskId?: string; grantFence?: number } | undefined,
    outcome: RecoveryReadRefusal, tool: string): Promise<void> {
    try {
      if (!this.deps.core.recoveryReadRefuse) return;
      const cred = await this.credentialFor(instId);
      await this.deps.core.recoveryReadRefuse(cred, {
        ...(grant?.grantId ? { grantId: grant.grantId, grantFence: grant.grantFence } : {}),
        ...(grant?.taskId ? { sourceTaskId: grant.taskId } : {}),
        outcome, tool,
      });
    } catch (error) {
      this.log(`recovery refusal ${outcome} for ${instId} not recorded: ${(error as Error).message.slice(0, 120)}`);
    }
  }

  /** FV06: the server grant is the authority; a local binding that is no longer active is closed, not renewed. */
  private async validateRecovery(instId: string): Promise<void> {
    const claim = this.recoveryClaims.get(instId);
    if (!claim) return;
    if (claim.expiresAt <= Date.now()) {
      await this.auditRecoveryRefusal(instId, claim, "expired", "channel");
      return this.closeRecovery(instId, "expired");
    }
    // One server check per minute and instance; local expiry is checked every sweep.
    const last = this.recoveryCheckedAt.get(instId) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.recoveryCheckedAt.set(instId, Date.now());
    try {
      const cred = await this.credentialFor(instId);
      const grant = await this.deps.core.recoveryGrantFor?.(cred, claim.grantId);
      if (!grant || !["issued", "bound", "running"].includes(grant.state)
        || Date.parse(grant.expiresAt) <= Date.now() || grant.taskId !== claim.taskId) {
        await this.closeRecovery(instId, grant?.state ?? "grant_unavailable");
      }
    } catch (error) {
      await this.closeRecovery(instId, `grant_unreadable: ${(error as Error).message.slice(0, 80)}`);
    }
  }

  /** FV06 reload: rebuild bindings from the complete credential-scoped server read (active only). */
  private async rebuildRecovery(inst: EmployeeInst): Promise<void> {
    if (this.claims.has(inst.id) || this.recoveryClaims.has(inst.id)) return;
    try { await this.adoptRecovery(inst); }
    catch (error) { this.log(`recovery adoption ${inst.id} failed: ${(error as Error).message}`); }
  }

  /**
   * Re-establish the local claim for a lease that survived the restart, then run the
   * turn-end ingest for artifacts the agent may have written while we were down.
   *
   * The server lookup is a complete credential-scoped query (`activeLeases`), not a task
   * list: listTasks is bounded and hides the employee's own review rows, which made a
   * review holder lose its lease after a plugin reload. The server remains the authority:
   * a local claim.json is only trusted for artifact delivery matching, never for deciding
   * that a lease exists. Ambiguous, expired, foreign or unreadable leases fail closed.
   */
  private async rebuildClaim(inst: EmployeeInst): Promise<void> {
    const cred = await this.credentialFor(inst.id);
    if (!this.deps.core.activeLeases) {
      throw new Error("core does not expose activeLeases; refusing to rebuild a lease from a bounded list");
    }
    const leases: ActiveLease[] = await this.deps.core.activeLeases(cred);
    const now = Date.now();
    const mine = leases.filter(lease => lease.currentEmployee === inst.id
      && (lease.state === "doing" || lease.state === "review")
      && !!lease.deliveryId
      && Number.isSafeInteger(lease.fence) && lease.fence >= 1
      && Number.isSafeInteger(lease.version)
      && typeof lease.leaseExpiresAt === "string"
      && Date.parse(lease.leaseExpiresAt) > now);
    const dir = commDir(this.deps.runDir, inst.id);
    if (mine.length > 1) {
      this.log(`sidecar adoption ambiguous for ${inst.id}: ${mine.length} active leases (${mine.map(l => l.taskId).join(", ")})`);
      return;
    }
    if (!mine.length) {
      this.routingUnconfirmed.delete(inst.id);
      // No server lease: the channel may still be live, but claim.json and artifacts are dead.
      // Artifacts finished after the lease was lost stay with their task as evidence.
      const lost = readJsonFile<Partial<ClaimResult>>(join(dir, "claim.json"))?.task?.id;
      this.endLease(inst.id);
      for (const path of [reportPath(dir), blockerPath(dir)]) {
        const text = readTextFile(path);
        if (text !== undefined) this.orphan(inst.id, lost, text, path, "stale");
      }
      return;
    }
    const lease = mine[0]!;
    const task = await this.deps.core.getTask(cred, lease.taskId);
    if (task.state !== lease.state || task.currentEmployee !== inst.id || task.deliveryId !== lease.deliveryId
        || !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= Date.now()
        || !Number.isSafeInteger(task.fence) || task.fence < 1 || !Number.isSafeInteger(task.version)) {
      this.log(`sidecar adoption lease ${lease.taskId} for ${inst.id} changed during recovery; not restoring`);
      return;
    }
    const claimPath = join(dir, "claim.json");
    const prior = readJsonFile<Partial<ClaimResult>>(claimPath);
    const trustedArtifacts = prior?.task?.id === task.id && prior.deliveryId === lease.deliveryId;
    const evidenceDir = join(dirname(this.deps.runDir), "evidence", task.id);
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    // Artifacts of another delivery are not this lease's closeout; keep them with their task.
    if (!trustedArtifacts) for (const path of [reportPath(dir), blockerPath(dir)]) {
      const text = readTextFile(path);
      if (text !== undefined) this.orphan(inst.id, prior?.task?.id, text, path, "stale");
    }
    const snapshot = {
      ...(trustedArtifacts && prior ? prior : {}),
      task,
      deliveryId: lease.deliveryId,
      fence: task.fence,
      leaseExpiresAt: task.leaseExpiresAt,
      history: trustedArtifacts && Array.isArray(prior?.history) ? prior.history : [],
      worktree: task.worktree,
      evidenceDir,
      orphanedArtifacts: orphanedArtifacts(evidenceDir),
    } as ClaimResult & { evidenceDir: string };
    this.routingUnconfirmed.delete(inst.id);
    this.claims.set(inst.id, {
      instId: inst.id, taskId: task.id, phase: lease.state,
      routing: {employee:inst.id,task:task.id,fence:task.fence,role:inst.role,tier:taskTier({model_tier:task.modelTier,kind:task.kind,title:task.title,executor_role:inst.role,reviewer_role:task.reviewerRole}),phase:lease.state==='review'?'review':'execute'},
      routingExpiresAt:Date.parse(task.leaseExpiresAt),
      proof: { taskId: task.id, deliveryId: lease.deliveryId, fence: task.fence, expectedVersion: task.version },
    });
    this.startBeat(inst.id);
    this.log(`sidecar adopted ${lease.state} lease ${task.id} for ${inst.id}`);
    try {
      writeFileAtomic(claimPath, JSON.stringify(snapshot));
      stageBrief(dir, snapshot);
    } catch (error) {
      // The in-memory proof is enough for sck writes; a failed snapshot refresh must not
      // turn a valid recovered lease into no_lease.
      this.log(`adopted claim.json refresh ${inst.id} failed: ${(error as Error).message}`);
    }
    if (!trustedArtifacts) return;
    const blocker = readTextFile(blockerPath(dir));
    const report = readTextFile(reportPath(dir));
    if (lease.state === "review") {
      // report.md is execute-phase closeout; archive it without ending a valid review lease.
      if (report !== undefined) {
        this.log(`adopted review lease ${task.id} for ${inst.id} has report.md; archiving it`);
        this.archive(reportPath(dir), "stale");
      }
      const claim = this.claims.get(inst.id);
      if (blocker !== undefined && claim) await this.finish(inst.id, claim, "gm", blocker, blockerPath(dir));
      return;
    }
    const claim = this.claims.get(inst.id);
    if (!claim) return;
    if (blocker !== undefined) await this.finish(inst.id, claim, "gm", blocker, blockerPath(dir));
    else if (report !== undefined) await this.finish(inst.id, claim, undefined, report, reportPath(dir));
  }

  private startBeat(instId: string): void {
    this.stopBeat(instId);
    const beat = setInterval(() => {
      const live = this.claims.get(instId);
      if (!live) { this.stopBeat(instId); return; }
      void (async () => {
        try {
          const result = await this.callWithCred(instId, cred => this.deps.core.heartbeat(cred, live.proof));
          if (this.claims.get(instId) === live) {
            live.proof.expectedVersion = result.task.version;
            if(result.task.leaseExpiresAt)live.routingExpiresAt=Date.parse(result.task.leaseExpiresAt);
          }
        } catch (error) {
          // Version drift (a concurrent write bumped the task) must not kill the
          // lease: re-read the task and resync the proof. End it only when the
          // lease is genuinely dead — wrong holder, wrong delivery, or expired.
          if (this.claims.get(instId) !== live) return;
          try {
            const cred = await this.credentialFor(instId);
            const task = await this.deps.core.getTask(cred, live.taskId);
            if (this.claims.get(instId) === live && task.currentEmployee === instId && task.deliveryId === live.proof.deliveryId
                && (!task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) > Date.now())) {
              live.proof.expectedVersion = task.version;
              live.proof.fence = task.fence;
              if(task.leaseExpiresAt)live.routingExpiresAt=Date.parse(task.leaseExpiresAt);
              this.log(`heartbeat ${instId} resynced after: ${(error as Error).message}`);
              return;
            }
          } catch { /* getTask failed too — the lease is gone */ }
          this.log(`heartbeat ${instId} failed: ${(error as Error).message}`);
          if (this.claims.get(instId) === live) this.endLease(instId);
        }
      })();
    }, this.deps.heartbeatMs ?? HEARTBEAT_MS);
    if (typeof beat === "object" && "unref" in beat) beat.unref();
    this.beats.set(instId, beat);
  }

  private stopBeat(instId: string): void {
    const beat = this.beats.get(instId);
    if (beat) clearInterval(beat);
    this.beats.delete(instId);
  }

  /** Injected-proof write tools plus identity-scoped reads; capability enforcement stays in core. */
  private async dispatch(
    instId: string, tool: string, args: Record<string, unknown>, forceRotate: boolean,
    request: { lease: LiveClaim | undefined; recovery?: RecoveryClaim },
  ): Promise<unknown> {
    const requestLease = request.lease;
    const core = this.deps.core;
    const ops = this.deps.ops;
    const media = this.deps.media;
    const browser = this.deps.browser;
    const sync = this.deps.sync;
    if (tool === "__list__") return { tools: [...BASE_TOOLS, ...(ops?.tools ?? []), ...(media?.tools ?? []), ...(browser?.tools ?? []), ...(sync?.tools ?? [])] };
    if (tool === "heartbeat") return { ok: true }; // the sidecar owns keepalive
    if (tool === "claim_next") throw Object.assign(new Error("任务由调度通道代领，无需手动 claim"), { code: "forbidden" });
    // SYS01 M1: for a snapshot-backed listing the reply ceiling covers the credential phase too, counted from the same
    // arrival as the answer: a stalled re-issue is refused recoverably inside the one deadline instead of delaying past it.
    const resolveCred = () => (forceRotate ? this.rotateCredential(instId) : this.credentialFor(instId));
    const cred = SNAPSHOT_TOOLS.has(tool) ? await withinReplyCeiling(resolveCred) : await resolveCred();
    // SYS02: the relay forwards the structured acceptance fields the caller declared. A malformed one is refused here
    // instead of being dropped: a silently dropped head would reach the gate as a missing declaration.
    const acceptance = (): { sha?: string; environment?: string } | undefined => {
      const raw = args.acceptance;
      if (raw === undefined || raw === null) return undefined;
      if (typeof raw !== "object" || Array.isArray(raw)) {
        throw Object.assign(new Error("acceptance must be an object with sha and/or environment"), { code: "invalid" });
      }
      const value = raw as Record<string, unknown>;
      const out: { sha?: string; environment?: string } = {};
      if (value.sha !== undefined) {
        if (typeof value.sha !== "string" || value.sha.length === 0 || value.sha.length > 200) {
          throw Object.assign(new Error("acceptance.sha must be a non-empty string up to 200 characters"), { code: "invalid" });
        }
        out.sha = value.sha;
      }
      if (value.environment !== undefined) {
        if (typeof value.environment !== "string" || !/^[a-z][a-z0-9._-]{0,49}$/.test(value.environment)) {
          throw Object.assign(new Error("acceptance.environment must be a controlled environment name"), { code: "invalid" });
        }
        out.environment = value.environment;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    };
    const declared = acceptance();
    // SYS-QUOTA: the relay forwards the subscription quota reset the caller declared on a block.
    // A declared field is never dropped quietly — a dropped reset leaves the provider dispatchable
    // and the manager unparked, which is the P0 this seam caused. A value of the wrong shape is
    // refused here; the instant itself is validated by core.block (parseQuotaResetsAt), the only
    // writer of quota_resets_at, so both the call entry and the file entry below refuse the same
    // texts with the same `invalid` refusal. A near-miss key is refused too, rather than silently
    // ignored as an unknown argument.
    const quotaReset = (): string | undefined => {
      const raw = args.quotaResetsAt;
      if (raw === undefined) {
        const misspelled = Object.keys(args).find(key => key !== "quotaResetsAt" && /^quota_?resets_?at$/i.test(key));
        if (misspelled) {
          throw Object.assign(new Error(`report_blocker takes quotaResetsAt, not ${misspelled}`), { code: "invalid" });
        }
        return undefined;
      }
      if (typeof raw !== "string" || raw.trim().length === 0) {
        throw Object.assign(new Error("quotaResetsAt must be an ISO 8601 instant with a timezone offset, e.g. 2026-10-18T10:12:00-04:00"), { code: "invalid" });
      }
      return raw;
    };
    const evidence = (): Evidence => ({
      ...(args.companyUpgrade === undefined ? {} : { companyUpgrade: args.companyUpgrade as Evidence["companyUpgrade"] }),
      ...(args.executionWindow === undefined ? {} : { executionWindow: args.executionWindow as Evidence["executionWindow"] }),
      ...(args.recoveryReason === undefined ? {} : { recoveryReason: args.recoveryReason as Evidence["recoveryReason"] }),
      text: String(args.text ?? ""),
      idempotencyKey: String(args.idempotencyKey ?? `sidecar-relay:${instId}:${randomBytes(6).toString("hex")}`),
      ...(declared ? { acceptance: declared } : {}),
    });
    const live = () => {
      const claim = this.claims.get(instId);
      if (!claim || claim !== requestLease) throw Object.assign(new Error("no matching active lease for this request"), { code: "no_lease" });
      return claim;
    };
    const writeOp = async (op: (proof: LeaseProof) => Promise<TaskView>, consume = false): Promise<TaskView> => {
      const claim = live();
      const view = await op(claim.proof);
      if (this.claims.get(instId) === claim) {
        if (consume) this.endLease(instId);
        else claim.proof.expectedVersion = view.version;
      }
      return view;
    };
    const gateway = [ops, media, browser, sync].find(item => item?.tools.includes(tool));
    if (gateway) {
      // FV06: a recovery binding authorizes only the ops allowlist, on the source task, with the grant proof
      // injected here. It is never a lease proof: every write tool below still goes through live().
      const recovery = request.recovery;
      if (gateway === ops && recovery) {
        const bound = this.recoveryClaims.get(instId);
        if (bound !== recovery) {
          await this.auditRecoveryRefusal(instId, recovery, "grant_not_bound", tool);
          throw Object.assign(new Error("no active recovery read grant for this request"), { code: "no_grant" });
        }
        if (requestLease) {
          await this.auditRecoveryRefusal(instId, bound, "busy", tool);
          throw Object.assign(new Error("execution and recovery bindings cannot both be active"), { code: "no_grant" });
        }
        if (bound.expiresAt <= Date.now()) {
          await this.auditRecoveryRefusal(instId, bound, "expired", tool);
          void this.closeRecovery(instId, "expired");
          throw Object.assign(new Error("recovery read grant expired"), { code: "no_grant" });
        }
        // 员工不能自带或覆盖源任务与 grant 证明：这些键一律拒绝（不是静默丢弃）。
        for (const key of RECOVERY_RESERVED_ARGS) {
          if (args[key] !== undefined) {
            await this.auditRecoveryRefusal(instId, bound, "reserved_arg", tool);
            throw Object.assign(new Error(`${key} is injected by the channel and must not be supplied`), { code: "invalid" });
          }
        }
        if (!(RECOVERY_READ_TOOLS as readonly string[]).includes(tool)) {
          await this.auditRecoveryRefusal(instId, bound, "not_allowlisted_tool", tool);
          throw Object.assign(new Error(`recovery read allows only ${RECOVERY_READ_TOOLS.join(", ")}`), { code: "forbidden" });
        }
        const value = await gateway.call(cred, bound.taskId, tool, { ...args }, { grantId: bound.grantId, grantFence: bound.grantFence });
        // The single login's handle must survive the turn boundary: keep it in the claim (and claim.json) so the
        // next wake can send the remaining GETs instead of asking for a login the chain will refuse.
        if (tool === "ops_operator_login") this.captureRecoverySession(instId, value);
        return value;
      }
      // The lease decides the task: a taskId in the request is dropped so ops tools only ever act for the task in hand.
      const { taskId: _requested, ...rest } = args;
      const claim = live();
      if (gateway !== ops) return gateway.call(cred, claim.taskId, tool, rest);
      return this.opsCircuit.run({ employee: instId, task: claim.taskId, delivery: claim.proof.deliveryId, tool,
        check: () => { live(); }, invoke: () => gateway.call(cred, claim.taskId, tool, rest),
        block: text => writeOp(proof => core.block(cred, proof, "gm", {
          text, idempotencyKey: `ops-circuit:${claim.proof.deliveryId}:${tool}`,
        }), true),
      });
    }
    switch (tool) {
      case "list_worktrees": return withinReplyCeiling(async () => {
        // R8：不带 taskId 即全局库存，只有 gm 可读，由 core 判定并拒绝员工；租约任务不再作为回退范围。
        // 显式 taskId 走 core 的 getTask 授权。null 与缺省相同（与 MCP、core 同源）：parseWorktreeInput 只接受字符串 taskId。
        const scope = parseWorktreeInput(args).taskId;
        // C1 default: a call that names neither pageSize nor cursor keeps the pre-SYS01 array; a paged call returns { worktrees, page }.
        if (isPaged(args) && core.worktreePage) return core.worktreePage(cred, { ...args, taskId: scope });
        if (core.worktreeList) return core.worktreeList(cred, { ...args, taskId: scope });
        // Cores that predate SYS01 keep the old unpaged array.
        if (!core.listWorktrees) return [];
        return core.listWorktrees(cred, scope);
      });
      case "reclaim_worktrees": {
        // Strict, as on MCP and in core (SYS01, D3): a null or non-boolean dryRun, and a repos that is not a list of paths, are
        // refused before any tree is touched. A non-list repos used to widen silently into a reclaim of every repository.
        const params = parseReclaimInput(args);
        return core.reclaimWorktrees
          ? core.reclaimWorktrees(cred, params)
          : { scanId: "", removed: [], kept: [], branchesDeleted: [], branchesRetained: [], audited: 0 };
      }
      case "list_worktree_audits": return core.listWorktreeAudits
        ? core.listWorktreeAudits(cred, typeof args.limit === "number" ? args.limit : undefined)
        : [];
      // SYS01: bounded pages. A call that names neither pageSize nor cursor keeps the task keys; the company block is in an answer only
      // when includeCompany is true (AC-A, the same default as core). A core without contextView answers the same keys, and ignores
      // scope and paging (SYS01 AC-A note): scope "company" is answered only by a core with contextView.
      case "get_context": return withinReplyCeiling(async () => {
        if (core.contextView) return core.contextView(cred, args);
        const withCompany = args.includeCompany === true;
        return {
          principal: await core.authenticate(cred),
          companyIncluded: withCompany,
          companyRead: { scope: "company", pageSize: 25 },
          ...(withCompany ? { company: await core.companyBrief(cred) } : {}),
          tasks: args.taskId ? [await core.getTask(cred, String(args.taskId))] : await core.listTasks(cred, (args.state ?? undefined) as never),
        };
      });
      case "get_task_history": return withinReplyCeiling(async () => {
        // C2 default: without pageSize or cursor (null counts as absent) the complete history, or response_too_large, in the pre-SYS01 { history } shape of this channel.
        const taskId = taskIdOf(args.taskId);
        if (isPaged(args) && core.historyView) return core.historyView(cred, taskId, args);
        return { history: await core.history(cred, taskId) };
      });
      case "get_admin_summary": return core.adminSummary
        ? core.adminSummary(cred, args)
        : Promise.reject(Object.assign(new Error("core does not expose get_admin_summary"), { code: "temporarily_unavailable" }));
      case "read_task_text": return core.taskText
        ? core.taskText(cred, args)
        : Promise.reject(Object.assign(new Error("core does not expose read_task_text"), { code: "temporarily_unavailable" }));
      // SYS01 R1: the recovery entry a paged list_worktrees item names when its references were cut. Same scope as the listing (core).
      case "read_worktree_refs": return core.worktreeRefs
        ? core.worktreeRefs(cred, args)
        : Promise.reject(Object.assign(new Error("core does not expose read_worktree_refs"), { code: "temporarily_unavailable" }));
      // SYS02: the acceptance gate tools ride the same channel; core owns authorization and the source adapter.
      case "record_acceptance_evidence": return core.recordAcceptanceEvidence
        ? core.recordAcceptanceEvidence(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose record_acceptance_evidence"), { code: "temporarily_unavailable" }));
      case "acceptance_status": return core.acceptanceStatus
        ? core.acceptanceStatus(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose acceptance_status"), { code: "temporarily_unavailable" }));
      case "acceptance_gate": return core.acceptanceGate
        ? core.acceptanceGate(cred)
        : Promise.reject(Object.assign(new Error("core does not expose acceptance_gate"), { code: "temporarily_unavailable" }));
      case "set_acceptance_gate": return core.setAcceptanceGate
        ? core.setAcceptanceGate(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose set_acceptance_gate"), { code: "temporarily_unavailable" }));
      case "acceptance_mapping_preview": return core.acceptanceMappingPreview
        ? core.acceptanceMappingPreview(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose acceptance_mapping_preview"), { code: "temporarily_unavailable" }));
      case "acceptance_mapping_import": return core.acceptanceMappingImport
        ? core.acceptanceMappingImport(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose acceptance_mapping_import"), { code: "temporarily_unavailable" }));
      case "checkpoint": return writeOp(p => core.checkpoint(cred, p, evidence()));
      case "submit": return writeOp(p => core.submit(cred, p, evidence()), true);
      case "review": {
        if (args.decision !== "accept" && args.decision !== "return") {
          throw Object.assign(new Error('review decision must be "accept" or "return"'), { code: "invalid" });
        }
        return writeOp(p => (args.decision === "accept" ? core.accept(cred, p, evidence()) : core.returnTask(cred, p, evidence())), true);
      }
      case "report_blocker": return writeOp(p => core.block(cred, p, args.to === "owner" ? "owner" : "gm", evidence(), quotaReset()), true);
      // SYS05: entering a wait consumes the lease in the same turn — the task takes no employee or provider seat
      // while it waits. The ops sessions and browser spaces opened under this lease are dropped by endLease below.
      case "wait_task": {
        if (!core.wait) return Promise.reject(Object.assign(new Error("core does not expose wait_task"), { code: "temporarily_unavailable" }));
        const { taskId: _t, deliveryId: _d, fence: _f, expectedVersion: _e, ...spec } = args;
        return writeOp(p => core.wait!(cred, p, evidence(), spec as never), true);
      }
      case "resolve_wait": return core.resolveWait
        ? core.resolveWait(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose resolve_wait"), { code: "temporarily_unavailable" }));
      case "cancel_wait": return core.cancelWait
        ? core.cancelWait(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose cancel_wait"), { code: "temporarily_unavailable" }));
      case "extend_wait": return core.extendWait
        ? core.extendWait(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose extend_wait"), { code: "temporarily_unavailable" }));
      case "list_task_waits": return core.listWaits
        ? core.listWaits(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose list_task_waits"), { code: "temporarily_unavailable" }));
      case "wait_handoff_cards": return core.waitHandoffCards
        ? core.waitHandoffCards(cred)
        : Promise.reject(Object.assign(new Error("core does not expose wait_handoff_cards"), { code: "temporarily_unavailable" }));
      case "wait_migration_preview": return core.waitMigrationPreview
        ? core.waitMigrationPreview(cred)
        : Promise.reject(Object.assign(new Error("core does not expose wait_migration_preview"), { code: "temporarily_unavailable" }));
      case "wait_migration_apply": return core.waitMigrationApply
        ? core.waitMigrationApply(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose wait_migration_apply"), { code: "temporarily_unavailable" }));
      case "create_task": return core.createTask(cred, args as never);
      case "create_goal": return core.relayGoal(cred, args as never);
      case "triage_goal": return core.triageGoal(cred, args as never);
      case "create_delivery": return core.createDelivery(cred, args as never);
      case "goal_phase_split": return core.goalPhaseSplit
        ? core.goalPhaseSplit(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose goal_phase_split"), { code: "temporarily_unavailable" }));
      case "record_owner_decision": return core.relayOwnerDecision(cred, args as never);
      case "set_direction": await core.relayDirection(cred, args as never); return { recorded: true };
      // FV06 P0: standbyEmployee turns the resume into an atomic bounded standby assignment
      // (doing + lease + progress_at + standby_until) instead of the ordinary ready hand-off.
      case "resume_task": return args.standbyEmployee && core.resumeStandby
        ? core.resumeStandby(cred, taskIdOf(args.taskId), evidence(), String(args.standbyEmployee))
        : core.resume(cred, taskIdOf(args.taskId), evidence());
      case "verify_standby": return core.verifyStandby
        ? core.verifyStandby(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose verify_standby"), { code: "temporarily_unavailable" }));
      case "defer_task_until": return core.deferTaskUntil(cred, args as never);
      case "append_dependency_prerequisites": return core.appendDependencyPrerequisites
        ? core.appendDependencyPrerequisites(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose append_dependency_prerequisites"), { code: "temporarily_unavailable" }));
      case "retire_task": return core.retireTask(cred, args as never);
      // SYS03 经理处置账本：授权与全部写入都在 core；这里只是同一通道上的入口（sck 与 MCP 同源判定）。
      case "claim_disposition": return core.claimDisposition
        ? core.claimDisposition(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose claim_disposition"), { code: "temporarily_unavailable" }));
      case "release_disposition": return core.releaseDisposition
        ? core.releaseDisposition(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose release_disposition"), { code: "temporarily_unavailable" }));
      case "disposition_status": return core.dispositionStatus
        ? core.dispositionStatus(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose disposition_status"), { code: "temporarily_unavailable" }));
      case "decide_disposition": return core.decideDisposition
        ? core.decideDisposition(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose decide_disposition"), { code: "temporarily_unavailable" }));
      case "holder_notices": {
        if (!core.dispositionNotices || !core.ackDispositionNotices) {
          return Promise.reject(Object.assign(new Error("core does not expose holder_notices"), { code: "temporarily_unavailable" }));
        }
        const ids = Array.isArray(args.ids) ? args.ids as string[] : undefined;
        return withinReplyCeiling(async () => {
          const notices = await core.dispositionNotices!(cred, ids ? { ids } : undefined);
          if (args.ack !== true) return { notices };
          if (!ids?.length) throw Object.assign(new Error("ack requires the ids of the notices being acknowledged"), { code: "invalid" });
          const receipt = await core.ackDispositionNotices!(cred, { ids, error: typeof args.error === "string" ? args.error : undefined });
          return { notices, receipt };
        });
      }
      // SYS03 受控外部动作：core 判定谁可以发起（经理，或该 run 所属任务的当事人），并记录真实内部员工 ID。
      case "cancel_ci_run": return core.cancelCiRun
        ? core.cancelCiRun(cred, { ...(args as Record<string, unknown>), kind: "ci-run-cancel" } as never)
        : Promise.reject(Object.assign(new Error("core does not expose cancel_ci_run"), { code: "temporarily_unavailable" }));
      case "reconcile_ci_runs": return core.reconcileCiRuns
        ? core.reconcileCiRuns(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose reconcile_ci_runs"), { code: "temporarily_unavailable" }));
      case "attribute_ci_run": return core.attributeCiRun
        ? core.attributeCiRun(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose attribute_ci_run"), { code: "temporarily_unavailable" }));
      case "list_external_actions": return core.listExternalActions
        ? core.listExternalActions(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose list_external_actions"), { code: "temporarily_unavailable" }));
      case "task_project_update": return core.taskProjectUpdate
        ? core.taskProjectUpdate(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose task_project_update"), { code: "temporarily_unavailable" }));
      case "task_intent_update": return core.taskIntentUpdate
        ? core.taskIntentUpdate(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose task_intent_update"), { code: "temporarily_unavailable" }));
      case "task_acceptance_amend": return core.taskAcceptanceAmend
        ? core.taskAcceptanceAmend(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose task_acceptance_amend"), { code: "temporarily_unavailable" }));
      case "bind_task_code_repo": return core.bindTaskCodeRepo
        ? core.bindTaskCodeRepo(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose bind_task_code_repo"), { code: "temporarily_unavailable" }));
      case "goal_acceptance_preview": return core.goalAcceptancePreview
        ? core.goalAcceptancePreview(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose goal_acceptance_preview"), { code: "temporarily_unavailable" }));
      case "goal_acceptance_repair": return core.goalAcceptanceRepair
        ? core.goalAcceptanceRepair(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose goal_acceptance_repair"), { code: "temporarily_unavailable" }));
      case "goal_console": return core.goalConsole
        ? core.goalConsole(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose goal_console"), { code: "temporarily_unavailable" }));
      case "goal_governance_scan": return core.goalGovernanceScan
        ? core.goalGovernanceScan(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose goal_governance_scan"), { code: "temporarily_unavailable" }));
      case "goal_metrics": return core.goalMetrics
        ? core.goalMetrics(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose goal_metrics"), { code: "temporarily_unavailable" }));
      case "goal_outcome_register": return core.goalOutcomeRegister
        ? core.goalOutcomeRegister(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose goal_outcome_register"), { code: "temporarily_unavailable" }));
      case "goal_evidence_record": return core.goalEvidenceRecord
        ? core.goalEvidenceRecord(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose goal_evidence_record"), { code: "temporarily_unavailable" }));
      case "goal_finalize": return core.goalFinalize
        ? core.goalFinalize(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose goal_finalize"), { code: "temporarily_unavailable" }));
      case "goal_final_gate_preview": return core.goalFinalGatePreview
        ? core.goalFinalGatePreview(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose goal_final_gate_preview"), { code: "temporarily_unavailable" }));
      case "goal_final_gate_repair": return core.goalFinalGateRepair
        ? core.goalFinalGateRepair(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose goal_final_gate_repair"), { code: "temporarily_unavailable" }));
      case "contributor_dryrun": return core.contributorDryRun
        ? core.contributorDryRun(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose contributor_dryrun"), { code: "temporarily_unavailable" }));
      case "qa_observation_grant": return core.qaObservationGrant
        ? core.qaObservationGrant(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose qa_observation_grant"), { code: "temporarily_unavailable" }));
      case "qa_observation_revoke": return core.qaObservationRevoke
        ? core.qaObservationRevoke(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose qa_observation_revoke"), { code: "temporarily_unavailable" }));
      case "qa_observation_status": return core.qaObservationStatus
        ? core.qaObservationStatus(cred)
        : Promise.reject(Object.assign(new Error("core does not expose qa_observation_status"), { code: "temporarily_unavailable" }));
      case "qa_observation_session": return core.qaObservationSession
        ? core.qaObservationSession(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose qa_observation_session"), { code: "temporarily_unavailable" }));
      case "qa_observation_read": return withinReplyCeiling(async () => {
        if (!core.qaObservationRead) throw Object.assign(new Error("core does not expose qa_observation_read"), { code: "temporarily_unavailable" });
        return withQaRelease(await core.qaObservationRead({ credential: cred }, args as never));
      });
      case "qa_observation_timeline": return withinReplyCeiling(async () => {
        if (!core.qaObservationTimeline) throw Object.assign(new Error("core does not expose qa_observation_timeline"), { code: "temporarily_unavailable" });
        return withQaRelease(await core.qaObservationTimeline({ credential: cred }, args as never));
      });
      case "review_watch_register": return core.reviewWatchRegister
        ? core.reviewWatchRegister(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose review_watch_register"), { code: "temporarily_unavailable" }));
      case "review_watch_close": return core.reviewWatchClose
        ? core.reviewWatchClose(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose review_watch_close"), { code: "temporarily_unavailable" }));
      case "review_watch_status": return core.reviewWatchStatus
        ? core.reviewWatchStatus(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose review_watch_status"), { code: "temporarily_unavailable" }));
      case "qa_review_scope_signal": return core.qaReviewScopeSignal
        ? core.qaReviewScopeSignal(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose qa_review_scope_signal"), { code: "temporarily_unavailable" }));
      case "review_scope_signals": return core.reviewScopeSignals
        ? core.reviewScopeSignals(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose review_scope_signals"), { code: "temporarily_unavailable" }));
      case "qa_observation_text": return withinReplyCeiling(async () => {
        if (!core.qaObservationText) throw Object.assign(new Error("core does not expose qa_observation_text"), { code: "temporarily_unavailable" });
        return withQaRelease(await core.qaObservationText({ credential: cred }, args as never));
      });
      case "implementer_takeover": return core.implementerTakeover
        ? core.implementerTakeover(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose implementer_takeover"), { code: "temporarily_unavailable" }));
      case "independence_set": return core.setIndependence
        ? core.setIndependence(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose independence_set"), { code: "temporarily_unavailable" }));
      case "identity_principal_set": return core.setIdentityPrincipal
        ? core.setIdentityPrincipal(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose identity_principal_set"), { code: "temporarily_unavailable" }));
      case "independence_check": return core.independenceCheck
        ? core.independenceCheck(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose independence_check"), { code: "temporarily_unavailable" }));
      case "policy_set": return core.policySet
        ? core.policySet(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose policy_set"), { code: "temporarily_unavailable" }));
      case "policy_revoke": return core.policyRevoke
        ? core.policyRevoke(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose policy_revoke"), { code: "temporarily_unavailable" }));
      case "policy_list": return core.policyList
        ? core.policyList(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose policy_list"), { code: "temporarily_unavailable" }));
      case "policy_effective": return core.policyEffective
        ? core.policyEffective(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose policy_effective"), { code: "temporarily_unavailable" }));
      case "policy_plan": return core.policyPlan
        ? core.policyPlan(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose policy_plan"), { code: "temporarily_unavailable" }));
      case "policy_enforce": return core.policyEnforce
        ? core.policyEnforce(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose policy_enforce"), { code: "temporarily_unavailable" }));
      case "get_model_evidence": return withinReplyCeiling(async()=> {
        if(!core.modelEvidence) throw new Error("Model evidence unavailable");
        return core.modelEvidence(cred,taskIdOf(args.taskId));
      });
      case "record_score": return core.recordScore(cred, args as never);
      case "get_task_cost": return core.taskCost
        ? core.taskCost(cred, (args as { taskId: string }).taskId)
        : Promise.reject(Object.assign(new Error("core does not expose get_task_cost"), { code: "temporarily_unavailable" }));
      case "def_list": return core.listDefs(cred);
      case "def_ensure": return core.ensureDef(cred, args as never);
      case "project_disciplines_update": return core.updateProjectDisciplines(cred, args as never);
      case "deliverable_publish": {
        // 显式 taskId 供经理代发/补发（免租约）；缺省才取当前租约任务。
        const taskId = args.taskId !== undefined && args.taskId !== null ? String(args.taskId) : live().taskId;
        const { publishDeliverables } = await import("./vendor/src/deliverables.ts");
        return publishDeliverables({
          home: serviceHome(), taskId,
          files: Array.isArray(args.files) ? args.files.map(String) : [],
        });
      }
      // SYS04: a read-only sample of what THIS process is running.
      //
      // The sample is taken here, in the plugin host, because core also runs in the MCP face and a path read
      // there would describe a different execution context than the one the employee's `sck call` reaches. The
      // authorization is core's: it decides whether this caller may read the diagnostics at all, and it does so
      // BEFORE the sample is taken, so an unauthorized read produces no diagnostic at all rather than a refused
      // one that still touched the filesystem. The role set is gm/product/qa — the operators who act on a
      // deployment; a general employee has no business collecting the service's runtime fingerprint.
      case "plugin_runtime_diagnostics": return withinReplyCeiling(async () => {
        if (!core.pluginRuntimeDiagnostics) {
          throw Object.assign(new Error("core does not expose plugin_runtime_diagnostics"), { code: "temporarily_unavailable" });
        }
        return core.pluginRuntimeDiagnostics(cred, async () => {
          const { collectPluginRuntimeDiagnostics } = await import("./runtime-diagnostics.ts");
          // Resolved inside the sample callback so an unauthorised caller (core refuses before sampling)
          // never triggers a host query. The host evaluates a CJS bundle with no module loader, so the
          // registered plugin source is the only legitimate directory this context can supply.
          let pluginSourceDir: string | null = null;
          try {
            pluginSourceDir = (await this.deps.pluginSource?.()) ?? null;
          } catch (error) {
            this.log(`plugin source lookup failed: ${(error as Error).message}`);
          }
          const sample = collectPluginRuntimeDiagnostics(pluginSourceDir ? { pluginSourceDir } : {});
          // The stamp that proves this answer came from the plugin face rather than the MCP one: the MCP process
          // has no plugin server directory, so its own attempt to answer would report the binding unavailable.
          return { ...sample, channel: "plugin-sidecar", instanceId: instId };
        });
      });
      case "fault_status": return core.faultStatus
        ? core.faultStatus(cred, { taskId: String(args.taskId ?? live().taskId) })
        : Promise.reject(Object.assign(new Error("core does not expose fault_status"), { code: "temporarily_unavailable" }));
      case "fault_lift": return core.faultLift
        ? core.faultLift(cred, {
            taskId: String(args.taskId ?? live().taskId),
            incident: String(args.incident ?? ""),
            reason: String(args.reason ?? ""),
            idempotencyKey: String(args.idempotencyKey ?? ""),
          })
        : Promise.reject(Object.assign(new Error("core does not expose fault_lift"), { code: "temporarily_unavailable" }));
      // FV06：恢复取证授权不走执行租约——gm 签发/撤销与只读状态都由 core 按凭证判定，参数原样转交。
      case "recovery_read_grant": return core.recoveryReadGrant
        ? core.recoveryReadGrant(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose recovery_read_grant"), { code: "temporarily_unavailable" }));
      case "recovery_read_grant_revoke": return core.recoveryReadGrantRevoke
        ? core.recoveryReadGrantRevoke(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose recovery_read_grant_revoke"), { code: "temporarily_unavailable" }));
      case "recovery_read_status": return core.recoveryReadStatus
        ? core.recoveryReadStatus(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose recovery_read_status"), { code: "temporarily_unavailable" }));
      case "deploy_drill_run": return core.deployDrillRun
        ? core.deployDrillRun(cred, {
            taskId: String(args.taskId ?? live().taskId),
            runId: String(args.runId ?? ""),
            baseSha: String(args.baseSha ?? ""),
            candidateSha: String(args.candidateSha ?? ""),
            idempotencyKey: String(args.idempotencyKey ?? ""),
          })
        : Promise.reject(Object.assign(new Error("core does not expose deploy_drill_run"), { code: "temporarily_unavailable" }));
      case "deploy_drill_status": return core.deployDrillStatus
        ? core.deployDrillStatus(cred, { runId: String(args.runId ?? "") })
        : Promise.reject(Object.assign(new Error("core does not expose deploy_drill_status"), { code: "temporarily_unavailable" }));
      default: throw Object.assign(new Error(RETIRED_TOOLS.has(tool)
        ? `${tool} 已下线：凭证不再交给员工，需要账号、workspace、登录请用运维工具（sck call ops_info '{}' 查看）`
        : `unknown tool: ${tool}`), { code: "unknown_tool" });
    }
  }

  /** Stops this pool's sweeper and keepalives, as a process exit would. A replacement pool over the same run
   *  directory must be the only one answering it, so a restarted pool closes its predecessor first. */
  close(): void {
    for (const instId of [...this.beats.keys()]) this.stopBeat(instId);
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    const sweep = setInterval(() => this.sweep(), this.deps.sweepMs ?? SWEEP_MS);
    if (typeof sweep === "object" && "unref" in sweep) sweep.unref();
    this.sweeper = sweep;
  }

  private sweep(): void {
    // Keep answering our ended/detached channels, but do not drain directories
    // owned by another pool (e.g. the replacement process during a restart).
    for (const instId of new Set([...this.active, ...this.quarantined])) {
      const live = this.active.has(instId);
      let files: string[];
      try { files = readdirSync(reqDir(commDir(this.deps.runDir, instId))); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith(".json") || this.processing.has(file)) continue;
        this.processing.add(file);
        void Promise.resolve(live ? this.handle(instId, file) : this.rejectOrphan(instId, file))
          .catch((error: unknown) => this.log(`handle ${file} failed: ${(error as Error).message}`))
          .finally(() => this.processing.delete(file));
      }
    }
    // FV06: expiry is local and immediate; the server state is re-read on a slower cadence.
    for (const instId of [...this.recoveryClaims.keys()]) void this.validateRecovery(instId);
  }

  /** Drains a request written after the instance's lease ended — the caller gets an
   *  explicit refusal instead of waiting out its timeout on a dead mailbox. */
  private rejectOrphan(instId: string, file: string): void {
    const dir = commDir(this.deps.runDir, instId);
    try { unlinkSync(join(reqDir(dir), file)); } catch { return; }
    const res: CommResponse = { ok: false, error: "本实例没有有效租约：任务已提交、被收回或已移交，等新的派工再操作" };
    writeFileAtomic(join(resDir(dir), file), JSON.stringify(res));
  }

  private async handle(instId: string, file: string): Promise<void> {
    const dir = commDir(this.deps.runDir, instId);
    const reqPath = join(reqDir(dir), file);
    const req = readJsonFile<CommRequest>(reqPath);
    const request = { lease: this.claims.get(instId), recovery: this.recoveryClaims.get(instId) };
    const arrival = Date.now();
    try { unlinkSync(reqPath); } catch { /* already consumed */ }
    const res: CommResponse = !req
      ? { ok: false, error: "malformed request" }
      : this.quarantined.has(instId) || !this.keys.has(instId) || req.key !== this.keys.get(instId)
        ? { ok: false, error: "stale comm key; this session predates a plugin restart" }
        // SYS01, D3: a null argument object is absent for reads, but for reclaim it is refused: a null never starts a real reclaim.
        : req.tool === "reclaim_worktrees" && req.args === null
          ? { ok: false, error: "invalid: reclaim arguments must be one object" }
          // The request's arrival (stamped above) is kept for the retry too: a listing answer counts its reply ceiling from it (SYS01 M1).
          : await arriving(() => this.dispatch(instId, req.tool, req.args ?? {}, false, request), arrival)
            .catch((error: unknown) => SidecarPool.isAuthError(error)
              // A concurrent adopter may have rotated the credential out from under us; retry once on a fresh one.
              ? arriving(() => this.dispatch(instId, req.tool, req.args ?? {}, true, request), arrival)
              : Promise.reject(error))
            .then(data => ({ ok: true as const, data }))
            .catch((error: Error & { code?: string }) => ({ ok: false as const, error: `${error.code ?? "error"}: ${error.message}` }));
    // Last-line budget check: an over-budget success becomes a recoverable, JSON-legal error (SYS01).
    // A successful call also carries the employee's unacked holder notices (holder_notices and the tool listing
    // already answer with notices / no employee state, so they are skipped). The notices are fitted to the reply's
    // remaining budget first: an in-lease holder sees an acceptance amendment here without being interrupted, an
    // attached notice is delivered (marked below), so it is gone from the next reply, and a notice that did not fit
    // stays undelivered and is attached on the next call.
    // Calls of one employee that arrive together take turns on the read, the attach and the mark (see withNoticeGate).
    const guarded = await this.withNoticeGate(instId, async () => {
      const answer: CommResponse = res.ok && req && req.tool !== "holder_notices" && req.tool !== "__list__"
        ? { ...res, ...(await this.attachNotices(instId, (res as { data?: unknown }).data)) }
        : res;
      const checked = guardRelayResponse(answer);
      // Attaching is delivery: the notices a reply carries are marked before the reply is written. A reply the guard
      // refuses carries none of them, so nothing is marked for it.
      if (checked === answer && answer.notices?.length) await this.markAttached(instId, answer.notices);
      return checked;
    });
    writeFileAtomic(join(resDir(dir), file), JSON.stringify(guarded));
  }
}
