import { describe, expect, test } from 'bun:test';
import { ownerApi } from '../src/owner-api.ts';
import {
  BOARD_TASK_CANDIDATE_REASON_CHARS, BOARD_TASK_CANDIDATE_ROWS, BOARD_TASK_REASON_CHARS, BOARD_TASK_TITLE_CHARS, type BoardTaskStatus,
} from '../src/board.ts';
import { answerBytes, guardRelayResponse, RESPONSE_BUDGET_BYTES } from '../src/response-budget.ts';
import { companyCmdNarrowHint } from '../src/runner/narrow-hint.ts';
import { boardContext, boardFixtureDb, largeBoardFixture, NOW, SEC, smallBoardFixture, wideBoardFixture } from './support/board-task-fixture.ts';

// board.task：老板看板同一份判定的按任务有界读取。假库按 SQL 片段应答（tests/support/board-task-fixture.ts），
// 覆盖排队、扣住、门槛、租约、老板复核、阻塞、终态与缺任务各一种；大看板夹具覆盖 relay 预算的拒绝与按任务通过。
const boardTask = (taskId: string) => ownerApi(boardContext(boardFixtureDb(smallBoardFixture()).db),
  { command: 'board.task', taskId, now: NOW }, 'agent') as Promise<BoardTaskStatus>;

