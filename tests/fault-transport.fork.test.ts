/**
 * SYS04 · AC05 against the real transport: a loopback TLS IdP that stalls, refuses and drops.
 *
 * The arithmetic is unit tested in tests/faults.test.ts and the persistence in tests/fault-budget.fork.test.ts.
 * This file closes the gap between the two: a real TLS connection, a real OIDC login flow and a real failure at a
 * real hop — classified by the same rules the broker uses, charged against the same budget.
 *
 * The budget's clock is injected, so the arithmetic is exact and the tests do not sleep; the transport's own
 * timeouts are real (a stalled handshake really times out, a dropped socket really breaks the connection).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { FaultStore } from '../src/fault-store.ts';
import { budgetKey, faultFactsOf, type FaultBudgetLimits, type FaultPhase, type FaultTargetKind } from '../src/faults.ts';
import { parseBrokerConfig } from '../src/ops/config.ts';
import { createOpsFetcher, type Fetcher } from '../src/ops/fetcher.ts';
import { passwordLogin } from '../src/ops/idp.ts';
import { loginBrokerConfig, makeTestPki, startLoginIdp, type LoginIdp, type LoginIdpOptions, type TestPki } from './support/ops-login-transport.ts';
import type { CreateTask } from '../src/contracts.ts';

const NS = 'sck_agent_company_test_fault_transport';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(180_000);

const PASSWORD = 'correct-pw';
const USERNAME = 'sck-nobody';
const ALIAS = 'LCA04_MEMBER';
const PHASE: FaultPhase = 'login';
const TARGET: FaultTargetKind = 'idp_login';
/** The connect limit of the transport: a stalled handshake really times out. */
const CONNECT_TIMEOUT_MS = 500;

let clock = 1_700_000_000_000;
const now = () => clock;
const limits: FaultBudgetLimits = { maxAttempts: 3, totalDeadlineMs: 120_000, minIntervalMs: 2_000, backoffMs: 5_000, jitter: 0 };
const core = new SurrealCompanyCore(database, { faults: { limits, clock: now } });
const tokens: Record<string, string> = {};
const idps: LoginIdp[] = [];
let pki: TestPki;
let transport: Fetcher & { close(): Promise<void> };

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
  ] as const) tokens[name] = await enrollment.enroll(`t-${name}`, role, caps);
  pki = makeTestPki();
  transport = createOpsFetcher({ connectTimeoutMs: CONNECT_TIMEOUT_MS, ca: pki.ca });
});

afterAll(async () => {
  await transport?.close();
  for (const idp of idps) await idp.close();
});

beforeEach(async () => {
  clock = 1_700_000_000_000;
  await database.db.query('DELETE fault_budget; DELETE fault_episode; DELETE fault_incident; DELETE fault_repair;');
  await database.db.query(`UPDATE task SET current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE
    WHERE current_employee != NONE; UPDATE employee SET active_task = NONE WHERE active_task != NONE;`);
});

/** A task the gm owns, so the tests can claim and block it. */
async function makeTask(title: string): Promise<string> {
  const view = await core.createTask(tokens.gm!, {
    title, context: 'SYS04 真实传输故障夹具', executorRole: 'engineering', reviewerRole: 'qa',
    workIntent: { kind: 'read' }, idempotencyKey: `fault-transport-${title}-${clock}`,
  } as CreateTask);
  return view.id;
}

/** A loopback IdP with the scripted failure. Nothing leaves 127.0.0.1. */
async function idpWith(options: Omit<LoginIdpOptions, 'password'>): Promise<LoginIdp> {
  const started = await startLoginIdp(pki, { password: PASSWORD, ...options });
  idps.push(started);
  return started;
}

const budgetRow = async (taskId: string) => {
  const store = new FaultStore(database.db);
  return store.scope(budgetKey(taskId, TARGET, PHASE));
};

interface Attempt {
  reserved?: { allowed: boolean; attempt: number; charged: boolean; reason?: string; message: string };
  reported?: { allowed: boolean; message: string; evidence: Record<string, unknown> };
  tokens?: { accessToken: string };
  facts?: { stage?: string; errno?: string; status?: number; name?: string };
}

/**
 * One attempt at the login, in the order the broker uses it: reserve the budget, run the real flow over TLS, then
 * either settle (it worked) or report the machine facts of the failure. Nothing is mocked but the IdP's answers.
 */
