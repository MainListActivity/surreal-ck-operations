import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Surreal } from 'surrealdb';
import {
  artifactPolicyFrom, decideArtifact, TASK_DIR, TOMBSTONE, trimArtifactDir,
  type ArtifactConfigInput, type ArtifactKind, type ArtifactMode, type ArtifactProtection, type ArtifactTrigger,
} from './artifact-reclaim.ts';

const DEFAULT_MAX_MS = 30_000;

export interface ArtifactTaskInfo {
  state: string;
  /** Last audit row of a terminal task. Undefined for tasks that are not terminal. */
  terminalAt?: Date;
  protection: ArtifactProtection;
}

/** Everything the reclaimer needs to know about tasks; the DB adapter below implements it. */
export interface ArtifactTaskSource {
  tasks(): Promise<Map<string, ArtifactTaskInfo>>;
}

export interface ArtifactReclaimInput {
  trigger: ArtifactTrigger;
  /**
   * Free-disk target in MB. Setting it selects pressure mode: the grace shrinks, the oldest
   * tasks go first (evidence and deliverables together — clones free nothing until both are
   * gone) and the run stops as soon as the real free-disk probe reaches the target.
   */
  targetFreeMb?: number;
  dryRun?: boolean;
  kinds?: ArtifactKind[];
  taskId?: string;
  /** Re-scan directories that already carry a tombstone. */
  force?: boolean;
  /** Wall-clock budget; whatever is left is picked up by the next run. */
  maxMs?: number;
}

export interface ArtifactTrimmed {
  kind: ArtifactKind;
  taskId: string;
  state?: string;
  ageDays?: number;
  reason: string;
  removedFiles: number;
  removedBytes: number;
  keptFiles: number;
  keptBytes: number;
  errors: number;
  partial: boolean;
}

export interface ArtifactReclaimResult {
  runId: string;
  trigger: ArtifactTrigger;
  dryRun: boolean;
  mode: ArtifactMode;
  /** Reclaim is switched off (config or SCK_ARTIFACT_RECLAIM=0) and this was an automatic run. */
  disabled?: boolean;
  /** Another run in this process was still going. */
  busy?: boolean;
  trimmed: ArtifactTrimmed[];
  /** Reason → number of directories left alone (grace, protection, already trimmed, …). */
  skipped: Record<string, number>;
  removedFiles: number;
  /** Logical bytes. Cloned copies keep their blocks until the last one goes: trust the probe. */
  freedBytes: number;
  freeDiskMbBefore?: number;
  freeDiskMbAfter?: number;
  targetMet?: boolean;
  truncated: boolean;
  errors: number;
}

export interface ArtifactReclaimerDeps {
  /** Service home: parent of evidence/, deliverables/ and logs/. */
  home: string;
  tasks: ArtifactTaskSource;
  config: () => Promise<ArtifactConfigInput>;
  /** Real free space of the volume holding the service home (MB). */
  freeDiskMb?: () => number | undefined;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  log?: (message: string) => void;
}

export class ArtifactReclaimer {
  private running = false;
  /** Directories seen with nothing left to trim; spares re-walking them every sweep. */
  private readonly clean = new Set<string>();

  constructor(private readonly deps: ArtifactReclaimerDeps) {}

  async reclaim(input: ArtifactReclaimInput): Promise<ArtifactReclaimResult> {
    const mode: ArtifactMode = input.targetFreeMb !== undefined ? 'pressure' : 'normal';
    const dryRun = input.dryRun === true || input.trigger === 'dry_run';
    const result: ArtifactReclaimResult = {
      runId: randomUUID(), trigger: input.trigger, dryRun, mode,
      trimmed: [], skipped: {}, removedFiles: 0, freedBytes: 0, truncated: false, errors: 0,
    };
    if (this.running) { result.busy = true; return result; }
    this.running = true;
    try { await this.run(input, result, mode, dryRun); } finally { this.running = false; }
    return result;
  }

  private probe(): number | undefined {
    try { return this.deps.freeDiskMb?.(); } catch { return undefined; }
  }

  private async handled(kind: ArtifactKind, taskId: string): Promise<boolean> {
    if (this.clean.has(`${kind}/${taskId}`)) return true;
    return Boolean(await lstat(join(this.deps.home, kind, taskId, TOMBSTONE)).catch(() => undefined));
  }

