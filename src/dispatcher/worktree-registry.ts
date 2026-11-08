import { createHash, randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { Surreal } from 'surrealdb';
import type { Principal, ProjectView, Role, TaskView, WorkIntent, WorktreeAssignment, WorktreeView } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import { hostIO } from '../host-io.ts';
import { MAX_ASSET_PATHS, MAX_ASSET_PATH_CHARS } from '../input-bounds.ts';
import {
  decideReclaim, parseGraceDays, reclaimEnabledFrom, type ReclaimTrigger,
} from './worktree-reclaim.ts';
import { junkPathsFromPorcelain, meaningfulChanges } from './lifecycle-gc.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const record = (table: string, key: string) => new RecordId(table, key);
/** The allocation path beside a repository: <repo dir>-sck-<8 hex of the repo path>-<suffix>. */
const siblingPath = (repo: string, suffix: string): string => {
  const io = hostIO();
  return io.path.join(io.path.dirname(repo), `${io.path.basename(repo)}-sck-${hash(repo).slice(0, 8)}-${suffix}`);
};
export const worktreeId = (repo: string, path: string) => hash(`${repo}\0${path}`);
export interface SceneCleanupResult { workspacesArchived?: number; projectsDeleted?: number; employeesRetired?: number }
export interface RegistryOptions {
  opsRepo: string;
  /** When false, inventory still classifies but reclaim never deletes. Default: env/config enabled. */
  reclaimEnabled?: boolean;
  orphanGraceDays?: number;
  /** Injectable clock for orphan grace tests. */
  now?: () => Date;
  /**
   * Paseo-side scene teardown, run under the repo lock at the delete transaction point just
   * before the git tree is removed. Throwing keeps the tree and its row: cleanup_todo is
   * recorded and the next event point or sweep retries the whole point idempotently.
   */
  sceneCleaner?: (treePath: string) => Promise<SceneCleanupResult | void>;
}
export interface ReclaimResult {
  scanId: string;
  removed: string[];
  kept: Array<{ path: string; reason: string }>;
  branchesDeleted: string[];
  branchesRetained: Array<{ branch: string; reason: string }>;
  /** Registry rows dropped because the tree was already gone and nothing referenced it. */
  dropped?: string[];
  audited: number;
}
interface Tree { path: string; branch?: string; main: boolean }
interface Row { id: RecordId; repo: string; project?: string; path: string; mode: WorktreeAssignment['mode'];
  branch?: string; lane?: string; protection?: string; created_at: unknown; last_used_at: unknown;
  last_released_at?: unknown; cleanup_todo?: string }
interface Ref { task?: RecordId; session_active?: boolean; employee: string; delivery: string; fence: number; intent: WorkIntent;
  at: unknown; tree: RecordId; current?: string; current_delivery?: string; task_state?: string; tree_mode?: string;
  assigned_tree?: string; current_fence?: number; handover?: boolean; resume_state?: string }

/** No shell, no credential files, and bounded git processes (the host runs the program with a 30 s limit). */
async function git(repo: string, args: string[]): Promise<string> {
  const run = await hostIO().proc.run('git', ['-C', repo, ...args], { timeoutMs: 30_000 });
  if (run.code === 0) return run.stdout.trimEnd();
  throw new CompanyError('conflict', `git worktree operation failed: ${run.stderr.slice(0, 300)}`);
}
async function trees(repo: string): Promise<Tree[]> {
  const io = hostIO();
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  return out.split('\n\n').filter(Boolean).map((block, i) => {
    const lines = block.split('\n');
    const path = lines.find(l => l.startsWith('worktree '))!.slice(9);
    return { path: io.fs.exists(path) ? io.fs.realpath(path) : io.path.resolve(path), main: i === 0,
      branch: lines.find(l => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') };
  });
}

/**
 * Runs `action` under the repository's allocation lock. The host holds a kernel flock (released on crash/EOF, with no stale
 * lease timeout); see HostLock and host-node.ts.
 */
export async function withRepoLock<T>(commonDir: string, action: () => Promise<T>): Promise<T> {
  return hostIO().lock.withRepoLock(commonDir, action);
}

export function validateIntent(intent: WorkIntent | undefined): void {
  if (intent === undefined) return;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) || Object.keys(intent).some(k => !['kind', 'paths', 'lane'].includes(k)) ||
      (intent.paths !== undefined && !Array.isArray(intent.paths)) || (intent.lane !== undefined && typeof intent.lane !== 'string')) throw new CompanyError('invalid', 'Invalid work intent fields');
  if (!['read', 'code', 'assets'].includes(intent.kind) || (intent.lane !== undefined && !/^[a-zA-Z0-9_-]{1,60}$/.test(intent.lane))) throw new CompanyError('invalid', 'Invalid work intent');
  if (intent.kind === 'assets' && (!intent.paths?.length || intent.paths.length > MAX_ASSET_PATHS)) throw new CompanyError('invalid', 'Asset writes require authorized relative directories');
  if (intent.kind !== 'assets' && intent.paths?.length) throw new CompanyError('invalid', 'Only assets use directory write scopes');
  for (const p of intent.paths ?? []) {
    if (typeof p !== 'string' || p.startsWith('/') || p.length > MAX_ASSET_PATH_CHARS || p.split('/').some(s => !s || s === '.' || s === '..' || /^(\.git|\.env.*|\.runtime|credentials|private)$/i.test(s)) || /[\\\x00-\x1f]/.test(p)) throw new CompanyError('invalid', 'Unsafe asset write directory');
  }
}
export const overlap = (a: string, b: string) => {
  a = a.toLocaleLowerCase('en-US'); b = b.toLocaleLowerCase('en-US');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};
const refState = (r: Ref): 'active' | 'recovery' | 'released' => {
  if (r.session_active) return 'active';
  if (r.current === r.employee && r.current_delivery === r.delivery && r.current_fence === r.fence && r.assigned_tree === String(r.tree.id)) return 'active';
  // Every non-terminal task state (ready, doing, review, blocked) keeps its scene: an unheld ref on
  // the task's assigned non-shared tree stays recovery until a terminal state releases it. 'void'
  // is terminal like 'done' — a retired task's scene refs release, so decideReclaim can delete the
  // exclusive tree instead of pinning it forever. Shared trees are already hard-protected, so their
  // refs release normally and serial tasks keep reusing the tree.
  if (!r.current && r.task_state && r.task_state !== 'done' && r.task_state !== 'void'
    && r.assigned_tree === String(r.tree.id) && r.tree_mode !== 'shared') return 'recovery';
  return 'released';
};

/** What a claim asks for: its intent, the lane it joins, and the branch it must be on (undefined: a shared read tree). */
function claimShape(task: TaskView, role: string) {
  const intent: WorkIntent = task.state === 'review' ? { kind: 'read' } : task.workIntent ?? { kind: 'read' };
  const writes = intent.kind === 'code' || (task.state === 'review' && task.executorRole === 'engineering' && task.kind === 'task' && !['read', 'assets'].includes(task.workIntent?.kind ?? 'code'));
  const desired = writes ? `task/${task.id.slice(0, 8)}` : undefined;
  return { intent, desired };
}
type ClaimShape = ReturnType<typeof claimShape>;

/**
 * The existing tree a claim lands in, or undefined when allocate creates one. Pure over the rows and git trees it is given, so
 * allocate and the read-only preflight choose the same tree.
 */
function chooseTree(rows: Row[], list: Tree[], task: TaskView, shape: ClaimShape): Row | undefined {
  const { intent, desired } = shape;
  const shared = rows.find(r => r.mode === 'shared');
  const previous = task.worktree;
  const own = previous && rows.find(r => String(r.id.id) === previous.id);
  const legacy = list.find(t => t.branch === `task/${task.id.slice(0, 8)}` && !t.main);
  let chosen = own && list.find(t => t.path === own.path && (!desired || t.branch === desired)) ? own : undefined;
  // Existing task trees are adopted in place, keeping protected mode and all uncommitted work.
  if (!chosen && legacy && (intent.kind === 'code' || desired)) chosen = rows.find(r => r.path === legacy.path);
  if (chosen && desired && chosen.branch !== desired) chosen = undefined;
  // Code never runs in the shared tree: it is the read/asset baseline and its branch is never switched.
  if (!chosen && !desired && shared && list.some(t => t.path === shared.path)) chosen = shared;
  return chosen;
}


export class WorktreeRegistry {
  /**
   * tree id → reason of its last recorded routine retention. A sweep runs every few minutes and keeps the same trees
   * for the same reasons; recording each unchanged retention filled worktree_audit with ~95% identical skip rows.
   * A routine sweep records a retention only when its reason changes; event and manual reclaims record every one.
   */
  private readonly retained = new Map<string, string>();
  constructor(private readonly db: Surreal, readonly options: RegistryOptions) {}
  async identity(repoPath: string) {
    const io = hostIO();
    const path = io.fs.realpath(repoPath);
    const common = io.fs.realpath(io.path.resolve(path, await git(path, ['rev-parse', '--git-common-dir'])));
    const list = await trees(path);
    return { repo: list[0]!.path, common, list };
  }
  async locked<T>(repoPath: string, action: (repo: string, list: Tree[]) => Promise<T>) {
    const { repo, common } = await this.identity(repoPath);
    return withRepoLock(common, async () => action(repo, await trees(repo)));
  }
  private async rows(repo?: string): Promise<Row[]> {
    const [rows] = await this.db.query<[Row[]]>('SELECT * FROM worktree WHERE $repo = NONE OR repo = $repo;', { repo });
    return rows;
  }
  private async refs(repo?: string): Promise<Ref[]> {
    const [refs] = await this.db.query<[Ref[]]>(`SELECT *, task.current_employee AS current, task.delivery_id AS current_delivery,
      task.state AS task_state, task.fence AS current_fence, task.worktree.id AS assigned_tree, task.handover AS handover,
      task.resume_state AS resume_state, tree.mode AS tree_mode FROM worktree_ref WHERE $repo = NONE OR tree.repo = $repo;`, { repo });
    const [sessions] = await this.db.query<[Array<Ref & { retired?: boolean; enabled?: boolean }>]>(`SELECT *,
      holder.retired AS retired, holder.workspace_read_active AS enabled, tree.mode AS tree_mode
      FROM worktree_session_ref WHERE $repo = NONE OR tree.repo = $repo;`, { repo });
    return [...refs, ...sessions.map(r => ({ ...r, session_active: !!r.enabled && !r.retired }))];
  }
  /** Import every git tree as protected before using any of them. Never reset legacy/unknown trees. */
  private async reconcile(repo: string, list: Tree[], project?: string) {
    const rows = await this.rows(repo);
    for (const t of list) {
      const existing = rows.find(r => r.path === t.path);
      if (existing) {
        if (project && !existing.project) await this.db.query('UPDATE ONLY $tree SET project = $project;', { tree: existing.id, project });
        continue;
      }
      const managedRead = t.path === siblingPath(repo, 'shared') && t.branch === `sck/shared-${hash(repo).slice(0, 12)}`;
      const protection = managedRead ? undefined : t.main ? 'repository-main' : 'legacy-or-release: manual adoption required';
      await this.db.query(`CREATE ONLY $tree CONTENT { repo: $repo, project: $project, path: $path,
        branch: $branch, mode: $mode, protection: $protection, created_at: time::now(), last_used_at: time::now() };`,
        { tree: record('worktree', worktreeId(repo, t.path)), repo, project, path: t.path, branch: t.branch, protection, mode: managedRead ? 'shared' : 'protected' });
    }
  }
  /** The shared tree is a read baseline. A branch that drifted onto it is moved off, never adopted. */
  private async restoreShared(repo: string, list: Tree[], shared: Row, base: string, writing: boolean) {
    const expected = `sck/shared-${hash(repo).slice(0, 12)}`;
    const tree = list.find(t => t.path === shared.path);
    if (!tree || hostIO().path.basename(shared.path) !== hostIO().path.basename(siblingPath(repo, 'shared'))) return;
    if (tree.branch !== expected) {
      if (writing || await git(shared.path, ['status', '--porcelain'])) return;
      let exists = false;
      try { await git(repo, ['show-ref', '--verify', `refs/heads/${expected}`]); exists = true; } catch {}
      await git(shared.path, ['checkout', ...(exists ? [expected] : ['-b', expected, base])]);
      tree.branch = expected;
    }
    if (shared.branch !== expected) {
      await this.db.query('UPDATE ONLY $tree SET branch = $branch;', { tree: shared.id, branch: expected });
      shared.branch = expected;
    }
  }
  async allocate(repo: string, list: Tree[], task: TaskView, actor: Principal, project?: ProjectView): Promise<WorktreeAssignment> {
    await this.reconcile(repo, list, project?.id);
    const shape = claimShape(task, actor.role);
    const { intent, desired } = shape;
    validateIntent(intent);
    const refs = await this.refs(repo);
    const live = refs.filter(r => refState(r) !== 'released' && String(r.task?.id) !== task.id);
    const rows = await this.rows(repo);
    const defaultBranch = project?.defaultBranch ?? list[0]!.branch ?? 'HEAD';
    let base = defaultBranch;
    try { await git(repo, ['show-ref', '--verify', `refs/remotes/origin/${defaultBranch}`]); base = `origin/${defaultBranch}`; } catch {}
    const shared = rows.find(r => r.mode === 'shared');
    // Never move a branch away from anyone still holding a task lease on the shared tree (legacy writers and reviewers).
    if (shared) await this.restoreShared(repo, list, shared, base, refs.some(r => String(r.tree.id) === String(shared.id.id) && r.task && refState(r) === 'active'));
    // 'recovery' refs are parked scene bookmarks of non-terminal tasks (e.g. a blocked task waiting
    // for its rework): nothing is working in the tree, so they must not occupy it. Only 'active'
    // refs (live session or still-assigned holder) serialize access; a parked owner's resumption
    // re-enters through this same gate and queues behind whoever is active then.
    let chosen = chooseTree(rows, list, task, shape);
    if (!chosen) {
      const mode = desired ? 'exclusive' : 'shared';
      const path = siblingPath(repo, mode === 'shared' ? 'shared' : task.id.slice(0, 8));
      // Do not treat an existing unregistered path as an empty target.
      if (hostIO().fs.exists(path)) throw new CompanyError('conflict', 'Unregistered allocation path exists; preserve it for reconciliation');
      const branch = desired ?? `sck/shared-${hash(repo).slice(0, 12)}`;
      let branchExists = false;
      try { await git(repo, ['show-ref', '--verify', `refs/heads/${branch}`]); branchExists = true; } catch {}
      // A branch with no commits of its own is only a stale pointer: bring it to the current base before reuse.
      if (branchExists && desired && base !== branch) {
        try { await git(repo, ['merge-base', '--is-ancestor', branch, base]); await git(repo, ['branch', '-f', branch, base]); } catch {}
      }
      await git(repo, ['worktree', 'add', ...(branchExists ? [] : ['-b', branch]), path, branchExists ? branch : base]);
      const canonical = hostIO().fs.realpath(path);
      chosen = { id: record('worktree', worktreeId(repo, canonical)), repo, project: project?.id, path: canonical, branch, mode, created_at: new Date(), last_used_at: new Date() };
      // Persist the physical tree before the task claim. On failure it has no effective reference.
      await this.db.query(`UPSERT ONLY $tree CONTENT { repo: $repo, project: $project, path: $path,
        branch: $branch, mode: $mode, created_at: time::now(), last_used_at: time::now() };`,
        { tree: chosen.id, repo, project: project?.id, path: canonical, branch, mode });
    }
    // Refuse branch drift (manual checkout) instead of silently restoring/resetting the tree.
    const actualBranch = await git(chosen.path, ['symbolic-ref', '--short', 'HEAD']).catch(() => undefined);
    if (actualBranch !== chosen.branch) throw new CompanyError('conflict', 'Registered branch differs from git; manual reconciliation required');
    const io = hostIO();
    for (const p of intent.paths ?? []) {
      let candidate = io.path.join(chosen.path, p);
      while (!io.fs.exists(candidate)) candidate = io.path.dirname(candidate);
      const resolved = io.fs.realpath(candidate);
      if (resolved !== candidate || (resolved !== chosen.path && !resolved.startsWith(chosen.path + io.path.sep))) throw new CompanyError('invalid', 'Asset directory escapes worktree through symlink');
    }
    return { id: String(chosen.id.id), repo, project: project?.id, worktreePath: chosen.path, branch: chosen.branch,
      mode: chosen.mode, intent,
      discipline: intent.kind === 'code' ? `仅在本任务分支 commit/push；禁止 checkout/reset/pull；禁止凭证读取；附件写 evidenceDir。`
        : intent.kind === 'assets' ? '仅写授权目录；不得 checkout/reset/pull 或 commit/push；附件写 evidenceDir。'
          : '只读代码；不得 checkout/reset/pull、commit/push 或写资产；附件写 evidenceDir。' };
  }
    async readWorkspace(repoPath: string, actor: Principal, project?: ProjectView): Promise<WorktreeAssignment> {
    return this.locked(repoPath, async (repo, list) => {
      const task: TaskView = { id: `session-${actor.employeeId}`, title: 'Read workspace', context: '', state: 'ready',
        executorRole: actor.role, reviewerRole: 'qa', kind: 'task', version: 0, fence: 0, workIntent: { kind: 'read' } };
      const assignment = await this.allocate(repo, list, task, actor, project);
      await this.db.query(`BEGIN;
        LET $who = SELECT * FROM ONLY $holder;
        IF $who = NONE OR $who.revoked = true OR $who.retired = true { THROW 'workspace identity revoked' };
        UPSERT ONLY $reference CONTENT { holder: $holder, tree: $tree, employee: $employee,
          delivery: 'read-session', fence: 0, intent: { kind: 'read' }, at: time::now() };
        UPDATE ONLY $holder SET workspace_read_active = true;
        UPDATE ONLY $tree SET last_used_at = time::now();
        COMMIT;`, { holder: record('employee', actor.employeeId), employee: actor.employeeId,
          tree: record('worktree', assignment.id), reference: record('worktree_session_ref', actor.employeeId) });
      return assignment;
    });
  }
  async releaseWorkspace(employeeId: string) {
    await this.db.query('UPDATE ONLY $holder SET workspace_read_active = false;', { holder: record('employee', employeeId) });
    // Event point: the released session ref may have been the tree's last reference.
    const ref = await this.db.select<{ tree?: RecordId }>(record('worktree_session_ref', employeeId)).catch(() => undefined);
    if (ref?.tree) await this.reclaimEvent(String(ref.tree.id), 'release').catch(() => undefined);
  }

  private async policy(): Promise<{ enabled: boolean; orphanGraceMs: number; now: Date }> {
    const [rows] = await this.db.query<[Array<{ worktree_reclaim_enabled?: boolean; worktree_orphan_grace_days?: number }>]>(
      'SELECT worktree_reclaim_enabled, worktree_orphan_grace_days FROM company_meta:config;');
    const cfg = rows[0] ?? {};
    const enabled = this.options.reclaimEnabled ?? reclaimEnabledFrom(process.env, cfg);
    const days = this.options.orphanGraceDays ?? parseGraceDays(
      process.env.SCK_WORKTREE_ORPHAN_GRACE_DAYS ?? cfg.worktree_orphan_grace_days, 7);
    return { enabled, orphanGraceMs: days * 86_400_000, now: this.options.now?.() ?? new Date() };
  }

  private asDate(value: unknown): Date | undefined {
    if (value instanceof Date) return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? undefined : d;
    }
    if (value && typeof value === 'object') {
      const raw = value as { toJSON?: () => unknown; toISOString?: () => string };
      if (typeof raw.toISOString === 'function') {
        const d = new Date(raw.toISOString());
        return Number.isNaN(d.getTime()) ? undefined : d;
      }
      if (typeof raw.toJSON === 'function') return this.asDate(raw.toJSON());
    }
    return undefined;
  }

  private async audit(entry: {
    scanId?: string; repo: string; path: string; tree?: RecordId; event: string; trigger: string;
    ownership?: object; decision: string; result: 'success' | 'skipped' | 'failed'; reason: string; task?: RecordId;
  }) {
    await this.db.query(`CREATE worktree_audit CONTENT {
      scan_id: $scan_id, repo: $repo, path: $path, tree: $tree, event: $event, trigger: $trigger,
      ownership: $ownership, decision: $decision, result: $result, reason: $reason, task: $task, at: time::now()
    };`, {
      scan_id: entry.scanId, repo: entry.repo, path: entry.path, tree: entry.tree, event: entry.event,
      trigger: entry.trigger, ownership: entry.ownership, decision: entry.decision, result: entry.result,
      reason: entry.reason, task: entry.task,
    });
  }

  /** Stamps the authority release clock; returns true only when it advanced (a new release epoch). */
  private async markReleased(tree: RecordId, at?: Date): Promise<boolean> {
    const when = at ?? new Date();
    const [rows] = await this.db.query<[Array<{ id: RecordId }>]>(
      'UPDATE $tree SET last_released_at = $at WHERE last_released_at = NONE OR last_released_at < $at RETURN AFTER;',
      { tree, at: when });
    return (rows?.length ?? 0) > 0;
  }

  /**
   * Safe remove without --force. Untracked dependency/build trees are cleared first: git
   * refuses on any untracked entry, and `node_modules` is not work. Tracked changes never
   * reach here (decideReclaim keeps a tree whose porcelain shows real changes).
   */
  private async removeTree(repo: string, path: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const io = hostIO();
      const junk = junkPathsFromPorcelain(await git(path, ['status', '--porcelain']).catch(() => ''));
      for (const rel of junk) await io.fs.removeTreeAsync(io.path.join(path, rel)).catch(() => undefined);
      await git(repo, ['worktree', 'remove', path]);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof CompanyError ? error.message.slice(0, 200) : String(error).slice(0, 200) };
    }
  }

  /** Delete only a fully merged local branch (`git branch -d`). Never force-delete. */
  private async deleteMergedBranch(repo: string, branch: string): Promise<{ deleted: boolean; reason?: string }> {
    try {
      await git(repo, ['branch', '-d', branch]);
      return { deleted: true };
    } catch (error) {
      return { deleted: false, reason: error instanceof CompanyError ? error.message.slice(0, 200) : String(error).slice(0, 200) };
    }
  }

  private async branchStillNeeded(branch: string | undefined): Promise<boolean> {
    if (!branch) return false;
    // Terminal states (done, void) never need their branch again; an unmerged branch still
    // survives `git branch -d`, so this only releases already-merged retired work.
    const [rows] = await this.db.query<[Array<{ id: RecordId }>]>(
      `SELECT id FROM task WHERE state NOT IN ['done', 'void'] AND worktree.branch = $branch LIMIT 1;`, { branch });
    return (rows?.length ?? 0) > 0;
  }

  async inventory(repo?: string): Promise<WorktreeView[]> {
    const known = await this.rows(repo);
    const seeds = repo ? [repo] : [...new Set([this.options.opsRepo, ...known.map(r => r.repo)])];
    for (const path of seeds) {
      await this.locked(path, (canonical, list) => this.reconcile(canonical, list)).catch(() => undefined);
    }
    const rows = await this.rows(repo), refs = await this.refs(repo);
    const policy = await this.policy();
    const cache = new Map<string, Tree[]>();
    const result: WorktreeView[] = [];
    for (const row of rows) {
      if (!cache.has(row.repo)) cache.set(row.repo, await trees(row.repo).catch(() => []));
      const tree = cache.get(row.repo)!.find(t => t.path === row.path);
      const references = refs.filter(r => String(r.tree.id) === String(row.id.id)).map(r => ({
        taskId: r.task ? String(r.task.id) : `session:${r.employee}`, employee: r.employee,
        deliveryId: r.delivery, fence: r.fence, intent: r.intent, state: refState(r), at: String(r.at),
      }));
      const dirty = !!(tree && meaningfulChanges(await git(row.path, ['status', '--porcelain']).catch(() => 'unavailable')));
      const status: WorktreeView['status'] = !tree ? 'missing' : tree.branch !== row.branch ? 'drift' : 'present';
      const decision = decideReclaim({
        path: row.path, branch: row.branch, mode: row.mode, protection: row.protection, main: tree?.main,
        status, dirty,
        effectiveRefs: references.filter(r => r.state === 'active').length,
        recoveryRefs: references.filter(r => r.state === 'recovery').length,
        createdAt: this.asDate(row.created_at), lastUsedAt: this.asDate(row.last_used_at),
        lastReleasedAt: this.asDate(row.last_released_at),
      }, policy);
      const reasons = [...decision.reasons];
      if (row.protection && !reasons.includes(row.protection)) reasons.push(row.protection);
      if (row.cleanup_todo) reasons.push(`cleanup-todo:${row.cleanup_todo}`);
      if (decision.graceRemainingMs !== undefined) {
        reasons.push(`grace-remaining-ms:${decision.graceRemainingMs}`);
      }
      result.push({
        id: String(row.id.id), repo: row.repo, project: row.project, worktreePath: row.path, branch: row.branch, mode: row.mode, lane: row.lane,
        createdAt: String(row.created_at), lastUsedAt: String(row.last_used_at), status, references,
        deletable: decision.deletable, reasons,
      });
    }
    return result;
  }

  /**
   * Ownership-based reclaim. Exclusive trees without effective refs are removed promptly when clean.
   * Shared / protected / unknown / dirty / in-grace orphans are retained with durable audit reasons.
   * Always re-checks references under the repo lock before deleting.
   */
  async reclaimAll(input: { trigger: ReclaimTrigger; dryRun?: boolean; repos?: string[]; treeId?: string } = { trigger: 'sweep' }): Promise<ReclaimResult> {
    const scanId = randomUUID();
    const result: ReclaimResult = { scanId, removed: [], kept: [], branchesDeleted: [], branchesRetained: [], audited: 0 };
    const policy = await this.policy();
    const known = await this.rows();
    const repos = [...new Set(input.repos ?? [this.options.opsRepo, ...known.map(r => r.repo)])];
    const routine = input.trigger === 'sweep' && !input.dryRun;
    const header = () => this.audit({
      scanId, repo: '*', path: '*', event: 'orphan_scan', trigger: input.trigger,
      decision: input.dryRun ? 'dry-run' : (policy.enabled ? 'scan' : 'disabled'),
      result: 'success', reason: `repos=${repos.length};graceMs=${policy.orphanGraceMs}`,
    });
    // A routine sweep that changes nothing leaves no trace; its header is written once it records something.
    if (!routine) { await header(); result.audited++; }

    for (const repoPath of repos) {
      try {
        await this.locked(repoPath, async (repo, list) => {
          await this.reconcile(repo, list);
          const rows = await this.rows(repo);
          const refs = await this.refs(repo);
          for (const row of rows) {
            if (input.treeId && String(row.id.id) !== input.treeId) continue;
            const tree = list.find(t => t.path === row.path);
            const live = refs.filter(r => String(r.tree.id) === String(row.id.id));
            const active = live.filter(r => refState(r) === 'active');
            const recovery = live.filter(r => refState(r) === 'recovery');
            if (!active.length && !recovery.length && live.length) {
              const latest = live.map(r => this.asDate(r.at)).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
              if (await this.markReleased(row.id, latest)) {
                row.last_released_at = latest ?? new Date();
                await this.audit({
                  scanId, repo, path: row.path, tree: row.id, event: 'release', trigger: input.trigger,
                  ownership: { mode: row.mode, refs: live.length }, decision: 'release', result: 'success',
                  reason: 'all-references-released', task: live.find(r => r.task)?.task,
                });
                result.audited++;
              }
            }
            const dirty = !!(tree && meaningfulChanges(await git(row.path, ['status', '--porcelain']).catch(() => 'unavailable')));
            const status: WorktreeView['status'] = !tree ? 'missing' : tree.branch !== row.branch ? 'drift' : 'present';
            // Re-read refs inside the lock immediately before any delete decision.
            const freshRefs = (await this.refs(repo)).filter(r => String(r.tree.id) === String(row.id.id));
            // A row whose tree is gone, whose task ended (refs released) and whose branch no open
            // task needs is pure litter: drop it instead of keeping a permanent "missing" alert.
            // Exclusive task trees only — shared/protected rows stay so a human can explain them.
            const anyLiveRef = freshRefs.some(r => refState(r) !== 'released');
            if (status === 'missing' && row.mode === 'exclusive' && !anyLiveRef && !(await this.branchStillNeeded(row.branch))) {
              if (input.dryRun || !policy.enabled) {
                result.kept.push({ path: row.path, reason: input.dryRun ? 'dry-run:stale-row' : 'reclaim-disabled' });
                await this.audit({
                  scanId, repo, path: row.path, tree: row.id, event: input.dryRun ? 'dry_run' : 'skip',
                  trigger: input.trigger, ownership: { mode: row.mode }, decision: 'skip', result: 'skipped',
                  reason: 'stale-row',
                });
                result.audited++;
                continue;
              }
              await this.db.query(`BEGIN;
                DELETE worktree_ref WHERE tree = $tree;
                DELETE worktree_session_ref WHERE tree = $tree;
                DELETE ONLY $tree;
                COMMIT;`, { tree: row.id });
              (result.dropped ??= []).push(row.path);
              await this.audit({
                scanId, repo, path: row.path, tree: row.id, event: 'drop_stale_row', trigger: input.trigger,
                ownership: { mode: row.mode }, decision: 'delete', result: 'success',
                reason: 'tree-missing-released-refs',
              });
              result.audited++;
              continue;
            }
            const decision = decideReclaim({
              path: row.path, branch: row.branch, mode: row.mode, protection: row.protection, main: tree?.main,
              status, dirty,
              effectiveRefs: freshRefs.filter(r => refState(r) === 'active').length,
              recoveryRefs: freshRefs.filter(r => refState(r) === 'recovery').length,
                    createdAt: this.asDate(row.created_at), lastUsedAt: this.asDate(row.last_used_at),
              lastReleasedAt: this.asDate(row.last_released_at),
            }, policy);

            if (decision.action !== 'delete') {
              const reason = decision.reasons.join(',');
              result.kept.push({ path: row.path, reason });
              if (!input.dryRun) {
                // Abnormal retention (dirty/drift/missing/prior failures) becomes a durable follow-up;
                // expected retention (refs, grace, protection) clears any stale todo.
                const todo = /dirty|drift|missing|fail|unmerged/i.test(reason) ? reason.slice(0, 200) : undefined;
                if ((row.cleanup_todo ?? undefined) !== todo) {
                  await this.db.query('UPDATE ONLY $tree SET cleanup_todo = $todo;', { tree: row.id, todo });
                  row.cleanup_todo = todo;
                }
              }
              const key = String(row.id.id);
              if (routine && this.retained.get(key) === reason) continue;
              if (routine) this.retained.set(key, reason);
              await this.audit({
                scanId, repo, path: row.path, tree: row.id, event: input.dryRun ? 'dry_run' : 'skip',
                trigger: input.trigger, ownership: { mode: row.mode, refs: freshRefs.length },
                decision: decision.action, result: 'skipped', reason,
              });
              result.audited++;
              continue;
            }

            if (input.dryRun || !policy.enabled) {
              result.kept.push({ path: row.path, reason: input.dryRun ? `dry-run:${decision.reasons.join(',')}` : 'reclaim-disabled' });
              await this.audit({
                scanId, repo, path: row.path, tree: row.id, event: 'dry_run', trigger: input.trigger,
                ownership: { mode: row.mode }, decision: 'delete', result: 'skipped',
                reason: decision.reasons.join(','),
              });
              result.audited++;
              continue;
            }

            // Three layers die at this one transaction point: Paseo workspaces → project → git tree.
            // A scene failure keeps the git tree and its row so the next event point or sweep retries.
            if (this.options.sceneCleaner) {
              try {
                const scene = (await this.options.sceneCleaner(row.path)) ?? {};
                await this.audit({
                  scanId, repo, path: row.path, tree: row.id, event: 'scene_release', trigger: input.trigger,
                  ownership: { mode: row.mode }, decision: 'delete', result: 'success',
                  reason: `paseo-workspaces-archived:${scene.workspacesArchived ?? 0};paseo-projects-deleted:${scene.projectsDeleted ?? 0};employees-retired:${scene.employeesRetired ?? 0}`,
                });
                result.audited++;
              } catch (error) {
                const reason = `scene-cleanup-failed:${(error instanceof Error ? error.message : String(error)).slice(0, 180)}`;
                result.kept.push({ path: row.path, reason });
                await this.db.query('UPDATE ONLY $tree SET cleanup_todo = $todo;', { tree: row.id, todo: reason.slice(0, 200) });
                row.cleanup_todo = reason.slice(0, 200);
                await this.audit({
                  scanId, repo, path: row.path, tree: row.id, event: 'fail', trigger: input.trigger,
                  ownership: { mode: row.mode }, decision: 'delete', result: 'failed', reason,
                });
                result.audited++;
                continue;
              }
            }

            const removed = await this.removeTree(repo, row.path);
            if (!removed.ok) {
              const reason = removed.reason ?? 'git-remove-failed';
              result.kept.push({ path: row.path, reason });
              await this.db.query('UPDATE ONLY $tree SET cleanup_todo = $todo;', { tree: row.id, todo: `git-remove-failed:${reason}`.slice(0, 200) });
              row.cleanup_todo = `git-remove-failed:${reason}`.slice(0, 200);
              await this.audit({
                scanId, repo, path: row.path, tree: row.id, event: 'fail', trigger: input.trigger,
                ownership: { mode: row.mode }, decision: 'delete', result: 'failed',
                reason: removed.reason ?? 'git-remove-failed',
              });
              result.audited++;
              continue;
            }

            result.removed.push(row.path);
            const branch = row.branch;
            const mode = row.mode;
            await this.db.query(`BEGIN;
              DELETE worktree_ref WHERE tree = $tree;
              DELETE worktree_session_ref WHERE tree = $tree;
              DELETE ONLY $tree;
              COMMIT;`, { tree: row.id });
            await this.audit({
              scanId, repo, path: row.path, tree: row.id, event: 'delete', trigger: input.trigger,
              ownership: { mode }, decision: 'delete', result: 'success',
              reason: decision.reasons.join(','),
            });
            result.audited++;

            if (branch && mode === 'exclusive') {
              if (await this.branchStillNeeded(branch)) {
                result.branchesRetained.push({ branch, reason: 'non-terminal-task-still-references-branch' });
                await this.audit({
                  scanId, repo, path: row.path, event: 'branch_retain', trigger: input.trigger,
                  decision: 'retain_branch', result: 'skipped', reason: 'non-terminal-task-still-references-branch',
                });
                result.audited++;
              } else {
                const del = await this.deleteMergedBranch(repo, branch);
                if (del.deleted) {
                  result.branchesDeleted.push(branch);
                } else {
                  result.branchesRetained.push({ branch, reason: del.reason ?? 'unmerged-or-checked-out' });
                  await this.audit({
                    scanId, repo, path: row.path, event: 'branch_retain', trigger: input.trigger,
                    decision: 'retain_branch', result: 'skipped', reason: del.reason ?? 'unmerged-or-checked-out',
                  });
                  result.audited++;
                }
              }
            }
          }
          const parent = hostIO().path.dirname(repo);
          if (result.removed.some(p => hostIO().path.dirname(p) === parent || p.startsWith(parent))) {
            await git(repo, ['worktree', 'prune']).catch(() => undefined);
          }
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
        result.kept.push({ path: repoPath, reason: `repo-lock-or-scan-failed:${reason}` });
        await this.audit({
          scanId, repo: repoPath, path: repoPath, event: 'fail', trigger: input.trigger,
          decision: 'scan', result: 'failed', reason,
        });
        result.audited++;
      }
    }
    if (routine && result.audited) await header().catch(() => undefined);
    return result;
  }

  /** Single-tree reclaim at a reference-release event point; resolves the tree's repo itself. */
  async reclaimEvent(treeId: string | undefined, trigger: ReclaimTrigger): Promise<ReclaimResult | undefined> {
    if (!treeId) return undefined;
    const row = await this.db.select<{ repo?: string }>(record('worktree', treeId)).catch(() => undefined);
    return this.reclaimAll({ trigger, treeId, repos: [row?.repo ?? this.options.opsRepo] });
  }

  /** Event-triggered reclaim for a task that just reached a terminal done state. */
  async reclaimAfterTerminal(task: TaskView, trigger: ReclaimTrigger = 'accept'): Promise<ReclaimResult | undefined> {
    if (!task.worktree || task.state !== 'done') return undefined;
    return this.reclaimEvent(task.worktree.id, trigger);
  }

  async listAudits(limit = 100): Promise<Array<Record<string, unknown>>> {
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      'SELECT * FROM worktree_audit ORDER BY at DESC LIMIT $limit;', { limit });
    return rows ?? [];
  }
}
