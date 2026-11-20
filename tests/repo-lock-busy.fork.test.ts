import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { Workforce } from '../src/workforce.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { BLOCK_TEXT, dispatchNoticeText } from '../src/dispatcher/dispatch-blocked.ts';
import { PaseoCliError, type PaseoGateway } from '../src/dispatcher/paseo.ts';
import { repoLockLogLine, type RepoLockEvent } from '../src/dispatcher/worktree-registry.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';

// A busy repository allocation lock is a queue on the host, not a failed employee or provider. Runs on a real company fork with a
// real git repository. Every outcome is read back from the database: task, audit, dispatch, employee, def and owner notice rows.
const run = process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1' ? test : test.skip;
const ROOT_PASSWORD = 'isolated-repo-lock-test-only';
/** Short enough that a held lock becomes a busy attempt inside a test. The host default is 35 seconds. */
const LOCK_WAIT_MS = 200;

interface TaskFact { state: string; version: number; current_employee?: unknown; dispatch_blocked_phase?: string | null; dispatch_blocked_since?: number | null }
interface AuditFact { action: string }
interface NoticeFact { key: string; text: string; resolved_at?: unknown }

function gitRepo(path: string): string {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', path, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode) throw new Error(result.stderr.toString());
  };
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', path]);
  writeFileSync(join(path, 'source.txt'), 'baseline');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline');
  return path;
}

