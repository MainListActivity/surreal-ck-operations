/**
 * Owner-side helpers shared by the browser console routes and the owner API.
 * Both surfaces must run the same validation and the same mutation path.
 */
import type { PaseoApi } from "@getpaseo/client";

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
