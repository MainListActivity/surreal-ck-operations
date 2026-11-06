/**
 * FV06 control-plane gap · append prerequisites to an existing dependency wait.
 *
 * A task already in a formal dependency wait is blocked with blocked_to=NONE, so defer_task_until
 * refuses it ("only applies to gm-blocked execute or normal review-phase tasks"). The narrow gm
 * tool must append real prerequisites without faking a resume/block state, preserve the original
 * wait reference and existing dependencies, set continuation=manager, and never auto-resume.
 *
 * The fork regressions below cover the success path, manager continuation, replay/CAS, and every
 * refusal the spec names: owner gates, review-phase waits, live leases, cross-goal, cycles,
 * terminal tasks, non-gm actors and a "no new dependency" no-op.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { CompanyError } from '../src/core-errors.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { WaitStore } from '../src/wait-store.ts';
import type { ClaimResult, CreateTask, Evidence, LeaseProof, TaskView } from '../src/contracts.ts';

const NS = 'sck_agent_company_test_dep_append';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(300_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-dep-append-'));
const core = new SurrealCompanyCore(database);
const owner = new OwnerDesk(database);
const tokens: Record<string, string> = {};

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  const enrollment = new LocalEnrollmentAdmin(database);
  for (const [name, role, caps] of [
    ['owner', 'owner', ['execute', 'review', 'manage']],
    ['gm2', 'owner', ['execute', 'review', 'manage']],
    ['eng', 'engineering', ['execute', 'review']],
    ['eng2', 'engineering', ['execute', 'review']],
    ['qa', 'qa', ['execute', 'review']],
    ['product', 'product', ['execute', 'review', 'manage']],
  ] as const) tokens[name] = await enrollment.enroll(`a-${name}`, role, caps);
});

afterAll(async () => {
  await database.close();
  rmSync(credDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await database.db.query(`DELETE task_wait; DELETE wait_event;
    UPDATE task SET state = 'done', evaluated_at = time::now(), current_employee = NONE, delivery_id = NONE,
      lease_expires_at = NONE WHERE state != 'done';
    UPDATE employee SET active_task = NONE WHERE active_task != NONE;`);
});

let seq = 0;
const key = () => crypto.randomUUID();
const evidence = (tag: string): Evidence => ({ text: `FV06 回归证据 ${tag}：受控追加依赖前置，来源任务必须保持 blocked，不得自动 resume。`, idempotencyKey: key() });
const proofOf = (c: ClaimResult) => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });

async function makeTask(title: string, opts: { reviewerRole?: 'qa' | 'owner'; goalId?: string; dependencies?: string[] } = {}): Promise<string> {
  const task = await core.createTask(tokens.owner!, {
    title: `${title} ${++seq}`, context: 'FV06 控制面受控追加依赖前置的回归夹具，任务本身不产生真实交付。',
    executorRole: 'engineering', reviewerRole: opts.reviewerRole ?? 'engineering', workIntent: { kind: 'read' },
    ...(opts.goalId === undefined ? {} : { goalId: opts.goalId }),
    ...(opts.dependencies === undefined ? {} : { dependencies: opts.dependencies }),
    idempotencyKey: key(),
  } as CreateTask);
  return task.id;
}

async function claim(taskId: string, employee = 'eng'): Promise<ClaimResult> {
  return await core.claim(tokens[employee]!, taskId) as ClaimResult;
}

async function execute(taskId: string, employee = 'eng'): Promise<void> {
  const held = await claim(taskId, employee);
  await core.submit(tokens[employee]!, proofOf(held), evidence(`submit-${taskId}`));
}

async function review(taskId: string, reviewer = 'eng2'): Promise<void> {
  const held = await claim(taskId, reviewer);
  await core.accept(tokens[reviewer]!, proofOf(held), evidence(`accept-${taskId}`));
}

/** Claim, then enter a formal dependency wait on `referenceTaskId`. Returns the waiting task view. */
async function enterDependencyWait(taskId: string, referenceTaskId: string, employee = 'eng', ownerRole?: string): Promise<TaskView> {
  const held = await claim(taskId, employee);
  return await core.wait(tokens[employee]!, proofOf(held), evidence(`wait-${taskId}`), {
    kind: 'dependency', referenceTaskId, ownerRole,
    reason: 'FV06 回归：任务已在正式依赖等待中，需要受控追加前置而不能用 resume/block 循环改变状态。',
  } as never);
}

