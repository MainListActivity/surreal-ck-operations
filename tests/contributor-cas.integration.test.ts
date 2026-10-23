import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import type { ClaimResult } from '../src/contracts.ts';

// SYS-DISP AC04/AC05/AC06 on the real core: the version check that binds contribution facts to a lease write, the review gate
// for a holder whose lease is still open, and the read-only gm dry-run. Own namespace, so nothing here shares state with the other
// integration files.
const NS = 'sck_agent_company_test_sysdisp_cas';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(180_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-sysdisp-cas-'));
const workforce = new Workforce(database, credDir);
const enrollment = new LocalEnrollmentAdmin(database);
const tokens: Record<string, string> = {};

/** Test-only hook state: how many times the hook ran and the task it moves. */
const hook = { calls: 0, bumpOn: (_call: number) => false, taskId: '' };
const core = new SurrealCompanyCore(database, {
  workforce,
  contributionReadHook: async (taskId: string) => {
    hook.calls += 1;
    if (hook.bumpOn(hook.calls)) {
      await database.db.query('UPDATE $task SET version += 1;', { task: new RecordId('task', taskId) });
    }
  },
});

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [name, role, caps] of [
    ['gm', 'gm', ['execute', 'review', 'manage']],
    ['eng-a', 'engineering', ['execute', 'review']], ['eng-b', 'engineering', ['execute', 'review']],
    ['eng-c', 'engineering', ['execute', 'review']],
  ] as const) tokens[name] = await enrollment.enroll(`t-${name}`, role, caps);
});

afterAll(async () => {
  await database.close();
  rmSync(credDir, { recursive: true, force: true });
});

const key = () => crypto.randomUUID();
const proofOf = (c: ClaimResult) => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });
const newTask = (title: string) => core.createTask(tokens.gm, { title, context: 'synthetic SYS-DISP CAS case', executorRole: 'engineering',
  reviewerRole: 'engineering', idempotencyKey: key() });
const auditCount = async (taskId: string) => {
  const [rows] = await database.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM audit WHERE task = $task GROUP ALL;', { task: new RecordId('task', taskId) });
  return rows?.[0]?.n ?? 0;
};
const DELIVERY = 'Synthetic delivery evidence for the SYS-DISP contributor test, long enough for the write gate.';
const REVIEW = 'Synthetic review evidence for the SYS-DISP contributor test, long enough for the write gate.';

test('CAS retry: a claim whose contribution view moved re-reads once and binds the implementer on the fresh facts', async () => {
  const task = await newTask('SYS-DISP CAS retry');
  hook.taskId = task.id;
  hook.calls = 0;
  hook.bumpOn = call => call === 1;
  const claim = await core.claim(tokens['eng-a'], task.id);
  expect(hook.calls).toBe(2);
  expect(claim.task.currentEmployee).toBeDefined();
  const after = await core.getTask(tokens.gm, task.id);
  expect(after.implementer).toBeDefined();
  expect(after.currentEmployee).toBe(after.implementer);
  hook.bumpOn = () => false;
  // Free the lease: one employee holds one task at a time, and the cases below reuse eng-a.
  await core.release(tokens['eng-a'], { ...proofOf(claim) }, { text: 'Synthetic release that frees the lease for the next SYS-DISP case.', idempotencyKey: key() });
});

test('CAS refusal: a view that keeps moving on every try is refused after the retries, and no lease is written', async () => {
  const task = await newTask('SYS-DISP CAS refusal');
  hook.taskId = task.id;
  hook.calls = 0;
  hook.bumpOn = () => true;
  const before = await core.getTask(tokens.gm, task.id);
  await expect(core.claim(tokens['eng-b'], task.id)).rejects.toMatchObject({ code: 'conflict' });
  expect(hook.calls).toBe(5);
  const after = await core.getTask(tokens.gm, task.id);
  expect(after.currentEmployee).toBeUndefined();
  expect(after.implementer).toBeUndefined();
  expect(after.version).toBeGreaterThan(before.version);
  hook.bumpOn = () => false;
});

