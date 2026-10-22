import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { meaningfulChanges } from './lifecycle-gc.ts';
const command = (bin: string, args: string[]) => new Promise<string>((yes, no) => {
  execFile(bin, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (error, out) => error ? no(error) : yes(out));
});
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

/** Only filenames are read; file contents, credentials and other employees' transcripts are never inspected. */
export async function openUserPaths(): Promise<string[]> {
  const out = await command('/usr/sbin/lsof', ['-nP', '-u', String(process.getuid!()), '-Fn']);
  return out.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1));
}

const BUILD = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.pnpm-store', '.cache', '.next', '.turbo', 'dist', 'build', 'target']);
/** Retain registered/open scenes and any repository whose work cannot be proven merged. */
export async function scratchKeepReason(path: string, refs: { registered: readonly string[]; open: readonly string[]; mergedRepos?: readonly string[]; activeAfterMs?: number }): Promise<string | undefined> {
  const root = resolve(path);
  if (refs.registered.some(p => inside(root, resolve(p)) || inside(resolve(p), root))) return 'registered-worktree';
  if (refs.open.some(p => inside(root, resolve(p)))) return 'open-process-file';
  let budget = 20000;
  const inspect = async (dir: string, depth: number): Promise<string | undefined> => {
    if (depth > 12 || --budget < 0) return 'inspection-limit';
    const names = await readdir(dir);
    if (names.includes('.git')) {
      const status = await command('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=normal']);
      if (meaningfulChanges(status)) return 'uncommitted-git-work';
      try { await command('git', ['-C', dir, 'merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main']); }
      catch {
        const head = (await command('git', ['-C', dir, 'rev-parse', 'HEAD'])).trim();
        let merged = false;
        for (const repo of refs.mergedRepos ?? []) {
          try { await command('git', ['-C', repo, 'merge-base', '--is-ancestor', head, 'refs/remotes/origin/main']); merged = true; break; }
          catch { /* unknown commit or not merged: never force-delete */ }
        }
        if (!merged) return 'unmerged-or-unknown-git-head';
      }
      return;
    }
    for (const name of names) {
      if (BUILD.has(name)) continue;
      const child = join(dir, name);
      const st = await lstat(child);
      if (st.isSymbolicLink()) continue;
      if (st.isFile() && st.mtimeMs > (refs.activeAfterMs ?? Date.now() - 86400000)) return 'recent-nested-file';
      if (!st.isDirectory()) continue;
      const keep = await inspect(child, depth + 1);
      if (keep) return keep;
    }
  };
  try { return await inspect(root, 0); }
  catch { return 'inspection-failed'; }
}
