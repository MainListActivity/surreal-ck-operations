import { describe, expect, test } from 'bun:test';
import { CompanyError } from '../src/core-errors.ts';
import { GatewayClient, GatewayError } from '../src/cloud/gateway.ts';
import { failureOf } from '../owner-end/src/errors.ts';
import { jobFailure } from '../owner-end/src/jobs.ts';
import { createOwnerJobStore, pendingReply, type OwnerJobStore, type Reply } from './support/owner-job-contract.ts';

const URL_BASE = 'https://gw.example.test';
const TOKEN = 'tok-gateway-1';
// 与 src/ops/redact.ts 的 JWT 形状一致的合成值，不是真实凭证。
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';

type Call = { url: string; init: RequestInit; body: { command: string; input: unknown } };

function fakeFetch(respond: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? 'null')),
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ok = (result: unknown) => json({ ok: true, result });
const fail = (code: string, message: string, status = 400) => json({ ok: false, error: { code, message } }, status);
const reply = ({ status, body }: Reply) => json(body, status);

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

const noSleep = async () => {};
const authOf = (call: Call) => (call.init.headers as Record<string, string>).Authorization;

/**
 * 老板端网关替身：业务命令排队并返回真实的 202 待取回应；ops.job.get 走老板端真实命令。
 * between(poll, id) 在第 poll 次轮询之前执行，用来模拟执行端在两次轮询之间推进作业。
 */
function bossGateway(store: OwnerJobStore, between: (poll: number, id: string) => void = () => {}) {
  let polls = 0;
  return fakeFetch(async call => {
    if (call.body.command !== 'ops.job.get') {
      const id = await store.enqueue(call.body.command, call.body.input as Record<string, unknown>);
      return reply(pendingReply(id));
    }
    polls += 1;
    between(polls, (call.body.input as { id: string }).id);
    return reply(await store.getJob(call.body.input));
  });
}

describe('GatewayClient.call', () => {
  test('ok 直接返回 result，并带正确的 Bearer 头与 body', async () => {
    const { fn, calls } = fakeFetch(() => ok({ value: 42 }));
    const client = new GatewayClient({ url: `${URL_BASE}/`, fetch: fn });
    expect(await client.call(TOKEN, 'board.read', { a: 1 })).toEqual({ value: 42 });
    expect(calls[0]?.url).toBe(`${URL_BASE}/api/cmd`);
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ command: 'board.read', input: { a: 1 } });
  });

  test('error 响应抛 GatewayError 并带 code', async () => {
    const { fn } = fakeFetch(() => fail('forbidden', '没有权限', 403));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'x.y'));
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe('forbidden');
  });

  test('未知 code 归一为 upstream_error', async () => {
    const { fn } = fakeFetch(() => fail('weird_code', 'x', 500));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    expect(((await catchError(client.call(TOKEN, 'x.y'))) as GatewayError).code).toBe('upstream_error');
  });

  test('非 JSON 响应抛 upstream_error：说明没有可读的回执，未受理，正文不回显', async () => {
    const { fn } = fakeFetch(() => new Response('<html>bad gateway secret-page</html>', { status: 502 }));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'x.y')) as GatewayError;
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe('网关返回了非 JSON 响应（HTTP 502），没有可读的回执');
    expect(error.message).not.toContain('secret-page');
    expect(error.accepted).toBe(false);
  });

  test.each([408, 504, 524])('超时类的非 JSON 响应（HTTP %i）说明为网关超时，仍没有回执，业务命令只提交一次', async status => {
    const { fn, calls } = fakeFetch(() => new Response('<html>timeout</html>', { status }));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' })) as GatewayError;
    expect(error.message).toBe(`网关超时（HTTP ${status}），没有可读的回执`);
    expect(error.accepted).toBe(false);
    expect(calls.map(call => call.body.command)).toEqual(['ops_login']);
  });

  const BAD_SHAPES: Array<[string, () => Response, string]> = [
    ['错误字段是字符串', () => json({ ok: false, error: 'boom' }, 500), '网关返回的错误格式不标准（HTTP 500，error 为字符串）'],
    ['错误字段是数组', () => json({ ok: false, error: [] }, 500), '网关返回的错误格式不标准（HTTP 500，error 为数组）'],
    ['缺少 ok 字段', () => json({ result: 1 }, 200), '网关响应缺少 ok 字段（HTTP 200）'],
    ['回执是数组', () => json([1, 2], 200), '网关响应不是对象（HTTP 200，正文为数组）'],
    ['回执是 null', () => json(null, 200), '网关响应不是对象（HTTP 200，正文为空值）'],
  ];
  test.each(BAD_SHAPES)('回执形状不对（%s）：明确失败，未受理，业务命令只提交一次', async (_label, respond, message) => {
    const { fn, calls } = fakeFetch(respond);
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'x.y')) as GatewayError;
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(message);
    expect(error.accepted).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test('错误信息中的令牌被脱敏', async () => {
    const leaked = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    const { fn } = fakeFetch(() => fail('unauthorized', `bad token ${leaked}`, 401));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'x.y'));
    expect((error as GatewayError).message).not.toContain(leaked);
  });

  test('命令名为空或超过 128 字符时不发请求', async () => {
    const { fn, calls } = fakeFetch(() => ok(null));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    expect(await catchError(client.call(TOKEN, ''))).toBeInstanceOf(GatewayError);
    expect(await catchError(client.call(TOKEN, 'c'.repeat(129)))).toBeInstanceOf(GatewayError);
    expect(calls).toHaveLength(0);
  });

  test('非 https 的网关地址在构造时拒绝', () => {
    expect(() => new GatewayClient({ url: 'http://evil.example' })).toThrow();
    expect(() => new GatewayClient({ url: 'http://localhost:8080' })).not.toThrow();
  });
});

