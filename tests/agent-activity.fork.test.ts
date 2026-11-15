import { afterAll, beforeAll, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Surreal, Table } from 'surrealdb';
import { ActivityCollector } from '../src/agent-activity.ts';
import { writeAgentActivity, expireAgentActivity } from '../src/runner/activity-store.ts';
const enabled = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1';
const run = enabled ? test : test.skip;
let server: ReturnType<typeof Bun.spawn>, db: Surreal;
beforeAll(async () => {
  if (!enabled) return;
  const listener = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture')});
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'isolated-fixture', '--log', 'error', 'memory'], {stdout:'ignore',stderr:'ignore'});
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new Surreal(); await db.connect(`ws://127.0.0.1:${port}/rpc`); await db.signin({username:'root',password:'isolated-fixture'});
  await db.use({namespace:'activity_fixture',database:'test'});
  await db.query(await Bun.file(new URL('../schema/066-agent-activity.surql', import.meta.url)).text());
  await db.query(`CREATE employee:e SET paseo_agent_id = 'a', runner_id = 'native:test', last_task = task:wrong;
    CREATE task:right SET runtime_execution = {agent:'a', turn:'t'}; CREATE task:wrong SET title = 'next task';`);
}, 15000);
afterAll(async () => { if (!enabled) return; await db?.close(); server?.kill(); if(server) await server.exited; });
run('按实际回合关联，不用员工上一任务；幂等写入，旧快照不覆盖新快照，过期记录显式删除', async () => {
  const c = new ActivityCollector('a','t',100);
  expect(await writeAgentActivity(db, 'other-runner', [c.snapshot(110)])).toEqual([]);
  const value = c.snapshot(120);
  expect(await writeAgentActivity(db, 'native:test', [value])).toEqual([{agent:'a',turn:'t'}]);
  await writeAgentActivity(db, 'native:test', [value]);
  await writeAgentActivity(db, 'native:test', [c.snapshot(110)]);
  const [rows] = await db.query<any[]>('SELECT * FROM agent_activity;');
  expect(rows).toHaveLength(1); expect(String(rows[0].task)).toBe('task:right'); expect(rows[0].observed_at).toBe(120);
  expect(await writeAgentActivity(db, 'native:test', [{...value,turn:'unmirrored'}])).toEqual([]);
  await db.query('UPDATE agent_activity SET expires_at = time::now() - 1s;');
  const [visible] = await db.query<any[]>('SELECT * FROM agent_activity WHERE expires_at > time::now();');
  expect(visible).toHaveLength(0);
  const [expired] = await db.query<any[]>('SELECT * FROM agent_activity;'); expect(expired).toHaveLength(1);
  await expireAgentActivity(db);
  const [left] = await db.query<any[]>('SELECT * FROM agent_activity;'); expect(left).toHaveLength(0);
});

run('进度更新通过真实 Live Query 推送，无轮询读取', async () => {
  const events: unknown[] = [];
  const sub = await db.live(new Table('agent_activity')); const off = sub.subscribe(e => events.push(e));
  try {
    const c = new ActivityCollector('a','t',Date.now());
    await writeAgentActivity(db,'native:test',[c.snapshot()]);
    for(let i=0;i<100 && !events.length;i++) await Bun.sleep(10);
    expect(events.length).toBeGreaterThan(0);
  } finally {off();await sub.kill();}
});

run('任务详情读到各轮的动作记录：按开始时间排，只带动作不带输出文本；保留 7 天', async () => {
  const { taskTurns } = await import('../src/owner-api.ts');
  // 前面的用例给同一回合写过当前时刻的快照，旧快照不覆盖新快照：这里用更晚的时刻。
  const T = Date.now() + 60_000;
  const c = new ActivityCollector('a', 't', T);
  c.ingest('claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'PUBLIC_OUTPUT' }, { type: 'tool_use', id: 'u', name: 'Bash', input: { command: 'bun test' } }] } }, T + 100);
  c.ingest('claude', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u', content: 'x' }] } }, T + 200);
  await writeAgentActivity(db, 'native:test', [c.snapshot(T + 300)]);
  const turns = await taskTurns(db, 'right');
  expect(turns).toEqual([{ employee: 'e', runtime: 'native', state: 'running', startedAt: T, lastActivityAt: T + 200,
    actions: [{ at: T + 100, tool: 'Bash', text: '执行命令：bun test', state: 'ok', endedAt: T + 200 }] }]);
  expect(JSON.stringify(turns)).not.toContain('PUBLIC_OUTPUT');
  const [rows] = await db.query<any[]>('SELECT expires_at > time::now() + 6d AS kept FROM agent_activity;');
  expect(rows[0].kept).toBe(true);
  expect(await taskTurns(db, 'wrong')).toEqual([]);
});
