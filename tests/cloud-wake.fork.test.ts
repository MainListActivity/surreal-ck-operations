import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Surreal } from 'surrealdb';
import { connectDb, queryDb, useDb, type DbTarget } from '../src/db-connection.ts';
import { WAKE_TABLES, subscribeWake } from '../src/cloud/wake.ts';

setDefaultTimeout(60000);

// ---- 真实 SurrealDB fork：在 mkdtemp 目录里起本地实例，与 tests/db-connection.test.ts 的方式一致 ----
const run = process.env.RUN_SCK_CLOUD_RUNNER_TESTS === '1' ? test : test.skip;
const ROOT_PASSWORD = 'fixture-only';
const NAMESPACE = 'cloud_wake_fixture';
const DATABASE = 'control_plane';
let dir: string, server: ReturnType<typeof Bun.spawn>, url: string;
const serverTarget = (): DbTarget => ({ url, namespace: NAMESPACE, database: DATABASE, auth: { kind: 'root', username: 'root', password: ROOT_PASSWORD } });

// 用 setTimeout 实现的等待，不使用 Bun.sleep
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// 轮询直到条件成立，超时则返回 false
async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await delay(25);
  }
  return check();
}

beforeAll(async () => {
  if (process.env.RUN_SCK_CLOUD_RUNNER_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-cloud-wake-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  url = `ws://127.0.0.1:${port}/rpc`;
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD, '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await delay(25); }
  // 建立命名空间与数据库，并定义四张订阅表
  const admin = new Surreal();
  await connectDb(admin, serverTarget());
  await admin.query(`DEFINE NAMESPACE ${NAMESPACE};`);
  await admin.use({ namespace: NAMESPACE });
  await admin.query(`DEFINE DATABASE ${DATABASE};`);
  await admin.use({ namespace: NAMESPACE, database: DATABASE });
  for (const table of WAKE_TABLES) await admin.query(`DEFINE TABLE ${table} SCHEMALESS;`);
  await admin.close();
});

afterAll(async () => {
  if (!dir) return;
  server.kill(); await server.exited;
  rmSync(dir, { recursive: true, force: true });
});

run('LIVE 订阅：四张表写入后都在 2000 ms 内回调对应表名', async () => {
  const db = new Surreal();
  let stop: (() => Promise<void>) | undefined;
  try {
    await connectDb(db, serverTarget());
    await useDb(db, serverTarget());
    const changes: string[] = [];
    stop = await subscribeWake(db, table => changes.push(table));

    // task 表：按示例写入 task:1
    await queryDb(db, "CREATE task:1 SET state = 'ready';");
    expect(await until(() => changes.includes('task'), 2000)).toBe(true);

    // 其余三张表各写一次，都要收到对应表名
    for (const table of ['outbound_message', 'ops_job', 'agent_policy']) {
      changes.length = 0;
      await queryDb(db, `CREATE ${table}:1 SET note = 'wake';`);
      expect(await until(() => changes.includes(table), 2000)).toBe(true);
    }
  } finally {
    if (stop) await stop();
    await db.close();
  }
});

run('停止函数杀掉订阅后，再写入不再收到通知', async () => {
  const db = new Surreal();
  try {
    await connectDb(db, serverTarget());
    await useDb(db, serverTarget());
    const changes: string[] = [];
    const stop = await subscribeWake(db, table => changes.push(table));
    await stop();
    await queryDb(db, "CREATE task:2 SET state = 'ready';");
    await queryDb(db, "CREATE outbound_message:2 SET note = 'after-stop';");
    // 留出足够时间让通知到达（若订阅仍存活，2000 ms 内必到）
    await delay(500);
    expect(changes).toEqual([]);
  } finally {
    await db.close();
  }
});
