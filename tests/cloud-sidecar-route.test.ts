import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CLOUD_OWNER_TOOLS, SidecarPool, cloudRequestOf, routesToGateway, type CloudRoute, type SidecarDeps } from '../plugin/server/sidecar.ts';
import { reqDir, resDir, readJsonFile } from '../src/comm.ts';
import type { ClaimResult, LeaseProof, TaskView } from '../src/contracts.ts';
import type { EmployeeInst, SupervisedTask } from '../src/workforce.ts';
import { GatewayClient } from '../src/cloud/gateway.ts';
import { IdpClient, type IssuedToken } from '../src/cloud/idp.ts';
import { AgentTokenCache } from '../src/cloud/agent-tokens.ts';
import { HARD_OWNER_ONLY, OWNER_API_COMMANDS, matchesCommand } from '../src/command-guard.ts';

// ma_hono（身份服务）与公司网关都用本地 mock，不连真实服务。
const CLIENT_ID = 'runner-client';
const CLIENT_SECRET = `runner-secret-${randomBytes(8).toString('hex')}`;
const EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface IdpCall { subject: string; taskId: string; ttl: string; authorized: boolean }
interface GwCall { auth: string; command: string; input: unknown }

const idpCalls: IdpCall[] = [];
const gwCalls: GwCall[] = [];
/** 本测试进程里 ma_hono mock 发出过的全部令牌；用来做"不出现"扫描。 */
const issued = new Set<string>();
const jobPolls = new Map<string, number>();

let idpServer: ReturnType<typeof Bun.serve>;
let gwServer: ReturnType<typeof Bun.serve>;
let idpBase = '';
let gwBase = '';

beforeAll(() => {
  idpServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== 'POST' || url.pathname !== '/t/company/token') return json({ error: 'not_found' }, 404);
      const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
      const form = new URLSearchParams(await req.text());
      const authorized = req.headers.get('authorization') === expected;
      idpCalls.push({
        subject: form.get('subject_token') ?? '', taskId: form.get('task_id') ?? '', ttl: form.get('ttl') ?? '', authorized,
      });
      if (!authorized) return json({ error: 'invalid_client' }, 401);
      if (form.get('grant_type') !== EXCHANGE_GRANT) return json({ error: 'unsupported_grant_type' }, 400);
      const token = `agt-${randomBytes(16).toString('hex')}`;
      issued.add(token);
      // 不是 JWT，走 expires_in 推算过期时间。
      return json({ access_token: token, token_type: 'Bearer', expires_in: Number(form.get('ttl')) }, 200);
    },
  });
  gwServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/api/cmd') return json({ ok: false, error: { code: 'not_found', message: 'x' } }, 404);
      const auth = req.headers.get('authorization') ?? '';
      const body = (await req.json()) as { command: string; input?: { id?: string } };
      gwCalls.push({ auth, command: body.command, input: body.input });
      const bearer = auth.replace(/^Bearer /, '');
      if (!issued.has(bearer)) return json({ ok: false, error: { code: 'unauthorized', message: 'invalid token' } }, 401);
      if (body.command === 'ops_slow') return json({ ok: false, error: { code: 'pending', message: 'job-1' } }, 202);
      if (body.command === 'ops_failjob') return json({ ok: false, error: { code: 'pending', message: 'job-2' } }, 202);
      if (body.command === 'ops_leak') return json({ ok: false, error: { code: 'forbidden', message: `refused for ${bearer}` } }, 403);
      if (body.command === 'ops.job.get') {
        const id = body.input?.id ?? '';
        const polls = (jobPolls.get(id) ?? 0) + 1;
        jobPolls.set(id, polls);
        if (id === 'job-1') {
          const job = polls < 3 ? { id, state: 'running' } : { id, state: 'done', result: { value: 42 } };
          return json({ ok: true, result: job });
        }
        if (id === 'job-2') return json({ ok: true, result: { id, state: 'error', error: { code: 'forbidden', message: `denied for ${bearer}` } } });
      }
      return json({ ok: true, result: { echoed: body.command } });
    },
  });
  idpBase = `http://127.0.0.1:${idpServer.port}`;
  gwBase = `http://127.0.0.1:${gwServer.port}`;
});

