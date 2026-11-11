/**
 * 页面直连公司库的会话保活。
 * 库里所有 DEFINE ACCESS 都是 `DURATION FOR SESSION 15m`（schema/055-access.surql），而 SDK 只按令牌的 exp（1 小时）
 * 安排续期：会话到 15 分钟就失效，LIVE 推送随之静默停止，页面却仍显示“已连接”。
 * 这里按真实时钟定期重新鉴权；如果距上次鉴权已超过会话时长（电脑休眠、标签页被节流），说明这段时间推送可能已丢，
 * 通知订阅方重建 LIVE 并全量重读。
 */

/** 库里的会话时长。 */
export const SESSION_MS = 15 * 60_000;
/** 距上次鉴权超过这个时长就重新鉴权，给节流的计时器留足余量。 */
export const SESSION_RENEW_MS = 10 * 60_000;
/** 距上次鉴权超过这个时长就按“会话可能已失效”处理。 */
export const SESSION_LAPSE_MS = SESSION_MS - 60_000;

export class SessionKeeper {
  #at = 0;
  #renewing: Promise<void> | undefined;
  readonly #lapsed = new Set<() => void>();

  constructor(
    private readonly renew: () => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  /** 任何一次鉴权成功（首次连接、SDK 续期、断线重连）都记下时间。 */
  authenticated(): void {
    this.#at = this.now();
  }

  /** 会话可能已失效、重新鉴权成功后调用；返回取消函数。 */
  onLapsed(fn: () => void): () => void {
    this.#lapsed.add(fn);
    return () => {
      this.#lapsed.delete(fn);
    };
  }

  /** 读数据前与定时检查时调用：会话快到期就重新鉴权（并发调用合并为一次）。 */
  ensure(): Promise<void> {
    if (this.now() - this.#at < SESSION_RENEW_MS) return Promise.resolve();
    this.#renewing ??= (async () => {
      const lapsed = this.now() - this.#at >= SESSION_LAPSE_MS;
      try {
        await this.renew();
      } finally {
        this.#renewing = undefined;
      }
      this.#at = this.now();
      if (lapsed) for (const fn of [...this.#lapsed]) fn();
    })();
    return this.#renewing;
  }
}
