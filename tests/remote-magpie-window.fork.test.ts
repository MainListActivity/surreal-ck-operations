// Company fork regression for the remote-magpie window: candidates are produced and checked through the
// real OpsBroker, a real company database and the fork binary. Gated like the other fork suites:
//   RUN_COMPANY_PROOF_FORK_TESTS=1 bun test tests/remote-magpie-window.fork.test.ts
// The remote gateway is a synthetic fetcher; no real credential, endpoint or model is touched.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { ProjectStore } from '../src/projects.ts';
import { OpsBroker } from '../src/ops/broker.ts';
import { CompanyProofStore } from '../src/ops/proof-store.ts';
import type { OpsScope } from '../src/contracts.ts';
import { MAGPIE_EXECUTION_HEADROOM_SECONDS, PROOF_GOAL } from '../src/ops/proof-contract.ts';
import { remoteConfigurationDigest, remoteMagpieEvidenceSchema } from '../src/ops/remote-magpie-evidence.ts';
import { brokerConfig, FakeWorld } from './support/ops-world.ts';

const enabled = process.env.RUN_COMPANY_PROOF_FORK_TESTS === '1';
const check = test.skipIf(!enabled);
const key = Buffer.alloc(32, 23); // synthetic sealing key, no real service credentials
const provider = { id: 'remote-magpie', chat: 'https://remote.test/ofm/v1', key: 'synthetic-remote-key' };
const BUDGET = { currency: 'USD' as const, totalNanoUsd: 5_000_000, perAttemptNanoUsd: 500_000, maxAttempts: 3 };
const ACCOUNT_USER = 'synthetic-remote-account';

let dir: string, url: string, child: ReturnType<typeof Bun.spawn>, database: CompanyDatabase;
let core: SurrealCompanyCore, projects: ProjectStore, ops: OpsBroker, world: FakeWorld;
let clock = Date.parse('2026-10-29T03:00:00Z');
const now = () => clock;
let gm: string, author: string, approver: string, windowTask: string, windowCredential: string;
/** 第二阶段目标：窗口绑定登记对它与 PROOF_GOAL 放行；内部 AI proof 链仍只认 PROOF_GOAL。 */
const PHASE_TWO_GOAL = 'e159e40ad4e50080';
const OUTSIDE_GOAL = 'f0f0f0f0f0f0f0f0';
let phaseTwoTask: string, outsideTask: string, phaseTwoAuthor: string, outsideAuthor: string;

async function start() {
  const binary = join(homedir(), '.surrealdb/surreal');
  child = Bun.spawn([binary, 'start', '--no-banner', '--log', 'none', '--bind', url.replace('ws://', ''), '--user', 'root', '--pass', 'root', 'rocksdb:' + join(dir, 'db')], { stdout: 'ignore', stderr: 'ignore' });
  for (let i = 0; i < 100; i++) { const p = Bun.spawn([binary, 'is-ready', '--endpoint', url], { stdout: 'ignore', stderr: 'ignore' }); if (await p.exited === 0) return; await Bun.sleep(50); }
  throw new Error('company fork unavailable');
}
async function connect() {
  database = new CompanyDatabase({ url: url + '/rpc', rootUser: 'root', rootPassword: 'root', namespace: 'remote_window_test', database: 'control_plane' });
  await database.connect(); await database.bootstrap(); core = new SurrealCompanyCore(database); projects = new ProjectStore(database.db);
}
async function stop() { await database.close(); child.kill(); await child.exited; }

