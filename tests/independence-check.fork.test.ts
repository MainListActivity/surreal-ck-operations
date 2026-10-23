import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { CompanyError } from '../src/core-errors.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import type { ClaimResult, IndependenceCheckView, SetIndependence } from '../src/contracts.ts';

// SYS-DISP candidate-level read-only preflight (independence_check): one candidate against one task's policy, at one stage, with the
// verdict the real gate would give. The preflight reads the same exclusion index as claim/submit (never a second judgment), only gm and
// qa may read it, an unreadable source is unverifiable rather than clear, and a read writes nothing at all — no lease, version, audit,
// outbox or dispatch observation. Own namespace; the seam below is test-only.
const NS = 'sck_agent_company_test_indep_check';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(180_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-indep-check-'));
const workforce = new Workforce(database, credDir);
const enrollment = new LocalEnrollmentAdmin(database);
const tokens: Record<string, string> = {};

/** Seam: fail one source read, the way a broken audit stream would (IR04 fail-closed). */
const seam: { source?: (taskId: string) => Promise<void> } = {};
const core = new SurrealCompanyCore(database, {
  workforce,
  independenceReadHook: async (taskId: string) => { await seam.source?.(taskId); },
});

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [name, role, caps] of [
    ['gm', 'gm', ['execute', 'review', 'manage']],
    ['qa', 'qa', ['review']],
    ['src', 'engineering', ['execute', 'review']], ['indep', 'engineering', ['execute', 'review']],
    ['alias', 'engineering', ['execute', 'review']], ['explicit', 'engineering', ['execute', 'review']],
    ['exec', 'engineering', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`t-${name}`, role, caps);
  // `src` and `alias` are two employees of one registered definition (a capacity template, NOT an identity) linked into one person by
  // a registered principal. `indep`, `explicit` and `exec` share definitions but carry no principal link.
  for (const [name, def] of [['src', 'eng-factory'], ['alias', 'eng-factory'], ['indep', 'eng-claude'], ['explicit', 'eng-qa'], ['exec', 'eng-exec']] as const) {
    await database.db.query('UPDATE ONLY $e SET def = $d;', { e: new RecordId('employee', `t-${name}`), d: new RecordId('employee_def', def) });
  }
  await database.db.query('CREATE ONLY $p CONTENT { reason: $reason, version: 1, created_at: time::now() };',
    { p: new RecordId('principal', 'ppl-check'), reason: '同一人的两个工程会话（independence_check 夹具）' });
  await database.db.query('UPDATE $e SET principal = $p;', { e: [new RecordId('employee', 't-src'), new RecordId('employee', 't-alias')],
    p: new RecordId('principal', 'ppl-check') });
});

afterAll(async () => {
  await database.close();
  rmSync(credDir, { recursive: true, force: true });
});

beforeEach(async () => {
  seam.source = undefined;
  await database.db.query(`UPDATE task SET current_employee = NONE, lease_expires_at = NONE WHERE current_employee != NONE;
    UPDATE employee SET active_task = NONE WHERE active_task != NONE;`);
});

const key = () => crypto.randomUUID();
const EVIDENCE = '独立预检只读工具测试证据：候选级回避判定与门禁同源，读取不写任何字段。';
const engineering = (title: string) => core.createTask(tokens.gm, { title, context: 'synthetic independence_check case',
  executorRole: 'engineering', reviewerRole: 'engineering', idempotencyKey: key() });
const versionOf = async (taskId: string) => (await core.getTask(tokens.gm, taskId)).version;
const policyInput = async (taskId: string, sources: string[], over: Partial<SetIndependence> = {}): Promise<SetIndependence> => ({
  taskId, stages: ['execute'], sources, mode: 'execute_handlers', reason: 'G5 独立审查：来源经手人回避（independence_check 测试）',
  expectedVersion: await versionOf(taskId), idempotencyKey: key(), ...over,
});
const setPolicy = async (taskId: string, sources: string[], over: Partial<SetIndependence> = {}) =>
  core.setIndependence(tokens.gm, await policyInput(taskId, sources, over));
