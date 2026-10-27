import { expect, test } from 'bun:test';
import { agingLevel, agingText, formatAge, localDate, renderBrief, type BriefData, type WaitingItem } from '../src/owner-brief.ts';
import type { GoalBlocker, GoalFinalGateView } from '../src/goal-governance.ts';
import { evaluateDispatch, globalBlock } from '../src/dispatcher/dispatch-blocked.ts';
import { dispatchBlockedList, dispatchBlockedRows } from '../src/dispatcher/dispatch-list.ts';

const item: WaitingItem = { taskId: 'aaaaaaaa-1111', version: 3, kind: 'question', title: '两位律师真实使用反馈收集与小结', goal: '两位律师 AI 检索试用', sinceMs: 0, downstream: 3 };

test('aging escalates at 4h, 24h, 72h and then once a day', () => {
  expect([0, 3.9, 4, 23.9, 24, 71.9, 72, 95.9, 96, 120].map(agingLevel)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 5]);
});

test('aging text names what waits, for how long and what it holds up', () => {
  expect(formatAge(5.2)).toBe('5 小时'); expect(formatAge(185)).toBe('7.7 天');
  const text = agingText(item, 185);
  for (const part of ['7.7 天', '待你回答的问题', '两位律师真实使用反馈收集与小结', '两位律师 AI 检索试用', '卡住下游 3 个任务', 'aaaaaaaa-1111']) expect(text).toContain(part);
  expect(agingText({ ...item, downstream: 0, kind: 'gate', goal: undefined }, 6)).not.toContain('卡住下游');
});

const data: BriefData = {
  date: '2026-10-11',
  waiting: [{ ...item, hours: 185 }, { ...item, taskId: 'bbbbbbbb-2222', kind: 'gate', title: '最终验收', downstream: 0, hours: 6 }],
  stuck: [{ taskId: 'cccccccc-3333', title: '小说拆解', reason: '依赖都已完成，却仍是 blocked（需要解锁）' }],
  last24h: { done: 38, returned: 4, rolledBack: 7, rejected: 1, retired: 6 },
  goals: [{ title: '短剧重设计', days: 4 }],
  resources: ['grok exhausted：402 Payment Required', 'codex 额度剩余 0%'], dispatchBlocked: { total: 0, rows: [] },
  capacity: [{ role: 'engineering', total: 6, usable: 3, down: ['codex 额度不足（周/月额度 0%<2%）', 'grok 额度耗尽或异常：402'] }, { role: 'qa', total: 5, usable: 5, down: [] }],
  churn: { created: 12, retired: 14, claimLost: 5 },
};

test('brief leads with a one-line summary and lists the longest wait first', () => {
  const { summary, text } = renderBrief(data);
  expect(summary).toBe('每日简报 2026-10-11：待你处理 2 项（最久 7.7 天）｜异常卡滞 1｜近24小时完成 38');
  expect(text.split('\n')[0]).toBe(summary);
  expect(text.indexOf('已等 7.7 天')).toBeLessThan(text.indexOf('已等 6 小时'));
  for (const part of ['【异常卡滞】', '小说拆解', '完成 38｜退回 4｜老板驳回 1｜作废 6｜通道回滚 7（系统换会话，不算退回）', '短剧重设计（已 4 天）', 'codex 额度剩余 0%', '【产能】', 'engineering：可用编制 3/6（codex 额度不足', '新建实例 12，退役 14（认领失败 5）']) expect(text).toContain(part);
  expect(text).not.toContain('qa：可用编制');
});

test('an empty brief says so and omits the empty sections', () => {
  const { summary, text } = renderBrief({ ...data, waiting: [], stuck: [], goals: [], resources: [], capacity: [], dispatchBlocked: { total: 0, rows: [] } });
  expect(summary).toContain('待你处理 0 项｜异常卡滞 0');
  expect(text).toContain('【等你处理】无'); expect(text).not.toContain('【异常卡滞】'); expect(text).not.toContain('【产能】'); expect(text).toContain('新建实例 12，退役 14（认领失败 5）');
});

test('local date is zero padded', () => { expect(localDate(new Date(2026, 0, 5, 9))).toBe('2026-01-05'); });

test('a role with every seat down says so plainly', () => {
  const { text } = renderBrief({ ...data, capacity: [{ role: 'gm', total: 3, usable: 0, down: ['codex 额度不足', 'grok 额度耗尽或异常'] }], resources: [], dispatchBlocked: { total: 0, rows: [] } });
  expect(text).toContain('gm：当前没有任何可用编制（codex 额度不足；grok 额度耗尽或异常）');
});

