import { describe, expect, test } from 'bun:test';
import { trackOkFor } from '../src/dispatcher/dispatcher.ts';
import { isDedicatedTrack } from '../src/core.ts';

const task = (discipline?: string, executorRole = 'ai-content') => ({ discipline, executorRole } as never);
const ARCH = '专属:架构师';

describe('dedicated tracks pin a task to one def', () => {
  test('a dedicated task only goes to an executor-role def that lists its track', () => {
    expect(trackOkFor('ai-content', task(ARCH), [ARCH])).toBe(true);
    expect(trackOkFor('ai-content', task(ARCH), undefined)).toBe(false);
    expect(trackOkFor('ai-content', task(ARCH), [])).toBe(false);
    expect(trackOkFor('ai-content', task(ARCH), ['文案'])).toBe(false);
    expect(trackOkFor('ai-content', task(ARCH), ['专属:公司员工'])).toBe(false);
  });

  test('a def with a dedicated track never takes ordinary work', () => {
    expect(trackOkFor('ai-content', task(undefined), [ARCH])).toBe(false);
    expect(trackOkFor('ai-content', task('文案'), [ARCH])).toBe(false);
    expect(trackOkFor('ai-content', undefined, [ARCH])).toBe(false);
  });

  test('ordinary defs and tasks keep the old matching', () => {
    expect(trackOkFor('ai-content', task(undefined), undefined)).toBe(true);
    expect(trackOkFor('ai-content', task('文案'), [])).toBe(true);
    expect(trackOkFor('ai-content', task('文案'), ['文案'])).toBe(true);
    expect(trackOkFor('ai-content', task('文案'), ['分镜'])).toBe(false);
    expect(trackOkFor('screenwriter', task('编剧', 'screenwriter'), ['编剧'])).toBe(true);
    expect(trackOkFor('screenwriter', task('编剧', 'screenwriter'), [])).toBe(false);
  });

  test('other roles (reviewer, blocker owner) see a dedicated task as untracked', () => {
    expect(trackOkFor('product', task(ARCH), undefined)).toBe(true);
    expect(trackOkFor('product', task(ARCH), ['规划'])).toBe(true);
  });

  test('the prefix alone is not a track', () => {
    expect(isDedicatedTrack('专属:')).toBe(false);
    expect(isDedicatedTrack(ARCH)).toBe(true);
    expect(isDedicatedTrack(undefined)).toBe(false);
  });
});
