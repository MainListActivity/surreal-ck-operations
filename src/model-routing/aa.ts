import { readFileSync } from "node:fs";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { BenchmarkRow } from "./policy.ts";

export const AA_SOURCE = "https://artificialanalysis.ai/leaderboards/models";
const DAY = 86400000;
const attempts = new Map<string, number>();

export interface AaSnapshot {
  source: string;
  retrievedAt: string;
  models: BenchmarkRow[];
}

/** The leaderboard page streams its data as Next.js flight chunks; `initialModels` holds every model. */
export function parseAaLeaderboard(html: string): BenchmarkRow[] {
  let flight = "";
  for (const m of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)) {
    try {
      const chunk = JSON.parse(m[1]!);
      if (typeof chunk[1] === "string") flight += chunk[1];
    } catch {}
  }
  const key = '"initialModels":';
  const start = flight.indexOf(key) + key.length;
  if (start < key.length) return [];
  let depth = 0, inString = false;
  for (let j = start; j < flight.length; j++) {
    const c = flight[j];
    if (inString) {
      if (c === "\\") j++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if ((c === "]" || c === "}") && --depth === 0) {
      const rows = JSON.parse(flight.slice(start, j + 1)) as Array<Record<string, any>>;
      return rows
        .filter((r) => typeof r.slug === "string" && typeof r.intelligenceIndex === "number" && !r.deprecated)
        .map((r) => ({
          slug: r.slug,
          score: r.intelligenceIndex,
          estimated: r.intelligenceIndexIsEstimated === true,
          priceInput: r.price1mInputTokens ?? null,
          priceOutput: r.price1mOutputTokens ?? null,
          priceCacheHit: r.cacheHitPrice ?? null,
          name: typeof r.name === "string" ? r.name : undefined,
        }));
    }
  }
  return [];
}

export function loadAa(file: string): AaSnapshot | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as AaSnapshot;
    if (!Array.isArray(value.models) || !Number.isFinite(Date.parse(value.retrievedAt)) || !value.models.every(m => typeof m.slug === 'string' && Number.isFinite(m.score))) return;
    return value;
  } catch {
    return undefined;
  }
}

/** At most one fetch a day. A failed or implausible fetch keeps the previous snapshot. */
export async function refreshAa(file: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<AaSnapshot | undefined> {
  const old = loadAa(file);
  // Snapshots from before names were kept cannot tell which reasoning level a score belongs to.
  if (old && now - Date.parse(old.retrievedAt) < DAY && old.models.some((m) => m.name)) return old;
  if (attempts.has(file) && now - attempts.get(file)! < DAY) return old;
  attempts.set(file, now);
  try {
    const reply = await fetchImpl(AA_SOURCE, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) });
    if (!reply.ok) return old;
    const models = parseAaLeaderboard(await reply.text());
    if (models.length < 50 || !models.some(m => /deepseek-v4-1-flash/.test(m.slug)) || !models.some(m => /claude-sonnet-5-5/.test(m.slug))) return old;
    const snapshot = { source: AA_SOURCE, retrievedAt: new Date(now).toISOString(), models };
    await mkdir(dirname(file), {recursive:true,mode:0o700});
    await writeFile(`${file}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    return snapshot;
  } catch {
    return old;
  }
}
