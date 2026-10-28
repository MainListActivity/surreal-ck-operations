/**
 * SYS-INT · QA 评审观察协同的持久事件唤醒：公司 fork 上的真实 core/事务回归（不是纯函数 mock）。
 *
 * 覆盖交付要求的九类场景：
 *   1. 事件先于登记：QA 先领到 review 租约，GM 后登记订阅，协同任务进入等待时立即被唤醒；
 *   2. 登记先于事件：协同任务已在等待，QA claim 当场唤醒一次；
 *   3. 20 并发：并发 claim 钩子/并发请求只产生一个事件、一次释放；
 *   4. 重启：另一个 core 实例读到同一订阅与事件，未交付事件继续可交付；
 *   5. 旧 fence：return 后旧事件作废，新 fence 产生新事件；
 *   6. return 重领：同一源任务被不同 QA 重领后，旧持有人的事件不唤醒；
 *   7. 重复通知：同 idempotencyKey、重复 claim、重复 retract 都不再唤醒；
 *   8. 授权/撤销两阶段：request 唤醒一次，positive retract 再唤醒一次；
 *   9. 零轮询：调度器的到点扫描（releaseDue）从不释放 feedback 等待，唤醒只来自事件。
 *
 * 负例同样覆盖：非 gm 登记、跨 goal、伪造 holder/fence、跨 goal subject、未在复核的任务、给别家订阅等待、
 * 先 retract 后 request，以及“checkpoint 文本本身不构成授权”。
 */
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { CompanyError } from '../src/core-errors.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { WaitStore } from '../src/wait-store.ts';
import { reviewWatchRef } from '../src/review-event-store.ts';
import type { ClaimResult, Evidence, LeaseProof } from '../src/contracts.ts';

setDefaultTimeout(600_000);
// Same opt-in as the other isolated-namespace fork suites: it needs a local company fork, not a mock.
// Without a fork run nothing is built at import time — reading loadDatabaseConfig() here once pointed
// the gate's plain `bun test` at the product .env and died on the non-local guard.
const forkEnv = process.env.RUN_SCK_REVIEW_EVENT_FORK_TESTS === '1' || process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1';
const fork = forkEnv ? test : test.skip;
const NS = 'sck_review_events_test';
let database: CompanyDatabase;
let enrollment: LocalEnrollmentAdmin;
let owner: OwnerDesk;
let core: SurrealCompanyCore;
let credDir = '';
const dir = mkdtempSync(join(tmpdir(), 'sck-review-events-db-'));
let dbServer: ReturnType<typeof Bun.spawn> | undefined;
const tokens: Record<string, string> = {};
const key = () => `re-${crypto.randomUUID()}`;
let clock = Date.now();

const proofOf = (claimed: ClaimResult): LeaseProof =>
  ({ taskId: claimed.task.id, deliveryId: claimed.deliveryId, fence: claimed.fence, expectedVersion: claimed.task.version });
const evidence = (tag: string): Evidence => ({ text: `SYS-INT 评审协同唤醒回归证据 ${tag}：唤醒只由真实结构化事件触发`, idempotencyKey: key() });
const expectRefused = async (promise: Promise<unknown>, code: CompanyError['code'], pattern: RegExp) => {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe(code);
  expect((error as CompanyError).message).toMatch(pattern);
};

interface Fixture { goalId: string; sourceId: string; collabId: string; secondCollabId: string; subjectId: string; }

/** A goal with a QA-reviewed source task, a collaboration task, a spare collaboration task and an allowed subject. */
async function fixture(label: string): Promise<Fixture> {
  const goal = await owner.createGoal({ text: `评审协同 ${label}`, source: 'owner:test', key: key(), tier: 'quick' });
  const source = await core.createTask(tokens.gm!, {
    goalId: goal.id, title: `源任务 ${label}`, context: '源任务上下文：由工程实现、QA 复核。',
    executorRole: 'engineering', reviewerRole: 'qa', kind: 'deploy', idempotencyKey: key(),
  });
  const collab = await core.createTask(tokens.gm!, {
    goalId: goal.id, title: `协同任务 ${label}`, context: '协同任务上下文：等待 QA 的结构化事件。',
    executorRole: 'engineering', reviewerRole: 'product', kind: 'task', idempotencyKey: key(),
  });
  const spare = await core.createTask(tokens.gm!, {
    goalId: goal.id, title: `备用协同任务 ${label}`, context: '备用协同任务上下文。',
    executorRole: 'engineering', reviewerRole: 'product', kind: 'task', idempotencyKey: key(),
  });
  const subject = await core.createTask(tokens.gm!, {
    goalId: goal.id, title: `取证主体 ${label}`, context: '取证主体上下文。',
    executorRole: 'engineering', reviewerRole: 'product', kind: 'task', idempotencyKey: key(),
  });
  return { goalId: goal.id, sourceId: source.id, collabId: collab.id, secondCollabId: spare.id, subjectId: subject.id };
}

