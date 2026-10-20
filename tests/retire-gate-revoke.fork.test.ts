import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { CompanyError } from '../src/core-errors.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import { createSceneCleaner, type PaseoGateway } from '../src/dispatcher/paseo.ts';
import type { ClaimResult, TaskView } from '../src/contracts.ts';

// SYS-DISP f517e2e4 (R1, F-A, F-B, F-D). The credential revocation passes the same retirement gate as the retirement itself, the
// scene cleaner holds back the tree teardown on every failed employee retirement, and review-phase refusals never recommend a takeover. Real core, real Workforce,
// real LocalEnrollmentAdmin and the real admin entry point, on the company fork. Own namespace.
const NS = 'sck_agent_company_test_retire_revoke';
const repoRoot = join(import.meta.dir, '..');
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(180_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-retire-revoke-'));
const workforce = new Workforce(database, credDir);
const enrollment = new LocalEnrollmentAdmin(database);
const core = new SurrealCompanyCore(database, { workforce });
const gm = 'rv-gm';
let gmToken = '';
const people = new Map<string, string>();
let seq = 0;

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  gmToken = await enrollment.enroll(gm, 'gm', ['execute', 'review', 'manage']);
});

afterAll(async () => {
  await database.close();
  rmSync(credDir, { recursive: true, force: true });
});

type Refusal = { code?: string; message?: string; details?: { employeeId?: string; reasons: Array<Record<string, unknown>>; legalActions: string[] } };

const key = () => crypto.randomUUID();
/** Race rounds per concurrency case. Both sides start after a random delay, so either order of the two writes occurs. */
const RACE_ROUNDS = 24;
const jitter = () => Bun.sleep(Math.floor(Math.random() * 12));
const WHY = 'R1 retirement gate test: synthetic reason, long enough for the audit text.';
const DELIVERY = 'Synthetic delivery evidence for the SYS-DISP R1 revocation gate test, long enough for the write gate.';
const REVIEW = 'Independent synthetic review evidence for the SYS-DISP R1 revocation gate test, long enough for the write gate.';
const proofOf = (claim: ClaimResult) => ({ taskId: claim.task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version });
const newTask = (title: string) => core.createTask(gmToken, { title, context: 'synthetic SYS-DISP R1 revocation gate case',
  executorRole: 'engineering', reviewerRole: 'engineering', idempotencyKey: key() });
const task = (taskId: string): Promise<TaskView> => core.getTask(gmToken, taskId);
const tokenOf = (employee: string) => people.get(employee)!;
async function engineer(label: string): Promise<string> {
  seq += 1;
  const employee = `rv-${label}-${seq}`;
  people.set(employee, await enrollment.enroll(employee, 'engineering', ['execute', 'review']));
  return employee;
}
const employeeRef = (employee: string) => new RecordId('employee', employee);
const rowOf = async (employee: string): Promise<Record<string, unknown>> =>
  (await database.db.select<Record<string, unknown>>(employeeRef(employee))) ?? {};
const isRetired = async (employee: string) => (await rowOf(employee)).retired === true;
const isRevoked = async (employee: string) => (await rowOf(employee)).revoked === true;

/** The refusal the gate must raise. Resolves to the caught error so the test can read its stable code and details. */
async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'retire_refused' });
  return error as Refusal;
}

/** Runs the real admin entry point as a child process, on the same isolated namespace. */
async function runAdmin(args: string[]) {
  const proc = Bun.spawn([process.execPath, 'src/admin.ts', ...args], {
    cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, SCK_COMPANY_NS: NS, SCK_COMPANY_DB: 'control_plane', SCK_CREDENTIAL_DIR: credDir },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
}

test('revoke: an active lease refuses the admin revocation before any write', async () => {
  const holder = await engineer('lease');
  const t = await newTask('RV1 active lease');
  const claim = await core.claim(tokenOf(holder), t.id);
  const before = await task(t.id);
  const digest = (await rowOf(holder)).credential_digest;
  const error = await refusal(enrollment.revoke(holder));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, state: 'doing', phase: 'execute', reason: 'active_lease' })]);
  expect(error.details?.legalActions.length).toBeGreaterThan(0);
  expect(await isRevoked(holder)).toBe(false);
  expect((await rowOf(holder)).security_revoked).not.toBe(true);
  expect((await rowOf(holder)).credential_digest).toBe(digest);
  expect(await task(t.id)).toMatchObject({ state: 'doing', currentEmployee: holder, fence: claim.fence, version: before.version, deliveryId: before.deliveryId });
});

