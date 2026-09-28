import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { CompanyError, SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import type { LeaseProof } from '../src/contracts.ts';
import type { OutboxEvent } from '../src/contracts.ts';

const database = new CompanyDatabase({
  ...loadDatabaseConfig(),
  namespace: 'sck_agent_company_test',
  database: 'control_plane',
});
setDefaultTimeout(120000);
const core = new SurrealCompanyCore(database);
const enrollment = new LocalEnrollmentAdmin(database);
const suffix = randomUUID().slice(0, 8);
let gm: string, engA: string, engB: string, engC: string, engD: string, engE: string, engF: string, engG: string, qa: string;

beforeAll(async () => {
  await database.connect();
  await database.bootstrap();
  gm = await enrollment.enroll(`test-gm-${suffix}`, 'gm', ['execute', 'review', 'manage']);
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
  expect((await core.authenticate(gm)).role).toBe('gm');
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
    executorRole: 'engineering', reviewerRole: 'qa', dependencies: [parent.id],
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
  const newClaim = await core.claim(engD, parent.id);
  expect(newClaim.fence).toBe(firstClaim.fence + 1);
  await expect(core.submit(engC, oldProof, {
    text: 'Fenced old execution must not deliver this task.', idempotencyKey: `fenced-${suffix}`,
  })).rejects.toBeInstanceOf(CompanyError);
  const newProof: LeaseProof = { taskId: parent.id, deliveryId: newClaim.deliveryId,
    fence: newClaim.fence, expectedVersion: newClaim.task.version };
  const blocked = await core.block(engD, newProof, 'gm', {
    text: 'Synthetic blocker requiring manager recovery.', idempotencyKey: `block-${suffix}`,
  });
  expect(blocked.state).toBe('blocked');
  const resumed = await core.resume(gm, parent.id, {
    text: 'Synthetic blocker resolved by manager.', idempotencyKey: `resume-${suffix}`,
  });
  expect(resumed.state).toBe('doing');
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
    executorRole: 'gm', reviewerRole: 'qa', idempotencyKey: `forbidden-${suffix}`,
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
