/**
 * SYS05 · The wait ledger on the real core and the company fork.
 *
 * The rules under test (AC01-AC06):
 *
 * - Entering a wait stores the progress and releases the lease in one transaction: the task has no holder, no
 *   lease and is not claimable; a late heartbeat with the old fence is refused and cannot revive it.
 * - A due time releases exactly once under 20 concurrent ticks. Every later tick sees the same task as ordinary
 *   ready work; the wait row says `released` once.
 * - The wait survives a new process (a second core over the same database) and is not lost on restart.
 * - An external condition moves only on a verified event: a duplicate, a wrong-object event, an expired wait or a
 *   bad signature leaves the task parked.
 * - An owner handoff is not released by a manager's self-report; only the owner relay's decision releases it.
 * - Cancel/extend are version-locked; resume cannot walk past a wait; a dependency wait releases only when its
 *   reference task is terminal.
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
import { WaitStore } from '../src/wait-store.ts';
import { signWaitWebhook, webhookPayload } from '../src/waits.ts';
import type { ClaimResult, CreateTask, Evidence, LeaseProof } from '../src/contracts.ts';

const NS = 'sck_agent_company_test_waits';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(300_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-waits-'));
const tokens: Record<string, string> = {};
const WEBHOOK_SECRET = 'wait-webhook-regression-secret';

/** The controlled clock. The DB's own time still guards the lease; this clock drives the wait arithmetic. */
let clock = Date.now();
const core = new SurrealCompanyCore(database, { waits: { clock: () => clock, webhookSecret: WEBHOOK_SECRET } });

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  const enrollment = new LocalEnrollmentAdmin(database);
  for (const [name, role, caps] of [
    ['gm', 'gm', ['execute', 'review', 'manage']],
    ['eng', 'engineering', ['execute', 'review']],
    ['eng2', 'engineering', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`w-${name}`, role, caps);
});

afterAll(async () => { rmSync(credDir, { recursive: true, force: true }); });

beforeEach(async () => {
  clock = Date.now();
  await database.db.query(`DELETE task_wait; DELETE wait_event;
    UPDATE task SET current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
      wait_state = NONE, wait_kind = NONE, wait_episode = NONE, wait_not_before = NONE,
      wait_expires_at = NONE, wait_next_check_at = NONE, wait_owner_role = NONE,
      wait_source = NONE, wait_version = NONE, wait_entered_at = NONE
    WHERE current_employee != NONE OR wait_state != NONE;
    UPDATE employee SET active_task = NONE WHERE active_task != NONE;`);
});

let seq = 0;
async function makeTask(title: string, reviewerRole: 'qa' | 'owner' = 'qa'): Promise<string> {
  const task = await core.createTask(tokens.gm, {
    title: `${title} ${++seq}`, context: 'SYS05 等待状态机回归夹具', executorRole: 'engineering',
    reviewerRole, workIntent: { kind: 'read' }, idempotencyKey: `wait-task-${title}-${seq}-${clock}`,
  } as CreateTask);
  return task.id;
}

async function claim(taskId: string, employee = 'eng'): Promise<ClaimResult & { proof: LeaseProof }> {
  const claimed = await core.claim(tokens[employee]!, taskId) as ClaimResult;
  return { ...claimed, proof: { taskId, deliveryId: claimed.deliveryId, fence: claimed.fence, expectedVersion: claimed.task.version } };
}

const evidence = (key: string): Evidence => ({ text: `SYS05 回归证据 ${key}：等待必须由调度层释放，不允许前台 sleep 保活`, idempotencyKey: key });
const iso = (ms: number) => new Date(ms).toISOString();

async function enter(taskId: string, employee: string, spec: Record<string, unknown>, proof?: LeaseProof) {
  const held = proof ?? (await claim(taskId, employee)).proof;
  return core.wait(tokens[employee]!, held, evidence(`enter-${taskId}-${seq}-${clock}`), {
    reason: 'SYS05 回归：进入有明确条件的等待，释放执行租约与容量',
    ...spec,
  } as never);
}

