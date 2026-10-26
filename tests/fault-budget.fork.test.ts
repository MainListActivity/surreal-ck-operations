/**
 * SYS04 · The persistent recovery budget, the atomic reservation and the block convergence, on the real core and
 * the company fork.
 *
 * The rules under test (AC01, AC02, AC03, AC04):
 *
 * - The budget of a fault object is spent **before** the attempt runs, and it survives a holder change, a lease
 *   change, a process restart and a concurrent call: the server is the one that refuses.
 * - Only a connect timeout, a connection reset and an explicitly retryable 5xx may be recovered. A 403, a
 *   rejected password, a revoked permission and an invalid input stop the recovery at once.
 * - The same cause reported ten times is one episode and one management notice. Only new evidence, a
 *   configuration change or the repair finishing may open a new stage.
 * - A budget that runs out produces one structured diagnostic and one repair chain; the original task then waits
 *   on that repair as a normal dependency, and a resume may not walk past it.
 *
 * The clock is injected, so the arithmetic is exact and the tests do not sleep.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { FaultStore } from '../src/fault-store.ts';
import { budgetKey, classifyFault, faultFingerprint, incidentKey, type FaultBudgetLimits, type FaultPhase, type FaultTargetKind } from '../src/faults.ts';
import type { ClaimResult, CreateTask, Evidence } from '../src/contracts.ts';

const NS = 'sck_agent_company_test_fault_budget';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(180_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-fault-budget-'));
const tokens: Record<string, string> = {};

/** The controlled clock: the tests move it, so no test sleeps and the arithmetic is exact. */
let clock = 1_700_000_000_000;
const now = () => clock;
const limits: FaultBudgetLimits = { maxAttempts: 3, totalDeadlineMs: 120_000, minIntervalMs: 2_000, backoffMs: 5_000, jitter: 0 };

const core = new SurrealCompanyCore(database, { faults: { limits, clock: now } });

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  const enrollment = new LocalEnrollmentAdmin(database);
  for (const [name, role, caps] of [
    ['gm', 'gm', ['execute', 'review', 'manage']],
    ['eng', 'engineering', ['execute', 'review']],
    ['eng2', 'engineering', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`t-${name}`, role, caps);
});

afterAll(async () => {
  rmSync(credDir, { recursive: true, force: true });
});

beforeEach(async () => {
  clock = 1_700_000_000_000;
  await database.db.query('DELETE fault_budget; DELETE fault_episode; DELETE fault_incident; DELETE fault_repair;');
  // The fixture leases one task per employee at a time: the leases of the previous test are released.
  await database.db.query(`UPDATE task SET current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE
    WHERE current_employee != NONE; UPDATE employee SET active_task = NONE WHERE active_task != NONE;`);
});

/** A task the gm owns, so the tests can claim and block it. */
async function makeTask(title: string): Promise<string> {
  const view = await core.createTask(tokens.gm, {
    title, context: 'SYS04 故障预算回归夹具', executorRole: 'engineering', reviewerRole: 'qa',
    workIntent: { kind: 'read' }, idempotencyKey: `fault-task-${title}-${clock}`,
  } as CreateTask);
  return view.id;
}

/** Claim a task for an employee so the block path has a live lease. */
async function claim(taskId: string, employee: string): Promise<ClaimResult> {
  return core.claim(tokens[employee]!, taskId) as Promise<ClaimResult>;
}

const TARGET: FaultTargetKind = 'idp_login';
const PHASE: FaultPhase = 'login';

interface AttemptInput {
  errno?: string;
  status?: number;
  alias?: string;
  phase?: FaultPhase;
  target?: FaultTargetKind;
  environment?: string;
  idempotent?: boolean;
}

/**
 * One attempt at the fault object, in the order the broker uses it: reserve, run, report the failure.
 *
 * A refused reservation never reaches the tool, and the report carries the reserved attempt so an attempt is
 * charged exactly once.
 */
async function attempt(scope: { taskId: string; employeeId?: string }, input: AttemptInput) {
  const phase = input.phase ?? PHASE;
  const target = input.target ?? TARGET;
  const reserved = await core.reserveFault!(scope, { phase, target });
  if (!reserved?.allowed) return { reserved, reported: undefined };
  const reported = await core.reportFault!(scope, {
    tool: 'ops_login', phase,
    ...(input.errno === undefined ? {} : { errno: input.errno }),
    ...(input.status === undefined ? {} : { status: input.status }),
    alias: input.alias ?? 'LCA04_MEMBER', target, environment: input.environment ?? 'production',
    ...(input.idempotent === undefined ? {} : { idempotent: input.idempotent }),
    ...(reserved.charged ? { attempt: reserved.attempt } : {}),
  });
  return { reserved, reported };
}

