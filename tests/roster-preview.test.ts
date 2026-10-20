import { expect, mock, test } from 'bun:test';
import { BLOCK_TEXT, evaluateDispatch, type DispatchVerdict } from '../src/dispatcher/dispatch-blocked.ts';
import type { ContributionFacts } from '../src/contributors.ts';
import type { InstState, StaffingInput } from '../src/dispatcher/dispatcher.ts';
import type { SupervisedTask } from '../src/workforce.ts';
import type { Pulse, Roster } from '../plugin/shared/types.ts';
import { CANDIDATE_LIMIT, LIST_BYTE_BUDGET, LIST_ITEM_LIMIT } from '../src/dispatcher/dispatch-list.ts';

const defs: StaffingInput['defs'] = [{ id: 'd1', role: 'engineering', provider: 'codex', model: 'm1',
  enabled: true, maxInstances: 3, priority: 100, weight: 10, scored: 0, errorStreak: 0 }];
const insts: StaffingInput['insts'] = ['author', 'fresh', 'rework-submitter'].map(id => ({ id, role: 'engineering',
  def: 'd1', provider: 'codex', model: 'm1', paseoAgentId: id, cwd: '/ops' }));
const task = { id: 'review-task', title: '独立验收', state: 'review', reviewerRole: 'engineering',
  submittedBy: 'rework-submitter', repoPath: '/ops' } as SupervisedTask;
const readyTask = { id: 'ready-task', title: '就绪实现', state: 'ready', executorRole: 'engineering',
  reviewerRole: 'engineering', repoPath: '/ops' } as SupervisedTask;

// The tick's own session observation, one entry per instance. Tests replace it to model busy or unobserved sessions.
type Session = { agentId: string; status: string; state: InstState };
const sessionOf = (id: string, state: InstState): [string, Session] =>
  [id, { agentId: id, status: state === 'busy' ? 'running' : 'idle', state }];
const idleSessions = () => new Map(insts.map(i => sessionOf(i.id, 'idle')));
let sessions = idleSessions();
let taskRows: SupervisedTask[] = [task];
let verdicts: DispatchVerdict[] = [];
let historyFails = false;
let emptyHistory = false;
let historyCalls = 0;
const contributors = async (): Promise<ContributionFacts> => {
  historyCalls++;
  if (historyFails) throw new Error('synthetic read failure');
  const authors = emptyHistory ? [] : ['author', 'rework-submitter'];
  return { authors, reviewers: [], unknown: [], ambiguous: false, excluded: authors };
};
mock.module('../plugin/server/company.ts', () => ({ company: async () => ({
  opsRepo: '/ops', db: { db: { query: async () => [[]] } },
  owner: { briefData: async () => ({ stuck: [], waiting: [], resources: [], goals: [], staffingAlerts: 0,
    last24h: { done: 0, returned: 0, rolledBack: 0, rejected: 0, retired: 0 }, churn: { created: 0, retired: 0, claimLost: 0 } }) },
  workforce: {
    config: async () => ({ providerMax: { codex: 3 } }),
    defs: async () => defs, insts: async () => insts, tasks: async () => taskRows, contributors,
  },
  dispatcher: {
    sessionSnapshot: () => ({ at: Date.now(), sessions }),
    dispatchVerdicts: () => verdicts,
  },
}) }));
mock.module('../plugin/server/dispatch.ts', () => ({
  refreshModels: async () => ({}), refreshQuota: async () => [], readProviderQuotas: async () => [],
}));
const handlersPath = '../plugin/server/handlers.ts';
const rpcPath = '../plugin/shared/rpc.ts';
const { registerHandlers } = await import(handlersPath);
const { roster, pulse } = await import(rpcPath);
type Ctx = { paseo: { agents: { list: () => Promise<{ entries: { id: string; status: string }[] }> } } };
const handlers = new Map<unknown, (input: unknown, ctx: Ctx) => Promise<unknown>>();
registerHandlers({ handle: (rpc: unknown, handler: (input: unknown, ctx: Ctx) => Promise<unknown>) => handlers.set(rpc, handler) });
// Paseo answers "idle" for every instance. Roster and pulse must not read it for status; only the tick's snapshot counts.
const paseo: Ctx['paseo'] = { agents: { list: async () => ({ entries: insts.map(i => ({ id: i.id, status: 'idle' })) }) } };
const callRoster = async () => await handlers.get(roster)!({}, { paseo }) as Roster;
const callPulse = async () => await handlers.get(pulse)!({}, { paseo }) as Pulse;

// Exercise the registered RPC handler, its shared candidate calculation and its wire response.
test('roster RPC: task author recused, fresh eligible, public execute pool remains usable', async () => {
  historyFails = false;
  const response = await callRoster();
  expect(historyCalls).toBeGreaterThan(0);
  const p = response.reviewPools[0]!;
  expect(p).toMatchObject({ taskId: task.id, title: task.title, purpose: 'review', status: 'ready', home: '/ops' });
  expect(p.entries.find(e => e.ref === 'author')).toMatchObject({ eligible: false, share: 0, code: 'author_recusal', reason: BLOCK_TEXT.author_recusal });
  expect(p.entries.find(e => e.ref === 'fresh')?.eligible).toBe(true);
  expect(response.pools[0]!.entries.find(e => e.ref === 'author')?.eligible).toBe(true);
});

