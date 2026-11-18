/**
 * SYS04 · The owner's grant of one new recovery window (fault.grant), on the real core, the real owner API and the
 * company fork.
 *
 * The rules under test:
 *
 * - An exhausted budget refuses every attempt, and nothing recovers it on its own: not the passing of time, not a fix
 *   that lands later. Only the owner's grant does, and only once per budget and incident.
 * - The grant records the decision and leaves the budget alone. The window opens when the first real attempt spends
 *   the grant, and it runs the full total duration from that attempt, however long the attempt waited in a queue.
 * - Opening the window is a change to the same budget: the attempts start over, the cumulative count stays for the
 *   audit, and only the episodes of this task and this incident close. Other tasks, targets and phases keep theirs.
 * - A replay answers the stored receipt. A window that was used up, and a grant that a success or a lift voided, are
 *   never granted again: the next exhaustion goes to the repair chain.
 * - A reservation refunded before its call ran hands the grant back. A refund that a newer attempt superseded changes nothing.
 *
 * The owner API reads the real clock, as it does in production, so the tests set the controlled clock to match it
 * wherever the grant is requested through the API. Everything else runs on the controlled clock, so nothing sleeps.
 */
import { beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { RecordId } from 'surrealdb';
import { judge, OWNER_API_COMMANDS } from '../src/command-guard.ts';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { FaultGrantRefusal, FaultStore, type FaultRecoveryGrantRow, type FaultRecoveryGrantReceipt } from '../src/fault-store.ts';
import { budgetKey, DEFAULT_FAULT_BUDGET, type FaultBudgetLimits, type FaultPhase, type FaultTargetKind } from '../src/faults.ts';
import { LIFECYCLE_COMMANDS } from '../src/lifecycle-policy.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';
import { ownerApi } from '../src/owner-api.ts';
import type { CreateTask } from '../src/contracts.ts';

const NS = 'sck_agent_company_test_fault_grant';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(180_000);
const tokens: Record<string, string> = {};

/** The controlled clock. It starts at the real time, so the owner API (which reads the real clock) agrees with it. */
let clock = Date.now();
const now = () => clock;
const limits: FaultBudgetLimits = { maxAttempts: 3, totalDeadlineMs: 120_000, minIntervalMs: 2_000, backoffMs: 5_000, jitter: 0 };

const core = new SurrealCompanyCore(database, { faults: { limits, clock: now } });

const TARGET: FaultTargetKind = 'idp_login';
const PHASE: FaultPhase = 'login';
const RESERVE = { phase: PHASE, target: TARGET } as const;
const GRANT_NOTE = '老板核对：IdP 修复已上线，授权一次新窗口';

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  // The release gate reads this marker: a skipped file (missing opt-in flag) must not look like a pass.
  console.log('fault-recovery-grant.fork executed');
  const enrollment = new LocalEnrollmentAdmin(database);
  for (const [name, role, caps] of [
    ['owner', 'owner', ['execute', 'review', 'manage']],
    ['eng', 'engineering', ['execute', 'review']],
    ['eng2', 'engineering', ['execute', 'review']],
    ['qa', 'qa', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`t-${name}`, role, caps);
});

beforeEach(async () => {
  clock = Date.now();
  // A repair chain is keyed by its incident, and that key is an idempotency key: the records of the previous test go too.
  await database.db.query(`DELETE fault_budget; DELETE fault_episode; DELETE fault_incident; DELETE fault_repair;
    DELETE fault_repair_consumption; DELETE fault_recovery_grant; DELETE idempotency; DELETE audit;`);
  // The fixture leases one task per employee at a time: the leases of the previous test are released.
  await database.db.query(`UPDATE task SET current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE
    WHERE current_employee != NONE; UPDATE employee SET active_task = NONE WHERE active_task != NONE;`);
});

/** A task the owner creates, so the tests can spend and exhaust its recovery budget. */
async function makeTask(title: string): Promise<string> {
  const view = await core.createTask(tokens.owner, {
    title, context: 'SYS04 恢复授权回归夹具', executorRole: 'engineering', reviewerRole: 'qa',
    workIntent: { kind: 'read' }, idempotencyKey: `grant-task-${title}-${clock}`,
  } as CreateTask);
  return view.id;
}

interface AttemptInput {
  errno?: string;
  status?: number;
  phase?: FaultPhase;
  target?: FaultTargetKind;
}

/** One attempt in the order the broker uses it: reserve, run, report the failure. A refused reservation never runs. */
async function attempt(scope: { taskId: string; employeeId?: string }, input: AttemptInput) {
  const phase = input.phase ?? PHASE;
  const target = input.target ?? TARGET;
  const reserved = await core.reserveFault!(scope, { phase, target });
  if (!reserved?.allowed) return { reserved, reported: undefined };
  const reported = await core.reportFault!(scope, {
    tool: 'ops_login', phase,
    ...(input.errno === undefined ? {} : { errno: input.errno }),
    ...(input.status === undefined ? {} : { status: input.status }),
    alias: 'LCA04_MEMBER', target, environment: 'production',
    ...(reserved.charged ? { attempt: reserved.attempt } : {}),
  });
  return { reserved, reported };
}

const store = () => new FaultStore(database.db);

const budgetRow = (taskId: string, target: FaultTargetKind = TARGET, phase: FaultPhase = PHASE) =>
  store().scope(budgetKey(taskId, target, phase));

/** The state of every episode of a task. */
const episodeStates = async (taskId: string) => (await store().episodesOfTask(taskId)).map(episode => episode.state);

/**
 * The first failure and the three attempts that spend the budget: the fourth is refused and the episode is exhausted.
 * The attempts run ten seconds apart, so the deadline of the window is still ahead when the budget runs out.
 */
async function exhaust(scope: { taskId: string; employeeId?: string }, input: AttemptInput = { errno: 'UND_ERR_CONNECT_TIMEOUT' }) {
  await attempt(scope, input);
  for (let n = 0; n < 2; n++) {
    clock += 10_000;
    await attempt(scope, input);
  }
  clock += 10_000;
  return attempt(scope, input);
}

/** The owner's grant through the store, on the controlled clock. The same content gives the same digest. */
const grantOf = (taskId: string, incident: string, idempotencyKey = 'grant-key-0001', evidence = GRANT_NOTE) =>
  store().grantRecovery({
    taskId, target: TARGET, phase: PHASE, incident, now: clock, limits: DEFAULT_FAULT_BUDGET,
    grantedBy: 'owner:test', evidence, idempotencyKey, payloadDigest: `digest|${taskId}|${incident}|${evidence}`,
  });

/** The grant's reason when the store refuses it; undefined when it was granted or replayed. */
async function refusalOf(promise: Promise<FaultRecoveryGrantReceipt>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof FaultGrantRefusal ? error.reason : `unexpected: ${(error as Error).message}`;
  }
}

