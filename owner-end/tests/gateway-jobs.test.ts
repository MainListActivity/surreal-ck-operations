import { describe, expect, test } from 'bun:test';
import { RecordId } from 'surrealdb';

import { CompanyError } from '../../src/core-errors.ts';
import { failureOf, STATUS_OF } from '../src/errors.ts';
import {
  CORE_ERROR_CODES,
  enqueueJob,
  jobDetail,
  jobFailure,
  listJobs,
  PendingJob,
  waitForJob,
} from '../src/jobs.ts';
import { fakeDb } from './_support.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 捕获 Promise 的 CompanyError；若不是 CompanyError 则抛出原错误。 */
async function errorOf(promise: Promise<unknown>): Promise<CompanyError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CompanyError) return error;
    throw error;
  }
  throw new Error('expected a CompanyError but the promise resolved');
}

/** 屏蔽 failureOf 对未知错误的 console.error 输出，结束后还原。 */
function quietly<T>(run: () => T): T {
  const original = console.error;
  console.error = () => undefined;
  try {
    return run();
  } finally {
    console.error = original;
  }
}

describe('排队（enqueueJob）', () => {
  test('返回 uuid 形式的任务号，并写入 CREATE 语句', async () => {
    const { db, calls } = fakeDb();
    const now = new Date('2025-01-02T03:04:05.000Z');
    const id = await enqueueJob(db, {
      command: 'ops.worktree.create',
      input: { name: 'w1', depth: 2 },
      actorKind: 'owner',
      actor: 'owner-user',
    }, now);

    expect(id).toMatch(UUID);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.sql).toContain('CREATE');
    const content = call.vars.content as Record<string, unknown>;
    expect(content.command).toBe('ops.worktree.create');
    expect(content.input).toBe(JSON.stringify({ name: 'w1', depth: 2 }));
    expect(content.actor_kind).toBe('owner');
    expect(content.actor).toBe('owner-user');
    expect(content.state).toBe('queued');
    expect(content.created_at).toEqual(now);
  });

  test('作业记录编号使用 ops_job 表与同一个 jobId', async () => {
    const { db, calls } = fakeDb();
    const id = await enqueueJob(db, { command: 'x', input: {}, actorKind: 'owner', actor: 'u' });
    const job = calls[0]!.vars.job as RecordId;
    expect(job).toBeInstanceOf(RecordId);
    expect(String(job.table)).toBe('ops_job');
    expect(job.id).toBe(id);
  });

  test('带任务时 content.task 是 task 表的记录编号', async () => {
    const { db, calls } = fakeDb();
    await enqueueJob(db, {
      command: 'x',
      input: {},
      actorKind: 'agent',
      actor: 'agent-1',
      task: 't-42',
    });
    const task = (calls[0]!.vars.content as Record<string, unknown>).task;
    expect(task).toBeInstanceOf(RecordId);
    const record = task as RecordId;
    expect(String(record.table)).toBe('task');
    expect(record.id).toBe('t-42');
  });

  test('不带任务时 content 没有 task 键', async () => {
    const { db, calls } = fakeDb();
    await enqueueJob(db, { command: 'x', input: {}, actorKind: 'owner', actor: 'u' });
    const content = calls[0]!.vars.content as Record<string, unknown>;
    expect('task' in content).toBe(false);
  });
});

