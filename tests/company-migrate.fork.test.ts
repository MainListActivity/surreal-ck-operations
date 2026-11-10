import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Surreal } from 'surrealdb';
import type { DatabaseConfig } from '../src/config.ts';
import { connectDb, useDb, type DbTarget } from '../src/db-connection.ts';
import { CLOUD_SCHEMA_VERSION, renderCompanyAccess } from '../src/database.ts';
import { SEED_DEFS } from '../src/seed.ts';
import { runCompanyMigrate } from '../scripts/company-migrate.ts';
import { runCloudBootstrap } from '../scripts/cloud-bootstrap.ts';

// 云端迁移与初始开通的真实 fork 测试（门控 RUN_SCK_CLOUD_RUNNER_TESTS=1）。
// 在 mkdtemp 目录里起本地 fork（~/.surrealdb/surreal）。身份服务用本地 Bun.serve 充当：/token 发 client_credentials 令牌。
// 服务目录用 SCK_SERVICE_HOME 指向临时目录，凭证文件权限 600，不碰生产库与真实服务目录。
//
// 测试替身（已验证的 fork 限制）：本机 fork（3.3.0-nightly）不支持 URL 类 JWT 访问（JWKS 从不被拉取，登录直接报
// "access method cannot be used in the requested operation"）。所以 055 生产渲染出的 JWKS 访问在这里无法登录。
// 替身做法：每次迁移或开通之后，在测试库上用同一份渲染后的 055 把 URL 换成 HS512 共享密钥再 OVERWRITE 一遍；
// 空库首次登录前，由 root 先定义同名的 HS512 migrator 访问。这样签名与校验仍走 JWT 访问路径，其余语句与生产一致。
setDefaultTimeout(120000);
const run = process.env.RUN_SCK_CLOUD_RUNNER_TESTS === '1' ? test : test.skip;

const ROOT_PASSWORD = 'cloud-migrate-fixture-only';
const CLIENT_ID = 'migrator-fixture';
const CLIENT_SECRET = 'cloud-migrate-client-secret-fixture-only';
const HS_STAND_IN_SECRET = 'cloud-migrate-hs512-standin-fixture-only-0123456789';
const MIGRATE_NS = 'cloud_migrate_fixture';
const BOOT_NS = 'cloud_bootstrap_fixture';
const LEGACY_NS = 'cloud_outbox_drop_fixture';
const DATABASE = 'main';
const ACCESS_NAMES = ['owner', 'runner', 'automation', 'gateway', 'migrator', 'viewer'];

// 用 setTimeout 实现的等待，不使用 Bun.sleep
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

let dir = '';
let home = '';
let previousHome: string | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
let idp: ReturnType<typeof Bun.serve> | undefined;
let surrealUrl = '';
let idpIssuer = '';
let jwksUrl = '';
// 当前签发令牌的 ns/db；每次运行前由测试切换，令牌必须与目标库一致。
let scope = { ns: MIGRATE_NS, db: DATABASE };
const sessions: Surreal[] = [];

