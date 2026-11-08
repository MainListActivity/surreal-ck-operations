import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RecordId, Surreal } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { audit, decide, digestOf } from '../src/command-guard.ts';

setDefaultTimeout(60000);
// 隔离的公司 fork（内存库，自己起停）。令牌用 HS512 共享密钥代替 JWKS：签名与校验走同一条 JWT 访问路径，
// 测试只把 055 里的 JWKS 地址换成共享密钥，其余语句与生产一致。
const run = process.env.RUN_SCK_COMPANY_ACCESS_TESTS === '1' ? test : test.skip;
const PASSWORD = 'company-access-fixture-only';
const SECRET = 'company-access-fixture-secret-0123456789-abcdef';
const ISS = 'https://ma.example.test';
const NS = 'company_access';
const DATABASE = 'control_plane';
const TASK_GUARD = '需求与验收标准只能由老板修改';
const MESSAGE_GUARD = '消息正文与放行保留只能由老板修改';
const CREATE_GUARD = '非提议任务不能由员工直接写入需求或验收标准';
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

async function seedTask(id: string): Promise<void> {
  await company.db.query(`CREATE task:${id} CONTENT { title: '种子任务', context: '老板原话', requirement: '需求原文',
    acceptance_text: '验收原文', state: 'ready', kind: 'task', version: 1, fence: 0, created_at: time::now() };`);
}

async function seedMessage(id: string, taskId: string): Promise<void> {
  await company.db.query(`CREATE outbound_message:${id} CONTENT { task: task:${taskId}, step: 'execute', role: 'engineering',
    body: '正文原文', state: 'draft', hold: false, created_at: time::now() };`);
}

