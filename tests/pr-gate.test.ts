import { expect, test } from 'bun:test';
import { createSubmitCheck, extractPrUrls, judgePr, type PrInfo } from '../src/pr-gate.ts';
import { assertEmployeeCiBlockAllowed, createCiBillingCheck, isCiBlockCause } from '../src/github-ci-control.ts';
import { referenceReport, referenceSentence } from './fixtures/ci-reference-report.ts';
import { citationWordBypassBlockers, customerBillingWaits, existingGapBlockers } from './fixtures/ci-billing-boundary.ts';

test.each([referenceSentence, referenceReport])('研究旁证不是当前 CI 原因：%s', text => {
  expect(() => assertEmployeeCiBlockAllowed(text)).not.toThrow();
  expect(isCiBlockCause([text])).toBe(false);
});

test('网页引用与已完成CI背景不启动当前CI原因检查', () => {
  for (const text of [
    '已核对 GitHub release 与 billing/self-serve.md，等待内部元数据处置确认。',
    'GitHub CI 已完成，当前等待老板确认客户账单。',
    'GitHub CI 已通过；等待内部元数据处置，计费文档仅为旁证。']) {
    expect(() => assertEmployeeCiBlockAllowed(text)).not.toThrow();
    expect(isCiBlockCause([text])).toBe(false);
  }
});

test('当前 CI 原因不能通过附加旁证声明或已完成背景逃逸', () => {
  for (const text of [
    'GitHub CI 因账户付款失败未启动，等待老板付款。',
    'GitHub CI 因账户付款失败未启动，引用仅为旁证。',
    'GitHub CI 已完成，但当前 CI 因付款失败未启动。',
    'GitHub CI 计费阻塞，等待老板付款；本报告不申请豁免。',
    'CI 等待账户问题解决后执行。',
  ]) {
    expect(isCiBlockCause([text])).toBe(true);
    expect(() => assertEmployeeCiBlockAllowed(text)).toThrow();
  }
  expect(isCiBlockCause(['检查未启动，需老板处理'])).toBe(true);
  expect(isCiBlockCause(['GitHub CI 断言测试失败'])).toBe(true);
  expect(isCiBlockCause(['CI 等待检查结果'])).toBe(true);
});

// A billing blocker owes no fixed problem vocabulary: every phrasing of a current CI billing
// obstruction is a CI cause and refuses, even dressed as a citation or a completed-CI report.
test('真实 CI 计费阻塞与等待的全部写法仍被拒绝', () => {
  for (const text of [
    'GitHub CI 账单未付，需老板处理。',
    'GitHub CI 账单需老板付款，才能跑 workflow。',
    'GitHub CI billing issue; waiting for owner payment.',
    'GitHub Actions spending limit needs to be raised before jobs can run.',
    'GitHub CI 账单已逾期，需老板付款后才能继续。',
    'GitHub CI 账单需付款，老板付款后再运行。',
    'GitHub Actions 因账单问题未运行，需老板付款。',
    'GitHub CI 暂停，原因是账户付款问题，需老板付款。',
    'GitHub CI 显示 spending limit 已达上限，需老板提高上限。',
    'CI 账户问题未解决，需老板处理。',
    'GitHub CI 已通过（计费页已核对）；但 CI 账单未付，需老板付款。',
    'GitHub CI 已通过，但账单未付需老板付款。',
    'GitHub CI 账单未付，以上摘自计费文档。',
    '引文核对无误；GitHub CI 账单需付款。',
    '核对计费页后确认：GitHub CI 账户问题需要老板处理。',
    '引用 billing 页面：GitHub CI 因账户付款卡住，请老板付款。',
    '引文核对后确认：GitHub Actions 计费额度耗尽，需老板处理。',
    '已核对计费页：GitHub CI 账户余额不足，需老板充值后再跑。',
    '引文核对：GitHub CI 账户付款卡住，引用仅为旁证。',
    'GitHub CI 已通过，账户付款卡住，需老板付款。',
    'quotation: GitHub Actions is blocked by the account payment hold.',
  ]) {
    expect(isCiBlockCause([text])).toBe(true);
    expect(() => assertEmployeeCiBlockAllowed(text)).toThrow();
  }
});

