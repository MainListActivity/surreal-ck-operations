import { useEffect, useRef, useState } from 'preact/hooks';
import { outcomeOf } from './api.ts';
import { openLive, type LiveState } from './source.ts';
export type { LiveState };
type Listener = (tables: string[]) => void;
const listeners = new Set<Listener>();
const stateListeners = new Set<(s: LiveState) => void>();
let state: LiveState = 'connecting';
let close: (() => void) | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let transport: typeof openLive = openLive;
/** 仅供测试替换底层连接。 */
export function setLiveTransportForTest(next: typeof openLive): void {
  transport = next;
}
/** 登录期间由 App 持有：切换页面时页面监听会短暂清零，连接与 LIVE 订阅不能随之关闭重建。 */
let holds = 0;
const wanted = () => holds > 0 || listeners.size > 0;
const status = (s: LiveState) => {
  state = s;
  for (const fn of stateListeners) fn(s);
};
const broadcast = (tables: string[]) => {
  for (const fn of listeners) fn(tables);
};
function stop() {
  clearTimeout(reconnect);
  reconnect = undefined;
  close?.();
  close = undefined;
}
/**
 * 全页面一条实时订阅（生产：浏览器直连公司库的 LIVE；设计模式：本地 SSE）。
 * 断线后由 SDK 自动重连；只有首次建立失败才在这里按退避重开。没有业务轮询回退。
 */
function connect() {
  if (close || !wanted()) return;
  close = transport({
    change(tables) {
      if (tables.includes('*')) failures = 0;
      broadcast(tables);
    },
    state: status,
    unauthorized() {
      stop();
      status('offline');
      void outcomeOf(new Response('', { status: 401 }));
    },
    failed() {
      stop();
      status('offline');
      if (!wanted()) return;
      reconnect = setTimeout(() => {
        reconnect = undefined;
        connect();
      }, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)));
    },
  });
}
export function subscribeLive(fn: Listener) {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
    release();
  };
}
function release() {
  if (wanted()) return;
  stop();
  status('offline');
}
/**
 * 登录后在 App 层调用一次：整个登录期间保持同一条实时连接和全部 LIVE 订阅，
 * 页面切换、刷新当前页只增减监听，不再断开重连。返回的函数在退出登录或登录失效时释放。
 */
export function holdLive(): () => void {
  holds++;
  connect();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    release();
  };
}
/** 编辑期间积累一次失效，退出编辑后补读；不会覆盖用户输入。 */
export function useLiveRefresh(
  tables: string[],
  refresh: () => void | Promise<unknown>,
  enabled = true,
) {
  const current = useRef({ tables, refresh, enabled });
  current.current = { tables, refresh, enabled };
  const pending = useRef(false);
  const running = useRef(false);
  const mounted = useRef(true);
  const drain = async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (pending.current && mounted.current && current.current.enabled) {
        pending.current = false;
        try {
          await current.current.refresh();
        } catch {
          console.warn('实时更新读取失败，请查看页面错误提示或手动重试');
        }
      }
    } finally {
      running.current = false;
    }
  };
  useEffect(() => {
    mounted.current = true;
    const off = subscribeLive((changed) => {
      if (!changed.includes('*') && !current.current.tables.some((t) => changed.includes(t)))
        return;
      pending.current = true;
      void drain();
    });
    return () => {
      mounted.current = false;
      off();
    };
  }, []);
  useEffect(() => {
    if (enabled && pending.current) void drain();
  }, [enabled]);
}
export function useLiveState() {
  const [value, set] = useState(state);
  useEffect(() => {
    stateListeners.add(set);
    set(state);
    return () => {
      stateListeners.delete(set);
    };
  }, []);
  return value;
}
