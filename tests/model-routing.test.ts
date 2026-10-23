import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classify,
  rank,
  taskTier,
  domainOf,
  modelIdentity,
} from "../src/model-routing/policy.ts";
import {
  startModelGateway,
  installRoutingSettings,
  routingEnv,
  type RoutingLease,
} from "../src/model-routing/gateway.ts";
// @ts-ignore Gateway module is deliberately plain JS, executed by magpie's JS runtime.
import { onRequest } from "../magpie/sck-performance.gateway.js";
const models = classify([
  { id: "claude/claude-opus-5-5" },
  { id: "codex/gpt-6-astra" },
  { id: "claude/claude-haiku-5-5" },
  { id: "relay/mystery" },
  { id: "group/any" },
  { id: "auto/gpt-6-astra" },
  { id: "remote-magpie/group/x" },
]);
test("catalog matches exact benchmark versions, conservatively classifies unknown models and omits group aliases", () => {
  expect(models).toHaveLength(4);
  expect(models.find((m) => m.model === "claude-opus-5-5")).toMatchObject({
    tier: "high",
    estimated: false,
  });
  expect(models.find((m) => m.model === "claude-haiku-5-5")?.tier).toBe(
    "medium",
  );
  // Unbenchmarked is unknown, not weak: neutral tier, ranked last by its prior.
  expect(models.find((m) => m.model === "mystery")).toMatchObject({
    tier: "medium",
    estimated: true,
    benchmark: undefined,
  });
  expect(classify([{ id: "sn/deepseek-v4.1-flash" }])[0]).toMatchObject({
    benchmark: "deepseek-v4-1-flash-1017",
    estimated: false,
  });
  expect(
    classify([{ id: "relay/claude-opus-5-5-preview" }])[0]?.benchmark,
  ).toBeUndefined();
});
test("task tiers honor explicit choice and keep complex/release work high", () => {
  expect(taskTier({ model_tier: "low", executor_role: "engineering" })).toBe(
    "low",
  );
  expect(taskTier({ executor_role: "engineering" })).toBe("high");
  expect(taskTier({ title: "上线申请" })).toBe("high");
  expect(taskTier({ title: "格式整理" })).toBe("low");
  expect(domainOf("story-author")).toBe("writing");
});
test("task evidence changes priority without allowing one tiny sample to dominate or crossing domains", () => {
  const now = Date.now();
  const weak = models.find((m) => m.model === "mystery")!;
  const strong = models.find((m) => m.model === "claude-opus-5-5")!;
  const results = Array.from({ length: 60 }, () => ({
    model: weak.id,
    domain: "engineering" as const,
    overall: 5,
    weight: 1,
    at: new Date(now).toISOString(),
  }));
  expect(rank([weak, strong], results.slice(0, 1), "engineering")[0]?.id).toBe(
    strong.id,
  );
  expect(
    rank(
      [weak, strong],
      [
        ...results,
        ...Array.from({ length: 10 }, () => ({
          ...results[0]!,
          model: strong.id,
          overall: 1,
        })),
      ],
      "engineering",
    )[0]?.id,
  ).toBe(weak.id);
  expect(rank([weak, strong], results, "writing")[0]?.id).toBe(strong.id);
  expect(
    rank(
      [weak, strong],
      [...results, { ...results[0]!, overall: NaN }],
      "engineering",
    ).every((m) => Number.isFinite(m.score)),
  ).toBe(true);
});
test("one model served through several accounts shares its task evidence", () => {
  const [a, b] = classify([
    { id: "codex/gpt-6-astra" },
    { id: "remote-magpie/codex/gpt-6-astra" },
  ]);
  const opus = models.find((m) => m.model === "claude-opus-5-5")!;
  const results = Array.from({ length: 30 }, () => ({
    model: a!.id,
    domain: "engineering" as const,
    overall: 1,
    weight: 1,
    at: new Date().toISOString(),
  }));
  const ranked = rank([a!, b!, opus], results, "engineering");
  expect(ranked[0]?.id).toBe(opus.id);
  expect(ranked.find((m) => m.id === b!.id)?.samples).toBe(30);
});
test("selector is deterministic per task lease, explores candidates and preserves unrelated requests", () => {
  const options = {
    routes: {
      "group/sck-engineering-high": [
        { group: "group/first" },
        { group: "group/second" },
        { group: "group/third" },
      ],
    },
  };
  const chosen = new Set();
  for (let i = 0; i < 1000; i++) {
    const body = {
      model: "group/sck-engineering-high",
      metadata: { user_id: `lease-${i}` },
      tools: [{ name: "x" }],
    };
    const a = onRequest(body, { options });
    expect(a).toEqual(onRequest(body, { options }));
    expect(a.tools).toEqual(body.tools);
    expect(body.model).toBe("group/sck-engineering-high");
    chosen.add(a.model);
  }
  expect(chosen.size).toBe(3);
  expect(onRequest({ model: "personal/model" }, { options })).toBeUndefined();
});
test("actual model identity never turns an unresolved group into a model score", () => {
  expect(modelIdentity("claude", "claude-opus-5-5")).toBe(
    "claude/claude-opus-5-5",
  );
  expect(modelIdentity("remote-magpie", "codex/gpt-6-astra")).toBe(
    "remote-magpie/codex/gpt-6-astra",
  );
  expect(modelIdentity("remote", "group/x")).toBeUndefined();
  expect(modelIdentity(null, "fake")).toBeUndefined();
});
const scratch = mkdtempSync(join(tmpdir(), "sck-routing-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
test("employee settings preserve other options and leave compaction setting alone", () => {
  installRoutingSettings(scratch, routingEnv("employee:test", 1234));
  const file = join(scratch, ".claude/settings.local.json");
  const old = JSON.parse(readFileSync(file, "utf8"));
  old.permissions = { allow: ["Read"] };
  old.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "471000";
  writeFileSync(file, JSON.stringify(old));
  installRoutingSettings(scratch, routingEnv("employee:test", 4321));
  const next = JSON.parse(readFileSync(file, "utf8"));
  expect(next.permissions).toEqual(old.permissions);
  expect(next.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("471000");
  expect(next.env.ANTHROPIC_BASE_URL).toContain(":4321/");
});
describe("streaming task gateway", () => {
  const lease: RoutingLease = {
    employee: "engineer",
    task: "task-1",
    fence: 4,
    role: "engineering",
    tier: "high",
    phase: "execute",
  };
  test("correlates actual model with the lease and streams bytes without forwarding credentials", async () => {
    const rows: any[] = [],
      complete: any[] = [];
    let input: any;
    const gateway = await startModelGateway(
      {
        lease: async () => lease,
        record: async (r) => {
          rows.push(r);
        },
        complete: async (...x) => {
          complete.push(x);
        },
        fetchImpl: (async (url: any, init: any) => {
          input = {
            url: String(url),
            headers: new Headers(init.headers),
            body: JSON.parse(init.body),
          };
          return new Response(
            'event: content_block_delta\ndata: {"type":"text_delta","text":"ok"}\n\ndata: {"type":"message_stop"}\n\n',
            {
              headers: {
                "content-type": "text/event-stream",
                "x-magpie-provider": "claude",
                "x-magpie-model": "claude-opus-5-5",
              },
            },
          );
        }) as unknown as typeof fetch,
      },
      0,
    );
    try {
      const r = await fetch(
        `http://127.0.0.1:${gateway.port}/a/employee%3Aengineer/v1/messages`,
        {
          method: "POST",
          headers: { authorization: "secret-never-forward" },
          body: JSON.stringify({
            model: "old-name",
            messages: [],
            stream: true,
          }),
        },
      );
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('"text":"ok"');
      for (let i = 0; i < 20 && !complete.length; i++) await Bun.sleep(5);
      expect(input.body.model).toBe("group/sck-engineering-high");
      expect(input.headers.get("authorization")).toBe("Bearer magpie-claude");
      expect(input.headers.get("x-magpie-session")).toMatch(/^sck-/);
      expect(rows[0]).toMatchObject({
        task: "task-1",
        employee: "engineer",
        fence: 4,
        model: "claude/claude-opus-5-5",
        completed: false,
      });
      expect(complete[0][1]).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("messages");
    } finally {
      await gateway.stop();
    }
  });
  test("rejects missing leases, browser requests and arbitrary upstream paths before spending tokens", async () => {
    let calls = 0;
    const g = await startModelGateway(
      {
        lease: async () => undefined,
        record: async () => {},
        complete: async () => {},
        fetchImpl: (async () => {
          calls++;
          throw Error("should not call");
        }) as unknown as typeof fetch,
      },
      0,
    );
    try {
      const url = `http://127.0.0.1:${g.port}`;
      expect(
        (await fetch(url + "/a/x/v1/messages", { method: "POST", body: "{}" }))
          .status,
      ).toBe(409);
      expect(
        (
          await fetch(url + "/a/x/v1/messages", {
            method: "POST",
            headers: { origin: "https://evil.example" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect(
        (await fetch(url + "/a/x/private", { method: "POST", body: "{}" }))
          .status,
      ).toBe(404);
      expect(calls).toBe(0);
    } finally {
      await g.stop();
    }
  });
  test("small-fast calls keep their model, never pin the lease and are marked auxiliary", async () => {
    const rows: any[] = [],
      sent: string[] = [],
      pins = new Map<string, string>();
    const g = await startModelGateway(
      {
        lease: async () => lease,
        record: async (r) => {
          rows.push(r);
        },
        complete: async () => {},
        pins: {
          get: (k) => pins.get(k),
          set: (k, v) => (v ? pins.set(k, v) : pins.delete(k)),
        },
        fetchImpl: (async (_url: any, init: any) => {
          const model = JSON.parse(init.body).model;
          sent.push(model);
          return new Response("{}", {
            status: model.includes("haiku") ? 429 : 200,
            headers: {
              "x-magpie-provider": "claude",
              "x-magpie-model": model.includes("haiku")
                ? "claude-haiku-5-5"
                : "claude-opus-5-5",
            },
          });
        }) as unknown as typeof fetch,
      },
      0,
    );
    try {
      const post = (model: string) =>
        fetch(`http://127.0.0.1:${g.port}/a/x/v1/messages`, {
          method: "POST",
          body: JSON.stringify({ model, messages: [] }),
        }).then((r) => r.text());
      await post("group/haiku5.5");
      await post("group/never-stuck");
      await post("group/haiku5.5");
      expect(sent).toEqual([
        "group/haiku5.5",
        "group/sck-engineering-high",
        "group/haiku5.5",
      ]);
      expect(rows[0]).toMatchObject({ phase: "auxiliary", status: 429 });
      expect(rows[1]).toMatchObject({ phase: "execute", status: 200 });
      // The auxiliary 429 did not cool the lease down, and the main model stays pinned.
      expect([...pins.values()]).toEqual(["claude/claude-opus-5-5"]);
    } finally {
      await g.stop();
    }
  });
  test("quota/failed requests retain infrastructure evidence and are not successful model work", async () => {
    const rows: any[] = [];
    const g = await startModelGateway(
      {
        lease: async () => lease,
        record: async (r) => {
          rows.push(r);
        },
        complete: async () => {},
        fetchImpl: (async () =>
          new Response('{"error":"quota"}', {
            status: 429,
          })) as unknown as typeof fetch,
      },
      0,
    );
    try {
      const r = await fetch(`http://127.0.0.1:${g.port}/a/x/v1/messages`, {
        method: "POST",
        body: "{}",
      });
      expect(r.status).toBe(429);
      await r.text();
      expect(rows[0]).toMatchObject({
        status: 429,
        model: null,
        attribution: "unknown",
      });
    } finally {
      await g.stop();
    }
  });
});

test("controller publishes complete model groups before selector options and reruns idempotently", async () => {
  const { ModelRoutingController } = await import(
    "../src/model-routing/controller.ts"
  );
  const calls: string[][] = [];
  let status: any;
  const db = {
    query: async (sql: string, vars: any) =>
      sql.includes("SELECT enabled")
        ? [{ enabled: true }]
        : sql.includes("FROM model_scorecard")
          ? [[]]
          : ((status = vars), []),
  };
  const controller = new ModelRoutingController(
    db as any,
    join(scratch, "controller"),
    join(import.meta.dir, "../magpie/sck-performance.gateway.js"),
    "unused",
    {
      fetch: (async () =>
        Response.json({
          data: [
            { id: "claude/claude-opus-5-5" },
            { id: "claude/claude-haiku-5-5" },
            { id: "relay/mystery" },
          ],
        })) as unknown as typeof fetch,
      command: async (args) => {
        calls.push(args);
      },
    },
  );
  await controller.refresh(true);
  expect(status.models).toHaveLength(3);
  expect(calls.at(-1)?.slice(0, 3)).toEqual([
    "plugin",
    "options",
    "sck-performance",
  ]);
  const options = JSON.parse(calls.at(-1)![3]!);
  expect(options.routes["group/sck-engineering-high"][0].model).toBe(
    "claude/claude-opus-5-5",
  );
  expect(
    calls
      .filter((c) => c[0] === "group")
      .every((c) => c.includes("routing=order") && c.includes("stays=session")),
  ).toBe(true);
  const n = calls.length;
  await controller.refresh(true);
  expect(calls.length).toBe(n);
});

test("durable local queue never waits for remote DB, survives restart and retains completions during a slow flush", async () => {
  const { ExecutionJournal } = await import("../src/model-routing/journal.ts");
  const dir = join(scratch, "queue");
  let finish!: () => void;
  let calls = 0;
  const db = {
    query: async () => {
      calls++;
      await new Promise<void>((r) => {
        finish = r;
      });
    },
  };
  const journal = new ExecutionJournal(dir);
  await journal.record({
    id: "request-1",
    status: 200,
    completed: false,
    at: new Date(),
    model: "relay/a",
  });
  expect(calls).toBe(0);
  const draining = journal.drain(db as any);
  expect(calls).toBe(1);
  await journal.complete("request-1", true);
  expect(
    JSON.parse(readFileSync(join(dir, "request-1.json"), "utf8")).completed,
  ).toBe(true);
  finish();
  await draining;
  expect(readFileSync(join(dir, "request-1.json"), "utf8")).toContain(
    '"completed":true',
  );
  const recovered = new ExecutionJournal(dir);
  let rows: any;
  await recovered.drain({
    query: async (_s: string, v: any) => {
      rows = v;
    },
  } as any);
  expect(rows.row0.completed).toBe(true);
  expect(() => readFileSync(join(dir, "request-1.json"), "utf8")).toThrow();
});

test("model pins survive restart, expire and are released when the selected model fails", async () => {
  const { RoutingPins } = await import("../src/model-routing/pins.ts");
  const path = join(scratch, "pins.json");
  const pins = new RoutingPins(path);
  pins.set("lease", "relay/a");
  expect(new RoutingPins(path).get("lease")).toBe("relay/a");
  pins.set("lease", undefined);
  expect(new RoutingPins(path).get("lease")).toBeUndefined();
  writeFileSync(path, JSON.stringify({ old: { model: "relay/old", at: 0 } }));
  expect(new RoutingPins(path).get("old")).toBeUndefined();
});

test("in-band SSE errors and truncated responses never count as completed model work", async () => {
  for (const data of [
    'event: error\ndata: {"type":"error","error":{"message":"quota"}}\n\n',
    'data: {"type":"content_block_delta"}\n\n',
  ]) {
    const done: boolean[] = [];
    const g = await startModelGateway(
      {
        lease: async () => ({
          employee: "e",
          task: "t",
          fence: 1,
          role: "engineering",
          tier: "high",
          phase: "execute",
        }),
        record: async () => {},
        complete: async (_id, c) => {
          done.push(c);
        },
        fetchImpl: (async () =>
          new Response(data, {
            headers: {
              "content-type": "text/event-stream",
              "x-magpie-provider": "relay",
              "x-magpie-model": "m",
            },
          })) as unknown as typeof fetch,
      },
      0,
    );
    try {
      const r = await fetch(`http://127.0.0.1:${g.port}/a/e/v1/messages`, {
        method: "POST",
        body: "{}",
      });
      await r.text();
      for (let i = 0; i < 20 && !done.length; i++) await Bun.sleep(5);
      expect(done).toEqual([false]);
    } finally {
      await g.stop();
    }
  }
});

test("a pinned model is reused after policy changes and quota failure falls back through its tier group", async () => {
  const pins = new Map<string, string>();
  const input: string[] = [];
  let unavailable = false;
  const g = await startModelGateway(
    {
      pins: {
        get: (k) => pins.get(k),
        set: (k, v) => {
          if (v) pins.set(k, v);
          else pins.delete(k);
        },
      },
      lease: async () => ({
        employee: "e",
        task: "t",
        fence: 1,
        role: "engineering",
        tier: "high",
        phase: "execute",
      }),
      record: async () => {},
      complete: async () => {},
      fetchImpl: (async (_url: any, init: any) => {
        const m = JSON.parse(String(init!.body)).model;
        input.push(m);
        if (unavailable && m === "relay/first")
          return new Response("{}", { status: 429 });
        return new Response("{}", {
          headers: {
            "x-magpie-provider": "relay",
            "x-magpie-model": unavailable ? "second" : "first",
          },
        });
      }) as unknown as typeof fetch,
    },
    0,
  );
  try {
    const send = async () => {
      const r = await fetch(`http://127.0.0.1:${g.port}/a/e/v1/messages`, {
        method: "POST",
        body: "{}",
      });
      await r.text();
    };
    await send();
    await send();
    unavailable = true;
    await send();
    expect(input).toEqual([
      "group/sck-engineering-high",
      "relay/first",
      "relay/first",
      "group/sck-engineering-high",
    ]);
    expect([...pins.values()]).toEqual(["relay/second"]);
  } finally {
    await g.stop();
  }
});

test("routing settings rollback preserves edits and restores only its managed keys", async () => {
  const { restoreRoutingSettings } = await import(
    "../src/model-routing/gateway.ts"
  );
  expect(restoreRoutingSettings(scratch)).toBe(true);
  const settings = JSON.parse(
    readFileSync(join(scratch, ".claude/settings.local.json"), "utf8"),
  );
  expect(settings.env.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("471000");
  expect(settings.permissions.allow).toEqual(["Read"]);
  expect(restoreRoutingSettings(scratch)).toBe(false);
});

test("magpie management batches group saves, keeps DB secrets out of child env and cleans up its process", async () => {
  const { saveMagpieGroups, magpieEnvironment } = await import(
    "../src/model-routing/magpie-admin.ts"
  );
  const { chmodSync } = await import("node:fs");
  const dir = join(scratch, "admin");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir);
  const data = join(dir, "received.json"),
    server = join(dir, "fake.cjs"),
    cli = join(dir, "fake-cli");
  writeFileSync(
    server,
    `const http=require('node:http'),fs=require('node:fs');const addr=process.argv[process.argv.indexOf('--addr')+1],port=Number(addr.split(':')[1]),rows=[];http.createServer(async(req,res)=>{if(req.headers.cookie!=='magpie_web_'+port+'='+process.env.MAGPIE_WEB_KEY){res.writeHead(401).end();return;}if(req.url==='/'){res.end('ready');return;}let raw='';for await(const chunk of req)raw+=chunk;rows.push(JSON.parse(raw));fs.writeFileSync(${JSON.stringify(data)},JSON.stringify({pid:process.pid,rows,leaked:process.env.SURREAL_ROOT_PASS!==undefined}));res.end('{}');}).listen(port,'127.0.0.1');`,
  );
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  writeFileSync(
    cli,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(server)} "$@"\n`,
  );
  chmodSync(cli, 0o700);
  const old = process.env.SURREAL_ROOT_PASS;
  process.env.SURREAL_ROOT_PASS = "fixture-must-not-leave-company";
  try {
    expect(magpieEnvironment().SURREAL_ROOT_PASS).toBeUndefined();
    await saveMagpieGroups(cli, [
      { id: "sck-one", models: ["relay/a"] },
      { id: "sck-two", models: ["relay/b"] },
    ]);
    const saved = JSON.parse(readFileSync(data, "utf8"));
    expect(saved.leaked).toBe(false);
    expect(saved.rows.map((r: any) => r.id)).toEqual(["sck-one", "sck-two"]);
    expect(saved.rows[0]).toMatchObject({
      members: ["relay/a"],
      routing: "order",
      affinity: "session",
    });
    expect(() => process.kill(saved.pid, 0)).toThrow();
  } finally {
    if (old === undefined) delete process.env.SURREAL_ROOT_PASS;
    else process.env.SURREAL_ROOT_PASS = old;
  }
});
