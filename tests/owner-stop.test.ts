import { expect, test } from 'bun:test';
import { stopRequested, watchStops } from '../src/runner/dispatch.ts';

// 老板中止任务后，执行端读到 employee.stop_requested，停掉会话、清掉本机领取残留，停成功才清请求。
test('执行端只停自己的员工；停成功才清掉请求，停失败的留到下一轮；已领新任务的不停', async () => {
  const stopped: string[] = [], dropped: string[] = [], cleared: unknown[] = [];
  const rows = [
    { id: { id: 'e1' }, paseo_agent_id: 'a1', runner_id: 'native:mac', stop_requested: { task: 't1' } },
    { id: { id: 'e2' }, paseo_agent_id: 'a2', runner_id: 'native:other', stop_requested: { task: 't2' } },
    { id: { id: 'e3' }, paseo_agent_id: 'a3', runner_id: 'native:mac', stop_requested: { task: 't3' } },
    { id: { id: 'e4' }, runner_id: 'native:mac', stop_requested: {} },
    { id: { id: 'e5' }, paseo_agent_id: 'a5', runner_id: 'native:mac', stop_requested: { task: 't5' } },
  ];
  const ctx = {
    runnerId: 'native:mac',
    db: { db: { query: async (sql: string, vars?: { employee?: unknown }) => {
      if (sql.startsWith('SELECT id, paseo_agent_id')) return [rows];
      // e5 已经领了新任务：正在跑的是新的一轮。
      if (sql.startsWith('SELECT id FROM task')) return [vars?.employee === 'e5' ? [{ id: 'task:new' }] : []];
      cleared.push(vars?.employee); return [[]];
    } } },
    runtime: { stop: async (id: string) => { if (id === 'a3') throw new Error('process busy'); stopped.push(id); } },
    sidecar: { dropLease: (inst: string, task?: string) => { dropped.push(`${inst}:${task ?? ''}`); } },
  };
  await stopRequested(ctx as never);
  expect(stopped).toEqual(['a1']);
  expect(dropped).toEqual(['e1:t1', 'e4:']);
  // e5 的请求清掉但不停会话。
  expect(cleared).toEqual([{ id: 'e1' }, { id: 'e4' }, { id: 'e5' }]);
});

// 0.13.21 生产实测：原生执行端一轮 tick 等会话跑完才返回（426 秒），跟着循环读请求等于没中止。
test('中止请求按独立计时器读，不等派工循环；上一次没读完不叠加', async () => {
  let runs = 0, release: (() => void) | undefined;
  const stop = watchStops(() => { runs++; return new Promise<void>(resolve => { release = resolve; }); }, 10);
  await new Promise(r => setTimeout(r, 60));
  expect(runs).toBe(1); // 第一次还没返回，后面的计时跳过
  release!();
  await new Promise(r => setTimeout(r, 40));
  expect(runs).toBeGreaterThanOrEqual(2);
  stop();
  release?.();
  const seen = runs;
  await new Promise(r => setTimeout(r, 40));
  expect(runs).toBe(seen);
});
