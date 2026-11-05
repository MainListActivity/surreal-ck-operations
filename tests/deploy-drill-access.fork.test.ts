// SYS-INT AC05: the drill's authorization guards, driven through the real core against an isolated company fork.
//
// The drill is the tool that proves a rollback is isolated, so the right to start one is itself a security boundary:
// only the task holder (engineering) or gm may run it, and a refused caller must leave nothing behind — no drill root,
// no processes, no audit row. These tests drive core.deployDrillRun / deployDrillStatus directly against a real fork
// database (never production), with a registered ops repo so the plan validator has real commits to inspect.
//
// Every refusal is asserted twice: the error code, and the absence of the side effects a guard placed too late would
// have produced (a drill root under the service home, and an audit row for deploy_drill_run).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';

// Own isolated fork rather than the shared one: this file also runs inside the release gate, where no
// test-worktrees server exists.
const run = process.env.RUN_SCK_DRILL_ACCESS_TESTS === '1' || process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;

const UUID = () => crypto.randomUUID();
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, home: string;
let gm: string, engineer: string, peerEngineer: string, qa: string, product: string, evaluator: string;
let launched = 0;

const password = 'drill-access-fixture-only';

async function auditCount(): Promise<number> {
  const [rows] = await db.db.query<[Array<{ count: number }>]>("SELECT count() AS count FROM audit WHERE action = 'deploy_drill_run' GROUP ALL;");
  return rows[0]?.count ?? 0;
}
const drillRoots = () => existsSync(join(home, 'drills')) ? readdirSync(join(home, 'drills')) : [];

beforeAll(async () => {
  if (process.env.RUN_SCK_DRILL_ACCESS_TESTS !== '1' && process.env.RUN_SCK_CHANNEL_FORK_TESTS !== '1') return;
  dir = mkdtempSync(join(tmpdir(), 'drill-access-'));
  home = join(dir, 'service-home');
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root',
    '--pass', password, '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: password, namespace: 'drill_access_fixture', database: 'control_plane' });
  let ready = false;
  for (let n = 0; n < 240 && !ready; n++) { try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch {} if (!ready) await Bun.sleep(25); }
  expect(ready).toBe(true);
  await db.connect(); await db.bootstrap();
  // SCK_SERVICE_HOME names the drill root parent; core reads it for both run and status.
  process.env.SCK_SERVICE_HOME = home;
  // The launch seam stands in for the detached worker: these tests assert who may start a drill and what a refusal
  // leaves behind, not what the drill does once started (AC04 covers that with a real run).
  // The seam mirrors startDrill's one filesystem effect (it creates the drill root before spawning), so the
  // replay guard sees the same state a real launch leaves behind.
  shas();
  core = new SurrealCompanyCore(db, { companyReleaseRepo: opsRepo, drillLaunch: (_home, _repo, plan) => {
    mkdirSync(plan.root, { recursive: true }); launched += 1; return 4242;
  } });
  const enroll = new LocalEnrollmentAdmin(db);
  gm = await enroll.enroll('access-gm', 'owner', ['execute', 'review', 'manage']);
  engineer = await enroll.enroll('access-eng-holder', 'engineering', ['execute', 'review']);
  peerEngineer = await enroll.enroll('access-eng-peer', 'engineering', ['execute', 'review']);
  qa = await enroll.enroll('access-qa', 'qa', ['execute', 'review']);
  product = await enroll.enroll('access-product', 'product', ['execute', 'review', 'manage']);
  evaluator = await enroll.enroll('access-eval', 'eval', ['execute', 'review']);
}, 60_000);

afterAll(async () => {
  if (!dir) return;
  delete process.env.SCK_SERVICE_HOME;
  await db?.close(); server?.kill(); await server?.exited;
  rmSync(dir, { recursive: true, force: true });
});

