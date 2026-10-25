import { z } from "zod";
import type { ModelTrends } from "./trends.ts";
import type { Surreal } from "surrealdb";
import type { JevClient, JevResult } from "../dispatcher/jev.ts";
import { aaRankOfScore, resolveBenchmark, splitMember, type Effort, type Tier } from "./policy.ts";

/** Opus is maintained entirely in Magpie; only Sonnet and Haiku are ranked by Jev. */
export const RANKED_TIERS: Tier[] = ["sonnet", "haiku"];
export const REFRESH_MINUTES = [2, 5, 10] as const;
export const DEFAULT_REFRESH_MINUTES = 5;
export const DEFAULT_RANKING_RULES = "智能程度和速度综合优先";

export interface RankingSettings {
  rules: string;
  refreshMinutes: number;
}
/** Exact member IDs, including effort; each group's array is the owner's pin order. */
export type RankingPins = Record<string, string[]>;
export async function rankingPins(db: Surreal): Promise<RankingPins> {
  const [row] = await db.query<[{pins?:RankingPins}|undefined]>("SELECT pins FROM ONLY company_meta:model_ranking;");
  return row?.pins ?? {};
}
export function pinnedOrder(members: string[], pins: string[] = []): string[] {
  const head = [...new Set(pins)].filter(id => members.includes(id));
  return [...head, ...members.filter(id => !head.includes(id))];
}
export interface UsageStat {
  source: "magpie";
  period: "7d";
  since?: string;
  collectedAt: string;
  /** Matches Magpie's native summary: this provider/model, across historical effort levels. */
  scope: "provider-model";
  requests: number;
  errors: number;
  speedSamples: number;
  ttftSamples: number;
  cacheHitRate?: number;
  tokensPerSecond?: number;
  ttftMs?: number;
}
export interface ModelFacts {
  trends?: ModelTrends;
  trendSource?: { source: string; available: boolean; invalidLines: number; collectedAt: string };
  id: string;
  /** Accounts behind this model's provider. Labels only: no e-mail or sign-in leaves the machine. */
  accounts: Array<{ account: string; remainingPct?: number }>;
  /** The score at the level the member is pinned to (effort), not the model's best. */
  aa?: { rank: number; score: number; effort?: Effort };
  /** USD per 1M tokens; 0 when magpie serves it free. */
  price: { free: boolean; input?: number | null; output?: number | null; cacheHit?: number | null };
  usage?: UsageStat;
  performance?: { score: number; samples: number };
}

const usageNumber = z.number().finite().nonnegative().default(0);
const nativeUsageSchema = z.object({
  period: z.literal("7d"), since: z.string().optional(),
  models: z.array(z.object({
    provider: z.string(), model: z.string(),
    calls: usageNumber, errors: usageNumber,
    input: usageNumber, cache_read: usageNumber, cache_write: usageNumber,
    decode_out: usageNumber, decode_ms: usageNumber, decode_n: usageNumber,
    ttft_ms: usageNumber, timed: usageNumber,
  })),
});

/** Consume Magpie's own timed decode totals. CSV output/duration cannot reproduce its reasoning
 * and stream-window rules. Keep the full provider/model path; names alone conflate different relays. */
export function usageStats(snapshot: unknown, collectedAt = new Date().toISOString()): Map<string, UsageStat> {
  const data = nativeUsageSchema.parse(snapshot);
  const acc = new Map<string, { calls: number; errors: number; prompt: number; hit: number; out: number; decodeMs: number; decodeN: number; ttft: number; timed: number }>();
  for (const r of data.models) {
    if (!r.provider || !r.model) continue;
    const key = `${r.provider}/${r.model}`;
    const a = acc.get(key) ?? { calls: 0, errors: 0, prompt: 0, hit: 0, out: 0, decodeMs: 0, decodeN: 0, ttft: 0, timed: 0 };
    a.calls += r.calls; a.errors += r.errors;
    a.prompt += r.input + r.cache_read + r.cache_write; a.hit += r.cache_read;
    a.out += r.decode_out; a.decodeMs += r.decode_ms; a.decodeN += r.decode_n;
    a.ttft += r.ttft_ms; a.timed += r.timed;
    acc.set(key, a);
  }
  return new Map([...acc].map(([key, a]) => [key, {
    source: "magpie", period: data.period, since: data.since, collectedAt, scope: "provider-model",
    requests: a.calls, errors: a.errors, speedSamples: a.decodeN, ttftSamples: a.timed,
    cacheHitRate: a.prompt ? Math.round(a.hit / a.prompt * 1000) / 1000 : undefined,
    tokensPerSecond: a.decodeN && a.decodeMs > 0 ? Math.round(a.out / (a.decodeMs / 1000)) : undefined,
    ttftMs: a.timed ? Math.floor(a.ttft / a.timed) : undefined,
  }]));
}