async function attempt(scope: { taskId: string; employeeId?: string }, target: LoginIdp,
  options: { password?: string; idempotent?: boolean; requestSent?: boolean } = {}): Promise<Attempt> {
  const reserved = await core.reserveFault!(scope, { phase: PHASE, target: TARGET });
  if (!reserved?.allowed) return { reserved };
  const cfg = parseBrokerConfig(loginBrokerConfig(target.origins));
  try {
    const tokens = await passwordLogin(cfg, USERNAME, options.password ?? PASSWORD, {
      fetch: transport, now: Date.now, channel: 'customer',
      stepTimeoutMs: 5_000, budgetMs: 20_000, retryMinLeftMs: 5_000,
    });
    await core.settleFault!(scope, { phase: PHASE, target: TARGET });
    return { reserved, tokens };
  } catch (error) {
    const facts = faultFactsOf(error);
    const reported = await core.reportFault!(scope, {
      tool: 'ops_login', phase: PHASE,
      ...(facts.stage === undefined ? {} : { stage: facts.stage }),
      ...(facts.errno === undefined ? {} : { errno: facts.errno }),
      ...(facts.status === undefined ? {} : { status: facts.status }),
      ...(facts.name === undefined ? {} : { name: facts.name }),
      alias: ALIAS, target: TARGET, environment: 'production',
      // Repeating the login operation starts a fresh flow with a fresh code; the client never replays a code.
      idempotent: options.idempotent ?? true,
      ...(options.requestSent === undefined ? {} : { requestSent: options.requestSent }),
      ...(reserved.charged ? { attempt: reserved.attempt } : {}),
    });
    return { reserved, reported, facts: { ...facts } };
  }
}

