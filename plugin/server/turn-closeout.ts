import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import type { Company } from "./company";
import { quotaFailure, QUOTA_RELEASE } from "./vendor/src/dispatcher/quota-failure.ts";
const MAX_SILENT_NUDGES = 2;
async function settleTurn(ctx: Pick<Company, "sidecar" | "workforce">, paseo: PaseoApi,
  event: PluginLifecycleEvents["agent.turn_ended"]): Promise<void> {
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
        await paseo.agents.ref(event.agent.id).send(
          `【系统】你上一轮结束时没有提交 report.md 或 blocker.md，任务仍挂在你名下。继续执行当前任务；收尾规则不变：完成写 report.md，受阻写 blocker.md。这是第 ${nudges}/${MAX_SILENT_NUDGES} 次提醒——再次无收尾退出，任务将被收回重派。`
        );
        console.log(`silent-turn nudge ${nudges}/${MAX_SILENT_NUDGES} sent to ${instId} on ${taskId}`);
      } catch (error) {
        console.warn(`silent-turn nudge failed for ${instId} on ${taskId}: ${(error as Error).message}`);
        await ctx.sidecar.releaseClaim(instId, taskId, `第 ${nudges} 轮无收尾退出且会话无法唤醒，收回任务重派`);
      }
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
export function settleCompanyTurn(ctx: Pick<Company, "sidecar" | "workforce">, paseo: PaseoApi,
  event: PluginLifecycleEvents["agent.turn_ended"]): Promise<void> {
  if (!event.turnId) return settleTurn(ctx, paseo, event);
  let seen = turns.get(ctx.sidecar);
  if (!seen) { seen = new Map(); turns.set(ctx.sidecar, seen); }
  const key = `${event.agent.id}:${event.turnId}`;
  const prior = seen.get(key);
  if (prior) return prior;
  const pending = settleTurn(ctx, paseo, event);
  seen.set(key, pending);
  void pending.then(() => {
    if (seen!.size > 512) seen!.delete(seen!.keys().next().value!);
  }, () => { if (seen!.get(key) === pending) seen!.delete(key); });
  return pending;
}
