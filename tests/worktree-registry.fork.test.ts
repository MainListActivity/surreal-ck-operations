import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { ProjectStore } from '../src/projects.ts';
import { Workforce } from '../src/workforce.ts';
import type { ClaimResult, LeaseProof, Role, WorkIntent } from '../src/contracts.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { OwnerDesk } from '../src/owner.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { readJsonFile } from '../src/comm.ts';

setDefaultTimeout(30000);
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
    const registry = await new SurrealCompanyCore(db, { worktrees: { opsRepo: dir } }).listWorktrees(gm);
    const effectiveReferences = registry.flatMap(w => w.references).filter(r => r.state !== 'released').length;
    writeFileSync(process.env.SCK_WORKTREE_EVIDENCE, JSON.stringify({ environment: 'isolated-local-company-fork', database: 'worktree_fixture/control_plane', production: false, before: { trees: 0, refs: 0, sessions: 0, effectiveReferences: 0 }, after: { ...counts, effectiveReferences }, registry, allocations: evidence }, null, 2));
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
async function acceptDone(core: SurrealCompanyCore, executor: string, claim: ClaimResult) {
  const submitted = await submit(core, executor, claim);
  const qa = await employee('qa');
  const review = await core.claim(qa, submitted.id);
  return core.accept(qa, proof(review), { text: 'Independent fixture accept for reclaim coverage', idempotencyKey: `fixture-accept-${++count}` });
}

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
  // Global inventory may reconcile the repo main as protected; failed claims must leave no effective refs or managed writers.
  const before = (await core.listWorktrees(gm)).filter(w => w.repo === path);
  expect(before.every(w => w.references.filter(r => r.state !== 'released').length === 0)).toBe(true);
  expect(before.every(w => w.mode === 'protected' && (w.worktreePath === path || w.reasons.includes('repository-main')))).toBe(true);
  const first = await core.claim(eng, t.id); await expect(core.claim(eng, (await task(core, 'engineering')).id)).rejects.toMatchObject({ code: 'already_claimed' });
  expect((await core.listWorktrees(gm)).flatMap(w => w.references).filter(r => r.state === 'active' && r.employee === first.task.currentEmployee)).toHaveLength(1);
  await submit(core, eng, first);
  symlinkSync(dir, join(first.worktree!.worktreePath, 'outside'));
  await expect(core.claim(assets, (await task(core, 'asset-production', { kind: 'assets', paths: ['outside/assets'] })).id)).rejects.toMatchObject({ code: 'invalid' });
  git(first.worktree!.worktreePath, 'checkout', '-b', 'manual-drift');
  const external = join(dir, `external-${++count}`); git(path, 'worktree', 'add', '-b', `external-${count}`, external);
  const inv = await core.listWorktrees(gm); expect(inv.find(w => w.id === first.worktree!.id)!.status).toBe('drift');
  expect(inv.find(w => w.worktreePath === external)!.mode).toBe('protected');
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
    spawn: async input => { seen = input; return 'fixture-agent'; }, send: async () => {}, stop: async () => {}, archive: async () => {},
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {} };
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

run('new task branches start from available origin default branch rather than a stale shared checkout', async () => {
  const path = repo(), core = coreFor(path), eng = await employee('engineering');
  git(path, 'checkout', '-b', 'approved-baseline'); writeFileSync(join(path, 'source.txt'), 'approved remote baseline');
  git(path, 'add', '.'); git(path, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'approved baseline');
  git(path, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); git(path, 'checkout', 'main');
  const a = await core.claim(eng, (await task(core, 'engineering')).id);
  expect(readFileSync(join(a.worktree!.worktreePath, 'source.txt'), 'utf8')).toBe('approved remote baseline');
  expect(git(path, 'show', 'main:source.txt')).toBe('baseline'); await submit(core, eng, a);
});

