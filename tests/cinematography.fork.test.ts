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
const run = process.env.RUN_SCK_CINEMATOGRAPHY_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, workforce: Workforce, gm: string, count = 0;

beforeAll(async () => {
  if (process.env.RUN_SCK_CINEMATOGRAPHY_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-cinematography-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'cinematography_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  workforce = new Workforce(db, join(dir, 'credentials')); core = new SurrealCompanyCore(db, { workforce });
  gm = await new LocalEnrollmentAdmin(db).enroll('cinema-gm', 'gm', ['execute', 'review', 'manage']);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const task = (extra: Record<string, unknown>) => core.createTask(gm, { title: `Camera task ${++count}`, context: 'camera fixture', executorRole: 'cinematography', reviewerRole: 'owner', idempotencyKey: `cinema-task-${++count}-${crypto.randomUUID()}`, ...extra } as never);
const claimAs = async (defId: string, taskId: string) => core.claim((await workforce.spawnInst((await workforce.defs()).find(d => d.id === defId)!)).credential!, taskId);

run('cinematography tasks must carry the 摄影 track and only a def that covers it can claim them', async () => {
  await expect(task({})).rejects.toThrow(/requires discipline=摄影/);
  await expect(task({ discipline: '分镜' })).rejects.toThrow(/requires discipline=摄影/);
  const shot = await task({ discipline: '摄影' });
  expect(shot).toMatchObject({ executorRole: 'cinematography', discipline: '摄影' });
  await workforce.upsertDef('cinema-no-track', { role: 'cinematography', provider: 'antigravity', model: 'gemini-3.8-flash-medium' });
  await expect(claimAs('cinema-no-track', shot.id)).rejects.toMatchObject({ code: 'forbidden' });
  const seed = SEED_DEFS.find(d => d.id === 'cinematography-agy')!;
  expect(seed).toMatchObject({ role: 'cinematography', provider: 'antigravity', tracks: ['摄影'] });
  await workforce.upsertDef(seed.id, seed);
  expect((await claimAs(seed.id, shot.id)).task).toMatchObject({ id: shot.id, state: 'doing' });
});

run('the cinematography def refuses other tracks and concept-design work is not cinematography work', async () => {
  const other = await task({ discipline: '摄影' });
  await workforce.upsertDef('concept-def', { role: 'concept-design', provider: 'antigravity', model: 'gemini-3.8-flash-medium', tracks: ['分镜'] });
  await expect(claimAs('concept-def', other.id)).rejects.toMatchObject({ code: 'forbidden' });
  await new ProjectStore(db.db).upsert({ id: 'anime', name: '动画项目', repoPath: dir, release: 'local', envs: [], disciplines: [{ name: '摄影', roles: ['cinematography'] }] });
  const [rows] = await db.db.query<[Array<{ id: unknown }>]>("CREATE goal CONTENT { title: '短片', brief: 'fixture', state: 'active', source: 'fixture', note: '', project: project:anime, tasks: {}, anchors: [], created_at: time::now() } RETURN AFTER;");
  const goalId = String((rows[0]!.id as { id: string }).id);
  await expect(task({ goalId, executorRole: 'concept-design', reviewerRole: 'gm', discipline: '摄影' })).rejects.toThrow(/only be carried by cinematography/);
  expect((await task({ goalId, discipline: '摄影' })).executorRole).toBe('cinematography');
});
