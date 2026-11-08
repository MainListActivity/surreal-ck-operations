import { describe, expect, test } from 'bun:test';
import { RecordId } from 'surrealdb';

import { CompanyError } from '../../src/core-errors.ts';
import type { VerifiedToken } from '../src/auth/jwt.ts';
import type { Caller } from '../src/auth/caller.ts';
import { parseCommandBody, requireOwner, runCommand, type GatewayDeps } from '../src/commands.ts';
import { PendingJob } from '../src/jobs.ts';
import { fakeDb, fakeSessions, testConfig, type FakeCall } from './_support.ts';

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

function depsWith(sessions: ReturnType<typeof fakeSessions>, waitMs = 0): GatewayDeps {
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
}) {
  return fakeDb((sql) => {
    if (sql.includes('FROM agent_identity')) return rows.identity ?? [];
    if (sql.includes('FROM agent_policy')) return rows.policy ?? [];
    if (sql.includes('FROM protected_command')) return rows.protectedRows ?? [];
    if (sql.includes('FROM $task')) return rows.task ?? [];
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

  test('老板调用执行端命令 upgrade.start：排队后在第一次轮询即完成，返回解析后的结果并写 ok 审计', async () => {
    const owner = fakeDb((sql) => (sql.startsWith('SELECT')
      ? [{ id: 'job-1', command: 'upgrade.start', state: 'done', result: '{"ok":1}' }]
      : []));
    const deps = depsWith(fakeSessions(owner.db), 0);
    const result = await runCommand(deps, ownerCaller, 'upgrade.start', {});
    expect(result).toEqual({ ok: 1 });
    const created = owner.calls.find((call) => call.sql.startsWith('CREATE $job'));
    expect(created).toBeDefined();
    const audits = auditsOf(owner.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('ok');
    expect(audits[0]!.vars.command).toBe('upgrade.start');
  });

  test('upgrade.list 按只读后缀判定不写审计，但仍排队并返回结果', async () => {
    const owner = fakeDb((sql) => (sql.startsWith('SELECT')
      ? [{ id: 'job-2', command: 'upgrade.list', state: 'done', result: '{"ok":1}' }]
      : []));
    const deps = depsWith(fakeSessions(owner.db), 0);
    const result = await runCommand(deps, ownerCaller, 'upgrade.list', {});
    expect(result).toEqual({ ok: 1 });
    expect(owner.calls.some((call) => call.sql.startsWith('CREATE $job'))).toBe(true);
    expect(auditsOf(owner.calls)).toHaveLength(0);
  });

  test('执行端始终未完成（等待为 0）：抛出 PendingJob，带任务号，审计 reason 以“已排队”开头', async () => {
    const owner = fakeDb((sql) => (sql.startsWith('SELECT')
      ? [{ id: 'job-3', command: 'upgrade.start', state: 'queued' }]
      : []));
    const deps = depsWith(fakeSessions(owner.db), 0);
    const error = await errorOf(() => runCommand(deps, ownerCaller, 'upgrade.start', {}));
    expect(error).toBeInstanceOf(PendingJob);
    expect(typeof (error as PendingJob).jobId).toBe('string');
    expect((error as PendingJob).jobId.length).toBeGreaterThan(0);
    const audits = auditsOf(owner.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('ok');
    expect(String(audits[0]!.vars.reason).startsWith('已排队')).toBe(true);
  });

  test('执行端返回 error：抛出对应的 CompanyError，审计 outcome 为 error', async () => {
    const owner = fakeDb((sql) => (sql.startsWith('SELECT')
      ? [{ id: 'job-4', command: 'upgrade.start', state: 'error', error: '{"code":"forbidden","message":"no"}' }]
      : []));
    const deps = depsWith(fakeSessions(owner.db), 0);
    const error = await errorOf(() => runCommand(deps, ownerCaller, 'upgrade.start', {}));
    expect(error).toBeInstanceOf(CompanyError);
    expect((error as CompanyError).code).toBe('forbidden');
    expect((error as CompanyError).message).toBe('no');
    const audits = auditsOf(owner.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('error');
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

  test('c. 写死的老板专属命令（task.create、message.edit、db.write）：forbidden，denied 审计', async () => {
    for (const command of ['task.create', 'message.edit', 'db.write']) {
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

  test('f. 有有效租约、命令通过守卫但不在员工白名单（note.add）：forbidden 只能由老板调用，denied 审计', async () => {
    const gateway = agentGateway({ identity: IDENTITY_ALICE, task: VALID_LEASE });
    const deps = depsWith(fakeSessions(gateway.db));
    const error = await errorOf(() => runCommand(deps, agentCaller, 'note.add', { lane: 'x', text: 'y' }));
    expect((error as CompanyError).code).toBe('forbidden');
    expect((error as CompanyError).message).toBe('该命令只能由老板调用');
    const audits = auditsOf(gateway.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('denied');
    expect(audits[0]!.vars.actor).toBe('alice');
    expect((audits[0]!.vars.task as RecordId).id).toBe('t1');
    expect(String(audits[0]!.vars.reason)).toBe('该命令只能由老板调用');
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

  test('h. 有有效租约，但老板命令不在员工白名单（ops.job.list）：forbidden 只能由老板调用，denied 审计', async () => {
    const gateway = agentGateway({ identity: IDENTITY_ALICE, task: VALID_LEASE });
    const deps = depsWith(fakeSessions(gateway.db));
    const error = await errorOf(() => runCommand(deps, agentCaller, 'ops.job.list', {}));
    expect((error as CompanyError).code).toBe('forbidden');
    expect((error as CompanyError).message).toBe('该命令只能由老板调用');
    const audits = auditsOf(gateway.calls);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.vars.outcome).toBe('denied');
    expect(audits[0]!.vars.command).toBe('ops.job.list');
  });
});
