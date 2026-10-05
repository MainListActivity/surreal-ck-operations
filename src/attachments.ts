import { readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/**
 * Task-evidence attachments: the owner inbox enumerates a task's evidenceDir
 * (<serviceHome>/evidence/<taskId>) so the plugin can render and one-click-open
 * deliverable files. Path handling always resolves inside the evidence dir —
 * traversal and symlink escapes resolve to undefined.
 */

export type AttachmentKind = 'image' | 'video' | 'html' | 'audio' | 'other';

export interface TaskAttachment {
  name: string;
  /** Path relative to the task evidenceDir, '/'-separated. */
  relPath: string;
  sizeBytes: number;
  kind: AttachmentKind;
}

export const ATTACHMENT_LIMIT = 50;
/** Inline preview ceiling for attachments.read (images only). */
export const ATTACHMENT_READ_MAX_BYTES = 5 * 1024 * 1024;

const KIND_BY_EXT: Record<string, AttachmentKind> = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video',
  html: 'html', htm: 'html',
  mp3: 'audio', m4a: 'audio', wav: 'audio', aac: 'audio',
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4',
  html: 'text/html', htm: 'text/html',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
};

/**
 * Extensions `open` must never hand to macOS `open`: anything that executes
 * (.command runs in Terminal, .app/.workflow launch) plus common script types.
 */
const OPEN_BLOCKED_EXT = new Set([
  'sh', 'bash', 'zsh', 'fish', 'command', 'app', 'workflow', 'scpt', 'scptd', 'applescript',
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'rb', 'pl', 'php', 'lua',
  'jar', 'exe', 'com', 'bat', 'cmd', 'ps1', 'vbs', 'msi', 'pkg', 'dmg', 'iso', 'run', 'bin',
]);

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export const attachmentKind = (name: string): AttachmentKind => KIND_BY_EXT[extOf(name)] ?? 'other';
export const attachmentMime = (name: string): string => MIME_BY_EXT[extOf(name)] ?? 'application/octet-stream';
export const isOpenBlocked = (name: string): boolean => OPEN_BLOCKED_EXT.has(extOf(name));

/** Task ids are path segments; reject anything that could escape evidence/. */
const VALID_TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function evidenceDirFor(serviceHome: string, taskId: string): string | undefined {
  if (!VALID_TASK_ID.test(taskId)) return undefined;
  return join(serviceHome, 'evidence', taskId);
}

/**
 * Resolve `<evidenceDir>/<relPath>` to a canonical regular-file path, or undefined
 * when the path is unsafe (traversal, symlink escaping the dir, non-regular file,
 * missing). The returned path is the realpath, safe to hand to `open`.
 */
export async function resolveTaskAttachment(
  serviceHome: string, taskId: string, relPath: string,
): Promise<string | undefined> {
  const dir = evidenceDirFor(serviceHome, taskId);
  if (!dir || typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 512) return undefined;
  if (relPath.startsWith('/') || relPath.split('/').includes('..')) return undefined;
  const abs = resolve(dir, relPath);
  if (abs !== dir && !abs.startsWith(dir + sep)) return undefined;
  try {
    const [realDir, realAbs] = await Promise.all([realpath(dir), realpath(abs)]);
    if (realAbs !== realDir && !realAbs.startsWith(realDir + sep)) return undefined;
    const st = await stat(realAbs);
    return st.isFile() ? realAbs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Enumerate regular files under evidence/<taskId> recursively ('/'-separated
 * relPath), classified by extension, capped at ATTACHMENT_LIMIT. Directory
 * missing → empty list. Symlinks are followed only when they resolve inside
 * the evidence dir; escaping or dangling links are skipped.
 */
export async function listTaskAttachments(serviceHome: string, taskId: string): Promise<TaskAttachment[]> {
  const dir = evidenceDirFor(serviceHome, taskId);
  if (!dir) return [];
  const realDir = await realpath(dir).catch(() => undefined);
  if (!realDir) return [];
  const out: TaskAttachment[] = [];
  const walk = async (sub: string): Promise<void> => {
    if (out.length >= ATTACHMENT_LIMIT) return;
    const entries = await readdir(join(realDir, sub), { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
    for (const e of entries) {
      if (out.length >= ATTACHMENT_LIMIT) return;
      if (e.name.startsWith('.')) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(rel); continue; }
      const abs = join(realDir, rel);
      const st = await stat(abs).catch(() => undefined); // follows symlinks
      if (!st || !st.isFile()) continue;
      if (e.isSymbolicLink()) {
        const realAbs = await realpath(abs).catch(() => '');
        if (realAbs !== realDir && !realAbs.startsWith(realDir + sep)) continue;
      }
      out.push({ name: e.name, relPath: rel, sizeBytes: st.size, kind: attachmentKind(e.name) });
    }
  };
  await walk('');
  return out;
}
