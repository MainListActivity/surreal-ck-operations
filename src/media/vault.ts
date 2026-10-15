// Client for sck-vault, the one process that holds the ElevenLabs key. Requests are newline-delimited JSON over a
// local Unix socket. A reply carries the upstream status and body only; the key never reaches this side.
import { Socket } from 'node:net';
import { CompanyError } from '../core-errors.ts';

export interface VaultReply {
  status: number;
  contentType: string;
  body: Buffer;
  /** Whitelisted upstream headers (e.g. idempotency-replayed); never carries secrets. */
  headers?: Record<string, string>;
}
export interface VaultStatus {
  configured: boolean;
  /** Per-provider state keyed by name; each entry carries a short SHA-256 fingerprint of the key on file. */
  providers?: Record<string, { configured: boolean; keyFp?: string }>;
}
export interface MediaVault {
  status(): Promise<VaultStatus>;
  call(kind: string, params: Record<string, unknown>): Promise<VaultReply>;
}

/** Music generation can take minutes upstream, so the reply window is longer than the vault's own timeouts. */
const REPLY_MS = 330_000;
const CODES: Partial<Record<string, CompanyError['code']>> = {
  forbidden: 'forbidden', invalid: 'invalid', busy: 'temporarily_unavailable', upstream_error: 'upstream_error', limit_reached: 'limit_reached',
};

export class VaultClient implements MediaVault {
  constructor(private readonly socketPath: string) {}

  async status(): Promise<VaultStatus> {
    const reply = await this.request({ op: 'status' });
    const raw = reply.providers;
    const providers = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw as Record<string, any>).map(([name, item]) => [
        name,
        { configured: item?.configured === true, keyFp: typeof item?.keyFp === 'string' ? item.keyFp : undefined },
      ]))
      : undefined;
    return { configured: reply.configured === true, providers };
  }

  async call(kind: string, params: Record<string, unknown>): Promise<VaultReply> {
    const reply = await this.request({ op: 'call', kind, params });
    const raw = reply.headers;
    const headers = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]))
      : undefined;
    return {
      status: Number(reply.status),
      contentType: String(reply.contentType ?? ''),
      body: Buffer.from(String(reply.bodyBase64 ?? ''), 'base64'),
      headers,
    };
  }

  private request(payload: Record<string, unknown>): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      let received = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: CompanyError, value?: Record<string, any>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(value ?? {});
      };
      timer = setTimeout(() => finish(new CompanyError('upstream_error', 'sck-vault 没有回复', true)), REPLY_MS);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
      socket.on('data', (chunk: string) => {
        received += chunk;
        const end = received.indexOf('\n');
        if (end < 0) return;
        let reply: Record<string, any>;
        try {
          reply = JSON.parse(received.slice(0, end));
        } catch {
          return finish(new CompanyError('upstream_error', 'sck-vault 回复格式错误'));
        }
        if (reply.ok === true) return finish(undefined, reply);
        const code = CODES[String(reply.code)] ?? 'upstream_error';
        finish(new CompanyError(code, String(reply.message ?? 'sck-vault 拒绝了请求'), code === 'temporarily_unavailable' || code === 'upstream_error'));
      });
      socket.on('error', () => finish(new CompanyError('not_configured', 'sck-vault 未运行，请老板检查 launchd 服务')));
      socket.on('close', () => finish(new CompanyError('upstream_error', 'sck-vault 连接中断', true)));
      socket.connect(this.socketPath);
    });
  }
}
