import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { Workforce } from '../src/workforce.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { createSceneCleaner, type PaseoGateway } from '../src/dispatcher/paseo.ts';
import type { ClaimResult, TaskView } from '../src/contracts.ts';

// SYS-DISP f517e2e4 (R1) on the real core and the real admin entry point: the shared retirement gate. The gate refuses an
// employee who holds a live task lease or is bound to unfinished engineering work, and it does so before any write.
// Own namespace, so nothing here shares state with the other integration files.
const NS = 'sck_agent_company_test_retire_gate';
const repoRoot = join(import.meta.dir, '..');
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(180_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-retire-gate-'));
const workforce = new Workforce(database, credDir);
const enrollment = new LocalEnrollmentAdmin(database);
const core = new SurrealCompanyCore(database, { workforce });
const gm = 'rg-gm';
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
const DELIVERY = 'Synthetic delivery evidence for the SYS-DISP R1 retirement gate test, long enough for the write gate.';
const REVIEW = 'Independent synthetic review evidence for the SYS-DISP R1 retirement gate test, long enough for the write gate.';
const BLOCK = 'Synthetic block evidence for the SYS-DISP R1 retirement gate test, long enough for the write gate.';
const proofOf = (claim: ClaimResult) => ({ taskId: claim.task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version });
const newTask = (title: string) => core.createTask(gmToken, { title, context: 'synthetic SYS-DISP R1 retirement gate case',
  executorRole: 'engineering', reviewerRole: 'engineering', idempotencyKey: key() });
const task = (taskId: string): Promise<TaskView> => core.getTask(gmToken, taskId);
const tokenOf = (employee: string) => people.get(employee)!;
async function engineer(label: string): Promise<string> {
  seq += 1;
  const employee = `rg-${label}-${seq}`;
  people.set(employee, await enrollment.enroll(employee, 'engineering', ['execute', 'review']));
  return employee;
}
const employeeRef = (employee: string) => new RecordId('employee', employee);
const rowOf = async (employee: string): Promise<Record<string, unknown>> =>
  (await database.db.select<Record<string, unknown>>(employeeRef(employee))) ?? {};
const rawTask = async (taskId: string): Promise<Record<string, unknown>> =>
  (await database.db.select<Record<string, unknown>>(new RecordId('task', taskId))) ?? {};
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

test('(a) an active lease refuses retirement: no retired flag, no credential swap, and the lease stays as it was', async () => {
  const holder = await engineer('lease');
  const t = await newTask('R1 a active lease');
  const claim = await core.claim(tokenOf(holder), t.id);
  const before = await task(t.id);
  const digest = (await rowOf(holder)).credential_digest;
  const error = await refusal(workforce.retire(holder, WHY, 'manual'));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, state: 'doing', phase: 'execute', reason: 'active_lease' })]);
  expect(error.details?.legalActions.length).toBeGreaterThan(0);
  expect(await isRetired(holder)).toBe(false);
  expect(await isRevoked(holder)).toBe(false);
  expect((await rowOf(holder)).credential_digest).toBe(digest);
  expect(await task(t.id)).toMatchObject({ state: 'doing', currentEmployee: holder, implementer: holder, fence: claim.fence,
    version: before.version, deliveryId: before.deliveryId });
});

test('(b) a ready rework task bound to its author refuses retirement; the reviewer who returned it is not an author', async () => {
  const author = await engineer('rework-author');
  const reviewer = await engineer('rework-reviewer');
  const t = await newTask('R1 b rework');
  const first = await core.claim(tokenOf(author), t.id);
  await core.submit(tokenOf(author), proofOf(first), { text: DELIVERY, idempotencyKey: key() });
  const review = await core.claim(tokenOf(reviewer), t.id);
  await core.returnTask(tokenOf(reviewer), proofOf(review), { text: REVIEW, idempotencyKey: key() });
  expect(await task(t.id)).toMatchObject({ state: 'ready', implementer: author });
  const error = await refusal(workforce.retire(author, WHY, 'manual'));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, state: 'ready', phase: 'execute', reason: 'bound_implementer' })]);
  expect(await isRetired(author)).toBe(false);
  await expect(workforce.retire(reviewer, WHY, 'manual')).resolves.toBeUndefined();
});