afterAll(() => {
  idpServer.stop(true);
  gwServer.stop(true);
});

const taskView = (id: string, version = 1): TaskView => ({
  id, title: `t-${id}`, context: '', state: 'doing', executorRole: 'engineering', reviewerRole: 'qa',
  kind: 'task', version, fence: 1, deliveryId: `d-${id}`,
});
const task = (id: string): SupervisedTask => ({ id, title: `t-${id}`, state: 'ready', executorRole: 'engineering', row: {} }) as unknown as SupervisedTask;
const inst = (id: string): EmployeeInst => ({ id, role: 'engineering', credential: `tok-${id}` }) as EmployeeInst;

const until = async (fn: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return; await Bun.sleep(10); }
  throw new Error('condition not met');
};

interface Reply { ok: boolean; data?: unknown; error?: string }

let root: string;
let runDir: string;
let logs: string[];
let pool: SidecarPool | undefined;
let leaseExpiresAt: string;
let localCalls: string[];
let exchangeCalls: unknown[];
let identityLookups: string[];
let opsCalls: Array<{ tool: string; args: Record<string, unknown> }>;
const replies: string[] = [];

const core = {
  claim: async (_c: string, taskId: string): Promise<ClaimResult> => ({
    task: taskView(taskId), deliveryId: `d-${taskId}`, fence: 7, leaseExpiresAt, history: [],
  }),
  checkpoint: async (_c: string, proof: LeaseProof) => {
    localCalls.push('checkpoint');
    return taskView(proof.taskId, proof.expectedVersion + 1);
  },
  getTask: async (_c: string, taskId: string) => taskView(taskId),
  heartbeat: async (_c: string, proof: LeaseProof) => ({ ...taskView(proof.taskId), leaseExpiresAt }),
};

const localOps = {
  tools: ['ops_info'] as const,
  call: async (_c: string, _taskId: string, tool: string, args: Record<string, unknown>) => {
    opsCalls.push({ tool, args });
    return { ok: true, tool };
  },
  release: () => undefined,
};

/** 组装真实的网关三件套（IdpClient / AgentTokenCache / GatewayClient），只替换地址与身份查询。 */
function makeCloud(users: Record<string, string> = { 'eng-1': 'user-eng-1' }): CloudRoute & { tokens: AgentTokenCache } {
  const idp = new IdpClient({ issuer: `${idpBase}/t/company`, clientId: CLIENT_ID, clientSecret: () => CLIENT_SECRET });
  const tokens = new AgentTokenCache({
    exchange: async (input): Promise<IssuedToken> => {
      exchangeCalls.push(input);
      return idp.exchangeAgentToken(input);
    },
  });
  const gateway = new GatewayClient({ url: gwBase, pollMs: 1, pollTimeoutMs: 5000, sleep: async () => undefined });
  return {
    gateway,
    tokens,
    idpUserOf: (employeeId: string) => {
      identityLookups.push(employeeId);
      return users[employeeId];
    },
  };
}

function makePool(options: { cloud?: CloudRoute; withLocalOps?: boolean } = {}): SidecarPool {
  return new SidecarPool({
    core: core as never,
    workforce: { rotate: async () => 'tok-rotated' } as never,
    runDir,
    heartbeatMs: 1_000_000,
    sweepMs: 5,
    log: message => { logs.push(message); },
    ...(options.withLocalOps ? { ops: localOps } : {}),
    ...(options.cloud ? { cloud: options.cloud } : {}),
  } as SidecarDeps);
}

