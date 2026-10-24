import type { Surreal } from "surrealdb";
import type { JevClient } from "../dispatcher/jev.ts";
import { aaRankOfScore, canonicalModel, resolveBenchmark, splitMember, type Effort, type Tier } from "./policy.ts";

/** Fable is owner-only and keeps the owner's order; the three staff tiers are ranked by Jev. */
export const RANKED_TIERS: Tier[] = ["opus", "sonnet", "haiku"];
export const REFRESH_MINUTES = [2, 5, 10] as const;
export const DEFAULT_REFRESH_MINUTES = 5;

export interface RankingSettings {
  rules: string;
  refreshMinutes: number;
}
export interface UsageStat {
  requests: number;
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

/** RFC 4180 rows: magpie's error columns can hold commas and quotes. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return head ? body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""]))) : [];
}

/** Per canonical model: cache-hit share of prompt tokens, decode speed and time to first token. */
export function usageStats(csv: string): Map<string, UsageStat> {
  const acc = new Map<string, { n: number; prompt: number; hit: number; out: number; decodeMs: number; ttft: number[] }>();
  for (const r of parseCsv(csv)) {
    if (r.status !== "200" || !r.served_model) continue;
    const key = canonicalModel(r.served_model);
    const a = acc.get(key) ?? { n: 0, prompt: 0, hit: 0, out: 0, decodeMs: 0, ttft: [] };
    const num = (k: string) => Number(r[k]) || 0;
    a.n++;
    a.prompt += num("input_tokens") + num("cache_read_tokens") + num("cache_write_tokens");
    a.hit += num("cache_read_tokens");
    const decode = num("duration_ms") - num("ttft_ms");
    if (num("output_tokens") > 0 && decode > 0) { a.out += num("output_tokens"); a.decodeMs += decode; }
    if (num("ttft_ms") > 0) a.ttft.push(num("ttft_ms"));
    acc.set(key, a);
  }
  return new Map([...acc].map(([k, a]) => {
    a.ttft.sort((x, y) => x - y);
    return [k, {
      requests: a.n,
      cacheHitRate: a.prompt ? Math.round((a.hit / a.prompt) * 1000) / 1000 : undefined,
      tokensPerSecond: a.decodeMs ? Math.round(a.out / (a.decodeMs / 1000)) : undefined,
      ttftMs: a.ttft.length ? a.ttft[Math.floor(a.ttft.length / 2)] : undefined,
    }];
  }));
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
      usage: sources.usage.get(canonicalModel(id)),
      performance: sources.performance.get(id),
    };
  });
}

const LEVELS = ["最后考虑", "靠后", "中等", "靠前", "首选"];

/** One Jev call per group: a priority score per member, highest first; ties keep the current order. */
export async function jevOrder(jev: JevClient, tier: Tier, rules: string, facts: ModelFacts[]): Promise<string[]> {
  const keys = facts.map((_, i) => `m${i}`);
  if (!facts.length) return [];
  const { answers } = await jev.ask(
    {
      group: `group/sck-${tier}`,
      ownerRules: rules || "（老板未设置额外规则）",
      models: Object.fromEntries(facts.map((f, i) => [keys[i], f])),
      notes: [
        "accounts.remainingPct：该订阅账号最紧的额度窗口剩余百分比；额度少的账号应靠后，避免撞上限。",
        "aa.rank：Artificial Analysis 智能指数全榜名次，越小越强；aa.effort 是该成员被固定的思考等级，分数即在该等级下测得。price：每百万 token 美元，free=true 为免费。",
        "usage：近 7 天实际调用，cacheHitRate 为缓存命中占提示 token 比例，tokensPerSecond 为输出速度，ttftMs 为首 token 中位延迟。",
        "performance：公司任务验收后的模型绩效（1–5 分）与样本数，样本少时参考价值低。",
      ],
    },
    Object.fromEntries(facts.map((f, i) => [keys[i], {
      type: "score" as const,
      instructions: `按老板规则，并综合能力、额度、价格、缓存命中、速度和绩效，${f.id} 在本组内应排多靠前？`,
      criteria: LEVELS,
    }])),
  );
  // score is the expectation over the five levels, so a mid-ranked model is still placed correctly
  // even though its confidence (mass on the single most likely level) is low. Only gaps are rejected.
  for (const key of keys) {
    const a = answers[key];
    if (a?.type !== "score" || !Number.isFinite(a.score) || a.score! < 0 || a.score! > 4) throw Error("Jev 排序结果不完整");
  }
  return facts
    .map((f, i) => ({ id: f.id, i, score: answers[keys[i]!]!.score! }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.id);
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
      for (const tier of RANKED_TIERS) {
        if (revision !== this.revision || this.stopped) return;
        const members = live[`sck-${tier}`];
        if (!members?.length) continue;
        try {
          const facts = members.map(id => byId.get(id));
          if (facts.some(f => !f)) throw Error("missing facts");
          orders[`sck-${tier}`] = await jevOrder(this.deps.jev!, tier, settings.rules, facts as ModelFacts[]);
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
        "UPSERT company_meta:model_ranking SET at=time::now(),orders=object::extend(orders ?? {},$orders),error=$error,refresh_minutes=$minutes;",
        { orders, error: errors.length ? errors.join("；") : undefined, minutes: this.minutes });
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
  return { rules: row?.ranking_rules ?? "", refreshMinutes: REFRESH_MINUTES.includes(row?.ranking_refresh_minutes as never) ? row!.ranking_refresh_minutes! : DEFAULT_REFRESH_MINUTES };
}
export async function saveRankingSettings(db: Surreal, settings: RankingSettings, refresher: RankingRefresher): Promise<void> {
  if (!REFRESH_MINUTES.includes(settings.refreshMinutes as never) || typeof settings.rules !== 'string' || settings.rules.length > 8000) throw Error('排序规则或刷新间隔无效');
  await db.query("UPSERT company_meta:model_routing MERGE {ranking_rules:$rules,ranking_refresh_minutes:$minutes};", {rules:settings.rules,minutes:settings.refreshMinutes});
  refresher.reset(settings.refreshMinutes);
}
