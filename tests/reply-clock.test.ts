// SYS01 M1: the reply ceiling of a snapshot-backed answer counts from the request's arrival, and the work is cut at it (no database).
import { expect, test } from 'bun:test';
import { arrivedAt, arriving, currentTool, noteTool, SNAPSHOT_TOOLS, withinReplyCeiling } from '../src/reply-clock';
import { REPLY_CEILING_MS } from '../src/snapshot-store';

test('a request keeps its arrival: a call made inside it reads that arrival, and a nested call does not restart the clock', () => {
  const arrival = Date.now() - 5_000;
  arriving(() => {
    expect(arrivedAt()).toBe(arrival);
    arriving(() => expect(arrivedAt()).toBe(arrival), Date.now());
  }, arrival);
  expect(arrivedAt()).toBeGreaterThan(Date.now() - 1_000);
});

test('the snapshot tools are the three listings, and the tool of a request is what it names', () => {
  expect([...SNAPSHOT_TOOLS].sort()).toEqual(['get_context', 'get_task_history', 'list_worktrees']);
  arriving(() => {
    expect(currentTool()).toBeUndefined();
    noteTool('get_context');
    expect(currentTool()).toBe('get_context');
  });
});

test('work that starts after the ceiling of its arrival is not started at all, and is refused as recoverable', async () => {
  let started = false;
  const late = Date.now() - REPLY_CEILING_MS - 1;
  const error = await arriving(() => withinReplyCeiling(async () => { started = true; return 1; }).catch((reason: unknown) => reason), late);
  expect((error as { code?: string }).code).toBe('temporarily_unavailable');
  expect((error as { retryable?: boolean }).retryable).toBe(true);
  expect(started).toBe(false);
});

test('work that is still running at the ceiling is cut there, and its answer is refused rather than sent late', async () => {
  const startedAt = Date.now();
  const error = await arriving(() => withinReplyCeiling(() => new Promise<number>(() => undefined)).catch((reason: unknown) => reason), startedAt);
  const elapsed = Date.now() - startedAt;
  expect((error as { code?: string }).code).toBe('temporarily_unavailable');
  expect(elapsed).toBeGreaterThanOrEqual(REPLY_CEILING_MS - 100);
  expect(elapsed).toBeLessThan(REPLY_CEILING_MS + 1_000);
}, 30_000);

test('work that answers in time is returned as it is', async () => {
  const value = await arriving(() => withinReplyCeiling(async () => 'answer'));
  expect(value).toBe('answer');
});