/** `magpie quota --json`: per provider, each account's tightest window. */
export function quotaAccounts(rows: Array<{ provider: string; name?: string; windows?: Array<{ remaining?: number }> }>): Map<string, ModelFacts["accounts"]> {
  const out = new Map<string, ModelFacts["accounts"]>();
  for (const q of rows) {
    const list = out.get(q.provider) ?? [];
    const left = (q.windows ?? []).map((w) => w.remaining).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100);
    list.push({ account: `${q.provider} #${list.length + 1}`, remainingPct: left.length ? Math.min(...left) : undefined });
    out.set(q.provider, list);
  }
  return out;
}

const providerOf = (id: string) => id.slice(0, id.lastIndexOf("/"));
const FREE = /(^|[^a-z])free([^a-z]|$)|免费/i;

export function modelFacts(
  ids: string[],
  sources: {
    catalog: Array<{ id: string; reasoning_levels?: string[]; display_name?: string; magpie_label?: string; owned_by?: string; pricing?: { input?: number; output?: number }; free?: boolean }>;
    quota: Map<string, ModelFacts["accounts"]>;
    usage: Map<string, UsageStat>;
    performance: Map<string, { score: number; samples: number }>;
  },
): ModelFacts[] {
  return ids.map((id) => {
    const base = splitMember(id).id;
    const entry = sources.catalog.find((m) => m.id === base);
    const free = entry?.free === true || (entry?.pricing?.input === 0 && entry?.pricing?.output === 0) || FREE.test(`${id} ${entry?.display_name ?? ""} ${entry?.magpie_label ?? ""} ${entry?.owned_by ?? ""}`);
    const resolved = resolveBenchmark(id, entry?.reasoning_levels);
    const b = resolved?.row;
    return {
      id,
      accounts: sources.quota.get(providerOf(base)) ?? [],
      aa: b ? { rank: aaRankOfScore(b.score), score: Math.round(b.score * 10) / 10, effort: resolved.effort } : undefined,
      price: free ? { free, input: 0, output: 0, cacheHit: 0 } : { free, input: b?.priceInput, output: b?.priceOutput, cacheHit: b?.priceCacheHit },
      usage: sources.usage.get(base),
      performance: sources.performance.get(id),
    };
  });
}

// Each level is evaluated independently. Describe its conditions rather than relying on
// the model to infer an ordering from generic labels or instructions hidden in state.
const LEVELS = [
  "最后考虑：触发老板规则中明确要求排最后或降到末尾的条件，其他能力、绩效、速度或价格优势不能抵消。没有明确末尾条件时，才表示综合优先级最低。",
  "靠后：未触发老板规则中必须排最后的条件，但按规则综合判断优先级偏低。",
  "中等：未触发老板规则中必须排最后的条件，按规则综合判断优先级中等。",
  "靠前：未触发老板规则中必须排最后的条件，按规则综合判断优先级较高。",
  "首选：未触发老板规则中必须排最后的条件，按规则综合判断属于本组最优先的选择。",
];