/** The stored grant of one budget and incident, read back from the database. */
const grantRow = (taskId: string, incident: string) => store().recoveryGrant(FaultStore.grantKey(budgetKey(taskId, TARGET, PHASE), incident));

/** How many grant rows the database holds. */
const grantRows = async (): Promise<number> => {
  const [rows] = await database.db.query<[Array<{ key?: string }>]>('SELECT key FROM fault_recovery_grant;');
  return rows?.length ?? 0;
};

const ownerGrantAudits = async (): Promise<number> => {
  const [rows] = await database.db.query<[Array<{ actor?: string }>]>("SELECT actor FROM audit WHERE action = 'owner_fault_grant';");
  return rows?.length ?? 0;
};

/** The owner command as the owner API receives it (the same path the gateway and the plugin use). */
const ownerCommand = (input: Record<string, unknown>) => ownerApi({
  db: database, core: core as never, owner: null as never, workforce: null as never,
  messages: new OutboundMessageStore(database.db), opsRepo: '/tmp',
}, input, 'test');

interface GrantReceipt {
  replayed: boolean;
  grant: FaultRecoveryGrantRow;
  window: { maxAttempts: number; totalDeadlineMs: number; opensAt: string };
  next: string;
}

describe('an exhausted budget is not recovered by time or by a fix', () => {
  test('without a grant the budget refuses every attempt, however long the wait', async () => {
    // The first failure is five minutes old in real time too, so the owner API sees the same expired window.
    clock = Date.now() - 300_000;
    const taskId = await makeTask('授权：无授权不自动恢复');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    // The window of the first failure is over. A fix that lands later changes nothing on its own.
    clock += 130_000;
    const expired = await core.reserveFault!(scope, RESERVE);
    expect(expired?.allowed).toBe(false);
    expect(expired?.reason).toBe('deadline_passed');
    clock += 7 * 24 * 3600_000;
    expect((await core.reserveFault!(scope, RESERVE))?.allowed).toBe(false);
    expect((await budgetRow(taskId))?.totalAttempts).toBe(1);
  });

  test('a budget that still has its window is not granted', async () => {
    const taskId = await makeTask('授权：窗口内不授权');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    const incident = (await budgetRow(taskId))!.lastIncident!;
    expect(await refusalOf(grantOf(taskId, incident))).toBe('not_exhausted');
    expect(await grantRows()).toBe(0);
  });
});