run('explicit read engineering task and its independent review keep shared read workspace without creating task branch', async () => {
  const path = repo(), core = coreFor(path), eng = await employee('engineering'), qa = await employee('qa');
  const t = await task(core, 'engineering', { kind: 'read' }), reader = await core.claim(eng, t.id);
  expect(reader.worktree!.intent.kind).toBe('read'); expect(reader.worktree!.mode).toBe('shared');
  await submit(core, eng, reader);
  const review = await core.claim(qa, t.id); expect(review.worktree!.worktreePath).toBe(reader.worktree!.worktreePath);
  expect(review.worktree!.branch).toBe(reader.worktree!.branch);
  await expect(core.accept(eng, proof(review), { text: 'self review denied', idempotencyKey: 'read-self-review-denied' })).rejects.toBeDefined();
  await core.accept(qa, proof(review), { text: 'Independent fixture read review', idempotencyKey: `read-accept-${++count}` });
});
run('managed allocator keeps expired-lease takeover semantics and preserves scene while fencing stale proof', async () => {
  const path = repo(), core = new SurrealCompanyCore(db, { leaseSeconds: 1, worktrees: { opsRepo: path } });
  const eng = await employee('engineering'), next = await employee('engineering');
  const t = await task(core, 'engineering'), a = await core.claim(eng, t.id);
  writeFileSync(join(a.worktree!.worktreePath, 'source.txt'), 'expired dirty scene'); await Bun.sleep(1100);
  const recovery = coreFor(path), b = await recovery.claim(next, t.id); expect(b.fence).toBeGreaterThan(a.fence); expect(b.worktree!.worktreePath).toBe(a.worktree!.worktreePath);
  expect(readFileSync(join(b.worktree!.worktreePath, 'source.txt'), 'utf8')).toBe('expired dirty scene');
  await expect(core.checkpoint(eng, proof(a), { text: 'stale after takeover', idempotencyKey: 'managed-expired-stale' })).rejects.toBeDefined();
  await submit(recovery, next, b);
});

run('project-bound non-lease eval uses project repo and carries persistent project/default branch metadata', async () => {
  const path = repo(), opsPath = repo(), core = coreFor(opsPath), judge = await employee('eval');
  git(path, 'checkout', '-b', 'project-default'); writeFileSync(join(path, 'source.txt'), 'project baseline');
  git(path, 'add', '.'); git(path, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'project baseline'); git(path, 'checkout', 'main');
  const project = await new ProjectStore(db.db).upsert({ id: `fixture-project-${++count}`, name: 'Isolated worktree project', repoPath: path, defaultBranch: 'project-default', release: 'Fixture only', envs: [] });
  const goal = await core.relayGoal(gm, { text: 'Synthetic isolated project-scoped worktree verification goal', ownerQuote: 'Synthetic fixture owner instruction', project: project.id, tier: 'quick', idempotencyKey: `project-goal-${count}` });
  const t = await core.createTask(gm, { title: 'Project-scoped fixture', context: 'Local fixture only', executorRole: 'qa', reviewerRole: 'engineering', goalId: goal.id, idempotencyKey: `project-task-${count}` });
  const workspace = await core.readWorkspace(judge, t.id);
  expect(workspace!.repo).toBe(path); expect(workspace!.project).toBe(project.id); expect(workspace!.repo).not.toBe(opsPath);
  expect(readFileSync(join(workspace!.worktreePath, 'source.txt'), 'utf8')).toBe('project baseline');
  expect((await core.listWorktrees(gm)).find(w => w.id === workspace!.id)!.project).toBe(project.id);
  await core.releaseWorkspace(judge);
});

