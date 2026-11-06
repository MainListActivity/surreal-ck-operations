// 评分批量节奏（spec 阶段三）：LLM eval 每 eval_batch_hours 一条批量消息，列出最多 30 个未评分或
// Jev 低置信的 done 任务；消息走 outbound_message（step=eval）。Jev 逐任务评分不受影响。
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { Workforce } from '../src/workforce.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';

setDefaultTimeout(120_000);
const fork = process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1' ? test : test.skip;
const NS = 'sck_eval_batch_test';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
const credDir = mkdtempSync(join(tmpdir(), 'sck-eval-batch-'));
const workforce = new Workforce(database, credDir);
const messages = new OutboundMessageStore(database.db);

const doneTask = async (id: string, evaluated = false) => {
  try {
    return await database.db.query(`CREATE $t CONTENT { title: 'eval 批候选 ${id}', state: 'done', executor_role: 'engineering',
    reviewer_role: 'qa', version: 1, fence: 1, created_at: time::now(), evaluated_at: ${evaluated ? 'time::now()' : 'NONE'} };`,
    { t: new RecordId('task', id) });
  } catch (e) { console.log('CREATEERR', id, (e as Error).message); throw e; }
};

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
}, 30_000);
afterAll(async () => { await database.close(); rmSync(credDir, { recursive: true, force: true }); });

fork('eval batch: unscored or Jev-low-confidence done tasks join one batch, capped at 30; cadence reads the last sent eval row', async () => {
  for (let i = 1; i <= 33; i++) await doneTask(`eb-${String(i).padStart(2, '0')}`);
  await doneTask('eb-scored', true); // already evaluated: not a candidate
  // A Jev low-confidence verdict (flagged scorecard) re-enters the batch.
  try {
    await database.db.query(`CREATE $s CONTENT { task: $t, employee: 'eng-a', quality: 2.0, evidence: 2.0,
    discipline: 2.0, timeliness: 2.0, overall: 2.0, eval_by: 'jev', flagged: true, at: time::now() };`,
    { s: new RecordId('scorecard', 'eb_flagged'), t: new RecordId('task', 'eb-flagged') });
  } catch (e) { console.log('SCOREERR', (e as Error).message); throw e; }
  await doneTask('eb-flagged', true);

  let batch; try { batch = await workforce.pendingEvalBatch(0.7, 30); } catch (e) { console.log('BATCHERR', (e as Error).message); throw e; }
  expect(batch.length).toBe(30); // 33 unscored + 1 flagged − cap 30
  expect(batch.every(task => task.state === 'done')).toBe(true);
  try { expect(await workforce.lastEvalBatchAt()).toBe(0); } catch (e) { console.log('BATCHATERR', (e as Error).message); throw e; } // nothing sent yet

  // The batch message is one eval step row listing the ids; sending it marks the cadence.
  const body = `按 agents/eval.md 的评分规则为以下完成任务的本轮参与员工逐个 record_score：${batch.map(task => task.id).join('、')}。`;
  let draft; try { draft = await messages.createDraft(batch[0].id, 'eval', 'eval', false, 'done', body); } catch (e) { console.log('DRAFTERR', (e as Error).message); throw e; }
  expect(draft.body).toContain(batch[0].id);
  expect(draft.body).toContain('record_score');
  try { await messages.markSent(draft.id, 'eval-fixture', draft.body); } catch (e) { console.log('MARKERR', (e as Error).message); throw e; }
  const lastAt = await workforce.lastEvalBatchAt();
  expect(lastAt).toBeGreaterThan(0);
  expect(Date.now() - lastAt).toBeLessThan(60_000); // within the 24h cadence window → next tick skips
});
