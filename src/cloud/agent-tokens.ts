// 员工 agent 令牌的进程内缓存。令牌只存内存，不写文件、不打日志；同一键并发只换发一次。
import { GatewayError } from './gateway.ts';
import type { IssuedToken } from './idp.ts';

export interface AgentTokenOptions {
  exchange: (input: { agentUserId: string; taskId: string; ttlSeconds: number }) => Promise<IssuedToken>;
  now?: () => number;
  marginMs?: number; // 默认 60000
  maxTtlSeconds?: number; // 默认 900
}

const HARD_TTL_CAP_SECONDS = 900; // 与身份服务的 ttl 上限保持一致
const MIN_LEASE_MS = 1000;

function keyOf(employee: string, taskId: string): string {
  return `${employee}\0${taskId}`;
}

export class AgentTokenCache {
  private readonly cache = new Map<string, IssuedToken>();
  private readonly inflight = new Map<string, { id: object; promise: Promise<string> }>();
  private readonly exchange: AgentTokenOptions['exchange'];
  private readonly now: () => number;
  private readonly marginMs: number;
  private readonly maxTtl: number;

  constructor(options: AgentTokenOptions) {
    this.exchange = options.exchange;
    this.now = options.now ?? Date.now;
    this.marginMs = options.marginMs ?? 60_000;
    this.maxTtl = Math.min(options.maxTtlSeconds ?? HARD_TTL_CAP_SECONDS, HARD_TTL_CAP_SECONDS);
  }

  async tokenFor(input: {
    employee: string;
    agentUserId: string;
    taskId: string;
    leaseRemainingMs: number;
  }): Promise<string> {
    const { employee, agentUserId, taskId, leaseRemainingMs } = input;
    // 租约剩余不足 1 秒视为无效，直接拒绝，不去换令牌。
    if (!(leaseRemainingMs >= MIN_LEASE_MS)) throw new GatewayError('forbidden', '员工没有有效租约');
    if (!employee || !taskId || employee.includes('\0') || taskId.includes('\0')) {
      throw new GatewayError('invalid', '员工或任务编号不合法');
    }

    const key = keyOf(employee, taskId);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.marginMs > this.now()) return cached.token;

    // 令牌有效期不超过剩余租约，也不超过上限。
    const ttlSeconds = Math.min(this.maxTtl, Math.floor(leaseRemainingMs / 1000));
    const running = this.inflight.get(key);
    if (running) return running.promise;

    // 用独立的标识对象判断本次换发是否仍有效（期间若被 drop 则不写回缓存）。
    const flightId = {};
    const promise = (async () => {
      await null; // 确保 inflight 登记早于本段执行
      const stillCurrent = () => this.inflight.get(key)?.id === flightId;
      try {
        const issued = await this.exchange({ agentUserId, taskId, ttlSeconds });
        if (stillCurrent()) this.cache.set(key, issued);
        return issued.token;
      } finally {
        if (stillCurrent()) this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, { id: flightId, promise });
    return promise;
  }

  /** 丢弃令牌；employee 缺省时丢弃该任务下全部员工的令牌。永不抛错。 */
  drop(input: { employee?: string; taskId: string }): void {
    try {
      const { employee, taskId } = input;
      if (employee !== undefined) {
        const key = keyOf(employee, taskId);
        this.cache.delete(key);
        this.inflight.delete(key);
        return;
      }
      const suffix = `\0${taskId}`;
      for (const key of [...this.cache.keys()]) if (key.endsWith(suffix)) this.cache.delete(key);
      for (const key of [...this.inflight.keys()]) if (key.endsWith(suffix)) this.inflight.delete(key);
    } catch {
      // drop 只做清理，不能影响调用方
    }
  }

  /** 当前缓存条数（测试用）。 */
  size(): number {
    return this.cache.size;
  }
}
