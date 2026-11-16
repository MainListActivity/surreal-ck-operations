import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RecordId, Surreal } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { CompanyError } from '../src/core-errors.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';
import { ownerApi, type OwnerApiContext } from '../src/owner-api.ts';
import { OwnerDesk } from '../src/owner.ts';

setDefaultTimeout(60000);
// 老板回复受阻任务：真实的 reply 命令 -> OwnerDesk.decide -> 公司 fork 上的事务（RUN_SCK_OWNER_REPLY_TESTS）。
// 身份有两类：根库会话（生产 CompanyDatabase 所用，可重建），以及 055 访问令牌（老板、运行器、网关、只读，HS512 共享密钥代替 JWKS）。
// fork 以 --allow-guests 启动：会话失去身份后，表权限把读取变成空结果而不是报错，正是“任务不存在”的形态。
// 生产是否开启访客未直接核实；生产日志里 IAM 错误与 Employee not found 同时出现，与这一现象一致。
const run = process.env.RUN_SCK_OWNER_REPLY_TESTS === '1' ? test : test.skip;
const TASK = '10231237-2bc2-438d-ba1e-227528bf555a';
const NOTE = '请复用原成果与 PR 继续送审，不要重做。';
const PASSWORD = 'owner-reply-fixture-only';
const SECRET = 'owner-reply-fixture-secret-0123456789-abcdef';
const ISS = 'https://ma.example.test';
const NS = 'owner_reply';
const DATABASE = 'control_plane';

let server: ReturnType<typeof Bun.spawn> | undefined;
let port = 0;
let company: CompanyDatabase;
let ctx: OwnerApiContext;
const sessions: Surreal[] = [];
let count = 0;
const key = () => `reply-${++count}-${crypto.randomUUID()}`;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(claims: Record<string, unknown>): string {
  const head = b64({ alg: 'HS512', typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${createHmac('sha512', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
/** A 055 access token. Its `rl` role makes the session a system user, which table permissions do not limit (055 convention). */
function tokenFor(ac: string, sub: string, rl: string[]): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({ iss: ISS, ns: NS, db: DATABASE, ac, sub, iat: now, nbf: now, exp: now + 600, rl });
}
async function session(token: string): Promise<Surreal> {
  const conn = new Surreal();
  await conn.connect(`ws://127.0.0.1:${port}/rpc`);
  await conn.use({ namespace: NS, database: DATABASE });
  await conn.authenticate(token);
  sessions.push(conn);
  return conn;
}
/** The part of owner-end's ownerContextOf that reply and task.detail use. Built here, so the test does not load owner-end's auth module and its dependencies. */
function sessionContext(conn: Surreal): OwnerApiContext {
  const database = { db: conn } as unknown as CompanyDatabase;
  return { db: database, owner: new OwnerDesk(database), opsRepo: '' } as unknown as OwnerApiContext;
}

/** A task as the dispatcher leaves it after the employee asked the owner a question: version 3, no lease. */
async function seed(state: 'blocked' | 'ready', blockedTo = 'owner', id = crypto.randomUUID()): Promise<string> {
  await company.db.query(`CREATE $task CONTENT { title: '修正过期路线图', context: '老板原话', requirement: '需求原文',
    acceptance_text: '验收原文', state: $state, blocked_to: $blocked, resume_state: 'doing', resume_role: 'engineering',
    executor_role: 'engineering', reviewer_role: 'qa', acceptance_version: 1, kind: 'task', version: 3, fence: 1, created_at: time::now() };`,
  { task: new RecordId('task', id), state, blocked: state === 'blocked' ? blockedTo : null });
  return id;
}
async function stored(id: string): Promise<{ state: string; version: number; blocked_to?: string | null }> {
  const [[task]] = await company.db.query<[Array<{ state: string; version: number; blocked_to?: string | null }>]>(
    'SELECT state, version, blocked_to FROM $t;', { t: new RecordId('task', id) });
  return task!;
}
/** Clears a task and its audit rows, then seeds it again under the same id (for the production UUID, which the first test creates). */
async function reseed(id: ReturnType<typeof crypto.randomUUID>): Promise<void> {
  await company.db.query('DELETE audit WHERE task = $task; DELETE $task;', { task: new RecordId('task', id) });
  await seed('blocked', 'owner', id);
}
async function ownerReplies(id: string): Promise<Array<{ action: string; evidence: string }>> {
  const [rows] = await company.db.query<[Array<{ action: string; evidence: string }>]>(
    "SELECT action, evidence FROM audit WHERE task = $t AND action = 'owner_reply';", { t: new RecordId('task', id) });
  return rows;
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
    '--log', 'error', '--allow-guests', 'memory'], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(25);
  }
  company = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: PASSWORD, namespace: NS, database: DATABASE });
  await company.connect();
  await company.bootstrap();
  // bootstrap skips 055 without COMPANY_JWKS_URL, so the access methods are applied here with the fixture key.
  const access = readFileSync(join(import.meta.dir, '..', 'schema', '055-access.surql'), 'utf8')
    .replaceAll("URL '{{COMPANY_JWKS_URL}}'", `ALGORITHM HS512 KEY '${SECRET}'`)
    .replaceAll('{{COMPANY_ISSUER}}', ISS);
  await company.db.query(access);
  ctx = { db: company, owner: new OwnerDesk(company), opsRepo: '' } as unknown as OwnerApiContext;
});

