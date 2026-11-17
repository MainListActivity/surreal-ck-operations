import { LIFECYCLE_COMMANDS } from '../../src/lifecycle-policy.ts';
import { ITERATION_COMMANDS } from '../src/iteration-commands.ts';
import { describe, expect, test } from 'bun:test';
import { RecordId } from 'surrealdb';

import { CompanyError } from '../../src/core-errors.ts';
import type { VerifiedToken } from '../src/auth/jwt.ts';
import type { Caller } from '../src/auth/caller.ts';
import { parseCommandBody, requireOwner, runCommand, type GatewayDeps } from '../src/commands.ts';
import { COMMAND_CATALOG } from '../src/command-catalog.ts';
import type { Sessions } from '../src/db.ts';
import { fakeDb, fakeSessions, json, scriptedFetch, testConfig, type FakeCall } from './_support.ts';

// 命令分流的单测：通过 runCommand 驱动，会话全部用假数据库替身，不访问网络、不读 process.env。
const NOW = new Date('2026-11-08T10:00:00Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

const verified = (ac: string, extra: Partial<VerifiedToken> = {}): VerifiedToken => ({
  token: 'token-fixture',
  sub: 'owner-user',
  ac,
  roles: ['Owner'],
  exp: NOW_SEC + 900,
  ...extra,
});

const ownerCaller: Caller = { kind: 'owner', sub: 'owner-user', token: verified('owner') };

/** 员工调用方：令牌绑定任务 t1，sub 为 ma_hono 的 agent 用户 id。 */
const agentCaller: Caller = {
  kind: 'agent',
  sub: 'agent-user-1',
  task: 't1',
  token: verified('agent', { sub: 'agent-user-1', task: 't1' }),
};

const systemCaller = (ac: string): Caller => ({
  kind: 'system',
  ac,
  sub: `${ac}-identity`,
  token: verified(ac, { sub: `${ac}-identity` }),
});

function depsWith(sessions: Sessions, waitMs = 0): GatewayDeps {
  return { cfg: testConfig(), sessions, now: () => NOW, waitMs };
}

/** 收集调用方法抛出的错误；不抛出则测试失败。 */
async function errorOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

function syncErrorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

const auditsOf = (calls: FakeCall[]): FakeCall[] => calls.filter((call) => call.sql.startsWith('CREATE ops_audit'));

/** 员工路径用的网关假库：按语句返回身份、策略、保护清单与任务租约。 */
function agentGateway(rows: {
  identity?: unknown[];
  policy?: unknown[];
  protectedRows?: unknown[];
  task?: unknown[];
  /** 作业详情（SELECT * FROM $job）。 */
  job?: unknown[];
  /** 作业的发起人（jobOwnedBy 的 SELECT actor_kind, actor）。 */
  jobOwner?: unknown[];
  /** 消息记录（读取与更新 $msg 时返回）。 */
  message?: unknown[];
  /** 按任务号返回任务行（给出时 FROM $task 只看这张表，缺的任务返回空）；否则所有任务都返回 task。 */
  tasks?: Record<string, unknown[]>;
}) {
  return fakeDb((sql, vars) => {
    if (sql.includes('FROM agent_identity')) return rows.identity ?? [];
    if (sql.includes('FROM agent_policy')) return rows.policy ?? [];
    if (sql.includes('FROM protected_command')) return rows.protectedRows ?? [];
    if (sql.includes('FROM $msg') || sql.startsWith('UPDATE $msg')) return rows.message ?? [];
    if (sql.includes('FROM $task')) {
      if (rows.tasks) return rows.tasks[String((vars.task as RecordId | undefined)?.id)] ?? [];
      return rows.task ?? [];
    }
    if (sql.startsWith('SELECT actor_kind, actor FROM $job')) return rows.jobOwner ?? [];
    if (sql.includes('FROM $job')) return rows.job ?? [];
    return [];
  });
}

const VALID_LEASE = [{ current_employee: 'alice', lease_expires_at: NOW_SEC + 3600 }];
const IDENTITY_ALICE = [{ employee: 'alice' }];

describe('parseCommandBody 请求体解析', () => {
  test('非对象的请求体（字符串、null、数组）都是 invalid', () => {
    for (const body of ['status', null, ['status']]) {
      const error = syncErrorOf(() => parseCommandBody(body));
      expect(error).toBeInstanceOf(CompanyError);
      expect((error as CompanyError).code).toBe('invalid');
    }
  });

  test('非法命令名（大写、含空格、超过 120 个字符）都是 invalid，120 个字符仍合法', () => {
    const illegal = ['Status', 'task list', 'a'.repeat(121), '', '1abc'];
    for (const command of illegal) {
      const error = syncErrorOf(() => parseCommandBody({ command }));
      expect((error as CompanyError).code).toBe('invalid');
    }
    expect(parseCommandBody({ command: 'a'.repeat(120) }).command).toHaveLength(120);
  });

  test('input 不是对象（字符串、数组）是 invalid', () => {
    for (const input of ['x', []]) {
      const error = syncErrorOf(() => parseCommandBody({ command: 'status', input }));
      expect((error as CompanyError).code).toBe('invalid');
    }
  });

  test('缺省 input 得到空对象，合法请求体原样解析', () => {
    expect(parseCommandBody({ command: 'status' })).toEqual({ command: 'status', input: {} });
    expect(parseCommandBody({ command: 'ops.job.list', input: { limit: 5 } })).toEqual({
      command: 'ops.job.list',
      input: { limit: 5 },
    });
  });
});

describe('requireOwner 老板校验', () => {
  test('员工与系统身份都返回 forbidden 并提示当前账号不是老板', () => {
    const error = syncErrorOf(() => requireOwner(agentCaller));
    expect(error).toBeInstanceOf(CompanyError);
    expect((error as CompanyError).code).toBe('forbidden');
    expect((error as CompanyError).message).toBe('当前账号不是老板');
    expect((syncErrorOf(() => requireOwner(systemCaller('runner'))) as CompanyError).message).toBe('当前账号不是老板');
  });

  test('老板身份原样返回', () => {
    expect(requireOwner(ownerCaller)).toBe(ownerCaller as Extract<Caller, { kind: 'owner' }>);
  });
});

describe('系统身份调用老板命令', () => {
  test('运行器令牌调用老板命令被拒，并写入 runner 的 denied 审计', async () => {
    const gateway = fakeDb();
    const deps = depsWith(fakeSessions(gateway.db));
    const error = await errorOf(() => runCommand(deps, systemCaller('runner'), 'status', {}));
    expect(error).toBeInstanceOf(CompanyError);
    expect((error as CompanyError).code).toBe('forbidden');
    const [audit] = auditsOf(gateway.calls);
    expect(audit).toBeDefined();
    expect(audit!.vars.actorKind).toBe('runner');
    expect(audit!.vars.outcome).toBe('denied');
    expect(audit!.vars.command).toBe('status');
  });

  test('定时任务令牌调用 guard.list 被拒，并写入 automation 的 denied 审计', async () => {
    const gateway = fakeDb();
    const deps = depsWith(fakeSessions(gateway.db));
    const error = await errorOf(() => runCommand(deps, systemCaller('automation'), 'guard.list', {}));
    expect((error as CompanyError).code).toBe('forbidden');
    const [audit] = auditsOf(gateway.calls);
    expect(audit!.vars.actorKind).toBe('automation');
    expect(audit!.vars.outcome).toBe('denied');
    expect(audit!.vars.command).toBe('guard.list');
  });

  test('网关、查看者、迁移令牌直接 forbidden，不写审计', async () => {
    for (const ac of ['gateway', 'viewer', 'migrator']) {
      const gateway = fakeDb();
      const deps = depsWith(fakeSessions(gateway.db));
      const error = await errorOf(() => runCommand(deps, systemCaller(ac), 'status', {}));
      expect(error).toBeInstanceOf(CompanyError);
      expect((error as CompanyError).code).toBe('forbidden');
      expect(auditsOf(gateway.calls)).toHaveLength(0);
    }
  });
});

describe('老板命令的执行与审计', () => {
  test('只读命令 ops.job.list 返回结果，且不写审计', async () => {
    const owner = fakeDb();
    const deps = depsWith(fakeSessions(owner.db));
    const result = await runCommand(deps, ownerCaller, 'ops.job.list', {});
    expect(result).toEqual({ jobs: [] });
    expect(auditsOf(owner.calls)).toHaveLength(0);
  });

  test('写命令 guard.protect 写入 protected_command，并写 ok 审计（摘要可读）', async () => {
    const owner = fakeDb();
    const deps = depsWith(fakeSessions(owner.db));
    const result = await runCommand(deps, ownerCaller, 'guard.protect', { command: 'x.y' });
    expect(result).toEqual({ command: 'x.y', ownerOnly: true });
    expect(owner.calls.some((call) => call.sql.startsWith('UPSERT $rid SET command'))).toBe(true);
    const audits = auditsOf(owner.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('ok');
    expect(audits[0]!.vars.actorKind).toBe('owner');
    expect(audits[0]!.vars.actor).toBe('owner-user');
    expect(audits[0]!.vars.summary).toBe('guard.protect 命令=x.y');
  });

});

describe('员工调用的命令守卫与审计', () => {
  test('a. 令牌没有登记的员工身份：forbidden，denied 审计 actor 退回为令牌 sub', async () => {
    const gateway = agentGateway({ identity: [], task: VALID_LEASE });
    const deps = depsWith(fakeSessions(gateway.db));
    const error = await errorOf(() => runCommand(deps, agentCaller, 'db.read', { sql: 'SELECT 1' }));
    expect((error as CompanyError).code).toBe('forbidden');
    expect((error as CompanyError).message).toBe('该令牌没有登记的员工身份');
    const audits = auditsOf(gateway.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('denied');
    expect(audits[0]!.vars.actorKind).toBe('agent');
    expect(audits[0]!.vars.actor).toBe('agent-user-1');
    expect(audits[0]!.vars.command).toBe('db.read');
    expect((audits[0]!.vars.task as RecordId).id).toBe('t1');
    expect(String(audits[0]!.vars.reason)).toBe('该令牌没有登记的员工身份');
  });

  test('b. 员工已停用（agent_policy.disabled 为 true）：forbidden，denied 审计', async () => {
    const gateway = agentGateway({ identity: IDENTITY_ALICE, policy: [{ disabled: true }], task: VALID_LEASE });
    const deps = depsWith(fakeSessions(gateway.db));
    const error = await errorOf(() => runCommand(deps, agentCaller, 'db.read', { sql: 'SELECT 1' }));
    expect((error as CompanyError).code).toBe('forbidden');
    expect((error as CompanyError).message).toBe('该员工已停用');
    const audits = auditsOf(gateway.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('denied');
    expect(audits[0]!.vars.actor).toBe('alice');
    expect(String(audits[0]!.vars.reason)).toBe('该员工已停用');
  });

  test('c. 写死的老板专属命令（db.write、agent.policy.set、guard.protect）：forbidden，denied 审计', async () => {
    for (const command of ['db.write', 'agent.policy.set', 'guard.protect']) {
      const gateway = agentGateway({ identity: IDENTITY_ALICE, task: VALID_LEASE });
      const deps = depsWith(fakeSessions(gateway.db));
      const error = await errorOf(() => runCommand(deps, agentCaller, command, {}));
      expect((error as CompanyError).code).toBe('forbidden');
      expect((error as CompanyError).message).toBe('老板专属命令，只有老板可以调用');
      const audits = auditsOf(gateway.calls);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.vars.outcome).toBe('denied');
      expect(audits[0]!.vars.command).toBe(command);
    }
  });

  test('d. 老板保护的命令（protected_command 的 owner_only 为 true，精确匹配）：forbidden，denied 审计', async () => {
    const gateway = agentGateway({
      identity: IDENTITY_ALICE,
      protectedRows: [{ command: 'x.y', owner_only: true }],
      task: VALID_LEASE,
    });
    const deps = depsWith(fakeSessions(gateway.db));
    const error = await errorOf(() => runCommand(deps, agentCaller, 'x.y', {}));
    expect((error as CompanyError).code).toBe('forbidden');
    expect((error as CompanyError).message).toBe('老板保护的命令，只有老板可以调用');
    const audits = auditsOf(gateway.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('denied');
    expect(audits[0]!.vars.command).toBe('x.y');
  });

  test('e. 没有有效租约（任务被其它员工持有，或租约已过期）：forbidden，denied 审计', async () => {
    const otherHolder = agentGateway({
      identity: IDENTITY_ALICE,
      task: [{ current_employee: 'bob', lease_expires_at: NOW_SEC + 3600 }],
    });
    const expired = agentGateway({
      identity: IDENTITY_ALICE,
      task: [{ current_employee: 'alice', lease_expires_at: NOW_SEC - 1 }],
    });
    for (const gateway of [otherHolder, expired]) {
      const deps = depsWith(fakeSessions(gateway.db));
      const error = await errorOf(() => runCommand(deps, agentCaller, 'db.read', { sql: 'SELECT 1' }));
      expect((error as CompanyError).code).toBe('forbidden');
      expect((error as CompanyError).message).toBe('没有该任务的有效租约');
      const audits = auditsOf(gateway.calls);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.vars.outcome).toBe('denied');
      expect(String(audits[0]!.vars.reason)).toBe('没有该任务的有效租约');
    }
  });

  test('f. 有有效租约、通过守卫且不在硬锁里的命令（message.list）：走网关令牌执行，写 ok 审计（actor 为员工）', async () => {
    const gateway = agentGateway({ identity: IDENTITY_ALICE, task: VALID_LEASE });
    const deps = depsWith(fakeSessions(gateway.db));
    const result = await runCommand(deps, agentCaller, 'message.list', {});
    expect(result).toEqual({ messages: [] });
    const audits = auditsOf(gateway.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('ok');
    expect(audits[0]!.vars.actor).toBe('alice');
    expect(audits[0]!.vars.actorKind).toBe('agent');
    expect((audits[0]!.vars.task as RecordId).id).toBe('t1');
  });

  test('g. 有有效租约的 db.read：走查看者会话执行 SELECT，返回结果，写 ok 审计（actor 为员工 id）', async () => {
    const gateway = agentGateway({ identity: IDENTITY_ALICE, task: VALID_LEASE });
    const viewer = fakeDb((sql) => (sql.startsWith('SELECT') ? [{ name: 'row-1' }] : []));
    const sessions = { ...fakeSessions(gateway.db), viewer: async () => viewer.db };
    const deps = depsWith(sessions);
    const result = await runCommand(deps, agentCaller, 'db.read', { sql: 'SELECT name FROM task;' });
    expect(result).toEqual({ results: [[{ name: 'row-1' }]] });
    expect(viewer.calls.some((call) => call.sql.startsWith('SELECT name FROM task'))).toBe(true);
    expect(gateway.calls.some((call) => call.sql.startsWith('SELECT name FROM task'))).toBe(false);
    const audits = auditsOf(gateway.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('ok');
    expect(audits[0]!.vars.actor).toBe('alice');
    expect(audits[0]!.vars.actorKind).toBe('agent');
  });

  test('h. 有有效租约，但老板观测命令在员工拒绝清单里（ops.job.list、audit.list）：forbidden 只能由老板调用，denied 审计', async () => {
    for (const command of ['ops.job.list', 'audit.list', ...ITERATION_COMMANDS, ...LIFECYCLE_COMMANDS]) {
      const gateway = agentGateway({ identity: IDENTITY_ALICE, task: VALID_LEASE });
      const deps = depsWith(fakeSessions(gateway.db));
      const error = await errorOf(() => runCommand(deps, agentCaller, command, {}));
      expect((error as CompanyError).code).toBe('forbidden');
      expect((error as CompanyError).message).toBe('该命令只能由老板调用');
      const audits = auditsOf(gateway.calls);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.vars.outcome).toBe('denied');
      expect(audits[0]!.vars.command).toBe(command);
    }
  });

  test('i. 员工调用执行端命令（ops_call）：以员工身份排队（actor_kind 为 agent，actor 为员工，task 为当前任务），完成后返回结果，写 ok 审计', async () => {
    for (const command of ['ops_call']) {
      const gateway = agentGateway({
        identity: IDENTITY_ALICE,
        task: VALID_LEASE,
        job: [{ id: 'job-i', command, state: 'done', result: '{"ok":1}' }],
      });
      const deps = depsWith(fakeSessions(gateway.db), 0);
      const result = await runCommand(deps, agentCaller, command, { tool: 'x' });
      expect(result).toEqual({ ok: 1 });
      const created = gateway.calls.find((call) => call.sql.startsWith('CREATE $job'));
      expect(created).toBeDefined();
      const content = created!.vars.content as Record<string, unknown>;
      expect(content).toMatchObject({ command, actor_kind: 'agent', actor: 'alice', state: 'queued' });
      expect((content.task as RecordId).id).toBe('t1');
      const audits = auditsOf(gateway.calls);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.vars.outcome).toBe('ok');
      expect(audits[0]!.vars.actor).toBe('alice');
    }
  });

  test('j. 员工命中按目标的硬锁（公司租户的客户端、服务主体的写入、老板端 Worker 的 cf.api）：forbidden，denied 审计，且不发出任何请求', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['idp.client.create', { role: 'runner' }],
      ['idp.request', { method: 'POST', path: '/admin/service-principals', body: {} }],
      ['cf.api', { method: 'PUT', path: '/accounts/acc123/workers/scripts/company-owner-end/secrets', body: {} }],
    ];
    for (const [command, input] of cases) {
      const gateway = agentGateway({ identity: IDENTITY_ALICE, task: VALID_LEASE });
      const { fetch, requests } = scriptedFetch([]);
      const deps = { ...depsWith(fakeSessions(gateway.db)), fetch };
      const error = await errorOf(() => runCommand(deps, agentCaller, command, input));
      expect((error as CompanyError).code).toBe('forbidden');
      expect((error as CompanyError).message.startsWith('按目标锁定：')).toBe(true);
      expect(requests).toHaveLength(0);
      const audits = auditsOf(gateway.calls);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.vars.outcome).toBe('denied');
      expect(audits[0]!.vars.command).toBe(command);
      expect(String(audits[0]!.vars.summary).startsWith(command)).toBe(true);
    }
  });

  test('k. ops.job.get：员工只能取本员工发起的作业；他人、老板发起与不存在的作业都返回 forbidden（denied 审计）', async () => {
    const notMine: unknown[][] = [[{ actor_kind: 'agent', actor: 'bob' }], [{ actor_kind: 'owner', actor: 'alice' }], []];
    for (const jobOwner of notMine) {
      const gateway = agentGateway({
        identity: IDENTITY_ALICE,
        task: VALID_LEASE,
        jobOwner,
        job: [{ id: 'job-k', command: 'ops_call', state: 'done', result: '{}' }],
      });
      const deps = depsWith(fakeSessions(gateway.db));
      const error = await errorOf(() => runCommand(deps, agentCaller, 'ops.job.get', { id: 'job-k' }));
      expect((error as CompanyError).code).toBe('forbidden');
      expect((error as CompanyError).message).toBe('只能查看本员工发起的作业');
      const audits = auditsOf(gateway.calls);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.vars.outcome).toBe('denied');
    }
    const mine = agentGateway({
      identity: IDENTITY_ALICE,
      task: VALID_LEASE,
      jobOwner: [{ actor_kind: 'agent', actor: 'alice' }],
      job: [{ id: 'job-k', command: 'ops_call', state: 'done', result: '{"ok":1}' }],
    });
    const result = await runCommand(depsWith(fakeSessions(mine.db)), agentCaller, 'ops.job.get', { id: 'job-k' });
    expect(result).toMatchObject({ job: { id: 'job-k', state: 'done', result: { ok: 1 } } });
    const audits = auditsOf(mine.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('ok');
  });

  test('l. 老板命令用老板自己的令牌连库：sessions.owner 收到老板令牌，不会调用网关令牌', async () => {
    const owner = fakeDb();
    const used: string[] = [];
    const sessions: Sessions = {
      owner: async (token) => {
        used.push(`owner:${token}`);
        return owner.db;
      },
      gateway: async () => {
        used.push('gateway');
        return owner.db;
      },
      viewer: async () => {
        used.push('viewer');
        return owner.db;
      },
      automation: async () => {
        used.push('automation');
        return owner.db;
      },
    };
    await runCommand(depsWith(sessions), ownerCaller, 'guard.list', {});
    expect(used).toEqual(['owner:token-fixture']);
  });

  test('m. 老板始终放行按目标的硬锁：idp.client.create 与老板端 Worker 的 cf.api 不被拦截（缺少配置返回 not_configured，不是 forbidden），写 error 审计', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['idp.client.create', { role: 'runner' }],
      ['cf.api', { method: 'PUT', path: '/accounts/acc123/workers/scripts/company-owner-end/secrets', body: {} }],
    ];
    for (const [command, input] of cases) {
      const owner = fakeDb();
      const error = await errorOf(() => runCommand(depsWith(fakeSessions(owner.db)), ownerCaller, command, input));
      expect((error as CompanyError).code).toBe('not_configured');
      const audits = auditsOf(owner.calls);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.vars.outcome).toBe('error');
      expect(audits[0]!.vars.actorKind).toBe('owner');
    }
  });

  test('n. guard.list 返回写死清单：仅老板的 6 条、员工拒绝清单、按目标锁定的规则与公司租户 id（来自配置）', async () => {
    const owner = fakeDb();
    const deps = { ...depsWith(fakeSessions(owner.db)), cfg: testConfig({ IDP_TENANT_ID: '46aa29a6-9ee8-4052-bccd-7923f98220d7' }) };
    const result = await runCommand(deps, ownerCaller, 'guard.list', {}) as Record<string, unknown>;
    expect(result.hardOwnerOnly).toEqual(['guard.*', 'agent.*', 'owner.login.*', 'owner.settings.*', 'def.*', 'db.write']);
    expect(result.ownerOnlyForAgents).toEqual(['ops.job.list', 'audit.list', ...ITERATION_COMMANDS, ...LIFECYCLE_COMMANDS]);
    expect(result.lockedTargets).toMatchObject({
      companyTenantId: '46aa29a6-9ee8-4052-bccd-7923f98220d7',
      companyHost: 'company.maplayer.top',
    });
    expect(result.targetLocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'idp.*' }),
      expect.objectContaining({ command: 'cf.api' }),
    ]));
  });
});

