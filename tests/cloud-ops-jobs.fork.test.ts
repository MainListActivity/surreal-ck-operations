import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Surreal } from 'surrealdb';
import { connectDb, openDb, type DbTarget } from '../src/db-connection.ts';
import { OpsJobRunner, type OpsJobDeps } from '../src/cloud/ops-jobs.ts';

setDefaultTimeout(60000);

// 真实 SurrealDB fork：只用 ~/.surrealdb/surreal，在临时目录起停，起停方式参照 tests/db-connection.test.ts。
const run = process.env.RUN_SCK_CLOUD_RUNNER_TESTS === '1' ? test : test.skip;
const ROOT_PASSWORD = 'fixture-only';
const NAMESPACE = 'cloud_ops_jobs_fixture';
const DATABASE = 'control_plane';
const SECRET = 'sk-test-secret-123';
let dir: string, server: ReturnType<typeof Bun.spawn>, url: string;
const serverTarget = (): DbTarget => ({
  url, namespace: NAMESPACE, database: DATABASE,
  auth: { kind: 'root', username: 'root', password: ROOT_PASSWORD },
});

beforeAll(async () => {
  if (process.env.RUN_SCK_CLOUD_RUNNER_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-cloud-ops-jobs-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  url = `ws://127.0.0.1:${port}/rpc`;
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD, '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  // 以 root 定义命名空间、数据库与 ops_job 表。
  const admin = new Surreal();
  await connectDb(admin, serverTarget());
  await admin.query(`DEFINE NAMESPACE ${NAMESPACE};`);
  await admin.use({ namespace: NAMESPACE });
  await admin.query(`DEFINE DATABASE ${DATABASE};`);
  await admin.use({ namespace: NAMESPACE, database: DATABASE });
  await admin.query('DEFINE TABLE ops_job SCHEMALESS;');
  await admin.close();
});

/** 以 root 插入 queued 作业；每个用例只插入自己需要的作业，避免互相抢占。 */
async function seedJobs(statements: string): Promise<void> {
  const admin = new Surreal();
  try {
    await openDb(admin, serverTarget());
    await admin.query(statements);
  } finally {
    await admin.close();
  }
}

afterAll(async () => {
  if (!dir) return;
  server.kill(); await server.exited;
  rmSync(dir, { recursive: true, force: true });
});

/** 每个执行端一个独立客户端，各自 root 登录。 */
async function runnerDeps(name: string, overrides: Partial<OpsJobDeps>): Promise<{ db: Surreal; runner: OpsJobRunner }> {
  const db = new Surreal();
  await openDb(db, serverTarget());
  const base: OpsJobDeps = {
    db,
    runner: name,
    runnerOnlyCommands: new Set<string>(),
    opsCall: async () => ({ ok: true }),
    runnerOnly: async () => ({}),
    hostExec: async () => ({ exitCode: 0 }),
  };
  return { db, runner: new OpsJobRunner({ ...base, ...overrides }) };
}

/** 读回作业；按 058 result、error 均为字符串。 */
async function readJob(key: string): Promise<{ state: string; runner?: string; result?: string; error?: string }> {
  const reader = new Surreal();
  try {
    await openDb(reader, serverTarget());
    const [rows] = await reader.query<[Array<{ state: string; runner?: string; result?: string; error?: string }>]>(
      `SELECT state, runner, result, error FROM ops_job:${key};`,
    );
    return rows[0];
  } finally {
    await reader.close();
  }
}

/** 解析作业 result 的 JSON 文本。 */
function parsed(text: string | undefined): unknown {
  return JSON.parse(String(text));
}

run('两个执行端并发认领同一作业：opsCall 只调用一次，作业 done，runner 为赢家', async () => {
  await seedJobs(`CREATE ops_job:j1 CONTENT { command: 'ops_info', input: {}, actor_kind: 'agent', actor: agent:⟨agent-1⟩, task: 'task-1', state: 'queued', created_at: time::now() };`);
  const calls: string[] = [];
  const a = await runnerDeps('runner-a', { opsCall: async () => { calls.push('runner-a'); return { ok: true, by: 'a' }; } });
  const b = await runnerDeps('runner-b', { opsCall: async () => { calls.push('runner-b'); return { ok: true, by: 'b' }; } });
  try {
    await Promise.all([a.runner.drain(), b.runner.drain()]);
    expect(calls).toHaveLength(1);
    const winner = calls[0];
    const job = await readJob('j1');
    expect(job.state).toBe('done');
    expect(job.runner).toBe(winner);
    expect(typeof job.result).toBe('string');
    expect(parsed(job.result)).toEqual({ ok: true, by: winner === 'runner-a' ? 'a' : 'b' });
  } finally {
    await a.db.close();
    await b.db.close();
  }
});

run('注入失败：作业 error，错误码沿用，message 脱敏', async () => {
  // 作业 j2 的 opsCall 抛出带 code 与密钥样式字符串的错误。
  await seedJobs(`CREATE ops_job:j2 CONTENT { command: 'ops_fail', input: {}, actor_kind: 'agent', actor: 'agent-1', task: 'task-1', state: 'queued', created_at: time::now() };`);
  const runner = await runnerDeps('runner-c', {
    opsCall: async () => {
      throw Object.assign(new Error(`租约不可用 ${SECRET}`), { code: 'no_lease' });
    },
  });
  try {
    await runner.runner.drain();
    const job = await readJob('j2');
    expect(job.state).toBe('error');
    expect(job.runner).toBe('runner-c');
    expect(typeof job.error).toBe('string');
    expect(job.error?.startsWith('no_lease: ')).toBe(true);
    expect(job.error).not.toContain(SECRET);
    expect(job.error!.length).toBeLessThanOrEqual(500);
  } finally {
    await runner.db.close();
  }
});

run('host.exec 路由的返回值写入 result；非法 timeoutSec 得到 invalid', async () => {
  await seedJobs(`
    CREATE ops_job:j3 CONTENT { command: 'host.exec', input: { host: 'arm-free-1', command: 'echo hi' }, actor_kind: 'agent', actor: 'agent-1', state: 'queued', created_at: time::now() };
    CREATE ops_job:j5 CONTENT { command: 'host.exec', input: { host: 'arm-free-1', command: 'echo hi', timeoutSec: 0 }, actor_kind: 'agent', actor: 'agent-1', state: 'queued', created_at: time::now() };
  `);
  const runner = await runnerDeps('runner-d', {
    hostExec: async (input) => ({ host: input.host, exitCode: 0, stdout: 'hi\n' }),
  });
  try {
    await runner.runner.drain();
    expect(parsed((await readJob('j3')).result)).toEqual({ host: 'arm-free-1', exitCode: 0, stdout: 'hi\n' });
    const invalid = await readJob('j5');
    expect(invalid.state).toBe('error');
    expect(invalid.error?.startsWith('invalid: ')).toBe(true);
  } finally {
    await runner.db.close();
  }
});