/** 写入一条 sck 请求，等待回复文件，并把回复原文记下来供"不出现"扫描。 */
async function send(dir: string, key: string, name: string, tool: string, args: Record<string, unknown>): Promise<Reply> {
  writeFileSync(join(reqDir(dir), `${name}.json`), JSON.stringify({ key, tool, args }));
  const path = join(resDir(dir), `${name}.json`);
  await until(() => existsSync(path));
  replies.push(readFileSync(path, 'utf8'));
  return readJsonFile<Reply>(path)!;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/** 所有落盘内容（临时目录全部文件）、日志与回复里是否出现过任何令牌或机密。 */
function sensitiveHits(): string[] {
  const hits: string[] = [];
  const haystacks: Array<[string, string]> = [];
  for (const file of walk(root)) haystacks.push([file, readFileSync(file, 'utf8')]);
  logs.forEach((line, index) => haystacks.push([`log#${index}`, line]));
  replies.forEach((text, index) => haystacks.push([`reply#${index}`, text]));
  for (const [where, text] of haystacks) {
    if (text.includes(CLIENT_SECRET)) hits.push(`${where}: client secret`);
    for (const token of issued) if (text.includes(token)) hits.push(`${where}: agent token`);
  }
  return hits;
}

/** 为员工开通通道并在云端认领任务，返回回复所需的通道信息。 */
async function claimFor(pool: SidecarPool, employee: string, taskId: string) {
  const i = inst(employee);
  const env = pool.env(i);
  const result = await pool.claim(i, task(taskId));
  expect(result?.deliveryId).toBe(`d-${taskId}`);
  return { dir: env.SCK_COMM_DIR, key: env.SCK_COMM_KEY, inst: i };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sck-cloud-route-'));
  runDir = join(root, 'comm');
  logs = [];
  replies.length = 0;
  idpCalls.length = 0;
  gwCalls.length = 0;
  issued.clear();
  jobPolls.clear();
  localCalls = [];
  exchangeCalls = [];
  identityLookups = [];
  opsCalls = [];
  leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
});

