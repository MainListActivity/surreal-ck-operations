import { expect, test } from 'bun:test';
import type { RuntimeDashboard } from '../../src/runtime-dashboard.ts';
import type { Requirement } from '../../src/iteration/requirements.ts';
import { decisionQueue, pausedCount, projectTone } from '../src/ui/today.ts';

const req = (over: Partial<Requirement>): Requirement => ({
  id: 'r', project: 'p1', title: 't', problem: '', acceptance: '1. ok', priority: 2, revision: 1,
  state: 'pending', created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z', ...over,
});

const dashboard = (over: Partial<RuntimeDashboard>): RuntimeDashboard => ({
  at: 0, hosts: [], agents: [], transfers: [], events: [], deliveries: [], warnings: [],
  summary: { hosts: 0, onlineHosts: 0, agents: 0, runningAgents: 0, idleAgents: 0, tasks: 0, queued: 0, blocked: 0 },
  ...over,
});

test('合并需求、任务与扣住的消息：受阻在前，其次待确认，再其次扣住的消息', () => {
  const held = { messageId: 'm1', taskId: 'x', title: '上线申请', body: '', preview: '', hold: true, assignment: 'unassigned' as const };
  const items = decisionQueue({
    requirements: [
      req({ id: 'a', title: '待确认', updated_at: '2026-11-10T01:00:00Z' }),
      req({ id: 'b', title: '执行受阻', state: 'implementing', execution_error: '实施链包含已作废任务' }),
      req({ id: 'c', title: '实施中', state: 'implementing' }),
      req({ id: 'd', title: '已暂停', state: 'paused' }),
      req({ id: 'e', title: '已上线', state: 'released' }),
    ],
    tasks: [{ id: 'task:t1', title: '验收', state: 'blocked' }, { id: 'task:t2', state: 'doing' }],
    dashboard: dashboard({
      agents: [{ id: 'e1', name: '工程', role: 'engineering', hostId: 'h', modelSource: 'unknown', state: 'waiting', taskId: 't1', blockedReason: '缺少 GitHub 权限', project: { id: 'p2', name: 'P2' } }],
      projects: [{ id: 'p1', name: 'P1', progress: { label: '', detail: '' }, estimate: { status: 'unknown' } as never, queued: 0, blocked: 0, pendingMessages: [held, { ...held, messageId: 'm2', hold: false }] }],
    }),
  });
  expect(items.map((i) => i.key)).toEqual(['req:b', 'task:t1', 'req:a', 'msg:m1']);
  expect(items[0]).toMatchObject({ tone: 'blocked', reason: '实施链包含已作废任务', href: '#requirements/b' });
  expect(items[1]).toMatchObject({ reason: '缺少 GitHub 权限', projectId: 'p2', href: '#tasks/t1' });
  expect(items[2]).toMatchObject({ kind: 'confirm', tone: 'decide', action: '去确认' });
  expect(items[3]).toMatchObject({ kind: 'held', href: '#messages', projectId: 'p1' });
});

test('没有数据时队列为空；暂停数单独统计；项目状态点按受阻优先', () => {
  expect(decisionQueue({})).toEqual([]);
  expect(pausedCount([req({ state: 'paused' }), req({ state: 'pending' })])).toBe(1);
  expect(projectTone(1, 3)).toBe('blocked');
  expect(projectTone(0, 1)).toBe('running');
  expect(projectTone(0, 0)).toBe('idle');
});

test('友好时间：今天、昨天、更早按月日', async () => {
  const { friendlyTime } = await import('../src/ui/today.ts');
  const now = new Date(2026, 10, 11, 15, 0).getTime();
  expect(friendlyTime(new Date(2026, 10, 11, 7, 41).getTime(), now)).toBe('今天 07:41');
  expect(friendlyTime(new Date(2026, 10, 10, 21, 19).getTime(), now)).toBe('昨天 21:19');
  expect(friendlyTime(new Date(2026, 10, 2, 9, 0).getTime(), now)).toBe('11月2日');
  expect(friendlyTime(undefined, now)).toBe('');
});