/** A remote gateway that states models, quotas and one matching usage row, with no revision, digest or expiry. */
function remoteFetch(opts: { catalogPricing?: boolean } = {}) {
  return async (input: string | URL | Request) => {
    const text = String(input);
    const at = new Date(clock).toISOString();
    if (text.endsWith('/models')) return Response.json({ data: [{ id: 'group/work' }, { id: 'sn/deepseek', ...(opts.catalogPricing === false ? {} : { pricing: { prompt: '0', completion: '0' } }) }] });
    if (text.endsWith('/quotas')) return Response.json({ data: [{ provider: 'sn', user: ACCOUNT_USER, kind: 'subscription', windows: [{ name: 'daily', remaining: 50, resetsAt: '2026-10-30T00:00:00Z' }], readAt: at }] });
    return Response.json({ total: 1, rows: [{ req: 'group/work', served: 'deepseek', provider: 'sn', providerAccount: ACCOUNT_USER, status: 200, stop: 'stop', ms: 2000, in: 500, out: 50, priced: false, cost: 0, route_id: 123, response_id: 'resp-1', t: at }] });
  };
}

// One broker serves the whole suite. Its observation store is what the window check trusts, so replacing
// the broker would drop the observations behind existing candidates. Only the approvals source changes.
let approvals: unknown[] = [];
function broker() {
  const remote = remoteFetch();
  ops = new OpsBroker({
    core, projects, secretKey: () => key, serviceHome: dir, now,
    proofStore: new CompanyProofStore(database.db, now),
    fetch: (input, init) => (String(input).startsWith(provider.chat) ? remote(input) : world.fetch(input, init)) as never,
    magpie: {
      readProductProvider: () => provider,
      remotePriceApprovals: () => approvals as never,
    },
  });
}

async function candidate(args: Record<string, unknown> = {}) {
  return await ops.call(author, windowTask, 'ops_product_magpie_candidate', args) as { candidateFile: string; candidate: any };
}
async function windowOf(file: string, approvalTask = windowTask) {
  return await ops.call(author, windowTask, 'ops_magpie_window_prepare', { approvalTask, candidatePath: file }) as Record<string, any>;
}
/** Candidate and window calls under another task, for the goal-scope regression. */
async function candidateUnder(credential: string, taskId: string, args: Record<string, unknown> = {}) {
  return await ops.call(credential, taskId, 'ops_product_magpie_candidate', args) as { candidateFile: string; candidate: any };
}
async function windowUnder(credential: string, taskId: string, file: string, approvalTask = taskId) {
  return await ops.call(credential, taskId, 'ops_magpie_window_prepare', { approvalTask, candidatePath: file }) as Record<string, any>;
}
/** Recomputes the digest after an edit. The function is public, so a forger can always do this. */
function recompute(body: Record<string, unknown>) {
  const { configurationDigest: _old, ...rest } = body;
  return { ...rest, configurationDigest: remoteConfigurationDigest(rest as never) };
}
async function writeCopy(file: string, edited: unknown) {
  const copy = file.replace(/\.json$/, `-edited-${randomUUID()}.json`);
  await writeFile(copy, JSON.stringify(edited));
  return copy;
}
const approvalFor = (c: { configurationDigest: string; pricing: { priceRevision: string | null } }, who = approver) =>
  ({ approverEmployee: who, configurationDigest: c.configurationDigest, priceRevision: c.pricing.priceRevision!, approvedAt: '2026-10-29T02:50:00Z' });
