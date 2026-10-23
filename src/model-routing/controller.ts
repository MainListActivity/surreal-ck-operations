import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { type Surreal } from "surrealdb";
import {
  classify,
  TIERS,
  selectedTier,
  canonicalModel,
  tierPool,
  digest,
  rank,
  type CatalogModel,
  type Domain,
  type Tier,
} from "./policy.ts";
import { setAgentModel } from "../dispatcher/agent-model.ts";
import { employeeTier } from "./policy.ts";
import { createPaseoCli } from "../dispatcher/paseo.ts";
import { saveMagpieGroups, magpieEnvironment } from "./magpie-admin.ts";
import { readModelResults } from "./store.ts";
import { loadAa, refreshAa } from "./aa.ts";
import { useBenchmarks } from "./policy.ts";
import { modelFacts, quotaAccounts, usageStats, type ModelFacts } from "./ranking.ts";
const exec = promisify(execFile);
/** Bump to re-run the one-time grouping (owner rule changes). Otherwise membership is the owner's. */
export const GROUPING_VERSION = "anchors-2026-10-23";
/** magpie keeps routing groups in providers.json; read-only here, writes go through its save API. */
export function readMagpieGroups(file = join(homedir(), ".config", "magpie", "providers.json")): Record<string, string[]> {
  try {
    const groups = (JSON.parse(readFileSync(file, "utf8")) as { groups?: Array<{ id: string; members?: string[] }> }).groups ?? [];
    return Object.fromEntries(groups.map((g) => [g.id, g.members ?? []]));
  } catch {
    return {};
  }
}
/** The retired in-gateway selector. magpie names a path plugin by its absolute path; removed on sync. */
const legacySelector = (home: string) =>
  join(home, "model-routing", "sck-performance.gateway.js");
