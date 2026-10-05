/**
 * 交付预览服务（签名 URL 版）：可挂公网的只读静态服务。
 * 用法: bun src/preview-server.ts [port]
 *   GET /e/<taskId>/<file>?exp=<ms>&sig=<hmac>  -> $SCK_SERVICE_HOME/evidence/<taskId>/<file>
 *   GET /d/<taskId>/<file>?exp&sig              -> $SCK_SERVICE_HOME/deliverables/<taskId>/<file>
 *   GET /e/<taskId>/ 或 /d/<taskId>/（带签名）-> 目录列表页，链接为同密钥签名 URL
 *   GET /healthz -> {"ok":true}
 * 鉴权：缺签名/签名不符 401，过期 403，未配置 SCK_PREVIEW_SECRET 时 503（fail closed）。
 * 环境（private/service.env 自动加载，进程 env 优先）：
 *   SCK_PREVIEW_SECRET    HMAC 密钥，签发方（插件 attachments.url）与服务方共享
 *   SCK_PREVIEW_TTL_MS    列表页链接有效期，默认 3600000
 * 部署：把 preview-server.ts 与其 import 的 attachments.ts、preview-sign.ts 一并拷到
 * $SCK_SERVICE_HOME/bin/ 供 launchd org.surrealck.deliverable-preview 运行。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { checkPreviewSig, previewSignedPath } from './preview-sign.ts';
import { resolveInsideChecked } from './attachments.ts';

const HOME = process.env.SCK_SERVICE_HOME ?? join(homedir(), 'Library/Application Support/SurrealCKCompany');
const PORT = Number(process.argv[2] ?? process.env.SCK_PREVIEW_PORT ?? 18777);

/** 与 plugin/server/env.ts 的 loadServiceEnv 等价：预览进程自持，避免改 launchd plist。 */
const loadServiceEnv = () => {
  try {
    for (const line of readFileSync(join(HOME, 'private/service.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* service.env 可选 */ }
};

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.pdf': 'application/pdf',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const statOrNull = (p: string) => { try { return statSync(p); } catch { return null; } };

export interface PreviewOptions {
  /** 测试注入：serviceHome 覆盖；默认 env 或 ~/Library/Application Support/SurrealCKCompany。 */
  home?: string;
  /** 测试注入：签名密钥覆盖；默认 process.env.SCK_PREVIEW_SECRET。 */
  secret?: string;
  now?: () => number;
}

function listPage(kind: 'e' | 'd', taskId: string, dir: string, sign: (rel: string) => string): string {
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { return 'not found'; }
  const items = files.filter((f) => !f.startsWith('.')).map((f) => {
    const st = statOrNull(join(dir, f));
    if (!st) return '';
    return st.isDirectory()
      ? `<li><a href="${esc(sign(`${f}/`))}">📁 ${esc(f)}/</a></li>`
      : `<li><a href="${esc(sign(f))}">${esc(f)}</a> <span class="sz">${(st.size / 1024 / 1024).toFixed(1)}MB</span></li>`;
  }).join('\n');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(taskId)}</title><style>body{font:16px/1.8 -apple-system,sans-serif;margin:24px;max-width:760px}a{color:#3aa6a0}.sz{color:#888;font-size:13px}h1{font-size:18px}</style>
<h1>交付包 ${esc(taskId)}</h1><ul>${items}</ul>`;
}

function serveFile(file: string, req: Request): Response {
  const st = statSync(file)!;
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      const end = m[1] ? (m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1) : st.size - 1;
      if (start <= end && start < st.size) {
        return new Response(Bun.file(file).slice(start, end + 1), { status: 206, headers: {
          'Content-Type': type, 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': String(end - start + 1),
        }});
      }
      return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
    }
  }
  return new Response(Bun.file(file), { headers: {
    'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(st.size),
    'Content-Disposition': 'inline', 'Cache-Control': 'no-cache',
  }});
}

/** 请求处理函数（Bun.serve fetch 形态），便于测试以临时 home/secret 起服务。 */
export function previewFetch(opts: PreviewOptions = {}) {
  const home = opts.home ?? HOME;
  const roots: Record<'e' | 'd', string> = { e: join(home, 'evidence'), d: join(home, 'deliverables') };
  const now = opts.now ?? Date.now;
  const ttl = () => Number(process.env.SCK_PREVIEW_TTL_MS ?? 3_600_000);
  const secret = () => opts.secret ?? process.env.SCK_PREVIEW_SECRET;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return Response.json({ ok: true });
    const m = /^\/([ed])\/([A-Za-z0-9_-]{1,128})(?:\/(.*))?$/.exec(url.pathname);
    if (!m) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>交付预览</title><body style="font:16px -apple-system,sans-serif;margin:24px">` +
        `<h1>交付预览服务</h1><p>/e/&lt;任务ID&gt;/ → evidence 目录 · /d/&lt;任务ID&gt;/ → deliverables 目录（均需签名 URL）</p></body>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const key = secret();
    if (!key) return new Response('preview secret not configured', { status: 503 });
    const chk = checkPreviewSig(key, url.pathname, url.searchParams.get('exp'), url.searchParams.get('sig'), now());
    if (chk === 'missing' || chk === 'bad') return new Response('unauthorized', { status: 401 });
    if (chk === 'expired') return new Response('signature expired', { status: 403 });

    const [, kind, taskId, relEnc = ''] = m as unknown as [string, 'e' | 'd', string, string];
    let rel = '';
    try { rel = decodeURIComponent(relEnc); } catch { return new Response('bad path', { status: 400 }); }
    if (rel.split('/').some((s) => s.startsWith('.'))) return new Response('forbidden', { status: 403 });

    const sign = (r: string) =>
      previewSignedPath(key, kind, taskId, rel ? `${rel.replace(/\/+$/, '')}/${r}` : r, ttl(), now()).path;
    const target = await resolveInsideChecked(roots[kind], rel ? `${taskId}/${rel}` : taskId, { allowDir: true });
    if (!target) return new Response('not found', { status: 404 });
    if (statSync(target).isDirectory()) {
      return new Response(listPage(kind, taskId, target, sign), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return serveFile(target, req);
  };
}

if (import.meta.main) {
  loadServiceEnv();
  Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    fetch: previewFetch(),
  });
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4')?.address ?? '127.0.0.1';
  console.log(`deliverable-preview listening: http://0.0.0.0:${PORT} → http://${lan}:${PORT}  auth=${process.env.SCK_PREVIEW_SECRET ? 'signed-url' : 'DISABLED(503)'}`);
}
