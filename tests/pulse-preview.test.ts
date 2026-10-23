import { expect, test } from 'bun:test';
import type { Pulse } from '../plugin/shared/types.ts';

// company.tsx 依赖宿主 UI 运行时，不能直接 import；把 normalizePulse 与其帮手从源文件切片编译出来跑真实现。
const page = await Bun.file(new URL('../plugin/client/company.tsx', import.meta.url)).text();
const helpersStart = page.indexOf('const arr = <T,>');
const normStart = page.indexOf('export function normalizePulse');
if (helpersStart < 0 || normStart < 0) throw new Error('normalizePulse helpers missing');
const normEnd = page.indexOf('\n}\n', normStart);
const helpersSrc = page.slice(helpersStart, normEnd + '\n}\n'.length).replace('export function', 'function');
const normalizePulse = new Function(`${new Bun.Transpiler({ loader: 'tsx' }).transformSync(helpersSrc)}\nreturn normalizePulse;`)() as (raw: unknown) => Pulse;
const labelsStart = page.indexOf('const WORKFLOW_LABEL');
const labelsEnd = page.indexOf('/** 动态页：一页回答');
if (labelsStart < 0 || labelsEnd < 0) throw new Error('WORKFLOW_LABEL or clockOf missing');
const { WORKFLOW_LABEL, WAIT_KIND_LABEL, WAIT_STATE_LABEL, clockOf } = new Function(`${new Bun.Transpiler({ loader: 'tsx' }).transformSync(page.slice(labelsStart, labelsEnd))}\nreturn { WORKFLOW_LABEL, WAIT_KIND_LABEL, WAIT_STATE_LABEL, clockOf };`)() as {
  WORKFLOW_LABEL: Record<string, string>; WAIT_KIND_LABEL: Record<string, string>; WAIT_STATE_LABEL: Record<string, string>; clockOf: (iso: string) => string;
};

const emptyBound = { total: 0, shown: 0, truncated: false };
const allBounds = (over: Partial<Pulse['bounds']> = {}): Pulse['bounds'] => ({
  dispatchBlocked: emptyBound, goalBlockers: emptyBound, workflowWaits: emptyBound, ready: emptyBound, doing: emptyBound, stuck: emptyBound,
  waiting: emptyBound, recentDone: emptyBound, goals: emptyBound, resources: emptyBound, ...over,
});

const full: Pulse = {
  at: '2026-10-15T04:00:00Z', dispatchAt: '2026-10-15T03:59:30Z', paused: false,
  doing: [{ taskId: 't1', title: '在办任务', role: 'engineering', sinceMin: 42 }],
  ready: [{ taskId: 't2', title: '就绪任务', role: 'qa', waitingMin: 90, unclaimableReason: '无可用实例' }],
  stuck: [{ taskId: 't3', title: '卡住任务', reason: '依赖未满足' }],
  waiting: [{ taskId: 't4', kind: 'gate', title: '概要关口', hours: 19.2, downstream: 7 }],
  recentDone: [{ taskId: 't5', title: '已完成任务', at: '2026-10-15T03:00:00Z', actor: 'qa' }],
  last24h: { done: 3, returned: 1, rolledBack: 0, rejected: 0, retired: 2 },
  resources: ['grok 额度不足'],
  churn: { created: 2, retired: 2, claimLost: 5 },
  goals: [{ title: '梦痕纪元宣传片', days: 4 }],
  goalBlockers: [],
  workflowWaits: [], workflowWaitSummary: { source: 'workflow-graph', available: false, totalRoots: 0, truncated: false, reason: '未加载' },
  dispatchBlocked: [{ taskId: 't2', title: '就绪任务', summary: '就绪任务：执行无法派工（会话占用中或异常）', phase: 'execute',
    workflowState: 'ready', checkedAt: '2026-10-15T03:59:30Z', eligibleCount: 0,
    feasible: true, since: '2026-10-15T03:30:00Z', waitingMinutes: 30,
    reasons: [{ code: 'session_busy', text: '会话占用中或异常', candidates: ['inst-1'], owner: 'gm', basis: 'tick-snapshot',
      recovery: '等待在办任务完成', nextTrigger: '候选会话空闲', actions: [{ authority: 'gm', label: '等待在办任务完成', executable: false }] }] }],
  bounds: allBounds({ dispatchBlocked: { total: 1, shown: 1, truncated: false } }),
};