// The mirror image of the rejections above: citation clauses that only describe fetched or quoted
// material, including negated and evidentiary mentions, assert no current CI state at all.
test('参考段落变体只描述资料内容，不是当前 CI 原因', () => {
  for (const text of [
    '本轮重新抓取计费页和 GitHub release 页，引文与报告一致，未发现失败。',
    '本轮核对计费文档；GitHub release 页无法作为 CI 判定依据，仅作研究旁证。',
    '已抓取 GitHub 计费页面，页面内容无阻塞说明，等待内部元数据处置。',
  ]) {
    expect(() => assertEmployeeCiBlockAllowed(text)).not.toThrow();
    expect(isCiBlockCause([text])).toBe(false);
  }
});

test('CI billing blockers are system-owned; ordinary invoices and real test failures remain separate', () => {
  for (const text of ['GitHub CI 账单失败，要求付款', 'CI 因计费未启动', 'GitHub Actions spending limit reached',
    'CI: account payments have failed', 'GitHub Billing & plans', 'workflow 支出上限']) {
    expect(() => assertEmployeeCiBlockAllowed(text)).toThrow();
  }
  for (const text of ['客户账单需要老板批准', 'GitHub CI 断言测试失败', '生产服务器余额不足', '普通外部审批',
    'GitHub PR 已完成；等待老板批准客户账单']) {
    expect(() => assertEmployeeCiBlockAllowed(text)).not.toThrow();
  }
  expect(() => assertEmployeeCiBlockAllowed('GitHub CI 已完成', '请老板批准客户账单')).not.toThrow();
});

// Citation wording and missing punctuation never move a current CI billing state out of the CI cause.
test('引文词与无标点写法不能包住当前CI计费状态', () => {
  for (const text of citationWordBypassBlockers) {
    expect(isCiBlockCause([text])).toBe(true);
    expect(() => assertEmployeeCiBlockAllowed(text)).toThrow();
  }
});

// Sentence or semicolon breaks, completed-CI conjunctions and Actions minute quota are the same CI billing cause.
test('既有缺口：句号、分号、并列与分钟额度不能切开CI与付款', () => {
  for (const text of existingGapBlockers) {
    expect(isCiBlockCause([text])).toBe(true);
    expect(() => assertEmployeeCiBlockAllowed(text)).toThrow();
  }
});

// A customer invoice beside a completed CI is an unrelated business wait, not a CI cause.
test('CI已完成旁的客户账单付款等待不是CI原因', () => {
  for (const text of customerBillingWaits) {
    expect(() => assertEmployeeCiBlockAllowed(text)).not.toThrow();
    expect(isCiBlockCause([text])).toBe(false);
  }
});

const refused = (text: string): boolean => {
  try { assertEmployeeCiBlockAllowed(text); return false; } catch { return true; }
};

