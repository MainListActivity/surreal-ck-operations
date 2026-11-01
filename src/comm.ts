// Agent<->sidecar comm protocol over a per-instance directory. Agents hold no
// credentials: the sidecar (running inside the Paseo plugin, owning the instance
// credential in memory) executes requests and writes responses. Files under
// req/ are consumed once; report.md is the submit signal; blocker.md escalates.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export interface CommRequest {
  key: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface CommResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** Unacked holder notices the sidecar attached to a successful call (SYS-INT acceptance amendments), so an
   *  in-lease holder sees an amendment on its next sck call instead of waiting for the dispatcher's idle pass. */
  notices?: unknown[];
}

export const commDir = (root: string, employeeId: string) => join(root, employeeId);
export const reqDir = (dir: string) => join(dir, 'req');
export const resDir = (dir: string) => join(dir, 'res');
export const reportPath = (dir: string) => join(dir, 'report.md');
export const blockerPath = (dir: string) => join(dir, 'blocker.md');

export function ensureCommDirs(dir: string): void {
  mkdirSync(reqDir(dir), { recursive: true, mode: 0o700 });
  mkdirSync(resDir(dir), { recursive: true, mode: 0o700 });
}

/** Atomic write so the reader never sees a partial file. */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, content); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export function readJsonFile<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

export function readTextFile(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch { return undefined; }
}
