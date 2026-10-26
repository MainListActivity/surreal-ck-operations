import { expect, test } from 'bun:test';
import { createSubmitCheck, extractPrUrls, judgePr, judgePrDetailed, type PrInfo } from '../src/pr-gate.ts';

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({ url: 'https://github.com/o/r/pull/7', state: 'OPEN', mergeable: 'MERGEABLE', headRefName: 'task/abcd1234', headRefOid: 'head-1', checks: [{ name: 'quality', conclusion: 'SUCCESS' }], ...over });

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

test('CI failures are soft; closed/conflicting are hard', () => {
  expect(judgePrDetailed(pr({ checks: [{ name: 'quality', conclusion: 'FAILURE' }] }), 'task/abcd1234')).toMatchObject({
    ok: false, hard: false, failedChecks: ['quality'],
  });
  expect(judgePrDetailed(pr({ state: 'CLOSED' }), 'task/abcd1234')).toMatchObject({ ok: false, hard: true });
  expect(judgePrDetailed(pr({ mergeable: 'CONFLICTING' }), 'task/abcd1234')).toMatchObject({ ok: false, hard: true });
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
  const soft = await check({ branch: 'task/abcd1234', text: 'PR https://github.com/o/r/pull/7 以及 https://github.com/o/r/pull/9' });
  expect(soft?.reason).toContain('ci/legacy');
  expect(soft?.ciFailed).toEqual(['ci/legacy']);
  expect(soft?.head).toBe('head-1');
  expect(seen.map(a => a[2])).toEqual(['https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/9']);
  expect(await check({ branch: 'task/abcd1234', text: 'PR https://github.com/o/r/pull/7' })).toEqual({ head: 'head-1' });
});

test('a soft CI failure still names the PR head for managed-local substitute', async () => {
  const check = createSubmitCheck(async () => payload({ statusCheckRollup: [{ name: 'quality', conclusion: 'FAILURE' }, { name: 'channel', conclusion: 'FAILURE' }] }));
  await expect(check({ branch: 'task/abcd1234', text: 'https://github.com/o/r/pull/7' })).resolves.toMatchObject({
    head: 'head-1',
    ciFailed: ['quality', 'channel'],
    prUrl: 'https://github.com/o/r/pull/7',
  });
});

test('a closed PR is a hard refuse without ciFailed', async () => {
  const check = createSubmitCheck(async () => payload({ state: 'CLOSED', statusCheckRollup: [{ name: 'quality', conclusion: 'FAILURE' }] }));
  const verdict = await check({ branch: 'task/abcd1234', text: 'https://github.com/o/r/pull/7' });
  expect(verdict?.reason).toContain('已关闭');
  expect(verdict?.ciFailed).toBeUndefined();
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

test('a check GitHub refused to start is infrastructure, not a failed test', () => {
  const refused = { name: 'quality', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/9/job/5', infrastructureBlocked: 'The job was not started because recent account payments have failed' };
  expect(judgePr(pr({ checks: [refused, { name: 'channel', conclusion: 'SUCCESS' }] }), 'task/abcd1234')).toBeUndefined();
  // A real failure beside it still refuses, and the same check without the refusal is a failure.
  expect(judgePr(pr({ checks: [refused, { name: 'lint', conclusion: 'FAILURE' }] }), 'task/abcd1234')).toContain('lint');
  expect(judgePr(pr({ checks: [{ ...refused, infrastructureBlocked: undefined }] }), 'task/abcd1234')).toContain('quality');
});

const billingMessage = "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";
const billingGh = (steps: unknown[], message = billingMessage) => async (args: string[]) => {
  if (args[0] === 'pr') {
    return payload({ statusCheckRollup: [{ name: 'quality', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/9/job/5' }] });
  }
  if (args[0] === 'api' && String(args[1]).includes('/check-runs/5/annotations')) return JSON.stringify([{ message }]);
  if (args[0] === 'api' && String(args[1]).includes('/actions/jobs/5')) return JSON.stringify({ id: 5, name: 'quality', steps });
  throw new Error(`unexpected gh ${args.join(' ')}`);
};

test('the submit check reads the refusal from GitHub and still names the PR head', async () => {
  expect(await createSubmitCheck(billingGh([]))({ branch: 'task/abcd1234', text: 'https://github.com/o/r/pull/7' })).toEqual({ head: 'head-1' });
  // A job that executed a step is a real failure; so is an annotation that names no billing or spending limit.
  expect((await createSubmitCheck(billingGh([{ name: 'checkout', conclusion: 'failure' }]))({ branch: 'task/abcd1234', text: 'https://github.com/o/r/pull/7' }))?.reason).toContain('quality');
  expect((await createSubmitCheck(billingGh([], 'tests failed'))({ branch: 'task/abcd1234', text: 'https://github.com/o/r/pull/7' }))?.reason).toContain('quality');
  // A check with no job link cannot be waived: the refusal is never inferred.
  const noLink = async (args: string[]) => args[0] === 'pr'
    ? payload({ statusCheckRollup: [{ name: 'quality', conclusion: 'FAILURE' }] })
    : (() => { throw new Error(`unexpected gh ${args.join(' ')}`); })();
  expect((await createSubmitCheck(noLink)({ branch: 'task/abcd1234', text: 'https://github.com/o/r/pull/7' }))?.reason).toContain('quality');
});
