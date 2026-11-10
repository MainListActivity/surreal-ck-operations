import { expect, test } from 'bun:test';
import type { Surreal } from 'surrealdb';
import { LIVE_TABLES, ownerEventStream, subscribeOwnerChanges } from '../src/realtime.ts';
import { parseLiveFrame, readLiveChunk } from '../src/ui/realtime.ts';
import { expireObservations } from '../src/ui/runtime-state.ts';
import { DemoRuntime } from '../demo/runtime.ts';
import { DemoStore } from '../demo/store.ts';
import { seed, withDesignCases } from '../demo/data.ts';
import { handler } from '../demo/server.ts';

function database(failAt = -1) {
  let closed = 0,
    killed = 0;
  const listeners: Array<() => void> = [];
  const events = new Map<string, () => void>();
  const db = {
    async live() {
      if (listeners.length === failAt) throw Error('unavailable');
      return {
        subscribe(fn: () => void) {
          listeners.push(fn);
          return () => {};
        },
        async kill() {
          killed++;
        },
      };
    },
    subscribe(event: string, fn: () => void) {
      events.set(event, fn);
      return () => {
        events.delete(event);
      };
    },
    async close() {
      closed++;
    },
  } as unknown as Surreal;
  return { db, listeners, events, counts: () => ({ closed, killed }) };
}

test('LIVE 订阅中途失败会释放已经建立的订阅', async () => {
  const fake = database(3);
  await expect(subscribeOwnerChanges(fake.db, () => {})).rejects.toThrow('unavailable');
  expect(fake.counts().killed).toBe(3);
});

test('半开连接未收到心跳时结束等待；正常数据不会触发超时', async () => {
  await expect(readLiveChunk({ read: () => new Promise(() => {}) }, 5)).rejects.toThrow(
    'heartbeat timeout',
  );
  const chunk = { done: false as const, value: new Uint8Array([1]) };
  expect(await readLiveChunk({ read: async () => chunk }, 20)).toEqual(chunk);
});

test('SSE 合并变更且只传表名；取消后释放全部订阅、事件监听和连接', async () => {
  const fake = database();
  const abort = new AbortController();
  const reader = ownerEventStream(fake.db, abort.signal, Date.now() + 60000).body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
  fake.listeners[0]!();
  fake.listeners[0]!();
  fake.listeners[1]!();
  const frame = parseLiveFrame(new TextDecoder().decode((await reader.read()).value));
  expect(frame).toEqual({ event: 'change', tables: ['task', 'employee'] });
  await reader.cancel();
  expect(fake.counts()).toEqual({ closed: 1, killed: LIVE_TABLES.length });
  expect(fake.events.size).toBe(0);
  abort.abort();
  expect(fake.counts().closed).toBe(1);
});

test('过期令牌结束旧流，数据库断连不会继续显示已连接', async () => {
  for (const expire of [true, false]) {
    const fake = database();
    const reader = ownerEventStream(
      fake.db,
      new AbortController().signal,
      Date.now() + (expire ? 1 : 60000),
    ).body!.getReader();
    await reader.read();
    if (expire)
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('reconnect');
    else fake.events.get('disconnected')!();
    expect((await reader.read()).done).toBe(true);
    await Bun.sleep(1);
    expect(fake.counts()).toEqual({ closed: 1, killed: LIVE_TABLES.length });
  }
});

test('解析心跳不触发数据更新；过期观测只修改显示，不改写原快照', () => {
  expect(parseLiveFrame('event: heartbeat\ndata: {"at":123}')).toEqual({
    event: 'heartbeat',
    tables: undefined,
  });
  const data = new DemoRuntime(new DemoStore(seed())).snapshot();
  data.sample = false;
  const expired = expireObservations(data, data.at + 91_000);
  expect(expired.summary.onlineHosts).toBe(0);
  expect(expired.summary.runningAgents).toBe(0);
  expect(expired.agents.every((a) => a.state === 'unknown')).toBe(true);
  expect(data.hosts[0]!.state).toBe('online');
});

test('设计模式写入主动推送，交接与返工方向正确，取消流后仍可操作', async () => {
  const origin = 'http://127.0.0.1:6006';
  const source = withDesignCases(seed());
  const engineer = source.agents.find(
    (a) => a.role === 'engineering' && !a.policy?.disabled,
  )!.employee;
  const reviewer = source.agents.find((a) => a.role === 'qa' && !a.policy?.disabled)!.employee;
  const serve = handler(new DemoStore(source), origin);
  const reader = (await serve(new Request(origin + '/api/events'))).body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
  let readTriggeredChange = false;
  const pending = reader.read().then((value) => {
    readTriggeredChange = true;
    return value;
  });
  await serve(
    new Request(origin + '/api/cmd', {
      method: 'POST',
      body: JSON.stringify({ command: 'requirement.list' }),
    }),
  );
  await Bun.sleep(30);
  expect(readTriggeredChange).toBe(false);
  await serve(
    new Request(origin + '/api/cmd', {
      method: 'POST',
      body: JSON.stringify({ command: 'task.pause' }),
    }),
  );
  expect(new TextDecoder().decode((await pending).value)).toContain('change');
  for (const [from, to] of [
    [engineer, reviewer],
    [reviewer, engineer],
  ]) {
    await serve(new Request(origin + '/api/demo/transfer', { method: 'POST' }));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('change');
    const { result } = await (await serve(new Request(origin + '/api/dashboard'))).json();
    expect(result.transfers[0]).toMatchObject({ from, to });
  }
  await reader.cancel();
  expect((await serve(new Request(origin + '/api/demo/reset', { method: 'POST' }))).status).toBe(
    200,
  );
});


test('设计大盘的员工数量来自同一份员工数据，CI/CD 不创建构建或部署岗位',()=>{
  const store=new DemoStore(withDesignCases(seed()));
  const runtime=new DemoRuntime(store);
  const initial=runtime.snapshot();
  expect(initial.agents.map(a=>a.id).sort()).toEqual(store.data.agents.map(a=>a.employee).sort());
  expect(initial.deliveries.length).toBeGreaterThan(0);
  expect(initial.agents.some(a=>['build','deploy','release'].includes(a.role))).toBe(false);
  store.data.agents.splice(1);
  const reduced=runtime.snapshot();
  expect(reduced.agents).toHaveLength(1);
  expect(reduced.summary.agents).toBe(1);
});
