import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import { commDir, reqDir, resDir, reportPath, blockerPath, readJsonFile } from '../src/comm.ts';
import type { ActiveLease, ClaimResult, LeaseProof, TaskView } from '../src/contracts.ts';
import type { EmployeeInst, SupervisedTask } from '../src/workforce.ts';

const taskView = (id: string, version = 1): TaskView => ({
  id, title: `t-${id}`, context: '', state: 'doing', executorRole: 'engineering', reviewerRole: 'qa',
  kind: 'task', dependencies: [], version, fence: 1, deliveryId: `d-${id}`,
});

const claimResult = (taskId: string): ClaimResult => ({
  task: taskView(taskId), deliveryId: `d-${taskId}`, fence: 7, leaseExpiresAt: new Date().toISOString(), history: [],
});

interface Call { tool: string; proof?: LeaseProof; text?: string; to?: string }
const calls: Call[] = [];

let employeeForGetTask = 'eng-x';
let authRole = 'engineering';
let activeLeaseRows: ActiveLease[] = [];
const wtCalls: Array<{ cred: string; taskId?: string }> = [];
const pageCalls: Array<{ cred: string; taskId?: string; pageSize?: number }> = [];
const refCalls: Array<{ cred: string; input: Record<string, unknown> }> = [];
const reclaimCalls: Array<{ cred: string; input?: { dryRun?: boolean; repos?: string[] } }> = [];
const auditCalls: Array<{ cred: string; limit?: number }> = [];
const snap = (proof: LeaseProof): LeaseProof => ({ ...proof }); // record a copy; the pool mutates its proof between calls

const core = {
  claim: async (_cred: string, taskId: string) => claimResult(taskId),
  heartbeat: async (_c: string, proof: LeaseProof) => { calls.push({ tool: 'heartbeat', proof: snap(proof) }); return claimResult(proof.taskId); },
  checkpoint: async (_c: string, proof: LeaseProof, ev: { text: string }) => { calls.push({ tool: 'checkpoint', proof: snap(proof), text: ev.text }); return { ...taskView(proof.taskId), version: proof.expectedVersion + 1 }; },
  submit: async (_c: string, proof: LeaseProof, ev: { text: string }) => { calls.push({ tool: 'submit', proof: snap(proof), text: ev.text }); return taskView(proof.taskId); },
  block: async (_c: string, proof: LeaseProof, to: string, ev: { text: string }) => { calls.push({ tool: 'block', proof: snap(proof), to, text: ev.text }); return taskView(proof.taskId); },
  accept: async (_c: string, proof: LeaseProof, ev: { text: string }) => { calls.push({ tool: 'accept', proof: snap(proof), text: ev.text }); return taskView(proof.taskId); },
  returnTask: async (_c: string, proof: LeaseProof, ev: { text: string }) => { calls.push({ tool: 'return', proof: snap(proof), text: ev.text }); return taskView(proof.taskId); },
  authenticate: async () => ({ employeeId: 'eng-x', role: authRole, capabilities: ['execute'] as const }),
  companyBrief: async () => ({ ok: true }),
  listTasks: async () => [],
  activeLeases: async () => activeLeaseRows,
  getTask: async (_c: string, taskId: string) => {
    const lease = activeLeaseRows.find(row => row.taskId === taskId);
    return { ...taskView(taskId, lease?.version ?? 1), state: lease?.state ?? 'doing',
      currentEmployee: employeeForGetTask, deliveryId: lease?.deliveryId ?? `d-${taskId}`,
      fence: lease?.fence ?? 1, leaseExpiresAt: lease?.leaseExpiresAt };
  },
  history: async () => [],
  listWorktrees: async (c: string, taskId?: string) => { wtCalls.push({ cred: c, taskId }); return [] as never; },
  worktreeList: async (c: string, input: { taskId?: string }) => { wtCalls.push({ cred: c, taskId: input.taskId }); return [] as never; },
  worktreePage: async (c: string, input: { taskId?: string; pageSize?: number }) => {
    pageCalls.push({ cred: c, taskId: input.taskId, pageSize: input.pageSize });
    return { worktrees: [], page: { returned: 0, hasMore: false } } as never;
  },
  worktreeRefs: async (c: string, input: Record<string, unknown>) => {
    refCalls.push({ cred: c, input });
    return { worktreePath: String(input.worktreePath), includeReleased: input.includeReleased === true, totalBytes: 2,
      sha256: 'a'.repeat(64), offset: 0, bytes: 2, nextOffset: null, text: '[]' } as never;
  },
  reclaimWorktrees: async (c: string, input?: { dryRun?: boolean; repos?: string[] }) => {
    reclaimCalls.push({ cred: c, input });
    return { scanId: 's', removed: [], kept: [], branchesDeleted: [], branchesRetained: [], audited: 0 };
  },
  listWorktreeAudits: async (c: string, limit?: number) => { auditCalls.push({ cred: c, limit }); return [] as never; },
  createTask: async () => taskView('new'),
  relayGoal: async () => ({}), triageGoal: async () => ({}), createDelivery: async () => [],
  relayOwnerDecision: async () => taskView('x'), relayDirection: async () => {},
  resume: async () => taskView('x'), recordScore: async () => ({ recorded: 1, participants: [] }),
  listOutbox: async () => [],
  qaObservationRead: async (c: string, input: Record<string, unknown>) => ({ meta: { checkedAt: 'x', dataSource: 'live', instanceAt: 'x', scope: {}, completeness: {} }, task: { id: input.taskId }, __cred: c }),
};

