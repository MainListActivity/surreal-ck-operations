/**
 * 经理在途任务验收要求追加（task_acceptance_amend）的 fork 回归。
 *
 * 需求（任务 21f4f2e5）：
 *   * gm-only（manage）工具：taskId、expectedVersion、ownerQuote（老板原话，必填）、text、notify（可空）、idempotencyKey；
 *   * 允许 ready/doing/review/blocked，拒绝 done/void；不改 state、租约、fence、所属员工，不放宽任何门禁；
 *   * 审计 action=acceptance_amend 含 ownerQuote 与 text；修订追加到任务可读位置（claim.json 的任务详情与
 *     read_task_text 的 context）；
 *   * notify 中每位员工收到持久 outbox 通知，可经 holder_notices 读到并 ack，租约内持有人不被中断；
 *   * done 拒绝、非 gm 拒绝、幂等、版本冲突拒绝。
 *
 * 这里用隔离库（自有 namespace + bootstrap）直接驱动 core，覆盖以上每一条；只在
 * RUN_SCK_CHANNEL_FORK_TESTS=1（scripts/test-worktrees.ts 的 fork fixture）下运行。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { CompanyError } from '../src/core-errors.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import type { ClaimResult, CreateTask, Evidence } from '../src/contracts.ts';

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? describe : describe.skip;
const NS = 'sck_agent_company_test_acceptance_amend';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(300_000);
const core = new SurrealCompanyCore(database);
const tokens: Record<string, string> = {};

const OWNER_QUOTE = '守卫复核标准仅剩真实发布树放行、缺失标记拒绝、真树冒烟测试覆盖全部守卫；A–E 族对抗性词法样例不再作为退回理由。';
const AMEND_TEXT = '复核范围收窄：只按上述三条判定 standby-relay-guard，其余 P0/P1 要求不变；不放宽预算、价格、采样、独立验收、租约、岗位与依赖。';

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  const enrollment = new LocalEnrollmentAdmin(database);
  for (const [name, role, caps] of [
    ['gm', 'gm', ['execute', 'review', 'manage']],
    ['gm2', 'gm', ['execute', 'review', 'manage']],
    ['eng', 'engineering', ['execute', 'review']],
    ['eng2', 'engineering', ['execute', 'review']],
    ['qa', 'qa', ['execute', 'review']],
    ['product', 'product', ['execute', 'review', 'manage']],
  ] as const) tokens[name] = await enrollment.enroll(`a-${name}`, role, caps);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.db.query(`DELETE holder_notice;
    UPDATE task SET state = 'done', evaluated_at = time::now(), current_employee = NONE, delivery_id = NONE,
      lease_expires_at = NONE WHERE state != 'done';
    UPDATE employee SET active_task = NONE WHERE active_task != NONE;`);
});

let seq = 0;
const key = () => crypto.randomUUID();
const evidence = (tag: string): Evidence => ({ text: `验收修订回归证据 ${tag}：只验证追加本身，任务不产生真实交付。`, idempotencyKey: key() });
const proofOf = (c: ClaimResult) => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });

async function makeTask(title: string): Promise<string> {
  const task = await core.createTask(tokens.gm!, {
    title: `${title} ${++seq}`, context: '经理在途任务验收要求追加的回归夹具；原任务上下文。',
    executorRole: 'engineering', reviewerRole: 'engineering', workIntent: { kind: 'read' },
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

async function expectRefused(promise: Promise<unknown>, code: CompanyError['code'], pattern: RegExp) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CompanyError);
  if ((error as CompanyError).code !== code) console.log(`expectRefused: expected ${code}, got ${(error as CompanyError).code}: ${(error as CompanyError).message}`);
  expect((error as CompanyError).code).toBe(code);
  expect((error as CompanyError).message).toMatch(pattern);
}

const rowOf = async (taskId: string) => {
  const [rows] = await database.db.query<[Array<Record<string, unknown>>]>('SELECT * FROM $task;', { task: new RecordId('task', taskId) });
  return rows?.[0] ?? {};
};
const amend = (taskId: string, expectedVersion: number, extra: Record<string, unknown> = {}) =>
  core.taskAcceptanceAmend(tokens.gm!, { taskId, expectedVersion, ownerQuote: OWNER_QUOTE, text: AMEND_TEXT, idempotencyKey: key(), ...extra });

run('manager acceptance amendment on an in-flight task', () => {
  test('review task with a live lease: amend keeps state, lease and every gate, and the holder can still accept', async () => {
    const taskId = await makeTask('在审任务');
    await execute(taskId);
    const held = await claim(taskId, 'eng2');
    const before = await core.getTask(tokens.gm!, taskId);
    expect(before).toMatchObject({ state: 'review', currentEmployee: 'a-eng2' });
    expect(before.leaseExpiresAt).toBe(held.leaseExpiresAt);
    const rowBefore = await rowOf(taskId);

    const amended = await amend(taskId, before.version);
    expect(amended.state).toBe('review');
    expect(amended.currentEmployee).toBe('a-eng2');
    expect(amended.deliveryId).toBe(held.deliveryId);
    expect(amended.fence).toBe(held.fence);
    expect(amended.leaseExpiresAt).toBe(before.leaseExpiresAt);
    // 版本不因追加而移动：租约证明（含 expectedVersion）继续有效，持有人不会被一次修订打断。
    expect(amended.version).toBe(before.version);
    expect(amended.context.startsWith(before.context)).toBe(true);
    expect(amended.context).toContain(OWNER_QUOTE);
    expect(amended.context).toContain(AMEND_TEXT);

    // 门禁与租约字段逐项未动。
    const rowAfter = await rowOf(taskId);
    for (const field of ['state', 'blocked_to', 'resume_state', 'resume_role', 'current_employee', 'delivery_id',
      'fence', 'lease_expires_at', 'acceptance_criteria', 'acceptance_version', 'dependencies', 'independence', 'worktree', 'version']) {
      expect(JSON.stringify(rowAfter[field] ?? null)).toBe(JSON.stringify(rowBefore[field] ?? null));
    }

    // 审计含老板原话与修订说明。
    const [[audit]] = await database.db.query<[[Record<string, unknown>]]>(
      `SELECT * FROM audit WHERE task = $task AND action = 'acceptance_amend' ORDER BY at DESC LIMIT 1;`,
      { task: new RecordId('task', taskId) });
    expect(audit).toMatchObject({ actor: new RecordId('employee', 'a-gm'), version: before.version });
    expect(String(audit.evidence)).toContain(OWNER_QUOTE);
    expect(String(audit.evidence)).toContain(AMEND_TEXT);

    // 默认通知对象 = 当前租约持有人 + implementer + 最近 submitter（eng2 + eng）。
    const forReviewer = await core.dispositionNotices(tokens.eng2!, {});
    expect(forReviewer).toHaveLength(1);
    expect(forReviewer[0]).toMatchObject({ kind: 'acceptance_amend', taskId, holder: 'a-eng2' });
    expect(forReviewer[0]!.text).toContain(OWNER_QUOTE);
    const forImplementer = await core.dispositionNotices(tokens.eng!, {});
    expect(forImplementer.map(notice => notice.taskId)).toEqual([taskId]);
    expect(await core.dispositionNotices(tokens.qa!, {})).toHaveLength(0);

    // ack 只对本人通知生效；回执后不再待发。
    await expectRefused(core.ackDispositionNotices(tokens.eng2!, { ids: [forImplementer[0]!.noticeKey] }), 'forbidden', /holder/);
    expect(await core.ackDispositionNotices(tokens.eng2!, { ids: [forReviewer[0]!.noticeKey] })).toEqual({ delivered: 1 });
    expect(await core.dispositionNotices(tokens.eng2!, {})).toHaveLength(0);

    // 租约未被打断：持有人用修订前领取时的租约证明直接验收。
    await core.accept(tokens.eng2!, proofOf(held), evidence('accept-after-amend'));
    expect((await core.getTask(tokens.gm!, taskId)).state).toBe('done');
  });

  test('the amendment is readable through read_task_text and on the next claim', async () => {
    const taskId = await makeTask('待领取任务');
    const before = await core.getTask(tokens.gm!, taskId);
    await amend(taskId, before.version);
    const segment = await core.taskText(tokens.gm!, { taskId, field: 'context' });
    expect(segment.text).toContain(OWNER_QUOTE);
    expect(segment.text).toContain(AMEND_TEXT);
    // 没有在租持有人、实现人或提交人时，默认通知为空，但修订仍然落库。
    expect(await core.dispositionNotices(tokens.gm!, {})).toHaveLength(0);
    const held = await claim(taskId, 'eng');
    expect(held.task.context).toContain(OWNER_QUOTE);
    expect(held.task.context).toContain(AMEND_TEXT);
  });

  test('a blocked task accepts the amendment and keeps its block, resume state and holder', async () => {
    const taskId = await makeTask('阻塞任务');
    const held = await claim(taskId, 'eng');
    const blocked = await core.block(tokens.eng!, proofOf(held), 'gm', evidence('block-before-amend'));
    expect(blocked.state).toBe('blocked');
    const amended = await amend(taskId, blocked.version);
    expect(amended).toMatchObject({ state: 'blocked', blockedTo: 'gm', resumeState: 'doing' });
    expect(amended.currentEmployee).toBeUndefined();
    expect(amended.version).toBe(blocked.version);
    const notices = await core.dispositionNotices(tokens.eng!, {});
    expect(notices.map(notice => notice.kind)).toEqual(['acceptance_amend']);
  });

  test('done and void tasks refuse the amendment', async () => {
    const doneId = await makeTask('已完成任务');
    await execute(doneId);
    await review(doneId);
    const doneView = await core.getTask(tokens.gm!, doneId);
    expect(doneView.state).toBe('done');
    await expectRefused(amend(doneId, doneView.version), 'conflict', /does not apply to done/);

    const voidId = await makeTask('已作废任务');
    await core.retireTask(tokens.gm!, { taskId: voidId, text: '作废这个回归夹具任务。', idempotencyKey: key() });
    const voidView = await core.getTask(tokens.gm!, voidId);
    expect(voidView.state).toBe('void');
    await expectRefused(amend(voidId, voidView.version), 'conflict', /does not apply to void/);
  });

  test('only gm may amend', async () => {
    const taskId = await makeTask('权限任务');
    const before = await core.getTask(tokens.gm!, taskId);
    await expectRefused(core.taskAcceptanceAmend(tokens.product!, {
      taskId, expectedVersion: before.version, ownerQuote: OWNER_QUOTE, text: AMEND_TEXT, idempotencyKey: key(),
    }), 'forbidden', /Only gm/);
    await expectRefused(core.taskAcceptanceAmend(tokens.eng!, {
      taskId, expectedVersion: before.version, ownerQuote: OWNER_QUOTE, text: AMEND_TEXT, idempotencyKey: key(),
    }), 'forbidden', /Capability denied/);
    await expectRefused(core.taskAcceptanceAmend(tokens.qa!, {
      taskId, expectedVersion: before.version, ownerQuote: OWNER_QUOTE, text: AMEND_TEXT, idempotencyKey: key(),
    }), 'forbidden', /Capability denied/);
    expect((await core.getTask(tokens.gm!, taskId)).version).toBe(before.version);
  });

  test('a replay with the same key returns the first answer and writes once', async () => {
    const taskId = await makeTask('幂等任务');
    const before = await core.getTask(tokens.gm!, taskId);
    const input = { taskId, expectedVersion: before.version, ownerQuote: OWNER_QUOTE, text: AMEND_TEXT, notify: ['a-qa'], idempotencyKey: key() };
    const first = await core.taskAcceptanceAmend(tokens.gm!, input);
    const second = await core.taskAcceptanceAmend(tokens.gm!, input);
    expect(second.context).toBe(first.context);
    expect(second.version).toBe(first.version);
    const [[counts]] = await database.db.query<[[{ n: number }]]>(
      `SELECT count() AS n FROM audit WHERE task = $task AND action = 'acceptance_amend' GROUP ALL;`,
      { task: new RecordId('task', taskId) });
    expect(counts?.n).toBe(1);
    expect(await core.dispositionNotices(tokens.qa!, {})).toHaveLength(1);
    await expectRefused(core.taskAcceptanceAmend(tokens.gm!, { ...input, text: '同一把幂等键但换了正文。' }), 'conflict', /Idempotency key reused/);
  });

  test('a stale expectedVersion is refused, even after the holder wrote once', async () => {
    const taskId = await makeTask('版本冲突任务');
    const before = await core.getTask(tokens.gm!, taskId);
    await expectRefused(amend(taskId, before.version + 1), 'conflict', /Task version moved/);
    const held = await claim(taskId, 'eng');
    await core.checkpoint(tokens.eng!, proofOf(held), evidence('checkpoint-before-amend'));
    await expectRefused(amend(taskId, before.version), 'conflict', /Task version moved/);
    expect((await core.getTask(tokens.gm!, taskId)).context).not.toContain(OWNER_QUOTE);
  });

  test('notify names exactly who is told, and unknown employees are refused', async () => {
    const taskId = await makeTask('显式通知任务');
    await execute(taskId);
    await claim(taskId, 'eng2');
    const before = await core.getTask(tokens.gm!, taskId);
    const amended = await amend(taskId, before.version, { notify: ['a-qa'] });
    expect(amended.state).toBe('review');
    expect(await core.dispositionNotices(tokens.qa!, {})).toHaveLength(1);
    expect(await core.dispositionNotices(tokens.eng2!, {})).toHaveLength(0);
    expect(await core.dispositionNotices(tokens.eng!, {})).toHaveLength(0);
    await expectRefused(amend(taskId, amended.version, { notify: ['a-ghost'] }), 'invalid', /Unknown employee id/);
    expect(await core.dispositionNotices(tokens.qa!, {})).toHaveLength(1);
  });
});