afterAll(async () => {
  for (const conn of sessions) await conn.close();
  if (company) await company.close();
  server?.kill();
  await server?.exited;
});

run('根库会话：受阻任务被 reply 恢复，原话入审计，同一幂等键重放返回原结果', async () => {
  const id = await seed('blocked', 'owner', TASK);
  const k = key();
  const first = await ownerApi(ctx, { command: 'reply', taskId: id, note: NOTE, idempotencyKey: k }, 'owner-cli') as { state: string; version: number };
  expect(first).toMatchObject({ state: 'doing', version: 4 });
  const replay = await ownerApi(ctx, { command: 'reply', taskId: id, note: NOTE, idempotencyKey: k }, 'owner-cli') as { version: number };
  expect(replay.version).toBe(first.version);
  expect((await failure(ownerApi(ctx, { command: 'reply', taskId: id, note: '另一句话', idempotencyKey: k }, 'owner-cli'))).code).toBe('conflict');
  const replies = await ownerReplies(id);
  expect(replies).toHaveLength(1);
  expect(replies[0]!.evidence).toContain(NOTE);
  expect(await stored(id)).toMatchObject({ state: 'doing', version: 4 });
  // The owner's words are the answer the next execution message carries. The employee reads them from this audit row.
  expect((await new OutboundMessageStore(company.db).promptTask(id)).answer?.reply).toBe(NOTE);
});

run('根库会话：不存在的 UUID 报任务不存在；非阻塞或阻塞给员工的任务报冲突，且不写入', async () => {
  await expect(ownerApi(ctx, { command: 'reply', taskId: crypto.randomUUID(), note: NOTE }, 'owner-cli'))
    .rejects.toMatchObject({ code: 'not_found', message: 'task not found' });
  await expect(ownerApi(ctx, { command: 'task.detail', taskId: crypto.randomUUID() }, 'owner-cli'))
    .rejects.toMatchObject({ code: 'not_found', message: 'task not found' });
  const ready = await seed('ready');
  await expect(ownerApi(ctx, { command: 'reply', taskId: ready, note: NOTE }, 'owner-cli')).rejects.toMatchObject({ code: 'conflict' });
  const employee = await seed('blocked', 'employee');
  await expect(ownerApi(ctx, { command: 'reply', taskId: employee, note: NOTE }, 'owner-cli')).rejects.toMatchObject({ code: 'conflict' });
  expect(await stored(employee)).toMatchObject({ state: 'blocked', version: 3 });
});

run('根库会话失去身份：reply 重建连接后落地，不报任务不存在', async () => {
  const id = await seed('blocked');
  // A guest session reads through the table permissions and gets nothing back, the same shape as the production symptom.
  await company.db.invalidate();
  const note = '会话恢复后的回复原话';
  await expect(ownerApi(ctx, { command: 'reply', taskId: id, note }, 'owner-cli')).resolves.toMatchObject({ state: 'doing', version: 4 });
  expect(await stored(id)).toMatchObject({ state: 'doing', version: 4 });
  expect((await ownerReplies(id))[0]!.evidence).toContain(note);
});

run('根库会话失去身份且无法重建：reply 报暂时不可用，不报任务不存在，且不写入', async () => {
  const id = await seed('blocked');
  const rebuild = company.ensureConnected.bind(company);
  company.ensureConnected = async () => undefined; // a rebuild that does not restore the identity
  let error: unknown;
  try {
    await company.db.invalidate();
    error = await ownerApi(ctx, { command: 'reply', taskId: id, note: '不应写入的回复' }, 'owner-cli').then(() => undefined, (caught: unknown) => caught);
  } finally {
    company.ensureConnected = rebuild;
    await rebuild();
  }
  expect(error).toBeInstanceOf(CompanyError);
  expect(error).toMatchObject({ code: 'temporarily_unavailable', retryable: true });
  expect((error as CompanyError).message).not.toContain('not found');
  expect(await stored(id)).toMatchObject({ state: 'blocked', version: 3 });
  expect(await ownerReplies(id)).toHaveLength(0);
});

