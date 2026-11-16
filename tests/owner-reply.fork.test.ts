import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RecordId, Surreal } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { CompanyError } from '../src/core-errors.ts';
import { OwnerDesk } from '../src/owner.ts';
import { ownerApi } from '../src/owner-api.ts';
import { ownerContextOf } from '../owner-end/src/commands.ts';

setDefaultTimeout(60000);
// 老板回复的真实链路：ownerApi（与本机 /api/owner 同一入口）-> OwnerDesk.decide -> 公司 fork 上的事务。
// 访问方式用生产 055（owner、runner、gateway 三种令牌，HS512 共享密钥代替 JWKS），不用 root 登录，权限与生产一致。
const run = process.env.RUN_SCK_OWNER_REPLY_TESTS === '1' ? test : test.skip;
const PASSWORD = 'owner-reply-fixture-only';
const SECRET = 'owner-reply-fixture-secret-0123456789-abcdef';
const ISS = 'https://ma.example.test';
const NS = 'owner_reply';
const DATABASE = 'control_plane';
const NOTE = '请复用原成果与 PR 继续送审，不要重做。';

let server: ReturnType<typeof Bun.spawn> | undefined;
let port = 0;
let company: CompanyDatabase;
const sessions: Surreal[] = [];

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(claims: Record<string, unknown>): string {
  const head = b64({ alg: 'HS512', typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${createHmac('sha512', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
function tokenFor(ac: string, sub: string, rl: string[]): string {
  const now = nowSec();
  return sign({ iss: ISS, ns: NS, db: DATABASE, ac, rl, sub, iat: now, nbf: now, exp: now + 600 });
}
async function session(token: string): Promise<Surreal> {
  const conn = new Surreal();
  await conn.connect(`ws://127.0.0.1:${port}/rpc`);
  await conn.use({ namespace: NS, database: DATABASE });
  await conn.authenticate(token);
  sessions.push(conn);
  return conn;
}

/** 与生产 blocked 任务同形：blocked_to=owner、无租约、无派工屏障，版本 3。每个用例用新任务，互不干扰。 */
async function seed(state: 'blocked' | 'ready'): Promise<string> {
  const uuid = crypto.randomUUID();
  await company.db.query(`CREATE $task CONTENT { title: '修正过期路线图', context: '老板原话', requirement: '需求原文',
    acceptance_text: '验收原文', state: $state, blocked_to: $blocked, resume_state: 'doing', resume_role: 'engineering',
    executor_role: 'engineering', reviewer_role: 'qa', kind: 'task', version: 3, fence: 1, created_at: time::now() };`,
  { task: new RecordId('task', uuid), state, blocked: state === 'blocked' ? 'owner' : null });
  return uuid;
}

async function failure(promise: Promise<unknown>): Promise<CompanyError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CompanyError);
  return error as CompanyError;
}

beforeAll(async () => {
  if (process.env.RUN_SCK_OWNER_REPLY_TESTS !== '1') return;
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

// 事务内读不到、事务外读得到：不能报成“任务不存在”。桩只替换数据库边界，OwnerDesk 与 run() 的判定是真的。
test('事务内读不到而事务外读得到时报冲突，不报任务不存在，且不写入', async () => {
  const row = { id: new RecordId('task', 'stub-task'), state: 'blocked', blocked_to: 'owner', version: 3 };
  const stub = {
    select: async (rid: RecordId) => String(rid).startsWith('task:') ? row : undefined,
    query: () => ({ responses: async () => [{ success: false, error: { message: 'An error occurred: task not visible in transaction' } }] }),
  };
  const desk = new OwnerDesk({ db: stub } as unknown as CompanyDatabase);
  const error = await failure(desk.decide({ taskId: 'stub-task', decision: 'reply', note: NOTE, source: 'owner:test', key: 'stub-visibility-0001' }));
  expect(error.code).toBe('conflict');
  expect(error.message).toContain('事务内读不到');
  expect(error.message).not.toContain('not found');
});

test('事务外也读不到的任务仍报任务不存在', async () => {
  const stub = { select: async () => undefined, query: () => { throw new Error('must not reach the transaction'); } };
  const desk = new OwnerDesk({ db: stub } as unknown as CompanyDatabase);
  const error = await failure(desk.decide({ taskId: 'missing-task', decision: 'reply', note: NOTE, source: 'owner:test', key: 'stub-missing-0001' }));
  expect(error.code).toBe('not_found');
  expect(error.message).toBe('task not found');
});

run('老板令牌：同一 UUID 的阻塞任务被 reply 恢复，owner_reply 审计原话，版本前进', async () => {
  const owner = await session(tokenFor('owner', 'reply-owner', ['Owner']));
  const ctx = ownerContextOf(owner);
  const taskId = await seed('blocked');
  const detail = await ownerApi(ctx, { command: 'task.detail', taskId }, 'owner-test') as { task: { state: string; blocked_to?: string } };
  expect(detail.task).toMatchObject({ state: 'blocked', blocked_to: 'owner' });
  const view = await ownerApi(ctx, { command: 'reply', taskId, note: NOTE }, 'owner-test') as { id: string; state: string; version: number };
  expect(view).toMatchObject({ state: 'doing', version: 4 });
  const [audit] = await owner.query<[Array<{ action: string; evidence: string }>]>(
    "SELECT action, evidence FROM audit WHERE task = $task AND action = 'owner_reply';", { task: new RecordId('task', taskId) });
  expect(audit).toHaveLength(1);
  expect(audit[0]!.evidence).toContain(NOTE);
});

run('运行器令牌（本机服务用的身份）：同一路径同样恢复阻塞任务', async () => {
  const runner = await session(tokenFor('runner', 'reply-runner', ['Editor']));
  const taskId = await seed('blocked');
  const view = await ownerApi(ownerContextOf(runner), { command: 'reply', taskId, note: NOTE }, 'runner-test') as { state: string };
  expect(view.state).toBe('doing');
});

run('网关令牌：同一路径同样恢复阻塞任务', async () => {
  const gateway = await session(tokenFor('gateway', 'reply-gateway', ['Editor']));
  const taskId = await seed('blocked');
  const view = await ownerApi(ownerContextOf(gateway), { command: 'reply', taskId, note: NOTE }, 'gateway-test') as { state: string };
  expect(view.state).toBe('doing');
});

run('拒绝：不存在的 UUID 报任务不存在；非阻塞任务报不在等待老板答复', async () => {
  const owner = await session(tokenFor('owner', 'reject-owner', ['Owner']));
  const ctx = ownerContextOf(owner);
  const missing = await failure(ownerApi(ctx, { command: 'reply', taskId: crypto.randomUUID(), note: NOTE }, 'owner-test'));
  expect(missing.code).toBe('not_found');
  expect(missing.message).toBe('task not found');
  const ready = await seed('ready');
  const notWaiting = await failure(ownerApi(ctx, { command: 'reply', taskId: ready, note: NOTE }, 'owner-test'));
  expect(notWaiting.code).toBe('conflict');
  expect(notWaiting.message).toContain('not waiting for an owner answer');
});

run('拒绝：版本不符报版本已变，且不写入', async () => {
  const owner = await session(tokenFor('owner', 'version-owner', ['Owner']));
  const desk = new OwnerDesk({ db: owner } as unknown as CompanyDatabase);
  const taskId = await seed('blocked');
  const error = await failure(desk.decide({ taskId, decision: 'reply', note: NOTE, source: 'owner:test', key: 'version-moved-0001', expectedVersion: 2 }));
  expect(error.code).toBe('conflict');
  expect(error.message).toContain('task version moved');
  const [rows] = await owner.query<[Array<{ state: string; version: number }>]>('SELECT state, version FROM $task;', { task: new RecordId('task', taskId) });
  expect(rows[0]).toMatchObject({ state: 'blocked', version: 3 });
});

run('幂等键：同一键同一输入返回原结果，同一键换了输入报冲突', async () => {
  const owner = await session(tokenFor('owner', 'idem-owner', ['Owner']));
  const ctx = ownerContextOf(owner);
  const taskId = await seed('blocked');
  const key = 'owner-reply-idem-0001';
  const first = await ownerApi(ctx, { command: 'reply', taskId, note: NOTE, idempotencyKey: key }, 'owner-test') as { version: number };
  const replay = await ownerApi(ctx, { command: 'reply', taskId, note: NOTE, idempotencyKey: key }, 'owner-test') as { version: number };
  expect(replay.version).toBe(first.version);
  const [rows] = await owner.query<[Array<{ version: number }>]>('SELECT version FROM $task;', { task: new RecordId('task', taskId) });
  expect(rows[0]!.version).toBe(first.version);
  const changed = await failure(ownerApi(ctx, { command: 'reply', taskId, note: '另一条答复', idempotencyKey: key }, 'owner-test'));
  expect(changed.code).toBe('conflict');
  expect(changed.message).toContain('Idempotency key reused');
});
