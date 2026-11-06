import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { CompanyError, SurrealCompanyCore, asId, id } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import type { LeaseProof } from '../src/contracts.ts';
import type { OutboxEvent } from '../src/contracts.ts';

const database = new CompanyDatabase({
  ...loadDatabaseConfig(),
  namespace: 'sck_agent_company_test',
  database: 'control_plane',
});
setDefaultTimeout(300000);
const core = new SurrealCompanyCore(database);
const enrollment = new LocalEnrollmentAdmin(database);
const suffix = randomUUID().slice(0, 8);
let gm: string, engA: string, engB: string, engC: string, engD: string, engE: string, engF: string, engG: string, qa: string;

beforeAll(async () => {
  await database.connect();
  await database.bootstrap();
  gm = await enrollment.enroll(`test-gm-${suffix}`, 'owner', ['execute', 'review', 'manage']);
  engA = await enrollment.enroll(`test-enga-${suffix}`, 'engineering', ['execute', 'review']);
  engB = await enrollment.enroll(`test-engb-${suffix}`, 'engineering', ['execute', 'review']);
  engC = await enrollment.enroll(`test-engc-${suffix}`, 'engineering', ['execute', 'review']);
  engD = await enrollment.enroll(`test-engd-${suffix}`, 'engineering', ['execute', 'review']);
  engE = await enrollment.enroll(`test-enge-${suffix}`, 'engineering', ['execute', 'review']);
  engF = await enrollment.enroll(`test-engf-${suffix}`, 'engineering', ['execute', 'review']);
  engG = await enrollment.enroll(`test-engg-${suffix}`, 'engineering', ['execute', 'review']);
  qa = await enrollment.enroll(`test-qa-${suffix}`, 'qa', ['execute', 'review']);
});

afterAll(async () => { await database.close(); });

async function allOutbox(): Promise<OutboxEvent[]> {
  const rows: OutboxEvent[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const batch = await core.listOutbox(gm, after);
    if (batch.length === 0) return rows;
    rows.push(...batch);
    after = batch.at(-1)!.id;
  }
  throw new Error('Outbox pagination exceeded test safety bound');
}

test('real DB: bootstrap, identity, concurrent claim, fencing, idempotency, independent review', async () => {
  expect((await core.authenticate(gm)).role).toBe('owner');
  const first = await core.createTask(gm, {
    title: `First integration task ${suffix}`, context: 'Synthetic integration task in isolated company DB.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `create-first-${suffix}`,
  });
  expect(first.state).toBe('ready');
  const same = await core.createTask(gm, {
    title: `First integration task ${suffix}`, context: 'Synthetic integration task in isolated company DB.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `create-first-${suffix}`,
  });
  expect(same.id).toBe(first.id);
  await expect(core.createTask(gm, {
    title: `Changed task ${suffix}`, context: 'Same key with changed payload must fail.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `create-first-${suffix}`,
  })).rejects.toMatchObject({ code: 'conflict' });
  const claims = await Promise.allSettled([core.claim(engA, first.id), core.claim(engB, first.id)]);
  expect(claims.filter(x => x.status === 'fulfilled')).toHaveLength(1);
  const winnerIndex = claims.findIndex(x => x.status === 'fulfilled');
  const winningToken = winnerIndex === 0 ? engA : engB;
  const losingToken = winnerIndex === 0 ? engB : engA;
  const claim = (claims[winnerIndex] as PromiseFulfilledResult<Awaited<ReturnType<typeof core.claim>>>).value;
  expect(claim.task.state).toBe('doing');
  const second = await core.createTask(gm, {
    title: `Second integration task ${suffix}`, context: 'Separate task for same-role parallel worker.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `create-second-${suffix}`,
  });
  const otherClaim = await core.claim(losingToken, second.id);
  expect(otherClaim.task.currentEmployee).not.toBe(claim.task.currentEmployee);
  const proof: LeaseProof = { taskId: first.id, deliveryId: claim.deliveryId,
    fence: claim.fence, expectedVersion: claim.task.version };
  const checkpoint = await core.checkpoint(winningToken, proof, {
    text: 'Synthetic checkpoint evidence recorded in database.', idempotencyKey: `checkpoint-${suffix}`,
  });
  expect(checkpoint.version).toBe(claim.task.version + 1);
  await expect(core.submit(winningToken, proof, {
    text: 'Stale version must not submit this task.', idempotencyKey: `stale-${suffix}`,
  })).rejects.toBeInstanceOf(CompanyError);
  const currentProof = { ...proof, expectedVersion: checkpoint.version };
  const delivered = await core.submit(winningToken, currentProof, {
    text: 'Synthetic delivery with durable evidence and idempotency.', idempotencyKey: `submit-${suffix}`,
  });
  expect(delivered.state).toBe('review');
  const replay = await core.submit(winningToken, currentProof, {
    text: 'Synthetic delivery with durable evidence and idempotency.', idempotencyKey: `submit-${suffix}`,
  });
  expect(replay.version).toBe(delivered.version);
  const [submitEvents] = await database.db.query<[Array<{ id: RecordId }>]>(
    "SELECT * FROM outbox WHERE task = $task AND kind = 'submit';", { task: new RecordId('task', first.id) }
  );
  expect(submitEvents).toHaveLength(1);
  await expect(core.claim(winningToken, first.id)).rejects.toMatchObject({ code: 'self_review' });
  const review = await core.claim(qa, first.id);
  const accepted = await core.accept(qa, { taskId: first.id, deliveryId: review.deliveryId,
    fence: review.fence, expectedVersion: review.task.version }, {
    text: 'Independent review accepted integration evidence.', idempotencyKey: `accept-${suffix}`,
  });
  expect(accepted.state).toBe('done');
  expect((await allOutbox()).some(e => e.taskId === first.id && e.kind === 'accept')).toBe(true);
  expect(otherClaim.task.state).toBe('doing');
});