async function expectRefused(promise: Promise<unknown>, code: CompanyError['code'], pattern: RegExp) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CompanyError);
  if ((error as CompanyError).code !== code) console.log(`expectRefused: expected ${code}, got ${(error as CompanyError).code}: ${(error as CompanyError).message}`);
  expect((error as CompanyError).code).toBe(code);
  expect((error as CompanyError).message).toMatch(pattern);
}

const waitOf = (taskId: string) => new WaitStore(database.db).openOfTask(taskId);
const rowOf = async (taskId: string) => {
  const [rows] = await database.db.query<[Array<Record<string, unknown>>]>('SELECT * FROM $task;', { task: new RecordId('task', taskId) });
  return rows?.[0] ?? {};
};

describe('append prerequisites to an existing dependency wait', () => {
  test('appends real same-goal prerequisites, preserves the wait reference and deps, sets manager continuation, and never resumes', async () => {
    const ref = await makeTask('原等待引用');
    const source = await makeTask('已在依赖等待的来源');
    await enterDependencyWait(source, ref);
    const before = await core.getTask(tokens.owner!, source);
    expect(before).toMatchObject({ state: 'blocked', resumeState: 'ready', waiting: { kind: 'dependency' } });
    expect(before.blockedTo).toBeUndefined();
    const waitBefore = await waitOf(source);
    expect(waitBefore?.referenceTaskId).toBe(ref);

    const deps = [await makeTask('新增前置A'), await makeTask('新增前置B'), await makeTask('新增前置C'), await makeTask('新增前置D')];
    const input = {
      taskId: source, dependencies: deps, expectedVersion: before.version,
      text: '受控追加四项真实前置：原等待引用保留，新增前置完成前来源任务保持 blocked，完成后回到 GM 而不是自动恢复。',
      idempotencyKey: key(),
    };
    const appended = await core.appendDependencyPrerequisites(tokens.owner!, input);
    expect(appended).toMatchObject({ state: 'blocked', resumeState: 'ready', dependencyContinuation: 'manager' });
    expect(appended.blockedTo).toBeUndefined();
    expect(appended.dependencies).toEqual(deps);
    expect(appended.version).toBe(before.version + 1);
    expect(appended.waiting).toMatchObject({ kind: 'dependency' });
    // The original wait reference is untouched; existing dependency list was empty and stays a prefix.
    expect((await waitOf(source))?.referenceTaskId).toBe(ref);

    const [[audit]] = await database.db.query<[[Record<string, unknown>]]>(
      `SELECT * FROM audit WHERE task = $task AND action = 'dependency_prerequisites_appended' ORDER BY at DESC LIMIT 1;`,
      { task: new RecordId('task', source) });
    expect(audit).toMatchObject({
      source_phase: 'ready', continuation: 'manager', operator: 'a-gm',
      wait_key: waitBefore?.waitKey, reference_task: new RecordId('task', ref),
    });
    expect((audit.dependencies_after as unknown[]).length).toBe(4);
    const [[outbox]] = await database.db.query<[[Record<string, unknown>]]>(
      `SELECT * FROM outbox WHERE task = $task AND kind = 'dependency_prerequisites_appended' ORDER BY at DESC LIMIT 1;`,
      { task: new RecordId('task', source) });
    expect((outbox.payload as Record<string, unknown>)).toMatchObject({ continuation: 'manager', added: 4 });

    // Same key + same payload replays without a write; a different payload conflicts; a stale version conflicts.
    expect(await core.appendDependencyPrerequisites(tokens.owner!, input)).toMatchObject({ version: appended.version });
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, { ...input, text: '同一幂等键但业务理由不同，必须冲突而不是重放。' }),
      'conflict', /different input/);
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, { ...input, idempotencyKey: key(), expectedVersion: before.version }),
      'conflict', /version moved/);

    // Nothing is finished: a scheduler release tick must not release the wait, and the source stays blocked.
    await new WaitStore(database.db).releaseDue(Date.now());
    expect(await core.getTask(tokens.owner!, source)).toMatchObject({ state: 'blocked', dependencyContinuation: 'manager' });

    // The original reference finishing alone is not enough: the appended prerequisites still hold it.
    await execute(ref); await review(ref);
    await new WaitStore(database.db).releaseDue(Date.now());
    expect((await core.getTask(tokens.owner!, source)).state).toBe('blocked');

    // All prerequisites finish: the wait releases into a GM gate, never into ready work.
    for (const dep of deps) { await execute(dep); await review(dep); }
    const released = await new WaitStore(database.db).releaseDue(Date.now());
    expect(released.released.map(r => r.taskId)).toContain(source);
    const gated = await core.getTask(tokens.owner!, source);
    expect(gated).toMatchObject({ state: 'blocked', blockedTo: 'owner', resumeState: 'ready' });
    expect(gated.dependencyContinuation).toBeUndefined();
    expect(gated.waiting).toMatchObject({ kind: 'owner' });
    const [[releaseAudit]] = await database.db.query<[[Record<string, unknown>]]>(
      `SELECT * FROM audit WHERE task = $task AND action = 'wait_released' ORDER BY at DESC LIMIT 1;`,
      { task: new RecordId('task', source) });
    expect(releaseAudit).toMatchObject({ continuation: 'manager' });

    // No fault/budget was cleared or created; an expired window is still the later resume's problem.
    expect((await rowOf(source)).recovery_stopped).toBeUndefined();
    expect(gated.executionWindow).toBeUndefined();
    const [[faultLifts]] = await database.db.query<[[Record<string, unknown>]]>(
      `SELECT count() AS n FROM audit WHERE task = $task AND action = 'fault_lift' GROUP ALL;`,
      { task: new RecordId('task', source) });
    expect(Number(faultLifts?.n ?? 0)).toBe(0);

    // Only the manager can resume the released gate.
    const resumed = await core.resume(tokens.owner!, source, evidence('manager-resume'));
    expect(resumed.state).toBe('ready');
  });

  test('ordinary dependency waits still restore their original phase when no continuation was set', async () => {
    const ref = await makeTask('普通等待引用');
    const source = await makeTask('普通依赖等待');
    await enterDependencyWait(source, ref);
    await execute(ref); await review(ref);
    const released = await new WaitStore(database.db).releaseDue(Date.now());
    expect(released.released.map(r => r.taskId)).toContain(source);
    expect(await core.getTask(tokens.owner!, source)).toMatchObject({ state: 'ready', blockedTo: undefined });
  });

  test('a review-phase dependency wait restores review without a manager continuation (existing behavior)', async () => {
    const ref = await makeTask('复核等待引用');
    const source = await makeTask('复核阶段依赖等待', { reviewerRole: 'qa' });
    await execute(source);
    const reviewClaim = await claim(source, 'qa');
    await core.wait(tokens.qa!, proofOf(reviewClaim), evidence('review-wait'), {
      kind: 'dependency', referenceTaskId: ref,
      reason: '复核阶段真实阻塞：等待引用任务完成前不重复实测。',
    } as never);
    expect((await core.getTask(tokens.owner!, source)).resumeState).toBe('review');
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [await makeTask('复核等待新前置')], expectedVersion: (await core.getTask(tokens.owner!, source)).version,
      text: '复核阶段的依赖等待不能使用执行阶段的受控追加，必须保留原复核岗位。', idempotencyKey: key(),
    }), 'invalid', /execute-phase/);
  });
});