  private async run(input: ArtifactReclaimInput, result: ArtifactReclaimResult, mode: ArtifactMode, dryRun: boolean): Promise<void> {
    const { home } = this.deps;
    const now = (this.deps.now ?? (() => new Date()))();
    const base = artifactPolicyFrom(await this.deps.config(), this.deps.env ?? process.env, now);
    // The kill switch stops automatic runs; an operator running it by hand (or previewing) still can.
    const automatic = input.trigger === 'sweep' || input.trigger === 'pressure';
    const policy = { ...base, enabled: base.enabled || !automatic };
    if (!policy.enabled) { result.disabled = true; return; }
    result.freeDiskMbBefore = this.probe();

    const tasks = await this.deps.tasks.tasks();
    interface Planned { taskId: string; info?: ArtifactTaskInfo; kinds: Array<{ kind: ArtifactKind; reason: string; ageMs?: number }> }
    const planned = new Map<string, Planned>();
    for (const kind of input.kinds ?? ['evidence', 'deliverables'] as ArtifactKind[]) {
      const names = await readdir(join(home, kind)).catch(() => [] as string[]);
      for (const taskId of names) {
        if (!TASK_DIR.test(taskId)) continue;
        if (input.taskId !== undefined && taskId !== input.taskId) continue;
        const info = tasks.get(taskId);
        const decision = decideArtifact({
          kind, state: info?.state, terminalAt: info?.terminalAt, protection: info?.protection ?? 'none',
          tombstoned: input.force === true ? false : await this.handled(kind, taskId),
        }, policy, mode);
        if (decision.action !== 'trim') {
          const reason = decision.reasons[0]!;
          result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
          continue;
        }
        const entry = planned.get(taskId) ?? { taskId, info, kinds: [] };
        entry.kinds.push({ kind, reason: decision.reasons[0]!, ageMs: decision.ageMs });
        planned.set(taskId, entry);
      }
    }

    // Oldest terminal event first: the longest-settled work is the safest to give up.
    const queue = [...planned.values()].sort((a, b) =>
      (a.info?.terminalAt?.getTime() ?? Infinity) - (b.info?.terminalAt?.getTime() ?? Infinity) || a.taskId.localeCompare(b.taskId));
    const deadline = Date.now() + (input.maxMs ?? DEFAULT_MAX_MS);
    for (const item of queue) {
      if (input.targetFreeMb !== undefined) {
        const free = this.probe();
        if (free !== undefined && free >= input.targetFreeMb) break;
      }
      if (Date.now() > deadline) { result.truncated = true; break; }
      for (const entry of item.kinds) {
        const trim = await trimArtifactDir({
          root: join(home, entry.kind), kind: entry.kind, taskId: item.taskId, rules: policy, dryRun, deadline,
          meta: { state: item.info?.state, terminalAt: item.info?.terminalAt, trigger: input.trigger, runId: result.runId, now },
        });
        if (trim.refused) {
          const key = `refused:${trim.refused}`;
          result.skipped[key] = (result.skipped[key] ?? 0) + 1;
          continue;
        }
        result.errors += trim.errors;
        if (trim.partial) result.truncated = true;
        if (trim.removedFiles === 0 && trim.junkDirs.length === 0) {
          if (!dryRun && !trim.partial) this.clean.add(`${entry.kind}/${item.taskId}`);
          continue;
        }
        result.trimmed.push({
          kind: entry.kind, taskId: item.taskId, state: item.info?.state, reason: entry.reason,
          ageDays: entry.ageMs === undefined ? undefined : Math.round(entry.ageMs / 8_640_000) / 10,
          removedFiles: trim.removedFiles, removedBytes: trim.removedBytes, keptFiles: trim.keptFiles, keptBytes: trim.keptBytes,
          errors: trim.errors, partial: trim.partial,
        });
        result.removedFiles += trim.removedFiles;
        result.freedBytes += trim.removedBytes;
      }
    }

    result.freeDiskMbAfter = this.probe();
    if (input.targetFreeMb !== undefined && result.freeDiskMbAfter !== undefined) result.targetMet = result.freeDiskMbAfter >= input.targetFreeMb;
    if (!dryRun && (result.trimmed.length || result.errors || result.truncated)) {
      this.deps.log?.(`artifact reclaim ${input.trigger}: ${summarizeReclaim(result)}`);
      await this.writeLedger(result, now).catch(error => this.deps.log?.(`artifact reclaim ledger write failed: ${(error as Error).message}`));
    }
  }

  /** Append-only JSONL next to the service logs: one line per trimmed directory plus a run summary. */
  private async writeLedger(result: ArtifactReclaimResult, now: Date): Promise<void> {
    const dir = join(this.deps.home, 'logs');
    await mkdir(dir, { recursive: true });
    const at = now.toISOString();
    const lines = result.trimmed.map(t => JSON.stringify({ at, runId: result.runId, trigger: result.trigger, ...t }));
    lines.push(JSON.stringify({
      at, runId: result.runId, trigger: result.trigger, mode: result.mode, summary: true,
      trimmed: result.trimmed.length, removedFiles: result.removedFiles, freedBytes: result.freedBytes,
      freeDiskMbBefore: result.freeDiskMbBefore, freeDiskMbAfter: result.freeDiskMbAfter, targetMet: result.targetMet,
      truncated: result.truncated, errors: result.errors, skipped: result.skipped,
    }));
    await appendFile(join(dir, 'artifact-reclaim.jsonl'), `${lines.join('\n')}\n`);
  }
}

