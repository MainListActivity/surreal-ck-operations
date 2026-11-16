import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import type { DatabaseConfig } from '../src/config.ts';
import { CompanyDatabase, type CompanyDatabaseOptions } from '../src/database.ts';
import { CompanyError } from '../src/core-errors.ts';
import { ownerApi, type OwnerApiContext } from '../src/owner-api.ts';
import { OwnerDesk } from '../src/owner.ts';

// 老板回复受阻任务：云端会话的身份真实失效时（RUN_SCK_OWNER_REPLY_TESTS）。三种情形都由服务端真实行为触发，
// 不用 invalidate() 或客户端计时代替：
//   1. 令牌 exp 先到、续期被拒：服务端把会话降为匿名。允许访客的服务端上，读表为空、INFO FOR DB 报 IAM 错误，
//      这正是生产日志里的形态。撤销身份的时刻晚于 exp 约 0.2 至 0.6 秒（有抖动），测试等它真的撤销后才回复。
//      到期前先断言身份、读与写都正常。回复报“暂时不可用”（可重试），不报“任务不存在”，且不写入。
//      身份恢复后同一回复落地一次。
//   2. 服务端会话到期（DURATION FOR SESSION 4s，令牌 600 秒）：到期前先断言身份、读与写都正常。到期后明确报
//      “The session has expired”，不是空读；拒绝以服务端返回为准，应出现在连接后约 4 秒。回复重建会话后同一答复落地一次。
//   3. 会话健康、任务确实不存在：报“任务不存在”，且不重建会话。
// 任务详情（task.detail）与回复走同一套判断：会话不可读时空结果不等于不存在，只报“暂时不可用”；到期的读取经重建后再读到原任务。
// fork 以 --allow-guests 启动：生产日志里只见 “IAM error: Not enough permissions”，从未见 “Anonymous access not allowed”，
// 与允许访客一致（由日志推断，生产配置未直接核实）。身份服务是本地 Bun.serve，签发 HS512 替身令牌（与
// cloud-session.fork.test.ts 相同做法）；令牌寿命与服务端会话时长分别设置，两者不互相代替。
setDefaultTimeout(60000);
const run = process.env.RUN_SCK_OWNER_REPLY_TESTS === '1' ? test : test.skip;

const PASSWORD = 'owner-session-fixture-only';
const SECRET = 'owner-session-hs512-standin-fixture-only-0123456789';
const ISS = 'https://ma.example.test';
const CLIENT_ID = 'runner-fixture';
const CLIENT_SECRET = 'owner-session-client-secret-fixture-only';
const NS = 'owner_session';
const DATABASE = 'control_plane';
const NOTE = '会话到期后的回复原话';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

