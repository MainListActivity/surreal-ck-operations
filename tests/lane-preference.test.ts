import { expect, test } from 'bun:test';
import { byLanePreference, dispatchReason, lanePreferenceFor, lanePreferenceValue, laneRank } from '../src/dispatcher/lane-preference.ts';
import { staffingPool, type StaffingInput } from '../src/dispatcher/dispatcher.ts';

const prefs = { 'discipline:文案': ['gemini-web', 'chatgpt-web'], 'type:product': ['claude'], 'role:ai-content': ['muse-web'] };

test('偏好只认任务上明确的事实：工种最具体，其次路线类型，最后岗位', () => {
  expect(lanePreferenceFor(prefs, 'ai-content', { discipline: '文案', executorRole: 'ai-content', type: 'product' })?.key).toBe('discipline:文案');
  expect(lanePreferenceFor(prefs, 'ai-content', { executorRole: 'ai-content', type: 'product' })?.key).toBe('type:product');
  expect(lanePreferenceFor(prefs, 'ai-content', { executorRole: 'ai-content' })?.key).toBe('role:ai-content');
  // 别的岗位处理这张任务（复核、受阻处理）时，工种和路线类型不算它的。
  expect(lanePreferenceFor(prefs, 'qa', { discipline: '文案', executorRole: 'ai-content', type: 'product' })).toBeUndefined();
  expect(lanePreferenceFor(undefined, 'ai-content', {})).toBeUndefined();
  expect(lanePreferenceFor({}, 'ai-content', { executorRole: 'ai-content' })).toBeUndefined();
});

test('按偏好排先后，其余保持原来的相对顺序；不在偏好里的不被剔除', () => {
  const choice = lanePreferenceFor(prefs, 'ai-content', { discipline: '文案', executorRole: 'ai-content' })!;
  const defs = [{ id: 'a', provider: 'claude' }, { id: 'b', provider: 'chatgpt-web' }, { id: 'c', provider: 'factory-droid' }, { id: 'd', provider: 'gemini-web' }];
  expect(byLanePreference(defs, choice).map(d => d.id)).toEqual(['d', 'b', 'a', 'c']);
  expect(byLanePreference(defs, undefined).map(d => d.id)).toEqual(['a', 'b', 'c', 'd']);
  expect(laneRank('chatgpt-web', choice)).toBe(1);
  expect(laneRank('claude', choice)).toBe(-1);
});

test('配置校验：键和值的形状不对就拒绝', () => {
  expect(lanePreferenceValue({ 'discipline:文案': ['gemini-web', 'gemini-web', 'chatgpt-web'] })).toEqual({ 'discipline:文案': ['gemini-web', 'chatgpt-web'] });
  expect(lanePreferenceValue({})).toEqual({});
  for (const bad of [[], 'x', { 文案: ['gemini-web'] }, { 'discipline:': ['gemini-web'] }, { 'discipline:文案': [] }, { 'discipline:文案': ['Gemini Web'] }, { 'discipline:文案': 'gemini-web' }])
    expect(() => lanePreferenceValue(bad)).toThrow(/lane_preference/);
});

test('“为什么派给它”说清楚依据，偏好通道没用上时说明原因', () => {
  const choice = lanePreferenceFor(prefs, 'ai-content', { discipline: '文案', executorRole: 'ai-content' })!;
  const ordered = [{ id: 'g', provider: 'gemini-web' }, { id: 'c', provider: 'claude' }];
  expect(dispatchReason({ provider: 'gemini-web', choice, ordered, skipped: [] })).toBe('工种“文案”先用 gemini-web、chatgpt-web，gemini-web 排第 1 位且有空位');
  expect(dispatchReason({ provider: 'claude', choice, ordered: [{ id: 'c', provider: 'claude' }],
    skipped: [{ provider: 'gemini-web', reason: '编制席位已满（1/1 个实例，仓库 ops）' }, { provider: 'codex', reason: '额度不足' }] }))
    .toBe('工种“文案”先用 gemini-web、chatgpt-web，这几条通道现在都用不了，改用 claude；没用 gemini-web（编制席位已满）');
  expect(dispatchReason({ provider: 'factory-droid', preferredProvider: 'factory-droid', ordered, skipped: [] })).toBe('优先订阅 factory-droid 有空位');
  expect(dispatchReason({ provider: 'claude', preferredProvider: 'factory-droid', ordered: [{ id: 'c', provider: 'claude' }], skipped: [{ provider: 'factory-droid', reason: '额度不足，恢复时间未知' }] }))
    .toBe('这个岗位现在只有 claude 能接；没用 factory-droid（额度不足）');
  expect(dispatchReason({ provider: 'claude', continuing: true, choice, ordered, skipped: [] })).toBe('这张任务已有会话在，接着用它');
  expect(dispatchReason({ provider: 'claude', ordered: [{ id: 'c', provider: 'claude' }, { id: 'd', provider: 'codex' }], skipped: [] })).toBe('2 个可用编制里按权重选中 claude');
});

const def = (id: string, provider: string) => ({ id, role: 'ai-content', provider, model: 'default', enabled: true, maxInstances: 1, weight: 10, quotaLimited: false }) as never;
const pool = (extra: Partial<StaffingInput>) => staffingPool({
  role: 'ai-content', home: '/ops', defs: [def('fd', 'factory-droid'), def('gw', 'gemini-web'), def('cl', 'claude')], insts: [], states: new Map(), holding: new Set(),
  health: new Map(), quotaBlocked: new Map(), busyBy: new Map(), providerMax: {}, slots: new Map(), opsRepo: '/ops', sidecar: true, now: 1_700_000_000,
  preferredProvider: 'factory-droid', ...extra,
});
const task = (discipline?: string) => ({ id: 't1', executorRole: 'ai-content', reviewerRole: 'owner', discipline, state: 'ready', row: {} }) as never;

test('候选池：命中通道偏好的任务不再为优先订阅保留等待，偏好通道带说明；没命中的照旧', () => {
  const plain = pool({ task: task() });
  expect(plain.filter(e => e.eligible).map(e => e.provider)).toEqual(['factory-droid']);
  expect(plain.find(e => e.provider === 'gemini-web')?.code).toBe('factory_wait');

  const hit = pool({ task: task('文案'), lanePreference: prefs });
  expect(hit.filter(e => e.eligible).map(e => e.provider).sort()).toEqual(['claude', 'factory-droid', 'gemini-web']);
  expect(hit.find(e => e.provider === 'gemini-web')?.note).toContain('通道偏好：工种“文案”先用 gemini-web、chatgpt-web，排第 1 位');
  expect(hit.find(e => e.provider === 'claude')?.note).toBeUndefined();

  // 复核工作不套用通道偏好。
  const review = pool({ task: task('文案'), lanePreference: prefs, excludeSubmitter: true });
  expect(review.find(e => e.provider === 'gemini-web')?.code).toBe('factory_wait');
});
