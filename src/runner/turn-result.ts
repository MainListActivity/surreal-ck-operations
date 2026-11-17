import type { RuntimeHost } from './host.ts';

/** Why a turn's final answer could not be read. Each reason may clear later, so the caller bounds its retries. */
export type RuntimeResultReason = 'channel_unavailable' | 'timeline_unavailable' | 'still_active' | 'not_yet_available' | 'not_found';

export class RuntimeResultError extends Error {
  constructor(readonly reason: RuntimeResultReason, message: string) {
    super(message);
    this.name = 'RuntimeResultError';
  }
}

/** In-flight provider work inside a turn. A running tool or compaction produces more rows, so the turn is not over. */
const inFlight = (item: { type: string; status?: string }): boolean =>
  (item.type === 'tool_call' && item.status === 'running') || (item.type === 'compaction' && item.status === 'loading');

/** Paseo 0.15 emits empty hook timelines; fetch only rows fenced by this exact turn. */
export async function readTurnResult(host: RuntimeHost | undefined, agent: string, turn: string, startedAt = 0): Promise<string> {
  const timeline = host?.agents.ref(agent).timeline;
  if (!timeline) throw new RuntimeResultError('channel_unavailable', 'runtime result channel unavailable');
  let cursor: { epoch: string; seq: number } | undefined;
  let epoch: string | undefined;
  // The snapshot can read idle/activeTurn null while a turn still has work in flight, so liveness
  // comes from the turn's own rows: any running tool keeps the read waiting. The turn's last row is
  // decided by the newest page that has fenced rows; older pages are still scanned for in-flight
  // work paged out behind later entries.
  let decided: 'none' | 'text' | 'pending' = 'none', text = '';
  for (let page = 0; page < 20; page++) {
    const result = await timeline.refetch({ direction: cursor ? 'before' : 'tail', cursor, limit: 100, projection: 'projected' });
    if (result.error || result.gap || result.staleCursor || (epoch && result.epoch !== epoch)) throw new RuntimeResultError('timeline_unavailable', 'runtime timeline unavailable');
    if (result.agent?.activeTurn || result.agent?.status === 'running') throw new RuntimeResultError('still_active', 'runtime turn still active');
    epoch = result.epoch;
    // Projection keeps each row at its first position, which seqStart records. seqEnd moves when a tool finishes,
    // so ordering by seqEnd would place a tool that finished after the answer behind the answer.
    const rows = result.entries.filter(row => row.turnId === turn && (!startedAt || (row.timestamp && Date.parse(row.timestamp) >= startedAt - 1000)))
      .sort((a, b) => (a.seqStart ?? a.seqEnd) - (b.seqStart ?? b.seqEnd));
    if (rows.some(row => inFlight(row.item))) throw new RuntimeResultError('still_active', 'runtime turn still active');
    if (!rows.length) {
      if (decided !== 'none') break;
    } else if (decided === 'none') {
      // A progress message followed by more tools/reasoning is not a final work result.
      const last = rows.at(-1)!;
      if (last.item.type === 'assistant_message' && last.item.text?.trim()) { decided = 'text'; text = last.item.text; }
      else decided = 'pending';
    }
    if (!result.hasOlder || !result.startCursor || result.startCursor.seq === cursor?.seq) break;
    cursor = result.startCursor;
  }
  if (decided === 'text') return text;
  if (decided === 'pending') throw new RuntimeResultError('not_yet_available', 'runtime final result not yet available');
  throw new RuntimeResultError('not_found', 'runtime turn result unavailable');
}