describe('GatewayClient 轮询老板端作业（真实 ops.job.get 回执）', () => {
  test('pending → queued → running → done：返回业务结果；业务命令只提交一次，之后都查同一个作业', async () => {
    const store = createOwnerJobStore();
    const { fn, calls } = bossGateway(store, (poll, id) => {
      if (poll === 2) store.start(id);
      if (poll === 3) store.succeed(id, { session: 'synthetic-session', workspaces: [] });
    });
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    expect(await client.call(TOKEN, 'ops_login', { alias: 'QA1' })).toEqual({
      session: 'synthetic-session',
      workspaces: [],
    });
    expect(calls.map(call => call.body.command)).toEqual(['ops_login', 'ops.job.get', 'ops.job.get', 'ops.job.get']);
    expect(calls[0]!.body.input).toEqual({ alias: 'QA1' });
    const id = (calls[1]!.body.input as { id: string }).id;
    for (const call of calls.slice(1)) expect(call.body.input).toEqual({ id });
    for (const call of calls) expect(authOf(call)).toBe(`Bearer ${TOKEN}`);
  });

  const CATEGORIES = ['forbidden', 'conflict', 'lease_expired', 'login_failed', 'ci_pending', 'ci_failed'] as const;
  test.each([...CATEGORIES])('作业失败：错误类别 %s 原样保留，说明写明原因，业务命令只提交一次', async code => {
    const store = createOwnerJobStore();
    const { fn, calls } = bossGateway(store, (poll, id) => {
      if (poll === 1) store.fail(id, new CompanyError(code, '执行端拒绝了这次操作'));
    });
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' }));
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe(code);
    expect((error as GatewayError).message).toBe('作业执行失败：执行端拒绝了这次操作');
    expect((error as GatewayError).accepted).toBe(true);
    expect(calls.filter(call => call.body.command === 'ops_login')).toHaveLength(1);
  });

  const UNLISTED: Array<[string, () => Error, string]> = [
    ['普通错误', () => new Error('boom'), 'boom'],
    ['带 Node 错误码的错误', () => Object.assign(new Error('no such file'), { code: 'ENOENT' }), 'no such file'],
  ];
  test.each(UNLISTED)('作业失败：%s 的类别不在公司错误码之内，按上游失败，说明保留', async (_label, make, detail) => {
    const store = createOwnerJobStore();
    const { fn } = bossGateway(store, (poll, id) => {
      if (poll === 1) store.fail(id, make());
    });
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' }));
    expect((error as GatewayError).code).toBe('upstream_error');
    expect((error as GatewayError).message).toBe(`作业执行失败：${detail}`);
  });

  test('作业失败：执行端写回的说明经脱敏，凭证不回显给员工', async () => {
    const store = createOwnerJobStore();
    const { fn } = bossGateway(store, (poll, id) => {
      if (poll === 1) store.fail(id, new CompanyError('login_failed', `登录被拒，令牌 ${JWT}`));
    });
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' }));
    expect((error as GatewayError).code).toBe('login_failed');
    expect((error as GatewayError).message).toContain('登录被拒');
    expect((error as GatewayError).message).not.toContain(JWT);
  });

  test('作业失败：即使执行端没有脱敏，客户端也不把凭证回显给员工', async () => {
    const store = createOwnerJobStore();
    const { fn } = bossGateway(store, (poll, id) => {
      if (poll === 1) store.patch(id, { state: 'error', error: `login_failed: 登录被拒，令牌 ${JWT}` });
    });
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' }));
    expect((error as GatewayError).code).toBe('login_failed');
    expect((error as GatewayError).message).not.toContain(JWT);
  });

  test('作业失败但没有错误文本：按上游失败，说明通用', async () => {
    const store = createOwnerJobStore();
    const { fn } = bossGateway(store, (poll, id) => {
      if (poll === 1) store.patch(id, { state: 'error' });
    });
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' }));
    expect((error as GatewayError).code).toBe('upstream_error');
    expect((error as GatewayError).message).toBe('作业执行失败');
  });

  test('作业失败的错误不是执行端的一句话文本：按上游失败，不猜测类别', async () => {
    const store = createOwnerJobStore();
    const { fn } = bossGateway(store, (poll, id) => {
      if (poll === 1) store.patch(id, { state: 'error', error: JSON.stringify({ code: 'forbidden', message: '拒绝' }) });
    });
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' }));
    expect((error as GatewayError).code).toBe('upstream_error');
    expect((error as GatewayError).message).toBe('作业执行失败');
  });

  test('作业仍在执行且超过轮询时限：抛 pending，业务命令不重提交', async () => {
    const store = createOwnerJobStore();
    const { fn, calls } = bossGateway(store, (poll, id) => {
      if (poll === 1) store.start(id);
    });
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, pollTimeoutMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' }));
    expect((error as GatewayError).code).toBe('pending');
    expect((error as GatewayError).message).toBe('作业仍在执行，稍后再取');
    expect((error as GatewayError).accepted).toBe(true);
    expect(calls.map(call => call.body.command)).toEqual(['ops_login', 'ops.job.get']);
  });

  test('ops.job.get 查不到作业（老板端真实的 not_found）：直接抛出，不重提交', async () => {
    const store = createOwnerJobStore();
    const { fn, calls } = bossGateway(store, (poll, id) => {
      if (poll === 1) store.remove(id);
    });
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' }));
    expect((error as GatewayError).code).toBe('not_found');
    expect((error as GatewayError).accepted).toBe(true);
    expect(calls.map(call => call.body.command)).toEqual(['ops_login', 'ops.job.get']);
  });

  test('轮询时网关返回 401：直接按原类别抛出，不重提交', async () => {
    const { fn, calls } = fakeFetch(call =>
      call.body.command === 'ops.job.get'
        ? fail('unauthorized', '令牌已失效', 401)
        : json({ ok: false, error: { code: 'pending', message: 'job-401' } }, 202),
    );
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' }));
    expect((error as GatewayError).code).toBe('unauthorized');
    expect((error as GatewayError).accepted).toBe(true);
    expect(calls.map(call => call.body.command)).toEqual(['ops_login', 'ops.job.get']);
  });

  test('业务命令在入队前即被拒（没有排队）：标为未接受，调用方可按原规则重试', async () => {
    const { fn, calls } = fakeFetch(() => fail('unauthorized', '令牌已失效', 401));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' }));
    expect((error as GatewayError).code).toBe('unauthorized');
    expect((error as GatewayError).accepted).toBe(false);
    expect(calls.map(call => call.body.command)).toEqual(['ops_login']);
  });

  const MALFORMED: Array<[string, unknown, string]> = [
    ['旧的裸作业视图', { id: 'job-m', state: 'done', result: { value: 1 } }, '作业视图格式错误：缺少 job 包装'],
    ['缺少 job', {}, '作业视图格式错误：缺少 job 包装'],
    ['job 为 null', { job: null }, '作业视图格式错误：job 不是对象'],
    ['job 是字符串', { job: 'job-m' }, '作业视图格式错误：job 不是对象'],
    ['job 是数组', { job: [] }, '作业视图格式错误：job 不是对象'],
    ['state 不认识', { job: { id: 'job-m', state: 'paused' } }, '作业视图格式错误：作业状态不认识'],
    ['缺少 id', { job: { state: 'done', result: { value: 1 } } }, '作业视图格式错误：缺少作业号'],
    ['id 与所查作业不一致', { job: { id: 'job-other', state: 'done', result: { value: 1 } } }, '作业视图格式错误：作业号与所查的作业不一致'],
    ['结果缺失（只有 ok）', undefined, '作业视图格式错误：缺少 job 包装'],
  ];
  test.each(MALFORMED)('ops.job.get 回执畸形（%s）：写明哪一项不符，明确失败，不重提交', async (_label, result, message) => {
    const { fn, calls } = fakeFetch(call =>
      call.body.command === 'ops.job.get'
        ? ok(result)
        : json({ ok: false, error: { code: 'pending', message: 'job-m' } }, 202),
    );
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' }));
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe('upstream_error');
    expect((error as GatewayError).message).toBe(message);
    expect((error as GatewayError).accepted).toBe(true);
    expect((error as GatewayError).jobId).toBe('job-m');
    expect(calls.map(call => call.body.command)).toEqual(['ops_login', 'ops.job.get']);
  });

  test('轮询时网关返回非 JSON 超时（HTTP 524）：已受理，作业号保留，正文不回显，不重提交', async () => {
    const { fn, calls } = fakeFetch(call =>
      call.body.command === 'ops.job.get'
        ? new Response('<html>edge timeout secret-page</html>', { status: 524 })
        : json({ ok: false, error: { code: 'pending', message: 'job-t1' } }, 202),
    );
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' })) as GatewayError;
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe('网关超时（HTTP 524），没有可读的回执');
    expect(error.message).not.toContain('secret-page');
    expect(error.accepted).toBe(true);
    expect(error.jobId).toBe('job-t1');
    expect(calls.map(call => call.body.command)).toEqual(['ops_login', 'ops.job.get']);
  });

  const ENTRANCE_REPLIES: Array<[number, string]> = [
    [503, 'Unavailable'],
    [500, 'Internal Server Error'],
    [403, 'Forbidden'],
    [404, 'Not Found'],
  ];
  test.each(ENTRANCE_REPLIES)('轮询时入口返回旧式 {error} 回执（HTTP %s，没有 ok 字段）：已受理，作业号保留，业务命令不重提交', async (status, text) => {
    const { fn, calls } = fakeFetch(call =>
      call.body.command === 'ops.job.get'
        ? json({ error: text }, status)
        : json({ ok: false, error: { code: 'pending', message: 'job-t1' } }, 202),
    );
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const failure = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' })) as GatewayError;
    expect(failure.code).toBe('upstream_error');
    expect(failure.message).toBe(`网关响应缺少 ok 字段（HTTP ${status}）`);
    expect(failure.accepted).toBe(true);
    expect(failure.jobId).toBe('job-t1');
    expect(calls.map(call => call.body.command)).toEqual(['ops_login', 'ops.job.get']);
  });

  test('作业因恢复窗口已过被拒：截止时刻随说明保留，已受理，作业号保留，业务命令只提交一次', async () => {
    const store = createOwnerJobStore();
    const deadline = '2026-11-16T07:01:22.859Z';
    const { fn, calls } = bossGateway(store, (poll, id) => {
      if (poll === 1) store.fail(id, new CompanyError('upstream_error', `the recovery deadline for this operation has passed at ${deadline}`));
    });
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' })) as GatewayError;
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`作业执行失败：the recovery deadline for this operation has passed at ${deadline}`);
    expect(error.accepted).toBe(true);
    expect(error.jobId).toBe((calls[1]!.body.input as { id: string }).id);
    expect(calls.filter(call => call.body.command === 'ops_login')).toHaveLength(1);
  });
});