test('(c) a task waiting for review that is bound to its author refuses retirement', async () => {
  const author = await engineer('review-wait-author');
  const t = await newTask('R1 c review wait');
  const claim = await core.claim(tokenOf(author), t.id);
  await core.submit(tokenOf(author), proofOf(claim), { text: DELIVERY, idempotencyKey: key() });
  expect(await task(t.id)).toMatchObject({ state: 'review', implementer: author });
  const error = await refusal(workforce.retire(author, WHY, 'manual'));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, state: 'review', phase: 'review', reason: 'bound_implementer' })]);
  expect(await isRetired(author)).toBe(false);
});

test('(d) a blocked task bound to its author refuses retirement', async () => {
  const author = await engineer('blocked-author');
  const t = await newTask('R1 d blocked');
  const claim = await core.claim(tokenOf(author), t.id);
  await core.block(tokenOf(author), proofOf(claim), 'gm', { text: BLOCK, idempotencyKey: key() });
  expect(await task(t.id)).toMatchObject({ state: 'blocked', implementer: author });
  const error = await refusal(workforce.retire(author, WHY, 'manual'));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, state: 'blocked', phase: 'execute', reason: 'bound_implementer' })]);
  expect(await isRetired(author)).toBe(false);
});

test('(e) no in-flight relation: retirement passes, a repeated call is idempotent, and a voided task no longer binds', async () => {
  const clean = await engineer('clean');
  await expect(workforce.retire(clean, WHY, 'manual')).resolves.toBeUndefined();
  expect(await rowOf(clean)).toMatchObject({ retired: true, revoked: true, retired_kind: 'manual' });
  await expect(workforce.retire(clean, WHY, 'manual')).resolves.toBeUndefined();
  expect(await rowOf(clean)).toMatchObject({ retired: true, revoked: true, retired_kind: 'manual' });

  const voided = await engineer('voided');
  const t = await newTask('R1 e void');
  await core.claim(tokenOf(voided), t.id);
  await core.retireTask(gmToken, { taskId: t.id, text: WHY, idempotencyKey: key() });
  expect(await task(t.id)).toMatchObject({ state: 'void' });
  await expect(workforce.retire(voided, WHY, 'manual')).resolves.toBeUndefined();
  expect(await isRetired(voided)).toBe(true);
});

test('(f1) claim racing retirement: the two never both succeed, and a revoked employee never keeps a live lease', async () => {
  const orders = { claimWon: 0, claimLost: 0 };
  for (let round = 0; round < RACE_ROUNDS; round++) {
    const racer = await engineer(`race-claim-${round}`);
    const t = await newTask(`R1 f1 race ${round}`);
    const results = await Promise.allSettled([jitter().then(() => core.claim(tokenOf(racer), t.id)), jitter().then(() => workforce.retire(racer, WHY, 'manual'))]);
    const claimed = results[0].status === 'fulfilled';
    const retired = results[1].status === 'fulfilled';
    orders[claimed ? 'claimWon' : 'claimLost'] += 1;
    expect(claimed && retired).toBe(false);
    const current = await task(t.id);
    if (await isRevoked(racer)) expect(current.currentEmployee === racer && ['doing', 'review'].includes(current.state)).toBe(false);
    if (claimed) expect(await isRetired(racer)).toBe(false);
  }
  console.log(`race f1: rounds=${RACE_ROUNDS} claimWon=${orders.claimWon} claimLost=${orders.claimLost}`);
});

test('(f2) takeover racing retirement of the target: never both succeed, and a retired target is never left bound', async () => {
  const orders = { takeWon: 0, takeLost: 0 };
  for (let round = 0; round < RACE_ROUNDS; round++) {
    const previous = await engineer(`race-prev-${round}`);
    const reviewer = await engineer(`race-rev-${round}`);
    const target = await engineer(`race-target-${round}`);
    const t = await newTask(`R1 f2 takeover ${round}`);
    const claim = await core.claim(tokenOf(previous), t.id);
    await core.submit(tokenOf(previous), proofOf(claim), { text: DELIVERY, idempotencyKey: key() });
    const review = await core.claim(tokenOf(reviewer), t.id);
    await core.returnTask(tokenOf(reviewer), proofOf(review), { text: REVIEW, idempotencyKey: key() });
    const before = await task(t.id);
    const results = await Promise.allSettled([
      jitter().then(() => core.implementerTakeover(gmToken, { taskId: t.id, toEmployee: target, expectedVersion: before.version, reason: WHY, idempotencyKey: key() })),
      jitter().then(() => workforce.retire(target, WHY, 'manual')),
    ]);
    const took = results[0].status === 'fulfilled';
    const retired = results[1].status === 'fulfilled';
    orders[took ? 'takeWon' : 'takeLost'] += 1;
    expect(took && retired).toBe(false);
    if (retired) expect((await task(t.id)).implementer === target).toBe(false);
    if (took) {
      expect(await isRetired(target)).toBe(false);
      await expect(workforce.retire(target, WHY, 'manual')).rejects.toMatchObject({ code: 'retire_refused' });
    }
  }
  console.log(`race f2: rounds=${RACE_ROUNDS} takeWon=${orders.takeWon} takeLost=${orders.takeLost}`);
});

