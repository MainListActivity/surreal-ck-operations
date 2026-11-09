import { timingSafeEqual } from "node:crypto";
/** /api/owner/* JSON 接口：Bearer <owner-token> 鉴权，页面自身与 sck owner 都走这套接口。 */
import type { Company } from "./company";
import { ensureOwnerToken, OWNER_AGENT_HEADER } from "./vendor/src/owner-token.ts";
import { LocalEnrollmentAdmin } from "./vendor/src/enrollment.ts";
import { ownerApi } from "./vendor/src/owner-api.ts";
import { OutboundMessageStore } from "./vendor/src/outbound-messages.ts";
import { OwnerDesk } from "./vendor/src/owner.ts";
import { Workforce } from "./vendor/src/workforce.ts";
import {
  answerPermissionFor, pendingPermissionsFor, taskAttachmentsFor, taskAttachmentUrlFor,
} from "./owner-actions.ts";

export interface OwnerHttpOptions { home: string; company: () => Promise<Company>; opsRepo?: string }

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body),
  { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid ${field}`);
  return value.trim();
};

const requirePaseo = (c: Company) => {
  if (!c.paseo) throw new Error("temporarily_unavailable Paseo 会话句柄尚未就绪，请稍后重试");
  return c.paseo;
};

export type PluginCommandResult = { handled: true; value: unknown } | { handled: false };

/**
 * Plugin-only owner commands: Paseo permissions and task attachments.
 * They run the exact helpers the web console routes use, then fall back to src/owner-api.ts
 * for every command that does not need the plugin host.
 */
export async function pluginOwnerCommand(c: Company, home: string, input: Record<string, unknown>): Promise<PluginCommandResult> {
  switch (String(input.command ?? "")) {
    case 'permission.list': return { handled: true, value: await pendingPermissionsFor(requirePaseo(c)) };
    case 'permission.answer': {
      const behavior = requiredText(input.behavior, 'behavior');
      if (behavior !== 'allow' && behavior !== 'deny') throw new Error("invalid behavior");
      return { handled: true, value: await answerPermissionFor(requirePaseo(c), {
        agentId: requiredText(input.agentId, 'agentId'), requestId: requiredText(input.requestId, 'requestId'),
        behavior, message: typeof input.message === 'string' ? input.message : undefined,
      }) };
    }
    case 'task.attachments': return { handled: true, value: await taskAttachmentsFor(home, requiredText(input.taskId, 'taskId')) };
    case 'attachment.url': return { handled: true, value: await taskAttachmentUrlFor(home, requiredText(input.taskId, 'taskId'), requiredText(input.file, 'file')) };
    default: return { handled: false };
  }
}

export function createOwnerApiFetch(opts: OwnerHttpOptions): (req: Request) => Promise<Response> {
  const token = ensureOwnerToken(opts.home);
  process.env.SCK_OWNER_TOKEN = token; // core.authenticate needs the same token for owner-principal writes
  // The owner control-plane principal (employee:owner) must exist in this database for core writes under the token.
  let ownerReady: Promise<void> | undefined;
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/owner/")) return json({ error: "not found" }, 404);
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "owner token required" }, 401);
    const provided = Buffer.from(auth.slice(7).trim(), "utf-8");
    const expected = Buffer.from(token, "utf-8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json({ error: "invalid owner token" }, 401);
    const via = req.headers.get(OWNER_AGENT_HEADER)?.trim() || "web";
    try {
      const body = req.method === "GET"
        ? Object.fromEntries(url.searchParams) as Record<string, unknown>
        : await req.json() as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad input" }, 400);
      const c = await opts.company();
      const plugin = await pluginOwnerCommand(c, opts.home, body);
      if (plugin.handled) return json(plugin.value);
      ownerReady ??= new LocalEnrollmentAdmin(c.db).ensureOwner(opts.home);
      await ownerReady;
      const ctx = {
        db: c.db, core: c.core as never, owner: c.owner ?? new OwnerDesk(c.db, opts.opsRepo),
        workforce: c.workforce ?? new Workforce(c.db, ""),
        messages: new OutboundMessageStore(c.db.db),
        opsRepo: opts.opsRepo ?? c.opsRepo,
        upgrades: c.upgrades,
      };
      const result = await ownerApi(ctx, body, via);
      return json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not found/i.test(message) ? 404 : /invalid|bad input|unknown owner command/i.test(message) ? 400
        : /forbidden|conflict|temporarily_unavailable/i.test(message) ? 409 : 500;
      return json({ error: message.slice(0, 500) }, status);
    }
  };
}
