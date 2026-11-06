/**
 * Model-management commands shared by the browser console routes and the owner API.
 * Both surfaces must run the same validation and the same mutation path; nothing here is
 * copied between the page routes and `sck owner`.
 */
import type { Surreal } from "surrealdb";
import type { PaseoApi } from "@getpaseo/client";

export interface ModelActionCompany {
  db: { db: Surreal };
  modelRanking: import("./vendor/src/model-routing/ranking.ts").RankingRefresher;
  modelRouting: import("./vendor/src/model-routing/controller.ts").ModelRoutingController;
}

/** The owner view of the ranking tables; reads never trigger Jev. */
export async function ownerModelRanking(ctx: ModelActionCompany) {
  const { modelRankingView } = await import("./model-ranking.ts");
  return modelRankingView(ctx.db.db);
}

export async function ownerModelRankingPreview(ctx: ModelActionCompany, policy: unknown, refresh: unknown) {
  if (refresh !== undefined && typeof refresh !== "boolean") throw new Error("invalid refresh");
  return ctx.modelRanking.preview(policy as never, refresh as boolean | undefined);
}

export async function ownerModelRankingSave(ctx: ModelActionCompany,
  input: { rules?: unknown; refreshMinutes?: unknown; policy?: unknown }) {
  const refreshMinutes = (input.refreshMinutes ?? 5) as number;
  if (typeof input.rules !== "string" || input.rules.length > 8000 || ![2, 5, 10].includes(refreshMinutes)) {
    throw new Error("invalid 排序规则或刷新间隔");
  }
  const { saveRankingSettings } = await import("./vendor/src/model-routing/ranking.ts");
  const { rankingPolicy } = await import("./vendor/src/model-routing/weights.ts");
  const policy = input.policy === undefined ? undefined : rankingPolicy(input.policy);
  await saveRankingSettings(ctx.db.db, { rules: input.rules, refreshMinutes, policy }, ctx.modelRanking);
  return { ok: true };
}

export async function ownerModelRankingPin(ctx: ModelActionCompany,
  input: { group?: unknown; model?: unknown; pinned?: unknown }) {
  if (!["sck-haiku", "sck-sonnet", "sck-opus"].includes(input.group as string) ||
    typeof input.model !== "string" || !input.model || input.model.length > 300 || typeof input.pinned !== "boolean") {
    throw new Error("invalid 置顶参数");
  }
  await ctx.modelRanking.setPin(input.group as string, input.model, input.pinned);
  return { ok: true };
}

export async function ownerModelCatalog(ctx: ModelActionCompany,
  input: { query?: unknown; offset?: unknown; limit?: unknown }) {
  const query = typeof input.query === "string" ? input.query : "";
  const offset = typeof input.offset === "number" && Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  const limit = typeof input.limit === "number" && Number.isSafeInteger(input.limit) && input.limit > 0
    ? Math.min(input.limit, 100) : 40;
  return ctx.modelRouting.catalogPage(query, offset, limit);
}

export async function ownerModelMembership(ctx: ModelActionCompany, input: unknown) {
  const { modelMembershipInput } = await import("../shared/rpc.ts");
  const { updateModelMembership } = await import("./model-ranking.ts");
  return updateModelMembership(ctx, modelMembershipInput.parse(input));
}

export async function ownerModelAlias(ctx: ModelActionCompany, input: { model?: unknown; slug?: unknown }) {
  if (typeof input.model !== "string" || !input.model || input.model.length > 300 ||
    !(input.slug === null || (typeof input.slug === "string" && input.slug.length > 0 && input.slug.length <= 200))) {
    throw new Error("invalid 参数");
  }
  const { updateModelAlias } = await import("./model-ranking.ts");
  return updateModelAlias(ctx, { model: input.model, slug: input.slug as string | null });
}

/** Attachment listing shared by the Paseo RPC and the owner CLI/HTTP command. */
export async function taskAttachmentsFor(home: string, taskId: string) {
  const { listTaskAttachments } = await import("./vendor/src/attachments.ts");
  return { attachments: await listTaskAttachments(home, taskId) };
}

/** LAN attachment URL shared by the Paseo RPC and the owner CLI/HTTP command. */
export async function taskAttachmentUrlFor(home: string, taskId: string, name: string) {
  // 老板亲定 LAN 口径：附件打开路径统一为内嵌预览服务 URL（/e/ 路由，无时效）。
  // 公网签名链路（preview-sign + 签名面 :18778）保留给远程可达链路的部署腿。
  const { resolveTaskAttachment } = await import("./vendor/src/attachments.ts");
  const { previewLanBase } = await import("./vendor/src/deliverables.ts");
  const abs = await resolveTaskAttachment(home, taskId, name);
  if (!abs) throw new Error("附件不存在或越界");
  const rel = name.split("/").map(encodeURIComponent).join("/");
  return { url: `${previewLanBase(home)}/e/${encodeURIComponent(taskId)}/${rel}` };
}

/** Pending Paseo permission requests, shared by the Paseo RPC and the owner CLI/HTTP command. */
export async function pendingPermissionsFor(paseo: PaseoApi) {
  const { entries } = await paseo.agents.list();
  const items = [];
  for (const entry of entries ?? []) {
    // The host SDK lists rows as {agent, project}; older snapshots were the agent itself. Read both.
    const agent = ((entry as { agent?: Record<string, any> }).agent ?? entry) as Record<string, any>;
    if (agent.labels?.company !== "surreal-ck") continue;
    const detail = await paseo.agents.ref(agent.id).refresh() as unknown as
      { agent?: { pendingPermissions?: any[] }; pendingPermissions?: any[] } | null;
    const pending = detail?.agent?.pendingPermissions ?? detail?.pendingPermissions ?? agent.pendingPermissions ?? [];
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
}

/** Answers one pending permission, shared by the Paseo RPC and the owner CLI/HTTP command. */
export async function answerPermissionFor(paseo: PaseoApi,
  input: { agentId: string; requestId: string; behavior: "allow" | "deny"; message?: string }) {
  await paseo.agents.ref(input.agentId).respondToPermission({
    requestId: input.requestId,
    response: { behavior: input.behavior, message: input.message },
  });
  return { ok: true };
}
