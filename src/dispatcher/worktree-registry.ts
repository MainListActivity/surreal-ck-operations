import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { RecordId } from 'surrealdb';
import type { Surreal } from 'surrealdb';
import type { Principal, ProjectView, TaskView, WorkIntent, WorktreeAssignment, WorktreeView } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const record = (table: string, key: string) => new RecordId(table, key);
export const worktreeId = (repo: string, path: string) => hash(`${repo}\0${path}`);
export interface RegistryOptions { opsRepo: string; strategy?: 'shared' | 'legacy' }
interface Tree { path: string; branch?: string; main: boolean }
interface Row { id: RecordId; repo: string; project?: string; path: string; mode: WorktreeAssignment['mode'];
  branch?: string; protection?: string; created_at: unknown; last_used_at: unknown }
interface Ref { task?: RecordId; session_active?: boolean; employee: string; delivery: string; fence: number; intent: WorkIntent;
  at: unknown; tree: RecordId; current?: string; current_delivery?: string; task_state?: string;
  assigned_tree?: string; handover?: boolean; resume_state?: string }

/** No shell, no credential files, and bounded git processes. */
async function git(repo: string, args: string[]): Promise<string> {
  return new Promise((resolveOut, reject) => {
    const child = spawn('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolveOut(out.trimEnd()) : reject(new CompanyError('conflict', `git worktree operation failed: ${err.slice(0, 300)}`)); });
  });
}
async function trees(repo: string): Promise<Tree[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  return out.split('\n\n').filter(Boolean).map((block, i) => {
    const lines = block.split('\n');
    const path = lines.find(l => l.startsWith('worktree '))!.slice(9);
    return { path: existsSync(path) ? realpathSync(path) : resolve(path), main: i === 0,
      branch: lines.find(l => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') };
  });
}

/** Kernel flock spans plugin + MCP processes and is released on crash/EOF, with no stale lease timeout.
 * The helper reads only its lock file. Its stdin is closed even when the caller dies.
 */
export async function withRepoLock<T>(commonDir: string, action: () => Promise<T>): Promise<T> {
  const helper = spawn('/usr/bin/python3', ['-c',
    'import fcntl,sys; f=open(sys.argv[1], "a"); fcntl.flock(f, fcntl.LOCK_EX); print("locked", flush=True); sys.stdin.buffer.read()',
    join(commonDir, 'sck-worktree-allocation.lock')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false;
  const closed = new Promise<void>(done => helper.once('close', () => { exited = true; done(); }));
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { helper.kill(); reject(new CompanyError('conflict', 'Repository allocation lock busy')); }, 35_000);
      helper.once('error', error => { clearTimeout(timer); reject(error); });
      helper.once('close', () => { clearTimeout(timer); reject(new CompanyError('conflict', 'Repository allocation lock unavailable')); });
      helper.stdout.once('data', () => { clearTimeout(timer); done(); });
    });
    if (exited) throw new CompanyError('conflict', 'Repository allocation lock lost');
    return await action();
  } finally { helper.stdin.end(); await closed; }
}

export function validateIntent(intent: WorkIntent | undefined): void {
  if (intent === undefined) return;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) || Object.keys(intent).some(k => !['kind', 'paths', 'lane'].includes(k)) ||
      (intent.paths !== undefined && !Array.isArray(intent.paths)) || (intent.lane !== undefined && typeof intent.lane !== 'string')) throw new CompanyError('invalid', 'Invalid work intent fields');
  if (!['read', 'code', 'assets'].includes(intent.kind) || (intent.lane !== undefined && !/^[a-zA-Z0-9_-]{1,60}$/.test(intent.lane))) throw new CompanyError('invalid', 'Invalid work intent');
  if (intent.kind === 'assets' && (!intent.paths?.length || intent.paths.length > 50)) throw new CompanyError('invalid', 'Asset writes require authorized relative directories');
  if (intent.kind !== 'assets' && intent.paths?.length) throw new CompanyError('invalid', 'Only assets use directory write scopes');
  for (const p of intent.paths ?? []) {
    if (typeof p !== 'string' || isAbsolute(p) || p.length > 300 || p.split('/').some(s => !s || s === '.' || s === '..' || /^(\.git|\.env.*|\.runtime|credentials|private)$/i.test(s)) || /[\\\x00-\x1f]/.test(p)) throw new CompanyError('invalid', 'Unsafe asset write directory');
  }
}
const overlap = (a: string, b: string) => {
  a = a.toLocaleLowerCase('en-US'); b = b.toLocaleLowerCase('en-US');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};