test('real DB: expired lease fences old writer, dependencies and blocked recovery persist', async () => {
  const parent = await core.createTask(gm, {
    title: `Dependency parent ${suffix}`, context: 'Synthetic dependency parent in isolated database.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `parent-${suffix}`,
  });
  const child = await core.createTask(gm, {
    title: `Dependency child ${suffix}`, context: 'Synthetic dependent task in isolated database.',
    executorRole: 'engineering', reviewerRole: 'qa',
    idempotencyKey: `child-${suffix}`,
  });
  expect(child.state).toBe('blocked');
  const shortLeaseCore = new SurrealCompanyCore(database, { leaseSeconds: 1 });
  const firstClaim = await shortLeaseCore.claim(engC, parent.id);
  await Bun.sleep(1500);
  const oldProof: LeaseProof = { taskId: parent.id, deliveryId: firstClaim.deliveryId,
    fence: firstClaim.fence, expectedVersion: firstClaim.task.version };
  await expect(core.checkpoint(engC, oldProof, {
    text: 'Expired lease must not write this checkpoint.', idempotencyKey: `expired-${suffix}`,
  })).rejects.toMatchObject({ code: 'lease_expired' });
  // The bound implementer's lease expired: another engineer's claim fences it once.
  const newClaim = await core.claim(engD, parent.id);
  expect(newClaim.fence).toBe(firstClaim.fence + 1);
  await expect(core.submit(engC, oldProof, {
    text: 'Fenced old execution must not deliver this task.', idempotencyKey: `fenced-${suffix}`,
  })).rejects.toBeInstanceOf(CompanyError);
  const newProof: LeaseProof = { taskId: parent.id, deliveryId: newClaim.deliveryId,
    fence: newClaim.fence, expectedVersion: newClaim.task.version };
  const blocked = await core.block(engD, newProof, 'owner', {
    text: 'Synthetic blocker requiring manager recovery.', idempotencyKey: `block-${suffix}`,
  });
  expect(blocked.state).toBe('blocked');
  const resumed = await core.resume(gm, parent.id, {
    text: 'Synthetic blocker resolved by manager.', idempotencyKey: `resume-${suffix}`,
  });
  expect(resumed.state).toBe('ready');
  const reclaimed = await core.claim(engD, parent.id);
  const submitted = await core.submit(engD, {
    taskId: parent.id, deliveryId: reclaimed.deliveryId,
    fence: reclaimed.fence, expectedVersion: reclaimed.task.version,
  }, { text: 'Completed dependency parent with independent review.', idempotencyKey: `parent-submit-${suffix}` });
  expect(submitted.state).toBe('review');
  const review = await core.claim(qa, parent.id);
  await core.accept(qa, { taskId: parent.id, deliveryId: review.deliveryId,
    fence: review.fence, expectedVersion: review.task.version }, {
    text: 'Accepted parent and unlocked dependent task.', idempotencyKey: `parent-accept-${suffix}`,
  });
  expect((await core.getTask(gm, child.id)).state).toBe('ready');
  const markerBefore = await database.db.select(new RecordId('company_meta', 'installation'));
  await database.bootstrap();
  const markerAfter = await database.db.select(new RecordId('company_meta', 'installation'));
  expect(markerAfter).toEqual(markerBefore);
  expect((await core.getTask(gm, child.id)).state).toBe('ready');
  await enrollment.revoke(`test-engc-${suffix}`);
  await expect(core.authenticate(engC)).rejects.toBeInstanceOf(CompanyError);
});