afterEach(() => {
  pool?.close();
  pool = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('路由判定', () => {
  test('ops_ 前缀与 owner 级工具走网关，任务流工具保持本地', () => {
    expect(routesToGateway('ops_info')).toBe(true);
    expect(routesToGateway('ops_login')).toBe(true);
    expect(routesToGateway('def_list')).toBe(true);
    expect(routesToGateway('def_ensure')).toBe(true);
    for (const tool of ['checkpoint', 'submit', 'review', 'report_blocker', 'get_context', 'create_task', 'media_tts', 'sync_render', 'task_project_update']) {
      expect(routesToGateway(tool)).toBe(false);
    }
  });

  test('每个网关路由的 owner 工具都对应 command-guard 中的 owner 命令', () => {
    for (const tool of CLOUD_OWNER_TOOLS) {
      const command = tool.replace(/_/g, '.');
      const owner = OWNER_API_COMMANDS.includes(command) || HARD_OWNER_ONLY.some(pattern => matchesCommand(pattern, command));
      expect(owner).toBe(true);
    }
  });
});

describe('无租约', () => {
  test('无租约的员工调用被拒，且没有查身份、没有换令牌、没有请求网关', async () => {
    pool = makePool({ cloud: makeCloud() });
    const env = pool.env(inst('eng-1'));
    const reply = await send(env.SCK_COMM_DIR, env.SCK_COMM_KEY, 'r1', 'ops_info', {});
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('no_lease');
    expect(exchangeCalls).toHaveLength(0);
    expect(idpCalls).toHaveLength(0);
    expect(identityLookups).toHaveLength(0);
    expect(gwCalls).toHaveLength(0);
  });

  test('租约已过期时同样直接拒绝，不换令牌', async () => {
    pool = makePool({ cloud: makeCloud() });
    leaseExpiresAt = new Date(Date.now() - 5_000).toISOString();
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-expired');
    const reply = await send(dir, key, 'r1', 'ops_info', {});
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('no_lease');
    expect(exchangeCalls).toHaveLength(0);
    expect(gwCalls).toHaveLength(0);
  });

  test('身份查不到时以中文原因拒绝，不换令牌', async () => {
    pool = makePool({ cloud: makeCloud({}) });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-noid');
    const reply = await send(dir, key, 'r1', 'ops_info', {});
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('agent_identity');
    expect(identityLookups).toEqual(['eng-1']);
    expect(exchangeCalls).toHaveLength(0);
    expect(gwCalls).toHaveLength(0);
  });
});

describe('有租约的网关调用', () => {
  test('换令牌带当前任务号，ttl 不超过租约剩余且不超过 900；网关收到的 Bearer 即换来的令牌', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-cloud-1');
    const reply = await send(dir, key, 'r1', 'ops_info', { taskId: 'someone-else', q: 1 });
    expect(reply).toEqual({ ok: true, data: { echoed: 'ops_info' } });

    expect(idpCalls).toHaveLength(1);
    expect(idpCalls[0]!.authorized).toBe(true);
    expect(idpCalls[0]!.subject).toBe('user-eng-1');
    expect(idpCalls[0]!.taskId).toBe('task-cloud-1');
    const ttl = Number(idpCalls[0]!.ttl);
    expect(ttl).toBeLessThanOrEqual(120);
    expect(ttl).toBeLessThanOrEqual(900);
    expect(ttl).toBeGreaterThanOrEqual(100);

    expect(gwCalls).toHaveLength(1);
    const bearer = gwCalls[0]!.auth.replace(/^Bearer /, '');
    expect(gwCalls[0]!.auth.startsWith('Bearer ')).toBe(true);
    expect(issued.has(bearer)).toBe(true);
    // 请求里的 taskId 被丢弃，只保留参数本身。
    expect(gwCalls[0]!.input).toEqual({ q: 1 });
  });

  test('租约很长时 ttl 封顶为 900 秒', async () => {
    pool = makePool({ cloud: makeCloud() });
    leaseExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-long');
    const reply = await send(dir, key, 'r1', 'ops_info', {});
    expect(reply.ok).toBe(true);
    expect(idpCalls[0]!.ttl).toBe('900');
  });

  test('同一 (员工, 任务) 的令牌被缓存，第二次调用不再换发', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-cache');
    expect((await send(dir, key, 'r1', 'ops_info', {})).ok).toBe(true);
    expect((await send(dir, key, 'r2', 'ops_info', {})).ok).toBe(true);
    expect(idpCalls).toHaveLength(1);
    expect(gwCalls.map(call => call.auth)).toEqual([gwCalls[0]!.auth, gwCalls[0]!.auth]);
  });

  test('网关返回 pending 时，按作业号轮询 ops.job.get 直到 done', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-pending');
    const reply = await send(dir, key, 'r1', 'ops_slow', {});
    expect(reply).toEqual({ ok: true, data: { value: 42 } });
    const polls = gwCalls.filter(call => call.command === 'ops.job.get');
    expect(polls).toHaveLength(3);
    for (const poll of polls) expect(poll.input).toEqual({ id: 'job-1' });
    expect(polls.every(poll => poll.auth === gwCalls[0]!.auth)).toBe(true);
  });

  test('作业失败时以中文返回，错误文本不含令牌', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-jobfail');
    const reply = await send(dir, key, 'r1', 'ops_failjob', {});
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('作业执行失败');
    for (const token of issued) expect(reply.error ?? '').not.toContain(token);
  });

  test('网关错误文本回显令牌时，返回给员工的内容已脱敏', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-leak');
    const reply = await send(dir, key, 'r1', 'ops_leak', {});
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('forbidden');
    expect(reply.error).toContain('[已隐藏]');
    for (const token of issued) expect(reply.error ?? '').not.toContain(token);
  });

  test('owner 级工具 def_list 以网关命令 def.list 转发', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-def');
    const reply = await send(dir, key, 'r1', 'def_list', {});
    expect(reply.ok).toBe(true);
    expect(gwCalls.map(call => call.command)).toEqual(['def.list']);
  });

  test('任务流工具保持本地，不查身份、不换令牌、不请求网关', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-local');
    const reply = await send(dir, key, 'r1', 'checkpoint', { text: 'half done' });
    expect(reply.ok).toBe(true);
    expect(localCalls).toEqual(['checkpoint']);
    expect(identityLookups).toHaveLength(0);
    expect(exchangeCalls).toHaveLength(0);
    expect(gwCalls).toHaveLength(0);
  });
});