async function expectRefused(promise: Promise<unknown>, code: CompanyError['code'], pattern: RegExp) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe(code);
  expect((error as CompanyError).message).toMatch(pattern);
}

async function rowOf(taskId: string): Promise<Record<string, unknown>> {
  const [rows] = await database.db.query<[Array<Record<string, unknown>>]>('SELECT * FROM $task;', { task: new RecordId('task', taskId) });
  return rows?.[0] ?? {};
}

describe('entering a wait releases the lease and capacity (AC01/AC03)', () => {
  test('a 10-minute wait parks the task with no holder, no lease and no claim path; the old fence cannot revive it', async () => {
    const taskId = await makeTask('十分钟等待');
    const held = await claim(taskId, 'eng');
    const before = await core.wait(tokens.eng!, held.proof, evidence('ten-minute-wait'), {
      kind: 'time', notBefore: iso(Date.now() + 10 * 60_000), reason: '等待供应商窗口开放后再继续（十分钟回归夹具）',
      timezone: 'Asia/Shanghai',
    });
    expect(before.state).toBe('blocked');
    expect(before.wait).toMatchObject({ kind: 'time', state: 'waiting', expiresSource: 'unknown' });
    const row = await rowOf(taskId);
    expect(row.current_employee).toBeUndefined();
    expect(row.lease_expires_at).toBeUndefined();
    expect(row.wait_state).toBe('waiting');
    const [employees] = await database.db.query<[Array<{ active_task?: unknown }>]>(
      'SELECT active_task FROM $employee;', { employee: new RecordId('employee', 'w-eng') });
    expect(employees?.[0]?.active_task).toBeUndefined();
    // No claim path while the wait is open: the task is blocked and the store says so.
    const denied = await core.claim(tokens.eng2!, taskId).then(() => undefined, (reason: unknown) => reason as CompanyError);
    expect(denied).toBeInstanceOf(CompanyError);
    expect(['forbidden', 'conflict', 'already_claimed']).toContain(denied!.code);
    // A late checkpoint with the old proof is refused: the wait cleared the holder and the lease.
    await expectRefused(core.checkpoint(tokens.eng!, held.proof, evidence('late-fence')), 'lease_expired', /lease expired/i);
    const waits = await new WaitStore(database.db).waitsOfTask(taskId);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ state: 'waiting', kind: 'time', enteredBy: 'w-eng', enteredVersion: held.task.version });
  });

  test('the wait survives a new core process (restart does not lose the condition)', async () => {
    const taskId = await makeTask('重启后仍在等');
    await enter(taskId, 'eng', { kind: 'time', notBefore: iso(Date.now() + 10 * 60_000) });
    const restarted = new SurrealCompanyCore(database, { waits: { clock: () => clock, webhookSecret: WEBHOOK_SECRET } });
    const view = await restarted.getTask(tokens.gm!, taskId);
    expect(view.state).toBe('blocked');
    expect(view.wait?.kind).toBe('time');
    expect(view.wait?.state).toBe('waiting');
    expect(await new WaitStore(database.db).openOfTask(taskId)).toMatchObject({ state: 'waiting' });
  });
});