test('normalizePulse: 完整响应原样通过', () => {
  const p = normalizePulse(full);
  expect(p.doing[0]!.title).toBe('在办任务');
  expect(p.waiting[0]!.hours).toBe(19.2);
  expect(p.dispatchBlocked[0]).toMatchObject({ taskId: 't2', phase: 'execute', feasible: true, waitingMinutes: 30 });
  expect(p.dispatchBlocked[0]!.reasons[0]!.code).toBe('session_busy');
  expect(p.dispatchAt).toBe('2026-10-15T03:59:30Z');
  expect(p.dispatchBlocked[0]).toMatchObject({ workflowState: 'ready', checkedAt: '2026-10-15T03:59:30Z', eligibleCount: 0 });
});

test('normalizePulse: truncation markers, omitted counts and reason actions survive the wire', () => {
  const p = normalizePulse({
    ...full,
    bounds: allBounds({ dispatchBlocked: { total: 1500, shown: 40, truncated: true }, goalBlockers: { total: 300, shown: 40, truncated: true } }),
    goalBlockers: [{ goalId: 'goal-1', taskId: 't9', title: '根任务', phase: 'execute', summary: '等待', feasible: true, waitingMinutes: 30,
      others: 0, impact: 2, dependencyPath: [], people: { authors: ['a'], reviewers: [], peopleOmitted: 788 },
      reasons: [{ code: 'session_busy', text: '忙', candidates: ['x'], candidatesOmitted: 54, owner: 'gm', basis: 'tick-snapshot', recovery: '等待', nextTrigger: '空闲',
        actions: [{ authority: 'owner', label: '老板充值', executable: false }] }] }],
  });
  expect(p.bounds).toEqual(allBounds({ dispatchBlocked: { total: 1500, shown: 40, truncated: true }, goalBlockers: { total: 300, shown: 40, truncated: true } }));
  expect(p.goalBlockers[0]!.people).toMatchObject({ authors: ['a'], peopleOmitted: 788 });
  expect(p.goalBlockers[0]!.reasons[0]).toMatchObject({ candidatesOmitted: 54, basis: 'tick-snapshot', owner: 'gm',
    actions: [{ authority: 'owner', label: '老板充值', executable: false }] });
  expect(p.dispatchBlocked[0]!.reasons[0]!.candidatesOmitted).toBeUndefined();
});

test('normalizePulse: a response without markers reads as complete, with nothing left out', () => {
  expect(normalizePulse({}).bounds).toEqual(allBounds());
});

test('normalizePulse: 畸形/缺字段输入收敛为安全视图模型，不再抛错', () => {
  for (const raw of [undefined, null, {}, { doing: [{ title: 'x' }] }, { waiting: [{ kind: 'gate' }] }, { last24h: 'bad', churn: null, goals: [{}] }, 'not-an-object']) {
    const p = normalizePulse(raw);
    expect(Array.isArray(p.doing)).toBe(true);
    expect(Array.isArray(p.waiting)).toBe(true);
    expect(typeof p.last24h.done).toBe('number');
    expect(typeof p.churn.created).toBe('number');
    for (const w of p.waiting) expect(typeof w.hours).toBe('number');
    for (const d of p.recentDone) expect(typeof d.at).toBe('string');
    for (const g of p.goals) expect(typeof g.title).toBe('string');
  }
  expect(normalizePulse({ waiting: [{}] }).waiting[0]!.kind).toBe('question');
});

// 编译并渲染 PulseTab 真实返回的 JSX（用归一化后的视图模型驱动），覆盖渲染期崩溃面。
const fnStart = page.indexOf('function PulseTab');
if (fnStart < 0) throw new Error('PulseTab missing');
const retStart = page.indexOf('return (', fnStart);
const retEnd = page.indexOf('\n  );', retStart);
if (retStart < 0 || retEnd < 0) throw new Error('PulseTab return missing');
const jsx = page.slice(retStart + 'return ('.length, retEnd).trim();
const compiled = new Bun.Transpiler({ loader: 'tsx', tsconfig: {
  compilerOptions: { jsx: 'react', jsxFactory: 'React.createElement' },
} }).transformSync(`return (${jsx});`);
const render = new Function(
  'React', 's', 'ctx', 'p', 'loaded', 'data', 'attention',
  'Section', 'Collapsible', 'View', 'Text', 'fmtAge', 'ROLE_LABEL', 'WORKFLOW_LABEL', 'WAIT_KIND_LABEL', 'WAIT_STATE_LABEL', 'clockOf',
  compiled,
);

