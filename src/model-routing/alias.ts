import { readFile, writeFile, rename } from "node:fs/promises";
import type { JevClient } from "../dispatcher/jev.ts";
import { benchmarkRows, canonicalModel, type BenchmarkRow } from "./policy.ts";

/** A vendor name no rule matches, decided once: by Jev for a new model, or by the owner. */
export interface AliasEntry {
  slug: string | null;
  by: "jev" | "owner";
  confidence?: number;
  /** Jev's pick when it was not sure enough to adopt it, for the owner to confirm. */
  suggested?: string;
  at: string;
}
export type AliasFile = Record<string, AliasEntry>;
/** Jev must be this sure before a vendor name borrows another model's AA score. */
export const ALIAS_CONFIDENCE = 0.7;
const CANDIDATES = 8;

export async function loadAliases(file: string): Promise<AliasFile> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}
export async function saveAliases(file: string, aliases: AliasFile): Promise<void> {
  await writeFile(`${file}.tmp`, JSON.stringify(aliases), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
export const aliasMap = (aliases: AliasFile) =>
  Object.fromEntries(Object.entries(aliases).map(([id, a]) => [id, a.slug]));

const bigrams = (s: string) => {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
};
/** Closest AA models by name (one row per model, its best variant), for Jev to choose from. */
export function aliasCandidates(id: string, rows: readonly BenchmarkRow[] = benchmarkRows()): BenchmarkRow[] {
  const target = bigrams(canonicalModel(id));
  const best = new Map<string, BenchmarkRow>();
  for (const r of rows) {
    const key = (r.name ?? r.slug).replace(/\(.*$/, "").trim();
    if (!best.has(key) || best.get(key)!.score < r.score) best.set(key, r);
  }
  const similarity = (r: BenchmarkRow) => {
    const other = bigrams(canonicalModel(r.slug));
    let shared = 0;
    for (const g of target) if (other.has(g)) shared++;
    return (2 * shared) / (target.size + other.size || 1);
  };
  return [...best.values()]
    .map((r) => ({ r, s: similarity(r) }))
    .sort((a, b) => b.s - a.s || b.r.score - a.r.score)
    .slice(0, CANDIDATES)
    .map((x) => x.r);
}

/** One Jev choice per new model: which AA entry is the same model under a vendor's name, or none. */
export async function askAlias(
  jev: JevClient,
  model: { id: string; display_name?: string; owned_by?: string },
  now = new Date(),
): Promise<AliasEntry> {
  const candidates = aliasCandidates(model.id);
  const options: Record<string, string | null> = Object.fromEntries(
    candidates.map((r, i) => [`a${i}`, `${r.name ?? r.slug}（slug ${r.slug}）`]),
  );
  options.none = "都不是：这是另一个模型，或无法确定";
  const { answers } = await jev.ask(
    {
      model: model.id,
      displayName: model.display_name,
      provider: model.id.slice(0, model.id.lastIndexOf("/")),
      notes: [
        "厂商常给同一个模型加自己的前缀、后缀或改大小写（如 zai_、-agent、-latest），但版本号或规格不同（flash/pro、27b/max、4.1/4.5）就是不同模型。",
        "只有确定是同一个模型时才选它；拿不准就选 none，宁缺毋滥，因为选中后它会借用该模型的公开智能分数进入分档。",
      ],
    },
    { same: { type: "choice", instructions: `${model.id} 与下列哪个 Artificial Analysis 榜单模型是同一个模型？`, criteria: options } },
  );
  const a = answers.same;
  const picked = a?.type === "choice" && a.choice && a.choice !== "none" ? candidates[Number(a.choice.slice(1))] : undefined;
  const confident = (a?.confidence ?? 0) >= ALIAS_CONFIDENCE;
  return {
    slug: picked && confident ? picked.slug : null,
    by: "jev",
    confidence: a?.confidence,
    suggested: picked && !confident ? picked.slug : undefined,
    at: now.toISOString(),
  };
}
