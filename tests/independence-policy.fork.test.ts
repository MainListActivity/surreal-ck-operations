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
import { independenceHit, readIndependenceSnapshot, type IndependenceScope } from '../src/independence.ts';
import { readContributionView } from '../src/contributors.ts';
import { Workforce, type EmployeeDef, type EmployeeInst, type SupervisedTask } from '../src/workforce.ts';
import { staffingPool, type InstState } from '../src/dispatcher/dispatcher.ts';
import { dispatchNoticeText, evaluateDispatch } from '../src/dispatcher/dispatch-blocked.ts';
import type { ClaimResult, SetIndependence } from '../src/contracts.ts';

// SYS-DISP IR01-IR05 on the real core and the company fork. A dependent task (an independent review) is never taken, submitted or
// decided by a source contributor, a source change between the read and the write is caught by the version guard, and the dispatcher
// reads the same exclusion from the same audit stream. Own namespace; the seams below are test-only.
const NS = 'sck_agent_company_test_indep_policy';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(180_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-indep-policy-'));
const workforce = new Workforce(database, credDir);
const enrollment = new LocalEnrollmentAdmin(database);
const tokens: Record<string, string> = {};

/** Seams: move the world between a read and its write, fail one source read, count the lease reads. */
const seam: { contribution?: (taskId: string) => Promise<void>; source?: (taskId: string) => Promise<void>; contributionReads: number } =
  { contributionReads: 0 };
const core = new SurrealCompanyCore(database, {
  workforce,
  contributionReadHook: async (taskId: string) => { seam.contributionReads += 1; await seam.contribution?.(taskId); },
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
    ['src', 'engineering', ['execute', 'review']], ['indep', 'engineering', ['execute', 'review']],
    ['alias', 'engineering', ['execute', 'review']], ['explicit', 'engineering', ['execute', 'review']],
    ['exec', 'engineering', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`t-${name}`, role, caps);
  // `src` and `alias` are instances of one registered definition (a capacity template, NOT an identity: SYS-DISP Q3) and are
  // linked into one person by a registered principal. `indep`, `explicit` and `exec` share the def but have no principal link.
  for (const [name, def] of [['src', 'eng-factory'], ['alias', 'eng-factory'], ['indep', 'eng-claude'], ['explicit', 'eng-qa'], ['exec', 'eng-exec']] as const) {
    await database.db.query('UPDATE ONLY $e SET def = $d;', { e: new RecordId('employee', `t-${name}`), d: new RecordId('employee_def', def) });
  }
  await database.db.query('CREATE ONLY $p CONTENT { reason: $reason, version: 1, created_at: time::now() };',
    { p: new RecordId('principal', 'ppl-factory'), reason: '同一人的两个工程会话（IR05 夹具）' });
  await database.db.query('UPDATE $e SET principal = $p;', { e: [new RecordId('employee', 't-src'), new RecordId('employee', 't-alias')],
    p: new RecordId('principal', 'ppl-factory') });
});

afterAll(async () => {
  await database.close();
  rmSync(credDir, { recursive: true, force: true });
});

// Each test starts with no lease held. A lease an earlier test left behind would refuse the next claim for the single-lease reason,
// and the independence refusal under test would never be reached.
beforeEach(async () => {
  await database.db.query(`UPDATE task SET current_employee = NONE, lease_expires_at = NONE WHERE current_employee != NONE;
    UPDATE employee SET active_task = NONE WHERE active_task != NONE;`);
});

const key = () => crypto.randomUUID();
const EVIDENCE = '独立审查提交：来源经手人回避的 IR05 测试证据，覆盖领取后冲突拒绝与并发竞争。';
const engineering = (title: string) => core.createTask(tokens.gm, { title, context: 'synthetic IR05 independence case',
  executorRole: 'engineering', reviewerRole: 'engineering', idempotencyKey: key() });
const versionOf = async (taskId: string) => (await core.getTask(tokens.gm, taskId)).version;
const policyInput = async (taskId: string, sources: string[], over: Partial<SetIndependence> = {}): Promise<SetIndependence> => ({
  taskId, stages: ['execute'], sources, mode: 'execute_handlers', reason: 'G5 独立审查：来源经手人回避（测试）',
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

// R1 (v18 return): migration 023 must be loaded by the bootstrap of an empty database, not only exist as a file.
test('a fresh bootstrap loads the independence migrations: task has both policy fields and the schema marker has passed 29', async () => {
  const [info] = await database.db.query<[{ fields?: Record<string, string> }]>('INFO FOR TABLE task;');
  expect(Object.keys(info?.fields ?? {})).toEqual(expect.arrayContaining(['independence', 'independence_guard']));
  const [marker] = await database.db.query<[Array<{ schema_version: number }>]>('SELECT schema_version FROM company_meta:installation;');
  // QA V7：marker 是**全库**最高已加载模块的编号，不是本模块的编号——写死 29 会让之后任何一条 lane 的
  // 新增迁移（SYS03 的 034）把这条与本模块无关的断言弄红。这里要证明的是「023 确实随 bootstrap 加载进来了」。
  expect(marker?.[0]?.schema_version).toBeGreaterThanOrEqual(29);
  // The identity link is additive: the field exists on employee, and no employee carries a principal until a manager registers one.
  const [table] = await database.db.query<[{ fields?: Record<string, string> }]>('INFO FOR TABLE employee;');
  expect(Object.keys(table?.fields ?? {})).toContain('principal');
  const probe = await engineering('bootstrap probe');
  expect((await core.getTask(tokens.gm, probe.id)).independence).toBeUndefined();
});

test('G5 replay: a source authored after the policy is a conflict at claim; the independent engineer still claims', async () => {
  const parent = await engineering('parent authored after the policy (3a9b0b3c analog)');
  const dependent = await engineering('independent review created before the parent claim (G5 analog)');
  await setPolicy(dependent.id, [parent.id]);
  await authorParent('src', parent.id);

  const refusal = await failureOf(core.claim(tokens.src, dependent.id));
  expect(refusal.code).toBe('forbidden');
  expect(refusal.message).toContain('independence conflict');
  expect(refusal.details).toMatchObject({ conflicts: [{ task: dependent.id, source: parent.id, employee: 't-src', matched: 't-src', via: 'contributor', role: 'author' }] });
  expect((refusal.details as { conflicts?: unknown[] }).conflicts).toEqual([expect.objectContaining({ auditRef: expect.stringContaining('audit') })]);

  const granted = await core.claim(tokens.indep, dependent.id);
  expect(granted.task.currentEmployee).toBe('t-indep');
});

test('explicit exclusion: a manager-named employee is refused, the rest of the pool still claims', async () => {
  const dependent = await engineering('explicit exclusion of a QA-style reviewer');
  const updated = await setPolicy(dependent.id, [], { excluded: ['t-explicit'] });
  expect(updated.independence).toMatchObject({ sources: [], excluded: ['t-explicit'], mode: 'execute_handlers', revision: 1 });

  const refusal = await failureOf(core.claim(tokens.explicit, dependent.id));
  expect(refusal.message).toContain('independence conflict');
  expect(refusal.details).toMatchObject({ conflicts: [{ task: dependent.id, employee: 't-explicit', via: 'explicit' }] });

  expect((await core.claim(tokens.indep, dependent.id)).task.currentEmployee).toBe('t-indep');
});

// SYS-DISP Q3: a definition is a capacity template, not an identity. Only a registered principal links two employeeIds.
test('a registered principal links an alias of a contributor: it is refused, and a new session of the same employee is the same identity', async () => {
  const parent = await engineering('parent whose contributor has a registered identity link');
  await authorParent('src', parent.id);
  const dependent = await engineering('dependent whose registered alias must not take it');
  await setPolicy(dependent.id, [parent.id]);

  const alias = await failureOf(core.claim(tokens.alias, dependent.id));
  expect(alias.message).toContain('independence conflict');
  expect(alias.details).toMatchObject({ conflicts: [{ employee: 't-alias', matched: 't-src', via: 'same_principal', principal: expect.any(String) }] });

  // A new paseo session under the same employee id changes nothing: identity is the registered employee, not the session.
  await database.db.query('UPDATE ONLY $e SET paseo_agent_id = $agent;', { e: new RecordId('employee', 't-src'), agent: 'ag-new-session' });
  expect((await failureOf(core.claim(tokens.src, dependent.id))).message).toContain('independence conflict');
});

test('the same definition is not the same identity: an independent employee of the contributor def may claim', async () => {
  // The link is unregistered, so the two factory-droid employees are different people.
  await database.db.query('UPDATE ONLY $e SET principal = NONE;', { e: new RecordId('employee', 't-alias') });
  const parent = await engineering('parent with a factory contributor and no identity link');
  await authorParent('src', parent.id);
  const dependent = await engineering('dependent a same-def independent employee may take');
  await setPolicy(dependent.id, [parent.id]);
  const scope = await workforce.independenceScope((await core.getTask(tokens.gm, dependent.id)).independence, 'execute');
  if (scope?.kind !== 'index') throw new Error('expected an index scope');
  expect(independenceHit(scope.index, 't-src', undefined)).toMatchObject({ via: 'contributor', source: parent.id });
  expect(independenceHit(scope.index, 't-alias', 'eng-factory')).toBeUndefined();
  expect((await core.claim(tokens.alias, dependent.id)).task.currentEmployee).toBe('t-alias');
});

test('a different definition with the same principal is the same identity: it is refused', async () => {
  // t-explicit uses another def (eng-qa) but shares the contributor's registered principal.
  await database.db.query('UPDATE ONLY $e SET principal = (SELECT VALUE principal FROM ONLY $src);',
    { e: new RecordId('employee', 't-explicit'), src: new RecordId('employee', 't-src') });
  const parent = await engineering('parent whose contributor is linked across definitions');
  await authorParent('src', parent.id);
  const dependent = await engineering('dependent whose cross-def alias must not take it');
  await setPolicy(dependent.id, [parent.id]);
  expect((await failureOf(core.claim(tokens.explicit, dependent.id))).message).toContain('independence conflict');
});

test('an unreadable source history refuses the claim fail-closed, leaves no lease, and clears when the history reads again', async () => {
  const parent = await engineering('parent whose history cannot be read');
  const dependent = await engineering('dependent waiting on an unreadable source');
  await setPolicy(dependent.id, [parent.id]);
  seam.source = async (taskId: string) => { if (taskId === parent.id) throw new Error('audit read failed'); };
  try {
    const refusal = await failureOf(core.claim(tokens.indep, dependent.id));
    expect(refusal.code).toBe('temporarily_unavailable');
    expect(refusal.retryable).toBe(true);
    expect((await core.getTask(tokens.gm, dependent.id)).currentEmployee).toBeUndefined();
  } finally {
    seam.source = undefined;
  }
  expect((await core.claim(tokens.indep, dependent.id)).task.currentEmployee).toBe('t-indep');
});

test('a source contribution that lands after the claim is refused at submit, and the lease is not released silently', async () => {
  const parent = await engineering('parent taken over after the dependent claim');
  const dependent = await engineering('dependent claimed before the source contribution');
  await setPolicy(dependent.id, [parent.id]);
  const claimed = await core.claim(tokens.indep, dependent.id);

  // The manager makes the claimant the implementer of the source: a new source contribution after the claim.
  await core.implementerTakeover(tokens.gm, { taskId: parent.id, toEmployee: 't-indep', expectedVersion: await versionOf(parent.id),
    reason: '经理指定 indep 接手源任务（测试）', idempotencyKey: key() });

  const refusal = await failureOf(core.submit(tokens.indep, proofOf(claimed), { text: EVIDENCE, idempotencyKey: key() }));
  expect(refusal.code).toBe('forbidden');
  expect(refusal.message).toContain('independence conflict');
  expect(refusal.details).toMatchObject({ conflicts: [{ task: dependent.id, source: parent.id, employee: 't-indep', via: 'contributor' }] });
  const held = await core.getTask(tokens.gm, dependent.id);
  expect(held.currentEmployee).toBe('t-indep');
  expect(held.state).toBe('doing');
});

test('a source change between the independence read and the claim write is caught by the version guard and the claim re-reads', async () => {
  const parent = await engineering('parent that moves between read and write');
  const dependent = await engineering('dependent whose claim races a source takeover');
  await setPolicy(dependent.id, [parent.id]);
  let moved = false;
  seam.contribution = async (taskId: string) => {
    if (taskId !== dependent.id || moved) return;
    moved = true;
    await core.implementerTakeover(tokens.gm, { taskId: parent.id, toEmployee: 't-indep', expectedVersion: await versionOf(parent.id),
      reason: '经理指定 indep 接手源任务（竞争测试）', idempotencyKey: key() });
  };
  const before = seam.contributionReads;
  try {
    const refusal = await failureOf(core.claim(tokens.indep, dependent.id));
    expect(refusal.message).toContain('independence conflict');
  } finally {
    seam.contribution = undefined;
  }
  // The first round read the source before the takeover and the guard refused its write; the retry read again and refused the claim.
  expect(seam.contributionReads - before).toBe(2);
  expect((await core.getTask(tokens.gm, dependent.id)).currentEmployee).toBeUndefined();
});

test('concurrent takeover of the source and claim of the dependent never leave a conflicting submit standing', async () => {
  for (let round = 0; round < 5; round++) {
    const parent = await engineering(`parent race round ${round}`);
    const dependent = await engineering(`dependent race round ${round}`);
    await setPolicy(dependent.id, [parent.id]);
    const [claimed, taken] = await Promise.allSettled([
      core.claim(tokens.indep, dependent.id),
      core.implementerTakeover(tokens.gm, { taskId: parent.id, toEmployee: 't-indep', expectedVersion: await versionOf(parent.id),
        reason: '经理指定 indep 接手源任务（并发轮次）', idempotencyKey: key() }),
    ]);
    // Both races settle before the submit, so a takeover that landed is already visible to the submit gate. Every round asserts the
    // same exact outcome: a claim that lost the race is refused with a structured error, and the submit lands only when the claim was
    // granted and the takeover did not land.
    expect(claimed.status === 'fulfilled' || claimed.reason instanceof CompanyError).toBe(true);
    const submitted = claimed.status === 'fulfilled'
      ? await core.submit(tokens.indep, proofOf(claimed.value), { text: EVIDENCE, idempotencyKey: key() }).then(() => true, () => false)
      : false;
    expect(submitted).toBe(claimed.status === 'fulfilled' && taken.status !== 'fulfilled');
  }
});

test('a policy change is refused while a lease is active, and nothing about the policy moves', async () => {
  const parent = await engineering('parent for the lease guard');
  const dependent = await engineering('dependent under an active lease');
  const first = await setPolicy(dependent.id, [parent.id]);
  await core.claim(tokens.indep, dependent.id);
  const refusal = await failureOf(core.setIndependence(tokens.gm, await policyInput(dependent.id, [], { excluded: ['t-explicit'] })));
  expect(refusal.code).toBe('conflict');
  expect(refusal.message).toContain('lease');
  expect((await core.getTask(tokens.gm, dependent.id)).independence).toMatchObject({ revision: first.independence!.revision, sources: [parent.id] });
});

test('setIndependence replays the same key and payload without a second revision, and refuses a different payload under that key', async () => {
  const parent = await engineering('parent for replay');
  const dependent = await engineering('dependent for replay');
  const input = await policyInput(dependent.id, [parent.id]);
  const first = await core.setIndependence(tokens.gm, input);
  const again = await core.setIndependence(tokens.gm, input);
  expect(again.independence?.revision).toBe(first.independence?.revision);
  expect(again.version).toBe(first.version);
  expect((await core.setIndependence(tokens.gm, input).then(view => view.version))).toBe(first.version);
  const clash = await failureOf(core.setIndependence(tokens.gm, { ...input, reason: '另一个理由同一个幂等键（测试）' }));
  expect(clash.code).toBe('conflict');
});

test('policy writes are manager-only and every bad input is refused before anything is written', async () => {
  const parent = await engineering('parent for negative inputs');
  const dependent = await engineering('dependent for negative inputs');
  const version = await versionOf(dependent.id);
  expect((await failureOf(core.setIndependence(tokens.src, await policyInput(dependent.id, [parent.id])))).code).toBe('forbidden');
  expect((await failureOf(core.setIndependence(tokens.gm, await policyInput(dependent.id, [dependent.id])))).code).toBe('invalid');
  expect((await failureOf(core.setIndependence(tokens.gm, await policyInput(dependent.id, ['task-that-does-not-exist'])))).code).toBe('not_found');
  expect((await failureOf(core.setIndependence(tokens.gm, await policyInput(dependent.id, [parent.id], { excluded: ['t-ghost'] })))).code).toBe('invalid');
  expect((await failureOf(core.setIndependence(tokens.gm, await policyInput(dependent.id, [parent.id], { expectedVersion: version + 9 })))).code).toBe('conflict');
  expect((await core.getTask(tokens.gm, dependent.id)).independence).toBeUndefined();
  expect((await core.getTask(tokens.gm, dependent.id)).version).toBe(version);
});

// SYS-DISP Q3 negatives: an identity link is a manage-controlled, audited write. Nobody may self-declare a link, and a live lease
// is never re-identified under a running task.
test('principal writes are manager-only, audited, idempotent, and refuse a live lease', async () => {
  const parent = await engineering('parent for principal negatives');
  const held = await core.claim(tokens.indep, parent.id);
  const principalInput = (over: Partial<Parameters<typeof core.setIdentityPrincipal>[1]> = {}) => ({
    employees: ['t-src', 't-alias'], reason: 'IR05 principal 夹具：同一人的两个会话', idempotencyKey: key(), ...over,
  });
  // Restore the fixture identity state whatever happens: later tests read the registered ppl-factory link from a clean principal
  // table, and a half-run test must never leave a second link behind for them.
  const restoreFixtureIdentity = async () => {
    await database.db.query('DELETE principal;');
    await database.db.query('UPDATE employee SET principal = NONE;');
    await database.db.query('CREATE ONLY $p CONTENT { reason: $reason, version: 1, created_at: time::now() };',
      { p: new RecordId('principal', 'ppl-factory'), reason: '同一人的两个工程会话（IR05 夹具）' });
    await database.db.query('UPDATE $e SET principal = $p;', { e: [new RecordId('employee', 't-src'), new RecordId('employee', 't-alias')],
      p: new RecordId('principal', 'ppl-factory') });
  };
  try {
    // Only manage may register an identity link.
    expect((await failureOf(core.setIdentityPrincipal!(tokens.src, principalInput()))).code).toBe('forbidden');
    // A short reason and an unknown employee are refused before anything is written.
    expect((await failureOf(core.setIdentityPrincipal!(tokens.gm, principalInput({ reason: '短' })))).code).toBe('invalid');
    expect((await failureOf(core.setIdentityPrincipal!(tokens.gm, principalInput({ employees: ['t-ghost'] })))).code).toBe('not_found');
    // A live lease refuses the write: an identity is never changed under a running task.
    expect((await failureOf(core.setIdentityPrincipal!(tokens.gm, principalInput({ employees: ['t-indep', 't-alias'] })))).code).toBe('conflict');
    // Nothing was written: only the fixture's own principal row exists, and no employee gained a second link.
    const [rows] = await database.db.query<[{ count: number }[]]>('SELECT count() AS count FROM principal GROUP ALL;');
    expect(rows?.[0]?.count ?? 0).toBe(1);
    const [linked] = await database.db.query<[{ count: number }[]]>('SELECT count() AS count FROM employee WHERE principal != NONE GROUP ALL;');
    expect(linked?.[0]?.count ?? 0).toBe(2);
    // The same key and payload replays the original result; a different payload under that key conflicts.
    const input = principalInput();
    const first = await core.setIdentityPrincipal!(tokens.gm, input);
    expect(first).toMatchObject({ employees: ['t-src', 't-alias'], setBy: 't-gm', reason: input.reason });
    expect(await core.setIdentityPrincipal!(tokens.gm, input)).toEqual(first);
    expect((await failureOf(core.setIdentityPrincipal!(tokens.gm, { ...input, reason: '另一个理由，同一把幂等键' }))).code).toBe('conflict');
    const [audit] = await database.db.query<[{ count: number }[]]>("SELECT count() AS count FROM audit WHERE action = 'identity_principal_set' GROUP ALL;");
    expect(audit?.[0]?.count ?? 0).toBeGreaterThan(0);
  } finally {
    await core.submit(tokens.indep, proofOf(held), { text: EVIDENCE, idempotencyKey: key() });
    await restoreFixtureIdentity();
  }
});

test('a task without a policy is unchanged: a source contributor of another task may still claim it', async () => {
  const parent = await engineering('parent with a contributor');
  await authorParent('src', parent.id);
  const legacy = await engineering('legacy task with no policy');
  expect((await core.claim(tokens.src, legacy.id)).task.currentEmployee).toBe('t-src');
});

// SYS-DISP IR01 (Q1/B): an ordinary task's plain review rule is unchanged. A holder who only claimed execute and never wrote
// code is demoted, not excluded, so they may still take and decide the review — exactly the pre-SYS-DISP running baseline.
test('an ordinary task keeps the claim-only review rule: the prior hand may claim and decide the review, while a real author may not', async () => {
  // The implementer is bound first and writes the code, so a later execute holder can only be a claim-only hand: the
  // binding (not the lease) is what makes someone the author.
  const parent = await engineering('parent where a hand claimed the review and released it');
  const written = await core.claim(tokens.exec, parent.id);
  await core.submit(tokens.exec, proofOf(written), { text: EVIDENCE, idempotencyKey: key() });
  expect((await core.getTask(tokens.gm, parent.id)).state).toBe('review');
  // A second holder claims the review lease and releases it without deciding: they held the task but wrote nothing.
  const claimed = await core.claim(tokens.alias, parent.id);
  await core.release(tokens.alias, proofOf(claimed), { text: '本轮暂停，未裁决（claim-only 经手人，Q1 回归夹具）', idempotencyKey: key() });

  // The prior hand (held a lease, never wrote code) is demoted, not excluded: the review claim is allowed again.
  const facts = await readContributionView(database.db, parent.id);
  expect(facts.facts).toMatchObject({ authors: ['t-exec'], excluded: ['t-exec'], hands: ['t-alias'], implementer: 't-exec', ambiguous: false });
  const reviewing = await core.claim(tokens.alias, parent.id);
  expect(reviewing.task.currentEmployee).toBe('t-alias');
  // The actual author never reviews their own delivery, policy or not.
  expect((await failureOf(core.claim(tokens.exec, parent.id))).code).toBe('self_review');
  await core.release(tokens.alias, proofOf(reviewing), { text: '释放复核租约（Q1 回归夹具收尾，避免占用租约影响后续断言）', idempotencyKey: key() });

  // A strict source excludes every execute handler of the source, including one who claimed execute and never wrote
  // code. The execute hand is the source's first implementer whose binding a takeover moved on: they held the code.
  const source = await engineering('source whose execute hand is hard-excluded');
  const first = await core.claim(tokens.alias, source.id);
  await core.release(tokens.alias, proofOf(first), { text: '本轮暂停，未写码（claim-only 执行经手人，Q1 回归夹具）', idempotencyKey: key() });
  const dependent = await engineering('dependent whose strict source hard-excludes the prior hand');
  await setPolicy(dependent.id, [source.id]);
  expect((await failureOf(core.claim(tokens.alias, dependent.id))).message).toContain('independence conflict');
});

// 7cf393f8 B1: strictExcluded used to be "all hands minus reviewers", so a hand who then took and returned the source's own review
// escaped a strict source: the independence gate let them claim the dependent. Reviewing never undoes having held the code.
test('a strict source excludes an execute hand who later reviewed that source, as it does one who never did', async () => {
  const legacyHand = (taskId: string, who: string) => database.db.query(
    'CREATE audit CONTENT { task: $task, actor: $actor, action: "checkpoint", phase: "execute", version: 0, at: time::now() };',
    { task: new RecordId('task', taskId), actor: new RecordId('employee', who) });
  const source = await engineering('source whose execute hand later reviewed it');
  await legacyHand(source.id, 't-indep');
  const written = await core.claim(tokens.exec, source.id);
  await core.submit(tokens.exec, proofOf(written), { text: EVIDENCE, idempotencyKey: key() });
  await legacyHand(source.id, 't-explicit');
  // On an ordinary task a hand is demoted, not recused: they may take the review and return it.
  const reviewing = await core.claim(tokens.indep, source.id);
  await core.returnTask(tokens.indep, proofOf(reviewing), { text: EVIDENCE, idempotencyKey: key() });
  const { facts } = await readContributionView(database.db, source.id);
  expect(facts).toMatchObject({ authors: ['t-exec'], reviewers: ['t-indep'], strictExcluded: ['t-exec', 't-explicit', 't-indep'] });

  const dependent = await engineering('dependent whose strict source has a hand who reviewed it');
  await setPolicy(dependent.id, [source.id]);
  for (const who of ['exec', 'explicit', 'indep'] as const) {
    const refusal = await failureOf(core.claim(tokens[who]!, dependent.id));
    expect(refusal.code).toBe('forbidden');
    expect(refusal.message).toContain('independence conflict');
    expect(refusal.details).toMatchObject({ conflicts: [expect.objectContaining({ source: source.id, employee: `t-${who}`, via: 'contributor' })] });
  }
  expect((await core.claim(tokens.alias, dependent.id)).task.currentEmployee).toBe('t-alias');
});

test('the dispatcher reads the same exclusion from the audit stream: the contributor and its alias are out, the independent engineer stays in', async () => {
  const parent = await engineering('parent for the candidate pool');
  await authorParent('src', parent.id);
  const dependent = await engineering('dependent for the candidate pool');
  await setPolicy(dependent.id, [parent.id]);
  const policy = (await core.getTask(tokens.gm, dependent.id)).independence!;
  const scope = await readIndependenceSnapshot(database.db, policy);
  expect(scope.sources).toEqual([expect.objectContaining({ taskId: parent.id, version: expect.any(Number) })]);
  expect(independenceHit(scope.index, 't-src', undefined)).toMatchObject({ via: 'contributor', source: parent.id });
  // The alias is not a contributor: it is excluded through the registered principal its contributor carries.
  expect(independenceHit(scope.index, 't-alias', 'ppl-factory')).toMatchObject({ via: 'same_principal', matched: 't-src', principal: 'ppl-factory' });
  expect(independenceHit(scope.index, 't-indep', undefined)).toBeUndefined();
});

test('review stage: a source contributor may not review the dependent, the independent reviewer may', async () => {
  const parent = await engineering('parent whose contributor must not review');
  await authorParent('src', parent.id);
  const dependent = await engineering('dependent reviewed under a review-stage policy');
  await setPolicy(dependent.id, [parent.id], { stages: ['review'] });
  const executed = await core.claim(tokens.exec, dependent.id);
  await core.submit(tokens.exec, proofOf(executed), { text: EVIDENCE, idempotencyKey: key() });
  expect((await core.getTask(tokens.gm, dependent.id)).state).toBe('review');

  const refusal = await failureOf(core.claim(tokens.src, dependent.id));
  expect(refusal.message).toContain('independence conflict');
  expect((await core.claim(tokens.indep, dependent.id)).task.currentEmployee).toBe('t-indep');
});

test('review decisions are gated too: a reviewer who became a source contributor after claiming can neither accept nor return', async () => {
  const parent = await engineering('parent whose implementer is taken over after the review claim');
  const dependent = await engineering('dependent decided under a review-stage policy');
  await setPolicy(dependent.id, [parent.id], { stages: ['review'] });
  const executed = await core.claim(tokens.exec, dependent.id);
  await core.submit(tokens.exec, proofOf(executed), { text: EVIDENCE, idempotencyKey: key() });
  const reviewing = await core.claim(tokens.indep, dependent.id);
  await core.implementerTakeover(tokens.gm, { taskId: parent.id, toEmployee: 't-indep', expectedVersion: await versionOf(parent.id),
    reason: '经理指定 indep 接手源任务（复核后新贡献）', idempotencyKey: key() });

  const refusals = [
    await failureOf(core.accept(tokens.indep, proofOf(reviewing), { text: EVIDENCE, idempotencyKey: key() })),
    await failureOf(core.returnTask(tokens.indep, proofOf(reviewing), { text: EVIDENCE, idempotencyKey: key() })),
  ];
  for (const refusal of refusals) {
    expect(refusal.code).toBe('forbidden');
    expect(refusal.details).toMatchObject({ conflicts: [{ task: dependent.id, source: parent.id, employee: 't-indep', via: 'contributor' }] });
  }
  const held = await core.getTask(tokens.gm, dependent.id);
  expect(held.state).toBe('review');
  expect(held.currentEmployee).toBe('t-indep');
});

/** Candidate pool of an engineering dispatch over the policy fixtures: the registered definitions and their instances. */
const poolDef = (id: string): EmployeeDef => ({ id, role: 'engineering', provider: 'codex', model: 'm1', enabled: true,
  maxInstances: 4, priority: 100, weight: 10, scored: 0, errorStreak: 0 });
const poolInst = (id: string, def: string, principal?: string): EmployeeInst => ({ id, role: 'engineering', def, provider: 'codex',
  model: 'm1', paseoAgentId: `ag-${id}`, ...(principal ? { principal } : {}) });
// The registered principal (identity link) the fixture registers in beforeAll, not the definition.
const POOL_INSTS = [poolInst('t-src', 'eng-factory', 'ppl-factory'), poolInst('t-alias', 'eng-factory', 'ppl-factory'),
  poolInst('t-indep', 'eng-claude'), poolInst('t-explicit', 'eng-qa'), poolInst('t-exec', 'eng-exec')];
const POOL_DEFS = ['eng-factory', 'eng-claude', 'eng-qa', 'eng-exec'].map(id => poolDef(id));
const POOL_STATES = new Map<string, InstState>(POOL_INSTS.map((inst): [string, InstState] => [inst.id, 'idle']));
const pool = (task: SupervisedTask, independence: IndependenceScope | undefined) => staffingPool({
  role: 'engineering', home: '/ops/repo', opsRepo: '/ops/repo', sidecar: false, now: 1_000_000,
  defs: POOL_DEFS, insts: POOL_INSTS, states: POOL_STATES, holding: new Set(), health: new Map(), quotaBlocked: new Map(),
  busyBy: new Map(), providerMax: { codex: 9 }, slots: new Map(), task, independence,
});
const entryOf = (entries: ReturnType<typeof staffingPool>, key: string) => entries.find(entry => entry.key === key);

test('the candidate pool built from the stored policy drops a contributor that appears after the policy, and its alias, on the next pass', async () => {
  const parent = await engineering('parent authored after the policy for the candidate pool');
  const dependent = await engineering('dependent whose candidates are read on every pass');
  await setPolicy(dependent.id, [parent.id]);
  const dispatchPass = async () => {
    const task = await core.getTask(tokens.gm, dependent.id);
    return pool({ id: dependent.id } as unknown as SupervisedTask, await workforce.independenceScope(task.independence, 'execute'));
  };
  // Before the source has any contributor, its employee is an ordinary candidate.
  expect(entryOf(await dispatchPass(), 't-src')).toMatchObject({ eligible: true });

  await authorParent('src', parent.id);
  const entries = await dispatchPass();
  expect(entryOf(entries, 't-src')).toMatchObject({ eligible: false, code: 'independence_conflict' });
  // The registered alias is out; a spawn of the same def is a new employee id with no principal, so it stays eligible.
  expect(entryOf(entries, 't-alias')).toMatchObject({ eligible: false, code: 'independence_conflict' });
  expect(entryOf(entries, 'spawn:eng-factory')).toMatchObject({ eligible: true });
  expect(entryOf(entries, 't-indep')).toMatchObject({ eligible: true });
  expect(entryOf(entries, 'spawn:eng-claude')).toMatchObject({ eligible: true });
});

test('an unreadable source history refuses the submit fail-closed: the lease stays put, nothing is written, and the same submit lands once history reads', async () => {
  const parent = await engineering('parent whose history is unreadable at submit');
  const dependent = await engineering('dependent submitted while the source history is unreadable');
  await setPolicy(dependent.id, [parent.id]);
  const claimed = await core.claim(tokens.indep, dependent.id);
  const before = await core.getTask(tokens.gm, dependent.id);

  seam.source = async (taskId: string) => { if (taskId === parent.id) throw new Error('audit read failed'); };
  try {
    const refusal = await failureOf(core.submit(tokens.indep, proofOf(claimed), { text: EVIDENCE, idempotencyKey: key() }));
    expect(refusal.code).toBe('temporarily_unavailable');
    expect(refusal.retryable).toBe(true);
  } finally {
    seam.source = undefined;
  }
  expect(await core.getTask(tokens.gm, dependent.id)).toMatchObject({ state: 'doing', currentEmployee: 't-indep', version: before.version });

  expect((await core.submit(tokens.indep, proofOf(claimed), { text: EVIDENCE, idempotencyKey: key() })).state).toBe('review');
});

test('a policy version this build does not read fails closed: the claim is refused and every candidate reads as unknown', async () => {
  const parent = await engineering('parent under a policy version this build does not read');
  const dependent = await engineering('dependent whose stored policy version is unknown');
  await setPolicy(dependent.id, [parent.id]);
  await database.db.query('UPDATE ONLY $task SET independence.schema = 2;', { task: new RecordId('task', dependent.id) });

  const refusal = await failureOf(core.claim(tokens.indep, dependent.id));
  expect(refusal.code).toBe('forbidden');
  expect(refusal.message).toContain('not understood');
  expect((await core.getTask(tokens.gm, dependent.id)).currentEmployee).toBeUndefined();

  const scope = await workforce.independenceScope((await core.getTask(tokens.gm, dependent.id)).independence, 'execute');
  expect(scope).toMatchObject({ kind: 'unverifiable' });
  const entries = pool({ id: dependent.id } as unknown as SupervisedTask, scope);
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every(entry => !entry.eligible && entry.code === 'unknown')).toBe(true);
});

test('an incomplete stored policy fails closed: a missing, empty, unknown or mistyped field refuses the claim and reads every candidate as unknown', async () => {
  const parent = await engineering('parent under an incomplete stored policy');
  for (const corruption of [
    'independence.stages = NONE', 'independence.stages = []', 'independence.stages = ["merge"]', 'independence.mode = "bogus"',
    'independence.sources = NONE', 'independence.excluded = "t-src"',
  ]) {
    const dependent = await engineering(`dependent whose stored policy is corrupt: ${corruption}`);
    await setPolicy(dependent.id, [parent.id]);
    await database.db.query(`UPDATE ONLY $task SET ${corruption};`, { task: new RecordId('task', dependent.id) });

    const refusal = await failureOf(core.claim(tokens.indep, dependent.id));
    expect(refusal.code).toBe('forbidden');
    expect(refusal.message).toContain('incomplete');
    expect((await core.getTask(tokens.gm, dependent.id)).currentEmployee).toBeUndefined();

    // The stage list cannot be trusted, so the policy is unverifiable at every stage, not only at the ones it names.
    const stored = (await core.getTask(tokens.gm, dependent.id)).independence;
    expect(await workforce.independenceScope(stored, 'execute')).toMatchObject({ kind: 'unverifiable' });
    expect(await workforce.independenceScope(stored, 'review')).toMatchObject({ kind: 'unverifiable' });
    const entries = pool({ id: dependent.id } as unknown as SupervisedTask, await workforce.independenceScope(stored, 'execute'));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => !entry.eligible && entry.code === 'unknown')).toBe(true);
  }
});

