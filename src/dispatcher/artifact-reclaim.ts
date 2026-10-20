/**
 * Artifact lifecycle for `<serviceHome>/evidence/<taskId>` and `<serviceHome>/deliverables/<taskId>`.
 *
 * Both directories are working storage: employees write attachments to evidence/ and
 * `deliverable_publish` copies the owner-facing files into deliverables/. Nothing ever removed
 * them, so every media-heavy task stayed on disk for good — one burst of short-drama work put
 * ~24 GB there within days and the free-disk floor then halted all dispatch.
 *
 * Reclaim is bound to the task lifecycle, never to file mtimes:
 *   - only tasks in a terminal state (done / void) qualify, clocked from their last audit row;
 *   - a grace window keeps fresh results intact (done evidence 3d, deliverables 7d, retired work 1d);
 *   - ancestors of unfinished work stay intact (fully in normal mode, direct dependencies under pressure);
 *   - "trim" removes heavy files (media, archives, dependency/VCS trees) and keeps the small text
 *     trail, leaving a `.reclaimed.json` tombstone that records what went away;
 *   - under disk pressure the grace shrinks to 12h and the oldest tasks go first until free space recovers.
 *
 * Published copies are APFS clones of evidence files: space only returns once every copy is gone.
 * `removedBytes` is therefore logical; callers decide with the real free-disk probe.
 */
import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { parseGraceDays } from './worktree-reclaim.ts';

export type ArtifactKind = 'evidence' | 'deliverables';
export type ArtifactTrigger = 'sweep' | 'pressure' | 'manual' | 'dry_run';
export type ArtifactMode = 'normal' | 'pressure';
/** How much unfinished work still needs this task: direct dependency, ancestor only, or none. */
export type ArtifactProtection = 'none' | 'indirect' | 'direct';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MAX_DEPTH = 32;
const LARGEST_KEPT = 20;
const LARGEST_MIN_BYTES = 1_048_576;

export const TOMBSTONE = '.reclaimed.json';
/** Same shape the preview server and attachment helpers accept for task ids (a single path segment). */
export const TASK_DIR = /^[A-Za-z0-9_-]{1,128}$/;

/** Trees that are never evidence (AGENTS.md: venv / dependency / VCS output is not evidence). */
export const JUNK_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', '.pnpm-store', 'site-packages',
]);

/** Text-like files stay (up to `keepTextBytes`): reports, logs, transcripts, small structured data. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.ndjson', '.log', '.csv', '.tsv', '.yaml', '.yml', '.toml',
  '.html', '.htm', '.xml', '.srt', '.vtt', '.diff', '.patch', '.sql', '.ts', '.tsx', '.js', '.mjs', '.py', '.sh', '.svg',
]);

export interface ArtifactKeepRules {
  /** Files at or below this size are always kept (thumbnails, short notes). */
  keepSmallBytes: number;
  /** Text-like files up to this size are kept. */
  keepTextBytes: number;
}

export interface ArtifactPolicy extends ArtifactKeepRules {
  enabled: boolean;
  /** Days a done task's evidence stays intact after its terminal event. */
  evidenceGraceMs: number;
  /** Days a done task's published deliverables stay intact. */
  deliverableGraceMs: number;
  /** Retired work is never an accepted result: both kinds use this shorter window. */
  voidGraceMs: number;
  /** Under disk pressure any terminal artifact at least this old is eligible, oldest first. */
  pressureMinAgeMs: number;
  now: Date;
}

export const DEFAULT_ARTIFACT_RULES = {
  evidenceGraceMs: 3 * DAY,
  deliverableGraceMs: 7 * DAY,
  voidGraceMs: 1 * DAY,
  pressureMinAgeMs: 12 * HOUR,
  keepSmallBytes: 128 * 1024,
  keepTextBytes: 2 * 1024 * 1024,
} as const;

export interface ArtifactConfigInput {
  artifactReclaimEnabled: boolean;
  artifactEvidenceGraceDays: number;
  artifactDeliverableGraceDays: number;
  artifactHeadroomMb?: number;
  minFreeDiskMb?: number;
}

/** Env wins over config, like SCK_WORKTREE_RECLAIM: `0`/`false` is the emergency stop. */
export function artifactReclaimEnabledFrom(env: NodeJS.ProcessEnv, config?: Pick<ArtifactConfigInput, 'artifactReclaimEnabled'>): boolean {
  const raw = env.SCK_ARTIFACT_RECLAIM;
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  return config?.artifactReclaimEnabled ?? true;
}

/** The env kill switch is the only thing that also stops emergency (resource-gate) reclaim. */
export function artifactReclaimHardStop(env: NodeJS.ProcessEnv): boolean {
  const raw = env.SCK_ARTIFACT_RECLAIM;
  return raw === '0' || raw === 'false';
}

export interface ReclaimCliArgs { execute: boolean; taskId?: string; targetFreeMb?: number }

