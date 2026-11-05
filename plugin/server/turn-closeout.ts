import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import type { Company } from "./company";
import { quotaFailure, QUOTA_RELEASE } from "./vendor/src/dispatcher/quota-failure.ts";
const MAX_SILENT_NUDGES = 2;
/** A canceled/failed silent turn waits this long before its lease is surrendered. */
export const INTERRUPT_GRACE_MS = 45_000;

/**
 * A daemon shutdown cancels every running turn a few seconds before the plugin itself is stopped, so a canceled
 * turn cannot tell an employee's dead end from the host going away. The release of a canceled/failed silent turn is
 * deferred: a plugin that stops inside the grace drops it, the lease outlives the restart, and adoption plus the
 * dispatcher's in-place resume give the same employee its task back. A turn started meanwhile settles on its own.
 */
export class TurnInterruptions {
  private stopped = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly started = new Map<string, number>();
  constructor(private readonly graceMs = INTERRUPT_GRACE_MS) {}
  get stopping(): boolean { return this.stopped; }
  turnStarted(agentId: string): void { this.started.set(agentId, Date.now()); }
  startedSince(agentId: string, at: number): boolean { return (this.started.get(agentId) ?? 0) >= at; }
  defer(run: () => Promise<void>): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) void run().catch(error => console.warn(`deferred turn release failed: ${(error as Error).message}`));
    }, this.graceMs);
    this.timers.add(timer);
  }
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

async function settleTurn(ctx: Pick<Company, "sidecar" | "workforce" | "messages">, paseo: PaseoApi,
  event: PluginLifecycleEvents["agent.turn_ended"], interruptions?: TurnInterruptions): Promise<void> {
  const failure = quotaFailure(event.outcome, event.timeline);
  const inst = failure ? (await ctx.workforce.insts()).find(i => i.paseoAgentId === event.agent.id) : undefined;
  if (failure && inst?.provider) {
    // Persist the circuit breaker before returning the task to the queue. If this
    // write fails, leave the lease intact; never turn a failed cooldown into a nudge.
    await ctx.workforce.markExhausted(inst.provider, failure.reason, failure.resetsAt);
  }
  const res = await ctx.sidecar.settle(event.agent.id, { infrastructureFailure: !!failure });
  if (failure) {
    if (res.silent) {
      const { instId, taskId } = res.silent;
      await ctx.sidecar.releaseClaim(instId, taskId, `${QUOTA_RELEASE}${failure.reason}；保留任务阶段，等待通道恢复后重派。`, { strict: true });
      if (event.turnId) await ctx.workforce.refundQuotaWake(instId, event.turnId);
    }
    return;
  }
  // A turn that closed without report.md/blocker.md leaves the lease alive
  // but the agent idle — a completed turn gets a bounded wake nudge, a
  // failed/canceled turn (or a nudge budget already spent) surrenders the
  // claim server-side so the task goes back to ready instead of wedging.
  if (res.status === "silent" && res.silent) {
    const { instId, taskId, nudges } = res.silent;
    const kind = event.outcome?.kind ?? "completed";
    if (kind === "completed" && nudges <= MAX_SILENT_NUDGES) {
      try {
        // 催办也走 outbound_message 表：draft 在触发时生成，hold 则不催办（老板留着放行）。
        const messages = ctx.messages;
        const draft = await messages.ensureDraft(taskId, "nudge", "owner", false, res.silent.phase);
        const prepared = draft.hold ? null : await messages.prepareSend(taskId, "nudge", instId);
        if (prepared) await paseo.agents.ref(event.agent.id).send(prepared.body);
        console.log(`silent-turn nudge ${nudges}/${MAX_SILENT_NUDGES} sent to ${instId} on ${taskId}`);
      } catch (error) {
        console.warn(`silent-turn nudge failed for ${instId} on ${taskId}: ${(error as Error).message}`);
        await ctx.sidecar.releaseClaim(instId, taskId, `第 ${nudges} 轮无收尾退出且会话无法唤醒，收回任务重派`);
      }
    } else if (kind !== "completed" && interruptions) {
      const endedAt = Date.now();
      if (interruptions.stopping) {
        console.log(`silent-turn kept ${taskId} on ${instId}: turn ${kind} while the plugin is stopping`);
        return;
      }
      interruptions.defer(async () => {
        if (interruptions.startedSince(event.agent.id, endedAt) || !ctx.sidecar.holdsLease(instId, taskId)) return;
        await ctx.sidecar.releaseClaim(instId, taskId, `turn 以 ${kind} 结束且未提交 report.md/blocker.md，回收任务重派`);
        console.log(`silent-turn released ${taskId} from ${instId} (outcome=${kind}, silent turns=${nudges})`);
      });
      console.log(`silent-turn ${kind} on ${taskId} from ${instId}: release deferred ${INTERRUPT_GRACE_MS / 1000}s`);
    } else {
      const reason = kind === "completed"
        ? `连续 ${nudges} 轮无收尾退出，放弃本轮并回收任务重派`
        : `turn 以 ${kind} 结束且未提交 report.md/blocker.md，回收任务重派`;
      await ctx.sidecar.releaseClaim(instId, taskId, reason);
      console.log(`silent-turn released ${taskId} from ${instId} (outcome=${kind}, silent turns=${nudges})`);
    }
  }
}


// Lifecycle delivery can be repeated; a turn must not double its cooldown or settle
// the next lease that this agent acquired. Failed writes remain retryable.
const turns = new WeakMap<object, Map<string, Promise<void>>>();
export function settleCompanyTurn(ctx: Pick<Company, "sidecar" | "workforce" | "messages">, paseo: PaseoApi,
  event: PluginLifecycleEvents["agent.turn_ended"], interruptions?: TurnInterruptions): Promise<void> {
  if (!event.turnId) return settleTurn(ctx, paseo, event, interruptions);
  let seen = turns.get(ctx.sidecar);
  if (!seen) { seen = new Map(); turns.set(ctx.sidecar, seen); }
  const key = `${event.agent.id}:${event.turnId}`;
  const prior = seen.get(key);
  if (prior) return prior;
  const pending = settleTurn(ctx, paseo, event, interruptions);
  seen.set(key, pending);
  void pending.then(() => {
    if (seen!.size > 512) seen!.delete(seen!.keys().next().value!);
  }, () => { if (seen!.get(key) === pending) seen!.delete(key); });
  return pending;
}