test('a source record that no longer exists refuses the claim as not found, and the verdict names that source', async () => {
  const gone = 'task-source-removed';
  const parent = await engineering('parent whose record is removed after the policy');
  const dependent = await engineering('dependent whose source record is gone');
  await setPolicy(dependent.id, [parent.id]);
  await database.db.query('UPDATE ONLY $task SET independence.sources = [$gone];', { task: new RecordId('task', dependent.id), gone });

  const refusal = await failureOf(core.claim(tokens.indep, dependent.id));
  expect(refusal.code).toBe('not_found');
  expect(refusal.message).toContain(gone);
  expect((await core.getTask(tokens.gm, dependent.id)).currentEmployee).toBeUndefined();

  const scope = await workforce.independenceScope((await core.getTask(tokens.gm, dependent.id)).independence, 'execute');
  expect(scope).toMatchObject({ kind: 'unverifiable', source: gone });
  const verdict = evaluateDispatch({ taskId: dependent.id, title: 'dependent', phase: 'execute', role: 'engineering', home: '/ops/repo',
    entries: pool({ id: dependent.id } as unknown as SupervisedTask, scope), checkedAt: 1_000_000 });
  expect(verdict).toMatchObject({ dispatchable: false, feasible: false });
  expect(verdict.reasons).toEqual([expect.objectContaining({ code: 'unknown' })]);
  expect(verdict.reasons[0]!.text).toContain(gone);
});