test('roster RPC: unknown history blocks all candidates at zero share; recovery recomputes', async () => {
  historyFails = true;
  const failed = await callRoster();
  expect(failed.reviewPools[0]?.status).toBe('history_unavailable');
  for (const entry of failed.reviewPools[0]!.entries) {
    expect(entry).toMatchObject({ eligible: false, share: 0, code: 'unknown', reason: BLOCK_TEXT.unknown });
  }
  expect(failed.pools[0]!.entries.find(e => e.ref === 'author')?.eligible).toBe(true);
  historyFails = false;
  const recovered = await callRoster();
  expect(recovered.reviewPools[0]?.status).toBe('ready');
  expect(recovered.reviewPools[0]!.entries.find(e => e.ref === 'fresh')?.eligible).toBe(true);
  expect(recovered.reviewPools[0]!.entries.find(e => e.ref === 'author')?.reason).toBe(BLOCK_TEXT.author_recusal);
});

// Compile and render the actual roster JSX section with wire responses, without a host UI runtime.
// The review-pool details live inside the collapsed 调度明细 section on the slimmed page.
const page = await Bun.file(new URL('../plugin/client/company.tsx', import.meta.url)).text();
const sectionStart = page.indexOf('<Collapsible title="调度明细');
const sectionEnd = page.indexOf('</Collapsible>', sectionStart);
if (sectionStart < 0 || sectionEnd < 0) throw new Error('Missing roster debug (调度明细) UI section');
const compiled = new Bun.Transpiler({ loader: 'tsx', tsconfig: {
  compilerOptions: { jsx: 'react', jsxFactory: 'React.createElement' },
} }).transformSync(`return (${page.slice(sectionStart, sectionEnd + '</Collapsible>'.length).trim()});`);
const render = new Function('r', 's', 'ctx', 'React', 'Section', 'View', 'Text', 'Collapsible', 'ROLE_LABEL', compiled);
const collectText = (node: unknown): string => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  if (typeof node === 'object' && 'children' in node) return collectText(node.children);
  return '';
};
const renderText = (response: Roster): string => collectText(render(response,
  { card: {}, text: {}, muted: {} }, {},
  { createElement: (_type: unknown, _props: unknown, ...children: unknown[]) => ({ children }) },
  'Section', 'View', 'Text', 'Collapsible', {}));

test('roster page JSX displays task, review recusal and unknown history at zero share', async () => {
  historyFails = false;
  const ready = renderText(await callRoster());
  expect(ready).toContain(task.title);
  expect(ready).toContain(task.id);
  expect(ready).toContain('review');
  expect(ready).toContain(BLOCK_TEXT.author_recusal);
  expect(ready).toContain('当前候选估算');
  historyFails = true;
  const unknown = renderText(await callRoster());
  expect(unknown).toContain('贡献者历史读取失败');
  expect(unknown).toContain('候选不可派，中选率 0%');
  historyFails = false;
});

test('roster RPC: a true empty audit still excludes submittedBy without blocking unrelated candidates', async () => {
  emptyHistory = true;
  try {
    const result = await callRoster();
    expect(result.reviewPools[0]?.status).toBe('ready');
    expect(result.reviewPools[0]!.entries.find(e => e.ref === 'rework-submitter'))
      .toMatchObject({ eligible: false, share: 0, reason: BLOCK_TEXT.author_recusal });
    expect(result.reviewPools[0]!.entries.find(e => e.ref === 'fresh')?.eligible).toBe(true);
  } finally { emptyHistory = false; }
});

test('roster RPC regression: session status is the tick snapshot, never a second Paseo read', async () => {
  sessions = new Map([sessionOf('author', 'idle'), sessionOf('fresh', 'busy'), sessionOf('rework-submitter', 'idle')]);
  try {
    const response = await callRoster(); // Paseo still answers idle for "fresh"
    expect(response.instances.find(i => i.id === 'fresh')?.agentStatus).toBe('running');
    expect(response.pools[0]!.entries.find(e => e.ref === 'fresh'))
      .toMatchObject({ eligible: false, code: 'session_busy', reason: BLOCK_TEXT.session_busy });
    expect(response.sessionsObservedAt).toBeDefined();
  } finally { sessions = idleSessions(); }
});

test('roster RPC: an instance the tick never observed is unknown, never reported as busy', async () => {
  sessions = new Map([sessionOf('author', 'idle'), sessionOf('rework-submitter', 'idle')]);
  try {
    const response = await callRoster();
    expect(response.instances.find(i => i.id === 'fresh')?.agentStatus).toBeUndefined();
    expect(response.pools[0]!.entries.find(e => e.ref === 'fresh'))
      .toMatchObject({ eligible: false, code: 'unknown', reason: BLOCK_TEXT.unknown });
  } finally { sessions = idleSessions(); }
});

