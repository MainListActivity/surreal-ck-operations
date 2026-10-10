import { expect, mock, test } from 'bun:test';
import type { StaffingInput } from '../src/dispatcher/dispatcher.ts';
import type { SupervisedTask, Workforce } from '../src/workforce.ts';
import type { Roster } from '../plugin/shared/types.ts';

const defs: StaffingInput['defs'] = [{ id: 'd1', role: 'engineering', provider: 'codex', model: 'm1',
  enabled: true, maxInstances: 3, priority: 100, weight: 10, scored: 0, errorStreak: 0 }];
const insts: StaffingInput['insts'] = ['author', 'fresh', 'rework-submitter'].map(id => ({ id, role: 'engineering',
  def: 'd1', provider: 'codex', model: 'm1', paseoAgentId: id, cwd: '/ops' }));
const task = { id: 'review-task', title: '独立验收', state: 'review', reviewerRole: 'engineering',
  submittedBy: 'rework-submitter', repoPath: '/ops' } as SupervisedTask;
let historyFails = false;
let emptyHistory = false;
let historyCalls = 0;
const evalState: Workforce['evalState'] = async () => {
  historyCalls++;
  if (historyFails) throw new Error('synthetic read failure');
  return { taskId: task.id, title: task.title, context: 'synthetic', state: 'review', executorRole: 'engineering', reviewerRole: 'engineering', timeline: [], participants: emptyHistory ? [] : ['author', 'rework-submitter'], metrics: {
    author: { claims: 1, submits: 1, checkpoints: 0, reviews: 0, returnsReceived: 0, revocations: 0 }, 'rework-submitter': { claims: 0, submits: 1, checkpoints: 0, reviews: 0, returnsReceived: 0, revocations: 0 },
  } }; 
};
mock.module('../plugin/server/company.ts', () => ({ company: async () => ({
  opsRepo: '/ops', db: { db: { query: async () => [[]] } }, workforce: {
    config: async () => ({ providerMax: { codex: 3 } }),
    defs: async () => defs, insts: async () => insts, tasks: async () => [task], evalState,
  },
}) }));
mock.module('../plugin/server/dispatch.ts', () => ({
  refreshModels: async () => ({}), refreshQuota: async () => [], readProviderQuotas: async () => [],
}));
const handlersPath = '../plugin/server/handlers.ts';
const rpcPath = '../plugin/shared/rpc.ts';
const { registerHandlers } = await import(handlersPath);
const { roster } = await import(rpcPath);
type Handler = (input: unknown, ctx: { paseo: { agents: { list: () => Promise<{ entries: { id: string; status: string }[] }> } } }) => Promise<Roster>;
const handlers = new Map<unknown, Handler>();
registerHandlers({ handle: (rpc: unknown, handler: Handler) => handlers.set(rpc, handler) });
const callRoster = () => handlers.get(roster)!({}, { paseo: { agents: { list: async () => ({
  entries: insts.map(i => ({ id: i.id, status: 'idle' })),
}) } } });

// Exercise the registered RPC handler, its shared candidate calculation and its wire response.
test('roster RPC: task author recused, fresh eligible, public execute pool remains usable', async () => {
  historyFails = false;
  const response = await callRoster();
  expect(historyCalls).toBeGreaterThan(0);
  const p = response.reviewPools[0]!;
  expect(p).toMatchObject({ taskId: task.id, title: task.title, purpose: 'review', status: 'ready', home: '/ops' });
  expect(p.entries.find(e => e.ref === 'author')).toMatchObject({ eligible: false, share: 0, reason: '提交过本任务，验收回避' });
  expect(p.entries.find(e => e.ref === 'fresh')?.eligible).toBe(true);
  expect(response.pools[0]!.entries.find(e => e.ref === 'author')?.eligible).toBe(true);
});

test('roster RPC: unknown history blocks all candidates at zero share; recovery recomputes', async () => {
  historyFails = true;
  const failed = await callRoster();
  expect(failed.reviewPools[0]?.status).toBe('history_unavailable');
  for (const entry of failed.reviewPools[0]!.entries) {
    expect(entry).toMatchObject({ eligible: false, share: 0, reason: '贡献者历史读取失败，等待安全候选' });
  }
  expect(failed.pools[0]!.entries.find(e => e.ref === 'author')?.eligible).toBe(true);
  historyFails = false;
  const recovered = await callRoster();
  expect(recovered.reviewPools[0]?.status).toBe('ready');
  expect(recovered.reviewPools[0]!.entries.find(e => e.ref === 'fresh')?.eligible).toBe(true);
  expect(recovered.reviewPools[0]!.entries.find(e => e.ref === 'author')?.reason).toBe('提交过本任务，验收回避');
});

// Compile and render the actual roster JSX section with wire responses, without a host UI runtime.
const page = await Bun.file(new URL('../plugin/client/company.tsx', import.meta.url)).text();
const sectionStart = page.indexOf('<Section title="待验收任务候选预览"');
const sectionEnd = page.indexOf('<Section title="员工编制"', sectionStart);
if (sectionStart < 0 || sectionEnd < 0) throw new Error('Missing task-scoped roster UI section');
const compiled = new Bun.Transpiler({ loader: 'tsx', tsconfig: {
  compilerOptions: { jsx: 'react', jsxFactory: 'React.createElement' },
} }).transformSync(`return (${page.slice(sectionStart, sectionEnd).trim()});`);
const render = new Function('r', 's', 'ctx', 'React', 'Section', 'View', 'Text', compiled);
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
  'Section', 'View', 'Text'));

test('roster page JSX displays task, review recusal and unknown history at zero share', async () => {
  historyFails = false;
  const ready = renderText(await callRoster());
  expect(ready).toContain(task.title);
  expect(ready).toContain(task.id);
  expect(ready).toContain('review');
  expect(ready).toContain('提交过本任务，验收回避');
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
      .toMatchObject({ eligible: false, share: 0, reason: '提交者回避' });
    expect(result.reviewPools[0]!.entries.find(e => e.ref === 'fresh')?.eligible).toBe(true);
  } finally { emptyHistory = false; }
});