/**
 * Operator CLI arguments. A bare number is a free-disk target, never a task id:
 * task ids are UUIDs and never all digits, so the old two `find` calls both matched
 * a target like `20480` and filtered the run down to a task that does not exist.
 */
export function parseReclaimCliArgs(args: string[]): ReclaimCliArgs {
  const execute = args.includes('--execute');
  const positional = args.filter(a => !a.startsWith('--'));
  const isTarget = (a: string) => /^\d+$/.test(a);
  const target = positional.find(isTarget);
  const taskId = positional.find(a => !isTarget(a) && /^[A-Za-z0-9_-]{1,128}$/.test(a));
  return { execute, taskId, targetFreeMb: target === undefined ? undefined : Number(target) };
}

export function artifactPolicyFrom(config: ArtifactConfigInput, env: NodeJS.ProcessEnv, now: Date): ArtifactPolicy {
  return {
    ...DEFAULT_ARTIFACT_RULES,
    enabled: artifactReclaimEnabledFrom(env, config),
    evidenceGraceMs: parseGraceDays(config.artifactEvidenceGraceDays, 3) * DAY,
    deliverableGraceMs: parseGraceDays(config.artifactDeliverableGraceDays, 7) * DAY,
    now,
  };
}

export interface ArtifactCandidate {
  kind: ArtifactKind;
  /** Task state; undefined = no task row owns this directory. */
  state: string | undefined;
  /** Authority clock: the task's last audit row. Never a file mtime. */
  terminalAt: Date | undefined;
  protection: ArtifactProtection;
  tombstoned: boolean;
}

export interface ArtifactDecision {
  action: 'trim' | 'keep' | 'skip';
  reasons: string[];
  ageMs?: number;
}

export function decideArtifact(candidate: ArtifactCandidate, policy: ArtifactPolicy, mode: ArtifactMode): ArtifactDecision {
  const skip = (reason: string): ArtifactDecision => ({ action: 'skip', reasons: [reason] });
  if (!policy.enabled) return skip('reclaim-disabled');
  if (candidate.state === undefined) return skip('no-task-row');
  if (candidate.state !== 'done' && candidate.state !== 'void') return skip('task-not-terminal');
  if (candidate.tombstoned) return skip('already-trimmed');
  // Unfinished work may still open what its ancestors produced. Under pressure only the direct
  // dependencies stay protected — the transitive chain is the first thing to give.
  if (candidate.protection === 'direct' || (candidate.protection === 'indirect' && mode === 'normal')) return skip('needed-by-open-task');
  if (!candidate.terminalAt) return skip('no-authority-clock');
  const ageMs = policy.now.getTime() - candidate.terminalAt.getTime();
  const kindGrace = candidate.kind === 'evidence' ? policy.evidenceGraceMs : policy.deliverableGraceMs;
  const grace = candidate.state === 'void' ? Math.min(kindGrace, policy.voidGraceMs) : kindGrace;
  if (ageMs >= grace) return { action: 'trim', reasons: ['past-grace'], ageMs };
  if (mode === 'pressure' && ageMs >= Math.min(policy.pressureMinAgeMs, grace)) return { action: 'trim', reasons: ['disk-pressure'], ageMs };
  return { action: 'keep', reasons: ['within-grace'], ageMs };
}

export function keepsFile(name: string, size: number, rules: ArtifactKeepRules): boolean {
  if (name === TOMBSTONE) return true;
  if (size <= rules.keepSmallBytes) return true;
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase()) && size <= rules.keepTextBytes;
}

export interface TrimOptions {
  /** `<serviceHome>/evidence` or `<serviceHome>/deliverables`. */
  root: string;
  kind: ArtifactKind;
  taskId: string;
  rules: ArtifactKeepRules;
  /** Walk and count, change nothing. */
  dryRun?: boolean;
  /** Epoch ms. The walk stops (partial) once passed; the next run carries on. */
  deadline?: number;
  meta: { state?: string; terminalAt?: Date; trigger: ArtifactTrigger; runId: string; now: Date };
}

export interface TrimResult {
  kind: ArtifactKind;
  taskId: string;
  dryRun: boolean;
  removedFiles: number;
  /** Logical bytes. APFS clones keep their blocks until the last copy goes. */
  removedBytes: number;
  keptFiles: number;
  keptBytes: number;
  junkDirs: string[];
  symlinks: number;
  errors: number;
  /** The walk stopped early (deadline or depth); no tombstone was written. */
  partial: boolean;
  /** Set when the directory was not touched at all. */
  refused?: string;
  byExt: Record<string, { files: number; bytes: number }>;
  largest: Array<{ path: string; bytes: number }>;
}

/**
 * Trims one task directory. Safe by construction: only plain directories directly under the
 * canonical root are accepted, symlinks are never followed or removed, every directory is
 * re-confined by realpath before it is read, and the only deletions are `unlink` on regular
 * files and `rm -r` on junk trees that were just seen as real directories inside the task dir.
 */
