import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { ProjectStore } from '../src/projects.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private RocksDB store: no production data, credentials or dispatcher.
const run = process.env.RUN_SCK_REASSIGN_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, owner: OwnerDesk, gm: string, concept: string, goal: string, count = 0;

beforeAll(async () => {
  if (process.env.RUN_SCK_REASSIGN_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-reassign-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'reassign_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db); owner = new OwnerDesk(db);
  const admin = new LocalEnrollmentAdmin(db);
  gm = await admin.enroll('reassign-gm', 'gm', ['execute', 'review', 'manage']);
  concept = await admin.enroll('reassign-concept', 'concept-design', ['execute', 'review']);
  await new ProjectStore(db.db).upsert({ id: 'novel', name: '故事项目', repoPath: dir, release: 'local', envs: [], disciplines: [{ name: '原著', roles: ['story-author'] }] });
  const [rows] = await db.db.query<[Array<{ id: RecordId }>]>("CREATE goal CONTENT { title: '长篇', brief: 'fixture', state: 'active', source: 'fixture', note: '', project: project:novel, tasks: {}, anchors: [], created_at: time::now() } RETURN AFTER;");
  goal = String(rows[0]!.id.id);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const key = () => `reassign-${++count}-${crypto.randomUUID()}`;
/** A task as the old transitional routing left it: concept-design on the 原著 track, owner-reviewed. */
async function legacyTask(extra: Record<string, unknown> = {}) {
  const t = await core.createTask(gm, { title: `Legacy story task ${++count}`, context: 'fixture', executorRole: 'story-author', reviewerRole: 'owner', discipline: '原著', goalId: goal, idempotencyKey: key(), ...extra } as never);
  await db.db.query("UPDATE $t SET executor_role = 'concept-design';", { t: new RecordId('task', t.id) });
  return t;
}
const reassign = (taskId: string, extra: Record<string, unknown>) => owner.reassign({ taskId, note: 'owner: fix routing', source: 'owner:test', key: key(), ...extra } as never);

run('a not-yet-started task moves to the right role, is audited and bumps its version', async () => {
  const t = await legacyTask();
  const moved = await reassign(t.id, { executorRole: 'story-author', reviewerRole: 'qa' });
  expect(moved).toMatchObject({ executorRole: 'story-author', reviewerRole: 'qa', version: t.version + 1, discipline: '原著' });
  const [audit] = await db.db.query<[Array<{ action: string; evidence: string }>]>("SELECT action, evidence FROM audit WHERE task = $t AND action = 'reassign';", { t: new RecordId('task', t.id) });
  expect(audit).toHaveLength(1); expect(audit[0]!.evidence).toContain('concept-design→story-author');
});

run('the project contract and required tracks still apply, and bad input is refused', async () => {
  const t = await legacyTask();
  await expect(reassign(t.id, { executorRole: 'product' })).rejects.toThrow(/only be carried by story-author/);
  await expect(reassign(t.id, { executorRole: 'eval' })).rejects.toMatchObject({ code: 'invalid' });
  await expect(reassign(t.id, {})).rejects.toMatchObject({ code: 'invalid' });
  await expect(owner.reassign({ taskId: t.id, executorRole: 'story-author', note: 'x', source: 'owner:test', key: key() })).rejects.toMatchObject({ code: 'invalid' });
  await expect(reassign('00000000-0000-0000-0000-000000000000', { executorRole: 'story-author' })).rejects.toMatchObject({ code: 'not_found' });
  expect((await core.getTask(gm, t.id)).executorRole).toBe('concept-design');
});

run('work that already started, finished or is leased is never reassigned', async () => {
  const leased = await legacyTask(); await core.claim(concept, leased.id);
  await expect(reassign(leased.id, { executorRole: 'story-author' })).rejects.toMatchObject({ code: 'conflict' });
  const done = await legacyTask();
  await db.db.query("UPDATE $t SET state = 'done';", { t: new RecordId('task', done.id) });
  await expect(reassign(done.id, { executorRole: 'story-author' })).rejects.toMatchObject({ code: 'conflict' });
  const submitted = await legacyTask();
  await db.db.query("UPDATE $t SET submitted_by = 'someone', state = 'ready';", { t: new RecordId('task', submitted.id) });
  await expect(reassign(submitted.id, { executorRole: 'story-author' })).rejects.toMatchObject({ code: 'conflict' });
});

run('replaying the same request is idempotent and a different payload on the same key is refused', async () => {
  const t = await legacyTask(); const k = key();
  const first = await owner.reassign({ taskId: t.id, executorRole: 'story-author', note: 'owner: fix routing', source: 'owner:test', key: k });
  expect((await owner.reassign({ taskId: t.id, executorRole: 'story-author', note: 'owner: fix routing', source: 'owner:test', key: k })).version).toBe(first.version);
  await expect(owner.reassign({ taskId: t.id, reviewerRole: 'qa', note: 'owner: fix routing', source: 'owner:test', key: k })).rejects.toMatchObject({ code: 'conflict' });
});
