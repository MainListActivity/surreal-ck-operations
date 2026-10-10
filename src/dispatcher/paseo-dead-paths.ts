import { existsSync } from 'node:fs';
import type { PaseoWorkspaceGateway } from './paseo.ts';

export interface DeadPathEntry { id: string; path: string }
export interface DeadPathReport {
  /** false = dry-run: only the plan is returned, nothing is archived or deleted. */
  apply: boolean;
  /** Workspaces whose cwd no longer exists on disk (archived when applied). */
  workspaces: DeadPathEntry[];
  /** Projects whose path no longer exists on disk (deleted when applied). */
  projects: DeadPathEntry[];
  /** Entries without any recorded path are never touched and listed here instead. */
  skipped: Array<{ kind: 'workspace' | 'project'; id: string; reason: string }>;
}

/** One-time dead-path repair: Paseo workspaces/projects whose cwd/path vanished from disk keep
 * the daemon listing zombies forever. Selection is by path existence only — never by title,
 * never touching live paths (those belong to the reference-zero event teardown). Archiving keeps
 * transcripts and project deletion keeps directories, so applying the same plan twice is a no-op.
 * The injected `exists` predicate exists for tests. */
export async function deadPathCleanup(
  gateway: PaseoWorkspaceGateway,
  input?: { apply?: boolean; exists?: (path: string) => boolean },
): Promise<DeadPathReport> {
  const exists = input?.exists ?? (path => existsSync(path));
  const report: DeadPathReport = { apply: input?.apply ?? false, workspaces: [], projects: [], skipped: [] };
  for (const w of await gateway.listWorkspaces()) {
    if (!w.cwd) { report.skipped.push({ kind: 'workspace', id: w.workspaceId, reason: 'no-cwd-recorded' }); continue; }
    if (!exists(w.cwd)) report.workspaces.push({ id: w.workspaceId, path: w.cwd });
  }
  for (const p of await gateway.listProjects()) {
    if (!p.path) { report.skipped.push({ kind: 'project', id: p.projectId, reason: 'no-path-recorded' }); continue; }
    if (!exists(p.path)) report.projects.push({ id: p.projectId, path: p.path });
  }
  if (!report.apply) return report;
  for (const w of report.workspaces) await gateway.archiveWorkspace(w.id);
  for (const p of report.projects) await gateway.deleteProject(p.id);
  return report;
}