test('roster RPC: dispatch-blocked rows are the tick verdicts, with the notice summary', async () => {
  const verdict = evaluateDispatch({ taskId: task.id, title: task.title, phase: 'review', role: 'engineering', home: '/ops',
    entries: [{ key: 'author', eligible: false, code: 'author_recusal' }, { key: 'rework-submitter', eligible: false, code: 'author_recusal' }],
    checkedAt: Date.now(), since: Date.now() - 6 * 60_000 });
  verdicts = [verdict];
  try {
    const response = await callRoster();
    expect(response.dispatchBlocked).toEqual([expect.objectContaining({ taskId: task.id, phase: 'review', summary: verdict.summary, feasible: false })]);
    expect(response.dispatchBlocked[0]!.reasons).toEqual([expect.objectContaining({ code: 'author_recusal', text: BLOCK_TEXT.author_recusal, owner: 'gm' })]);
    expect(response.dispatchBlocked[0]!.waitingMinutes).toBeGreaterThanOrEqual(5);
  } finally { verdicts = []; }
});

test('pulse RPC: a ready task carries the tick execute verdict reason only while it is blocked', async () => {
  taskRows = [readyTask];
  const verdict = evaluateDispatch({ taskId: readyTask.id, title: readyTask.title, phase: 'execute', role: 'engineering', home: '/ops',
    entries: [{ key: 'fresh', eligible: false, code: 'session_busy' }], checkedAt: Date.now() });
  try {
    verdicts = [verdict];
    const blocked = await callPulse();
    expect(blocked.ready.find(r => r.taskId === readyTask.id)?.unclaimableReason).toBe(BLOCK_TEXT.session_busy);
    expect(blocked.dispatchBlocked).toEqual([expect.objectContaining({ taskId: readyTask.id, phase: 'execute', summary: verdict.summary })]);
    verdicts = [];
    const dispatchable = await callPulse();
    expect(dispatchable.ready.find(r => r.taskId === readyTask.id)?.unclaimableReason).toBeUndefined();
  } finally { taskRows = [task]; verdicts = []; }
});

// SYS-DISP R3 (AC02/AC03): a large tick never makes the roster or pulse answer unbounded. Count and bytes stay inside the
// budgets, and each marker says how many verdicts the tick held.
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const blockedSample = (count: number, goalOf?: (i: number) => string): DispatchVerdict[] => {
  const at = Date.now();
  return Array.from({ length: count }, (_, i) => evaluateDispatch({ taskId: `big-${i}`, title: `大样本任务 ${i}`, phase: 'execute',
    role: 'engineering', home: '/ops', goalId: goalOf?.(i),
    entries: Array.from({ length: 60 }, (_, c) => ({ key: `big-${i}-c${c}`, eligible: false, code: 'session_busy' as const })),
    checkedAt: at, since: at - (i % 90) * 60_000 }));
};

test('roster RPC: a large tick is bounded by count and bytes, and the marker says what was left out', async () => {
  verdicts = blockedSample(1_500);
  try {
    const response = await callRoster();
    expect(response.dispatchBlocked.length).toBeLessThanOrEqual(LIST_ITEM_LIMIT);
    expect(bytesOf(response.dispatchBlocked)).toBeLessThanOrEqual(LIST_BYTE_BUDGET);
    expect(response.bounds.dispatchBlocked).toEqual({ total: 1_500, shown: response.dispatchBlocked.length, truncated: true });
    expect(response.dispatchBlocked[0]!.reasons[0]!.candidates).toHaveLength(CANDIDATE_LIMIT);
    expect(response.dispatchBlocked[0]!.reasons[0]!.candidatesOmitted).toBe(60 - CANDIDATE_LIMIT);
  } finally { verdicts = []; }
});

test('pulse RPC: a large tick bounds the dispatch-blocked list with its marker', async () => {
  verdicts = blockedSample(1_500);
  try {
    const response = await callPulse();
    expect(response.dispatchBlocked.length).toBeLessThanOrEqual(LIST_ITEM_LIMIT);
    expect(bytesOf(response.dispatchBlocked)).toBeLessThanOrEqual(LIST_BYTE_BUDGET);
    expect(response.bounds.dispatchBlocked).toEqual({ total: 1_500, shown: response.dispatchBlocked.length, truncated: true });
    expect(response.bounds.goalBlockers).toEqual({ total: 0, shown: 0, truncated: false });
  } finally { verdicts = []; }
});

test('pulse RPC: a large goal sample bounds the goal-root list and keeps the longest waits first', async () => {
  verdicts = blockedSample(300, i => `goal-${String(i).padStart(3, '0')}`);
  try {
    const response = await callPulse();
    expect(response.goalBlockers.length).toBeLessThanOrEqual(LIST_ITEM_LIMIT);
    expect(bytesOf(response.goalBlockers)).toBeLessThanOrEqual(LIST_BYTE_BUDGET);
    expect(response.bounds.goalBlockers).toEqual({ total: 300, shown: response.goalBlockers.length, truncated: true });
    expect(response.goalBlockers[0]!.goalId).toBe('goal-089');
  } finally { verdicts = []; }
});
