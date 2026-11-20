// 本机公司工具：逻辑唯一权威是 src/runner/company-tools.ts 的 runCompanyTool；
// 传输有两条——Paseo 插件薄壳（plugin/server/company-tools.ts → callForAgent 'company_tool'）
// 与 `sck mcp`（comm 目录 → sidecar dispatch 'company_tool'）。
// 三层验证：假 face 测 runCompanyTool 的绑定/校验/转发形状；真 SidecarPool（journal 托管
// 生命周期模式）测经 'company_tool' 的 submit/review/report_blocker 真落 result.json 且能被
// workResult 解析；插件薄壳只测清单、转发与错误形状。
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { companyAgentTools, type CompanySidecarFace, type LocalAgentToolResult } from '../plugin/server/company-tools.ts';
import { runCompanyTool, COMPANY_TOOL_SPECS, type CompanyToolFace } from '../src/runner/company-tools.ts';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import { commDir } from '../src/comm.ts';
import { workResult } from '../src/runner/lifecycle.ts';
import type { ClaimResult, TaskView } from '../src/contracts.ts';
import type { EmployeeInst, SupervisedTask } from '../src/workforce.ts';

type Relay = { tool: string; args: Record<string, unknown> };
type Lease = { taskId: string; phase: 'doing' | 'review'; leaseExpiresAt?: number };

const ctx = (agentId = 'agent-1') => ({ agent: { id: agentId, provider: 'codex', cwd: '/x' }, paseo: undefined, signal: new AbortController().signal });

// ---- runCompanyTool（假 face）：绑定、校验、内层转发 ----

/** 假 face：记录内层调用；landscape 可省略（模拟未注入）。 */
const fakeFace = (lease?: Lease, landscape?: CompanyToolFace['landscape']) => {
  const calls: Relay[] = [];
  const face: CompanyToolFace = {
    lease: () => lease,
    call: async (tool, args) => { calls.push({ tool, args }); return { ok: true, data: { recorded: true, tool } }; },
    capabilityTools: () => ['ops_info', 'ops_login', 'media_tts', 'sync_lipsync'],
    ...(landscape ? { landscape } : {}),
  };
  return { face, calls };
};
const runTool = (face: CompanyToolFace, name: string, args: unknown) => runCompanyTool(name, args, face);
const errOf = (res: Awaited<ReturnType<typeof runCompanyTool>>) => (res as { ok: false; code: string; message: string });
const valOf = (res: Awaited<ReturnType<typeof runCompanyTool>>): unknown => { expect(res.ok).toBe(true); return (res as { ok: true; value: unknown }).value; };

