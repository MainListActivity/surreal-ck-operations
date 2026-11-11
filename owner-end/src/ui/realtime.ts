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
  if (close || !listeners.size) return;
  close = openLive({
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
      if (!listeners.size) return;
      reconnect = setTimeout(() => {
        reconnect = undefined;
        connect();
      }, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)));
    },
  });
}
function subscribe(fn: Listener) {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      stop();
      status('offline');
    }
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
    const off = subscribe((changed) => {
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