test('(k) a claim that lands after the retirement decision is caught by the write: refused, and the claim keeps its lease', async () => {
  const racer = await engineer('late-claim');
  const t = await newTask('R1 k late claim');
  const seen: { claim?: ClaimResult } = {};
  // The hook runs once the decision (no relation yet) is read; the claim commits in that window, before the write.
  const racing = new Workforce(database, credDir, async employee => {
    if (employee === racer && !seen.claim) seen.claim = await core.claim(tokenOf(racer), t.id);
  });
  const error = await refusal(racing.retire(racer, WHY, 'manual'));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, state: 'doing', reason: 'active_lease' })]);
  expect(seen.claim).toBeDefined();
  expect(await isRetired(racer)).toBe(false);
  expect(await isRevoked(racer)).toBe(false);
  expect(await task(t.id)).toMatchObject({ state: 'doing', currentEmployee: racer, fence: seen.claim!.fence });
});

test('(k2) a takeover that lands after the decision of its target is caught by the write: the target is refused and stays bound', async () => {
  const previous = await engineer('late-take-prev');
  const reviewer = await engineer('late-take-rev');
  const target = await engineer('late-take-target');
  const t = await newTask('R1 k2 late takeover');
  const first = await core.claim(tokenOf(previous), t.id);
  await core.submit(tokenOf(previous), proofOf(first), { text: DELIVERY, idempotencyKey: key() });
  const review = await core.claim(tokenOf(reviewer), t.id);
  await core.returnTask(tokenOf(reviewer), proofOf(review), { text: REVIEW, idempotencyKey: key() });
  const seen: { taken?: boolean } = {};
  const racing = new Workforce(database, credDir, async employee => {
    if (employee !== target || seen.taken) return;
    seen.taken = true;
    const before = await task(t.id);
    await core.implementerTakeover(gmToken, { taskId: t.id, toEmployee: target, expectedVersion: before.version, reason: WHY, idempotencyKey: key() });
  });
  const error = await refusal(racing.retire(target, WHY, 'manual'));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, state: 'ready', reason: 'bound_implementer' })]);
  expect(seen.taken).toBe(true);
  expect(await isRetired(target)).toBe(false);
  expect(await task(t.id)).toMatchObject({ state: 'ready', implementer: target });
});

test('(g1) a legacy task with no implementer field: its sole derived author is refused (fail-closed)', async () => {
  const author = await engineer('legacy-one');
  const t = await newTask('R1 g1 legacy');
  const claim = await core.claim(tokenOf(author), t.id);
  await core.submit(tokenOf(author), proofOf(claim), { text: DELIVERY, idempotencyKey: key() });
  await database.db.query('UPDATE $task SET implementer = NONE;', { task: new RecordId('task', t.id) });
  expect((await rawTask(t.id)).implementer).toBeUndefined();
  const error = await refusal(workforce.retire(author, WHY, 'manual'));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, state: 'review', reason: 'legacy_implementer' })]);
  expect(await isRetired(author)).toBe(false);
});

test('(g2) a legacy task with several authors and no implementer: every author is refused until a manager records one', async () => {
  const first = await engineer('amb-a');
  const second = await engineer('amb-b');
  const t = await newTask('R1 g2 ambiguous');
  const claim = await core.claim(tokenOf(first), t.id);
  await core.submit(tokenOf(first), proofOf(claim), { text: DELIVERY, idempotencyKey: key() });
  await database.db.query('UPDATE $task SET implementer = NONE;', { task: new RecordId('task', t.id) });
  await database.db.query('CREATE audit CONTENT { task: $task, actor: $actor, action: "checkpoint", phase: "execute", version: 0, at: time::now() };',
    { task: new RecordId('task', t.id), actor: employeeRef(second) });
  for (const who of [first, second]) {
    const error = await refusal(workforce.retire(who, WHY, 'manual'));
    expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, state: 'review', phase: 'review', reason: 'implementer_unresolved' })]);
    // The task waits for its review, and the takeover is an execute-phase action only (SYS-DISP F-D): the legal action says to wait.
    expect(error.details?.legalActions.join('\n')).not.toContain('implementer_takeover');
    expect(error.details?.legalActions.join('\n')).toContain('复核');
    expect(await isRetired(who)).toBe(false);
  }
});