const proofOf = (claimed: ClaimResult) => ({ taskId: claimed.task.id, deliveryId: claimed.deliveryId, fence: claimed.fence, expectedVersion: claimed.task.version });
const failureOf = async (run: Promise<unknown>): Promise<CompanyError> => {
  try { await run; } catch (error) { if (error instanceof CompanyError) return error; throw error; }
  throw new Error('expected a refusal');
};
/** The author of a source has submitted it: they hold no lease, so only the independence gate can refuse their next claim. */
const authorParent = async (author: 'src' | 'alias', parentId: string) => {
  const claimed = await core.claim(tokens[author]!, parentId);
  await core.submit(tokens[author]!, proofOf(claimed), { text: EVIDENCE, idempotencyKey: key() });
};
const check = (taskId: string, employeeId: string, stage?: 'execute' | 'review'): Promise<IndependenceCheckView> =>
  core.independenceCheck(tokens.gm, { taskId, employeeId, ...(stage === undefined ? {} : { stage }) });

// IR06(a) and IR02: a source author is a conflict, and the conflict carries the same source/role as the claim refusal, plus the audit row.
test('a source author reads as a conflict with the source, role and audit reference the gate cites', async () => {
  const parent = await engineering('parent authored before the preflight');
  const dependent = await engineering('dependent whose source author is preflighted');
  await setPolicy(dependent.id, [parent.id]);
  await authorParent('src', parent.id);

  const view = await check(dependent.id, 't-src');
  expect(view).toMatchObject({ taskId: dependent.id, employeeId: 't-src', stage: 'execute', verdict: 'conflict',
    via: 'contributor', source: parent.id, matched: 't-src', role: 'author' });
  expect(view.auditRef).toEqual(expect.stringContaining('audit'));
  expect(view.policy).toMatchObject({ revision: 1, stages: ['execute'], mode: 'execute_handlers', sources: [parent.id], excluded: [] });
  expect(view.policy?.setBy).toBe('t-gm');
  expect(typeof view.policy?.setAt).toBe('string');
  expect(view.reason).toContain(parent.id);

  // Same source and same facts as the write gate: the refusal cites one conflict whose fields are exactly the preflight's, bar the
  // request-echo names (task/taskId, employee/employeeId). Same audit row, so the reading cannot drift from the refusal.
  const refusal = await failureOf(core.claim(tokens.src, dependent.id));
  expect(refusal.code).toBe('forbidden');
  const [conflict] = (refusal.details as { conflicts: Array<Record<string, unknown>> }).conflicts;
  expect(Object.keys(conflict!).sort()).toEqual(['auditRef', 'employee', 'matched', 'role', 'source', 'task', 'via']);
  expect(conflict).toMatchObject({ task: view.taskId, employee: view.employeeId, via: view.via, source: view.source,
    matched: view.matched, role: view.role, auditRef: view.auditRef });
});

// IR06(b): the mode decides whether the source's reviewer is a contributor at all.
test('mode distinguishes a source reviewer: all_handlers conflicts, execute_handlers clears', async () => {
  const parent = await engineering('parent whose reviewer is preflighted');
  await authorParent('src', parent.id);
  const reviewing = await core.claim(tokens.exec, parent.id);
  await core.accept(tokens.exec, proofOf(reviewing), { text: EVIDENCE, idempotencyKey: key() });
  expect((await core.getTask(tokens.gm, parent.id)).state).toBe('done');

  const all = await engineering('dependent under all_handlers');
  await setPolicy(all.id, [parent.id], { mode: 'all_handlers' });
  const execOnly = await engineering('dependent under execute_handlers');
  await setPolicy(execOnly.id, [parent.id]);

  const conflicted = await check(all.id, 't-exec');
  expect(conflicted).toMatchObject({ verdict: 'conflict', via: 'contributor', source: parent.id, role: 'reviewer' });
  expect(conflicted.policy?.mode).toBe('all_handlers');
  const cleared = await check(execOnly.id, 't-exec');
  expect(cleared).toMatchObject({ verdict: 'clear' });
  expect(cleared.policy?.mode).toBe('execute_handlers');
  expect(cleared.source).toBeUndefined();
});

// IR06(c): a manager-named employee is excluded with via=explicit and no source.
test('a named excluded employee reads as a conflict via=explicit', async () => {
  const dependent = await engineering('dependent with an explicit exclusion');
  await setPolicy(dependent.id, [], { excluded: ['t-explicit'] });
  const view = await check(dependent.id, 't-explicit');
  expect(view).toMatchObject({ verdict: 'conflict', via: 'explicit', matched: 't-explicit' });
  expect(view.source).toBeUndefined();
  expect(view.policy).toMatchObject({ excluded: ['t-explicit'], sources: [] });
  expect(await check(dependent.id, 't-indep')).toMatchObject({ verdict: 'clear' });
});