/** Compact wire columns keep the shared state within Jev's per-question context. */
export const TREND_COLUMNS = ["current","ewma","slopePerMinute","change","baselineMean","baselineSamples","samples","lastSampleAtMs","ageMs","sufficient"] as const;
const METRIC_UNITS:Record<string,string> = {ttftMs:"ms",tokensPerSecond:"tokens/s",errorRate:"ratio",cacheHitRate:"ratio",ttftOver10sRate:"ratio",performanceScore:"score",aaScore:"score",aaRank:"rank",remainingPct:"percent",inputPrice:"USD/1M",outputPrice:"USD/1M",cacheHitPrice:"USD/1M"};
const sampleUnitOf = (key:string) => key === "performanceScore" ? "task" as const : ["aaScore","aaRank","remainingPct","inputPrice","outputPrice","cacheHitPrice"].includes(key) ? "snapshot" as const : "request" as const;
/** Full facts remain in successful UI snapshots; only the transport uses shared columns. */
export function rankingInputFact(f:ModelFacts) {
  if(!f.trends)return f;
  return {...f,trends:Object.fromEntries(Object.entries(f.trends).map(([key,t])=>[key,t.baseline.samples ? [
    t.current??null,t.ewma??null,t.slopePerMinute??null,t.change.detected?[t.change.direction,t.change.at?Date.parse(t.change.at):null,t.change.before??null,t.change.after??null]:false,
    t.baseline.mean??null,t.baseline.samples,t.samples,t.lastSampleAt?Date.parse(t.lastSampleAt):null,t.ageMs??null,t.sufficient,
  ] : null]))};
}
/** Legacy/first-attempt cards can read the exact compact request even before any successful score. */
function expandRankingInput(f:ModelFacts):ModelFacts {
  if(!f.trends)return f;
  const trends:ModelTrends={};
  for(const [key,input] of Object.entries(f.trends)) {
    if(input && !Array.isArray(input)){trends[key]=input;continue;}
    const row=input as unknown[]|null;
    const value=(i:number)=>typeof row?.[i]==='number'&&Number.isFinite(row[i])?row[i] as number:undefined;
    const at=value(7);
    trends[key]={unit:METRIC_UNITS[key]??"unknown",sampleUnit:sampleUnitOf(key),current:value(0),ewma:value(1),slopePerMinute:value(2),
      change:Array.isArray(row?.[3])?{detected:true,direction:row[3][0] as 'up'|'down',at:typeof row[3][1]==='number'?new Date(row[3][1]).toISOString():undefined,before:row[3][2]??undefined,after:row[3][3]??undefined}:{detected:false},
      baseline:{mean:value(4),samples:value(5)??0},samples:value(6)??0,lastSampleAt:at===undefined?undefined:new Date(at).toISOString(),ageMs:value(8),sufficient:row?.[9]===true,windows:{}};
  }
  return {...f,trends};
}
// Conservative UTF-8 engineering budgets, not a tokenizer. Upstream rejections still retain the previous order.
// https://docs.typesafe.ai/models: 32k state+one question; 64k state+all questions.
export const RANKING_INPUT_BUDGET = {stateBytes:48_000,requestBytes:128_000};

/** Explicit units/estimators travel with every request, rather than relying on field names. */
export const TREND_DICTIONARY = {
  columns:TREND_COLUMNS,
  encoding:"trends每项是按columns列名对应的数组；整个指标null表示无有效历史，数组里的null表示该字段未知。规则引用指标.current等字段时按相应列读取。change=false表示未检出突变；突变数组为[direction,atMs,before,after]（direction=up或down，atMs为Unix毫秒）。lastSampleAtMs为Unix毫秒。详细窗口保留在公司页面成功快照，本次输入只传当前、趋势与基线摘要。",
  metricInfo:Object.fromEntries(Object.entries(METRIC_UNITS).map(([key,unit])=>[key,{unit,sampleUnit:sampleUnitOf(key)}])),
  scope:"每个完整供应商/模型通道独立统计，沿用 usage 的跨历史思考等级口径，不混用其他供应商。绩效按现有 canonical model 映射归并。",
  metrics:{ttftMs:"首个内容（含思考或工具调用）的延迟，毫秒；仅成功且有计时的请求",tokensPerSecond:"Magpie DecodeOf 原生生成速度（token/s），排除未计时、隐式思考和突发释放等不可测速请求",errorRate:"失败请求占比0–1，含没有首token的失败",cacheHitRate:"每次成功请求的缓存token/全部提示token，窗口为请求比例的均值；与usage的token加权命中率区分",ttftOver10sRate:"成功且有首token计时的请求中超过10000ms的比例",performanceScore:"最终验收任务的1–5分绩效，同一任务多名员工按原评分权重归并成一个样本",aaScore:"AA智能分",aaRank:"AA全榜名次，越小越好",remainingPct:"各订阅最紧窗口剩余比例的最小值，0–100",inputPrice:"输入价格USD/百万token",outputPrice:"输出价格USD/百万token",cacheHitPrice:"缓存命中价格USD/百万token"},
  current:"最新一次有效实测值，不是均值；lastSampleAt与ageMs标明它是否过期；没有数据是未知，不是0。",
  ewma:"请求使用最近1小时最多20个有效样本、半衰期5分钟；任务绩效与变动快照使用最近7天最多20个样本、半衰期24小时。按相对最新样本的真实时间指数加权。限制样本数防止高流量旧数据淹没最近变化。",
  slopePerMinute:"同EWMA的近期窗口最多20个样本对实际时间做最小二乘回归；单位=该指标unit/分钟。至少5样本且覆盖1秒才提供。正负只代表上升下降，延迟/错误率/排名上升通常变差，速度/绩效/命中率上升通常变好。",
  change:"启发式突变信号而非统计显著性概率：最近10样本前后各5个均值相差超过25%、前5样本3倍标准差与单位最小变化量（ms为500、ratio为0.05、score为0.25、percent为5、USD/1M为0.001、其他为1），且后5中至少4个同方向；最新请求须在15分钟内，任务/变动快照须在7天内。detected=false不证明没有变化。",
  confidence:"samples是相应近期窗口最多20样本数；sufficient要求至少5样本、覆盖至少1秒，请求最新不超过15分钟，稀疏任务/变动快照不超过7天。false时降低采信，不据此断言趋势；快照是变动记录，重复读取相同值不增加样本，不能冒充独立请求或任务。",
  baseline:"最近7天有效样本的均值与样本数，只作长期参照。公司页面的完整快照windows给出15m/1h/24h/7d分布，本次请求不重复发送这些窗口；不重叠前后5样本用于突变检测。",
  rules:"老板明确的优先级和排最后条件优先；缺失、样本不足或过期数据不代表优秀或满足限制。趋势辅助排序，不自行修改老板阈值或统计口径。AA与价格等稀疏指标没有变动历史时趋势未知。",
};