const rootTarget = (namespace: string): DbTarget => ({
  url: surrealUrl, namespace, database: DATABASE, auth: { kind: 'root', username: 'root', password: ROOT_PASSWORD },
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** HS512 签名的 JWT（测试替身）。 */
function signHs512(claims: Record<string, unknown>): string {
  const head = b64({ alg: 'HS512', typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${createHmac('sha512', HS_STAND_IN_SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

/** 配置：云端模式，身份服务指向本地 Bun.serve，migrator 凭证文件在临时服务目录里。 */
function configFor(namespace: string): DatabaseConfig {
  return {
    url: surrealUrl,
    rootUser: '',
    rootPassword: '',
    namespace,
    database: DATABASE,
    companyJwksUrl: jwksUrl,
    companyIssuer: idpIssuer,
    cloud: {
      idpIssuer,
      runnerClientSecretFile: join(home, 'private/cloud/runner-client-secret'),
      migratorClientId: CLIENT_ID,
      migratorClientSecretFile: join(home, 'private/cloud/migrator-client-secret'),
    },
  };
}

/** root 会话：只用于定义替身、断言与读取库内状态。 */
async function rootSession(namespace: string): Promise<Surreal> {
  const conn = new Surreal();
  await connectDb(conn, rootTarget(namespace));
  await useDb(conn, rootTarget(namespace));
  sessions.push(conn);
  return conn;
}

/**
 * 测试替身：用生产同一份渲染后的 055 重新定义六个访问方式，只把 JWKS 地址换成 HS512 共享密钥。
 * 只在测试库上执行；生产里 055 只用 JWKS 地址。
 */
async function standInAccesses(namespace: string): Promise<void> {
  const admin = await rootSession(namespace);
  const rendered = renderCompanyAccess(readFileSync(join(import.meta.dir, '..', 'schema', '055-access.surql'), 'utf8'), jwksUrl, idpIssuer)
    .replaceAll(`URL '${jwksUrl}'`, `ALGORITHM HS512 KEY '${HS_STAND_IN_SECRET}'`);
  await admin.query(rendered);
}

/** 统计库里每张表的行数（表名来自 INFO FOR DB，均为 schema 内定义的标识符）。 */
async function countRows(conn: Surreal): Promise<Record<string, number>> {
  const [info] = await conn.query<[Record<string, unknown>]>('INFO FOR DB;');
  const counts: Record<string, number> = {};
  for (const table of Object.keys((info.tables ?? {}) as Record<string, unknown>)) {
    const [rows] = await conn.query<[Array<{ c: number }>]>(`SELECT count() AS c FROM ${table} GROUP ALL;`);
    counts[table] = rows?.[0]?.c ?? 0;
  }
  return counts;
}

beforeAll(async () => {
  if (process.env.RUN_SCK_CLOUD_RUNNER_TESTS !== '1') return;

  // 临时服务目录与权限 600 的假 migrator 凭证
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sck-cloud-migrate-home-')));
  mkdirSync(join(home, 'private/cloud'), { recursive: true });
  const secretFile = join(home, 'private/cloud/migrator-client-secret');
  writeFileSync(secretFile, CLIENT_SECRET);
  chmodSync(secretFile, 0o600);
  previousHome = process.env.SCK_SERVICE_HOME;
  process.env.SCK_SERVICE_HOME = home;

  // 本地身份服务：/token 发 client_credentials 令牌（HS512 替身），/jwks.json 只为满足 055 的 URL 形态
  idp = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async req => {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/jwks.json') return Response.json({ keys: [] });
      if (req.method === 'POST' && url.pathname === '/token') {
        const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
        if (req.headers.get('authorization') !== expected) return Response.json({ error: 'invalid_client' }, { status: 401 });
        const form = new URLSearchParams(await req.text());
        if (form.get('grant_type') !== 'client_credentials') return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
        const now = Math.floor(Date.now() / 1000);
        const token = signHs512({ iss: idpIssuer, ns: scope.ns, db: scope.db, ac: 'migrator', rl: ['Owner'],
          sub: CLIENT_ID, iat: now, nbf: now, exp: now + 600 });
        return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 600 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  idpIssuer = `http://127.0.0.1:${idp.port}`;
  jwksUrl = `${idpIssuer}/jwks.json`;

  // 起 fork：先找一个空闲端口，再用 rocksdb 目录启动
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-cloud-migrate-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!;
  listener.stop(true);
  surrealUrl = `ws://127.0.0.1:${port}/rpc`;
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root',
    '--pass', ROOT_PASSWORD, '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 尚未就绪 */ }
    await delay(25);
  }

  // 空的 ns/db 由 root 建好；首次登录前 055 尚未应用，所以先定义同名的 HS512 migrator 访问（测试替身）。
  for (const namespace of [MIGRATE_NS, BOOT_NS, LEGACY_NS]) {
    const admin = new Surreal();
    await connectDb(admin, rootTarget(namespace));
    await admin.query(`DEFINE NAMESPACE ${namespace};`);
    await admin.use({ namespace });
    await admin.query(`DEFINE DATABASE ${DATABASE};`);
    await admin.use({ namespace, database: DATABASE });
    await admin.query(`DEFINE ACCESS migrator ON DATABASE TYPE JWT ALGORITHM HS512 KEY '${HS_STAND_IN_SECRET}' DURATION FOR SESSION 15m;`);
    await admin.close();
  }
});

afterAll(async () => {
  for (const conn of sessions) await conn.close().catch(() => {});
  if (server) { server.kill(); await server.exited; }
  if (idp) idp.stop(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
  if (process.env.RUN_SCK_CLOUD_RUNNER_TESTS === '1') {
    if (previousHome === undefined) delete process.env.SCK_SERVICE_HOME;
    else process.env.SCK_SERVICE_HOME = previousHome;
  }
});

run('空库上 company-migrate 应用全部 schema 到 CLOUD_SCHEMA_VERSION；再次运行结果不变（幂等）', async () => {
  scope = { ns: MIGRATE_NS, db: DATABASE };
  const firstLines: string[] = [];
  const first = await runCompanyMigrate(configFor(MIGRATE_NS), { log: line => firstLines.push(line) });
  expect(first.fresh).toBe(true);
  expect(firstLines.some(line => line.startsWith('阶段 3/3'))).toBe(true);

  // 055 生产渲染：六个访问方式的定义里是 JWKS 地址；随后换成测试替身，使下一次登录可用。
  const probe = await rootSession(MIGRATE_NS);
  const [infoAfterFirst] = await probe.query<[Record<string, unknown>]>('INFO FOR DB;');
  // 0.7.1 的 062 删除 outbox 表：空库按 001–062 应用之后不再有它。
  expect(Object.keys((infoAfterFirst.tables ?? {}) as Record<string, unknown>)).not.toContain('outbox');
  const renderedAccesses = (infoAfterFirst.accesses ?? {}) as Record<string, string>;
  for (const name of ACCESS_NAMES) expect(renderedAccesses[name]).toContain(`URL '${jwksUrl}'`);
  await standInAccesses(MIGRATE_NS);

  const admin = await rootSession(MIGRATE_NS);
  const [marker] = await admin.query<[Array<{ owner: string; schema_version: number }>]>(
    'SELECT owner, schema_version FROM company_meta:installation;');
  expect(marker?.[0]?.schema_version).toBe(CLOUD_SCHEMA_VERSION);
  const before = await countRows(admin);

  const secondLines: string[] = [];
  const second = await runCompanyMigrate(configFor(MIGRATE_NS), { log: line => secondLines.push(line) });
  expect(second.fresh).toBe(false);
  expect(secondLines.some(line => line.startsWith('阶段 3/3'))).toBe(true);
  await standInAccesses(MIGRATE_NS);

  const [after] = await admin.query<[Array<{ owner: string; schema_version: number }>]>(
    'SELECT owner, schema_version FROM company_meta:installation;');
  expect(after?.[0]?.schema_version).toBe(CLOUD_SCHEMA_VERSION);
  expect(after?.[0]?.owner).toBe(marker?.[0]?.owner);
  expect(await countRows(admin)).toEqual(before);
});

run('055 渲染后：owner、runner、automation、gateway、migrator、viewer 六个访问方式都存在', async () => {
  const admin = await rootSession(MIGRATE_NS);
  const [info] = await admin.query<[Record<string, unknown>]>('INFO FOR DB;');
  const accesses = (info.accesses ?? {}) as Record<string, string>;
  for (const name of ACCESS_NAMES) expect(accesses[name]).toBeDefined();
});

run('0.7.0 遗留的 outbox 表与计数器：迁移到 062 后删除；再次迁移无错且行数不变', async () => {
  scope = { ns: LEGACY_NS, db: DATABASE };
  await runCompanyMigrate(configFor(LEGACY_NS), { log: () => {} });
  await standInAccesses(LEGACY_NS);

  // 模拟 0.7.0 库：outbox 表（含索引与一条旧事件）、company_meta:outbox_counter，结构版本停在 61。
  const admin = await rootSession(LEGACY_NS);
  await admin.query(`DEFINE TABLE IF NOT EXISTS outbox SCHEMALESS PERMISSIONS NONE;
    DEFINE INDEX IF NOT EXISTS outbox_sequence ON TABLE outbox FIELDS sequence UNIQUE;
    CREATE outbox CONTENT { at: 1, sequence: 1, kind: 'legacy' };
    UPSERT company_meta:outbox_counter CONTENT { value: 1 };
    UPDATE company_meta:installation SET schema_version = 61;`);

  const migrated = await runCompanyMigrate(configFor(LEGACY_NS), { log: () => {} });
  expect(migrated.fresh).toBe(false);
  await standInAccesses(LEGACY_NS);
  const [info] = await admin.query<[Record<string, unknown>]>('INFO FOR DB;');
  expect(Object.keys((info.tables ?? {}) as Record<string, unknown>)).not.toContain('outbox');
  const [counter] = await admin.query<[unknown]>('SELECT * FROM ONLY company_meta:outbox_counter;');
  expect(counter).toBeFalsy();
  const [marker] = await admin.query<[Array<{ schema_version: number }>]>(
    'SELECT schema_version FROM company_meta:installation;');
  expect(marker?.[0]?.schema_version).toBe(CLOUD_SCHEMA_VERSION);
  const before = await countRows(admin);

  const again = await runCompanyMigrate(configFor(LEGACY_NS), { log: () => {} });
  expect(again.fresh).toBe(false);
  await standInAccesses(LEGACY_NS);
  expect(await countRows(admin)).toEqual(before);
});

run('cloud-bootstrap 对空库运行两次：初始编制写入一次，第二次行数不变', async () => {
  scope = { ns: BOOT_NS, db: DATABASE };
  const first = await runCloudBootstrap(configFor(BOOT_NS), { log: () => {} });
  expect(first.fresh).toBe(true);
  expect([...first.inserted].sort()).toEqual(SEED_DEFS.map(def => def.id).sort());
  await standInAccesses(BOOT_NS);

  const admin = await rootSession(BOOT_NS);
  const [defIds] = await admin.query<[string[]]>('SELECT VALUE meta::id(id) FROM employee_def;');
  expect(defIds.length).toBe(SEED_DEFS.length);
  expect([...defIds].sort()).toEqual(SEED_DEFS.map(def => def.id).sort());
  const before = await countRows(admin);

  const second = await runCloudBootstrap(configFor(BOOT_NS), { log: () => {} });
  expect(second.fresh).toBe(false);
  expect(second.inserted).toEqual([]);
  expect(await countRows(admin)).toEqual(before);
});
