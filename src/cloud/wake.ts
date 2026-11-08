// LIVE 唤醒模块。派工循环在关心的表变化时尽快 tick：TickGate 负责合并与最小间隔，subscribeWake 负责建立 LIVE 订阅。会话重建不在本模块内处理。
import { Table, type LiveSubscription, type Surreal } from 'surrealdb';

/** 派工循环需要因其变化而唤醒的表。 */
export const WAKE_TABLES = ['task', 'outbound_message', 'ops_job', 'agent_policy'] as const;

/** wait() 的结束原因：wake 为有请求唤醒，fallback 为兜底周期到期，stop 为已停止。 */
export type WakeReason = 'wake' | 'fallback' | 'stop';

export interface TickGateOptions {
  minGapMs?: number; // 默认 1000
  fallbackMs?: number; // 默认 60000
  now?: () => number; // 默认 Date.now
  setTimer?: (fn: () => void, ms: number) => unknown; // 默认 setTimeout
  clearTimer?: (handle: unknown) => void; // 默认 clearTimeout
}

interface Waiter {
  resolve: (reason: WakeReason) => void;
  // 当前是否处于兜底计时；有请求到达时需要改为按最小间隔唤醒。
  fallback: boolean;
  // 本次等待的兜底时长（wait 的参数，缺省用构造时的值）。
  fallbackMs: number;
}

/**
 * tick 节流门：请求合并、两次 tick 之间保持最小间隔、无唤醒时按兜底周期触发。
 * 时钟与定时器全部可注入，便于用假时钟测试。
 */
export class TickGate {
  private readonly minGapMs: number;
  private readonly fallbackMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private pending = false; // 有未被 tick 消费的唤醒请求
  private lastStarted: number | undefined; // 上一次 tick 开始的时刻
  private stopped = false;
  private waiter: Waiter | undefined;
  private timer: unknown; // 当前唯一的定时器句柄

  constructor(options: TickGateOptions = {}) {
    this.minGapMs = options.minGapMs ?? 1000;
    this.fallbackMs = options.fallbackMs ?? 60000;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** 请求一次 tick。一次 tick 开始前的多次请求合并为一次。 */
  request(): void {
    if (this.stopped) return;
    this.pending = true;
    const waiter = this.waiter;
    // 正处于兜底等待时，改为按最小间隔唤醒。已在按间隔等待时无需重排。
    if (waiter && waiter.fallback) this.schedule(waiter);
  }

  /**
   * 等待下一次 tick。fallbackMs 为本次无唤醒时的兜底时长，缺省用构造时的值；
   * 派工循环据此在正常周期与失败退避之间切换，唤醒请求始终按最小间隔处理。
   */
  wait(fallbackMs: number = this.fallbackMs): Promise<WakeReason> {
    if (this.stopped) return Promise.resolve('stop');
    if (this.waiter) throw new Error('同一时间只允许一个未决的 wait');
    return new Promise<WakeReason>(resolve => {
      const waiter: Waiter = { resolve, fallback: false, fallbackMs };
      this.waiter = waiter;
      this.schedule(waiter);
    });
  }

  /** 记录一次 tick 开始：作为下一次最小间隔的起点。 */
  started(): void {
    this.lastStarted = this.now();
  }

  /** 停止：未决的 wait 以 'stop' 结束；之后的 wait 立即返回 'stop'；清理全部定时器。 */
  stop(): void {
    this.stopped = true;
    this.pending = false;
    this.clearPendingTimer();
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.resolve('stop');
  }

  /** 按当前状态为 waiter 安排定时器：有请求则按间隔唤醒，否则进入兜底计时。 */
  private schedule(waiter: Waiter): void {
    this.clearPendingTimer();
    if (this.pending) {
      waiter.fallback = false;
      const now = this.now();
      const due = Math.max(now, (this.lastStarted ?? -Infinity) + this.minGapMs);
      this.timer = this.setTimer(() => this.finish('wake'), Math.max(0, due - now));
    } else {
      // 兜底计时从本次 wait() 开始算。
      waiter.fallback = true;
      this.timer = this.setTimer(() => this.finish('fallback'), waiter.fallbackMs);
    }
  }

  private finish(reason: WakeReason): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.clearPendingTimer();
    this.waiter = undefined;
    if (reason === 'wake') this.pending = false; // 请求已被这次 tick 消费
    waiter.resolve(reason);
  }

  private clearPendingTimer(): void {
    if (this.timer === undefined) return;
    const handle = this.timer;
    this.timer = undefined;
    this.clearTimer(handle);
  }
}

/**
 * 在 client 上为 WAKE_TABLES 建立 LIVE 订阅，任一表有变化即调用 onChange(table)。返回的函数杀掉全部订阅。
 * 任一订阅建立失败：先杀掉已建立的，再抛出错误（不留半成品）。
 */
export async function subscribeWake(client: Surreal, onChange: (table: string) => void): Promise<() => Promise<void>> {
  const subs: Array<{ sub: LiveSubscription; unsubscribe: () => void }> = [];

  // 逐个杀掉订阅；单个失败吞掉并继续。调用后清空列表，重复调用无副作用。
  const killAll = async (): Promise<void> => {
    const current = subs.splice(0, subs.length);
    for (const { unsubscribe, sub } of current) {
      try {
        unsubscribe();
      } catch {
        // 取消本地回调失败不影响后续清理。
      }
      try {
        await sub.kill();
      } catch {
        // 单个订阅杀失败时继续杀其余订阅。
      }
    }
  };

  try {
    for (const table of WAKE_TABLES) {
      const sub = await client.live(new Table(table));
      const unsubscribe = sub.subscribe(() => onChange(table));
      subs.push({ sub, unsubscribe });
    }
  } catch (error) {
    await killAll();
    throw error;
  }
  return killAll;
}
