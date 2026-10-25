import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyDatabase } from '../src/database.ts';
import { pruneOperationalData } from '../src/data-retention.ts';

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase;
const password = 'isolated-retention-fixture-only';

beforeAll(async () => {
  if (process.env.RUN_SCK_CHANNEL_FORK_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-retention-fork-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') }); const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', password, '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: password, namespace: 'retention_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
}, 20000);
afterAll(async () => { if (!dir) return; await db.close().catch(() => {}); server.kill(); rmSync(dir, { recursive: true, force: true }); });

run('retention drops operational exhaust and keeps what open work and pending scoring still read', async () => {
  const q = (sql: string) => db.db.query(sql);
  await q(`CREATE task:scored SET title = 'scored', state = 'done', evaluated_at = time::now();
    CREATE task:pending SET title = 'pending', state = 'done';
    CREATE task:open SET title = 'open', state = 'doing';`);
  await q(`LET $old = time::now() - 40d; LET $new = time::now() - 1h;
    CREATE worktree_audit:old CONTENT { repo: '/r', path: '/p', event: 'skip', trigger: 'sweep', decision: 'skip', result: 'skipped', reason: 'x', at: $old };
    CREATE worktree_audit:new CONTENT { repo: '/r', path: '/p', event: 'skip', trigger: 'sweep', decision: 'skip', result: 'skipped', reason: 'x', at: $new };
    CREATE idempotency:legacy CONTENT { payload_digest: 'd', result: { id: 'x' } };
    CREATE idempotency:stamped CONTENT { payload_digest: 'd', result: { created_at: $new } };
    CREATE idempotency:old CONTENT { at: $old, payload_digest: 'd', result: {} };
    CREATE outbox:old CONTENT { kind: 'claimed', task: task:open, at: $old, sequence: 1 };
    CREATE outbox:revoked_pending CONTENT { kind: 'revoked', task: task:pending, at: $old, sequence: 2 };
    CREATE outbox:revoked_scored CONTENT { kind: 'revoked', task: task:scored, at: $old, sequence: 3 };
    CREATE model_execution:scored CONTENT { task: task:scored, employee: 'e', at: $old };
    CREATE model_execution:pending CONTENT { task: task:pending, employee: 'e', at: $old };
    CREATE model_execution:idle CONTENT { employee: 'e', at: $old };
    CREATE audit:ops_open CONTENT { action: 'ops_call', task: task:open, at: $old };
    CREATE audit:ops_done CONTENT { action: 'ops_error', task: task:scored, at: $old };
    CREATE audit:submit_done CONTENT { action: 'submit', task: task:scored, at: $old };`);
  const removed = await pruneOperationalData(db.db);
  const left = async (table: string) => ((await db.db.query<[Array<{ id: { id: string } }>]>(`SELECT id FROM type::table($t);`, { t: table }))[0] ?? []).map(r => String(r.id.id)).sort();
  expect(await left('worktree_audit')).toEqual(['new']);
  expect(await left('idempotency')).toEqual(['stamped']);
  expect(await left('outbox')).toEqual(['revoked_pending']);
  expect(await left('model_execution')).toEqual(['pending']);
  expect(await left('audit')).toEqual(expect.arrayContaining(['ops_open', 'submit_done']));
  expect(await left('audit')).not.toContain('ops_done');
  expect(removed).toMatchObject({ worktree_audit: 1, idempotency: 2, outbox: 2, model_execution: 2, audit: 1 });
  expect(await pruneOperationalData(db.db)).toEqual({});
});
