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
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[._]/g, "-")
    .replace(/-free$|:free$/, "");
/** One model served through several accounts shares its task evidence. */
export const canonicalModel = (id: string) =>
  normalize(id.slice(id.lastIndexOf("/") + 1));
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
      const canonical = normalize(model);
      // A dated snapshot slug (e.g. "-1017") is the same version; any other suffix is not.
      const b =
        benchmark.models.find((b) => b.slug === canonical) ??
        benchmark.models.find(
          (b) =>
            b.slug.startsWith(`${canonical}-`) &&
            /^\d{4,8}$/.test(b.slug.slice(canonical.length + 1)),
        );
      const score = b?.score;
      return {
        id: m.id,
        model,
        tier: score === undefined ? "sonnet" : score >= 50 ? "fable" : score >= 43 ? "opus" : score >= 33 ? "sonnet" : "haiku",
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