describe('the grant opens one window when the first real attempt spends it', () => {
  test('after a queue delay past the old deadline, the first real attempt gets a full window', async () => {
    clock = Date.now() - 300_000;
    const taskId = await makeTask('授权：排队后首次尝试获完整窗口');
    const scope = { taskId, employeeId: 't-eng' };
    const firstFailure = clock;
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    const before = await budgetRow(taskId);
    expect(before?.deadline).toBe(firstFailure + 120_000);
    clock = firstFailure + 130_000;
    expect((await core.reserveFault!(scope, RESERVE))?.reason).toBe('deadline_passed');

    // The owner grants through the owner API, which reads the real clock: the old window has passed in real time too.
    const receipt = await ownerCommand({
      command: 'fault.grant', taskId, target: TARGET, phase: PHASE, incident: before!.lastIncident,
      note: GRANT_NOTE, idempotencyKey: 'grant-e2e-window-0001',
    }) as GrantReceipt;
    expect(receipt.replayed).toBe(false);
    expect(receipt.grant.state).toBe('pending');
    // The grant alone opens nothing: the budget is untouched until an attempt spends it.
    expect(await budgetRow(taskId)).toMatchObject({ attempts: before!.attempts, totalAttempts: before!.totalAttempts, deadline: before!.deadline });

    // The employee's attempt waits in a queue for ten minutes, far past the old deadline, and still gets the whole window.
    clock = Date.now() + 600_000;
    const started = clock;
    const first = await core.reserveFault!(scope, RESERVE);
    expect(first).toMatchObject({ allowed: true, charged: true, attempt: 1 });
    const opened = await budgetRow(taskId);
    expect(opened?.deadline).toBe(started + 120_000);
    expect(opened?.attempts).toBe(1);
    // The cumulative count keeps every attempt before the grant, and counts the one that opened the window.
    expect(opened?.totalAttempts).toBe(before!.totalAttempts + 1);
    expect((await grantRow(taskId, before!.lastIncident!))?.state).toBe('consumed');
    expect(await episodeStates(taskId)).toEqual(['resolved']);

    // The window runs for exactly the total duration from that attempt.
    clock = started + 119_000;
    expect((await core.reserveFault!(scope, RESERVE))?.allowed).toBe(true);
    clock = started + 120_000;
    expect((await core.reserveFault!(scope, RESERVE))?.reason).toBe('deadline_passed');
    expect((await budgetRow(taskId))?.totalAttempts).toBe(before!.totalAttempts + 2);
  });

  test('a grant that is refused for the lease does not spend the window: the next real attempt opens it', async () => {
    const taskId = await makeTask('授权：租约结束不开窗');
    const scope = { taskId, employeeId: 't-eng' };
    await exhaust(scope);
    const incident = (await budgetRow(taskId))!.lastIncident!;
    await grantOf(taskId, incident);
    // The lease the attempt would run under has ended.
    await database.db.query('UPDATE $t SET lease_expires_at = $past;', {
      t: new RecordId('task', taskId), past: Math.floor(clock / 1000) - 1,
    });
    const refused = await core.reserveFault!(scope, RESERVE);
    expect(refused?.allowed).toBe(false);
    expect(refused?.reason).toBe('lease_expired');
    expect((await grantRow(taskId, incident))?.state).toBe('pending');
    expect((await budgetRow(taskId))?.attempts).toBe(3);
    // The lease is claimed again: the same grant opens the window now.
    await database.db.query('UPDATE $t SET lease_expires_at = $future;', {
      t: new RecordId('task', taskId), future: Math.floor(clock / 1000) + 3600,
    });
    expect(await core.reserveFault!(scope, RESERVE)).toMatchObject({ allowed: true, charged: true });
    expect((await grantRow(taskId, incident))?.state).toBe('consumed');
  });

  test('concurrent reservations after the grant open exactly one window', async () => {
    const taskId = await makeTask('授权：并发尝试只开一个窗口');
    const scope = { taskId, employeeId: 't-eng' };
    await exhaust(scope);
    const incident = (await budgetRow(taskId))!.lastIncident!;
    const totalBefore = (await budgetRow(taskId))!.totalAttempts;
    await grantOf(taskId, incident);
    clock += 600_000;
    const results = await Promise.all(Array.from({ length: 10 }, () => core.reserveFault!(scope, RESERVE)));
    const allowed = results.filter(result => result?.allowed);
    expect(allowed).toHaveLength(1);
    expect(allowed[0]?.charged).toBe(true);
    expect((await budgetRow(taskId))?.attempts).toBe(1);
    expect((await budgetRow(taskId))?.totalAttempts).toBe(totalBefore + 1);
    expect((await grantRow(taskId, incident))?.consumedTotalAttempts).toBe(totalBefore + 1);
  });

  test('the window used up goes to the repair chain, and the grant is never issued again', async () => {
    const taskId = await makeTask('授权：耗尽后不再开窗');
    const scope = { taskId, employeeId: 't-eng' };
    await exhaust(scope);
    const incident = (await budgetRow(taskId))!.lastIncident!;
    await grantOf(taskId, incident);
    clock += 600_000;
    expect((await core.reserveFault!(scope, RESERVE))?.charged).toBe(true);
    clock += 10_000;
    expect((await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' })).reserved?.charged).toBe(true);
    clock += 10_000;
    expect((await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' })).reserved?.charged).toBe(true);
    clock += 10_000;
    const spent = await core.reserveFault!(scope, RESERVE);
    expect(spent?.allowed).toBe(false);
    expect(spent?.reason).toBe('attempts_exhausted');
    // The second window is not opened: the budget stays spent and the repair chain holds the incident.
    expect((await budgetRow(taskId))?.attempts).toBe(3);
    expect((await store().repair(incident))?.diagnostic).toBeDefined();
    expect(await refusalOf(grantOf(taskId, incident, 'grant-key-0002'))).toBe('already_granted');
    expect((await grantRow(taskId, incident))?.state).toBe('consumed');
  });

  test('a replayed request after the window was used answers the stored receipt and opens nothing', async () => {
    const taskId = await makeTask('授权：窗口用过后重放');
    const scope = { taskId, employeeId: 't-eng' };
    await exhaust(scope);
    const incident = (await budgetRow(taskId))!.lastIncident!;
    const granted = await grantOf(taskId, incident);
    clock += 600_000;
    await core.reserveFault!(scope, RESERVE);
    const replay = await grantOf(taskId, incident);
    expect(replay.replayed).toBe(true);
    expect(replay.grant.state).toBe('consumed');
    expect(replay.grant.grantedAt).toBe(granted.grant.grantedAt);
    expect((await budgetRow(taskId))?.attempts).toBe(1);
  });
});

describe('the grant is one per event, and retries change nothing', () => {
  test('the same request replayed answers the stored receipt and writes nothing new', async () => {
    const taskId = await makeTask('授权：同请求重放');
    await exhaust({ taskId, employeeId: 't-eng' });
    const incident = (await budgetRow(taskId))!.lastIncident!;
    const first = await grantOf(taskId, incident);
    const replay = await grantOf(taskId, incident);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.grant.grantedAt).toBe(first.grant.grantedAt);
    expect(await grantRows()).toBe(1);
    expect(await ownerGrantAudits()).toBe(1);
    // The audit names the grant, the actor and the evidence, never a credential.
    const [audits] = await database.db.query<[Array<{ actor?: string; evidence?: string }>]>(
      "SELECT actor, evidence FROM audit WHERE action = 'owner_fault_grant';");
    expect(audits?.[0]?.actor).toBe('owner:test');
    expect(audits?.[0]?.evidence).toContain(GRANT_NOTE);
  });

  test('a restart answers the same receipt: the answer is in the database, not in memory', async () => {
    const taskId = await makeTask('授权：重启后重放');
    await exhaust({ taskId, employeeId: 't-eng' });
    const incident = (await budgetRow(taskId))!.lastIncident!;
    await grantOf(taskId, incident);
    const restarted = new FaultStore(database.db);
    const replay = await restarted.grantRecovery({
      taskId, target: TARGET, phase: PHASE, incident, now: clock, limits: DEFAULT_FAULT_BUDGET,
      grantedBy: 'owner:test', evidence: GRANT_NOTE, idempotencyKey: 'grant-key-0001', payloadDigest: `digest|${taskId}|${incident}|${GRANT_NOTE}`,
    });
    expect(replay.replayed).toBe(true);
    expect(await grantRows()).toBe(1);
  });

  test('the same key with other content is refused, and another key for the same event is refused', async () => {
    const taskId = await makeTask('授权：幂等键冲突');
    await exhaust({ taskId, employeeId: 't-eng' });
    const incident = (await budgetRow(taskId))!.lastIncident!;
    await grantOf(taskId, incident);
    await expect(store().grantRecovery({
      taskId, target: TARGET, phase: PHASE, incident, now: clock, limits: DEFAULT_FAULT_BUDGET,
      grantedBy: 'owner:test', evidence: '另一份内容', idempotencyKey: 'grant-key-0001', payloadDigest: 'digest|other',
    })).rejects.toMatchObject({ reason: 'idempotency_conflict' });
    expect(await refusalOf(grantOf(taskId, incident, 'grant-key-0002'))).toBe('already_granted');
    expect(await grantRows()).toBe(1);
  });

  test('concurrent requests for one event write one grant, and the others get the stored answer', async () => {
    const taskId = await makeTask('授权：并发同事件只写一次');
    await exhaust({ taskId, employeeId: 't-eng' });
    const incident = (await budgetRow(taskId))!.lastIncident!;
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => grantOf(taskId, incident)));
    const receipts = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    expect(receipts).toHaveLength(8);
    expect(receipts.filter(receipt => !receipt.replayed)).toHaveLength(1);
    expect(await grantRows()).toBe(1);
    expect(await ownerGrantAudits()).toBe(1);
  });

  test('concurrent requests with different keys for one event: one is granted, the rest are refused', async () => {
    const taskId = await makeTask('授权：并发不同键只授权一次');
    await exhaust({ taskId, employeeId: 't-eng' });
    const incident = (await budgetRow(taskId))!.lastIncident!;
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
      grantOf(taskId, incident, `grant-key-000${index + 1}`)));
    const granted = results.filter(result => result.status === 'fulfilled');
    expect(granted).toHaveLength(1);
    const refused = results.flatMap(result => result.status === 'rejected' && result.reason instanceof FaultGrantRefusal
      ? [result.reason.reason] : []);
    expect(refused).toHaveLength(5);
    expect(new Set(refused)).toEqual(new Set(['already_granted']));
    expect(await grantRows()).toBe(1);
  });
});

