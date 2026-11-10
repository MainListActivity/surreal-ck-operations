import { describe, expect, test } from 'bun:test';
import { RecordId, type Surreal } from 'surrealdb';
import { OpsJobRunner, storeResult, type OpsJobDeps, type OpsJobState } from '../src/cloud/ops-jobs.ts';

// ---- 最小假库：只模拟执行器用到的三类语句，条件与真实 SQL 一致 ----
type Row = {
  id: RecordId;
  command: string;
  input?: unknown;
  actor?: unknown;
  task?: unknown;
  state: OpsJobState;
  runner?: string;
  result?: unknown;
  error?: unknown;
  created_at?: unknown;
};

function fakeDb(rows: Row[], options: { failCompleteFor?: string } = {}) {
  const find = (id: unknown) => rows.find(row => String(row.id) === String(id));
  const db = {
    async query(sql: string, vars: Record<string, unknown> = {}) {
      if (sql.startsWith('SELECT')) {
        // 真实查询带 LIMIT 100；假库不实现 LIMIT，故意返回全部，检验执行器自身的上限。
        return [rows.filter(row => row.state === 'queued').map(row => ({ ...row }))];
      }
      if (sql.includes("SET state = 'running'")) {
        const row = find(vars.job);
        if (row && row.state === 'queued') {
          Object.assign(row, { state: 'running', runner: vars.runner });
          return [[{ ...row }]];
        }
        return [[]];
      }
      if (sql.includes("SET state = 'done'") || sql.includes("SET state = 'error'")) {
        if (options.failCompleteFor && String(vars.id) === options.failCompleteFor) throw new Error('写回失败');
        const row = find(vars.id);
        if (row && row.state === 'running' && row.runner === vars.runner) {
          if (sql.includes("SET state = 'done'")) Object.assign(row, { state: 'done', result: vars.result });
          else Object.assign(row, { state: 'error', error: vars.error });
          return [[{ ...row }]];
        }
        return [[]];
      }
      throw new Error(`假库未识别的语句：${sql}`);
    },
  };
  return { db: db as unknown as Surreal, rows };
}

const job = (key: string, command: string, extra: Partial<Row> = {}): Row => ({
  id: new RecordId('ops_job', key),
  command,
  input: {},
  actor: 'agent-1',
  task: 'task-1',
  state: 'queued',
  ...extra,
});

function deps(over: Partial<OpsJobDeps> & { db: Surreal }): OpsJobDeps {
  return {
    runner: 'plugin:1',
    runnerOnlyCommands: new Set(['company.dashboard']),
    opsCall: async () => ({ ok: true }),
    runnerOnly: async () => ({ only: true }),
    hostExec: async () => ({ exitCode: 0 }),
    ...over,
  };
}

const find = (rows: Row[], key: string) => rows.find(row => String(row.id) === `ops_job:${key}`)!;
/** 作业 result 为 JSON 文本，解析回对象便于断言。 */
const parsedResult = (rows: Row[], key: string): unknown => JSON.parse(String(find(rows, key).result));