test('revoke: a bound implementer of ready rework is refused and keeps its credential', async () => {
  const author = await engineer('rework');
  const reviewer = await engineer('rework-reviewer');
  const t = await newTask('RV2 rework');
  const first = await core.claim(tokenOf(author), t.id);
  await core.submit(tokenOf(author), proofOf(first), { text: DELIVERY, idempotencyKey: key() });
  const review = await core.claim(tokenOf(reviewer), t.id);
  await core.returnTask(tokenOf(reviewer), proofOf(review), { text: REVIEW, idempotencyKey: key() });
  expect(await task(t.id)).toMatchObject({ state: 'ready', implementer: author });
  const digest = (await rowOf(author)).credential_digest;
  const error = await refusal(enrollment.revoke(author));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, state: 'ready', phase: 'execute', reason: 'bound_implementer' })]);
  expect(await isRevoked(author)).toBe(false);
  expect((await rowOf(author)).credential_digest).toBe(digest);
});

test('revoke: no in-flight relation writes the security revocation, keeps it a security revocation, and repeats idempotently', async () => {
  const idle = await engineer('idle');
  await expect(enrollment.revoke(idle)).resolves.toBeUndefined();
  expect(await rowOf(idle)).toMatchObject({ revoked: true, security_revoked: true });
  expect((await rowOf(idle)).retired).not.toBe(true);
  expect((await rowOf(idle)).retired_kind).toBeUndefined();
  await expect(enrollment.revoke(idle)).resolves.toBeUndefined();
  expect(await rowOf(idle)).toMatchObject({ revoked: true, security_revoked: true });
});

test('revoke: the admin revoke command refuses an employee with an active lease: exit 1, stable code, nothing written', async () => {
  const holder = await engineer('cli-lease');
  const t = await newTask('RV4 cli revoke');
  await core.claim(tokenOf(holder), t.id);
  const digest = (await rowOf(holder)).credential_digest;
  const run = await runAdmin(['revoke', holder]);
  expect(run.exitCode).not.toBe(0);
  expect(`${run.stdout}\n${run.stderr}`).toContain('retire_refused');
  expect(await isRevoked(holder)).toBe(false);
  expect((await rowOf(holder)).credential_digest).toBe(digest);
});

test('revoke: a claim that lands after the revocation decision is caught by the write, and the claim keeps its lease', async () => {
  const target = await engineer('decision-hook');
  const t = await newTask('RV5 decision hook');
  let armed = true;
  // The hook runs between the decision and the write, the same seam the retirement race tests use.
  const hooked = new LocalEnrollmentAdmin(database, async employeeId => {
    if (!armed || employeeId !== target) return;
    armed = false;
    await core.claim(tokenOf(target), t.id);
  });
  const error = await refusal(hooked.revoke(target));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, reason: 'active_lease' })]);
  expect(await isRevoked(target)).toBe(false);
  expect(await task(t.id)).toMatchObject({ state: 'doing', currentEmployee: target });
});

test('revoke racing a claim: never both succeed, and a live lease holder is never revoked', async () => {
  for (let round = 0; round < RACE_ROUNDS; round++) {
    const racer = await engineer(`race-${round}`);
    const t = await newTask(`RV6 race ${round}`);
    const results = await Promise.allSettled([
      jitter().then(() => core.claim(tokenOf(racer), t.id)),
      jitter().then(() => enrollment.revoke(racer)),
    ]);
    const claimed = results[0].status === 'fulfilled';
    const revoked = results[1].status === 'fulfilled';
    expect(claimed && revoked).toBe(false);
    if (claimed) {
      expect(await isRevoked(racer)).toBe(false);
      expect(results[1].status === 'rejected' && results[1].reason).toMatchObject({ code: 'retire_refused' });
      expect(await task(t.id)).toMatchObject({ state: 'doing', currentEmployee: racer });
    } else if (revoked) {
      expect(await isRevoked(racer)).toBe(true);
    }
  }
});

