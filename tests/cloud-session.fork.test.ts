import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Surreal } from 'surrealdb';
import type { DatabaseConfig } from '../src/config.ts';
import { CompanyDatabase, type CompanyDatabaseOptions } from '../src/database.ts';
import { connectDb, type DbTarget } from '../src/db-connection.ts';
import { subscribeWake, WAKE_TABLES } from '../src/cloud/wake.ts';

// 云端会话（续期、断线重连、关闭、绑定）的真实 fork 测试（门控 RUN_SCK_CLOUD_RUNNER_TESTS=1）。
// 在 mkdtemp 目录里起本地 fork（~/.surrealdb/surreal，rocksdb）。身份服务用本地 Bun.serve 充当：/token 发 client_credentials 令牌。
// 服务目录用 SCK_SERVICE_HOME 指向临时目录，凭证文件权限 600，不碰生产库与真实服务目录。
//
// 测试替身（已验证的 fork 限制）：本机 fork（3.3.0-nightly）不支持 URL 类 JWT 访问（JWKS 从不被拉取，登录直接报
// "access method cannot be used in the requested operation"）。所以 055 生产的 runner 访问方式在这里无法登录。
// 替身做法：空库首次登录前，由 root 定义同名的 HS512 runner 访问方式（共享密钥），签名与校验仍走 JWT 访问路径。
// 令牌寿命可配置（测试 2、4 用 6 秒），exp 即续期的依据。
setDefaultTimeout(120000);
const run = process.env.RUN_SCK_CLOUD_RUNNER_TESTS === '1' ? test : test.skip;

const ROOT_PASSWORD = 'cloud-session-fixture-only';
const CLIENT_ID = 'runner-fixture';
const CLIENT_SECRET = 'cloud-session-client-secret-fixture-only';
const HS_STAND_IN_SECRET = 'cloud-session-hs512-standin-fixture-only-0123456789';
const NS = 'cloud_session_fixture';
const DATABASE = 'main';

// 用 setTimeout 实现的等待，不使用 Bun.sleep
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

let dir = '';
let home = '';
let previousHome: string | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
let idp: ReturnType<typeof Bun.serve> | undefined;
let port = 0;
let surrealUrl = '';
let idpIssuer = '';
/** 当前签发的令牌寿命（秒）；每个用例在连接前设置。 */
let lifetimeSec = 600;
/** 身份服务收到的每一次 /token 请求（用于断言认证方式与请求次数）。 */
const tokenLog: Array<{ authorization: string | null; form: string }> = [];