describe('路由与终态', () => {
  test('ops_*、runner-only、host.exec 各自路由到对应注入函数并写入 done', async () => {
    const calls: Array<[string, unknown]> = [];
    const rows = [
      job('ops', 'ops_info'),
      job('only', 'company.dashboard', { input: { a: 1 } }),
      job('host', 'host.exec', { input: { host: 'arm-free-1', command: 'echo hi', timeoutSec: 5 } }),
    ];
    const { db } = fakeDb(rows);
    const runner = new OpsJobRunner(deps({
      db,
      opsCall: async (j) => { calls.push(['opsCall', j]); return { tool: j.tool }; },
      runnerOnly: async (j) => { calls.push(['runnerOnly', j]); return { only: true }; },
      hostExec: async (i) => { calls.push(['hostExec', i]); return { exitCode: 0 }; },
    }));
    expect(await runner.drain()).toBe(3);
    expect(calls).toEqual([
      ['opsCall', { actor: 'agent-1', task: 'task-1', tool: 'ops_info', args: {} }],
      ['runnerOnly', { command: 'company.dashboard', input: { a: 1 } }],
      ['hostExec', { host: 'arm-free-1', command: 'echo hi', timeoutSec: 5 }],
    ]);
    expect(find(rows, 'ops')).toMatchObject({ state: 'done', runner: 'plugin:1', result: JSON.stringify({ tool: 'ops_info' }) });
    expect(parsedResult(rows, 'host')).toEqual({ exitCode: 0 });
  });

  test('未知命令得到 invalid 且消息为“未知命令”', async () => {
    const rows = [job('x', 'rm.everything')];
    const runner = new OpsJobRunner(deps({ db: fakeDb(rows).db }));
    expect(await runner.drain()).toBe(1);
    expect(find(rows, 'x')).toMatchObject({ state: 'error' });
    expect(find(rows, 'x').error).toBe('invalid: 未知命令');
  });

  test('ops_* 缺 task 或 task 为空：invalid，且不调用 opsCall', async () => {
    let called = 0;
    const rows = [job('none', 'ops_info', { task: undefined }), job('blank', 'ops_info', { task: '  ' })];
    const runner = new OpsJobRunner(deps({ db: fakeDb(rows).db, opsCall: async () => { called++; return {}; } }));
    await runner.drain();
    expect(called).toBe(0);
    expect(find(rows, 'none')).toMatchObject({ state: 'error' });
    expect(find(rows, 'blank')).toMatchObject({ state: 'error' });
    expect(typeof find(rows, 'none').error).toBe('string');
    expect(String(find(rows, 'none').error).startsWith('invalid: ')).toBe(true);
    expect(String(find(rows, 'blank').error).startsWith('invalid: ')).toBe(true);
  });

  test('actor 缺失或为空：state=error，error 为说明原因的字符串，且不调用任何注入函数', async () => {
    let called = 0;
    const count = async () => { called++; return {}; };
    const rows = [
      job('no_actor', 'ops_info', { actor: undefined }),
      job('blank_actor', 'ops_info', { actor: '   ' }),
      job('host_no_actor', 'host.exec', { actor: undefined, input: { host: 'arm-free-1', command: 'echo hi' } }),
    ];
    const runner = new OpsJobRunner(deps({ db: fakeDb(rows).db, opsCall: count, hostExec: count }));
    expect(await runner.drain()).toBe(3);
    expect(called).toBe(0);
    for (const key of ['no_actor', 'blank_actor', 'host_no_actor']) {
      const row = find(rows, key);
      expect(row.state).toBe('error');
      expect(typeof row.error).toBe('string');
      expect(String(row.error)).toMatch(/^invalid: .*actor/);
    }
  });

  test('作业 input 为 JSON 文本时解析后传给注入函数', async () => {
    let seen: unknown;
    const rows = [job('txt', 'ops_info', { input: '{"k":1}' })];
    const runner = new OpsJobRunner(deps({ db: fakeDb(rows).db, opsCall: async (j) => { seen = j.args; return {}; } }));
    await runner.drain();
    expect(seen).toEqual({ k: 1 });
  });

  test('input 不是合法 JSON 文本：invalid，不调用注入函数', async () => {
    let called = 0;
    const rows = [job('bad_json', 'ops_info', { input: '{oops' })];
    const runner = new OpsJobRunner(deps({ db: fakeDb(rows).db, opsCall: async () => { called++; return {}; } }));
    await runner.drain();
    expect(called).toBe(0);
    expect(find(rows, 'bad_json').error).toBe('invalid: input 不是合法的 JSON 文本');
  });

  test('RecordId 形式的 actor 与 task 取其 id 字段的字符串', async () => {
    let seen: unknown;
    const rows = [job('rid', 'ops_info', { actor: new RecordId('agent', 'agent-9'), task: new RecordId('task', 'task-7') })];
    const runner = new OpsJobRunner(deps({ db: fakeDb(rows).db, opsCall: async (j) => { seen = j; return {}; } }));
    await runner.drain();
    expect(seen).toEqual({ actor: 'agent-9', task: 'task-7', tool: 'ops_info', args: {} });
  });
});

