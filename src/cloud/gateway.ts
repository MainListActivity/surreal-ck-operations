// 公司网关 HTTP 客户端。pending 表示作业已入队，按作业 id 轮询 ops.job.get 直到结束或超时。
import { CORE_ERROR_CODES } from '../core-errors.ts';
import { clip, redactText } from '../ops/redact.ts';
import { isSecureBaseUrl } from './idp.ts';

export class GatewayError extends Error {
  readonly code: string;
  /** 业务命令已被网关接受（作业已排队）之后的失败：命令可能已在执行，调用方不得据此自动重新提交。 */
  readonly accepted: boolean;
  /** 作业编号。作业已排队时带上，调用方凭它用 ops.job.get 查询，不必重新提交。 */
  readonly jobId?: string;
  /** 登录流程中失败的阶段（authorize、login、consent、exchange），执行端说明里有才带上。 */
  readonly stage?: string;

  constructor(code: string, message: string, accepted = false, facts: { jobId?: string; stage?: string } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.accepted = accepted;
    this.jobId = facts.jobId;
    this.stage = facts.stage;
  }
}

export interface GatewayOptions {
  url: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number; // 默认 1000
  pollTimeoutMs?: number; // 默认 900000
  now?: () => number;
}

/** 回执里认识的错误码：接口码，加上执行端作业失败时保留的公司错误码（如 login_failed）。 */
const KNOWN_CODES: ReadonlySet<string> = new Set<string>([...CORE_ERROR_CODES, 'pending']);

/** 超时类的 HTTP 状态：这类响应没有回执，无法判断作业是否已排队。 */
const TIMEOUT_STATUS: ReadonlySet<number> = new Set([408, 504, 524]);

function normalizeCode(code: unknown): string {
  return typeof code === 'string' && KNOWN_CODES.has(code) ? code : 'upstream_error';
}

/** 网关返回的错误文本只保留短段并脱敏，避免令牌经上游回显进入错误信息。 */
function safeMessage(message: unknown): string {
  return typeof message === 'string' ? redactText(clip(message, 200)) : '';
}

/** 登录流程的阶段标记 stage=…（src/ops/idp.ts 写入）。阶段只会是这四个之一；说明被截断时仍从原文取。 */
const STAGE_MARK = /\bstage=(authorize|login|consent|exchange)\b/;

function stageOf(text: string): string | undefined {
  return STAGE_MARK.exec(text)?.[1];
}

/** 回执正文的 JSON 类型。只说类型，不回显内容，便于排查又不泄露。 */
function kindOf(value: unknown): string {
  if (value === null || value === undefined) return '空值';
  if (Array.isArray(value)) return '数组';
  if (typeof value === 'string') return '字符串';
  if (typeof value === 'number') return '数字';
  if (typeof value === 'boolean') return '布尔值';
  return '对象';
}