test('real DB: heartbeat, one active task, return and outbox cursor', async () => {
  await expect(core.createTask(engE, {
    title: 'Forbidden task', context: 'A normal worker cannot create tasks.',
    executorRole: 'owner', reviewerRole: 'qa', idempotencyKey: `forbidden-${suffix}`,
  })).rejects.toBeInstanceOf(CompanyError);
  const one = await core.createTask(gm, {
    title: `Return task one ${suffix}`, context: 'Synthetic return path test.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `return-one-${suffix}`,
  });
  const two = await core.createTask(gm, {
    title: `Return task two ${suffix}`, context: 'Synthetic same-employee lease guard.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `return-two-${suffix}`,
  });
  const claim = await core.claim(engE, one.id);
  await expect(core.claim(engE, two.id)).rejects.toBeInstanceOf(CompanyError);
  const proof: LeaseProof = { taskId: one.id, deliveryId: claim.deliveryId,
    fence: claim.fence, expectedVersion: claim.task.version };
  const heartbeat = await core.heartbeat(engE, proof);
  expect(heartbeat.task.version).toBe(claim.task.version);
  expect(heartbeat.fence).toBe(claim.fence);
  const submitted = await core.submit(engE, proof, {
    text: 'Synthetic submission for independent return.', idempotencyKey: `return-submit-${suffix}`,
  });
  expect(submitted.state).toBe('review');
  const reviewer = await core.claim(qa, one.id);
  const returned = await core.returnTask(qa, {
    taskId: one.id, deliveryId: reviewer.deliveryId,
    fence: reviewer.fence, expectedVersion: reviewer.task.version,
  }, { text: 'Synthetic review found a required correction.', idempotencyKey: `return-review-${suffix}` });
  expect(returned.state).toBe('ready');
  const secondClaim = await core.claim(engE, two.id);
  expect(secondClaim.task.state).toBe('doing');
  const events = await allOutbox();
  const cursor = events.findIndex(event => event.taskId === one.id);
  expect(cursor).toBeGreaterThanOrEqual(0);
  const after = await core.listOutbox(gm, events[cursor]!.id);
  expect(after.every(event => event.id !== events[cursor]!.id)).toBe(true);
});

test('real DB: persisted outbox pagination beyond 1000 and concurrent append stays reachable', async () => {
  const seed = await core.createTask(gm, {
    title: `Outbox page seed ${suffix}`, context: 'Synthetic outbox pagination in isolated company database.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `page-seed-${suffix}`,
  });
  const [counter] = await database.db.query<[{ value: number }]>(
    'SELECT * FROM ONLY company_meta:outbox_counter;'
  );
  const count = 1005;
  const rows = Array.from({ length: count }, (_, index) => ({
    id: new RecordId('outbox', `page-${suffix}-${index}`),
    sequence: counter.value + index + 1,
    task: new RecordId('task', seed.id),
    kind: 'test-page', payload: { index }, at: new Date(),
  }));
  const responses = await database.db.query(
    'BEGIN; UPDATE ONLY company_meta:outbox_counter SET value += $count; INSERT INTO outbox $rows; COMMIT;',
    { count, rows }
  ).responses();
  expect(responses.every(response => response.success)).toBe(true);
  const first = await core.listOutbox(gm);
  expect(first).toHaveLength(1000);
  const appended = await core.createTask(gm, {
    title: `Outbox appended task ${suffix}`, context: 'Event written after first outbox page was read.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `page-append-${suffix}`,
  });
  const seen = [...first];
  let cursor = first.at(-1)!.id;
  for (let page = 0; page < 30; page++) {
    const next = await core.listOutbox(gm, cursor);
    if (next.length === 0) break;
    expect(next[0]!.sequence).toBeGreaterThan(seen.at(-1)!.sequence);
    seen.push(...next);
    cursor = next.at(-1)!.id;
  }
  expect(seen.filter(event => event.kind === 'test-page' && event.taskId === seed.id)).toHaveLength(count);
  expect(seen.some(event => event.taskId === appended.id && event.kind === 'created')).toBe(true);
  expect(new Set(seen.map(event => event.sequence)).size).toBe(seen.length);
});