describe('作业字段形状（058）', () => {
  test('成功作业的 result 是可 JSON.parse 的字符串，error 为空', async () => {
    const rows = [job('shape', 'ops_info')];
    const runner = new OpsJobRunner(deps({ db: fakeDb(rows).db, opsCall: async () => ({ ok: true }) }));
    await runner.drain();
    const stored = find(rows, 'shape');
    expect(typeof stored.result).toBe('string');
    expect(JSON.parse(String(stored.result))).toEqual({ ok: true });
    expect(stored.error).toBeUndefined();
  });

  test('失败作业的 error 是字符串 `${code}: ${message}`，不是对象', async () => {
    const rows = [job('str_err', 'ops_info')];
    const runner = new OpsJobRunner(deps({
      db: fakeDb(rows).db,
      opsCall: async () => { throw Object.assign(new Error('boom'), { code: 'no_lease' }); },
    }));
    await runner.drain();
    expect(find(rows, 'str_err').error).toBe('no_lease: boom');
  });

  test('error 中的 Bearer 令牌、URL 凭证与 sk- 密钥均被脱敏，整体不超过 500 字符', async () => {
    const rows = [job('scrub', 'ops_info')];
    const runner = new OpsJobRunner(deps({
      db: fakeDb(rows).db,
      opsCall: async () => {
        throw Object.assign(new Error(`Bearer abc.def-ghi https://user:hunter2pass@example.com/x ${'y'.repeat(900)} sk-test-secret-123`), { code: 'upstream' });
      },
    }));
    await runner.drain();
    const error = String(find(rows, 'scrub').error);
    expect(typeof find(rows, 'scrub').error).toBe('string');
    expect(error.startsWith('upstream: ')).toBe(true);
    expect(error).not.toContain('abc.def-ghi');
    expect(error).not.toContain('hunter2pass');
    expect(error).not.toContain('sk-test-secret-123');
    expect(error.length).toBeLessThanOrEqual(500);
  });

  test('storeResult 对超过 64 KiB 的结果返回整体合法的 JSON 文本，且不超过上限', () => {
    const text = storeResult({ blob: '"\n'.repeat(40000) });
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    const parsed = JSON.parse(text) as { truncated: boolean; preview: string };
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.preview).toBe('string');
  });
});

describe('host.exec 输入校验', () => {
  const badHost: Array<[string, unknown]> = [
    ['host 非字符串', { host: 1, command: 'ls' }],
    ['command 为空', { host: 'arm-free-1', command: '   ' }],
    ['command 含 NUL', { host: 'arm-free-1', command: 'ls\u0000' }],
    ['command 超过 8192 字节', { host: 'arm-free-1', command: 'a'.repeat(8193) }],
    ['timeoutSec 为 0', { host: 'arm-free-1', command: 'ls', timeoutSec: 0 }],
    ['timeoutSec 为 901', { host: 'arm-free-1', command: 'ls', timeoutSec: 901 }],
    ['timeoutSec 为小数', { host: 'arm-free-1', command: 'ls', timeoutSec: 1.5 }],
    ['timeoutSec 为字符串', { host: 'arm-free-1', command: 'ls', timeoutSec: '3' }],
  ];
  test.each(badHost)('host.exec：%s → invalid，不调用 hostExec', async (_, input) => {
    let called = 0;
    const rows = [job('h', 'host.exec', { input })];
    const runner = new OpsJobRunner(deps({ db: fakeDb(rows).db, hostExec: async () => { called++; return {}; } }));
    await runner.drain();
    expect(called).toBe(0);
    expect(find(rows, 'h')).toMatchObject({ state: 'error' });
    expect(String(find(rows, 'h').error).startsWith('invalid: ')).toBe(true);
  });

});

