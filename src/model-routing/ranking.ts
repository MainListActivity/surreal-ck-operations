import {rankingPolicy,DEFAULT_POLICY,type RankingPolicy} from './weights.ts';
import { RULE_ENGINE, RULE_DESCRIPTION, ruleOrder, type RuleDecision } from './rules.ts';
import { z } from "zod";
import type { ModelTrends } from "./trends.ts";
import type { ModelHealth } from "./health.ts";
import type { Surreal } from "surrealdb";
import type { JevClient, JevResult } from "../dispatcher/jev.ts";
import { aaRankOfScore, resolveBenchmark, splitMember, type Effort, type Tier } from "./policy.ts";

/** Opus is maintained entirely in Magpie; only Sonnet and Haiku use deterministic ranking. */
export const RANKED_TIERS: Tier[] = ["sonnet", "haiku"];
export const REFRESH_MINUTES = [2, 5, 10] as const;
export const DEFAULT_REFRESH_MINUTES = 5;
export const DEFAULT_RANKING_RULES = RULE_DESCRIPTION;

export interface RankingSettings {
  rules: string;
  refreshMinutes: number;
  policy?: RankingPolicy;
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
  accounts: Array<{ account: string; kind?:'subscription'|'plan'|'api'|'unknown'; remainingPct?: number; windows?:Array<{remainingPct:number;resetsAt?:string}> }>;
  /** The score at the level the member is pinned to (effort), not the model's best. */
  aa?: { rank: number; score: number; effort?: Effort };
  /** USD per 1M tokens; 0 when magpie serves it free. */
  price: { free: boolean; input?: number | null; output?: number | null; cacheHit?: number | null };
  usage?: UsageStat;
  performance?: { score: number; samples: number };
  /** Every try in Magpie's routing log, including refusals handed on to the next member. */
  health?: ModelHealth;
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
export function quotaAccounts(rows: Array<{ provider: string; name?: string; kind?:string; error?:string; readAt?:string; windows?: Array<{ remaining?: number; resetsAt?:string }> }>): Map<string, ModelFacts["accounts"]> {
  const out = new Map<string, ModelFacts["accounts"]>();
  for (const q of rows) {
    const list = out.get(q.provider) ?? [];
    const windows=q.error?[]:(q.windows??[]).filter(w=>!w.resetsAt||Date.parse(w.resetsAt)>Date.now());
    const left = windows.map((w) => w.remaining).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100);
    list.push({kind:q.kind==='subscription'||q.kind==='plan'||q.kind==='api'?q.kind:'unknown',windows:windows.flatMap(w=>typeof w.remaining==='number'&&Number.isFinite(w.remaining)&&w.remaining>=0&&w.remaining<=100?[{remainingPct:w.remaining,...(w.resetsAt?{resetsAt:w.resetsAt}:{})}]:[]), account: `${q.provider} #${list.length + 1}`, remainingPct: left.length ? Math.min(...left) : undefined });
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

export {TREND_COLUMNS,TREND_DICTIONARY,RANKING_INPUT_BUDGET,rankingInputFact} from "./ranking-input.ts";
import {buildRankingInput,expandRankingModels,RankingInputBudgetError,type RankingAttempt} from "./ranking-input.ts";
export type {RankingAttempt} from "./ranking-input.ts";

/** Only a standalone, unambiguous numeric TTFT tail clause is executable; arbitrary prose stays with Jev. */
export function ttftTailThreshold(rules:string):number|undefined {
  const values:number[]=[];
  for(const clause of rules.split(/[，,；;。\n]/).map(s=>s.trim()).filter(Boolean)) {
    const m=/^(?:平均\s*)?(?:首\s*token|首个\s*token|TTFT)\s*(?:延迟\s*)?(?:超过|大于|>)\s*(\d+(?:\.\d+)?)\s*(毫秒|ms|秒|s)\s*(?:的(?:模型)?)?\s*(?:排在最后|排最后|放到最后|排在末尾|排末尾)$/i.exec(clause);
    if(!m) {
      // Compile only fully understood independent preferences. Unknown clauses may contain an
      // exception to the tail rule in any language; do not guess from a growing blacklist.
      if(!/^(?:智能程度和速度综合优先|智能(?:程度)?优先|速度优先|token速率未知的排前面)$/i.test(clause))return undefined;
      continue;
    }
    const n=Number(m[1])*(["ms","毫秒"].includes(m[2]!.toLowerCase())?1:1000);
    if(!Number.isFinite(n)||n<0)return undefined;values.push(n);
  }
  const unique=[...new Set(values)];return unique.length===1?unique[0]:undefined;
}
const overTtftLimit=(f:ModelFacts|undefined,limit:number|undefined)=>limit!==undefined&&f?.usage?.ttftMs!==undefined&&f.usage.ttftMs>limit;

/** One Jev call per group: a priority score per member, highest first; ties keep the current order. */
export async function jevOrder(jev: JevClient, tier: Tier, rules: string, facts: ModelFacts[], beforeAsk?: (payload: RankingRequestPayload) => Promise<void>, afterAnswer?: (result: RankingResultSnapshot) => void, onAttempt?: (attempt:RankingAttempt) => Promise<void>): Promise<string[]> {
  const keys = facts.map((_, i) => `m${i}`);
  if (!facts.length) return [];
  const {payload,attempt}=buildRankingInput(jev.model,tier,rules.trim() || DEFAULT_RANKING_RULES,facts,LEVELS);
  await onAttempt?.(attempt);
  if(attempt.status==='budget_exceeded')throw new RankingInputBudgetError(attempt);
  await beforeAsk?.(payload);
  let response:JevResult;
  try {response=await jev.ask(payload.state,payload.questions);}
  catch(error){await onAttempt?.({...attempt,status:'upstream_error'});throw error;}
  const { answers } = response;
  // score is the expectation over the five levels, so a mid-ranked model is still placed correctly
  // even though its confidence (mass on the single most likely level) is low. Only gaps are rejected.
  for (const key of keys) {
    const a = answers[key];
    if (a?.type !== "score" || !Number.isFinite(a.score) || a.score! < 0 || a.score! > 4) {await onAttempt?.({...attempt,status:"invalid_answer"});throw Error("Jev 排序结果不完整");}
  }
  const tailLimit=ttftTailThreshold(rules);
  const rows = facts
    .map((f, i) => ({ facts: f, i, tail:overTtftLimit(f,tailLimit), score: answers[keys[i]!]!.score!, confidence: answers[keys[i]!]!.confidence }))
    .sort((a, b) => Number(a.tail)-Number(b.tail) || b.score - a.score || a.i - b.i)
    .map(({ i, tail, ...row }) => row);
  await onAttempt?.({...attempt,status:"success"});
  afterAnswer?.({ tier, at: new Date().toISOString(), model: response.model, rules: payload.state.ownerRules as string,
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
  engine?:string;
  policy?:RankingPolicy;
  tier: Tier;
  at: string;
  model: string;
  rules: string;
  rows: Array<{ facts: ModelFacts; score?: number; confidence?: number; decision?:RuleDecision }>;
  answers: JevResult["answers"];
  /** Observations for pinned members, kept outside the Jev request and scored rows. */
  pinnedFacts?: ModelFacts[];
  /** Members that kept failing: placed last by code, never sent to Jev, never given a score. */
  excludedFacts?: ModelFacts[];
}
/** Latest safety observations are independent of the last successful Jev answer. */
export interface RankingGateSnapshot {at:string;facts:ModelFacts[]}
export type RankingGates=Record<string,RankingGateSnapshot>;
export interface RankingTableRow {
  model: string; previousRank?:number; price?:ModelFacts["price"]; pinned?: boolean; tailReason?:string; decision?:RuleDecision;
  trends?: ModelTrends; trendSource?: ModelFacts["trendSource"];
  aaScore?: number; aaRank?: number; effort?: string;
  tokensPerSecond?: number; ttftMs?: number; stabilityPct?: number; stabilitySamples?: number;
  accounts: ModelFacts["accounts"];
  performanceScore?: number; performanceSamples?: number;
  jevScore?: number; jevConfidence?: number;
  health?: ModelHealth;
}
export interface RankingTable {
  group: string; at?: string; rules?: string; scored: boolean;
  rows: RankingTableRow[];
}
/** Current Magpie membership/order wins; a changed effort is a new member and must not inherit an old score. */
export function rankingTables(groups: Record<string,string[]>, results: Record<string,RankingResultSnapshot> = {}, requests: RankingRequestSnapshot[] = [], pins: RankingPins = {}, gates:RankingGates = {}): RankingTable[] {
  return RANKED_TIERS.map(tier => {
    const group = `sck-${tier}`, result = results[group], gate=gates[group];
    const tailLimit=ttftTailThreshold(result?.rules??"");
    const request = requests.find(r => r.tier === tier);
    const legacy = expandRankingModels(request?.payload.state ?? {});
    const rows = (groups[group] ?? []).map(model => {
      const judged = result?.rows.find(row => row.facts.id === model);
      // Once a successful snapshot exists, do not borrow facts from a later failed/pending request.
      const current=gate?.facts.find(f=>f.id===model);
      const excluded = gate ? (current?.health?.excluded ? current : undefined) : result?.excludedFacts?.find(f => f.id === model);
      const facts = excluded ?? judged?.facts ?? result?.pinnedFacts?.find(f => f.id === model) ?? current ?? (!result ? legacy.find(f => f.id === model) : undefined);
      const pinned = !excluded && (pins[group] ?? []).includes(model);
      const decision=judged?.decision;
      return { model, price:facts?.price, decision, tailReason:decision?.tail??(!pinned&&!excluded&&overTtftLimit(facts,tailLimit)?`老板规则要求末尾：原生平均首token ${facts!.usage!.ttftMs!/1000} 秒 > ${tailLimit!/1000} 秒`:undefined), trends: facts?.trends, trendSource:facts?.trendSource, pinned, health: gate ? current?.health : facts?.health, aaScore: facts?.aa?.score, aaRank: facts?.aa?.rank, effort: facts?.aa?.effort,
        tokensPerSecond: facts?.usage?.tokensPerSecond, ttftMs: decision?decision.ttftMs:facts?.usage?.ttftMs,
        stabilityPct: facts?.usage?.requests ? Math.max(0,100*(1-facts.usage.errors/facts.usage.requests)) : undefined,
        stabilitySamples: facts?.usage?.requests,
        accounts: facts?.accounts ?? [], performanceScore: facts?.performance?.score,
        performanceSamples: facts?.performance?.samples, jevScore: result?.engine?.startsWith('quality-pace-') || pinned || excluded ? undefined : judged?.score, jevConfidence: pinned || excluded ? undefined : judged?.confidence };
    });
    return { group, at: result?.at ?? request?.at, rules: result?.rules ?? (!result ? request?.payload.state.ownerRules as string|undefined : undefined), scored: !!result?.model, rows };
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
  private warming=false;
  private configuring?:Promise<void>;
  private previewSnapshot?:{at:string;groups:Record<string,string[]>;facts:ModelFacts[]};
  constructor(private readonly deps: RefresherDeps) {}
  reset(minutes = DEFAULT_REFRESH_MINUTES): void {
    this.last = undefined;
    this.minutes = minutes;
    this.revision++;
  }
  stop(): void { this.stopped = true; this.revision++; }
  settled(): Promise<void> { return this.running ?? Promise.resolve(); }
  trigger(now = Date.now()): void {
    if (this.stopped || this.running || this.pinning || this.configuring || (this.last !== undefined && now - this.last < (this.warming?30000:this.minutes * 60000))) return;
    this.last = now;
    const revision = this.revision;
    this.running = Promise.resolve().then(() => this.run(revision)).catch(() => this.deps.log?.("模型排序刷新失败，保留现有顺序"))
      .finally(() => { this.running = undefined; });
  }
  async configure(write:()=>Promise<void>,minutes:number):Promise<void>{
    const previous=this.configuring;
    const job=(async()=>{await previous?.catch(()=>undefined);this.reset(minutes);await this.pinning;await write();this.reset(minutes);})();
    this.configuring=job;
    try{await job;}finally{if(this.configuring===job)this.configuring=undefined;}
  }
  /** Read/collect only: never writes settings, orders or Magpie configuration. Frozen observations across slider edits. */
  async preview(input:unknown,refresh=false){
    const policy=rankingPolicy(input),groups=this.deps.groups(),ids=[...new Set(RANKED_TIERS.flatMap(t=>groups[`sck-${t}`]??[]))];
    if(refresh){const facts=await this.deps.facts(ids);this.previewSnapshot={at:new Date().toISOString(),groups,facts};}
    if(!this.previewSnapshot){
      const [status]=await this.deps.db.query<[{at?:string;results?:Record<string,RankingResultSnapshot>}|undefined]>('SELECT at,results FROM ONLY company_meta:model_ranking;');
      this.previewSnapshot={at:status?.at?String(status.at):new Date().toISOString(),groups,facts:Object.values(status?.results??{}).flatMap(r=>r.rows.map(row=>row.facts))};
    }
    const snapshot=this.previewSnapshot,pins=await rankingPins(this.deps.db),orders:Record<string,string[]>={},results:Record<string,RankingResultSnapshot>={};
    for(const tier of RANKED_TIERS){const group=`sck-${tier}`,members=groups[group]??[];
      const facts=members.map(id=>snapshot.facts.find(f=>f.id===id));
      if(facts.some(f=>!f))throw Error('预览观测不完整，请点击更新观测');
      const rows=ruleOrder(facts as ModelFacts[],pins[group],Date.parse(snapshot.at),policy);
      orders[group]=rows.map(r=>r.facts.id);results[group]={engine:RULE_ENGINE,policy,tier,at:snapshot.at,model:RULE_ENGINE,rules:RULE_DESCRIPTION,rows,answers:{}};
    }
    const tables=rankingTables(orders,results,[],pins).map(t=>({...t,rows:t.rows.map(r=>({...r,previousRank:(groups[t.group]??[]).indexOf(r.model)+1}))}));
    return {tables,at:snapshot.at,policy};
  }
  /** Invalidate in-flight Jev results before waiting; serialize edits from both owner surfaces. */
  setPin(group: string, model: string, pinned: boolean): Promise<void> {
    if (this.configuring)return Promise.reject(Error('配置保存中，请稍后重试'));
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
      const facts=await this.deps.facts(members);
      if(members.some(id=>!facts.some(f=>f.id===id)))throw Error('排序观测缺失，置顶尚未生效');
      const settings=await rankingSettings(this.deps.db);
      const rows=ruleOrder(members.map(id=>facts.find(f=>f.id===id)!),next,Date.now(),settings.policy);
      const orders = {[group]:rows.map(r=>r.facts.id)};
      const results={[group]:{engine:RULE_ENGINE,policy:settings.policy,tier:group.slice(4),at:new Date().toISOString(),model:RULE_ENGINE,rules:RULE_DESCRIPTION,rows,answers:{}}};
      await this.deps.db.query(
        "UPSERT company_meta:model_ranking SET pins=object::extend(pins ?? {},$pins),orders=object::extend(orders ?? {},$orders),results=object::extend(results ?? {},$results);",
        {pins:{[group]:next},orders,results});
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
      const gates:RankingGates={};
      for (const tier of RANKED_TIERS) {
        if (revision !== this.revision || this.stopped) return;
        const members = live[`sck-${tier}`];
        if (!members?.length) continue;
        // A member that keeps failing goes last by code, before Jev and over the owner's pins:
        // Jev cannot be relied on to read a refusal into a rank, and a pin must not keep it first.
        gates[`sck-${tier}`]={at:new Date().toISOString(),facts:members.flatMap(id=>byId.has(id)?[byId.get(id)!]:[])};
        try {
          const facts=members.map(id=>byId.get(id));
          if(facts.some(f=>!f))throw Error('missing facts');
          const rows=ruleOrder(facts as ModelFacts[],pins[`sck-${tier}`],Date.now(),settings.policy);
          orders[`sck-${tier}`]=rows.map(r=>r.facts.id);
          results[`sck-${tier}`]={engine:RULE_ENGINE,policy:settings.policy,tier,at:new Date().toISOString(),model:RULE_ENGINE,rules:RULE_DESCRIPTION,
            rows,answers:{}};
        } catch {
          errors.push(`${tier} 数据不完整，保留现有顺序`);
        }
      }
      if (revision !== this.revision || this.stopped) return;
      this.warming=Object.values(results).some(r=>r.rows.some(row=>row.decision?.coldStart));
      if (Object.keys(orders).length) await this.deps.apply(orders, () => revision === this.revision && !this.stopped);
      if (revision !== this.revision || this.stopped) return;
      await this.deps.db.query(
        "UPSERT company_meta:model_ranking SET at=time::now(),orders=object::extend(orders ?? {},$orders),results=object::extend(results ?? {},$results),gates=object::extend(gates ?? {},$gates),error=$error,refresh_minutes=$minutes;",
        { orders, results, gates, error: errors.length ? errors.join("；") : undefined, minutes: this.minutes });
    } catch (e) {
      this.deps.log?.(`模型排序刷新失败：${(e as Error).message.slice(0, 200)}`);
      if (revision === this.revision && !this.stopped) await this.deps.db.query(
        "UPSERT company_meta:model_ranking MERGE {at:time::now(),error:'刷新失败，保留现有顺序'};").catch(() => undefined);
    }
  }
}

export async function rankingSettings(db: Surreal): Promise<RankingSettings> {
  const [row] = await db.query<[{ranking_policy?:RankingPolicy;ranking_refresh_minutes?:number}|undefined]>(
    "SELECT ranking_rules, ranking_refresh_minutes, ranking_policy FROM ONLY company_meta:model_routing;");
  return {rules:DEFAULT_RANKING_RULES,policy:rankingPolicy(row?.ranking_policy??DEFAULT_POLICY),refreshMinutes:REFRESH_MINUTES.includes(row?.ranking_refresh_minutes as never)?row!.ranking_refresh_minutes!:DEFAULT_REFRESH_MINUTES};
}
export async function saveRankingSettings(db: Surreal, settings: RankingSettings, refresher: RankingRefresher): Promise<void> {
  if (!REFRESH_MINUTES.includes(settings.refreshMinutes as never) || typeof settings.rules !== 'string' || settings.rules.length > 8000) throw Error('排序规则或刷新间隔无效');
  // Older clients changing only the interval must not reset weights or billing decisions.
  const policy=rankingPolicy(settings.policy??(await rankingSettings(db)).policy);
  const write=async()=>{await db.query("UPSERT company_meta:model_routing MERGE {ranking_rules:$rules,ranking_refresh_minutes:$minutes,ranking_policy:$policy};",{rules:DEFAULT_RANKING_RULES,minutes:settings.refreshMinutes,policy});};
  if(typeof refresher.configure==='function')await refresher.configure(write,settings.refreshMinutes);
  else {await write();refresher.reset(settings.refreshMinutes);}
}
