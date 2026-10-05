/**
 * 交付预览服务（桥接版）：局域网可达的只读静态服务。
 * 用法: bun src/preview-server.ts [port]
 *   GET /e/<taskId>/<file>  -> $SCK_SERVICE_HOME/evidence/<taskId>/<file>
 *   GET /d/<taskId>/<file>  -> $SCK_SERVICE_HOME/deliverables/<taskId>/<file>
 *   GET /e/<taskId>/ 或 /d/<taskId>/ -> 包内文件列表页
 *   GET /healthz -> {"ok":true}
 * 监听 0.0.0.0，不鉴权（老板口径：能摸到这台机器即可达）。正式版由插件托管，见目标 c5be4f1e。
 */
import { statSync, readdirSync, createReadStream } from 'node:fs';
import { join, normalize, extname, resolve } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';

const HOME = process.env.SCK_SERVICE_HOME ?? join(homedir(), 'Library/Application Support/SurrealCKCompany');
const ROOTS: Record<string, string> = { e: join(HOME, 'evidence'), d: join(HOME, 'deliverables') };
const PORT = Number(process.argv[2] ?? process.env.SCK_PREVIEW_PORT ?? 18777);

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 解析并校验落点必须在 root 内（含符号链接逃逸），越界返回 null。 */
function resolveInside(root: string, rel: string): string | null {
  const rootReal = resolve(root);
  const target = resolve(rootReal, normalize(rel));
  if (target !== rootReal && !target.startsWith(rootReal + '/')) return null;
  return target;
}

function listPage(prefix: string, taskId: string, dir: string): string {
  const files = exists(() => readdirSync(dir)) ?? [];
  const items = files.filter((f) => !f.startsWith('.')).map((f) => {
    const st = statSync(join(dir, f));
    if (st.isDirectory()) return `<li><a href="${prefix}/${taskId}/${esc(f)}/">📁 ${esc(f)}/</a></li>`;
    return `<li><a href="${prefix}/${taskId}/${esc(f)}">${esc(f)}</a> <span class="sz">${(st.size / 1024 / 1024).toFixed(1)}MB</span></li>`;
  }).join('\n');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(taskId)}</title><style>body{font:16px/1.8 -apple-system,sans-serif;margin:24px;max-width:760px}a{color:#3aa6a0}.sz{color:#888;font-size:13px}h1{font-size:18px}</style>
<h1>交付包 ${esc(taskId)}</h1><ul>${items}</ul>`;
}
const exists = (fn: () => string[]) => { try { return fn(); } catch { return null; } };
const existsSync_ = (p: string) => { try { statSync(p); return true; } catch { return false; } };

function serveFile(file: string, req: Request): Response {
  const st = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      const end = m[1] ? (m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1) : st.size - 1;
      if (start <= end && start < st.size) {
        const fd = Bun.file(file).slice(start, end + 1);
        return new Response(fd, { status: 206, headers: {
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

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return Response.json({ ok: true });
    const m = /^\/([ed])\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(decodeURIComponent(url.pathname));
    if (!m) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>交付预览</title><body style="font:16px -apple-system,sans-serif;margin:24px">` +
        `<h1>交付预览服务</h1><p>/e/&lt;任务ID&gt;/ → evidence 目录 · /d/&lt;任务ID&gt;/ → deliverables 目录</p></body>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const [, kind, taskId, rel = ''] = m;
    const root = ROOTS[kind];
    const dir = resolveInside(root, taskId);
    if (!dir) return new Response('forbidden', { status: 403 });
    if (!rel) {
      return existsSync_(dir) ? new Response(listPage(`/${kind}`, taskId, dir), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        : new Response('not found', { status: 404 });
    }
    const file = resolveInside(dir, rel);
    if (!file) return new Response('forbidden', { status: 403 });
    if (!existsSync_(file)) return new Response('not found', { status: 404 });
    if (statSync(file).isDirectory())
      return new Response(listPage(`/${kind}/${taskId}`, rel.replace(/\/$/, ''), file), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return serveFile(file, req);
  },
});
const lan = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4')?.address ?? '127.0.0.1';
console.log(`deliverable-preview listening: http://0.0.0.0:${PORT}  →  http://${lan}:${PORT}`);