beforeAll(async () => {
  if (process.env.RUN_SCK_COMPANY_ACCESS_TESTS !== '1') return;
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
  await company.bootstrap();
  // 测试替身：与生产同一份 055，只把 JWKS 地址换成共享密钥（生产里由 bootstrap 用 COMPANY_JWKS_URL 渲染）。
  const access = readFileSync(join(import.meta.dir, '..', 'schema', '055-access.surql'), 'utf8')
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

run('055 令牌：ac 与签发方校验通过；无 ac、签发方不符、签名错、带 id 声明都被拒', async () => {
  const runner = await session(tokenFor('runner', 'runner-1'));
  const [access] = await runner.query<[string]>('RETURN $access;');
  expect(access).toBe('runner');
  const now = nowSec();
  const base = { iss: ISS, ns: NS, db: DATABASE, rl: ['Editor'], sub: 'x', iat: now, nbf: now, exp: now + 600 };
  await expect(session(sign(base))).rejects.toThrow();
  await expect(session(tokenFor('runner', 'x', { iss: 'https://evil.test' }))).rejects.toThrow();
  await expect(session(sign({ ...base, ac: 'runner' }, 'another-secret-another-secret-0000000000'))).rejects.toThrow();
  await expect(session(tokenFor('runner', 'x', { id: 'runner:1' }))).rejects.toThrow();
});

run('055 运行器：普通数据可读写；需求、验收、正文与保留的改动被拒，行保持不变', async () => {
  await seedTask('fx_runner');
  await seedMessage('fx_runner', 'fx_runner');
  const runner = await session(tokenFor('runner', 'runner-1'));
  await runner.query("UPDATE task:fx_runner SET state = 'doing';");
  const [[seen]] = await runner.query<[Array<{ state: string }>]>('SELECT state FROM task:fx_runner;');
  expect(seen).toMatchObject({ state: 'doing' });
  await rejects(runner.query("UPDATE task:fx_runner SET requirement = '篡改';"), TASK_GUARD);
  await rejects(runner.query("UPDATE task:fx_runner SET acceptance_text = '篡改';"), TASK_GUARD);
  await rejects(runner.query("UPDATE task:fx_runner SET acceptance_criteria = [{ id: 'x', kind: 'machine', required: true }];"), TASK_GUARD);
  await rejects(runner.query("UPDATE task:fx_runner SET context = '篡改';"), TASK_GUARD);
  await rejects(runner.query("UPDATE outbound_message:fx_runner SET body = '篡改';"), MESSAGE_GUARD);
  await rejects(runner.query('UPDATE outbound_message:fx_runner SET hold = true;'), MESSAGE_GUARD);
  // 原样回写同一个值，以及发送时把原本未保留的 hold 写回 false，都放行。
  await runner.query("UPDATE task:fx_runner SET requirement = '需求原文';");
  await runner.query("UPDATE outbound_message:fx_runner SET state = 'sent', sent_at = time::now(), hold = false;");
  const [[task]] = await company.db.query<[Array<Record<string, unknown>>]>(
    'SELECT state, requirement, acceptance_text, context FROM task:fx_runner;');
  expect(task).toMatchObject({ state: 'doing', requirement: '需求原文', acceptance_text: '验收原文', context: '老板原话' });
  const [[message]] = await company.db.query<[Array<Record<string, unknown>>]>('SELECT state, body, hold FROM outbound_message:fx_runner;');
  expect(message).toMatchObject({ state: 'sent', body: '正文原文', hold: false });
});

run('055 自动化：普通数据可读写；需求、验收、正文与保留的改动被拒，行保持不变', async () => {
  await seedTask('fx_auto_edit');
  await seedMessage('fx_auto_edit', 'fx_auto_edit');
  const automation = await session(tokenFor('automation', 'automation-1'));
  await automation.query("UPDATE task:fx_auto_edit SET state = 'doing';");
  const [[seen]] = await automation.query<[Array<{ state: string }>]>('SELECT state FROM task:fx_auto_edit;');
  expect(seen).toMatchObject({ state: 'doing' });
  await rejects(automation.query("UPDATE task:fx_auto_edit SET requirement = '篡改';"), TASK_GUARD);
  await rejects(automation.query("UPDATE task:fx_auto_edit SET acceptance_text = '篡改';"), TASK_GUARD);
  await rejects(automation.query("UPDATE task:fx_auto_edit SET acceptance_criteria = [{ id: 'x', kind: 'machine', required: true }];"), TASK_GUARD);
  await rejects(automation.query("UPDATE task:fx_auto_edit SET context = '篡改';"), TASK_GUARD);
  await rejects(automation.query("UPDATE outbound_message:fx_auto_edit SET body = '篡改';"), MESSAGE_GUARD);
  await rejects(automation.query('UPDATE outbound_message:fx_auto_edit SET hold = true;'), MESSAGE_GUARD);
  const [[task]] = await company.db.query<[Array<Record<string, unknown>>]>(
    'SELECT state, requirement, acceptance_text, context FROM task:fx_auto_edit;');
  expect(task).toMatchObject({ state: 'doing', requirement: '需求原文', acceptance_text: '验收原文', context: '老板原话' });
  const [[message]] = await company.db.query<[Array<Record<string, unknown>>]>('SELECT body, hold FROM outbound_message:fx_auto_edit;');
  expect(message).toMatchObject({ body: '正文原文', hold: false });
});

run('055 老板：可以改需求、验收与消息正文、保留；建带需求的任务不受限制', async () => {
  await seedTask('fx_owner');
  await seedMessage('fx_owner', 'fx_owner');
  const owner = await session(tokenFor('owner', 'owner-1'));
  await owner.query("UPDATE task:fx_owner SET requirement = '老板改的需求', acceptance_text = '老板改的验收';");
  await owner.query("UPDATE outbound_message:fx_owner SET body = '老板改的正文', hold = true;");
  const [[seenByOwner]] = await owner.query<[Array<{ requirement: string }>]>('SELECT requirement FROM task:fx_owner;');
  expect(seenByOwner).toMatchObject({ requirement: '老板改的需求' });
  await owner.query("CREATE task:fx_owner_new CONTENT { title: '老板建单', context: '老板原话', requirement: '需求', state: 'ready', kind: 'task' };");
  const [[task]] = await company.db.query<[Array<Record<string, unknown>>]>('SELECT requirement, acceptance_text FROM task:fx_owner;');
  expect(task).toMatchObject({ requirement: '老板改的需求', acceptance_text: '老板改的验收' });
  const [[message]] = await company.db.query<[Array<Record<string, unknown>>]>('SELECT body, hold FROM outbound_message:fx_owner;');
  expect(message).toMatchObject({ body: '老板改的正文', hold: true });
});

run('055 员工建单：直接建带需求的非提议任务被拒；提议建单与员工草稿放行', async () => {
  const runner = await session(tokenFor('runner', 'runner-1'));
  const automation = await session(tokenFor('automation', 'automation-1'));
  await rejects(runner.query("CREATE task:fx_direct CONTENT { title: '直建', context: '需求', requirement: '需求', state: 'ready', kind: 'task' };"), CREATE_GUARD);
  await rejects(automation.query("CREATE task:fx_auto CONTENT { title: '自动化直建', context: '需求', state: 'ready', kind: 'task' };"), CREATE_GUARD);
  await runner.query("CREATE task:fx_proposal CONTENT { title: '提议', context: '需求', requirement: '需求', proposed_in: 'audit:fx', state: 'planned', kind: 'task' };");
  await runner.query("CREATE outbound_message:fx_draft CONTENT { task: task:fx_proposal, step: 'execute', role: 'engineering', body: '路线正文', state: 'draft', hold: false, created_at: time::now() };");
  const [[draft]] = await company.db.query<[Array<Record<string, unknown>>]>('SELECT body FROM outbound_message:fx_draft;');
  expect(draft).toMatchObject({ body: '路线正文' });
});

run('056 保护清单与员工策略：只有老板与 root 能写，运行器与自动化写入被拒', async () => {
  const owner = await session(tokenFor('owner', 'owner-1'));
  const runner = await session(tokenFor('runner', 'runner-1'));
  const automation = await session(tokenFor('automation', 'automation-1'));
  await owner.query("CREATE protected_command CONTENT { command: 'task.void', owner_only: true, updated_by: 'owner-1', updated_at: time::now() };");
  await owner.query("CREATE agent_policy CONTENT { agent: 'emp-a', disabled: false, deny: ['task.pause'], updated_by: 'owner-1', updated_at: time::now() };");
  await owner.query("UPDATE protected_command SET owner_only = true WHERE command = 'task.void';");
  await rejects(runner.query("CREATE protected_command CONTENT { command: 'task.retire', owner_only: true, updated_by: 'runner-1', updated_at: time::now() };"), PROTECTED_GUARD);
  await rejects(runner.query("UPDATE protected_command SET owner_only = false WHERE command = 'task.void';"), PROTECTED_GUARD);
  await rejects(automation.query("DELETE protected_command WHERE command = 'task.void';"), PROTECTED_GUARD);
  await rejects(runner.query("CREATE agent_policy CONTENT { agent: 'emp-b', disabled: true, deny: [], updated_by: 'runner-1', updated_at: time::now() };"), POLICY_GUARD);
  await rejects(automation.query("UPDATE agent_policy SET disabled = true WHERE agent = 'emp-a';"), POLICY_GUARD);
  const [[policy]] = await company.db.query<[Array<Record<string, unknown>>]>("SELECT disabled, deny FROM agent_policy WHERE agent = 'emp-a';");
  expect(policy).toMatchObject({ disabled: false, deny: ['task.pause'] });
  // root（启动与运维）不受守卫限制。
  await company.db.query("UPDATE agent_policy SET disabled = false WHERE agent = 'emp-a';");
});

run('056 审计账本只能新增：任何身份修改或删除都被拒', async () => {
  const owner = await session(tokenFor('owner', 'owner-1'));
  const runner = await session(tokenFor('runner', 'runner-1'));
  await runner.query("CREATE ops_audit CONTENT { actor_kind: 'runner', actor: 'runner-1', command: 'task.note', args_digest: 'digest-a', outcome: 'ok' };");
  const [[row]] = await company.db.query<[Array<{ id: RecordId }>]>("SELECT id FROM ops_audit WHERE actor = 'runner-1' LIMIT 1;");
  for (const who of [company.db, owner, runner]) {
    await rejects(who.query("UPDATE $row SET reason = '篡改';", { row: row.id }), AUDIT_GUARD);
    await rejects(who.query('DELETE $row;', { row: row.id }), AUDIT_GUARD);
  }
  const [[kept]] = await company.db.query<[Array<{ reason?: string }>]>('SELECT reason FROM $row;', { row: row.id });
  expect(kept.reason).toBeUndefined();
});

run('bootstrap 本机模式：不应用 055（没有访问方式），056 的表照常存在，schema_version 推到 56', async () => {
  const local = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: PASSWORD, namespace: 'company_access_local', database: DATABASE });
  await local.connect();
  try {
    await local.bootstrap();
    const [info] = await local.db.query<[{ accesses?: Record<string, string>; tables: Record<string, string> }]>('INFO FOR DB;');
    expect(Object.keys(info.accesses ?? {})).toEqual([]);
    expect(Object.keys(info.tables)).toEqual(expect.arrayContaining(['protected_command', 'agent_policy', 'ops_audit']));
    const marker = await local.db.select<{ schema_version: number }>(new RecordId('company_meta', 'installation'));
    expect(marker?.schema_version).toBeGreaterThanOrEqual(56);
  } finally {
    await local.close();
  }
});

