/**
 * deliverable_publish 核心：把本地文件/目录发布为老板可点的 LAN 预览 URL。
 * 落点 <serviceHome>/deliverables/<taskId>/，由插件内嵌预览服务（preview-core）经
 * /d/<taskId>/<file> 路由对外——无鉴权 LAN 口径为老板亲定，公网签名面独立（preview-sign）。
 *
 * 语义：
 * - taskId 与路由层同校验：^[A-Za-z0-9_-]{1,128}$（拒绝穿越/斜杠）。
 * - files 必须全部是绝对路径且存在：任一无效整体报错，不产生半截交付包。
 * - 文件复制到 <taskId>/<basename>；目录递归复制为 <taskId>/<basename(dir)>/** 保结构。
 * - 隐藏名（. 开头段）一律跳过——预览服务本就不服务隐藏段，记录进 skipped。
 * - 同名冲突一律覆盖（定稿语义：重发即更新），conflictPolicy 字段回告。
 * - 符号链接在复制期解引用（拷目标内容），交付包内不留悬空链接。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { lanIPv4 } from './preview-core.ts';

const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface PublishInput {
  /** serviceHome：deliverables/ 的上级目录。 */
  home: string;
  taskId: string;
  files: string[];
}

export interface PublishResult {
  taskId: string;
  /** 落点目录（deliverables/<taskId> 绝对路径）。 */
  dir: string;
  /** 预览基址 http://<lanIP>:<port>。 */
  baseUrl: string;
  /** 每个已发布文件的可点 URL + 目录条目的列表页 URL。 */
  urls: string[];
  /** 被跳过的条目（隐藏名、非文件/目录节点）。 */
  skipped: { path: string; reason: string }[];
  conflictPolicy: 'overwrite';
}

/** LAN 预览基址：插件 preview-status.json 为权威（实际绑定），否则 env 端口，缺省 18777。 */
export function previewLanBase(home: string): string {
  try {
    const st = JSON.parse(readFileSync(join(home, 'preview-status.json'), 'utf8')) as {
      lan?: { running?: boolean; lanUrl?: string };
    };
    if (st.lan?.running && st.lan.lanUrl) return st.lan.lanUrl.replace(/\/+$/, '');
  } catch { /* 状态文件缺席正常 */ }
  return `http://${lanIPv4()}:${Number(process.env.SCK_PREVIEW_PORT ?? 18777)}`;
}

const encPath = (rel: string) => rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');

/** 递归展开一个复制完成的落点为 URL 列表（文件→文件 URL，目录→列表页 URL）。 */
function collectUrls(baseUrl: string, taskId: string, rel: string, abs: string, out: string[]): void {
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) {
    out.push(`${baseUrl}/d/${taskId}/${encPath(rel)}/`);
    for (const name of readdirSync(abs).filter((n) => !n.startsWith('.')).sort())
      collectUrls(baseUrl, taskId, rel ? `${rel}/${name}` : name, join(abs, name), out);
    return;
  }
  if (st.isFile()) out.push(`${baseUrl}/d/${taskId}/${encPath(rel)}`);
}

export function publishDeliverables(input: PublishInput): PublishResult {
  const { home, taskId } = input;
  const files = Array.isArray(input.files) ? input.files : [];
  if (!TASK_ID.test(taskId ?? ''))
    throw new Error(`invalid taskId: ${taskId}（仅允许 [A-Za-z0-9_-]）`);
  if (files.length === 0) throw new Error('files 为空：给绝对路径的文件或目录');

  // 先全量校验再落盘：任一输入非法即整体报错，不产生半截交付包。
  const bad = files.filter((f) => typeof f !== 'string' || !isAbsolute(f) || !existsSync(f));
  if (bad.length) throw new Error(`路径无效或不存在（未产生任何交付）：${bad.join(', ')}`);

  const dir = join(home, 'deliverables', taskId);
  const skipped: PublishResult['skipped'] = [];
  const planned: { src: string; rel: string }[] = [];
  for (const src of files) {
    const base = basename(src);
    if (base.startsWith('.')) { skipped.push({ path: src, reason: 'hidden' }); continue; }
    planned.push({ src, rel: base });
  }
  mkdirSync(dir, { recursive: true });
  for (const { src, rel } of planned) {
    cpSync(src, join(dir, rel), {
      recursive: true,
      force: true, // 同名冲突一律覆盖：重发即更新
      dereference: true, // 符号链接拷目标内容，交付包不留悬空链接
      filter: (s) => {
        const keep = !basename(s).startsWith('.');
        if (!keep) skipped.push({ path: s, reason: 'hidden' });
        return keep;
      },
    });
  }
  const urls: string[] = [];
  const baseUrl = previewLanBase(home);
  for (const { rel } of planned) collectUrls(baseUrl, taskId, rel, join(dir, rel), urls);
  return { taskId, dir, baseUrl, urls, skipped, conflictPolicy: 'overwrite' };
}
