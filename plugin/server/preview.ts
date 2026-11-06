/**
 * 交付预览（正式版）：HTTP 服务内嵌在 sck-company 插件 server 进程内，随插件生命周期启停。
 * 双监听面：
 *   LAN  面 0.0.0.0:SCK_PREVIEW_PORT（缺省 18777，保持已公布 LAN URL 有效）——无鉴权，
 *        老板 Mac 局域网口径（本任务 spec 明确不做鉴权/白名单）
 *   签名面 127.0.0.1:SCK_PREVIEW_SIGNED_PORT（缺省 18778）——仅当 SCK_PREVIEW_SECRET
 *        已配置才起；公网经 VPS→SSH 反向隧道打到这里，回环绑定天然不可被局域网直连，
 *        因此 LAN 面与公网面彻底分流，隧道流量在签名门控后才触达文件（R2 复核意见）。
 * 路由与安全在 vendor 的 src/preview-core.ts（auth 选项即签名门控），本层只管生命周期、
 * 配置与状态输出（preview-status.json 供 ops_info 兜底读取）。绑定失败每 2s 重试至
 * teardown（R3：部署顺序不再受固定重试窗口约束）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { company } from "./company";
import { loadServiceEnv, serviceHome } from "./env";

/** 与 src/preview-core.ts 的 lanIPv4 等价：本层本地化，避免 vendor 缺席时模块加载即失败。 */
const lanIPv4 = (): string => {
  const nics = networkInterfaces();
  for (const name of ["en0", "en1"]) {
    const hit = nics[name]?.find((i) => !i.internal && i.family === "IPv4");
    if (hit) return hit.address;
  }
  return Object.values(nics).flat().find((i) => i && !i.internal && i.family === "IPv4")?.address ?? "127.0.0.1";
};

type FetchHandler = (req: Request) => Promise<Response>;
type CoreFactory = (opts: { home: string; port: number; auth?: { secret: string } }) => FetchHandler;

export interface PreviewHandle {
  /** LAN 面端口（listen 完成后为实际绑定值）。 */
  readonly port: number;
  readonly lanUrl: string;
  /** 签名面配置与绑定端口（未配置 secret 时 undefined）。 */
  readonly signedPort: number | undefined;
  /** resolve 到 LAN 面实际绑定端口；绑定被永久拒绝时 reject。 */
  readonly ready: Promise<number>;
  /** 幂等：重复调用安全；两个监听端口都释放后 resolve。 */
  stop(): Promise<void>;
}

const STATUS_FILE = "preview-status.json";
const BIND_RETRY_MS = 2_000;

const toRequest = (req: IncomingMessage): Request => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const init: RequestInit = { method: req.method, headers };
  // POST/PUT 必须把 node 请求体接上，否则 handler 里 req.json() 读到空流报 unexpected end of JSON。
  if (req.method !== "GET" && req.method !== "HEAD") {
    (init as RequestInit & { duplex: string }).duplex = "half";
    (init as { body?: unknown }).body = Readable.toWeb(req);
  }
  // Keep the HTTP authority: owner-console POSTs validate Origin against this URL.
  return new Request(`http://${req.headers.host ?? "preview.local"}${req.url ?? "/"}`, init);
};

const send = async (res: ServerResponse, out: Response): Promise<void> => {
  res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
  if (!out.body) { res.end(); return; }
  Readable.fromWeb(out.body as unknown as import("node:stream/web").ReadableStream).pipe(res);
};

let active: PreviewHandle | undefined;

export interface StartPreviewOptions {
  home?: string;
  port?: number;
  /** 签名面端口（缺省 SCK_PREVIEW_SIGNED_PORT 或 18778）。 */
  signedPort?: number;
  /** 测试注入；缺省读 process.env.SCK_PREVIEW_SECRET。 */
  secret?: string;
  /** 测试注入：core 工厂（缺省 lazy import vendor 的 preview-core）。 */
  coreFactory?: CoreFactory;
  /** 老板审核台 handler：/o/ 前缀的请求先走它（自带 token 门控），不进核心文件路由。 */
  consoleFetch?: FetchHandler;
  /** QA 专属只读验收台 handler：/q/ 前缀的请求先走它（受限 cookie 门控），不进核心文件路由。 */
  qaFetch?: FetchHandler;
  log?: (msg: string) => void;
}

interface Listener {
  name: "lan" | "signed";
  server?: Server;
  boundPort?: number;
  dead?: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
}