describe('a grant is refused unless it fits the budget it is for', () => {
  test('a task with no recovery budget is not granted', async () => {
    const taskId = await makeTask('授权：没有预算');
    expect(await refusalOf(grantOf(taskId, 'phase|none'))).toBe('not_found');
  });

  test('a grant names the incident the budget recorded last', async () => {
    const taskId = await makeTask('授权：事件不一致');
    await exhaust({ taskId, employeeId: 't-eng' });
    const incident = (await budgetRow(taskId))!.lastIncident!;
    expect(await refusalOf(grantOf(taskId, 'login|other|incident'))).toBe('incident_mismatch');
    await expect(grantOf(taskId, 'login|other|incident')).rejects.toThrow(incident);
    expect(await grantRows()).toBe(0);
  });

  test('a recovery that is not running is not granted', async () => {
    const taskId = await makeTask('授权：没有在恢复中');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    const incident = (await budgetRow(taskId))!.lastIncident!;
    // A success ends the recovery before the owner grants anything.
    await core.settleFault!(scope, RESERVE);
    expect(await refusalOf(grantOf(taskId, incident))).toBe('not_in_recovery');
  });

  test('a stopped budget is not granted, and the grant does not lift the stop', async () => {
    const taskId = await makeTask('授权：停止不解除');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { status: 403 });
    const stopped = await budgetRow(taskId);
    expect(stopped?.stopped).toBe(true);
    expect(await refusalOf(grantOf(taskId, stopped!.lastIncident!))).toBe('stopped');
    const refused = await core.reserveFault!(scope, RESERVE);
    expect(refused?.allowed).toBe(false);
    expect(refused?.reason).toBe('not_retryable');
  });
});