test('scene: a retirement that fails for a non-refusal reason keeps the scene: no detach, no archive, no workspace teardown, a retryable error', async () => {
  const holder = await engineer('scene-fail');
  const tree = realpathSync(mkdtempSync(join(tmpdir(), 'sck-retire-revoke-scene-')));
  try {
    const cwd = join(tree, 'session');
    mkdirSync(cwd);
    await workforce.bind(holder, { agentId: `agent-${holder}`, cwd });
    const archived: string[] = [], torn: string[] = [], detached: string[] = [];
    const paseo = {
      listWorkspaces: async () => [{ workspaceId: 'ws-scene-fail', cwd: tree, project: 'scene-fail' }],
      listProjects: async () => [],
      archiveWorkspace: async (workspaceId: string) => { torn.push(workspaceId); },
      deleteProject: async () => {},
      archive: async (agentId: string) => { archived.push(agentId); },
    } as unknown as PaseoGateway;
    // The real retirement entry, failing after its decision: the facts cannot be confirmed, so the retirement is not completed.
    const unavailable = new Workforce(database, credDir, async () => {
      throw new CompanyError('temporarily_unavailable', 'synthetic: retirement facts unreadable', true);
    });
    const cleaner = createSceneCleaner(paseo, {
      insts: async () => (await workforce.insts()).map(inst => ({ id: inst.id, cwd: inst.cwd, paseoAgentId: inst.paseoAgentId })),
      retire: (id, reason, kind) => unavailable.retire(id, reason, kind),
      detach: inst => { detached.push(inst.id); },
    });
    const error = await cleaner(tree).then(() => undefined, (caught: unknown) => caught) as CompanyError | undefined;
    expect(error).toMatchObject({ retryable: true });
    expect(error?.message).toContain('scene kept');
    expect(error?.message).toContain('temporarily_unavailable');
    expect(archived).toEqual([]);
    expect(torn).toEqual([]);
    expect(detached).toEqual([]);
    expect(await isRetired(holder)).toBe(false);
    expect(await isRevoked(holder)).toBe(false);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test('legal actions: a review-phase reviewer lease never recommends implementer_takeover', async () => {
  const author = await engineer('legal-author');
  const reviewer = await engineer('legal-reviewer');
  const t = await newTask('RV7 review lease');
  const first = await core.claim(tokenOf(author), t.id);
  await core.submit(tokenOf(author), proofOf(first), { text: DELIVERY, idempotencyKey: key() });
  await core.claim(tokenOf(reviewer), t.id);
  expect(await task(t.id)).toMatchObject({ state: 'review', currentEmployee: reviewer });
  const error = await refusal(workforce.retire(reviewer, WHY, 'manual'));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, state: 'review', phase: 'review', reason: 'active_lease' })]);
  expect(error.details!.legalActions.join('\n')).not.toContain('implementer_takeover');
  expect(error.details!.legalActions.join('\n')).toContain('复核');
  expect(await isRetired(reviewer)).toBe(false);
});

test('legal actions: a review-phase bound implementer is told to wait for the review, never offered implementer_takeover', async () => {
  const author = await engineer('legal-bound');
  const t = await newTask('RV8 review bound');
  const claim = await core.claim(tokenOf(author), t.id);
  await core.submit(tokenOf(author), proofOf(claim), { text: DELIVERY, idempotencyKey: key() });
  const error = await refusal(workforce.retire(author, WHY, 'manual'));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, state: 'review', phase: 'review', reason: 'bound_implementer' })]);
  expect(error.details!.legalActions.join('\n')).not.toContain('implementer_takeover');
  expect(error.details!.legalActions.join('\n')).toContain('复核');
  expect(await isRetired(author)).toBe(false);
});

test('legal actions: several refusals each get their own numbered, separated action', async () => {
  const worker = await engineer('legal-two');
  const reviewer = await engineer('legal-two-reviewer');
  const rework = await newTask('RV9 rework bound');
  const first = await core.claim(tokenOf(worker), rework.id);
  await core.submit(tokenOf(worker), proofOf(first), { text: DELIVERY, idempotencyKey: key() });
  const review = await core.claim(tokenOf(reviewer), rework.id);
  await core.returnTask(tokenOf(reviewer), proofOf(review), { text: REVIEW, idempotencyKey: key() });
  const leased = await newTask('RV9 active lease');
  await core.claim(tokenOf(worker), leased.id);
  const error = await refusal(workforce.retire(worker, WHY, 'manual'));
  expect(error.details?.reasons).toHaveLength(2);
  expect(error.details?.legalActions).toHaveLength(2);
  expect(error.message).toContain('1）');
  expect(error.message).toContain('2）');
  expect(await isRetired(worker)).toBe(false);
});
