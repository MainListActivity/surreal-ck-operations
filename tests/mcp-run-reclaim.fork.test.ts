import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { connectCompanyClient } from '../src/mcp/client.ts';
import type { ClaimResult, LeaseProof } from '../src/contracts.ts';

setDefaultTimeout(60000);
// Boots the real MCP process (src/mcp/run.ts) against an isolated company-fork SurrealDB and a
// fake paseo CLI, then drives GM reclaim_worktrees through the MCP HTTP surface: the git tree,
// the Paseo scene and the registry rows must die together. Same gate as the worktree fork tests.
const run = process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1' ? test : test.skip;
let dir: string, port: number, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, gm: string;
let count = 0;
const password = 'isolated-worktree-fixture-only';
const config = () => ({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: password, namespace: 'mcp_reclaim_fixture', database: 'control_plane' });
async function start() {
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', password, '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase(config()); await db.connect(); await db.bootstrap();
}
beforeAll(async () => {
  if (process.env.RUN_SCK_WORKTREE_FORK_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-mcp-reclaim-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') }); port = listener.port!; listener.stop(true);
  await start(); gm = await new LocalEnrollmentAdmin(db).enroll('mcp-reclaim-manager', 'owner', ['execute', 'review', 'manage']);
}, 20000);
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });
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
const proof = (claim: ClaimResult): LeaseProof => ({ taskId: claim.task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version });
async function submit(core: SurrealCompanyCore, credential: string, claim: ClaimResult) {
  return core.submit(credential, proof(claim), { text: 'Isolated fixture completion, scene untouched', idempotencyKey: `mcp-reclaim-submit-${++count}` });
}

/** Stand-in paseo CLI: serves a JSON state file and logs every invocation, so the test can prove
 * the MCP process reached the Paseo layer. Never touches a real daemon. */
function writeFakePaseo(): { bin: string; statePath: string; logPath: string } {
  const statePath = join(dir, `fake-paseo-${++count}.json`);
  const logPath = join(dir, `fake-paseo-${count}.log`);
  const bin = join(dir, `fake-paseo-${count}.ts`);
  writeFileSync(bin, `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2).filter(a => a !== '--json');
appendFileSync(process.env.FAKE_PASEO_LOG!, args.join(' ') + '\\n');
const state = JSON.parse(readFileSync(process.env.FAKE_PASEO_STATE!, 'utf8'));
const [kind, op, id] = args;
if (kind === 'workspace' && op === 'ls') console.log(JSON.stringify(state.workspaces.filter((w: { workspaceId: string }) => !state.archived.includes(w.workspaceId))));
else if (kind === 'workspace' && op === 'archive') { state.archived.push(id); writeFileSync(process.env.FAKE_PASEO_STATE!, JSON.stringify(state)); }
else if (kind === 'project' && op === 'ls') console.log(JSON.stringify(state.projects.filter((p: { projectId: string }) => !state.deleted.includes(p.projectId))));
else if (kind === 'project' && op === 'delete') { state.deleted.push(id); writeFileSync(process.env.FAKE_PASEO_STATE!, JSON.stringify(state)); }
else console.log('[]');
`);
  chmodSync(bin, 0o755);
  return { bin, statePath, logPath };
}