test('(g3) a legacy author whose phase cannot be inferred counts as an author: a sole unknown author is refused', async () => {
  const unknown = await engineer('unknown-phase');
  const t = await newTask('R1 g3 unknown phase');
  await database.db.query('CREATE audit CONTENT { task: $task, actor: $actor, action: "checkpoint", version: 0, at: time::now() };',
    { task: new RecordId('task', t.id), actor: employeeRef(unknown) });
  const error = await refusal(workforce.retire(unknown, WHY, 'manual'));
  expect(error.details?.reasons).toEqual([expect.objectContaining({ taskId: t.id, reason: 'legacy_implementer' })]);
  expect(await isRetired(unknown)).toBe(false);
});

test('(g4) a legacy author of a finished task retires normally', async () => {
  const author = await engineer('legacy-done-author');
  const reviewer = await engineer('legacy-done-reviewer');
  const t = await newTask('R1 g4 finished legacy');
  const claim = await core.claim(tokenOf(author), t.id);
  await core.submit(tokenOf(author), proofOf(claim), { text: DELIVERY, idempotencyKey: key() });
  const review = await core.claim(tokenOf(reviewer), t.id);
  await core.accept(tokenOf(reviewer), proofOf(review), { text: REVIEW, idempotencyKey: key() });
  expect(await task(t.id)).toMatchObject({ state: 'done' });
  await database.db.query('UPDATE $task SET implementer = NONE;', { task: new RecordId('task', t.id) });
  await expect(workforce.retire(author, WHY, 'manual')).resolves.toBeUndefined();
  expect(await isRetired(author)).toBe(true);
});

test('(g5) a pure reviewer is never labelled an author: it retires normally on finished and on returned work', async () => {
  const author = await engineer('pure-author');
  const reviewer = await engineer('pure-reviewer');
  const finished = await newTask('R1 g5 finished');
  const first = await core.claim(tokenOf(author), finished.id);
  await core.submit(tokenOf(author), proofOf(first), { text: DELIVERY, idempotencyKey: key() });
  const accepted = await core.claim(tokenOf(reviewer), finished.id);
  await core.accept(tokenOf(reviewer), proofOf(accepted), { text: REVIEW, idempotencyKey: key() });
  const returned = await newTask('R1 g5 returned');
  const second = await core.claim(tokenOf(author), returned.id);
  await core.submit(tokenOf(author), proofOf(second), { text: DELIVERY, idempotencyKey: key() });
  const bounced = await core.claim(tokenOf(reviewer), returned.id);
  await core.returnTask(tokenOf(reviewer), proofOf(bounced), { text: REVIEW, idempotencyKey: key() });
  const facts = await workforce.contributors(returned.id);
  expect(facts.authors).toEqual([author]);
  expect(facts.reviewers).toEqual([reviewer]);
  await expect(workforce.retire(reviewer, WHY, 'manual')).resolves.toBeUndefined();
  expect(await isRetired(reviewer)).toBe(true);
  expect(await isRetired(author)).toBe(false);
});

test('(h) the admin retire command refuses an employee with an active lease through the same boundary: exit 1, stable code, nothing written', async () => {
  const holder = await engineer('cli-lease');
  const t = await newTask('R1 h admin lease');
  await core.claim(tokenOf(holder), t.id);
  const digest = (await rowOf(holder)).credential_digest;
  const run = await runAdmin(['retire', holder, 'CLI 退役测试']);
  expect(run.exitCode).not.toBe(0);
  expect(`${run.stdout}\n${run.stderr}`).toContain('retire_refused');
  expect(await isRetired(holder)).toBe(false);
  expect(await isRevoked(holder)).toBe(false);
  expect((await rowOf(holder)).credential_digest).toBe(digest);
});

test('(h2) the admin retire command retires an idle employee and reports ok', async () => {
  const idle = await engineer('cli-idle');
  const run = await runAdmin(['retire', idle, 'CLI 空闲退役测试']);
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toContain('"ok": true');
  expect(await rowOf(idle)).toMatchObject({ retired: true, revoked: true, retired_kind: 'manual' });
});

