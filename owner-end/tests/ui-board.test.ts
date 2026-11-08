import { describe, expect, test } from 'bun:test';
import {
  agoText, buildBoardView, clockText, durationText, messageIdOf, nowView, otherUnsentMessages, shownMessageIds, translationView,
} from '../src/ui/model.ts';
import type { BoardMessageRow, OwnerBoard } from '../src/ui/types.ts';

const AT = Date.parse('2026-05-01T10:00:00Z');

/** 形状与 src/board.ts 的 readBoard 输出一致，并带上待后端补齐的译文与未发消息字段。 */
function boardFixture(): OwnerBoard {
  return {
    at: AT,
    scheduler: { at: AT - 4_000, ageMs: 4_000 },
    runner: { state: 'online', id: 'runner-1', host: 'mac', version: '0.3.80', at: AT - 5_000 },
    employees: [
      {
        id: 'eng-1', name: 'eng-1', role: 'engineering', provider: 'codex', model: 'auto:sol', project: 'surreal_ck',
        now: {
          state: 'leased', taskId: 't1', title: '实现看板接口', phase: 'execute', leaseStartedAt: AT - 600_000, elapsedSeconds: 600,
          leaseExpiresAt: AT + 1_200_000, leaseActive: true, progress: { at: AT - 120_000, action: 'checkpoint', label: '记录进展', summary: '已接好路由' },
        },
        next: [{ taskId: 't2', title: '写测试', phase: 'execute', position: 2, eligible: false, reason: '排在第 2 位；依赖已解锁，等租约释放' }],
        outbox: [
          {
            messageId: 'm2', taskId: 't2', title: '写测试', step: 'execute', body: '先读 notes.md。完成写测试。', workdirPending: true, hold: false,
            lang: 'zh', editable: true, translation: { lang: 'en', status: 'stale', text: '旧译文' },
          },
        ],
      },
      {
        id: 'qa-1', name: 'qa-1', role: 'qa', provider: 'codex', model: 'auto:sol',
        now: { state: 'idle', idleSeconds: 1800 }, next: [],
        outbox: [{ messageId: 'm3', taskId: 't3', title: '复核任务', step: 'review', body: '复核任务的原文', workdirPending: false, hold: true, lang: 'zh', editable: true }],
      },
    ],
    unassigned: [
      {
        taskId: 't4', title: '排队任务', phase: 'execute', position: 1, blocked: false, eligible: true, reason: '排在第 1 位，可接',
        message: { messageId: 'm9', taskId: 't4', title: '排队任务', step: 'execute', state: 'draft', body: '排队原文', hold: false, editable: true },
      },
      { taskId: 't5', title: '无消息的排队', phase: 'review', position: 2, blocked: true, eligible: false, reason: '排在第 2 位；消息待老板放行' },
    ],
    messages: [
      { messageId: 'm2', taskId: 't2', title: '写测试', step: 'execute', state: 'draft', body: '先读 notes.md。完成写测试。', hold: false, editable: true },
      { messageId: 'm9', taskId: 't4', title: '排队任务', step: 'execute', state: 'draft', body: '排队原文', hold: false, editable: true },
      { messageId: 'm10', taskId: 't6', title: '孤立消息', step: 'execute', state: 'draft', body: '不在任何卡片里的原文', hold: false, editable: true },
      { messageId: 'm10', taskId: 't6', title: '孤立消息', step: 'execute', state: 'draft', body: '重复出现的同一条', hold: false, editable: true },
      { messageId: 'm11', taskId: 't7', title: '另一条', step: 'review', state: 'held', body: '另一条原文', hold: true, editable: true },
    ],
    recent: [
      { at: AT - 60_000, actor: 'eng-1', action: 'checkpoint', label: '记录进展', taskId: 't1', taskTitle: '实现看板接口' },
      { at: AT - 90_000, actor: 'owner', action: 'message.edit', label: '', taskTitle: undefined },
    ],
  };
}

