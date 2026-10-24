// SYS03 unit tests that need no database: the episode/business/notice identities the whole ledger keys on, and the
// controlled external exit's honest three-way outcome mapping (confirmed / refused / result_unknown). The fork-level
// concurrency, idempotency and rollback drills live in disposition.integration.fork.test.ts and
// disposition-rollback-isolation.fork.test.ts.
import { expect, test } from 'bun:test';
import { createCompanyGithubGateway, githubRepoSlug } from '../src/external-actions.ts';
import { dispositionBusinessKey, dispositionEpisodeKey, dispositionNoticeKey } from '../src/disposition.ts';

test('episode identity is task + phase + episode start, and the same episode keeps one key', () => {
  expect(dispositionEpisodeKey('task-1', 'execute', 1_700_000_000_000)).toBe('task-1:execute:1700000000000');
  expect(dispositionEpisodeKey('task-1', 'review', 1_700_000_000_000)).toBe('task-1:review:1700000000000');
  // A new episode (a new start) is a different key: it can be claimed and decided on its own.
  expect(dispositionEpisodeKey('task-1', 'execute', 1_700_000_001_000))
    .not.toBe(dispositionEpisodeKey('task-1', 'execute', 1_700_000_000_000));
});

test('the business key carries no employee identity: a swap, a restart or a replay reads the same disposition', () => {
  const episode = dispositionEpisodeKey('task-1', 'execute', 1_700_000_000_000);
  const key = dispositionBusinessKey(episode, 'repair');
  expect(key).toBe(`${episode}\0repair`);
  // Nothing about who asked is in the key — that is what stops a second repair chain after an employee change.
  expect(dispositionBusinessKey(episode, 'repair')).toBe(key);
  // A different action on the same episode is a different business operation, and an explicit key is namespaced.
  expect(dispositionBusinessKey(episode, 'resume')).not.toBe(key);
  expect(dispositionBusinessKey(episode, 'repair', 'release-2026-10-23')).toBe(dispositionBusinessKey('other-episode', 'repair', 'release-2026-10-23'));
  expect(dispositionBusinessKey(episode, 'repair', 'release-2026-10-23')).toBe('custom\0release-2026-10-23');
});

test('notice identity includes the episode, the kind and the version, so one event notifies once', () => {
  const episode = dispositionEpisodeKey('task-1', 'execute', 1_700_000_000_000);
  expect(dispositionNoticeKey(episode, 'disposition_decided', 7)).toBe(`${episode}\0disposition_decided\0` + '7');
  expect(dispositionNoticeKey(episode, 'disposition_decided', 7)).toBe(dispositionNoticeKey(episode, 'disposition_decided', 7));
  expect(dispositionNoticeKey(episode, 'resumed', 7)).not.toBe(dispositionNoticeKey(episode, 'disposition_decided', 7));
  expect(dispositionNoticeKey(episode, 'disposition_decided', 8)).not.toBe(dispositionNoticeKey(episode, 'disposition_decided', 7));
});

/** One scripted gh runner: every call is answered from the list, and the calls themselves are recorded. */
const scripted = (...answers: Array<{ match: (args: string[]) => boolean; out?: string; fail?: string }>) => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const answer = answers.find(a => a.match(args));
    if (!answer) throw new Error(`unscripted gh call: ${args.join(' ')}`);
    if (answer.fail) throw new Error(answer.fail);
    return answer.out ?? '';
  };
  return { calls, run };
};

const runJson = (status: string, conclusion: string | null, account: string | null) =>
  JSON.stringify({ status, conclusion, account, createdAt: '2026-10-23T00:00:00Z',
    headBranch: 'lane/sys03-fixture', headSha: 'abcdef0123456789' });
const isRead = (args: string[]) => args[0] === 'api' && args[1] !== undefined && !args[1].startsWith('--method') && !args.includes('POST');
const isCancel = (args: string[]) => args.includes('POST') && args.some(a => a.endsWith('/cancel'));

