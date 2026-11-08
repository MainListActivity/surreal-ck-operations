/**
 * 执行端任务队列（ops_job）。只有执行端（本机服务）能执行的命令先排队，网关最多等 25 秒，
 * 超时返回 pending 与 jobId，之后用 ops.job.get 取结果。
 * 执行端把 state 改为 running，完成后写 result（done）或 error（error）。input、result、error 按 058 存 JSON 文本。
 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from '../../src/core-errors.ts';
import { boundedInt, isoOf, keyOf, parsedJson, type Row } from './rows.ts';

export const JOB_WAIT_MS = 25_000;
const POLL_MS = 500;

export type JobState = 'queued' | 'running' | 'done' | 'error';

export interface JobRequest {
  command: string;
  input: Record<string, unknown>;
  actorKind: 'owner' | 'agent';
  actor: string;
  task?: string;
}

export interface JobRecord {
  id: string;
  command: string;
  state: JobState;
  result?: unknown;
  error?: unknown;
  actor_kind?: string;
  actor?: string;
  created_at?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  runner?: string;
}

export type JobOutcome =
  | { state: 'done'; result: unknown }
  | { state: 'error'; code: string; message: string }
  | { state: 'pending' };

/** 等待超时：任务仍在队列或执行中，调用方应返回 202 并附 jobId。 */
export class PendingJob extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super('执行端尚未完成，请稍后用 ops.job.get 取结果');
    this.name = 'PendingJob';
    this.jobId = jobId;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 排队一个执行端任务，返回 jobId。 */
export async function enqueueJob(db: Surreal, job: JobRequest, now: Date = new Date()): Promise<string> {
  const id = crypto.randomUUID();
  const content: Record<string, unknown> = {
    command: job.command,
    input: JSON.stringify(job.input),
    actor_kind: job.actorKind,
    actor: job.actor,
    state: 'queued',
    created_at: now,
  };
  if (job.task) content.task = new RecordId('task', job.task);
  await db.query('CREATE $job CONTENT $content;', { job: new RecordId('ops_job', id), content });
  return id;
}

/** 文本列里的 JSON 尽量还原为对象；不是 JSON 的原样返回。 */
function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** 读取一个任务；不存在时返回 undefined。 */
export async function readJob(db: Surreal, id: string): Promise<JobRecord | undefined> {
  const [rows] = await db.query<[JobRecord[]]>('SELECT * FROM $job;', { job: new RecordId('ops_job', id) });
  const row = rows?.[0];
  if (!row) return undefined;
  return { ...row, id, result: parsed(row.result), error: parsed(row.error) };
}

type ErrorCode = ConstructorParameters<typeof CompanyError>[0];

/**
 * 全部 CompanyError 错误码（与 src/core-errors.ts 的联合类型一致）。执行端记录的错误码都来自 CompanyError，
 * 漏掉的码会被当成上游失败（502），所以下面的类型断言保证这份列表与联合类型同步。
 */
export const CORE_ERROR_CODES = [
  'unauthorized', 'forbidden', 'not_found', 'conflict', 'invalid', 'worktree_busy', 'already_claimed', 'lease_expired',
  'self_review', 'temporarily_unavailable', 'checkpoint_limit', 'not_configured', 'unavailable', 'payment_approval_required',
  'upstream_error', 'login_failed', 'limit_reached', 'response_too_large', 'snapshot_gone', 'retire_refused',
] as const satisfies readonly ErrorCode[];

/** 编译期检查：联合类型里的每个码都在上面的列表里；少列一个，这一行就是类型错误。 */
type AssertNever<T extends never> = T;
export type UnlistedErrorCode = AssertNever<Exclude<ErrorCode, (typeof CORE_ERROR_CODES)[number]>>;

const KNOWN_CODES: ReadonlySet<string> = new Set<string>(CORE_ERROR_CODES);

