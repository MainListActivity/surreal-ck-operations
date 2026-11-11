import { expect, test } from 'bun:test';
import { orderWork, schedulingDecision, FAIR_WAIT_MS, type SchedulingFact } from '../src/dispatcher/scheduling.ts';
import { factoryQueue } from '../src/dispatcher/provider-order.ts';
const item = (id: string, purpose = 'execute') => ({ task: { id, row: {} }, purpose });
test('repeated urgent arrivals cannot overtake old eligible work after the waiting bound', () => {
  const ordinary = [item('old-a'), item('old-b'), item('old-c')];
  const facts = new Map<string, SchedulingFact>(ordinary.map((r, i) => [r.task.id, { readyAt: i * 1000 }]));
  const served: string[] = [];
  for (let step = 0; step < 8; step++) {
    const now = FAIR_WAIT_MS + step * 1000;
    const urgent = item(`urgent-${step}`, 'review');
    facts.set(urgent.task.id, { readyAt: now, priority: 0, requirement: 'approved', revision: 1 });
    const queue = orderWork([...ordinary, urgent].reverse(), facts, now);
    served.push(queue[0]!.task.id);
    const index = ordinary.findIndex(x => x.task.id === queue[0]!.task.id);
    if (index >= 0) ordinary.splice(index, 1);
  }
  expect(served.slice(0, 3)).toEqual(['old-a', 'old-b', 'old-c']);
});
test('missing approval, malformed time, and future time do not manufacture urgency or age', () => {
  const facts = new Map<string, SchedulingFact>([
    ['tag-only', { priority: 0, readyAt: NaN }],
    ['future', { readyAt: 9_000_000 }],
  ]);
  expect(schedulingDecision(item('tag-only'), facts, 1000)).toMatchObject({ priority: 2, waitingMs: 0, reason: 'ordinary' });
  expect(schedulingDecision(item('future'), facts, 1000).waitingMs).toBe(0);
});
test('Factory reservations preserve delivery ranking instead of undoing it with creation time', () => {
  const queue = factoryQueue([{key:'old',createdAt:1,rank:1},{key:'critical',createdAt:2,rank:0}]);
  expect([...queue.keys()]).toEqual(['critical','old']);
});

import { unavailableProvider, providerRetryBlock } from '../src/dispatcher/provider-failover.ts';
test('only explicit terminal provider rejection admits failover, timeout/unknown/cancel do not', () => {
  expect(unavailableProvider({kind:'failed',error:{message:'HTTP 503 service unavailable'}})).toBe(true);
  for(const outcome of [
    {kind:'failed',error:{message:'transport timed out; outcome unknown'}},
    {kind:'completed',error:{message:'503 mentioned in task'}},
    {kind:'canceled',error:{message:'503'}},
    {kind:'unknown',error:{message:'503'}},
  ]) expect(unavailableProvider(outcome)).toBe(false);
});
test('failed providers and budget apply only to the failed task phase and expire on server time', () => {
  const failures = ['a','b','c'].map((provider,i)=>({provider,delivery:`d${i}`,phase:'doing' as const,at:10+i,cause:'unavailable' as const}));
  expect(providerRetryBlock(failures.slice(0,1),'a','doing',20)).toBeDefined();
  expect(providerRetryBlock(failures.slice(0,1),'b','doing',20)).toBeUndefined();
  expect(providerRetryBlock(failures,'d','doing',20)?.reason).toContain('3 次');
  expect(providerRetryBlock(failures,'a','review',20)).toBeUndefined();
  expect(providerRetryBlock(failures,'a','doing',1810)).toBeUndefined();
});