run('bootstrap 公司模式应用 055：三种访问方式按 JWKS 地址定义；JWKS 不可达不影响 bootstrap，重放后生效', async () => {
  const jwks = 'http://127.0.0.1:9/.well-known/jwks.json';
  const first = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: PASSWORD, namespace: 'company_access_jwks', database: DATABASE,
    companyJwksUrl: jwks, companyIssuer: ISS });
  await first.connect();
  try {
    await first.bootstrap();
    const [info] = await first.db.query<[{ accesses: Record<string, string> }]>('INFO FOR DB;');
    for (const name of ['owner', 'runner', 'automation']) expect(info.accesses[name]).toContain(`URL '${jwks}'`);
    expect(info.accesses.owner).toContain(`$token.iss != '${ISS}'`);
  } finally {
    await first.close();
  }
  const rotated = 'https://ma-next.example.test';
  const second = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: PASSWORD, namespace: 'company_access_jwks', database: DATABASE,
    companyJwksUrl: jwks, companyIssuer: rotated });
  await second.connect();
  try {
    await second.bootstrap();
    const [info] = await second.db.query<[{ accesses: Record<string, string> }]>('INFO FOR DB;');
    expect(info.accesses.runner).toContain(`$token.iss != '${rotated}'`);
  } finally {
    await second.close();
  }
});

