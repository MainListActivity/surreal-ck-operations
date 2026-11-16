// 公司网关 HTTP 客户端。pending 表示作业已入队，按作业 id 轮询 ops.job.get 直到结束或超时。
import { CORE_ERROR_CODES } from '../core-errors.ts';
import { clip, redactText } from '../ops/redact.ts';
import { isSecureBaseUrl } from './idp.ts';

export class GatewayError extends Error {
  readonly code: string;
  /** 业务命令已被网关接受（作业已排队）之后的失败：命令可能已在执行，调用方不得据此自动重新提交。 */
  readonly accepted: boolean;

  constructor(code: string, message: string, accepted = false) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.accepted = accepted;
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

const KNOWN_CODES = new Set([
  'unauthorized',
  'forbidden',
  'invalid',
  'not_found',
  'conflict',
  'unavailable',
  'pending',
  'upstream_error',
]);

function normalizeCode(code: unknown): string {
  return typeof code === 'string' && KNOWN_CODES.has(code) ? code : 'upstream_error';
}

/** 网关返回的错误文本只保留短段并脱敏，避免令牌经上游回显进入错误信息。 */
function safeMessage(message: unknown): string {
  return typeof message === 'string' ? redactText(clip(message, 200)) : '';
}

type Outcome = { ok: true; result: unknown } | { ok: false; code: string; message: string };

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
    if (first.code !== 'pending') throw new GatewayError(first.code, first.message);
    return this.poll(token, first.message).catch((error: unknown) => {
      throw acceptedError(error);
    });
  }

  private async poll(token: string, id: string): Promise<unknown> {
    if (typeof id !== 'string' || id === '') throw new GatewayError('upstream_error', '作业编号缺失');
    const started = this.now();
    for (;;) {
      const out = await this.send(token, 'ops.job.get', { id });
      if (!out.ok) {
        if (out.code !== 'pending') throw new GatewayError(out.code, out.message);
      } else {
        const job = parseJob(out.result, id);
        if (job.state === 'done') return job.result;
        if (job.state === 'error') {
          const failed = jobFailureOf(job.error);
          const detail = safeMessage(failed.detail);
          throw new GatewayError(failed.code, detail ? `作业执行失败：${detail}` : '作业执行失败');
        }
      }
      if (this.now() - started >= this.pollTimeoutMs) {
        throw new GatewayError('pending', '作业仍在执行，稍后再取');
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
      throw new GatewayError('upstream_error', `HTTP ${res.status}`);
    }
    if (!body || typeof body !== 'object') throw new GatewayError('upstream_error', '网关响应格式错误');
    const envelope = body as { ok?: unknown; result?: unknown; error?: unknown };
    if (envelope.ok === true) return { ok: true, result: envelope.result };
    if (envelope.ok === false && envelope.error && typeof envelope.error === 'object') {
      const err = envelope.error as { code?: unknown; message?: unknown };
      // pending 时 message 即作业 id，不做脱敏截断。
      const message = normalizeCode(err.code) === 'pending' ? String(err.message ?? '') : safeMessage(err.message);
      return { ok: false, code: normalizeCode(err.code), message };
    }
    throw new GatewayError('upstream_error', '网关响应格式错误');
  }
}

/** 作业已排队之后的任何失败，都以 accepted 形式交给调用方；未知的内部错误按上游失败处理，不回显原文。 */
function acceptedError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return new GatewayError(error.code, error.message, true);
  return new GatewayError('upstream_error', '作业取回失败', true);
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

function malformedJob(): GatewayError {
  return new GatewayError('upstream_error', '作业视图格式错误');
}

/**
 * ops.job.get 的结果是 {job: 作业视图}（owner-end/src/commands.ts）。id 必须与所查的作业一致，state 必须是四种之一；
 * 其它形状（包括没有包装的旧作业视图）一律按格式错误处理，不猜测。
 */
function parseJob(value: unknown, id: string): JobView {
  const job = typeof value === 'object' && value !== null ? (value as { job?: unknown }).job : undefined;
  if (typeof job !== 'object' || job === null || Array.isArray(job)) throw malformedJob();
  const view = job as Partial<JobView>;
  if (view.id !== id || !isJobState(view.state)) throw malformedJob();
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