run('根库会话失去身份：task.detail 重建连接后读到原任务，不报任务不存在', async () => {
  const id = await seed('blocked');
  await company.db.invalidate();
  const detail = await ownerApi(ctx, { command: 'task.detail', taskId: id }, 'owner-cli') as { task: { state: string; version: number } };
  expect(detail.task).toMatchObject({ state: 'blocked', version: 3 });
});

run('根库会话失去身份且无法重建：task.detail 报暂时不可用，连真不存在的任务也不报不存在', async () => {
  const id = await seed('blocked');
  const rebuild = company.ensureConnected.bind(company);
  company.ensureConnected = async () => undefined; // a rebuild that does not restore the identity
  let detailError: CompanyError | undefined;
  let absentError: CompanyError | undefined;
  try {
    await company.db.invalidate();
    detailError = await failure(ownerApi(ctx, { command: 'task.detail', taskId: id }, 'owner-cli'));
    absentError = await failure(ownerApi(ctx, { command: 'task.detail', taskId: crypto.randomUUID() }, 'owner-cli'));
  } finally {
    company.ensureConnected = rebuild;
    await rebuild();
  }
  expect(detailError).toMatchObject({ code: 'temporarily_unavailable', retryable: true });
  expect(detailError!.message).not.toContain('not found');
  expect(absentError).toMatchObject({ code: 'temporarily_unavailable', retryable: true });
  expect(absentError!.message).not.toContain('not found');
});

run('原 UUID 的受阻任务：根库会话失去身份后，任务详情与回复重建后恢复，回复只落地一次', async () => {
  await reseed(TASK);
  await company.db.invalidate();
  const detail = await ownerApi(ctx, { command: 'task.detail', taskId: TASK }, 'owner-cli') as { task: { state: string; version: number } };
  expect(detail.task).toMatchObject({ state: 'blocked', version: 3 });
  const k = key();
  const landed = await ownerApi(ctx, { command: 'reply', taskId: TASK, note: NOTE, idempotencyKey: k }, 'owner-cli');
  expect(landed).toMatchObject({ state: 'doing', version: 4 });
  const replay = await ownerApi(ctx, { command: 'reply', taskId: TASK, note: NOTE, idempotencyKey: k }, 'owner-cli');
  expect(replay).toMatchObject({ state: 'doing', version: 4 });
  expect(await stored(TASK)).toMatchObject({ state: 'doing', version: 4 });
  expect(await ownerReplies(TASK)).toHaveLength(1);
});

run('原 UUID 的受阻任务：根库会话失去身份且无法重建时，任务详情与回复都报暂时不可用，且不写入', async () => {
  await reseed(TASK);
  const rebuild = company.ensureConnected.bind(company);
  company.ensureConnected = async () => undefined; // a rebuild that does not restore the identity
  let detailError: CompanyError | undefined;
  let replyError: CompanyError | undefined;
  try {
    await company.db.invalidate();
    detailError = await failure(ownerApi(ctx, { command: 'task.detail', taskId: TASK }, 'owner-cli'));
    replyError = await failure(ownerApi(ctx, { command: 'reply', taskId: TASK, note: '不应写入的回复' }, 'owner-cli'));
  } finally {
    company.ensureConnected = rebuild;
    await rebuild();
  }
  expect(detailError).toMatchObject({ code: 'temporarily_unavailable', retryable: true });
  expect(replyError).toMatchObject({ code: 'temporarily_unavailable', retryable: true });
  expect(detailError!.message).not.toContain('not found');
  expect(replyError!.message).not.toContain('not found');
  expect(await stored(TASK)).toMatchObject({ state: 'blocked', version: 3 });
  expect(await ownerReplies(TASK)).toHaveLength(0);
});

run('老板令牌：同一 UUID 的阻塞任务，task.detail 可见，reply 恢复，原话入审计', async () => {
  const owner = sessionContext(await session(tokenFor('owner', 'reply-owner', ['Owner'])));
  const taskId = await seed('blocked');
  const detail = await ownerApi(owner, { command: 'task.detail', taskId }, 'owner-test') as { task: { state: string; blocked_to?: string } };
  expect(detail.task).toMatchObject({ state: 'blocked', blocked_to: 'owner' });
  const view = await ownerApi(owner, { command: 'reply', taskId, note: NOTE }, 'owner-test') as { state: string; version: number };
  expect(view).toMatchObject({ state: 'doing', version: 4 });
  const replies = await ownerReplies(taskId);
  expect(replies).toHaveLength(1);
  expect(replies[0]!.evidence).toContain(NOTE);
  expect((await new OutboundMessageStore(company.db).promptTask(taskId)).answer?.reply).toBe(NOTE);
});

