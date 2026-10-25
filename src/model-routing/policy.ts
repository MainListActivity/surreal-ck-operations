import { createHash } from "node:crypto";
import benchmark from "./benchmarks.json";
export const TIERS = ["fable", "opus", "sonnet", "haiku"] as const;
export type Tier = typeof TIERS[number];
export type TierInput = Tier | "high" | "medium" | "low";
export type Domain = "engineering" | "writing" | "general";
export interface CatalogModel {
  id: string;
  context_window?: number;
  context_length?: number;
  native_endpoints?: string[];
  type?: string;
  /** Levels magpie can send this model; empty when the vendor fixes it (e.g. a "-max" model id). */
  reasoning_levels?: string[];
}
export interface ModelCandidate {
  id: string;
  /** What the magpie group lists: the id, pinned to the level its AA score was measured at. */
  member?: string;
  effort?: Effort;
  score?: number;
  model: string;
  tier: Tier;
  prior: number;
  benchmark?: string;
  estimated: boolean;
  context: number;
}
export interface ModelResult {
  task?: string;
  model: string;
  domain: Domain;
  overall: number;
  weight: number;
  at: string;
}
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);
/** Roles remain audit metadata; all four tiers share one performance ranking. */
export const domainOf = (_role: string): Domain => "general";
export function selectedTier(model: unknown): Tier | undefined {
  if (typeof model !== "string") return;
  const legacy: Record<string, Tier> = {high:"opus",medium:"sonnet",low:"haiku"};
  if (legacy[model]) return legacy[model];
  const match = model.match(/^(?:group\/sck-|claude-)?(fable|opus|sonnet|haiku)(?:[-\d.].*)?$/i);
  return match?.[1]?.toLowerCase() as Tier | undefined;
}
export function taskTier(task: {model_tier?: string; kind?: string; executor_role?: string; reviewer_role?: string; title?: string}): Tier {
  return selectedTier(task.model_tier) ?? employeeTier(task.executor_role);
}
export function employeeTier(role?: string): Tier {
  return role === "gm" ? "opus" : role === "product" ? "sonnet" : "haiku";
}
export function managedModel(def: {provider?: string; model?: string; role?: string} | undefined): boolean {
  return def?.role !== "story-author" && def?.provider === "claude" && !!def?.model?.startsWith("group/sck-") && !!selectedTier(def.model?.replace(/^group\/sck-(engineering|writing|general)-/, ""));
}
/** Owner rule: no tier may hold a model scoring below this on the AA Intelligence Index. Unscored is not admitted. */
export const AA_FLOOR = 38;
export const tierRank = (t: Tier) => TIERS.indexOf(t);
/** Owner rule (2026-10-23): boundaries are models, not numbers, so a rescored anchor moves its line.
 * <= deepseek-v4.1-flash: Sonnet and Haiku (one shared pool); above it up to and including
 * claude-sonnet-5.5: Opus; above sonnet-5.5: Fable. */
export const TIER_ANCHORS = { opusAbove: "deepseek-v4.1-flash", fableAbove: "claude-sonnet-5-5" } as const;
/** Haiku has no band of its own; it serves the Sonnet pool. */
export const tierPool = (t: Tier): Tier => (t === "haiku" ? "sonnet" : t);
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = typeof EFFORTS[number];
/** magpie fixes a member's reasoning with `provider/model:<effort>` (optionally `:fast` after it). */
export function splitMember(member: string): { id: string; effort?: Effort; fast: boolean } {
  let rest = member, fast = false;
  if (rest.endsWith(":fast")) { rest = rest.slice(0, -5); fast = true; }
  const i = rest.lastIndexOf(":");
  const effort = i > rest.lastIndexOf("/") ? rest.slice(i + 1).toLowerCase() : "";
  return EFFORTS.includes(effort as Effort) ? { id: rest.slice(0, i), effort: effort as Effort, fast } : { id: rest, fast };
}
export const pinEffort = (id: string, effort?: Effort) => (effort ? `${id}:${effort}` : id);
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/^[a-z0-9]+_(?=[a-z])/, "") // a vendor's own prefix: zai_glm-5.3-flash is glm-5.3-flash
    .replace(/@\d+[km]?$/, "") // magpie's context variant: grok-4.7@500k is grok-4.7
    .replace(/[._\s]+/g, "-")
    .replace(/-free$|:free$/, "");
