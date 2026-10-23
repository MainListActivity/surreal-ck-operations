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
}
export interface ModelCandidate {
  id: string;
  model: string;
  tier: Tier;
  prior: number;
  benchmark?: string;
  estimated: boolean;
  context: number;
}
export interface ModelResult {
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
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[._]/g, "-")
    .replace(/-free$|:free$/, "");
/** One model served through several accounts shares its task evidence. */
export const canonicalModel = (id: string) =>
  normalize(id.slice(id.lastIndexOf("/") + 1));
export interface BenchmarkRow {
  slug: string;
  score: number;
  estimated?: boolean;
  /** USD per 1M tokens; absent when AA does not publish it. */
  priceInput?: number | null;
  priceOutput?: number | null;
  priceCacheHit?: number | null;
}
/** The bundled snapshot until the daily AA refresh (aa.ts) supplies a newer one. */
let dataset: BenchmarkRow[] = benchmark.models;
export function useBenchmarks(rows: BenchmarkRow[]): void {
  if (rows.length) dataset = rows;
}
/** 1-based position by AA Intelligence Index among all published models. */
export function aaRankOf(model: string): number | undefined {
  const b = benchmarkOf(model);
  return b ? dataset.filter((x) => x.score > b.score).length + 1 : undefined;
}
/** Exact version, or the same version with a dated snapshot suffix (e.g. "-1017"); any other suffix is not. */
export function benchmarkOf(model: string): BenchmarkRow | undefined {
  const canonical = normalize(model);
  return (
    dataset.find((b) => b.slug === canonical) ??
    dataset.find(
      (b) =>
        b.slug.startsWith(`${canonical}-`) &&
        /^\d{4,8}$/.test(b.slug.slice(canonical.length + 1)),
    )
  );
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
export function classify(catalog: CatalogModel[]): ModelCandidate[] {
  return catalog
    .filter(
      (m) =>
        m.type !== "embedding" &&
        !/^(group|auto)\//.test(m.id) &&
        !/\/group\//.test(m.id) &&
        !/\/(auto|combo:.*)$/.test(m.id) &&
        (!m.native_endpoints ||
          m.native_endpoints.some((p) => /messages|responses|chat/.test(p))),
    )
    .map<ModelCandidate & { score?: number }>((m) => {
      const model = m.id.slice(m.id.lastIndexOf("/") + 1);
      const b = benchmarkOf(model);
      const score = b?.score;
      return {
        id: m.id,
        model,
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
    .map(({ score: _score, ...m }): ModelCandidate => m)
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