test('the verdict and its notice name the source task and each excluded candidate, read from the stored policy', async () => {
  const parent = await engineering('parent whose contributor the verdict must name');
  await authorParent('src', parent.id);
  const dependent = await engineering('dependent whose excluded candidates are the only ones left');
  await setPolicy(dependent.id, [parent.id]);
  const scope = await workforce.independenceScope((await core.getTask(tokens.gm, dependent.id)).independence, 'execute');
  // Only the excluded candidates are left in the pool, so the verdict must say why none of them can take the task.
  const excluded = pool({ id: dependent.id } as unknown as SupervisedTask, scope).filter(entry => !entry.eligible);
  const verdict = evaluateDispatch({ taskId: dependent.id, title: 'dependent', phase: 'execute', role: 'engineering', home: '/ops/repo',
    entries: excluded, checkedAt: 1_000_000 });
  expect(verdict).toMatchObject({ dispatchable: false, feasible: false });
  expect(verdict.reasons).toEqual([expect.objectContaining({ code: 'independence_conflict', candidates: expect.arrayContaining(['t-src', 't-alias']) })]);
  expect(verdict.reasons[0]!.text).toContain(parent.id);
  expect(verdict.reasons[0]!.text).toContain('t-src');
  expect(dispatchNoticeText(verdict)).toContain(parent.id);
});
