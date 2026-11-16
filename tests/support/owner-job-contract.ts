/**
 * 作业回执的共用替身。老板端的 ops.job.get 与待取回应用真实代码：owner-end/src/jobs.ts 的 jobGet（commands.ts 里的
 * ops.job.get 也调用它）、owner-end/src/errors.ts 的 failureOf、owner-end/src/jobs.ts 的 enqueueJob 与 PendingJob。
 * 执行端写回用真实写法：src/cloud/ops-jobs.ts 的 storeResult 与 failure。只有数据库是假的，内存里的一行就是 ops_job 的一条记录。
 * 这里不导入 commands.ts：它经 auth 的类型导入引入 jose，而根目录的类型检查在安装 owner-end 依赖之前运行（CI 如此）。
 * 客户端与 sidecar 的测试都从这里取回执，避免各写一份作业视图的假形状。
 */
import { RecordId, type Surreal } from 'surrealdb';
import { failureOf } from '../../owner-end/src/errors.ts';
import { enqueueJob, jobGet, PendingJob } from '../../owner-end/src/jobs.ts';
import { failure, storeResult } from '../../src/cloud/ops-jobs.ts';

/** 固定的时刻（与事故时间相同），让测试不依赖当前时间。 */
const NOW = new Date('2026-11-16T03:35:47Z');
const RUNNER = 'plugin:contract-test';

type Row = Record<string, unknown>;

/** 一次 HTTP 应答的状态与正文，与 owner-end 的 failureOf 同形。 */
export interface Reply {
  status: number;
  body: unknown;
}

export interface OwnerJobStore {
  /** 数据库替身：只实现 enqueueJob 的 CREATE 与 jobDetail 的 SELECT，其它语句直接报错。 */
  readonly db: Surreal;
  /** 排队一个执行端作业（真实的 enqueueJob），返回任务号。 */
  enqueue(command: string, input: Row): Promise<string>;
  /** 执行端认领并开始执行：state = running。 */
  start(id: string): void;
  /** 执行端写回成功：result 按 storeResult 存成 JSON 文本。 */
  succeed(id: string, value: unknown): void;
  /** 执行端写回失败：error 按 failure 存成 `${code}: ${message}`。 */
  fail(id: string, error: unknown): void;
  /** 直接改一行的字段，用来构造执行端未脱敏或格式不同的情形。 */
  patch(id: string, fields: Row): void;
  /** 删除一行，模拟查不到作业。 */
  remove(id: string): void;
  /** 老板端 ops.job.get：真实的 jobGet；错误经真实的 failureOf 映射为 HTTP 状态与正文。 */
  getJob(input: unknown): Promise<Reply>;
}

export function createOwnerJobStore(): OwnerJobStore {
  const rows = new Map<string, Row>();
  const db = {
    async query(sql: string, vars: Row = {}) {
      if (sql.startsWith('CREATE $job')) {
        const job = vars.job as RecordId;
        rows.set(String(job.id), { ...(vars.content as Row), id: job });
        return [[]];
      }
      if (sql === 'SELECT * FROM $job;') {
        const row = rows.get(String((vars.job as RecordId).id));
        return [row ? [row] : []];
      }
      throw new Error(`owner job store: unexpected statement ${sql}`);
    },
  } as unknown as Surreal;
  const update = (id: string, fields: Row) => {
    const row = rows.get(id);
    if (!row) throw new Error(`owner job store: no job ${id}`);
    Object.assign(row, fields);
  };
  return {
    db,
    enqueue: (command, input) => enqueueJob(db, { command, input, actorKind: 'owner', actor: 'owner-user' }, NOW),
    start: id => update(id, { state: 'running', runner: RUNNER, started_at: NOW }),
    succeed: (id, value) => update(id, { state: 'done', result: storeResult(value), runner: RUNNER, finished_at: NOW }),
    fail: (id, error) => update(id, { state: 'error', error: failure(error), runner: RUNNER, finished_at: NOW }),
    patch: update,
    remove: id => {
      rows.delete(id);
    },
    async getJob(input) {
      try {
        const result = await jobGet(db, input as Row);
        return { status: 200, body: { ok: true, result } };
      } catch (error) {
        return failureOf(error);
      }
    },
  };
}

/** 排队后的待取回应：owner-end 的 failureOf 对 PendingJob 给出的 202 与任务号。 */
export function pendingReply(id: string): Reply {
  return failureOf(new PendingJob(id));
}