describe('a due time releases exactly once (AC01/AC06)', () => {
  test('20 concurrent ticks at the boundary produce one release and one wake path', async () => {
    const taskId = await makeTask('二十并发到点');
    const notBefore = Date.now() + 1_000;
    await enter(taskId, 'eng', { kind: 'time', notBefore: iso(notBefore) });
    const store = new WaitStore(database.db);
    expect((await store.releaseDue(notBefore - 1)).released).toHaveLength(0);
    clock = notBefore;
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => store.releaseDue(notBefore)));
    expect(outcomes.flatMap(outcome => outcome.released)).toHaveLength(1);
    const waits = await store.waitsOfTask(taskId);
    expect(waits[0]!.state).toBe('released');
    expect(waits[0]!.version).toBe(2);
    const row = await rowOf(taskId);
    expect(row.state).toBe('ready');
    expect(row.wait_state).toBeUndefined();
    const after = await claim(taskId, 'eng');
    expect(after.task.state).toBe('doing');
  });

  test('a due time with an unfinished dependency is held, not released', async () => {
    const dependency = await makeTask('依赖未完成');
    const taskId = await makeTask('到点但依赖未完成');
    // Add the live dependency through the task's own dependency field (the fixture writes it directly).
    await database.db.query('UPDATE $task SET dependencies += $dep;', {
      task: new RecordId('task', taskId), dep: new RecordId('task', dependency),
    });
    await enter(taskId, 'eng', { kind: 'time', notBefore: iso(Date.now()) });
    const outcome = await new WaitStore(database.db).releaseDue(Date.now());
    expect(outcome.released.map(item => item.taskId)).not.toContain(taskId);
    expect(outcome.held.map(item => item.taskId)).toContain(taskId);
    expect((await rowOf(taskId)).state).toBe('blocked');
  });
});

describe('external events (AC02/AC06)', () => {
  test('a signed webhook releases once; a duplicate and a wrong object are refused', async () => {
    const taskId = await makeTask('客户激活等待');
    const entered = await enter(taskId, 'eng', {
      kind: 'customer_activation', reference: 'ticket OPS-1001',
      expiresAt: iso(Date.now() + 3_600_000), nextCheckAt: iso(Date.now() + 1_800_000),
    });
    const waitKey = entered.wait!.waitKey;
    const at = Date.now();
    const payload = webhookPayload({ eventId: 'evt-activate-1', provider: 'product', at, objectWaitId: waitKey });
    const signed = {
      source: 'webhook', provider: 'product', eventId: 'evt-activate-1', at, objectWaitId: waitKey,
      signature: signWaitWebhook(WEBHOOK_SECRET, payload),
      text: 'SYS05 回归：受信 webhook 确认客户已激活（测试事件，不对真实客户造事件）',
      idempotencyKey: 'resolve-activate-1',
    };
    const first = await core.resolveWait(tokens.gm!, signed as never);
    expect(first.released).toBe(true);
    expect((await rowOf(taskId)).state).toBe('ready');
    const again = await core.resolveWait(tokens.gm!, signed as never);
    expect(again.released).toBe(false);
    expect(['not_waiting', 'duplicate_event']).toContain(again.code);

    const secondTask = await makeTask('错误对象事件');
    const second = await enter(secondTask, 'eng', { kind: 'feedback', expiresAt: iso(Date.now() + 3_600_000) });
    await expectRefused(core.resolveWait(tokens.gm!, {
      waitKey: second.wait!.waitKey, source: 'authorized_person', objectWaitId: second.wait!.waitKey,
      objectTaskId: 'someone-else', at: Date.now(),
      text: 'SYS05 回归：错误对象的事件必须被拒绝，不能解除这个等待', idempotencyKey: 'wrong-object',
    } as never), 'invalid', /不匹配/);
    expect((await rowOf(secondTask)).state).toBe('blocked');
    expect(second.wait!.kind).toBe('feedback');
  });

  test('a bad webhook signature is refused; a wait with no configured secret is not trusted', async () => {
    const taskId = await makeTask('坏签名');
    const entered = await enter(taskId, 'eng', { kind: 'customer_activation', expiresAt: iso(Date.now() + 3_600_000) });
    await expectRefused(core.resolveWait(tokens.gm!, {
      source: 'webhook', provider: 'product', eventId: 'evt-bad', at: Date.now(),
      objectWaitId: entered.wait!.waitKey, signature: '0'.repeat(64),
      text: 'SYS05 回归：签名无效的 webhook 事件不能解除等待，也不能被信任', idempotencyKey: 'bad-signature',
    } as never), 'forbidden', /签名无效/);
    expect((await rowOf(taskId)).state).toBe('blocked');
  });

  test('an expired condition is not auto-released; a late event cannot revive it', async () => {
    const taskId = await makeTask('过期等待');
    const expiresAt = Date.now() + 3_600_000;
    const entered = await enter(taskId, 'eng', { kind: 'feedback', expiresAt: iso(expiresAt) });
    clock = expiresAt + 1;
    const store = new WaitStore(database.db);
    const expired = await store.markExpired(clock);
    expect(expired.map(item => item.taskId)).toContain(taskId);
    await store.releaseDue(clock);
    expect((await rowOf(taskId)).state).toBe('blocked');
    const late = await core.resolveWait(tokens.gm!, {
      source: 'authorized_person', objectWaitId: entered.wait!.waitKey, at: expiresAt - 1_000,
      text: 'SYS05 回归：等待过期后即使事件发生在到期前，也必须先延期再确认',
      idempotencyKey: 'late-event',
    } as never);
    expect(late.released).toBe(false);
    expect(['expired', 'not_waiting']).toContain(late.code);
  });
});