describe('看板视图模型', () => {
  test('执行端状态、调度器与心跳文案', () => {
    const view = buildBoardView(boardFixture());
    expect(view.runner.stateText).toBe('执行端在线');
    expect(view.runner.tone).toBe('success');
    expect(view.runner.detail).toBe('心跳 5 秒前 · v0.3.80');
    expect(view.scheduler).toBe('调度器 4 秒前更新');
  });

  test('执行端未知与调度器未写出时如实显示', () => {
    const board = { ...boardFixture(), runner: { state: 'unknown' as const }, scheduler: undefined, employees: [], unassigned: [], messages: undefined };
    const view = buildBoardView(board);
    expect(view.runner.stateText).toBe('执行端未知');
    expect(view.runner.tone).toBe('');
    expect(view.scheduler).toBe('调度器还没有写出排队');
    expect(view.others).toEqual([]);
  });

  test('租约中的员工：任务、阶段、已用时长、租约与最近进展', () => {
    const eng = buildBoardView(boardFixture()).employees[0]!;
    expect(eng.now.statusText).toBe('执行中');
    expect(eng.now.title).toBe('实现看板接口');
    expect(eng.now.phaseText).toBe('执行');
    expect(eng.now.facts).toContain('已用 10 分钟');
    expect(eng.now.facts.some(f => f.startsWith('租约到 '))).toBe(true);
    expect(eng.now.progressText).toBe('最近进展：记录进展 · 2 分钟前 · 已接好路由');
    expect(eng.subtitle).toBe('codex · auto:sol · surreal_ck');
  });

  test('空闲员工显示空闲时长；复核阶段显示复核中', () => {
    const qa = buildBoardView(boardFixture()).employees[1]!;
    expect(qa.now.statusText).toBe('空闲 30 分钟');
    expect(qa.now.noTaskText).toBe('当前没有领取任务');
    expect(nowView({ state: 'leased', taskId: 'x', title: 'y', phase: 'review', leaseActive: true }, AT).statusText).toBe('复核中');
  });

  test('租约已过期但仍绑定：明确标出', () => {
    const view = nowView({ state: 'leased', taskId: 'x', title: 'y', phase: 'execute', leaseActive: false, leaseExpiresAt: AT }, AT);
    expect(view.facts).toContain('租约已过期，仍绑定本员工');
  });

  test('排队项带上未分配消息；没有消息的排队项不显示消息', () => {
    const view = buildBoardView(boardFixture());
    expect(view.queue[0]!.message?.messageId).toBe('m9');
    expect(view.queue[0]!.message?.body).toBe('排队原文');
    expect(view.queue[1]!.message).toBeUndefined();
    expect(view.queue[1]!.blocked).toBe(true);
    expect(view.queue[1]!.eligible).toBe(false);
  });

  test('「其它未发消息」：去掉卡片与排队项里已显示的，并按消息编号去重', () => {
    const view = buildBoardView(boardFixture());
    expect(view.others.map(m => m.messageId)).toEqual(['m10', 'm11']);
    expect(view.others[0]!.body).toBe('不在任何卡片里的原文');
  });

  test('没有 messages 字段时不报错，其它未发消息为空', () => {
    const board = { ...boardFixture(), messages: undefined };
    expect(buildBoardView(board).others).toEqual([]);
  });

  test('shownMessageIds 同时包含员工待发与排队消息', () => {
    const ids = shownMessageIds(boardFixture());
    expect([...ids].sort()).toEqual(['m2', 'm3', 'm9']);
  });

  test('otherUnsentMessages 跳过已显示的编号并保持顺序', () => {
    // 兼容旧形状（只有 id、缺字段）：测试这些脏数据仍能被列出
    const rows = [
      { messageId: 'a', body: '1' }, { messageId: 'b', body: '2' }, { messageId: 'a', body: '3' }, { id: 'c', body: '4' },
    ] as unknown as BoardMessageRow[];
    const out = otherUnsentMessages(rows, new Set(['b']));
    expect(out.map(m => m.messageId)).toEqual(['a', 'c']);
    expect(out[0]!.body).toBe('1');
  });

  test('没有编号的消息仍然列出，但 messageId 为空串（只能查看）', () => {
    const out = otherUnsentMessages([{ body: '无编号' } as BoardMessageRow], new Set());
    expect(out).toHaveLength(1);
    expect(out[0]!.messageId).toBe('');
    expect(messageIdOf({ id: 'legacy' })).toBe('legacy');
  });

  test('最近动态：空 label 回退到 action', () => {
    const view = buildBoardView(boardFixture());
    expect(view.recent[0]!.label).toBe('记录进展');
    expect(view.recent[1]!.label).toBe('message.edit');
    expect(view.recent[1]!.taskTitle).toBeUndefined();
  });
});

describe('译文状态文案', () => {
  test('没有 translation 字段表示不翻译', () => {
    expect(translationView(undefined)).toEqual({ kind: 'none', label: '不翻译', blocksSend: false });
  });

  test('ready 显示已译并带上译文，不阻止发送', () => {
    const t = translationView({ lang: 'en', status: 'ready', text: 'Hello' });
    expect(t).toEqual({ kind: 'ready', label: '已译', text: 'Hello', blocksSend: false });
  });

  test('missing 与 stale 都阻止发送，文案不同', () => {
    expect(translationView({ lang: 'en', status: 'missing' })).toMatchObject({ label: '缺译文', blocksSend: true });
    expect(translationView({ lang: 'en', status: 'stale' })).toMatchObject({ label: '原文已改，需重译', blocksSend: true });
  });

  test('员工待发的译文状态经视图模型带出', () => {
    const outbox = buildBoardView(boardFixture()).employees[0]!.outbox[0]!;
    expect(outbox.translation.kind).toBe('stale');
    expect(outbox.translation.blocksSend).toBe(true);
    expect(buildBoardView(boardFixture()).employees[1]!.outbox[0]!.translation.label).toBe('不翻译');
  });
});

describe('时间与时长文案', () => {
  test('durationText 按秒、分钟、小时切换', () => {
    expect(durationText(5)).toBe('5 秒');
    expect(durationText(600)).toBe('10 分钟');
    expect(durationText(3600)).toBe('1 小时');
    expect(durationText(3900)).toBe('1 小时 5 分钟');
  });

  test('agoText 以看板时钟为基准，超过一小时改写钟点', () => {
    expect(agoText(AT - 15_000, AT)).toBe('15 秒前');
    expect(agoText(AT - 120_000, AT)).toBe('2 分钟前');
    expect(agoText(AT + 5_000, AT)).toBe('0 秒前');
    expect(agoText(AT - 7_200_000, AT)).toBe(clockText(AT - 7_200_000));
  });
});
