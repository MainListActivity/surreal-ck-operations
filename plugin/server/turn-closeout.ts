import type { PluginLifecycleEvents } from '@getpaseo/plugin/server';
import type { PaseoApi } from '@getpaseo/client';
import { settleCompanyTurn as settle } from './vendor/src/runner/turn-closeout.ts';
export { TurnInterruptions, INTERRUPT_GRACE_MS } from './vendor/src/runner/turn-closeout.ts';
export function settleCompanyTurn(ctx: Parameters<typeof settle>[0], paseo: PaseoApi,
  event: PluginLifecycleEvents['agent.turn_ended'], interruptions?: Parameters<typeof settle>[3]) {
  return settle(ctx, { send: (id, prompt) => paseo.agents.ref(id).send(prompt).then(() => {}) }, event, interruptions);
}