/** One Jev call per group: a priority score per member, highest first; ties keep the current order. */
export async function jevOrder(jev: JevClient, tier: Tier, rules: string, facts: ModelFacts[], beforeAsk?: (payload: RankingRequestPayload) => Promise<void>, afterAnswer?: (result: RankingResultSnapshot) => void): Promise<string[]> {
  const keys = facts.map((_, i) => `m${i}`);
  if (!facts.length) return [];
  const state = {
      group: `group/sck-${tier}`,
      ownerRules: rules.trim() || DEFAULT_RANKING_RULES,
      trendDictionary: TREND_DICTIONARY,
      models: Object.fromEntries(facts.map((f, i) => [keys[i], rankingInputFact(f)])),
      notes: [
        "accounts.remainingPct：该订阅账号最紧的额度窗口剩余百分比；额度少的账号应靠后，避免撞上限。",
        "aa.rank：Artificial Analysis 智能指数全榜名次，越小越强；aa.effort 是该成员被固定的思考等级，分数即在该等级下测得。price：每百万 token 美元，free=true 为免费。",
        "usage：本轮排序前实时读取 Magpie /v1/magpie/usage?period=7d 原生统计；collectedAt 为采集时间，since 为窗口起点。严格按完整供应商/模型路径匹配，含该通道历史各思考等级；缺失表示无该通道数据，不借用其他供应商。",
        "usage.tokensPerSecond 使用 Magpie decode_out/decode_ms 的原生测速口径，speedSamples 为实测速样本数；ttftMs 为原生平均首 token 延迟，ttftSamples 为样本数；requests 含失败次数 errors，cacheHitRate 为缓存命中占提示 token 比例。",
        "performance：公司任务验收后的模型绩效（1–5 分）与样本数，样本少时参考价值低。",
      ],
    };
  const questions = Object.fromEntries(facts.map((f, i) => [keys[i], {
      type: "score" as const,
      instructions: `老板的完整排序规则：${state.ownerRules}。规则中的明确优先关系和排最后条件优先于其他综合优势，不能抵消。根据 state.models.${keys[i]}（${f.id}）的事实，评估它在本组内的优先程度。先按 trendDictionary 解释所有 trends 字段，结合当前水平与趋势，不用大样本历史平均掩盖近期变化。老板规则未指定统计口径时沿用 usage 的原有口径，不能擅自把平均值阈值换成 P90 或最后一次请求。该通道近7天平均首 token 延迟：${f.usage?.ttftMs === undefined ? "未知" : `${f.usage.ttftMs / 1000} 秒`}；这不是生成速度。缺失数据表示未知，不推断为满足或违反条件。`,
      criteria: LEVELS.map(level => `老板规则「${state.ownerRules}」。${level}`),
    }]));
  // Normalize exactly as the HTTP client does, so the persisted snapshot has no undefined fields.
  const payload: RankingRequestPayload = JSON.parse(JSON.stringify({ model: jev.model, state, questions }));
  if(Buffer.byteLength(JSON.stringify(payload.state),"utf8") > RANKING_INPUT_BUDGET.stateBytes || Buffer.byteLength(JSON.stringify(payload),"utf8") > RANKING_INPUT_BUDGET.requestBytes)
    throw Error("ranking input exceeds Jev safety budget; preserve the previous order");
  await beforeAsk?.(payload);
  const response = await jev.ask(payload.state, payload.questions);
  const { answers } = response;
  // score is the expectation over the five levels, so a mid-ranked model is still placed correctly
  // even though its confidence (mass on the single most likely level) is low. Only gaps are rejected.
  for (const key of keys) {
    const a = answers[key];
    if (a?.type !== "score" || !Number.isFinite(a.score) || a.score! < 0 || a.score! > 4) throw Error("Jev 排序结果不完整");
  }
  const rows = facts
    .map((f, i) => ({ facts: f, i, score: answers[keys[i]!]!.score!, confidence: answers[keys[i]!]!.confidence }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ i, ...row }) => row);
  afterAnswer?.({ tier, at: new Date().toISOString(), model: response.model, rules: state.ownerRules,
    rows: JSON.parse(JSON.stringify(rows)), answers: JSON.parse(JSON.stringify(answers)) });
  return rows.map(row => row.facts.id);
}