let home = '';
let previousHome: string | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
let port = 0;
let idp: ReturnType<typeof Bun.serve> | undefined;
let idpUrl = '';
/** 身份服务：拒绝发令牌（续期被拒）。 */
let idpDown = false;
/** 本次签发的令牌所用的访问方式，以及寿命（秒）与到期时刻（毫秒）。 */
let idpAccess = 'runner';
let lifetimeSec = 600;
let lastExpMs = 0;
let company: CompanyDatabase;
let count = 0;
const key = () => `reply-${++count}-${crypto.randomUUID()}`;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(claims: Record<string, unknown>): string {
  const head = b64({ alg: 'HS512', typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${createHmac('sha512', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

function cloudConfig(): DatabaseConfig {
  return {
    url: `ws://127.0.0.1:${port}/rpc`, rootUser: '', rootPassword: '', namespace: NS, database: DATABASE,
    cloud: { idpIssuer: idpUrl, runnerClientId: CLIENT_ID, runnerClientSecretFile: join(home, 'private/cloud/runner-client-secret') },
  };
}
/** 云端执行端的数据库：每次登录向本地身份服务取令牌，与生产的 runner 会话同一路径。 */
function cloudDb(options: CompanyDatabaseOptions = {}): CompanyDatabase {
  return new CompanyDatabase(cloudConfig(), options);
}
/** The part of the owner API context that reply uses: the same wiring as the runner, `c.owner ?? new OwnerDesk(c.db)`. */
function contextOf(db: CompanyDatabase): OwnerApiContext {
  return { db, owner: new OwnerDesk(db), opsRepo: '' } as unknown as OwnerApiContext;
}

async function seed(state: 'blocked' | 'ready'): Promise<string> {
  const id = crypto.randomUUID();
  await company.db.query(`CREATE $task CONTENT { title: '修正过期路线图', context: '老板原话', requirement: '需求原文',
    acceptance_text: '验收原文', state: $state, blocked_to: $blocked, resume_state: 'doing', resume_role: 'engineering',
    executor_role: 'engineering', reviewer_role: 'qa', acceptance_version: 1, kind: 'task', version: 3, fence: 1, created_at: time::now() };`,
  { task: new RecordId('task', id), state, blocked: state === 'blocked' ? 'owner' : null });
  return id;
}
async function stored(id: string): Promise<{ state: string; version: number; blocked_to?: string | null }> {
  const [[task]] = await company.db.query<[Array<{ state: string; version: number; blocked_to?: string | null }>]>(
    'SELECT state, version, blocked_to FROM $t;', { t: new RecordId('task', id) });
  return task!;
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

/**
 * What one bare statement returns on this session: its rows, a statement error, or an error thrown by the call itself.
 * The three shapes are what tell an identity loss (empty rows, IAM error) from a server expiry (thrown).
 */
async function rawOutcome(db: CompanyDatabase, sql: string, vars?: Record<string, unknown>):
  Promise<{ rows?: unknown[]; statementError?: string; thrown?: string }> {
  try {
    const responses = await db.db.query(sql, vars).responses();
    const first = responses[0];
    if (first?.success) return { rows: first.result as unknown[] };
    return { statementError: first?.success === false ? first.error.message : undefined };
  } catch (error) {
    return { thrown: (error as Error).message };
  }
}

/**
 * 等服务端真正拒绝这个会话为止（INFO FOR DB 报的错误匹配 refusal），返回拒绝被观察到的毫秒时刻。
 * 令牌过期或会话到期后，服务端撤销身份的时刻有抖动，不能用固定等待代替。超时即失败。
 */
async function untilRefused(db: CompanyDatabase, refusal: RegExp, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = await rawOutcome(db, 'INFO FOR DB;');
    if (refusal.test(outcome.statementError ?? outcome.thrown ?? '')) return Date.now();
    if (Date.now() > deadline) throw new Error(`会话在 ${timeoutMs} 毫秒内没有被拒绝`);
    await delay(50);
  }
}

/**
 * 到期前的断言：会话仍有身份（INFO FOR DB 成功）、能读到 readId 这条任务、回复能写入 writeId 这条任务并落库。
 * 三项都须在 beforeMs（令牌或会话的到期时刻）之前完成；超过即失败，不把到期后的结果当作到期前的证据。
 */
async function expectUsableBefore(db: CompanyDatabase, readId: string, writeId: string, beforeMs: number): Promise<void> {
  expect(Date.now()).toBeLessThan(beforeMs);
  expect(await rawOutcome(db, 'INFO FOR DB;')).toEqual({ rows: expect.anything() });
  expect(await rawOutcome(db, 'SELECT * FROM $task;', { task: new RecordId('task', readId) }))
    .toEqual({ rows: [expect.objectContaining({ state: 'blocked', version: 3 })] });
  const landed = await ownerApi(contextOf(db), { command: 'reply', taskId: writeId, note: NOTE, idempotencyKey: key() }, 'owner-cli');
  expect(landed).toMatchObject({ state: 'doing', version: 4 });
  expect(await stored(writeId)).toMatchObject({ state: 'doing', version: 4 });
  expect(await ownerReplies(writeId)).toHaveLength(1);
  expect(Date.now()).toBeLessThan(beforeMs);
}

/** 拦截 console 输出，记录会话探测与重建的日志；restore 还原。 */
function captureConsole(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const log = console.log;
  const error = console.error;
  const capture = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
  console.log = capture;
  console.error = capture;
  return { messages, restore: () => { console.log = log; console.error = error; } };
}

beforeAll(async () => {
  if (process.env.RUN_SCK_OWNER_REPLY_TESTS !== '1') return;

  // 临时服务目录与权限 600 的假 runner 凭证（与 cloud-session.fork.test.ts 相同）
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sck-owner-session-home-')));
  mkdirSync(join(home, 'private/cloud'), { recursive: true });
  const secretFile = join(home, 'private/cloud/runner-client-secret');
  writeFileSync(secretFile, CLIENT_SECRET);
  chmodSync(secretFile, 0o600);
  previousHome = process.env.SCK_SERVICE_HOME;
  process.env.SCK_SERVICE_HOME = home;

  // 本地身份服务：校验 Basic 认证；拒绝时返回 503；否则签发 HS512 替身令牌（iss、ns、db、ac、rl、sub、exp）
  idp = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async req => {
      const url = new URL(req.url);
      if (req.method !== 'POST' || url.pathname !== '/token') return new Response('not found', { status: 404 });
      const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
      if (req.headers.get('authorization') !== expected) return Response.json({ error: 'invalid_client' }, { status: 401 });
      if (idpDown) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
      const now = Math.floor(Date.now() / 1000);
      const exp = now + lifetimeSec;
      lastExpMs = exp * 1000;
      const token = sign({ iss: ISS, ns: NS, db: DATABASE, ac: idpAccess, rl: ['Editor'], sub: CLIENT_ID, iat: now, nbf: now - 1, exp });
      return Response.json({ access_token: token, token_type: 'Bearer', expires_in: lifetimeSec });
    },
  });
  idpUrl = `http://127.0.0.1:${idp.port}`;

  // 起 fork（允许访客，内存存储）。访问方式用 055 的定义（占位符按 owner-reply 的做法替换），另加一个 4 秒会话的访问方式。
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  port = listener.port!;
  listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', PASSWORD,
    '--log', 'error', '--allow-guests', 'memory'], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 尚未就绪 */ }
    await delay(25);
  }
  company = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: PASSWORD, namespace: NS, database: DATABASE });
  await company.connect();
  await company.bootstrap();
  const access = readFileSync(join(import.meta.dir, '..', 'schema', '055-access.surql'), 'utf8')
    .replaceAll("URL '{{COMPANY_JWKS_URL}}'", `ALGORITHM HS512 KEY '${SECRET}'`)
    .replaceAll('{{COMPANY_ISSUER}}', ISS);
  await company.db.query(access);
  await company.db.query(`DEFINE ACCESS OVERWRITE runner_short ON DATABASE TYPE JWT ALGORITHM HS512 KEY '${SECRET}'
    AUTHENTICATE { IF $token.iss != '${ISS}' { THROW '令牌签发方不属于公司库' } } DURATION FOR SESSION 4s;`);
});