const evidence = (what: string) => ({ text: `${what} — long enough to satisfy the evidence validation`, idempotencyKey: randomUUID() });
/** Puts a fixture task into the blocked-to-gm state a manager resumes, with the approval task as its dependency. */
async function blockedDependingOn(taskId: string, approvalTask: string, dependent = true) {
  await database.db.query("UPDATE $task SET state='blocked', blocked_to='owner', resume_state='doing', dependencies=[$dep];", { task: new RecordId('task', taskId), dep: new RecordId('task', approvalTask) });
  if (!dependent) await database.db.query("UPDATE $task SET dependencies=[];", { task: new RecordId('task', taskId) });
}
/** The binding checks mark the approval task done; each check starts by putting it back so ops calls stay allowed. */
const approvalDoing = () => database.db.query("UPDATE $dep SET state='doing';", { dep: new RecordId('task', windowTask) });
const approvalDone = () => database.db.query("UPDATE $dep SET state='done';", { dep: new RecordId('task', windowTask) });
/** Phase-two fixture task back to doing so later ops calls and the registration lease stay allowed. */
const phaseTwoDoing = () => database.db.query("UPDATE $t SET state='doing';", { t: new RecordId('task', phaseTwoTask) });
const newSource = () => core.createTask(gm, { title: 'Window binding source', context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', tag: PROOF_GOAL, idempotencyKey: randomUUID() });
const bindWindow = (candidate: { configurationDigest: string; expiry: { expiresAt: string } }, approvalTask = windowTask) => ({ approvalTask, configurationDigest: candidate.configurationDigest, evidenceExpiresAt: candidate.expiry.expiresAt, minRemainingSeconds: MAGPIE_EXECUTION_HEADROOM_SECONDS, notAfter: new Date(Date.parse(candidate.expiry.expiresAt) - MAGPIE_EXECUTION_HEADROOM_SECONDS * 1000).toISOString() });

beforeAll(async () => {
  if (!enabled) return;
  dir = await realpath(await mkdtemp(join(tmpdir(), 'remote-magpie-window-fork-')));
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address() as { port: number }; s.close(() => resolve(a.port)); }); });
  url = 'ws://127.0.0.1:' + port; await start(); await connect();
  const enroll = new LocalEnrollmentAdmin(database);
  gm = await enroll.enroll('test-gm', 'owner', ['execute', 'review', 'manage']);
  author = await enroll.enroll('test-author', 'engineering', ['execute', 'review']);
  approver = 'test-approver';
  await enroll.enroll(approver, 'qa', ['execute', 'review']);
  await projects.upsert({ id: 'surreal_ck', name: 'synthetic', repoPath: dir, release: 'synthetic', envs: [{ name: 'production', broker: brokerConfig() }] });
  await database.db.query('CREATE $goal CONTENT {state:"active",project:$project,anchors:[],tasks:{}};', { goal: new RecordId('goal', PROOF_GOAL), project: new RecordId('project', 'surreal_ck') });
  // A phase-two goal and a goal outside the allowlist: both hold a task the author claims, so the ops calls
  // reach the registration lease instead of failing on claim or project checks.
  for (const goalId of [PHASE_TWO_GOAL, OUTSIDE_GOAL]) await database.db.query('CREATE $goal CONTENT {state:"active",project:$project,anchors:[],tasks:{}};', { goal: new RecordId('goal', goalId), project: new RecordId('project', 'surreal_ck') });
  const phaseTwo = await core.createTask(gm, { title: 'Phase-two remote window preparation', context: 'Only test fixtures', executorRole: 'engineering', reviewerRole: 'qa', tag: PHASE_TWO_GOAL, idempotencyKey: randomUUID() });
  phaseTwoTask = phaseTwo.id;
  // An employee can hold one active task at a time, so each fixture goal gets its own holder.
  phaseTwoAuthor = await enroll.enroll('test-phase-two-author', 'engineering', ['execute', 'review']);
  await core.claim(phaseTwoAuthor, phaseTwo.id);
  const outside = await core.createTask(gm, { title: 'Goal outside the allowlist', context: 'Only test fixtures', executorRole: 'engineering', reviewerRole: 'qa', tag: OUTSIDE_GOAL, idempotencyKey: randomUUID() });
  outsideTask = outside.id;
  outsideAuthor = await enroll.enroll('test-outside-author', 'engineering', ['execute', 'review']);
  await core.claim(outsideAuthor, outside.id);
  world = new FakeWorld(); world.clock = clock;
  await projects.setSecret({ project: 'surreal_ck', env: 'production', name: 'SUPPLIER_SNV_FORK_USERNAME', value: world.magpie.accountUser }, key);
  await projects.setSecret({ project: 'surreal_ck', env: 'production', name: 'SUPPLIER_SNV_FORK_PASSWORD', value: 'synthetic-magpie-password' }, key);
  const task = await core.createTask(gm, { title: 'Synthetic remote window preparation', context: 'Only test fixtures', executorRole: 'engineering', reviewerRole: 'qa', tag: PROOF_GOAL, idempotencyKey: randomUUID() });
  windowTask = task.id;
  windowCredential = author;
  await core.claim(author, task.id);
  broker();
}, 30_000);

