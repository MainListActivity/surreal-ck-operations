import { expect, test } from 'bun:test';
import { agingLevel, agingText, formatAge, localDate, renderBrief, type BriefData, type WaitingItem } from '../src/owner-brief.ts';

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
  last24h: { done: 38, returned: 4, rejected: 1, retired: 6 },
  goals: [{ title: '短剧重设计', days: 4 }],
  resources: ['grok exhausted：402 Payment Required', 'codex 额度剩余 0%'], staffingAlerts: 2,
};

test('brief leads with a one-line summary and lists the longest wait first', () => {
  const { summary, text } = renderBrief(data);
  expect(summary).toBe('每日简报 2026-10-11：待你处理 2 项（最久 7.7 天）｜异常卡滞 1｜近24小时完成 38');
  expect(text.split('\n')[0]).toBe(summary);
  expect(text.indexOf('已等 7.7 天')).toBeLessThan(text.indexOf('已等 6 小时'));
  for (const part of ['【异常卡滞】', '小说拆解', '完成 38｜退回 4｜老板驳回 1｜作废 6', '短剧重设计（已 4 天）', 'codex 额度剩余 0%', '有 2 个岗位暂无可用员工']) expect(text).toContain(part);
});

test('an empty brief says so and omits the empty sections', () => {
  const { summary, text } = renderBrief({ ...data, waiting: [], stuck: [], goals: [], resources: [], staffingAlerts: 0 });
  expect(summary).toContain('待你处理 0 项｜异常卡滞 0');
  expect(text).toContain('【等你处理】无'); expect(text).not.toContain('【异常卡滞】'); expect(text).not.toContain('【资源】');
});

test('local date is zero padded', () => { expect(localDate(new Date(2026, 0, 5, 9))).toBe('2026-01-05'); });