describe('runCompanyTool：清单、绑定与校验', () => {
  test('工具清单恰好 7 个，名字与云端一致且都合法', () => {
    expect(COMPANY_TOOL_SPECS.map(item => item.name).sort()).toEqual([
      'company_landscape', 'company_ops', 'task_block', 'task_context', 'task_current', 'task_review', 'task_submit',
    ]);
    for (const item of COMPANY_TOOL_SPECS) expect(item.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(COMPANY_TOOL_SPECS.some(item => item.name === 'company_job')).toBe(false); // 本机不提供：运维调用同步返回
  });

  test('未知工具名 → invalid', async () => {
    const res = errOf(await runTool(fakeFace().face, 'company_job', {}));
    expect(res.code).toBe('invalid');
    expect(res.message).toContain('未知公司工具');
    const rec = errOf(await runTool(fakeFace().face, 'company_tool', { name: 'task_current' }));
    expect(rec.code).toBe('invalid'); // company_tool 不是公司工具名，递归入口在 sidecar 另有拦截
  });

  test('无租约与 taskId 不符 → forbidden', async () => {
    const res = errOf(await runTool(fakeFace(undefined).face, 'task_context', { taskId: 'task-9' }));
    expect(res.code).toBe('forbidden');
    expect(res.message).toContain('没有在租任务');

    const other = fakeFace({ taskId: 'task-1', phase: 'doing' });
    const res2 = errOf(await runTool(other.face, 'task_context', { taskId: 'task:other-task' }));
    expect(res2.code).toBe('forbidden');
    expect(res2.message).toContain('不是你当前在租的任务');
    expect(other.calls).toHaveLength(0);
  });

  test('task_current 返回租约任务与阶段；无租约为空', async () => {
    const { face } = fakeFace({ taskId: 'task-7', phase: 'review', leaseExpiresAt: 999 });
    expect(valOf(await runTool(face, 'task_current', {}))).toEqual(
      { tasks: [{ taskId: 'task-7', phase: 'review', leaseExpiresAt: 999 }] });
    expect(valOf(await runTool(fakeFace().face, 'task_current', {}))).toEqual({ tasks: [] });
  });

  test('task_context 绑定后走 get_context（支持 task: 前缀）', async () => {
    const { face, calls } = fakeFace({ taskId: 'task-3', phase: 'doing' });
    const res = await runTool(face, 'task_context', { taskId: 'task:task-3' });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ tool: 'get_context', args: {} }]);
  });

  test('company_landscape 转发参数；未注入 landscape → not_configured', async () => {
    const { face } = fakeFace(undefined, async (args) => ({ landscape: true, args }));
    const res = await runTool(face, 'company_landscape', { host: 'vps-data' });
    expect((valOf(res) as { args: { host: string } }).args.host).toBe('vps-data');

    const none = errOf(await runTool(fakeFace().face, 'company_landscape', {}));
    expect(none.code).toBe('not_configured');
  });

  test('company_ops 只放行能力工具且按租约分发（taskId 不进内层调用）', async () => {
    const { face, calls } = fakeFace({ taskId: 'task-5', phase: 'doing' });
    const bad = errOf(await runTool(face, 'company_ops', { taskId: 'task-5', tool: 'task_submit' }));
    expect(bad.code).toBe('forbidden');
    expect(bad.message).toContain('不是运维能力工具');
    expect(calls).toHaveLength(0);

    const good = await runTool(face, 'company_ops', { taskId: 'task-5', tool: 'ops_info', args: { alias: 'QA1' } });
    expect(good.ok).toBe(true);
    expect(calls).toEqual([{ tool: 'ops_info', args: { alias: 'QA1' } }]);
  });

  test('task_submit：phase 校验、sha 40 位小写化、PR 追加', async () => {
    const review = errOf(await runTool(fakeFace({ taskId: 't', phase: 'review' }).face, 'task_submit',
      { taskId: 't', summary: '复核任务上误用执行交卷工具，这里应当被拒绝的' }));
    expect(review.code).toBe('invalid');
    expect(review.message).toContain('task_review');

    const { face, calls } = fakeFace({ taskId: 't', phase: 'doing' });
    const sha = 'A'.repeat(40);
    const res = await runTool(face, 'task_submit', { taskId: 't', summary: '完成了公司工具适配的全部改动并跑过类型检查与测试',
      sha, pr: 'https://github.com/acme/widget/pull/7' });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ tool: 'submit', args: {
      text: '完成了公司工具适配的全部改动并跑过类型检查与测试\nPR: https://github.com/acme/widget/pull/7', sha: 'a'.repeat(40) } }]);
  });

  test('task_review：pass→accept、return→return；执行阶段被拒', async () => {
    const wrong = errOf(await runTool(fakeFace({ taskId: 't', phase: 'doing' }).face, 'task_review',
      { taskId: 't', verdict: 'pass', findings: '执行任务上误用了复核工具，这里应当被拒绝的' }));
    expect(wrong.code).toBe('invalid');
    expect(wrong.message).toContain('task_submit');

    const { face, calls } = fakeFace({ taskId: 't', phase: 'review' });
    await runTool(face, 'task_review', { taskId: 't', verdict: 'pass', findings: '逐条复核了全部验收标准，证据与结论都写在这里' });
    await runTool(face, 'task_review', { taskId: 't', verdict: 'return', findings: '第三条验收标准缺少证据支撑，需要退回补齐材料' });
    expect(calls).toEqual([
      { tool: 'review', args: { decision: 'accept', text: '逐条复核了全部验收标准，证据与结论都写在这里' } },
      { tool: 'review', args: { decision: 'return', text: '第三条验收标准缺少证据支撑，需要退回补齐材料' } },
    ]);
  });

  test('文本长度与 sha/pr 校验 → invalid', async () => {
    const { face, calls } = fakeFace({ taskId: 't', phase: 'doing' });
    for (const [name, input, contains] of [
      ['task_submit', { taskId: 't', summary: 'x'.repeat(30), sha: 'abc123' }, '40 位'],
      ['task_submit', { taskId: 't', summary: '太短' }, '20..8000'],
      ['task_block', { taskId: 't', reason: '太短' }, '20..4000'],
      ['task_submit', { taskId: 't', summary: 'x'.repeat(30), pr: 'https://example.com/not-a-pr' }, 'pr'],
    ] as const) {
      const res = errOf(await runTool(face, name, input));
      expect(res.code).toBe('invalid');
      expect(res.message).toContain(contains);
    }
    const reviewShort = errOf(await runTool(fakeFace({ taskId: 't', phase: 'review' }).face, 'task_review',
      { taskId: 't', verdict: 'pass', findings: '太短' }));
    expect(reviewShort.code).toBe('invalid');
    expect(reviewShort.message).toContain('20..8000');
    expect(calls).toHaveLength(0);
  });
});

