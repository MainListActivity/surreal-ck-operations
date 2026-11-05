/** /api/owner/* JSON 接口：Bearer <owner-token> 鉴权，页面自身与 sck owner 都走这套接口。 */
import type { Company } from "./company";
import { ensureOwnerToken, OWNER_AGENT_HEADER } from "./vendor/src/owner-token.ts";
import { LocalEnrollmentAdmin } from "./vendor/src/enrollment.ts";
import { ownerApi } from "./vendor/src/owner-api.ts";
import { OutboundMessageStore } from "./vendor/src/outbound-messages.ts";
import { OwnerDesk } from "./vendor/src/owner.ts";
import { Workforce } from "./vendor/src/workforce.ts";

export interface OwnerHttpOptions { home: string; company: () => Promise<Company>; opsRepo?: string }

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body),
  { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

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
    if (auth.slice(7).trim() !== token) return json({ error: "invalid owner token" }, 401);
    const via = req.headers.get(OWNER_AGENT_HEADER)?.trim() || "web";
    try {
      const body = req.method === "GET"
        ? Object.fromEntries(url.searchParams) as Record<string, unknown>
        : await req.json() as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad input" }, 400);
      const c = await opts.company();
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