describe('等待结果（waitForJob）', () => {
  test('先排队、再完成：返回 done 与解析后的 result 对象', async () => {
    let reads = 0;
    const { db } = fakeDb((sql) => {
      if (!sql.includes('SELECT')) return [];
      reads += 1;
      return reads === 1
        ? [{ id: 'j1', command: 'x', state: 'queued' }]
        : [{ id: 'j1', command: 'x', state: 'done', result: JSON.stringify({ ok: true, count: 3 }) }];
    });
    const outcome = await waitForJob(db, 'j1', 5_000);
    expect(outcome).toEqual({ state: 'done', result: { ok: true, count: 3 } });
    expect(reads).toBe(2);
  });

  test('state 为 error：返回 error 与 code、message，并带上作业号', async () => {
    const { db } = fakeDb(() => [
      { id: 'j2', command: 'x', state: 'error', error: JSON.stringify({ code: 'forbidden', message: '不允许' }) },
    ]);
    const outcome = await waitForJob(db, 'j2', 5_000);
    expect(outcome).toEqual({ state: 'error', code: 'forbidden', message: '不允许', jobId: 'j2' });
  });

  test('执行端写回的一句话失败（src/cloud/ops-jobs.ts 的写法）：类别与说明从这句话还原', async () => {
    const { db } = fakeDb(() => [
      { id: 'j4', command: 'ops_login', state: 'error', error: 'login_failed: IdP rejected the login; stage=login' },
    ]);
    const outcome = await waitForJob(db, 'j4', 5_000);
    expect(outcome).toEqual({ state: 'error', code: 'login_failed', message: 'IdP rejected the login; stage=login', jobId: 'j4' });
  });

  test('一句话失败的类别不认识：按上游失败，说明保留', async () => {
    const { db } = fakeDb(() => [{ id: 'j5', command: 'x', state: 'error', error: 'weird: 奇怪的错误' }]);
    expect(await waitForJob(db, 'j5', 5_000)).toEqual({ state: 'error', code: 'upstream_error', message: '奇怪的错误', jobId: 'j5' });
  });

  test('失败文本不是一句话形式：只给通用说明，不猜测类别', async () => {
    const { db } = fakeDb(() => [{ id: 'j6', command: 'x', state: 'error', error: 'boom' }]);
    expect(await waitForJob(db, 'j6', 5_000)).toEqual({ state: 'error', code: 'upstream_error', message: '执行端任务失败', jobId: 'j6' });
  });

  test('一直排队且等待 0 毫秒：立即返回 pending', async () => {
    const { db } = fakeDb(() => [{ id: 'j3', command: 'x', state: 'queued' }]);
    const started = Date.now();
    const outcome = await waitForJob(db, 'j3', 0);
    expect(outcome).toEqual({ state: 'pending' });
    expect(Date.now() - started).toBeLessThan(400);
  });

  test('任务不存在且等待 0 毫秒：返回 pending', async () => {
    const { db } = fakeDb(() => []);
    expect(await waitForJob(db, 'missing', 0)).toEqual({ state: 'pending' });
  });
});

describe('失败还原（jobFailure）', () => {
  test('已知错误码保留', async () => {
    const error = jobFailure({ code: 'forbidden', message: '不允许执行' });
    expect(error).toBeInstanceOf(CompanyError);
    expect(error.code).toBe('forbidden');
    expect(error.message).toBe('不允许执行');
  });

  test('未知错误码按上游失败处理', () => {
    const error = jobFailure({ code: 'weird', message: '奇怪的错误' });
    expect(error).toBeInstanceOf(CompanyError);
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe('奇怪的错误');
  });

  test('执行端记录的每个核心错误码都原样保留，不会被当成上游失败', () => {
    for (const code of CORE_ERROR_CODES) {
      expect(jobFailure({ code, message: '原样保留' }).code).toBe(code);
    }
  });

  test('作业号随失败一起带上，调用方凭它用 ops.job.get 定位', () => {
    expect(jobFailure({ code: 'login_failed', message: 'x', jobId: 'j7' }).jobId).toBe('j7');
    expect(jobFailure({ code: 'login_failed', message: 'x' }).jobId).toBeUndefined();
  });
});

describe('错误映射（failureOf，见 errors.ts）', () => {
  test('PendingJob 返回 202，message 与 jobId 都是任务号', () => {
    const { status, body } = failureOf(new PendingJob('abc'));
    expect(status).toBe(202);
    expect(STATUS_OF.pending).toBe(202);
    expect(body).toEqual({ ok: false, error: { code: 'pending', message: 'abc', jobId: 'abc' } });
  });

  test('CompanyError not_found 返回 404 与原提示', () => {
    const { status, body } = failureOf(new CompanyError('not_found', 'job not found'));
    expect(status).toBe(404);
    expect(body).toEqual({ ok: false, error: { code: 'not_found', message: 'job not found' } });
  });

  test('未知错误返回 5xx 与通用提示，不回显细节', () => {
    const { status, body } = quietly(() => failureOf(new Error('secret detail')));
    expect(status).toBeGreaterThanOrEqual(500);
    expect(status).toBeLessThan(600);
    expect(body.error.code).toBe('upstream_error');
    expect(body.error.message).toBe('服务暂时出错，请稍后重试');
    expect(JSON.stringify(body)).not.toContain('secret detail');
  });

  test('作业失败返回 502：接口码 upstream_error，作业类别放在 jobCode，作业号放在 jobId', () => {
    const { status, body } = failureOf(jobFailure({ code: 'login_failed', message: 'IdP rejected the login', jobId: 'j9' }));
    expect(status).toBe(502);
    expect(body).toEqual({
      ok: false,
      error: { code: 'upstream_error', message: 'IdP rejected the login', jobId: 'j9', jobCode: 'login_failed' },
    });
  });

  test('作业失败永远不返回 401：网页据此不会把老板登出，每个核心错误码都是这样', () => {
    for (const code of CORE_ERROR_CODES) {
      const { status, body } = failureOf(jobFailure({ code, message: '原样保留', jobId: 'j-all' }));
      expect(status, code).not.toBe(401);
      expect(body.error.code, code).not.toBe('unauthorized');
      expect(body.error.jobCode, code).toBe(code);
    }
  });

  test('作业失败的接口码与普通错误一致：拒绝为 403，冲突为 409，其余照常', () => {
    expect(failureOf(jobFailure({ code: 'forbidden', message: '不允许', jobId: 'j1' })).status).toBe(403);
    expect(failureOf(jobFailure({ code: 'forbidden', message: '不允许', jobId: 'j1' })).body.error.code).toBe('forbidden');
    expect(failureOf(jobFailure({ code: 'lease_expired', message: '租约已过', jobId: 'j2' })).status).toBe(409);
  });

  test('作业没有作业号时不带 jobId 字段', () => {
    const { body } = failureOf(jobFailure({ code: 'forbidden', message: '不允许' }));
    expect(body.error).toEqual({ code: 'forbidden', message: '不允许', jobCode: 'forbidden' });
    expect('jobId' in body.error).toBe(false);
  });

  test('普通错误的接口信封不附作业字段：没有 jobCode，也没有 jobId', () => {
    const { body } = failureOf(new CompanyError('not_found', 'job not found'));
    expect('jobCode' in body.error).toBe(false);
    expect('jobId' in body.error).toBe(false);
  });
});