// ---- 插件薄壳：清单、agentId 转发、错误形状 ----

/** 假 sidecar：agent-1 视为在岗员工，其他 agentId 一律 forbidden（与 callForAgent 相同形状）。 */
const fakeSidecar = () => {
  const calls: Array<{ agentId: string; tool: string; args: Record<string, unknown> }> = [];
  const face: CompanySidecarFace = {
    callForAgent: async (agentId, tool, args) => {
      calls.push({ agentId, tool, args });
      if (agentId !== 'agent-1') return { ok: false, error: 'forbidden: 该会话不是在岗公司员工' };
      return { ok: true, data: { echoed: args } };
    },
  };
  return { face, calls };
};
const errRes = (res: LocalAgentToolResult) => (res.structuredContent as { error: { code: string; message: string } }).error;

describe('插件薄壳：注入 Paseo 会话的 AgentTool', () => {
  test('清单恰好 7 个，名字合法；未知 agentId → forbidden', async () => {
    const tools = companyAgentTools({ sidecar: async () => fakeSidecar().face });
    expect(tools.map(item => item.name).sort()).toEqual(COMPANY_TOOL_SPECS.map(item => item.name).sort());
    for (const item of tools) expect(item.name).toMatch(/^[a-z][a-z0-9_]*$/);

    const { face } = fakeSidecar();
    const res = await companyAgentTools({ sidecar: async () => face }).find(t => t.name === 'task_context')!
      .execute({ taskId: 'task-9' }, ctx('stranger')) as LocalAgentToolResult;
    expect(errRes(res).code).toBe('forbidden');
  });

  test('execute 统一经 company_tool 转发并映射成功/失败形状', async () => {
    const { face, calls } = fakeSidecar();
    const tools = companyAgentTools({ sidecar: async () => face });
    const res = await tools.find(t => t.name === 'task_context')!.execute({ taskId: 'task-9' }, ctx()) as LocalAgentToolResult;
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ echoed: { name: 'task_context', args: { taskId: 'task-9' } } });
    expect(calls).toEqual([{ agentId: 'agent-1', tool: 'company_tool', args: { name: 'task_context', args: { taskId: 'task-9' } } }]);

    const bad: CompanySidecarFace = { callForAgent: async () => ({ ok: false, error: 'invalid: sha 需要 40 位' }) };
    const fail = await companyAgentTools({ sidecar: async () => bad }).find(t => t.name === 'task_submit')!
      .execute({ taskId: 't', summary: 'x'.repeat(30), sha: 'abc' }, ctx()) as LocalAgentToolResult;
    expect(fail.isError).toBe(true);
    expect(errRes(fail)).toEqual({ code: 'invalid', message: 'sha 需要 40 位' });
  });
});

// ---- 真 SidecarPool（journal 模式）：'company_tool' 端到端落 result.json ----

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

/** journal 模式真池：员工 e1（Paseo agent-1）已领租 task-x；返回调用通道与读 result.json 的工具。 */
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
  const call = (name: string, args: Record<string, unknown> = {}) =>
    pool.callForAgent('agent-1', 'company_tool', { name, args });
  const resultJson = () => {
    const path = join(commDir(runDir, 'e1'), 'result.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : undefined;
  };
  return { call, pool, resultJson, taskId: `task-${state}` };
}

