import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { OwnerDesk } from '../src/owner.ts';

// SYS-DISP AC03 (R7) on the real database: when a dispatch-blocked notice closes, the close is written to the task's audit stream,
// once. Repeated ends (ticks, restarts) write nothing further. Own namespace, so nothing here shares state with other files.
const NS = 'sck_agent_company_test_sysdisp_audit';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
const owner = new OwnerDesk(database);
setDefaultTimeout(180_000);

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
});

afterAll(async () => {
  await database.close();
});

const taskId = 'audit-fixture-task';
const dispatchKey = (phase: 'execute' | 'review') => `dispatch-blocked:${taskId}:${phase}`;
const unblockedRows = async () => {
  const [rows] = await database.db.query<[Array<{ action: string; actor: string; evidence: string }>]>(
    'SELECT action, actor, evidence, at FROM audit WHERE task = $task AND action = $action ORDER BY at;',
    { task: new RecordId('task', taskId), action: 'dispatch_unblocked' });
  return rows ?? [];
};

test('a dispatch-blocked notice that closes writes one dispatch_unblocked audit row; repeated ends write nothing more', async () => {
  expect(await owner.raiseNotice(dispatchKey('execute'), '执行无法派工（会话占用中）')).toBe(true);
  // The open notice is closed by the first end, which is audited with the reason and the system actor.
  await owner.resolveNotice(dispatchKey('execute'), { task: taskId, evidence: 'dispatch-blocked execute episode ended: dispatched' });
  let rows = await unblockedRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'dispatch_unblocked', actor: 'system:dispatcher', evidence: 'dispatch-blocked execute episode ended: dispatched' });
  // Ticks and restarts end the same episode again: nothing open, so no further row.
  for (let n = 0; n < 10; n++) await owner.resolveNotice(dispatchKey('execute'), { task: taskId, evidence: 'dispatch-blocked execute episode ended: dispatched' });
  rows = await unblockedRows();
  expect(rows).toHaveLength(1);
  // An end for a notice that was never raised writes nothing either.
  await owner.resolveNotice(dispatchKey('review'), { task: taskId, evidence: 'dispatch-blocked review episode ended: work left the queue' });
  expect(await unblockedRows()).toHaveLength(1);
});

test('without an audit target the end is only a notice change, as before', async () => {
  expect(await owner.raiseNotice('staff:engineering', '旧的岗位级通知')).toBe(true);
  await owner.resolveNotice('staff:engineering');
  expect((await owner.openNotices()).some(notice => notice.key === 'staff:engineering')).toBe(false);
  expect(await unblockedRows()).toHaveLength(1);
});