/** 幂等：已有存活实例时直接复用（同一插件进程重复 contribute 不重复占端口）。 */
export function startPreview(opts: StartPreviewOptions = {}): PreviewHandle {
  if (active) return active;
  loadServiceEnv();
  const home = opts.home ?? serviceHome();
  const lanPort = opts.port ?? Number(process.env.SCK_PREVIEW_PORT ?? 18777);
  const signedPortCfg = opts.signedPort ?? Number(process.env.SCK_PREVIEW_SIGNED_PORT ?? 18778);
  const secret = opts.secret ?? process.env.SCK_PREVIEW_SECRET;
  const log = opts.log ?? ((m: string) => console.log(`[preview] ${m}`));
  const roots = { e: join(home, "evidence"), d: join(home, "deliverables") };
  const startedAt = Date.now();
  let lastError: string | undefined;
  let stopped = false;

  const lan: Listener = { name: "lan" };
  const signed: Listener = { name: "signed" };
  const listeners = [lan, signed];

  const writeStatus = () => {
    try {
      writeFileSync(join(home, STATUS_FILE), JSON.stringify({
        lan: { running: lan.server?.listening === true, port: lan.boundPort ?? lanPort, lanUrl: `http://${lanIPv4()}:${lan.boundPort ?? lanPort}` },
        signed: { configured: Boolean(secret), running: signed.server?.listening === true, port: signed.boundPort ?? null },
        roots, startedAt: new Date(startedAt).toISOString(), lastError,
      }) + "\n");
    } catch { /* 状态文件尽力而为 */ }
  };

  let resolveReady!: (port: number) => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<number>((res, rej) => { resolveReady = res; rejectReady = rej; });

  const listen = (L: Listener, host: string, port: number, handlerFor: () => FetchHandler | undefined) => {
    if (stopped || L.dead) return;
    const consoleHandler = opts.consoleFetch;
    const qaHandler = opts.qaFetch;
    const server = createServer((req, res) => {
      const path = req.url ?? "/";
      const handler = (L.name === "lan" && qaHandler && (path === "/q" || path.startsWith("/q/"))) ? qaHandler
        : (consoleHandler && (path.startsWith("/o/") || (L.name === "lan" && path.startsWith("/api/owner/")))) ? consoleHandler : handlerFor();
      if (!handler) { res.writeHead(503).end("preview core unavailable"); return; }
      Promise.resolve().then(async () => {
        const request = toRequest(req);
        if (new URL(request.url).pathname === "/internal-ai/status") return (await company()).ops.proofStatus(request);
        return handler(request);
      }).then((out) => send(res, out)).catch((err) => {
        lastError = (err as Error).message;
        res.writeHead(500).end("preview error");
      });
    });
    L.server = server;
    server.once("error", (err) => {
      lastError = (err as Error).message;
      writeStatus();
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        log(`${L.name} port ${port} in use, retrying every ${BIND_RETRY_MS}ms until teardown`);
        L.retryTimer = setTimeout(() => listen(L, host, port, handlerFor), BIND_RETRY_MS);
        return;
      }
      L.dead = true;
      log(`${L.name} bind failed permanently: ${lastError}`);
      if (L.name === "lan") rejectReady(err);
    });
    server.listen(port, host, () => {
      L.boundPort = (server.address() as { port: number }).port;
      lastError = undefined;
      if (L.name === "lan") {
        writeStatus();
        log(`deliverable-preview LAN listening http://0.0.0.0:${L.boundPort} → ${handle.lanUrl}`);
        resolveReady(L.boundPort);
      } else {
        writeStatus();
        log(`deliverable-preview signed listening http://127.0.0.1:${L.boundPort} (tunnel-facing)`);
      }
    });
  };

  // core fetch 从 vendor lazy 加载（vendor 缺席时服务仍起，请求 503）
  const coreRef: { lan?: FetchHandler; signed?: FetchHandler } = {};
  void (async () => {
    try {
      const core: CoreFactory = opts.coreFactory
        ?? ((await import("./vendor/src/preview-core.ts")).createPreviewFetch as CoreFactory);
      coreRef.lan = core({ home, port: lanPort });
      if (secret) coreRef.signed = core({ home, port: signedPortCfg, auth: { secret } });
    } catch (err) {
      lastError = (err as Error).message;
      writeStatus();
    }
    listen(lan, "0.0.0.0", lanPort, () => coreRef.lan);
    if (secret) listen(signed, "127.0.0.1", signedPortCfg, () => coreRef.signed);
    else log("signed listener disabled: SCK_PREVIEW_SECRET not set");
  })();

  const handle: PreviewHandle = {
    get port() { return lan.boundPort ?? lanPort; },
    get lanUrl() { return `http://${lanIPv4()}:${lan.boundPort ?? lanPort}`; },
    get signedPort() { return secret ? (signed.boundPort ?? signedPortCfg) : undefined; },
    ready,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const L of listeners) {
        if (L.retryTimer) clearTimeout(L.retryTimer);
        const s = L.server;
        L.server = undefined;
        if (s?.listening) {
          s.closeAllConnections?.();
          await new Promise<void>((res) => s.close(() => res()));
        } else if (s) {
          s.closeAllConnections?.();
          s.close();
        }
      }
      writeStatus();
      if (active === handle) active = undefined;
    },
  };

  active = handle;
  return handle;
}