describe('真池 company_tool：写工具落 result.json 且被 workResult 解析', () => {
  test('task_submit：summary 落盘；带 pr 时末行 PR；sha 透传', async () => {
    const { call, resultJson, taskId } = await world('doing');
    const sha = 'a'.repeat(40);
    const res = await call('task_submit', { taskId, summary: '完成了公司工具适配的全部改动并跑过类型检查与测试',
      sha: sha.toUpperCase(), pr: 'https://github.com/acme/widget/pull/7' });
    expect(res.ok).toBe(true);
    const value = resultJson()!;
    expect(value.sha).toBe(sha); // 小写化后落盘
    expect(String(value.summary).split('\n').at(-1)).toBe('PR: https://github.com/acme/widget/pull/7');
    const parsed = workResult('终稿', 'doing', value);
    expect(parsed.action).toBe('submit');
    expect(parsed.evidence.sha).toBe(sha);
  });

  test('task_review：pass→accept、return→return；复核阶段 task_submit 被拒', async () => {
    const { call, resultJson, taskId } = await world('review');
    const wrongPhase = await call('task_submit', { taskId, summary: '复核任务上误用执行交卷工具，这里应当被拒绝的' });
    expect(String(wrongPhase.error)).toContain('invalid');
    expect(String(wrongPhase.error)).toContain('task_review');

    const tooShort = await call('task_review', { taskId, verdict: 'pass', findings: '太短' });
    expect(String(tooShort.error)).toContain('20..8000');
    const pass = await call('task_review', { taskId, verdict: 'pass', findings: '逐条复核了全部验收标准，证据与结论都写在这里' });
    expect(pass.ok).toBe(true);
    expect(resultJson()).toMatchObject({ review: 'accept' });
    expect(workResult('终稿', 'review', resultJson()).action).toBe('accept');

    const back = await call('task_review', { taskId, verdict: 'return', findings: '第三条验收标准缺少证据支撑，需要退回补齐材料' });
    expect(back.ok).toBe(true);
    expect(resultJson()).toMatchObject({ review: 'return' });
    expect(workResult('终稿', 'review', resultJson()).action).toBe('return');
  });

  test('task_block → outcome blocked，被 workResult 解析为 block', async () => {
    const { call, resultJson, taskId } = await world('doing');
    const res = await call('task_block', { taskId, reason: '供应商测试环境当前不可用，需要等恢复后继续' });
    expect(res.ok).toBe(true);
    expect(resultJson()).toMatchObject({ outcome: 'blocked' });
    expect(workResult('终稿', 'doing', resultJson()).action).toBe('block');
  });

  test('执行阶段 task_review、sha 非 40 位、文本过短 → invalid，一个 result.json 都不写', async () => {
    const { call, taskId, resultJson } = await world('doing');
    const review = await call('task_review', { taskId, verdict: 'pass', findings: '执行任务上误用了复核工具，这里应当被拒绝的' });
    expect(String(review.error)).toContain('task_submit');

    for (const [name, input, contains] of [
      ['task_submit', { taskId, summary: 'x'.repeat(30), sha: 'abc123' }, '40 位'],
      ['task_submit', { taskId, summary: '太短' }, '20..8000'],
      ['task_block', { taskId, reason: '太短' }, '20..4000'],
      ['task_submit', { taskId, summary: 'x'.repeat(30), pr: 'https://example.com/not-a-pr' }, 'pr'],
    ] as const) {
      const res = await call(name, input);
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain(contains);
    }
    expect(resultJson()).toBeUndefined();
  });

  test('company_tool 自身不是公司工具名、company_ops 不能借道 company_tool', async () => {
    const { call, taskId } = await world('doing');
    const rec = await call('company_tool', { name: 'task_current' });
    expect(rec.ok).toBe(false);
    expect(String(rec.error)).toContain('未知公司工具');
    const escape = await call('company_ops', { taskId, tool: 'company_tool' });
    expect(escape.ok).toBe(false);
    expect(String(escape.error)).toContain('不是运维能力工具');
  });

  test('task_current/task_context 走真池租约；未注入 landscape → not_configured', async () => {
    const { call, taskId } = await world('doing');
    const current = await call('task_current', {});
    expect(current.ok).toBe(true);
    expect(current.data).toEqual({ tasks: [{ taskId, phase: 'doing', leaseExpiresAt: expect.any(Number) }] });

    const other = await call('task_context', { taskId: 'task-other' });
    expect(String(other.error)).toContain('不是你当前在租的任务');

    const land = await call('company_landscape', {});
    expect(String(land.error)).toContain('not_configured');
  });
});