describe('令牌生命周期与不泄露', () => {
  test('任务结束（endLease）即丢弃令牌；之后再调用必须重新换发', async () => {
    const cloud = makeCloud();
    pool = makePool({ cloud });
    const { dir, key, inst: i } = await claimFor(pool, 'eng-1', 'task-drop');
    expect((await send(dir, key, 'r1', 'ops_info', {})).ok).toBe(true);
    expect(cloud.tokens.size()).toBe(1);

    pool.dropLease('eng-1', 'task-drop');
    expect(cloud.tokens.size()).toBe(0);
    // 租约结束后请求被拒，不会用旧令牌继续调用网关。
    const refused = await send(dir, key, 'r2', 'ops_info', {});
    expect(refused.ok).toBe(false);
    expect(gwCalls).toHaveLength(1);

    await pool.claim(i, task('task-drop'));
    expect((await send(dir, key, 'r3', 'ops_info', {})).ok).toBe(true);
    expect(idpCalls).toHaveLength(2);
  });

  test('令牌与机密不出现在日志、临时目录任何文件、回复内容中', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-scan');
    await send(dir, key, 'r1', 'ops_info', { q: 1 });
    await send(dir, key, 'r2', 'ops_slow', {});
    await send(dir, key, 'r3', 'ops_leak', {});
    await send(dir, key, 'r4', 'ops_failjob', {});
    await send(dir, key, 'r5', 'def_list', {});
    expect(issued.size).toBeGreaterThan(0);
    expect(replies.length).toBe(5);
    expect(sensitiveHits()).toEqual([]);
  });

  test('扫描本身能发现令牌（自检，防止扫描形同虚设）', () => {
    const planted = 'agt-planted-for-self-check';
    issued.add(planted);
    writeFileSync(join(root, 'planted.txt'), `oops ${planted}`);
    try {
      expect(sensitiveHits().some(hit => hit.includes('agent token'))).toBe(true);
    } finally {
      issued.delete(planted);
      rmSync(join(root, 'planted.txt'), { force: true });
    }
  });
});

describe('本机模式', () => {
  test('不注入 cloud 时 ops_ 工具走本地 ops，不查身份、不换令牌、不请求网关', async () => {
    pool = makePool({ withLocalOps: true });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-local-mode');
    const reply = await send(dir, key, 'r1', 'ops_info', { x: 1 });
    expect(reply).toEqual({ ok: true, data: { ok: true, tool: 'ops_info' } });
    expect(opsCalls).toEqual([{ tool: 'ops_info', args: { x: 1 } }]);
    expect(identityLookups).toHaveLength(0);
    expect(exchangeCalls).toHaveLength(0);
    expect(gwCalls).toHaveLength(0);
  });
});

