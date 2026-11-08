import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RecordId, Surreal } from 'surrealdb';
import { CompanyDatabase } from '../../src/database.ts';

setDefaultTimeout(60000);
// 老板端网关的访问规则（fork）：058 应用后，gateway 令牌写 protected_command / agent_policy 被拒，改删 ops_audit 被拒。
// 055 不定义 gateway 访问方式（W3-RUNNER 后加），所以这里在测试里自己定义一份，形状与 055 一致；
// 令牌用 HS512 共享密钥代替 JWKS，与 company-access.fork.test.ts 同一套替身。
const run = process.env.RUN_SCK_OWNER_END_TESTS === '1' ? test : test.skip;
const PASSWORD = 'owner-end-gateway-fixture-only';
const SECRET = 'owner-end-gateway-fixture-secret-0123456789-abcdef';
const ISS = 'https://ma.example.test';
const NS = 'owner_end_gateway';
const DATABASE = 'control_plane';
const PROTECTED_GUARD = '只有老板可以修改保护命令';
const POLICY_GUARD = '只有老板可以修改员工策略';
const AUDIT_GUARD = '审计账本只追加';

let server: ReturnType<typeof Bun.spawn> | undefined;
let port = 0;
let company: CompanyDatabase;
const sessions: Surreal[] = [];

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(claims: Record<string, unknown>, secret = SECRET): string {
  const head = b64({ alg: 'HS512', typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${createHmac('sha512', secret).update(`${head}.${body}`).digest('base64url')}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
/** 令牌：ac 选访问方式；身份走 sub（fork 不接受 id / ID 声明）。 */
function tokenFor(ac: string, sub: string, extra: Record<string, unknown> = {}): string {
  const now = nowSec();
  return sign({ iss: ISS, ns: NS, db: DATABASE, ac, rl: ['Editor'], sub, iat: now, nbf: now, exp: now + 600, ...extra });
}

async function session(token: string): Promise<Surreal> {
  const conn = new Surreal();
  await conn.connect(`ws://127.0.0.1:${port}/rpc`);
  await conn.use({ namespace: NS, database: DATABASE });
  try {
    await conn.authenticate(token);
  } catch (error) {
    await conn.close();
    throw error;
  }
  sessions.push(conn);
  return conn;
}

/** 语句必须被拒绝，且错误信息含指定文字。 */
async function rejects(promise: Promise<unknown>, reason: string): Promise<void> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(String(error)).toContain(reason);
}

beforeAll(async () => {
  if (process.env.RUN_SCK_OWNER_END_TESTS !== '1') return;
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  port = listener.port!;
  listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', PASSWORD,
    '--log', 'error', 'memory'], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(25);
  }
  company = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: PASSWORD, namespace: NS, database: DATABASE });
  await company.connect();
  // bootstrap 应用到 058（含 056 的守卫事件）；本机模式不应用 055。
  await company.bootstrap();
  // 测试替身：与生产同一份 055，只把 JWKS 地址换成共享密钥（owner 访问方式由它提供）。
  const access = readFileSync(join(import.meta.dir, '..', '..', 'schema', '055-access.surql'), 'utf8')
    .replaceAll("URL '{{COMPANY_JWKS_URL}}'", `ALGORITHM HS512 KEY '${SECRET}'`)
    .replaceAll('{{COMPANY_ISSUER}}', ISS);
  await company.db.query(access);
  // gateway 访问方式（测试自备）：形状同 055 的 owner / runner，签发方校验与会话时长一致。
  await company.db.query(`DEFINE ACCESS OVERWRITE gateway ON DATABASE TYPE JWT ALGORITHM HS512 KEY '${SECRET}'
    AUTHENTICATE { IF $token.iss != '${ISS}' { THROW '令牌签发方不属于公司库' } }
    DURATION FOR SESSION 15m;`);
});

afterAll(async () => {
  for (const conn of sessions) await conn.close();
  if (company) await company.close();
  server?.kill();
  await server?.exited;
});

run('gateway 令牌：ac 与签发方校验通过；签发方不符、签名错、带 id 声明都被拒', async () => {
  const gateway = await session(tokenFor('gateway', 'gateway-client-id'));
  const [access] = await gateway.query<[string]>('RETURN $access;');
  expect(access).toBe('gateway');
  const now = nowSec();
  const base = { iss: ISS, ns: NS, db: DATABASE, ac: 'gateway', rl: ['Editor'], sub: 'x', iat: now, nbf: now, exp: now + 600 };
  await expect(session(tokenFor('gateway', 'x', { iss: 'https://evil.test' }))).rejects.toThrow();
  await expect(session(sign(base, 'another-secret-another-secret-0000000000'))).rejects.toThrow();
  await expect(session(tokenFor('gateway', 'x', { id: 'gateway:1' }))).rejects.toThrow();
});

