import { createHash } from "node:crypto";

export const TIERS = ["fable", "opus", "sonnet", "haiku"] as const;
export type Tier = typeof TIERS[number];

export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The tier of a model name: group/sck-<tier>, claude-<tier>-5-5, a bare tier, or a legacy high/medium/low. */
export function selectedTier(model: unknown): Tier | undefined {
  if (typeof model !== "string") return;
  const legacy: Record<string, Tier> = { high: "opus", medium: "sonnet", low: "haiku" };
  if (legacy[model]) return legacy[model];
  const match = model.match(/^(?:group\/sck-|claude-)?(fable|opus|sonnet|haiku)(?:[-\d.].*)?$/i);
  return match?.[1]?.toLowerCase() as Tier | undefined;
}

export function taskTier(task: {model_tier?: string; kind?: string; executor_role?: string; reviewer_role?: string; title?: string}): Tier {
  return selectedTier(task.model_tier) ?? employeeTier(task.executor_role);
}

export function employeeTier(role?: string): Tier {
  return role === "owner" || role === "gm" ? "opus" : role === "product" ? "sonnet" : "haiku";
}

/** Claude employees run on magpie groups. story-author keeps the model its author was configured with. */
export function managedModel(def: {provider?: string; model?: string; role?: string} | undefined): boolean {
  return !!def && def.role !== "story-author" && def.provider === "claude";
}
