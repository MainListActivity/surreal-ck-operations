import { test, expect } from "bun:test";
import {
  normalizeRequest,
  normalizeQuota,
  normalizeTotals,
  parseMagpieJson,
} from "../src/usage/magpie.ts";
test("usage normalization keeps actual routing, missing prices unknown and private fields outside the result", () => {
  const row = normalizeRequest({
    t: "2026-10-25T12:00:00Z",
    agent: "claude",
    provider: "relay",
    model: "actual",
    status: 200,
    ms: 2000,
    out: 30,
    in: 100,
    providerKeyId: "opaque-key",
    session: "PRIVATE-session",
    err: "PRIVATE-error",
    prompt: "PRIVATE-prompt",
  });
  expect(row).toMatchObject({
    provider: "relay",
    model: "actual",
    output: 30,
    input: 100,
    totalMs: 2000,
    accountLinked: false,
  });
  expect(row.cost).toBeUndefined();
  expect(JSON.stringify(row)).not.toContain("PRIVATE");
  expect(
    normalizeTotals({
      calls: 20,
      errors: 2,
      input: 500,
      output: 100,
      decode_n: 2,
      decode_out: 100,
      decode_ms: 2000,
      ttft_ms: 5000,
      timed: 2,
      unpriced: 3,
    }),
  ).toMatchObject({
    requests: 20,
    errors: 2,
    decodeTokensPerSecond: 50,
    ttftMs: 2500,
    unpriced: 3,
  });
  expect(parseMagpieJson('{"id":9007199254740993,"ms":1200}')).toEqual({
    id: "9007199254740993",
    ms: 1200,
  });
});
import { MagpieUsage, normalizeTrace, usagePath } from "../src/usage/magpie.ts";
const filter = {
  period: "7d" as const,
  provider: "real/provider",
  model: "real:model",
  terminal: "claude",
  offset: 50,
  limit: 50,
};
test("native pagination filters are exact and never become a text search", () => {
  const url = new URL(usagePath(filter), "http://local");
  expect(url.searchParams.get("provider")).toBe("real/provider");
  expect(url.searchParams.get("model")).toBe("real:model");
  expect(url.searchParams.get("agent")).toBe("claude");
  expect(url.searchParams.get("offset")).toBe("50");
  expect(url.searchParams.has("q")).toBe(false);
});
test("trace associates the actual attempted candidate, never the first eligible one or a different session", () => {
  const route = {
    id: "9007199254740993",
    time: "2026-10-25T12:00:00Z",
    session: "exact",
    agent: "claude",
    model: "group/haiku",
    done: false,
    order: [
      { id: "wrong", provider: "wrong-provider" },
      { id: "right", provider: "right-provider", who: "PRIVATE" },
    ],
    tries: [{ id: "right", model: "actual-model" }],
    prompt: "PRIVATE",
  };
  const rows = normalizeTrace(
    { routes: [route, { ...route, id: "another", session: "other" }] },
    new Set(["exact"]),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    provider: "right-provider",
    model: "actual-model",
    completed: false,
    accountLinked: true,
  });
  expect(rows[0]?.output).toBeUndefined();
  expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  const unattempted = normalizeTrace({ routes: [{ ...route, tries: [] }] }, new Set(["exact"]))[0];
  expect(unattempted?.accountLinked).toBe(false);
  expect(unattempted?.model).toBeUndefined();
});
test("quota windows preserve percentages and mask private identity", () => {
  const quota = normalizeQuota({
    provider: "real",
    user: "PRIVATE@private.com",
    windows: [{ name: "weekly", remaining: 27, resetsAt: "2026-10-28T12:00:00Z" }],
  });
  expect(quota.windows[0]?.remainingPct).toBe(27);
  expect(JSON.stringify(quota)).not.toContain("PRIVATE");
});
test("single-flight cache retains last good data on failure with an explicit stale flag", async () => {
  let now = 10000,
    calls = 0,
    fail = false;
  const request = async () => {
    calls++;
    if (fail) return new Response("", { status: 503 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Response.json({
      total: 1,
      rows: [
        { t: "2026-10-25T12:00:00Z", provider: "actual", model: "actual", priced: false, cost: 0 },
      ],
      calls: 1,
      by: {},
      series: [],
    });
  };
  const source = new MagpieUsage("http://local", request, () => now);
  const [a, b] = await Promise.all([source.page(filter), source.page(filter)]);
  expect(calls).toBe(1);
  expect(a).toEqual(b);
  expect(a.rows[0]?.cost).toBeUndefined();
  now += 6000;
  fail = true;
  const stale = await source.page(filter);
  expect(stale.stale).toBe(true);
  expect(stale.at).toBe(10000);
  source.stop();
  const unavailable = new MagpieUsage("http://local", request);
  await expect(unavailable.page(filter)).rejects.toThrow("暂不可用");
  unavailable.stop();
});
test("overview uses filtered native aggregates rather than summing a single page", async () => {
  const source = new MagpieUsage("http://local", async (url: string) =>
    String(url).includes("quotas")
      ? Response.json({ data: [] })
      : Response.json({
          calls: 321,
          errors: 2,
          total: 321,
          rows: [],
          by: { provider: [{ id: "actual", calls: 321 }] },
          series: [{ time: "2026-10-25T12:00:00Z", calls: 321 }],
        }),
  );
  const view = await source.overview(filter);
  expect(view.totals.requests).toBe(321);
  expect(view.providers[0]?.requests).toBe(321);
  expect(view.series[0]?.requests).toBe(321);
  source.stop();
});
