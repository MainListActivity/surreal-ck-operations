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