run('命令守卫（库内事实）：老板直接放行；员工凭有效租约放行，租约过期或缺失即拒', async () => {
  const now = nowSec();
  await company.db.query(`CREATE task:fx_lease CONTENT { title: '租约', state: 'doing', kind: 'task', current_employee: 'emp-g', lease_expires_at: $live, fence: 1, version: 1 };`, { live: now + 600 });
  await company.db.query(`CREATE task:fx_expired CONTENT { title: '过期', state: 'doing', kind: 'task', current_employee: 'emp-g', lease_expires_at: $past, fence: 1, version: 1 };`, { past: now - 1 });
  await company.db.query("CREATE task:fx_free CONTENT { title: '空闲', state: 'ready', kind: 'task', fence: 0, version: 1 };");
  const base = { actor: 'emp-g', command: 'submit', now };
  expect(await decide(company.db, { ...base, actorKind: 'agent', task: 'fx_lease' })).toMatchObject({ allow: true });
  expect(await decide(company.db, { ...base, actorKind: 'agent', task: 'fx_expired' })).toMatchObject({ allow: false, reason: '没有该任务的有效租约' });
  expect(await decide(company.db, { ...base, actorKind: 'agent', task: 'fx_free' })).toMatchObject({ allow: false });
  expect(await decide(company.db, { ...base, actorKind: 'agent', task: 'fx_missing' })).toMatchObject({ allow: false });
  expect(await decide(company.db, { actorKind: 'owner', actor: 'owner:web', command: 'task.void', now })).toMatchObject({ allow: true });
});