run('WT02: done exclusive is removed, shared retained; dirty exclusive kept with audit', async () => {
  const path = repo(), core = coreFor(path), eng = await employee('engineering'), eng2 = await employee('engineering');
  const sharedClaim = await core.claim(eng, (await task(core, 'engineering')).id);
  writeFileSync(join(sharedClaim.worktree!.worktreePath, 'source.txt'), 'shared writer');
  git(sharedClaim.worktree!.worktreePath, 'add', '.');
  git(sharedClaim.worktree!.worktreePath, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'shared change');
  // Keep first writer active so the second engineer gets exclusive.
  const exclusiveClaim = await core.claim(eng2, (await task(core, 'engineering')).id);
  expect(exclusiveClaim.worktree!.mode).toBe('exclusive');
  expect(exclusiveClaim.worktree!.worktreePath).not.toBe(sharedClaim.worktree!.worktreePath);
  writeFileSync(join(exclusiveClaim.worktree!.worktreePath, 'source.txt'), 'exclusive clean');
  git(exclusiveClaim.worktree!.worktreePath, 'add', '.');
  git(exclusiveClaim.worktree!.worktreePath, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'exclusive change');
  const exclusivePath = exclusiveClaim.worktree!.worktreePath;
  const sharedPath = sharedClaim.worktree!.worktreePath;
  await acceptDone(core, eng2, exclusiveClaim);
  expect(existsSync(exclusivePath)).toBe(false);
  expect(existsSync(sharedPath)).toBe(true);
  await acceptDone(core, eng, sharedClaim);
  expect(existsSync(sharedPath)).toBe(true);
  const inv = await core.listWorktrees(gm);
  expect(inv.find(w => w.worktreePath === sharedPath)).toBeTruthy();
  expect(inv.find(w => w.worktreePath === exclusivePath)).toBeUndefined();

  const dirtyEng = await employee('engineering'), dirtyPeer = await employee('engineering');
  const holder = await core.claim(dirtyEng, (await task(core, 'engineering')).id);
  const dirty = await core.claim(dirtyPeer, (await task(core, 'engineering')).id);
  expect(dirty.worktree!.mode).toBe('exclusive');
  writeFileSync(join(dirty.worktree!.worktreePath, 'wip.txt'), 'unsaved');
  await submit(core, dirtyPeer, dirty);
  const qa = await employee('qa');
  const review = await core.claim(qa, dirty.task.id);
  await core.accept(qa, proof(review), { text: 'Accept dirty exclusive fixture', idempotencyKey: `dirty-accept-${++count}` });
  expect(existsSync(dirty.worktree!.worktreePath)).toBe(true);
  const audits = await core.listWorktreeAudits(gm, 50);
  expect(audits.some(a => a.event === 'skip' && String(a.reason).includes('dirty'))).toBe(true);
  await submit(core, dirtyEng, holder);
}, 30000);

run('WT02: lease expire keeps recovery scene; orphan past grace reclaims managed legacy tree', async () => {
  const path = repo();
  const clock = { now: new Date('2026-10-10T12:00:00.000Z') };
  const core = new SurrealCompanyCore(db, { leaseSeconds: 1, worktrees: { opsRepo: path, now: () => clock.now } });
  const eng = await employee('engineering'), next = await employee('engineering');
  const t = await task(core, 'engineering');
  const a = await core.claim(eng, t.id);
  writeFileSync(join(a.worktree!.worktreePath, 'source.txt'), 'recovery scene');
  await Bun.sleep(1100);
  const invAfterExpire = await core.listWorktrees(gm);
  expect(invAfterExpire.find(w => w.id === a.worktree!.id)!.references.some(r => r.state === 'recovery' || r.state === 'active')).toBe(true);
  expect(existsSync(a.worktree!.worktreePath)).toBe(true);
  const b = await core.claim(next, t.id);
  expect(b.worktree!.worktreePath).toBe(a.worktree!.worktreePath);
  await acceptDone(core, next, b);

  // Adopt a legacy company-managed tree with no task refs and advance the authority clock past grace.
  const orphanPath = join(dir, `repo-orphan-task-${++count}`);
  const id8 = 'abcdef12';
  const legacyPath = join(dir, `legacy-task-${id8}`);
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', orphanPath]);
  writeFileSync(join(orphanPath, 'source.txt'), 'orphan-base');
  git(orphanPath, 'add', '.');
  git(orphanPath, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'orphan base');
  git(orphanPath, 'worktree', 'add', '-b', `task/${id8}`, legacyPath);
  const orphanCore = new SurrealCompanyCore(db, {
    worktrees: { opsRepo: orphanPath, orphanGraceDays: 7, now: () => clock.now },
  });
  await orphanCore.listWorktrees(gm); // reconcile as protected
  const legacyReal = realpathSync(legacyPath);
  const row = (await orphanCore.listWorktrees(gm)).find(w => w.worktreePath === legacyReal)!;
  expect(row.mode).toBe('protected');
  expect(row.deletable).toBe(false);
  const aged = new Date(clock.now.getTime() - 8 * 86_400_000).toISOString();
  await db.db.query('UPDATE ONLY $tree SET last_released_at = type::datetime($at), last_used_at = type::datetime($at);', {
    tree: new RecordId('worktree', row.id), at: aged,
  });
  const afterAge = (await orphanCore.listWorktrees(gm)).find(w => w.id === row.id)!;
  expect(afterAge.deletable).toBe(true);
  expect(afterAge.reasons).toContain('orphan-past-grace');
  const dry = await orphanCore.reclaimWorktrees(gm, { dryRun: true, repos: [orphanPath] });
  expect(dry.kept.some(k => k.path === legacyReal && k.reason.includes('dry-run'))).toBe(true);
  const reclaimed = await orphanCore.reclaimWorktrees(gm, { dryRun: false, repos: [orphanPath] });
  expect(reclaimed.removed).toContain(legacyReal);
  expect(existsSync(legacyPath)).toBe(false);
  const audits = await orphanCore.listWorktreeAudits(gm, 40);
  expect(audits.some(a => a.event === 'delete' && a.result === 'success')).toBe(true);
  expect(audits.some(a => a.event === 'dry_run')).toBe(true);
}, 30000);