async function startFork(name: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `repo-lock-fork-${name}-`)));
  const repo = gitRepo(join(dir, 'ops'));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD, '--log', 'error', `surrealkv:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  // SurrealDB reads a hyphen in a bare identifier as subtraction, so the namespace uses underscores only.
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: ROOT_PASSWORD, namespace: `isolated_repo_lock_${name.replaceAll('-', '_')}`, database: 'control_plane' });
  let pool: SidecarPool | undefined;
  const agentRows = new Map<string, { id: string; status: string }>();
  // Every attempt at the repository lock, as the host timed it.
  const lockEvents: RepoLockEvent[] = [];
  // Set by a test to make the next session start fail the way a plugin refusal does.
  let spawnError: Error | undefined;
  const close = async () => {
    for (const id of agentRows.keys()) pool?.detachAgent(id);
    pool?.close();
    await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true });
  };
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true);
    await db.connect(); await db.bootstrap();
    const core = new SurrealCompanyCore(db, { worktrees: { opsRepo: repo, lockAcquireMs: LOCK_WAIT_MS, onRepoLock: event => { lockEvents.push(event); } } });
    const owner = new OwnerDesk(db);
    const gm = await new LocalEnrollmentAdmin(db).enroll('fixture-manager', 'owner', ['execute', 'review', 'manage']);
    await db.db.upsert(new RecordId('company_meta', 'config')).content({ jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
    const wf = new Workforce(db);
    // The original query stays reachable for every assertion below, even when a test wraps db.db.query.
    const rawQuery = db.db.query.bind(db.db) as unknown as typeof db.db.query;
    const ops = { tools: ['ops_info'], call: async () => ({ available: true }), release: () => {} };
    pool = new SidecarPool({ core, workforce: wf as unknown as SidecarDeps['workforce'], ops, runDir: join(dir, 'comm'), sweepMs: 5 });
    const paseo: PaseoGateway = {
      list: async () => new Map([...agentRows]),
      status: async id => !agentRows.has(id) ? undefined : { status: agentRows.get(id)!.status, pendingPermissions: 0 },
      lastError: async () => '', logsTail: async () => 'isolated synthetic transcript', lastInputTokens: async () => 0,
      spawn: async b => {
        if (spawnError) throw spawnError;
        const id = `agent-${b.labels.employee_id}`; agentRows.set(id, { id, status: 'running' }); return id;
      },
      send: async id => { agentRows.get(id)!.status = 'running'; }, stop: async id => { agentRows.get(id)!.status = 'idle'; },
      reload: async id => { agentRows.get(id)!.status = 'idle'; },
      archive: async id => { agentRows.get(id)!.status = 'archived'; pool?.detachAgent(id); },
      listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {} };
    // Every dispatcher is built on the same database; a new one is a process restart with no memory kept.
    const newDispatcher = () => new Dispatcher({ workforce: wf, owner, paseo, sidecar: pool!, rand: () => 0,
      env: { opsRepo: repo, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' } });
    // Provider cooldowns are counted here, so a lock wait that cooled a provider would show up.
    const exhausted: string[] = [];
    const markExhausted = wf.markExhausted.bind(wf);
    wf.markExhausted = (provider, error, resetsAt) => { exhausted.push(provider); return markExhausted(provider, error, resetsAt); };
    const taskRow = async (taskId: string) => (await rawQuery<[TaskFact]>('SELECT state, version, current_employee, dispatch_blocked_phase, dispatch_blocked_since FROM ONLY $t;',
      { t: new RecordId('task', taskId) }))[0] as TaskFact;
    const auditRows = async (taskId: string) => ((await rawQuery<[AuditFact[]]>(
      'SELECT id, action, at FROM audit WHERE task = $t ORDER BY at ASC, id ASC;', { t: new RecordId('task', taskId) }))[0] ?? []);
    const noticeRows = async (prefix: string) => ((await rawQuery<[NoticeFact[]]>(
      'SELECT key, text, resolved_at FROM owner_notice WHERE string::starts_with(key, $prefix) ORDER BY key;', { prefix }))[0] ?? []);
    const dispatchRows = async (taskId: string) => ((await rawQuery<[unknown[]]>('SELECT purpose, employee FROM dispatch WHERE task = $t;', { t: taskId }))[0] ?? []);
    const retiredRows = async () => ((await rawQuery<[Array<{ id: unknown; retired_kind?: string | null; retired_reason?: string | null }>]>(
      'SELECT id, retired_kind, retired_reason FROM employee WHERE retired = true ORDER BY id;'))[0] ?? [])
      .map(({ retired_kind, retired_reason }) => ({ retired_kind, retired_reason }));
    const errorStreak = async (defId: string) => (await wf.allDefs()).find(def => def.id === defId)?.errorStreak;
    const verdictOf = (dispatcher: Dispatcher, taskId: string) => dispatcher.dispatchVerdicts().find(v => v.taskId === taskId && v.phase === 'execute');
    return {
      repo, pool: pool!, core, owner, wf, gm, exhausted, lockEvents, agentRows, rawQuery, taskRow, auditRows, noticeRows, dispatchRows,
      retiredRows, errorStreak, verdictOf, newDispatcher, setSpawnError: (error?: Error) => { spawnError = error; }, close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const claimsOf = (rows: AuditFact[]) => rows.filter(row => row.action === 'claim');

run('a busy repository lock queues the task as repo_lock_busy: no failure is counted, no provider cools down, and the next free pass dispatches once', async () => {
  const w = await startFork('busy-then-free');
  // Replaced by the executor below; the default keeps the cleanup safe when the test fails before the lock is taken.
  let inside: () => void = () => {};
  let leave: () => void = () => {};
  try {
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'repo lock busy', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'owner',
      workIntent: { kind: 'code' }, idempotencyKey: 'repo-lock-busy-create' });
    const prefix = `dispatch-blocked:${task.id}:`;
    // Another allocation holds the repository lock until this test lets it go.
    const entered = new Promise<void>(done => { inside = done; });
    const release = new Promise<void>(done => { leave = done; });
    const holder = w.core.worktrees!.locked(w.repo, async () => { inside(); await release; }, 'inventory');
    await Promise.race([entered, holder]);

    const busy = w.newDispatcher();
    const busyReport = await busy.tick();
    expect(busyReport.woke.filter(row => row.task === task.id)).toEqual([]);
    const verdict = w.verdictOf(busy, task.id);
    expect(verdict?.reasons.map(reason => reason.code)).toEqual(['repo_lock_busy']);
    expect(verdict?.reasons[0]?.text).toBe(BLOCK_TEXT.repo_lock_busy);
    expect(verdict?.feasible).toBe(true);
    expect(verdict!.summary).toContain('仓库分配锁忙');
    expect(verdict!.summary).not.toContain(BLOCK_TEXT.wake_failed);
    expect(dispatchNoticeText(verdict!)).toContain('仓库分配锁忙');
    // The host timed the claim as queued for the whole limit and never held the lock.
    const busyClaims = w.lockEvents.filter(event => event.operation === 'claim');
    expect(busyClaims).toHaveLength(1);
    expect(busyClaims[0]).toMatchObject({ result: 'busy' });
    expect(busyClaims[0]!.repo).toMatch(/^[0-9a-f]{8}$/);
    expect(busyClaims[0]!.heldMs).toBeUndefined();
    expect(busyClaims[0]!.waitMs).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 10);
    expect(repoLockLogLine(busyClaims[0]!)).toMatch(/^repo lock claim [0-9a-f]{8} busy wait=\d+ms$/);

    // The attempt is not a failure: the task stays ready and unleased, nothing is dispatched, and no failure is counted.
    const row = await w.taskRow(task.id);
    expect(row.state).toBe('ready');
    expect(row.current_employee ?? null).toBeNull();
    expect(row.dispatch_blocked_phase).toBe('execute');
    expect(typeof row.dispatch_blocked_since).toBe('number');
    const since = row.dispatch_blocked_since;
    expect(claimsOf(await w.auditRows(task.id))).toEqual([]);
    expect(await w.dispatchRows(task.id)).toEqual([]);
    expect(await w.wf.insts()).toEqual([]);
    expect(await w.errorStreak('fixture-eng')).toBe(0);
    expect(w.exhausted).toEqual([]);
    // The unbound seat of the attempt is retired as a normal rotation, never as a failure.
    expect(await w.retiredRows()).toEqual([{ retired_kind: 'rotation', retired_reason: '仓库分配锁忙，未开会话，下一轮重新分配' }]);
    // Like other queued work, the owner is asked only after five minutes of waiting.
    expect((await w.owner.openNotices()).filter(n => n.key.startsWith(prefix))).toEqual([]);

    // A second busy pass keeps the first wait time and still counts nothing.
    const again = w.newDispatcher();
    expect((await again.tick()).woke.filter(row => row.task === task.id)).toEqual([]);
    expect((await w.taskRow(task.id)).dispatch_blocked_since).toBe(since);
    expect(w.verdictOf(again, task.id)?.reasons.map(reason => reason.code)).toEqual(['repo_lock_busy']);
    expect(await w.errorStreak('fixture-eng')).toBe(0);
    expect(w.exhausted).toEqual([]);

    // Five minutes of waiting: the owner is told the real reason, and the start of the wait is kept.
    await w.rawQuery('UPDATE $t SET dispatch_blocked_since = time::unix(time::now()) - 400;', { t: new RecordId('task', task.id) });
    const aged = w.newDispatcher();
    const agedReport = await aged.tick();
    expect(agedReport.notices).toContain(`${prefix}execute`);
    const [notice] = (await w.noticeRows(prefix)).filter(n => n.key === `${prefix}execute`);
    expect(notice?.text).toContain('仓库分配锁忙');
    expect(notice?.text).not.toContain(BLOCK_TEXT.wake_failed);
    expect(notice?.text).toContain(`自 ${w.verdictOf(aged, task.id)!.since} 起等待`);
    expect(notice?.resolved_at).toBeFalsy();

    // The lock is free again: one pass dispatches the task, the owner notice closes, and later passes do not dispatch it again.
    leave();
    await holder;
    const freed = await w.newDispatcher().tick();
    expect(freed.woke.filter(x => x.task === task.id).map(x => x.spawned)).toEqual([true]);
    expect(await w.dispatchRows(task.id)).toHaveLength(1);
    expect(claimsOf(await w.auditRows(task.id))).toHaveLength(1);
    expect(w.lockEvents.filter(event => event.operation === 'claim' && event.result === 'ok')).toEqual([expect.objectContaining({ repo: busyClaims[0]!.repo })]);
    expect((await w.taskRow(task.id)).dispatch_blocked_phase ?? null).toBeNull();
    const [closed] = (await w.noticeRows(prefix)).filter(n => n.key === `${prefix}execute`);
    expect(closed?.resolved_at).toBeTruthy();
    expect((await w.newDispatcher().tick()).woke.filter(x => x.task === task.id)).toEqual([]);
    expect(await w.dispatchRows(task.id)).toHaveLength(1);
    expect(claimsOf(await w.auditRows(task.id))).toHaveLength(1);
    expect(await w.errorStreak('fixture-eng')).toBe(0);
    expect(w.exhausted).toEqual([]);
  } finally {
    leave();
    await w.close();
  }
}, 120000);

run('a bound employee whose claim waits on the repository lock is kept and woken again once the lock is free', async () => {
  const w = await startFork('bound-employee');
  let inside: () => void = () => {};
  let leave: () => void = () => {};
  try {
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'bound employee waits', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'owner',
      workIntent: { kind: 'code' }, idempotencyKey: 'bound-employee-create' });
    const first = await w.newDispatcher().tick();
    expect(first.woke.filter(x => x.task === task.id).map(x => x.spawned)).toEqual([true]);
    const [employee] = await w.wf.insts();
    // The session went idle and its lease ran out: the task is ready again for the same, still bound employee.
    w.agentRows.get(employee!.paseoAgentId!)!.status = 'idle';
    await w.rawQuery('UPDATE $t SET lease_expires_at = time::unix(time::now()) - 1;', { t: new RecordId('task', task.id) });
    const entered = new Promise<void>(done => { inside = done; });
    const release = new Promise<void>(done => { leave = done; });
    const holder = w.core.worktrees!.locked(w.repo, async () => { inside(); await release; }, 'inventory');
    await Promise.race([entered, holder]);

    const busy = w.newDispatcher();
    const busyReport = await busy.tick();
    expect(busyReport.woke.filter(x => x.task === task.id)).toEqual([]);
    expect(w.verdictOf(busy, task.id)?.reasons.map(reason => reason.code)).toEqual(['repo_lock_busy']);
    // The seat is kept: a lock wait is not a session failure, so nothing is retired and no definition is charged.
    expect((await w.wf.insts()).map(i => i.id)).toEqual([employee!.id]);
    expect(await w.retiredRows()).toEqual([]);
    expect(await w.errorStreak('fixture-eng')).toBe(0);
    expect(w.exhausted).toEqual([]);

    leave();
    await holder;
    const freed = await w.newDispatcher().tick();
    expect(freed.woke.filter(x => x.task === task.id)).toEqual([{ task: task.id, employee: employee!.id, spawned: false }]);
    expect(await w.dispatchRows(task.id)).toHaveLength(2);
    expect(claimsOf(await w.auditRows(task.id))).toHaveLength(2);
    expect((await w.newDispatcher().tick()).woke.filter(x => x.task === task.id)).toEqual([]);
    expect(await w.dispatchRows(task.id)).toHaveLength(2);
    expect(await w.errorStreak('fixture-eng')).toBe(0);
  } finally {
    leave();
    await w.close();
  }
}, 120000);

run('a real employee wake refusal stays wake_failed and counts as a definition failure, not as a lock wait', async () => {
  const w = await startFork('wake-refused');
  try {
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'wake refused', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'owner',
      workIntent: { kind: 'code' }, idempotencyKey: 'wake-refused-create' });
    // The plugin refuses the session before it exists: the same shape isOpenRefused recognises in production.
    w.setSpawnError(new PaseoCliError('paseo run failed', JSON.stringify({ error: { code: 'AGENT_CREATE_FAILED',
      message: 'Plugin sck-company agent.open.before failed: synthetic refusal for the regression test' } }), false));
    const dispatcher = w.newDispatcher();
    const report = await dispatcher.tick();
    expect(report.woke.filter(row => row.task === task.id)).toEqual([]);
    const verdict = w.verdictOf(dispatcher, task.id);
    expect(verdict?.reasons.map(reason => reason.code)).toEqual(['wake_failed']);
    expect(verdict!.summary).not.toContain('仓库分配锁忙');
    expect(await w.errorStreak('fixture-eng')).toBe(1);
    expect(await w.retiredRows()).toEqual([{ retired_kind: 'failure', retired_reason: expect.stringContaining('spawn failed') }]);
    expect(w.exhausted).toEqual([]);
    expect(await w.dispatchRows(task.id)).toEqual([]);
    expect((await w.taskRow(task.id)).current_employee ?? null).toBeNull();
  } finally {
    await w.close();
  }
}, 120000);
