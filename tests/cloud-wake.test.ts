import { expect, test } from 'bun:test';
import type { Surreal } from 'surrealdb';
import { TickGate, WAKE_TABLES, subscribeWake } from '../src/cloud/wake.ts';

// ---- 假时钟：手动推进，定时器按到期时刻顺序触发 ----
function fakeClock() {
  let now = 0;
  type Timer = { id: number; at: number; fn: () => void };
  let nextId = 1;
  const timers: Timer[] = [];
  const cleared: unknown[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { id: nextId++, at: now + ms, fn };
      timers.push(timer);
      return timer.id;
    },
    clearTimer: (handle: unknown) => {
      cleared.push(handle);
      const index = timers.findIndex(timer => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    cleared,
    pendingCount: () => timers.length,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        now = due.at;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
      now = target;
    },
  };
}

// 让已 resolve 的 Promise 回调全部执行完
async function flush() {
  for (let n = 0; n < 10; n++) await Promise.resolve();
}

test('默认值：minGapMs 为 1000，fallbackMs 为 60000', async () => {
  const clock = fakeClock();
  const gate = new TickGate({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  // 无请求时在 59999 ms 不触发，60000 ms 触发 fallback，证明默认兜底为 60000
  let result: string | undefined;
  gate.wait().then(reason => { result = reason; });
  clock.advance(59999);
  await flush();
  expect(result).toBeUndefined();
  clock.advance(1);
  await flush();
  expect(result).toBe('fallback');
  // 默认 minGapMs 为 1000：started 之后立即 request，wait 需要推进满 1000 ms
  gate.started();
  gate.request();
  let woke: string | undefined;
  gate.wait().then(reason => { woke = reason; });
  clock.advance(999);
  await flush();
  expect(woke).toBeUndefined();
  clock.advance(1);
  await flush();
  expect(woke).toBe('wake');
});

test('连续 5 次 request() 只产生一次 wake', async () => {
  const clock = fakeClock();
  const gate = new TickGate({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  for (let n = 0; n < 5; n++) gate.request();
  const reasons: string[] = [];
  gate.wait().then(reason => reasons.push(reason));
  clock.advance(0); // 从未 started 时立即到期
  await flush();
  expect(reasons).toEqual(['wake']);
  // 这次 tick 已消费请求：下一次 wait 不应立即再 wake，而是等待兜底
  gate.started();
  let second: string | undefined;
  gate.wait().then(reason => { second = reason; });
  clock.advance(1000);
  await flush();
  expect(second).toBeUndefined();
  clock.advance(59000);
  await flush();
  expect(second).toBe('fallback');
});

test('started() 之后 300 ms 内的 request() 推迟到 minGapMs 满时才返回 wake', async () => {
  const clock = fakeClock();
  const gate = new TickGate({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, minGapMs: 1000 });
  gate.started(); // t=0
  clock.advance(300);
  gate.request(); // t=300
  let result: string | undefined;
  gate.wait().then(reason => { result = reason; });
  clock.advance(699);
  await flush();
  expect(result).toBeUndefined(); // t=999，尚未满 minGapMs
  clock.advance(1);
  await flush();
  expect(result).toBe('wake'); // t=1000
});

test('wait 在间隔已过时立即 wake', async () => {
  const clock = fakeClock();
  const gate = new TickGate({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, minGapMs: 1000 });
  gate.started(); // t=0
  clock.advance(5000);
  gate.request();
  let result: string | undefined;
  gate.wait().then(reason => { result = reason; });
  clock.advance(0);
  await flush();
  expect(result).toBe('wake');
});

test('无请求时推进到 fallbackMs 返回 fallback', async () => {
  const clock = fakeClock();
  const gate = new TickGate({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, fallbackMs: 500 });
  let result: string | undefined;
  gate.wait().then(reason => { result = reason; });
  clock.advance(499);
  await flush();
  expect(result).toBeUndefined();
  clock.advance(1);
  await flush();
  expect(result).toBe('fallback');
});

test('兜底等待期间到达的 request() 改为按最小间隔唤醒', async () => {
  const clock = fakeClock();
  const gate = new TickGate({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, fallbackMs: 60000, minGapMs: 1000 });
  gate.started(); // t=0
  clock.advance(300);
  let result: string | undefined;
  gate.wait().then(reason => { result = reason; }); // t=300，进入兜底计时
  clock.advance(100);
  gate.request(); // t=400，应按间隔唤醒，到期时刻为 t=1000
  clock.advance(599);
  await flush();
  expect(result).toBeUndefined(); // t=999
  clock.advance(1);
  await flush();
  expect(result).toBe('wake'); // t=1000
});

test('wait(fallbackMs) 为本次等待指定兜底时长，不传参时仍用构造时的值', async () => {
  const clock = fakeClock();
  const gate = new TickGate({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, fallbackMs: 60000 });
  let result: string | undefined;
  gate.wait(5000).then(reason => { result = reason; });
  clock.advance(4999);
  await flush();
  expect(result).toBeUndefined();
  clock.advance(1);
  await flush();
  expect(result).toBe('fallback');
  let next: string | undefined;
  gate.wait().then(reason => { next = reason; });
  clock.advance(59999);
  await flush();
  expect(next).toBeUndefined();
  clock.advance(1);
  await flush();
  expect(next).toBe('fallback');
});

test('stop() 使未决 wait 返回 stop，之后的 wait 立即返回 stop，并清理定时器', async () => {
  const clock = fakeClock();
  const gate = new TickGate({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  let result: string | undefined;
  gate.wait().then(reason => { result = reason; });
  expect(clock.pendingCount()).toBe(1);
  gate.stop();
  await flush();
  expect(result).toBe('stop');
  expect(clock.cleared.length).toBe(1);
  expect(clock.pendingCount()).toBe(0);
  expect(await gate.wait()).toBe('stop');
  gate.request();
  expect(await gate.wait()).toBe('stop');
});

test('同一时间只允许一个未决的 wait', async () => {
  const clock = fakeClock();
  const gate = new TickGate({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  gate.wait();
  expect(() => gate.wait()).toThrow();
  gate.stop();
});

// ---- subscribeWake：假 client，记录订阅与杀掉的顺序 ----
type FakeSub = { table: string; handlers: Array<() => void>; killed: boolean };
function fakeLiveClient(failOn?: string, killFails?: string) {
  const subs: FakeSub[] = [];
  const killed: string[] = [];
  const client = {
    live: (resource: { name: string }) => {
      const table = resource.name;
      const promise = (async () => {
        if (table === failOn) throw new Error(`live 失败：${table}`);
        const sub: FakeSub = { table, handlers: [], killed: false };
        subs.push(sub);
        return {
          subscribe: (handler: () => void) => {
            sub.handlers.push(handler);
            return () => { sub.handlers = sub.handlers.filter(h => h !== handler); };
          },
          kill: async () => {
            sub.killed = true;
            if (table === killFails) throw new Error('kill 失败');
            killed.push(table);
          },
        };
      })();
      return promise;
    },
  };
  return { client: client as unknown as Surreal, subs, killed };
}

test('subscribeWake 为 WAKE_TABLES 建立订阅，任一表变化都回调表名，停止函数杀掉全部订阅', async () => {
  const fake = fakeLiveClient();
  const changes: string[] = [];
  const stop = await subscribeWake(fake.client, table => changes.push(table));
  expect(fake.subs.map(sub => sub.table)).toEqual([...WAKE_TABLES]);
  for (const sub of fake.subs) sub.handlers.forEach(handler => handler());
  expect(changes).toEqual([...WAKE_TABLES]);
  await stop();
  expect(fake.killed).toEqual([...WAKE_TABLES]);
});

test('任一订阅建立失败：先杀掉已建立的订阅，再抛出错误', async () => {
  const fake = fakeLiveClient('ops_job');
  await expect(subscribeWake(fake.client, () => {})).rejects.toThrow('live 失败：ops_job');
  expect(fake.killed).toEqual(['task', 'outbound_message']);
});

test('单个订阅 kill 失败时吞掉错误并继续杀其余订阅', async () => {
  const fake = fakeLiveClient(undefined, 'outbound_message');
  const stop = await subscribeWake(fake.client, () => {});
  await stop();
  expect(fake.subs.every(sub => sub.killed)).toBe(true);
  expect(fake.killed).toEqual(['task', 'ops_job', 'agent_policy']);
});