function errorFields(value: unknown): { code: string; message: string } {
  const record = typeof value === 'object' && value !== null ? value as { code?: unknown; message?: unknown } : {};
  return {
    code: typeof record.code === 'string' ? record.code : 'upstream_error',
    message: typeof record.message === 'string' ? record.message : '执行端任务失败',
  };
}

/** 把执行端记录的失败还原为 CompanyError，供接口统一映射。未知错误码按上游失败处理。 */
export function jobFailure(outcome: { code: string; message: string }): CompanyError {
  const code = KNOWN_CODES.has(outcome.code) ? outcome.code as ErrorCode : 'upstream_error';
  return new CompanyError(code, outcome.message);
}

/** 等待任务结束，最多 waitMs 毫秒。 */
export async function waitForJob(db: Surreal, id: string, waitMs = JOB_WAIT_MS): Promise<JobOutcome> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const job = await readJob(db, id);
    if (job?.state === 'done') return { state: 'done', result: job.result };
    if (job?.state === 'error') return { state: 'error', ...errorFields(job.error) };
    if (Date.now() >= deadline) return { state: 'pending' };
    await sleep(POLL_MS);
  }
}

export const JOB_STATES: readonly JobState[] = ['queued', 'running', 'done', 'error'];

/** 页面看到的作业（字段名与页面一致）。列表不带 input 与 result，详情带。 */
export interface JobView {
  id: string;
  command: string;
  state: JobState;
  actorKind: string | null;
  actor: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  runner: string | null;
  error: unknown;
  input?: unknown;
  result?: unknown;
}

const textOrNull = (value: unknown): string | null => typeof value === 'string' && value ? value : null;

function viewOf(row: Row, detail: boolean): JobView {
  const view: JobView = {
    id: keyOf(row.id),
    command: String(row.command ?? ''),
    state: String(row.state) as JobState,
    actorKind: textOrNull(row.actor_kind),
    actor: textOrNull(row.actor),
    createdAt: isoOf(row.created_at),
    startedAt: isoOf(row.started_at),
    finishedAt: isoOf(row.finished_at),
    runner: textOrNull(row.runner),
    error: parsedJson(row.error) ?? null,
  };
  if (detail) {
    view.input = parsedJson(row.input) ?? null;
    view.result = parsedJson(row.result) ?? null;
  }
  return view;
}

/** 作业列表，新的在前；state 可选筛选。 */
export async function listJobs(db: Surreal, input: Record<string, unknown>): Promise<JobView[]> {
  const limit = boundedInt(input.limit, 50, 200);
  const state = input.state === undefined || input.state === null || input.state === '' ? undefined : String(input.state);
  if (state !== undefined && !JOB_STATES.includes(state as JobState)) throw new CompanyError('invalid', 'state invalid');
  const [rows] = await db.query<[Row[]]>(
    `SELECT * FROM ops_job ${state ? 'WHERE state = $state' : ''} ORDER BY created_at DESC LIMIT $limit;`,
    { limit, ...(state ? { state } : {}) });
  return (rows ?? []).map((row) => viewOf(row, false));
}

/**
 * 作业是否由该员工发起（员工取作业详情时用：只能取自己的）。作业不存在、id 不合法都视为否，不泄露作业是否存在。
 */
export async function jobOwnedBy(db: Surreal, id: unknown, employee: string): Promise<boolean> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return false;
  const [rows] = await db.query<[Array<{ actor_kind?: unknown; actor?: unknown }>]>(
    'SELECT actor_kind, actor FROM $job;', { job: new RecordId('ops_job', id) });
  const row = rows?.[0];
  return row?.actor_kind === 'agent' && row.actor === employee;
}

/** 单个作业的详情（含 input 与 result）；不存在即 not_found。 */
export async function jobDetail(db: Surreal, id: string): Promise<JobView> {
  const [rows] = await db.query<[Row[]]>('SELECT * FROM $job;', { job: new RecordId('ops_job', id) });
  const row = rows?.[0];
  if (!row) throw new CompanyError('not_found', 'job not found');
  return viewOf(row, true);
}
