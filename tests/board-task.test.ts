import { describe, expect, test } from 'bun:test';
import { RecordId } from 'surrealdb';
import { ownerApi, type OwnerApiContext } from '../src/owner-api.ts';
import type { BoardTaskStatus, BoardView, OwnerBoard } from '../src/board.ts';
import { answerBytes, guardRelayResponse, RESPONSE_BUDGET_BYTES } from '../src/response-budget.ts';
import { companyCmdNarrowHint } from '../plugin/server/sidecar.ts';

// board.task：老板看板同一份判定的按任务有界读取。假库按 SQL 片段应答，覆盖排队、扣住、门槛、租约、
// 老板复核、阻塞、终态与缺任务各一种，外加 relay 预算的夹具回归（大看板被拒、单任务状态通过）。
const NOW = 1_800_000_000_000;
const SEC = Math.floor(NOW / 1000);
const rid = (table: string, id: string) => new RecordId(table, id);

const VIEW: BoardView = {
  at: NOW - 5_000,
  env: { sckBin: '/sck', opsRepo: '/ops' },
  queue: [
    { taskId: 't-queue', title: '队列任务', phase: 'execute', role: 'engineering', blocked: false, eligible: true, body: '依赖已解锁，等待派工' },
    { taskId: 't-held', title: '扣住任务', phase: 'execute', role: 'engineering', blocked: false, eligible: true, body: '依赖已解锁，等待派工' },
    { taskId: 't-gate', title: '门槛任务', phase: 'execute', role: 'engineering', blocked: true, eligible: false, body: '全员配额耗尽' },
  ],
  employees: {
    e1: {
      commDir: '/comm/e1',
      next: [
        { taskId: 't-queue', title: '队列任务', phase: 'execute', eligible: true, body: '可接' },
        { taskId: 't-gate', title: '门槛任务', phase: 'execute', eligible: false, body: '配额耗尽' },
      ],
    },
  },
};

const TASKS: Record<string, Record<string, unknown>> = {
  't-doing': { id: rid('task', 't-doing'), title: '在途任务', state: 'doing', reviewer_role: 'qa', current_employee: rid('employee', 'e1'), lease_expires_at: SEC + 600 },
  't-queue': { id: rid('task', 't-queue'), title: '队列任务', state: 'ready', reviewer_role: 'qa' },
  't-held': { id: rid('task', 't-held'), title: '扣住任务', state: 'ready', reviewer_role: 'qa' },
  't-gate': { id: rid('task', 't-gate'), title: '门槛任务', state: 'ready', reviewer_role: 'qa' },
  't-owner': { id: rid('task', 't-owner'), title: '老板复核任务', state: 'review', reviewer_role: 'owner' },
  't-blocked': { id: rid('task', 't-blocked'), title: '阻塞任务', state: 'blocked', blocked_to: 'owner', reviewer_role: 'qa' },
  't-wait': { id: rid('task', 't-wait'), title: '等待恢复任务', state: 'blocked', resume_state: 'ready', reviewer_role: 'qa' },
  't-done': { id: rid('task', 't-done'), title: '完成任务', state: 'done', reviewer_role: 'qa' },
  't-lapsed': { id: rid('task', 't-lapsed'), title: '租约过期任务', state: 'doing', reviewer_role: 'qa', current_employee: rid('employee', 'e2'), lease_expires_at: SEC - 60 },
};

const UNSENT = [
  { id: rid('outbound_message', 'm-held'), task: rid('task', 't-held'), step: 'execute', state: 'draft', hold: true, body: '老板没放行的派工正文', created_at: new Date(NOW - 60_000) },
];

const EMPLOYEES = [
  { id: rid('employee', 'e1'), role: 'engineering', def: rid('employee_def', 'eng-1'), provider: 'codex', model: 'auto' },
  { id: rid('employee', 'e2'), role: 'qa', def: rid('employee_def', 'qa-1'), provider: 'codex', model: 'auto' },
];