/** A Paseo fake for one dispatcher tick: sessions by agent id, with the status each test sets. Nothing here reaches a real CLI. */
function fakePaseo(statuses: Map<string, string>, archived: string[]): PaseoGateway {
  return {
    list: async () => new Map([...statuses].map(([id, status]) => [id, { id, status }])),
    status: async (id: string) => statuses.has(id) ? { status: statuses.get(id)!, pendingPermissions: 0 } : undefined,
    lastError: async () => 'synthetic session error',
    logsTail: async () => 'synthetic transcript',
    lastInputTokens: async () => 0,
    spawn: async () => { throw new Error('no spawn in the retirement gate fixture'); },
    send: async () => {},
    stop: async () => {},
    archive: async (id: string) => { archived.push(id); statuses.set(id, 'archived'); },
    listWorkspaces: async () => [],
    listProjects: async () => [],
    archiveWorkspace: async () => {},
    deleteProject: async () => {},
  } as unknown as PaseoGateway;
}

test('(i) a dead session that holds a lease: the tick refuses the retirement, archives nothing, and retires only after a takeover', async () => {
  const holder = await engineer('dispatch-holder');
  const target = await engineer('dispatch-target');
  const t = await newTask('R1 i dispatch refusal');
  await core.claim(tokenOf(holder), t.id);
  await workforce.bind(holder, { agentId: `agent-${holder}` });
  const digest = (await rowOf(holder)).credential_digest;
  const statuses = new Map([[`agent-${holder}`, 'error']]);
  const archived: string[] = [];
  const dispatcher = new Dispatcher({ workforce, owner: new OwnerDesk(database), paseo: fakePaseo(statuses, archived),
    rand: () => 0, env: { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' } });
  // Session error: the refused retirement leaves the session, the credential and the employee alone. The lease supervision then
  // hands the dead holder's lease over, as it always did, so the task is no longer held by this employee.
  const first = await dispatcher.tick();
  expect(first.refused).toEqual([holder]);
  expect(first.retired).not.toContain(holder);
  expect(archived).toEqual([]);
  expect(await isRetired(holder)).toBe(false);
  expect(await isRevoked(holder)).toBe(false);
  expect((await rowOf(holder)).credential_digest).toBe(digest);
  expect((await task(t.id)).currentEmployee).not.toBe(holder);
  // The task is still engineering work this employee implements: the next pass refuses again.
  const second = await dispatcher.tick();
  expect(second.refused).toEqual([holder]);
  expect(archived).toEqual([]);
  expect(await isRetired(holder)).toBe(false);
  // The legal next step is a manager takeover. Once the employee is no longer bound, the same session retires and is archived.
  const before = await task(t.id);
  await core.implementerTakeover(gmToken, { taskId: t.id, toEmployee: target, expectedVersion: before.version, reason: WHY, idempotencyKey: key() });
  const third = await dispatcher.tick();
  expect(third.retired).toContain(holder);
  expect(archived).toEqual([`agent-${holder}`]);
  expect(await rowOf(holder)).toMatchObject({ retired: true, revoked: true, retired_kind: 'failure' });
});

test('(j) the scene cleaner keeps a tree whose employee has in-flight work: no detach, no archive, no workspace teardown', async () => {
  const holder = await engineer('scene-holder');
  const t = await newTask('R1 j scene');
  await core.claim(tokenOf(holder), t.id);
  const tree = realpathSync(mkdtempSync(join(tmpdir(), 'sck-retire-scene-')));
  try {
    const cwd = join(tree, 'session');
    mkdirSync(cwd);
    await workforce.bind(holder, { agentId: `agent-${holder}`, cwd });
    const archived: string[] = [], torn: string[] = [], detached: string[] = [];
    const paseo = {
      listWorkspaces: async () => [{ workspaceId: 'ws-scene', cwd: tree, project: 'scene' }],
      listProjects: async () => [],
      archiveWorkspace: async (workspaceId: string) => { torn.push(workspaceId); },
      deleteProject: async () => {},
      archive: async (agentId: string) => { archived.push(agentId); },
    } as unknown as PaseoGateway;
    const cleaner = createSceneCleaner(paseo, {
      insts: async () => (await workforce.insts()).map(inst => ({ id: inst.id, cwd: inst.cwd, paseoAgentId: inst.paseoAgentId })),
      retire: (id, reason, kind) => workforce.retire(id, reason, kind),
      detach: inst => { detached.push(inst.id); },
    });
    await expect(cleaner(tree)).rejects.toThrow('scene kept');
    expect(archived).toEqual([]);
    expect(torn).toEqual([]);
    expect(detached).toEqual([]);
    expect(await isRetired(holder)).toBe(false);
    expect(await isRevoked(holder)).toBe(false);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});