// IR06(d): the registered identity link, not the shared definition, is what makes an alias a conflict.
test('an alias sharing the source author registered principal reads as a conflict with the principal echoed', async () => {
  const parent = await engineering('parent authored before the alias preflight');
  const dependent = await engineering('dependent whose alias is preflighted');
  await setPolicy(dependent.id, [parent.id]);
  await authorParent('src', parent.id);

  const view = await check(dependent.id, 't-alias');
  expect(view).toMatchObject({ verdict: 'conflict', via: 'same_principal', source: parent.id, matched: 't-src', principal: 'ppl-check' });
  expect(view.role).toBe('author');
  // A same-definition employee with no registered link stays independent (a definition is not an identity).
  expect(await check(dependent.id, 't-indep')).toMatchObject({ verdict: 'clear' });
});

// IR06(e) and (f): an unrelated candidate is clear, and a task with no policy is not_applicable with no policy echoed.
test('an unrelated candidate reads as clear, and a task without a policy reads as not_applicable', async () => {
  const parent = await engineering('parent for the clear case');
  const dependent = await engineering('dependent with an unrelated candidate');
  await setPolicy(dependent.id, [parent.id]);
  await authorParent('src', parent.id);
  expect(await check(dependent.id, 't-indep')).toMatchObject({ verdict: 'clear' });
  expect(await check(dependent.id, 't-exec')).toMatchObject({ verdict: 'clear' });

  const legacy = await engineering('legacy task without a policy');
  const legacyView = await check(legacy.id, 't-src');
  expect(legacyView).toMatchObject({ verdict: 'not_applicable' });
  expect(legacyView.policy).toBeUndefined();
});

// IR04: a source that cannot be read is unverifiable, never clear — both when the row is missing and when the read throws.
test('an unreadable source reads as unverifiable, never clear, and names the source', async () => {
  const gone = 'task-source-that-is-gone';
  const parent = await engineering('parent dropped from the policy');
  const dependent = await engineering('dependent whose source row is gone');
  await setPolicy(dependent.id, [parent.id]);
  await database.db.query('UPDATE ONLY $task SET independence.sources = [$gone];', { task: new RecordId('task', dependent.id), gone });
  const missing = await check(dependent.id, 't-indep');
  expect(missing).toMatchObject({ verdict: 'unverifiable', source: gone });
  expect(missing.reason).toBeTruthy();
  expect(missing.verdict).not.toBe('clear');

  const parent2 = await engineering('parent whose history read fails');
  const dependent2 = await engineering('dependent whose source read fails');
  await setPolicy(dependent2.id, [parent2.id]);
  seam.source = async (taskId: string) => { if (taskId === parent2.id) throw new Error('audit read failed'); };
  const failed = await check(dependent2.id, 't-indep');
  expect(failed).toMatchObject({ verdict: 'unverifiable', source: parent2.id });
  expect(failed.verdict).not.toBe('clear');
  seam.source = undefined;
  expect(await check(dependent2.id, 't-indep')).toMatchObject({ verdict: 'clear' });
});

// IR03: the target is often already finished, so a done task must stay readable, and an explicit stage overrides the inferred one.
test('a closed (done) target stays readable with the right verdict, and an explicit stage wins over the inferred one', async () => {
  const parent = await engineering('parent of a dependent that will be done');
  const dependent = await engineering('dependent closed before the preflight');
  await setPolicy(dependent.id, [parent.id], { stages: ['execute', 'review'] });
  await authorParent('src', parent.id);
  const executed = await core.claim(tokens.exec, dependent.id);
  await core.submit(tokens.exec, proofOf(executed), { text: EVIDENCE, idempotencyKey: key() });
  const reviewing = await core.claim(tokens.indep, dependent.id);
  await core.accept(tokens.indep, proofOf(reviewing), { text: EVIDENCE, idempotencyKey: key() });
  expect((await core.getTask(tokens.gm, dependent.id)).state).toBe('done');

  expect(await check(dependent.id, 't-src')).toMatchObject({ verdict: 'conflict', stage: 'execute', source: parent.id, role: 'author' });
  expect(await check(dependent.id, 't-exec')).toMatchObject({ verdict: 'clear' });
  // A review-phase preflight of the task's own reviewer: the reviewer decided the source, so all_handlers would refuse it.
  expect(await check(dependent.id, 't-src', 'review')).toMatchObject({ verdict: 'conflict', stage: 'review' });
  expect(await check(dependent.id, 't-indep', 'review')).toMatchObject({ verdict: 'clear', stage: 'review' });
});