type Outcome =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string; jobId?: string; stage?: string };

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class GatewayClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly pollTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: GatewayOptions) {
    if (!isSecureBaseUrl(options.url)) throw new GatewayError('invalid', '网关地址必须是 https，或本机 http');
    this.url = options.url.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.pollMs = options.pollMs ?? 1000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 900_000;
    this.now = options.now ?? Date.now;
  }

  /** 调用网关命令；pending 时轮询同一个作业直到 done / error / 超时。业务命令只提交一次，作业入队后的失败都标为 accepted。 */
  async call(token: string, command: string, input?: unknown): Promise<unknown> {
    if (typeof command !== 'string' || command.trim() === '' || command.length > 128) {
      throw new GatewayError('invalid', '命令名不合法');
    }
    const first = await this.send(token, command, input);
    if (first.ok) return first.result;
    if (first.code === 'pending') {
      const jobId = first.jobId ?? first.message;
      return this.poll(token, jobId).catch((error: unknown) => {
        throw acceptedError(error, jobId);
      });
    }
    // 同步路径：执行端在等待时限内就结束了作业。回执带 jobId 即表示作业已排队，按已受理处理，调用方不得重提。
    if (first.jobId !== undefined) {
      throw new GatewayError(first.code, first.message, true, { jobId: first.jobId, stage: first.stage });
    }
    throw new GatewayError(first.code, first.message);
  }

  private async poll(token: string, id: string): Promise<unknown> {
    if (typeof id !== 'string' || id === '') throw new GatewayError('upstream_error', '作业编号缺失');
    const started = this.now();
    for (;;) {
      const out = await this.send(token, 'ops.job.get', { id });
      if (!out.ok) {
        if (out.code !== 'pending') throw new GatewayError(out.code, out.message, false, { jobId: id });
      } else {
        const job = parseJob(out.result, id);
        if (job.state === 'done') return job.result;
        if (job.state === 'error') {
          const failed = jobFailureOf(job.error);
          const detail = safeMessage(failed.detail);
          throw new GatewayError(failed.code, detail ? `作业执行失败：${detail}` : '作业执行失败', false,
            { jobId: id, stage: stageOf(failed.detail) });
        }
      }
      if (this.now() - started >= this.pollTimeoutMs) {
        throw new GatewayError('pending', '作业仍在执行，稍后再取', false, { jobId: id });
      }
      await this.sleep(this.pollMs);
    }
  }

  private async send(token: string, command: string, input: unknown): Promise<Outcome> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/api/cmd`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ command, input }),
      });
    } catch {
      throw new GatewayError('unavailable', '网关不可达');
    }

    const text = await res.text().catch(() => '');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // 超时或上游的错误页：没有回执，不能说明作业是否已排队。正文不回显。
      const label = TIMEOUT_STATUS.has(res.status) ? '网关超时' : '网关返回了非 JSON 响应';
      throw new GatewayError('upstream_error', `${label}（HTTP ${res.status}），没有可读的回执`);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new GatewayError('upstream_error', `网关响应不是对象（HTTP ${res.status}，正文为${kindOf(body)}）`);
    }
    const envelope = body as { ok?: unknown; result?: unknown; error?: unknown };
    if (envelope.ok === true) return { ok: true, result: envelope.result };
    if (envelope.ok !== false) throw new GatewayError('upstream_error', `网关响应缺少 ok 字段（HTTP ${res.status}）`);
    // 数组也不是错误对象：否则会得到没有码、没有说明的失败。
    if (!envelope.error || typeof envelope.error !== 'object' || Array.isArray(envelope.error)) {
      throw new GatewayError('upstream_error', `网关返回的错误格式不标准（HTTP ${res.status}，error 为${kindOf(envelope.error)}）`);
    }
    const err = envelope.error as { code?: unknown; message?: unknown; jobId?: unknown; jobCode?: unknown };
    const jobId = typeof err.jobId === 'string' && err.jobId !== '' && err.jobId.length <= 200 ? err.jobId : undefined;
    // 执行端作业失败时 jobCode 是作业的公司错误码（如 login_failed），按它还原类别；code 只是接口码。
    const code = normalizeCode(err.jobCode ?? err.code);
    const raw = typeof err.message === 'string' ? err.message : '';
    // pending 时 message 即作业 id，不做脱敏截断。
    if (code === 'pending') return { ok: false, code, message: raw, jobId };
    // 阶段从截断前的原文取，截断只影响说明文字。
    const stage = jobId === undefined ? undefined : stageOf(raw);
    return { ok: false, code, message: safeMessage(raw), jobId, stage };
  }
}

/** 作业已排队之后的任何失败，都以 accepted 形式交给调用方；未知的内部错误按上游失败处理，不回显原文。 */
function acceptedError(error: unknown, jobId: string): GatewayError {
  if (error instanceof GatewayError) {
    return new GatewayError(error.code, error.message, true, { jobId: error.jobId ?? jobId, stage: error.stage });
  }
  return new GatewayError('upstream_error', '作业取回失败', true, { jobId });
}

type JobState = 'queued' | 'running' | 'done' | 'error';

interface JobView {
  id: string;
  state: JobState;
  result?: unknown;
  error?: unknown;
}

function isJobState(value: unknown): value is JobState {
  return value === 'queued' || value === 'running' || value === 'done' || value === 'error';
}

function malformedJob(id: string, reason: string): GatewayError {
  return new GatewayError('upstream_error', `作业视图格式错误：${reason}`, false, { jobId: id });
}

/**
 * ops.job.get 的结果是 {job: 作业视图}（owner-end/src/commands.ts）。id 必须与所查的作业一致，state 必须是四种之一；
 * 其它形状（包括没有包装的旧作业视图）一律按格式错误处理，不猜测。说明写明是哪一项不符，不回显内容。
 */
function parseJob(value: unknown, id: string): JobView {
  const wrapper = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as { job?: unknown } : undefined;
  if (wrapper === undefined || !('job' in wrapper)) throw malformedJob(id, '缺少 job 包装');
  const job = wrapper.job;
  if (typeof job !== 'object' || job === null || Array.isArray(job)) throw malformedJob(id, 'job 不是对象');
  const view = job as Partial<JobView>;
  if (view.id === undefined) throw malformedJob(id, '缺少作业号');
  if (view.id !== id) throw malformedJob(id, '作业号与所查的作业不一致');
  if (!isJobState(view.state)) throw malformedJob(id, '作业状态不认识');
  return view as JobView;
}

/** 执行端把失败写成 `${code}: ${message}` 一句话（src/cloud/ops-jobs.ts 的 failure）。 */
const JOB_FAILURE = /^([A-Za-z_][A-Za-z0-9_]*): ([\s\S]*)$/;

/**
 * 还原作业失败的类别与说明。码在公司错误码之内则原样保留；不认识的码按上游失败，说明保留。
 * 不是这一句话格式的（例如存成了 JSON）不猜测类别，也不回显原文。
 */
function jobFailureOf(error: unknown): { code: string; detail: string } {
  const match = typeof error === 'string' ? JOB_FAILURE.exec(error) : null;
  if (!match) return { code: 'upstream_error', detail: '' };
  const [, token = '', detail = ''] = match;
  return { code: (CORE_ERROR_CODES as readonly string[]).includes(token) ? token : 'upstream_error', detail };
}
