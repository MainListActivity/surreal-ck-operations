// 仅由 demo/server.ts 的构建别名加载，替换 src/ui/source.ts：本地设计模式不连接任何数据库，
// 数据来自本机演示服务的 /api/dashboard、/api/board 与 /api/events（SSE）。
import type { RuntimeDashboard } from '../../src/runtime-dashboard.ts';
import { parseLiveFrame, readLiveChunk } from '../src/ui/sse.ts';
import type { OwnerBoard } from '../src/ui/types.ts';

export type LiveState = 'connecting' | 'live' | 'offline';

export interface LiveHandlers {
  change(tables: string[]): void;
  state(state: LiveState): void;
  unauthorized(): void;
  failed(): void;
}

export class SourceError extends Error {
  constructor(readonly code: 'unauthorized' | 'network' | 'unavailable', message = '') {
    super(message);
  }
}

async function read<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' } });
  } catch {
    throw new SourceError('network');
  }
  const body = (await res.json().catch(() => undefined)) as { ok?: boolean; result?: T; error?: { message?: string } } | undefined;
  if (res.ok && body?.ok === true) return body.result as T;
  throw new SourceError('unavailable', body?.error?.message ?? '');
}

export const readDashboardData = (): Promise<RuntimeDashboard> => read<RuntimeDashboard>('/api/dashboard');
export const readBoardData = (): Promise<OwnerBoard> => read<OwnerBoard>('/api/board');

export function openLive(handlers: LiveHandlers): () => void {
  const abort = new AbortController();
  void (async () => {
    handlers.state('connecting');
    try {
      const response = await fetch('/api/events', { headers: { Accept: 'text/event-stream' }, signal: abort.signal });
      if (!response.ok || !response.body) throw Error('stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!abort.signal.aborted) {
          const { value, done } = await readLiveChunk(reader);
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
          if (buffer.length > 65536) throw Error('frame');
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const msg = parseLiveFrame(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
            if (msg.event === 'ready') {
              handlers.state('live');
              handlers.change(['*']);
            } else if (msg.event === 'change') handlers.change(msg.tables ?? []);
            else if (msg.event === 'unavailable' || msg.event === 'reconnect') throw Error('reconnect');
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch {
      // 由 failed() 交给 realtime 按退避重开。
    }
    if (!abort.signal.aborted) handlers.failed();
  })();
  return () => abort.abort();
}
