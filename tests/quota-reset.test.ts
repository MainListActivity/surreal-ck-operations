import { expect, test } from 'bun:test';
import { parseQuotaResetsAt } from '../src/core.ts';

const now = Date.parse('2026-10-18T12:00:00Z');

test('quotaResetsAt: explicit offset converts to unix seconds', () => {
  // 10:12 AM America/New_York (EDT, UTC-4) is 14:12 UTC.
  expect(parseQuotaResetsAt('2026-10-18T10:12:00-04:00', now)).toBe(Date.parse('2026-10-18T14:12:00Z') / 1000);
  expect(parseQuotaResetsAt('2026-10-18T16:00:00Z', now)).toBe(Date.parse('2026-10-18T16:00:00Z') / 1000);
});

test('quotaResetsAt: a bare clock time without an offset is rejected', () => {
  expect(() => parseQuotaResetsAt('2026-10-18T10:12:00', now)).toThrow('explicit timezone offset');
  expect(() => parseQuotaResetsAt('Oct 18, 10:12 AM', now)).toThrow('explicit timezone offset');
});

test('quotaResetsAt: past instants and instants more than 14 days away are rejected', () => {
  expect(() => parseQuotaResetsAt('2026-10-18T07:00:00-04:00', now)).toThrow('must be in the future');
  expect(() => parseQuotaResetsAt('2026-12-01T00:00:00Z', now)).toThrow('more than 14 days');
});

test('quotaResetsAt: unparseable text is rejected', () => {
  expect(() => parseQuotaResetsAt('2026-13-45T99:99:00+00:00', now)).toThrow('not a valid time');
});