export async function trimArtifactDir(opts: TrimOptions): Promise<TrimResult> {
  const { kind, taskId, rules, dryRun = false, deadline, meta } = opts;
  const result: TrimResult = {
    kind, taskId, dryRun, removedFiles: 0, removedBytes: 0, keptFiles: 0, keptBytes: 0,
    junkDirs: [], symlinks: 0, errors: 0, partial: false, byExt: {}, largest: [],
  };
  const refuse = (reason: string): TrimResult => ({ ...result, refused: reason });
  if (!TASK_DIR.test(taskId)) return refuse('invalid-task-id');
  let rootReal: string;
  try { rootReal = await realpath(opts.root); } catch { return refuse('root-missing'); }
  const dir = join(rootReal, taskId);
  const top = await lstat(dir).catch(() => undefined);
  if (!top) return refuse('missing');
  if (top.isSymbolicLink() || !top.isDirectory()) return refuse('not-a-plain-directory');
  if ((await realpath(dir).catch(() => undefined)) !== dir) return refuse('path-not-canonical');

  const inside = (path: string) => path === dir || path.startsWith(dir + sep);
  const pastDeadline = () => deadline !== undefined && Date.now() > deadline;
  const note = (slotName: string, files: number, bytes: number) => {
    const slot = (result.byExt[slotName] ??= { files: 0, bytes: 0 });
    slot.files += files; slot.bytes += bytes;
  };

  const treeSize = async (abs: string, depth = 0): Promise<{ files: number; bytes: number }> => {
    const total = { files: 0, bytes: 0 };
    if (depth > MAX_DEPTH) return total;
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const entry of entries) {
      const path = join(abs, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const sub = await treeSize(path, depth + 1);
        total.files += sub.files; total.bytes += sub.bytes;
      } else if (entry.isFile()) {
        const info = await lstat(path).catch(() => undefined);
        if (info?.isFile()) { total.files += 1; total.bytes += info.size; }
      }
    }
    return total;
  };

  const removeJunk = async (abs: string, rel: string): Promise<void> => {
    const size = await treeSize(abs);
    if (!dryRun) {
      try { await rm(abs, { recursive: true, force: true }); } catch { result.errors++; return; }
    }
    result.junkDirs.push(rel);
    result.removedFiles += size.files; result.removedBytes += size.bytes;
    note('(junk-tree)', size.files, size.bytes);
  };

  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) { result.partial = true; return; }
    const real = await realpath(abs).catch(() => undefined);
    if (!real || !inside(real)) { result.errors++; return; }
    let entries: Dirent[];
    try { entries = await readdir(abs, { withFileTypes: true }); } catch { result.errors++; return; }
    for (const entry of entries) {
      if (pastDeadline()) { result.partial = true; return; }
      const path = join(abs, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { result.symlinks++; continue; }
      if (entry.isDirectory()) {
        if (JUNK_DIRS.has(entry.name)) { await removeJunk(path, relPath); continue; }
        await walk(path, relPath, depth + 1);
        // Only succeeds when the walk emptied it; a directory with kept files stays.
        if (!dryRun && !result.partial) await rmdir(path).catch(() => undefined);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile()) continue;
      if (keepsFile(entry.name, info.size, rules)) { result.keptFiles++; result.keptBytes += info.size; continue; }
      if (!dryRun) {
        try { await unlink(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // raced with another run
          result.errors++;
          continue;
        }
      }
      result.removedFiles++; result.removedBytes += info.size;
      note(extname(entry.name).toLowerCase() || '(none)', 1, info.size);
      if (info.size >= LARGEST_MIN_BYTES) result.largest.push({ path: relPath, bytes: info.size });
    }
  };

  await walk(dir, '', 0);
  result.largest = result.largest.sort((a, b) => b.bytes - a.bytes).slice(0, LARGEST_KEPT);

  // The tombstone doubles as the "already handled" marker, so it is only written for a complete
  // walk that actually removed something. Directories with nothing to trim are cheap to re-check.
  if (!dryRun && !result.partial && (result.removedFiles > 0 || result.junkDirs.length > 0)) {
    const target = join(dir, TOMBSTONE);
    const tmp = `${target}.${process.pid}.tmp`;
    const doc = {
      version: 1,
      reclaimedAt: meta.now.toISOString(),
      runId: meta.runId,
      trigger: meta.trigger,
      kind,
      taskId,
      taskState: meta.state,
      terminalAt: meta.terminalAt?.toISOString(),
      removedFiles: result.removedFiles,
      removedBytes: result.removedBytes,
      keptFiles: result.keptFiles,
      keptBytes: result.keptBytes,
      junkDirs: result.junkDirs,
      errors: result.errors,
      rules,
      byExt: Object.fromEntries(Object.entries(result.byExt).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12)),
      largest: result.largest,
    };
    try {
      await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644 });
      await rename(tmp, target);
    } catch {
      result.errors++;
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
  return result;
}