const workforce = { rotate: async () => 'tok-rotated' };
const inst = (id: string, extra: Partial<EmployeeInst> = {}): EmployeeInst =>
  ({ id, role: 'engineering', credential: `tok-${id}`, ...extra }) as EmployeeInst;
const task = (id: string): SupervisedTask => ({ id, title: `t-${id}`, state: 'ready', executorRole: 'engineering', row: {} }) as unknown as SupervisedTask;

const until = async (fn: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return; await Bun.sleep(20); }
  throw new Error('condition not met');
};

interface OpsCall { credential: string; taskId: string; tool: string; args: Record<string, unknown> }
const opsCalls: OpsCall[] = [];
const released: string[] = [];
const ops = {
  tools: ['ops_info', 'ops_login'] as const,
  call: async (credential: string, taskId: string, tool: string, args: Record<string, unknown>) => {
    opsCalls.push({ credential, taskId, tool, args });
    return { ok: true, tool };
  },
  release: (employeeId: string) => { released.push(employeeId); },
};
const mediaCalls: OpsCall[] = [];
const mediaReleased: string[] = [];
const media = {
  tools: ['media_info', 'media_tts'] as const,
  call: async (credential: string, taskId: string, tool: string, args: Record<string, unknown>) => {
    mediaCalls.push({ credential, taskId, tool, args });
    return { ok: true, tool };
  },
  release: (employeeId: string) => { mediaReleased.push(employeeId); },
};

const relay = async (envDir: string, key: string, name: string, tool: string, args: Record<string, unknown> | null) => {
  writeFileSync(join(reqDir(envDir), `${name}.json`), JSON.stringify({ key, tool, args }));
  await until(() => existsSync(join(resDir(envDir), `${name}.json`)));
  return readJsonFile<{ ok: boolean; data?: unknown; error?: string }>(join(resDir(envDir), `${name}.json`))!;
};

let runDir: string;
let pool: SidecarPool;
beforeEach(() => {
  calls.length = 0;
  opsCalls.length = 0;
  released.length = 0;
  mediaCalls.length = 0;
  mediaReleased.length = 0;
  wtCalls.length = 0;
  pageCalls.length = 0;
  refCalls.length = 0;
  reclaimCalls.length = 0;
  auditCalls.length = 0;
  employeeForGetTask = 'eng-x';
  authRole = 'engineering';
  activeLeaseRows = [];
  runDir = mkdtempSync(join(tmpdir(), 'sck-sidecar-'));
  pool = new SidecarPool({ core: core as never, workforce: workforce as never, ops, media, runDir, heartbeatMs: 10_000, sweepMs: 20 });
});
afterEach(() => { rmSync(runDir, { recursive: true, force: true }); });

