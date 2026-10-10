import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import type { ClaimResult, LeaseProof, Role, WorkIntent } from '../src/contracts.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { OwnerDesk } from '../src/owner.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { readJsonFile } from '../src/comm.ts';

const run = process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1' ? test : test.skip;
let dir: string, port: number, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, gm: string;
let count = 0;
const evidence: unknown[] = [];
const password = 'isolated-worktree-fixture-only';
const config = () => ({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: password, namespace: 'worktree_fixture', database: 'control_plane' });
async function start() {
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', password, '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase(config()); await db.connect(); await db.bootstrap();
}
beforeAll(async () => {
  if (process.env.RUN_SCK_WORKTREE_FORK_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-worktree-fork-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') }); port = listener.port!; listener.stop(true);
  await start(); gm = await new LocalEnrollmentAdmin(db).enroll('worktree-manager', 'gm', ['execute', 'review', 'manage']);
}, 20000);
afterAll(async () => { if (!dir) return;
  if (process.env.SCK_WORKTREE_EVIDENCE) {
    const [counts] = await db.db.query<[Array<{ trees: number; refs: number; sessions: number }>]>(`RETURN { trees: array::len((SELECT id FROM worktree)), refs: array::len((SELECT id FROM worktree_ref)), sessions: array::len((SELECT id FROM worktree_session_ref)) };`);
    writeFileSync(process.env.SCK_WORKTREE_EVIDENCE, JSON.stringify({ environment: 'isolated-local-company-fork', database: 'worktree_fixture/control_plane', production: false, before: { trees: 0, refs: 0, sessions: 0 }, after: counts, allocations: evidence }, null, 2));
  }
  await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });
const git = (repo: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
function repo() {
  const path = join(dir, `repo-${++count}`); Bun.spawnSync(['git', 'init', '-q', '-b', 'main', path]);
  writeFileSync(join(path, 'source.txt'), 'baseline');
  git(path, 'add', '.'); git(path, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline');
  return path;
}
async function capture(core: SurrealCompanyCore, result: ClaimResult) {
  const taskId = result.task.id;
  const [audits] = await core.database.db.query<[Array<{ id: RecordId; at: unknown }>]>(
    "SELECT id, at FROM audit WHERE task = $task AND action = 'claim' ORDER BY at DESC LIMIT 1;", { task: new RecordId('task', taskId) });
  evidence.push({ taskId, employee: result.task.currentEmployee, assignment: result.worktree, fence: result.fence,
    auditId: String(audits[0]?.id), at: String(audits[0]?.at) });
}
const coreFor = (path: string) => {
  const core = new SurrealCompanyCore(db, { worktrees: { opsRepo: path } });
  const claim = core.claim.bind(core);
  core.claim = async (credential, taskId) => { const result = await claim(credential, taskId); await capture(core, result); return result; };
  return core;
};
async function employee(role: Role) { return new LocalEnrollmentAdmin(db).enroll(`fixture-${role}-${++count}`, role, ['execute', 'review']); }
async function task(core: SurrealCompanyCore, role: Role, intent?: WorkIntent) {
  return core.createTask(gm, { title: `Worktree fixture ${++count}`, context: 'Isolated local integration fixture, never production', executorRole: role, reviewerRole: 'qa', workIntent: intent, idempotencyKey: `fixture-task-${count}` });
}
const proof = (claim: ClaimResult): LeaseProof => ({ taskId: claim.task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version });
async function submit(core: SurrealCompanyCore, credential: string, claim: ClaimResult) { return core.submit(credential, proof(claim), { text: 'Synthetic fixture completed with unchanged scene', idempotencyKey: `fixture-submit-${++count}` }); }

run('serial QA and GM reuse one physical tree, with authenticated references and protected main', async () => {
  const path = repo(), core = coreFor(path), qa = await employee('qa');
  const first = await core.claim(qa, (await task(core, 'qa')).id); await submit(core, qa, first);
  const second = await core.claim(qa, (await task(core, 'qa')).id); expect(second.worktree!.worktreePath).toBe(first.worktree!.worktreePath); await submit(core, qa, second);
  const manager1 = await core.claim(gm, (await task(core, 'gm')).id); await submit(core, gm, manager1);
  const manager2 = await core.claim(gm, (await task(core, 'gm')).id); expect(manager2.worktree!.worktreePath).toBe(first.worktree!.worktreePath);
  const inventory = await core.listWorktrees(gm);
  const shared = inventory.find(w => w.id === first.worktree!.id)!;
  expect(shared.references.filter(r => r.state === 'active').map(r => r.taskId)).toEqual([manager2.task.id]);
  expect(shared.references.filter(r => r.state === 'released')).toHaveLength(3);
  expect(shared.createdAt).toBeTruthy(); expect(shared.lastUsedAt).toBeTruthy(); expect(shared.reasons).toContain('active-reference');
  expect(inventory.find(w => w.worktreePath === path)!.reasons).toContain('repository-main');
  await expect(core.listWorktrees(qa)).rejects.toMatchObject({ code: 'forbidden' });
  expect((await core.listWorktrees(qa, first.task.id)).some(w => w.id === shared.id)).toBe(true);
  const history = await core.history(qa, first.task.id); expect(history.find(h => h.action === 'claim')!.evidence).toContain(first.worktree!.worktreePath);
  await submit(core, gm, manager2);
});
run('serial engineers keep independent task branches and PR histories while reusing clean tree', async () => {
  const path = repo(), core = coreFor(path), eng = await employee('engineering');
  const first = await core.claim(eng, (await task(core, 'engineering')).id);
  writeFileSync(join(first.worktree!.worktreePath, 'source.txt'), 'first task');
  git(first.worktree!.worktreePath, 'add', '.'); git(first.worktree!.worktreePath, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'first change');
  await submit(core, eng, first);
  const second = await core.claim(eng, (await task(core, 'engineering')).id);
  expect(second.worktree!.worktreePath).toBe(first.worktree!.worktreePath); expect(second.worktree!.branch).not.toBe(first.worktree!.branch);
  expect(readFileSync(join(second.worktree!.worktreePath, 'source.txt'), 'utf8')).toBe('baseline');
  expect(git(path, 'show', `${first.worktree!.branch}:source.txt`)).toBe('first task');
  expect(git(path, 'show', 'main:source.txt')).toBe('baseline');
  await submit(core, eng, second);
});
run('two first claims across independent processes get distinct writers; dirty first scene stays untouched', async () => {
  const path = repo(), core = coreFor(path), a = await employee('engineering'), b = await employee('engineering');
  const ta = await task(core, 'engineering'), tb = await task(core, 'engineering');
  const code = `import {CompanyDatabase} from './src/database.ts'; import {SurrealCompanyCore} from './src/core.ts';
    const input=await new Response(Bun.stdin.stream()).json(); const db=new CompanyDatabase(input.config);
    await db.connect(); await db.useDatabase(); try { const core=new SurrealCompanyCore(db,{worktrees:{opsRepo:input.repo}});
    const c=await core.claim(input.credential,input.task); console.log('FIXTURE_RESULT='+JSON.stringify(c)); } finally {await db.close();}`;
  const claimInChild = async (credential: string, taskId: string) => {
    const child = Bun.spawn(['bun', '-e', code], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(JSON.stringify({ config: config(), repo: path, credential, task: taskId })); child.stdin.end();
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit) throw new Error(err); return JSON.parse(out.split('FIXTURE_RESULT=')[1]!) as ClaimResult;
  };
  const [first, second] = await Promise.all([claimInChild(a, ta.id), claimInChild(b, tb.id)]);
  await capture(core, first); await capture(core, second);
  expect(first.worktree!.worktreePath).not.toBe(second.worktree!.worktreePath);
  expect([first.worktree!.mode, second.worktree!.mode].sort()).toEqual(['exclusive', 'shared']);
  writeFileSync(join(first.worktree!.worktreePath, 'source.txt'), 'uncommitted first');
  writeFileSync(join(second.worktree!.worktreePath, 'source.txt'), 'uncommitted second');
  expect(readFileSync(join(first.worktree!.worktreePath, 'source.txt'), 'utf8')).toBe('uncommitted first');
  expect(readFileSync(join(second.worktree!.worktreePath, 'source.txt'), 'utf8')).toBe('uncommitted second');
  const again = await core.claim(a, ta.id); expect(again.worktree).toEqual(first.worktree); expect(again.fence).toBe(first.fence);
  const inv = await core.listWorktrees(gm); expect(inv.filter(w => w.repo === path && w.references.some(r => r.state === 'active'))).toHaveLength(2);
  await submit(core, a, again); await submit(core, b, second);
}, 20000);
run('asset scopes overlap queues, disjoint directories share; readers prevent engineering branch switch', async () => {
  const path = repo(), core = coreFor(path), a = await employee('asset-production'), b = await employee('concept-design'), eng = await employee('engineering');
  const first = await core.claim(a, (await task(core, 'asset-production', { kind: 'assets', paths: ['assets/characters'] })).id);
  const queued = await task(core, 'concept-design', { kind: 'assets', paths: ['assets/characters/sub'] });
  await expect(core.claim(b, queued.id)).rejects.toMatchObject({ code: 'worktree_busy' });
  expect((await core.getTask(gm, queued.id)).currentEmployee).toBeUndefined();
  const disjoint = await core.claim(b, (await task(core, 'concept-design', { kind: 'assets', paths: ['assets/music'] })).id);
  expect(disjoint.worktree!.worktreePath).toBe(first.worktree!.worktreePath);
  const writer = await core.claim(eng, (await task(core, 'engineering')).id); expect(writer.worktree!.mode).toBe('exclusive');
  expect(git(first.worktree!.worktreePath, 'branch', '--show-current')).toBe(first.worktree!.branch!);
  await submit(core, a, first); await submit(core, b, disjoint); await submit(core, eng, writer);
  const resumed = await core.claim(b, queued.id); expect(resumed.worktree!.worktreePath).toBe(first.worktree!.worktreePath); await submit(core, b, resumed);
  await expect(task(core, 'asset-production', { kind: 'assets', paths: ['../escape'] })).rejects.toMatchObject({ code: 'invalid' });
  await expect(task(core, 'asset-production', { kind: 'assets', paths: ['.env'] })).rejects.toMatchObject({ code: 'invalid' });
});
run('restart persistence, revoked handover preserves dirty scene and fencing; legacy trees are adopted without reset', async () => {
  const path = repo(), core = coreFor(path), eng = await employee('engineering'), successor = await employee('engineering');
  const t = await task(core, 'engineering'), legacy = join(dir, `legacy-${++count}`);
  git(path, 'worktree', 'add', '-b', `task/${t.id.slice(0, 8)}`, legacy); writeFileSync(join(legacy, 'source.txt'), 'old scene');
  const first = await core.claim(eng, t.id); expect(first.worktree!.worktreePath).toBe(legacy); expect(first.worktree!.mode).toBe('protected');
  const actor = (await core.authenticate(eng)).employeeId;
  await new Workforce(db, join(dir, 'unused')).revokeLease(t.id, actor, 'fixture handover', 'fixture previous employee stopped');
  expect((await core.listWorktrees(gm)).find(w => w.id === first.worktree!.id)!.reasons).toContain('unfinished-scene');
  await db.close(); server.kill(); await server.exited; await start();
  const restarted = coreFor(path), second = await restarted.claim(successor, t.id);
  expect(second.worktree!.worktreePath).toBe(legacy); expect(second.fence).toBeGreaterThan(first.fence); expect(readFileSync(join(legacy, 'source.txt'), 'utf8')).toBe('old scene');
  await expect(restarted.checkpoint(eng, proof(first), { text: 'stale fixture proof', idempotencyKey: 'stale-worktree-proof' })).rejects.toBeDefined();
  const inv = await restarted.listWorktrees(gm); expect(inv.find(w => w.id === second.worktree!.id)!.references.filter(r => r.state === 'active')).toHaveLength(1);
  await submit(restarted, successor, second);
}, 20000);
run('failed authorization/claim and symlink scopes never leave effective references; manual drift remains protected', async () => {
  const path = repo(), core = coreFor(path), eng = await employee('engineering'), qa = await employee('qa'), assets = await employee('asset-production');
  const t = await task(core, 'engineering'); await expect(core.claim(qa, t.id)).rejects.toMatchObject({ code: 'forbidden' });
  expect((await core.listWorktrees(gm)).filter(w => w.repo === path)).toHaveLength(0);
  const first = await core.claim(eng, t.id); await expect(core.claim(eng, (await task(core, 'engineering')).id)).rejects.toMatchObject({ code: 'already_claimed' });
  expect((await core.listWorktrees(gm)).flatMap(w => w.references).filter(r => r.state === 'active' && r.employee === first.task.currentEmployee)).toHaveLength(1);
  await submit(core, eng, first);
  symlinkSync(dir, join(first.worktree!.worktreePath, 'outside'));
  await expect(core.claim(assets, (await task(core, 'asset-production', { kind: 'assets', paths: ['outside/assets'] })).id)).rejects.toMatchObject({ code: 'invalid' });
  git(first.worktree!.worktreePath, 'checkout', '-b', 'manual-drift');
  const inv = await core.listWorktrees(gm); expect(inv.find(w => w.id === first.worktree!.id)!.status).toBe('drift');
  const isolated = await core.claim(eng, (await task(core, 'engineering')).id);
  expect(isolated.worktree!.worktreePath).not.toBe(first.worktree!.worktreePath);
  expect(git(first.worktree!.worktreePath, 'branch', '--show-current')).toBe('manual-drift');
  await submit(core, eng, isolated);
});
run('actual dispatcher and sidecar stage one registry source in claim.json, prompt and Paseo cwd', async () => {
  const path = repo(), core = coreFor(path), wf = new Workforce(db, join(dir, 'unused')), owner = new OwnerDesk(db);
  await db.db.upsert(new RecordId('company_meta', 'config')).content({ eval_enabled: false, jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
  // Limit the scheduler to this synthetic task; no real employees or dispatcher are created.
  const t = await task(core, 'qa'); const originalTasks = wf.tasks.bind(wf); wf.tasks = async () => (await originalTasks()).filter(x => x.id === t.id);
  await wf.upsertDef('worktree-qa-def', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
  const pool = new SidecarPool({ core, workforce: wf as unknown as SidecarDeps['workforce'], runDir: join(dir, 'comm') });
  let seen: { cwd: string; prompt: string; env: Record<string, string> } | undefined;
  const paseo: PaseoGateway = { list: async () => new Map(), status: async () => undefined, lastError: async () => '', logsTail: async () => '', lastInputTokens: async () => 0,
    spawn: async input => { seen = input; return 'fixture-agent'; }, send: async () => {}, stop: async () => {}, archive: async () => {} };
  try {
    const dispatcher = new Dispatcher({ workforce: wf, owner, paseo, sidecar: pool, env: { opsRepo: path, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' } });
    const result = await dispatcher.tick(); expect(result.woke).toHaveLength(1); expect(seen).toBeDefined();
    const claim = readJsonFile<ClaimResult>(join(seen!.env.SCK_COMM_DIR!, 'claim.json'))!;
    expect(seen!.cwd).toBe(claim.worktree!.worktreePath); expect(seen!.prompt).toContain(claim.worktree!.worktreePath); expect(seen!.cwd).not.toBe(path);
    expect(claim.worktree!.discipline).toContain('只读代码');
    expect(JSON.stringify(claim)).not.toContain('sck_'); expect(JSON.stringify(claim)).not.toContain(password);
    const [refs] = await db.db.query<[Array<{ employee: string }>]>('SELECT employee FROM worktree_ref WHERE task = $task;', { task: new RecordId('task', t.id) }); expect(refs).toHaveLength(1);
    expect(existsSync(join(dir, 'unused'))).toBe(false);
  } finally { pool.detachAgent('fixture-agent'); }
}, 15000);

run('non-lease GM/eval shared sessions protect checkout and release without credentials reaching agents', async () => {
  const path = repo(), core = coreFor(path), judge = await employee('eval'), eng = await employee('engineering');
  const manager = await core.readWorkspace(gm), evaluator = await core.readWorkspace(judge);
  expect(manager!.worktreePath).toBe(evaluator!.worktreePath);
  const writer = await core.claim(eng, (await task(core, 'engineering')).id);
  expect(writer.worktree!.mode).toBe('exclusive');
  const inventory = await core.listWorktrees(gm), shared = inventory.find(w => w.id === manager!.id)!;
  expect(shared.references.filter(r => r.state === 'active')).toHaveLength(2);
  await core.releaseWorkspace(gm); await core.releaseWorkspace(judge);
  expect((await core.listWorktrees(gm)).find(w => w.id === manager!.id)!.references.filter(r => r.state === 'active')).toHaveLength(0);
  await submit(core, eng, writer);
});

run('strategy rollback preserves existing assignments and registry; new code stays isolated while read/asset trees share', async () => {
  const path = repo(), core = new SurrealCompanyCore(db, { worktrees: { opsRepo: path, strategy: 'legacy' } });
  const eng = await employee('engineering'), qa = await employee('qa'), assets = await employee('asset-production');
  const a = await core.claim(eng, (await task(core, 'engineering')).id); await submit(core, eng, a);
  const b = await core.claim(eng, (await task(core, 'engineering')).id); expect(b.worktree!.mode).toBe('exclusive'); expect(b.worktree!.worktreePath).not.toBe(a.worktree!.worktreePath);
  const reader = await core.claim(qa, (await task(core, 'qa')).id);
  const artist = await core.claim(assets, (await task(core, 'asset-production', { kind: 'assets', paths: ['assets/test'] })).id);
  expect(reader.worktree!.mode).toBe('shared'); expect(artist.worktree!.worktreePath).toBe(reader.worktree!.worktreePath);
  const current = await core.claim(eng, b.task.id); expect(current.worktree).toEqual(b.worktree);
  await submit(core, eng, current); await submit(core, qa, reader); await submit(core, assets, artist);
});
run('retry after git-created read tree lost initial registration reuses scene without reset or false references', async () => {
  const path = repo(), core = coreFor(path), qa = await employee('qa');
  const a = await core.claim(qa, (await task(core, 'qa')).id); await submit(core, qa, a);
  await db.db.query('DELETE ONLY $tree;', { tree: new RecordId('worktree', a.worktree!.id) });
  writeFileSync(join(a.worktree!.worktreePath, 'retained.txt'), 'preserve across reconciliation');
  const b = await core.claim(qa, (await task(core, 'qa')).id);
  expect(b.worktree!.id).toBe(a.worktree!.id); expect(b.worktree!.worktreePath).toBe(a.worktree!.worktreePath); expect(b.worktree!.mode).toBe('shared');
  expect(readFileSync(join(b.worktree!.worktreePath, 'retained.txt'), 'utf8')).toBe('preserve across reconciliation');
  expect((await core.listWorktrees(gm)).find(w => w.id === b.worktree!.id)!.references.filter(r => r.state === 'active')).toHaveLength(1);
  await submit(core, qa, b);
});
