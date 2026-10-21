import { expect, test } from 'bun:test';
import { createSubmitCheck, extractPrUrls, judgePr, type PrInfo } from '../src/pr-gate.ts';

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({ url: 'https://github.com/o/r/pull/7', state: 'OPEN', mergeable: 'MERGEABLE', headRefName: 'task/abcd1234', checks: [{ name: 'quality', conclusion: 'SUCCESS' }], ...over });

test('PR links are found once each in free text', () => {
  expect(extractPrUrls('见 https://github.com/o/r/pull/7 和 https://github.com/o/r/pull/7，另一个 https://github.com/o/r/pull/9。')).toEqual(['https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/9']);
  expect(extractPrUrls('没有链接 #12')).toEqual([]);
});

test('a conflicting, closed or red PR on the task branch cannot go to review', () => {
  expect(judgePr(pr(), 'task/abcd1234')).toBeUndefined();
  expect(judgePr(pr({ mergeable: 'CONFLICTING' }), 'task/abcd1234')).toContain('与主干有冲突');
  expect(judgePr(pr({ state: 'CLOSED' }), 'task/abcd1234')).toContain('已关闭且未合并');
  expect(judgePr(pr({ checks: [{ name: 'quality', conclusion: 'FAILURE' }, { name: 'channel', conclusion: 'SUCCESS' }, { name: 'lint', state: 'ERROR' }] }), 'task/abcd1234')).toContain('quality、lint');
});

test('pending checks, merged PRs and unknown mergeability are not failures', () => {
  expect(judgePr(pr({ checks: [{ name: 'quality', conclusion: '' }, { name: 'channel', state: 'PENDING' }] }), 'task/abcd1234')).toBeUndefined();
  expect(judgePr(pr({ state: 'MERGED' }), 'task/abcd1234')).toBeUndefined();
  expect(judgePr(pr({ mergeable: 'UNKNOWN' }), 'task/abcd1234')).toBeUndefined();
});

test('only the PR that carries the task branch is judged; other linked PRs are context', () => {
  expect(judgePr(pr({ headRefName: 'task/other', mergeable: 'CONFLICTING', state: 'CLOSED' }), 'task/abcd1234')).toBeUndefined();
  expect(judgePr(pr({ mergeable: 'CONFLICTING' }), undefined)).toBeUndefined();
});

const payload = (over: Record<string, unknown> = {}) => JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', headRefName: 'task/abcd1234', headRefOid: 'head-1', statusCheckRollup: [{ name: 'quality', conclusion: 'SUCCESS' }], ...over });

test('the submit check reads linked PRs through gh and names the first problem', async () => {
  const seen: string[][] = [];
  const check = createSubmitCheck(async args => { seen.push(args); return args[2]!.endsWith('/9') ? payload({ statusCheckRollup: [{ context: 'ci/legacy', state: 'FAILURE' }] }) : payload(); });
  expect((await check({ branch: 'task/abcd1234', text: 'PR https://github.com/o/r/pull/7 以及 https://github.com/o/r/pull/9' }))?.reason).toContain('ci/legacy');
  expect(seen.map(a => a[2])).toEqual(['https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/9']);
  expect(await check({ branch: 'task/abcd1234', text: 'PR https://github.com/o/r/pull/7' })).toEqual({ head: 'head-1' });
});

test('the submit check returns the own PR head and ignores another branch head', async () => {
  const own = createSubmitCheck(async () => payload());
  expect(await own({ branch: 'task/abcd1234', text: 'https://github.com/o/r/pull/7' })).toEqual({ head: 'head-1' });
  const other = createSubmitCheck(async () => payload({ headRefName: 'task/other', headRefOid: 'other-head' }));
  expect(await other({ branch: 'task/abcd1234', text: 'https://github.com/o/r/pull/7' })).toBeUndefined();
  const noHead = createSubmitCheck(async () => payload({ headRefOid: undefined }));
  expect(await noHead({ branch: 'task/abcd1234', text: 'https://github.com/o/r/pull/7' })).toBeUndefined();
});

test('no branch, no link, or any gh trouble lets the submission through', async () => {
  let calls = 0;
  const broken = createSubmitCheck(async () => { calls++; throw new Error('gh: not logged in'); });
  expect(await broken({ branch: 'task/abcd1234', text: 'https://github.com/o/r/pull/7' })).toBeUndefined(); expect(calls).toBe(1);
  expect(await createSubmitCheck(async () => 'not json')({ branch: 'task/abcd1234', text: 'https://github.com/o/r/pull/7' })).toBeUndefined();
  expect(await broken({ text: 'https://github.com/o/r/pull/7' })).toBeUndefined();
  expect(await broken({ branch: 'task/abcd1234', text: '没有链接' })).toBeUndefined(); expect(calls).toBe(1);
});