describe('the real transport', () => {
  test('a connect timeout is recoverable: the next attempt goes through', async () => {
    // Every flow attempt stalls, so the login gives up after its own retries and the failure reaches the fault layer.
    const target = await idpWith({ hold: (connection) => (connection <= 3 ? 3_000 : 0) });
    const taskId = await makeTask('传输：建连超时可恢复');
    const scope = { taskId, employeeId: 't-eng' };
    const first = await attempt(scope, target);
    // The failure is a connect timeout at the authorize hop, and it may be recovered.
    expect(first.reported?.allowed).toBe(true);
    expect(first.reported?.evidence.errno).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(first.reported?.evidence.hop).toBe('connect');
    expect(first.reported?.evidence.stage).toBe('authorize');
    expect(first.reported?.evidence.retryability).toBe('retryable');
    // The failure is on the record and the budget holds it.
    const row = await budgetRow(taskId);
    expect(row?.attempts).toBe(1);
    expect(row?.failed).toBe(true);
    // The next attempt runs after the interval and succeeds.
    clock += 10_000;
    const second = await attempt(scope, target);
    expect(second.tokens?.accessToken).toBeTruthy();
    // A call that works costs no recovery budget: the recovery is over.
    const after = await budgetRow(taskId);
    expect(after?.attempts).toBe(0);
    expect(after?.failed).toBe(false);
  });

  test('the budget runs out at the authorize stage and the refused attempt never reaches the IdP', async () => {
    const target = await idpWith({ hold: () => 3_000 });
    const taskId = await makeTask('传输：authorize 阶段耗尽');
    const scope = { taskId, employeeId: 't-eng' };
    for (let n = 0; n < 3; n++) {
      if (n > 0) clock += 10_000;
      const run = await attempt(scope, target);
      expect(run.reserved?.allowed).toBe(true);
    }
    const seen = target.counts.authorize;
    clock += 10_000;
    const refused = await attempt(scope, target);
    expect(refused.reserved?.allowed).toBe(false);
    expect(refused.reserved?.message).toContain('recovery budget');
    // The refused attempt never reached the upstream.
    expect(target.counts.authorize).toBe(seen);
    // One episode, one diagnostic, one repair chain.
    const [episodes] = await database.db.query<[Array<{ state?: string; fingerprint?: string }>]>(
      'SELECT state, fingerprint FROM fault_episode;');
    expect(episodes?.length).toBe(1);
    expect(episodes?.[0]?.state).toBe('exhausted');
    // The cause is identified down to the stage that failed.
    expect(episodes?.[0]?.fingerprint?.startsWith('login|authorize|')).toBe(true);
    const [repairs] = await database.db.query<[Array<{ diagnostic?: { attempts?: number } }>]>(
      'SELECT diagnostic FROM fault_repair;');
    expect(repairs?.length).toBe(1);
    expect(repairs?.[0]?.diagnostic?.attempts).toBe(3);
  });

  test('the budget runs out at the login stage as well', async () => {
    const target = await idpWith({ dropLogin: () => true });
    const taskId = await makeTask('传输：login 阶段耗尽');
    const scope = { taskId, employeeId: 't-eng' };
    const first = await attempt(scope, target);
    // A broken connection is recoverable for an operation that may be repeated.
    expect(first.reported?.allowed).toBe(true);
    expect(first.reported?.evidence.stage).toBe('login');
    expect(first.reported?.evidence.hop).toBe('connect');
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, target);
    }
    clock += 10_000;
    const refused = await attempt(scope, target);
    expect(refused.reserved?.allowed).toBe(false);
    expect(refused.reserved?.message).toContain('recovery budget');
  });

  test('the budget runs out at the exchange stage as well', async () => {
    const target = await idpWith({ dropExchange: () => true });
    const taskId = await makeTask('传输：exchange 阶段耗尽');
    const scope = { taskId, employeeId: 't-eng' };
    const first = await attempt(scope, target);
    expect(first.reported?.allowed).toBe(true);
    expect(first.reported?.evidence.stage).toBe('exchange');
    for (let n = 0; n < 2; n++) {
      clock += 10_000;
      await attempt(scope, target);
    }
    clock += 10_000;
    const refused = await attempt(scope, target);
    expect(refused.reserved?.allowed).toBe(false);
    // The authorization code is never replayed: every flow got its own.
    expect(target.counts.replays).toBe(0);
    expect(new Set(target.issuedCodes).size).toBe(target.issuedCodes.length);
  });

  test('a 403 stops the recovery at once and is not asked again', async () => {
    const target = await idpWith({ refuseStatus: 403 });
    const taskId = await makeTask('传输：403 不重试');
    const scope = { taskId, employeeId: 't-eng' };
    const first = await attempt(scope, target, { password: 'wrong-pw' });
    expect(first.reported?.allowed).toBe(false);
    expect(first.reported?.evidence.status).toBe(403);
    expect(first.reported?.evidence.httpClass).toBe('client_error');
    // The IdP was asked once: a refusal is not retried.
    expect(target.counts.login).toBe(1);
    // The next attempt is refused by the budget, and the IdP is not asked again.
    clock += 10_000;
    const next = await attempt(scope, target, { password: 'wrong-pw' });
    expect(next.reserved?.allowed).toBe(false);
    expect(next.reserved?.message).toContain('not retryable');
    expect(target.counts.login).toBe(1);
  });

  test('a 5xx may be recovered, and the recovery spends the budget', async () => {
    const target = await idpWith({ refuseStatus: 503 });
    const taskId = await makeTask('传输：5xx 可恢复');
    const scope = { taskId, employeeId: 't-eng' };
    const first = await attempt(scope, target, { password: 'wrong-pw' });
    expect(first.reported?.allowed).toBe(true);
    expect(first.reported?.evidence.status).toBe(503);
    expect(first.reported?.evidence.httpClass).toBe('server_error');
    // The client tried the flow three times before giving up: each retry is counted, not hidden.
    expect(target.counts.login).toBe(3);
  });

  test('a write whose request may have been sent is not replayed', async () => {
    const target = await idpWith({ dropLogin: () => true });
    const taskId = await makeTask('传输：非幂等不重放');
    const scope = { taskId, employeeId: 't-eng' };
    const first = await attempt(scope, target, { idempotent: false, requestSent: true });
    expect(first.reported?.allowed).toBe(false);
    expect(first.reported?.evidence.retryability).toBe('unknown_outcome');
    // The recovery stopped: the next attempt is refused.
    clock += 10_000;
    const next = await attempt(scope, target, { idempotent: false, requestSent: true });
    expect(next.reserved?.allowed).toBe(false);
    expect(next.reserved?.message).toContain('not retryable');
  });

  test('an attempt may not run inside a lease that has ended', async () => {
    const target = await idpWith({ hold: () => 3_000 });
    const taskId = await makeTask('传输：锁内截止');
    const scope = { taskId, employeeId: 't-eng' };
    // The object is in recovery: the first failure put it there.
    const first = await attempt(scope, target);
    expect(first.reported?.allowed).toBe(true);
    // The lease that holds the recovery attempt ends.
    await database.db.query('UPDATE $t SET lease_expires_at = $past;', {
      t: new RecordId('task', taskId), past: Math.floor(clock / 1000) - 1,
    });
    const seen = target.counts.authorize;
    clock += 10_000;
    const refused = await attempt(scope, target);
    expect(refused.reserved?.allowed).toBe(false);
    expect(refused.reserved?.reason).toBe('lease_expired');
    // The upstream was never reached inside a lock that no longer exists.
    expect(target.counts.authorize).toBe(seen);
  });

  test('twenty concurrent calls spend the budget once per attempt, never more', async () => {
    const target = await idpWith({ hold: () => 3_000 });
    const taskId = await makeTask('传输：20 并发');
    const scope = { taskId, employeeId: 't-eng' };
    // The object is in recovery already: every one of these is a charged attempt.
    await attempt(scope, target);
    clock += 10_000;
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      core.reserveFault!(scope, { phase: PHASE, target: TARGET })));
    const allowed = results.filter(result => result?.allowed).length;
    expect(allowed).toBeLessThanOrEqual(limits.maxAttempts);
    expect(allowed).toBeGreaterThan(0);
    const row = await budgetRow(taskId);
    expect(row?.attempts).toBe(1 + allowed);
  });

  test('the budget survives a restart and a change of holder', async () => {
    const target = await idpWith({ hold: () => 3_000 });
    const taskId = await makeTask('传输：重启与换人');
    const scope = { taskId, employeeId: 't-eng' };
    for (let n = 0; n < 3; n++) {
      if (n > 0) clock += 10_000;
      await attempt(scope, target);
    }
    // A fresh core over the same database: the budget is in the database, not in memory.
    const restarted = new SurrealCompanyCore(database, { faults: { limits, clock: now } });
    clock += 10_000;
    const afterRestart = await restarted.reserveFault!({ taskId, employeeId: 't-eng2' }, { phase: PHASE, target: TARGET });
    expect(afterRestart?.allowed).toBe(false);
    expect(afterRestart?.message).toContain('recovery budget');
  });

  test('the same cause reported ten times is one episode and one notice', async () => {
    const taskId = await makeTask('传输：同因十次上报');
    const scope = { taskId, employeeId: 't-eng' };
    const store = new FaultStore(database.db);
    for (let n = 0; n < 10; n++) {
      clock += 10_000;
      await core.reportFault!(scope, {
        tool: 'ops_login', phase: PHASE, errno: 'UND_ERR_CONNECT_TIMEOUT', stage: 'authorize',
        alias: ALIAS, target: TARGET, environment: 'production', charge: false,
      });
    }
    const [episodes] = await database.db.query<[Array<{ episode?: string }>]>('SELECT episode FROM fault_episode;');
    expect(episodes?.length).toBe(1);
    // One episode, one notice: the manager is told about this cause once.
    expect(await store.markNotified(episodes![0]!.episode!)).toBe(true);
    expect(await store.markNotified(episodes![0]!.episode!)).toBe(false);
    const [incidents] = await database.db.query<[Array<{ reports?: number }>]>('SELECT reports FROM fault_incident;');
    expect(incidents?.[0]?.reports).toBe(10);
  });

  test('a finished repair allows exactly one new recovery, and the budget audit is recomputable', async () => {
    const target = await idpWith({ hold: () => 3_000 });
    const taskId = await makeTask('传输：修复后一次恢复');
    const scope = { taskId, employeeId: 't-eng' };
    for (let n = 0; n < 3; n++) {
      if (n > 0) clock += 10_000;
      await attempt(scope, target);
    }
    clock += 10_000;
    await attempt(scope, target);
    // The audit before the repair: the budget is spent and the deadline is the first attempt plus the total.
    const before = await budgetRow(taskId);
    expect(before?.attempts).toBe(3);
    expect(before?.maxAttempts).toBe(limits.maxAttempts);
    expect(before?.deadline).toBe(1_700_000_000_000 + limits.totalDeadlineMs);
    // The task waits on the repair chain.
    await database.db.query('UPDATE $t SET state = "blocked", blocked_to = "gm", resume_state = "ready";', {
      t: new RecordId('task', taskId),
    });
    await core.resume(tokens.gm!, taskId, {
      text: '尝试恢复：预算耗尽后应当走修复链而不是直接恢复', idempotencyKey: `resume-transport-${clock}`,
    });
    const [repairs] = await database.db.query<[Array<{ task?: unknown }>]>('SELECT task FROM fault_repair;');
    const repairId = String(repairs?.[0]?.task ?? '').split(':').slice(1).join(':').replace(/^⟨|⟩$/g, '');
    expect(repairId).not.toBe('');
    // The repair is finished.
    await database.db.query('UPDATE $t SET state = "done";', { t: new RecordId('task', repairId) });
    // The source task may recover again, with a fresh budget.
    clock += 10_000;
    const recovered = await attempt(scope, target);
    expect(recovered.reserved?.allowed).toBe(true);
    const after = await budgetRow(taskId);
    expect(after?.attempts).toBe(1);
    expect(after?.failed).toBe(true);
    // The audit after the repair: the deadline starts over, the total stays for the audit.
    expect(after?.deadline).toBe(clock + limits.totalDeadlineMs);
    expect(after?.totalAttempts).toBe(4);
  });
});
