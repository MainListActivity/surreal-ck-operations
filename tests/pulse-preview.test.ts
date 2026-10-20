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

const full: Pulse = {
  at: '2026-10-15T04:00:00Z', paused: false,
  doing: [{ taskId: 't1', title: '在办任务', role: 'engineering', sinceMin: 42 }],
  ready: [{ taskId: 't2', title: '就绪任务', role: 'qa', waitingMin: 90, unclaimableReason: '无可用实例' }],
  stuck: [{ taskId: 't3', title: '卡住任务', reason: '依赖未满足' }],
  waiting: [{ taskId: 't4', kind: 'gate', title: '概要关口', hours: 19.2, downstream: 7 }],
  recentDone: [{ taskId: 't5', title: '已完成任务', at: '2026-10-15T03:00:00Z', actor: 'qa' }],
  last24h: { done: 3, returned: 1, rolledBack: 0, rejected: 0, retired: 2 },
  resources: ['grok 额度不足'],
  staffingAlerts: 1,
  churn: { created: 2, retired: 2, claimLost: 5 },
  goals: [{ title: '梦痕纪元宣传片', days: 4 }],
  dispatchBlocked: [{ taskId: 't2', title: '就绪任务', summary: '就绪任务：执行无法派工（会话占用中或异常）', phase: 'execute',
    feasible: true, since: '2026-10-15T03:30:00Z', waitingMinutes: 30,
    reasons: [{ code: 'session_busy', text: '会话占用中或异常', candidates: ['inst-1'], owner: 'gm', recovery: '等待在办任务完成', nextTrigger: '候选会话空闲' }] }],
};

test('normalizePulse: 完整响应原样通过', () => {
  const p = normalizePulse(full);
  expect(p.doing[0]!.title).toBe('在办任务');
  expect(p.waiting[0]!.hours).toBe(19.2);
  expect(p.dispatchBlocked[0]).toMatchObject({ taskId: 't2', phase: 'execute', feasible: true, waitingMinutes: 30 });
  expect(p.dispatchBlocked[0]!.reasons[0]!.code).toBe('session_busy');
  expect(p.staffingAlerts).toBe(1);
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
  'Section', 'Collapsible', 'View', 'Text', 'fmtAge', 'ROLE_LABEL',
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
  p.waiting.length + p.stuck.length + p.ready.filter(r => r.unclaimableReason).length + p.resources.length + p.staffingAlerts;
const renderPulse = (raw: unknown, q: { isLoading?: boolean; isError?: boolean; error?: Error } = {}) =>
  render(React, s, ctx, normalizePulse(raw), raw != null,
    { data: raw, isLoading: false, isError: false, error: undefined, ...q },
    attentionOf(normalizePulse(raw)), Section, Collapsible, View, Text, fmtAge, ROLE_LABEL);

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
