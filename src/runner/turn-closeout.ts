import { unavailableProvider } from '../dispatcher/provider-failover.ts';
import type { TurnEnded, AgentRuntime } from "./contracts.ts";

import type { SidecarPool } from './sidecar.ts';
import type { Workforce } from '../workforce.ts';
import type { OutboundMessageStore } from '../outbound-messages.ts';
interface TurnContext { sidecar: SidecarPool; workforce: Workforce; messages: OutboundMessageStore; sckBin: string }

import { quotaFailure, QUOTA_RELEASE } from "../dispatcher/quota-failure.ts";
import { renderMessage } from "../outbound-messages.ts";
import { latestFindings } from "../dispatcher/brief.ts";
import { readJsonFile } from "../comm.ts";
import { join } from "node:path";
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
  private readonly started = new Map<string, {at: number; turn?: string | null}>();
  constructor(private readonly graceMs = INTERRUPT_GRACE_MS) {}
  get stopping(): boolean { return this.stopped; }
  turnStarted(agentId: string, turn?: string | null): void { this.started.set(agentId, {at: Date.now(), turn}); }
  startedSince(agentId: string, at: number, endedTurn?: string | null): boolean {
    const started = this.started.get(agentId);
    return !!started && (started.at >= at || !!(endedTurn && started.turn && started.turn !== endedTurn));
  }
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

async function settleTurn(ctx: TurnContext, runtime: Pick<AgentRuntime, "send">,
  event: TurnEnded, interruptions?: TurnInterruptions): Promise<void> {
  const quota = quotaFailure(event.outcome, event.timeline);
  const unavailable = unavailableProvider(event.outcome);
  const failure = quota ?? (unavailable ? { reason: '供应商明确返回服务不可用（终止回合）', resetsAt: undefined } : undefined);
  const inst = failure ? (await ctx.workforce.insts()).find(i => i.paseoAgentId === event.agent.id) : undefined;
  if (failure && inst?.provider) {
    // Persist the circuit breaker before returning the task to the queue. If this
    // write fails, leave the lease intact; never turn a failed cooldown into a nudge.
    await ctx.workforce.markExhausted(inst.provider, failure.reason, failure.resetsAt);
  }
  const managed = await ctx.sidecar.settleExecution?.(failure ? { ...event, outcome: { kind: 'failed' } } : event);
  const res = managed ?? await ctx.sidecar.settle(event.agent.id, { infrastructureFailure: !!failure });
  if (failure) {
    if (res.silent) {
      const { instId, taskId } = res.silent;
      await ctx.sidecar.releaseClaim(instId, taskId, `${QUOTA_RELEASE}${failure.reason}；保留任务阶段，等待通道恢复后重派。`, { strict: true, providerFailure: quota ? 'quota' : 'unavailable' });
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
        const role = ctx.sidecar.roleFor(instId) ?? (await ctx.workforce.insts()).find(i => i.id === instId)?.role ?? "engineering";
        const draft = await messages.ensureDraft(taskId, "nudge", role, false, res.silent.phase);
        const prepared = draft.hold ? null : await messages.prepareSend(taskId, "nudge", instId);
        if (prepared) {
          const commDir = ctx.sidecar.commDirFor(instId);
          const claim = readJsonFile<{ history?: Parameters<typeof latestFindings>[0] }>(join(commDir, "claim.json"));
          const findings = latestFindings(claim?.history);
          const body = renderMessage(prepared.body, {
            sckBin: ctx.sckBin, commDir, taskId, ...(findings ? { findingsFile: findings.file } : {}),
          });
          await runtime.send(event.agent.id, body);
          await messages.markSent(prepared.message.id, instId, prepared.message.body);
          console.log(`silent-turn nudge ${nudges}/${MAX_SILENT_NUDGES} sent to ${instId} on ${taskId}`);
        } else {
          // Held by the owner, or waiting for its translation: no send and no notice here (behaviour unchanged, log corrected).
          console.log(`silent-turn nudge ${nudges}/${MAX_SILENT_NUDGES} skipped for ${instId} on ${taskId}: message held or awaiting translation`);
        }
      } catch (error) {
        console.warn(`silent-turn nudge failed for ${instId} on ${taskId}: ${(error as Error).message}`);
        await ctx.sidecar.releaseClaim(instId, taskId, `第 ${nudges} 轮无收尾退出且会话无法唤醒，收回任务重派`);
      }
    } else if (kind !== "completed" && interruptions) {
      const endedAt = event.observedAt ?? Date.now();
      if (interruptions.stopping) {
        console.log(`silent-turn kept ${taskId} on ${instId}: turn ${kind} while the plugin is stopping`);
        return;
      }
      interruptions.defer(async () => {
        if (interruptions.startedSince(event.agent.id, endedAt, event.turnId) || !ctx.sidecar.holdsLease(instId, taskId, res.silent?.deliveryId)) return;
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
export function settleCompanyTurn(ctx: TurnContext, runtime: Pick<AgentRuntime, "send">,
  event: TurnEnded, interruptions?: TurnInterruptions): Promise<void> {
  if (!event.turnId) return settleTurn(ctx, runtime, event, interruptions);
  let seen = turns.get(ctx.sidecar);
  if (!seen) { seen = new Map(); turns.set(ctx.sidecar, seen); }
  const key = ctx.sidecar.turnCloseoutKey?.(event.agent.id, event.turnId)
    ?? JSON.stringify([event.agent.id, event.turnId]);
  const prior = seen.get(key);
  if (prior) return prior;
  const pending = settleTurn(ctx, runtime, event, interruptions);
  seen.set(key, pending);
  void pending.then(() => {
    if (seen!.size > 512) seen!.delete(seen!.keys().next().value!);
  }, () => { if (seen!.get(key) === pending) seen!.delete(key); });
  return pending;
}
