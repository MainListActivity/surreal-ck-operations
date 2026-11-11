import { expect, test } from 'bun:test';
import { SESSION_LAPSE_MS, SESSION_MS, SESSION_RENEW_MS, SessionKeeper } from '../src/ui/session-keeper.ts';

function keeper(fail = false) {
  let now = 1_000_000;
  let renewals = 0;
  let lapses = 0;
  const k = new SessionKeeper(async () => {
    renewals++;
    if (fail) throw new Error('refresh failed');
  }, () => now);
  k.onLapsed(() => lapses++);
  k.authenticated();
  return { k, advance: (ms: number) => { now += ms; }, counts: () => ({ renewals, lapses }) };
}

test('续期时点早于库的 15 分钟会话时长，且留有余量', () => {
  expect(SESSION_RENEW_MS).toBeLessThan(SESSION_LAPSE_MS);
  expect(SESSION_LAPSE_MS).toBeLessThan(SESSION_MS);
});

test('会话未到续期时点不重新鉴权；到点后续期一次、不触发重建', async () => {
  const t = keeper();
  t.advance(SESSION_RENEW_MS - 1);
  await t.k.ensure();
  expect(t.counts()).toEqual({ renewals: 0, lapses: 0 });
  t.advance(1);
  await t.k.ensure();
  await t.k.ensure();
  expect(t.counts()).toEqual({ renewals: 1, lapses: 0 });
});

test('休眠超过会话时长后：并发检查只续期一次，并通知重建 LIVE', async () => {
  const t = keeper();
  t.advance(SESSION_MS + 5 * 60_000);
  await Promise.all([t.k.ensure(), t.k.ensure(), t.k.ensure()]);
  expect(t.counts()).toEqual({ renewals: 1, lapses: 1 });
});

test('SDK 自己的续期或重连鉴权会刷新时钟，避免多余续期', async () => {
  const t = keeper();
  t.advance(SESSION_RENEW_MS - 1000);
  t.k.authenticated();
  t.advance(SESSION_RENEW_MS - 1000);
  await t.k.ensure();
  expect(t.counts().renewals).toBe(0);
});

test('续期失败把错误交给调用方，不通知重建；下次检查会再试', async () => {
  const t = keeper(true);
  t.advance(SESSION_MS);
  await expect(t.k.ensure()).rejects.toThrow('refresh failed');
  await expect(t.k.ensure()).rejects.toThrow('refresh failed');
  expect(t.counts()).toEqual({ renewals: 2, lapses: 0 });
});

test('库明确回复会话过期时：即使时钟显示未到期，也立即续期并通知重建', async () => {
  const t = keeper();
  t.advance(60_000);
  await t.k.ensure(true);
  expect(t.counts()).toEqual({ renewals: 1, lapses: 1 });
});