describe('refusals', () => {
  test('only gm may append', async () => {
    const ref = await makeTask('非GM引用');
    const source = await makeTask('非GM来源');
    await enterDependencyWait(source, ref);
    const v = (await core.getTask(tokens.owner!, source)).version;
    const dep = await makeTask('非GM前置');
    for (const actor of ['product', 'eng'] as const) {
      await expectRefused(core.appendDependencyPrerequisites(tokens[actor]!, {
        taskId: source, dependencies: [dep], expectedVersion: v,
        text: '非经理不能追加依赖前置，受控工具只对 gm 开放。', idempotencyKey: key(),
      }), 'forbidden', /Only gm|Capability denied/);
    }
  });

  test('owner gates and owner-owned waits are refused', async () => {
    const ref = await makeTask('owner引用');
    const ownerTask = await makeTask('owner关口任务', { reviewerRole: 'owner' });
    await enterDependencyWait(ownerTask, ref);
    const v = (await core.getTask(tokens.owner!, ownerTask)).version;
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: ownerTask, dependencies: [await makeTask('owner新前置')], expectedVersion: v,
      text: '老板关口不能被追加前置绕过；依赖等待只服务普通执行任务。', idempotencyKey: key(),
    }), 'invalid', /Owner-gated/);

    const normal = await makeTask('owner等待角色任务');
    await enterDependencyWait(normal, ref, 'eng', 'owner');
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: normal, dependencies: [await makeTask('owner角色新前置')], expectedVersion: (await core.getTask(tokens.owner!, normal)).version,
      text: '等待的 ownerRole 是老板时同样视为老板关口，不能追加前置。', idempotencyKey: key(),
    }), 'invalid', /Owner-gated/);
  });

  test('a live lease blocks the append', async () => {
    const ref = await makeTask('租约引用');
    const source = await makeTask('活动租约来源');
    await enterDependencyWait(source, ref);
    await database.db.query(`UPDATE $task SET current_employee = $emp, lease_expires_at = time::unix(time::now()) + 600,
      delivery_id = 'late-lease', fence += 1;`, { task: new RecordId('task', source), emp: new RecordId('employee', 'a-eng') });
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [await makeTask('租约新前置')], expectedVersion: (await rowOf(source)).version as number,
      text: '来源任务仍有活动租约时不得追加前置，避免与在途持有人的写入竞争。', idempotencyKey: key(),
    }), 'conflict', /active lease/);
  });

  test('cross-goal and cyclic dependencies are refused', async () => {
    const goal = await owner.createGoal({ text: 'FV06 跨目标回归', source: 'owner:test', key: key(), tier: 'quick' });
    const ref = await makeTask('跨目标引用');
    const source = await makeTask('跨目标来源');
    await enterDependencyWait(source, ref);

    const foreign = await makeTask('异目标前置', { goalId: goal.id });
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [foreign], expectedVersion: (await core.getTask(tokens.owner!, source)).version,
      text: '依赖必须与来源任务同目标，跨目标前置一律拒绝。', idempotencyKey: key(),
    }), 'invalid', /same goal/);

    // A task that already depends on the source would close a cycle if appended to it.
    const back = await makeTask('反向依赖', { dependencies: [source] });
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [back], expectedVersion: (await core.getTask(tokens.owner!, source)).version,
      text: '反向依赖会形成环，追加前置前必须走依赖图闭包检查。', idempotencyKey: key(),
    }), 'invalid', /cycle/);
  });

  test('self, duplicate-only and non-dependency waits are refused', async () => {
    const ref = await makeTask('参数引用');
    const source = await makeTask('参数来源');
    await enterDependencyWait(source, ref);
    const v = (await core.getTask(tokens.owner!, source)).version;

    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [source], expectedVersion: v,
      text: '任务不能把自己追加为前置，自依赖会被依赖图检查拒绝。', idempotencyKey: key(),
    }), 'invalid', /itself/);

    const dep = await makeTask('先追加的前置');
    await core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [dep], expectedVersion: v,
      text: '先追加一项真实前置，随后重复同一前置必须被拒绝。', idempotencyKey: key(),
    });
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [dep], expectedVersion: (await core.getTask(tokens.owner!, source)).version,
      text: '重复追加同一前置没有产生新的依赖边，必须拒绝而不是空写审计。', idempotencyKey: key(),
    }), 'invalid', /not already present|no new dependency/i);

    const timeTask = await makeTask('时间等待任务');
    const held = await claim(timeTask);
    await core.wait(tokens.eng!, proofOf(held), evidence('time-wait'), {
      kind: 'time', notBefore: new Date(Date.now() + 3_600_000).toISOString(),
      reason: '时间等待不是正式依赖等待，受控追加工具不得作用于它。',
    } as never);
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: timeTask, dependencies: [await makeTask('时间等待前置')], expectedVersion: (await core.getTask(tokens.owner!, timeTask)).version,
      text: '时间等待与依赖等待语义不同，不能追加依赖前置。', idempotencyKey: key(),
    }), 'invalid', /formal dependency wait/);
  });

  test('terminal tasks are refused', async () => {
    const done = await makeTask('已完成任务');
    await execute(done); await review(done);
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: done, dependencies: [await makeTask('已完成前置')], expectedVersion: (await core.getTask(tokens.owner!, done)).version,
      text: '已完成任务没有依赖等待，不能追加前置，终态任务一律拒绝。', idempotencyKey: key(),
    }), 'invalid', /formal dependency wait/);

    const voided = await makeTask('将作废任务');
    await core.retireTask(tokens.owner!, { taskId: voided, text: '回归作废', idempotencyKey: key() });
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: voided, dependencies: [await makeTask('作废前置')], expectedVersion: (await core.getTask(tokens.owner!, voided)).version,
      text: '已作废任务没有依赖等待，不能追加前置，终态任务一律拒绝。', idempotencyKey: key(),
    }), 'invalid', /formal dependency wait/);
  });

  test('a void prerequisite never auto-authorizes an expired execution window', async () => {
    const ref = await makeTask('过期窗口引用');
    const source = await makeTask('过期窗口来源');
    await enterDependencyWait(source, ref);
    const dep = await makeTask('将被作废的前置');
    await core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [dep], expectedVersion: (await core.getTask(tokens.owner!, source)).version,
      text: '追加一项前置；即使该前置之后作废，也不能让过期的执行窗口自动获得授权。', idempotencyKey: key(),
    });
    // void counts as satisfied for dependency release, but it must not authorize a stale window.
    await core.retireTask(tokens.owner!, { taskId: dep, text: '回归：把新增前置作废，验证 void 不授权过期窗口。', idempotencyKey: key() });
    await execute(ref); await review(ref);
    await database.db.query(`UPDATE $task SET execution_window = $window;`, {
      task: new RecordId('task', source),
      window: {
        approvalTask: 'expired-approval', configurationDigest: 'x'.repeat(64), evidenceExpiresAt: '2020-01-01T00:00:00.000Z',
        minRemainingSeconds: 60, notAfter: '2020-01-01T00:00:00.000Z',
      },
    });
    await new WaitStore(database.db).releaseDue(Date.now());
    const gated = await core.getTask(tokens.owner!, source);
    expect(gated).toMatchObject({ state: 'blocked', blockedTo: 'owner' });
    await expectRefused(core.resume(tokens.owner!, source, evidence('expired-window-resume')), 'invalid', /window expired/i);
  });

  test('concurrent appends under the same expected version: exactly one wins', async () => {
    const ref = await makeTask('并发引用');
    const source = await makeTask('并发来源');
    await enterDependencyWait(source, ref);
    const v = (await core.getTask(tokens.owner!, source)).version;
    const a = await makeTask('并发前置A');
    const b = await makeTask('并发前置B');
    const results = await Promise.allSettled([
      core.appendDependencyPrerequisites(tokens.owner!, {
        taskId: source, dependencies: [a], expectedVersion: v,
        text: '并发 A：同一版本下两个经理同时追加不同前置，只能有一个提交成功。', idempotencyKey: key(),
      }),
      core.appendDependencyPrerequisites(tokens.owner!, {
        taskId: source, dependencies: [b], expectedVersion: v,
        text: '并发 B：同一版本下两个经理同时追加不同前置，只能有一个提交成功。', idempotencyKey: key(),
      }),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as CompanyError).code).toBe('conflict');
    const after = await core.getTask(tokens.owner!, source);
    expect(after.version).toBe(v + 1);
    expect(after.dependencies).toHaveLength(1);
    expect([a, b]).toContain(after.dependencies![0]!);
  });
});