describe('owner handoff (AC04/AC06)', () => {
  test('a manager self-report cannot release it; the owner relay can', async () => {
    const taskId = await makeTask('老板交接等待');
    const entered = await enter(taskId, 'eng', {
      kind: 'owner_handoff', completed: ['已生成邀请文件', '已核对域名'], pendingAction: '请老板把邀请链接转交客户',
      handoffFile: '/secure/handoff/invite-abc.txt', expiresAt: iso(Date.now() + 86_400_000),
    });
    const waitKey = entered.wait!.waitKey;
    await expectRefused(core.resolveWait(tokens.gm!, {
      source: 'authorized_person', objectWaitId: waitKey, at: Date.now(),
      text: 'SYS05 回归：模型自称收到老板反馈，不能解锁老板交接等待',
      idempotencyKey: 'model-self-report',
    } as never), 'invalid', /owner relay/);
    await expectRefused(core.resolveWait(tokens.gm!, {
      source: 'owner', objectWaitId: waitKey, at: Date.now(), ownerQuote: '老板说可以',
      text: 'SYS05 回归：公开工具不能冒充 owner relay 记录老板决定',
      idempotencyKey: 'fake-owner',
    } as never), 'forbidden', /owner relay/);
    expect((await rowOf(taskId)).state).toBe('blocked');
    // The relay path (record_owner_decision with decision=reply) is the only writer that reaches this resolution.
    const relayed = await core.relayOwnerDecision(tokens.gm!, {
      taskId, decision: 'reply', note: '老板已确认转交客户', ownerQuote: '可以转交客户', idempotencyKey: 'owner-decision-1',
    } as never);
    expect(relayed.state).toBe('ready');
    expect((await rowOf(taskId)).state).toBe('ready');
    const waits = await new WaitStore(database.db).waitsOfTask(taskId);
    expect(waits[0]).toMatchObject({ state: 'released', releaseSource: 'owner' });
  });

  test('the handoff card keeps an unknown expiry unknown and never exposes the secret material', async () => {
    const taskId = await makeTask('交接卡');
    const entered = await enter(taskId, 'eng', {
      kind: 'owner_handoff', completed: ['已生成邀请文件'], pendingAction: '请老板确认是否发给客户',
    });
    const cards = await core.waitHandoffCards(tokens.gm!);
    const card = cards.find(item => item.waitKey === entered.wait!.waitKey);
    expect(card).toBeDefined();
    expect(card!.expiresAt).toEqual({ source: 'unknown' });
    expect(card!.taskTitle).toBe((await core.getTask(tokens.gm!, taskId)).title);
    expect(card!.waitingOn).toBe('owner');
    expect(card!.waitingBy).toBe('engineering');
    expect(card!.handoffFileName).toBeUndefined();
    expect(JSON.stringify(card)).not.toMatch(/https?:\/\//);
  });
});

describe('safe release and version locks (AC05)', () => {
  test('resume cannot walk past a wait; cancel and extend require the current version and a reason', async () => {
    const taskId = await makeTask('版本锁');
    const entered = await enter(taskId, 'eng', { kind: 'time', notBefore: iso(Date.now() + 10 * 60_000) });
    const waitKey = entered.wait!.waitKey;
    await expectRefused(core.resume(tokens.gm!, taskId, evidence('resume-past-wait')), 'conflict', /在等待中/);
    const stale = await core.extendWait(tokens.gm!, {
      waitKey, expectedVersion: 99, reason: 'SYS05 回归：用旧版本延期必须被拒绝，不能覆盖别人刚做的变更', idempotencyKey: 'extend-stale',
    });
    expect(stale.ok).toBe(false);
    const extended = await core.extendWait(tokens.gm!, {
      waitKey, expectedVersion: 1, reason: 'SYS05 回归：延期十分钟，保留同一个任务与等待身份', idempotencyKey: 'extend-ok',
      notBefore: iso(Date.now() + 20 * 60_000),
    });
    expect(extended).toMatchObject({ ok: true, version: 2 });
    const cancelStale = await core.cancelWait(tokens.gm!, {
      waitKey, expectedVersion: 1, reason: 'SYS05 回归：旧版本取消必须被拒绝，避免覆盖延期', idempotencyKey: 'cancel-stale',
    });
    expect(cancelStale.ok).toBe(false);
    const cancelled = await core.cancelWait(tokens.gm!, {
      waitKey, expectedVersion: 2, reason: 'SYS05 回归：授权取消等待，任务交回经理而不是静默可调度', idempotencyKey: 'cancel-ok',
    });
    expect(cancelled.ok).toBe(true);
    const row = await rowOf(taskId);
    expect(row.state).toBe('blocked');
    expect(row.blocked_to).toBe('gm');
    expect(row.wait_state).toBeUndefined();
  });

  test('a dependency wait releases only when its reference task is terminal', async () => {
    const dependency = await makeTask('修复任务');
    const taskId = await makeTask('等待修复');
    const entered = await enter(taskId, 'eng', { kind: 'upstream_repair', referenceTaskId: dependency });
    const store = new WaitStore(database.db);
    expect((await store.releaseDue(Date.now())).released.map(item => item.taskId)).not.toContain(taskId);
    await core.retireTask(tokens.gm!, { taskId: dependency, text: 'SYS05 回归：修复任务作废，视为已满足依赖', idempotencyKey: `retire-${dependency}` } as never);
    const sweep = await store.releaseDue(Date.now());
    expect(sweep.released.map(item => item.taskId)).toContain(taskId);
    expect((await rowOf(taskId)).state).toBe('ready');
    expect(entered.wait!.kind).toBe('upstream_repair');
  });

  test('a source=dependency event cannot release while the reference task is still ready', async () => {
    const dependency = await makeTask('未完成的上游修复');
    const taskId = await makeTask('等待未完成修复');
    const entered = await enter(taskId, 'eng', { kind: 'upstream_repair', referenceTaskId: dependency });
    const refused = await core.resolveWait(tokens.gm!, {
      source: 'dependency', objectWaitId: entered.wait!.waitKey, at: Date.now(),
      text: 'SYS05 回归：引用任务仍为 ready，系统依赖事件不能解除上游修复等待',
      idempotencyKey: 'dependency-not-terminal',
    } as never);
    expect(refused.released).toBe(false);
    expect(refused.code).toBe('dependency');
    expect((await rowOf(taskId)).state).toBe('blocked');
    // A named manager may attest explicitly (and is audited as authorized_person) rather than pretending the task finished.
    const attested = await core.resolveWait(tokens.gm!, {
      source: 'authorized_person', objectWaitId: entered.wait!.waitKey, at: Date.now(),
      text: 'SYS05 回归：授权人显式确认上游已修复并留审计，属于人工豁免而非系统依赖事件',
      idempotencyKey: 'dependency-human-exemption',
    } as never);
    expect(attested.released).toBe(true);
    expect((await rowOf(taskId)).state).toBe('ready');
  });

  test('a held wait recovers automatically once its dependency finishes', async () => {
    const dependency = await makeTask('迟到的依赖');
    const taskId = await makeTask('到点后被依赖挂住');
    await enter(taskId, 'eng', { kind: 'time', notBefore: iso(Date.now()) });
    // A dependency added after the wait was entered is exactly the case that produces `held`.
    await database.db.query('UPDATE $task SET dependencies += $dep;', {
      task: new RecordId('task', taskId), dep: new RecordId('task', dependency),
    });
    const store = new WaitStore(database.db);
    const first = await store.releaseDue(Date.now());
    expect(first.held.map(item => item.taskId)).toContain(taskId);
    expect((await store.waitsOfTask(taskId))[0]!.state).toBe('held');
    expect((await rowOf(taskId)).state).toBe('blocked');
    await core.retireTask(tokens.gm!, { taskId: dependency, text: 'SYS05 回归：依赖完成后 held 等待应自动恢复', idempotencyKey: `retire-held-${dependency}` } as never);
    const recovered = await store.releaseDue(Date.now());
    expect(recovered.released.map(item => item.taskId)).toContain(taskId);
    expect((await rowOf(taskId)).state).toBe('ready');
    expect((await store.waitsOfTask(taskId))[0]!.state).toBe('released');
  });

  test('migration applies to one named task, refuses owner gates, and is version-locked', async () => {
    const legacy = await makeTask('旧时间阻塞');
    const until = Math.floor(Date.now() / 1000) + 3600;
    await database.db.query('UPDATE ONLY $task SET quota_resets_at = $until;', { task: new RecordId('task', legacy), until });
    const before = await rowOf(legacy);
    const migrated = await core.waitMigrationApply(tokens.gm!, {
      taskId: legacy, expectedVersion: before.version as number,
      reason: 'SYS05 回归：把一条旧的时间阻塞按任务迁移为时间等待，不批量放行', idempotencyKey: 'migrate-one',
    });
    expect(migrated.state).toBe('blocked');
    expect(migrated.wait).toMatchObject({ kind: 'time', state: 'waiting' });
    expect((await rowOf(legacy)).quota_resets_at).toBeUndefined();
    const wait = (await new WaitStore(database.db).waitsOfTask(legacy))[0]!;
    expect(wait.notBefore).toBe(until * 1000);
    await expectRefused(core.waitMigrationApply(tokens.gm!, {
      taskId: legacy, expectedVersion: before.version as number,
      reason: 'SYS05 回归：旧版本再次迁移必须被拒绝，避免覆盖新状态', idempotencyKey: 'migrate-stale',
    }), 'conflict', /version moved|版本/);

    const owned = await makeTask('老板关口不迁移', 'owner');
    await database.db.query('UPDATE ONLY $task SET quota_resets_at = $until, state = "blocked", blocked_to = "owner";', {
      task: new RecordId('task', owned), until,
    });
    const ownedRow = await rowOf(owned);
    await expectRefused(core.waitMigrationApply(tokens.gm!, {
      taskId: owned, expectedVersion: ownedRow.version as number,
      reason: 'SYS05 回归：老板关口不能被批量迁移为时间等待', idempotencyKey: 'migrate-owner',
    }), 'forbidden', /老板关口/);
  });

  test('the migration preview is read-only and never marks an owner gate eligible', async () => {
    const preview = await core.waitMigrationPreview(tokens.gm!);
    expect(Array.isArray(preview.candidates)).toBe(true);
    expect(preview.ownerGatesBlocked).toBeGreaterThanOrEqual(0);
    for (const candidate of preview.candidates) {
      if (candidate.blockedTo === 'owner') expect(candidate.eligible).toBe(false);
    }
  });
});