// Deterministic sweep over CI billing wording. A current CI billing state refuses under every citation wrapper, joint
// and tail; citation-only CI sentences and customer invoices beside a completed CI stay open.
test('变体扫描：引文包裹的CI计费状态全部拒绝，纯引文与客户账单全部放行', () => {
  const subjects = ['GitHub CI', 'GitHub Actions', 'CI', 'workflow'];
  const wrappers = ['', '已核对计费页', '引文核对', '核对计费说明', '引用 billing 页面', '已抓取账单页', '摘自计费文档', '仅作旁证：'];
  const joints = ['', ' ', '，', '。'];
  const states = ['未付款逾期', '付款卡住了问题', '未付款', '账户问题', '欠费', '余额不足', '需老板付款', '额度耗尽',
    '免费分钟用尽', 'spending limit 已达上限', '支付失败', '账单未付', 'billing issue', 'payment failed'];
  const billingTails = ['', '，需老板处理', '，引文与报告一致', '，仅为旁证', '；引用仅为旁证', '。以上摘自计费文档',
    '，未对任何 CI 作出豁免或成功判定'];
  // A citation-only sentence keeps its marker beside the CI word; a bare CI word with no marker is a CI cause by design.
  const citationTails = ['', '，引文与报告一致', '，仅为旁证', '，未对任何 CI 作出豁免或成功判定', '，仅供参考', '。以上摘自计费文档'];
  const doneCi = ['GitHub CI 已完成，', 'GitHub CI 已通过；', 'GitHub PR 已完成，'];
  const customerWaits = ['客户付款卡住，等待老板处理', '客户账单需老板付款', '当前等待老板确认客户账单', '客户欠费，需老板处理'];
  const bypasses: string[] = [];
  const falseRefusals: string[] = [];
  let billingClaims = 0, citationOnly = 0;
  for (const wrapper of wrappers) for (const subject of subjects) {
    for (const joint of joints) for (const state of states) for (const tail of billingTails) {
      const text = `${wrapper}${subject}${joint}${state}${tail}`;
      billingClaims++;
      if (!refused(text) || !isCiBlockCause([text])) bypasses.push(text);
    }
    for (const tail of citationTails) {
      // Without a wrapper, the tail must stay in the CI word's sentence, so a bare CI word or a sentence break has no marker.
      if (wrapper === '' && (tail === '' || tail.startsWith('。'))) continue;
      const text = `${wrapper}${subject}${tail}`;
      citationOnly++;
      if (refused(text) || isCiBlockCause([text])) falseRefusals.push(text);
    }
  }
  for (const opening of doneCi) for (const wait of customerWaits) {
    const text = `${opening}${wait}`;
    citationOnly++;
    if (refused(text) || isCiBlockCause([text])) falseRefusals.push(text);
  }
  expect(billingClaims).toBeGreaterThan(10_000);
  expect(citationOnly).toBeGreaterThan(150);
  expect(bypasses).toEqual([]);
  expect(falseRefusals).toEqual([]);
});

test('CI billing control reads PR/run sources even when the blocker omits all billing words', async () => {
  const github = (steps: unknown[] = []) => async (args: string[]) => {
    if (args[0] === 'pr') return JSON.stringify({state:'OPEN',headRefOid:'head-1',statusCheckRollup:[{detailsUrl:'https://github.com/o/r/actions/runs/9/job/5'}]});
    if (args[0] === 'run') return JSON.stringify({headSha:'head-1',conclusion:'failure'});
    if (args[1]?.endsWith('/jobs')) return JSON.stringify({jobs:[{id:5,steps}]});
    if (args[1]?.endsWith('/annotations')) return JSON.stringify([{message:'account payments have failed'}]);
    throw Error('unexpected GitHub request');
  };
  const text = '检查未启动，需老板解决账户问题。https://github.com/o/r/pull/7';
  expect(await createCiBillingCheck(github())({text})).toEqual({runUrl:'https://github.com/o/r/actions/runs/9',sha:'head-1'});
  expect(await createCiBillingCheck(github())({text:'PR #7 检查未启动',repo:'o/r'}))
    .toEqual({runUrl:'https://github.com/o/r/actions/runs/9',sha:'head-1'});
  expect(await createCiBillingCheck(github([{name:'tests',conclusion:'failure'}]))({text})).toBeUndefined();
  const mixed = async (args: string[]) => {
    if (args[0] === 'pr') return JSON.stringify({state:'OPEN',headRefOid:'head-1',statusCheckRollup:[
      {detailsUrl:'https://github.com/o/r/actions/runs/9/job/5'},
      {detailsUrl:'https://github.com/o/r/actions/runs/10/job/6'},
    ]});
    if (args[1]?.includes('/runs/10/jobs')) return JSON.stringify({jobs:[{id:6,steps:[{name:'test',conclusion:'failure'}]}]});
    return github()(args);
  };
  expect(await createCiBillingCheck(mixed)({text})).toBeUndefined();
  expect(await createCiBillingCheck(github())({text,head:'other-head'})).toBeUndefined();
  expect(await createCiBillingCheck(async () => {throw Error('offline');})({text})).toBeUndefined();
});

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
