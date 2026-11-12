import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CborCodec, RecordId, Surreal, Table } from 'surrealdb';
import { CompanyDatabase } from '../../src/database.ts';
import { ownerEventStream, LIVE_TABLES } from '../src/realtime.ts';
import { readRuntimeDashboard } from '../../src/runtime-dashboard.ts';
import { writeHostTelemetry, writeRuntimeObservation } from '../../src/runner/telemetry.ts';
import { writeRunnerHeartbeat } from '../../src/board.ts';
import { OutboundMessageStore } from '../../src/outbound-messages.ts';
import { decide } from '../../src/command-guard.ts';
import { runOwnerCommandOn } from '../src/commands.ts';

setDefaultTimeout(60000);
// 老板端网关的访问规则（fork）：058 应用后，gateway 令牌写 protected_command / agent_policy 被拒，改删 ops_audit 被拒。
// 访问方式用生产的 055（owner、gateway 等都在其中定义），这里只把 JWKS 地址换成共享密钥，不在测试里另写访问方式。
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
  // 测试替身：与生产同一份 055（owner、gateway、viewer 等访问方式都由它提供），只把 JWKS 地址换成共享密钥。
  const access = readFileSync(join(import.meta.dir, '..', '..', 'schema', '055-access.surql'), 'utf8')
    .replaceAll("URL '{{COMPANY_JWKS_URL}}'", `ALGORITHM HS512 KEY '${SECRET}'`)
    .replaceAll('{{COMPANY_ISSUER}}', ISS);
  await company.db.query(access);
});

afterAll(async () => {
  for (const conn of sessions) await conn.close();
  if (company) await company.close();
  server?.kill();
  await server?.exited;
});

async function nextFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('LIVE event timeout')), 5000); }),
    ]);
    return new TextDecoder().decode(result.value);
  } finally { clearTimeout(timer); }
}

run('老板身份在公司 fork 上建立全部 LIVE，跨连接写入主动推送；取消流释放连接', async () => {
  const owner = await session(tokenFor('owner', 'live-owner', { rl: ['Owner'] }));
  const abort = new AbortController();
  const response = ownerEventStream(owner, abort.signal, Date.now() + 60000);
  const reader = response.body!.getReader();
  try {
    const ready = await nextFrame(reader);
    expect(ready).toContain('event: ready');
    for (const table of LIVE_TABLES) expect(ready).toContain(table);
    await company.db.query("UPSERT company_meta:live_probe CONTENT { marker: '不得传给前端的原始正文' };");
    const changed = await nextFrame(reader);
    expect(changed).toContain('event: change');
    expect(changed).toContain('company_meta');
    expect(changed).not.toContain('原始正文');
    // id 没变、仅修改未投影的正文，也必须触发页面失效。
    await company.db.query("UPDATE company_meta:live_probe SET marker = '正文已修改';");
    const updated = await nextFrame(reader);
    expect(updated).toContain('event: change');
    expect(updated).toContain('company_meta');
    expect(updated).not.toContain('正文已修改');
    await company.db.query('DELETE company_meta:live_probe;');
    expect(await nextFrame(reader)).toContain('company_meta');
  } finally { await reader.cancel(); }
  expect(owner.isConnected).toBe(false);
});

run('LIVE 仅投影 id 仍逐次收到同一记录的创建、正文更新和删除，正文不进入 SDK 通知', async () => {
  const owner = await session(tokenFor('owner', 'live-projection-owner', { rl: ['Owner'] }));
  const full = await owner.live(new Table('company_meta'));
  const projected = await owner.live(new Table('company_meta')).fields('id');
  const fullEvents = full[Symbol.asyncIterator]();
  const projectedEvents = projected[Symbol.asyncIterator]();
  const codec = new CborCodec({});
  const nextEvent = async (events: typeof fullEvents) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const event = await Promise.race([
        events.next(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('LIVE projection timeout')), 5000); }),
      ]);
      expect(event.done).toBe(false);
      return event.value!;
    } finally { clearTimeout(timer); }
  };
  try {
    const body = '仅限本地测试的示例正文'.repeat(4000);
    const writes = [
      ['CREATE', 'CREATE company_meta:projection_probe SET body = $body;'],
      ['UPDATE', 'UPDATE company_meta:projection_probe SET body = $body + "已修改";'],
      ['DELETE', 'DELETE company_meta:projection_probe;'],
    ] as const;
    for (const [action, sql] of writes) {
      await company.db.query(sql, { body });
      const [original, slim] = await Promise.all([nextEvent(fullEvents), nextEvent(projectedEvents)]);
      expect(original.action).toBe(action);
      expect(slim.action).toBe(action);
      expect(String(slim.recordId)).toBe('company_meta:projection_probe');
      expect(Object.keys(slim.value)).toEqual(['id']);
      expect(String(slim.value.id)).toBe('company_meta:projection_probe');
      expect(codec.encode(slim.value).byteLength).toBeLessThan(codec.encode(original.value).byteLength / 100);
    }
  } finally {
    await Promise.all([full.kill(), projected.kill()]);
    await owner.close();
  }
});

