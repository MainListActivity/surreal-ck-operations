/** 本地设计模式的 SSE 事件流解析（demo/source.ts 使用）。生产页面直连公司库，不走 SSE。 */
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