describe('a grant ends with the recovery it was given for', () => {
  test('a success ends the recovery: an unspent grant is void and never opens a window', async () => {
    const taskId = await makeTask('授权：成功后作废');
    const scope = { taskId, employeeId: 't-eng' };
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT' });
    // Two more attempts are in flight when the budget runs out.
    clock += 10_000;
    expect((await core.reserveFault!(scope, RESERVE))?.charged).toBe(true);
    clock += 10_000;
    expect((await core.reserveFault!(scope, RESERVE))?.charged).toBe(true);
    const incident = (await budgetRow(taskId))!.lastIncident!;
    expect((await grantOf(taskId, incident)).grant.state).toBe('pending');
    // The in-flight attempt succeeds: the fault object works again.
    await core.settleFault!(scope, RESERVE);
    expect((await grantRow(taskId, incident))?.state).toBe('void');
    // A later exhaustion of the same cause has no window to open.
    const again = await exhaust(scope);
    expect(again.reserved?.reason).toBe('attempts_exhausted');
    expect((await grantRow(taskId, incident))?.state).toBe('void');
    expect(await refusalOf(grantOf(taskId, incident, 'grant-key-0002'))).toBe('already_granted');
  });

  test('a repair lift or a manual reset voids a pending grant', async () => {
    const taskId = await makeTask('授权：修复解除后作废');
    const scope = { taskId, employeeId: 't-eng' };
    await exhaust(scope);
    const incident = (await budgetRow(taskId))!.lastIncident!;
    await grantOf(taskId, incident);
    await store().resetRecovery({ taskId, incident, now: clock, limits: DEFAULT_FAULT_BUDGET });
    expect((await grantRow(taskId, incident))?.state).toBe('void');
    // The budget starts over; when it runs out again, nothing is granted and the repair chain takes the incident.
    const again = await exhaust(scope);
    expect(again.reserved?.reason).toBe('attempts_exhausted');
    expect((await grantRow(taskId, incident))?.state).toBe('void');
    expect((await budgetRow(taskId))?.attempts).toBe(3);
  });
});