test('real DB: different tasks can be claimed concurrently by same-role workers', async () => {
  const [a, b] = await Promise.all([
    core.createTask(gm, { title: `Parallel A ${suffix}`, context: 'First independent concurrent task.',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `parallel-a-${suffix}` }),
    core.createTask(gm, { title: `Parallel B ${suffix}`, context: 'Second independent concurrent task.',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `parallel-b-${suffix}` }),
  ]);
  const claims = await Promise.all([core.claim(engF, a.id), core.claim(engG, b.id)]);
  expect(claims.map(claim => claim.task.state)).toEqual(['doing', 'doing']);
  expect(claims[0]!.task.currentEmployee).not.toBe(claims[1]!.task.currentEmployee);
  const events = await allOutbox();
  expect(events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true);
});

test('real DB: retire_task voids work, unblocks dependents, idempotent, releases leases', async () => {
  const engX = await enrollment.enroll(`test-engx-${suffix}`, 'engineering', ['execute', 'review']);
  const qaManage = await enrollment.enroll(`test-qam-${suffix}`, 'qa', ['execute', 'review', 'manage']);

  // --- capability + role gate ---
  const gateTask = await core.createTask(gm, {
    title: `Retire gate target ${suffix}`, context: 'Synthetic target for capability denial.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `retire-gate-${suffix}`,
  });
  await expect(core.retireTask(engX, {
    taskId: gateTask.id, text: 'no manage cap', idempotencyKey: `retire-nocap-${suffix}`,
  })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(core.retireTask(qaManage, {
    taskId: gateTask.id, text: 'manage cap but wrong role', idempotencyKey: `retire-role-${suffix}`,
  })).rejects.toMatchObject({ code: 'forbidden' });

  // --- retire a blocked dependency: dependent chain unlocks ---
  const dep = await core.createTask(gm, {
    title: `Retire dep ${suffix}`, context: 'Duplicate-chain member to be voided.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `retire-dep-${suffix}`,
  });
  const child = await core.createTask(gm, {
    title: `Retire child ${suffix}`, context: 'Blocked on the soon-voided dep.',
    executorRole: 'engineering', reviewerRole: 'qa',
    idempotencyKey: `retire-child-${suffix}`,
  });
  const grandchild = await core.createTask(gm, {
    title: `Retire grandchild ${suffix}`, context: 'Two hops downstream of the voided dep.',
    executorRole: 'engineering', reviewerRole: 'qa',
    idempotencyKey: `retire-grandchild-${suffix}`,
  });
  // 下游只被作废依赖卡住的任务当场解锁；被别的未完依赖卡住的按兵不动。
  const otherDep = await core.createTask(gm, {
    title: `Retire other dep ${suffix}`, context: 'A second still-pending dependency.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `retire-otherdep-${suffix}`,
  });
  const mixedChild = await core.createTask(gm, {
    title: `Retire mixed child ${suffix}`, context: 'Blocked on voided dep AND a live dep.',
    executorRole: 'engineering', reviewerRole: 'qa',
    idempotencyKey: `retire-mixed-${suffix}`,
  });
  expect(child.state).toBe('blocked');
  expect(mixedChild.state).toBe('blocked');

  const retired = await core.retireTask(gm, {
    taskId: dep.id, text: '撞车产生的重复链成员，作废。', idempotencyKey: `retire-dep-do-${suffix}`,
  });
  expect(retired.state).toBe('void');
  expect(retired.currentEmployee).toBeUndefined();
  // 依赖清理：child 只剩 void 依赖 → ready；mixedChild 仍有未满足依赖 → 保持 blocked
  expect((await core.getTask(gm, child.id)).state).toBe('ready');
  expect((await core.getTask(gm, grandchild.id)).state).toBe('blocked'); // 还在等 child
  expect((await core.getTask(gm, mixedChild.id)).state).toBe('blocked');

  // 幂等：同 key 重放返回原结果；新 key 对 void 任务为空操作（version 不动）
  const replayed = await core.retireTask(gm, {
    taskId: dep.id, text: '撞车产生的重复链成员，作废。', idempotencyKey: `retire-dep-do-${suffix}`,
  });
  expect(replayed.version).toBe(retired.version);
  const again = await core.retireTask(gm, {
    taskId: dep.id, text: '重复作废应为幂等空操作。', idempotencyKey: `retire-dep-again-${suffix}`,
  });
  expect(again.state).toBe('void');
  expect(again.version).toBe(retired.version);
  await expect(core.retireTask(gm, {
    taskId: dep.id, text: '同 key 不同载荷必须冲突。', idempotencyKey: `retire-dep-do-${suffix}`,
  })).rejects.toMatchObject({ code: 'conflict' });

  // void 任务不可领取/恢复/延期
  await expect(core.claim(engX, dep.id)).rejects.toBeInstanceOf(CompanyError);
  await expect(core.resume(gm, dep.id, {
    text: 'Resume a void task must be denied.', idempotencyKey: `resume-void-${suffix}`,
  })).rejects.toBeInstanceOf(CompanyError);

  // 新任务依赖 void 任务视为已满足 → 直接 ready
  const freeChild = await core.createTask(gm, {
    title: `Retire free child ${suffix}`, context: 'Created after the dep was voided.',
    executorRole: 'engineering', reviewerRole: 'qa',
    idempotencyKey: `retire-freechild-${suffix}`,
  });
  expect(freeChild.state).toBe('ready');

  // 全链路验收：child 正常走完 → grandchild 由常规 accept 解锁
  const childClaim = await core.claim(engX, child.id);
  const childProof: LeaseProof = { taskId: child.id, deliveryId: childClaim.deliveryId,
    fence: childClaim.fence, expectedVersion: childClaim.task.version };
  await core.submit(engX, childProof, {
    text: 'Chain leg after retire completes normally.', idempotencyKey: `retire-child-submit-${suffix}`,
  });
  const childReview = await core.claim(qa, child.id);
  await core.accept(qa, { taskId: child.id, deliveryId: childReview.deliveryId,
    fence: childReview.fence, expectedVersion: childReview.task.version }, {
    text: 'Accept unlocks the grandchild.', idempotencyKey: `retire-child-accept-${suffix}`,
  });
  expect((await core.getTask(gm, grandchild.id)).state).toBe('ready');

  // --- 在执任务作废：释放租约、清 active_task、持有人续写被拒、下游解锁 ---
  const doingDep = await core.createTask(gm, {
    title: `Retire in-flight dep ${suffix}`, context: 'Claimed and then voided mid-flight.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `retire-inflight-${suffix}`,
  });
  const doingChild = await core.createTask(gm, {
    title: `Retire in-flight child ${suffix}`, context: 'Blocked on the in-flight dep.',
    executorRole: 'engineering', reviewerRole: 'qa',
    idempotencyKey: `retire-inflight-child-${suffix}`,
  });
  const engY = await enrollment.enroll(`test-engy-${suffix}`, 'engineering', ['execute', 'review']);
  const liveClaim = await core.claim(engY, doingDep.id);
  expect(liveClaim.task.state).toBe('doing');
  const voided = await core.retireTask(gm, {
    taskId: doingDep.id, text: '在执任务作废：释放租约。', idempotencyKey: `retire-inflight-do-${suffix}`,
  });
  expect(voided.state).toBe('void');
  expect(voided.currentEmployee).toBeUndefined();
  expect(voided.leaseExpiresAt).toBeUndefined();
  // 持有人旧租约的一切写操作被拒（'task retired' → conflict）
  const staleProof: LeaseProof = { taskId: doingDep.id, deliveryId: liveClaim.deliveryId,
    fence: liveClaim.fence, expectedVersion: liveClaim.task.version };
  await expect(core.checkpoint(engY, staleProof, {
    text: 'Lease released by retire must refuse writes.', idempotencyKey: `retire-stale-${suffix}`,
  })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('retired') });
  // active_task 已清：同一员工可立即领取别的任务（unblocked 下游此时 ready）
  const nextClaim = await core.claim(engY, doingChild.id);
  expect(nextClaim.task.state).toBe('doing');
  expect(nextClaim.task.id).toBe(doingChild.id);

  // --- done 任务拒绝作废；expectedVersion 乐观并发 ---
  const finished = await core.createTask(gm, {
    title: `Retire finished ${suffix}`, context: 'Done tasks refuse retirement.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `retire-fin-${suffix}`,
  });
  const finClaim = await core.claim(engX, finished.id);
  await core.submit(engX, { taskId: finished.id, deliveryId: finClaim.deliveryId,
    fence: finClaim.fence, expectedVersion: finClaim.task.version },
    { text: 'Finishing before retire attempt.', idempotencyKey: `retire-fin-submit-${suffix}` });
  const finReview = await core.claim(qa, finished.id);
  await core.accept(qa, { taskId: finished.id, deliveryId: finReview.deliveryId,
    fence: finReview.fence, expectedVersion: finReview.task.version },
    { text: 'Accepting this task to done state.', idempotencyKey: `retire-fin-accept-${suffix}` });
  await expect(core.retireTask(gm, {
    taskId: finished.id, text: 'done 任务不可作废', idempotencyKey: `retire-fin-do-${suffix}`,
  })).rejects.toMatchObject({ code: 'conflict' });
  await expect(core.retireTask(gm, {
    taskId: gateTask.id, text: 'version 漂移拒绝', idempotencyKey: `retire-ver-${suffix}`,
    expectedVersion: 999,
  })).rejects.toMatchObject({ code: 'conflict' });
  await expect(core.retireTask(gm, {
    taskId: 'no-such-task', text: '不存在任务', idempotencyKey: `retire-missing-${suffix}`,
  })).rejects.toMatchObject({ code: 'not_found' });

  // --- owner 关口保护：作废未获批原型不得放行量产下游 ---
  const proto = await core.createTask(gm, {
    title: `Retire proto ${suffix}`, context: 'Concept-design prototype awaiting owner demo.',
    executorRole: 'concept-design', reviewerRole: 'owner', kind: 'task',
    idempotencyKey: `retire-proto-${suffix}`,
  });
  const mass = await core.createTask(gm, {
    title: `Retire mass ${suffix}`, context: 'Mass production gated on the owner demo.',
    executorRole: 'asset-production', reviewerRole: 'owner',
    idempotencyKey: `retire-mass-${suffix}`,
  });
  expect(mass.state).toBe('blocked');
  // 有存活下游时拒绝退役原型
  await expect(core.retireTask(gm, {
    taskId: proto.id, text: '绕过 owner 关口退役原型', idempotencyKey: `retire-proto-do-${suffix}`,
  })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('dependents') });
  expect((await core.getTask(gm, proto.id)).state).toBe('ready');
  expect((await core.getTask(gm, mass.id)).state).toBe('blocked');
  // 正确顺序：先退役下游，再退役原型
  await core.retireTask(gm, {
    taskId: mass.id, text: '先收尾废弃下游量产。', idempotencyKey: `retire-mass-do-${suffix}`,
  });
  const voidedProto = await core.retireTask(gm, {
    taskId: proto.id, text: '下游已清，退役原型。', idempotencyKey: `retire-proto-do2-${suffix}`,
  });
  expect(voidedProto.state).toBe('void');
  // 新建量产引用 void 原型不得视为 demo 已批准 → 保持 blocked
  const lateMass = await core.createTask(gm, {
    title: `Retire late mass ${suffix}`, context: 'New mass task referencing a voided prototype.',
    executorRole: 'asset-production', reviewerRole: 'owner',
    idempotencyKey: `retire-latemass-${suffix}`,
  });
  expect(lateMass.state).toBe('blocked');

  // --- 并发同 key 同载荷：两笔都按幂等重放返回同一结果 ---
  const raceTarget = await core.createTask(gm, {
    title: `Retire race ${suffix}`, context: 'Concurrent identical retire calls must both succeed.',
    executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `retire-race-${suffix}`,
  });
  const raceInput = {
    taskId: raceTarget.id, text: '并发相同请求幂等测试。', idempotencyKey: `retire-race-do-${suffix}`,
  };
  const [r1, r2] = await Promise.allSettled([core.retireTask(gm, raceInput), core.retireTask(gm, raceInput)]);
  expect(r1.status).toBe('fulfilled');
  expect(r2.status).toBe('fulfilled');
  if (r1.status === 'fulfilled' && r2.status === 'fulfilled') {
    expect(r1.value.state).toBe('void');
    expect(r2.value.version).toBe(r1.value.version);
  }

  // --- 锚点死锁回归：owner 关口下游只剩锚点簿记时可退役，锚点不再被该 dep 卡住 ---
  // quick 目标模板：链 d0(release)→d1(deploy)，锚点 manual 依赖 d1；
  // GOAL_ANCHOR_SQL 会把每个新任务追加进锚点 dependencies，原型因此必有锚点下游。
  const [grows] = await database.db.query<[Array<{ id: RecordId }>]>("CREATE goal CONTENT { title: '退役锚点回归', brief: 'fixture', state: 'active', source: 'fixture', note: '', tasks: {}, anchors: [], created_at: time::now() } RETURN AFTER;");
  const goal = { id: asId(grows[0]!.id) };
  const protoG = await core.createTask(gm, {
    title: `Goal proto ${suffix}`, context: 'Owner-gated prototype inside a goal.',
    executorRole: 'concept-design', reviewerRole: 'owner', goalId: goal.id,
    idempotencyKey: `retire-protoG-${suffix}`,
  });
  const massG = await core.createTask(gm, {
    title: `Goal mass ${suffix}`, context: 'Mass production gated on the prototype.',
    executorRole: 'asset-production', reviewerRole: 'owner', goalId: goal.id,
    idempotencyKey: `retire-massG-${suffix}`,
  });
  const [anchorIds] = await database.db.query<[RecordId[]]>(
    'SELECT VALUE anchors FROM ONLY $g;', { g: id('goal', goal.id) });
  expect(anchorIds.length).toBeGreaterThan(0);
  const anchorId = asId(anchorIds[0]);
  const anchorDeps = (await core.getTask(gm, anchorId)).dependencies;
  expect(anchorDeps).toContain(protoG.id);
  expect(anchorDeps).toContain(massG.id);
  // 锚点之外还有存活量产下游：退役原型仍被拒
  await expect(core.retireTask(gm, {
    taskId: protoG.id, text: '锚点豁免不该放行量产下游', idempotencyKey: `retire-protoG-do-${suffix}`,
  })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('dependents') });
  // 先退役量产下游，再退役原型：此时下游只剩锚点簿记，退役放行
  await core.retireTask(gm, {
    taskId: massG.id, text: '退役量产后清原型。', idempotencyKey: `retire-massG-do-${suffix}`,
  });
  expect((await core.retireTask(gm, {
    taskId: protoG.id, text: '下游仅剩锚点，退役原型。', idempotencyKey: `retire-protoG-do2-${suffix}`,
  })).state).toBe('void');
  // 锚点（簿记）把 void 一律视为已满足：清掉模板链剩余节点后锚点解锁为 ready
  const [chainIds] = await database.db.query<[RecordId[]]>(
    `SELECT VALUE id FROM task WHERE goal = $g AND state NOT IN ['done','void'] AND id NOT IN $anchors;`,
    { g: id('goal', goal.id), anchors: anchorIds });
  for (const tid of chainIds) {
    await core.retireTask(gm, {
      taskId: asId(tid), text: '清模板链剩余节点。', idempotencyKey: `retire-chain-${asId(tid)}-${suffix}`,
    });
  }
  expect((await core.getTask(gm, anchorId)).state).toBe('ready');
});