describe('云端运维作业在执行端的执行（runCloudOps）', () => {
  test('员工持有作业所属任务的租约：执行 ops 工具，丢弃作业里的 taskId，不换令牌、不请求网关', async () => {
    pool = makePool({ withLocalOps: true, cloud: makeCloud() });
    await claimFor(pool, 'eng-1', 'task-job-ok');
    const result = await pool.runCloudOps({ employee: 'eng-1', taskId: 'task-job-ok', tool: 'ops_info', args: { taskId: 'other', x: 1 } });
    expect(result).toEqual({ ok: true, tool: 'ops_info' });
    expect(opsCalls).toEqual([{ tool: 'ops_info', args: { x: 1 } }]);
    expect(exchangeCalls).toHaveLength(0);
    expect(gwCalls).toHaveLength(0);
  });

  test('员工没有这个任务的租约（任务不符或员工不在岗）：以 no_lease 拒绝，不执行', async () => {
    pool = makePool({ withLocalOps: true, cloud: makeCloud() });
    await claimFor(pool, 'eng-1', 'task-job-mine');
    await expect(pool.runCloudOps({ employee: 'eng-1', taskId: 'task-other', tool: 'ops_info', args: {} })).rejects.toMatchObject({ code: 'no_lease' });
    await expect(pool.runCloudOps({ employee: 'eng-2', taskId: 'task-job-mine', tool: 'ops_info', args: {} })).rejects.toMatchObject({ code: 'no_lease' });
    expect(opsCalls).toHaveLength(0);
  });

  test('租约已结束后再执行作业：以 no_lease 拒绝，不执行', async () => {
    pool = makePool({ withLocalOps: true, cloud: makeCloud() });
    await claimFor(pool, 'eng-1', 'task-job-ended');
    pool.dropLease('eng-1', 'task-job-ended');
    await expect(pool.runCloudOps({ employee: 'eng-1', taskId: 'task-job-ended', tool: 'ops_info', args: {} })).rejects.toMatchObject({ code: 'no_lease' });
    expect(opsCalls).toHaveLength(0);
  });

  test('未知运维工具：以 not_found 拒绝，不执行', async () => {
    pool = makePool({ withLocalOps: true, cloud: makeCloud() });
    await claimFor(pool, 'eng-1', 'task-job-unknown');
    await expect(pool.runCloudOps({ employee: 'eng-1', taskId: 'task-job-unknown', tool: 'ops_nope', args: {} })).rejects.toMatchObject({ code: 'not_found' });
    expect(opsCalls).toHaveLength(0);
  });

  test('执行结果里不含 agent 令牌', async () => {
    pool = makePool({ withLocalOps: true, cloud: makeCloud() });
    await claimFor(pool, 'eng-1', 'task-job-clean');
    const result = await pool.runCloudOps({ employee: 'eng-1', taskId: 'task-job-clean', tool: 'ops_info', args: {} });
    for (const token of issued) expect(JSON.stringify(result)).not.toContain(token);
    expect(issued.size).toBe(0);
  });
});

