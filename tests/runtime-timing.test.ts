import {expect, test} from 'bun:test';
import {estimateRemaining, phaseDurations, type TimingEvent} from '../src/runtime-timing.ts';

const now = 1_800_000_000_000;
const target = {task: 'current', project: 'company', role: 'engineering', kind: 'task', phase: 'execute'};
const event = (value: Partial<TimingEvent>): TimingEvent => ({...target, actor: 'dev', action: 'claim', at: now - 600000, ...value});
function history() {
  return Array.from({length: 8}, (_, i) => ({...target, task: `done-${i}`, seconds: 600 + i * 60, at: now - i * 1000}));
}

test('耗时只来自完整且未被打断的同一员工阶段；返工、阻塞、换租约不混入', () => {
  const events = [
    event({task: 'ok'}), event({task: 'ok', action: 'submit', at: now}),
    event({task: 'blocked'}), event({task: 'blocked', action: 'block', at: now - 300000}), event({task: 'blocked', action: 'submit', at: now}),
    event({task: 'reclaimed'}), event({task: 'reclaimed', actor: 'other', at: now - 200000}), event({task: 'reclaimed', action: 'submit', at: now}),
    event({task: 'returned', phase: 'review'}), event({task: 'returned', phase: 'review', action: 'return', at: now}),
    event({task: 'old', at: now - 40 * 86400000}), event({task: 'old', action: 'submit', at: now}),
    event({task: 'tiny', at: now - 1000}), event({task: 'tiny', action: 'submit', at: now}),
    event({task: 'missing-start', action: 'submit', at: now}),
  ];
  expect(phaseDurations(events, now)).toEqual([{...target, task: 'ok', seconds: 600, at: now}]);
});

test('参考范围按项目、岗位、阶段、任务类型筛选，扣除已用时间，不重复计当前任务', () => {
  const other = [{...history()[0]!, project: 'other'}, {...history()[0]!, phase: 'review'}, {...history()[0]!, role: 'qa'}, {...history()[0]!, kind: 'goal'}, {...history()[0]!, task: 'current'}];
  expect(estimateRemaining(target, 180, [...history(), ...other])).toEqual({status: 'estimated', samples: 8, lowerSeconds: 480, upperSeconds: 780});
  expect(estimateRemaining(target, 1020, history())).toMatchObject({status: 'overrun'});
  expect(estimateRemaining(target, undefined, history())).toMatchObject({status: 'unavailable'});
  expect(estimateRemaining(target, 180, history().slice(0, 4))).toMatchObject({status: 'insufficient', samples: 4});
  expect(estimateRemaining(target, 180, history().map((h,i) => ({...h, seconds: i < 4 ? 60 : 3600})))).toMatchObject({status: 'variable'});
});

test('同一任务的重复成功仅保留最近一轮，异常长耗时不伪装同类样本', () => {
  const events = [event({at: now - 1000000}), event({action: 'submit', at: now - 500000}),
    event({at: now - 400000}), event({action: 'submit', at: now}),
    event({task: 'stuck', at: now - 7 * 3600000}), event({task: 'stuck', action: 'submit', at: now})];
  expect(phaseDurations(events, now)).toHaveLength(1);
  expect(phaseDurations(events, now)[0]?.seconds).toBe(400);
});