describe('sidecar', () => {
  test('env exposes comm channel, never credentials', () => {
    const env = pool.env(inst('e1'));
    expect(env.SCK_COMM_DIR).toBe(join(runDir, 'e1'));
    expect(env.SCK_COMM_KEY?.length).toBe(32);
    expect(Object.keys(env)).not.toContain('SCK_EMPLOYEE_CREDENTIAL');
    expect(existsSync(reqDir(env.SCK_COMM_DIR))).toBe(true);
  });

  test('claim stages claim.json and records the lease proof', async () => {
    const i = inst('e2');
    pool.env(i);
    const result = await pool.claim(i, task('task-1'));
    expect(result?.deliveryId).toBe('d-task-1');
    const staged = JSON.parse(readFileSync(join(runDir, 'e2', 'claim.json'), 'utf8')) as ClaimResult;
    expect(staged.fence).toBe(7);
  });

  test('legacy credential-file instances are never claimed by the sidecar', async () => {
    const i = inst('legacy-1', { credentialFile: '/tmp/x.token', credential: undefined });
    const result = await pool.claim(i, task('task-2'));
    expect(result).toBeUndefined();
    expect(calls.filter(c => c.tool === 'claim')).toHaveLength(0);
  });

  test('relay injects the held lease proof into checkpoint', async () => {
    const i = inst('e3');
    const env = pool.env(i);
    await pool.claim(i, task('task-3'));
    const key = 'req1';
    writeFileSync(join(reqDir(env.SCK_COMM_DIR), `${key}.json`),
      JSON.stringify({ key: env.SCK_COMM_KEY, tool: 'checkpoint', args: { text: 'half done' } }));
    await until(() => existsSync(join(resDir(env.SCK_COMM_DIR), `${key}.json`)));
    const res = readJsonFile<{ ok: boolean; data?: { version: number }; error?: string }>(join(resDir(env.SCK_COMM_DIR), `${key}.json`))!;
    expect(res.ok).toBe(true);
    const call = calls.find(c => c.tool === 'checkpoint')!;
    expect(call.proof).toEqual({ taskId: 'task-3', deliveryId: 'd-task-3', fence: 7, expectedVersion: 1 });
    expect(call.text).toBe('half done');
  });


  test('QA reads carry the actual running release, and never a fabricated one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sck-sidecar-home-'));
    const sha = 'c'.repeat(40);
    mkdirSync(join(home, 'releases', sha), { recursive: true });
    symlinkSync(join(home, 'releases', sha), join(home, 'active'));
    const prevHome = process.env.SCK_SERVICE_HOME;
    process.env.SCK_SERVICE_HOME = home;
    try {
      const i = inst('e-qa');
      const env = pool.env(i);
      await pool.claim(i, task('task-qa'));
      const answer = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY, 'qa1', 'qa_observation_read', { taskId: 'task-qa' });
      expect(answer.ok).toBe(true);
      expect((answer.data as { meta: { runtimeRelease?: string } }).meta.runtimeRelease).toBe(sha);
      unlinkSync(join(home, 'active'));
      const after = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY, 'qa2', 'qa_observation_read', { taskId: 'task-qa' });
      expect(after.ok).toBe(true);
      expect((after.data as { meta: { runtimeRelease?: string } }).meta.runtimeRelease).toBeUndefined();
    } finally {
      if (prevHome === undefined) delete process.env.SCK_SERVICE_HOME; else process.env.SCK_SERVICE_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('relay rejects a wrong comm key and claim_next', async () => {
    const i = inst('e4');
    const env = pool.env(i);
    await pool.claim(i, task('task-4'));
    writeFileSync(join(reqDir(env.SCK_COMM_DIR), 'bad.json'),
      JSON.stringify({ key: 'forged', tool: 'checkpoint', args: { text: 'x' } }));
    writeFileSync(join(reqDir(env.SCK_COMM_DIR), 'cn.json'),
      JSON.stringify({ key: env.SCK_COMM_KEY, tool: 'claim_next', args: { taskId: 'task-4' } }));
    await until(() => existsSync(join(resDir(env.SCK_COMM_DIR), 'bad.json')) && existsSync(join(resDir(env.SCK_COMM_DIR), 'cn.json')));
    expect(readJsonFile<{ ok: boolean }>(join(resDir(env.SCK_COMM_DIR), 'bad.json'))!.ok).toBe(false);
    const cn = readJsonFile<{ ok: boolean; error?: string }>(join(resDir(env.SCK_COMM_DIR), 'cn.json'))!;
    expect(cn.ok).toBe(false);
    expect(cn.error).toContain('forbidden');
    expect(calls.filter(c => c.tool === 'checkpoint')).toHaveLength(0);
  });

  test('writes without a live lease are refused', async () => {
    const i = inst('e5');
    const env = pool.env(i);
    writeFileSync(join(reqDir(env.SCK_COMM_DIR), 's.json'),
      JSON.stringify({ key: env.SCK_COMM_KEY, tool: 'submit', args: { text: 'done' } }));
    await until(() => existsSync(join(resDir(env.SCK_COMM_DIR), 's.json')));
    const res = readJsonFile<{ ok: boolean; error?: string }>(join(resDir(env.SCK_COMM_DIR), 's.json'))!;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no_lease');
  });

  test('settle submits report.md exactly once', async () => {
    const i = inst('e6');
    const env = pool.env(i);
    await pool.claim(i, task('task-6'));
    pool.bindAgent('e6', 'agent-6');
    writeFileSync(reportPath(env.SCK_COMM_DIR), '交付完成：已验证 a/b/c');
    await pool.settle('agent-6');
    const submits = calls.filter(c => c.tool === 'submit');
    expect(submits).toHaveLength(1);
    expect(submits[0]!.text).toContain('交付完成');
    expect(submits[0]!.proof?.deliveryId).toBe('d-task-6');
    // File was renamed; a second settle cannot resubmit.
    await pool.settle('agent-6');
    expect(calls.filter(c => c.tool === 'submit')).toHaveLength(1);
    expect(readdirSync(env.SCK_COMM_DIR).some(f => f.startsWith('report.md.done-'))).toBe(true);
  });

  test('settle routes blocker.md to gm and consumes the lease', async () => {
    const i = inst('e7');
    const env = pool.env(i);
    await pool.claim(i, task('task-7'));
    pool.bindAgent('e7', 'agent-7');
    writeFileSync(blockerPath(env.SCK_COMM_DIR), '需要经理定夺范围');
    await pool.settle('agent-7');
    const blocks = calls.filter(c => c.tool === 'block');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.to).toBe('gm');
    // A later write attempt finds no lease.
    writeFileSync(join(reqDir(env.SCK_COMM_DIR), 'late.json'),
      JSON.stringify({ key: env.SCK_COMM_KEY, tool: 'checkpoint', args: { text: 'x' } }));
    await until(() => existsSync(join(resDir(env.SCK_COMM_DIR), 'late.json')));
    expect(readJsonFile<{ ok: boolean }>(join(resDir(env.SCK_COMM_DIR), 'late.json'))!.ok).toBe(false);
  });

  test('a stale report file present before claim is never submitted', async () => {
    const i = inst('e8');
    const env = pool.env(i);
    writeFileSync(reportPath(env.SCK_COMM_DIR), '上一轮残留的假交付');
    await pool.claim(i, task('task-8'));
    pool.bindAgent('e8', 'agent-8');
    await pool.settle('agent-8');
    expect(calls.filter(c => c.tool === 'submit')).toHaveLength(0);
  });

  test('ops tools are relayed under the lease holder task id; the credential never leaves the plugin', async () => {
    const i = inst('e10');
    const env = pool.env(i);
    await pool.claim(i, task('task-10'));
    const res = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'o1', 'ops_login', { alias: 'QA1', taskId: 'someone-elses-task', env: 'production' });
    expect(res).toEqual({ ok: true, data: { ok: true, tool: 'ops_login' } });
    expect(opsCalls).toEqual([{ credential: 'tok-e10', taskId: 'task-10', tool: 'ops_login', args: { alias: 'QA1', env: 'production' } }]);
    expect(JSON.stringify(res)).not.toContain('tok-e10');
  });

  test('ops tools are listed, need a live lease, and the old secret tools are gone', async () => {
    const i = inst('e11');
    const env = pool.env(i);
    const refused = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'o2', 'ops_info', {});
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('no_lease');
    expect(opsCalls).toHaveLength(0);

    const listed = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'o3', '__list__', {});
    const tools = (listed.data as { tools: string[] }).tools;
    expect(tools).toEqual(expect.arrayContaining(['ops_info', 'ops_login', 'checkpoint']));
    expect(tools).not.toContain('get_secret');
    expect(tools).not.toContain('put_secret');

    await pool.claim(i, task('task-11'));
    for (const [name, tool] of [['o4', 'get_secret'], ['o5', 'put_secret']] as const) {
      const res = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, name, tool, { name: 'X' });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('unknown_tool');
    }
  });

  test('worktree 工具经 sidecar 路由：员工缺省绑当前任务，gm 缺省取全局，回收/审计透传 core', async () => {
    const i = inst('e13');
    const env = pool.env(i);
    await pool.claim(i, task('task-13'));

    // R8（GM 裁定 v25）：员工缺省不再回退到当前租约任务。改动原因：旧断言要求缺省回退到 task-13，与 core 的
    // 「非 gm 且无 taskId 即 forbidden」相反。通道只把缺省 taskId 以 undefined 交给 core，由 core 判定拒绝；
    // 本桩 core 不拒绝，所以这里只断言通道没有注入租约任务。显式 taskId 原样透传。
    const unscoped = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'w1', 'list_worktrees', {});
    expect(unscoped.ok).toBe(true);
    expect(wtCalls[0]).toEqual({ cred: 'tok-e13', taskId: undefined });
    await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'w2', 'list_worktrees', { taskId: 'task-other' });
    expect(wtCalls[1]).toEqual({ cred: 'tok-e13', taskId: 'task-other' });

    // gm 缺省：全局库存（taskId undefined，角色门控在 core）
    authRole = 'gm';
    await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'w3', 'list_worktrees', {});
    expect(wtCalls[2]).toEqual({ cred: 'tok-e13', taskId: undefined });

    // C1：不带 pageSize/cursor 仍返回数组；带分页参数才走 worktreePage，返回 { worktrees, page }
    const legacy = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'w8', 'list_worktrees', {});
    expect(Array.isArray(legacy.data)).toBe(true);
    const paged = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'w9', 'list_worktrees', { pageSize: 5 });
    expect(paged.data).toEqual({ worktrees: [], page: { returned: 0, hasMore: false } });
    expect(pageCalls).toEqual([{ cred: 'tok-e13', taskId: undefined, pageSize: 5 }]);

    // SYS01 R1：截断条目的恢复入口经通道原样转发（taskId、路径、过滤与字节窗口都由 core 校验）。
    const refs = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'w10', 'read_worktree_refs',
      { taskId: 'task-13', worktreePath: '/wt/shared', includeReleased: true, offset: 0 });
    expect(refs.ok).toBe(true);
    expect(refCalls[0]).toEqual({ cred: 'tok-e13', input: { taskId: 'task-13', worktreePath: '/wt/shared', includeReleased: true, offset: 0 } });

    // 回收（dry-run 透传）与审计查询；写全量回收同样透传，由 core 做 gm 门控
    await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'w4', 'reclaim_worktrees', { dryRun: true, repos: ['/repo/a'] });
    expect(reclaimCalls[0]).toEqual({ cred: 'tok-e13', input: { dryRun: true, repos: ['/repo/a'] } });
    await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'w5', 'reclaim_worktrees', {});
    expect(reclaimCalls[1]).toEqual({ cred: 'tok-e13', input: { dryRun: false, repos: undefined } });
    await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'w6', 'list_worktree_audits', { limit: 5 });
    expect(auditCalls[0]).toEqual({ cred: 'tok-e13', limit: 5 });

    // 工具清单暴露新工具
    const listed = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'w7', '__list__', {});
    expect((listed.data as { tools: string[] }).tools)
      .toEqual(expect.arrayContaining(['reclaim_worktrees', 'list_worktree_audits', 'read_worktree_refs']));
  });

  test('reclaim_worktrees is strict on the sidecar relay as in core and MCP (SYS01, D3): a null or non-boolean dryRun, and a repos that is not a list of paths, are refused before the registry runs', async () => {
    const i = inst('e15');
    const env = pool.env(i);
    await pool.claim(i, task('task-15'));
    const before = reclaimCalls.length;
    const refused: Array<[string, Record<string, unknown>]> = [
      ['dry-null', { dryRun: null }], ['dry-string', { dryRun: 'true' }], ['dry-one', { dryRun: 1 }], ['dry-zero', { dryRun: 0 }],
      ['dry-empty', { dryRun: '' }], ['repos-string', { repos: '/repo/a' }], ['repos-null', { repos: null }],
      ['repos-number', { repos: 5 }], ['repos-blank', { repos: [' '] }], ['repos-element', { repos: [7] }],
    ];
    for (const [name, args] of refused) {
      const res = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, `bad-${name}`, 'reclaim_worktrees', args);
      expect({ name, ok: res.ok }).toEqual({ name, ok: false });
    }
    // A null argument object is refused too: the relay does not read it as absent and reclaim.
    const nullArgs = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'bad-args-null', 'reclaim_worktrees', null);
    expect({ name: 'args-null', ok: nullArgs.ok, error: nullArgs.error?.slice(0, 7) }).toEqual({ name: 'args-null', ok: false, error: 'invalid' });
    expect(reclaimCalls.length).toBe(before);
    // An omitted dryRun is a reclaim and dryRun true a dry run, under the same rule as core and MCP.
    await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'ok-reclaim', 'reclaim_worktrees', {});
    await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'ok-dry', 'reclaim_worktrees', { dryRun: true });
    expect(reclaimCalls.slice(before)).toEqual([
      { cred: 'tok-e15', input: { dryRun: false } },
      { cred: 'tok-e15', input: { dryRun: true } },
    ]);
  });

  test('null is absent on the sidecar relay as in core and MCP (SYS01, defect 2): paging and filters are absent, a null task id is refused for get_task_history and resume_task', async () => {
    const i = inst('e14');
    const env = pool.env(i);
    await pool.claim(i, task('task-14'));
    // list_worktrees (R8): null pageSize, cursor and taskId are absent, so the call is unscoped (core refuses a non-gm).
    // It never falls back to the lease task, and the null never reaches core as the string "null".
    const legacy = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'n1', 'list_worktrees', { pageSize: null, cursor: null, taskId: null });
    expect(legacy.ok).toBe(true);
    expect(Array.isArray(legacy.data)).toBe(true);
    expect(wtCalls.at(-1)).toEqual({ cred: 'tok-e14', taskId: undefined });
    expect(pageCalls).toHaveLength(0);
    // A null task id with a real page size is paged and still unscoped: null taskId is absent, pageSize 5 is the paged branch.
    await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'n6', 'list_worktrees', { taskId: null, pageSize: 5 });
    expect(pageCalls.at(-1)).toEqual({ cred: 'tok-e14', taskId: undefined, pageSize: 5 });
    // get_task_history: a null page size keeps the { history } shape; a null task id is refused, never read as "null".
    const history = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'n2', 'get_task_history', { taskId: 'task-14', pageSize: null, cursor: null });
    expect(history).toMatchObject({ ok: true, data: { history: [] } });
    const nullTask = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'n3', 'get_task_history', { taskId: null });
    expect(nullTask.ok).toBe(false);
    expect(nullTask.error).toContain('taskId');
    // get_context: null filters and a null task id are absent (legacy keys: this stub core has no contextView).
    const context = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'n4', 'get_context', { taskId: null, state: null, pageSize: null, cursor: null });
    expect(context.ok).toBe(true);
    expect(Object.keys(context.data as object).sort()).toEqual(['companyIncluded', 'companyRead', 'principal', 'tasks']);
    // resume_task: a null task id is refused, and core never sees the string "null".
    const resume = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'n5', 'resume_task', { taskId: null });
    expect(resume.ok).toBe(false);
    expect(resume.error).toContain('taskId');
  });

  test('ops sessions are dropped when the lease ends and when the agent is archived', async () => {
    const i = inst('e12');
    const env = pool.env(i);
    pool.bindAgent('e12', 'agent-12');
    await pool.claim(i, task('task-12'));
    released.length = 0; // claim clears leftovers from a previous lease first
    const submitted = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'o6', 'submit', { text: 'done' });
    expect(submitted.ok).toBe(true);
    expect(released).toEqual(['e12']);
    pool.detachAgent('agent-12');
    expect(released).toEqual(['e12', 'e12']);
  });

  test('media tools are listed and relayed under the lease holder task id, like ops; the lease end drops their state too', async () => {
    const i = inst('e14');
    const env = pool.env(i);
    await pool.claim(i, task('task-14'));
    mediaReleased.length = 0; // claim clears leftovers from a previous lease first
    const listed = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'm1', '__list__', {});
    expect((listed.data as { tools: string[] }).tools).toEqual(expect.arrayContaining(['media_info', 'media_tts', 'ops_info']));
    const res = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'm2', 'media_tts', { voiceId: 'v1', taskId: 'someone-elses-task' });
    expect(res).toEqual({ ok: true, data: { ok: true, tool: 'media_tts' } });
    expect(mediaCalls).toEqual([{ credential: 'tok-e14', taskId: 'task-14', tool: 'media_tts', args: { voiceId: 'v1' } }]);
    expect(opsCalls).toHaveLength(0);
    const submitted = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'm3', 'submit', { text: 'done' });
    expect(submitted.ok).toBe(true);
    expect(mediaReleased).toEqual(['e14']);
  });

  test('adopt re-keys a live binding: channel stays usable, stale artifacts orphaned', async () => {
    const fresh = new SidecarPool({ core: core as never, workforce: workforce as never, runDir, heartbeatMs: 10_000, sweepMs: 20 });
    const live = inst('e9', { paseoAgentId: 'a-9', activeTask: 'task-9', credential: undefined });
    await fresh.adopt([live]);
    // workforce.rotate proves the instance is alive — the channel is re-keyed, not quarantined.
    expect(fresh.canReuse(live)).toBe(true);
    // No live server-side lease (listTasks is empty): a leftover report is orphaned, never submitted.
    writeFileSync(reportPath(join(runDir, 'e9')), '陈旧补交');
    await fresh.settle('a-9');
    expect(calls.filter(c => c.tool === 'submit')).toHaveLength(0);
    await expect(fresh.claim(live, task('other'))).resolves.toBeTruthy();
    fresh.detachAgent('a-9');
  });

  test('adopt recovers a live review lease and keeps checkpoint/review usable without a new claim', async () => {
    const i = inst('e-review', { paseoAgentId: 'agent-review', role: 'qa', credential: undefined });
    const expires = new Date(Date.now() + 60_000).toISOString();
    activeLeaseRows = [{ taskId: 'task-review', state: 'review', deliveryId: 'd-review', fence: 4, version: 9,
      leaseExpiresAt: expires, role: 'qa', currentEmployee: 'e-review' }];
    employeeForGetTask = 'e-review';
    authRole = 'qa';
    const fresh = new SidecarPool({ core: core as never, workforce: workforce as never, runDir, heartbeatMs: 10_000, sweepMs: 20 });
    await fresh.adopt([i]);
    await fresh.adopt([i]); // two consecutive adopts must reuse the one recovered claim
    expect(fresh.canReuse(i)).toBe(true);
    const env = fresh.env(i);
    const checkpoint = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'rv1', 'checkpoint', { text: 'review checkpoint after reload' });
    expect(checkpoint.ok).toBe(true);
    expect(calls.find(c => c.tool === 'checkpoint')!.proof).toEqual({
      taskId: 'task-review', deliveryId: 'd-review', fence: 4, expectedVersion: 9,
    });
    // A report.md is execute-phase closeout; on a review lease it is archived, not submitted,
    // and the recovered lease stays usable.
    writeFileSync(reportPath(env.SCK_COMM_DIR), 'review report should not submit');
    await fresh.settle('agent-review');
    expect(calls.filter(c => c.tool === 'submit')).toHaveLength(0);
    expect(readdirSync(env.SCK_COMM_DIR).some(f => f.startsWith('report.md.stale-'))).toBe(true);
    const review = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'rv2', 'review', { decision: 'return', text: 'formal review after reload' });
    expect(review.ok).toBe(true);
    expect(calls.find(c => c.tool === 'return')!.proof).toEqual({
      taskId: 'task-review', deliveryId: 'd-review', fence: 4, expectedVersion: 10,
    });
    fresh.close();
  });

  test('adopt recovers a review lease for report_blocker', async () => {
    const i = inst('e-review-block', { paseoAgentId: 'agent-review-block', role: 'qa', credential: undefined });
    activeLeaseRows = [{ taskId: 'task-review-block', state: 'review', deliveryId: 'd-review-block', fence: 2, version: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), role: 'qa', currentEmployee: 'e-review-block' }];
    employeeForGetTask = 'e-review-block';
    authRole = 'qa';
    const fresh = new SidecarPool({ core: core as never, workforce: workforce as never, runDir, heartbeatMs: 10_000, sweepMs: 20 });
    await fresh.adopt([i]);
    const env = fresh.env(i);
    const blocked = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'rb1', 'report_blocker', { text: 'review blocker after reload', to: 'gm' });
    expect(blocked.ok).toBe(true);
    expect(calls.find(c => c.tool === 'block')!.proof).toEqual({
      taskId: 'task-review-block', deliveryId: 'd-review-block', fence: 2, expectedVersion: 3,
    });
    expect(calls.find(c => c.tool === 'block')!.to).toBe('gm');
    fresh.close();
  });

  test('adopt fails closed on an expired review lease; no local no_lease resurrection', async () => {
    const i = inst('e-expired', { paseoAgentId: 'agent-expired', role: 'qa', credential: undefined });
    activeLeaseRows = [{ taskId: 'task-expired', state: 'review', deliveryId: 'd-expired', fence: 1, version: 1,
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(), role: 'qa', currentEmployee: 'e-expired' }];
    employeeForGetTask = 'e-expired';
    authRole = 'qa';
    const fresh = new SidecarPool({ core: core as never, workforce: workforce as never, runDir, heartbeatMs: 10_000, sweepMs: 20 });
    await fresh.adopt([i]);
    const env = fresh.env(i);
    const checkpoint = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'ex1', 'checkpoint', { text: 'expired lease must not revive' });
    expect(checkpoint.ok).toBe(false);
    expect(checkpoint.error).toContain('no_lease');
    fresh.close();
  });

  test('adopt does not apply a stale claim.json artifact to a different delivery', async () => {
    const i = inst('e-stale-artifact', { credential: undefined });
    const env = pool.env(i);
    await pool.claim(i, task('task-old'));
    writeFileSync(reportPath(env.SCK_COMM_DIR), 'old delivery report');
    writeFileSync(blockerPath(env.SCK_COMM_DIR), 'old delivery blocker');
    pool.close();
    i.paseoAgentId = 'agent-stale-artifact';
    activeLeaseRows = [{ taskId: 'task-new', state: 'doing', deliveryId: 'd-task-new', fence: 2, version: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), role: 'engineering', currentEmployee: 'e-stale-artifact' }];
    employeeForGetTask = 'e-stale-artifact';
    const fresh = new SidecarPool({ core: core as never, workforce: workforce as never, runDir, heartbeatMs: 10_000, sweepMs: 20 });
    await fresh.adopt([i]);
    expect(calls.filter(c => c.tool === 'submit' || c.tool === 'block')).toHaveLength(0);
    expect(readdirSync(env.SCK_COMM_DIR).some(f => f.startsWith('report.md.stale-'))).toBe(true);
    expect(readdirSync(env.SCK_COMM_DIR).some(f => f.startsWith('blocker.md.stale-'))).toBe(true);
    const staged = readJsonFile<ClaimResult>(join(env.SCK_COMM_DIR, 'claim.json'))!;
    expect(staged.task.id).toBe('task-new');
    expect(staged.deliveryId).toBe('d-task-new');
    fresh.close();
  });

  test('adopt fails closed when the complete lease lookup is ambiguous', async () => {
    const i = inst('e-ambiguous', { paseoAgentId: 'agent-ambiguous', role: 'qa', credential: undefined });
    const expires = new Date(Date.now() + 60_000).toISOString();
    activeLeaseRows = [
      { taskId: 'task-one', state: 'review', deliveryId: 'd-one', fence: 1, version: 1, leaseExpiresAt: expires, role: 'qa', currentEmployee: 'e-ambiguous' },
      { taskId: 'task-two', state: 'review', deliveryId: 'd-two', fence: 1, version: 1, leaseExpiresAt: expires, role: 'qa', currentEmployee: 'e-ambiguous' },
    ];
    employeeForGetTask = 'e-ambiguous';
    authRole = 'qa';
    const fresh = new SidecarPool({ core: core as never, workforce: workforce as never, runDir, heartbeatMs: 10_000, sweepMs: 20 });
    await fresh.adopt([i]);
    const env = fresh.env(i);
    const checkpoint = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'amb1', 'checkpoint', { text: 'ambiguous lease must not revive' });
    expect(checkpoint.ok).toBe(false);
    expect(checkpoint.error).toContain('no_lease');
    fresh.close();
  });

  test('claim drops a stale local claim when the server lease is already dead', async () => {
    const i = inst('e-stale');
    pool.env(i); pool.bindAgent('e-stale', 'agent-stale');
    await pool.claim(i, task('task-held'));
    // The same live lease still blocks a second claim.
    employeeForGetTask = 'e-stale';
    await expect(pool.claim(i, task('task-next'))).rejects.toMatchObject({ code: 'already_claimed' });
    // Once the server-side lease is gone (revoked, expired or re-claimed), the
    // stale remnant is dropped and the new claim goes through.
    employeeForGetTask = 'someone-else';
    await expect(pool.claim(i, task('task-next'))).resolves.toBeTruthy();
  });
});

