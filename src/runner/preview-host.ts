/**
 * 执行端内的交付预览服务（原先由 Paseo 插件承载）：
 *   LAN  面 0.0.0.0:SCK_PREVIEW_PORT（缺省 18777）——/e /d 文件路由（无鉴权，老板局域网口径）、
 *        /api/owner/*（Bearer owner-token，`sck owner` 走这里）与 /internal-ai/status。
 *   签名面 127.0.0.1:SCK_PREVIEW_SIGNED_PORT（缺省 18778）——仅在配置了 SCK_PREVIEW_SECRET 时启动；
 *        公网经 VPS → SSH 反向隧道打到这里，回环绑定，不承载 /api/owner/*。
 * 路由与安全在 src/preview-core.ts。端口被占用（例如旧插件仍在运行）时每 5 秒重试，占用期间不改写
 * preview-status.json，以免覆盖正在服务的那一方的状态。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createPreviewFetch, lanIPv4 } from '../preview-core.ts';

type FetchHandler = (req: Request) => Promise<Response>;

export interface PreviewHostOptions {
  home: string;
  lanPort?: number;
  signedPort?: number;
  secret?: string;
  /** /api/owner/* 处理器（只挂在 LAN 面）。 */
  ownerFetch?: FetchHandler;
  /** /internal-ai/status 处理器。 */
  statusFetch?: FetchHandler;
  retryMs?: number;
  log?: (line: string) => void;
}

export interface PreviewHost {
  /** LAN 面实际绑定端口（未绑定时为配置值）。 */
  readonly port: number;
  readonly lanUrl: string;
  readonly listening: { lan: boolean; signed: boolean };
  stop(): Promise<void>;
}

const STATUS_FILE = 'preview-status.json';

const toRequest = (req: IncomingMessage): Request => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    (init as RequestInit & { duplex: string }).duplex = 'half';
    (init as { body?: unknown }).body = Readable.toWeb(req);
  }
  return new Request(`http://${req.headers.host ?? 'preview.local'}${req.url ?? '/'}`, init);
};

const send = async (res: ServerResponse, out: Response): Promise<void> => {
  res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
  if (!out.body) { res.end(); return; }
  Readable.fromWeb(out.body as unknown as import('node:stream/web').ReadableStream).pipe(res);
};

interface Listener { name: 'lan' | 'signed'; host: string; port: number; handler: FetchHandler; server?: Server; bound?: number; timer?: ReturnType<typeof setTimeout>; warned?: boolean }

export function startPreviewHost(opts: PreviewHostOptions): PreviewHost {
  const log = opts.log ?? ((line: string) => console.log(`[preview] ${line}`));
  const lanPort = opts.lanPort ?? Number(process.env.SCK_PREVIEW_PORT ?? 18777);
  const signedPort = opts.signedPort ?? Number(process.env.SCK_PREVIEW_SIGNED_PORT ?? 18778);
  const secret = opts.secret ?? process.env.SCK_PREVIEW_SECRET;
  const retryMs = Math.max(1, Math.round(opts.retryMs ?? 5_000));
  const startedAt = new Date().toISOString();
  const roots = { e: join(opts.home, 'evidence'), d: join(opts.home, 'deliverables') };
  let stopped = false;
  let lastError: string | undefined;

  const lanCore = createPreviewFetch({ home: opts.home, port: lanPort });
  const lanHandler: FetchHandler = async request => {
    const path = new URL(request.url).pathname;
    if (opts.ownerFetch && path.startsWith('/api/owner/')) return opts.ownerFetch(request);
    if (opts.statusFetch && path === '/internal-ai/status') return opts.statusFetch(request);
    return lanCore(request);
  };
  const listeners: Listener[] = [{ name: 'lan', host: '0.0.0.0', port: lanPort, handler: lanHandler }];
  if (secret) {
    const signedCore = createPreviewFetch({ home: opts.home, port: signedPort, auth: { secret } });
    listeners.push({ name: 'signed', host: '127.0.0.1', port: signedPort, handler: async request => {
      if (opts.statusFetch && new URL(request.url).pathname === '/internal-ai/status') return opts.statusFetch(request);
      return signedCore(request);
    } });
  } else {
    log('签名面未启动：SCK_PREVIEW_SECRET 未配置');
  }
  const lan = listeners[0]!;
  const signed = listeners[1];

  const writeStatus = () => {
    try {
      writeFileSync(join(opts.home, STATUS_FILE), JSON.stringify({
        lan: { running: lan.server?.listening === true, port: lan.bound ?? lanPort, lanUrl: `http://${lanIPv4()}:${lan.bound ?? lanPort}` },
        signed: { configured: Boolean(secret), running: signed?.server?.listening === true, port: signed?.bound ?? null },
        roots, startedAt, lastError, host: 'native',
      }) + '\n');
    } catch { /* 状态文件尽力而为 */ }
  };

  const listen = (L: Listener) => {
    if (stopped) return;
    const server = createServer((req, res) => {
      Promise.resolve().then(() => L.handler(toRequest(req))).then(out => send(res, out)).catch(error => {
        lastError = (error as Error).message;
        if (!res.headersSent) res.writeHead(500);
        res.end('preview error');
      });
    });
    L.server = server;
    server.once('error', error => {
      L.server = undefined;
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        if (!L.warned) log(`${L.name} 端口 ${L.port} 已被占用，每 ${retryMs} 毫秒重试一次`);
        L.warned = true;
        L.timer = setTimeout(() => listen(L), retryMs);
        return;
      }
      lastError = error.message;
      log(`${L.name} 端口 ${L.port} 绑定失败：${error.message}`);
      L.timer = setTimeout(() => listen(L), retryMs * 12);
    });
    server.listen(L.port, L.host, () => {
      L.bound = (server.address() as { port: number }).port;
      lastError = undefined;
      writeStatus();
      log(`${L.name} 面已监听 http://${L.host}:${L.bound}`);
    });
  };
  for (const L of listeners) listen(L);

  return {
    get port() { return lan.bound ?? lanPort; },
    get lanUrl() { return `http://${lanIPv4()}:${lan.bound ?? lanPort}`; },
    get listening() { return { lan: lan.server?.listening === true, signed: signed?.server?.listening === true }; },
    async stop() {
      if (stopped) return;
      stopped = true;
      const wasBound = listeners.some(L => L.server?.listening);
      for (const L of listeners) {
        if (L.timer) clearTimeout(L.timer);
        const s = L.server;
        L.server = undefined;
        if (!s) continue;
        s.closeAllConnections?.();
        if (s.listening) await new Promise<void>(resolve => s.close(() => resolve()));
      }
      if (wasBound) writeStatus();
    },
  };
}