describe('命令目录（cmd.catalog）与员工的任务范围', () => {
  const messageRow = (id: string, task: string) => ({
    id: new RecordId('outbound_message', id), task: new RecordId('task', task), step: 'execute', role: 'engineering',
    body: '正文', state: 'draft', hold: false, created_at: '2026-11-08T09:00:00Z',
  });

  test('cmd.catalog：老板拿到全部命令，只读不写审计', async () => {
    const owner = fakeDb();
    const deps = depsWith(fakeSessions(owner.db));
    const result = await runCommand(deps, ownerCaller, 'cmd.catalog', {}) as { scope: string; commands: unknown[] };
    expect(result.scope).toBe('owner');
    expect(result.commands).toHaveLength(COMMAND_CATALOG.length);
    expect(auditsOf(owner.calls)).toHaveLength(0);
  });

  test('cmd.catalog：员工只看到自己能调用的命令，并写 ok 审计（员工的调用无论读写都记）', async () => {
    const gateway = agentGateway({ identity: IDENTITY_ALICE, task: VALID_LEASE, policy: [{ deny: ['route.save'] }] });
    const deps = depsWith(fakeSessions(gateway.db));
    const result = await runCommand(deps, agentCaller, 'cmd.catalog', {}) as { scope: string; commands: Array<{ command: string }> };
    const names = result.commands.map((item) => item.command);
    expect(result.scope).toBe('agent');
    expect(names).toContain('message.list');
    expect(names).not.toContain('route.save');
    expect(names).not.toContain('guard.protect');
    const audits = auditsOf(gateway.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('ok');
    expect(audits[0]!.vars.command).toBe('cmd.catalog');
  });

  test('员工可读取任务资料，但不再控制本任务或其他任务的派工', async () => {
    const gateway = agentGateway({ identity: IDENTITY_ALICE, task: VALID_LEASE, message: [messageRow('m1', 't1')] });
    expect(await runCommand(depsWith(fakeSessions(gateway.db)), agentCaller, 'message.list', { taskId: 't2' })).toEqual({ messages: [] });
    for (const command of ['message.hold', 'task.revoke', 'task.create']) {
      await expect(runCommand(depsWith(fakeSessions(gateway.db)), agentCaller, command, { messageId: 'm1', taskId: 't1' })).rejects.toThrow();
    }
    expect(gateway.calls.some(call => call.sql.startsWith('UPDATE $msg'))).toBe(false);
  });

});

describe('board.task：员工与老板的读取范围与审计', () => {
  // 看板内容由根目录的 board-task 与 cloud-sidecar-route 测试覆盖；这里只核对守卫、审计与读取范围。
  // 时间由网关的服务端时钟决定（depsWith 的 now），与判定租约的时钟一致；员工输入里的 now 不参与判断。
  const at = NOW.getTime();

  test('员工持有有效租约：可读本任务的派工状态，写 ok 审计（actor 为员工、带任务）', async () => {
    const gateway = agentGateway({ identity: IDENTITY_ALICE, tasks: { t1: VALID_LEASE } });
    const result = await runCommand(depsWith(fakeSessions(gateway.db)), agentCaller, 'board.task', { taskId: 't1' });
    expect(result).toMatchObject({ taskId: 't1', holder: { employeeId: 'alice', leaseActive: true }, waiting: { on: 'employee', kind: 'lease' } });
    const audits = auditsOf(gateway.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars).toMatchObject({ outcome: 'ok', actor: 'alice', actorKind: 'agent', command: 'board.task' });
    expect((audits[0]!.vars.task as RecordId).id).toBe('t1');
  });

  test('员工持有任一有效租约即可读其他任务的派工状态（与 message.list 同一读取范围）', async () => {
    const gateway = agentGateway({
      identity: IDENTITY_ALICE,
      tasks: { t1: VALID_LEASE, t2: [{ current_employee: 'bob', lease_expires_at: NOW_SEC + 3600 }] },
    });
    const result = await runCommand(depsWith(fakeSessions(gateway.db)), agentCaller, 'board.task', { taskId: 't2' });
    expect(result).toMatchObject({ taskId: 't2', holder: { employeeId: 'bob', leaseActive: true } });
    expect(auditsOf(gateway.calls)[0]!.vars.outcome).toBe('ok');
  });

  test('员工传入的 now 不改变租约结论：过期的租约仍按服务端时钟判为已过期', async () => {
    const gateway = agentGateway({
      identity: IDENTITY_ALICE,
      tasks: { t1: VALID_LEASE, t2: [{ current_employee: 'bob', lease_expires_at: NOW_SEC - 60 }] },
    });
    const honest = await runCommand(depsWith(fakeSessions(gateway.db)), agentCaller, 'board.task', { taskId: 't2' });
    // 员工说现在是两分钟前，那时 t2 的租约还有效；服务端时钟没变，结论也不变。
    const claimed = await runCommand(depsWith(fakeSessions(gateway.db)), agentCaller, 'board.task', { taskId: 't2', now: at - 120_000 });
    expect(honest).toMatchObject({ taskId: 't2', holder: { employeeId: 'bob', leaseActive: false }, waiting: { on: 'scheduler', kind: 'lease_lapsed' } });
    expect(claimed).toEqual(honest);
  });

  test('员工没有有效租约（任务由别人持有，或租约已过期）：forbidden，denied 审计，且不读派工状态', async () => {
    const otherHolder = agentGateway({ identity: IDENTITY_ALICE, task: [{ current_employee: 'bob', lease_expires_at: NOW_SEC + 3600 }] });
    const expired = agentGateway({ identity: IDENTITY_ALICE, task: [{ current_employee: 'alice', lease_expires_at: NOW_SEC - 1 }] });
    for (const gateway of [otherHolder, expired]) {
      const error = await errorOf(() => runCommand(depsWith(fakeSessions(gateway.db)), agentCaller, 'board.task', { taskId: 't1' }));
      expect((error as CompanyError).code).toBe('forbidden');
      expect((error as CompanyError).message).toBe('没有该任务的有效租约');
      const audits = auditsOf(gateway.calls);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.vars).toMatchObject({ outcome: 'denied', command: 'board.task' });
      expect(gateway.calls.some(call => call.sql.includes('FROM task WHERE state IN'))).toBe(false);
    }
  });

  test('老板读取派工状态：只读，不写审计', async () => {
    const owner = fakeDb((sql) => (sql.includes('FROM $task') ? [{ id: new RecordId('task', 't1'), title: '任务一', state: 'doing' }] : []));
    const result = await runCommand(depsWith(fakeSessions(owner.db)), ownerCaller, 'board.task', { taskId: 't1' });
    expect(result).toMatchObject({ taskId: 't1', title: '任务一', state: 'doing', waiting: { on: 'scheduler', kind: 'not_queued' } });
    expect(auditsOf(owner.calls)).toHaveLength(0);
  });

  test('员工目录列出 board.task（只读），老板观测命令不在员工目录里', async () => {
    const gateway = agentGateway({ identity: IDENTITY_ALICE, task: VALID_LEASE });
    const result = await runCommand(depsWith(fakeSessions(gateway.db)), agentCaller, 'cmd.catalog', {}) as { commands: Array<{ command: string; readOnly?: boolean }> };
    expect(result.commands.find(item => item.command === 'board.task')).toMatchObject({ readOnly: true });
    expect(result.commands.map(item => item.command)).not.toContain('ops.job.list');
  });
});