const refState = (r: Ref): 'active' | 'recovery' | 'released' => {
  if (r.session_active) return 'active';
  if (r.current === r.employee && r.current_delivery === r.delivery) return 'active';
  if (!r.current && r.intent.kind !== 'read' && (r.task_state === 'doing' || (r.task_state === 'ready' && r.handover) || (r.task_state === 'blocked' && r.resume_state === 'doing')) && r.assigned_tree === String(r.tree.id)) return 'recovery';
  return 'released';
};

export class WorktreeRegistry {
  constructor(private readonly db: Surreal, readonly options: RegistryOptions) {}
  async identity(repoPath: string) {
    const path = realpathSync(repoPath);
    const common = realpathSync(resolve(path, await git(path, ['rev-parse', '--git-common-dir'])));
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
      task.state AS task_state, task.worktree.id AS assigned_tree, task.handover AS handover,
      task.resume_state AS resume_state FROM worktree_ref WHERE $repo = NONE OR tree.repo = $repo;`, { repo });
    const [sessions] = await this.db.query<[Array<Ref & { retired?: boolean; enabled?: boolean }>]>(`SELECT *,
      holder.retired AS retired, holder.workspace_read_active AS enabled FROM worktree_session_ref WHERE $repo = NONE OR tree.repo = $repo;`, { repo });
    return [...refs, ...sessions.map(r => ({ ...r, session_active: !!r.enabled && !r.retired }))];
  }
  /** Import every git tree as protected before using any of them. Never reset legacy/unknown trees. */
  private async reconcile(repo: string, list: Tree[], project?: string) {
    const rows = await this.rows(repo);
    for (const t of list) {
      if (rows.some(r => r.path === t.path)) continue;
      const managedRead = t.path === join(dirname(repo), `${basename(repo)}-sck-${hash(repo).slice(0, 8)}-shared`) && t.branch === `sck/shared-${hash(repo).slice(0, 12)}`;
      const protection = managedRead ? undefined : t.main ? 'repository-main' : 'legacy-or-release: manual adoption required';
      await this.db.query(`CREATE ONLY $tree CONTENT { repo: $repo, project: $project, path: $path,
        branch: $branch, mode: $mode, protection: $protection, created_at: time::now(), last_used_at: time::now() };`,
        { tree: record('worktree', worktreeId(repo, t.path)), repo, project, path: t.path, branch: t.branch, protection, mode: managedRead ? 'shared' : 'protected' });
    }
  }
  async allocate(repo: string, list: Tree[], task: TaskView, actor: Principal, project?: ProjectView): Promise<WorktreeAssignment> {
    await this.reconcile(repo, list, project?.id);
    const intent: WorkIntent = task.state === 'review' ? { kind: 'read' } : task.workIntent ?? { kind: actor.role === 'engineering' && task.kind !== 'release' ? 'code' : 'read' };
    validateIntent(intent);
    const refs = await this.refs(repo);
    const live = refs.filter(r => refState(r) !== 'released' && String(r.task?.id) !== task.id);
    const rows = await this.rows(repo);
    const previous = task.worktree;
    const base = project?.defaultBranch ?? list[0]!.branch ?? 'HEAD';
    const desired = intent.kind === 'code' || (task.state === 'review' && task.executorRole === 'engineering' && task.kind === 'task') ? `task/${task.id.slice(0, 8)}` : undefined;
    const own = previous && rows.find(r => String(r.id.id) === previous.id);
    const legacy = list.find(t => t.branch === `task/${task.id.slice(0, 8)}` && !t.main);
    let chosen = own && list.find(t => t.path === own.path && (!desired || t.branch === desired)) ? own : undefined;
    // Existing task trees are adopted in place, keeping protected mode and all uncommitted work.
    if (!chosen && legacy && (intent.kind === 'code' || desired)) chosen = rows.find(r => r.path === legacy.path);
    const shared = rows.find(r => r.mode === 'shared');
    const activeOn = (r: Row) => live.filter(f => String(f.tree.id) === String(r.id.id));
    if (chosen && desired && chosen.branch !== desired) chosen = undefined;
    if (!chosen) {
      if (shared && list.some(t => t.path === shared.path) && (this.options.strategy !== 'legacy' || (!desired && intent.kind !== 'code'))) {
        const users = activeOn(shared);
        const writers = users.filter(r => r.intent.kind !== 'read');
        if (intent.kind === 'code' || desired) {
          if (!users.length && !(await git(shared.path, ['status', '--porcelain']))) chosen = shared;
        } else if (!writers.some(r => r.intent.kind === 'code')) chosen = shared;
      }
      // A shared tree with a code writer is still the default read workspace; no checkout takes place.
      if (!chosen && intent.kind === 'read' && !desired && shared && list.some(t => t.path === shared.path)) chosen = shared;
    }
    if (intent.kind === 'assets') {
      if (live.some(r => r.intent.kind === 'assets' && r.intent.paths!.some(a => intent.paths!.some(b => overlap(a, b))))) throw new CompanyError('worktree_busy', 'Authorized asset directories overlap; wait for current writer');
      if (!chosen && shared && activeOn(shared).some(r => r.intent.kind === 'code')) throw new CompanyError('worktree_busy', 'Shared repository has an active code writer; asset writes wait');
    }
    if (chosen && intent.kind === 'code' && task.currentEmployee !== actor.employeeId && activeOn(chosen).length) throw new CompanyError('worktree_busy', 'Task scene is referenced by another active delivery');
    if (!chosen) {
      const mode = (this.options.strategy === 'legacy' && (intent.kind === 'code' || desired)) || (shared && (intent.kind === 'code' || desired)) ? 'exclusive' : 'shared';
      const path = join(dirname(repo), `${basename(repo)}-sck-${hash(repo).slice(0, 8)}-${mode === 'shared' ? 'shared' : task.id.slice(0, 8)}`);
      // Do not treat an existing unregistered path as an empty target.
      if (existsSync(path)) throw new CompanyError('conflict', 'Unregistered allocation path exists; preserve it for reconciliation');
      const branch = desired ?? `sck/shared-${hash(repo).slice(0, 12)}`;
      let branchExists = false;
      try { await git(repo, ['show-ref', '--verify', `refs/heads/${branch}`]); branchExists = true; } catch {}
      await git(repo, ['worktree', 'add', ...(branchExists ? [] : ['-b', branch]), path, branchExists ? branch : base]);
      const canonical = realpathSync(path);
      chosen = { id: record('worktree', worktreeId(repo, canonical)), repo, project: project?.id, path: canonical, branch, mode, created_at: new Date(), last_used_at: new Date() };
      // Persist the physical tree before the task claim. On failure it has no effective reference.
      await this.db.query(`UPSERT ONLY $tree CONTENT { repo: $repo, project: $project, path: $path,
        branch: $branch, mode: $mode, created_at: time::now(), last_used_at: time::now() };`,
        { tree: chosen.id, repo, project: project?.id, path: canonical, branch, mode });
    } else if (desired && chosen.branch !== desired) {
      const before = await git(chosen.path, ['symbolic-ref', '--short', 'HEAD']).catch(() => undefined);
      if (before !== chosen.branch) throw new CompanyError('conflict', 'Registered branch drift; preserve scene');
      const status = await git(repo, ['-C', chosen.path, 'status', '--porcelain']);
      if (status) throw new CompanyError('worktree_busy', 'Shared scene contains uncommitted/untracked work; preserve before reuse');
      let exists = false;
      try { await git(repo, ['show-ref', '--verify', `refs/heads/${desired}`]); exists = true; } catch {}
      await git(chosen.path, ['checkout', ...(exists ? [desired] : ['-b', desired, base])]);
      chosen.branch = desired;
      await this.db.query('UPDATE ONLY $tree SET branch = $branch;', { tree: chosen.id, branch: desired });
    }
    // Refuse branch drift (manual checkout) instead of silently restoring/resetting the tree.
    const actualBranch = await git(chosen.path, ['symbolic-ref', '--short', 'HEAD']).catch(() => undefined);
    if (actualBranch !== chosen.branch) throw new CompanyError('conflict', 'Registered branch differs from git; manual reconciliation required');
    for (const p of intent.paths ?? []) {
      let candidate = join(chosen.path, p);
      while (!existsSync(candidate)) candidate = dirname(candidate);
      const resolved = realpathSync(candidate);
      if (resolved !== candidate || (resolved !== chosen.path && !resolved.startsWith(chosen.path + sep))) throw new CompanyError('invalid', 'Asset directory escapes worktree through symlink');
    }
    return { id: String(chosen.id.id), repo, project: project?.id, worktreePath: chosen.path, branch: chosen.branch,
      mode: chosen.mode, intent,
      discipline: intent.kind === 'code' ? '仅在本任务分支 commit/push；禁止 checkout/reset/pull；禁止凭证读取；附件写 evidenceDir。'
        : intent.kind === 'assets' ? '仅写授权目录；不得 checkout/reset/pull 或 commit/push；附件写 evidenceDir。'
          : '只读代码；不得 checkout/reset/pull、commit/push 或写资产；附件写 evidenceDir。' };
  }
  async readWorkspace(repoPath: string, actor: Principal): Promise<WorktreeAssignment> {
    return this.locked(repoPath, async (repo, list) => {
      const task: TaskView = { id: `session-${actor.employeeId}`, title: 'Read workspace', context: '', state: 'ready',
        executorRole: actor.role, reviewerRole: 'qa', kind: 'task', dependencies: [], version: 0, fence: 0, workIntent: { kind: 'read' } };
      const assignment = await this.allocate(repo, list, task, actor);
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
  }
  async inventory(repo?: string): Promise<WorktreeView[]> {
    const rows = await this.rows(repo), refs = await this.refs(repo);
    const cache = new Map<string, Tree[]>();
    const result: WorktreeView[] = [];
    for (const row of rows) {
      if (!cache.has(row.repo)) cache.set(row.repo, await trees(row.repo).catch(() => []));
      const tree = cache.get(row.repo)!.find(t => t.path === row.path);
      const references = refs.filter(r => String(r.tree.id) === String(row.id.id)).map(r => ({ taskId: r.task ? String(r.task.id) : `session:${r.employee}`, employee: r.employee,
        deliveryId: r.delivery, fence: r.fence, intent: r.intent, state: refState(r), at: String(r.at) }));
      const reasons = ['WT01: deletion disabled', ...(row.protection ? [row.protection] : [])];
      if (references.some(r => r.state === 'active')) reasons.push('active-reference');
      if (references.some(r => r.state === 'recovery')) reasons.push('unfinished-scene');
      if (tree && await git(row.path, ['status', '--porcelain']).catch(() => 'unavailable')) reasons.push('dirty-or-unavailable');
      const status = !tree ? 'missing' : tree.branch !== row.branch ? 'drift' : 'present';
      if (status !== 'present') reasons.push(status);
      result.push({ id: String(row.id.id), repo: row.repo, project: row.project, worktreePath: row.path, branch: row.branch, mode: row.mode,
        createdAt: String(row.created_at), lastUsedAt: String(row.last_used_at), status, references, deletable: false, reasons });
    }
    return result;
  }
}
