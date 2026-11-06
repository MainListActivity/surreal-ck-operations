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
  // The fresh bootstrap of this file runs schema 047 (fault repair credential) and then 048 (this amendment's kind). The
  // version marker has reached at least 48, and 047's credential start is recorded, which only the 047 step itself writes.
  test('a fresh bootstrap runs 047 then 048: the version marker is at least 48 and the credential start is recorded', async () => {
    const [installation] = await database.db.query<[{ schema_version?: number; fault_credential_since?: unknown } | undefined]>(
      'SELECT schema_version, fault_credential_since FROM ONLY company_meta:installation;');
    expect(installation?.schema_version).toBeGreaterThanOrEqual(48);
    expect(installation?.fault_credential_since).toBeDefined();
  });

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
    // 审计 evidence 是 JSON，含老板原话、修订说明、notify 入参与调用方读到的版本（缺省 notify 记为 null）。
    expect(JSON.parse(String(audit.evidence))).toEqual({
      ownerQuote: OWNER_QUOTE, text: AMEND_TEXT, notify: null, expectedVersion: before.version,
    });

    // 默认通知对象 = 当前租约持有人 + implementer + 最近 submitter（eng2 + eng）。
    const forReviewer = await core.dispositionNotices(tokens.eng2!, {});
    expect(forReviewer).toHaveLength(1);
    expect(forReviewer[0]).toMatchObject({ kind: 'acceptance_amended', taskId, holder: 'a-eng2' });
    expect(forReviewer[0]!.text).toContain(OWNER_QUOTE);
    // 通知 id 不含控制字符：调度器要把它嵌进命令行回执。
    expect(/[\u0000-\u001f\u007f]/.test(forReviewer[0]!.noticeKey)).toBe(false);
    const forImplementer = await core.dispositionNotices(tokens.eng!, {});
    expect(forImplementer.map(notice => notice.taskId)).toEqual([taskId]);
    expect(await core.dispositionNotices(tokens.qa!, {})).toHaveLength(0);

    // ack 只对本人通知生效；回执后不再待发。
    await expectRefused(core.ackDispositionNotices(tokens.eng2!, { ids: [forImplementer[0]!.noticeKey] }), 'forbidden', /holder/);
    expect(await core.ackDispositionNotices(tokens.eng2!, { ids: [forReviewer[0]!.noticeKey] })).toEqual({ delivered: 1 });
    expect(await core.dispositionNotices(tokens.eng2!, {})).toHaveLength(0);
    // 已送达的本人通知再回执仍成功、不计数；同一批里另一条本人未送达的通知照常标记，不连累整批。
    expect(await core.ackDispositionNotices(tokens.eng2!, { ids: [forReviewer[0]!.noticeKey] })).toEqual({ delivered: 0 });
    await amend(taskId, (await core.getTask(tokens.gm!, taskId)).version);
    const second = await core.dispositionNotices(tokens.eng2!, {});
    expect(second).toHaveLength(1);
    expect(second[0]!.noticeKey).not.toBe(forReviewer[0]!.noticeKey);
    expect(await core.ackDispositionNotices(tokens.eng2!, { ids: [forReviewer[0]!.noticeKey, second[0]!.noticeKey] })).toEqual({ delivered: 1 });
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
    const blocked = await core.block(tokens.eng!, proofOf(held), 'owner', evidence('block-before-amend'));
    expect(blocked.state).toBe('blocked');
    const amended = await amend(taskId, blocked.version);
    expect(amended).toMatchObject({ state: 'blocked', blockedTo: 'owner', resumeState: 'doing' });
    expect(amended.currentEmployee).toBeUndefined();
    expect(amended.version).toBe(blocked.version);
    const notices = await core.dispositionNotices(tokens.eng!, {});
    expect(notices.map(notice => notice.kind)).toEqual(['acceptance_amended']);
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

  // 已批准语义：显式传入以传入为准，[] 表示不通知；只有省略 notify 才用缺省集合。
  test('an explicit empty notify list notifies nobody and still writes the audit', async () => {
    const taskId = await makeTask('显式空通知任务');
    await execute(taskId);
    await claim(taskId, 'eng2');
    const before = await core.getTask(tokens.gm!, taskId);
    const amended = await amend(taskId, before.version, { notify: [] });
    expect(amended.context).toContain(OWNER_QUOTE);
    // 持有人、实现人、最近提交人都没有收到通知。
    for (const who of ['eng2', 'eng', 'qa']) expect(await core.dispositionNotices(tokens[who]!, {})).toHaveLength(0);
    const [[audit]] = await database.db.query<[[Record<string, unknown>]]>(
      `SELECT * FROM audit WHERE task = $task AND action = 'acceptance_amend' ORDER BY at DESC LIMIT 1;`,
      { task: new RecordId('task', taskId) });
    expect(JSON.parse(String(audit.evidence))).toMatchObject({ notify: [], expectedVersion: before.version });
  });

  // 复核退回 round-01（P1）：并发两次 amend 曾各自在事务外读旧 context 再整体覆写，后写者覆盖先写者，
  // 审计说有两条修订而任务可读位置只剩一条。拼接移进事务后，两条都必须落地。
  test('two concurrent amendments both land in the context, with two audits and one notice each', async () => {
    const taskId = await makeTask('并发追加任务');
    const before = await core.getTask(tokens.gm!, taskId);
    const quoteA = '老板原话 A：并发修订第一条只看真树放行。';
    const textA = '并发修订说明 A：第一条收窄判据，必须留在任务上下文里。';
    const quoteB = '老板原话 B：并发修订第二条不认词法对抗样例。';
    const textB = '并发修订说明 B：第二条收窄判据，同样必须留在任务上下文里。';
    const results = await Promise.allSettled([
      core.taskAcceptanceAmend(tokens.gm!, {
        taskId, expectedVersion: before.version, ownerQuote: quoteA, text: textA, notify: ['a-eng'], idempotencyKey: key(),
      }),
      core.taskAcceptanceAmend(tokens.gm!, {
        taskId, expectedVersion: before.version, ownerQuote: quoteB, text: textB, notify: ['a-eng2'], idempotencyKey: key(),
      }),
    ]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected.length) console.log(rejected.map(r => `${(r.reason as CompanyError).code}: ${(r.reason as CompanyError).message}`).join(' | '));
    expect(rejected).toHaveLength(0);

    const after = await core.getTask(tokens.gm!, taskId);
    expect(after.context).toContain(quoteA);
    expect(after.context).toContain(textA);
    expect(after.context).toContain(quoteB);
    expect(after.context).toContain(textB);
    // 两条修订互不覆盖，且都完整追加在原 context 之后（谁先落地由竞态决定，只断言原前缀仍在、两条都在）。
    expect(after.context.startsWith(before.context)).toBe(true);
    // 版本仍不移动（不中断租约），审计各一条，通知各一条。
    expect(after.version).toBe(before.version);
    const [[counts]] = await database.db.query<[[{ n: number }]]>(
      `SELECT count() AS n FROM audit WHERE task = $task AND action = 'acceptance_amend' GROUP ALL;`,
      { task: new RecordId('task', taskId) });
    expect(counts?.n).toBe(2);
    expect((await core.dispositionNotices(tokens.eng!, {})).filter(notice => notice.taskId === taskId)).toHaveLength(1);
    expect((await core.dispositionNotices(tokens.eng2!, {})).filter(notice => notice.taskId === taskId)).toHaveLength(1);
  });

  // MAX_CONTEXT 的上限检查随拼接一起移进事务：超限的那一次整笔回滚，任务上下文停在上一条修订。
  // 上限与创建时一致（20000 字符），而不是另一套更大的数。
  test('an amendment that would push the context past the cap is refused and writes nothing', async () => {
    const taskId = await makeTask('上下文上限任务');
    const quote = '老'.repeat(4000);
    const text = '修'.repeat(4000);
    let rounds = 0;
    let refused: CompanyError | undefined;
    let last = await core.getTask(tokens.gm!, taskId);
    while (rounds < 20) {
      rounds++;
      try {
        last = await core.taskAcceptanceAmend(tokens.gm!, {
          taskId, expectedVersion: last.version, ownerQuote: quote, text, idempotencyKey: key(),
        });
      } catch (error) {
        refused = error as CompanyError;
        break;
      }
    }
    expect(refused).toBeInstanceOf(CompanyError);
    expect(refused!.code).toBe('invalid');
    expect(refused!.message).toMatch(/exceed .* characters/);
    // 被拒的这次没有留下任何痕迹：审计条数等于成功追加的次数，正文仍是成功那次的末尾。
    // 注意用库里的行做断言：amend 的回包是 echoTask 的结果，context 会按响应预算截断。
    const stored = await rowOf(taskId);
    const context = String(stored.context ?? '');
    const [[counts]] = await database.db.query<[[{ n: number }]]>(
      `SELECT count() AS n FROM audit WHERE task = $task AND action = 'acceptance_amend' GROUP ALL;`,
      { task: new RecordId('task', taskId) });
    expect(counts?.n).toBe(rounds - 1);
    expect(context.length).toBeLessThanOrEqual(20_000);
    expect(context.trimEnd().endsWith(text)).toBe(true);
  });
});