run('运行器令牌（本机服务用的身份）：同一路径同样恢复阻塞任务', async () => {
  const runner = sessionContext(await session(tokenFor('runner', 'reply-runner', ['Editor'])));
  const taskId = await seed('blocked');
  await expect(ownerApi(runner, { command: 'reply', taskId, note: NOTE }, 'runner-test')).resolves.toMatchObject({ state: 'doing' });
});

run('网关令牌（代老板执行命令）：同一路径同样恢复阻塞任务', async () => {
  const gateway = sessionContext(await session(tokenFor('gateway', 'reply-gateway', ['Editor'])));
  const taskId = await seed('blocked');
  await expect(ownerApi(gateway, { command: 'reply', taskId, note: NOTE }, 'gateway-test')).resolves.toMatchObject({ state: 'doing' });
});

run('老板令牌：不存在的 UUID 报任务不存在；非阻塞任务报不在等待老板答复', async () => {
  const owner = sessionContext(await session(tokenFor('owner', 'reject-owner', ['Owner'])));
  const missing = await failure(ownerApi(owner, { command: 'reply', taskId: crypto.randomUUID(), note: NOTE }, 'owner-test'));
  expect(missing).toMatchObject({ code: 'not_found', message: 'task not found' });
  const missingDetail = await failure(ownerApi(owner, { command: 'task.detail', taskId: crypto.randomUUID() }, 'owner-test'));
  expect(missingDetail).toMatchObject({ code: 'not_found', message: 'task not found' });
  const ready = await seed('ready');
  const notWaiting = await failure(ownerApi(owner, { command: 'reply', taskId: ready, note: NOTE }, 'owner-test'));
  expect(notWaiting.code).toBe('conflict');
  expect(notWaiting.message).toContain('not waiting for an owner answer');
});

run('老板令牌：版本不符报版本已变，且不写入', async () => {
  const context = sessionContext(await session(tokenFor('owner', 'version-owner', ['Owner'])));
  const taskId = await seed('blocked');
  const error = await failure(context.owner.decide({ taskId, decision: 'reply', note: NOTE, source: 'owner:test', key: key(), expectedVersion: 2 }));
  expect(error.code).toBe('conflict');
  expect(error.message).toContain('task version moved');
  expect(await stored(taskId)).toMatchObject({ state: 'blocked', version: 3 });
});

run('老板令牌：同一幂等键同一输入返回原结果，换了输入报冲突', async () => {
  const owner = sessionContext(await session(tokenFor('owner', 'idem-owner', ['Owner'])));
  const taskId = await seed('blocked');
  const k = key();
  const first = await ownerApi(owner, { command: 'reply', taskId, note: NOTE, idempotencyKey: k }, 'owner-test') as { version: number };
  const replay = await ownerApi(owner, { command: 'reply', taskId, note: NOTE, idempotencyKey: k }, 'owner-test') as { version: number };
  expect(replay.version).toBe(first.version);
  expect(await stored(taskId)).toMatchObject({ version: first.version });
  const changed = await failure(ownerApi(owner, { command: 'reply', taskId, note: '另一条答复', idempotencyKey: k }, 'owner-test'));
  expect(changed.code).toBe('conflict');
  expect(changed.message).toContain('Idempotency key reused');
});

run('只读令牌（Viewer）：能读到任务但不能写，回复报无写权限，不报任务不存在，且不写入', async () => {
  // The fork refuses a read-only role's writes silently: the task reads back, but the update and the audit row come back empty.
  const viewer = sessionContext(await session(tokenFor('viewer', 'viewer-reply', ['Viewer'])));
  const taskId = await seed('blocked');
  const error = await failure(ownerApi(viewer, { command: 'reply', taskId, note: NOTE }, 'owner-test'));
  expect(error).toMatchObject({ code: 'forbidden' });
  expect(error.message).not.toContain('not found');
  expect(await stored(taskId)).toMatchObject({ state: 'blocked', version: 3 });
  expect(await ownerReplies(taskId)).toHaveLength(0);
  // The read path asks the session whether it can still read before it reports absence: a read-only session must get a
  // real answer both for a task it can see and for one that does not exist.
  const detail = await ownerApi(viewer, { command: 'task.detail', taskId }, 'owner-test') as { task: { state: string; version: number } };
  expect(detail.task).toMatchObject({ state: 'blocked', version: 3 });
  expect(await failure(ownerApi(viewer, { command: 'task.detail', taskId: crypto.randomUUID() }, 'owner-test')))
    .toMatchObject({ code: 'not_found', message: 'task not found' });
});