run('058 之后 gateway 令牌写 protected_command 被拒：新建与改动都拒绝，行保持不变', async () => {
  const owner = await session(tokenFor('owner', 'owner-1'));
  const gateway = await session(tokenFor('gateway', 'gateway-client-id'));
  // 先由老板建一行，确保下面的 UPDATE 真的命中记录（WHERE 不命中则事件不触发）。
  await owner.query("CREATE protected_command CONTENT { command: 'gateway.probe', owner_only: true, updated_by: 'owner-1', updated_at: time::now() };");
  await rejects(gateway.query("CREATE protected_command CONTENT { command: 'gateway.new', owner_only: true, updated_by: 'gateway-client-id', updated_at: time::now() };"), PROTECTED_GUARD);
  await rejects(gateway.query("UPDATE protected_command SET owner_only = false WHERE command = 'gateway.probe';"), PROTECTED_GUARD);
  const [[row]] = await company.db.query<[Array<Record<string, unknown>>]>("SELECT command, owner_only FROM protected_command WHERE command = 'gateway.probe';");
  expect(row).toMatchObject({ command: 'gateway.probe', owner_only: true });
  const [[added]] = await company.db.query<[Array<Record<string, unknown>>]>("SELECT command FROM protected_command WHERE command = 'gateway.new';");
  expect(added).toBeUndefined();
});

run('058 之后 gateway 令牌写 agent_policy 被拒：新建与改动都拒绝，行保持不变', async () => {
  const owner = await session(tokenFor('owner', 'owner-1'));
  const gateway = await session(tokenFor('gateway', 'gateway-client-id'));
  await owner.query("CREATE agent_policy CONTENT { agent: 'emp-gw', disabled: false, deny: ['task.pause'], updated_by: 'owner-1', updated_at: time::now() };");
  await rejects(gateway.query("CREATE agent_policy CONTENT { agent: 'emp-gw-new', disabled: true, deny: [], updated_by: 'gateway-client-id', updated_at: time::now() };"), POLICY_GUARD);
  await rejects(gateway.query("UPDATE agent_policy SET disabled = true WHERE agent = 'emp-gw';"), POLICY_GUARD);
  const [[policy]] = await company.db.query<[Array<Record<string, unknown>>]>("SELECT disabled, deny FROM agent_policy WHERE agent = 'emp-gw';");
  expect(policy).toMatchObject({ disabled: false, deny: ['task.pause'] });
});

run('正控制：老板与 root 写 protected_command、agent_policy 放行，拒绝只来自访问方式而非 schema 故障', async () => {
  const owner = await session(tokenFor('owner', 'owner-1'));
  // root（$access 为 NONE）与老板（owner）都能写两张守卫表。
  await company.db.query("CREATE protected_command CONTENT { command: 'gateway.root', owner_only: true, updated_by: 'root', updated_at: time::now() };");
  await company.db.query("CREATE agent_policy CONTENT { agent: 'emp-gw-root', disabled: false, deny: [], updated_by: 'root', updated_at: time::now() };");
  await owner.query("UPDATE protected_command SET owner_only = true WHERE command = 'gateway.root';");
  await owner.query("UPDATE agent_policy SET disabled = true WHERE agent = 'emp-gw-root';");
  const [[protectedRow]] = await company.db.query<[Array<Record<string, unknown>>]>("SELECT command FROM protected_command WHERE command = 'gateway.root';");
  expect(protectedRow).toMatchObject({ command: 'gateway.root' });
  const [[policyRow]] = await company.db.query<[Array<Record<string, unknown>>]>("SELECT disabled FROM agent_policy WHERE agent = 'emp-gw-root';");
  expect(policyRow).toMatchObject({ disabled: true });
});

run('058 之后 gateway 令牌可以追加 ops_audit；修改与删除都被拒，行保持不变', async () => {
  const gateway = await session(tokenFor('gateway', 'gateway-client-id'));
  const [created] = await gateway.query<[Array<{ id: RecordId }>]>(
    "CREATE ops_audit CONTENT { actor_kind: 'agent', actor: 'gateway-audit', command: 'task.note', args_digest: 'digest-gw', outcome: 'ok', summary: '网关审计' };");
  const row = created[0];
  expect(row.id).toBeInstanceOf(RecordId);
  await rejects(gateway.query("UPDATE $row SET reason = '篡改';", { row: row.id }), AUDIT_GUARD);
  await rejects(gateway.query('DELETE $row;', { row: row.id }), AUDIT_GUARD);
  const [[kept]] = await company.db.query<[Array<{ reason?: string; summary?: string }>]>('SELECT reason, summary FROM $row;', { row: row.id });
  expect(kept.reason).toBeUndefined();
  expect(kept.summary).toBe('网关审计');
});

run('owner 令牌可以写保护清单与员工策略（可选，正控制的访问方式版本）', async () => {
  const owner = await session(tokenFor('owner', 'owner-1'));
  await owner.query("CREATE protected_command CONTENT { command: 'gateway.owner', owner_only: true, updated_by: 'owner-1', updated_at: time::now() };");
  await owner.query("CREATE agent_policy CONTENT { agent: 'emp-gw-owner', disabled: false, deny: [], updated_by: 'owner-1', updated_at: time::now() };");
  const [[protectedRow]] = await company.db.query<[Array<Record<string, unknown>>]>("SELECT command FROM protected_command WHERE command = 'gateway.owner';");
  expect(protectedRow).toMatchObject({ command: 'gateway.owner' });
  const [[policyRow]] = await company.db.query<[Array<Record<string, unknown>>]>("SELECT agent FROM agent_policy WHERE agent = 'emp-gw-owner';");
  expect(policyRow).toMatchObject({ agent: 'emp-gw-owner' });
});
