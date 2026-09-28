import type { Role } from './contracts.ts';

/**
 * Initial employee definitions: every role backed by three subscriptions. Edit rows in employee_def afterwards.
 * weight = dispatch probability share among eligible candidates of the same role (score-adjusted at runtime).
 */
export const SEED_DEFS: Array<{ id: string; role: Role; provider: string; model: string; thinking?: string; maxInstances: number; priority: number; weight: number }> =
  [...(['gm', 'product', 'engineering', 'ai-content', 'qa', 'cs'] as Role[]).flatMap(role => [
    { id: `${role}-codex`, role, provider: 'codex', model: 'gpt-6-sol', thinking: role === 'gm' ? 'high' : 'medium',
      maxInstances: role === 'engineering' ? 2 : 1, priority: 10, weight: 60 },
    { id: `${role}-grok`, role, provider: 'grok', model: 'grok-4.7', thinking: role === 'gm' ? 'high' : 'medium',
      maxInstances: 1, priority: 20, weight: 25 },
    { id: `${role}-devin`, role, provider: 'devin', model: 'swe-2-high', thinking: 'high', maxInstances: 1, priority: 30, weight: 15 },
  ]),
  // 评审岗位：便宜够用优先 grok，codex/devin 兜底。
  { id: 'eval-grok', role: 'eval' as Role, provider: 'grok', model: 'grok-4.7', thinking: 'medium', maxInstances: 1, priority: 10, weight: 60 },
  { id: 'eval-codex', role: 'eval' as Role, provider: 'codex', model: 'gpt-6-sol', thinking: 'low', maxInstances: 1, priority: 20, weight: 30 },
  { id: 'eval-devin', role: 'eval' as Role, provider: 'devin', model: 'swe-2-high', thinking: 'medium', maxInstances: 1, priority: 30, weight: 10 },
];