run('WT02: review and returned-ready windows keep exclusive scene; release writes durable audit', async () => {
  const path = repo(), core = coreFor(path);
  const eng1 = await employee('engineering'), eng2 = await employee('engineering'), qa = await employee('qa');
  const holder = await core.claim(eng1, (await task(core, 'engineering')).id);
  expect(holder.worktree!.mode).toBe('shared');
  const c2 = await core.claim(eng2, (await task(core, 'engineering')).id);
  expect(c2.worktree!.mode).toBe('exclusive');
  const scene = c2.worktree!.worktreePath;
  writeFileSync(join(scene, 'source.txt'), 'review window work');
  git(scene, 'add', '.');
  git(scene, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'window work');

  // submit -> reviewer-claim window: a non-terminal 'review' task retains its exclusive scene.
  const submitted = await submit(core, eng2, c2);
  expect(submitted.state).toBe('review');
  const firstSweep = await core.reclaimWorktrees(gm, { repos: [path] });
  expect(firstSweep.removed).not.toContain(scene);
  expect(existsSync(scene)).toBe(true);
  let row = (await core.listWorktrees(gm)).find(w => w.id === c2.worktree!.id)!;
  expect(row.deletable).toBe(false);
  expect(row.reasons).toContain('unfinished-scene');
  expect(row.references.some(r => r.state === 'recovery')).toBe(true);

  // reviewer claim then return: the 'ready' + handover NONE window also retains the scene.
  const review = await core.claim(qa, submitted.id);
  expect(review.worktree!.worktreePath).toBe(scene);
  const returned = await core.returnTask(qa, proof(review), { text: 'Return keeps the non-terminal exclusive scene', idempotencyKey: `window-return-${++count}` });
  expect(returned.state).toBe('ready');
  expect(returned.handover).toBeUndefined();
  const secondSweep = await core.reclaimWorktrees(gm, { repos: [path] });
  expect(secondSweep.removed).not.toContain(scene);
  expect(existsSync(scene)).toBe(true);
  row = (await core.listWorktrees(gm)).find(w => w.id === c2.worktree!.id)!;
  expect(row.references.some(r => r.state === 'recovery')).toBe(true);

  // terminal 'done' releases the task ref: durable release audit precedes the clean removal.
  const resumed = await core.claim(eng2, returned.id);
  expect(resumed.worktree!.worktreePath).toBe(scene);
  const resubmitted = await submit(core, eng2, resumed);
  const qa2 = await employee('qa');
  const reReview = await core.claim(qa2, resubmitted.id);
  await core.accept(qa2, proof(reReview), { text: 'Accept after returned window', idempotencyKey: `window-accept-${++count}` });
  expect(existsSync(scene)).toBe(false);
  const audits = await core.listWorktreeAudits(gm, 100);
  const releases = audits.filter(a => a.event === 'release' && a.result === 'success');
  expect(releases.length).toBeGreaterThan(0);
  expect(releases.some(a => String(a.task).includes(submitted.id))).toBe(true);
  await submit(core, eng1, holder);
}, 30000);