export interface RankingRequestPayload {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, import("../dispatcher/jev.ts").JevQuestion>;
}
export interface RankingRequestSnapshot {
  tier: string;
  at: string;
  payload: RankingRequestPayload;
}

/** Last successfully applied response and the exact facts used to judge it; never mixed with later attempts. */
export interface RankingResultSnapshot {
  tier: Tier;
  at: string;
  model: string;
  rules: string;
  rows: Array<{ facts: ModelFacts; score: number; confidence?: number }>;
  answers: JevResult["answers"];
  /** Observations for pinned members, kept outside the Jev request and scored rows. */
  pinnedFacts?: ModelFacts[];
}
export interface RankingTableRow {
  model: string; pinned?: boolean;
  trends?: ModelTrends; trendSource?: ModelFacts["trendSource"];
  aaScore?: number; aaRank?: number; effort?: string;
  tokensPerSecond?: number; ttftMs?: number; stabilityPct?: number; stabilitySamples?: number;
  accounts: ModelFacts["accounts"];
  performanceScore?: number; performanceSamples?: number;
  jevScore?: number; jevConfidence?: number;
}
export interface RankingTable {
  group: string; at?: string; rules?: string; scored: boolean;
  rows: RankingTableRow[];
}
/** Current Magpie membership/order wins; a changed effort is a new member and must not inherit an old score. */
export function rankingTables(groups: Record<string,string[]>, results: Record<string,RankingResultSnapshot> = {}, requests: RankingRequestSnapshot[] = [], pins: RankingPins = {}): RankingTable[] {
  return RANKED_TIERS.map(tier => {
    const group = `sck-${tier}`, result = results[group];
    const request = requests.find(r => r.tier === tier);
    const legacy = Object.values((request?.payload.state.models ?? {}) as Record<string,ModelFacts>).map(expandRankingInput);
    const rows = (groups[group] ?? []).map(model => {
      const judged = result?.rows.find(row => row.facts.id === model);
      // Once a successful snapshot exists, do not borrow facts from a later failed/pending request.
      const facts = judged?.facts ?? result?.pinnedFacts?.find(f => f.id === model) ?? (!result ? legacy.find(f => f.id === model) : undefined);
      return { model, trends: facts?.trends, trendSource:facts?.trendSource, pinned: (pins[group] ?? []).includes(model), aaScore: facts?.aa?.score, aaRank: facts?.aa?.rank, effort: facts?.aa?.effort,
        tokensPerSecond: facts?.usage?.tokensPerSecond, ttftMs: facts?.usage?.ttftMs,
        stabilityPct: facts?.usage?.requests ? Math.max(0,100*(1-facts.usage.errors/facts.usage.requests)) : undefined,
        stabilitySamples: facts?.usage?.requests,
        accounts: facts?.accounts ?? [], performanceScore: facts?.performance?.score,
        performanceSamples: facts?.performance?.samples, jevScore: (pins[group] ?? []).includes(model) ? undefined : judged?.score, jevConfidence: (pins[group] ?? []).includes(model) ? undefined : judged?.confidence };
    });
    return { group, at: result?.at ?? request?.at, rules: result?.rules ?? (!result ? request?.payload.state.ownerRules as string|undefined : undefined), scored: !!result, rows };
  }).filter(table => table.rows.length > 0);
}

