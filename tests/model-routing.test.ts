import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classify,
  rank,
  taskTier,
  selectedTier,
  employeeTier,
  domainOf,
  modelIdentity,
} from "../src/model-routing/policy.ts";
import {
  startModelGateway,
  installRoutingSettings,
  routingEnv,
  type RoutingLease,
} from "../src/model-routing/gateway.ts";
const models = classify([
  { id: "claude/claude-opus-5-5" },
  { id: "codex/gpt-6-astra" },
  { id: "claude/claude-haiku-5-5" },
  { id: "relay/mystery" },
  { id: "relay/mimo-v2.6-flash" },
  { id: "codex/gpt-6-luna" },
  { id: "group/any" },
  { id: "auto/gpt-6-astra" },
  { id: "remote-magpie/group/x" },
]);
test("catalog matches exact benchmark versions, admits only AA >= 38 and omits group aliases", () => {
  expect(models.map((m) => m.model).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "gpt-6-astra", "gpt-6-luna"]);
  expect(models.find((m) => m.model === "claude-opus-5-5")).toMatchObject({
    tier: "fable",
    estimated: false,
  });
  expect(models.find((m) => m.model === "claude-haiku-5-5")?.tier).toBe(
    "sonnet",
  );
  // Owner rule: unscored (mystery) and below the floor (mimo-v2.6-flash, 37.9) enter no tier; 38.1 does.
  expect(models.some((m) => m.model === "mystery" || m.model === "mimo-v2.6-flash")).toBe(false);
  expect(models.find((m) => m.model === "gpt-6-luna")?.tier).toBe("sonnet");
  expect(classify([{ id: "sn/deepseek-v4.1-flash" }])[0]).toMatchObject({
    benchmark: "deepseek-v4-1-flash-1017",
    estimated: false,
  });
  expect(classify([{ id: "relay/claude-opus-5-5-preview" }])).toEqual([]);
});
test("tier lines are the owner's anchor models: deepseek-v4.1-flash and below is Sonnet/Haiku, up to sonnet-5.5 is Opus", () => {
  const tiers = Object.fromEntries(classify([
    { id: "a/deepseek-v4.1-flash" }, { id: "a/kimi-k3" }, { id: "a/gpt-6.1-sol" },
    { id: "a/gpt-6-astra" }, { id: "a/claude-sonnet-5-5" }, { id: "a/claude-opus-5-5" },
  ]).map((m) => [m.model, m.tier]));
  expect(tiers).toEqual({
    "deepseek-v4.1-flash": "sonnet", "kimi-k3": "sonnet",
    "gpt-6.1-sol": "opus", "gpt-6-astra": "opus", "claude-sonnet-5-5": "opus",
    "claude-opus-5-5": "fable",
  });
});
test("Haiku serves the Sonnet pool, and Fable serves Opus while its own models are excluded", async () => {
  const { ModelRoutingController } = await import("../src/model-routing/controller.ts");
  const calls: string[][] = [];
  const db = { query: async (sql: string) => (sql.includes("SELECT enabled") ? [{ enabled: true, disabledModels: ["a/claude-opus-5-5"] }] : [[]]) };
  const controller = new ModelRoutingController(db as any, join(scratch, "controller-pools"), "unused", {
    fetch: (async () => Response.json({ data: [{ id: "a/claude-opus-5-5" }, { id: "a/gpt-6.1-sol" }, { id: "a/deepseek-v4.1-flash" }] })) as unknown as typeof fetch,
    command: async (args) => { calls.push(args); },
  });
  await controller.refresh(true);
  const members = Object.fromEntries(calls.filter((c) => c[1] === "add").map((c) => [c[2], c[3]]));
  expect(members).toEqual({
    "sck-fable": "models=a/gpt-6.1-sol", "sck-opus": "models=a/gpt-6.1-sol",
    "sck-sonnet": "models=a/deepseek-v4.1-flash", "sck-haiku": "models=a/deepseek-v4.1-flash",
  });
});
test("after the one-time grouping, membership is the owner's: manual edits stay, only unseen models are placed", async () => {
  const { ModelRoutingController } = await import("../src/model-routing/controller.ts");
  let catalog = [{ id: "a/gpt-6.1-sol" }, { id: "a/deepseek-v4.1-flash" }, { id: "a/kimi-k3" }];
  const store: Record<string, string[]> = {};
  const db = { query: async (sql: string) => (sql.includes("SELECT enabled") ? [{ enabled: true }] : [[]]) };
  const controller = new ModelRoutingController(db as any, join(scratch, "controller-owner"), "unused", {
    fetch: (async () => Response.json({ data: catalog })) as unknown as typeof fetch,
    command: async (args) => { if (args[0] === "group" && args[1] === "add") store[args[2]!] = args[3]!.slice(7).split(","); },
    groups: () => store,
  });
  await controller.refresh(true);
  expect([...store["sck-sonnet"]!].sort()).toEqual(["a/deepseek-v4.1-flash", "a/kimi-k3"]);
  // The owner takes kimi out of Sonnet and puts an unscored model into Haiku by hand.
  store["sck-sonnet"] = ["a/deepseek-v4.1-flash"];
  store["sck-haiku"] = [...store["sck-haiku"]!, "a/hand-picked"];
  // A model magpie has never served before appears.
  catalog = [...catalog, { id: "b/glm-5.3-flash" }];
  await controller.refresh(true);
  expect(store["sck-sonnet"]!.includes("a/kimi-k3")).toBe(false);
  expect(store["sck-haiku"]).toContain("a/hand-picked");
  expect(store["sck-sonnet"]).toContain("b/glm-5.3-flash");
  expect(store["sck-haiku"]).toContain("b/glm-5.3-flash");
  expect(store["sck-opus"]).toEqual(["a/gpt-6.1-sol"]);
});
test("four explicit tiers and owner-approved role defaults never depend on task titles", () => {
  expect(taskTier({ model_tier: "haiku", executor_role: "engineering" })).toBe("haiku");
  expect(taskTier({ executor_role: "engineering",title:"发布高风险功能" })).toBe("haiku");
  expect(employeeTier("gm")).toBe("opus");
  expect(employeeTier("product")).toBe("sonnet");
  expect(employeeTier("qa")).toBe("haiku");
  expect(selectedTier("claude-fable-5-1")).toBe("fable");
  expect(selectedTier("group/sck-haiku")).toBe("haiku");
  expect(taskTier({model_tier:"high"})).toBe("opus");
  expect(domainOf("story-author")).toBe("general");
});
test("task evidence changes priority without allowing one tiny sample to dominate or crossing domains", () => {
  const now = Date.now();
  const weak = { id: "relay/mystery", model: "mystery", tier: "sonnet" as const, prior: 2.5, estimated: true, context: 32768 };
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
  expect(rank([weak, strong], results, "writing", now)).toEqual(rank([weak,strong],results,"engineering",now));
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
    tier: "opus",
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
      expect(input.body.model).toBe("group/sck-opus");
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
  test("every request names a magpie tier group: cheaper tiers allowed, never above the lease, never a concrete model", async () => {
    const rows:any[]=[], sent:string[]=[];
    const g=await startModelGateway({lease:async()=>lease,record:async r=>{rows.push(r)},complete:async()=>{},
      fetchImpl:(async (_url:any,init:any)=>{sent.push(JSON.parse(init.body).model);return new Response('{}',{headers:{'x-magpie-provider':'claude','x-magpie-model':'claude-sonnet-5-5'}})}) as typeof fetch},0);
    try {
      // Twice the same: magpie having served a concrete model must not turn the next request into it.
      for(const model of ['haiku','sonnet','opus','group/sck-fable','claude/claude-sonnet-5-5[1m]','claude/claude-sonnet-5-5[1m]']) {
        const r=await fetch(`http://127.0.0.1:${g.port}/a/x/v1/messages`,{method:'POST',body:JSON.stringify({model,messages:[]})});await r.text();
      }
      expect(sent).toEqual(['group/sck-haiku','group/sck-sonnet','group/sck-opus','group/sck-opus','group/sck-opus','group/sck-opus']);
      expect(rows.every(r=>r.phase==='execute' && r.model==='claude/claude-sonnet-5-5')).toBe(true);
    } finally {await g.stop()}
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

test("controller writes only the four magpie tier groups, removes the retired selector and reruns idempotently", async () => {
  const { ModelRoutingController } = await import(
    "../src/model-routing/controller.ts"
  );
  const calls: string[][] = [];
  let status: any;
  const home = join(scratch, "controller");
  const db = {
    query: async (sql: string, vars: any) =>
      sql.includes("SELECT enabled")
        ? [{ enabled: true }]
        : sql.includes("FROM model_scorecard") || sql.includes("story-author")
          ? [[]]
          : ((status = vars), []),
  };
  // State left by the release that rewrote tiers into concrete-model route groups.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, "model-routing"), { recursive: true });
  writeFileSync(join(home, "model-routing", "groups.json"), JSON.stringify({ "sck-route-haiku-best": "x", __selector: "y", __options: "z" }));
  const store: Record<string, string[]> = {};
  const controller = new ModelRoutingController(db as any, home, "unused", {
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
      if (args[0] === "group" && args[1] === "add") store[args[2]!] = args[3]!.slice(7).split(",");
    },
    groups: () => store,
  });
  await controller.refresh(true);
  expect(status.models.map((m: any) => m.id)).toEqual(["claude/claude-opus-5-5", "claude/claude-haiku-5-5"]);
  const groups = calls.filter((c) => c[0] === "group" && c[1] === "add");
  expect(groups.map((c) => c[2])).toEqual(["sck-fable", "sck-opus", "sck-sonnet", "sck-haiku"]);
  expect(groups.every((c) => c.includes("routing=order") && c.includes("stays=session"))).toBe(true);
  expect(groups.every((c) => !c.join(" ").includes("mystery"))).toBe(true);
  expect(calls).toContainEqual(["plugin", "rm", join(home, "model-routing", "sck-performance.gateway.js")]);
  expect(calls).toContainEqual(["group", "rm", "sck-route-haiku-best"]);
  expect(calls.some((c) => c[0] === "plugin" && c[1] !== "rm")).toBe(false);
  expect(status.routes["group/sck-fable"][0].model).toBe("claude/claude-opus-5-5");
  const n = calls.length;
  await controller.refresh(true);
  expect(calls.length).toBe(n);
});

test("removing a route group that is already gone does not fail the sync", async () => {
  const { ModelRoutingController } = await import("../src/model-routing/controller.ts");
  const home = join(scratch, "controller-gone");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, "model-routing"), { recursive: true });
  writeFileSync(join(home, "model-routing", "groups.json"), JSON.stringify({ "sck-route-opus-best": "x" }));
  const db = { query: async (sql: string) => (sql.includes("SELECT enabled") ? [{ enabled: true }] : [[]]) };
  const controller = new ModelRoutingController(db as any, home, "unused", {
    fetch: (async () => Response.json({ data: [{ id: "claude/claude-opus-5-5" }] })) as unknown as typeof fetch,
    command: async (args) => {
      if (args[0] === "group" && args[1] === "rm") throw Error('magpie management command failed: group rm: magpie: no group "sck-route-opus-best"');
    },
  });
  await controller.refresh(true);
  expect(Object.keys(JSON.parse(readFileSync(join(home, "model-routing", "groups.json"), "utf8")))).toEqual(["sck-fable", "sck-opus", "sck-sonnet", "sck-haiku"]);
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
          tier: "opus",
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


test("an upstream connection failure is a 502 and the next request still names the tier group", async () => {
  const sent:string[]=[];
  const g=await startModelGateway({lease:async()=>({employee:'worker',task:'task',fence:1,role:'qa',tier:'haiku',phase:'execute'}),
    record:async()=>{},complete:async()=>{},
    fetchImpl:(async(_url:any,init:any)=>{sent.push(JSON.parse(init.body).model);if(sent.length===2)throw Error('ECONNRESET');return new Response('{}',{headers:{'x-magpie-provider':'relay','x-magpie-model':'actual'}})}) as typeof fetch},0);
  try {
    for(let n=0;n<3;n++){const r=await fetch(`http://127.0.0.1:${g.port}/a/worker/v1/messages`,{method:'POST',body:'{}'});expect(r.status).toBe(n===1?502:200);await r.text()}
    expect(sent).toEqual(['group/sck-haiku','group/sck-haiku','group/sck-haiku']);
  } finally {await g.stop()}
});

test("roster simplification preserves story authors, role tracks and review seats", async () => {
  const {planRoutingRoster}=await import('../src/model-routing/roster.ts');
  const defs=[{id:'qa-codex',role:'qa',provider:'codex',model:'native',enabled:true,tracks:['web']},
    {id:'qa-claude',role:'qa',provider:'claude',model:'old',enabled:true,tracks:['mobile']},
    {id:'gm-old',role:'gm',provider:'grok',model:'native',enabled:true},
    {id:'story',role:'story-author',provider:'codex',model:'keep-me',enabled:true},
    {id:'product-claude',role:'product',provider:'claude',model:'old',enabled:true}];
  const changes=planRoutingRoster(defs);
  expect(changes.some(d=>d.role==='story-author')).toBe(false);
  expect(changes.find(d=>d.id==='qa-codex')?.enabled).toBe(false);
  expect(changes.find(d=>d.id==='qa-claude')).toMatchObject({model:'group/sck-haiku',maxInstances:2,tracks:['web','mobile']});
  expect(changes.find(d=>d.role==='gm' && d.enabled)).toMatchObject({provider:'claude',model:'group/sck-opus'});
  expect(changes.find(d=>d.role==='product' && d.enabled)?.model).toBe('group/sck-sonnet');
  expect(changes.filter(d=>d.enabled).every(d=>!d.model.includes('fable'))).toBe(true);
});


test("merging a wildcard track definition never narrows the surviving Claude role",async()=>{
  const {planRoutingRoster}=await import('../src/model-routing/roster.ts');
  const changes=planRoutingRoster([{id:'engineering-claude',role:'engineering',provider:'claude',model:'old',enabled:true,tracks:[]},
    {id:'engineering-codex',role:'engineering',provider:'codex',model:'old',enabled:true,tracks:['web']}]);
  expect(changes.find(d=>d.enabled)?.tracks).toEqual([]);
});


test("story authors already using the old gateway keep their configured model",async()=>{
  let sent='';
  const g=await startModelGateway({lease:async()=>({employee:'author',task:'story',fence:1,role:'story-author',tier:'haiku',phase:'execute'}),record:async()=>{},complete:async()=>{},
    fetchImpl:(async(_url:any,init:any)=>{sent=JSON.parse(init.body).model;return new Response('{}')}) as typeof fetch},0);
  try {const r=await fetch(`http://127.0.0.1:${g.port}/a/author/v1/messages`,{method:'POST',body:JSON.stringify({model:'group/sck-writing-high'})});await r.text();expect(sent).toBe('group/sck-writing-high')}finally{await g.stop()}
});


test("Fable stays owner-only even when a legacy busy employee sends a Fable model name",async()=>{
  const sent:string[]=[];
  const g=await startModelGateway({lease:async()=>({employee:'legacy',task:'real-task',fence:4,role:'engineering',tier:'haiku',phase:'review'}),record:async()=>{},complete:async()=>{},
    fetchImpl:(async(_url:any,init:any)=>{sent.push(JSON.parse(init.body).model);return new Response('{}')}) as typeof fetch},0);
  try {
    for(const model of ['claude-fable-5-1','group/sck-fable']){const r=await fetch(`http://127.0.0.1:${g.port}/a/legacy/v1/messages`,{method:'POST',body:JSON.stringify({model})});await r.text();}
    expect(sent).toEqual(['group/sck-haiku','group/sck-haiku']);
  }finally{await g.stop()}
});