const SKIP_TEXT: Record<string, string> = {
  'within-grace': '仍在宽限期内',
  'needed-by-open-task': '被未完成任务依赖',
  'task-not-terminal': '任务尚未结束',
  'no-authority-clock': '缺少时间依据',
};

/** One line for logs and the owner notice. */
export function summarizeReclaim(result: ArtifactReclaimResult): string {
  if (result.disabled) return '终态产物回收已关闭（artifact_reclaim_enabled / SCK_ARTIFACT_RECLAIM）';
  const gb = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  const parts: string[] = [];
  const tasks = new Set(result.trimmed.map(t => t.taskId)).size;
  parts.push(tasks
    ? `回收 ${tasks} 个终态任务的大文件（${result.removedFiles} 个文件，逻辑 ${gb(result.freedBytes)}）`
    : '没有可回收的终态任务产物');
  if (result.freeDiskMbBefore !== undefined && result.freeDiskMbAfter !== undefined) {
    parts.push(`空闲磁盘 ${(result.freeDiskMbBefore / 1024).toFixed(1)}→${(result.freeDiskMbAfter / 1024).toFixed(1)} GB`);
  }
  if (!tasks) {
    const why = Object.entries(SKIP_TEXT).filter(([key]) => result.skipped[key]).map(([key, text]) => `${text} ${result.skipped[key]}`);
    if (why.length) parts.push(`未回收：${why.join('、')}`);
  }
  if (result.truncated) parts.push('本轮限时未做完，余下下一轮继续');
  if (result.errors) parts.push(`${result.errors} 处删除失败`);
  return parts.join('；');
}

const idOf = (value: unknown): string => String((value as { id?: unknown } | null)?.id ?? value).split('⟨').pop()!.replace('⟩', '');

/** Accepts Date, SDK DateTime, ISO text and epoch seconds/milliseconds. */
function asDate(value: unknown): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) {
    const n = Number(value);
    const date = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const raw = value as { toDate?: () => Date; toISOString?: () => string };
  if (typeof raw.toDate === 'function') return asDate(raw.toDate());
  if (typeof raw.toISOString === 'function') return asDate(raw.toISOString());
  return undefined;
}

/**
 * Task facts from SurrealDB: state, terminal clock (last audit row) and how much unfinished
 * work still depends on each task — directly, or only through the ancestor chain.
 */
export function dbArtifactTasks(db: Surreal): ArtifactTaskSource {
  // A terminal task never moves again, so its clock is read once per process.
  const clocks = new Map<string, Date>();
  return {
    async tasks() {
      const [rows] = await db.query<[Array<{ id: unknown; state: string; dependencies?: unknown[]; progress_at?: unknown }>]>(
        'SELECT id, state, dependencies, progress_at FROM task;');
      const all = rows ?? [];
      const terminal = (state: string) => state === 'done' || state === 'void';
      const deps = new Map<string, string[]>();
      for (const row of all) deps.set(idOf(row.id), (row.dependencies ?? []).map(idOf));

      const direct = new Set<string>();
      for (const row of all) if (!terminal(row.state)) for (const dep of deps.get(idOf(row.id)) ?? []) direct.add(dep);
      const indirect = new Set<string>();
      const stack = [...direct];
      while (stack.length) {
        for (const dep of deps.get(stack.pop()!) ?? []) {
          if (direct.has(dep) || indirect.has(dep)) continue;
          indirect.add(dep);
          stack.push(dep);
        }
      }

      const unclocked = all.filter(row => terminal(row.state) && !clocks.has(idOf(row.id)));
      if (unclocked.length) {
        // `math::max(datetime)` returns null on this fork, so read the rows back in
        // descending order and keep the first hit per task. Terminal clocks are read once
        // per process: a terminal task never moves again.
        const [rows] = await db.query<[Array<{ task: unknown; at: unknown }>]>(
          'SELECT task, at FROM audit WHERE task IN $ids ORDER BY at DESC;', { ids: unclocked.map(row => row.id) });
        for (const entry of rows ?? []) {
          const key = idOf(entry.task);
          if (clocks.has(key)) continue;
          const at = asDate(entry.at);
          if (at) clocks.set(key, at);
        }
      }

      const out = new Map<string, ArtifactTaskInfo>();
      for (const row of all) {
        const key = idOf(row.id);
        out.set(key, {
          state: row.state,
          terminalAt: terminal(row.state) ? (clocks.get(key) ?? asDate(row.progress_at)) : undefined,
          protection: direct.has(key) ? 'direct' : indirect.has(key) ? 'indirect' : 'none',
        });
      }
      return out;
    },
  };
}