test('AC03: an accepted cancel is recorded as confirmed with the provider account kept only as an external account', async () => {
  const gh = scripted(
    { match: isRead, out: runJson('in_progress', null, 'shared-bot') },
    { match: isCancel, out: '' },
  );
  // The readback after the cancel: same scripted answer (a real provider would already report the cancellation).
  const view = await createCompanyGithubGateway(gh.run).cancelRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' });
  expect(view).toMatchObject({ confirmed: true, runStatus: 'in_progress', externalAccount: 'shared-bot' });
  expect(gh.calls.filter(isCancel)).toHaveLength(1);
  expect(gh.calls.filter(isRead).length).toBeGreaterThanOrEqual(1);
});

test('AC03: a run the provider does not know, or one already terminal, is a definite refusal — never an unknown', async () => {
  const missing = scripted({ match: isRead, fail: 'HTTP 404: Not Found (gh api ...)' });
  expect(await createCompanyGithubGateway(missing.run).cancelRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' }))
    .toMatchObject({ refused: true });
  expect(missing.calls.filter(isCancel)).toHaveLength(0);

  const terminal = scripted({ match: isRead, out: runJson('completed', 'success', 'shared-bot') });
  const refused = await createCompanyGithubGateway(terminal.run).cancelRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' });
  expect(refused).toMatchObject({ refused: true });
  if (!('refused' in refused)) throw new Error('expected a refusal');
  expect(refused.reason).toContain('completed');
  expect(terminal.calls.filter(isCancel)).toHaveLength(0);
});

test('AC03 (QA V5): a replay that finds the run terminal-cancelled reads it as the cancellation we asked for', async () => {
  // 第一次请求读到终态 = provider 的明确拒绝，且不发取消请求。
  const terminal = scripted({ match: isRead, out: runJson('completed', 'cancelled', 'shared-bot') });
  expect(await createCompanyGithubGateway(terminal.run).cancelRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' }))
    .toMatchObject({ refused: true });
  expect(terminal.calls.filter(isCancel)).toHaveLength(0);

  // 重放（我们已经为同一个 actionKey 发过请求，崩溃点在 provider 取消之后、回执之前）：同一个终态就是
  // 我们自己那次取消生效了，记 confirmed 并附 provider 读回。
  const replay = await createCompanyGithubGateway(terminal.run)
    .cancelRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' }, { replay: true });
  expect(replay).toMatchObject({ confirmed: true, runStatus: 'completed' });
  if (!('confirmed' in replay) || replay.confirmed !== true) throw new Error('expected a confirmation');
  expect(replay.observed).toMatchObject({ conclusion: 'cancelled', replay: 'already-terminal-cancelled' });

  // 重放时终态不是取消（运行自己失败了）→ 仍然是拒绝，绝不把失败读成成功。
  const failedRun = scripted({ match: isRead, out: runJson('completed', 'failure', 'shared-bot') });
  expect(await createCompanyGithubGateway(failedRun.run)
    .cancelRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' }, { replay: true }))
    .toMatchObject({ refused: true });
});

test('AC05 (QA D3): a replay of a request that has not settled reads the run, posts nothing and stays unknown', async () => {
  // 取消请求已经发出去（回执丢了），run 还在跑：重放只读状态。绝不能第二次 POST，也绝不能伪报 confirmed——
  // 诚实的结果是 result_unknown，等 provider 真的落成 cancelled 之后再读一次才变 confirmed。
  const pending = scripted({ match: isRead, out: runJson('in_progress', null, 'shared-bot') });
  const gateway = createCompanyGithubGateway(pending.run);
  const unsettled = await gateway.cancelRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' }, { replay: true });
  expect(unsettled).toMatchObject({ confirmed: false });
  if (!('error' in unsettled)) throw new Error('expected an unknown');
  expect(unsettled.error).toContain('has not settled');
  expect(unsettled.observed).toMatchObject({ replay: 'not-settled-yet' });
  expect(pending.calls.filter(isCancel)).toHaveLength(0);

  // 它真的落定成 cancelled 之后，同一个 key 的再一次重放就是 confirmed（这就是 G4 那条路径的收尾）。
  const settled = scripted({ match: isRead, out: runJson('completed', 'cancelled', 'shared-bot') });
  expect(await createCompanyGithubGateway(settled.run)
    .cancelRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' }, { replay: true }))
    .toMatchObject({ confirmed: true, runStatus: 'completed' });
  expect(settled.calls.filter(isCancel)).toHaveLength(0);
});

test('AC05 (QA D2/D3): the provider exit is claimed once, so a rival request under one action key posts nothing', async () => {
  // 并发下只有把 post_claimed 从「没发过」翻成「发过」的那一次调用会真的 POST；对手不 POST 且如实回 unknown。
  const gh = scripted(
    { match: isRead, out: runJson('in_progress', null, 'shared-bot') },
    { match: isCancel, out: '' },
  );
  const gateway = createCompanyGithubGateway(gh.run);
  const won = await gateway.cancelRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' },
    { claimRequest: async () => true });
  expect(won).toMatchObject({ confirmed: true });
  expect(gh.calls.filter(isCancel)).toHaveLength(1);

  const lost = await gateway.cancelRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' },
    { claimRequest: async () => false });
  expect(lost).toMatchObject({ confirmed: false });
  if (!('error' in lost)) throw new Error('expected an unknown');
  expect(lost.error).toContain('posted nothing');
  expect(gh.calls.filter(isCancel)).toHaveLength(1);
});

test('QA D5: a repository identifier only compares as a repo when it resolves to a GitHub slug', () => {
  // 能比的形式：登记的就是 slug，或者是能解析出 slug 的 remote。
  expect(githubRepoSlug('surreal-ck/operations-fixture')).toBe('surreal-ck/operations-fixture');
  expect(githubRepoSlug('https://github.com/surreal-ck/operations-fixture')).toBe('surreal-ck/operations-fixture');
  expect(githubRepoSlug('https://github.com/surreal-ck/operations-fixture.git')).toBe('surreal-ck/operations-fixture');
  expect(githubRepoSlug('git at github.com:surreal-ck/operations-fixture.git')).toBe('surreal-ck/operations-fixture');
  // 比不出来的形式（本地路径、裸名字）：返回 undefined，调用方只能记「依据是分支」而不是假装核过仓库。
  expect(githubRepoSlug('/Users/y/IdeaProjects/surreal-ck')).toBeUndefined();
  expect(githubRepoSlug('surreal-ck')).toBeUndefined();
  expect(githubRepoSlug('')).toBeUndefined();
});

test('AC03: an unreadable run or a failed cancel request is result_unknown, not a fabricated success', async () => {
  const unreadable = scripted({ match: isRead, fail: 'dial tcp: connection refused' });
  expect(await createCompanyGithubGateway(unreadable.run).cancelRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' }))
    .toMatchObject({ confirmed: false });

  const failedPost = scripted(
    { match: isRead, out: runJson('in_progress', null, 'shared-bot') },
    { match: isCancel, fail: 'HTTP 500' },
  );
  expect(await createCompanyGithubGateway(failedPost.run).cancelRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' }))
    .toMatchObject({ confirmed: false });
});

test('AC03: reconciliation reads the provider as unknown_actor, and an absent run is a readable fact', async () => {
  const gateway = createCompanyGithubGateway(scripted({ match: isRead, out: runJson('completed', 'cancelled', 'shared-bot') }).run);
  expect(await gateway.observeRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' }))
    .toMatchObject({ readable: true, exists: true, runStatus: 'completed', externalAccount: 'shared-bot',
      // QA V2：受控外部动作要用这个字段把 run 绑到前置任务的登记分支上。
      headBranch: 'lane/sys03-fixture', attribution: 'unknown_actor' });

  const absent = createCompanyGithubGateway(scripted({ match: isRead, fail: 'gh: Not Found (HTTP 404)' }).run);
  expect(await absent.observeRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' }))
    .toMatchObject({ readable: true, exists: false, attribution: 'unknown_actor' });

  const broken = createCompanyGithubGateway(scripted({ match: isRead, fail: 'network unreachable' }).run);
  expect(await broken.observeRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '42' }))
    .toMatchObject({ readable: false });
});

test('AC03: a target without both repo and run id is refused before any provider call', async () => {
  const gh = scripted({ match: () => true, out: '{}' });
  const gateway = createCompanyGithubGateway(gh.run);
  expect(await gateway.cancelRun({ provider: 'github', repo: '', runId: '42' })).toMatchObject({ confirmed: false });
  expect(await gateway.observeRun({ provider: 'github', repo: 'surreal-ck/repo', runId: '' })).toMatchObject({ readable: false });
  expect(gh.calls).toHaveLength(0);
});