/** A task with a real engineering holder, in doing state, plus that holder's own credential. */
async function heldTask(key: string): Promise<{ taskId: string; runId: string; baseSha: string; candidateSha: string; holder: string }> {
  const created = await core.createTask(gm, { title: `drill access ${key}`, context: 'isolated drill access fixture',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `drill-access-${key}` });
  // One lease per employee at a time, so each fixture holder is its own engineering employee.
  const holder = await new LocalEnrollmentAdmin(db).enroll(`access-holder-${key}`, 'engineering', ['execute', 'review']);
  await core.claim(holder, created.id);
  return { taskId: created.id, runId: UUID(), baseSha: shas().base, candidateSha: shas().candidate, holder };
}
// A self-contained fixture repo: the gate runs this file from an extracted release tree, which has no .git, so
// reading the real history would make the test depend on where it runs. Two commits are enough for the plan
// validator's ancestry and commit-existence checks.
let shasCache: { base: string; candidate: string } | undefined;
function shas() {
  if (!shasCache) {
    const repo = join(dir, 'ops-repo');
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', ...args], { stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'candidate.txt'), 'candidate\n');
    git('add', '.'); git('commit', '-qm', 'candidate');
    const candidate = git('rev-parse', 'HEAD');
    opsRepo = repo;
    shasCache = { base, candidate };
  }
  return shasCache;
}
let opsRepo = '';
const input = (t: { taskId: string; runId: string; baseSha: string; candidateSha: string }) => ({
  taskId: t.taskId, runId: t.runId, baseSha: t.baseSha, candidateSha: t.candidateSha, idempotencyKey: `drill-${t.runId}`,
});

run('a non-holder engineering caller is refused before any process, file or audit side effect', async () => {
  const t = await heldTask('peer');
  const audits = await auditCount();
  const roots = drillRoots();
  await expect(core.deployDrillRun(peerEngineer, input(t))).rejects.toMatchObject({ code: 'forbidden' });
  expect(await auditCount()).toBe(audits);
  expect(drillRoots()).toEqual(roots);
  expect(existsSync(join(home, 'drills', t.runId))).toBe(false);
});

run('product, qa and eval callers are refused, each with no side effect', async () => {
  const t = await heldTask('roles');
  const audits = await auditCount();
  const roots = drillRoots();
  for (const credential of [product, qa, evaluator]) {
    await expect(core.deployDrillRun(credential, input(t))).rejects.toMatchObject({ code: 'forbidden' });
  }
  expect(await auditCount()).toBe(audits);
  expect(drillRoots()).toEqual(roots);
  expect(existsSync(join(home, 'drills', t.runId))).toBe(false);
});

run('the real task holder and gm may start a drill; the audit row is written only then', async () => {
  const holderTask = await heldTask('holder');
  const before = await auditCount();
  const launchesBefore = launched;
  const started = await core.deployDrillRun(holderTask.holder, input(holderTask));
  expect(started.runId).toBe(holderTask.runId);
  expect(started.root).toBe(join(home, 'drills', holderTask.runId));
  expect(await auditCount()).toBe(before + 1);
  const gmTask = await heldTask('owner');
  const gmStarted = await core.deployDrillRun(gm, input(gmTask));
  expect(gmStarted.runId).toBe(gmTask.runId);
  expect(await auditCount()).toBe(before + 2);
  // The launch seam ran exactly twice: a refusal never reaches it.
  expect(launched - launchesBefore).toBe(2);
  // A second run with the same runId is a replay: refused, and it must not add another audit row, launch, or root.
  await expect(core.deployDrillRun(holderTask.holder, input(holderTask))).rejects.toMatchObject({ code: 'conflict' });
  expect(await auditCount()).toBe(before + 2);
  expect(launched - launchesBefore).toBe(2);
}, 120_000);

run('drill status is readable by engineering, gm, qa and product, and refused for the other roles', async () => {
  const t = await heldTask('status');
  const launchesBefore = launched;
  const started = await core.deployDrillRun(t.holder, input(t));
  expect(launched - launchesBefore).toBe(1);
  for (const credential of [t.holder, gm, qa, product]) {
    const status = await core.deployDrillStatus(credential, { runId: started.runId });
    // The state file is written by the detached worker; the read itself must answer without throwing.
    expect(status).toBeDefined();
  }
  await expect(core.deployDrillStatus(evaluator, { runId: started.runId })).rejects.toMatchObject({ code: 'forbidden' });
  // Reading status never starts anything.
  expect(launched - launchesBefore).toBe(1);
}, 120_000);