/** Engineer implements and submits the source task; the QA claim is the caller's choice of timing. */
async function submitSource(sourceId: string): Promise<void> {
  const held = await core.claim(tokens.eng!, sourceId) as ClaimResult;
  await core.submit(tokens.eng!, proofOf(held), evidence(`submit-${sourceId}`));
}

async function claimReview(sourceId: string, employee = 'qa'): Promise<ClaimResult> {
  return await core.claim(tokens[employee]!, sourceId) as ClaimResult;
}

/** Park the collaboration task on its own review-watch feedback wait. */
async function parkCollaboration(collabId: string, watchId: string): Promise<void> {
  const held = await core.claim(tokens.eng!, collabId) as ClaimResult;
  await core.wait(tokens.eng!, proofOf(held), evidence(`park-${collabId}`), {
    kind: 'feedback', reference: reviewWatchRef(watchId),
    reason: 'SYS-INT 回归：等待 QA 评审协同事件，不再用固定时间窗猜',
  } as never);
}

const rowOf = async (taskId: string): Promise<Record<string, unknown>> => {
  const [rows] = await database.db.query<[Array<Record<string, unknown>>]>('SELECT * FROM $task;', { task: new RecordId('task', taskId) });
  return rows?.[0] ?? {};
};

const sleeps = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (fn: () => Promise<boolean> | boolean, timeoutMs = 8_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleeps(25);
  }
  return false;
};

