// B1 guard: every owner RPC wrapper uses this predicate; a QA restricted principal/token is refused.
import { expect, test } from 'bun:test';
import { isQaContext } from '../plugin/server/owner-context.ts';

test('detects a QA restricted context and leaves owner/paseo contexts alone', () => {
  expect(isQaContext({ principal: { role: 'qa' } })).toBe(true);
  expect(isQaContext({ qaSession: true })).toBe(true);
  expect(isQaContext({ qa: true })).toBe(true);
  expect(isQaContext({ qaToken: 'restricted' })).toBe(true);
  expect(isQaContext({})).toBe(false);
  expect(isQaContext({ principal: { role: 'owner' } })).toBe(false);
  expect(isQaContext({ paseo: {} })).toBe(false);
  expect(isQaContext(undefined)).toBe(false);
});
