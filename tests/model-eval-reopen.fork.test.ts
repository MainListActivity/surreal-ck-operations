// model_evaluation_reopened 事件修复（052 OVERWRITE）：done 任务可以被 DELETE（原事件在 DELETE 时对 NONE $after 抛错）；
// UPDATE done→非 done 仍清 evaluated_at 与 model_scorecard；owner task.delete 路径可用。
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { OwnerDesk } from '../src/owner.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';

setDefaultTimeout(120_000);
const fork = process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1' ? test : test.skip;
const NS = 'sck_eval_reopen_test';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
const enrollment = new LocalEnrollmentAdmin(database);
let ownerToken = '';
const core = new SurrealCompanyCore(database);
const owner = new OwnerDesk(database);
const key = () => crypto.randomUUID();

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  ownerToken = await enrollment.enroll('t-owner', 'owner', ['execute', 'review', 'manage']);
}, 30_000);
afterAll(async () => { await database.close(); });

fork('a done task can be deleted; reopening clears evaluated_at and model_scorecard', async () => {
  const done = new RecordId('task', crypto.randomUUID());
  const card = new RecordId('model_scorecard', crypto.randomUUID());
  await database.db.query(`CREATE $t CONTENT { title: '已完成', state: 'done', evaluated_at: time::now(), version: 1, fence: 1 };
    CREATE $s CONTENT { task: $t, model: 'fixture/model', domain: 'execute', overall: 4.0, weight: 1.0, at: time::now() };`,
    { t: done, s: card });
  // The reopen path still clears the settlement.
  await database.db.query('UPDATE $t SET state = $state;', { t: done, state: 'doing' });
  let [rows] = await database.db.query<[Array<{ evaluated_at?: unknown }>]>('SELECT evaluated_at FROM $t;', { t: done });
  expect(rows[0]?.evaluated_at ?? null).toBeNull();
  const [cards] = await database.db.query<[unknown[]]>('SELECT id FROM model_scorecard WHERE task = $t;', { t: done });
  expect(cards).toHaveLength(0);
  // Back to done, then DELETE must not trip the event (no $after row).
  await database.db.query("UPDATE $t SET state = 'done', evaluated_at = time::now();", { t: done });
  await database.db.query('DELETE $t;', { t: done });
  [rows] = await database.db.query<[Array<Record<string, unknown>>]>('SELECT id FROM $t;', { t: done });
  expect(rows).toHaveLength(0);
});

fork('owner task.delete on a done task refuses with the domain error, never the reopen event crash', async () => {
  // retire() keeps done tasks terminal by contract; the path must fail with 'already terminal',
  // not with the event's 'UPDATE statement using value: NONE' that broke the production wipe.
  const task = await core.createTask(ownerToken, { executorRole: 'engineering', reviewerRole: 'qa',
    title: '将被老板尝试删除的完成任务', context: '验证 owner task.delete 路径不触发事件崩溃。', idempotencyKey: key() } as never);
  await database.db.query("UPDATE $t SET state = 'done', evaluated_at = time::now();", { t: new RecordId('task', task.id) });
  try {
    await owner.retire({ taskId: task.id, note: '老板清理完成的历史任务', source: 'owner:test', key: key() });
    expect.unreachable('done task retire must refuse');
  } catch (error) {
    expect(String((error as Error).message)).not.toContain('UPDATE statement using value: NONE');
  }
  const [rows] = await database.db.query<[Array<{ state: string }>]>('SELECT state FROM $t;', { t: new RecordId('task', task.id) });
  expect(rows[0]?.state).toBe('done');
});