function fakeDb() {
  const queries: string[] = [];
  const db = {
    query: async (sql: string, vars?: Record<string, unknown>) => {
      const s = sql.replace(/\s+/g, ' ');
      queries.push(s);
      if (s.includes('company_meta:board_view') || s.includes('runner_board')) return [[{ json: JSON.stringify(VIEW), at: VIEW.at }]];
      if (s.includes('FROM runner_heartbeat')) return [[{ runner: 'r1', host: 'host-1', version: '0.13.35', at: new Date(NOW - 10_000) }]];
      if (s.includes('FROM employee WHERE revoked')) return [EMPLOYEES];
      if (s.includes('FROM task WHERE state IN')) {
        return [Object.values(TASKS).filter(row => ['ready', 'doing', 'review'].includes(String(row.state)) || row.current_employee)];
      }
      if (s.includes("SELECT task, actor, action, at FROM audit")) return [[]];
      if (s.includes('FROM agent_policy')) return [[]];
      if (s.includes("FROM outbound_message WHERE state != 'sent'")) return [UNSENT];
      if (s.includes('VALUE owner_lang')) return [['zh']];
      if (s.includes("action IN ['return', 'owner_reject']")) return [[]];
      if (s.includes('FROM task WHERE id IN $ids')) return [[{ id: rid('task', 't-held'), title: '扣住任务' }]];
      if (s.includes('FROM $employee')) {
        const id = String((vars?.employee as RecordId).id);
        return [EMPLOYEES.filter(row => String((row.id as RecordId).id) === id)];
      }
      if (s.includes('FROM $task')) {
        const id = String((vars?.task as RecordId).id);
        return [TASKS[id] ? [TASKS[id]] : []];
      }
      if (s.includes('FROM audit') && s.includes('LIMIT 1')) {
        if (String((vars?.task as RecordId).id) === 't-doing' && s.includes("action = 'claim'")) return [[{ at: new Date(NOW - 120_000) }]];
        if (String((vars?.task as RecordId).id) === 't-doing') return [[{ action: 'checkpoint', evidence: '已完成一半', at: new Date(NOW - 60_000) }]];
        return [[]];
      }
      return [[]];
    },
    select: async () => undefined,
  };
  return { db, queries };
}

function ctxOf(db: unknown) {
  return { db: { db } as never, core: {} as never, owner: {} as never, workforce: {} as never, messages: {} as never,
    opsRepo: '/ops' } as OwnerApiContext;
}

const boardTask = (taskId: string) => ownerApi(ctxOf(fakeDb().db), { command: 'board.task', taskId, now: NOW }, 'agent') as Promise<BoardTaskStatus>;

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
    expect(status.holder?.progress).toMatchObject({ action: 'checkpoint', summary: '已完成一半' });
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
    await expect(ownerApi(ctxOf(fakeDb().db), { command: 'board.task' }, 'agent')).rejects.toMatchObject({ code: 'invalid' });
  });

  test('调度快照过期时标 stale', async () => {
    const status = await boardTask('t-queue');
    expect(status.scheduler?.stale).toBe(false);
    const stale = await ownerApi(ctxOf(fakeDb().db), { command: 'board.task', taskId: 't-queue', now: NOW + 200_000 }, 'agent') as BoardTaskStatus;
    expect(stale.scheduler?.stale).toBe(true);
  });
});

describe('relay 预算：大看板被拒、按任务状态通过', () => {
  test('真实等价大回执经 guardRelayResponse 失败，错误指到 board.task 而不是 pageSize', () => {
    // 复刻 /tmp/sck-devin-cloud-check-20261115/board-relay-budget-repro.json：整板回执远超预算。
    const bigBoard: OwnerBoard = {
      at: NOW, runner: { state: 'online' }, employees: [
        { id: 'e1', name: 'eng-1', role: 'engineering', now: { state: 'idle' }, next: [], outbox: [] },
      ], unassigned: [], recent: [],
      messages: Array.from({ length: 40 }, (_, index) => ({
        messageId: `m${index}`, taskId: `t${index}`, title: `任务${index}`, step: 'execute' as const,
        state: 'draft' as const, hold: false, body: '派工正文'.repeat(1500), editable: true as const,
      })),
    };
    const res = { ok: true as const, data: bigBoard };
    expect(answerBytes(bigBoard)).toBeGreaterThan(RESPONSE_BUDGET_BYTES);
    const guarded = guardRelayResponse(res, companyCmdNarrowHint({ command: 'board.snapshot' }));
    expect(guarded).toMatchObject({ ok: false, code: 'response_too_large', retryable: false });
    const error = String((guarded as { error: string }).error);
    expect(error).toContain('board.task');
    expect(error).not.toContain('pageSize');
  });

  test('board.task 的单任务答复在预算内；未知命令的错误不暗示无效参数', async () => {
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

  test('companyCmdNarrowHint 给出各命令真实支持的缩小方式', () => {
    expect(companyCmdNarrowHint({ command: 'board.snapshot' })).toContain('board.task with taskId');
    expect(companyCmdNarrowHint({ command: 'progress' })).toContain('board.task with taskId');
    expect(companyCmdNarrowHint({ command: 'audit.list' })).toContain('filters');
    expect(companyCmdNarrowHint({ command: 'note.consolidate' })).toContain('company_cmd_catalog');
    expect(companyCmdNarrowHint(null)).toContain('company_cmd_catalog');
  });
});
