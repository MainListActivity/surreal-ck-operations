import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { calibrate, clampComplexity, collectEvalState, writeScorecards } from '../src/scoring.ts';
import { COST_LIST_SQL, magpieSessionRows, recordPendingTaskCosts, recordTaskCost, rollUp, sessionOf, type UsageRow } from '../src/task-cost.ts';

test('the gateway session of a lease is recomputed exactly', () => {
  // Same digest as model-routing/gateway.ts: sck-<sha256(task:employee:fence:phase:tier)[0..16]>.
  expect(sessionOf({ task: 't1', employee: 'eng-a', fence: 2, phase: 'execute', tier: 'haiku' })).toMatch(/^sck-[0-9a-f]{16}$/);
  expect(sessionOf({ task: 't1', employee: 'eng-a', fence: 2, phase: 'execute', tier: 'haiku' }))
    .not.toBe(sessionOf({ task: 't1', employee: 'eng-a', fence: 3, phase: 'execute', tier: 'haiku' }));
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

test('the Magpie reader pages one session and keeps only exact session rows', async () => {
  const calls: string[] = [];
  const page = (offset: number) => ({ total: 3, rows: offset === 0
    ? [{ session: 'sck-x', cost: 1 }, { session: 'sck-xy', cost: 5 }]
    : offset === 2 ? [{ session: 'sck-x', cost: 2 }] : [] });
  const fake = (async (url: URL) => {
    calls.push(url.search);
    return new Response(JSON.stringify(page(Number(url.searchParams.get('offset')))));
  }) as unknown as typeof fetch;
  const rows = await magpieSessionRows('http://magpie.test', fake)('sck-x');
  expect(rows?.map(r => r.cost)).toEqual([1, 2]);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain('q=sck-x');
  expect(await magpieSessionRows('http://magpie.test', (async () => new Response('', { status: 500 })) as unknown as typeof fetch)('sck-x')).toBeUndefined();
});

test('calibration deducts audit facts the judge cannot erase and steps efficiency for authors only', () => {
  expect(calibrate({ judgeOverall: 5, complexity: 3, author: true, metrics: { claims: 1, checkpoints: 1, submits: 3, reviews: 0, returnsReceived: 2, revocations: 1, checkFailures: 1 } }))
    .toMatchObject({ judgeOverall: 5, overall: 3, adjustments: [
      { code: 'returns', points: -1 }, { code: 'revocations', points: -0.5 }, { code: 'check_failures', points: -0.5 }] });
  // Deductions are capped per kind and the score never leaves 1-5.
  expect(calibrate({ judgeOverall: 2, complexity: 3, author: true, metrics: { claims: 1, checkpoints: 0, submits: 9, reviews: 0, returnsReceived: 9, revocations: 9 } }).overall).toBe(1);
  const baseline = { usd: 0.1, elapsedSeconds: 1000, samples: 8 };
  const slow = calibrate({ judgeOverall: 4, complexity: 3, author: true, cost: { usd: 0.5, elapsedSeconds: 1000 }, baseline });
  expect(slow.overall).toBe(3);
  expect(slow.adjustments[0]).toMatchObject({ code: 'efficiency', points: -1 });
  expect(slow.adjustments[0]!.basis).toContain('复杂度 3');
  expect(calibrate({ judgeOverall: 4, complexity: 3, author: true, cost: { usd: 0.25, elapsedSeconds: 900 }, baseline }).overall).toBe(3.5);
  expect(calibrate({ judgeOverall: 4.2, complexity: 3, author: true }).overall).toBe(4.2);
  expect(calibrate({ judgeOverall: 4, complexity: 3, author: true, cost: { usd: 0.04, elapsedSeconds: 400 }, baseline }).overall).toBe(4.5);
  // A reviewer does not drive the task's cost; without a baseline nothing moves.
  expect(calibrate({ judgeOverall: 4, complexity: 3, author: false, cost: { usd: 9, elapsedSeconds: 99999 }, baseline }).overall).toBe(4);
  expect(calibrate({ judgeOverall: 4, complexity: 3, author: true, cost: { usd: 9, elapsedSeconds: 99999 } }).overall).toBe(4);
  expect([clampComplexity(undefined), clampComplexity(0), clampComplexity(4.6), clampComplexity(9)]).toEqual([3, 1, 5, 5]);
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

run('a finished task settles its cost from its lease sessions, and scoring stores judge and calibrated overall', async () => {
  await db.db.query(`CREATE task:t1 CONTENT { title: 'cost fixture', context: 'x', state: 'done', executor_role: 'engineering', reviewer_role: 'qa', created_at: time::now() - 30m, version: 5, fence: 2 };
    CREATE employee:\`eng-a\` CONTENT { role: 'engineering' }; CREATE employee:\`qa-b\` CONTENT { role: 'qa' };
    CREATE audit CONTENT { task: task:t1, actor: employee:\`eng-a\`, action: 'claim', at: time::now() - 29m };
    CREATE audit CONTENT { task: task:t1, actor: employee:\`eng-a\`, action: 'submit_check_failed', at: time::now() - 25m };
    CREATE audit CONTENT { task: task:t1, actor: employee:\`eng-a\`, action: 'submit', at: time::now() - 20m };
    CREATE audit CONTENT { task: task:t1, actor: employee:\`qa-b\`, action: 'claim', at: time::now() - 15m };
    CREATE audit CONTENT { task: task:t1, actor: employee:\`qa-b\`, action: 'accept', at: time::now() - 10m };
    CREATE model_execution CONTENT { task: task:t1, employee: 'eng-a', fence: 1, phase: 'execute', tier: 'haiku', model: 'm/one', completed: true, status: 200, at: time::now() - 28m };
    CREATE model_execution CONTENT { task: task:t1, employee: 'eng-a', fence: 1, phase: 'execute', tier: 'haiku', model: 'm/one', completed: true, status: 200, at: time::now() - 27m };
    CREATE model_execution CONTENT { task: task:t1, employee: 'qa-b', fence: 2, phase: 'review', tier: 'sonnet', model: 'm/two', completed: true, status: 200, at: time::now() - 14m };`);
  const eng = sessionOf({ task: 't1', employee: 'eng-a', fence: 1, phase: 'execute', tier: 'haiku' });
  const qa = sessionOf({ task: 't1', employee: 'qa-b', fence: 2, phase: 'review', tier: 'sonnet' });
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
  await db.db.query("CREATE task:t2 CONTENT { title: 'x', context: 'x', state: 'done', created_at: time::now() }; CREATE model_execution CONTENT { task: task:t2, employee: 'eng-a', fence: 1, phase: 'execute', tier: 'haiku', at: time::now() };");
  expect(await recordTaskCost(db.db, 't2', async () => undefined)).toBeUndefined();

  const state = await collectEvalState(db.db, 't1');
  expect(state.cost?.usd).toBe(0.06);
  expect(state.metrics['eng-a']).toMatchObject({ submits: 1, checkFailures: 1 });
  const base = { quality: 5, evidence: 5, discipline: 5, timeliness: 5, overall: 5 };
  await writeScorecards(db.db, { taskId: 't1', summary: 'fixture', judge: 'eval-x', judgeKind: 'llm', state, complexity: 2,
    scores: [{ employee: 'eng-a', ...base, modelScores: [{ model: 'm/one', overall: 5 }] }, { employee: 'qa-b', ...base, modelScores: [{ model: 'm/two', overall: 5 }] }] });
  const [cards] = await db.db.query<[Array<{ employee: string; overall: number; judge_overall: number; calibration: { complexity: number; adjustments: Array<{ code: string }> } }>]>(
    'SELECT employee, overall, judge_overall, calibration FROM scorecard WHERE task = task:t1 ORDER BY employee;');
  expect(cards.map(c => [c.employee, c.judge_overall, c.overall])).toEqual([['eng-a', 5, 5], ['qa-b', 5, 5]].map(([e, j]) => [e, j, e === 'eng-a' ? 4.5 : 5]));
  expect(cards[0]!.calibration.adjustments.map(a => a.code)).toEqual(['check_failures']);
  expect(cards[0]!.calibration.complexity).toBe(2);
  const [costRow] = await db.db.query<[Array<{ complexity: number }>]>('SELECT complexity FROM task_cost WHERE task = $t;', { t: new RecordId('task', 't1') });
  expect(costRow[0]!.complexity).toBe(2);
  // The owner's list reads the settled task with its complexity and calibrated score.
  const [list] = await db.db.query<[Array<{ title: string; complexity: number; score: number; cost: { usd: number } }>]>(COST_LIST_SQL, { span: '7d' });
  expect(list.map(r => [r.title, r.complexity, r.score, r.cost.usd])).toEqual([['cost fixture', 2, 4.75, 0.06]]);
});