beforeEach(() => { approvals = []; });

afterAll(async () => {
  if (enabled) {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});

check('null+gap candidate from the real broker passes the schema and writes no invented revision, digest or expiry', async () => {
  const out = await candidate({ budget: BUDGET });
  const onDisk = JSON.parse(await readFile(out.candidateFile, 'utf8'));
  expect(remoteMagpieEvidenceSchema.safeParse(onDisk).success).toBe(true);
  expect(onDisk.route).toMatchObject({ revision: null, digest: null, expiresAt: null });
  expect(onDisk.observation.routingConfigurationVerified).toBe(false);
  expect(onDisk.route.gaps.map((g: { field: string }) => g.field)).toEqual(['revision', 'digest', 'maxOutputTokens', 'expiresAt']);
});

check('a null+gap candidate with no price approval stays closed on price-not-reviewed, and passes once a different employee approves its digest', async () => {
  const out = await candidate({ budget: BUDGET });
  approvals = [];
  const closed = await windowOf(out.candidateFile);
  expect(closed.eligible).toBe(false);
  expect(closed.blockedReasons).toEqual(['price-not-reviewed']);
  approvals = [approvalFor(out.candidate)];
  const open = await windowOf(out.candidateFile);
  expect(open.eligible).toBe(true);
  expect(open.window.minRemainingSeconds).toBe(MAGPIE_EXECUTION_HEADROOM_SECONDS);
});

check('the real price-approval writer refuses self-approval and keeps the window on the broker record, with no injected approvals', async () => {
  // No injected approvals: only a recorded writer approval could open the window, and the author cannot write one.
  approvals = [];
  const out = await candidate({ budget: BUDGET });
  const self = await ops.call(author, windowTask, 'ops_product_magpie_price_approve', { candidatePath: out.candidateFile }).catch((e: { code?: string }) => e);
  expect((self as { code?: string }).code).toBe('self_review');
  const closed = await windowOf(out.candidateFile);
  expect(closed.eligible).toBe(false);
  expect(closed.blockedReasons).toEqual(['price-not-reviewed']);
});

check('an expiry moved to the next day, with a recomputed digest and a second employee approval, is refused', async () => {
  const out = await candidate({ budget: BUDGET });
  approvals = [approvalFor(out.candidate)];
  const edited = recompute({ ...out.candidate, expiry: { ...out.candidate.expiry, expiresAt: '2026-10-30T03:00:00.000Z', sourceExpiresAt: [...out.candidate.expiry.sourceExpiresAt, '2026-10-30T03:00:00.000Z'] } });
  const result = await windowOf(await writeCopy(out.candidateFile, edited));
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('expiry-not-from-observation');
  expect(result.blockedReasons).not.toContain('candidate-digest-mismatch');
});

check('forged route revision, digest and expiry on a null route, recomputed, with a second approval, is refused', async () => {
  const out = await candidate({ budget: BUDGET });
  approvals = [approvalFor(out.candidate)];
  const edited = recompute({ ...out.candidate, route: { ...out.candidate.route, revision: 'r-forged', digest: 'a'.repeat(64), expiresAt: '2030-01-01T00:00:00.000Z', gaps: [] } });
  const result = await windowOf(await writeCopy(out.candidateFile, edited));
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('route-not-from-observation');
});

check('an unreviewed or forged price stays closed, and a price approval cannot authorise a changed price field', async () => {
  const out = await candidate({ budget: BUDGET });
  approvals = [approvalFor(out.candidate)];
  const edited = recompute({ ...out.candidate, pricing: { ...out.candidate.pricing, rawPrompt: '0.000001', priceRevision: 'remote-magpie-catalog-forged' } });
  const result = await windowOf(await writeCopy(out.candidateFile, edited), windowTask);
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('candidate-not-from-observation');
});

check('evidence with less than the 5400 second execution headroom is closed, not extended', async () => {
  const out = await candidate({ budget: BUDGET });
  approvals = [approvalFor(out.candidate)];
  const tight = recompute({ ...out.candidate, expiry: { ...out.candidate.expiry, expiresAt: new Date(clock + (MAGPIE_EXECUTION_HEADROOM_SECONDS - 1) * 1000).toISOString() } });
  const result = await windowOf(await writeCopy(out.candidateFile, tight));
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('insufficient-headroom');
});

check('an expired candidate is refused, and a later window never extends it', async () => {
  const out = await candidate({ budget: BUDGET });
  approvals = [approvalFor(out.candidate)];
  const before = clock;
  clock = Date.parse(out.candidate.expiry.expiresAt) + 1000;
  try {
    const result = await windowOf(out.candidateFile);
    expect(result.eligible).toBe(false);
    expect(result.blockedReasons).toContain('evidence-expired');
  } finally {
    clock = before;
  }
});

check('a missing sampling budget keeps the window closed on budget-missing', async () => {
  const out = await candidate();
  approvals = [approvalFor(out.candidate)];
  const result = await windowOf(out.candidateFile);
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('budget-missing');
});

check('an old 30-attempt cycle or an old approval for a different digest cannot be referenced', async () => {
  const out = await candidate({ budget: BUDGET });
  const oldApproval = { ...approvalFor(out.candidate), configurationDigest: 'c'.repeat(64), approvedAt: '2026-10-01T00:00:00Z' };
  approvals = [oldApproval];
  const result = await windowOf(out.candidateFile);
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toEqual(['price-not-reviewed']);
  expect(result.window).toBeUndefined();
});

check('a candidate that this broker process never observed is refused as observation-untrusted', async () => {
  const out = await candidate({ budget: BUDGET });
  // A broker restarted after the observation holds no trusted copy, so the same candidate file must fail closed.
  const restarted = new OpsBroker({ core, projects, secretKey: () => key, serviceHome: dir, now, fetch: (input, init) => world.fetch(input, init) as never, magpie: { readProductProvider: () => provider, remotePriceApprovals: () => [approvalFor(out.candidate)] } });
  const result = await restarted.call(author, windowTask, 'ops_magpie_window_prepare', { approvalTask: windowTask, candidatePath: out.candidateFile }) as Record<string, any>;
  expect(result.eligible).toBe(false);
  // Without a trusted author no approval can count as independent, so the price gate is also closed.
  expect(result.blockedReasons).toContain('observation-untrusted');
  expect(result.blockedReasons).toContain('price-not-reviewed');
});

check('an author edited to the approver and re-digested is refused on candidate-author-mismatch', async () => {
  const out = await candidate({ budget: BUDGET });
  approvals = [approvalFor(out.candidate)];
  // The file now names the approver as author. Its digest is recomputed, so only the trusted author check can refuse it.
  const edited = recompute({ ...out.candidate, author: approver });
  const result = await windowOf(await writeCopy(out.candidateFile, edited));
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('candidate-author-mismatch');
  expect(result.blockedReasons).not.toContain('candidate-digest-mismatch');
  expect(result.window).toBeUndefined();
});

check('the original author cannot self-approve an unedited candidate, and it stays price-not-reviewed', async () => {
  const out = await candidate({ budget: BUDGET });
  // Only the author's own approval is on the table.
  approvals = [{ ...approvalFor(out.candidate, out.candidate.author) }];
  const result = await windowOf(out.candidateFile);
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toEqual(['price-not-reviewed']);
});

// ---- window binding: an eligible remote candidate becomes the approval candidate resume can bind ----
// The resume checks use the wall clock, so these checks sample at real time instead of the fixed fixture clock.