/** One model served through several accounts shares its task evidence, whatever level it is pinned to. */
export const canonicalModel = (id: string) => {
  const base = splitMember(id).id;
  return normalize(base.slice(base.lastIndexOf("/") + 1));
};
export interface BenchmarkRow {
  slug: string;
  score: number;
  estimated?: boolean;
  /** USD per 1M tokens; absent when AA does not publish it. */
  priceInput?: number | null;
  priceOutput?: number | null;
  priceCacheHit?: number | null;
  /** AA's display name, e.g. "GPT-6 Luna (Max)": the slug often leaves the measured level out. */
  name?: string;
}
/** The level AA measured a row at, from the first word in its name's parentheses. */
export function effortOfName(name?: string): Effort | undefined {
  const word = name?.match(/\(([^),]+)/)?.[1]?.trim().toLowerCase();
  if (word === "non-reasoning") return "none";
  return EFFORTS.includes(word as Effort) ? (word as Effort) : undefined;
}
/** The model a row measures, without its level: "GPT-6 Luna (Max)" -> gpt-6-luna. */
const baseKey = (b: BenchmarkRow) => (b.name ? normalize(b.name.replace(/\(.*$/, "").trim()) : b.slug);
const fullKey = (b: BenchmarkRow) => { const e = effortOfName(b.name); return e ? `${baseKey(b)}-${e}` : baseKey(b); };
/** Exact, or the same version with a dated snapshot suffix (e.g. "-1017"); any other suffix is not. */
const sameModel = (key: string, model: string) =>
  key === model || (key.startsWith(`${model}-`) && /^\d{4,8}$/.test(key.slice(model.length + 1)));
/** The bundled snapshot until the daily AA refresh (aa.ts) supplies a newer one. */
let dataset: BenchmarkRow[] = benchmark.models;
export function useBenchmarks(rows: BenchmarkRow[]): void {
  if (rows.length) dataset = rows;
}
export const benchmarkRows = (): readonly BenchmarkRow[] => dataset;
/** Catalog id (no level) -> AA slug, for vendor names no rule can match; null: none is the same model. */
let aliases: Record<string, string | null> = {};
export function useAliases(map: Record<string, string | null>): void {
  aliases = { ...map };
}
export interface Resolved { row: BenchmarkRow; effort?: Effort }
/** The AA score this member runs at. A level is only claimed if magpie can send it: AA scores a model
 * per reasoning level, so a tier admitted on the Max score must be served at max. `levels` undefined
 * means unknown (anchors, the bundled list): the best measured variant. */
export function resolveBenchmark(member: string, levels?: string[]): Resolved | undefined {
  const { id, effort: pinned } = splitMember(member);
  const alias = aliases[id];
  if (alias === null) return;
  const aliased = alias ? dataset.find((b) => b.slug === alias) : undefined;
  const model = aliased ? baseKey(aliased) : normalize(id.slice(id.lastIndexOf("/") + 1));
  const family = dataset.filter((b) => sameModel(baseKey(b), model));
  if (!family.length) {
    // The id names one measured variant itself (gpt-6-luna-max): the vendor fixes its level.
    const row = aliased ?? dataset.find((b) => sameModel(b.slug, model) || sameModel(fullKey(b), model));
    return row && !pinned ? { row } : undefined;
  }
  const measured = family.filter((b) => effortOfName(b.name));
  if (!measured.length) {
    const row = family.reduce((a, b) => (b.score > a.score ? b : a));
    return { row };
  }
  if (pinned) {
    const row = measured.find((b) => effortOfName(b.name) === pinned);
    return row ? { row, effort: pinned } : undefined;
  }
  const usable = levels === undefined ? measured : measured.filter((b) => levels.includes(effortOfName(b.name)!));
  if (!usable.length) return;
  const row = usable.reduce((a, b) => (b.score > a.score ? b : a));
  return { row, effort: levels === undefined ? undefined : effortOfName(row.name) };
}
/** 1-based position by AA Intelligence Index among all published models. */
export function aaRankOf(model: string): number | undefined {
  const b = benchmarkOf(model);
  return b ? aaRankOfScore(b.score) : undefined;
}
export const aaRankOfScore = (score: number) => dataset.filter((x) => x.score > score).length + 1;
/** The model's best measured variant; members use resolveBenchmark with the levels magpie offers. */
export function benchmarkOf(model: string): BenchmarkRow | undefined {
  return resolveBenchmark(model)?.row;
}
function anchorScore(model: string): number {
  const score = benchmarkOf(model)?.score;
  if (score === undefined) throw Error(`tier anchor ${model} has no AA score`);
  return score;
}
export function tierOf(score: number): Tier {
  return score > anchorScore(TIER_ANCHORS.fableAbove) ? "fable"
    : score > anchorScore(TIER_ANCHORS.opusAbove) ? "opus" : "sonnet";
}
/** Exact version matches only. A preview/opaque vendor alias never inherits another model's benchmark.
 * Models without a public score, or below AA_FLOOR, are left out of every tier. */
/** A concrete chat model; groups, auto routers and embeddings are never members. */
export const routable = (m: CatalogModel) =>
  m.type !== "embedding" &&
  !/^(group|auto)\//.test(m.id) &&
  !/\/group\//.test(m.id) &&
  !/\/(auto|combo:.*)$/.test(m.id) &&
  (!m.native_endpoints || m.native_endpoints.some((p) => /messages|responses|chat/.test(p)));
export function classify(catalog: CatalogModel[]): ModelCandidate[] {
  return catalog
    .filter(routable)
    .map<ModelCandidate>((m) => {
      const model = m.id.slice(m.id.lastIndexOf("/") + 1);
      const resolved = resolveBenchmark(m.id, m.reasoning_levels);
      const b = resolved?.row;
      const score = b?.score;
      return {
        id: m.id,
        model,
        member: pinEffort(m.id, resolved?.effort),
        effort: resolved?.effort,
        tier: score === undefined ? "sonnet" : tierOf(score),
        prior:
          score === undefined ? 2.5 : Math.max(1, Math.min(5, 1 + score / 15)),
        benchmark: b?.slug,
        estimated: b?.estimated ?? true,
        context: m.context_window ?? m.context_length ?? 32768,
        score,
      };
    })
    .filter((m) => m.score !== undefined && m.score >= AA_FLOOR)
    .sort((a, b) => b.prior - a.prior || a.id.localeCompare(b.id));
}
/** Decayed task evidence with an eight-task prior; calls/tokens never become independent quality samples. */
export function rank(
  models: ModelCandidate[],
  results: ModelResult[],
  _domain: string = "general",
  now = Date.now(),
): Array<ModelCandidate & { score: number; samples: number }> {
  return models
    .map((m) => {
      let total = 8 * m.prior,
        weight = 8,
        samples = 0;
      for (const r of results)
        if (
          canonicalModel(r.model) === canonicalModel(m.id) &&
          Number.isFinite(r.overall) &&
          r.overall >= 1 &&
          r.overall <= 5 &&
          r.weight > 0
        ) {
          const w =
            Math.min(1, r.weight) *
            Math.pow(
              0.5,
              Math.max(0, now - Date.parse(r.at)) / (30 * 86400000),
            );
          if (!Number.isFinite(w)) continue;
          total += w * r.overall;
          weight += w;
          samples += Math.min(1, r.weight);
        }
      return { ...m, score: total / weight, samples };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
export function modelIdentity(
  provider: string | null,
  model: string | null,
): string | undefined {
  if (
    !provider ||
    !model ||
    /^(group|auto)\//.test(model) ||
    /\/group\//.test(model)
  )
    return undefined;
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}