run('命令守卫（库内事实）：员工策略的停用、允许与拒绝清单，保护清单与硬性老板命令逐条生效；运行器只受老板命令约束', async () => {
  const now = nowSec();
  const seedLease = (task: string, employee: string) => company.db.query(
    `CREATE task:${task} CONTENT { title: '策略', state: 'doing', kind: 'task', current_employee: $employee, lease_expires_at: $live, fence: 1, version: 1 };`,
    { employee, live: now + 600 });
  await seedLease('fx_off', 'emp-off');
  await seedLease('fx_deny', 'emp-deny');
  await seedLease('fx_allow', 'emp-allow');
  await company.db.query("CREATE agent_policy CONTENT { agent: 'emp-off', disabled: true, deny: [], updated_by: 'owner-1', updated_at: time::now() };");
  await company.db.query("CREATE agent_policy CONTENT { agent: 'emp-deny', disabled: false, deny: ['checkpoint'], updated_by: 'owner-1', updated_at: time::now() };");
  await company.db.query("CREATE agent_policy CONTENT { agent: 'emp-allow', disabled: false, allow: ['submit'], deny: [], updated_by: 'owner-1', updated_at: time::now() };");
  await company.db.query("CREATE protected_command CONTENT { command: 'heartbeat', owner_only: true, updated_by: 'owner-1', updated_at: time::now() };");
  const ask = (actorKind: 'agent' | 'runner', actor: string, command: string, task?: string) =>
    decide(company.db, { actorKind, actor, command, task, now });
  expect(await ask('agent', 'emp-off', 'submit', 'fx_off')).toMatchObject({ allow: false, reason: '该员工已停用' });
  expect(await ask('agent', 'emp-deny', 'checkpoint', 'fx_deny')).toMatchObject({ allow: false, reason: '该员工不能调用此命令' });
  expect(await ask('agent', 'emp-deny', 'submit', 'fx_deny')).toMatchObject({ allow: true });
  expect(await ask('agent', 'emp-allow', 'checkpoint', 'fx_allow')).toMatchObject({ allow: false, reason: '命令不在该员工的允许清单内' });
  expect(await ask('agent', 'emp-allow', 'submit', 'fx_allow')).toMatchObject({ allow: true });
  expect(await ask('agent', 'emp-deny', 'heartbeat', 'fx_deny')).toMatchObject({ allow: false, reason: '老板保护的命令，只有老板可以调用' });
  expect(await ask('agent', 'emp-deny', 'agent.policy.set', 'fx_deny')).toMatchObject({ allow: false, reason: '老板专属命令，只有老板可以调用' });
  expect(await ask('runner', 'runner-1', 'task.void')).toMatchObject({ allow: false });
  expect(await ask('runner', 'runner-1', 'heartbeat')).toMatchObject({ allow: false });
  expect(await ask('runner', 'runner-1', 'submit')).toMatchObject({ allow: true });
});

run('审计（库内）：只写参数与结果的摘要，原文不入库；没有任务时照样记录', async () => {
  const args = { text: '客户资料原文 ABC-123', idempotencyKey: 'audit-key-1' };
  await audit(company.db, { actorKind: 'agent', actor: 'emp-audit', task: 'fx_lease', command: 'submit', args, outcome: 'ok', result: { ok: true } });
  await audit(company.db, { actorKind: 'runner', actor: 'runner-audit', command: 'task.void', args: { taskId: 'x' }, outcome: 'denied', reason: '运行器与自动化不能直接调用老板命令' });
  const [rows] = await company.db.query<[Array<Record<string, unknown>>]>(
    "SELECT * FROM ops_audit WHERE actor IN ['emp-audit', 'runner-audit'] ORDER BY actor;");
  expect(rows).toHaveLength(2);
  const [agentRow, runnerRow] = rows;
  expect(agentRow).toMatchObject({ actor_kind: 'agent', actor: 'emp-audit', command: 'submit', outcome: 'ok', args_digest: await digestOf(args), result_digest: await digestOf({ ok: true }) });
  expect(String(agentRow.task)).toBe('task:fx_lease');
  expect(runnerRow).toMatchObject({ actor_kind: 'runner', outcome: 'denied', reason: '运行器与自动化不能直接调用老板命令' });
  expect(runnerRow.task).toBeUndefined();
  expect(runnerRow.result_digest).toBeUndefined();
  const stored = JSON.stringify(rows);
  for (const secret of ['客户资料原文', 'ABC-123', 'audit-key-1']) expect(stored).not.toContain(secret);
});