const rootTarget = (): DbTarget => ({
  url: surrealUrl, namespace: NS, database: DATABASE, auth: { kind: 'root', username: 'root', password: ROOT_PASSWORD },
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** HS512 签名的 JWT（测试替身）。 */
function signHs512(claims: Record<string, unknown>): string {
  const head = b64({ alg: 'HS512', typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${createHmac('sha512', HS_STAND_IN_SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

/** 云端配置：runner 身份，凭证文件在临时服务目录里。 */
function configFor(): DatabaseConfig {
  return {
    url: surrealUrl,
    rootUser: '',
    rootPassword: '',
    namespace: NS,
    database: DATABASE,
    companyJwksUrl: `${idpIssuer}/jwks.json`,
    companyIssuer: idpIssuer,
    cloud: {
      idpIssuer,
      runnerClientId: CLIENT_ID,
      runnerClientSecretFile: join(home, 'private/cloud/runner-client-secret'),
    },
  };
}

function newDb(options?: CompanyDatabaseOptions): CompanyDatabase {
  return new CompanyDatabase(configFor(), options);
}

/** 用 root 连接数 task 表行数（每次新开连接，fork 重启后也可用）。 */
async function countTasks(): Promise<number> {
  const conn = new Surreal();
  try {
    await connectDb(conn, rootTarget());
    await conn.use({ namespace: NS, database: DATABASE });
    const [rows] = await conn.query<[Array<{ c: number }>]>('SELECT count() AS c FROM task GROUP ALL;');
    return rows?.[0]?.c ?? 0;
  } finally {
    await conn.close().catch(() => {});
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await delay(50);
  }
}

/** 拦截 console.error，记录会话重建的失败日志；restore 还原。 */
function captureConsoleError(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  };
  return { messages, restore: () => { console.error = original; } };
}

async function startFork(): Promise<void> {
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root',
    '--pass', ROOT_PASSWORD, '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* 尚未就绪 */ }
    await delay(25);
  }
  throw new Error('fork 未在时限内就绪');
}

async function stopFork(): Promise<void> {
  if (!server) return;
  const current = server;
  server = undefined;
  current.kill();
  await current.exited;
}

beforeAll(async () => {
  if (process.env.RUN_SCK_CLOUD_RUNNER_TESTS !== '1') return;

  // 临时服务目录与权限 600 的假 runner 凭证
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sck-cloud-session-home-')));
  mkdirSync(join(home, 'private/cloud'), { recursive: true });
  const secretFile = join(home, 'private/cloud/runner-client-secret');
  writeFileSync(secretFile, CLIENT_SECRET);
  chmodSync(secretFile, 0o600);
  previousHome = process.env.SCK_SERVICE_HOME;
  process.env.SCK_SERVICE_HOME = home;

  // 本地身份服务：/token 校验 Basic 认证后发 HS512 替身令牌（iss、ns、db、ac=runner、rl=Editor）
  idp = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async req => {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/token') {
        const authorization = req.headers.get('authorization');
        const form = await req.text();
        tokenLog.push({ authorization, form });
        const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
        if (authorization !== expected) return Response.json({ error: 'invalid_client' }, { status: 401 });
        if (new URLSearchParams(form).get('grant_type') !== 'client_credentials') {
          return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
        }
        const now = Math.floor(Date.now() / 1000);
        const token = signHs512({ iss: idpIssuer, ns: NS, db: DATABASE, ac: 'runner', rl: ['Editor'],
          sub: CLIENT_ID, iat: now, nbf: now, exp: now + lifetimeSec });
        return Response.json({ access_token: token, token_type: 'Bearer', expires_in: lifetimeSec });
      }
      return new Response('not found', { status: 404 });
    },
  });
  idpIssuer = `http://127.0.0.1:${idp.port}`;

  // 起 fork：先找一个空闲端口，再用 rocksdb 目录启动。端口在断线重启时保持不变。
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-cloud-session-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  port = listener.port!;
  listener.stop(true);
  surrealUrl = `ws://127.0.0.1:${port}/rpc`;
  await startFork();

  // 空库由 root 建好 ns/db、runner 访问方式（HS512 替身）与 task 表（任何已认证会话可读写，便于测试 LIVE 与写入）。
  const admin = new Surreal();
  await connectDb(admin, rootTarget());
  await admin.query(`DEFINE NAMESPACE ${NS};`);
  await admin.use({ namespace: NS });
  await admin.query(`DEFINE DATABASE ${DATABASE};`);
  await admin.use({ namespace: NS, database: DATABASE });
  await admin.query(`DEFINE ACCESS runner ON DATABASE TYPE JWT ALGORITHM HS512 KEY '${HS_STAND_IN_SECRET}' DURATION FOR SESSION 15m;`);
  // subscribeWake 会为 WAKE_TABLES 全部建立 LIVE 订阅，每张表都要存在且可读。
  for (const table of WAKE_TABLES) await admin.query(`DEFINE TABLE ${table} SCHEMALESS PERMISSIONS FULL;`);
  await admin.close();
});

afterAll(async () => {
  await stopFork();
  if (idp) idp.stop(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
  if (process.env.RUN_SCK_CLOUD_RUNNER_TESTS === '1') {
    if (previousHome === undefined) delete process.env.SCK_SERVICE_HOME;
    else process.env.SCK_SERVICE_HOME = previousHome;
  }
});

run('token 模式连接成功：connect 后可查询；身份服务收到 Basic 认证的 client_credentials 请求', async () => {
  lifetimeSec = 600;
  const before = tokenLog.length;
  const db = newDb();
  try {
    await db.connect();
    await db.useDatabase();
    const [rows] = await db.db.query<[Array<{ c: number }>]>('SELECT count() AS c FROM task GROUP ALL;');
    expect(Array.isArray(rows)).toBe(true);

    expect(tokenLog.length - before).toBe(1);
    const entry = tokenLog[before]!;
    expect(entry.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
    expect(new URLSearchParams(entry.form).get('grant_type')).toBe('client_credentials');
  } finally {
    await db.close();
  }
});

run('令牌临近过期时重建会话：绑定再次执行，写入不中断，续期后订阅仍感知写入', async () => {
  // 令牌寿命 6 秒，离到期 2.5 秒时续期：约 3.5 秒后第一次续期。
  lifetimeSec = 6;
  const db = newDb({ renewBeforeMs: 2500 });
  let binds = 0;
  let changes = 0;
  let changesAtRenewal = -1;
  try {
    await db.bindSession(async client => {
      binds++;
      if (binds === 2) changesAtRenewal = changes;
      return subscribeWake(client, () => { changes++; });
    });
    await db.connect();
    expect(binds).toBe(1);

    const before = await countTasks();
    let ok = 0;
    const failures: string[] = [];
    const stopAt = Date.now() + 8000;
    let seq = 0;
    while (Date.now() < stopAt) {
      try {
        await db.db.query('CREATE task CONTENT $row;', { row: { kind: 'renew-probe', seq: ++seq } });
        ok++;
      } catch (error) {
        failures.push((error as Error).message);
      }
      await delay(100);
    }

    expect(failures).toEqual([]);
    expect(ok).toBeGreaterThanOrEqual(30);
    expect(binds).toBeGreaterThanOrEqual(2);
    expect(changesAtRenewal).toBeGreaterThanOrEqual(0);
    expect(changes).toBeGreaterThan(changesAtRenewal);
    expect((await countTasks()) - before).toBe(ok);
  } finally {
    await db.close();
  }
});

run('断线后指数退避重连：fork 停止期间重建反复失败；重启后会话恢复并重新绑定', async () => {
  lifetimeSec = 600;
  const db = newDb({ reconnectMinMs: 200, reconnectMaxMs: 1000 });
  const logs = captureConsoleError();
  try {
    let binds = 0;
    await db.bindSession(async client => {
      binds++;
      return subscribeWake(client, () => {});
    });
    await db.connect();
    expect(binds).toBe(1);

    // 停掉 fork：连接断开后 SDK 不自动重连（reconnect: false），发出 'disconnected'，onDisconnected 触发后台重建。
    // 每次重建的 db connect 时限是 15 秒，所以第一次失败要等 15 秒以上才会出现，这里等到至少两次失败为止。
    await stopFork();
    const failedCount = () => logs.messages.filter(message => message.includes('公司库会话重建失败')).length;
    await waitFor(() => logs.messages.some(message => message.includes('公司库连接已断开')), 10000);
    await waitFor(() => failedCount() >= 2, 45000);
    expect(failedCount()).toBeGreaterThanOrEqual(2);
    expect(binds).toBe(1);

    // 同一 rocksdb 目录、同一端口重启：根账号、ns/db 与 HS512 访问方式仍在，后台重建应成功。
    await startFork();
    await waitFor(() => binds >= 2, 20000);
    const [rows] = await db.db.query<[Array<{ c: number }>]>('SELECT count() AS c FROM task GROUP ALL;');
    expect(Array.isArray(rows)).toBe(true);
  } finally {
    logs.restore();
    await db.close();
    // 即使用例中途失败，也要把 fork 拉起来，免得后续用例连接超时。
    if (!server) await startFork();
  }
});

run('close 后不再续期：关闭后等待超过一个令牌寿命，身份服务不再收到 /token 请求，close 不抛异常', async () => {
  lifetimeSec = 6;
  const db = newDb({ renewBeforeMs: 2500 });
  const startCount = tokenLog.length;
  await db.connect();
  // 等过一次续期（约 3.5 秒处），确认续期确实发生过，再关闭。
  await delay(4000);
  expect(tokenLog.length - startCount).toBeGreaterThanOrEqual(2);

  await db.close();
  const atClose = tokenLog.length;
  await delay(7000);
  expect(tokenLog.length).toBe(atClose);
});

run('bindSession 在已有会话时立即绑定；取消函数拆除绑定，之后经 db.db 的写入不再触发 onChange', async () => {
  lifetimeSec = 600;
  const db = newDb();
  try {
    await db.connect();
    let binds = 0;
    let changes = 0;
    const cancel = await db.bindSession(async client => {
      binds++;
      return subscribeWake(client, () => { changes++; });
    });
    expect(binds).toBe(1);

    // 绑定有效：写入会触发 onChange。
    await db.db.query('CREATE task CONTENT $row;', { row: { kind: 'bind-probe', seq: 1 } });
    await waitFor(() => changes >= 1, 5000);

    await cancel();
    const atCancel = changes;
    await db.db.query('CREATE task CONTENT $row;', { row: { kind: 'bind-probe', seq: 2 } });
    await db.db.query('CREATE task CONTENT $row;', { row: { kind: 'bind-probe', seq: 3 } });
    await delay(800);
    expect(changes).toBe(atCancel);
    expect(binds).toBe(1);
  } finally {
    await db.close();
  }
});
