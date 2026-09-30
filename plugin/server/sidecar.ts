// Per-agent sidecar pool. Each company employee instance gets a private comm
// directory and an in-memory credential held by the plugin; agents receive only
// SCK_COMM_DIR/SCK_COMM_KEY in their spawn env and never see auth material.
// The sidecar claims tasks on the instance's behalf (dispatcher calls claim()),
// keeps the lease alive while a turn runs, relays `sck call` requests through
// req/res files, and ingests report.md/blocker.md when a turn ends.
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  blockerPath, commDir, ensureCommDirs, readJsonFile, readTextFile, reportPath, reqDir, resDir,
  writeFileAtomic, type CommRequest, type CommResponse,
} from "./vendor/src/comm.ts";
import type { ClaimResult, CompanyCore, Evidence, LeaseProof, TaskView } from "./vendor/src/contracts.ts";
import type { EmployeeInst, SupervisedTask, Workforce } from "./vendor/src/workforce.ts";

const HEARTBEAT_MS = 60_000;
const SWEEP_MS = 400;
const TOOL_LIST = [
  "get_context", "get_task_history", "checkpoint", "submit", "review", "report_blocker",
  "create_task", "create_goal", "triage_goal", "create_delivery", "get_secret", "put_secret",
  "record_owner_decision", "set_direction", "resume_task", "record_score", "heartbeat",
];

const hash = (text: string | undefined) => (text === undefined ? undefined : createHash("sha256").update(text).digest("hex"));

export interface SidecarDeps {
  core: CompanyCore;
  workforce: Workforce;
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

  bindAgent(instId: string, agentId: string): void {
    for (const [agent, inst] of this.instByAgent) if (inst === instId) this.instByAgent.delete(agent);
    this.instByAgent.set(agentId, instId);
  }

  private async credentialFor(instId: string): Promise<string> {
    const held = this.creds.get(instId);
    if (held) return held;
    // Plugin restart or adoption: re-issue. Retired instances fail here (revoked + retired row).
    const rotated = await this.deps.workforce.rotate(instId);
    this.creds.set(instId, rotated);
    return rotated;
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
    const dir = commDir(this.deps.runDir, inst.id);
    ensureCommDirs(dir);
    writeFileAtomic(join(dir, "claim.json"), JSON.stringify(result));
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
    this.stopBeat(instId);
    this.claims.delete(instId);
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
      this.claims.delete(instId);
    } catch (error) {
      this.log(`sidecar finish ${live.taskId} for ${instId} failed: ${(error as Error).message}`);
      this.archive(path, "failed");
      this.claims.delete(instId); // lease is already gone or foreign; do not retry
    }
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
    this.stopBeat(instId);
    this.claims.delete(instId);
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
          const cred = await this.credentialFor(instId);
          const result = await this.deps.core.heartbeat(cred, live.proof);
          live.proof.expectedVersion = result.task.version;
        } catch (error) {
          this.log(`heartbeat ${instId} failed: ${(error as Error).message}`);
          this.stopBeat(instId);
          this.claims.delete(instId);
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
  private async dispatch(instId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const core = this.deps.core;
    if (tool === "__list__") return { tools: TOOL_LIST };
    if (tool === "heartbeat") return { ok: true }; // the sidecar owns keepalive
    if (tool === "claim_next") throw Object.assign(new Error("任务由调度通道代领，无需手动 claim"), { code: "forbidden" });
    const cred = await this.credentialFor(instId);
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
      if (consume) { this.claims.delete(instId); this.stopBeat(instId); }
      else claim.proof.expectedVersion = view.version;
      return view;
    };
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
      case "get_secret": return { value: await core.getSecret(cred, args as never) };
      case "put_secret": return core.putSecret(cred, args as never);
      case "record_owner_decision": return core.relayOwnerDecision(cred, args as never);
      case "set_direction": await core.relayDirection(cred, args as never); return { recorded: true };
      case "resume_task": return core.resume(cred, String(args.taskId), evidence());
      case "record_score": return core.recordScore(cred, args as never);
      default: throw Object.assign(new Error(`unknown tool: ${tool}`), { code: "unknown_tool" });
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    const sweep = setInterval(() => this.sweep(), this.deps.sweepMs ?? SWEEP_MS);
    if (typeof sweep === "object" && "unref" in sweep) sweep.unref();
    this.sweeper = sweep;
  }

  private sweep(): void {
    for (const instId of this.active) {
      let files: string[];
      try { files = readdirSync(reqDir(commDir(this.deps.runDir, instId))); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith(".json") || this.processing.has(file)) continue;
        this.processing.add(file);
        void this.handle(instId, file).finally(() => this.processing.delete(file));
      }
    }
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
            .then(data => ({ ok: true as const, data }))
            .catch((error: Error & { code?: string }) => ({ ok: false as const, error: `${error.code ?? "error"}: ${error.message}` }));
    writeFileAtomic(join(resDir(dir), file), JSON.stringify(res));
  }
}
