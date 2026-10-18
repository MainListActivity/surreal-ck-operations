import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { TOMBSTONE } from '../src/dispatcher/artifact-reclaim.ts';
import { ArtifactReclaimer, dbArtifactTasks } from '../src/dispatcher/artifact-sweeper.ts';
import type { CreateTask } from '../src/contracts.ts';
import { RecordId } from 'surrealdb';

const recId = (table: string, part: string) => new RecordId(table, part);

setDefaultTimeout(60000);
// Isolated company fork on a private RocksDB store: no production data, credentials or dispatcher.
const run = process.env.RUN_SCK_ARTIFACT_FORK_TESTS === '1' ? test : test.skip;
const MB = 1_048_576;

let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, home: string;
let gm: string, eng: string, qa: string, count = 0;

beforeAll(async () => {
  if (process.env.RUN_SCK_ARTIFACT_FORK_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-artifact-fork-')));
  home = join(dir, 'home');
  for (const sub of ['evidence', 'deliverables', 'logs']) mkdirSync(join(home, sub), { recursive: true });
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'artifact_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db);
  const admin = new LocalEnrollmentAdmin(db);
  gm = await admin.enroll('artifact-gm', 'gm', ['execute', 'review', 'manage']);
  eng = await admin.enroll('artifact-eng', 'engineering', ['execute', 'review']);
  qa = await admin.enroll('artifact-qa', 'qa', ['execute', 'review']);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const text = (what: string) => ({ text: `${what} — long enough to satisfy the evidence validation`, idempotencyKey: `af-${++count}-${crypto.randomUUID()}` });
const proofOf = (c: { task: { id: string; version: number }; deliveryId: string; fence: number }) =>
  ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });

const newTask = (over: Partial<CreateTask> = {}) => core.createTask(gm, {
  title: `artifact task ${++count}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa',
  idempotencyKey: `af-task-${count}-${crypto.randomUUID()}`, ...over,
} as never);

async function accepted(taskId: string): Promise<string> {
  const claim = await core.claim(eng, taskId);
  await core.submit(eng, proofOf(claim), text(`submit ${taskId}`));
  const review = await core.claim(qa, taskId);
  const accepted = await core.accept(qa, proofOf(review), text(`accept ${taskId}`));
  return accepted.id;
}

/** One task driven all the way to accepted `done`. */
async function acceptedTask(over: Partial<CreateTask> = {}): Promise<string> {
  return accepted((await newTask(over)).id);
}

function seedArtifacts(taskId: string, bytes = 5 * MB): void {
  for (const kind of ['evidence', 'deliverables']) {
    const at = join(home, kind, taskId);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'payload.bin'), Buffer.alloc(bytes, 1));
    writeFileSync(join(at, 'report.md'), '# trail');
  }
}

const reclaimer = (config: Record<string, unknown> = {}) => new ArtifactReclaimer({
  home,
  tasks: dbArtifactTasks(db.db),
  config: async () => ({
    artifactReclaimEnabled: true, artifactEvidenceGraceDays: 0, artifactDeliverableGraceDays: 0,
    artifactHeadroomMb: 10_240, minFreeDiskMb: 10_240, ...config,
  }) as never,
  env: {},
});

run('an accepted task past its grace is trimmed in both kinds', async () => {
  const taskId = await acceptedTask();
  seedArtifacts(taskId);
  const result = await reclaimer().reclaim({ trigger: 'sweep' });
  expect(result.trimmed.map(t => `${t.kind}:${t.taskId}`).sort()).toEqual([`deliverables:${taskId}`, `evidence:${taskId}`]);
  for (const kind of ['evidence', 'deliverables']) {
    expect(readdirSync(join(home, kind, taskId)).sort()).toEqual([TOMBSTONE, 'report.md']);
  }
});

run('the terminal clock is the last audit row, so a just-accepted task keeps its artifacts', async () => {
  const taskId = await acceptedTask();
  seedArtifacts(taskId);
  const result = await reclaimer({ artifactEvidenceGraceDays: 7, artifactDeliverableGraceDays: 7 }).reclaim({ trigger: 'sweep' });
  expect(result.trimmed).toEqual([]);
  expect(result.skipped['within-grace']).toBe(2);
  expect(readdirSync(join(home, 'evidence', taskId))).toContain('payload.bin');
});

run('an ancestor of unfinished work stays intact; once the child finishes it is reclaimable', async () => {
  const parentId = await acceptedTask({ title: `parent ${++count}` });
  seedArtifacts(parentId);
  const child = await newTask({ title: `child ${count}`, dependencies: [parentId] });

  const held = await reclaimer().reclaim({ trigger: 'sweep' });
  expect(held.trimmed.map(t => t.taskId)).not.toContain(parentId);
  expect(held.skipped['needed-by-open-task']).toBeGreaterThanOrEqual(1);
  expect(readdirSync(join(home, 'evidence', parentId))).toContain('payload.bin');

  // Finish the child; the parent is nobody's ancestor any more.
  await accepted(child.id);
  const freed = await reclaimer().reclaim({ trigger: 'sweep' });
  expect(freed.trimmed.map(t => t.taskId)).toContain(parentId);
  expect(readdirSync(join(home, 'evidence', parentId))).toContain(TOMBSTONE);
});

run('pressure reclaims an ancestor a grandchild still needs, but never a direct dependency', async () => {
  // root (done) ← mid (done) ← leaf (open). leaf is the only unfinished task, so
  // mid is a direct dependency and root only an indirect one.
  const root = await acceptedTask({ title: `root ${++count}` });
  seedArtifacts(root);
  const mid = await acceptedTask({ title: `mid ${count}`, dependencies: [root] });
  seedArtifacts(mid);
  const leaf = await newTask({ title: `leaf ${count}`, dependencies: [mid] });

  // Normally the unfinished chain protects both ancestors.
  const normal = await reclaimer().reclaim({ trigger: 'sweep' });
  expect(normal.trimmed.map(t => t.taskId)).not.toContain(root);
  expect(normal.trimmed.map(t => t.taskId)).not.toContain(mid);

  // Under pressure the indirect ancestor gives way; the direct dependency does not.
  const pressured = await reclaimer().reclaim({ trigger: 'pressure', targetFreeMb: Number.MAX_SAFE_INTEGER });
  expect(pressured.trimmed.map(t => t.taskId)).toContain(root);
  expect(pressured.trimmed.map(t => t.taskId)).not.toContain(mid);
  expect(readdirSync(join(home, 'evidence', mid))).toContain('payload.bin');
  // The unfinished leaf never had artifacts, and reclaim never invents them.
  expect(existsSync(join(home, 'evidence', leaf.id))).toBe(false);
});

run('retired work is reclaimable sooner than accepted work', async () => {
  const task = await newTask({ title: `doomed ${++count}` });
  await core.retireTask(gm, { taskId: task.id, text: 'obsolete duplicate', idempotencyKey: `af-retire-${count}-${crypto.randomUUID()}` });
  seedArtifacts(task.id);
  // Seven days for accepted work would normally protect this; void uses the 1-day window.
  expect((await reclaimer({ artifactEvidenceGraceDays: 7, artifactDeliverableGraceDays: 7 }).reclaim({ trigger: 'sweep' })).trimmed).toEqual([]);
  // Age the terminal event past the void window (its audit rows, not a file mtime).
  await db.db.query('UPDATE audit SET at = time::now() - 2d WHERE task = $task;', { task: recId('task', task.id) });
  // Terminal clocks are cached per process on purpose, so a fresh reclaimer re-reads them.
  const retired = await reclaimer({ artifactEvidenceGraceDays: 7, artifactDeliverableGraceDays: 7 }).reclaim({ trigger: 'sweep' });
  expect(retired.trimmed.map(t => t.taskId).sort()).toEqual([task.id, task.id]);
  expect(retired.trimmed.every(t => t.state === 'void')).toBe(true);
  expect(retired.trimmed.map(t => t.reason)).toEqual(['past-grace', 'past-grace']);
});

run('the ledger and tombstone agree on what was removed', async () => {
  const taskId = await acceptedTask();
  seedArtifacts(taskId, 3 * MB);
  await reclaimer().reclaim({ trigger: 'sweep' });
  const tombstone = JSON.parse(await Bun.file(join(home, 'evidence', taskId, TOMBSTONE)).text());
  expect(tombstone.taskId).toBe(taskId);
  expect(tombstone.removedBytes).toBe(3 * MB);
  expect(tombstone.taskState).toBe('done');
  const lines = readdirSync(join(home, 'logs'));
  expect(lines).toContain('artifact-reclaim.jsonl');
  const records = (await Bun.file(join(home, 'logs', 'artifact-reclaim.jsonl')).text()).trim().split('\n').map(l => JSON.parse(l));
  const summary = records.find(r => r.summary);
  expect(summary.trimmed).toBe(2);
  expect(summary.freeDiskMbBefore).toBeUndefined(); // no probe wired in this fixture
});