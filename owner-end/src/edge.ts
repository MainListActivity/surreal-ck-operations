/** 免费边缘入口：静态资源留在 Cloudflare，API 原样流式转发到固定云端。 */
export interface EdgeEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  OWNER_BACKEND_ORIGIN: string;
  OWNER_PROXY_KEY: string;
}

export type EdgeFetch = (request: Request) => Promise<Response>;

const INTERNAL_HEADERS = [
  'host', 'forwarded', 'x-real-ip', 'cf-connecting-ip',
  'x-company-proxy-key', 'x-company-client-ip',
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
  'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade',
];

function backendUrl(value: unknown, incoming: URL): URL | undefined {
  if (typeof value !== 'string' || value !== value.trim() || /[\\\s?#@]/.test(value) || value.endsWith('/')) return;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      host === 'company.maplayer.top' || host === incoming.hostname.toLowerCase().replace(/\.+$/, '')) return;
    return url;
  } catch { return; }
}

function failure(status: 502 | 503): Response {
  return Response.json({ ok: false, error: {
    code: status === 503 ? 'unavailable' : 'upstream_error',
    message: status === 503 ? '云端接口尚未配置' : '云端接口暂不可用，请稍后重试',
  } }, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

/** fetch 可注入测试；不解析 JWT、正文或事件流，不重放任何请求。 */
export function createEdgeHandler(fetchBackend: EdgeFetch = request => fetch(request)) {
  return async (request: Request, env: EdgeEnv): Promise<Response> => {
    const incoming = new URL(request.url);
    if (incoming.pathname !== '/api' && !incoming.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const backend = backendUrl(env.OWNER_BACKEND_ORIGIN, incoming);
    const key = env.OWNER_PROXY_KEY;
    // 密钥必须能不经变换地放入 HTTP 头；拒绝空白、换行和隐式字符串转换。
    if (!backend || typeof key !== 'string' || key.length < 32 || !/^[\x21-\x7e]+$/.test(key)) return failure(503);

    const headers = new Headers(request.headers);
    const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
    const hopHeaders = (headers.get('connection') ?? '').split(',').map(name => name.trim())
      .filter(name => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name));
    for (const name of [...INTERNAL_HEADERS, ...hopHeaders]) headers.delete(name);
    const forwardedHeaders: string[] = [];
    headers.forEach((_, name) => { if (name.startsWith('x-forwarded-')) forwardedHeaders.push(name); });
    for (const name of forwardedHeaders) headers.delete(name);
    headers.set('x-company-proxy-key', key);
    headers.set('x-company-client-ip', clientIp);
    // 不用相对 URL 解析：保留既定后端前缀，浏览器路径不能替换后端地址。
    backend.pathname = backend.pathname.replace(/\/$/, '') + incoming.pathname;
    backend.search = incoming.search;

    try {
      const upstream = await fetchBackend(new Request(backend, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        signal: request.signal,
        redirect: 'manual',
        cache: 'no-store',
      }));
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => undefined);
        return failure(502);
      }
      // 直接交还原响应，SSE 不经过 JS 逐块处理或缓冲。
      return upstream;
    } catch { return failure(502); }
  };
}

export default { fetch: createEdgeHandler() };