test('dry-run is gm-only and read-only: it names the authors, the open reviewer and the implementer status, and writes nothing', async () => {
  const task = await newTask('SYS-DISP dry-run');
  const first = await core.claim(tokens['eng-a'], task.id);
  const authorId = first.task.currentEmployee!;
  await core.submit(tokens['eng-a'], proofOf(first), { text: DELIVERY, idempotencyKey: key() });
  const review = await core.claim(tokens['eng-b'], task.id);
  const reviewerId = review.task.currentEmployee!;
  expect(review.task.state).toBe('review');

  const beforeVersion = (await core.getTask(tokens.gm, task.id)).version;
  const beforeAudit = await auditCount(task.id);
  const view = await core.contributorDryRun!(tokens.gm, { taskIds: [task.id] });
  expect(view.readOnly).toBe(true);
  const row = view.tasks[0]!;
  expect(row).toMatchObject({ found: true, status: 'bound', implementer: authorId });
  expect(row.authors).toEqual([authorId]);
  expect(row.excluded).toContain(authorId);
  expect(row.reviewers).toEqual([reviewerId]);
  // The timeline names every contribution row: the execute claim, the implementer binding it recorded, the submit and the
  // review claim. The binding is its own row so a later takeover never erases who wrote the code.
  expect((row.timeline ?? []).map(entry => entry.role).filter(role => role !== 'none')).toEqual(['author', 'author', 'author', 'reviewer']);
  expect((row.timeline ?? []).map(entry => entry.action)).toContain('implementer_bound');
  expect((await core.getTask(tokens.gm, task.id)).version).toBe(beforeVersion);
  expect(await auditCount(task.id)).toBe(beforeAudit);

  await expect(core.contributorDryRun!(tokens['eng-a'], { taskIds: [task.id] })).rejects.toMatchObject({ code: 'forbidden' });
});

test('the open reviewer decides: a holder of a review lease is not counted as an author, so accept goes through', async () => {
  const task = await newTask('SYS-DISP open reviewer');
  const first = await core.claim(tokens['eng-a'], task.id);
  await core.submit(tokens['eng-a'], proofOf(first), { text: DELIVERY, idempotencyKey: key() });
  const review = await core.claim(tokens['eng-c'], task.id);
  const accepted = await core.accept(tokens['eng-c'], proofOf(review), { text: REVIEW, idempotencyKey: key() });
  expect(accepted.state).toBe('done');
});

test('an author never reviews its own work, even while a reviewer holds the lease elsewhere', async () => {
  const task = await newTask('SYS-DISP author refused');
  const first = await core.claim(tokens['eng-a'], task.id);
  await core.submit(tokens['eng-a'], proofOf(first), { text: DELIVERY, idempotencyKey: key() });
  await expect(core.claim(tokens['eng-a'], task.id)).rejects.toMatchObject({ code: 'self_review' });
  expect((await core.getTask(tokens.gm, task.id)).currentEmployee).toBeUndefined();
});

test('dry-run answer is bounded (R3): 20 tasks with 200 audit rows each stay within 24 KiB, keep the newest rows, and mark every cut', async () => {
  const ids: string[] = [];
  for (let n = 0; n < 20; n++) ids.push((await newTask(`SYS-DISP dry-run bound ${n}`)).id);
  // Synthetic non-contribution rows: they fill the timeline without changing any authorship fact.
  for (const taskId of ids) {
    await database.db.query(`FOR $i IN 0..200 { CREATE audit CONTENT { task: $task, actor: 'system:fixture', action: 'fixture_note', evidence: $evidence, version: $i, at: time::now() }; };`,
      { task: new RecordId('task', taskId), evidence: 'synthetic timeline row for the dry-run bound' });
  }
  const view = await core.contributorDryRun!(tokens.gm, { taskIds: ids });
  const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8');
  expect(view.budgetBytes).toBe(24 * 1024);
  expect(bytes).toBeLessThanOrEqual(24 * 1024);
  expect(view.truncated).toBe(true);
  for (const row of view.tasks) {
    expect(row.found).toBe(true);
    expect(row.timelineTotal).toBeGreaterThan(200);
    expect(row.timelineShown).toBe(row.timeline!.length);
    expect(row.timelineTruncated).toBe(true);
    expect(row.timeline!.length).toBeLessThan(row.timelineTotal!);
  }
  // A task with few rows is answered whole and not marked.
  const small = await newTask('SYS-DISP dry-run small');
  const whole = await core.contributorDryRun!(tokens.gm, { taskIds: [small.id] });
  expect(whole.truncated).toBe(false);
  expect(whole.tasks[0]!.timelineTruncated).toBe(false);
  expect(whole.tasks[0]!.timelineShown).toBe(whole.tasks[0]!.timelineTotal);
});