run('WT02: reclaim disabled switch and concurrent claim under lock keep scene', async () => {
  const path = repo();
  const core = new SurrealCompanyCore(db, { worktrees: { opsRepo: path, reclaimEnabled: false } });
  const eng = await employee('engineering'), peer = await employee('engineering');
  const first = await core.claim(eng, (await task(core, 'engineering')).id);
  const second = await core.claim(peer, (await task(core, 'engineering')).id);
  expect(second.worktree!.mode).toBe('exclusive');
  writeFileSync(join(second.worktree!.worktreePath, 'source.txt'), 'kept while disabled');
  git(second.worktree!.worktreePath, 'add', '.');
  git(second.worktree!.worktreePath, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'exclusive');
  await acceptDone(core, peer, second);
  expect(existsSync(second.worktree!.worktreePath)).toBe(true);
  const inv = await core.listWorktrees(gm);
  expect(inv.find(w => w.id === second.worktree!.id)!.reasons).toContain('reclaim-disabled');
  await submit(core, eng, first);
}, 20000);

run('WT03: done event releases paseo scene and git tree at one point; scene failure keeps tree for retry', async () => {
  const path = repo();
  const calls: Array<{ path: string; existed: boolean }> = [];
  let fail = true;
  const core = new SurrealCompanyCore(db, { worktrees: { opsRepo: path, sceneCleaner: async (p) => {
    calls.push({ path: p, existed: existsSync(p) });
    if (fail) throw new Error('fixture paseo daemon down');
    return { workspacesArchived: 2, projectsDeleted: 1 };
  } } });
  const eng = await employee('engineering'), peer = await employee('engineering');
  await core.claim(eng, (await task(core, 'engineering')).id); // shared writer forces peer's exclusive tree
  const claim = await core.claim(peer, (await task(core, 'engineering')).id);
  expect(claim.worktree!.mode).toBe('exclusive');
  const scene = claim.worktree!.worktreePath;

  // Paseo side down: the delete point aborts atomically — git tree and row survive with a todo.
  await acceptDone(core, peer, claim);
  expect(existsSync(scene)).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({ path: scene, existed: true }); // scene teardown ran before any git remove
  const kept = (await core.listWorktrees(gm)).find(w => w.worktreePath === scene)!;
  expect(kept.reasons.some(r => r.includes('cleanup-todo:scene-cleanup-failed'))).toBe(true);
  expect((await core.listWorktreeAudits(gm, 50)).some(a => a.event === 'fail' && String(a.reason).includes('scene-cleanup-failed'))).toBe(true);

  // Paseo side back: the next event/sweep retries the whole point; all three layers die together.
  fail = false;
  const retried = await core.reclaimWorktrees(gm, { repos: [path] });
  expect(retried.removed).toContain(scene);
  expect(existsSync(scene)).toBe(false);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({ path: scene, existed: true });
  const audits = await core.listWorktreeAudits(gm, 50);
  expect(audits.some(a => a.event === 'scene_release' && a.result === 'success' && String(a.reason).includes('paseo-workspaces-archived:2'))).toBe(true);
  expect(audits.some(a => a.event === 'delete' && a.result === 'success')).toBe(true);
}, 30000);

