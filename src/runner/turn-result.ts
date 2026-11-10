import type { RuntimeHost } from './host.ts';

/** Paseo 0.15 emits empty hook timelines; fetch only rows fenced by this exact turn. */
export async function readTurnResult(host: RuntimeHost | undefined, agent: string, turn: string, startedAt = 0): Promise<string> {
  const timeline = host?.agents.ref(agent).timeline;
  if (!timeline) throw new Error('runtime result channel unavailable');
  let cursor: { epoch: string; seq: number } | undefined;
  let epoch: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await timeline.refetch({ direction: cursor ? 'before' : 'tail', cursor, limit: 100, projection: 'projected' });
    if (result.error || result.gap || result.staleCursor || (epoch && result.epoch !== epoch)) throw new Error('runtime timeline unavailable');
    if (result.agent?.activeTurn || result.agent?.status === 'running') throw new Error('runtime turn still active');
    epoch = result.epoch;
    const rows = result.entries.filter(row => row.turnId === turn && (!startedAt || (row.timestamp && Date.parse(row.timestamp) >= startedAt - 1000))).sort((a, b) => a.seqEnd - b.seqEnd);
    // A progress message followed by more tools/reasoning is not a final work result.
    const last = rows.at(-1);
    if (last) {
      if (last.item.type === 'assistant_message' && last.item.text?.trim()) return last.item.text;
      throw new Error('runtime final result not yet available');
    }
    if (!result.hasOlder || !result.startCursor || result.startCursor.seq === cursor?.seq) break;
    cursor = result.startCursor;
  }
  throw new Error('runtime turn result unavailable');
}
