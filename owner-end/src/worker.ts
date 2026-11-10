import { ownerEventStream } from './realtime.ts';
import { readRuntimeDashboard } from '../../src/runtime-dashboard.ts';
import { feedbackEndpoint } from './feedback.ts';
/**
 * 老板端 Worker：/api 下的接口（登录身份、看板、命令）与定时任务入口；其余路径交给静态页面（assets）。
 * 鉴权只认 Bearer 令牌、不用 cookie，所以不存在跨站请求伪造；命令接口仍核对 Origin，挡住其它站点的页面误用。
 * 接口形状见 README：成功 {ok:true,result}，失败 {ok:false,error:{code,message,jobId?}}，只有 /api/config 是裸 JSON。
 */
import { Hono } from 'hono';
import { readBoard } from '../../src/board.ts';
import { CompanyError } from '../../src/core-errors.ts';
import { authenticate, type Caller } from './auth/caller.ts';
import { parseCommandBody, requireOwner, runCommand } from './commands.ts';
import { sessionsOf, withSession } from './db.ts';
import { readConfig, type Env } from './env.ts';
import { failureOf } from './errors.ts';
import { runScheduled } from './cron.ts';

const MAX_BODY_BYTES = 256 * 1024;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

function failed(error: unknown): Response {
  const { status, body } = failureOf(error);
  return json(status, body);
}

async function respond(run: () => Promise<unknown>): Promise<Response> {
  try {
    return json(200, { ok: true, result: await run() });
  } catch (error) {
    return failed(error);
  }
}

/** 命令接口只接受同源（或没有 Origin 的）请求。 */
function sameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) throw new CompanyError('forbidden', '请求来源不被允许');
}

async function jsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new CompanyError('invalid', '请求体过大');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CompanyError('invalid', '请求体不是合法的 JSON');
  }
}

const app = new Hono<{ Bindings: Env }>();

/** 页面登录所需的公开配置（无需登录）。裸 JSON，不包在 ok 里。 */
app.get('/api/config', (c) => {
  try {
    const { idp } = readConfig(c.env);
    return json(200, {
      issuer: idp.issuer,
      clientId: idp.consoleClientId,
      authorizeUrl: idp.authorizeUrl,
      tokenUrl: idp.tokenUrl,
      audience: idp.audience,
    });
  } catch (error) {
    return failed(error);
  }
});

/** 当前登录的老板。非老板返回 403。 */
app.get('/api/me', (c) => respond(async () => {
  const caller = requireOwner(await authenticate(c.req.raw, readConfig(c.env)));
  return { sub: caller.sub, roles: caller.token.roles, exp: caller.token.exp };
}));

/** 老板看板：与 board.snapshot 同一份数据。 */
app.get('/api/board', (c) => respond(async () => {
  const cfg = readConfig(c.env);
  const caller = requireOwner(await authenticate(c.req.raw, cfg));
  return withSession(await sessionsOf(cfg).owner(caller.token.token), (db) => readBoard(db));
}));

app.get('/api/events', async c => {
  try {
    const cfg = readConfig(c.env);
    const caller = requireOwner(await authenticate(c.req.raw, cfg));
    const db = await sessionsOf(cfg).owner(caller.token.token);
    return ownerEventStream(db, c.req.raw.signal, caller.token.exp * 1000);
  } catch (error) { return failed(error); }
});

app.get('/api/dashboard', c => respond(async () => {
  const cfg = readConfig(c.env);
  const caller = requireOwner(await authenticate(c.req.raw, cfg));
  return withSession(await sessionsOf(cfg).owner(caller.token.token), db => readRuntimeDashboard(db));
}));

/** 执行命令：先认身份，再分流（见 commands.ts）。 */
app.post('/api/cmd', (c) => respond(async () => {
  sameOrigin(c.req.raw);
  const cfg = readConfig(c.env);
  const caller: Caller = await authenticate(c.req.raw, cfg);
  const { command, input } = parseCommandBody(await jsonBody(c.req.raw));
  return runCommand({ cfg, sessions: sessionsOf(cfg) }, caller, command, input);
}));

app.on(['POST', 'OPTIONS'], '/api/feedback/:project', c => feedbackEndpoint(c.req.raw, c.env, c.req.param('project')));

app.all('/api/*', () => json(404, { ok: false, error: { code: 'not_found', message: '接口不存在' } }));

/** 定时任务的 cron 表达式与 ExecutionContext 只用到这两个成员，声明在这里免得依赖额外的类型包。 */
interface ScheduledEvent { readonly cron: string }
interface WaitContext { waitUntil(promise: Promise<unknown>): void }

async function runCron(env: Env, cron: string): Promise<void> {
  try {
    const cfg = readConfig(env);
    const result = await runScheduled(cfg, sessionsOf(cfg), cron);
    console.log(JSON.stringify({ cron, result }));
  } catch (error) {
    console.error('owner-end cron failed', error instanceof Error ? error.message : 'unknown');
  }
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    return pathname === '/api' || pathname.startsWith('/api/') ? app.fetch(request, env) : env.ASSETS.fetch(request);
  },
  scheduled(event: ScheduledEvent, env: Env, context: WaitContext): void {
    context.waitUntil(runCron(env, event.cron));
  },
};