type Node = { type: unknown; props: { children?: unknown; style?: unknown } };
const el = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => {
  const flat: unknown[] = [];
  const walk = (c: unknown) => Array.isArray(c) ? c.forEach(walk) : flat.push(c);
  children.forEach(walk);
  const pr = (props ?? {}) as Record<string, unknown>;
  return { type, props: { ...pr, children: flat.length <= 1 ? flat[0] : flat } };
};
const React = { createElement: el };
const View = 'View', Text = 'Text';
const Section = ({ title, children }: { title: string; children: unknown }) =>
  el('section', { title }, children);
const Collapsible = ({ title, children }: { title: string; children: unknown }) =>
  el('collapsible', { title }, children);
const s = new Proxy({}, { get: () => ({}) });
const ctx = { theme: { colors: {} }, compact: false } as never;
const fmtAge = (m?: number) => `${m ?? 0}分钟`;
const ROLE_LABEL: Record<string, string> = { engineering: '工程', qa: '测试' };

const collectText = (node: unknown): string => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  const n = node as Node;
  return collectText(n.props?.children);
};
const attentionOf = (p: Pulse) =>
  p.waiting.length + p.stuck.length + p.resources.length + p.bounds.dispatchBlocked.total;
const renderPulse = (raw: unknown, q: { isLoading?: boolean; isError?: boolean; error?: Error } = {}) =>
  render(React, s, ctx, normalizePulse(raw), raw != null,
    { data: raw, isLoading: false, isError: false, error: undefined, ...q },
    attentionOf(normalizePulse(raw)), Section, Collapsible, View, Text, fmtAge, ROLE_LABEL, WORKFLOW_LABEL, WAIT_KIND_LABEL, WAIT_STATE_LABEL, clockOf);

test('normalizePulse and owner view preserve workflow waits, provenance, impact path and independent time', () => {
  const raw = { ...full, workflowWaitSummary: { source: 'workflow-graph', available: true, checkedAt: '2026-10-15T03:58:00Z', totalRoots: 2, truncated: true },
    workflowWaits: [{ goalId: 'goal-1', taskId: 'root', title: '活租约复核根', workflowState: 'review', kind: 'active_lease', basis: 'task.current_employee + task.lease_expires_at',
      waitingForRole: 'qa', nextTrigger: '租约到期后重新判定', goalRootCount: 2, impact: 2,
      dependencyPath: [{ taskId: 'root', title: '活租约复核根' }, { taskId: 'leaf', title: '下游任务' }],
      people: { implementer: 'eng-1', authors: ['eng-1'], reviewers: ['qa-1'], submitter: 'eng-1', submitCommit: 'abcdef1234567' },
      peopleSource: 'contributor-audit', submitterSource: 'submit-audit', submitCommitSource: 'submit-audit-evidence',
      peopleCheckedAt: '2026-10-15T03:57:00Z', submitCheckedAt: '2026-10-15T03:56:00Z' }] };
  const p = normalizePulse(raw);
  expect(p.workflowWaits[0]).toMatchObject({ taskId: 'root', kind: 'active_lease', workflowState: 'review', impact: 2,
    peopleSource: 'contributor-audit', submitCommitSource: 'submit-audit-evidence', peopleCheckedAt: '2026-10-15T03:57:00Z' });
  expect(p.workflowWaitSummary).toMatchObject({ available: true, totalRoots: 2, truncated: true, checkedAt: '2026-10-15T03:58:00Z' });
  const text = collectText(renderPulse(raw));
  expect(text).toContain('活租约等待');
  expect(text).toContain('下游任务');
  expect(text).toContain('影响 2 项');
  expect(text).toContain('submit-audit-evidence');
  expect(text).toContain(`人物来源采集于 ${clockOf('2026-10-15T03:57:00Z')}`);
  expect(text).toContain(`提交审计采集于 ${clockOf('2026-10-15T03:56:00Z')}`);
  expect(text).toContain('可能未纳入最近 dispatcher pass');
  expect(text).toContain('列表已截断');
});

