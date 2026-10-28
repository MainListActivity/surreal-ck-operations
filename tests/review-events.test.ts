// SYS-INT 评审协同唤醒的纯规则回归（无数据库）：事件身份、订阅对、事件类型、subject 归一与失效判定。
// 这些规则一旦放松，就会变成“旧 fence 的迟到事件也能唤醒协同任务”或“申请人可以自己把 scope 扩到别的 goal”。
import { describe, expect, test } from 'bun:test';
import {
  normalizeEventKinds, normalizeScopeSubjects, reviewEventKeyOf, reviewEventStaleReason, reviewWatchKeyOf,
  sameEventKinds, signalEventKind, validateWatchPair,
} from '../src/review-events.ts';
import { reviewWatchRef, watchOfRef } from '../src/review-event-store.ts';
import { CompanyError } from '../src/core-errors.ts';

const codeOf = (fn: () => unknown): string => {
  try { fn(); return 'ok'; } catch (error) { return (error as CompanyError).code; }
};

describe('subscription identity', () => {
  test('one ordered pair is one watch, and the same pair is never a second subscription', () => {
    expect(reviewWatchKeyOf('c3736677', '3cf7477d')).toBe('c3736677|3cf7477d');
    expect(reviewWatchKeyOf('c3736677', '3cf7477d')).not.toBe(reviewWatchKeyOf('3cf7477d', 'c3736677'));
  });

  test('a pair must be two distinct exact task ids: self-pairs and wildcards are refused', () => {
    expect(codeOf(() => validateWatchPair({ sourceTaskId: 'a', collaborationTaskId: 'a' }))).toBe('invalid');
    expect(codeOf(() => validateWatchPair({ sourceTaskId: '*', collaborationTaskId: 'b' }))).toBe('invalid');
    expect(codeOf(() => validateWatchPair({ sourceTaskId: 'a:b', collaborationTaskId: 'c' }))).toBe('ok');
  });

  test('the wait reference round-trips only a 32-hex watch id', () => {
    const id = 'a'.repeat(32);
    expect(reviewWatchRef(id)).toBe(`review-watch:${id}`);
    expect(watchOfRef(reviewWatchRef(id))).toBe(id);
    expect(watchOfRef('review-watch:not-a-digest')).toBeUndefined();
    expect(watchOfRef('github-PR-1')).toBeUndefined();
  });
});

describe('event identity and kinds', () => {
  test('an event is identified by source task, review fence and kind', () => {
    expect(reviewEventKeyOf('c3736677', 2, 'authorization')).toBe('c3736677:2:authorization');
    expect(reviewEventKeyOf('c3736677', 2, 'positive')).not.toBe(reviewEventKeyOf('c3736677', 2, 'authorization'));
    expect(reviewEventKeyOf('c3736677', 3, 'authorization')).not.toBe(reviewEventKeyOf('c3736677', 2, 'authorization'));
  });

  test('the request phase maps to authorization and only the retract maps to positive', () => {
    expect(signalEventKind('request')).toBe('authorization');
    expect(signalEventKind('retract')).toBe('positive');
  });

  test('event kinds default to both and refuse duplicates, empty and unknown values', () => {
    expect(normalizeEventKinds(undefined)).toEqual(['authorization', 'positive']);
    expect(normalizeEventKinds(['positive'])).toEqual(['positive']);
    expect(normalizeEventKinds(['positive', 'authorization'])).toEqual(['authorization', 'positive']);
    expect(codeOf(() => normalizeEventKinds([]))).toBe('invalid');
    expect(codeOf(() => normalizeEventKinds(['positive', 'positive']))).toBe('ok');
    expect(codeOf(() => normalizeEventKinds(['everything']))).toBe('invalid');
    expect(sameEventKinds(['positive', 'authorization'], ['authorization', 'positive'])).toBe(true);
    expect(sameEventKinds(['positive'], ['authorization', 'positive'])).toBe(false);
  });
});

describe('scope subjects are exact same-goal ids only', () => {
  test('sorted and de-duplicated, never widened or empty', () => {
    expect(normalizeScopeSubjects(['b', 'a', 'a'])).toEqual(['a', 'b']);
    expect(codeOf(() => normalizeScopeSubjects([]))).toBe('invalid');
    expect(codeOf(() => normalizeScopeSubjects(['*']))).toBe('invalid');
    expect(codeOf(() => normalizeScopeSubjects(Array.from({ length: 51 }, (_, index) => `t${index}`)))).toBe('invalid');
    expect(codeOf(() => normalizeScopeSubjects(['a\nb']))).toBe('invalid');
  });
});

describe('a stored event is stale once the review lease it was born on moved', () => {
  const live = { state: 'review', reviewerRole: 'qa', holder: 'qa-1', fence: 4, leaseLive: true };

  test('the matching live lease is the only non-stale case', () => {
    expect(reviewEventStaleReason(live, { fence: 4, actor: 'qa-1' })).toBeUndefined();
  });

  test('a moved fence, a new holder, an ended review and a dead lease all invalidate it', () => {
    expect(reviewEventStaleReason({ ...live, fence: 5 }, { fence: 4, actor: 'qa-1' })).toMatch(/fence moved/);
    expect(reviewEventStaleReason({ ...live, holder: 'qa-2' }, { fence: 4, actor: 'qa-1' })).toMatch(/holder changed/);
    expect(reviewEventStaleReason({ ...live, state: 'ready', holder: undefined }, { fence: 4, actor: 'qa-1' })).toMatch(/no longer in QA review/);
    expect(reviewEventStaleReason({ ...live, leaseLive: false }, { fence: 4, actor: 'qa-1' })).toMatch(/not live/);
    expect(reviewEventStaleReason({ leaseLive: false }, { fence: 4, actor: 'qa-1' })).toMatch(/no longer exists/);
  });
});
