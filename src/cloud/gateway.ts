// 公司网关 HTTP 客户端。pending 表示作业已入队，按作业 id 轮询 ops.job.get 直到结束或超时。
import { clip, redactText } from '../ops/redact.ts';
import { isSecureBaseUrl } from './idp.ts';

export class GatewayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
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

  /** 调用网关命令；pending 时轮询作业直到 done / error / 超时。 */
  async call(token: string, command: string, input?: unknown): Promise<unknown> {
    if (typeof command !== 'string' || command.trim() === '' || command.length > 128) {
      throw new GatewayError('invalid', '命令名不合法');
    }
    const first = await this.send(token, command, input);
    if (first.ok) return first.result;
    if (first.code !== 'pending') throw new GatewayError(first.code, first.message);
    return this.poll(token, first.message);
  }

  private async poll(token: string, id: string): Promise<unknown> {
    if (typeof id !== 'string' || id === '') throw new GatewayError('upstream_error', '作业编号缺失');
    const started = this.now();
    for (;;) {
      const out = await this.send(token, 'ops.job.get', { id });
      if (!out.ok) {
        if (out.code !== 'pending') throw new GatewayError(out.code, out.message);
      } else {
        const job = parseJob(out.result);
        if (job.state === 'done') return job.result;
        if (job.state === 'error') {
          const detail = safeMessage(job.error?.message);
          throw new GatewayError(normalizeCode(job.error?.code), detail ? `作业执行失败：${detail}` : '作业执行失败');
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

interface JobView {
  id: string;
  state: 'queued' | 'running' | 'done' | 'error';
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function parseJob(value: unknown): JobView {
  if (!value || typeof value !== 'object') throw new GatewayError('upstream_error', '作业视图格式错误');
  const job = value as Partial<JobView>;
  if (job.state !== 'queued' && job.state !== 'running' && job.state !== 'done' && job.state !== 'error') {
    throw new GatewayError('upstream_error', '作业视图格式错误');
  }
  return job as JobView;
}
