import { createServer, type Server } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RecordId, type Surreal } from "surrealdb";
import {
  digest,
  domainOf,
  modelIdentity,
  taskTier,
  selectedTier,
  employeeTier,
  tierRank,
  type Tier,
} from "./policy.ts";
export interface RoutingLease {
  employee: string;
  task: string;
  fence: number;
  role: string;
  tier: Tier;
  phase: string;
}
export interface GatewayDeps {
  lease(agent: string): Promise<RoutingLease | undefined>;
  record(row: Record<string, unknown>): Promise<void>;
  complete(id: string, completed: boolean): Promise<void>;
  upstream?: string;
  fetchImpl?: typeof fetch;
}
export const ROUTING_PORT = 18779;
/** Project-local settings override a user's global settings.env without changing their personal sessions. */
export function installRoutingSettings(
  comm: string,
  env: Record<string, string>,
): void {
  const dir = join(comm, ".claude"),
    file = join(dir, "settings.local.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let settings: Record<string, any> = {};
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (!existsSync(file + ".sck-before"))
    writeFileSync(
      file + ".sck-before",
      JSON.stringify({
        existed: existsSync(file),
        env: Object.fromEntries(
          Object.keys(env)
            .filter((k) => settings.env?.[k] !== undefined)
            .map((k) => [k, settings.env[k]]),
        ),
      }),
      { mode: 0o600 },
    );
  const next =
    JSON.stringify({ ...settings, env: { ...settings.env, ...env } }, null, 2) +
    "\n";
  writeFileSync(file + ".sck-tmp", next, { mode: 0o600 });
  renameSync(file + ".sck-tmp", file);
  writeFileSync(join(comm, ".sck-model-router"), "v2", { mode: 0o600 });
}
export function restoreRoutingSettings(comm: string): boolean {
  const file = join(comm, ".claude", "settings.local.json"),
    backup = file + ".sck-before";
  if (!existsSync(backup)) return false;
  const before = JSON.parse(readFileSync(backup, "utf8")),
    settings = JSON.parse(readFileSync(file, "utf8"));
  if (
    !/^http:\/\/127\.0\.0\.1:\d+\/a\//.test(
      settings.env?.ANTHROPIC_BASE_URL ?? "",
    )
  )
    return false;
  for (const key of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
  ]) {
    if (Object.hasOwn(before.env, key)) settings.env[key] = before.env[key];
    else delete settings.env[key];
  }
  if (!Object.keys(settings.env).length) delete settings.env;
  if (!before.existed && !Object.keys(settings).length) unlinkSync(file);
  else
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", {
      mode: 0o600,
    });
  unlinkSync(backup);
  try {
    unlinkSync(join(comm, ".sck-model-router"));
  } catch {}
  return true;
}
export function routingEnv(
  agent: string,
  port = ROUTING_PORT,
): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/a/${encodeURIComponent(agent)}`,
    ANTHROPIC_AUTH_TOKEN: "magpie-claude",
    ANTHROPIC_API_KEY: "",
  };
}
/** Loopback only. Fixed upstream, fixed paths, no forwarded credentials, no request/response bodies stored. */
export async function startModelGateway(
  deps: GatewayDeps,
  port = ROUTING_PORT,
): Promise<{ server: Server; port: number; stop(): Promise<void> }> {
  const upstream = new URL(deps.upstream ?? "http://127.0.0.1:3425");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname))
    throw Error("model gateway upstream must be loopback");
  const cooldowns = new Map<string, number>();
  const server = createServer(async (req, res) => {
    if (req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname === "/health" && req.method === "GET") {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const match = u.pathname.match(
      /^\/a\/([^/]+)(\/v1\/(?:messages(?:\/count_tokens)?|responses|chat\/completions))$/,
    );
    if (req.method !== "POST" || !match) {
      res.writeHead(404).end();
      return;
    }
    const abort = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    let execution: string | undefined;
    try {
      const lease = await deps.lease(decodeURIComponent(match[1]!));
      if (!lease) {
        res
          .writeHead(409, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              error: {
                type: "invalid_request_error",
                message:
                  "公司任务租约不可用；请等待调度，不发送未归属的模型请求。",
              },
            }),
          );
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        res.writeHead(400).end();
        return;
      }
      const auxiliary = match[2]!.endsWith("count_tokens");
      // Containment is magpie's: every request names one of its tier groups, and a group never serves
      // outside its members. A concrete model ID is never sent — an unserved one can be answered by
      // the Claude sign-in instead (sonnet, 2026-10-23). The lease's tier is a ceiling: a request may
      // pick a cheaper tier, never a stronger one, and Fable stays owner-only.
      const ceiling = lease.tier === 'fable' ? employeeTier(lease.role) : lease.tier;
      const asked = selectedTier(body.model);
      const tier = asked && tierRank(asked) > tierRank(ceiling) ? asked : ceiling;
      // Older releases may already have injected the gateway into a story-author comm directory.
      // Preserve that author's configured model rather than applying the new employee defaults.
      const requested = lease.role==='story-author' && typeof body.model==='string' ? body.model : `group/sck-${tier}`;
      body.model = requested;
      const session = `sck-${digest(`${lease.task}:${lease.employee}:${lease.fence}:${lease.phase}:${tier}`)}`;
      const cooling = auxiliary ? 0 : (cooldowns.get(session) ?? 0);
      if (cooling > Date.now()) {
        res
          .writeHead(429, {
            "content-type": "application/json",
            "retry-after": String(Math.ceil((cooling - Date.now()) / 1000)),
          })
          .end(
            JSON.stringify({
              error: {
                type: "rate_limit_error",
                message: "模型组暂不可用，正在等待通道恢复。",
              },
            }),
          );
        return;
      }
      if (cooldowns.size > 4096)
        for (const [key, until] of cooldowns)
          if (until <= Date.now()) cooldowns.delete(key);
      if (match[2]!.includes("/messages"))
        body.metadata = { ...body.metadata, user_id: session };
      else body.prompt_cache_key = session;
      const headers = new Headers({
        "content-type": "application/json",
        authorization: "Bearer magpie-claude",
        "x-magpie-session": session,
      });
      for (const name of ["anthropic-version", "anthropic-beta", "accept"]) {
        const v = req.headers[name];
        if (typeof v === "string") headers.set(name, v);
      }
      const started = Date.now();
      // Stickiness to one model per lease is magpie's (`stays=session` on x-magpie-session).
      const reply = await (deps.fetchImpl ?? fetch)(new URL(match[2]!, upstream), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(900000)]),
      });
      const model = modelIdentity(
        reply.headers.get("x-magpie-provider"),
        reply.headers.get("x-magpie-model"),
      );
      if (match[2]!.endsWith("count_tokens")) {
        res.writeHead(reply.status, {
          "content-type":
            reply.headers.get("content-type") ?? "application/json",
        });
        if (reply.body)
          await pipeline(Readable.fromWeb(reply.body as never), res);
        else res.end();
        return;
      }
      const retrySeconds = Math.max(
        15,
        Math.min(900, Number(reply.headers.get("retry-after")) || 60),
      );
      if ([402, 429].includes(reply.status) && !auxiliary)
        cooldowns.set(session, Date.now() + retrySeconds * 1000);
      execution = randomUUID();
      await deps.record({
        id: execution,
        harness: "claude",
        effort_requested:
          body.output_config?.effort ?? body.thinking?.type ?? "unspecified",
        task: lease.task,
        employee: lease.employee,
        fence: lease.fence,
        phase: auxiliary ? "auxiliary" : lease.phase,
        domain: domainOf(lease.role),
        tier,
        requested,
        model: model ?? null,
        status: reply.status,
        completed: false,
        at: new Date(),
        header_ms: Date.now() - started,
        attribution: model ? "gateway-headers" : "unknown",
        retry_seconds: [402, 429].includes(reply.status)
          ? retrySeconds
          : undefined,
      });
      const outgoing: Record<string, string> = {};
      reply.headers.forEach((v, k) => {
        if (
          ![
            "connection",
            "transfer-encoding",
            "content-length",
            "content-encoding",
            "set-cookie",
          ].includes(k)
        )
          outgoing[k] = v;
      });
      res.writeHead(reply.status, outgoing);
      let failed = false,
        terminal = false,
        line = "";
      const decoder = new TextDecoder();
      const sse = reply.headers
        .get("content-type")
        ?.includes("text/event-stream");
      const observe = (text: string) => {
        if (text === "data: [DONE]") {
          terminal = true;
          return;
        }
        if (text === "event: error") {
          failed = true;
          return;
        }
        if (!text.startsWith("data: ")) return;
        try {
          const event = JSON.parse(text.slice(6));
          if (
            event.type === "error" ||
            event.type === "response.failed" ||
            event.error
          )
            failed = true;
          if (
            event.type === "message_stop" ||
            event.type === "response.completed"
          )
            terminal = true;
        } catch {}
      };
      const tap = new Transform({
        transform(chunk, _encoding, callback) {
          if (sse) {
            line += decoder.decode(chunk, { stream: true });
            let pos;
            while ((pos = line.indexOf("\n")) >= 0) {
              observe(line.slice(0, pos).trim());
              line = line.slice(pos + 1);
            }
            if (line.length > 1024 * 1024) line = "";
          }
          callback(null, chunk);
        },
        flush(callback) {
          if (line) observe(line.trim());
          callback();
        },
      });
      if (reply.body)
        await pipeline(Readable.fromWeb(reply.body as never), tap, res);
      else res.end();
      const completed = !failed && (!sse || terminal);
      await deps.complete(execution, completed);
    } catch {
      if (execution) await deps.complete(execution, false).catch(() => {});
      if (!res.headersSent)
        res
          .writeHead(502, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              error: {
                type: "api_error",
                message: "公司模型网关暂不可用；请保留任务并等待恢复。",
              },
            }),
          );
      else res.destroy();
    }
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    server,
    port: (server.address() as { port: number }).port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeIdleConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
export function databaseGateway(db: Surreal): GatewayDeps {
  return {
    async lease(agent) {
      const byEmployee = agent.startsWith("employee:");
      const [employees] = await db.query<
        [Array<{ id: RecordId; role: string; active_task?: RecordId }>]
      >(
        "SELECT id,role,active_task FROM employee WHERE ((paseo_agent_id=$agent) OR (id=$employee)) AND revoked!=true AND retired!=true LIMIT 1;",
        {
          agent,
          employee: new RecordId(
            "employee",
            byEmployee ? agent.slice(9) : "__no_employee__",
          ),
        },
      );
      const e = employees[0];
      if (!e) return;
      if (!e.active_task)
        return {
          employee: String(e.id.id),
          task: "",
          fence: 0,
          role: e.role,
          tier: taskTier({executor_role:e.role}),
          phase: "planning",
        };
      const [task] = await db.query<[any]>(
        "SELECT id,state,kind,title,executor_role,reviewer_role,model_tier,current_employee,fence,lease_expires_at FROM ONLY $task;",
        { task: e.active_task },
      );
      if (
        !task ||
        task.current_employee !== String(e.id.id) ||
        task.lease_expires_at <= Math.floor(Date.now() / 1000) ||
        !["doing", "review"].includes(task.state)
      )
        return;
      return {
        employee: String(e.id.id),
        task: String(task.id.id),
        fence: task.fence,
        role: e.role,
        tier: taskTier(task),
        phase: task.state === "review" ? "review" : "execute",
      };
    },
    async record(row) {
      const { id, ...rest } = row;
      await db
        .create(new RecordId("model_execution", String(id)))
        .content({
          ...rest,
          task: row.task ? new RecordId("task", String(row.task)) : undefined,
        });
    },
    async complete(id, completed) {
      await db.query(
        "UPDATE $id SET completed=$completed,ended_at=time::now() RETURN NONE;",
        { id: new RecordId("model_execution", id), completed },
      );
    },
  };
}
