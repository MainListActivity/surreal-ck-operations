/**
 * 通道偏好：老板按工作的种类定“先用哪条通道”（例如文案先用 Gemini 网页、其次 ChatGPT 网页）。
 * 只认任务上明确的事实——工种（discipline）、路线类型（type）、执行岗位（role）——不从标题或正文推断。
 * 偏好只排顺序：排在前面的通道有空位就先用，没空位照常用别的；不为它保留等待（网页通道并发 1、单轮可达两小时，
 * 保留等待会把同类工作全堵在它后面）。命中偏好的任务也不再套用全公司的优先订阅保留。
 */
import { CompanyError } from '../core-errors.ts';
import { sameSubscription } from '../provider-admission.ts';

/** 键是 `discipline:<工种>`、`type:<路线类型>`、`role:<岗位>`，值是按先后排的供应商编号。 */
export type LanePreference = Record<string, string[]>;
export interface LaneChoice { key: string; providers: string[] }

const KEY = /^(discipline|type|role):[^\s:][^\n]{0,59}$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KIND_ZH: Record<string, string> = { discipline: '工种', type: '路线', role: '岗位' };

/** lane_preference 的合法取值；admin config 与老板命令共用。空对象即不设偏好。 */
export function lanePreferenceValue(raw: unknown): LanePreference {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new CompanyError('invalid', 'lane_preference 必须是对象：{"discipline:文案":["gemini-web","chatgpt-web"]}');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 40) throw new CompanyError('invalid', 'lane_preference 最多 40 条');
  const out: LanePreference = {};
  for (const [key, value] of entries) {
    if (!KEY.test(key)) throw new CompanyError('invalid', `lane_preference 的键必须是 discipline:<工种>、type:<路线类型> 或 role:<岗位>：${key.slice(0, 60)}`);
    if (!Array.isArray(value) || !value.length || value.length > 8 || value.some(p => typeof p !== 'string' || !PROVIDER.test(p)))
      throw new CompanyError('invalid', `lane_preference["${key}"] 必须是 1 到 8 个供应商编号（小写字母数字连字符）`);
    out[key] = [...new Set(value as string[])];
  }
  return out;
}

/**
 * 这次派工适用哪一条偏好：工种最具体，其次路线类型，最后岗位。工种和路线类型只对任务的执行岗位生效
 * （复核岗、受阻处理岗看到的是别人的任务）；岗位键按这次派工的岗位查。
 */
export function lanePreferenceFor(prefs: LanePreference | undefined, role: string,
  task?: { discipline?: string; executorRole?: string; type?: string }): LaneChoice | undefined {
  if (!prefs) return undefined;
  const keys = [
    ...(task && task.executorRole === role && task.discipline ? [`discipline:${task.discipline}`] : []),
    ...(task && task.executorRole === role && task.type ? [`type:${task.type}`] : []),
    `role:${role}`,
  ];
  for (const key of keys) if (prefs[key]?.length) return { key, providers: prefs[key]! };
  return undefined;
}

/** 这个供应商在偏好里排第几（从 0 起）；不在偏好里返回 -1。同一订阅的通道算同一位。 */
export function laneRank(provider: string | undefined, choice: LaneChoice | undefined): number {
  return choice ? choice.providers.findIndex(p => sameSubscription(provider, p)) : -1;
}

/** 按偏好排：偏好里的在前（按偏好顺序），其余保持原来的相对顺序。 */
export function byLanePreference<T extends { provider?: string }>(rows: readonly T[], choice: LaneChoice | undefined): T[] {
  if (!choice) return [...rows];
  const rank = (row: T) => { const at = laneRank(row.provider, choice); return at < 0 ? Number.MAX_SAFE_INTEGER : at; };
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).map(x => x.row);
}

/** 给老板看的偏好说明：「工种“文案”先用 gemini-web、chatgpt-web」。 */
export function laneChoiceText(choice: LaneChoice): string {
  const at = choice.key.indexOf(':');
  return `${KIND_ZH[choice.key.slice(0, at)] ?? choice.key.slice(0, at)}“${choice.key.slice(at + 1)}”先用 ${choice.providers.join('、')}`;
}

export interface ReasonInput {
  provider: string;
  defId?: string;
  /** 接着用这张任务已有的会话。 */
  continuing?: boolean;
  choice?: LaneChoice;
  /** 全公司的优先订阅（没有命中通道偏好时才起作用）。 */
  preferredProvider?: string;
  /** 这次可以新开会话的编制，已按最终顺序排好。 */
  ordered: ReadonlyArray<{ id: string; provider: string }>;
  /** 同岗位里这次不能用的编制和原因。 */
  skipped: ReadonlyArray<{ provider: string; reason?: string }>;
}

/** 派出去那一刻记下的“为什么派给它”，一两句话，给老板看。 */
export function dispatchReason(input: ReasonInput): string {
  const parts: string[] = [];
  if (input.continuing) parts.push('这张任务已有会话在，接着用它');
  else {
    const rank = laneRank(input.provider, input.choice);
    if (input.choice && rank >= 0) parts.push(`${laneChoiceText(input.choice)}，${input.provider} 排第 ${rank + 1} 位且有空位`);
    else if (input.choice) parts.push(`${laneChoiceText(input.choice)}，这几条通道现在都用不了，改用 ${input.provider}`);
    else if (input.preferredProvider && sameSubscription(input.provider, input.preferredProvider)) parts.push(`优先订阅 ${input.preferredProvider} 有空位`);
    else if (input.ordered.length <= 1) parts.push(`这个岗位现在只有 ${input.provider} 能接`);
    else parts.push(`${input.ordered.length} 个可用编制里按权重选中 ${input.provider}`);
  }
  // 没选上的偏好通道要说明为什么：老板最想知道“为什么不是我说的那条”。
  const missed = new Map<string, string>();
  for (const row of input.skipped) {
    if (sameSubscription(row.provider, input.provider) || missed.has(row.provider) || !row.reason) continue;
    if (input.choice && laneRank(row.provider, input.choice) < 0) continue;
    missed.set(row.provider, row.reason.split(/[（(，,]/)[0]!.slice(0, 40));
  }
  if (missed.size) parts.push(`没用 ${[...missed].slice(0, 3).map(([provider, reason]) => `${provider}（${reason}）`).join('、')}`);
  return parts.join('；').slice(0, 300);
}