describe('a refund hands the grant back, and a superseded refund changes nothing', () => {
  test('refunding the reservation that opened the window returns the grant and reopens the episode', async () => {
    const taskId = await makeTask('授权：退款归还授权');
    const scope = { taskId, employeeId: 't-eng' };
    await exhaust(scope);
    const incident = (await budgetRow(taskId))!.lastIncident!;
    const exhausted = await budgetRow(taskId);
    await grantOf(taskId, incident);
    clock += 600_000;
    const reserved = await core.reserveFault!(scope, RESERVE);
    expect(reserved?.charged).toBe(true);
    expect(reserved?.refund?.grant).toBeDefined();
    expect((await grantRow(taskId, incident))?.state).toBe('consumed');
    // The call never ran: the window it would have opened goes back.
    expect((await core.refundFault!(scope, { ...RESERVE, refund: reserved!.refund! })).refunded).toBe(true);
    const returned = await grantRow(taskId, incident);
    expect(returned?.state).toBe('pending');
    expect(returned?.consumedAt).toBeUndefined();
    expect(await episodeStates(taskId)).toEqual(['exhausted']);
    expect(await budgetRow(taskId)).toMatchObject({
      attempts: exhausted!.attempts, totalAttempts: exhausted!.totalAttempts, deadline: exhausted!.deadline,
    });
    // The next real attempt spends the grant again.
    expect(await core.reserveFault!(scope, RESERVE)).toMatchObject({ allowed: true, charged: true });
    expect((await grantRow(taskId, incident))?.state).toBe('consumed');
  });

  test('a refund that a newer attempt superseded leaves the window and the grant as they are', async () => {
    const taskId = await makeTask('授权：退款被后续尝试覆盖');
    const scope = { taskId, employeeId: 't-eng' };
    await exhaust(scope);
    const incident = (await budgetRow(taskId))!.lastIncident!;
    await grantOf(taskId, incident);
    clock += 600_000;
    const first = await core.reserveFault!(scope, RESERVE);
    clock += 3_000;
    const second = await core.reserveFault!(scope, RESERVE);
    expect(second?.charged).toBe(true);
    expect((await core.refundFault!(scope, { ...RESERVE, refund: first!.refund! })).refunded).toBe(false);
    expect((await grantRow(taskId, incident))?.state).toBe('consumed');
    expect((await budgetRow(taskId))?.attempts).toBe(2);
  });
});

