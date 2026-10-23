// The actual /q/ console implementation (server-rendered page) against a stub core: login cookie, allowlisted task,
// every dispatch reason, timeline cursor pages, context/evidence segment reassembly, and no write/owner route.
import { expect, test } from 'bun:test';
import { createQaConsoleFetch } from '../plugin/server/qa-console.ts';

const scope = { id: 'scope-1', goalId: 'goal-1', deploymentTaskId: 'deploy-1', subjects: ['t1', 't2'],
  expiresAt: '2026-10-22T01:00:00Z', leaseHolder: 'qa-1', leaseFence: 3, version: 1, status: 'active' };
const reasons = Array.from({ length: 31 }, (_, i) => ({ code: `reason-${i}`, text: `原因 ${i}`, candidates: ['candidate'], owner: 'gm', recovery: '恢复', nextTrigger: '触发', basis: 'contribution-audit' }));
const readView = {
  meta: { checkedAt: '2026-10-22T00:20:00Z', dataSource: 'live', instanceAt: '2026-10-22T00:20:00Z', scope, completeness: { complete: true, dispatchComplete: true } },
  task: { id: 't1', title: '主体任务', state: 'review', version: 4, executorRole: 'engineering', reviewerRole: 'qa', implementer: 'eng-1', currentEmployee: 'qa-1', goalId: 'goal-1', kind: 'deploy', dependencies: [], waiting: undefined },
  contribution: { authors: ['eng-1'], reviewers: ['qa-1'], excluded: ['eng-1'], unknown: [{ actor: 'legacy', action: 'checkpoint', reason: '未知' }], implementer: 'eng-1', ambiguous: false },
  dispatch: { available: true, complete: true, source: 'dispatcher-pass', checkedAt: '2026-10-22T00:19:00Z', originalVerdicts: 1, originalReasons: 31,
    attemptAt: '2026-10-22T00:19:00Z', attemptOk: true,
    verdicts: [{ phase: 'review', dispatchable: false, workflowState: 'review', eligibleCount: 0, feasible: false, summary: '无独立复核人选', checkedAt: '2026-10-22T00:19:00Z', waitingMinutes: 5, reasons }] },
  contextOmitted: true, contextBytes: 30000, contextSha256: 'a'.repeat(64),
};
const page1 = { history: [{ auditId: 'a1', action: 'checkpoint', actor: 'eng-1', at: '2026-10-22T00:10:00Z', version: 2, evidence: '短证据', evidenceBytes: 12, evidenceSha256: 'b'.repeat(64), evidenceTruncated: false }], page: { returned: 1, total: 11, hasMore: true, nextCursor: 'cursor-2', snapshotAt: '2026-10-22T00:20:00Z' } };
const page2 = { history: [{ auditId: 'a2', action: 'submit', actor: 'eng-1', at: '2026-10-22T00:11:00Z', version: 3, evidence: 'x'.repeat(200), evidenceBytes: 200, evidenceSha256: 'c'.repeat(64), evidenceTruncated: true }], page: { returned: 1, total: 11, hasMore: false, snapshotAt: '2026-10-22T00:20:00Z' } };
let textCalls: any[] = [];
const core = {
  qaObservationLogin: async (code: string) => { if (code !== 'code-1') throw new Error('login code is invalid'); return { token: 'tok-1', scope, expiresAt: '2026-10-22T00:35:00Z', pagePath: '/q/' }; },
  qaObservationRead: async (_auth: any, input: any) => input.goalId
    ? { meta: { scope, completeness: { dispatchComplete: true } }, goal: { id: input.goalId, states: { review: 1 }, total: 1, undispatchable: 0, checkedAt: '2026-10-22T00:19:00Z' } }
    : readView,
  qaObservationTimeline: async (_auth: any, input: any) => input.cursor === 'cursor-2' ? page2 : page1,
  qaObservationText: async (_auth: any, input: any) => {
    textCalls.push(input);
    if (input.field === 'evidence') return { taskId: input.taskId, field: 'evidence', auditId: input.auditId, totalBytes: 4, sha256: 'd'.repeat(64), offset: 0, bytes: 4, nextOffset: null, text: '证据原文' };
    if ((input.offset ?? 0) === 0) return { taskId: input.taskId, field: 'context', totalBytes: 6, sha256: 'e'.repeat(64), offset: 0, bytes: 3, nextOffset: 3, text: 'abc' };
    return { taskId: input.taskId, field: 'context', totalBytes: 6, sha256: 'e'.repeat(64), offset: 3, bytes: 3, nextOffset: null, text: 'def' };
  },
};
const consoleFetch = createQaConsoleFetch({ home: '/nonexistent', company: async () => ({ core }) as any });
const cookie = 'sck_qa=tok-1';
const get = (path: string) => consoleFetch(new Request(`http://x${path}`, { headers: { cookie } }));
const post = (path: string, body: string) => consoleFetch(new Request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }));

