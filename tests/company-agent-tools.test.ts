// 本机 Paseo 员工的公司工具（plugin/server/company-tools.ts）：与云端公司 MCP 同名同参数。
// 两层验证：假 sidecar face 测绑定/校验/转发形状；真 SidecarPool（journal 托管生命周期模式）
// 测 submit/review/report_blocker 真的落 result.json 且能被 workResult 解析成正确动作。
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { companyAgentTools, type CompanySidecarFace, type LocalAgentToolResult } from '../plugin/server/company-tools.ts';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import { commDir } from '../src/comm.ts';
import { workResult } from '../src/runner/lifecycle.ts';
import type { ClaimResult, TaskView } from '../src/contracts.ts';
import type { EmployeeInst, SupervisedTask } from '../src/workforce.ts';

type Relay = { tool: string; args: Record<string, unknown>; agentId: string };
type Lease = { employee: string; taskId: string; phase: 'doing' | 'review'; leaseExpiresAt?: number };

const ctx = (agentId = 'agent-1') => ({ agent: { id: agentId, provider: 'codex', cwd: '/x' }, paseo: undefined, signal: new AbortController().signal });

/** 假 sidecar：agent-1 视为在岗员工，其他 agentId 一律 forbidden（与 callForAgent 相同形状）。 */
const fakeFace = (lease?: Lease) => {
  const calls: Relay[] = [];
  const face: CompanySidecarFace = {
    callForAgent: async (agentId, tool, args) => {
      if (agentId !== 'agent-1') return { ok: false, error: 'forbidden: 该会话不是在岗公司员工' };
      calls.push({ tool, args, agentId });
      return { ok: true, data: { recorded: true, tool } };
    },
    leaseForAgent: (agentId) => agentId === 'agent-1' ? lease : undefined,
    capabilityTools: () => ['ops_info', 'ops_login', 'media_tts', 'sync_lipsync'],
  };
  return { face, calls };
};

const toolDeps = (face: CompanySidecarFace, landscape?: (args: { host?: string; repo?: string }) => Promise<unknown>) => ({
  sidecar: async () => face,
  landscape: landscape ?? (async (args) => ({ landscape: true, args })),
});
const tool = (deps: ReturnType<typeof toolDeps>, name: string) =>
  companyAgentTools(deps).find(item => item.name === name)!;
const err = (res: LocalAgentToolResult) => (res.structuredContent as { error: { code: string; message: string } }).error;