describe('board.task：与看板一致的按任务有界派工状态', () => {
  test('排队任务给出真实位置、原因、快照时效与候选原因', async () => {
    const status = await boardTask('t-queue');
    expect(status.state).toBe('ready');
    expect(status.phase).toBe('execute');
    expect(status.queue).toEqual({ position: 1, of: 3, blocked: false, eligible: true, reason: '排在第 1 位，可接' });
    expect(status.scheduler).toEqual({ at: NOW - 5_000, ageMs: 5_000, stale: false });
    expect(status.runner.state).toBe('online');
    expect(status.waiting).toMatchObject({ on: 'scheduler', kind: 'queued' });
    expect(status.candidates).toEqual([{ employeeId: 'e1', position: 1, eligible: true, reason: '排在第 1 位，可接' }]);
    expect(status.holder).toBeUndefined();
  });

  test('扣住消息的排队任务：分类为 held，责任方是老板', async () => {
    const status = await boardTask('t-held');
    expect(status.queue?.position).toBe(2);
    expect(status.queue?.blocked).toBe(true);
    expect(status.waiting).toMatchObject({ on: 'owner', kind: 'held', nextTrigger: '老板放行消息' });
    // 不带消息正文与审计原文。
    expect(JSON.stringify(status)).not.toContain('老板没放行的派工正文');
  });

  test('派工门槛挡住的排队任务：分类为 gate，保留看板原因', async () => {
    const status = await boardTask('t-gate');
    expect(status.queue).toMatchObject({ position: 3, blocked: true, eligible: false });
    expect(status.waiting.kind).toBe('gate');
    expect(status.candidates).toEqual([{ employeeId: 'e1', position: 3, eligible: false, reason: '排在第 3 位；配额耗尽' }]);
  });

  test('在途租约：持有人、租约事实与最近进展', async () => {
    const status = await boardTask('t-doing');
    expect(status.holder).toMatchObject({
      employeeId: 'e1', name: 'eng-1', role: 'engineering', phase: 'execute',
      leaseActive: true, leaseStartedAt: NOW - 120_000, leaseExpiresAt: (SEC + 600) * 1000,
    });
    // 最近进展只给动作名、中文标签与时间；审计里记的证据原文不带出（同一条审计在老板看板里仍可见）。
    expect(status.holder?.progress).toEqual({ at: NOW - 60_000, action: 'checkpoint', label: '记录进展' });
    expect(JSON.stringify(status)).not.toContain('已完成一半');
    expect(status.waiting).toMatchObject({ on: 'employee', kind: 'lease' });
    expect(status.queue).toBeUndefined();
  });

  test('租约已过期仍绑定：分类为 lease_lapsed，责任方回到调度器', async () => {
    const status = await boardTask('t-lapsed');
    expect(status.holder).toMatchObject({ employeeId: 'e2', leaseActive: false });
    expect(status.waiting).toMatchObject({ on: 'scheduler', kind: 'lease_lapsed' });
  });

  test('老板复核与阻塞：责任方是老板', async () => {
    const review = await boardTask('t-owner');
    expect(review.waiting).toMatchObject({ on: 'owner', kind: 'owner_decision' });
    expect(review.phase).toBe('review');
    expect((await boardTask('t-blocked')).waiting).toMatchObject({ on: 'owner', kind: 'owner_decision' });
    expect((await boardTask('t-blocked')).phase).toBe('execute');
    expect((await boardTask('t-wait')).waiting).toMatchObject({ on: 'owner', kind: 'resume' });
  });

  test('终态与缺任务', async () => {
    expect((await boardTask('t-done')).waiting).toMatchObject({ on: 'none', kind: 'terminal' });
    await expect(boardTask('t-missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(ownerApi(boardContext(boardFixtureDb().db), { command: 'board.task' }, 'agent')).rejects.toMatchObject({ code: 'invalid' });
  });

  test('调度快照过期时标 stale', async () => {
    const status = await boardTask('t-queue');
    expect(status.scheduler?.stale).toBe(false);
    const stale = await ownerApi(boardContext(boardFixtureDb().db), { command: 'board.task', taskId: 't-queue', now: NOW + 200_000 }, 'agent') as BoardTaskStatus;
    expect(stale.scheduler?.stale).toBe(true);
  });
});

describe('relay 预算：大看板被拒、按任务状态通过', () => {
  test('真实等价大看板经 guardRelayResponse 失败，错误指到 board.task 而不是 pageSize', async () => {
    // 合成的 300 个排队任务与 40 条消息，经真实 readBoard 读出：整板回执远超预算，形状同 /tmp 复现的整板回执。
    const board = await ownerApi(boardContext(boardFixtureDb(largeBoardFixture()).db), { command: 'board.snapshot', now: NOW }, 'agent');
    expect(answerBytes(board)).toBeGreaterThan(RESPONSE_BUDGET_BYTES);
    const guarded = guardRelayResponse({ ok: true as const, data: board }, companyCmdNarrowHint({ command: 'board.snapshot' }));
    expect(guarded).toMatchObject({ ok: false, code: 'response_too_large', retryable: false });
    const error = String((guarded as { error: string }).error);
    expect(error).toContain('board.task');
    expect(error).not.toContain('pageSize');
  });

  test('同一大看板里，单任务的 board.task 答复在预算内，并保留真实队列位置与等待原因', async () => {
    const status = await ownerApi(boardContext(boardFixtureDb(largeBoardFixture()).db),
      { command: 'board.task', taskId: 'q-007', now: NOW }, 'agent') as BoardTaskStatus;
    expect(status.queue).toMatchObject({ position: 8, of: 300, blocked: false, eligible: false });
    expect(status.waiting).toMatchObject({ on: 'system', kind: 'no_candidate' });
    expect(answerBytes(status)).toBeLessThan(RESPONSE_BUDGET_BYTES);
    expect(guardRelayResponse({ ok: true as const, data: status }, companyCmdNarrowHint({ command: 'board.task' }))).toMatchObject({ ok: true });
  });

  test('单任务答复在预算内；本机工具之外的未知命令错误不暗示 pageSize', async () => {
    const status = await boardTask('t-queue');
    expect(answerBytes(status)).toBeLessThan(RESPONSE_BUDGET_BYTES);
    const guarded = guardRelayResponse({ ok: true as const, data: status }, companyCmdNarrowHint({ command: 'board.task' }));
    expect(guarded).toMatchObject({ ok: true });
    const generic = guardRelayResponse({ ok: true as const, data: { blob: 'x'.repeat(60_000) } }, companyCmdNarrowHint({ command: 'task.pause' }));
    expect(String((generic as { error: string }).error)).not.toContain('pageSize');
    // 本机工具保持 pageSize/cursor 的默认提示。
    const toolError = guardRelayResponse({ ok: true as const, data: { blob: 'x'.repeat(60_000) } });
    expect(String((toolError as { error: string }).error)).toContain('pageSize');
  });

  test('companyCmdNarrowHint 只指向命令真实支持的参数；没有参数的命令明说没有', () => {
    expect(companyCmdNarrowHint({ command: 'board.snapshot' })).toContain('board.task with taskId');
    expect(companyCmdNarrowHint({ command: 'progress' })).toContain('board.task with taskId');
    expect(companyCmdNarrowHint({ command: 'task.cost' })).toContain('taskId');
    expect(companyCmdNarrowHint({ command: 'message.list' })).toContain('includeSent');
    expect(companyCmdNarrowHint({ command: 'note.consolidations' })).toContain('limit');
    expect(companyCmdNarrowHint({ command: 'message.records' })).toContain('no paging or filter parameter');
    expect(companyCmdNarrowHint({ command: 'brief' })).toContain('no paging or filter parameter');
    expect(companyCmdNarrowHint(null)).toContain('no paging or filter parameter');
    // 没有分页的命令从不指向 pageSize、cursor 或不存在的过滤参数。
    for (const command of ['board.snapshot', 'progress', 'task.list', 'task.detail', 'task.plan', 'task.cost', 'message.list', 'message.records', 'brief']) {
      expect(companyCmdNarrowHint({ command })).not.toMatch(/pageSize|cursor|filters/);
    }
  });

  test('宽看板：一个任务有很多候选、标题与理由都很长，单任务答复仍在预算内，省略的候选写明条数', async () => {
    const status = await ownerApi(boardContext(boardFixtureDb(wideBoardFixture(60, 300)).db),
      { command: 'board.task', taskId: 'w-target', now: NOW }, 'agent') as BoardTaskStatus;
    expect(status.candidates).toHaveLength(BOARD_TASK_CANDIDATE_ROWS);
    expect(status.candidatesOmitted).toBe(60 - BOARD_TASK_CANDIDATE_ROWS);
    expect(status.candidates[0]!.employeeId).toBe('w000');
    // 被截断的文本以省略号结尾，长度是上限加一个字符。
    expect(Array.from(status.title).length).toBe(BOARD_TASK_TITLE_CHARS + 1);
    expect(Array.from(status.queue!.reason).length).toBe(BOARD_TASK_REASON_CHARS + 1);
    expect(Array.from(status.candidates[0]!.reason).length).toBe(BOARD_TASK_CANDIDATE_REASON_CHARS + 1);
    expect(status.candidates[0]!.reason.endsWith('…')).toBe(true);
    expect(answerBytes(status)).toBeLessThan(RESPONSE_BUDGET_BYTES);
    expect(guardRelayResponse({ ok: true as const, data: status }, companyCmdNarrowHint({ command: 'board.task' }))).toMatchObject({ ok: true });
  });

  test('候选不超过上限时不写 candidatesOmitted，文本不带省略号', async () => {
    const status = await boardTask('t-queue');
    expect(status.candidatesOmitted).toBeUndefined();
    expect(status.title.endsWith('…')).toBe(false);
  });
});
