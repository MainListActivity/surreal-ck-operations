import { Table, type LiveSubscription, type Surreal } from 'surrealdb';

export const LIVE_TABLES = [
  'task',
  'employee',
  'agent_activity',
  'audit',
  'acceptance_evidence',
  'runner_heartbeat',
  'company_meta',
  'outbound_message',
  'product_requirement',
  'product_feedback',
  'product_iteration',
  'project',
  'requirement_plan',
  'requirement_execution',
  'requirement_approval',
  'ops_job',
  'ops_audit',
  'lane_note',
  'note_consolidation',
  'agent_policy',
  'agent_identity',
  'protected_command',
] as const;
/** 只传失效通知，不把 LIVE 记录正文/凭证发送给页面。每个连接使用老板自己的数据库身份。 */
export async function subscribeOwnerChanges(
  db: Surreal,
  notify: (table: string) => void,
): Promise<() => Promise<void>> {
  const subs: Array<{ sub: LiveSubscription; off: () => void }> = [];
  const stop = async () => {
    await Promise.allSettled(
      subs.splice(0).map(async ({ sub, off }) => {
        off();
        await sub.kill();
      }),
    );
  };
  try {
    for (const table of LIVE_TABLES) {
      // 页面只需要表级失效；在数据库端投影，避免 Worker 解码整条正文。
      const sub = await db.live(new Table(table)).fields('id');
      subs.push({ sub, off: sub.subscribe(() => notify(table)) });
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return stop;
}
/** 取消、数据库断线和令牌过期均释放 LIVE 与数据库连接；心跳只保活，不查询数据。 */
export function ownerEventStream(db: Surreal, signal: AbortSignal, expiresAt: number): Response {
  let stop: undefined | (() => Promise<void>);
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let flush: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const pending = new Set<string>();
  const encoder = new TextEncoder();
  let offDisconnect = () => {};
  let offReconnect = () => {};
  let offError = () => {};
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    clearTimeout(flush);
    signal.removeEventListener('abort', onAbort);
    offDisconnect();
    offReconnect();
    offError();
    try {
      controller.close();
    } catch {}
    // 断线时 KILL 无法等待服务器确认；同时关闭连接停止 SDK 自动重连，并限制清理等待。
    const cleanup = Promise.allSettled([stop?.(), db.close()]);
    let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => {
          cleanupTimeout = setTimeout(resolve, 1000);
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimeout);
    }
  };
  const onAbort = () => {
    void close();
  };
  const send = (event: string, data: unknown) => {
    if (closed) return;
    try {
      if ((controller.desiredSize ?? 1) < -32) {
        void close();
        return;
      }
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      void close();
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      signal.addEventListener('abort', onAbort, { once: true });
      offDisconnect = db.subscribe('disconnected', onAbort);
      offReconnect = db.subscribe('reconnecting', onAbort);
      offError = db.subscribe('error', onAbort);
      if (signal.aborted) {
        void close();
        return;
      }
      void subscribeOwnerChanges(db, (table) => {
        pending.add(table);
        flush ??= setTimeout(() => {
          flush = undefined;
          send('change', { tables: [...pending] });
          pending.clear();
        }, 80);
      })
        .then(async (cleanup) => {
          stop = cleanup;
          if (closed) {
            await cleanup();
            return;
          }
          send('ready', { tables: [...LIVE_TABLES] });
          heartbeat = setInterval(() => send('heartbeat', { at: Date.now() }), 20_000);
          expiry = setTimeout(
            () => {
              send('reconnect', {});
              void close();
            },
            Math.max(0, Math.min(expiresAt - Date.now() - 5000, 15 * 60_000)),
          );
        })
        .catch(() => {
          send('unavailable', {});
          void close();
        });
    },
    cancel() {
      return close();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
