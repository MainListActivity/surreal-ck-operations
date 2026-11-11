import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { version } from '../../package.json';
import { readConfig, type Env } from './env.ts';
import { readServerEnvironment, type ServerEnvironment } from './server-env.ts';
import worker from './worker.ts';

export { readServerEnvironment } from './server-env.ts';

export interface OwnerServerOptions {
  env: ServerEnvironment;
  publicOrigin: string;
  proxyKey: string;
  fetch?: (request: Request, env: Env) => Response | Promise<Response>;
  port?: number;
  idleTimeout?: number;
  shutdownGraceMs?: number;
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const reply = (status: number, body: unknown) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

function publicOriginOf(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('OWNER_PUBLIC_ORIGIN 必须是无路径的 HTTPS origin');
  return url.origin;
}

/** HTTP 传输入口；业务处理器可替换，代理信任与流式生命周期始终经过同一路径。 */
export function createOwnerServer(options: OwnerServerOptions) {
  readConfig(options.env);
  const publicOrigin = publicOriginOf(options.publicOrigin);
  if (options.proxyKey.length < 32 || options.proxyKey.trim() !== options.proxyKey)
    throw Error('OWNER_PROXY_KEY 至少需要 32 个字符且不得含首尾空白');
  const expectedKey = digest(options.proxyKey);
  const handle = options.fetch ?? worker.fetch;
  const grace = options.shutdownGraceMs ?? 5000;
  if (!Number.isFinite(grace) || grace < 0) throw Error('shutdownGraceMs 必须是非负有限值');
  let stopping: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 39125,
    idleTimeout: options.idleTimeout ?? 30,
    development: false,
    async fetch(request, server) {
      const incoming = new URL(request.url);
      if (incoming.pathname === '/healthz' && ['GET', 'HEAD'].includes(request.method))
        return reply(stopping ? 503 : 200, {
          ok: !stopping, ready: !stopping,
          version: options.env.OWNER_RELEASE_VERSION ?? version,
          sha: options.env.OWNER_RELEASE_SHA ?? null,
        });
      if (incoming.pathname !== '/api' && !incoming.pathname.startsWith('/api/'))
        return reply(404, { error: 'Not Found' });
      // 对固定长度摘要恒时比较；不按输入密钥长度提前返回，也不将密钥送入业务处理器。
      if (!timingSafeEqual(expectedKey, digest(request.headers.get('x-company-proxy-key') ?? '')))
        return reply(403, { error: 'Forbidden' });
      if (stopping) return reply(503, { error: 'Unavailable' });

      const headers = new Headers(request.headers);
      const clientIp = headers.get('x-company-client-ip');
      const names: string[] = [];
      headers.forEach((_, name) => names.push(name));
      for (const name of names) {
        if (name === 'host' || name === 'forwarded' || name.startsWith('x-forwarded-') ||
          name === 'x-real-ip' || name === 'true-client-ip' || name.startsWith('cf-connecting-ip') ||
          name === 'x-company-proxy-key' || name === 'x-company-client-ip') headers.delete(name);
      }
      if (clientIp && isIP(clientIp)) headers.set('cf-connecting-ip', clientIp);
      const url = new URL(publicOrigin);
      url.pathname = incoming.pathname;
      url.search = incoming.search;
      const forwarded = new Request(url, {
        method: request.method, headers, signal: request.signal,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      });
      if (incoming.pathname === '/api/events') server.timeout(request, 0);
      // 原样交还 Response：Bun 负责背压和断开 cancel，不读取或复制响应正文。
      return handle(forwarded, options.env);
    },
    error() {
      return reply(500, { error: 'Internal Server Error' });
    },
  });
  const stop = (): Promise<void> => stopping ??= (async () => {
    // Bun 1.3 的 stop(false) 不能再升级为强制停机。先停止接纳业务工作，
    // 给普通请求有限的完成窗口，最后只调用一次 stop(true) 取消剩余流。
    const deadline = performance.now() + grace;
    while (server.pendingRequests > 0 && performance.now() < deadline)
      await Bun.sleep(Math.max(0, Math.min(25, deadline - performance.now())));
    await server.stop(true);
  })();
  return { server, stop };
}

if (import.meta.main) {
  try {
    const backend = createOwnerServer({
      env: readServerEnvironment(process.env),
      publicOrigin: process.env.OWNER_PUBLIC_ORIGIN ?? 'https://company.maplayer.top',
      proxyKey: process.env.OWNER_PROXY_KEY ?? '',
    });
    const stop = () => {
      // 清理数据库或供应商连接也不能让进程跨越服务管理器的退出窗口。
      const deadline = setTimeout(() => process.exit(1), 6500);
      deadline.unref();
      void backend.stop().then(() => process.exit(0), () => process.exit(1));
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    console.log(JSON.stringify({ service: 'owner-api', version, ready: true }));
  } catch {
    console.error('owner API 启动失败：请检查业务环境与代理配置');
    process.exitCode = 1;
  }
}
