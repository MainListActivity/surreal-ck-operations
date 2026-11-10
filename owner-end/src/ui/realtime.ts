import { useEffect, useRef, useState } from 'preact/hooks';
import { accessToken } from './auth.ts';
import { outcomeOf } from './api.ts';
export type LiveState = 'connecting' | 'live' | 'offline';
type Listener = (tables: string[]) => void;
/** 心跳超时只重建实时连接；不会以定时查询业务数据作为降级。 */
export async function readLiveChunk(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  timeoutMs = 45_000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('live heartbeat timeout')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const listeners = new Set<Listener>();
const stateListeners = new Set<(s: LiveState) => void>();
let state: LiveState = 'connecting';
let abort: AbortController | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
const status = (s: LiveState) => {
  state = s;
  for (const fn of stateListeners) fn(s);
};
const broadcast = (tables: string[]) => {
  for (const fn of listeners) fn(tables);
};
/** SSE 的块可以跨网络分片；心跳不产生业务刷新。 */
export function parseLiveFrame(frame: string): { event: string; tables?: string[] } {
  const lines = frame.split('\n');
  const event =
    lines
      .find((l) => l.startsWith('event:'))
      ?.slice(6)
      .trim() ?? 'message';
  const data = lines
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('\n');
  try {
    const parsed = JSON.parse(data);
    return { event, tables: Array.isArray(parsed.tables) ? parsed.tables : undefined };
  } catch {
    return { event };
  }
}
async function connect() {
  if (abort || !listeners.size) return;
  const own = new AbortController();
  abort = own;
  status('connecting');
  try {
    const token = await accessToken();
    if (!token) {
      await outcomeOf(new Response('', { status: 401 }));
      return;
    }
    const response = await fetch('/api/events', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: own.signal,
    });
    if (response.status === 401) {
      await outcomeOf(response);
      return;
    }
    if (!response.ok || !response.body) throw Error('stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!own.signal.aborted) {
        const { value, done } = await readLiveChunk(reader);
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        if (buffer.length > 65536) throw Error('frame');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const msg = parseLiveFrame(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (msg.event === 'ready') {
            failures = 0;
            status('live');
            broadcast(['*']);
          } else if (msg.event === 'change') broadcast(msg.tables ?? []);
          else if (msg.event === 'unavailable' || msg.event === 'reconnect')
            throw Error('reconnect');
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch {
    /* 状态在 finally 统一反馈；无业务轮询回退。 */
  } finally {
    if (abort === own) abort = undefined;
    if (!own.signal.aborted && listeners.size) {
      status('offline');
      reconnect = setTimeout(
        () => {
          reconnect = undefined;
          void connect();
        },
        Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)),
      );
    }
  }
}
function subscribe(fn: Listener) {
  listeners.add(fn);
  void connect();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      clearTimeout(reconnect);
      reconnect = undefined;
      abort?.abort();
      abort = undefined;
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