// IR06(i): the verdict is the gate's own verdict — every candidate's preflight agrees with what claim actually does.
test('the verdict matches core.claim case by case: a refused claim is a conflict, a granted claim is clear', async () => {
  const cases: Array<[string, 'conflict' | 'clear']> = [
    ['src', 'conflict'], ['alias', 'conflict'], ['explicit', 'clear'], ['indep', 'clear'], ['exec', 'clear'],
  ];
  for (const [who, expected] of cases) {
    const parent = await engineering(`parent for the claim cross-check (${who})`);
    const dependent = await engineering(`dependent cross-checked against claim (${who})`);
    await setPolicy(dependent.id, [parent.id]);
    await authorParent('src', parent.id);

    const view = await check(dependent.id, `t-${who}`);
    expect([who, view.verdict]).toEqual([who, expected]);

    let granted: ClaimResult | undefined;
    try {
      granted = await core.claim(tokens[who]!, dependent.id);
    } catch (error) {
      if (!(error instanceof CompanyError)) throw error;
      expect([who, error.code, error.message.includes('independence conflict')]).toEqual([who, 'forbidden', true]);
    }
    expect([who, granted !== undefined]).toEqual([who, expected === 'clear']);
    if (granted) await core.release(tokens[who]!, proofOf(granted), { text: '预检交叉核对后释放租约，测试收尾不留占用（independence_check）', idempotencyKey: key() });
  }
});

// IR03 and IR05: only gm and qa may read, and a read leaves the task and every write table exactly as it found them.
test('only gm and qa may read, and reading writes nothing: no version, audit, outbox, observation or lease change', async () => {
  const parent = await engineering('parent for the authorization case');
  const dependent = await engineering('dependent for the authorization case');
  await setPolicy(dependent.id, [parent.id]);
  await authorParent('src', parent.id);

  for (const who of ['src', 'indep', 'exec', 'explicit', 'alias'] as const) {
    const refusal = await failureOf(core.independenceCheck(tokens[who]!, { taskId: dependent.id, employeeId: 't-src' }));
    expect([who, refusal.code]).toEqual([who, 'forbidden']);
  }
  expect(await core.independenceCheck(tokens.qa!, { taskId: dependent.id, employeeId: 't-src' })).toMatchObject({ verdict: 'conflict' });
  expect(await core.independenceCheck(tokens.qa!, { taskId: dependent.id, employeeId: 't-indep' })).toMatchObject({ verdict: 'clear' });

  const counts = async () => {
    const [audit] = await database.db.query<[Array<{ count: number }>]>('SELECT count() AS count FROM audit GROUP ALL;');
    const [outbox] = await database.db.query<[Array<{ count: number }>]>('SELECT count() AS count FROM outbox GROUP ALL;');
    const [observations] = await database.db.query<[Array<{ count: number }>]>('SELECT count() AS count FROM company_meta WHERE id = $id;',
      { id: new RecordId('company_meta', 'dispatch_observation') });
    return { audit: audit?.[0]?.count ?? 0, outbox: outbox?.[0]?.count ?? 0, observations: observations?.[0]?.count ?? 0 };
  };
  const before = { ...(await counts()), task: await core.getTask(tokens.gm, dependent.id) };
  await core.independenceCheck(tokens.gm, { taskId: dependent.id, employeeId: 't-src' });
  await core.independenceCheck(tokens.gm, { taskId: dependent.id, employeeId: 't-indep' });
  await core.independenceCheck(tokens.qa!, { taskId: dependent.id, employeeId: 't-alias' });
  await core.independenceCheck(tokens.gm, { taskId: dependent.id, employeeId: 't-src', stage: 'review' });
  const after = { ...(await counts()), task: await core.getTask(tokens.gm, dependent.id) };

  expect(after.audit).toBe(before.audit);
  expect(after.outbox).toBe(before.outbox);
  expect(after.observations).toBe(before.observations);
  expect(after.task.version).toBe(before.task.version);
  expect(after.task.state).toBe('ready');
  expect(after.task.currentEmployee).toBeUndefined();
});