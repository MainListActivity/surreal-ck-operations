import type { Role } from './contracts.ts';

/** Initial employee definitions: every role backed by three subscriptions. Edit rows in employee_def afterwards. */
export const SEED_DEFS: Array<{ id: string; role: Role; provider: string; model: string; thinking?: string; maxInstances: number; priority: number }> =
  (['gm', 'product', 'engineering', 'ai-content', 'qa', 'cs'] as Role[]).flatMap(role => [
    { id: `${role}-codex`, role, provider: 'codex', model: 'gpt-6-sol', thinking: role === 'gm' ? 'high' : 'medium',
      maxInstances: role === 'engineering' ? 2 : 1, priority: 10 },
    { id: `${role}-grok`, role, provider: 'grok', model: 'grok-4.7', thinking: role === 'gm' ? 'high' : 'medium',
      maxInstances: 1, priority: 20 },
    { id: `${role}-devin`, role, provider: 'devin', model: 'swe-2-high', thinking: 'high', maxInstances: 1, priority: 30 },
  ]);
