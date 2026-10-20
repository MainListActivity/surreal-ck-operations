import { expect, mock, test } from 'bun:test';
import { BLOCK_TEXT, evaluateDispatch, type DispatchVerdict } from '../src/dispatcher/dispatch-blocked.ts';
import type { ContributionFacts } from '../src/contributors.ts';
import { snapshotOf, type DispatchSnapshot, type InstState, type PassInputs, type StaffingInput } from '../src/dispatcher/dispatcher.ts';
import type { SupervisedTask } from '../src/workforce.ts';
import type { Pulse, PulseListName, Roster } from '../plugin/shared/types.ts';
import { CANDIDATE_LIMIT, LIST_BYTE_BUDGET, LIST_ITEM_LIMIT } from '../src/dispatcher/dispatch-list.ts';
import { PULSE_BUDGET_BYTES, PULSE_LIST_CAPS } from '../src/dispatcher/pulse-answer.ts';
import { ROSTER_BUDGET_BYTES, ROSTER_LIST_CAPS, rosterAnswer as boundRosterAnswer, type RosterListName } from '../src/dispatcher/roster-answer.ts';

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
// One dispatch pass as far as the owner-facing answers are concerned: the observed sessions and the snapshot of the inputs it reads.
let observed = { at: 0, sessions: new Map<string, Session>() };
let snapshot: DispatchSnapshot = { at: 0, verdicts: [], pools: [], reviewPools: [], ready: [] };
const tick = async () => {
  observed = { at: Date.now(), sessions: new Map(sessions) };
  const states = new Map<string, InstState>(insts.map(i => [i.id, sessions.get(i.id)?.state ?? 'unknown']));
  snapshot = await snapshotOf({ now: Math.floor(Date.now() / 1000), cfg: { providerMax: { codex: 3 } } as unknown as PassInputs['cfg'],
    defs, insts, states, health: new Map(), quotaBlocked: new Map(), tasks: taskRows, slots: new Map() },
    { opsRepo: '/ops', sidecar: true }, verdicts, { contributors, readySince: async () => new Map() });
};
// Mutable answers for the whole-answer size test: the pulse reads its doing rows, recent accepts and daily brief from these.
let briefOverride: Record<string, unknown> | undefined;
let doingOverride: Array<Record<string, unknown>> = [];
let recentOverride: Array<Record<string, unknown>> = [];
const queryRows = (sql: string): unknown[][] =>
  sql.includes("state = 'doing'") ? [doingOverride] : sql.includes("action IN ['accept'") ? [recentOverride] : [[]];