describe('GatewayClient 回执：作业号、类别与阶段', () => {
  test('同步失败的老板端真实回执（等待时限内作业已失败）：已受理，作业号、类别与阶段都保留，业务命令只提交一次', async () => {
    const { fn, calls } = fakeFetch(() => reply(failureOf(jobFailure({
      code: 'login_failed', jobId: 'job-sync-1', message: 'IdP rejected the login (invalid_credentials); stage=login',
    }))));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' })) as GatewayError;
    expect(error.code).toBe('login_failed');
    expect(error.accepted).toBe(true);
    expect(error.jobId).toBe('job-sync-1');
    expect(error.stage).toBe('login');
    expect(error.message).toContain('IdP rejected the login');
    expect(calls.map(call => call.body.command)).toEqual(['ops_login']);
  });

  test('同步失败且没有作业号（入队前被拒）：未受理，没有作业号与阶段', async () => {
    const { fn } = fakeFetch(() => fail('forbidden', '没有权限', 403));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'x.y')) as GatewayError;
    expect(error.code).toBe('forbidden');
    expect(error.accepted).toBe(false);
    expect(error.jobId).toBeUndefined();
    expect(error.stage).toBeUndefined();
  });

  test('作业类别取 jobCode：接口码 upstream_error 不覆盖作业原来的类别', async () => {
    const { fn } = fakeFetch(() => json({ ok: false, error: { code: 'upstream_error', jobCode: 'forbidden', message: '拒绝', jobId: 'job-c1' } }, 502));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'x.y')) as GatewayError;
    expect(error.code).toBe('forbidden');
    expect(error.accepted).toBe(true);
  });

  test('作业类别是 unauthorized（老板端映射为 502）：类别保留给调用方，但已受理，不当作网关鉴权失败重提', async () => {
    const { fn, calls } = fakeFetch(() => reply(failureOf(jobFailure({ code: 'unauthorized', jobId: 'job-u1', message: '登录令牌已失效' }))));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'ops_authfail', {})) as GatewayError;
    expect(error.code).toBe('unauthorized');
    expect(error.accepted).toBe(true);
    expect(error.jobId).toBe('job-u1');
    expect(calls).toHaveLength(1);
  });

  test('jobCode 不认识：按上游失败，说明保留', async () => {
    const { fn } = fakeFetch(() => json({ ok: false, error: { code: 'upstream_error', jobCode: 'weird_code', message: '奇怪', jobId: 'job-c2' } }, 502));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'x.y')) as GatewayError;
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe('奇怪');
  });

  test('阶段从截断前的原文取：同步失败的说明超过 200 字时，阶段仍在，说明正文被截断', async () => {
    const message = `${'x'.repeat(260)}; stage=exchange`;
    const { fn } = fakeFetch(() => reply(failureOf(jobFailure({ code: 'login_failed', jobId: 'job-long', message }))));
    const client = new GatewayClient({ url: URL_BASE, fetch: fn });
    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' })) as GatewayError;
    expect(error.stage).toBe('exchange');
    expect(error.message).not.toContain('stage=');
  });

  test('执行端写回的失败说明超过 200 字：阶段仍由执行端记录取得，作业号与轮询的作业一致', async () => {
    const store = createOwnerJobStore();
    const { fn, calls } = bossGateway(store, (poll, id) => {
      if (poll === 1) store.fail(id, new CompanyError('login_failed', `${'y'.repeat(260)}; stage=consent`));
    });
    const client = new GatewayClient({ url: URL_BASE, fetch: fn, pollMs: 0, sleep: noSleep });

    const error = await catchError(client.call(TOKEN, 'ops_login', { alias: 'QA1' })) as GatewayError;
    expect(error.code).toBe('login_failed');
    expect(error.accepted).toBe(true);
    expect(error.stage).toBe('consent');
    expect(error.jobId).toBe((calls[1]!.body.input as { id: string }).id);
  });
});