/**
 * A report of a failure that was already charged by the broker: the cause is recorded, the attempt is not
 * charged twice. This is the shape of the repeated blocking the convergence rules are about.
 */
async function report(scope: { taskId: string; employeeId?: string }, input: AttemptInput) {
  return core.reportFault!(scope, {
    tool: 'ops_login', phase: input.phase ?? PHASE,
    ...(input.errno === undefined ? {} : { errno: input.errno }),
    ...(input.status === undefined ? {} : { status: input.status }),
    alias: input.alias ?? 'LCA04_MEMBER', target: input.target ?? TARGET, environment: input.environment ?? 'production',
    charge: false,
  });
}

const budgetRow = async (taskId: string, target = TARGET, phase = PHASE) => {
  const store = new FaultStore(database.db);
  return store.scope(budgetKey(taskId, target, phase));
};

describe('the budget is spent before the attempt', () => {
  test('the first attempt is free, the recovery attempts are charged, and the fourth is refused', async () => {
    const taskId = await makeTask('预算：尝试前占位');
    const scope = { taskId, employeeId: 't-eng' };
    // Nothing was known to be broken yet: the first attempt costs no recovery budget.
    const first = await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(first.reserved?.allowed).toBe(true);
    expect(first.reserved?.charged).toBe(false);
    // The recovery attempts are charged before they run.
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      const next = await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
      expect(next.reserved?.allowed).toBe(true);
      expect(next.reserved?.charged).toBe(true);
    }
    // The budget is spent: the server, not the employee, stops the loop.
    clock += 10_000;
    const refused = await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(refused.reserved?.allowed).toBe(false);
    expect(refused.reserved?.message).toContain('recovery budget');
    // The refusal never names the alias.
    expect(refused.reserved?.message).not.toContain('LCA04_MEMBER');
    // The three attempts that ran are on the record.
    const row = await budgetRow(taskId);
    expect(row?.attempts).toBe(3);
    expect(row?.totalAttempts).toBe(3);
  });

  test('the budget is not cleared by a different holder', async () => {
    const taskId = await makeTask('预算：换持有人不清零');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    clock += 10_000;
    const other = await attempt({ taskId, employeeId: 't-eng2' }, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(other.reserved?.allowed).toBe(false);
  });

  test('the budget is not cleared by a different spelling of the alias, nor by another account', async () => {
    const taskId = await makeTask('预算：别名写法变体不清零');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    clock += 10_000;
    const spelled = await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT', alias: 'lca04 member' });
    expect(spelled.reserved?.allowed).toBe(false);
    clock += 10_000;
    const swapped = await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT', alias: 'LCA04_REMOVABLE' });
    expect(swapped.reserved?.allowed).toBe(false);
  });

  test('the budget is not cleared by a different task', async () => {
    const first = await makeTask('预算：任务甲');
    const second = await makeTask('预算：任务乙');
    const scope = { taskId: first, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    clock += 10_000;
    const other = await attempt({ taskId: second, employeeId: 't-eng' }, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(other.reserved?.allowed).toBe(true);
  });

  test('a different phase is a different budget', async () => {
    const taskId = await makeTask('预算：阶段不同');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    clock += 10_000;
    const other = await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT', phase: 'exchange', target: 'idp_token' });
    expect(other.reserved?.allowed).toBe(true);
  });

  test('the budget survives a process restart: the state is in the database, not in memory', async () => {
    const taskId = await makeTask('预算：进程重启后仍在');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    // A fresh store and a fresh core: nothing is carried in memory.
    const restarted = new SurrealCompanyCore(database, { faults: { limits, clock: now } });
    clock += 10_000;
    const afterRestart = await restarted.reserveFault!({ taskId, employeeId: 't-eng2' }, {
      phase: PHASE, target: TARGET,
    });
    expect(afterRestart?.allowed).toBe(false);
    expect(afterRestart?.message).toContain('recovery budget');
  });

  test('the budget survives a revoked lease and a re-claim', async () => {
    const taskId = await makeTask('预算：撤租重领后仍在');
    const scope = { taskId, employeeId: 't-eng' };
    const held = await claim(taskId, 'eng');
    expect(held.task.state).toBe('doing');
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    // The lease is revoked and the task is claimed again by somebody else.
    await database.db.query('UPDATE $t SET lease_expires_at = $past;', {
      t: new RecordId('task', taskId), past: Math.floor(clock / 1000) - 1,
    });
    await claim(taskId, 'eng2').catch(() => undefined);
    clock += 10_000;
    const afterReclaim = await attempt({ taskId, employeeId: 't-eng2' }, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(afterReclaim.reserved?.allowed).toBe(false);
    expect(afterReclaim.reserved?.message).toContain('recovery budget');
  });

  test('an attempt may not outlive the lease it runs under', async () => {
    const taskId = await makeTask('预算：锁内截止');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    const row = await budgetRow(taskId);
    expect(row?.deadline).toBeGreaterThan(clock);
    // The lease that holds the attempt is gone: the attempt may not run inside a lock that no longer exists.
    await database.db.query('UPDATE $t SET lease_expires_at = $past;', {
      t: new RecordId('task', taskId), past: Math.floor(clock / 1000) - 1,
    });
    const refused = await core.reserveFault!(scope, {
      phase: PHASE, target: TARGET,
    });
    expect(refused?.allowed).toBe(false);
    // The refusal names the lease, not the budget: the counters stay as they are.
    expect(refused?.reason).toBe('lease_expired');
    expect(refused?.message).not.toContain('recovery budget');
  });
});

describe('concurrent calls', () => {
  test('twenty concurrent reservations spend the budget once per attempt, never more', async () => {
    const taskId = await makeTask('并发：20 次占位');
    const scope = { taskId, employeeId: 't-eng' };
    // The object is already in recovery, so every one of these is a charged attempt.
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    clock += 10_000;
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      core.reserveFault!(scope, { phase: PHASE, target: TARGET })));
    // At most the attempt limit is granted: the rest are refused by the budget, not by luck.
    const allowed = results.filter(result => result?.allowed).length;
    expect(allowed).toBeLessThanOrEqual(limits.maxAttempts);
    expect(allowed).toBeGreaterThan(0);
    const row = await budgetRow(taskId);
    expect(row?.attempts).toBe(1 + allowed);
  });
});

describe('classification decides what may be recovered', () => {
  test('a 403 stops the recovery at once and says what to fix', async () => {
    const taskId = await makeTask('分类：403 不重试');
    const scope = { taskId, employeeId: 't-eng' };
    const first = await attempt(scope, { status: 403 });
    expect(first.reported?.allowed).toBe(false);
    expect(first.reported?.message).toContain('not retryable');
    // The refusal is about the cause, not about the network.
    expect(first.reported?.message).not.toContain('recovery budget');
    expect(first.reported?.message).not.toContain('LCA04_MEMBER');
    // The next attempt is refused: the recovery is over.
    clock += 10_000;
    const next = await attempt(scope, { status: 403 });
    expect(next.reserved?.allowed).toBe(false);
    expect(next.reserved?.message).toContain('not retryable');
  });

  test('a rejected password stops the recovery and names the credential class as the cause', async () => {
    const taskId = await makeTask('分类：错密码不重试');
    const scope = { taskId, employeeId: 't-eng' };
    const first = await attempt(scope, { status: 401 });
    expect(first.reported?.allowed).toBe(false);
    expect(first.reported?.evidence.httpClass).toBe('auth');
  });

  test('a connect timeout is recoverable', async () => {
    const taskId = await makeTask('分类：建连超时可恢复');
    const scope = { taskId, employeeId: 't-eng' };
    const first = await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(first.reported?.allowed).toBe(true);
  });

  test('a retryable 5xx is recoverable and a 501 is not', async () => {
    const retryable = await makeTask('分类：5xx 可恢复');
    const permanent = await makeTask('分类：501 不恢复');
    expect((await attempt({ taskId: retryable, employeeId: 't-eng' }, { status: 503 })).reported?.allowed).toBe(true);
    expect((await attempt({ taskId: permanent, employeeId: 't-eng' }, { status: 501 })).reported?.allowed).toBe(false);
  });

  test('a non-idempotent failure whose request may have been sent is not replayed', async () => {
    const taskId = await makeTask('分类：非幂等不重放');
    const scope = { taskId, employeeId: 't-eng' };
    const first = await attempt(scope, { errno: 'ECONNRESET', idempotent: false });
    expect(first.reported?.allowed).toBe(false);
    expect(first.reported?.evidence.retryability).toBe('unknown_outcome');
  });

  test('a connection that never came up proves that nothing was written: even a write may be repeated', async () => {
    const taskId = await makeTask('分类：未写出可重试');
    const scope = { taskId, employeeId: 't-eng' };
    const first = await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT', idempotent: false });
    expect(first.reported?.allowed).toBe(true);
    expect(first.reported?.evidence.retryability).toBe('retryable');
  });
});

describe('convergence', () => {
  test('the same cause reported ten times is one episode and one notification', async () => {
    const taskId = await makeTask('收敛：同因十次上报');
    const scope = { taskId, employeeId: 't-eng' };
    const store = new FaultStore(database.db);
    for (let n = 0; n < 10; n++) {
      clock += 10_000;
      await report(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    const [episodes] = await database.db.query<[Array<{ episode?: string }>]>('SELECT episode FROM fault_episode;');
    expect(episodes?.length).toBe(1);
    const episode = await store.episode(episodes![0]!.episode!);
    // One episode, one notice: the manager is told about this cause once.
    expect(await store.markNotified(episodes![0]!.episode!)).toBe(true);
    expect(await store.markNotified(episodes![0]!.episode!)).toBe(false);
    expect(episode?.notified).toBe(false);
    const [incidents] = await database.db.query<[Array<{ reports?: number }>]>('SELECT reports FROM fault_incident;');
    expect(incidents?.[0]?.reports).toBe(10);
  });

  test('ten reports by different holders still produce one episode', async () => {
    const taskId = await makeTask('收敛：换人十次上报');
    for (let n = 0; n < 10; n++) {
      clock += 10_000;
      await report({ taskId, employeeId: n % 2 ? 't-eng' : 't-eng2' }, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    const [episodes] = await database.db.query<[Array<unknown>]>('SELECT episode FROM fault_episode;');
    expect(episodes?.length).toBe(1);
  });

  test('the same cause for two tasks is one incident but two episodes', async () => {
    const first = await makeTask('收敛：跨任务同因甲');
    const second = await makeTask('收敛：跨任务同因乙');
    for (const taskId of [first, second]) {
      clock += 10_000;
      await report({ taskId, employeeId: 't-eng' }, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    const [incidents] = await database.db.query<[Array<unknown>]>('SELECT incident FROM fault_incident;');
    expect(incidents?.length).toBe(1);
    const [episodes] = await database.db.query<[Array<unknown>]>('SELECT episode FROM fault_episode;');
    expect(episodes?.length).toBe(2);
  });

  test('a different environment is a different incident', async () => {
    const first = await makeTask('收敛：环境甲');
    const second = await makeTask('收敛：环境乙');
    await report({ taskId: first, employeeId: 't-eng' }, {
      errno: 'UND_ERR_CONNECT_TIMEOUT', environment: 'production' });
    await report({ taskId: second, employeeId: 't-eng' }, {
      errno: 'UND_ERR_CONNECT_TIMEOUT', environment: 'staging' });
    const [incidents] = await database.db.query<[Array<unknown>]>('SELECT incident FROM fault_incident;');
    expect(incidents?.length).toBe(2);
  });
});

describe('the exhausted budget', () => {
  test('the budget running out produces one diagnostic and one repair chain', async () => {
    const taskId = await makeTask('耗尽：一次诊断一条修复链');
    const scope = { taskId, employeeId: 't-eng' };
    // Spend the whole budget on the same cause.
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    clock += 10_000;
    const refused = await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(refused.reserved?.allowed).toBe(false);
    expect(refused.reserved?.message).toContain('recovery budget');
    // The diagnostic is structured: machine facts, no message from the upstream.
    expect(refused.reserved?.evidence.phase).toBe('login');
    const [repairs] = await database.db.query<[Array<{ incident?: string; diagnostic?: { attempts?: number } }>]>(
      'SELECT incident, diagnostic FROM fault_repair;');
    expect(repairs?.length).toBe(1);
    expect(repairs?.[0]?.diagnostic?.attempts).toBe(3);
  });

  test('a resume does not walk past an exhausted budget: it creates the repair chain instead', async () => {
    const taskId = await makeTask('耗尽：resume 不得越过');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    clock += 10_000;
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    // The task waits on the gm gate, as a fault report would leave it.
    await database.db.query('UPDATE $t SET state = "blocked", blocked_to = "gm", resume_state = "ready";', { t: new RecordId('task', taskId) });
    const resumed = await core.resume(tokens.gm, taskId, {
      text: '尝试恢复：同一故障再次发生，应当走修复链而不是直接恢复', idempotencyKey: `resume-${clock}`,
    });
    // The task did not go back to ready: it waits on the repair.
    expect(resumed.state).toBe('blocked');
    const [repairs] = await database.db.query<[Array<{ task?: unknown; state?: string }>]>('SELECT task, state FROM fault_repair;');
    expect(repairs?.length).toBe(1);
    expect(String(repairs?.[0]?.task)).toContain('task:');
  });

  test('the repair chain is created once, however often the budget is exhausted', async () => {
    const taskId = await makeTask('耗尽：修复链唯一');
    const scope = { taskId, employeeId: 't-eng' };
    for (let n = 0; n < 6; n++) {
      clock += 10_000;
      await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    const [repairs] = await database.db.query<[Array<unknown>]>('SELECT incident FROM fault_repair;');
    expect(repairs?.length).toBe(1);
  });

  test('the repair finishing allows exactly one new recovery', async () => {
    const taskId = await makeTask('耗尽：修复后仅一次恢复');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    clock += 10_000;
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    const store = new FaultStore(database.db);
    const key = budgetKey(taskId, TARGET, PHASE);
    const row = await store.scope(key);
    expect(row?.attempts).toBe(3);
    // The repair finishes: the budget is reset and the episode may open a new stage.
    await store.liftRepair({ taskId, incident: row?.lastIncident ?? '', now: clock, limits });
    const after = await store.scope(key);
    expect(after?.attempts).toBe(0);
    expect(after?.stopped).toBe(false);
    clock += 10_000;
    const recovered = await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(recovered.reserved?.allowed).toBe(true);
    const [episodes] = await database.db.query<[Array<{ episode?: string; evidence_revision?: number }>]>(
      'SELECT episode, evidence_revision FROM fault_episode;');
    expect(episodes?.length).toBe(1);
    expect(episodes?.[0]?.evidence_revision).toBe(2);
  });

  test('fault_status is readable by the holder and reports spent budgets; fault_lift resets them for gm', async () => {
    const taskId = await makeTask('诊断：fault_status 与 fault_lift');
    const claimResult = await claim(taskId, 'eng');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    clock += 10_000;
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    // The holder (and the reviewer / gm) can read the diagnosis without guessing.
    const status = await core.faultStatus!(tokens.eng, { taskId });
    expect(status.taskId).toBe(taskId);
    expect(status.budgets.length).toBeGreaterThanOrEqual(1);
    expect(status.budgets[0]?.attempts).toBe(3);
    expect(status.budgets[0]?.lastErrno).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(status.episodes.some(episode => episode.state === 'exhausted')).toBe(true);
    const incident = status.budgets[0]?.lastIncident ?? status.episodes[0]?.incident;
    expect(incident).toBeTruthy();
    // A non-gm cannot lift.
    await expect(core.faultLift!(tokens.eng, {
      taskId, incident: incident!, reason: '验收期间解封', idempotencyKey: `lift-eng-${clock}`,
    })).rejects.toMatchObject({ code: 'forbidden' });
    // gm lifts with a reason: the next attempt starts a fresh recovery window.
    const after = await core.faultLift!(tokens.gm, {
      taskId, incident: incident!, reason: 'TLS 长尾已诊断，验收需要解封继续测', idempotencyKey: `lift-gm-${clock}`,
    });
    expect(after.budgets[0]?.attempts).toBe(0);
    expect(after.budgets[0]?.stopped).toBe(false);
    expect(after.episodes.every(episode => episode.state === 'resolved' || episode.incident !== incident)).toBe(true);
    clock += 10_000;
    const recovered = await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(recovered.reserved?.allowed).toBe(true);
    // The claim is kept alive so the holder path stays valid for the duration of the test.
    expect(claimResult.task.id).toBe(taskId);
  });

  test('a repair that is done lifts the fault: the source task may recover with a fresh budget', async () => {
    const taskId = await makeTask('耗尽：修复完成后可恢复');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    }
    clock += 10_000;
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    // The task waits on the gm gate, as a fault report would leave it.
    await database.db.query('UPDATE $t SET state = "blocked", blocked_to = "gm", resume_state = "ready";', { t: new RecordId('task', taskId) });
    await core.resume(tokens.gm, taskId, {
      text: '尝试恢复：预算耗尽后应当走修复链而不是直接恢复', idempotencyKey: `resume-lift-${clock}`,
    });
    const [repairs] = await database.db.query<[Array<{ task?: unknown }>]>('SELECT task FROM fault_repair;');
    // The fork renders a record id as `task:⟨uuid⟩`: strip the table and the quoting.
    const repairId = String(repairs?.[0]?.task ?? '').split(':').slice(1).join(':').replace(/^⟨|⟩$/g, '');
    expect(repairId).not.toBe('');
    // The repair is finished.
    await database.db.query('UPDATE $t SET state = "done";', { t: new RecordId('task', repairId) });
    // The source task may recover again: the budget starts over.
    const recovered = await core.reserveFault!(scope, { phase: PHASE, target: TARGET });
    expect(recovered?.allowed).toBe(true);
    const row = await budgetRow(taskId);
    expect(row?.attempts).toBe(0);
    expect(row?.failed).toBe(false);
    // And the episode is closed: a later report opens a new stage.
    const [episodes] = await database.db.query<[Array<{ state?: string }>]>('SELECT state FROM fault_episode;');
    expect(episodes?.[0]?.state).toBe('resolved');
  });
});

describe('the audit trail', () => {
  test('the budget of a fault object is recomputable from the stored row', async () => {
    const taskId = await makeTask('审计：预算可复算');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    clock += 10_000;
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    const row = await budgetRow(taskId);
    expect(row?.attempts).toBe(2);
    expect(row?.maxAttempts).toBe(limits.maxAttempts);
    expect(row?.totalDeadlineMs).toBe(limits.totalDeadlineMs);
    expect(row?.minIntervalMs).toBe(limits.minIntervalMs);
    expect(row?.backoffMs).toBe(limits.backoffMs);
    // The deadline is the first attempt's start plus the total deadline: recomputable, not drifting.
    expect(row?.deadline).toBe(1_700_000_000_000 + limits.totalDeadlineMs);
    expect(row?.lastAttemptAt).toBe(1_700_000_010_000);
  });

  test('the episode records the fingerprint and the incident of the cause', async () => {
    const taskId = await makeTask('审计：归组身份');
    await report({ taskId, employeeId: 't-eng' }, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    const [rows] = await database.db.query<[Array<{ fingerprint?: string; incident?: string; evidence_revision?: number; notified?: boolean }>]>(
      'SELECT fingerprint, incident, evidence_revision, notified FROM fault_episode;');
    const fault = classifyFault({ phase: 'login', errno: 'UND_ERR_CONNECT_TIMEOUT', identityAlias: 'LCA04_MEMBER', target: 'idp_login', environment: 'production' });
    expect(rows?.[0]?.fingerprint).toBe(faultFingerprint(fault));
    expect(rows?.[0]?.incident).toBe(incidentKey(fault));
    expect(rows?.[0]?.evidence_revision).toBe(1);
    expect(rows?.[0]?.notified).toBe(false);
  });
});

describe('the classification of the block path', () => {
  test('a block with machine facts records the fault; a block without them does not', async () => {
    const taskId = await makeTask('阻塞：带机器事实才记账');
    const claimResult = await claim(taskId, 'eng');
    expect(claimResult.task.state).toBe('doing');
    const proof = { taskId, expectedVersion: claimResult.task.version, fence: claimResult.fence, deliveryId: claimResult.deliveryId };
    const evidence: Evidence = {
      text: '登录建连超时：连接建立阶段停顿 20 秒，未拿到令牌', idempotencyKey: `block-fault-${clock}`,
    };
    await core.block(tokens.eng!, proof, 'gm', evidence, undefined, {
      phase: 'login', errno: 'UND_ERR_CONNECT_TIMEOUT', identityAlias: 'LCA04_MEMBER', target: 'idp_login', environment: 'production',
    });
    const [episodes] = await database.db.query<[Array<unknown>]>('SELECT episode FROM fault_episode;');
    expect(episodes?.length).toBe(1);
  });

  test('a block without machine facts is an ordinary block: no budget, no episode', async () => {
    const taskId = await makeTask('阻塞：无事实不记账');
    const claimResult = await claim(taskId, 'eng');
    const proof = { taskId, expectedVersion: claimResult.task.version, fence: claimResult.fence, deliveryId: claimResult.deliveryId };
    await core.block(tokens.eng!, proof, 'gm', { text: '我先停下：请经理确认这一步应该怎么走，以及谁来接手', idempotencyKey: `block-plain-${clock}` });
    const [episodes] = await database.db.query<[Array<unknown>]>('SELECT episode FROM fault_episode;');
    expect(episodes?.length).toBe(0);
  });
});
