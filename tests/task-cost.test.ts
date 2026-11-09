import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { sessionKey } from '../src/model-routing/magpie-contract.ts';
import { COST_LIST_SQL, magpieSessionRows, readTaskCost, recordPendingTaskCosts, recordTaskCost, rollUp, type UsageRow } from '../src/task-cost.ts';

test('each task and employee has its own magpie session, so usage cannot cross tasks', () => {
  expect(sessionKey('t1', 'eng-a')).toMatch(/^sck-[0-9a-f]{16}$/);
  expect(sessionKey('t1', 'eng-a')).toBe(sessionKey('t1', 'eng-a'));
  expect(sessionKey('t1', 'eng-a')).not.toBe(sessionKey('t2', 'eng-a'));
  expect(sessionKey('t1', 'eng-a')).not.toBe(sessionKey('t1', 'qa-b'));
});

test('roll-up sums tokens and priced USD per employee and model, and counts unpriced requests apart', () => {
  const sessions = new Map([['s-a', 'eng-a'], ['s-b', 'qa-b']]);
  const rows: UsageRow[] = [
    { session: 's-a', model: 'm/one', in: 100, out: 10, cache_read: 50, ms: 1000, status: 200, cost: 0.01, priced: true },
    { session: 's-a', model: 'm/one', in: 200, out: 20, ms: 2000, status: 529, cost: 0, priced: true },
    { session: 's-b', model: 'm/two', in: 300, out: 30, ms: 500, status: 200, cost: 0.5, priced: false },
    { session: 'other', model: 'm/one', in: 9999, cost: 9 },
  ];
  const cost = rollUp('t1', sessions, rows, 600);
  expect(cost).toMatchObject({ requests: 3, failed: 1, inputTokens: 600, outputTokens: 60, cacheReadTokens: 50, usd: 0.01, unpriced: 1, modelMs: 3500, elapsedSeconds: 600, sessions: 2, complete: true });
  expect(cost.byEmployee['eng-a']).toMatchObject({ requests: 2, usd: 0.01 });
  expect(cost.byEmployee['qa-b']).toMatchObject({ requests: 1, usd: 0, unpriced: 1 });
  expect(cost.byModel).toEqual({ 'm/one': { requests: 2, usd: 0.01 }, 'm/two': { requests: 1, usd: 0 } });
});

test('the Magpie reader sends the employee key, pages one session and keeps only exact session rows', async () => {
  const calls: string[] = [];
  const auth: unknown[] = [];
  const page = (offset: number) => ({ total: 3, rows: offset === 0
    ? [{ session: 'sck-x', cost: 1 }, { session: 'sck-xy', cost: 5 }]
    : offset === 2 ? [{ session: 'sck-x', cost: 2 }] : [] });
  const fake = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    auth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
    return new Response(JSON.stringify(page(Number(url.searchParams.get('offset')))));
  }) as unknown as typeof fetch;
  const rows = await magpieSessionRows({ Authorization: 'Bearer employee-key' }, 'https://magpie.test/ofm', fake)('sck-x');
  expect(rows?.map(r => r.cost)).toEqual([1, 2]);
  expect(calls).toHaveLength(2);
  // The base path of the VPS relay (/ofm) survives: the usage endpoint lives under it.
  expect(calls[0]).toContain('/ofm/v1/magpie/usage/requests?');
  expect(calls[0]).toContain('q=sck-x');
  expect(auth).toEqual(['Bearer employee-key', 'Bearer employee-key']);
  expect(await magpieSessionRows({}, 'https://magpie.test', (async () => new Response('', { status: 500 })) as unknown as typeof fetch)('sck-x')).toBeUndefined();
});

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase;
const password = 'isolated-task-cost-fixture-only';

beforeAll(async () => {
  if (process.env.RUN_SCK_CHANNEL_FORK_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-task-cost-fork-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') }); const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', password, '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: password, namespace: 'task_cost_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
}, 20000);
afterAll(async () => { if (!dir) return; await db.close().catch(() => {}); server.kill(); rmSync(dir, { recursive: true, force: true }); });

run('a finished task settles its cost from its employees sessions, once, and the owner list reads it', async () => {
  await db.db.query(`CREATE task:t1 CONTENT { title: 'cost fixture', context: 'x', state: 'done', executor_role: 'engineering', reviewer_role: 'qa', created_at: time::now() - 30m, version: 5, fence: 2 };
    CREATE employee:\`eng-a\` CONTENT { role: 'engineering' }; CREATE employee:\`qa-b\` CONTENT { role: 'qa' };
    CREATE audit CONTENT { task: task:t1, actor: employee:\`eng-a\`, action: 'claim', at: time::now() - 29m };
    CREATE audit CONTENT { task: task:t1, actor: employee:\`eng-a\`, action: 'submit', at: time::now() - 20m };
    CREATE audit CONTENT { task: task:t1, actor: employee:\`qa-b\`, action: 'claim', at: time::now() - 15m };
    CREATE audit CONTENT { task: task:t1, actor: employee:\`qa-b\`, action: 'accept', at: time::now() - 10m };`);
  const eng = sessionKey('t1', 'eng-a');
  const qa = sessionKey('t1', 'qa-b');
  const usage: Record<string, UsageRow[]> = {
    [eng]: [{ session: eng, model: 'm/one', in: 1000, out: 100, cost: 0.02, priced: true }, { session: eng, model: 'm/one', in: 1000, out: 100, cost: 0.03, priced: true }],
    [qa]: [{ session: qa, model: 'm/two', in: 500, out: 50, cost: 0.01, priced: true }],
  };
  const fetchRows = async (s: string) => usage[s] ?? [];
  expect(await recordPendingTaskCosts(db.db, { fetchRows })).toBe(1);
  expect(await recordPendingTaskCosts(db.db, { fetchRows })).toBe(0); // settled once
  const [stored] = await db.db.query<[Array<{ cost: { usd: number; requests: number; elapsedSeconds: number; byEmployee: Record<string, { usd: number }> } }>]>('SELECT cost FROM task_cost WHERE task = task:t1;');
  expect(stored[0]!.cost).toMatchObject({ usd: 0.06, requests: 3 });
  expect(stored[0]!.cost.byEmployee['eng-a']!.usd).toBe(0.05);
  expect(stored[0]!.cost.elapsedSeconds).toBeGreaterThanOrEqual(1199);
  // Magpie unreadable: nothing is written and the next pass retries.
  await db.db.query("CREATE task:t2 CONTENT { title: 'x', context: 'x', state: 'done', created_at: time::now() }; CREATE audit CONTENT { task: task:t2, actor: employee:`eng-a`, action: 'claim', at: time::now() };");
  expect(await recordTaskCost(db.db, 't2', async () => undefined)).toBeUndefined();
  expect(await readTaskCost(db.db, 't2')).toBeUndefined();
  // The owner's list reads the settled task.
  const [list] = await db.db.query<[Array<{ title: string; cost: { usd: number } }>]>(COST_LIST_SQL, { span: '7d' });
  expect(list.map(r => [r.title, r.cost.usd])).toEqual([['cost fixture', 0.06]]);
});