run('WT03: return and releaseWorkspace evaluate their tree in place without harming live scenes', async () => {
  const path = repo(), core = coreFor(path);
  const eng1 = await employee('engineering'), eng2 = await employee('engineering'), qa = await employee('qa');
  const holder = await core.claim(eng1, (await task(core, 'engineering')).id); // keeps shared writer active
  const claim = await core.claim(eng2, (await task(core, 'engineering')).id);
  expect(claim.worktree!.mode).toBe('exclusive');
  const scene = claim.worktree!.worktreePath;
  await submit(core, eng2, claim);
  const review = await core.claim(qa, claim.task.id);
  const returned = await core.returnTask(qa, proof(review), { text: 'Return event point keeps recovery scene', idempotencyKey: `event-return-${++count}` });
  expect(returned.state).toBe('ready');
  // The returned scene still has a recovery ref: evaluated in place, kept on disk.
  expect(existsSync(scene)).toBe(true);
  expect((await core.listWorktreeAudits(gm, 50)).some(a => a.trigger === 'return' && a.event === 'skip' && String(a.reason).includes('unfinished-scene'))).toBe(true);

  // Session release runs the same single-tree evaluation; the shared tree is protected anyway.
  const judge = await employee('eval');
  const workspace = await core.readWorkspace(judge, claim.task.id);
  await core.releaseWorkspace(judge);
  expect((await core.listWorktreeAudits(gm, 50)).some(a => a.trigger === 'release' && a.event === 'skip' && String(a.reason).includes('shared-retained'))).toBe(true);
  expect((await core.listWorktrees(gm)).find(w => w.id === workspace!.id)).toBeTruthy();
  await submit(core, eng1, holder);
}, 30000);

run('WT03: channel rollback via core.release() keeps the scene for the next holder; terminal done still releases all three layers', async () => {
  const path = repo(), core = coreFor(path);
  const eng = await employee('engineering'), eng2 = await employee('engineering'), qa = await employee('qa');
  const holder = await core.claim(eng, (await task(core, 'engineering')).id); // keeps shared writer active
  const claim = await core.claim(eng2, (await task(core, 'engineering')).id);
  expect(claim.worktree!.mode).toBe('exclusive');
  const scene = claim.worktree!.worktreePath;

  // Channel-side claim rollback (sidecar.releaseClaim → core.release()): the rolled-back task
  // keeps its worktree reference, so the release event evaluates the scene in place and keeps it.
  const released = await core.release(eng2, proof(claim), { text: 'Fixture channel rollback without reviewer verdict', idempotencyKey: `event-release-${++count}` });
  expect(released.state).toBe('ready');
  expect(existsSync(scene)).toBe(true);
  expect((await core.listWorktreeAudits(gm, 50)).some(a => a.trigger === 'release' && a.event === 'skip' && String(a.path) === scene)).toBe(true);

  // The rolled-back task is claimable again on the same scene; the terminal done event is where
  // all three layers die together.
  const resumed = await core.claim(eng2, claim.task.id);
  expect(resumed.worktree!.worktreePath).toBe(scene);
  await submit(core, eng2, resumed);
  const review = await core.claim(qa, resumed.task.id);
  await core.accept(qa, proof(review), { text: 'Accept after channel rollback fixture', idempotencyKey: `event-release-accept-${++count}` });
  expect(existsSync(scene)).toBe(false);
  await submit(core, eng, holder);
}, 30000);

run('WT02: inventory no longer hard-disables deletion and exposes grace reasons', async () => {
  const path = repo(), core = coreFor(path), eng = await employee('engineering'), peer = await employee('engineering');
  const first = await core.claim(eng, (await task(core, 'engineering')).id);
  const exclusive = await core.claim(peer, (await task(core, 'engineering')).id);
  expect(exclusive.worktree!.mode).toBe('exclusive');
  await submit(core, peer, exclusive);
  const qa = await employee('qa');
  const review = await core.claim(qa, exclusive.task.id);
  await core.accept(qa, proof(review), { text: 'Accept to release exclusive refs', idempotencyKey: `inv-accept-${++count}` });
  const inv = await core.listWorktrees(gm);
  expect(inv.every(w => !w.reasons.includes('WT01: deletion disabled'))).toBe(true);
  const shared = inv.find(w => w.mode === 'shared');
  expect(shared?.deletable).toBe(false);
  expect(shared?.reasons.some(r => r === 'shared-retained' || r === 'active-reference')).toBe(true);
  await submit(core, eng, first);
}, 20000);
