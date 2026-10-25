import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Whether a member has been answering at all, from Magpie's own routing log. Native usage only
 * records the try that finally answered, so a member that is refused and handed on (a plan that does
 * not include the model, a key that is gone) never shows an error there. This reads every try.
 */
export interface ModelHealth {
  source: "magpie-routing";
  excluded: boolean;
  reason?: "unavailable" | "consecutive_errors" | "error_rate";
  attempts: number;
  errors: number;
  consecutiveErrors: number;
  lastStatus?: number;
  lastAttemptAt?: string;
}

export const HEALTH_WINDOW_MS = 24 * 3600_000;
/** Refusals that do not go away by retrying (auth, payment, plan or model not offered): remembered for the window. */
const DENIED = new Set([401, 402, 403, 404]);
/**
 * Transient failures (429, 5xx, lost streams) only count while recent. A member at the tail is rarely
 * tried, so it could never show a success again: after the cooldown it goes back to Jev, and a new
 * failing streak sends it back.
 */
const CONSECUTIVE = { count: 3, cooldownMs: 30 * 60_000 };
const RATE = { attempts: 5, ratio: 0.5, windowMs: 3600_000 };
const DAY = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

interface Try { id?: unknown; model?: unknown; start?: unknown; done?: unknown; status?: unknown }

export async function readModelHealth(now: number, dir = join(homedir(), ".config", "magpie", "routing")): Promise<Map<string, ModelHealth>> {
  let names: string[];
  try { names = await readdir(dir); } catch { return new Map(); }
  // Files are named by Magpie's local date; a day of slack on each side covers any time zone.
  const from = now - HEALTH_WINDOW_MS;
  const wanted = names.filter((n) => {
    const day = DAY.exec(n)?.[1];
    const at = day ? Date.parse(`${day}T00:00:00Z`) : NaN;
    return at >= from - 2 * 86400_000 && at <= now + 86400_000;
  }).sort();
  // A route is logged again as it progresses; the last copy of each route id is the whole story.
  const routes = new Map<string, Try[]>();
  for (const name of wanted) {
    let text: string;
    try {
      const raw = await readFile(join(dir, name));
      text = (name.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
    } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as { id?: unknown; tries?: unknown };
        if (Array.isArray(r.tries)) routes.set(String(r.id), r.tries as Try[]);
      } catch { /* a half-written line */ }
    }
  }
  const byModel = new Map<string, Array<{ at: number; status: number }>>();
  for (const tries of routes.values())
    for (const t of tries) {
      const at = typeof t.start === "string" ? Date.parse(t.start) : NaN;
      // Unfinished tries and requests the agent itself cancelled (499) say nothing about the model.
      if (t.done !== true || typeof t.status !== "number" || t.status === 499 || typeof t.id !== "string" || typeof t.model !== "string") continue;
      if (!(at >= from && at <= now)) continue;
      const key = `${t.id}/${t.model}`;
      (byModel.get(key) ?? byModel.set(key, []).get(key)!).push({ at, status: t.status });
    }
  const out = new Map<string, ModelHealth>();
  for (const [key, list] of byModel) {
    list.sort((a, b) => a.at - b.at);
    const failed = (s: number) => s < 200 || s >= 400;
    const errors = list.filter((x) => failed(x.status)).length;
    let consecutiveErrors = 0;
    for (let i = list.length - 1; i >= 0 && failed(list[i]!.status); i--) consecutiveErrors++;
    const last = list.at(-1)!;
    const recent = list.filter((x) => x.at >= now - RATE.windowMs);
    const reason = consecutiveErrors && DENIED.has(last.status) ? "unavailable"
      : consecutiveErrors >= CONSECUTIVE.count && last.at >= now - CONSECUTIVE.cooldownMs ? "consecutive_errors"
      : recent.length >= RATE.attempts && recent.filter((x) => failed(x.status)).length / recent.length >= RATE.ratio ? "error_rate"
      : undefined;
    out.set(key, { source: "magpie-routing", excluded: !!reason, ...(reason ? { reason } : {}), attempts: list.length, errors,
      consecutiveErrors, lastStatus: last.status, lastAttemptAt: new Date(last.at).toISOString() });
  }
  return out;
}