export interface RoutingConfig {
  enabled?: boolean;
  disabledModels?: string[];
  tierOverrides?: Record<string, Tier>;
}
export class ModelRoutingController {
  enabled = false;
  /** Latest Jev order per group; members it has not seen yet follow in performance order. */
  private orders: Record<string, string[]> = {};
  private catalog: CatalogModel[] = [];
  private updated = 0;
  private sessionsChecked = 0;
  private pending?: Promise<void>;
  constructor(
    private readonly db: Surreal,
    private readonly home: string,
    private readonly cli = "/Applications/magpie.app/Contents/MacOS/magpie",
    private readonly io: {
      fetch?: typeof fetch;
      command?: (args: string[]) => Promise<void>;
      groups?: () => Record<string, string[]>;
    } = {},
  ) {
    try {
      this.enabled =
        JSON.parse(
          readFileSync(join(home, "model-routing", "activation.json"), "utf8"),
        ).enabled === true;
    } catch {}
  }
  private async command(args: string[]) {
    if (this.io.command) return this.io.command(args);
    try {
      await exec(this.cli, args, {
        timeout: 20000,
        maxBuffer: 1024 * 1024,
        env: magpieEnvironment(),
      });
    } catch (error) {
      const why = String((error as { stderr?: string }).stderr ?? "")
        .trim()
        .split("\n")
        .pop()
        ?.slice(0, 200);
      throw Error(
        `magpie management command failed: ${args.slice(0, 2).join(" ")}${why ? `: ${why}` : ""}`,
      );
    }
  }
  private async output(args: string[]): Promise<string> {
    const { stdout } = await exec(this.cli, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: magpieEnvironment() });
    return stdout;
  }
  /** Jev's input for one group: accounts and quota, AA rank and price, 7-day usage, task performance. */
  async rankingFacts(ids: string[]): Promise<ModelFacts[]> {
    const [quota, usage, results] = await Promise.all([
      this.output(["quota", "--json"]).then((t) => quotaAccounts(JSON.parse(t))).catch(() => new Map()),
      this.output(["usage", "--csv", "--days", "7"]).then(usageStats).catch(() => new Map()),
      readModelResults(this.db),
    ]);
    const known = new Map(classify(this.catalog).map((m) => [m.id, m]));
    const candidates = ids.map((id) => known.get(id) ?? { id, model: id.slice(id.lastIndexOf("/") + 1), tier: "sonnet" as Tier, prior: 2.5, estimated: true, context: 0 });
    const performance = new Map<string, {score:number;samples:number}>();
    for (const candidate of candidates) {
      const evidence = results.filter(r => canonicalModel(r.model) === canonicalModel(candidate.id));
      const samples = evidence.reduce((sum,r) => sum + r.weight, 0);
      if (samples > 0) performance.set(candidate.id,{score:Math.round(evidence.reduce((sum,r)=>sum+r.overall*r.weight,0)/samples*100)/100,samples});
    }
    return modelFacts(ids, { catalog: this.catalog as never, quota, usage, performance });
  }
  async applyOrders(orders: Record<string, string[]>): Promise<void> {
    // Serialize behind any periodic sync, then re-read the owner's current membership.
    if (this.pending) await this.pending;
    this.orders = { ...this.orders, ...orders };
    await this.refresh(true);
  }
  refresh(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.updated < 300000) return Promise.resolve();
    this.pending = this.sync().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  /** Existing busy sessions finish normally; only idle, unleased Claude sessions reopen on the gateway. */
  async activateIdle(): Promise<void> {
    if (!this.enabled || Date.now() - this.sessionsChecked < 30000) return;
    this.sessionsChecked = Date.now();
    const [rows] = await this.db.query<
      [Array<{ paseo_agent_id: string; workspace_cwd?: string; role:string }>]
    >(
      "SELECT paseo_agent_id,workspace_cwd,role FROM employee WHERE provider='claude' AND role!='story-author' AND retired!=true AND revoked!=true AND paseo_agent_id!=NONE AND active_task=NONE LIMIT 100;",
    );
    const paseo = createPaseoCli(undefined, { timeoutMs: 5000 });
    const pending = rows
      .filter(
        (row) =>
          row.workspace_cwd &&
          ( !existsSync(join(row.workspace_cwd, ".sck-model-router")) || readFileSync(join(row.workspace_cwd, ".sck-model-router"),"utf8") !== "v2" ),
      )
      .slice(0, 3);
    for (const row of pending) {
      const status = await paseo
        .status(row.paseo_agent_id)
        .catch(() => undefined);
      if (status?.status === "idle" && status.pendingPermissions === 0) {
        if (!await setAgentModel(row.paseo_agent_id,`group/sck-${employeeTier(row.role)}`)) continue;
        await paseo.reload(row.paseo_agent_id);
      }
    }
  }
  async prepare(): Promise<void> {
    await this.sync(true);
  }
  private async sync(preparing = false) {
    const [config] = await this.db.query<[RoutingConfig | undefined]>(
      "SELECT enabled,disabledModels,tierOverrides FROM ONLY company_meta:model_routing;",
    );
    this.enabled = preparing || config?.enabled === true;
    if (!this.enabled) {
      this.updated = Date.now();
      return;
    }
    const reply = await (this.io.fetch ?? fetch)(
      "http://127.0.0.1:3425/v1/models",
      { signal: AbortSignal.timeout(10000) },
    );
    if (!reply.ok) throw Error(`magpie catalog unavailable: ${reply.status}`);
    const catalog = (await reply.json()) as { data: CatalogModel[] };
    this.catalog = catalog.data;
    const dir0 = join(this.home, "model-routing");
    await mkdir(dir0, { recursive: true, mode: 0o700 });
    // Daily AA scores and prices, so new models are placed by today's leaderboard, not the bundled one.
    const aa = this.io.command ? loadAa(join(dir0, "aa.json")) : await refreshAa(join(dir0, "aa.json"));
    if (aa) useBenchmarks(aa.models);
    const [ranking] = await this.db.query<[{ orders?: Record<string, string[]> } | undefined]>("SELECT orders FROM ONLY company_meta:model_ranking;");
    this.orders = { ...ranking?.orders, ...this.orders };
    const models = classify(catalog.data).filter(
      (m) => !config?.disabledModels?.includes(m.id),
    );
    for (const m of models)
      if (config?.tierOverrides?.[m.id]) m.tier = selectedTier(config.tierOverrides[m.id]) ?? m.tier;
    if (!models.length) throw Error("no usable magpie models");
    const results = await readModelResults(this.db);
    const dir = join(this.home, "model-routing");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let previous: Record<string, string> = {};
    try {
      previous = JSON.parse(await readFile(join(dir, "groups.json"), "utf8"));
    } catch {}
    const groups: Record<string, string> = {};
    const routes: Record<string, Array<{ model: string; score: number; samples: number }>> = {};
    const groupsToSet: Array<{ id: string; models: string[]; signature: string }> = [];
    // Membership is the owner's. Automatic grouping runs once per GROUPING_VERSION and afterwards
    // only places models this controller has never seen; manual adds and removals in magpie stay.
    // The controller only reorders members by ranking.
    const live = this.io.groups?.() ?? (this.io.command ? {} : readMagpieGroups());
    let state: { version?: string; known?: string[] } = {};
    try {
      state = JSON.parse(await readFile(join(dir, "membership.json"), "utf8"));
    } catch {}
    const initializing = state.version !== GROUPING_VERSION;
    const known = new Set(initializing ? [] : state.known ?? []);
    const fresh = models.filter((m) => !known.has(m.id));
    const byId = new Map(models.map((m) => [m.id, m]));
    const tiers = TIERS;
    for (const [level, tier] of tiers.entries()) {
      // An empty staff tier borrows the next stronger one: an upgrade, never a silent downgrade.
      // Fable is owner-only and has nothing stronger; while its models are excluded it serves Opus.
      const pool = (t: Tier) => models.filter((m) => m.tier === tierPool(t));
      const bucket =
        [...tiers.slice(0, level + 1).reverse(), ...(tier === "fable" ? (["opus"] as Tier[]) : [])]
          .map(pool)
          .find((b) => b.length) ?? [];
      const current = live[`sck-${tier}`];
      const ids = initializing || !current
        ? bucket.map((m) => m.id)
        : [...current, ...fresh.filter((m) => tierPool(m.tier) === tierPool(tier) && !current.includes(m.id)).map((m) => m.id)];
      if (!ids.length) {
        if (initializing) throw Error(`magpie tier ${tier} has no models or stronger fallback`);
        continue; // emptied by hand: leave it as the owner set it
      }
      // A model added by hand may have no score: it keeps a neutral prior and is still ordered.
      const candidates = ids.map((id) => byId.get(id) ?? { id, model: id.slice(id.lastIndexOf("/") + 1), tier, prior: 2.5, estimated: true, context: 0 });
      const byRank = rank(candidates, results);
      const jev = tier === "fable" ? [] : this.orders[`sck-${tier}`] ?? [];
      const at = (id: string) => { const i = jev.indexOf(id); return i < 0 ? jev.length : i; };
      const baseOrder = tier === "fable" && !initializing ? candidates.map(m => byRank.find(r => r.id === m.id)!) : byRank;
      const ordered = baseOrder.map((m, i) => ({ m, i })).sort((a, b) => at(a.m.id) - at(b.m.id) || a.i - b.i).map((x) => x.m);
      const members = ordered.map((m) => m.id);
      const signature = digest(JSON.stringify(members));
      groups[`sck-${tier}`] = signature;
      if (JSON.stringify(current) !== JSON.stringify(members))
        groupsToSet.push({ id: `sck-${tier}`, models: members, signature });
      routes[`group/sck-${tier}`] = ordered.map((m) => ({ model: m.id, score: m.score, samples: m.samples }));
    }
    const nextKnown = [...new Set([...known, ...models.map((m) => m.id), ...(config?.disabledModels ?? [])])];
    // Only private sck-* groups are touched; existing user groups/providers/accounts are never rewritten.
    if (this.io.command) {
      for (const g of groupsToSet)
        await this.command([
          "group",
          "add",
          g.id,
          `models=${g.models.join(",")}`,
          "routing=order",
          "stays=session",
        ]);
    } else await saveMagpieGroups(this.cli, groupsToSet);

    // The old selector rewrote a tier to concrete-model route groups; once it is out, those groups go too.
    if (previous.__selector) {
      await this.command(["plugin", "rm", legacySelector(this.home)]).catch(() => {});
      await unlink(legacySelector(this.home)).catch(() => {});
    }
    const [storyModels] = await this.db.query<[string[]]>("SELECT VALUE model FROM employee_def WHERE role='story-author';");
    for (const id of Object.keys(previous)) {
      if (!id.startsWith('sck-') || id in groups || storyModels?.includes(`group/${id}`)) continue;
      if (preparing) groups[id] = previous[id]!; // the previous gateway still owns live leases until release switch
      // Already gone is done: a sync that died after removing groups but before writing groups.json
      // (or a concurrent one) must not fail every later sync.
      else await this.command(['group','rm',id]).catch((e: Error) => { if (!/no group/.test(e.message)) throw e; });
    }
    await writeFile(join(dir, "membership.json.tmp"), JSON.stringify({ version: GROUPING_VERSION, known: nextKnown }), { mode: 0o600 });
    await rename(join(dir, "membership.json.tmp"), join(dir, "membership.json"));
    await writeFile(join(dir, "groups.json.tmp"), JSON.stringify(groups), {
      mode: 0o600,
    });
    await rename(join(dir, "groups.json.tmp"), join(dir, "groups.json"));
    await this.db.query(
      "UPSERT company_meta:model_routing_status CONTENT {at:time::now(),catalog:$models,routes:$routes,groups:$groups,source:$source,enabled:$enabled};",
      {
        models,
        routes,
        groups: Object.keys(groups).filter((k) => !k.startsWith("__")),
        source: "https://artificialanalysis.ai/leaderboards/models",
        enabled: !preparing,
      },
    );
    if (!preparing) {
      await writeFile(
        join(dir, "activation.json.tmp"),
        JSON.stringify({ enabled: true }),
        { mode: 0o600 },
      );
      await rename(
        join(dir, "activation.json.tmp"),
        join(dir, "activation.json"),
      );
    }
    this.updated = Date.now();
  }
}
