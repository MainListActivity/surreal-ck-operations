import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { ProjectStore } from '../src/projects.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private RocksDB store: no production data, credentials or dispatcher.
const run = process.env.RUN_SCK_PIPELINE_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, owner: OwnerDesk, gm: string, count = 0;

beforeAll(async () => {
  if (process.env.RUN_SCK_PIPELINE_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-pipelines-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'pipelines_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db); owner = new OwnerDesk(db);
  gm = await new LocalEnrollmentAdmin(db).enroll('pipeline-gm', 'owner', ['execute', 'review', 'manage']);
  const projects = new ProjectStore(db.db);
  const base = { release: 'local', envs: [] as never[], repoPath: dir };
  await projects.upsert({ ...base, id: 'content', name: '内容项目', pipeline: 'video', disciplines: [
    { name: '原著', roles: ['asset-production'] }, { name: '编剧', roles: ['screenwriter'] }, { name: '角色设计', roles: ['concept-design', 'asset-production'] }, { name: '审片' }] });
  await projects.upsert({ ...base, id: 'plain', name: '普通项目' });
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const key = () => `pipeline-${++count}-${crypto.randomUUID()}`;
const goalOn = async (project: string, pipeline?: string, tier: 'quick' | 'standard' | 'program' = 'program') => {
  const goal = await owner.createGoal({ text: `fixture goal ${key()}`, source: 'test', key: key(), project, pipeline, tier });
  const [rows] = await db.db.query<[Array<{ title: string; executor_role: string; reviewer_role: string; kind: string }>]>('SELECT title, executor_role, reviewer_role, kind FROM task WHERE goal = $goal ORDER BY title;', { goal: new (await import('surrealdb')).RecordId('goal', goal.id) });
  return { goal, tasks: rows };
};
const task = (goalId: string, extra: Record<string, unknown>) =>
  core.createTask(gm, { title: `Pipeline task ${++count}`, context: 'pipeline fixture', executorRole: 'concept-design', reviewerRole: 'owner', goalId, idempotencyKey: key(), ...extra } as never);

run('a story goal is one story-author delivery reviewed by qa: no product intake, acceptance or auto-closing gate', async () => {
  const { goal, tasks } = await goalOn('content', 'story');
  expect(goal.pipeline).toBe('story');
  expect(tasks.map(t => [t.executor_role, t.reviewer_role, t.kind])).toEqual([['story-author', 'qa', 'task']]);
  expect(tasks[0]!.title).toContain('交付');
});

run('with no explicit line a goal runs its project default; no default means software', async () => {
  const video = await goalOn('content');
  expect(video.goal.pipeline).toBe('video');
  // video: one concept-design task, reviewed by the owner; no gate/product rows.
  expect(video.tasks.map(t => [t.executor_role, t.reviewer_role, t.kind])).toEqual([['concept-design', 'owner', 'task']]);
  expect(video.tasks.some(t => t.executor_role === 'product')).toBe(false);
  const software = await goalOn('plain', undefined, 'standard');
  expect(software.goal.pipeline).toBeUndefined();
  // software on a plain project: one engineering deploy task reviewed by qa.
  expect(software.tasks.map(t => [t.executor_role, t.reviewer_role, t.kind])).toEqual([['engineering', 'qa', 'deploy']]);
  expect(software.tasks.some(t => t.executor_role === 'product')).toBe(false);
  await expect(owner.createGoal({ text: 'bad line', source: 'test', key: key(), pipeline: 'novel' })).rejects.toMatchObject({ code: 'invalid' });
});

run('a track only accepts the roles the project lists for it, and line roles must name a track', async () => {
  const { goal } = await goalOn('content', 'video');
  await expect(task(goal.id, { executorRole: 'product', reviewerRole: 'owner', discipline: '原著' })).rejects.toThrow(/only be carried by asset-production/);
  await expect(task(goal.id, { executorRole: 'engineering', reviewerRole: 'qa', discipline: '角色设计' })).rejects.toThrow(/cannot take it/);
  await expect(task(goal.id, { executorRole: 'concept-design' })).rejects.toThrow(/must set discipline to one of: 角色设计/);
  await expect(task(goal.id, { executorRole: 'concept-design', discipline: '没有这条轨' })).rejects.toThrow(/tracks vocabulary/);
  expect((await task(goal.id, { executorRole: 'concept-design', discipline: '角色设计' })).discipline).toBe('角色设计');
  expect((await task(goal.id, { executorRole: 'asset-production', discipline: '原著' })).discipline).toBe('原著');
  expect((await task(goal.id, { executorRole: 'screenwriter', discipline: '编剧' })).executorRole).toBe('screenwriter');
  await expect(task(goal.id, { executorRole: 'screenwriter' })).rejects.toThrow(/must set discipline to one of: 编剧/);
  expect((await task(goal.id, { executorRole: 'product', reviewerRole: 'owner' })).executorRole).toBe('product');
  expect((await task(goal.id, { executorRole: 'product', reviewerRole: 'owner', discipline: '审片' })).discipline).toBe('审片');
});

run('the contract is data on the project: unknown roles are refused when it is saved', async () => {
  await expect(new ProjectStore(db.db).setDisciplines('content', [{ name: '原著', roles: ['novelist' as never] }])).rejects.toMatchObject({ code: 'invalid' });
  await expect(new ProjectStore(db.db).upsert({ id: 'bad', name: 'bad', repoPath: dir, release: 'x', envs: [], pipeline: 'novel' })).rejects.toMatchObject({ code: 'invalid' });
  expect((await new ProjectStore(db.db).get('content'))!.disciplines![0]).toMatchObject({ name: '原著', roles: ['asset-production'] });
});
