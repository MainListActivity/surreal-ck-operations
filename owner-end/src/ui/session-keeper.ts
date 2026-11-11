/**
 * 页面直连公司库的会话保活。
 * 库里所有 DEFINE ACCESS 都是 `DURATION FOR SESSION 15m`（schema/055-access.surql），而 SDK 只按令牌的 exp（1 小时）
 * 安排续期：会话到 15 分钟就失效，LIVE 推送随之静默停止，页面却仍显示“已连接”。
 * 每条 LIVE 查询绑定注册时的会话：连接重新鉴权只延长连接的会话，已注册的 LIVE 仍在注册后 15 分钟停止推送
 * （生产实测，v0.11.16）。所以这里按真实时钟定期重新鉴权，并在每次续期后通知订阅方重建 LIVE；
 * 如果距上次鉴权已超过会话时长（电脑休眠、标签页被节流），这段时间推送可能已丢，另行标明，订阅方还要全量重读。
 */

/** 库里的会话时长。 */
export const SESSION_MS = 15 * 60_000;
/** 距上次鉴权（也是 LIVE 上次重建）超过这个时长就重新鉴权，给节流的计时器留足余量。 */
export const SESSION_RENEW_MS = 10 * 60_000;
/** 距上次鉴权超过这个时长就按“会话可能已失效”处理。 */
export const SESSION_LAPSE_MS = SESSION_MS - 60_000;

export class SessionKeeper {
  #at = 0;
  #renewing: Promise<void> | undefined;
  readonly #renewed = new Set<(lapsed: boolean) => void>();

  constructor(
    private readonly renew: () => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  /** 连接建立或断线重连成功（SDK 会用新会话重新注册托管的 LIVE）时记下时间。 */
  authenticated(): void {
    this.#at = this.now();
  }

  /** 每次重新鉴权成功后调用；lapsed 表示会话可能已失效、期间的推送可能丢失。返回取消函数。 */
  onRenewed(fn: (lapsed: boolean) => void): () => void {
    this.#renewed.add(fn);
    return () => {
      this.#renewed.delete(fn);
    };
  }

  /**
   * 读数据前与定时检查时调用：会话快到期就重新鉴权（并发调用合并为一次）。
   * expired=true 表示库已明确回复会话过期：立即重新鉴权并按已失效处理。
   */
  ensure(expired = false): Promise<void> {
    if (!expired && this.now() - this.#at < SESSION_RENEW_MS) return Promise.resolve();
    this.#renewing ??= (async () => {
      const lapsed = expired || this.now() - this.#at >= SESSION_LAPSE_MS;
      try {
        await this.renew();
      } finally {
        this.#renewing = undefined;
      }
      this.#at = this.now();
      for (const fn of [...this.#renewed]) fn(lapsed);
    })();
    return this.#renewing;
  }
}
