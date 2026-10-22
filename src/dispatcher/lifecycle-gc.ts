/**
 * Lifecycle GC for the leftovers the task-scoped artifact reclaim never sees.
 *
 * Three leaks kept filling the disk even while evidence/deliverables were being
 * trimmed correctly:
 *   - worktrees parked with nothing but `node_modules`/build output were judged
 *     "dirty" by `git status --porcelain` and could never be removed;
 *   - `comm/<instance>` outlived every retired employee (1800+ dirs);
 *   - `archive/<batch>` cold storage had no retention at all (14 GB from one batch).
 *
 * Nothing here touches task evidence: it only removes dependency trees from the
 * dirty test, dead instance channels by age, and cold-archive batches by age.
 */
import { lstat, readdir, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';

/** Dependency/build output: never evidence, never a reason to keep a worktree alive. */
const JUNK_SEGMENT = /(?:^|\/)(?:node_modules|\.venv|venv|__pycache__|\.pnpm-store|\.cache|\.next|\.turbo|dist|build|target)(?:\/|$)/;

/**
 * True when `git status --porcelain` shows work that a `git worktree remove` must not
 * throw away. Tracked modifications always count. Untracked entries count unless the
 * whole entry is dependency/build output — a worktree parked with only `node_modules`
 * holds no work of its own and used to be retained forever.
 */
export function meaningfulChanges(porcelain: string): boolean {
  return porcelain.split('\n').some(line => {
    if (!line.trim()) return false;
    const untracked = line.startsWith('??');
    const path = line.slice(3).trim().replace(/^"|"$/g, '');
    if (!path) return false;
    if (untracked && JUNK_SEGMENT.test(path)) return false;
    return true;
  });
}

/** Untracked paths that are pure dependency/build output, trimmed to the junk root. */
const JUNK_ROOT = /^(?:node_modules|\.venv|venv|__pycache__|\.pnpm-store|\.cache|\.next|\.turbo|dist|build|target)$/;
export function junkPathsFromPorcelain(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('??')) continue;
    const raw = line.slice(3).trim().replace(/^"|"$/g, '').replace(/\/$/, '');
    if (!raw || raw.startsWith('/') || raw.split('/').includes('..')) continue;
    if (!JUNK_SEGMENT.test(raw)) continue;
    const segments = raw.split('/');
    const idx = segments.findIndex(seg => JUNK_ROOT.test(seg));
    out.push(idx >= 0 ? segments.slice(0, idx + 1).join('/') : raw);
  }
  return [...new Set(out)];
}

/** Instance ids minted by the dispatcher: `<role>-<provider>-<hex6>`; anything else is foreign. */
const INSTANCE_DIR = /^[a-z0-9][a-z0-9-]*-[0-9a-f]{6}$/;
/** Cold-archive batches produced by the operator: `evidence-YYYY-MM-DD` or any `*.tar.gz`. */
const ARCHIVE_BATCH = /^(?:evidence|deliverables)-\d{4}-\d{2}-\d{2}$|\.tar\.gz$/;

export interface GcEntry { name: string; path: string; mtimeMs: number }

async function entries(root: string): Promise<GcEntry[]> {
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const out: GcEntry[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const path = join(root, name);
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink()) continue;
      out.push({ name, path, mtimeMs: st.mtimeMs });
    } catch { /* raced away */ }
  }
  return out;
}

async function sizeOf(path: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 24) return;
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      try {
        const st = await lstat(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) await walk(p, depth + 1);
        else total += st.size;
      } catch { /* raced away */ }
    }
  };
  await walk(path, 0);
  return total;
}

export interface GcResult { removed: string[]; bytes: number; skipped: number; kept?: Array<{ name: string; reason: string }>; failed?: string[] }

/**
 * Dead employee channels: a `comm/<instance>` dir whose instance is not live and
 * whose last write is older than the grace. Live instances are passed in by the
 * plugin (the only component that knows which sessions are still answering).
 */
export async function sweepInstanceDirs(opts: {
  root: string; now: Date; graceMs: number; keep: ReadonlySet<string>; dryRun?: boolean;
  protect?: (path: string) => Promise<string | undefined>;
}): Promise<GcResult> {
  const result: GcResult = { removed: [], bytes: 0, skipped: 0, kept: [], failed: [] };
  const cutoff = opts.now.getTime() - opts.graceMs;
  const keep = (name: string, reason: string) => { result.skipped++; result.kept!.push({ name, reason }); };
  for (const entry of await entries(opts.root)) {
    if (!INSTANCE_DIR.test(entry.name)) { keep(entry.name, 'foreign-name'); continue; }
    if (opts.keep.has(entry.name)) { keep(entry.name, 'live-instance'); continue; }
    if (entry.mtimeMs > cutoff) { keep(entry.name, 'grace-period'); continue; }
    let reason;
    try { reason = await opts.protect?.(entry.path); } catch { reason = 'inspection-failed'; }
    if (reason) { keep(entry.name, reason); continue; }
    const bytes = await sizeOf(entry.path);
    if (!opts.dryRun) {
      try { await rm(entry.path, { recursive: true, force: true }); }
      catch { result.failed!.push(entry.name); keep(entry.name, 'remove-failed'); continue; }
    }
    result.bytes += bytes;
    result.removed.push(entry.name);
  }
  return result;
}

/**
 * Cold-archive batches: `archive/` is explicitly "this already left the working set",
 * so it gets a plain retention instead of task-state logic. Only our own batch names
 * are eligible; anything else in the directory is left for a human.
 */
export async function sweepArchiveBatches(opts: {
  root: string; now: Date; retentionMs: number; dryRun?: boolean;
}): Promise<GcResult> {
  const result: GcResult = { removed: [], bytes: 0, skipped: 0 };
  const cutoff = opts.now.getTime() - opts.retentionMs;
  for (const entry of await entries(opts.root)) {
    if (!ARCHIVE_BATCH.test(entry.name)) { result.skipped++; continue; }
    if (entry.mtimeMs > cutoff) { result.skipped++; continue; }
    result.bytes += await sizeOf(entry.path);
    result.removed.push(entry.name);
    if (!opts.dryRun) await rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}

/** Root-escape guard reused by callers that assemble paths from names. */
export const isDirectChild = (root: string, path: string): boolean =>
  path.startsWith(root + sep) && !path.slice(root.length + 1).includes(sep);
