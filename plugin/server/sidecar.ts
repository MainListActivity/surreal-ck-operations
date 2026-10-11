// Per-agent sidecar pool. Each company employee instance gets a private comm
// directory and an in-memory credential held by the plugin; agents receive only
// SCK_COMM_DIR/SCK_COMM_KEY in their spawn env and never see auth material.
// The sidecar claims tasks on the instance's behalf (dispatcher calls claim()),
// keeps the lease alive while a turn runs, relays `sck call` requests through
// req/res files, and ingests report.md/blocker.md when a turn ends.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blockerPath, commDir, ensureCommDirs, readJsonFile, readTextFile, reportPath, reqDir, resDir,
  writeFileAtomic, type CommRequest, type CommResponse,
} from "./vendor/src/comm.ts";
import { serviceHome } from "./env";
import type { ClaimResult, CompanyCore, Evidence, LeaseProof, TaskView, WorktreeAssignment } from "./vendor/src/contracts.ts";
import type { EmployeeInst, SupervisedTask, Workforce } from "./vendor/src/workforce.ts";

const HEARTBEAT_MS = 60_000;
const SWEEP_MS = 400;
const BASE_TOOLS = [
  "get_context", "get_task_history", "list_worktrees", "reclaim_worktrees", "list_worktree_audits", "checkpoint", "submit", "review", "report_blocker",
  "create_task", "create_goal", "triage_goal", "create_delivery",
  "record_owner_decision", "set_direction", "resume_task", "defer_task_until", "retire_task",
  "record_score", "heartbeat", "deliverable_publish",
  // Manage capability (gm/product) only, enforced in core; writes land in audit.
  "def_list", "def_ensure", "project_disciplines_update",
  // gm only in core (rebind a blocked task to a registered project; audited, version-guarded).
  "task_project_update",
  // gm only in core (bind a blocked execute-phase task's code repo; audited, version-guarded).
  "bind_task_code_repo",
];

/** Still named by tasks written before credentials left the agent; answer with where to go instead of a bare "unknown tool". */
const RETIRED_TOOLS = new Set(["get_secret", "put_secret"]);

const hash = (text: string | undefined) => (text === undefined ? undefined : createHash("sha256").update(text).digest("hex"));

/** Capability broker behind the `ops_*` tools (OpsBroker). Credentials and login tokens stay on its side. */
export interface OpsGateway {
  readonly tools: readonly string[];
  call(credential: string, taskId: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** The employee instance is done with its lease or gone: drop every session opened for it. */
  release(employeeId: string): void;
}

export interface SidecarDeps {
  core: CompanyCore;
  workforce: Workforce;
  /** Absent in tests that do not exercise ops; `ops_*` tools are then unknown. */
  ops?: OpsGateway;
  /** Root under which per-instance comm dirs live. */
  runDir: string;
  log?: (message: string) => void;
  /** Injectable for tests. */
  heartbeatMs?: number;
  sweepMs?: number;
}

interface LiveClaim {
  instId: string;
  taskId: string;
  proof: LeaseProof;
  /** Hash of artifact content already consumed, so a stale file never submits twice. */
  reportHash?: string;
  blockerHash?: string;
}

export class SidecarPool {
  private readonly launched = new Set<string>();
  private readonly quarantined = new Set<string>();
  private readonly creds = new Map<string, string>();
  private readonly keys = new Map<string, string>();
  private readonly claims = new Map<string, LiveClaim>();
  private readonly instByAgent = new Map<string, string>();
  private readonly beats = new Map<string, ReturnType<typeof setInterval>>();
  private readonly active = new Set<string>();
  private readonly processing = new Set<string>();
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: SidecarDeps) {}
  private log(message: string) { this.deps.log?.(message); }

