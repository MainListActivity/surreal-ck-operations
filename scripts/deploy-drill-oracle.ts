// Deploy-drill oracle (SYS-INT). Proves, on the drill database with this release's own code:
//   1. leftover isolation states are not dispatched — a blocked (blocked_to=gm) task is refused at claim;
//   2. zero write — the leftover rows are byte-identical after the refused attempts;
//   3. positive control — a ready task IS claimable, so the zero above is not a dead harness.
// Older releases already contain these RB01 semantics (the oracle assumption is disclosed in the drill
// report): the check proves the drill DB is isolated and the faces did not misdispatch, not that the
// candidate introduced the behavior. The full per-package RB01 suites remain in the release gates.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: deploy-drill-oracle.ts <drill-root>');
  process.exit(2);
}
process.env.SCK_SERVICE_HOME = root;

const { loadDatabaseConfig } = await import('../src/config.ts');
const { CompanyDatabase } = await import('../src/database.ts');
const { SurrealCompanyCore } = await import('../src/core.ts');
const { LocalEnrollmentAdmin } = await import('../src/enrollment.ts');
const { RecordId } = await import('surrealdb');
const id = (table: string, value: string) => new RecordId(table, value);

const db = new CompanyDatabase(loadDatabaseConfig());
await db.connect();
await db.bootstrap();
const core = new SurrealCompanyCore(db);
const enrollment = new LocalEnrollmentAdmin(db);
const gm = await enrollment.enroll('drill-oracle-manager', 'gm', ['execute', 'review', 'manage']);
const eng = await enrollment.enroll('drill-oracle-eng', 'engineering', ['execute']);
await enrollment.enroll('drill-oracle-qa', 'qa', ['review']);

const runKey = createHash('sha256').update(root).digest('hex').slice(0, 12);
const leftover = await core.createTask(gm, { title: 'drill leftover isolation sample', context: 'Seeded by the drill oracle; must never be dispatched.',
  executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `drill-leftover-${runKey}` });
await db.db.query("UPDATE $t MERGE { state: 'blocked', blocked_to: 'gm' };", { t: id('task', leftover.id) });
const control = await core.createTask(gm, { title: 'drill positive control sample', context: 'Seeded by the drill oracle; must be claimable.',
  executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `drill-control-${runKey}` });

const digest = async (taskId: string): Promise<string> => {
  const [row] = await db.db.query<[unknown]>('SELECT * FROM ONLY $t;', { t: id('task', taskId) });
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
};
const leftoverBefore = await digest(leftover.id);

let refused = '';
try {
  await core.claim(eng, leftover.id);
  refused = 'CLAIM UNEXPECTEDLY SUCCEEDED';
} catch (error) {
  refused = String((error as { code?: string }).code ?? error).slice(0, 120);
}
if (refused.includes('UNEXPECTEDLY')) throw new Error(`leftover task was dispatched: ${refused}`);

const controlClaim = await core.claim(eng, control.id);
if (!controlClaim?.deliveryId) throw new Error('positive control task was not claimable; the drill harness is dead');

const leftoverAfter = await digest(leftover.id);
if (leftoverBefore !== leftoverAfter) throw new Error('leftover task row changed during the refused claim; zero-write violated');

const summary = {
  leftoverTask: leftover.id, leftoverRefusal: refused, leftoverDigestUnchanged: true,
  positiveControl: { taskId: control.id, claimed: true, deliveryId: controlClaim.deliveryId },
  policyEpochPresent: Boolean((await db.db.query<[unknown]>('RETURN (SELECT * FROM ONLY company_meta:policy_epoch);'))[0]),
};
console.log(`DRILL_ORACLE_OK ${JSON.stringify(summary)}`);
// The core import leaves live sockets and timers behind; the drill runner consumes stdout, so exit.
process.exit(0);
