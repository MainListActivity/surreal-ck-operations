import { z } from "zod";
import type { Surreal } from "surrealdb";
import type { JevClient, JevResult } from "../dispatcher/jev.ts";
import { aaRankOfScore, resolveBenchmark, splitMember, type Effort, type Tier } from "./policy.ts";

/** Fable is owner-only and keeps the owner's order; the three staff tiers are ranked by Jev. */
export const RANKED_TIERS: Tier[] = ["opus", "sonnet", "haiku"];
export const REFRESH_MINUTES = [2, 5, 10] as const;
export const DEFAULT_REFRESH_MINUTES = 5;
export const DEFAULT_RANKING_RULES = "智能程度和速度综合优先";

export interface RankingSettings {
  rules: string;
  refreshMinutes: number;
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

const LEVELS = ["最后考虑", "靠后", "中等", "靠前", "首选"];

/** One Jev call per group: a priority score per member, highest first; ties keep the current order. */
export async function jevOrder(jev: JevClient, tier: Tier, rules: string, facts: ModelFacts[], beforeAsk?: (payload: RankingRequestPayload) => Promise<void>, afterAnswer?: (result: RankingResultSnapshot) => void): Promise<string[]> {
  const keys = facts.map((_, i) => `m${i}`);
  if (!facts.length) return [];
  const state = {
      group: `group/sck-${tier}`,
      ownerRules: rules.trim() || DEFAULT_RANKING_RULES,
      models: Object.fromEntries(facts.map((f, i) => [keys[i], f])),
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
      instructions: `按老板规则，并综合能力、额度、价格、缓存命中、速度和绩效，${f.id} 在本组内应排多靠前？`,
      criteria: LEVELS,
    }]));
  // Normalize exactly as the HTTP client does, so the persisted snapshot has no undefined fields.
  const payload: RankingRequestPayload = JSON.parse(JSON.stringify({ model: jev.model, state, questions }));
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
}
export interface RankingTableRow {
  model: string;
  aaScore?: number; aaRank?: number; effort?: string;
  tokensPerSecond?: number; ttftMs?: number;
  accounts: ModelFacts["accounts"];
  performanceScore?: number; performanceSamples?: number;
  jevScore?: number; jevConfidence?: number;
}
export interface RankingTable {
  group: string; at?: string; rules?: string; scored: boolean;
  rows: RankingTableRow[];
}
/** Current Magpie membership/order wins; a changed effort is a new member and must not inherit an old score. */
export function rankingTables(groups: Record<string,string[]>, results: Record<string,RankingResultSnapshot> = {}, requests: RankingRequestSnapshot[] = []): RankingTable[] {
  return RANKED_TIERS.map(tier => {
    const group = `sck-${tier}`, result = results[group];
    const request = requests.find(r => r.tier === tier);
    const legacy = Object.values((request?.payload.state.models ?? {}) as Record<string,ModelFacts>);
    const rows = (groups[group] ?? []).map(model => {
      const judged = result?.rows.find(row => row.facts.id === model);
      // Once a successful snapshot exists, do not borrow facts from a later failed/pending request.
      const facts = judged?.facts ?? (!result ? legacy.find(f => f.id === model) : undefined);
      return { model, aaScore: facts?.aa?.score, aaRank: facts?.aa?.rank, effort: facts?.aa?.effort,
        tokensPerSecond: facts?.usage?.tokensPerSecond, ttftMs: facts?.usage?.ttftMs,
        accounts: facts?.accounts ?? [], performanceScore: facts?.performance?.score,
        performanceSamples: facts?.performance?.samples, jevScore: judged?.score, jevConfidence: judged?.confidence };
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
  constructor(private readonly deps: RefresherDeps) {}
  reset(minutes = DEFAULT_REFRESH_MINUTES): void {
    this.last = undefined;
    this.minutes = minutes;
    this.revision++;
  }
  stop(): void { this.stopped = true; this.revision++; }
  settled(): Promise<void> { return this.running ?? Promise.resolve(); }
  trigger(now = Date.now()): void {
    if (this.stopped || !this.deps.jev || this.running || (this.last !== undefined && now - this.last < this.minutes * 60000)) return;
    this.last = now;
    const revision = this.revision;
    this.running = Promise.resolve().then(() => this.run(revision)).catch(() => this.deps.log?.("模型排序刷新失败，保留现有顺序"))
      .finally(() => { this.running = undefined; });
  }
  private async run(revision: number): Promise<void> {
    try {
      const settings = await rankingSettings(this.deps.db);
      this.minutes = settings.refreshMinutes;
      const live = this.deps.groups();
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
          const facts = members.map(id => byId.get(id));
          if (facts.some(f => !f)) throw Error("missing facts");
          orders[`sck-${tier}`] = await jevOrder(this.deps.jev!, tier, settings.rules, facts as ModelFacts[], async payload => {
            await this.deps.db.query(
              "UPSERT type::record('company_meta',$key) SET tier=$tier,at=$at,payload=$payload;",
              { key: `model_ranking_request_${tier}`, tier, at: new Date().toISOString(), payload });
          }, result => { results[`sck-${tier}`] = result; });
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