  /** Spawn env for a fresh instance: comm channel only. Minted credential stays in memory. */
  env(inst: EmployeeInst): Record<string, string> {
    if (this.quarantined.has(inst.id) || (inst.paseoAgentId && !this.canReuse(inst))) {
      throw Object.assign(new Error("session channel cannot be restored; retire the instance"), { code: "stale_channel" });
    }
    const dir = commDir(this.deps.runDir, inst.id);
    ensureCommDirs(dir);
    const held = this.keys.get(inst.id);
    if (held) return { SCK_COMM_DIR: dir, SCK_COMM_KEY: held };
    this.launched.add(inst.id);
    const key = randomBytes(16).toString("hex");
    this.keys.set(inst.id, key);
    this.active.add(inst.id);
    if (inst.credential) this.creds.set(inst.id, inst.credential);
    this.ensureSweeper();
    return { SCK_COMM_DIR: dir, SCK_COMM_KEY: key };
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
      return task.currentEmployee !== held.instId
          || task.deliveryId !== held.proof.deliveryId
          || (task.leaseExpiresAt !== undefined && Date.parse(task.leaseExpiresAt) <= Date.now());
    } catch {
      return true; // unreachable/removed task — never worth blocking dispatch on
    }
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
    const cred = await this.credentialFor(inst.id);
    let result: ClaimResult;
    try {
      result = await this.deps.core.claim(cred, task.id);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (["already_claimed", "forbidden", "no_available_task", "not_found", "worktree_busy"].includes(code)) return undefined;
      throw error;
    }
    this.deps.ops?.release(inst.id); // sessions never outlive the lease they were opened under
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
    writeFileAtomic(join(dir, "claim.json"), JSON.stringify({ ...result, evidenceDir }));
    // A new lease must not inherit a previous turn's artifacts: archive them so an
    // identical-looking new report still submits instead of matching a stale hash.
    this.archive(reportPath(dir), "stale");
    this.archive(blockerPath(dir), "stale");
    this.claims.set(inst.id, {
      instId: inst.id, taskId: task.id,
      proof: { taskId: task.id, deliveryId: result.deliveryId, fence: result.fence, expectedVersion: result.task.version },
    });
    this.startBeat(inst.id);
    this.log(`sidecar claimed ${task.id} for ${inst.id}`);
    return result;
  }

  /** Spawn/wake/workspace-handoff rollback after a pre-claim: hand the lease back without a
   * reviewer verdict — never routed through returnTask, which would fake a return and bounce
   * a review task back to doing. Cores without the release op let the lease expire on its own. */
  async releaseClaim(instId: string, _taskId: string, reason: string): Promise<void> {
    const live = this.claims.get(instId);
    this.endLease(instId);
    if (!live) return;
    try {
      const cred = await this.credentialFor(instId);
      await this.deps.core.release?.(cred, live.proof, { text: `【通道回滚】${reason}`, idempotencyKey: `sidecar-release:${instId}:${live.proof.deliveryId}` });
    } catch (error) {
      this.log(`releaseClaim ${instId} failed (lease will expire): ${(error as Error).message}`);
    }
  }

  /** Turn ended: ingest the agent's artifacts, then let the lease live or die.
   * The keepalive is NOT stopped here — the claim may outlive this turn (multi-turn
   * work), and a claim whose beat died becomes an orphan no heartbeat can expire. */
  async settle(agentId: string): Promise<void> {
    const instId = this.instByAgent.get(agentId);
    if (!instId) return;
    const dir = commDir(this.deps.runDir, instId);
    const blocker = readTextFile(blockerPath(dir));
    const report = readTextFile(reportPath(dir));
    const live = this.claims.get(instId);
    if (!live) {
      await this.deps.core.releaseWorkspace?.(await this.credentialFor(instId)).catch(() => undefined);
      // No lease to act on; rename stale artifacts so they are not retried forever.
      for (const [text, path] of [[blocker, blockerPath(dir)], [report, reportPath(dir)]] as const) {
        if (text !== undefined) this.archive(path, "orphaned");
      }
      return;
    }
    if (blocker !== undefined && hash(blocker) !== live.blockerHash) {
      await this.finish(instId, live, "gm", blocker, blockerPath(dir));
      return;
    }
    if (report !== undefined && hash(report) !== live.reportHash) {
      await this.finish(instId, live, undefined, report, reportPath(dir));
      return;
    }
    this.log(`turn ended without new report/blocker: ${instId} on ${live.taskId}`);
  }

  private async finish(
    instId: string, live: LiveClaim, to: "gm" | undefined,
    text: string, path: string,
  ): Promise<void> {
    const evidence: Evidence = { text, idempotencyKey: `sidecar-file:${instId}:${live.proof.deliveryId}:${hash(text)}` };
    try {
      const cred = await this.credentialFor(instId);
      if (to) await this.deps.core.block(cred, live.proof, to, evidence);
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
    this.stopBeat(instId);
    this.claims.delete(instId);
    this.deps.ops?.release(instId);
    // claim.json describes a dead lease — remove it so a re-used/woken agent knows it holds nothing.
    try { unlinkSync(join(commDir(this.deps.runDir, instId), "claim.json")); } catch { /* already gone */ }
  }

  private archive(path: string, tag: string): void {
    try { renameSync(path, `${path}.${tag}-${Date.now().toString(36)}`); } catch { /* already gone */ }
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
      try { await this.rebuildClaim(inst); }
      catch (error) { this.log(`adopt lease check ${inst.id} failed: ${(error as Error).message}`); }
    }
    this.ensureSweeper();
  }

  /**
   * Re-establish the local claim for a lease that survived the restart, then run
   * the turn-end ingest for artifacts the agent may have written while we were
   * down. Only ingest when claim.json still names this delivery — older files
   * belong to a dead lease and are archived as stale.
   */
  private async rebuildClaim(inst: EmployeeInst): Promise<void> {
    const cred = await this.credentialFor(inst.id);
    const doing = await this.deps.core.listTasks(cred, "doing");
    const live = doing.find(t => t.currentEmployee === inst.id && !!t.deliveryId &&
      (!t.leaseExpiresAt || Date.parse(t.leaseExpiresAt) > Date.now()));
    if (!live) return;
    const dir = commDir(this.deps.runDir, inst.id);
    this.claims.set(inst.id, {
      instId: inst.id, taskId: live.id,
      proof: { taskId: live.id, deliveryId: live.deliveryId!, fence: live.fence, expectedVersion: live.version },
    });
    this.startBeat(inst.id);
    this.log(`sidecar adopted lease ${live.id} for ${inst.id}`);
    const claimMeta = readJsonFile<{ deliveryId?: string }>(join(dir, "claim.json"));
    if (claimMeta?.deliveryId !== live.deliveryId) {
      this.archive(reportPath(dir), "stale");
      this.archive(blockerPath(dir), "stale");
      return;
    }
    const blocker = readTextFile(blockerPath(dir));
    const report = readTextFile(reportPath(dir));
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
          if (this.claims.get(instId) === live) live.proof.expectedVersion = result.task.version;
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
    request: { lease: LiveClaim | undefined },
  ): Promise<unknown> {
    const requestLease = request.lease;
    const core = this.deps.core;
    const ops = this.deps.ops;
    if (tool === "__list__") return { tools: [...BASE_TOOLS, ...(ops?.tools ?? [])] };
    if (tool === "heartbeat") return { ok: true }; // the sidecar owns keepalive
    if (tool === "claim_next") throw Object.assign(new Error("任务由调度通道代领，无需手动 claim"), { code: "forbidden" });
    const cred = forceRotate ? await this.rotateCredential(instId) : await this.credentialFor(instId);
    const evidence = (): Evidence => ({
      text: String(args.text ?? ""),
      idempotencyKey: String(args.idempotencyKey ?? `sidecar-relay:${instId}:${randomBytes(6).toString("hex")}`),
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
    if (ops?.tools.includes(tool)) {
      // The lease decides the task: a taskId in the request is dropped so ops tools only ever act for the task in hand.
      const { taskId: _requested, ...rest } = args;
      return ops.call(cred, live().taskId, tool, rest);
    }
    switch (tool) {
      case "list_worktrees": {
        if (!core.listWorktrees) return [];
        if (args.taskId !== undefined) return core.listWorktrees(cred, String(args.taskId));
        // GM 缺省取全局库存（runbook：list_worktrees {}）；员工缺省仍按当前租约任务取数。
        const actor = await core.authenticate(cred);
        return core.listWorktrees(cred, actor.role === "gm" ? undefined : live().taskId);
      }
      case "reclaim_worktrees": return core.reclaimWorktrees
        ? core.reclaimWorktrees(cred, {
            dryRun: args.dryRun === true,
            repos: Array.isArray(args.repos) ? args.repos.map(String) : undefined,
          })
        : { scanId: "", removed: [], kept: [], branchesDeleted: [], branchesRetained: [], audited: 0 };
      case "list_worktree_audits": return core.listWorktreeAudits
        ? core.listWorktreeAudits(cred, typeof args.limit === "number" ? args.limit : undefined)
        : [];
      case "get_context":
        return {
          principal: await core.authenticate(cred),
          company: await core.companyBrief(cred),
          tasks: args.taskId ? [await core.getTask(cred, String(args.taskId))] : await core.listTasks(cred, args.state as never),
        };
      case "get_task_history": return { history: await core.history(cred, String(args.taskId)) };
      case "checkpoint": return writeOp(p => core.checkpoint(cred, p, evidence()));
      case "submit": return writeOp(p => core.submit(cred, p, evidence()), true);
      case "review": return writeOp(p => (args.decision === "accept" ? core.accept(cred, p, evidence()) : core.returnTask(cred, p, evidence())), true);
      case "report_blocker": return writeOp(p => core.block(cred, p, args.to === "owner" ? "owner" : "gm", evidence()), true);
      case "create_task": return core.createTask(cred, args as never);
      case "create_goal": return core.relayGoal(cred, args as never);
      case "triage_goal": return core.triageGoal(cred, args as never);
      case "create_delivery": return core.createDelivery(cred, args as never);
      case "record_owner_decision": return core.relayOwnerDecision(cred, args as never);
      case "set_direction": await core.relayDirection(cred, args as never); return { recorded: true };
      case "resume_task": return core.resume(cred, String(args.taskId), evidence());
      case "defer_task_until": return core.deferTaskUntil(cred, args as never);
      case "retire_task": return core.retireTask(cred, args as never);
      case "task_project_update": return core.taskProjectUpdate
        ? core.taskProjectUpdate(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose task_project_update"), { code: "temporarily_unavailable" }));
      case "bind_task_code_repo": return core.bindTaskCodeRepo
        ? core.bindTaskCodeRepo(cred, args as never)
        : Promise.reject(Object.assign(new Error("core does not expose bind_task_code_repo"), { code: "temporarily_unavailable" }));
      case "record_score": return core.recordScore(cred, args as never);
      case "def_list": return core.listDefs(cred);
      case "def_ensure": return core.ensureDef(cred, args as never);
      case "project_disciplines_update": return core.updateProjectDisciplines(cred, args as never);
      case "deliverable_publish": {
        // 显式 taskId 供经理代发/补发（免租约）；缺省才取当前租约任务。
        const taskId = args.taskId !== undefined ? String(args.taskId) : live().taskId;
        const { publishDeliverables } = await import("./vendor/src/deliverables.ts");
        return publishDeliverables({
          home: serviceHome(), taskId,
          files: Array.isArray(args.files) ? args.files.map(String) : [],
        });
      }
      default: throw Object.assign(new Error(RETIRED_TOOLS.has(tool)
        ? `${tool} 已下线：凭证不再交给员工，需要账号、workspace、登录请用运维工具（sck call ops_info '{}' 查看）`
        : `unknown tool: ${tool}`), { code: "unknown_tool" });
    }
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
    const request = { lease: this.claims.get(instId) };
    try { unlinkSync(reqPath); } catch { /* already consumed */ }
    const res: CommResponse = !req
      ? { ok: false, error: "malformed request" }
      : this.quarantined.has(instId) || !this.keys.has(instId) || req.key !== this.keys.get(instId)
        ? { ok: false, error: "stale comm key; this session predates a plugin restart" }
        : await this.dispatch(instId, req.tool, req.args ?? {}, false, request)
            .catch((error: unknown) => SidecarPool.isAuthError(error)
              // A concurrent adopter may have rotated the credential out from under us; retry once on a fresh one.
              ? this.dispatch(instId, req.tool, req.args ?? {}, true, request)
              : Promise.reject(error))
            .then(data => ({ ok: true as const, data }))
            .catch((error: Error & { code?: string }) => ({ ok: false as const, error: `${error.code ?? "error"}: ${error.message}` }));
    writeFileAtomic(join(resDir(dir), file), JSON.stringify(res));
  }
}
