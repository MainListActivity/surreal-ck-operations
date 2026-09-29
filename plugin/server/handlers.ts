import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import { company } from "./company";
import * as rpc from "../shared/rpc";

const SOURCE = "owner:paseo-plugin";

export function registerHandlers(server: PluginServerContext): void {
  server.handle(rpc.inbox, async () => (await company()).owner.inbox());
  server.handle(rpc.brief, async () => (await company()).owner.brief());

  server.handle(rpc.createGoal, async (input: RpcInput<typeof rpc.createGoal>) => {
    const goal = await (await company()).owner.createGoal({
      text: input.text, source: SOURCE, key: input.key, tier: input.tier, project: input.project,
    });
    return { id: goal.id, state: goal.state };
  });

  server.handle(rpc.triageGoal, async (input: RpcInput<typeof rpc.triageGoal>) => {
    const goal = await (await company()).owner.triage(input.goalId, input.tier, "owner:paseo-plugin");
    return { id: goal.id, state: goal.state, tier: goal.tier };
  });

  server.handle(rpc.addDirection, async (input: RpcInput<typeof rpc.addDirection>) => {
    await (await company()).owner.addDirection({ text: input.text, source: SOURCE, key: input.key });
    return { ok: true };
  });

  server.handle(rpc.decide, async (input: RpcInput<typeof rpc.decide>) => {
    const task = await (await company()).owner.decide({
      taskId: input.taskId, decision: input.decision, note: input.note, source: SOURCE, key: input.key,
    });
    return { state: task.state };
  });

  server.handle(rpc.resolveNotice, async (input: RpcInput<typeof rpc.resolveNotice>) => {
    await (await company()).owner.resolveNotice(input.key);
    return { ok: true };
  });

  server.handle(rpc.setPaused, async (input: RpcInput<typeof rpc.setPaused>) => {
    await (await company()).owner.setPaused(input.paused);
    return { ok: true };
  });

  server.handle(rpc.goalTasks, async (input: RpcInput<typeof rpc.goalTasks>) => {
    const { db } = await company();
    const { view } = await import("./vendor/src/core.ts");
    const { id } = await import("./vendor/src/core.ts");
    const [rows] = await db.db.query<[Parameters<typeof view>[0][]]>(
      "SELECT * FROM task WHERE goal = $goal ORDER BY created_at, id;", { goal: id("goal", input.goalId) });
    return { tasks: rows.map(view) };
  });

  server.handle(rpc.taskDetail, async (input: RpcInput<typeof rpc.taskDetail>) => {
    const { db } = await company();
    const { view, id, asId } = await import("./vendor/src/core.ts");
    const task = await db.db.select<any>(id("task", input.taskId));
    if (!task) throw new Error("task not found");
    const [audit] = await db.db.query<[any[]]>(
      "SELECT action, actor, evidence, version, at FROM audit WHERE task = $task ORDER BY at;", { task: task.id });
    return {
      task: view(task as Parameters<typeof view>[0]),
      audit: audit.map(a => ({ action: a.action, actor: asId(a.actor), evidence: a.evidence, version: a.version, at: String(a.at) })),
    };
  });

  server.handle(rpc.roster, async (_input: unknown, { paseo }: { paseo: any }) => {
    const { db, workforce } = await company();
    const cfg = await workforce.config();
    const [health] = await db.db.query<[any[]]>("SELECT provider, state, last_error, until FROM provider_health;");
    const agents = paseo ? await paseo.agents.list() : { entries: [] };
    const statusById = new Map<string, string>(
      (agents.entries ?? []).map((a: any) => [a.id, a.status ?? "unknown"]));
    const usageResult = paseo ? await paseo.providers.listUsage().catch(() => undefined) : undefined;
    return {
      paused: cfg.paused,
      usage: (usageResult?.providers ?? []).map((u: any) => ({
        providerId: u.providerId, displayName: u.displayName, planLabel: u.planLabel, status: u.status,
        windows: (u.windows ?? []).map((w: any) => ({ label: w.label, remainingPct: w.remainingPct, resetsAt: w.resetsAt, tone: w.tone })),
        balances: (u.balances ?? []).map((b: any) => ({ label: b.label, remaining: b.remaining, limit: b.limit, unit: b.unit, tone: b.tone })),
      })),
      defs: (await workforce.defs()).map(d => ({
        id: d.id, role: d.role, provider: d.provider, model: d.model,
        enabled: d.enabled, maxInstances: d.maxInstances, weight: d.weight,
      })),
      instances: (await workforce.insts()).map(i => ({
        id: i.id, def: i.def, role: i.role, provider: i.provider, cwd: i.cwd,
        agentId: i.paseoAgentId, agentStatus: i.paseoAgentId ? statusById.get(i.paseoAgentId) : undefined,
      })),
      health: health.map(h => ({ provider: String(h.provider).split("⟨").pop()?.replace("⟩", "") ?? String(h.provider), state: h.state, lastError: h.last_error, until: h.until })),
    };
  });

  server.handle(rpc.pendingPermissions, async (_input: unknown, { paseo }: { paseo: any }) => {
    const { entries } = await paseo.agents.list();
    const items = [];
    for (const agent of entries ?? []) {
      if (agent.labels?.company !== "surreal-ck") continue;
      const detail = await paseo.agents.ref(agent.id).refresh();
      const pending = detail?.pendingPermissions ?? agent.pendingPermissions ?? [];
      for (const request of pending) {
        items.push({
          agentId: agent.id,
          title: agent.title ?? agent.name,
          employeeId: agent.labels?.employee_id,
          role: agent.labels?.role,
          request: {
            id: request.id,
            kind: request.kind ?? request.type,
            summary: request.summary ?? request.title ?? request.description,
            detail: typeof request.detail === "string" ? request.detail.slice(0, 2000) : undefined,
          },
        });
      }
    }
    return { items };
  });

  server.handle(rpc.answerPermission, async (input: RpcInput<typeof rpc.answerPermission>, { paseo }: { paseo: any }) => {
    await paseo.agents.ref(input.agentId).respondToPermission({
      requestId: input.requestId,
      response: { behavior: input.behavior, message: input.message },
    });
    return { ok: true };
  });
}