describe('the grant touches only its own task, target, phase and episode', () => {
  test('the grant closes only the episode of this task and incident; other budgets keep theirs', async () => {
    const taskId = await makeTask('授权：只关闭本任务事件');
    const other = await makeTask('授权：同因另一任务');
    const scope = { taskId, employeeId: 't-eng' };
    const otherScope = { taskId: other, employeeId: 't-eng2' };
    await exhaust(scope);
    const incident = (await budgetRow(taskId))!.lastIncident!;
    await exhaust(otherScope);
    // The same task has a second budget on another target and phase, with one failure on record.
    await attempt(scope, { errno: 'UND_ERR_CONNECT_TIMEOUT', phase: 'exchange', target: 'idp_token' });
    const exchange = await budgetRow(taskId, 'idp_token', 'exchange');

    await grantOf(taskId, incident);
    clock += 600_000;
    expect((await core.reserveFault!(scope, RESERVE))?.allowed).toBe(true);

    expect(await episodeStates(taskId)).toEqual(['resolved']);
    expect(await episodeStates(other)).toEqual(['exhausted']);
    expect((await core.reserveFault!(otherScope, RESERVE))?.allowed).toBe(false);
    expect(await budgetRow(other)).toMatchObject({ attempts: 3, totalAttempts: 3 });
    expect(await budgetRow(taskId, 'idp_token', 'exchange')).toMatchObject({
      attempts: exchange!.attempts, totalAttempts: exchange!.totalAttempts, deadline: exchange!.deadline,
    });
  });
});

describe('the owner entry and the gateway', () => {
  test('the owner command validates its input, and its receipt says what happens next', async () => {
    const taskId = await makeTask('授权：入口校验与回执');
    await exhaust({ taskId, employeeId: 't-eng' });
    const incident = (await budgetRow(taskId))!.lastIncident!;
    const base = { command: 'fault.grant', taskId, target: TARGET, phase: PHASE, incident };
    await expect(ownerCommand({ ...base, note: GRANT_NOTE })).rejects.toThrow('idempotencyKey invalid');
    await expect(ownerCommand({ ...base, note: 'x', idempotencyKey: 'grant-key-0001' })).rejects.toThrow('note invalid');
    await expect(ownerCommand({ ...base, taskId: 'no-such-task', note: GRANT_NOTE, idempotencyKey: 'grant-key-0001' }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await grantRows()).toBe(0);

    const receipt = await ownerCommand({ ...base, note: GRANT_NOTE, idempotencyKey: 'grant-key-0001' }) as GrantReceipt;
    expect(receipt.replayed).toBe(false);
    expect(receipt.window).toEqual({ maxAttempts: 3, totalDeadlineMs: 120_000, opensAt: expect.any(String) });
    expect(receipt.next).toContain('下一次真实尝试');
  });

  test('employees and automation cannot call fault.grant', () => {
    // Employees are refused at the gateway and in the sidecar journal through the lifecycle list (the owner-end
    // employee list is derived from it); the owner API refuses runners and automation directly.
    expect(LIFECYCLE_COMMANDS).toContain('fault.grant');
    expect(OWNER_API_COMMANDS).toContain('fault.grant');
    for (const actorKind of ['runner', 'automation'] as const) {
      expect(judge({ actorKind, actor: `${actorKind}:test`, command: 'fault.grant', now: 0 }, {}).allow).toBe(false);
    }
    expect(judge({ actorKind: 'owner', actor: 'owner:web', command: 'fault.grant', now: 0 }, {}).allow).toBe(true);
  });
});