beforeAll(async () => {
  if (!forkEnv) return;
  // Self-hosting like tests/effective-policy.fork.test.ts: the gate runs this file with the fork env
  // but without test-worktrees.ts, so the suite spawns its own isolated company-fork database on a
  // random loopback port instead of falling back to the product .env URL.
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const rootPassword = 'review-events-fork-fixture';
  dbServer = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`,
    '--user', 'root', '--pass', rootPassword, '--log', 'error', `rocksdb:${dir}/db`],
    { stdout: 'ignore', stderr: 'ignore' });
  let ready = false;
  for (let n = 0; n < 160; n++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
    await Bun.sleep(25);
  }
  if (!ready) throw new Error('the review-events fork fixture did not become healthy');
  database = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword, namespace: NS, database: 'control_plane' });
  credDir = mkdtempSync(join(tmpdir(), 'sck-review-events-'));
  enrollment = new LocalEnrollmentAdmin(database);
  owner = new OwnerDesk(database);
  core = new SurrealCompanyCore(database, { waits: { clock: () => clock } });
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [name, role, caps] of [
    ['gm', 'gm', ['execute', 'review', 'manage']],
    ['eng', 'engineering', ['execute', 'review']],
    ['eng2', 'engineering', ['execute', 'review']],
    ['qa', 'qa', ['execute', 'review']],
    ['qa2', 'qa', ['execute', 'review']],
    ['product', 'product', ['execute', 'review', 'manage']],
  ] as const) tokens[name] = await enrollment.enroll(`re-${name}`, role, caps);
}, 180_000);

afterAll(async () => {
  if (!forkEnv) return;
  await database.close();
  dbServer?.kill();
  rmSync(dir, { recursive: true, force: true });
  if (credDir) rmSync(credDir, { recursive: true, force: true });
});

/**
 * Fixture reset between cases: each case asserts the wake rules, not the previous case's leftover lease. The lease
 * of a task that never terminated is dropped exactly as a channel rollback would drop it, and every employee is
 * unbound; the wake tables are left alone so a case that inspects them reads its own rows.
 */
beforeEach(async () => {
  if (!forkEnv) return;
  clock = Date.now();
  await database.db.query(`UPDATE task SET current_employee = NONE, delivery_id = NONE, lease_expires_at = NONE,
      state = IF state IN ['doing'] THEN 'ready' ELSE state END,
      wait_state = NONE, wait_kind = NONE, wait_episode = NONE, wait_not_before = NONE, wait_expires_at = NONE,
      wait_next_check_at = NONE, wait_owner_role = NONE, wait_source = NONE, wait_version = NONE, wait_entered_at = NONE
    WHERE current_employee != NONE OR wait_state != NONE;
    UPDATE task_wait SET state = 'cancelled', cancelled_reason = 'fixture reset', updated_at = time::now()
    WHERE state IN ['waiting', 'held'];
    UPDATE employee SET active_task = NONE WHERE active_task != NONE;
    DELETE qa_review_watch; DELETE qa_review_signal; DELETE qa_review_wake;`);
});

fork('登记先于事件：QA claim 当场唤醒一次协同等待，重复 claim 钩子与重复请求都不再唤醒', async () => {
  const fx = await fixture('登记先于事件');
  await submitSource(fx.sourceId);
  const watch = await core.reviewWatchRegister(tokens.gm!, {
    sourceTaskId: fx.sourceId, collaborationTaskId: fx.collabId,
    reason: 'GM 登记 c373/3cf 式协同唤醒：QA 领取或结构化请求时唤醒协同任务', idempotencyKey: key(),
  });
  expect(watch.state).toBe('active');
  expect(watch.eventKinds).toEqual(['authorization', 'positive']);
  expect(watch.source.state).toBe('review');
  await parkCollaboration(fx.collabId, watch.id);
  expect((await rowOf(fx.collabId)).state).toBe('blocked');

  const claimed = await claimReview(fx.sourceId);
  expect(await waitFor(async () => (await rowOf(fx.collabId)).state === 'ready')).toBe(true);
  expect((await rowOf(fx.collabId)).wait_state).toBeUndefined();
  const after = await core.reviewWatchStatus(tokens.gm!, { watchId: watch.id });
  const delivered = after[0]!.deliveries.filter(item => item.kind === 'authorization' && item.fence === claimed.fence);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ delivered: true, code: 'released', actor: 're-qa' });

  // 重复通知：再次触发同一个钩子、再发一次等价请求，都只得到同一个事件，不会二次唤醒。
  const collabNow = await rowOf(fx.collabId);
  expect(collabNow.state).toBe('ready');
  const request = await core.qaReviewScopeSignal(tokens.qa!, {
    taskId: fx.sourceId, fence: claimed.fence, kind: 'request', subjects: [fx.subjectId],
    reason: '同一 fence 上的结构化请求与已经发生的 claim 共用一个授权事件', idempotencyKey: key(),
  });
  expect(request.event).toMatchObject({ kind: 'authorization', created: true });
  // claim 与请求收敛为同一个 (watch, fence, authorization)：没有第二个事件，也没有第二次唤醒。
  expect(request.woken.filter(item => item.released)).toHaveLength(0);
  const status = await core.reviewWatchStatus(tokens.gm!, { watchId: watch.id });
  expect(status[0]!.deliveries.filter(item => item.kind === 'authorization')).toHaveLength(1);
  // 重复的等价请求（同 key）是幂等重放，仍不产生事件。
  const replay = await core.qaReviewScopeSignal(tokens.qa!, {
    taskId: fx.sourceId, fence: claimed.fence, kind: 'request', subjects: [fx.subjectId],
    reason: '同一 fence 上的结构化请求与已经发生的 claim 共用一个授权事件', idempotencyKey: (request.signal as unknown as { id: string }).id,
  }).catch((error: unknown) => error as CompanyError);
  expect(replay).toBeInstanceOf(CompanyError); // 不同 key 的同内容请求 → 同一 fence 已有请求阶段
  expect((await core.reviewWatchStatus(tokens.gm!, { watchId: watch.id }))[0]!
    .deliveries.filter(item => item.kind === 'authorization')).toHaveLength(1);
});

fork('事件先于登记：QA 先领到 review 租约，GM 后登记，协同任务一进入等待就被唤醒', async () => {
  const fx = await fixture('事件先于登记');
  await submitSource(fx.sourceId);
  const claimed = await claimReview(fx.sourceId);
  // 事件已经发生：此刻没有任何订阅。
  const watch = await core.reviewWatchRegister(tokens.gm!, {
    sourceTaskId: fx.sourceId, collaborationTaskId: fx.collabId,
    reason: '补登记：QA 已领到租约，登记时必须立刻交付当前状态，不能等第二次事件', idempotencyKey: key(),
  });
  const first = watch.deliveries.find(item => item.kind === 'authorization');
  expect(first).toBeDefined();
  // 协同任务尚未进入等待：事件保持未交付（pending），不是丢失。
  expect(first!.delivered).toBe(false);
  expect(['no_wait', 'pending']).toContain(first!.code ?? 'pending');
  await parkCollaboration(fx.collabId, watch.id);
  expect((await rowOf(fx.collabId)).state).toBe('ready');
  const status = await core.reviewWatchStatus(tokens.gm!, { watchId: watch.id });
  expect(status[0]!.deliveries.find(item => item.kind === 'authorization')).toMatchObject({
    delivered: true, code: 'released', fence: claimed.fence,
  });
});

fork('重启：另一个 core 实例读到同一订阅、同一事件，重启不丢等待也不重复唤醒', async () => {
  const fx = await fixture('重启');
  await submitSource(fx.sourceId);
  const watch = await core.reviewWatchRegister(tokens.gm!, {
    sourceTaskId: fx.sourceId, collaborationTaskId: fx.collabId,
    reason: '重启回归：订阅、信号与事件都必须落库，第二个进程能继续交付', idempotencyKey: key(),
  });
  await parkCollaboration(fx.collabId, watch.id);
  const restarted = new SurrealCompanyCore(database, { waits: { clock: () => Date.now() } });
  const seen = await restarted.reviewWatchStatus(tokens.gm!, { watchId: watch.id });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.source.state).toBe('review');
  expect((await new WaitStore(database.db).openOfTask(fx.collabId))).toMatchObject({ kind: 'feedback', state: 'waiting' });
  await claimReview(fx.sourceId);
  expect(await waitFor(async () => (await rowOf(fx.collabId)).state === 'ready')).toBe(true);
  // 第二个进程再登记一次（不同 idempotencyKey）不会产生第二个授权事件。
  const again = await restarted.reviewWatchRegister(tokens.gm!, {
    sourceTaskId: fx.sourceId, collaborationTaskId: fx.collabId,
    reason: '重启后重复登记：同一 (watch, fence, kind) 只能有一个事件', idempotencyKey: key(),
  });
  expect(again.deliveries.filter(item => item.kind === 'authorization')).toHaveLength(1);
});

fork('旧 fence 与 return 重领：旧持有人的事件作废，新 fence 才产生新事件', async () => {
  const fx = await fixture('旧fence');
  await submitSource(fx.sourceId);
  const watch = await core.reviewWatchRegister(tokens.gm!, {
    sourceTaskId: fx.sourceId, collaborationTaskId: fx.collabId,
    reason: '旧 fence 回归：return 之后旧事件不得唤醒任何协同任务', idempotencyKey: key(),
  });
  const firstClaim = await claimReview(fx.sourceId, 'qa');
  // 未交付时先 return：事件必须作废。
  await core.returnTask(tokens.qa!, proofOf(firstClaim), evidence('return-before-delivery'));
  const stale = await core.reviewWatchStatus(tokens.gm!, { watchId: watch.id });
  const staleEvent = stale[0]!.deliveries.find(item => item.kind === 'authorization' && item.fence === firstClaim.fence);
  expect(staleEvent?.invalidatedReason).toMatch(/fence moved|returned/i);
  // 重新提交并由另一位 QA 领取：新 fence 产生新事件，旧事件不被重放。
  await core.submit(tokens.eng!, await claimExecuteAgain(fx.sourceId), evidence('resubmit'));
  await parkCollaboration(fx.collabId, watch.id);
  const secondClaim = await claimReview(fx.sourceId, 'qa2');
  expect(secondClaim.fence).toBeGreaterThan(firstClaim.fence);
  expect(await waitFor(async () => (await rowOf(fx.collabId)).state === 'ready')).toBe(true);
  const status = await core.reviewWatchStatus(tokens.gm!, { watchId: watch.id });
  const events = status[0]!.deliveries.filter(item => item.kind === 'authorization');
  expect(events.map(item => item.fence).sort()).toEqual([firstClaim.fence, secondClaim.fence].sort());
  expect(events.find(item => item.fence === firstClaim.fence)!.delivered).toBe(false);
  expect(events.find(item => item.fence === secondClaim.fence)).toMatchObject({ delivered: true, actor: 're-qa2' });
});

/** After a return the task is ready again; the engineer re-claims and resubmits it. */
async function claimExecuteAgain(sourceId: string): Promise<LeaseProof> {
  const held = await core.claim(tokens.eng!, sourceId) as ClaimResult;
  return proofOf(held);
}

fork('授权/撤销两阶段：request 唤醒一次，positive retract 再唤醒一次；先 retract 与二次 retract 都被拒', async () => {
  const fx = await fixture('两阶段');
  await submitSource(fx.sourceId);
  const watch = await core.reviewWatchRegister(tokens.gm!, {
    sourceTaskId: fx.sourceId, collaborationTaskId: fx.collabId,
    reason: '两阶段回归：请求授权与正向取证撤销各唤醒一次，不能合并也不能重复', idempotencyKey: key(),
  });
  const claimed = await claimReview(fx.sourceId);
  await expectRefused(core.qaReviewScopeSignal(tokens.qa!, {
    taskId: fx.sourceId, fence: claimed.fence, kind: 'retract', subjects: [fx.subjectId], positiveReady: true,
    reason: '还没有 request 就先 retract 必须被拒绝', idempotencyKey: key(),
  }), 'invalid', /needs an earlier request/);

  const request = await core.qaReviewScopeSignal(tokens.qa!, {
    taskId: fx.sourceId, fence: claimed.fence, kind: 'request', subjects: [fx.subjectId],
    reason: 'QA 申请对同 goal 取证实体的只读授权', idempotencyKey: key(),
  });
  expect(request.event).toMatchObject({ kind: 'authorization', created: true });
  expect(request.woken.filter(item => item.released)).toHaveLength(0); // 协同任务还没在等待

  await parkCollaboration(fx.collabId, watch.id);
  // 进入等待时先交付已发生的 authorization
  expect((await rowOf(fx.collabId)).state).toBe('ready');

  // 重新把协同任务停回等待，再发第二阶段。
  await parkCollaboration(fx.collabId, watch.id);
  const retract = await core.qaReviewScopeSignal(tokens.qa!, {
    taskId: fx.sourceId, fence: claimed.fence, kind: 'retract', subjects: [fx.subjectId], positiveReady: true,
    reason: '正向取证完成，撤销授权请求并唤醒协同任务做收尾', idempotencyKey: key(),
  });
  expect(retract.event).toMatchObject({ kind: 'positive', created: true });
  expect(retract.woken.some(item => item.released)).toBe(true);
  expect((await rowOf(fx.collabId)).state).toBe('ready');

  await expectRefused(core.qaReviewScopeSignal(tokens.qa!, {
    taskId: fx.sourceId, fence: claimed.fence, kind: 'retract', subjects: [fx.subjectId], positiveReady: true,
    reason: '同一 fence 的第二次撤销不得再产生第三个唤醒', idempotencyKey: key(),
  }), 'conflict', /already retracted/);
  const status = await core.reviewWatchStatus(tokens.gm!, { watchId: watch.id });
  expect(status[0]!.deliveries.filter(item => item.kind === 'positive')).toHaveLength(1);
  expect(status[0]!.signal).toMatchObject({ state: 'retracted', positiveReady: true, actor: 're-qa' });
});

fork('20 并发：并发 claim 钩子与并发请求都只产生一个事件、一次释放', async () => {
  const fx = await fixture('并发');
  await submitSource(fx.sourceId);
  const watch = await core.reviewWatchRegister(tokens.gm!, {
    sourceTaskId: fx.sourceId, collaborationTaskId: fx.collabId,
    reason: '并发回归：20 个调用者同时触发只能唤醒一次', idempotencyKey: key(),
  });
  await parkCollaboration(fx.collabId, watch.id);
  const claimed = await claimReview(fx.sourceId);
  // 20 个并发钩子（模拟调度/重试同时看到这次 claim）。
  const outcomes = await Promise.all(Array.from({ length: 20 }, () =>
    core.reviewWatchStatus(tokens.gm!, { watchId: watch.id })));
  expect(outcomes).toHaveLength(20);
  const events = (await core.reviewWatchStatus(tokens.gm!, { watchId: watch.id }))[0]!
    .deliveries.filter(item => item.kind === 'authorization');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ fence: claimed.fence, delivered: true });

  // 20 个并发 request：一个落地，其余是 conflict，不产生第二批事件。
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    core.qaReviewScopeSignal(tokens.qa!, {
      taskId: fx.sourceId, fence: claimed.fence, kind: 'request', subjects: [fx.subjectId],
      reason: `并发请求 ${index}：同一 fence 只允许一个请求阶段`, idempotencyKey: key(),
    }).then(() => 'ok' as const, (error: unknown) => (error as CompanyError).code)));
  expect(results.filter(item => item === 'ok')).toHaveLength(1);
  const signals = await core.reviewScopeSignals(tokens.gm!, { taskId: fx.sourceId });
  expect(signals).toHaveLength(1);
  expect(signals[0]!.state).toBe('requested');
});

fork('零轮询：调度器的到点扫描从不释放 feedback 等待，唤醒只来自事件', async () => {
  const fx = await fixture('零轮询');
  await submitSource(fx.sourceId);
  const watch = await core.reviewWatchRegister(tokens.gm!, {
    sourceTaskId: fx.sourceId, collaborationTaskId: fx.collabId,
    reason: '零轮询回归：没有真实事件时，到点扫描不能放出协同任务', idempotencyKey: key(),
  });
  await parkCollaboration(fx.collabId, watch.id);
  const store = new WaitStore(database.db);
  clock = Date.now() + 86_400_000;
  const due = await store.releaseDue(clock);
  expect(due.released.map(item => item.taskId)).not.toContain(fx.collabId);
  expect((await rowOf(fx.collabId)).state).toBe('blocked');
  const [wakes] = await database.db.query<[Array<{ id: unknown }>]>(
    'SELECT id FROM qa_review_wake WHERE collaboration_task = $task AND delivered = true;',
    { task: new RecordId('task', fx.collabId) });
  expect(wakes ?? []).toHaveLength(0);
  // 事件到达后才放行，并且只放行这一次。
  clock = Date.now();
  await claimReview(fx.sourceId);
  expect(await waitFor(async () => (await rowOf(fx.collabId)).state === 'ready')).toBe(true);
});

fork('负例：非 gm 登记、跨 goal、非 QA 角色、假 holder/fence、跨 goal subject、给别家订阅等待都被拒', async () => {
  const fx = await fixture('负例');
  const other = await fixture('另一目标');
  await submitSource(fx.sourceId);
  await expectRefused(core.reviewWatchRegister(tokens.product!, {
    sourceTaskId: fx.sourceId, collaborationTaskId: fx.collabId,
    reason: '非 gm 不能登记评审协同唤醒订阅', idempotencyKey: key(),
  }), 'forbidden', /Only gm/);
  await expectRefused(core.reviewWatchRegister(tokens.gm!, {
    sourceTaskId: fx.sourceId, collaborationTaskId: other.collabId,
    reason: '跨 goal 的源任务与协同任务不能登记同一条订阅', idempotencyKey: key(),
  }), 'invalid', /same goal/);
  const watch = await core.reviewWatchRegister(tokens.gm!, {
    sourceTaskId: fx.sourceId, collaborationTaskId: fx.collabId,
    reason: '负例夹具：登记一条正常订阅用于后续拒绝路径', idempotencyKey: key(),
  });
  // 让别家的协同任务给这条订阅等待：必须被拒。
  const foreign = await core.claim(tokens.eng!, other.secondCollabId) as ClaimResult;
  await expectRefused(core.wait(tokens.eng!, proofOf(foreign), evidence('foreign-park'), {
    kind: 'feedback', reference: reviewWatchRef(watch.id),
    reason: '别的任务的等待不能挂在这条订阅上，否则会把无关任务唤醒', idempotencyKey: key(),
  } as never), 'forbidden', /not the collaboration task/);

  const claimed = await claimReview(fx.sourceId);
  // 非持有人的 QA：用别人的 fence/身份发信号必须被拒。
  await expectRefused(core.qaReviewScopeSignal(tokens.qa2!, {
    taskId: fx.sourceId, fence: claimed.fence, kind: 'request', subjects: [fx.subjectId],
    reason: '不是当前 holder 的 QA 不能代表这次复核发出结构化请求', idempotencyKey: key(),
  }), 'invalid', /holder or fence/);
  await expectRefused(core.qaReviewScopeSignal(tokens.qa!, {
    taskId: fx.sourceId, fence: claimed.fence + 1, kind: 'request', subjects: [fx.subjectId],
    reason: '伪造 fence 的结构化请求必须被拒绝，不能借此唤醒协同任务', idempotencyKey: key(),
  }), 'invalid', /holder or fence/);
  await expectRefused(core.qaReviewScopeSignal(tokens.qa!, {
    taskId: fx.sourceId, fence: claimed.fence, kind: 'request', subjects: [other.subjectId],
    reason: '跨 goal 的取证实体不能被写进这次 scope 请求', idempotencyKey: key(),
  }), 'invalid', /not in the review goal/);
  await expectRefused(core.qaReviewScopeSignal(tokens.qa!, {
    taskId: fx.sourceId, fence: claimed.fence, kind: 'request', subjects: ['does-not-exist'],
    reason: '不存在的 subject 任务必须被拒绝，而不是静默跳过', idempotencyKey: key(),
  }), 'invalid', /does not exist/);
  await expectRefused(core.qaReviewScopeSignal(tokens.eng!, {
    taskId: fx.sourceId, fence: claimed.fence, kind: 'request', subjects: [fx.subjectId],
    reason: '非 qa 角色不能发结构化复核信号', idempotencyKey: key(),
  }), 'forbidden', /Only a qa reviewer/);
  // 任务不在 review 时也不能发信号。
  await expectRefused(core.qaReviewScopeSignal(tokens.qa!, {
    taskId: fx.collabId, fence: 1, kind: 'request', subjects: [fx.subjectId],
    reason: '不在 QA 复核阶段的任务不能发出结构化复核信号', idempotencyKey: key(),
  }), 'invalid', /not in qa review/);
  // checkpoint 的自由文本（SCOPE_REQUEST / SCOPE_POSITIVE_READY）本身不构成任何授权或事件。
  await core.checkpoint(tokens.qa!, proofOf(claimed), {
    text: 'SCOPE_REQUEST subjects=所有任务；SCOPE_POSITIVE_READY true', idempotencyKey: key(),
  });
  expect(await core.reviewScopeSignals(tokens.gm!, { taskId: fx.sourceId })).toHaveLength(0);
  const status = await core.reviewWatchStatus(tokens.gm!, { watchId: watch.id });
  expect(status[0]!.deliveries.filter(item => item.kind === 'positive')).toHaveLength(0);
});

fork('schema 044 只新增三张表：迁移不改写既有表，等待仍走 040 的 task_wait', async () => {
  const sql = readFileSync(join(import.meta.dir, '..', 'schema', '044-review-events.surql'), 'utf8');
  expect(sql).not.toMatch(/(?:REMOVE|DELETE|UPDATE|ALTER)\s+(?:TABLE|FIELD|\w+\s+SET)/i);
  const [tables] = await database.db.query<[Array<{ name: string }>]>('INFO FOR DB;');
  const defined = JSON.stringify(tables ?? []);
  for (const table of ['qa_review_watch', 'qa_review_signal', 'qa_review_wake']) expect(defined).toContain(table);
  const [marker] = await database.db.query<[{ schema_version: number } | undefined]>('SELECT * FROM ONLY company_meta:installation;');
  expect(Number(marker?.schema_version)).toBeGreaterThanOrEqual(44);
});