afterAll(async () => {
  if (company) await company.close();
  server?.kill();
  await server?.exited;
  idp?.stop(true);
  if (home) rmSync(home, { recursive: true, force: true });
  if (process.env.RUN_SCK_OWNER_REPLY_TESTS === '1') {
    if (previousHome === undefined) delete process.env.SCK_SERVICE_HOME;
    else process.env.SCK_SERVICE_HOME = previousHome;
  }
});

run('令牌到期且续期被拒：会话失去身份，回复报暂时不可用（不报任务不存在）且不写入；身份恢复后同一回复落地一次', async () => {
  idpAccess = 'runner';
  lifetimeSec = 3;
  // 续期排在令牌到期前 500 毫秒；身份服务拒绝后，续期失败，令牌先到期。
  const db = cloudDb({ renewBeforeMs: 500, reconnectMinMs: 200, reconnectMaxMs: 400 });
  const logs = captureConsole();
  try {
    await db.connect();
    const inUseExpMs = lastExpMs;
    idpDown = true;
    const taskId = await seed('blocked');
    const earlyId = await seed('blocked');
    // 到期前：身份、读、写都正常。写入的是另一条任务 earlyId，taskId 留给下面的失效用例。
    await expectUsableBefore(db, taskId, earlyId, inUseExpMs);

    // 服务端把过期令牌的会话降为匿名：等它真的撤销（晚于 exp）。读表为空，INFO FOR DB 报 IAM 错误（与生产日志同一形态）。
    const lostAt = await untilRefused(db, /Not enough permissions/, 10_000);
    expect(lostAt).toBeGreaterThanOrEqual(inUseExpMs);
    expect(await rawOutcome(db, 'SELECT * FROM $task;', { task: new RecordId('task', taskId) })).toEqual({ rows: [] });
    expect((await rawOutcome(db, 'INFO FOR DB;')).statementError).toContain('Not enough permissions');

    const k = key();
    const refused = await failure(ownerApi(contextOf(db), { command: 'reply', taskId, note: NOTE, idempotencyKey: k }, 'owner-cli'));
    expect(refused).toMatchObject({ code: 'temporarily_unavailable', retryable: true });
    expect(refused.message).not.toContain('not found');
    expect(logs.messages.some(message => message.includes('database reconnect failed'))).toBe(true);
    // 没有写入：任务仍是阻塞、版本 3，也没有老板回复记录。
    expect(await stored(taskId)).toMatchObject({ state: 'blocked', version: 3 });
    expect(await ownerReplies(taskId)).toHaveLength(0);

    // 读取同样：会话不可读时任务详情报暂时不可用，连真不存在的任务也不报“任务不存在”。
    const unreadable = await failure(ownerApi(contextOf(db), { command: 'task.detail', taskId }, 'owner-cli'));
    expect(unreadable).toMatchObject({ code: 'temporarily_unavailable', retryable: true });
    expect(unreadable.message).not.toContain('not found');
    expect(await failure(ownerApi(contextOf(db), { command: 'task.detail', taskId: crypto.randomUUID() }, 'owner-cli')))
      .toMatchObject({ code: 'temporarily_unavailable', retryable: true });

    // 身份服务恢复：任务详情先读到原任务（版本 3）；同一回复（同一幂等键）落地一次；重放返回原结果。
    idpDown = false;
    lifetimeSec = 600;
    const detail = await ownerApi(contextOf(db), { command: 'task.detail', taskId }, 'owner-cli') as { task: { state: string; version: number } };
    expect(detail.task).toMatchObject({ state: 'blocked', version: 3 });
    const landed = await ownerApi(contextOf(db), { command: 'reply', taskId, note: NOTE, idempotencyKey: k }, 'owner-cli');
    expect(landed).toMatchObject({ state: 'doing', version: 4 });
    const replay = await ownerApi(contextOf(db), { command: 'reply', taskId, note: NOTE, idempotencyKey: k }, 'owner-cli');
    expect(replay).toMatchObject({ state: 'doing', version: 4 });
    const replies = await ownerReplies(taskId);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.evidence).toContain(NOTE);
  } finally {
    idpDown = false;
    lifetimeSec = 600;
    logs.restore();
    await db.close();
  }
});