/** Bounded history: keep the most recent attempted request per ranked group across restarts. */
export async function rankingRequests(db: Surreal): Promise<RankingRequestSnapshot[]> {
  const [rows] = await db.query<[RankingRequestSnapshot[]]>(
    "SELECT tier,at,payload FROM company_meta WHERE id IN [company_meta:model_ranking_request_opus,company_meta:model_ranking_request_sonnet,company_meta:model_ranking_request_haiku];");
  return RANKED_TIERS.flatMap(tier => rows.filter(row => row.tier === tier));
}

export interface RefresherDeps {
  db: Surreal;
  jev?: JevClient;
  /** Current members of each sck-* group in magpie. */
  groups(): Record<string, string[]>;
  facts(ids: string[]): Promise<ModelFacts[]>;
  /** Hand the new orders to the controller, which writes them into magpie. */
  apply(orders: Record<string, string[]>, isCurrent: () => boolean): Promise<void>;
  log?(message: string): void;
}

/** Owner's design: no timer of its own. The first request after the interval starts one refresh
 * in the background; saving new rules clears the clock so the next request refreshes at once. */
export class RankingRefresher {
  private last?: number;
  private minutes = DEFAULT_REFRESH_MINUTES;
  private running?: Promise<void>;
  private revision = 0;
  private stopped = false;
  private pinning?: Promise<void>;
  constructor(private readonly deps: RefresherDeps) {}
  reset(minutes = DEFAULT_REFRESH_MINUTES): void {
    this.last = undefined;
    this.minutes = minutes;
    this.revision++;
  }
  stop(): void { this.stopped = true; this.revision++; }
  settled(): Promise<void> { return this.running ?? Promise.resolve(); }
  trigger(now = Date.now()): void {
    if (this.stopped || !this.deps.jev || this.running || this.pinning || (this.last !== undefined && now - this.last < this.minutes * 60000)) return;
    this.last = now;
    const revision = this.revision;
    this.running = Promise.resolve().then(() => this.run(revision)).catch(() => this.deps.log?.("模型排序刷新失败，保留现有顺序"))
      .finally(() => { this.running = undefined; });
  }
  /** Invalidate in-flight Jev results before waiting; serialize edits from both owner surfaces. */
  setPin(group: string, model: string, pinned: boolean): Promise<void> {
    if (!RANKED_TIERS.some(t => group === `sck-${t}`) || !model || model.length > 300 || typeof pinned !== 'boolean')
      return Promise.reject(Error('置顶参数无效'));
    this.reset(this.minutes);
    const previous = this.pinning;
    const operation = (async () => {
      await previous?.catch(() => undefined);
      await this.settled();
      if (this.stopped) throw Error('排序服务已停止');
      const members = this.deps.groups()[group] ?? [];
      if (!members.includes(model)) throw Error('模型已不在当前分组，请刷新列表');
      const pins = await rankingPins(this.deps.db);
      const next = (pins[group] ?? []).filter(id => id !== model);
      if (pinned) {
        // Repeated clicks are idempotent, including the position among other pins.
        if (pins[group]?.includes(model)) next.splice(pins[group].indexOf(model), 0, model);
        else next.push(model);
      }
      const orders = {[group]: pinnedOrder(members, next)};
      await this.deps.db.query(
        "UPSERT company_meta:model_ranking SET pins=object::extend(pins ?? {},$pins),orders=object::extend(orders ?? {},$orders);",
        {pins:{[group]:next},orders});
      await this.deps.apply(orders, () => !this.stopped);
    })();
    const tracked = operation.finally(() => { if (this.pinning === tracked) this.pinning = undefined; });
    this.pinning = tracked;
    return tracked;
  }
  private async run(revision: number): Promise<void> {
    try {
      const settings = await rankingSettings(this.deps.db);
      this.minutes = settings.refreshMinutes;
      const live = this.deps.groups();
      const pins = await rankingPins(this.deps.db);
      const ids = [...new Set(RANKED_TIERS.flatMap(t => live[`sck-${t}`] ?? []))];
      const allFacts = await this.deps.facts(ids);
      const byId = new Map(allFacts.map(f => [f.id, f]));
      const orders: Record<string, string[]> = {};
      const errors: string[] = [];
      const results: Record<string,RankingResultSnapshot> = {};
      for (const tier of RANKED_TIERS) {
        if (revision !== this.revision || this.stopped) return;
        const members = live[`sck-${tier}`];
        if (!members?.length) continue;
        try {
          const pinned = pinnedOrder(members, pins[`sck-${tier}`]).filter(id => (pins[`sck-${tier}`] ?? []).includes(id));
          const facts = members.filter(id => !pinned.includes(id)).map(id => byId.get(id));
          if (facts.some(f => !f)) throw Error("missing facts");
          orders[`sck-${tier}`] = [...pinned, ...await jevOrder(this.deps.jev!, tier, settings.rules, facts as ModelFacts[], async payload => {
            await this.deps.db.query(
              "UPSERT type::record('company_meta',$key) SET tier=$tier,at=$at,payload=$payload;",
              { key: `model_ranking_request_${tier}`, tier, at: new Date().toISOString(), payload });
          }, result => { results[`sck-${tier}`] = {...result,pinnedFacts:pinned.map(id => byId.get(id)!).filter(Boolean)}; })];
        } catch (e) {
          // Upstream text stays in the local plugin log; the shared record only says which group kept its order.
          this.deps.log?.(`模型排序 ${tier} 失败：${(e as Error).message.slice(0, 200)}`);
          errors.push(`${tier} 刷新失败，保留原顺序`);
        }
      }
      if (revision !== this.revision || this.stopped) return;
      if (Object.keys(orders).length) await this.deps.apply(orders, () => revision === this.revision && !this.stopped);
      if (revision !== this.revision || this.stopped) return;
      await this.deps.db.query(
        "UPSERT company_meta:model_ranking SET at=time::now(),orders=object::extend(orders ?? {},$orders),results=object::extend(results ?? {},$results),error=$error,refresh_minutes=$minutes;",
        { orders, results, error: errors.length ? errors.join("；") : undefined, minutes: this.minutes });
    } catch (e) {
      this.deps.log?.(`模型排序刷新失败：${(e as Error).message.slice(0, 200)}`);
      if (revision === this.revision && !this.stopped) await this.deps.db.query(
        "UPSERT company_meta:model_ranking MERGE {at:time::now(),error:'刷新失败，保留现有顺序'};").catch(() => undefined);
    }
  }
}

export async function rankingSettings(db: Surreal): Promise<RankingSettings> {
  const [row] = await db.query<[{ ranking_rules?: string; ranking_refresh_minutes?: number } | undefined]>(
    "SELECT ranking_rules, ranking_refresh_minutes FROM ONLY company_meta:model_routing;");
  return { rules: row?.ranking_rules?.trim() || DEFAULT_RANKING_RULES, refreshMinutes: REFRESH_MINUTES.includes(row?.ranking_refresh_minutes as never) ? row!.ranking_refresh_minutes! : DEFAULT_REFRESH_MINUTES };
}
export async function saveRankingSettings(db: Surreal, settings: RankingSettings, refresher: RankingRefresher): Promise<void> {
  if (!REFRESH_MINUTES.includes(settings.refreshMinutes as never) || typeof settings.rules !== 'string' || settings.rules.length > 8000) throw Error('排序规则或刷新间隔无效');
  await db.query("UPSERT company_meta:model_routing MERGE {ranking_rules:$rules,ranking_refresh_minutes:$minutes};", {rules:settings.rules.trim() || DEFAULT_RANKING_RULES,minutes:settings.refreshMinutes});
  refresher.reset(settings.refreshMinutes);
}
