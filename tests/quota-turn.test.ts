import { expect, test } from 'bun:test';
import { quotaFailure } from '../src/dispatcher/quota-failure.ts';
const now = Date.parse('2026-10-22T06:00:00Z');
test('completed API error is a quota failure, with its explicit reset', () => {
  expect(quotaFailure({ kind: 'completed' }, [{ type: 'assistant_message', text: 'API Error: 429 usage cap reached until 2026-10-22T08:00:00Z' }], now))
    .toEqual({ reason: '订阅额度耗尽/限流（API 拒绝）', resetsAt: Date.parse('2026-10-22T08:00:00Z') / 1000 });
});
test('failed structured usage error works without timeline', () => {
  expect(quotaFailure({ kind: 'failed', error: { message: 'usage cap reached', code: 'model_usage_exhausted' } }, [], now)).toBeDefined();
});
test('completed turns never treat quoted quotas, zero usage or earlier recovered errors as failure', () => {
  for (const timeline of [
    [{ type: 'user_message', text: 'API Error: 429 usage cap reached' }],
    [{ type: 'assistant_message', text: '已修复 429 usage cap reached，测试通过。' }],
    [{ type: 'error', message: '429 usage cap reached' }, { type: 'assistant_message', text: '恢复后已完成任务' }],
    [{ type: 'assistant_message', text: 'done', usage: { input: 0, output: 0 } }],
  ]) expect(quotaFailure({ kind: 'completed' }, timeline, now)).toBeUndefined();
});
test('ambiguous clock reset uses bounded cooldown rather than guessing a timezone', () => {
  expect(quotaFailure({ kind: 'completed' }, [{ type: 'assistant_message', text: 'API Error: 429 usage cap reached until 08:00' }], now)?.resetsAt).toBeUndefined();
});
test('canceled turns and unrelated API errors are not quota failures', () => {
  expect(quotaFailure({ kind: 'canceled' }, [{ type: 'error', message: '429' }], now)).toBeUndefined();
  expect(quotaFailure({ kind: 'completed' }, [{ type: 'assistant_message', text: 'API Error: 500 internal server error' }], now)).toBeUndefined();
});

test('dispatcher also recognizes a cap without an HTTP code after the lifecycle hook', async () => {
  const { EXHAUSTED_PATTERN } = await import('../src/dispatcher/dispatcher.ts');
  expect(EXHAUSTED_PATTERN.test('usage cap reached until 08:00')).toBe(true);
});


test('magpie request-rejected envelope is recognized even without a structured failed outcome', () => {
  expect(quotaFailure({ kind: 'completed' }, [{ type: 'assistant_message', text: 'API Error: request rejected (429) — usage cap reached until 08:00' }], now)).toBeDefined();
});

const refusalAt = (message: string, at: string) => quotaFailure({ kind: 'completed' },
  [{ type: 'assistant_message', text: `API Error: 429 usage cap reached ${message}` }], Date.parse(at))?.resetsAt;
const seconds = (iso: string) => Date.parse(iso) / 1000;
test('magpie clock uses the explicit offset, including fractional-hour offsets and a different UTC date', () => {
  expect(refusalAt('until 08:00 UTC-4', '2026-10-22T06:00:00Z')).toBe(seconds('2026-10-22T12:00:00Z'));
  expect(refusalAt('until 08:00 UTC+5:30', '2026-10-22T01:00:00Z')).toBe(seconds('2026-10-22T02:30:00Z'));
  expect(refusalAt('until 21:00 UTC-4', '2026-10-23T00:00:00Z')).toBe(seconds('2026-10-23T01:00:00Z'));
});
test('magpie dated resets cover later days and New Year; multiple held accounts use the soonest reset', () => {
  expect(refusalAt('until Oct 24 08:00 UTC-4', '2026-10-22T23:00:00Z')).toBe(seconds('2026-10-24T12:00:00Z'));
  expect(refusalAt('until Jan 2 08:00 UTC+8', '2026-12-31T12:00:00Z')).toBe(seconds('2027-01-02T00:00:00Z'));
  expect(refusalAt('until Oct 24 08:00 UTC-4; another account until 08:00 UTC-4', '2026-10-22T06:00:00Z')).toBe(seconds('2026-10-22T12:00:00Z'));
});
test('invalid, stale, timezone-free and excessively distant clocks retain bounded-backoff fallback', () => {
  for (const text of ['until 08:00', 'until 25:00 UTC-4', 'until 08:00 UTC+5:99', 'until 08:00 UTC+99',
    'until Feb 30 08:00 UTC-4', 'until Nov 24 08:00 UTC-4', 'until 01:00 UTC+8']) {
    expect(refusalAt(text, '2026-10-22T06:00:00Z')).toBeUndefined();
  }
});