test('login sets an HttpOnly restricted cookie; bad codes stay on the login page', async () => {
  let r = await consoleFetch(new Request('http://x/q/'));
  expect(r.status).toBe(200);
  expect(await r.text()).toContain('一次性登录码');
  r = await post('/q/login', 'code=bad');
  expect(await r.text()).toContain('invalid');
  r = await post('/q/login', 'code=code-1');
  expect(r.status).toBe(303);
  const set = r.headers.get('set-cookie') ?? '';
  expect(set).toContain('sck_qa=tok-1');
  expect(set).toContain('HttpOnly');
});

test('the page shows the allowlisted task, every dispatch reason, and no owner/write route', async () => {
  const r = await get('/q/');
  const page = await r.text();
  expect(page).toContain('主体任务');
  for (const reason of ['reason-0', 'reason-15', 'reason-30']) expect(page).toContain(reason);
  expect(page).toContain('审计时间线');
  expect(page).not.toContain('company.pause.set');
  expect(page).not.toContain('owner.setPaused');
  expect((await consoleFetch(new Request('http://x/q/', { method: 'POST', headers: { cookie } }))).status).toBe(405);
  expect((await get('/q/api/brief')).status).toBe(404);
});

test('timeline pages follow nextCursor and show truncated evidence as a readable link', async () => {
  const first = await (await get('/q/timeline?taskId=t1')).text();
  expect(first).toContain('cursor-2');
  expect(first).toContain('短证据');
  const second = await (await get('/q/timeline?taskId=t1&cursor=cursor-2')).text();
  expect(second).toContain('证据已截断');
  expect(second).toContain('auditId=a2');
});

test('context and evidence are reassembled in nextOffset+sha256 segments', async () => {
  textCalls = [];
  const text = await (await get('/q/text?taskId=t1&field=context')).text();
  expect(text).toContain('abcdef');
  expect(text).toContain('完整');
  expect(textCalls.length).toBe(2);
  expect(textCalls[0].expectSha256).toBeUndefined();
  expect(textCalls[1].expectSha256).toBe('e'.repeat(64));
  const evidence = await (await get('/q/text?taskId=t1&field=evidence&auditId=a2')).text();
  expect(evidence).toContain('证据原文');
});

test('short inline context is rendered, every task offers a context link, and goal coverage is explicit', async () => {
  const marker = 'INLINE_CONTEXT_MUST_BE_VISIBLE_正体验收条件';
  const inlineRead = { meta: { scope, completeness: { complete: true, contextIncluded: true }, dataSource: 'live' },
    task: { id: 'short-task', title: '短正文主体', context: marker, state: 'review', version: 1 }, dispatch: { available: false, reason: 'local fixture' } };
  const goalIncomplete = { meta: { scope, completeness: { dispatchComplete: false } },
    goal: { id: 'goal-1', total: 5, states: { review: 1 }, dispatchComplete: false, dispatchReason: 'no dispatcher pass observation' } };
  const app = createQaConsoleFetch({ home: '/nonexistent', company: async () => ({ core: {
    qaObservationRead: async (_a: any, input: any) => input.goalId ? goalIncomplete : inlineRead,
  } }) as any });
  const page = await (await app(new Request('http://x/q/?taskId=short-task', { headers: { cookie } }))).text();
  expect(page).toContain(marker);
  expect(page).toContain('field=context');
  const goalPage = await (await app(new Request('http://x/q/?goal=1', { headers: { cookie } }))).text();
  expect(goalPage).toContain('不可用/未知');
  expect(goalPage).not.toContain('无法派工 0');
  const completeApp = createQaConsoleFetch({ home: '/nonexistent', company: async () => ({ core: {
    qaObservationRead: async (_a: any, input: any) => ({ meta: { scope, completeness: { dispatchComplete: true } },
      goal: { id: input.goalId, total: 5, states: { review: 1 }, dispatchComplete: true, undispatchable: 2, dispatchCheckedAt: '2026-10-22T00:19:00Z' } }),
  } }) as any });
  const completePage = await (await completeApp(new Request('http://x/q/?goal=1', { headers: { cookie } }))).text();
  expect(completePage).toContain('无法派工 2');
  expect(completePage).toContain('完整');
});

