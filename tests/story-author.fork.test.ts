import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { ProjectStore } from '../src/projects.ts';
import { SEED_DEFS } from '../src/seed.ts';
import { Workforce } from '../src/workforce.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private RocksDB store: no production data, credentials or dispatcher.
const run = process.env.RUN_SCK_STORY_AUTHOR_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, workforce: Workforce, gm: string, count = 0;

beforeAll(async () => {
  if (process.env.RUN_SCK_STORY_AUTHOR_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-story-author-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'story_author_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  workforce = new Workforce(db, join(dir, 'credentials')); core = new SurrealCompanyCore(db, { workforce });
  gm = await new LocalEnrollmentAdmin(db).enroll('story-gm', 'gm', ['execute', 'review', 'manage']);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const task = (extra: Record<string, unknown>) => core.createTask(gm, { title: `Story task ${++count}`, context: 'story fixture', executorRole: 'story-author', reviewerRole: 'owner', idempotencyKey: `story-task-${++count}-${crypto.randomUUID()}`, ...extra } as never);
const claimAs = async (defId: string, taskId: string) => core.claim((await workforce.spawnInst((await workforce.defs()).find(d => d.id === defId)!)).credential!, taskId);

run('story-author tasks must carry the 原著 track and only a def that covers it can claim them', async () => {
  await expect(task({})).rejects.toThrow(/requires discipline=原著/);
  await expect(task({ discipline: '编剧' })).rejects.toThrow(/requires discipline=原著/);
  const outline = await task({ discipline: '原著' });
  expect(outline).toMatchObject({ executorRole: 'story-author', discipline: '原著' });
  await workforce.upsertDef('story-no-track', { role: 'story-author', provider: 'antigravity', model: 'gemini-3.7-flash-medium' });
  await expect(claimAs('story-no-track', outline.id)).rejects.toMatchObject({ code: 'forbidden' });
  const seed = SEED_DEFS.find(d => d.id === 'story-author-agy')!;
  expect(seed).toMatchObject({ role: 'story-author', provider: 'antigravity', tracks: ['原著'] });
  await workforce.upsertDef(seed.id, seed);
  expect((await claimAs(seed.id, outline.id)).task).toMatchObject({ id: outline.id, state: 'doing' });
});

run('the story-author def refuses other tracks and screenwriter work is not story-author work', async () => {
  const other = await task({ discipline: '原著' });
  await workforce.upsertDef('screen-def', { role: 'screenwriter', provider: 'antigravity', model: 'gemini-3.7-flash-medium', tracks: ['编剧'] });
  await expect(claimAs('screen-def', other.id)).rejects.toMatchObject({ code: 'forbidden' });
  await new ProjectStore(db.db).upsert({ id: 'novel', name: '故事项目', repoPath: dir, release: 'local', envs: [], disciplines: [{ name: '原著', roles: ['story-author'] }] });
  const [rows] = await db.db.query<[Array<{ id: unknown }>]>("CREATE goal CONTENT { title: '长篇', brief: 'fixture', state: 'active', source: 'fixture', note: '', project: project:novel, tasks: {}, anchors: [], created_at: time::now() } RETURN AFTER;");
  const goalId = String((rows[0]!.id as { id: string }).id);
  await expect(task({ goalId, executorRole: 'product', reviewerRole: 'gm', discipline: '原著' })).rejects.toThrow(/only be carried by story-author/);
  expect((await task({ goalId, discipline: '原著' })).executorRole).toBe('story-author');
});
