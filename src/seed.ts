import type { Role } from './contracts.ts';

/**
 * Initial employee definitions: existing roles backed by three subscriptions; screenwriter has one antigravity seat. Edit rows in employee_def afterwards.
 * weight = dispatch probability share among eligible candidates of the same role (score-adjusted at runtime).
 */
// model is a slot, not a pin: `auto:<family>` tracks the newest model of that
// family reported by the provider (refreshed by the Paseo plugin). Spawn resolves
// the slot to a concrete id at dispatch time, so upstream version bumps need no edits.
export const SEED_DEFS: Array<{ id: string; role: Role; provider: string; model: string; thinking?: string; tracks?: string[]; maxInstances: number; priority: number; weight: number }> =
  [...(['product', 'engineering', 'ai-content', 'concept-design', 'asset-production', 'qa', 'cs'] as Role[]).flatMap(role => [
    { id: `${role}-codex`, role, provider: 'codex', model: 'auto:sol', thinking: 'medium',
      maxInstances: role === 'engineering' ? 2 : 1, priority: 10, weight: 60 },
    { id: `${role}-grok`, role, provider: 'grok', model: 'auto:grok', thinking: 'medium',
      maxInstances: 1, priority: 20, weight: 25 },
    { id: `${role}-devin`, role, provider: 'devin', model: 'auto:swe', thinking: 'high', maxInstances: 1, priority: 30, weight: 15 },
  ]),
  // 评审岗位：便宜够用优先 grok，codex/devin 兜底。
  { id: 'eval-grok', role: 'eval' as Role, provider: 'grok', model: 'auto:grok', thinking: 'medium', maxInstances: 1, priority: 10, weight: 60 },
  { id: 'eval-codex', role: 'eval' as Role, provider: 'codex', model: 'auto:sol', thinking: 'low', maxInstances: 1, priority: 20, weight: 30 },
  { id: 'eval-devin', role: 'eval' as Role, provider: 'devin', model: 'auto:swe', thinking: 'medium', maxInstances: 1, priority: 30, weight: 10 },
  // 专职编剧：老板只编制 antigravity 主笔；无模型族槽位（pin 字面量）与 thinkingOptions，编剧轨专属。
  { id: 'screenwriter-agy', role: 'screenwriter', provider: 'antigravity', model: 'gemini-3.7-flash-medium',
    tracks: ['编剧'], maxInstances: 1, priority: 10, weight: 60 },
  // 长篇故事作者：同样只编制 antigravity 主笔，原著轨专属。
  { id: 'story-author-agy', role: 'story-author', provider: 'antigravity', model: 'gemini-3.7-flash-medium',
    tracks: ['原著'], maxInstances: 1, priority: 10, weight: 60 },
  // 摄影摄像：运镜/镜头调度专属，codex 单座（auto:sol 槽位跟随 sol 族最新）。
  { id: 'cinematography-codex', role: 'cinematography', provider: 'codex', model: 'auto:sol', thinking: 'high',
    tracks: ['摄影'], maxInstances: 1, priority: 10, weight: 60 },
];
