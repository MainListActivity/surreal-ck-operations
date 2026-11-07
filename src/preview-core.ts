/**
 * 交付预览核心：标准 fetch 形态请求处理器，LAN 插件托管版与应急桥接脚本共用。
 * 只读服务两个根：<home>/evidence（/e/）与 <home>/deliverables（/d/）。
 * 运行时零依赖 Bun/node:http——Response body 用 node stream 转 web stream，两端通用。
 * 安全：词法 resolve + realpath 双重校验，'..' 遍历/绝对路径/符号链接逃逸拒 403；
 * 隐藏文件段（含 '..'）拒 403；仅服务两个根目录。
 * auth 可选：给定 secret 时 /e//d/ 请求强制 exp+sig 签名（未签/坏签 401、过期 403），
 * 列表页链接由服务端同密钥签发；不给则完全开放（LAN 口径，仅绑 0.0.0.0 局域网）。
 */
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { extname, join, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { checkPreviewSig, previewSignedPath } from './preview-sign.ts';
import { previewListCss } from '../plugin/shared/relay-tokens.ts';

export interface PreviewCoreOptions {
  /** serviceHome：evidence/ 与 deliverables/ 的上级目录。 */
  home: string;
  /** 对外端口（healthz 报告用）。 */
  port: number;
  startedAt?: number;
  now?: () => number;
  /** 签名门控：给了则 /e//d/ 请求必须带有效 exp+sig（公网/隧道面用）。 */
  auth?: { secret: string; ttlMs?: number };
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.pdf': 'application/pdf',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 局域网 IPv4：en0/en1 优先（Mac 有线/无线），取第一个非 internal 地址。 */
export function lanIPv4(): string {
  const nics = networkInterfaces();
  for (const name of ['en0', 'en1']) {
    const hit = nics[name]?.find((i) => !i.internal && i.family === 'IPv4');
    if (hit) return hit.address;
  }
  return Object.values(nics).flat().find((i) => i && !i.internal && i.family === 'IPv4')?.address ?? '127.0.0.1';
}

type Resolved = { ok: true; path: string; isDir: boolean } | { ok: false; reason: 'escape' | 'missing' | 'type' };

/**
 * 解析 `<root>/<rel>` 并校验落点在 root 内：词法 resolve + realpath 双重。
 * rel '' 解析为 root 本身；allowDir 放行目录目标，否则只要常规文件。
 * 与 attachments.ts 的 resolveInsideChecked 同形但返回逃逸/缺失原因——本服务要把
 * 越界打成 403、不存在打成 404（QA 口径区分）。
 */
async function resolveInsideChecked(root: string, rel: string, { allowDir = false }: { allowDir?: boolean } = {}): Promise<Resolved> {
  if (rel.length > 512 || rel.startsWith('/') || rel.split('/').includes('..')) return { ok: false, reason: 'escape' };
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return { ok: false, reason: 'escape' };
  let realRoot: string, realAbs: string;
  try {
    [realRoot, realAbs] = await Promise.all([realpath(rootAbs), realpath(abs)]);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) return { ok: false, reason: 'escape' };
  const st = await stat(realAbs).catch(() => undefined);
  if (!st) return { ok: false, reason: 'missing' };
  if (st.isFile()) return { ok: true, path: realAbs, isDir: false };
  if (allowDir && st.isDirectory()) return { ok: true, path: realAbs, isDir: true };
  return { ok: false, reason: 'type' };
}

function serveFile(file: string, size: number, req: Request): Response {
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.get('range');
  const stream = (start?: number, end?: number) =>
    Readable.toWeb(createReadStream(file, start === undefined ? undefined : { start, end })) as unknown as ReadableStream;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] ? (m[2] ? Math.min(Number(m[2]), size - 1) : size - 1) : size - 1;
      if (start <= end && start < size) {
        return new Response(stream(start, end), { status: 206, headers: {
          'Content-Type': type, 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1),
        }});
      }
      return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
  }
  return new Response(stream(), { headers: {
    'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(size),
    'Content-Disposition': 'inline', 'Cache-Control': 'no-cache',
  }});
}