/** 同步调用抛出的错误码；不抛出返回 undefined。 */
function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('公司命令 company_cmd 与 company_cmd_catalog', () => {
  test('两个工具走网关，并列入工具表（__list__）', async () => {
    expect(routesToGateway('company_cmd')).toBe(true);
    expect(routesToGateway('company_cmd_catalog')).toBe(true);
    pool = makePool();
    const env = pool.env(inst('eng-1'));
    const reply = await send(env.SCK_COMM_DIR, env.SCK_COMM_KEY, 'r1', '__list__', {});
    expect(reply.ok).toBe(true);
    expect((reply.data as { tools: string[] }).tools).toEqual(expect.arrayContaining(['company_cmd', 'company_cmd_catalog']));
  });

  test('请求映射：company_cmd 原样取命令与输入；catalog 固定为 cmd.catalog；ops_ 与 owner 工具的命名不变', () => {
    expect(cloudRequestOf('company_cmd', { command: 'task.detail', input: { taskId: 'task:a', q: 1 } }))
      .toEqual({ command: 'task.detail', input: { taskId: 'task:a', q: 1 } });
    expect(cloudRequestOf('company_cmd', { command: 'message.list' })).toEqual({ command: 'message.list', input: {} });
    expect(cloudRequestOf('company_cmd_catalog', { anything: 1 })).toEqual({ command: 'cmd.catalog', input: {} });
    expect(cloudRequestOf('ops_info', { q: 1 })).toEqual({ command: 'ops_info', input: { q: 1 } });
    expect(cloudRequestOf('def_ensure', { id: 'x' })).toEqual({ command: 'def.ensure', input: { id: 'x' } });
    expect(codeOf(() => cloudRequestOf('company_cmd', {}))).toBe('invalid');
    expect(codeOf(() => cloudRequestOf('company_cmd', { command: 'task.list', input: ['x'] }))).toBe('invalid');
  });

  test('无租约：直接拒绝，不查身份、不换令牌、不请求网关', async () => {
    pool = makePool({ cloud: makeCloud() });
    const env = pool.env(inst('eng-1'));
    const reply = await send(env.SCK_COMM_DIR, env.SCK_COMM_KEY, 'r1', 'company_cmd', { command: 'task.list', input: {} });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('no_lease');
    expect(identityLookups).toHaveLength(0);
    expect(exchangeCalls).toHaveLength(0);
    expect(gwCalls).toHaveLength(0);
  });

  test('有租约：命令与输入原样转发，换令牌带当前任务号；请求顶层的 taskId 被丢弃', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-cmd-1');
    const reply = await send(dir, key, 'r1', 'company_cmd', { command: 'task.detail', input: { taskId: 'task:other', q: 1 }, taskId: 'someone-else' });
    expect(reply).toEqual({ ok: true, data: { echoed: 'task.detail' } });
    expect(idpCalls).toHaveLength(1);
    expect(idpCalls[0]!.taskId).toBe('task-cmd-1');
    expect(gwCalls).toHaveLength(1);
    expect(gwCalls[0]!.command).toBe('task.detail');
    // 输入里点名的任务由网关核对（见 owner-end 的 taskId 范围检查），插件不改写。
    expect(gwCalls[0]!.input).toEqual({ taskId: 'task:other', q: 1 });
    expect(gwCalls[0]!.auth.startsWith('Bearer ')).toBe(true);
  });

  test('company_cmd_catalog 固定请求 cmd.catalog，忽略传入的参数', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-cmd-catalog');
    const reply = await send(dir, key, 'r1', 'company_cmd_catalog', { anything: 1 });
    expect(reply).toEqual({ ok: true, data: { echoed: 'cmd.catalog' } });
    expect(gwCalls.map(call => [call.command, call.input])).toEqual([['cmd.catalog', {}]]);
  });

  test('网关返回 pending 时，company_cmd 按作业号轮询 ops.job.get 直到 done', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-cmd-pending');
    const reply = await send(dir, key, 'r1', 'company_cmd', { command: 'ops_slow', input: {} });
    expect(reply).toEqual({ ok: true, data: { value: 42 } });
    const polls = gwCalls.filter(call => call.command === 'ops.job.get');
    expect(polls).toHaveLength(3);
    for (const poll of polls) expect(poll.input).toEqual({ id: 'job-1' });
  });

  test('参数不合法（缺命令名、input 不是对象）：以 invalid 拒绝，不换令牌、不请求网关', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-cmd-bad');
    const missing = await send(dir, key, 'r1', 'company_cmd', { input: {} });
    const wrongInput = await send(dir, key, 'r2', 'company_cmd', { command: 'task.list', input: ['x'] });
    expect(missing.error).toContain('invalid');
    expect(wrongInput.error).toContain('invalid');
    expect(exchangeCalls).toHaveLength(0);
    expect(gwCalls).toHaveLength(0);
  });

  test('网关错误文本回显令牌时，返回给员工的内容已脱敏', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-cmd-leak');
    const reply = await send(dir, key, 'r1', 'company_cmd', { command: 'ops_leak', input: {} });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('[已隐藏]');
    for (const token of issued) expect(reply.error ?? '').not.toContain(token);
  });

  test('回复、日志与临时目录都不含令牌或机密（含 pending 与失败作业）', async () => {
    pool = makePool({ cloud: makeCloud() });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-cmd-scan');
    await send(dir, key, 'r1', 'company_cmd', { command: 'task.list', input: {} });
    await send(dir, key, 'r2', 'company_cmd', { command: 'ops_slow', input: {} });
    await send(dir, key, 'r3', 'company_cmd', { command: 'ops_leak', input: {} });
    await send(dir, key, 'r4', 'company_cmd', { command: 'ops_failjob', input: {} });
    await send(dir, key, 'r5', 'company_cmd_catalog', {});
    expect(issued.size).toBeGreaterThan(0);
    expect(replies.length).toBe(5);
    expect(sensitiveHits()).toEqual([]);
  });

  test('本机模式：两个工具都返回“需要云端执行端”，不查身份、不换令牌、不请求网关', async () => {
    pool = makePool({ withLocalOps: true });
    const { dir, key } = await claimFor(pool, 'eng-1', 'task-cmd-local');
    for (const tool of ['company_cmd', 'company_cmd_catalog']) {
      const reply = await send(dir, key, `r-${tool}`, tool, { command: 'task.list', input: {} });
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain('not_configured');
      expect(reply.error).toContain('需要云端执行端');
    }
    expect(identityLookups).toHaveLength(0);
    expect(exchangeCalls).toHaveLength(0);
    expect(gwCalls).toHaveLength(0);
  });
});
