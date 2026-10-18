import { expect, test } from 'bun:test';
import { normalRetirement, type ReviewerLifecycle } from '../src/ops/approval-diagnosis.ts';

const retired = (fields: Partial<ReviewerLifecycle>): ReviewerLifecycle => ({ revoked: true, retired: true, ...fields });

test('only a trusted normal retirement (rotation or archive) that was never security-revoked keeps an approval', () => {
  expect(normalRetirement(retired({ retired_kind: 'rotation' }))).toBe(true);
  expect(normalRetirement(retired({ retired_kind: 'archive' }))).toBe(true);
  for (const retired_kind of ['failure', 'manual', 'rotation ', '', null, undefined]) {
    expect(normalRetirement(retired({ retired_kind }))).toBe(false);
  }
  expect(normalRetirement(retired({ retired_kind: 'rotation', security_revoked: true }))).toBe(false);
  expect(normalRetirement({ revoked: true, retired: false, retired_kind: 'rotation' })).toBe(false);
  expect(normalRetirement({ revoked: true })).toBe(false);
  expect(normalRetirement({ revoked: false, retired: false })).toBe(false);
});