describe('作业列表（listJobs）', () => {
  test('非法 state 抛出 invalid', async () => {
    const { db, calls } = fakeDb();
    const error = await errorOf(listJobs(db, { state: 'bogus' }));
    expect(error.code).toBe('invalid');
    expect(calls).toHaveLength(0);
  });

  test('state 为 done 时 SQL 含 state 过滤，变量带上 state', async () => {
    const { db, calls } = fakeDb();
    await listJobs(db, { state: 'done' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('state = $state');
    expect(calls[0]!.vars.state).toBe('done');
  });

  test('未给 state 时不加过滤条件', async () => {
    const { db, calls } = fakeDb();
    await listJobs(db, {});
    expect(calls[0]!.sql).not.toContain('state = $state');
    expect('state' in calls[0]!.vars).toBe(false);
  });

  test('limit 999 被限制为 200', async () => {
    const { db, calls } = fakeDb();
    await listJobs(db, { limit: 999 });
    expect(calls[0]!.vars.limit).toBe(200);
  });

  test('缺省 limit 为 50', async () => {
    const { db, calls } = fakeDb();
    await listJobs(db, {});
    expect(calls[0]!.vars.limit).toBe(50);
  });

  test('列表项不带 input 与 result，字段名与页面一致', async () => {
    const { db } = fakeDb(() => [
      {
        id: new RecordId('ops_job', 'j9'),
        command: 'ops.x',
        state: 'running',
        actor_kind: 'owner',
        actor: 'owner-user',
        created_at: new Date('2025-01-02T03:04:05.000Z'),
        started_at: null,
        finished_at: null,
        runner: 'mac-1',
        input: JSON.stringify({ a: 1 }),
        result: JSON.stringify({ b: 2 }),
      },
    ]);
    const [view] = await listJobs(db, {});
    expect(view).toEqual({
      id: 'j9',
      command: 'ops.x',
      state: 'running',
      actorKind: 'owner',
      actor: 'owner-user',
      createdAt: '2025-01-02T03:04:05.000Z',
      startedAt: null,
      finishedAt: null,
      runner: 'mac-1',
      error: null,
    });
    expect(view).not.toHaveProperty('input');
    expect(view).not.toHaveProperty('result');
  });
});

describe('作业详情（jobDetail）', () => {
  test('记录不存在 → not_found', async () => {
    const { db } = fakeDb(() => []);
    const error = await errorOf(jobDetail(db, 'nope'));
    expect(error.code).toBe('not_found');
  });

  test('input 与 result 的 JSON 文本还原为对象', async () => {
    const { db, calls } = fakeDb(() => [
      {
        id: new RecordId('ops_job', 'j10'),
        command: 'ops.y',
        state: 'done',
        input: JSON.stringify({ name: 'w1', items: [1, 2] }),
        result: JSON.stringify({ ok: true }),
        error: null,
      },
    ]);
    const view = await jobDetail(db, 'j10');
    expect(view.id).toBe('j10');
    expect(view.state).toBe('done');
    expect(view.input).toEqual({ name: 'w1', items: [1, 2] });
    expect(view.result).toEqual({ ok: true });
    expect(view.error).toBeNull();
    expect(calls[0]!.vars.job).toBeInstanceOf(RecordId);
  });
});