run('服务端会话到期（DURATION FOR SESSION 4s，令牌 600 秒）：到期前身份、读与写正常；到期后明确报会话已过期，拒绝约在连接后 4 秒；回复重建会话后落地一次，不报任务不存在', async () => {
  idpAccess = 'runner_short';
  lifetimeSec = 600;
  const db = cloudDb();
  const logs = captureConsole();
  try {
    const connectStart = Date.now();
    await db.connect();
    const taskId = await seed('blocked');
    const earlyId = await seed('blocked');
    // 会话自登录起 4 秒到期（令牌仍然有效）。在到期前约 2 秒检查身份、读与写，且检查须在连接后 3 秒内完成。
    await delay(Math.max(0, connectStart + 2000 - Date.now()));
    await expectUsableBefore(db, taskId, earlyId, connectStart + 3000);

    // 拒绝以服务端返回为准：到期是明确的错误，不是空读，也不由客户端配置推算。服务端撤销会话有约 1 秒的抖动（实测在连接后
    // 4 至 5 秒之间），窗口取 3.5 至 6 秒：早于它说明会话提前失效，晚于它说明会话没有按 4 秒到期。
    const refusedAt = await untilRefused(db, /session has expired/, 15_000);
    expect(refusedAt - connectStart).toBeGreaterThanOrEqual(3500);
    expect(refusedAt - connectStart).toBeLessThanOrEqual(6000);
    expect(await rawOutcome(db, 'INFO FOR DB;')).toMatchObject({ thrown: expect.stringContaining('The session has expired') });

    // 读取经由同一条重建路径：到期的读取被服务端明确拒绝，重建后读到原任务（版本 3）。
    const detail = await ownerApi(contextOf(db), { command: 'task.detail', taskId }, 'owner-cli') as { task: { state: string; version: number } };
    expect(detail.task).toMatchObject({ state: 'blocked', version: 3 });
    const landed = await ownerApi(contextOf(db), { command: 'reply', taskId, note: NOTE }, 'owner-cli');
    expect(landed).toMatchObject({ state: 'doing', version: 4 });
    // 重建走的是“会话到期”这条路：探测报到期，然后重建连接。
    expect(logs.messages.some(message => message.includes('database connection re-established (was: The session has expired'))).toBe(true);
    expect(await ownerReplies(taskId)).toHaveLength(1);
  } finally {
    logs.restore();
    await db.close();
  }
});

run('会话健康：任务确实不存在时报任务不存在（回复与任务详情都是），存在时读到原任务，且不重建会话', async () => {
  idpAccess = 'runner';
  lifetimeSec = 600;
  const db = cloudDb();
  const logs = captureConsole();
  try {
    await db.connect();
    const error = await failure(ownerApi(contextOf(db), { command: 'reply', taskId: crypto.randomUUID(), note: NOTE }, 'owner-cli'));
    expect(error).toMatchObject({ code: 'not_found', message: 'task not found' });
    expect(await failure(ownerApi(contextOf(db), { command: 'task.detail', taskId: crypto.randomUUID() }, 'owner-cli')))
      .toMatchObject({ code: 'not_found', message: 'task not found' });
    const taskId = await seed('blocked');
    const detail = await ownerApi(contextOf(db), { command: 'task.detail', taskId }, 'owner-cli') as { task: { state: string; version: number } };
    expect(detail.task).toMatchObject({ state: 'blocked', version: 3 });
    expect(logs.messages.some(message => message.includes('re-established') || message.includes('reconnect failed'))).toBe(false);
  } finally {
    logs.restore();
    await db.close();
  }
});