// SYS-DISP R1 (AC02): the brief names each blocked item of the pass with its own phase, workflow state, reason, owner, wait and
// trigger. It reads the same list the tick and the pulse read, and says how many items it left out.
test('brief names every blocked item of the pass row by row, and says how many it left out', () => {
  const at = Date.parse('2026-10-20T04:00:00Z');
  const verdicts = [
    evaluateDispatch({ taskId: 'exec-busy', title: '就绪实现', phase: 'execute', role: 'engineering', home: '/ops',
      entries: [{ key: 'fresh', eligible: false, code: 'session_busy' }], checkedAt: at, since: at - 30 * 60_000 }),
    evaluateDispatch({ taskId: 'review-recused', title: '独立验收', phase: 'review', role: 'engineering', home: '/ops',
      entries: [{ key: 'author', eligible: false, code: 'author_recusal' }], checkedAt: at, since: at - 12 * 60_000 }),
    evaluateDispatch({ taskId: 'budget-gate', title: '预算阻塞任务', phase: 'execute', role: 'engineering', home: '/ops',
      globalBlocks: [globalBlock('budget')], checkedAt: at, since: at - 200 * 60_000 }),
    evaluateDispatch({ taskId: 'zero', title: '零候选任务', phase: 'execute', role: 'engineering', home: '/ops',
      entries: [], checkedAt: at, since: at - 5 * 60_000 }),
    evaluateDispatch({ taskId: 'free', title: '可派工任务', phase: 'execute', role: 'engineering', home: '/ops',
      entries: [{ key: 'fresh', eligible: true }], checkedAt: at }),
  ];
  const briefWith = (limit: number) => {
    const list = dispatchBlockedList(verdicts, limit);
    expect(list.items).toEqual(dispatchBlockedRows(verdicts).slice(0, limit));
    return renderBrief({ ...data, waiting: [], stuck: [], goals: [], resources: [], capacity: [],
      dispatchBlocked: { total: list.bound.total, rows: list.items } }).text;
  };
  const text = briefWith(12);
  expect(text).toContain('【无法派工】共 4 项（同一份结论，见岗位页面）');
  for (const line of [
    '- 《独立验收》（复核·待复核）：本任务作者（写过或提交过）不能复核；已等 12 分钟；负责：gm；下一触发：出现独立候选人选',
    '- 《零候选任务》（执行·就绪）：该岗位与仓库下没有任何编制或员工；已等 5 分钟；负责：gm；下一触发：新增编制或员工',
    '- 《预算阻塞任务》（执行·就绪）：订阅额度耗尽或限流；已等 200 分钟；负责：老板；下一触发：额度恢复或老板充值',
    '- 《就绪实现》（执行·就绪）：会话占用中或异常；已等 30 分钟；负责：gm；下一触发：候选会话空闲',
  ]) expect(text).toContain(line);
  expect(text).not.toContain('可派工任务');
  // Material blocks first (the owner-only recusal), then the longest wait.
  expect(text.indexOf('独立验收')).toBeLessThan(text.indexOf('零候选任务'));
  expect(text.indexOf('预算阻塞任务')).toBeLessThan(text.indexOf('就绪实现'));
  // A bounded list names its first rows and the marker says how many it left out.
  const short = briefWith(2);
  expect(short).toContain('【无法派工】共 4 项');
  expect(short).toContain('- 另有 2 项未逐条列出，见岗位页面');
  expect(short).toContain('独立验收'); expect(short).not.toContain('就绪实现');
});

// SYS07 follow-up: the active SYS07 goal sat on card 27 behind the old first-page read. The brief now carries
// every parallel blocker with responsibility/holder/path/wait/trigger and the effective final gate with its evidence.
test('the brief names every blocker with responsibility, holder, path, wait, trigger and the final gate', () => {
  const blockers: GoalBlocker[] = [
    { taskId: 't1', title: '客户激活', kind: 'wait', summary: '等待客户激活：客户回执', responsibleRole: 'engineering',
      holder: 'eng-holder', waitedMinutes: 90, nextTrigger: '2026-10-28T00:00:00.000Z',
      dependencyPath: [{ taskId: 'gate', title: '终验' }, { taskId: 't1', title: '客户激活' }],
      handoff: { kind: 'customer_activation', ownerRole: 'customer', pendingAction: '请客户确认激活', completed: ['内部验收'] } },
    { taskId: 't2', title: '经理决策', kind: 'manager', summary: '等待经理动作', responsibleRole: 'gm',
      dependencyPath: [{ taskId: 't2', title: '经理决策' }] },
  ];
  const finalGate: GoalFinalGateView = { taskId: 'gate', title: '终验', state: 'review', reviewerRole: 'owner',
    ownerGate: true, effective: true, superseded: false, evidenceTaskIds: ['e1'] };
  const { text } = renderBrief({ ...data, waiting: [], stuck: [], resources: [], capacity: [],
    dispatchBlocked: { total: 0, rows: [] },
    goals: [{ title: 'SYS07 目标', days: 12, needsRepair: true, blockers, finalGate }] });
  for (const part of [
    'SYS07 目标（已 12 天，待修复）', '责任：engineering', '持有人：eng-holder', '已等 90 分钟',
    '下一触发：2026-10-28T00:00:00.000Z', '依赖路径：终验 → 客户激活', '交接：待办：请客户确认激活',
    '阻点[manager] 等待经理动作；责任：gm', '终验：《终验》（review，复核 owner，老板关口）；证据任务：e1',
  ]) expect(text).toContain(part);
});