describe('结果体积与脱敏', () => {
  test('超过 64 KiB 的结果存为 preview 形式，preview 不含注入的密钥样式字符串', async () => {
    const rows = [job('big', 'ops_info')];
    const runner = new OpsJobRunner(deps({
      db: fakeDb(rows).db,
      opsCall: async () => ({ note: 'sk-test-secret-123', blob: 'a'.repeat(70000) }),
    }));
    await runner.drain();
    const stored = find(rows, 'big');
    expect(stored.state).toBe('done');
    expect(typeof stored.result).toBe('string');
    const result = JSON.parse(String(stored.result)) as { truncated: boolean; preview: string };
    expect(result.truncated).toBe(true);
    expect(typeof result.preview).toBe('string');
    expect(Buffer.byteLength(String(stored.result), 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(String(stored.result)).not.toContain('sk-test-secret-123');
    expect(result.preview).toContain('[redacted]');
  });

  test('长串字母的结果脱敏耗时线性增长（URL 凭证正则不得平方级回溯）', () => {
    const started = performance.now();
    storeResult({ blob: 'a'.repeat(128 * 1024) });
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test('未超过上限的结果脱敏后作为 JSON 文本存入', () => {
    const stored = storeResult({ note: 'sk-test-secret-123', n: 1 });
    expect(typeof stored).toBe('string');
    expect(JSON.parse(stored)).toEqual({ note: '[redacted]', n: 1 });
    expect(stored).not.toContain('sk-test-secret-123');
  });

  test('协议名超过 64 字符时，URL 中的凭证仍被脱敏', () => {
    const stored = storeResult({ note: `a${'1'.repeat(70)}://user:pass@host.example/x` });
    expect(stored).not.toContain('user:pass');
    expect(stored).toContain('@host.example/x');
  });

  test('注入函数抛出的错误：沿用字符串 code，message 脱敏且不超过 200 字符', async () => {
    const rows = [job('e1', 'ops_info')];
    const runner = new OpsJobRunner(deps({
      db: fakeDb(rows).db,
      opsCall: async () => {
        throw Object.assign(new Error(`令牌 sk-test-secret-123 ${'x'.repeat(500)}`), { code: 'no_lease' });
      },
    }));
    await runner.drain();
    const error = find(rows, 'e1').error;
    expect(typeof error).toBe('string');
    expect(String(error).startsWith('no_lease: ')).toBe(true);
    expect(String(error)).not.toContain('sk-test-secret-123');
    expect(String(error).length).toBeLessThanOrEqual(500);
  });

  test('没有字符串 code 的错误归为 upstream_error', async () => {
    const rows = [job('e2', 'ops_info')];
    const runner = new OpsJobRunner(deps({
      db: fakeDb(rows).db,
      opsCall: async () => { throw Object.assign(new Error('boom'), { code: 42 }); },
    }));
    await runner.drain();
    expect(find(rows, 'e2').error).toBe('upstream_error: boom');
  });
});

describe('drain 行为', () => {
  test('单飞：执行中再次调用返回同一个 promise，注入函数只被调用一次', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rows = [job('s', 'ops_info')];
    const runner = new OpsJobRunner(deps({
      db: fakeDb(rows).db,
      opsCall: async () => { calls++; await gate; return {}; },
    }));
    const first = runner.drain();
    const second = runner.drain();
    expect(second).toBe(first);
    release();
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(calls).toBe(1);
  });

  test('执行中再次 drain：本轮结束后补跑一轮，处理本轮开始之后入队的作业', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rows = [job('first', 'ops_info')];
    const runner = new OpsJobRunner(deps({
      db: fakeDb(rows).db,
      opsCall: async () => { await gate; return {}; },
    }));
    const running = runner.drain();
    // 第一轮的查询已经发出，之后才入队的作业只能由补跑的一轮处理。
    rows.push(job('late', 'ops_info'));
    expect(runner.drain()).toBe(running);
    release();
    expect(await running).toBe(2);
    expect(find(rows, 'first').state).toBe('done');
    expect(find(rows, 'late').state).toBe('done');
  });

  test('一轮结束后再 drain 会开始新的一轮，不沿用已结束的 promise', async () => {
    const rows = [job('a', 'ops_info')];
    const runner = new OpsJobRunner(deps({ db: fakeDb(rows).db }));
    expect(await runner.drain()).toBe(1);
    rows.push(job('b', 'ops_info'));
    expect(await runner.drain()).toBe(1);
    expect(find(rows, 'b').state).toBe('done');
  });

  test('认领失败（已被别的执行端认领）时跳过，不计数、不调用', async () => {
    let called = 0;
    // 作业在 SELECT 之后、认领之前已被别的执行端认领：假库的 SELECT 仍返回 queued，认领语句返回空。
    const rows = [job('lost', 'ops_info', { state: 'running', runner: 'plugin:other' })];
    const base = fakeDb(rows).db as unknown as { query: (sql: string, vars?: Record<string, unknown>) => Promise<unknown> };
    const staleSelect = {
      query: (sql: string, vars?: Record<string, unknown>) =>
        sql.startsWith('SELECT') ? Promise.resolve([[{ ...rows[0], state: 'queued', runner: undefined }]]) : base.query(sql, vars),
    };
    const runner = new OpsJobRunner(deps({
      db: staleSelect as unknown as Surreal,
      opsCall: async () => { called++; return {}; },
    }));
    expect(await runner.drain()).toBe(0);
    expect(called).toBe(0);
  });

  test('每轮最多处理 100 个作业', async () => {
    let called = 0;
    const rows = Array.from({ length: 150 }, (_, i) => job(`n${i}`, 'ops_info'));
    const runner = new OpsJobRunner(deps({ db: fakeDb(rows).db, opsCall: async () => { called++; return {}; } }));
    expect(await runner.drain()).toBe(100);
    expect(called).toBe(100);
  });

  test('单个作业写回异常不中断整轮，记录日志后继续处理其余作业', async () => {
    const logs: string[] = [];
    const rows = [job('bad', 'ops_info'), job('good', 'ops_info')];
    const runner = new OpsJobRunner(deps({
      db: fakeDb(rows, { failCompleteFor: 'ops_job:bad' }).db,
      log: (message) => logs.push(message),
    }));
    expect(await runner.drain()).toBe(1);
    expect(find(rows, 'good').state).toBe('done');
    expect(logs.some(line => line.includes('ops_job:bad'))).toBe(true);
  });
});

describe('多执行端的认领归属', () => {
  test('ops_* 作业：本机持有租约时认领并执行', async () => {
    const rows = [job('mine', 'ops_info', { created_at: new Date() })];
    const runner = new OpsJobRunner(deps({ db: fakeDb(rows).db, holds: () => true }));
    expect(await runner.drain()).toBe(1);
    expect(find(rows, 'mine').state).toBe('done');
  });

  test('ops_* 作业：本机不持有租约且入队不久，保持 queued，不调用 opsCall', async () => {
    let called = 0;
    const rows = [job('other', 'ops_info', { created_at: new Date() })];
    const runner = new OpsJobRunner(deps({
      db: fakeDb(rows).db,
      holds: () => false,
      opsCall: async () => { called++; return {}; },
    }));
    expect(await runner.drain()).toBe(0);
    expect(called).toBe(0);
    expect(find(rows, 'other').state).toBe('queued');
  });

  test('ops_* 作业：本机不持有但入队已超过窗口，认领后由 opsCall 的 no_lease 写回错误', async () => {
    const rows = [job('stale', 'ops_info', { created_at: new Date(Date.now() - 300_000) })];
    const runner = new OpsJobRunner(deps({
      db: fakeDb(rows).db,
      holds: () => false,
      opsCall: async () => { throw Object.assign(new Error('员工没有这个任务的租约'), { code: 'no_lease' }); },
    }));
    expect(await runner.drain()).toBe(1);
    expect(find(rows, 'stale').state).toBe('error');
    expect(find(rows, 'stale').error).toBe('no_lease: 员工没有这个任务的租约');
  });

  test('非 ops_* 作业不受归属判断影响：本机不持有租约也照常执行', async () => {
    const rows = [job('dash', 'company.dashboard', { created_at: new Date() })];
    const runner = new OpsJobRunner(deps({ db: fakeDb(rows).db, holds: () => false }));
    expect(await runner.drain()).toBe(1);
    expect(find(rows, 'dash').state).toBe('done');
  });
});