/**
 * Legacy defer waits: defer_task_until leaves a blocked execute-phase task with unmet
 * dependencies but NO task_wait row, so the formal-wait gate refused it in production
 * (v0.3.28, task ee1f0f21). The compat path only accepts an auditable legacy wait — a real
 * deferred audit plus at least one unmet dependency — builds the canonical wait row inside
 * the same controlled transaction, and keeps every other gate (CAS, idempotency, same goal,
 * closure cycles, epoch, owner/review/gm-block/live-lease refusals) unchanged.
 */
describe('append prerequisites to a legacy defer wait (defer_task_until compat)', () => {
  /** eng 领取（doing）→ 交回 gm → gm 以经理续接 defer：生产 ee1f0f21 的真实存量形状。 */
  async function legacyDoing(taskId: string, referenceTaskId: string): Promise<TaskView> {
    const held = await claim(taskId, 'eng');
    await core.block(tokens.eng!, proofOf(held), 'owner', evidence(`gm-block-${taskId}`));
    return await core.deferTaskUntil(tokens.owner!, {
      taskId, dependencies: [referenceTaskId], continuation: 'manager',
      text: 'FV06 回归：经理以 defer 产生存量执行依赖等待（无等待实体），验证受控追加能兼容。',
      idempotencyKey: key(),
    }) as TaskView;
  }

  test('a real defer_task_until wait from doing appends, builds the canonical wait and never resumes', async () => {
    const ref = await makeTask('存量引用');
    const source = await makeTask('存量defer来源');
    const deferred = await legacyDoing(source, ref);
    expect(deferred).toMatchObject({ state: 'blocked', resumeState: 'doing', dependencyContinuation: 'manager' });
    expect(deferred.blockedTo).toBeUndefined();
    // 存量等待没有 task_wait 实体：list_task_waits 为空，正式等待门禁在此拒绝。
    expect(await waitOf(source)).toBeUndefined();

    const deps = [await makeTask('存量前置A'), await makeTask('存量前置B')];
    const before = await core.getTask(tokens.owner!, source);
    const input = {
      taskId: source, dependencies: deps, expectedVersion: before.version,
      text: '受控追加兼容存量等待：在同一受控事务补建规范等待行并设经理续接，不伪造 ready、不 resume、不清故障。',
      idempotencyKey: key(),
    };
    const appended = await core.appendDependencyPrerequisites(tokens.owner!, input);
    expect(appended).toMatchObject({ state: 'blocked', resumeState: 'doing', dependencyContinuation: 'manager' });
    expect(appended.blockedTo).toBeUndefined();
    expect(appended.waiting).toMatchObject({ kind: 'dependency', resumeState: 'doing' });
    expect(appended.dependencies).toEqual([ref, ...deps]);
    // 规范等待行已原子建立，引用=首个未完成依赖；普通 release 路径从此可见。
    const wait = await waitOf(source);
    expect(wait?.kind).toBe('dependency');
    expect(wait?.state).toBe('waiting');
    expect(wait?.referenceTaskId).toBe(ref);

    const [[audit]] = await database.db.query<[[Record<string, unknown>]]>(
      `SELECT * FROM audit WHERE task = $task AND action = 'dependency_prerequisites_appended' ORDER BY at DESC LIMIT 1;`,
      { task: new RecordId('task', source) });
    expect(audit).toMatchObject({
      source_phase: 'doing', continuation: 'manager', operator: 'a-gm', legacy_wait: true,
      wait_key: wait?.waitKey, reference_task: new RecordId('task', ref),
    });
    const [[outbox]] = await database.db.query<[[Record<string, unknown>]]>(
      `SELECT * FROM outbox WHERE task = $task AND kind = 'dependency_prerequisites_appended' ORDER BY at DESC LIMIT 1;`,
      { task: new RecordId('task', source) });
    expect(outbox.payload as Record<string, unknown>).toMatchObject({ continuation: 'manager', added: 2, legacy_wait: true });

    // 同键同负载幂等重放；同键不同负载冲突。
    expect(await core.appendDependencyPrerequisites(tokens.owner!, input)).toMatchObject({ version: appended.version });
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, { ...input, text: '同一幂等键但业务理由不同，必须冲突而不是重放旧结果。' }),
      'conflict', /different input/);

    // 调度 tick 不释放：引用未完成。
    await new WaitStore(database.db).releaseDue(Date.now());
    expect((await core.getTask(tokens.owner!, source)).state).toBe('blocked');
    // 引用单独完成不够：UNLOCK 跳过正式等待中的任务，WaitStore 也不释放。
    await execute(ref); await review(ref);
    await new WaitStore(database.db).releaseDue(Date.now());
    expect((await core.getTask(tokens.owner!, source)).state).toBe('blocked');

    // 全部前置完成 → 回到 GM 关口（resume_state 保持 doing），经理 resume 才回到 doing。
    for (const dep of deps) { await execute(dep); await review(dep); }
    const released = await new WaitStore(database.db).releaseDue(Date.now());
    expect(released.released.map(r => r.taskId)).toContain(source);
    const gated = await core.getTask(tokens.owner!, source);
    expect(gated).toMatchObject({ state: 'blocked', blockedTo: 'owner', resumeState: 'doing' });
    expect(gated.dependencyContinuation).toBeUndefined();
    // resume 把 doing 相位恢复为 ready 重新派工（core.resume 的固定语义）。
    expect((await core.resume(tokens.owner!, source, evidence('manager-resume-legacy'))).state).toBe('ready');
    expect((await rowOf(source)).recovery_stopped).toBeUndefined();
  });

  test('a legacy wait in the ready phase (after a manager release) appends and releases to the GM gate', async () => {
    const first = await makeTask('第一轮引用');
    const source = await makeTask('legacy-ready来源');
    await enterDependencyWait(source, first);
    const dep1 = await makeTask('第一轮前置');
    await core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [dep1], expectedVersion: (await core.getTask(tokens.owner!, source)).version,
      text: '第一轮受控追加（正式等待），完成后回到 GM 关口。', idempotencyKey: key(),
    });
    await execute(first); await review(first); await execute(dep1); await review(dep1);
    const released = await new WaitStore(database.db).releaseDue(Date.now());
    expect(released.released.map(r => r.taskId)).toContain(source);
    expect(await core.getTask(tokens.owner!, source)).toMatchObject({ state: 'blocked', blockedTo: 'owner', resumeState: 'ready' });

    // 经理再次 defer（新的未完成前置、经理续接）：得到 legacy-ready 形状（无等待行）。
    const second = await makeTask('第二轮引用');
    const deferred = await core.deferTaskUntil(tokens.owner!, {
      taskId: source, dependencies: [second], continuation: 'manager',
      text: '第二轮 defer：在 ready 相位产生 legacy 存量执行依赖等待。', idempotencyKey: key(),
    });
    expect(deferred).toMatchObject({ state: 'blocked', resumeState: 'ready', dependencyContinuation: 'manager' });
    expect(deferred.blockedTo).toBeUndefined();
    expect(await waitOf(source)).toBeUndefined();

    const dep2 = await makeTask('第二轮前置');
    const appended = await core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [dep2], expectedVersion: deferred.version,
      text: 'legacy-ready 存量等待受控追加，引用为第二轮引用。', idempotencyKey: key(),
    });
    expect(appended).toMatchObject({ state: 'blocked', resumeState: 'ready', dependencyContinuation: 'manager' });
    expect(appended.waiting).toMatchObject({ kind: 'dependency', resumeState: 'ready' });
    expect((await waitOf(source))?.referenceTaskId).toBe(second);

    await execute(second); await review(second); await execute(dep2); await review(dep2);
    const released2 = await new WaitStore(database.db).releaseDue(Date.now());
    expect(released2.released.map(r => r.taskId)).toContain(source);
    expect(await core.getTask(tokens.owner!, source)).toMatchObject({ state: 'blocked', blockedTo: 'owner', resumeState: 'ready' });
  });

  test('a plain gm block without a defer audit is refused', async () => {
    const source = await makeTask('普通gm阻塞来源');
    const held = await claim(source, 'eng');
    await core.block(tokens.eng!, proofOf(held), 'owner', evidence('block-only'));
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [await makeTask('普通阻塞前置')], expectedVersion: (await core.getTask(tokens.owner!, source)).version,
      text: '普通 gm 阻塞既无 deferred 审计也无未完成依赖，不是存量依赖等待。', idempotencyKey: key(),
    }), 'invalid', /formal dependency wait/);
  });

  test('a forged legacy shape without a deferred audit is refused', async () => {
    const ref = await makeTask('伪造引用');
    const forged = await makeTask('伪造存量来源');
    const held = await claim(forged, 'eng');
    await core.block(tokens.eng!, proofOf(held), 'owner', evidence('forge-block'));
    // 手工把任务摆成 legacy 形状（blocked、blocked_to=NONE、resume_state=doing、带未完成依赖），但没有 deferred 审计。
    await database.db.query(`UPDATE $task SET state = 'blocked', blocked_to = NONE, resume_state = 'doing',
      dependency_continuation = 'manager', dependencies = [$ref];`,
      { task: new RecordId('task', forged), ref: new RecordId('task', ref) });
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: forged, dependencies: [await makeTask('伪造前置')], expectedVersion: (await rowOf(forged)).version as number,
      text: '伪造的存量形状没有真实 deferred 审计，受控追加必须拒绝。', idempotencyKey: key(),
    }), 'invalid', /deferred audit/);
  });

  test('a legacy wait whose dependencies all complete is unlocked to the GM gate, not appendable', async () => {
    const done1 = await makeTask('会完成的引用');
    const source = await makeTask('已满足来源');
    const held = await claim(source, 'eng');
    await core.block(tokens.eng!, proofOf(held), 'owner', evidence('satisfied-block'));
    await core.deferTaskUntil(tokens.owner!, {
      taskId: source, dependencies: [done1], continuation: 'manager',
      text: 'defer 后把引用完成，制造依赖已满足的存量形状。', idempotencyKey: key(),
    });
    expect(await waitOf(source)).toBeUndefined();
    await execute(done1); await review(done1);
    // 无等待实体时由依赖完成解锁：回到 GM 关口，而不是停在 blocked 等待追加。
    const unlocked = await core.getTask(tokens.owner!, source);
    expect(unlocked).toMatchObject({ state: 'blocked', blockedTo: 'owner', resumeState: 'doing' });
    expect(unlocked.dependencyContinuation).toBeUndefined();
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [await makeTask('已满足前置')], expectedVersion: unlocked.version,
      text: '依赖已满足的任务回到了 GM 关口（gm block），不再接受受控追加。', idempotencyKey: key(),
    }), 'invalid', /formal dependency wait/);
  });

  test('owner-gated and review-phase legacy waits are refused', async () => {
    const ref = await makeTask('owner存量引用');
    const ownerTask = await makeTask('owner存量来源', { reviewerRole: 'owner' });
    await legacyDoing(ownerTask, ref);
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: ownerTask, dependencies: [await makeTask('owner存量前置')], expectedVersion: (await core.getTask(tokens.owner!, ownerTask)).version,
      text: 'owner 关口的存量等待不能被受控追加绕过。', idempotencyKey: key(),
    }), 'invalid', /Owner-gated/);

    const reviewRef = await makeTask('复核存量引用');
    const reviewTask = await makeTask('复核存量来源', { reviewerRole: 'qa' });
    await execute(reviewTask);
    const reviewClaim = await claim(reviewTask, 'qa');
    await core.block(tokens.qa!, proofOf(reviewClaim), 'owner', evidence('review-block-legacy'));
    const deferred = await core.deferTaskUntil(tokens.owner!, {
      taskId: reviewTask, dependencies: [reviewRef], continuation: 'manager',
      text: '复核相位被 defer 成存量等待：受控追加不得触碰复核岗位。', idempotencyKey: key(),
    });
    expect(deferred).toMatchObject({ state: 'blocked', resumeState: 'review' });
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: reviewTask, dependencies: [await makeTask('复核存量前置')], expectedVersion: deferred.version,
      text: '复核相位的存量等待必须保留复核岗位，不能受控追加。', idempotencyKey: key(),
    }), 'invalid', /execute-phase/);
  });

  test('a live lease, cross-goal dependencies and cycles are refused on legacy waits too', async () => {
    const ref = await makeTask('租约存量引用');
    const source = await makeTask('租约存量来源');
    await legacyDoing(source, ref);
    await database.db.query(`UPDATE $task SET current_employee = $emp, lease_expires_at = time::unix(time::now()) + 600,
      delivery_id = 'legacy-lease', fence += 1;`, { task: new RecordId('task', source), emp: new RecordId('employee', 'a-eng') });
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [await makeTask('租约存量前置')], expectedVersion: (await rowOf(source)).version as number,
      text: '存量等待同样不得在活动租约下追加前置，避免与在途持有人竞争写入。', idempotencyKey: key(),
    }), 'conflict', /active lease/);
    // 清掉测试租约，让后续负例走各自的守卫而不是租约门。
    await database.db.query(`UPDATE $task SET current_employee = NONE, lease_expires_at = NONE, delivery_id = NONE;`,
      { task: new RecordId('task', source) });

    const goal = await owner.createGoal({ text: 'FV06 存量跨目标回归', source: 'owner:test', key: key(), tier: 'quick' });
    const foreign = await makeTask('存量异目标前置', { goalId: goal.id });
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [foreign], expectedVersion: (await rowOf(source)).version as number,
      text: '存量等待的追加前置同样必须与来源任务同目标，跨目标一律拒绝。', idempotencyKey: key(),
    }), 'invalid', /same goal/);

    const back = await makeTask('存量反向依赖', { dependencies: [source] });
    await expectRefused(core.appendDependencyPrerequisites(tokens.owner!, {
      taskId: source, dependencies: [back], expectedVersion: (await rowOf(source)).version as number,
      text: '存量等待追加反向依赖同样会成环，必须拒绝。', idempotencyKey: key(),
    }), 'invalid', /cycle/);
  });

  test('concurrent appends on a legacy wait: exactly one wins and one canonical wait row exists', async () => {
    const ref = await makeTask('并发存量引用');
    const source = await makeTask('并发存量来源');
    await legacyDoing(source, ref);
    const v = (await core.getTask(tokens.owner!, source)).version;
    const a = await makeTask('并发存量前置A');
    const b = await makeTask('并发存量前置B');
    const results = await Promise.allSettled([
      core.appendDependencyPrerequisites(tokens.owner!, {
        taskId: source, dependencies: [a], expectedVersion: v,
        text: '并发 A：legacy 等待同版本双写只能一个成功。', idempotencyKey: key(),
      }),
      core.appendDependencyPrerequisites(tokens.owner!, {
        taskId: source, dependencies: [b], expectedVersion: v,
        text: '并发 B：legacy 等待同版本双写只能一个成功。', idempotencyKey: key(),
      }),
    ]);
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as CompanyError).code).toBe('conflict');
    const after = await core.getTask(tokens.owner!, source);
    expect(after.version).toBe(v + 1);
    expect(after.dependencies).toHaveLength(2);
    expect([a, b]).toContain(after.dependencies![1]!);
    const [[count]] = await database.db.query<[[Record<string, unknown>]]>(
      `SELECT count() AS n FROM task_wait WHERE task = $task AND state = 'waiting' GROUP ALL;`,
      { task: new RecordId('task', source) });
    expect(Number(count?.n ?? 0)).toBe(1);
  });
});