describe('deliverable_publish 工具', () => {
  const PUB_HOME = () => process.env.SCK_SERVICE_HOME!;
  const withHome = async (fn: (home: string) => Promise<void>) => {
    const home = mkdtempSync(join(tmpdir(), 'pub-sidecar-'));
    const prev = process.env.SCK_SERVICE_HOME;
    process.env.SCK_SERVICE_HOME = home;
    try { await fn(home); } finally {
      if (prev === undefined) delete process.env.SCK_SERVICE_HOME; else process.env.SCK_SERVICE_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  };

  test('__list__ 含 deliverable_publish；缺省 taskId 落租约任务；显式 taskId 可用', async () => {
    await withHome(async (home) => {
      const i = inst('e20');
      const env = pool.env(i);
      const listed = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'l9', '__list__', {});
      expect((listed.data as { tools: string[] }).tools).toContain('deliverable_publish');

      await pool.claim(i, task('task-20'));
      const srcDir = mkdtempSync(join(tmpdir(), 'pub-src-'));
      writeFileSync(join(srcDir, 'shot.png'), 'png');
      writeFileSync(join(srcDir, '剪 辑.mp4'), 'mp4');
      try {
        // 缺省 taskId = 租约任务 task-20
        const res = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'p1', 'deliverable_publish',
          { files: [join(srcDir, 'shot.png'), join(srcDir, '剪 辑.mp4')] });
        expect(res.ok).toBe(true);
        const data = res.data as { taskId: string; dir: string; baseUrl: string; urls: string[] };
        expect(data.taskId).toBe('task-20');
        expect(data.dir).toBe(join(home, 'deliverables', 'task-20'));
        expect(readFileSync(join(data.dir, 'shot.png'), 'utf8')).toBe('png');
        expect(data.urls).toContain(`${data.baseUrl}/d/task-20/shot.png`);
        expect(data.urls).toContain(`${data.baseUrl}/d/task-20/${encodeURIComponent('剪 辑.mp4')}`);
        // 显式 taskId（经理代发/补发）
        const res2 = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'p2', 'deliverable_publish',
          { taskId: 'task-other', files: [join(srcDir, 'shot.png')] });
        expect((res2.data as { taskId: string }).taskId).toBe('task-other');
        expect(existsSync(join(home, 'deliverables', 'task-other', 'shot.png'))).toBe(true);
      } finally { rmSync(srcDir, { recursive: true, force: true }); }
    });
  });

  test('坏路径拒绝且不落半截包；无租约无显式 taskId 报 no_lease', async () => {
    await withHome(async (home) => {
      const i = inst('e21');
      const env = pool.env(i);
      await pool.claim(i, task('task-21'));
      const res = await relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'p3', 'deliverable_publish',
        { files: ['/definitely/not/here.bin'] });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('未产生任何交付');
      expect(existsSync(join(home, 'deliverables', 'task-21'))).toBe(false);

      const i2 = inst('e22'); // 未 claim、无租约
      const env2 = pool.env(i2);
      const noLease = await relay(env2.SCK_COMM_DIR, env2.SCK_COMM_KEY!, 'p4', 'deliverable_publish',
        { files: ['/tmp/x.txt'] });
      expect(noLease.ok).toBe(false);
      expect(noLease.error).toContain('no_lease');
      // 但显式 taskId 免租约（经理补发）
      writeFileSync('/tmp/x.txt', 'x');
      const okExplicit = await relay(env2.SCK_COMM_DIR, env2.SCK_COMM_KEY!, 'p5', 'deliverable_publish',
        { taskId: 'task-resend', files: ['/tmp/x.txt'] });
      expect(okExplicit.ok).toBe(true);
      expect(existsSync(join(home, 'deliverables', 'task-resend', 'x.txt'))).toBe(true);
    });
  });

  test('a listing whose credential re-issue is still pending at its reply ceiling is refused recoverably at the ceiling (SYS01 M1)', async () => {
    // No held credential and a stalled rotate: the credential phase of a snapshot-backed read is inside the one deadline.
    const stalling = new SidecarPool({
      core: core as never, workforce: { rotate: () => new Promise<never>(() => undefined) } as never,
      ops, media, runDir, heartbeatMs: 10_000, sweepMs: 20,
    });
    try {
      const i = inst('e-stall', { credential: undefined });
      const env = stalling.env(i);
      const started = Date.now();
      // The answer is due at the ceiling, so wait past relay()'s short default.
      writeFileSync(join(reqDir(env.SCK_COMM_DIR), 's1.json'), JSON.stringify({ key: env.SCK_COMM_KEY, tool: 'get_context', args: {} }));
      await until(() => existsSync(join(resDir(env.SCK_COMM_DIR), 's1.json')), 20_000);
      const res = readJsonFile<{ ok: boolean; error?: string }>(join(resDir(env.SCK_COMM_DIR), 's1.json'))!;
      const elapsed = Date.now() - started;
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain('temporarily_unavailable');
      expect(elapsed).toBeGreaterThan(12_000);
      expect(elapsed).toBeLessThan(15_000);
    } finally { stalling.close(); }
  }, 30_000);
});