/** linkFor：子项名→href。无鉴权用相对链接，鉴权模式签发绝对路径签名 URL。 */
function listPage(kind: 'e' | 'd', taskId: string, dir: string, subdir: boolean, linkFor: (name: string, isDir: boolean) => string): string | null {
  let files: string[];
  try { files = readdirSync(dir); } catch { return null; }
  const parent = subdir ? `<li><a href="${esc(linkFor('..', true))}">📁 ../</a></li>` : '';
  const items = parent + files.filter((f) => !f.startsWith('.')).map((f) => {
    const st = statSync(join(dir, f), { throwIfNoEntry: false });
    if (!st) return '';
    return st.isDirectory()
      ? `<li><a href="${esc(linkFor(f, true))}">📁 ${esc(f)}/</a></li>`
      : `<li><a href="${esc(linkFor(f, false))}">${esc(f)}</a> <span class="sz">${(st.size / 1024 / 1024).toFixed(1)}MB</span></li>`;
  }).join('\n');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(taskId)}</title><style>${previewListCss}</style>
<h1>交付包 ${esc(taskId)}</h1><ul>${items}</ul>`;
}

/** 构造 fetch 处理器；startedAt/now 可注入供测试 healthz uptime。 */
export function createPreviewFetch(opts: PreviewCoreOptions) {
  const roots = { e: join(opts.home, 'evidence'), d: join(opts.home, 'deliverables') };
  const now = opts.now ?? Date.now;
  const startedAt = opts.startedAt ?? now();
  const auth = opts.auth;
  const ttl = () => auth?.ttlMs ?? 3_600_000;
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, port: opts.port, uptime: Math.max(0, Math.round((now() - startedAt) / 1000)) });
    }
    const m = /^\/([ed])\/([A-Za-z0-9_-]{1,128})(?:\/(.*))?$/.exec(url.pathname);
    if (!m) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>交付预览</title><style>${previewListCss}</style>` +
        `<h1>交付预览服务</h1><p>/e/&lt;任务ID&gt;/ → evidence 目录 · /d/&lt;任务ID&gt;/ → deliverables 目录</p>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (auth) {
      const chk = checkPreviewSig(auth.secret, url.pathname, url.searchParams.get('exp'), url.searchParams.get('sig'), now());
      if (chk === 'missing' || chk === 'bad') return new Response('unauthorized', { status: 401 });
      if (chk === 'expired') return new Response('signature expired', { status: 403 });
    }
    const [, kind, taskId, relEnc = ''] = m as unknown as [string, 'e' | 'd', string, string];
    let rel = '';
    try { rel = decodeURIComponent(relEnc); } catch { return new Response('bad path', { status: 400 }); }
    if (rel.split('/').some((s) => s.startsWith('.'))) return new Response('forbidden', { status: 403 });
    const cleanRel = rel.replace(/\/+$/, '');
    const linkFor = (name: string, isDir: boolean): string => {
      if (auth) {
        const child = name === '..' ? cleanRel.split('/').slice(0, -1).join('/') : (cleanRel ? `${cleanRel}/${name}` : name);
        return previewSignedPath(auth.secret, kind, taskId, child, ttl(), now()).path;
      }
      return name === '..' ? '../' : encodeURIComponent(name) + (isDir ? '/' : '');
    };
    const target = await resolveInsideChecked(roots[kind], cleanRel ? `${taskId}/${cleanRel}` : taskId, { allowDir: true });
    if (!target.ok) return new Response(target.reason === 'escape' ? 'forbidden' : 'not found', { status: target.reason === 'escape' ? 403 : 404 });
    if (target.isDir) {
      const page = listPage(kind, taskId, target.path, cleanRel !== '', linkFor);
      return page === null
        ? new Response('not found', { status: 404 })
        : new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const st = statSync(target.path)!;
    return serveFile(target.path, st.size, req);
  };
}
