/** Read-only, bounded Magpie usage adapter. No prompts, credentials or sessions cross this boundary. */
import { createHash } from "node:crypto";
import { MAGPIE_BASE } from "../model-routing/magpie-contract.ts";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Magpie usage.Record.DecodeOf/DecodeWindow: reasoning and burst exclusions match its native summary. */
export function nativeDecode(r: Record<string, unknown>): number | undefined {
  let out = r.out, start = r.ttft_ms;
  const ms = r.ms, think = finite(r.reasoning) ? r.reasoning : 0, first = r.first_text_ms, flow = finite(r.flow_ms) ? r.flow_ms : 0;
  if (!finite(out) || !finite(start) || !finite(ms) || start <= 0 || (r.reasoning_hidden === true && !(finite(first) && first > 0))) return;
  if (think > 0) {
    if (finite(first) && first > 0) { out -= think; start = first; }
    else if (finite(r.first_reasoning_ms) && r.first_reasoning_ms >= start && flow > 0 && think <= out) start = r.first_reasoning_ms;
    else return;
  }
  const window = ms - Number(start);
  if (out <= 0 || window < 100 || out * 1000 > 10000 * window || (flow > 0 && flow * 4 < window)) return;
  if (think > 0 && finite(first) && first > 0 && out * (first - Number(r.ttft_ms)) > 20 * think * window) return;
  return out * 1000 / window;
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, 300) : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function stamp(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
export function parseMagpieJson(value: string): unknown {
  // JSON numbers may hold int64 route IDs. Preserve them before JS can round them,
  // including the full `ids` list in incremental trace responses.
  let result = "",
    i = 0;
  while (i < value.length) {
    if (value[i] === '"') {
      const start = i++;
      while (i < value.length) {
        if (value[i] === "\\") {
          i += 2;
          continue;
        }
        if (value[i++] === '"') break;
      }
      result += value.slice(start, i);
      continue;
    }
    if (value[i] === "-" || /[0-9]/.test(value[i]!)) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(value.slice(i));
      if (match) {
        const token = match[0];
        result +=
          !/[.eE]/.test(token) && !Number.isSafeInteger(Number(token))
            ? JSON.stringify(token)
            : token;
        i += token.length;
        continue;
      }
    }
    result += value[i++];
  }
  return JSON.parse(result);
}
/** Merge the trace's changed routes, retaining untouched in-flight requests. */
export function mergeTrace(previous: unknown, incoming: unknown): unknown {
  const next = record(incoming);
  if (!Array.isArray(next.ids) || !Array.isArray(next.routes)) throw Error("Magpie trace格式无效");
  const ids = new Set(next.ids.map(String));
  const routes = new Map<string, unknown>();
  if (record(previous).pid === next.pid)
    for (const row of list(record(previous).routes)) {
      const id = String(record(row).id);
      if (ids.has(id)) routes.set(id, row);
    }
  for (const row of next.routes) {
    const id = String(record(row).id);
    if (ids.has(id)) routes.set(id, row);
  }
  return { pid: next.pid, seq: next.seq, routes: [...routes.values()].slice(-60) };
}
export function normalizeTotals(value: unknown) {
  const r = record(value),
    timed = num(r.timed) ?? 0,
    decodeMs = num(r.decode_ms) ?? 0;
  return {
    requests: num(r.calls) ?? 0,
    errors: num(r.errors) ?? 0,
    input: num(r.input) ?? 0,
    output: num(r.output) ?? 0,
    cacheRead: num(r.cache_read) ?? 0,
    cacheWrite: num(r.cache_write) ?? 0,
    cost: num(r.cost),
    unpriced: num(r.unpriced) ?? 0,
    ttftMs: timed > 0 && num(r.ttft_ms) !== undefined ? Number(r.ttft_ms) / timed : undefined,
    decodeTokensPerSecond:
      (num(r.decode_n) ?? 0) > 0 && decodeMs > 0 && num(r.decode_out) !== undefined
        ? ((num(r.decode_out) ?? 0) * 1000) / decodeMs
        : undefined,
  };
}
export function normalizeRequest(value: unknown) {
  const r = record(value),
    account = text(r.providerAccount);
  return {
    id: hash(
      JSON.stringify([r.route_id, r.id, r.t, r.response_id, r.provider, r.providerKeyId, r.model]),
    ),
    at: stamp(r.t) ?? 0,
    terminal: text(r.agent) ?? "未知",
    provider: text(r.provider),
    model: text(r.model),
    accountId: account ? hash(`${r.provider}:${account}`) : undefined,
    accountLabel: account ? `账号 ${hash(`${r.provider}:${account}`).slice(0, 8)}` : undefined,
    accountLinked: !!account,
    completed: r.done !== false,
    status: num(r.status) ?? 0,
    totalMs: num(r.ms),
    ttftMs: num(r.ttft_ms),
    firstTextMs: num(r.first_text_ms),
    input: num(r.in),
    output: num(r.out),
    cacheRead: num(r.cache_read),
    cacheWrite: num(r.cache_write),
    cost: r.priced === true ? num(r.cost) : undefined,
    decodeTokensPerSecond: nativeDecode(r),
  };
}
export function normalizeQuota(value: unknown) {
  const r = record(value),
    provider = text(r.provider) ?? "未知",
    identity = text(r.user),
    id = hash(`${provider}:${identity ?? ""}`);
  return {
    id,
    provider,
    label: text(r.name) ?? provider,
    accountLabel: identity ? `账号 ${id.slice(0, 8)}` : undefined,
    status: r.error
      ? ("error" as const)
      : list(r.windows).length
        ? ("available" as const)
        : ("unknown" as const),
    windows: list(r.windows)
      .slice(0, 30)
      .map((value, i) => {
        const w = record(value);
        return {
          id: String(i),
          label: text(w.name) ?? "额度窗口",
          remainingPct: percent(w.remaining),
          usedPct: percent(w.used),
          resetsAt: text(w.resetsAt),
          display: text(w.display),
          unlimited: typeof w.unlimited === "boolean" ? w.unlimited : undefined,
        };
      }),
    readAt: stamp(r.readAt),
  };
}
function percent(value: unknown) {
  const n = num(value);
  return n !== undefined && n <= 100 ? n : undefined;
}
export interface UsageFilter {
  after?: string;
  period: "today" | "7d" | "30d";
  provider?: string;
  model?: string;
  terminal?: string;
  offset: number;
  limit: number;
}
export function usagePath(f: UsageFilter) {
  const q = new URLSearchParams({
    period: f.period,
    offset: String(f.offset),
    limit: String(f.limit),
  });
  if (f.provider) q.set("provider", f.provider);
  if (f.model) q.set("model", f.model);
  if (f.terminal) q.set("agent", f.terminal);
  return `/v1/magpie/usage/requests?${q}`;
}
export function normalizeGroups(value: unknown) {
  return list(value)
    .slice(0, 500)
    .map((value) => {
      const r = record(value);
      return {
        id: text(r.id) ?? "未知",
        label: text(r.name) ?? text(r.id) ?? "未知",
        provider: text(r.provider),
        ...normalizeTotals(r),
      };
    });
}
export function normalizeTrace(value: unknown, sessions: ReadonlySet<string>) {
  return list(record(value).routes)
    .filter((value) => {
      const r = record(value);
      return typeof r.session === "string" && sessions.has(r.session);
    })
    .slice(-60)
    .map((value) => {
      const r = record(value),
        tries = list(r.tries).map(record),
        attempt = tries.at(-1),
        candidate = list(r.order)
          .map(record)
          .find((c) => c.id === attempt?.id),
        done = r.done === true,
        account = candidate?.kind === "account" ? text(candidate.who) : undefined,
        provider = text(candidate?.provider) ?? text(r.provider),
        accountId = account ? hash(`${provider}:${account}`) : undefined;
      return {
        ...normalizeRequest({
          id: r.id,
          t: r.time,
          agent: r.agent,
          provider: candidate?.provider ?? r.provider,
          model: attempt?.served ?? attempt?.model ?? r.served,
          done,
          status: r.status,
          ms: done ? r.ms : undefined,
        }),
        id: hash(String(r.id)),
        completed: done,
        accountLinked: !!accountId,
        accountId,
        accountLabel: accountId ? `账号 ${accountId.slice(0, 8)}` : undefined,
        ttftMs: num(r.ttft),
        firstTextMs: num(r.firstText),
        output: num(r.out),
      };
    });
}
interface CacheEntry {
  value: unknown;
  at: number;
  pending?: Promise<unknown>;
}
export class MagpieUsage {
  private readonly cache = new Map<string, CacheEntry>();
  private trace: unknown;
  private traceAt = 0;
  private traceSeq = "";
  private traceInterest = 0;
  private observing = false;
  private stopped = false;
  private controller?: AbortController;
  constructor(
    private readonly base = MAGPIE_BASE,
    private readonly request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
    private readonly now = Date.now,
    /** The employee key for the VPS magpie; the caller reads it, so this module never touches the key file. */
    private readonly authorization: () => Record<string, string> = () => ({}),
  ) {}
  private async read(path: string, signal?: AbortSignal) {
    const response = await this.request(this.base + path, {
      headers: this.authorization(),
      signal: signal ?? AbortSignal.timeout(8000),
    });
    if (!response.ok) throw Error(`Magpie HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw Error("Magpie response missing");
    let data = "",
      size = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 8 * 1024 * 1024) throw Error("Magpie response too large");
        data += decoder.decode(part.value, { stream: true });
      }
      return parseMagpieJson(data + decoder.decode());
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  private async cached(path: string, ttl: number) {
    let entry = this.cache.get(path);
    if (entry && this.now() - entry.at < ttl)
      return { value: entry.value, at: entry.at, stale: false };
    if (!entry) {
      if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
      entry = { value: undefined, at: 0 };
      this.cache.set(path, entry);
    }
    if (!entry.pending) {
      entry.pending = this.read(path)
        .then((value) => {
          entry!.value = value;
          entry!.at = this.now();
          return value;
        })
        .finally(() => {
          entry!.pending = undefined;
        });
    }
    try {
      await entry.pending;
      return { value: entry.value, at: entry.at, stale: false };
    } catch {
      if (entry.value !== undefined) return { value: entry.value, at: entry.at, stale: true };
      throw Error("Magpie 用量暂不可用，请重试");
    }
  }
  async quotas() {
    const data = await this.cached("/v1/magpie/quotas", 60000);
    return {
      rows: list(record(data.value).data).slice(0, 500).map(normalizeQuota),
      stale: data.stale,
    };
  }
  async page(filter: UsageFilter) {
    // Read the boundary and its following rows in the SAME native snapshot.
    // A bounded overlap absorbs new insertions without offset-based duplicates.
    const probeOffset = filter.after ? Math.max(0, filter.offset - 250) : filter.offset;
    const data = await this.cached(
      usagePath({ ...filter, offset: probeOffset, limit: filter.after ? 500 : filter.limit }),
      5000,
    );
    const r = record(data.value);
    if (!Array.isArray(r.rows) || num(r.total) === undefined)
      throw Error("Magpie 请求列表格式无效");
    const normalized = r.rows.map(normalizeRequest);
    const boundary = filter.after ? normalized.findIndex((row) => row.id === filter.after) : -1;
    if (filter.after && boundary < 0) throw Error("分页边界已过期，请点击“最新请求”重新开始");
    const start = filter.after ? boundary + 1 : 0;
    if (
      filter.after &&
      start + filter.limit > normalized.length &&
      probeOffset + normalized.length < Number(r.total)
    )
      throw Error("分页边界已过期，请点击“最新请求”重新开始");
    const rows = normalized.slice(start, start + filter.limit);
    return {
      at: data.at,
      stale: data.stale,
      total: num(r.total)!,
      offset: filter.offset,
      limit: filter.limit,
      rows,
      hasMore: probeOffset + start + rows.length < Number(r.total),
    };
  }
  async overview(filter: UsageFilter) {
    const data = await this.cached(usagePath({ ...filter, offset: 0, limit: 1 }), 5000),
      r = record(data.value);
    if (num(r.calls) === undefined) throw Error("Magpie 汇总格式无效");
    const quota = await this.quotas().catch(() => ({ rows: [], stale: true })),
      by = record(r.by);
    return {
      at: data.at,
      source: "magpie" as const,
      stale: data.stale,
      totals: normalizeTotals(r),
      models: normalizeGroups(by.model),
      providers: normalizeGroups(by.provider),
      terminals: normalizeGroups(by.agent).slice(0, 100),
      series: list(r.series)
        .slice(-800)
        .map((value) => {
          const s = record(value);
          return {
            at: stamp(s.time) ?? 0,
            requests: num(s.calls) ?? 0,
            errors: num(s.errors) ?? 0,
            input: num(s.input) ?? 0,
            output: num(s.output) ?? 0,
          };
        }),
      quotas: quota.rows,
      partial: quota.stale || list(by.model).length > 500 || list(by.provider).length > 500,
    };
  }
  live(sessions: ReadonlySet<string>) {
    this.traceInterest = this.now();
    if (!this.observing && !this.stopped) void this.observe();
    return {
      at: this.traceAt,
      available: this.traceAt > 0 && this.now() - this.traceAt < 35000,
      requests: normalizeTrace(this.trace, sessions),
      quotas: [] as ReturnType<typeof normalizeQuota>[],
      note: "实时路由来自 Magpie。等待时显示已过时间；token 与首响应仅在上游确认后显示。额度独立缓存 60 秒。",
    };
  }
  private async observe() {
    this.observing = true;
    let firstRead = true;
    try {
      while (!this.stopped && this.now() - this.traceInterest < 30000) {
        this.controller = new AbortController();
        const timeout = setTimeout(() => this.controller?.abort(), 28000);
        try {
          const incoming = await this.read(
            `/v1/magpie/trace?after=${encodeURIComponent(this.traceSeq)}${firstRead ? "" : "&wait=1"}`,
            this.controller.signal,
          );
          const restarted =
            this.trace !== undefined && record(this.trace).pid !== record(incoming).pid;
          this.trace = mergeTrace(this.trace, incoming);
          this.traceAt = this.now();
          firstRead = false;
          this.traceSeq = restarted ? "" : String(record(incoming).seq ?? "");
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      this.observing = false;
    }
  }
  stop() {
    this.stopped = true;
    this.controller?.abort();
    this.cache.clear();
  }
}