test('动态页渲染：等待根被字节份额清空时不再说“没有等待根”，真实空目标仍说', () => {
  const cut = { ...full, workflowWaitSummary: { source: 'workflow-graph', available: true, checkedAt: '2026-10-15T03:58:00Z', totalRoots: 3, truncated: true },
    workflowWaits: [], bounds: allBounds({ workflowWaits: { total: 3, shown: 0, truncated: true } }) };
  const text = collectText(renderPulse(cut));
  expect(text).toContain('均未纳入本页字节预算');
  expect(text).toContain('显示 0 / 3');
  expect(text).toContain('单项超出本页字节份额');
  expect(text).not.toContain('当前没有已识别的目标等待根');
  const empty = { ...full, workflowWaitSummary: { source: 'workflow-graph', available: true, checkedAt: '2026-10-15T03:58:00Z', totalRoots: 0, truncated: false },
    workflowWaits: [], bounds: allBounds() };
  const emptyText = collectText(renderPulse(empty));
  expect(emptyText).toContain('当前没有已识别的目标等待根');
  expect(emptyText).not.toContain('均未纳入本页字节预算');
});

test('动态页渲染：完整数据呈现全部区块', () => {
  const text = collectText(renderPulse(full));
  expect(text).toContain('派工运行中');
  expect(text).toContain('在办任务');
  expect(text).toContain('概要关口');
  expect(text).toContain('无人可派：无可用实例');
  expect(text).toContain('grok 额度不足');
  expect(text).toContain('梦痕纪元宣传片');
});

test('动态页渲染：畸形/部分数据不抛错，仍给出可见兜底', () => {
  for (const raw of [{ doing: [{ title: '部分任务' }] }, { waiting: [{ kind: 'gate' }] }, {}]) {
    const text = collectText(renderPulse(raw));
    expect(text).toContain('派工运行中');
    expect(text).toContain('没有排队等认领的任务。');
    expect(text).toContain('订阅与编制都正常。');
  }
  expect(collectText(renderPulse({ doing: [{ title: '部分任务' }] }))).toContain('部分任务');
});

test('动态页渲染：加载中与失败态可见', () => {
  expect(collectText(renderPulse(undefined, { isLoading: true }))).toContain('加载中…');
  expect(collectText(renderPulse(undefined, { isError: true, error: new Error('rpc timeout') }))).toContain('加载失败');
});

test('normalizePulse: goal roots carry their own counts and conclusion time; an unknown workflow state reads as ready', () => {
  const p = normalizePulse({
    ...full,
    goalBlockers: [{ goalId: 'goal-1', taskId: 't9', title: '根任务', phase: 'review', workflowState: 'review', summary: '等待复核',
      feasible: false, waitingMinutes: 12, others: 2, undispatchable: 3, impact: 5, eligibleCount: 0, checkedAt: '2026-10-15T03:59:30Z',
      dependencyPath: [], people: {}, reasons: [] }],
    dispatchBlocked: [{ taskId: 't8', title: '未知状态', phase: 'execute', workflowState: 'weird', summary: 's', feasible: true,
      waitingMinutes: 1, eligibleCount: 0, checkedAt: '2026-10-15T03:59:30Z', reasons: [] }],
  });
  expect(p.goalBlockers[0]).toMatchObject({ workflowState: 'review', undispatchable: 3, impact: 5, eligibleCount: 0, checkedAt: '2026-10-15T03:59:30Z' });
  expect(p.dispatchBlocked[0]).toMatchObject({ workflowState: 'ready' });
});

test('动态页渲染：无法派工逐条写出工作流与派工状态、结论时点，且只计一次', () => {
  const text = collectText(renderPulse(full));
  expect(text).toContain('无法派工');
  expect(text).toContain(`工作流：${WORKFLOW_LABEL.ready}`);
  expect(text).toContain('派工：无法派工');
  expect(text).toContain(`结论检查于 ${clockOf('2026-10-15T03:59:30Z')}`);
  // waiting 1 + stuck 1 + resources 1 + dispatch 1 = 4: the ready queue's unclaimable reason is not counted again.
  expect(text).toContain('需要关注 4 项');
});