test('F1: next trigger, basis and structured actions render; missing fields show unknown, never invented', async () => {
  const withActions = { ...readView,
    dispatch: { ...readView.dispatch,
      verdicts: [{ ...readView.dispatch.verdicts[0],
        reasons: [{ code: 'implementer_mismatch', text: '任务已绑定实现负责人', candidates: ['eng-2'], owner: 'gm',
          recovery: '经理用 implementer_takeover 显式接手', nextTrigger: '绑定实现负责人可派工', basis: 'contribution-audit',
          actions: [{ authority: 'gm', label: '经理用 implementer_takeover 显式接手', tool: 'implementer_takeover', executable: true },
            { authority: 'owner', label: '老板线下确认', executable: false }] }] }] } };
  const legacy = { ...readView,
    dispatch: { ...readView.dispatch, verdicts: [{ ...readView.dispatch.verdicts[0],
      reasons: [{ code: 'quota', text: '订阅额度耗尽', candidates: [], owner: 'owner', recovery: '等待恢复' }] }] } };
  const mk = (view: unknown) => createQaConsoleFetch({ home: '/nonexistent', company: async () => ({ core: {
    qaObservationRead: async () => view,
  } }) as any });
  const page = await (await mk(withActions)(new Request('http://x/q/?taskId=t1', { headers: { cookie } }))).text();
  expect(page).toContain('下一触发 绑定实现负责人可派工');
  expect(page).toContain('依据 contribution-audit');
  expect(page).toContain('工具 implementer_takeover');
  expect(page).toContain('老板线下确认（不可执行）');
  const oldPage = await (await mk(legacy)(new Request('http://x/q/?taskId=t1', { headers: { cookie } }))).text();
  expect(oldPage).toContain('下一触发 未知');
  expect(oldPage).toContain('依据 未知');
  expect(oldPage).toContain('未知（旧记录未携带结构化动作）');
  expect(oldPage).not.toContain('implementer_takeover');
});

test('F2: the goal page renders root blocker, impact, dependency path, notice and submit SHA; facts-unavailable is unknown', async () => {
  const rootBase = { taskId: 't9', title: '根任务', phase: 'review', workflowState: 'review', summary: '无独立复核人选',
    feasible: false, waitingMinutes: 30, since: '2026-10-22T00:00:00Z', checkedAt: '2026-10-22T00:19:00Z',
    eligibleCount: 0, undispatchable: 2, others: 1, noticeKey: 't9:review:1:no_candidate' };
  const reasons = [{ code: 'no_candidate', text: '该岗位与仓库下没有任何编制或员工', candidates: [], owner: 'gm', recovery: '经理增补编制',
    nextTrigger: '新增编制或员工', basis: 'tick:staffing-pool', actions: [{ authority: 'gm', label: '经理用 def_ensure 增加编制', tool: 'def_ensure', executable: true }] }];
  const mk = (root: unknown) => createQaConsoleFetch({ home: '/nonexistent', company: async () => ({ core: {
    qaObservationRead: async (_a: any, input: any) => ({ meta: { scope, completeness: { dispatchComplete: true } },
      goal: { id: input.goalId, total: 5, states: { review: 1 }, dispatchComplete: true, undispatchable: 2, dispatchCheckedAt: '2026-10-22T00:19:00Z', root } }),
  } }) as any });
  const page = await (await mk({ ...rootBase, factsAvailable: true, impact: 3,
    dependencyPath: [{ taskId: 't9', title: '根任务' }, { taskId: 't10', title: '后续任务' }],
    people: { implementer: 'eng-1', authors: ['eng-1'], reviewers: ['qa-1'], submitter: 'eng-1', submitCommit: 'abcdef1234567' }, reasons })(
    new Request('http://x/q/?goal=1', { headers: { cookie } }))).text();
  expect(page).toContain('根阻点 · 根任务');
  expect(page).toContain('影响 3 项');
  expect(page).toContain('后续任务（t10）');
  expect(page).toContain('提交 SHA abcdef1234567');
  expect(page).toContain('notice t9:review:1:no_candidate');
  expect(page).toContain('工具 def_ensure');
  const unknownPage = await (await mk({ ...rootBase, factsAvailable: false, reasons })(
    new Request('http://x/q/?goal=1', { headers: { cookie } }))).text();
  expect(unknownPage).toContain('未知（事实不可读）');
  expect(unknownPage).not.toContain('影响 0 项');
});

test('F3: an empty waits list with roots present is a budget cut, not an empty goal; a real empty goal still says so', async () => {
  const waitsPage = async (waits: unknown) => (await createQaConsoleFetch({ home: '/nonexistent', company: async () => ({ core: {
    qaObservationRead: async (_a: any, input: any) => ({ meta: { scope, completeness: { dispatchComplete: true } },
      goal: { id: input.goalId, total: 5, states: { blocked: 3 }, dispatchComplete: true, undispatchable: 0,
        dispatchCheckedAt: '2026-10-22T00:19:00Z', waits } }),
  } }) as any })(new Request('http://x/q/?goal=1', { headers: { cookie } }))).text();
  const cut = await waitsPage({ source: 'workflow-graph', available: true, checkedAt: '2026-10-22T00:20:00Z',
    totalRoots: 3, shownRoots: 0, truncated: true, budgetLimited: true, roots: [] });
  expect(cut).toContain('本页字节预算未保留任何一条');
  expect(cut).toContain('为响应字节预算收缩');
  expect(cut).toContain('显示 0 / 3');
  expect(cut).not.toContain('当前目标没有已识别的工作流等待根');
  const empty = await waitsPage({ source: 'workflow-graph', available: true, checkedAt: '2026-10-22T00:20:00Z',
    totalRoots: 0, shownRoots: 0, truncated: false, roots: [] });
  expect(empty).toContain('当前目标没有已识别的工作流等待根');
  expect(empty).not.toContain('本页字节预算未保留任何一条');
});