run('MCP process manual reclaim_worktrees tears git tree, Paseo scene and registry rows down together', async () => {
  const path = repo();
  // In-process core with reclaim disabled and no sceneCleaner: the retire event must not delete
  // anything here, so the MCP process's manual reclaim is the only possible remover below.
  const core = new SurrealCompanyCore(db, { worktrees: { opsRepo: path, reclaimEnabled: false } });
  const eng = await new LocalEnrollmentAdmin(db).enroll(`fixture-eng-${++count}`, 'engineering', ['execute', 'review']);
  const peer = await new LocalEnrollmentAdmin(db).enroll(`fixture-peer-${++count}`, 'engineering', ['execute', 'review']);
  const holder = await core.claim(eng, (await core.createTask(gm, { title: `MCP holder ${count}`, context: 'Isolated fixture task', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `mcp-holder-${count}` })).id);
  const task = await core.createTask(gm, { title: `MCP retire target ${count}`, context: 'Isolated fixture task to be retired', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `mcp-task-${count}` });
  const claim = await core.claim(peer, task.id);
  expect(claim.worktree!.mode).toBe('exclusive');
  const scene = claim.worktree!.worktreePath;
  const retired = await core.retireTask(gm, { taskId: task.id, text: '作废重复任务：现场只释放引用不删树', idempotencyKey: `mcp-retire-${++count}` });
  expect(retired.state).toBe('void');
  expect(existsSync(scene)).toBe(true); // reclaim disabled in-process: nothing died yet

  // Fake Paseo daemon state: one workspace and one project rooted at the task tree.
  const paseo = writeFakePaseo();
  writeFileSync(paseo.statePath, JSON.stringify({
    workspaces: [{ workspaceId: 'wks_scene', name: 'MCP fixture scene', cwd: scene }],
    projects: [{ projectId: 'prj_scene', name: 'MCP fixture project', path: scene }],
    archived: [], deleted: [],
  }));

  // Boot the real MCP process wired like production: fork SurrealDB + fake paseo binary.
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const mcpPort = listener.port!; listener.stop(true);
  const child = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'mcp', 'run.ts')], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, SCK_PRODUCT_ENV: '/dev/null', SCK_MCP_PORT: String(mcpPort),
      SURREAL_URL: `ws://127.0.0.1:${port}/rpc`, SURREAL_ROOT_USER: 'root', SURREAL_ROOT_PASS: password,
      SCK_COMPANY_NS: 'mcp_reclaim_fixture', SCK_COMPANY_DB: 'control_plane',
      SCK_AGENT_CWD: path, SCK_CREDENTIAL_DIR: join(dir, 'unused-credentials'), SCK_PASEO_BIN: paseo.bin,
      FAKE_PASEO_STATE: paseo.statePath, FAKE_PASEO_LOG: paseo.logPath },
  });
  // Drain both streams so service logs surface in failure output instead of wedging the pipe.
  const serviceLogs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    .then(([out, err]) => out + err);
  try {
    let up = false;
    for (let n = 0; n < 240; n++) {
      try { if ((await fetch(`http://127.0.0.1:${mcpPort}/ready`)).ok) { up = true; break; } } catch {}
      await Bun.sleep(50);
    }
    expect(up).toBe(true);

    // GM drives the manual reclaim through the MCP surface, scoped to this repo, no dry-run.
    const conn = await connectCompanyClient({ url: new URL(`http://127.0.0.1:${mcpPort}/mcp`), credential: gm, clientName: 'mcp-reclaim-fixture' });
    let removed: string[] = [];
    try {
      const result = await conn.client.callTool({ name: 'reclaim_worktrees', arguments: { repos: [path] } });
      const data = (result.structuredContent as { ok: boolean; data: { removed: string[] } }).data;
      removed = data.removed;
    } finally { await conn.close(); }
    expect(removed).toContain(scene);

    // Three layers, one process: Paseo workspace archived + project deleted, git tree gone, rows gone.
    const state = JSON.parse(readFileSync(paseo.statePath, 'utf8')) as { archived: string[]; deleted: string[] };
    expect(state.archived).toEqual(['wks_scene']);
    expect(state.deleted).toEqual(['prj_scene']);
    const log = readFileSync(paseo.logPath, 'utf8');
    expect(log).toContain('workspace ls');
    expect(log).toContain('workspace archive wks_scene');
    expect(log).toContain('project delete prj_scene');
    expect(existsSync(scene)).toBe(false);
    const [rows] = await db.db.query<[Array<{ id: RecordId }>]>('SELECT id FROM worktree WHERE path = $path;', { path: scene });
    expect(rows).toEqual([]);
    // The company fork's parser only orders by projected fields, so `at` rides along.
    const [audits] = await db.db.query<[Array<{ event: string; result: string; path: string; trigger: string }>]>(
      'SELECT event, result, path, trigger, at FROM worktree_audit WHERE path = $path ORDER BY at DESC;', { path: scene });
    expect(audits.some(a => a.trigger === 'manual' && a.event === 'scene_release' && a.result === 'success')).toBe(true);
    expect(audits.some(a => a.trigger === 'manual' && a.event === 'delete' && a.result === 'success')).toBe(true);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(5000).then(() => child.kill('SIGKILL'))]);
    if (process.env.SCK_MCP_FORK_DEBUG) console.error(`[mcp service logs]\n${await serviceLogs}`);
  }
  await submit(core, eng, holder);
}, 60000);
