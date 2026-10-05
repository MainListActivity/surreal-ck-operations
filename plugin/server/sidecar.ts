// Per-agent sidecar pool. Each company employee instance gets a private comm
// directory and an in-memory credential held by the plugin; agents receive only
// SCK_COMM_DIR/SCK_COMM_KEY in their spawn env and never see auth material.
// The sidecar claims tasks on the instance's behalf (dispatcher calls claim()),
// keeps the lease alive while a turn runs, relays `sck call` requests through
// req/res files, and ingests report.md/blocker.md when a turn ends.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blockerPath, commDir, ensureCommDirs, readJsonFile, readTextFile, reportPath, reqDir, resDir,
  writeFileAtomic, type CommRequest, type CommResponse,
} from "./vendor/src/comm.ts";
import { serviceHome } from "./env";
import type { ClaimResult, CompanyCore, Evidence, LeaseProof, TaskView } from "./vendor/src/contracts.ts";
import type { EmployeeInst, SupervisedTask, Workforce } from "./vendor/src/workforce.ts";

const HEARTBEAT_MS = 60_000;
const SWEEP_MS = 400;
const BASE_TOOLS = [
  "get_context", "get_task_history", "checkpoint", "submit", "review", "report_blocker",
  "create_task", "create_goal", "triage_goal", "create_delivery",
  "record_owner_decision", "set_direction", "resume_task", "defer_task_until", "record_score", "heartbeat",
  "deliverable_publish",
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
    const dir = commDir(this.deps.runDir, inst.id);
    ensureCommDirs(dir);
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

  bindAgent(instId: string, agentId: string): void {
    for (const [agent, inst] of this.instByAgent) if (inst === instId) this.instByAgent.delete(agent);
    this.instByAgent.set(agentId, instId);
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

  /** Claims the task as the instance and stages claim.json in its comm dir. */
  async claim(inst: EmployeeInst, task: SupervisedTask): Promise<ClaimResult | undefined> {
    // Legacy instances still carry a credential file their agent reads directly;
    // rotating it here would kill their in-flight work. They phase out naturally.
    if (inst.credentialFile) return undefined;
    const cred = await this.credentialFor(inst.id);
    let result: ClaimResult;
    try {
      result = await this.deps.core.claim(cred, task.id);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (["already_claimed", "forbidden", "no_available_task", "not_found"].includes(code)) return undefined;
      throw error;
    }
    this.deps.ops?.release(inst.id); // sessions never outlive the lease they were opened under
    const dir = commDir(this.deps.runDir, inst.id);
    ensureCommDirs(dir);
    // Evidence attachments (screenshots, exported reports, acceptance manuals) live
    // under the service home, keyed by task so handovers and reviewers share one
    // directory — deliberately outside any git repo so audits never bloat it.
    const evidenceDir = join(dirname(this.deps.runDir), "evidence", task.id);
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(dir, "claim.json"), JSON.stringify({ ...result, evidenceDir }));
    this.claims.set(inst.id, {
      instId: inst.id, taskId: task.id,
      proof: { taskId: task.id, deliveryId: result.deliveryId, fence: result.fence, expectedVersion: result.task.version },
      reportHash: hash(readTextFile(reportPath(dir))),
      blockerHash: hash(readTextFile(blockerPath(dir))),
    });
    this.startBeat(inst.id);
    this.log(`sidecar claimed ${task.id} for ${inst.id}`);
    return result;
  }

  /** Spawn failed after a pre-claim: hand the lease back so the task returns to ready. */
  async releaseClaim(instId: string, _taskId: string, reason: string): Promise<void> {
    const live = this.claims.get(instId);
    this.endLease(instId);
    if (!live) return;
    try {
      const cred = await this.credentialFor(instId);
      await this.deps.core.returnTask(cred, live.proof, { text: `【通道回滚】${reason}`, idempotencyKey: `sidecar-release:${instId}:${live.proof.deliveryId}` });
    } catch (error) {
      this.log(`releaseClaim ${instId} failed (lease will expire): ${(error as Error).message}`);
    }
  }

  /** Turn ended: ingest the agent's artifacts, then let the lease live or die. */
  async settle(agentId: string): Promise<void> {
    const instId = this.instByAgent.get(agentId);
    if (!instId) return;
    this.stopBeat(instId);
    const dir = commDir(this.deps.runDir, instId);
    const blocker = readTextFile(blockerPath(dir));
    const report = readTextFile(reportPath(dir));
    const live = this.claims.get(instId);
    if (!live) {
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
    }
  }

  private async finish(
    instId: string, live: LiveClaim, to: "gm" | undefined,
    text: string, path: string,
  ): Promise<void> {
    const evidence: Evidence = { text, idempotencyKey: `sidecar-file:${instId}:${hash(text)}` };
    try {
      const cred = await this.credentialFor(instId);
      if (to) await this.deps.core.block(cred, live.proof, to, evidence);
      else await this.deps.core.submit(cred, live.proof, evidence);
      this.log(`sidecar ${to ? "blocked" : "submitted"} ${live.taskId} for ${instId}`);
      this.archive(path, "done");
      this.endLease(instId);
    } catch (error) {
      this.log(`sidecar finish ${live.taskId} for ${instId} failed: ${(error as Error).message}`);
      this.archive(path, "failed");
      this.endLease(instId); // lease is already gone or foreign; do not retry
    }
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

  /** Agent archived: drop the binding and credential; any live lease expires on its own. */
  detachAgent(agentId: string): void {
    const instId = this.instByAgent.get(agentId);
    this.instByAgent.delete(agentId);
    if (!instId) return;
    if ([...this.instByAgent.values()].includes(instId)) return;
    this.endLease(instId);
    this.creds.delete(instId);
    this.keys.delete(instId);
    this.active.delete(instId);
  }

  /** Plugin boot: rebuild bindings and live claims for comm-mode instances. */
  async adopt(insts: EmployeeInst[]): Promise<void> {
    for (const inst of insts) {
      if (inst.credentialFile || !inst.paseoAgentId) continue; // legacy token-file sessions keep their own path
      this.instByAgent.set(inst.paseoAgentId, inst.id);
      this.active.add(inst.id);
      const dir = commDir(this.deps.runDir, inst.id);
      ensureCommDirs(dir);
      if (!inst.activeTask) continue;
      try {
        const cred = await this.credentialFor(inst.id); // rotates; old in-memory cred died with the process
        const task = await this.deps.core.getTask(cred, inst.activeTask);
        if (task.currentEmployee === inst.id && task.deliveryId && (task.state === "doing" || task.state === "review")) {
          this.claims.set(inst.id, {
            instId: inst.id, taskId: task.id,
            proof: { taskId: task.id, deliveryId: task.deliveryId, fence: task.fence, expectedVersion: task.version },
            reportHash: hash(readTextFile(reportPath(dir))),
            blockerHash: hash(readTextFile(blockerPath(dir))),
          });
          this.startBeat(inst.id);
          this.log(`sidecar adopted ${inst.id} on ${task.id}`);
        }
      } catch (error) {
        this.log(`adopt ${inst.id} failed: ${(error as Error).message}`);
      }
    }
    this.ensureSweeper();
  }

  private startBeat(instId: string): void {
    this.stopBeat(instId);
    const beat = setInterval(() => {
      const live = this.claims.get(instId);
      if (!live) { this.stopBeat(instId); return; }
      void (async () => {
        try {
          const result = await this.callWithCred(instId, cred => this.deps.core.heartbeat(cred, live.proof));
          live.proof.expectedVersion = result.task.version;
        } catch (error) {
          this.log(`heartbeat ${instId} failed: ${(error as Error).message}`);
          this.endLease(instId);
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
  private async dispatch(instId: string, tool: string, args: Record<string, unknown>, forceRotate = false): Promise<unknown> {
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
      if (!claim) throw Object.assign(new Error("no active lease for this session"), { code: "no_lease" });
      return claim;
    };
    const writeOp = async (op: (proof: LeaseProof) => Promise<TaskView>, consume = false): Promise<TaskView> => {
      const claim = live();
      const view = await op(claim.proof);
      if (consume) this.endLease(instId);
      else claim.proof.expectedVersion = view.version;
      return view;
    };
    if (ops?.tools.includes(tool)) {
      // The lease decides the task: a taskId in the request is dropped so ops tools only ever act for the task in hand.
      const { taskId: _requested, ...rest } = args;
      return ops.call(cred, live().taskId, tool, rest);
    }
    switch (tool) {
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
      case "record_score": return core.recordScore(cred, args as never);
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
    // Scan every comm dir, not just live leases: requests filed after a lease ended
    // must still get an answer or the caller blocks for the full 120s client timeout.
    let instIds: string[];
    try { instIds = readdirSync(this.deps.runDir); } catch { return; }
    for (const instId of instIds) {
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
    try { unlinkSync(reqPath); } catch { /* already consumed */ }
    const res: CommResponse = !req
      ? { ok: false, error: "malformed request" }
      : this.keys.get(instId) !== undefined && req.key !== this.keys.get(instId)
        ? { ok: false, error: "stale comm key; this session predates a plugin restart" }
        : await this.dispatch(instId, req.tool, req.args ?? {})
            .catch((error: unknown) => SidecarPool.isAuthError(error)
              // A concurrent adopter may have rotated the credential out from under us; retry once on a fresh one.
              ? this.dispatch(instId, req.tool, req.args ?? {}, true)
              : Promise.reject(error))
            .then(data => ({ ok: true as const, data }))
            .catch((error: Error & { code?: string }) => ({ ok: false as const, error: `${error.code ?? "error"}: ${error.message}` }));
    writeFileAtomic(join(resDir(dir), file), JSON.stringify(res));
  }
}