mock.module('../plugin/server/company.ts', () => ({ company: async () => ({
  opsRepo: '/ops', db: { db: { query: async (sql: string) => queryRows(sql) } },
  owner: { briefData: async () => briefOverride ?? ({ stuck: [], waiting: [], resources: [], goals: [],
    last24h: { done: 0, returned: 0, rolledBack: 0, rejected: 0, retired: 0 }, churn: { created: 0, retired: 0, claimLost: 0 } }) },
  workforce: {
    config: async () => ({ providerMax: { codex: 3 } }),
    defs: async () => defs, insts: async () => insts, tasks: async () => taskRows, contributors,
  },
  dispatcher: {
    sessionSnapshot: () => observed,
    dispatchVerdicts: () => verdicts,
    dispatchSnapshot: () => snapshot,
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
// The answers of a fresh pass: each call ticks first, so the test's inputs are the pass's inputs.
const callRoster = async () => { await tick(); return await handlers.get(roster)!({}, { paseo }) as Roster; };
const callPulse = async () => { await tick(); return await handlers.get(pulse)!({}, { paseo }) as Pulse; };
// The answers as they stand between passes: no tick, so only the snapshot of the last pass is read.
const answerNow = async <T>(rpc: unknown): Promise<T> => await handlers.get(rpc)!({}, { paseo }) as T;

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
    expect(response.dispatchBlocked.length).toBeLessThanOrEqual(ROSTER_LIST_CAPS.dispatchBlocked.items);
    expect(bytesOf(response.dispatchBlocked)).toBeLessThanOrEqual(ROSTER_LIST_CAPS.dispatchBlocked.bytes);
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

// SYS-DISP R4 (AC02): the roster and the pulse answer from the tick's snapshot. A database change after the pass reaches them only with
// the next pass, so the preview, the ready queue and the dispatch-blocked list always describe the same pass.
test('R4: after a tick, a database change does not reach the roster or the pulse until the next tick', async () => {
  historyFails = false;
  taskRows = [readyTask];
  verdicts = [evaluateDispatch({ taskId: readyTask.id, title: readyTask.title, phase: 'execute', role: 'engineering', home: '/ops',
    entries: [{ key: 'fresh', eligible: false, code: 'session_busy' }], checkedAt: Date.now() })];
  try {
    await tick();
    // Changed after the pass: the task is claimed, the history breaks, and the verdict no longer holds.
    taskRows = [];
    historyFails = true;
    verdicts = [];
    const pulseAnswer = await answerNow<Pulse>(pulse);
    expect(pulseAnswer.ready.find(r => r.taskId === readyTask.id)?.unclaimableReason).toBe(BLOCK_TEXT.session_busy);
    expect(pulseAnswer.dispatchBlocked.map(v => v.taskId)).toEqual([readyTask.id]);
    expect(pulseAnswer.dispatchAt).toBeDefined();
    const rosterAnswer = await answerNow<Roster>(roster);
    expect(rosterAnswer.dispatchAt).toBe(pulseAnswer.dispatchAt);
    expect(rosterAnswer.dispatchBlocked.map(v => v.taskId)).toEqual([readyTask.id]);
    expect(rosterAnswer.reviewPools[0]).toBeUndefined();
    // The next pass reads the database again and tells the new story.
    await Bun.sleep(2);
    await tick();
    const next = await answerNow<Roster>(roster);
    expect(next.dispatchBlocked).toEqual([]);
    expect(next.dispatchAt).not.toBe(rosterAnswer.dispatchAt);
  } finally { taskRows = [task]; historyFails = false; verdicts = []; }
});

test('R4: the roster pools and review previews are the pass snapshot, not a recomputation from live state', async () => {
  historyFails = false;
  await tick();
  const passed = await answerNow<Roster>(roster);
  historyFails = true;
  try {
    const sameAnswer = await answerNow<Roster>(roster);
    expect(sameAnswer.reviewPools[0]?.status).toBe(passed.reviewPools[0]?.status);
    expect(sameAnswer.reviewPools[0]?.status).toBe('ready');
    expect(sameAnswer.pools).toEqual(passed.pools);
  } finally { historyFails = false; }
});

// SYS-DISP R6 (AC06): the whole pulse answer stays inside the SYS01 whole-response budget however large the company is. Every list
// is filled past its cap here; each marker says how many items the list had and that the answer left some out.
test('pulse RPC: with every list full, the whole answer stays within the 48 KiB budget and each list says what it left out', async () => {
  const long = (prefix: string, i: number) => `${prefix} ${i} ${'长标题'.repeat(40)}`;
  taskRows = Array.from({ length: 300 }, (_, i) => ({ id: `ready-${i}`, title: long('就绪任务', i), state: 'ready',
    executorRole: 'engineering', reviewerRole: 'engineering', repoPath: '/ops' }) as SupervisedTask);
  verdicts = blockedSample(1_500, i => `goal-${String(i % 300).padStart(3, '0')}`);
  doingOverride = Array.from({ length: 300 }, (_, i) => ({ id: `doing-${i}`, title: long('在办任务', i), executor_role: 'engineering',
    current_employee: `emp-${i}`, goal_title: long('目标', i) }));
  recentOverride = Array.from({ length: 50 }, (_, i) => ({ task: `done-${i}`, title: long('已完成', i), at: '2026-10-20T03:00:00Z', actor: `emp-${i}` }));
  briefOverride = {
    stuck: Array.from({ length: 200 }, (_, i) => ({ taskId: `stuck-${i}`, title: long('卡滞', i), reason: '依赖都已完成，却仍是 blocked' })),
    waiting: Array.from({ length: 200 }, (_, i) => ({ taskId: `wait-${i}`, kind: 'gate', title: long('关口', i), hours: 30 + i, downstream: 2 })),
    resources: Array.from({ length: 100 }, (_, i) => `资源告警 ${i} ${'磁盘水位'.repeat(30)}`),
    goals: Array.from({ length: 100 }, (_, i) => ({ title: long('目标', i), days: i })),
    last24h: { done: 1, returned: 0, rolledBack: 0, rejected: 0, retired: 0 },
    churn: { created: 0, retired: 0, claimLost: 0 },
  };
  const totals: Record<PulseListName, number> = { dispatchBlocked: 1_500, goalBlockers: 300, ready: 300, doing: 300, stuck: 200,
    waiting: 200, recentDone: 50, goals: 100, resources: 100 };
  try {
    const response = await callPulse();
    for (const name of Object.keys(totals) as PulseListName[]) {
      const list = response[name];
      expect(response.bounds[name]).toEqual({ total: totals[name], shown: list.length, truncated: true });
      expect(list.length).toBeGreaterThan(0);
      expect(list.length).toBeLessThanOrEqual(PULSE_LIST_CAPS[name].items);
      expect(bytesOf(list)).toBeLessThanOrEqual(PULSE_LIST_CAPS[name].bytes);
    }
    expect(bytesOf(response)).toBeLessThanOrEqual(PULSE_BUDGET_BYTES);
  } finally { taskRows = [task]; verdicts = []; briefOverride = undefined; doingOverride = []; recentOverride = []; }
});

// SYS-DISP R6 (AC06, B1): the roster answer is bounded like the pulse. A backlog of 120 review tasks fills the review previews and,
// with one home per task, the staffing pools. Each list keeps its cap and says what it left out, and the whole answer fits the budget.
const reviewBacklog = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `review-${i}`, title: `独立验收 ${i} ${'长标题'.repeat(30)}`,
  state: 'review', reviewerRole: 'engineering', submittedBy: 'rework-submitter', repoPath: `/proj-${i}` }) as SupervisedTask);

test('roster RPC: a 120-task review backlog is bounded by count and bytes, and the whole answer stays within the 48 KiB budget', async () => {
  taskRows = reviewBacklog(120);
  verdicts = blockedSample(1_500);
  try {
    const response = await callRoster();
    expect(Object.keys(response.bounds).sort()).toEqual(Object.keys(ROSTER_LIST_CAPS).sort());
    expect(response.reviewPools[0]!.taskId).toBe('review-0');
    expect(response.reviewPools.length).toBeLessThanOrEqual(ROSTER_LIST_CAPS.reviewPools.items);
    expect(bytesOf(response.reviewPools)).toBeLessThanOrEqual(ROSTER_LIST_CAPS.reviewPools.bytes);
    expect(response.bounds.reviewPools).toEqual({ total: 120, shown: response.reviewPools.length, truncated: true });
    expect(bytesOf(response.pools)).toBeLessThanOrEqual(ROSTER_LIST_CAPS.pools.bytes);
    expect(response.bounds.pools.shown).toBe(response.pools.length);
    expect(response.bounds.pools.total).toBeGreaterThan(response.pools.length);
    expect(bytesOf(response.dispatchBlocked)).toBeLessThanOrEqual(ROSTER_LIST_CAPS.dispatchBlocked.bytes);
    expect(bytesOf(response)).toBeLessThanOrEqual(ROSTER_BUDGET_BYTES);
  } finally { taskRows = [task]; verdicts = []; }
});

test('roster page JSX states how many review previews the answer left out', async () => {
  taskRows = reviewBacklog(120);
  try {
    const response = await callRoster();
    // The text helper joins the children of each node with spaces, so the markers are compared without whitespace.
    const text = renderText(response).replace(/\s+/g, '');
    expect(text).toContain(`复核候选只列出${response.reviewPools.length}项，共120项。`);
    expect(text).toContain(`候选池只列出${response.pools.length}个，共${response.bounds.pools.total}个。`);
  } finally { taskRows = [task]; }
});

test('roster answer: with every list full, each list keeps its cap and the whole answer stays within the 48 KiB budget', () => {
  const lists = Object.fromEntries((Object.keys(ROSTER_LIST_CAPS) as RosterListName[]).map(name =>
    [name, Array.from({ length: 500 }, (_, i) => ({ key: `${name}-${i}`, text: '长标题'.repeat(40), n: i }))]));
  const answer = boundRosterAnswer({ paused: false, opsRepo: '/ops', sessionsObservedAt: new Date().toISOString(),
    dispatchAt: new Date().toISOString(), ...lists } as Parameters<typeof boundRosterAnswer>[0]);
  for (const name of Object.keys(ROSTER_LIST_CAPS) as RosterListName[]) {
    const list = answer[name];
    expect(list.length).toBeLessThanOrEqual(ROSTER_LIST_CAPS[name].items);
    expect(bytesOf(list)).toBeLessThanOrEqual(ROSTER_LIST_CAPS[name].bytes);
    expect(answer.bounds[name]).toEqual({ total: 500, shown: list.length, truncated: true });
  }
  expect(bytesOf(answer)).toBeLessThanOrEqual(ROSTER_BUDGET_BYTES);
});
