import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { asId, SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { ProjectStore } from '../src/projects.ts';
import { Workforce } from '../src/workforce.ts';
import type { ClaimResult, LeaseProof } from '../src/contracts.ts';

setDefaultTimeout(60000);
// Isolated local control-plane: spawns the company SurrealDB fork (~/.surrealdb/surreal) on a
// private RocksDB store plus throwaway git repos. No production data, no credentials, no dispatcher.
const run = process.env.RUN_SCK_TASK_PROJECT_TESTS === '1' ? test : test.skip;
let dir: string, port: number, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase;
let gm: string, eng: string, eng2: string, eng3: string, eng4: string, eng5: string, eng6: string, eng7: string, eng8: string, product: string, count = 0;
let repoOps: string, repoMlc: string, repoAnime: string;

const config = () => ({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'task_project_fixture', database: 'control_plane' });

beforeAll(async () => {
  if (process.env.RUN_SCK_TASK_PROJECT_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-task-project-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root',
    '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase(config());
  await db.connect(); await db.bootstrap();

  const git = (repo: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const repo = (name: string) => {
    const path = join(dir, name);
    Bun.spawnSync(['git', 'init', '-q', '-b', 'main', path]);
    writeFileSync(join(path, 'README.md'), 'fixture baseline');
    git(path, 'add', '.');
    git(path, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline');
    return path;
  };
  repoOps = repo('operations');
  repoMlc = repo('maplayer-content');
  repoAnime = repo('anime-repo');

  const enrollment = new LocalEnrollmentAdmin(db);
  gm = await enrollment.enroll('tp-gm', 'owner', ['execute', 'review', 'manage']);
  eng = await enrollment.enroll('tp-eng', 'engineering', ['execute', 'review']);
  eng2 = await enrollment.enroll('tp-eng2', 'engineering', ['execute', 'review']);
  eng3 = await enrollment.enroll('tp-eng3', 'engineering', ['execute', 'review']);
  eng4 = await enrollment.enroll('tp-eng4', 'engineering', ['execute', 'review']);
  eng5 = await enrollment.enroll('tp-eng5', 'engineering', ['execute', 'review']);
  eng6 = await enrollment.enroll('tp-eng6', 'engineering', ['execute', 'review']);
  eng7 = await enrollment.enroll('tp-eng7', 'engineering', ['execute', 'review']);
  eng8 = await enrollment.enroll('tp-eng8', 'engineering', ['execute', 'review']);
  product = await enrollment.enroll('tp-product', 'product', ['execute', 'review', 'manage']);

  const projects = new ProjectStore(db.db);
  await projects.upsert({ id: 'maplayer-content', name: 'MapLayer 内容仓', repoPath: repoMlc, release: '合入 main 后 CI 自动发布', rollback: '重发上一提交', redLines: [], envs: [] });
  await projects.upsert({ id: 'anime', name: '动漫产线', repoPath: repoAnime, release: 'manual', envs: [] });
}, 30000);

afterAll(async () => {
  if (!dir) return;
  await db.close(); server.kill(); await server.exited;
  rmSync(dir, { recursive: true, force: true });
});

const core = () => new SurrealCompanyCore(db, { worktrees: { opsRepo: repoOps } });
const workforce = () => new Workforce(db, join(dir, 'unused-creds'));

let c = 0;
const key = () => `tp-${++c}-${crypto.randomUUID().slice(0, 8)}`;
const proof = (claim: ClaimResult): LeaseProof =>
  ({ taskId: claim.task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version });

/** 无 project 目标：任务仅挂 goal，无单任务覆盖。 */
async function taskOnNoProjectGoal(core: SurrealCompanyCore) {
  const [grows] = await db.db.query<[Array<{ id: RecordId }>]>("CREATE goal CONTENT { title: '跨仓库交付解堵', brief: 'fixture', state: 'active', source: 'fixture', note: '', tasks: {}, anchors: [], created_at: time::now() } RETURN AFTER;");
  return core.createTask(gm, { title: `受控改绑 fixture ${++count}`, context: 'Isolated fixture task for project rebinding tests', executorRole: 'engineering', reviewerRole: 'engineering', goalId: asId(grows[0]!.id), idempotencyKey: key() });
}
/** goal 本身挂 anime 项目：用于「单任务覆盖不影响同目标其它任务」。 */
async function animeGoal() {
  const [grows] = await db.db.query<[Array<{ id: RecordId }>]>("CREATE goal CONTENT { title: 'anime 目标', brief: 'fixture', state: 'active', source: 'fixture', note: '', project: project:anime, tasks: {}, anchors: [], created_at: time::now() } RETURN AFTER;");
  return asId(grows[0]!.id);
}
async function taskOnGoal(core: SurrealCompanyCore, goalId: string) {
  return core.createTask(gm, { title: `anime 目标内任务 ${++count}`, context: 'Isolated fixture task under a project-carrying goal', executorRole: 'engineering', reviewerRole: 'engineering', goalId, idempotencyKey: key() });
}
const blockByGm = async (core: SurrealCompanyCore, taskId: string, worker = eng) => {
  const claim = await core.claim(worker, taskId);
  const checkpointed = await core.checkpoint(worker, proof(claim), { text: 'fixture progress before blocking for rebind', idempotencyKey: key() });
  const current = { taskId, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: checkpointed.version };
  return core.block(worker, current, 'owner', { text: 'fixture: 工作区错配阻塞，等待经理改绑', idempotencyKey: key() });
};
/** 当前任务版本：负例断言 forbidden 的前提是先过版本门禁。 */
const versionOf = async (core: SurrealCompanyCore, taskId: string) => (await core.getTask(gm, taskId)).version;
const auditRows = async (taskId: string, action: string) => {
  const [rows] = await db.db.query<[Array<{ id: RecordId }>]>('SELECT id FROM audit WHERE task = $task AND action = $action;', { task: new RecordId('task', taskId), action });
  return rows;
};
const taskRow = async (taskId: string) => {
  const [rows] = await db.db.query<[Array<Record<string, unknown>>]>('SELECT * FROM $task;', { task: new RecordId('task', taskId) });
  return rows[0]!;
};
const overlayOf = async (taskId: string) => {
  const row = await taskRow(taskId);
  const overlay = row['project'] as RecordId | undefined;
  return overlay ? String(overlay.id) : undefined;
};
/** 直接构造 blocked+活租约的异常态（正常 block 流程会清租约；防御门禁需要该形态）。 */
const forgeActiveLease = async (taskId: string, employee: string) => {
  await db.db.query("UPDATE ONLY $task SET state = 'blocked', current_employee = $emp, delivery_id = 'forged', lease_expires_at = time::unix(time::now()) + 600;",
    { task: new RecordId('task', taskId), emp: employee });
};

run('rebind routes claim workspace, claim.json project, inventory and supervisor repoPath to maplayer-content', async () => {
  const C = core(), wf = workforce();
  const t = await taskOnNoProjectGoal(C);
  await blockByGm(C, t.id);
  expect(await overlayOf(t.id)).toBeUndefined(); // 改绑前无覆盖

  const rebound = await C.taskProjectUpdate(gm, { taskId: t.id, project: 'maplayer-content', expectedVersion: await versionOf(C, t.id), text: '经理裁定：该任务属于 maplayer-content 仓', idempotencyKey: key() });
  expect(rebound.projectOverlay).toBe('maplayer-content');
  expect(rebound.state).toBe('blocked');
  expect(rebound.worktree).toBeUndefined(); // 旧 assignment 已清

  // 改绑后经理 resume，任务按新项目路由重新进入派发。
  await C.resume(gm, t.id, { text: 'fixture resume after rebind to the target project', idempotencyKey: key() });
  const claim = await C.claim(eng, t.id);
  expect(claim.project?.id).toBe('maplayer-content'); // claim.json.project 的来源（sidecar 原样序列化 ClaimResult）
  expect(claim.worktree!.repo).toBe(repoMlc);
  expect(existsSync(claim.worktree!.worktreePath)).toBe(true);
  expect(claim.worktree!.branch).toBe(`task/${t.id.slice(0, 8)}`); // 后续合法 claim 重新分配目标仓任务分支
  // listWorktrees（core 工作区清单）按新项目仓解析。
  const inventory = await C.listWorktrees(gm, t.id);
  expect(inventory.find(w => w.references.some(r => r.taskId === t.id && r.state === 'active'))!.repo).toBe(repoMlc);
  // 监督器 repoPath（dispatcher home/名额/cwd 的单一来源）指向 maplayer-content。
  const supervised = (await wf.tasks()).find(x => x.id === t.id)!;
  expect(supervised.repoPath).toBe(repoMlc);
  // 审计落行。
  expect(await auditRows(t.id, 'task_project_update')).toHaveLength(1);
  await C.submit(eng, proof(claim), { text: 'fixture delivery after rebind to maplayer-content', idempotencyKey: key() });
});

run('without an override a no-project goal task still routes to the operations repo', async () => {
  const C = core(), wf = workforce();
  const t = await taskOnNoProjectGoal(C);
  const claim = await C.claim(eng, t.id);
  expect(claim.project).toBeUndefined();
  expect(claim.worktree!.repo).toBe(realpathSync(repoOps));
  const supervised = (await wf.tasks()).find(x => x.id === t.id)!;
  expect(supervised.repoPath).toBeUndefined(); // dispatcher 回退 opsRepo home
  await C.submit(eng, proof(claim), { text: 'fixture delivery without any project override', idempotencyKey: key() });
});

run('a per-task override does not touch sibling tasks of the same goal', async () => {
  const C = core(), wf = workforce();
  const goalId = await animeGoal();
  const first = await taskOnGoal(C, goalId);
  const second = await taskOnGoal(C, goalId);
  expect(first.goalId).toBe(goalId);
  expect(second.goalId).toBe(goalId);
  await blockByGm(C, second.id);
  const rebound = await C.taskProjectUpdate(gm, { taskId: second.id, project: 'maplayer-content', expectedVersion: 4, text: '仅该任务改绑，同目标其它任务不受影响', idempotencyKey: key() });
  expect(rebound.projectOverlay).toBe('maplayer-content');
  const [sFirst, sSecond] = await Promise.all([
    (await wf.tasks()).find(x => x.id === first.id)!,
    (await wf.tasks()).find(x => x.id === second.id)!,
  ]);
  expect(sFirst.repoPath).toBe(repoAnime); // goal 级路由保持
  expect(sSecond.repoPath).toBe(realpathSync(repoMlc));
});

run('create_delivery persists one project override across all three legs', async () => {
  const C = core();
  const [grows] = await db.db.query<[Array<{ id: RecordId }>]>("CREATE goal CONTENT { title: '三腿同项目', brief: 'fixture', state: 'active', source: 'fixture', note: '', tasks: {}, anchors: [], created_at: time::now() } RETURN AFTER;");
  const withProject = await C.createDelivery(gm, { goalId: asId(grows[0]!.id), title: '改绑能力交付', spec: '实现受控改绑工具并在测试中验证三腿同项目与负例拒绝。', project: 'maplayer-content', idempotencyKey: key() });
  expect(withProject).toHaveLength(3);
  expect(withProject.map(t => t.projectOverlay)).toEqual(['maplayer-content', 'maplayer-content', 'maplayer-content']);
  const without = await C.createDelivery(gm, { goalId: asId(grows[0]!.id), title: '默认路由交付', spec: '不带覆盖参数的交付链保持原有 goal.project 路由行为。', idempotencyKey: key() });
  expect(without.map(t => t.projectOverlay)).toEqual([undefined, undefined, undefined]);
});

run('permission, state, lease, version-race, unknown-project and idempotency negatives all reject', async () => {
  const C = core();
  // 权限：engineering 与 product（有 manage 能力但非 gm）都拒绝。
  const t = await taskOnNoProjectGoal(C);
  await blockByGm(C, t.id);
  const blockedVersion = await versionOf(C, t.id);
  await expect(C.taskProjectUpdate(eng, { taskId: t.id, project: 'maplayer-content', expectedVersion: blockedVersion, text: '工程师尝试改绑必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(C.taskProjectUpdate(product, { taskId: t.id, project: 'maplayer-content', expectedVersion: blockedVersion, text: 'product 尝试改绑必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });

  // 项目不存在显式拒绝。
  await expect(C.taskProjectUpdate(gm, { taskId: t.id, project: 'no-such-project', expectedVersion: blockedVersion, text: '未登记项目必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'not_found' });

  // 幂等：同 key 同参重放返回同一结果，不重复审计；同 key 不同参冲突。
  const idem = key();
  const first = await C.taskProjectUpdate(gm, { taskId: t.id, project: 'maplayer-content', expectedVersion: blockedVersion, text: '幂等重放探测', idempotencyKey: idem });
  const replayed = await C.taskProjectUpdate(gm, { taskId: t.id, project: 'maplayer-content', expectedVersion: blockedVersion, text: '幂等重放探测', idempotencyKey: idem });
  expect(replayed.version).toBe(first.version);
  expect(await auditRows(t.id, 'task_project_update')).toHaveLength(1);
  await expect(C.taskProjectUpdate(gm, { taskId: t.id, project: 'anime', expectedVersion: blockedVersion, text: '幂等重放探测', idempotencyKey: idem })).rejects.toMatchObject({ code: 'conflict' });

  // 版本竞态：改绑把版本推进一步后，用过期 expectedVersion 再改绑必须冲突。
  await expect(C.taskProjectUpdate(gm, { taskId: t.id, project: 'anime', expectedVersion: first.version - 1, text: '版本竞态负例：版本已前进', idempotencyKey: key() })).rejects.toMatchObject({ code: 'conflict' });

  // 状态负例：ready / doing / review / done。
  const ready = await taskOnNoProjectGoal(C);
  await expect(C.taskProjectUpdate(gm, { taskId: ready.id, project: 'maplayer-content', expectedVersion: await versionOf(C, ready.id), text: 'ready 任务必须先 block 才能改绑', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
  const doing = await taskOnNoProjectGoal(C);
  await C.claim(eng3, doing.id); // 独立员工：doing 租约不再泄漏到后续负例的领取者
  await expect(C.taskProjectUpdate(gm, { taskId: doing.id, project: 'maplayer-content', expectedVersion: await versionOf(C, doing.id), text: 'doing 任务持有租约必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
  const review = await taskOnNoProjectGoal(C);
  const rc = await C.claim(eng2, review.id);
  await C.submit(eng2, proof(rc), { text: 'fixture submission to reach review state', idempotencyKey: key() });
  await expect(C.taskProjectUpdate(gm, { taskId: review.id, project: 'maplayer-content', expectedVersion: await versionOf(C, review.id), text: 'review 任务必须拒绝改绑', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
  const done = await taskOnNoProjectGoal(C);
  await blockByGm(C, done.id, eng2);
  await C.resume(gm, done.id, { text: 'fixture resume to walk the task to done', idempotencyKey: key() });
  const dc = await C.claim(eng2, done.id);
  await C.submit(eng2, proof(dc), { text: 'fixture submission for done path', idempotencyKey: key() });
  const reviewerClaim = await C.claim(eng, done.id);
  await C.accept(eng, proof(reviewerClaim), { text: 'fixture independent accept for done path', idempotencyKey: key() });
  await expect(C.taskProjectUpdate(gm, { taskId: done.id, project: 'maplayer-content', expectedVersion: await versionOf(C, done.id), text: 'done 任务必须拒绝改绑', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });

  // owner 阻塞拒绝（改绑不能绕过 owner 关口）。
  const owned = await taskOnNoProjectGoal(C);
  const oc = await C.claim(eng2, owned.id);
  await C.block(eng2, proof(oc), 'owner', { text: 'fixture owner-blocked task must not be rebindable', idempotencyKey: key() });
  await expect(C.taskProjectUpdate(gm, { taskId: owned.id, project: 'maplayer-content', expectedVersion: await versionOf(C, owned.id), text: 'owner 阻塞任务必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });

  // 活租约拒绝（异常态防御：blocked 但租约未过期）。
  const leased = await taskOnNoProjectGoal(C);
  await blockByGm(C, leased.id, eng2);
  await forgeActiveLease(leased.id, 'tp-eng2');
  await expect(C.taskProjectUpdate(gm, { taskId: leased.id, project: 'maplayer-content', expectedVersion: await versionOf(C, leased.id), text: '活租约任务必须拒绝改绑', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });

  // 已提交成果拒绝：review 中被打断成 blocked 的任务保留 submitted_by。
  const submitted = await taskOnNoProjectGoal(C);
  const sc = await C.claim(eng2, submitted.id);
  await C.submit(eng2, proof(sc), { text: 'fixture submission before reviewer block', idempotencyKey: key() });
  const rv = await C.claim(eng, submitted.id);
  await C.block(eng, proof(rv), 'owner', { text: 'fixture reviewer block keeps submitted results', idempotencyKey: key() });
  await expect(C.taskProjectUpdate(gm, { taskId: submitted.id, project: 'maplayer-content', expectedVersion: await versionOf(C, submitted.id), text: '已有提交成果的任务必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
});

run('rebind releases the stale registered reference but never deletes the physical tree', async () => {
  const C = core();
  const t = await taskOnNoProjectGoal(C);
  const claim = await C.claim(eng, t.id);
  const treePath = claim.worktree!.worktreePath;
  const before = await C.listWorktrees(gm);
  expect(before.find(w => w.worktreePath === treePath)!.references.some(r => r.taskId === t.id && r.state === 'active')).toBe(true);
  await C.block(eng, proof(claim), 'owner', { text: 'fixture: 错配仓库阻塞，等待改绑', idempotencyKey: key() });

  await C.taskProjectUpdate(gm, { taskId: t.id, project: 'maplayer-content', expectedVersion: await versionOf(C, t.id), text: '改绑后旧登记引用按生命周期释放', idempotencyKey: key() });
  const after = await C.listWorktrees(gm); // 全局清单：旧树挂在旧仓，任务级清单已按新项目解析
  const oldTree = after.find(w => w.worktreePath === treePath)!;
  expect(oldTree).toBeDefined();
  expect(oldTree.references.filter(r => r.taskId === t.id).every(r => r.state === 'released')).toBe(true);
  expect(existsSync(treePath)).toBe(true); // 物理树未被删除，交给既有 reclaim 生命周期
  // 改绑后经理 resume，再在新项目仓重新领取：分配 maplayer-content 的任务分支，而不是复用旧仓现场。
  await C.resume(gm, t.id, { text: 'fixture resume after rebind away from the wrong repo', idempotencyKey: key() });
  // The original implementer keeps the task: a different engineering employee is still refused by the implementer guard.
  const crossClaim = await C.claim(eng2, t.id).catch((error: Error & { code?: string }) => error);
  expect(crossClaim).toMatchObject({ code: 'forbidden', message: 'Task claim denied: bound to another implementer' });
  const next = await C.claim(eng, t.id);
  expect(next.worktree!.repo).toBe(repoMlc);
  expect(next.worktree!.worktreePath).not.toBe(treePath);
  await C.submit(eng, proof(next), { text: 'fixture delivery proves rebinding rerouted the workspace', idempotencyKey: key() });
});

run('ops project resolution follows the override for broker scope and audit quota counting', async () => {
  const C = core();
  // create_task 带覆盖：claim 后 opsScope 解析到 maplayer-content（ops_info/broker 环境随之切换）。
  const [grows] = await db.db.query<[Array<{ id: RecordId }>]>("CREATE goal CONTENT { title: 'ops 解析', brief: 'fixture', state: 'active', source: 'fixture', note: '', tasks: {}, anchors: [], created_at: time::now() } RETURN AFTER;");
  const t = await C.createTask(gm, { title: `ops 解析 fixture ${++count}`, context: 'Isolated fixture for ops project resolution', executorRole: 'engineering', reviewerRole: 'engineering', goalId: asId(grows[0]!.id), project: 'maplayer-content', idempotencyKey: key() });
  expect(t.projectOverlay).toBe('maplayer-content');
  const claim = await C.claim(eng, t.id);
  const scope = await C.opsScope(eng, t.id);
  expect(scope.project).toBe('maplayer-content');
  // 配额计数按任务解析项目（覆盖优先）归属，而不是 goal 的项目。
  await C.auditOps(scope, 'ops_call', 'fixture read-only ops call');
  expect(await C.opsCount('maplayer-content', 'ops_call', 3600)).toBeGreaterThanOrEqual(1);
  expect(claim.project?.id).toBe('maplayer-content');
});

// ---- bind_task_code_repo：显式代码仓库绑定，业务项目/ops 范围不动 ----

run('bind routes the workspace to the ops repo while the business project stays untouched', async () => {
  const C = core(), wf = workforce();
  // 业务项目在 maplayer-content（goal.project），代码绑定到公司运营仓：产品目标 + 公司代码。
  const [grows] = await db.db.query<[Array<{ id: RecordId }>]>("CREATE goal CONTENT { title: '产品目标公司代码', brief: 'fixture', state: 'active', source: 'fixture', note: '', project: project:`maplayer-content`, tasks: {}, anchors: [], created_at: time::now() } RETURN AFTER;");
  const t = await C.createTask(gm, { title: `代码绑定 fixture ${++count}`, context: 'Isolated fixture for explicit code-repo binding', executorRole: 'engineering', reviewerRole: 'engineering', goalId: asId(grows[0]!.id), idempotencyKey: key() });
  const claim = await C.claim(eng4, t.id);
  const treePath = claim.worktree!.worktreePath;
  expect(claim.worktree!.repo).toBe(repoMlc); // 绑定前走业务项目仓
  await C.block(eng4, proof(claim), 'owner', { text: 'fixture: 代码仓错配阻塞，等待经理绑定', idempotencyKey: key() });

  const version = await versionOf(C, t.id);
  const bound = await C.bindTaskCodeRepo(gm, { taskId: t.id, codeRepoPath: repoOps, expectedVersion: version, text: '经理裁定：代码在公司运营仓，业务项目保持 maplayer-content', idempotencyKey: key() });
  expect(bound.codeRepoPath).toBe(realpathSync(repoOps));
  expect(bound.version).toBe(version + 1);
  expect(bound.state).toBe('blocked');
  expect(bound.worktree).toBeUndefined(); // 旧 assignment 已清
  expect(bound.projectOverlay).toBeUndefined(); // 业务项目解析未变

  // 旧 worktree 引用按生命周期释放，物理树保留（不自行删树）。
  const inventory = await C.listWorktrees(gm);
  const oldTree = inventory.find(w => w.worktreePath === treePath)!;
  expect(oldTree.references.filter(r => r.taskId === t.id).every(r => r.state === 'released')).toBe(true);
  expect(existsSync(treePath)).toBe(true);

  await C.resume(gm, t.id, { text: 'fixture resume after code-repo bind', idempotencyKey: key() });
  // Binding the code repo does not hand the task to another employee: the original implementer still claims it.
  const crossClaim = await C.claim(eng2, t.id).catch((error: Error & { code?: string }) => error);
  expect(crossClaim).toMatchObject({ code: 'forbidden', message: 'Task claim denied: bound to another implementer' });
  const next = await C.claim(eng4, t.id);
  expect(next.worktree!.repo).toBe(realpathSync(repoOps)); // 新 claim 在绑定仓分配任务分支
  expect(next.worktree!.branch).toBe(`task/${t.id.slice(0, 8)}`);
  expect(next.worktree!.worktreePath).not.toBe(treePath);
  expect(next.project?.id).toBe('maplayer-content'); // claim.json.project 仍是业务项目
  const scope = await C.opsScope(eng4, t.id);
  expect(scope.project).toBe('maplayer-content'); // ops 环境/凭证范围不受代码绑定影响

  const supervised = (await wf.tasks()).find(x => x.id === t.id)!;
  expect(supervised.repoPath).toBe(realpathSync(repoOps)); // dispatcher home/cwd/repoHome 单点解析
  expect(supervised.codeRepoPath).toBe(realpathSync(repoOps));

  // 任务级清单按绑定仓解析；审计与 outbox 落行。
  const scoped = await C.listWorktrees(gm, t.id);
  expect(scoped.find(w => w.references.some(r => r.taskId === t.id && r.state === 'active'))!.repo).toBe(realpathSync(repoOps));
  expect(await auditRows(t.id, 'bind_task_code_repo')).toHaveLength(1);
  const [events] = await db.db.query<[Array<{ kind: string; payload: { new_repo?: string } }>]>("SELECT kind, payload FROM outbox WHERE task = $task AND kind = 'code_repo_bound';", { task: new RecordId('task', t.id) });
  expect(events).toHaveLength(1);
  expect(events[0]!.payload.new_repo).toBe(realpathSync(repoOps));
  const hist = await C.history(gm, t.id);
  expect(hist.some(h => h.action === 'bind_task_code_repo' && h.actor === 'tp-gm')).toBe(true);
  await C.submit(eng4, proof(next), { text: 'fixture delivery after binding code repo to operations', idempotencyKey: key() });
});

run('dependency waits and defer_task_until waits stay bindable, then claim in the bound repo', async () => {
  const C = core();
  const [grows] = await db.db.query<[Array<{ id: RecordId }>]>("CREATE goal CONTENT { title: '依赖等待绑定', brief: 'fixture', state: 'active', source: 'fixture', note: '', tasks: {}, anchors: [], created_at: time::now() } RETURN AFTER;");
  const goalId = asId(grows[0]!.id);
  const gate = await C.createTask(gm, { title: `绑定门槛 ${++count}`, context: 'gate for dependency-wait bind fixture', executorRole: 'engineering', reviewerRole: 'engineering', goalId, idempotencyKey: key() });
  const child = await C.createTask(gm, { title: `依赖等待任务 ${++count}`, context: 'blocked dependency-wait fixture', executorRole: 'engineering', reviewerRole: 'engineering', goalId, dependencies: [gate.id], idempotencyKey: key() });
  expect(child.state).toBe('blocked');
  expect(child.blockedTo).toBeUndefined(); // 正式依赖等待：blocked_to 为空也可绑定

  const bound = await C.bindTaskCodeRepo(gm, { taskId: child.id, codeRepoPath: repoAnime, expectedVersion: await versionOf(C, child.id), text: '依赖等待期提前绑定代码仓', idempotencyKey: key() });
  expect(bound.codeRepoPath).toBe(realpathSync(repoAnime));

  // 门槛完成后解锁的任务按绑定仓分配。
  const gc = await C.claim(eng4, gate.id);
  await C.submit(eng4, proof(gc), { text: 'fixture gate delivery', idempotencyKey: key() });
  const gr = await C.claim(eng2, gate.id);
  await C.accept(eng2, proof(gr), { text: 'fixture gate accept unlocks the child', idempotencyKey: key() });
  const next = await C.claim(eng5, child.id);
  expect(next.worktree!.repo).toBe(repoAnime);
  await C.submit(eng5, proof(next), { text: 'fixture delivery after dependency-unlock bind', idempotencyKey: key() });

  // defer_task_until 清掉 gm 标志后的依赖等待同样可绑定。
  const gate2 = await C.createTask(gm, { title: `推迟门槛 ${++count}`, context: 'gate for defer-wait bind fixture', executorRole: 'engineering', reviewerRole: 'engineering', goalId, idempotencyKey: key() });
  const held = await C.createTask(gm, { title: `推迟等待任务 ${++count}`, context: 'gm-blocked then deferred fixture', executorRole: 'engineering', reviewerRole: 'engineering', goalId, idempotencyKey: key() });
  const hc = await C.claim(eng4, held.id);
  await C.block(eng4, proof(hc), 'owner', { text: 'fixture gm block before defer', idempotencyKey: key() });
  const deferred = await C.deferTaskUntil(gm, { taskId: held.id, dependencies: [gate2.id], text: '转为依赖等待：blocked_to 清空', idempotencyKey: key() });
  expect(deferred.state).toBe('blocked');
  expect(deferred.blockedTo).toBeUndefined();
  const bound2 = await C.bindTaskCodeRepo(gm, { taskId: held.id, codeRepoPath: repoAnime, expectedVersion: deferred.version, text: 'defer 等待中绑定代码仓', idempotencyKey: key() });
  expect(bound2.codeRepoPath).toBe(realpathSync(repoAnime));
});

run('bind rejects non-gm, unregistered and escaped paths, owner/review blocks, leases and stale versions', async () => {
  const C = core();
  const t = await taskOnNoProjectGoal(C);
  await blockByGm(C, t.id, eng4);
  const v = await versionOf(C, t.id);

  // 权限：engineering 无 manage；product 有 manage 但非 gm —— 两者都拒绝。
  await expect(C.bindTaskCodeRepo(eng4, { taskId: t.id, codeRepoPath: repoOps, expectedVersion: v, text: '工程师绑定必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(C.bindTaskCodeRepo(product, { taskId: t.id, codeRepoPath: repoOps, expectedVersion: v, text: 'product 绑定必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });

  // 路径校验：相对路径与 `..` 段是 invalid；未登记路径与 symlink 逃逸是 forbidden。
  await expect(C.bindTaskCodeRepo(gm, { taskId: t.id, codeRepoPath: 'relative/path', expectedVersion: v, text: '相对路径必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });
  await expect(C.bindTaskCodeRepo(gm, { taskId: t.id, codeRepoPath: `${repoAnime}/../operations`, expectedVersion: v, text: '遍历段必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'invalid' });
  await expect(C.bindTaskCodeRepo(gm, { taskId: t.id, codeRepoPath: join(dir, 'not-registered'), expectedVersion: v, text: '未登记仓库必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
  const escape = join(repoAnime, 'escape-link');
  symlinkSync(dir, escape); // 指向仓外目录：canonical 后不在白名单
  await expect(C.bindTaskCodeRepo(gm, { taskId: t.id, codeRepoPath: escape, expectedVersion: v, text: 'symlink 逃逸必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
  rmSync(escape);

  // 版本竞态：过期 expectedVersion 冲突。
  await expect(C.bindTaskCodeRepo(gm, { taskId: t.id, codeRepoPath: repoOps, expectedVersion: v + 5, text: '版本竞态必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'conflict' });

  // owner 阻塞与 review 阶段块：不能借绑定绕过关口或打断验收。
  const owned = await taskOnNoProjectGoal(C);
  const oc = await C.claim(eng2, owned.id);
  await C.block(eng2, proof(oc), 'owner', { text: 'fixture owner-blocked task must not be rebindable', idempotencyKey: key() });
  await expect(C.bindTaskCodeRepo(gm, { taskId: owned.id, codeRepoPath: repoOps, expectedVersion: await versionOf(C, owned.id), text: 'owner 阻塞必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
  const rev = await taskOnNoProjectGoal(C);
  const rc = await C.claim(eng2, rev.id);
  await C.submit(eng2, proof(rc), { text: 'fixture submission to reach review', idempotencyKey: key() });
  const rv = await C.claim(eng4, rev.id);
  await C.block(eng4, proof(rv), 'owner', { text: 'fixture reviewer block keeps submitted results', idempotencyKey: key() });
  await expect(C.bindTaskCodeRepo(gm, { taskId: rev.id, codeRepoPath: repoOps, expectedVersion: await versionOf(C, rev.id), text: 'review 阶段块必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });

  // 活租约与可执行态：blocked+活租约、ready、doing 都拒绝。
  const leased = await taskOnNoProjectGoal(C);
  await blockByGm(C, leased.id, eng2);
  await forgeActiveLease(leased.id, 'tp-eng2');
  await expect(C.bindTaskCodeRepo(gm, { taskId: leased.id, codeRepoPath: repoOps, expectedVersion: await versionOf(C, leased.id), text: '活租约必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
  const ready = await taskOnNoProjectGoal(C);
  await expect(C.bindTaskCodeRepo(gm, { taskId: ready.id, codeRepoPath: repoOps, expectedVersion: await versionOf(C, ready.id), text: 'ready 必须先 block', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
  const doing = await taskOnNoProjectGoal(C);
  await C.claim(eng5, doing.id); // 独立员工：doing 租约不再泄漏到后续负例的领取者
  await expect(C.bindTaskCodeRepo(gm, { taskId: doing.id, codeRepoPath: repoOps, expectedVersion: await versionOf(C, doing.id), text: 'doing 持有租约必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });

  // 幂等：同 key 同参重放返回同一结果不重复审计；同 key 不同参冲突。
  const idem = key();
  const first = await C.bindTaskCodeRepo(gm, { taskId: t.id, codeRepoPath: repoOps, expectedVersion: v, text: '幂等重放探测', idempotencyKey: idem });
  const replayed = await C.bindTaskCodeRepo(gm, { taskId: t.id, codeRepoPath: repoOps, expectedVersion: v, text: '幂等重放探测', idempotencyKey: idem });
  expect(replayed.version).toBe(first.version);
  expect(await auditRows(t.id, 'bind_task_code_repo')).toHaveLength(1);
  await expect(C.bindTaskCodeRepo(gm, { taskId: t.id, codeRepoPath: repoAnime, expectedVersion: v, text: '幂等重放探测', idempotencyKey: idem })).rejects.toMatchObject({ code: 'conflict' });
});

run('creation binds the code repo up front: explicit, inferred from the ops repo path, or left to the project', async () => {
  const C = core();
  const [grows] = await db.db.query<[Array<{ id: RecordId }>]>("CREATE goal CONTENT { title: '创建即绑定代码仓', brief: 'fixture', state: 'active', source: 'fixture', note: '', project: project:`maplayer-content`, tasks: {}, anchors: [], created_at: time::now() } RETURN AFTER;");
  const goalId = asId(grows[0]!.id);
  const base = { executorRole: 'engineering' as const, reviewerRole: 'engineering' as const, goalId };
  // Code intent naming the ops repo path: bound to the ops repo at creation, the business project stays.
  const inferred = await C.createTask(gm, { ...base, title: `推断绑定 ${++count}`, context: `代码仓 ${repoOps}，业务项目保持 maplayer-content`, workIntent: { kind: 'code' }, idempotencyKey: key() });
  expect(inferred.codeRepoPath).toBe(realpathSync(repoOps));
  const claim = await C.claim(eng6, inferred.id);
  expect(claim.worktree!.repo).toBe(realpathSync(repoOps));
  expect(claim.project?.id).toBe('maplayer-content');
  // A longer sibling path is not the ops repo; a read task naming it is not bound either.
  const sibling = await C.createTask(gm, { ...base, title: `近似路径 ${++count}`, context: `参考 ${repoOps}-four-tier 的发布脚本`, workIntent: { kind: 'code' }, idempotencyKey: key() });
  expect(sibling.codeRepoPath).toBeUndefined();
  const read = await C.createTask(gm, { ...base, title: `只读不绑定 ${++count}`, context: `只读核对 ${repoOps}`, workIntent: { kind: 'read' }, idempotencyKey: key() });
  expect(read.codeRepoPath).toBeUndefined();
  // Explicit binding to a registered repo wins; an unregistered one refuses before any write.
  const explicit = await C.createTask(gm, { ...base, title: `显式绑定 ${++count}`, context: 'fixture', workIntent: { kind: 'code' }, codeRepoPath: repoAnime, idempotencyKey: key() });
  expect(explicit.codeRepoPath).toBe(realpathSync(repoAnime));
  await expect(C.createTask(gm, { ...base, title: `未登记仓 ${++count}`, context: 'fixture', codeRepoPath: join(dir, 'not-registered'), idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'forbidden' });
  // A delivery whose spec names the ops repo binds all three legs, including the read-intent release leg.
  const legs = await C.createDelivery(gm, { goalId, title: `交付链绑定 ${++count}`, spec: `改动在 ${repoOps} 的 src/ops，业务项目保持 maplayer-content`, idempotencyKey: key() });
  expect(legs.map(leg => leg.codeRepoPath)).toEqual([0, 1, 2].map(() => realpathSync(repoOps)));
  // create_delivery keeps its intents: implement and deploy legs write code, the release leg is read, all on one lane.
  expect(legs.map(leg => leg.workIntent?.kind)).toEqual(['code', 'read', 'code']);
  expect(new Set(legs.map(leg => leg.workIntent?.lane)).size).toBe(1);
});

run('triage binds a company-system quick goal legs to the ops repo; a project goal keeps project routing', async () => {
  const C = core();
  const owner = (C as unknown as { owner: import('../src/owner.ts').OwnerDesk }).owner;
  type LegRow = { title: string; code_repo_path?: string };
  const tasksOf = async (goalId: string) => (await db.db.query<[LegRow[]]>(
    'SELECT title, code_repo_path FROM task WHERE goal = $goal;', { goal: new RecordId('goal', goalId) }))[0] ?? [];
  const repoOf = (rows: LegRow[], suffix: string) => rows.find(row => row.title.endsWith(suffix))?.code_repo_path;
  // No project: the company system's own goal. Its implement+release leg and its deploy leg bind to the ops repo at triage,
  // so the deploy leg's upgrade card passes the company-release gate. The manual acceptance is not a code leg.
  const company = await owner.createGoal({ text: `公司系统小改动 ${++count}`, source: 'fixture', key: key() });
  await C.triageGoal(gm, { goalId: company.id, tier: 'quick', reason: '经理定级：公司系统单仓库小改动' });
  const companyRows = await tasksOf(company.id);
  expect(repoOf(companyRows, '· 实现与上线申请')).toBe(realpathSync(repoOps));
  expect(repoOf(companyRows, '· 合入部署与生产实测')).toBe(realpathSync(repoOps));
  expect(repoOf(companyRows, '· 运营验收')).toBeUndefined();
  // A goal with a project keeps the project routing: none of its legs is bound to a code repo at triage.
  const project = await owner.createGoal({ text: `业务项目小改动 ${++count}`, source: 'fixture', key: key(), project: 'maplayer-content' });
  await C.triageGoal(gm, { goalId: project.id, tier: 'quick', reason: '经理定级：业务项目单仓库小改动' });
  const projectRows = await tasksOf(project.id);
  expect(projectRows).toHaveLength(3);
  expect(projectRows.every(row => row.code_repo_path === undefined)).toBe(true);
});

run('owner CLI split: the next phase of a company-system quick goal binds its code legs from a core that only knows the company repo', async () => {
  const owner = (core() as unknown as { owner: import('../src/owner.ts').OwnerDesk }).owner;
  const origin = await owner.createGoal({ text: `分阶段绑定原目标 ${++count}`, source: 'fixture', key: key() });
  await core().triageGoal(gm, { goalId: origin.id, tier: 'quick', reason: '经理定级：公司系统单仓库小改动' });
  // Only the deploy leg moves: the manual acceptance is the anchor, and nothing that stays waits on the deploy leg.
  const legs = (await db.db.query<[Array<{ id: RecordId; title: string }>]>(
    'SELECT id, title FROM task WHERE goal = $goal;', { goal: new RecordId('goal', origin.id) }))[0] ?? [];
  const deploy = legs.find(row => row.title.endsWith('· 合入部署与生产实测'))!;
  // The owner CLI builds its core from the company repo alone (no worktree registry); the split triages the next phase there.
  const title = `分阶段绑定下一阶段 ${++count}`;
  const split = await new SurrealCompanyCore(db, { companyReleaseRepo: repoOps }).ownerGoalPhaseSplit('cli', {
    goalId: origin.id, taskIds: [asId(deploy.id)], title, reason: '老板分阶段 fixture', idempotencyKey: key() });
  type LegRow = { title: string; code_repo_path?: string };
  const rows = (await db.db.query<[LegRow[]]>('SELECT title, code_repo_path FROM task WHERE goal = $goal;',
    { goal: new RecordId('goal', split.nextGoalId) }))[0] ?? [];
  // The moved deploy leg keeps its original binding, so only the next phase's own legs prove the split's triage.
  const next = rows.filter(row => row.title.startsWith(`[目标] ${title} · `));
  expect(next).toHaveLength(3);
  expect(next.find(row => row.title.endsWith('· 实现与上线申请'))?.code_repo_path).toBe(realpathSync(repoOps));
  expect(next.find(row => row.title.endsWith('· 合入部署与生产实测'))?.code_repo_path).toBe(realpathSync(repoOps));
  expect(next.find(row => row.title.endsWith('· 运营验收'))?.code_repo_path).toBeUndefined();
});

run('a blocked read-only engineering task becomes a code task in place', async () => {
  const C = core();
  const t = await C.createTask(gm, { title: `只读改代码 ${++count}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'engineering', workIntent: { kind: 'read' }, idempotencyKey: key() });
  const v0 = await versionOf(C, t.id);
  // Only a blocked task changes intent; ready/doing refuse before any write.
  await expect(C.taskIntentUpdate(gm, { taskId: t.id, expectedVersion: v0, text: '未阻塞必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
  const claim = await C.claim(eng7, t.id);
  await C.block(eng7, proof(claim), 'owner', { text: 'fixture: 只读任务查明需要改代码，请经理改为 code 写权', idempotencyKey: key() });
  const v = await versionOf(C, t.id);
  await expect(C.taskIntentUpdate(eng7, { taskId: t.id, expectedVersion: v, text: '工程师不能改写权', idempotencyKey: key() })).rejects.toMatchObject({ code: 'forbidden' });
  const idem = key();
  const changed = await C.taskIntentUpdate(gm, { taskId: t.id, lane: 'intent-fix', expectedVersion: v, text: '经理裁定：同任务改为 code', idempotencyKey: idem });
  expect(changed.workIntent).toEqual({ kind: 'code', lane: 'intent-fix' });
  expect(changed.version).toBe(v + 1);
  expect(changed.worktree).toBeUndefined();
  const replayed = await C.taskIntentUpdate(gm, { taskId: t.id, lane: 'intent-fix', expectedVersion: v, text: '经理裁定：同任务改为 code', idempotencyKey: idem });
  expect(replayed.version).toBe(changed.version);
  expect(await auditRows(t.id, 'task_intent_update')).toHaveLength(1);
  await expect(C.taskIntentUpdate(gm, { taskId: t.id, expectedVersion: changed.version, text: '已是 code 必须拒绝', idempotencyKey: key() })).rejects.toMatchObject({ code: 'conflict' });
});

run('a failed system check refuses an ops-repo code submit before review and is audited against the author', async () => {
  let problems = ['tsc 报 1 个类型错误：src/a.ts(1,1): error TS2322'];
  const seen: string[] = [];
  const C = new SurrealCompanyCore(db, { worktrees: { opsRepo: repoOps }, systemCheck: async ({ worktreePath }) => { seen.push(worktreePath); return problems; } });
  const t = await C.createTask(gm, { title: `系统检查 ${++count}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'engineering', workIntent: { kind: 'code' }, idempotencyKey: key() });
  const claim = await C.claim(eng8, t.id);
  expect(claim.worktree!.repo).toBe(realpathSync(repoOps));
  await expect(C.submit(eng8, proof(claim), { text: 'fixture submit that fails the system check', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('系统检查未通过') });
  expect(seen).toEqual([claim.worktree!.worktreePath]);
  const after = await C.getTask(eng8, t.id);
  expect(after.state).toBe('doing'); // no reviewer is spent; the author still holds the lease
  expect(after.currentEmployee).toBe('tp-eng8');
  expect(await auditRows(t.id, 'submit_check_failed')).toHaveLength(1);
  problems = [];
  const submitted = await C.submit(eng8, proof(claim), { text: 'fixture submit after fixing the system check', idempotencyKey: key() });
  expect(submitted.state).toBe('review');
});

run('a failed system check also refuses the quick chain code leg (release kind); a read-intent release leg is not checked', async () => {
  const problems = ['tsc 报 1 个类型错误：src/a.ts(1,1): error TS2322'];
  const seen: string[] = [];
  const C = new SurrealCompanyCore(db, { worktrees: { opsRepo: repoOps }, systemCheck: async ({ worktreePath }) => { seen.push(worktreePath); return problems; } });
  const enrollment = new LocalEnrollmentAdmin(db);
  const codeEng = await enrollment.enroll(`tp-quick-code-${++count}`, 'engineering', ['execute', 'review']);
  const readEng = await enrollment.enroll(`tp-quick-read-${++count}`, 'engineering', ['execute', 'review']);
  const leg = await C.createTask(gm, { title: `合并腿系统检查 ${++count}`, context: 'fixture', kind: 'release', executorRole: 'engineering', reviewerRole: 'product',
    workIntent: { kind: 'code', lane: 'quick-check' }, idempotencyKey: key() });
  const claim = await C.claim(codeEng, leg.id);
  expect(claim.worktree!.mode).toBe('exclusive');
  await expect(C.submit(codeEng, proof(claim), { text: 'quick leg submit that fails the system check', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('系统检查未通过') });
  expect(seen).toEqual([claim.worktree!.worktreePath]);
  expect((await C.getTask(codeEng, leg.id)).state).toBe('doing');
  expect(await auditRows(leg.id, 'submit_check_failed')).toHaveLength(1);
  // A read-intent release leg is not checked: its submit goes through as before.
  const readLeg = await C.createTask(gm, { title: `上线申请只读 ${++count}`, context: 'fixture', kind: 'release', executorRole: 'engineering', reviewerRole: 'product',
    workIntent: { kind: 'read' }, idempotencyKey: key() });
  const readClaim = await C.claim(readEng, readLeg.id);
  expect((await C.submit(readEng, proof(readClaim), { text: 'read release leg submit', idempotencyKey: key() })).state).toBe('review');
  expect(seen).toHaveLength(1);
});

run('a large goal closes in stages: open follow-ups move to a next-phase goal and the anchor unlocks', async () => {
  const C = core();
  const goal = await C.relayGoal(gm, { text: '分阶段目标 fixture', ownerQuote: '老板原话 fixture', idempotencyKey: key(), tier: 'standard' });
  const anchor = goal.tasks.manual!;
  const base = { executorRole: 'engineering' as const, reviewerRole: 'engineering' as const, goalId: goal.id, context: 'fixture' };
  const followA = await C.createTask(gm, { ...base, title: `后续补测 A ${++count}`, dependencies: [goal.tasks.plan!], idempotencyKey: key() });
  const followB = await C.createTask(gm, { ...base, title: `后续补测 B ${++count}`, dependencies: [followA.id], idempotencyKey: key() });
  await db.db.query("UPDATE $plan SET state = 'done';", { plan: new RecordId('task', goal.tasks.plan!) });
  // Moving A alone would strand B, which waits on it; anchors cannot be moved.
  await expect(C.goalPhaseSplit(gm, { goalId: goal.id, taskIds: [followA.id], title: '下一阶段', reason: '分阶段 fixture', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining(followB.id) });
  await expect(C.goalPhaseSplit(gm, { goalId: goal.id, taskIds: [anchor], title: '下一阶段', reason: '分阶段 fixture', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('锚点') });
  await expect(C.goalPhaseSplit(eng, { goalId: goal.id, taskIds: [followA.id, followB.id], title: '下一阶段', reason: '分阶段 fixture', idempotencyKey: key() }))
    .rejects.toMatchObject({ code: 'forbidden' });
  const idem = key();
  const split = await C.goalPhaseSplit(gm, { goalId: goal.id, taskIds: [followA.id, followB.id], title: '下一阶段 fixture', reason: '分阶段 fixture', idempotencyKey: idem });
  expect(split.moved.sort()).toEqual([followA.id, followB.id].sort());
  expect(split.unlocked).toEqual([anchor]);
  const anchorAfter = await C.getTask(gm, anchor);
  expect(anchorAfter.state).toBe('ready');
  expect(anchorAfter.dependencies).not.toContain(followA.id);
  const [movedRows] = await db.db.query<[Array<{ goal: RecordId }>]>('SELECT goal FROM $ids;', { ids: [followA.id, followB.id].map(t => new RecordId('task', t)) });
  expect(movedRows.map(r => asId(r.goal))).toEqual([split.nextGoalId, split.nextGoalId]);
  const [next] = await db.db.query<[{ anchors: RecordId[]; tier: string } ]>('SELECT anchors, tier FROM ONLY $g;', { g: new RecordId('goal', split.nextGoalId) });
  expect(next.tier).toBe('standard');
  const firstAnchor = await C.getTask(gm, asId(next.anchors[0]!));
  expect(firstAnchor.dependencies).toEqual(expect.arrayContaining([followA.id, followB.id]));
  // The owner's own split runs the same checks and is audited as the owner.
  const goal2 = await C.relayGoal(gm, { text: '老板分阶段 fixture', ownerQuote: '老板原话 fixture', idempotencyKey: key(), tier: 'standard' });
  const f2 = await C.createTask(gm, { ...base, goalId: goal2.id, title: `老板移走 ${++count}`, dependencies: [goal2.tasks.plan!], idempotencyKey: key() });
  await db.db.query("UPDATE $plan SET state = 'done';", { plan: new RecordId('task', goal2.tasks.plan!) });
  const owned = await C.ownerGoalPhaseSplit('cli', { goalId: goal2.id, taskIds: [f2.id], title: '老板下一阶段', reason: '老板分阶段 fixture', idempotencyKey: key() });
  expect(owned.unlocked).toEqual([goal2.tasks.manual!]);
  const [ownerAudit] = await db.db.query<[Array<{ actor: string }>]>("SELECT actor FROM audit WHERE goal = $g AND action = 'goal_phase_split';", { g: new RecordId('goal', goal2.id) });
  expect(ownerAudit.map(a => String(a.actor))).toEqual(['owner:cli']);
  // A replay returns the same next goal and moves nothing again.
  expect((await C.goalPhaseSplit(gm, { goalId: goal.id, taskIds: [followA.id, followB.id], title: '下一阶段 fixture', reason: '分阶段 fixture', idempotencyKey: idem })).nextGoalId).toBe(split.nextGoalId);
});

run('phase split re-evaluates an owner-approved retained stage without reopening its historical edges',async()=>{
 const C=new SurrealCompanyCore(db);
 const g=await C.relayGoal(gm,{text:'阶段收口回归：已验收第一阶段与延后交付分开',ownerQuote:'老板授权将后续交付拆到第二阶段，第一阶段按真实验收关闭',tier:'standard',idempotencyKey:key()});
 const follow=await C.createTask(gm,{goalId:g.id,title:'第二阶段独立后续工作',context:'下一阶段交付，不能被第一阶段完成冒充',executorRole:'engineering',reviewerRole:'qa',idempotencyKey:key()});
 const historical=await C.createTask(gm,{goalId:g.id,title:'第一阶段已验收历史工作',context:'已验收历史引用保持原样',executorRole:'engineering',reviewerRole:'qa',dependencies:[follow.id],idempotencyKey:key()});
 await db.db.query('UPDATE task SET state="done",accepted_by="owner",current_employee=NONE WHERE goal=$goal AND id!=$follow;', {goal:new RecordId('goal',g.id),follow:new RecordId('task',follow.id)});
 const split=await C.ownerGoalPhaseSplit('test',{goalId:g.id,taskIds:[follow.id],title:'第二阶段独立交付回归',reason:'老板已验收本阶段，将尚未完成的后续工作完整迁入下一阶段，不复用本阶段批准',idempotencyKey:key()});
 const old=await db.db.select<any>(new RecordId('goal',g.id)),next=await db.db.select<any>(new RecordId('goal',split.nextGoalId));
 expect(old!.state).toBe('done');expect(next!.state).not.toBe('done');
 const retained=await db.db.select<any>(new RecordId('task',historical.id));expect(retained!.dependencies.map(asId)).toContain(follow.id);
 const moved=await db.db.select<any>(new RecordId('task',follow.id));expect(asId(moved!.goal)).toBe(split.nextGoalId);expect(moved!.state).not.toBe('done');
});

run('phase-split retry preserves completed next anchors and refuses leased anchors',async()=>{
 for(const scenario of ['done','leased']){
  const C=core();const g=await C.relayGoal(gm,{text:`分阶段恢复边界 ${scenario}`,ownerQuote:'老板授权分阶段并保留既有执行状态',tier:'standard',idempotencyKey:key()});
  const work=await C.createTask(gm,{goalId:g.id,title:'待移动真实后续任务',context:'需要下一阶段继续完成',executorRole:'engineering',reviewerRole:'qa',idempotencyKey:key()});
  // Fault injection between durable next-goal creation and the phase-split transaction.
  const owner=(C as unknown as {owner:import('../src/owner.ts').OwnerDesk}).owner;
  const create=owner.createGoal.bind(owner);let first:string|undefined;
  owner.createGoal=async input=>{const next=await create(input);const row=await db.db.select<any>(new RecordId('goal',next.id));first=asId(row!.anchors[0]);
   await db.db.query(scenario==='done'?'UPDATE ONLY $task SET state="done";':'UPDATE ONLY $task SET current_employee=$holder,lease_expires_at=time::unix(time::now())+3600;', {task:new RecordId('task',first),holder:new RecordId('employee','fixture-holder')});return next;};
  const split=C.ownerGoalPhaseSplit('test',{goalId:g.id,taskIds:[work.id],title:'下一阶段恢复边界回归',reason:'回归模拟创建下一阶段后首锚点先行完成或被认领，不能改写既有状态',idempotencyKey:key()});
  if(scenario==='leased'){
   await expect(split).rejects.toThrow();expect(asId((await db.db.select<any>(new RecordId('task',work.id)))!.goal)).toBe(g.id);
  }else{await split;expect((await db.db.select<any>(new RecordId('task',first!)))!.state).toBe('done');}
 }
});