run('新运行数据在真实 schema 可写可读，已发正文保存实际渲染文本', async () => {
  const owner = await session(tokenFor('owner', 'dashboard-owner', { rl: ['Owner'] }));
  await writeRunnerHeartbeat(company.db, {runner:'fixture:runtime',host:'test-host',version:'test'});
  await writeHostTelemetry(company.db,'fixture:runtime','fixture-node',{
    platform:'darwin',arch:'arm64',cpuModel:'fixture',cores:8,memoryTotal:16*2**30,memoryUsed:8*2**30,cpuPercent:25,
  });
  await company.db.query("CREATE employee:runtime_fixture CONTENT {role:'engineering',paseo_agent_id:'fixture-session',runner_id:'fixture:runtime',model:'configured-model'};");
  const observedAt=Date.now();
  await writeRuntimeObservation(company.db,'fixture-session','running',observedAt,'fixture-model');
  await writeRuntimeObservation(company.db,'fixture-session','idle',observedAt-1000,'stale-model');
  await company.db.query(`CREATE project:timing_fixture SET name = '真实项目关联', repo_path = '/fixture';
    CREATE task:runtime_fixture SET project = project:timing_fixture, title = '本轮任务', kind = 'task', state = 'doing',
      executor_role = 'engineering', reviewer_role = 'qa', current_employee = 'runtime_fixture', lease_expires_at = time::unix(time::now()) + 60;
    CREATE audit SET task = task:runtime_fixture, actor = employee:runtime_fixture, action = 'claim', phase = 'execute', at = time::now() - 10s;
    FOR $i IN [1,2,3,4,5] {
      LET $task = type::record('task', 'timing-history-' + <string>$i);
      CREATE $task SET project = project:timing_fixture, kind = 'task', state = 'done', executor_role = 'engineering';
      CREATE audit SET task = $task, actor = employee:runtime_fixture, action = 'claim', phase = 'execute', at = time::now() - 10m;
      CREATE audit SET task = $task, actor = employee:runtime_fixture, action = 'submit', phase = 'execute', at = time::now() - 1m;
    };`);
  const result = await readRuntimeDashboard(owner);
  expect(result.hosts.find(h=>h.id==='fixture-node')).toMatchObject({state:'online',metrics:{cpuPercent:25,cores:8}});
  expect(result.agents.find(a=>a.id==='runtime_fixture')).toMatchObject({hostId:'fixture-node',state:'running',model:'fixture-model',modelSource:'observed'});
  expect(result.agents.find(a=>a.id==='runtime_fixture')).toMatchObject({project:{id:'timing_fixture',name:'真实项目关联'}, estimate:{status:'estimated',samples:5}});
  await company.db.query("CREATE outbound_message:runtime_sent CONTENT {task: task:runtime_fixture, step:'execute', role:'engineering', body:'模板 {{employee}}'};");
  await new OutboundMessageStore(company.db).markSent('runtime_sent','fixture-employee','实际渲染文本与工作目录');
  const [[row]] = await company.db.query<[Array<{body:string;sent_body:string}>]>('SELECT body, sent_body FROM outbound_message:runtime_sent;');
  expect(row).toEqual({body:'模板 {{employee}}',sent_body:'实际渲染文本与工作目录'});
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

run('网关会话下的命令守卫按职能取策略：职能停用即拒绝该职能的任何实例，其它职能照常（读不到职能时不能放行）', async () => {
  const gateway = await session(tokenFor('gateway', 'gateway-client-id'));
  const now = Math.floor(Date.now() / 1000);
  await company.db.query(`UPSERT employee:⟨gw-role-off-1⟩ SET role = 'gw-role-off', paseo_agent_id = 'agent-gw-off';
    UPSERT employee:⟨gw-role-on-1⟩ SET role = 'gw-role-on', paseo_agent_id = 'agent-gw-on';
    CREATE agent_policy CONTENT { agent: 'gw-role-off', disabled: true, deny: [], updated_by: 'root', updated_at: time::now() };
    CREATE task:gw_role_off CONTENT { title: '职能停用', state: 'doing', kind: 'task', current_employee: 'gw-role-off-1', lease_expires_at: $live, fence: 1, version: 1 };
    CREATE task:gw_role_on CONTENT { title: '职能启用', state: 'doing', kind: 'task', current_employee: 'gw-role-on-1', lease_expires_at: $live, fence: 1, version: 1 };`,
    { live: now + 600 });
  expect(await decide(gateway, { actorKind: 'agent', actor: 'gw-role-off-1', task: 'gw_role_off', command: 'submit', now }))
    .toMatchObject({ allow: false, reason: '该员工已停用' });
  expect(await decide(gateway, { actorKind: 'agent', actor: 'gw-role-on-1', task: 'gw_role_on', command: 'submit', now }))
    .toMatchObject({ allow: true });
});

run('老板令牌在页面里编辑员工定义：未给出的字段保持原值，停用的定义改其它字段后仍停用，thinking 传 null 才清空', async () => {
  const owner = await session(tokenFor('owner', 'owner-1', { rl: ['Owner'] }));
  const ensure = (input: Record<string, unknown>) => runOwnerCommandOn({}, owner, 'owner-1', 'def.ensure', input);
  await ensure({ id: 'gw-def-a', role: 'engineering', provider: 'claude', model: 'claude-haiku-5-5', thinking: 'max', maxInstances: 3, weight: 20, priority: 50 });
  await company.db.query("UPDATE employee_def:⟨gw-def-a⟩ SET tracks = ['编剧'];");
  const read = async () => (await company.db.query<[Array<Record<string, unknown>>]>('SELECT * FROM employee_def:⟨gw-def-a⟩;'))[0][0]!;

  // 只改模型：思考强度、上限、权重、优先级、擅长方向都不变。
  await ensure({ id: 'gw-def-a', role: 'engineering', provider: 'claude', model: 'claude-sonnet-5-5' });
  expect(await read()).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'max', max_instances: 3, weight: 20, priority: 50, tracks: ['编剧'], enabled: true });

  // 停用后再改其它字段：仍停用。
  await runOwnerCommandOn({}, owner, 'owner-1', 'def.disable', { id: 'gw-def-a', reason: '老板停用' });
  await ensure({ id: 'gw-def-a', role: 'engineering', provider: 'factory-droid', model: 'claude-haiku-5-5', quotaLimited: false });
  expect(await read()).toMatchObject({ provider: 'factory-droid', enabled: false, quota_limited: false, disabled_reason: '老板停用' });

  // thinking 传 null 清空。
  await ensure({ id: 'gw-def-a', role: 'engineering', provider: 'factory-droid', model: 'claude-haiku-5-5', thinking: null });
  expect((await read()).thinking).toBeUndefined();
  // 工作时间：保存规范化后的值，不提即保留，null 清除；不合法的拒绝。
  await ensure({ id: 'gw-def-a', role: 'engineering', provider: 'factory-droid', model: 'claude-haiku-5-5', workHours: { days: [5, 1], start: '09:00', end: '18:00' } });
  expect((await read()).work_hours).toEqual({ days: [1, 5], start: '09:00', end: '18:00' });
  await ensure({ id: 'gw-def-a', role: 'engineering', provider: 'factory-droid', model: 'claude-haiku-5-5' });
  expect((await read()).work_hours).toEqual({ days: [1, 5], start: '09:00', end: '18:00' });
  await expect(ensure({ id: 'gw-def-a', role: 'engineering', provider: 'factory-droid', model: 'claude-haiku-5-5', workHours: { days: [], start: '09:00', end: '18:00' } }))
    .rejects.toThrow('workHours invalid');
  await ensure({ id: 'gw-def-a', role: 'engineering', provider: 'factory-droid', model: 'claude-haiku-5-5', workHours: null });
  expect((await read()).work_hours).toBeUndefined();
  await runOwnerCommandOn({}, owner, 'owner-1', 'def.enable', { id: 'gw-def-a' });
  expect(await read()).toMatchObject({ enabled: true });
  expect((await read()).disabled_reason).toBeUndefined();
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

run('老板令牌连库：$access 为 owner（老板端用老板自己的令牌执行，不换成网关令牌）', async () => {
  const owner = await session(tokenFor('owner', 'owner-1', { rl: ['Owner'] }));
  const [access] = await owner.query<[string]>('RETURN $access;');
  expect(access).toBe('owner');
});