describe('公司工具清单与身份', () => {
  test('恰好 7 个工具，名字与云端一致且都合法', () => {
    const tools = companyAgentTools(toolDeps(fakeFace().face));
    expect(tools.map(item => item.name).sort()).toEqual([
      'company_landscape', 'company_ops', 'task_block', 'task_context', 'task_current', 'task_review', 'task_submit',
    ]);
    for (const item of tools) expect(item.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(tools.some(item => item.name === 'company_job')).toBe(false); // 本机不提供：运维调用同步返回
  });

  test('未知 agentId → forbidden，不调用 dispatch', async () => {
    const { face, calls } = fakeFace({ employee: 'e1', taskId: 'task-9', phase: 'doing' });
    const res = await tool(toolDeps(face), 'task_context').execute({ taskId: 'task-9' }, ctx('stranger'));
    expect(err(res).code).toBe('forbidden');
    expect(calls).toHaveLength(0);
  });

  test('无租约与 taskId 不符 → forbidden', async () => {
    const { face } = fakeFace(undefined);
    const res = await tool(toolDeps(face), 'task_context').execute({ taskId: 'task-9' }, ctx());
    expect(err(res).code).toBe('forbidden');
    expect(err(res).message).toContain('没有在租任务');

    const other = fakeFace({ employee: 'e1', taskId: 'task-1', phase: 'doing' });
    const res2 = await tool(toolDeps(other.face), 'task_context').execute({ taskId: 'task:other-task' }, ctx());
    expect(err(res2).code).toBe('forbidden');
    expect(err(res2).message).toContain('不是你当前在租的任务');
    expect(other.calls).toHaveLength(0);
  });

  test('task_current 返回租约任务与阶段；无租约为空', async () => {
    const { face } = fakeFace({ employee: 'e1', taskId: 'task-7', phase: 'review', leaseExpiresAt: 999 });
    const res = await tool(toolDeps(face), 'task_current').execute({}, ctx());
    expect(res.structuredContent).toEqual({ tasks: [{ taskId: 'task-7', phase: 'review', leaseExpiresAt: 999 }] });
    const empty = await tool(toolDeps(fakeFace().face), 'task_current').execute({}, ctx());
    expect(empty.structuredContent).toEqual({ tasks: [] });
  });

  test('task_context 绑定后走 get_context（支持 task: 前缀）', async () => {
    const { face, calls } = fakeFace({ employee: 'e1', taskId: 'task-3', phase: 'doing' });
    const res = await tool(toolDeps(face), 'task_context').execute({ taskId: 'task:task-3' }, ctx());
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual([{ tool: 'get_context', args: {}, agentId: 'agent-1' }]);
  });

  test('company_landscape 转发参数；company_ops 只放行能力工具且按租约分发', async () => {
    const { face, calls } = fakeFace({ employee: 'e1', taskId: 'task-5', phase: 'doing' });
    const landscape = tool(toolDeps(face), 'company_landscape');
    const res = await landscape.execute({ host: 'vps-data' }, ctx());
    expect((res.structuredContent as { args: { host: string } }).args.host).toBe('vps-data');

    const ops = tool(toolDeps(face), 'company_ops');
    const bad = await ops.execute({ taskId: 'task-5', tool: 'task_submit' }, ctx());
    expect(err(bad).code).toBe('forbidden');
    expect(err(bad).message).toContain('不是运维能力工具');
    expect(calls).toHaveLength(0);

    const good = await ops.execute({ taskId: 'task-5', tool: 'ops_info', args: { alias: 'QA1' } }, ctx());
    expect(good.isError).toBeUndefined();
    expect(calls).toEqual([{ tool: 'ops_info', args: { alias: 'QA1' }, agentId: 'agent-1' }]);
  });
});

// ---- 真 SidecarPool（journal 模式）：result.json 落盘与 workResult 解析 ----

const taskView = (id: string, state = 'doing'): TaskView => ({
  id, title: `t-${id}`, context: '', state: state as TaskView['state'], executorRole: 'engineering', reviewerRole: 'qa',
  kind: 'task', version: 1, fence: 1, deliveryId: `d-${id}`,
});
const claimResult = (taskId: string, state = 'doing'): ClaimResult => ({
  task: taskView(taskId, state), deliveryId: `d-${taskId}`, fence: 7, leaseExpiresAt: new Date(Date.now() + 3600_000).toISOString(), history: [],
});
const inst = (id: string, agentId: string | undefined = 'agent-1'): EmployeeInst =>
  ({ id, role: 'engineering', credential: `tok-${id}`, ...(agentId ? { paseoAgentId: agentId } : {}) }) as EmployeeInst;
const task = (id: string): SupervisedTask => ({ id, title: `t-${id}`, state: 'ready', executorRole: 'engineering', row: {} }) as unknown as SupervisedTask;

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** journal 模式真池：员工 e1（Paseo agent-1）已领租 task-x；返回工具与读 result.json 的通道。 */
async function world(state: 'doing' | 'review' = 'doing') {
  const runDir = mkdtempSync(join(tmpdir(), 'sck-agent-tools-'));
  dirs.push(runDir);
  const core = { claim: async (_c: string, taskId: string) => claimResult(taskId, state) };
  const pool = new SidecarPool({ core: core as never, workforce: { rotate: async () => 'tok' } as never,
    runDir, managedLifecycle: true, heartbeatMs: 60_000, sweepMs: 10_000 });
  // env() 在 bindAgent 之前：带 paseoAgentId 的实例先开通道（无 agent 绑定时按新实例建），
  // 绑定 agent 后再用带 paseoAgentId 的同一实例领租（canReuse 此时成立）。
  pool.env(inst('e1', ''));
  pool.bindAgent('e1', 'agent-1');
  const claimed = await pool.claim(inst('e1'), task(`task-${state}`));
  expect(claimed).toBeDefined();
  const tools = companyAgentTools({ sidecar: async () => pool, landscape: async () => ({}) });
  const resultJson = () => {
    const path = join(commDir(runDir, 'e1'), 'result.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : undefined;
  };
  return { tools, pool, resultJson, taskId: `task-${state}` };
}
const run = (tools: ReturnType<typeof companyAgentTools>, name: string, input: Record<string, unknown>) =>
  tools.find(item => item.name === name)!.execute(input, ctx()) as Promise<LocalAgentToolResult>;

describe('journal 模式：写工具落 result.json 且被 workResult 解析', () => {
  test('task_submit：summary 落盘；带 pr 时末行 PR；sha 透传', async () => {
    const { tools, resultJson, taskId } = await world('doing');
    const sha = 'a'.repeat(40);
    const res = await run(tools, 'task_submit', { taskId, summary: '完成了公司工具适配的全部改动并跑过类型检查与测试', sha: sha.toUpperCase(), pr: 'https://github.com/acme/widget/pull/7' });
    expect(res.isError).toBeUndefined();
    const value = resultJson()!;
    expect(value.sha).toBe(sha); // 小写化后落盘
    expect(String(value.summary).split('\n').at(-1)).toBe('PR: https://github.com/acme/widget/pull/7');
    const parsed = workResult('终稿', 'doing', value);
    expect(parsed.action).toBe('submit');
    expect(parsed.evidence.sha).toBe(sha);
  });

  test('task_review：pass→accept、return→return；复核阶段 task_submit 被拒', async () => {
    const { tools, resultJson, taskId } = await world('review');
    const wrongPhase = await run(tools, 'task_submit', { taskId, summary: '复核任务上误用执行交卷工具，这里应当被拒绝的' });
    expect(err(wrongPhase).code).toBe('invalid');
    expect(err(wrongPhase).message).toContain('task_review');

    const tooShort = await run(tools, 'task_review', { taskId, verdict: 'pass', findings: '太短' });
    expect(err(tooShort).code).toBe('invalid');
    expect(err(tooShort).message).toContain('20..8000');
    const pass = await run(tools, 'task_review', { taskId, verdict: 'pass', findings: '逐条复核了全部验收标准，证据与结论都写在这里' });
    expect(pass.isError).toBeUndefined();
    expect(resultJson()).toMatchObject({ review: 'accept' });
    expect(workResult('终稿', 'review', resultJson()).action).toBe('accept');

    const back = await run(tools, 'task_review', { taskId, verdict: 'return', findings: '第三条验收标准缺少证据支撑，需要退回补齐材料' });
    expect(back.isError).toBeUndefined();
    expect(resultJson()).toMatchObject({ review: 'return' });
    expect(workResult('终稿', 'review', resultJson()).action).toBe('return');
  });

  test('task_block → outcome blocked，被 workResult 解析为 block', async () => {
    const { tools, resultJson, taskId } = await world('doing');
    const res = await run(tools, 'task_block', { taskId, reason: '供应商测试环境当前不可用，需要等恢复后继续' });
    expect(res.isError).toBeUndefined();
    expect(resultJson()).toMatchObject({ outcome: 'blocked' });
    expect(workResult('终稿', 'doing', resultJson()).action).toBe('block');
  });

  test('执行阶段 task_review、sha 非 40 位、文本过短 → invalid', async () => {
    const { tools, taskId, resultJson } = await world('doing');
    const review = await run(tools, 'task_review', { taskId, verdict: 'pass', findings: '执行任务上误用了复核工具，这里应当被拒绝的' });
    expect(err(review).code).toBe('invalid');
    expect(err(review).message).toContain('task_submit');

    for (const [name, input, contains] of [
      ['task_submit', { taskId, summary: 'x'.repeat(30), sha: 'abc123' }, '40 位'],
      ['task_submit', { taskId, summary: '太短' }, '20..8000'],
      ['task_block', { taskId, reason: '太短' }, '20..4000'],
      ['task_submit', { taskId, summary: 'x'.repeat(30), pr: 'https://example.com/not-a-pr' }, 'pr'],
    ] as const) {
      const res = await run(tools, name, input);
      expect(err(res).code).toBe('invalid');
      expect(err(res).message).toContain(contains);
    }
    expect(resultJson()).toBeUndefined(); // 校验失败一个 result.json 都不写
  });
});
