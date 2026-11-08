import { describe, expect, test } from 'bun:test';
import { AgentTokenCache } from '../src/cloud/agent-tokens.ts';
import { GatewayError } from '../src/cloud/gateway.ts';
import type { IssuedToken } from '../src/cloud/idp.ts';

type ExchangeInput = { agentUserId: string; taskId: string; ttlSeconds: number };

function setup(options: { expiresInMs?: number; maxTtlSeconds?: number; marginMs?: number } = {}) {
  let clock = 1_000_000;
  const calls: ExchangeInput[] = [];
  const exchange = async (input: ExchangeInput): Promise<IssuedToken> => {
    calls.push(input);
    await Promise.resolve();
    return { token: `tok-SECRET-${calls.length}`, expiresAt: clock + (options.expiresInMs ?? 900_000) };
  };
  const cache = new AgentTokenCache({
    exchange,
    now: () => clock,
    maxTtlSeconds: options.maxTtlSeconds,
    marginMs: options.marginMs,
  });
  return {
    cache,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const lease = (employee: string, taskId: string, leaseRemainingMs: number) => ({
  employee,
  agentUserId: `user-${employee}`,
  taskId,
  leaseRemainingMs,
});

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('AgentTokenCache', () => {
  test('租约剩余不足 1 秒直接拒绝，且不换发', async () => {
    const { cache, calls } = setup();
    const error = await catchError(cache.tokenFor(lease('alice', 't1', 999)));
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe('forbidden');
    expect(calls).toHaveLength(0);
    expect(await catchError(cache.tokenFor(lease('alice', 't1', Number.NaN)))).toBeInstanceOf(GatewayError);
  });

  test('ttl 为 min(900, 剩余秒)', async () => {
    const { cache, calls } = setup();
    await cache.tokenFor(lease('alice', 't1', 1_500_000));
    await cache.tokenFor(lease('bob', 't1', 100_999));
    expect(calls[0]?.ttlSeconds).toBe(900);
    expect(calls[1]?.ttlSeconds).toBe(100);
  });

  test('maxTtlSeconds 生效', async () => {
    const { cache, calls } = setup({ maxTtlSeconds: 120 });
    await cache.tokenFor(lease('alice', 't1', 500_000));
    expect(calls[0]?.ttlSeconds).toBe(120);
  });

  test('缓存命中不重复换发', async () => {
    const { cache, calls } = setup();
    const first = await cache.tokenFor(lease('alice', 't1', 900_000));
    const second = await cache.tokenFor(lease('alice', 't1', 900_000));
    expect(first).toBe(second);
    expect(calls).toHaveLength(1);
    expect(cache.size()).toBe(1);
  });

  test('距过期不足 marginMs 时重新换发', async () => {
    const { cache, calls, advance } = setup({ expiresInMs: 120_000, marginMs: 60_000 });
    const first = await cache.tokenFor(lease('alice', 't1', 900_000));
    advance(70_000); // 剩余 50 秒，小于 margin 60 秒
    const second = await cache.tokenFor(lease('alice', 't1', 900_000));
    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2);
  });

  test('同一员工与任务的并发请求只换发一次', async () => {
    const { cache, calls } = setup();
    const results = await Promise.all([
      cache.tokenFor(lease('alice', 't1', 900_000)),
      cache.tokenFor(lease('alice', 't1', 900_000)),
      cache.tokenFor(lease('alice', 't1', 900_000)),
    ]);
    expect(calls).toHaveLength(1);
    expect(new Set(results).size).toBe(1);
  });

  test('不同员工同一任务分别缓存', async () => {
    const { cache, calls } = setup();
    const a = await cache.tokenFor(lease('alice', 't1', 900_000));
    const b = await cache.tokenFor(lease('bob', 't1', 900_000));
    expect(a).not.toBe(b);
    expect(calls).toHaveLength(2);
    expect(cache.size()).toBe(2);
  });

  test('drop(taskId) 清掉该任务的全部员工令牌，之后重新换发', async () => {
    const { cache, calls } = setup();
    await cache.tokenFor(lease('alice', 't1', 900_000));
    await cache.tokenFor(lease('bob', 't1', 900_000));
    await cache.tokenFor(lease('alice', 't2', 900_000));
    cache.drop({ taskId: 't1' });
    expect(cache.size()).toBe(1);
    await cache.tokenFor(lease('alice', 't1', 900_000));
    expect(calls).toHaveLength(4);
  });

  test('drop(employee, taskId) 只清掉单个员工', async () => {
    const { cache } = setup();
    await cache.tokenFor(lease('alice', 't1', 900_000));
    await cache.tokenFor(lease('bob', 't1', 900_000));
    cache.drop({ employee: 'alice', taskId: 't1' });
    expect(cache.size()).toBe(1);
  });

  test('drop 永不抛错', () => {
    const { cache } = setup();
    expect(() => cache.drop({ taskId: 'nothing' })).not.toThrow();
    expect(() => cache.drop({ employee: 'x', taskId: 'nothing' })).not.toThrow();
  });

  test('令牌字符串不出现在抛出的错误信息中', async () => {
    const { cache } = setup();
    const token = await cache.tokenFor(lease('alice', 't1', 900_000));
    const error = await catchError(cache.tokenFor(lease('alice', 't1', 10)));
    expect((error as Error).message).not.toContain(token);
  });
});
