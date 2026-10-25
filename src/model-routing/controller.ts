import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { type Surreal } from "surrealdb";
import {
  AA_FLOOR,
  benchmarkRows,
  classify,
  resolveBenchmark,
  routable,
  splitMember,
  tierOf,
  useAliases,
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
import { GROUP_STAYS, saveMagpieGroups, magpieEnvironment } from "./magpie-admin.ts";
import { readModelResults } from "./store.ts";
import { readModelHealth } from "./health.ts";
import { GaugeHistory, metricTrend, readUsageSamples, type ModelTrends, type Sample } from "./trends.ts";
import { loadAa, refreshAa } from "./aa.ts";
import { useBenchmarks } from "./policy.ts";
import { pinnedOrder, modelFacts, quotaAccounts, usageStats, type ModelFacts } from "./ranking.ts";
import { aliasMap, askAlias, loadAliases, saveAliases } from "./alias.ts";
import {loadInventory,saveInventory,inventoryAliases,recordDecision,reconcileInventory,inventoryView} from "./inventory.ts";
import type { JevClient } from "../dispatcher/jev.ts";
/** New vendor names Jev is asked about per sync; models are added rarely, so this only bounds a burst. */
const ALIAS_ASKS_PER_SYNC = 6;
const DAY = 86400000;
export interface MemberIssue { group: string; member: string; reason: string }
/** A member breaks the owner's rule when the level it is sent at has no AA score of 38+, or that
 * score belongs to another band. Members are the owner's: issues are reported, never removed. */
export function memberIssue(tier: Tier, member: string, levels: string[] | undefined): string | undefined {
  const r = resolveBenchmark(member, levels);
  if (!r) return splitMember(member).effort ? "AA 没有该思考等级的分数" : "AA 没有可用思考等级下的分数";
  if (r.row.score < AA_FLOOR) return `AA ${r.row.score.toFixed(1)} 低于 ${AA_FLOOR}`;
  const band = tierOf(r.row.score);
  if (tier === "fable" ? band === "sonnet" : band !== tierPool(tier))
    return `AA ${r.row.score.toFixed(1)} 属于 ${band} 档`;
  return;
}
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
/** Each group's stickiness as magpie stored it; the default (`auto`) is stored as no field. */
export function readMagpieAffinity(file = join(homedir(), ".config", "magpie", "providers.json")): Record<string, string> {
  try {
    const groups = (JSON.parse(readFileSync(file, "utf8")) as { groups?: Array<{ id: string; affinity?: string }> }).groups ?? [];
    return Object.fromEntries(groups.map((g) => [g.id, g.affinity ?? "auto"]));
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
  private readonly gaugeHistory: GaugeHistory;
  private pending?: Promise<void>;
  constructor(
    private readonly db: Surreal,
    private readonly home: string,
    private readonly cli = "/Applications/magpie.app/Contents/MacOS/magpie",
    private readonly io: {
      fetch?: typeof fetch;
      command?: (args: string[]) => Promise<void>;
      output?: (args: string[]) => Promise<string>;
      groups?: () => Record<string, string[]>;
      affinity?: () => Record<string, string>;
      jev?: JevClient;
      usageLog?: string;
      /** Magpie's per-try routing log; tests point it at a fixture. */
      routingLogDir?: string;
      now?: () => number;
    } = {},
  ) {
    this.gaugeHistory = new GaugeHistory(join(home,"model-routing","trend-gauges.json"));
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
    if (this.io.output) return this.io.output(args);
    const { stdout } = await exec(this.cli, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: magpieEnvironment() });
    return stdout;
  }
  /** magpie fetches a vendor's model list only when asked; a relay's new models stay invisible
   * until then. Once a day every remote-magpie provider is fetched again. */
  private async refreshRemoteCatalogs(now = Date.now()): Promise<void> {
    const stamp = join(this.home, "model-routing", "catalog-refresh.json");
    try {
      if (now - JSON.parse(await readFile(stamp, "utf8")).at < DAY) return;
    } catch {}
    let providers: Array<{ id: string; preset?: string }> = [];
    try {
      providers = JSON.parse(await readFile(join(homedir(), ".config", "magpie", "providers.json"), "utf8")).providers ?? [];
    } catch {}
    for (const p of providers.filter((p) => p.preset === "remote-magpie"))
      await this.output(["provider", "refresh", p.id]).catch((e) => console.warn(`magpie provider refresh ${p.id}: ${(e as Error).message.slice(0, 160)}`));
    await mkdir(join(this.home, "model-routing"), { recursive: true, mode: 0o700 });
    await writeFile(stamp, JSON.stringify({ at: now }), { mode: 0o600 });
  }
  /** For the owner's console: every vendor-name decision, and members breaking the band rule. */
  async identity(): Promise<{
    aliases: Array<{ model: string; slug: string | null; by: "jev" | "owner"; confidence?: number; suggested?: string; aa?: { name: string; score: number } }>;
    issues: MemberIssue[];
    inventory: ReturnType<typeof inventoryView>;
  }> {
    const inventory=await loadInventory(join(this.home,"model-routing","inventory.json"));
    const aliases = inventoryAliases(inventory,await loadAliases(join(this.home, "model-routing", "aliases.json")));
    const [status] = await this.db.query<[{ issues?: MemberIssue[] } | undefined]>("SELECT issues FROM ONLY company_meta:model_routing_status;");
    const row = (slug?: string | null) => (slug ? benchmarkRows().find((b) => b.slug === slug) : undefined);
    return {
      aliases: Object.entries(aliases)
        .map(([model, a]) => {
          const r = row(a.slug ?? a.suggested);
          return { model, slug: a.slug, by: a.by, confidence: a.confidence, suggested: a.suggested, aa: r ? { name: r.name ?? r.slug, score: Math.round(r.score * 10) / 10 } : undefined };
        })
        .sort((a, b) => Number(!a.slug) - Number(!b.slug) || Number(!a.suggested) - Number(!b.suggested) || a.model.localeCompare(b.model)),
      issues: status?.issues ?? [],
      inventory: inventoryView(inventory),
    };
  }
  /** Owner's decision on a vendor name; a model not yet in any group is placed by it on the next sync. */
  async setAlias(model: string, slug: string | null): Promise<{synchronized:boolean}> {
    while(this.pending) await this.pending.catch(()=>undefined);
    let synchronized=true;
    const operation=async()=>{
      const dir = join(this.home, "model-routing");
      if (slug !== null && !benchmarkRows().some((b) => b.slug === slug)) throw Error(`AA 榜单上没有 ${slug}`);
      const inventory=await loadInventory(join(dir,"inventory.json"));
      const aliases = inventoryAliases(inventory,await loadAliases(join(dir, "aliases.json")));
      aliases[model] = { slug, by: "owner", at: new Date().toISOString() };
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await saveAliases(join(dir, "aliases.json"), aliases);
      recordDecision(inventory,model,aliases[model]!);
      await saveInventory(join(dir,"inventory.json"),inventory);
      const groups = this.io.groups?.() ?? readMagpieGroups();
      if (!Object.entries(groups).some(([id, m]) => id.startsWith("sck-") && m.some((x) => splitMember(x).id === model))) {
        try {
          const file = join(dir, "membership.json");
          const state = JSON.parse(await readFile(file, "utf8"));
          state.known = (state.known ?? []).filter((id: string) => id !== model);
          await writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
          await rename(`${file}.tmp`, file);
        } catch {}
      }
      try{await this.sync();}catch{ synchronized=false;console.warn("Model decision saved; group synchronization will retry"); }
    };
    this.pending=operation().finally(()=>{this.pending=undefined;});
    await this.pending;
    return {synchronized};
  }

  /** Jev's input for one group: accounts and quota, AA rank and price, 7-day usage, task performance. */
  async rankingFacts(ids: string[]): Promise<ModelFacts[]> {
    const now = this.io.now?.() ?? Date.now();
    const [quota, usage, results, observations, health] = await Promise.all([
      this.output(["quota", "--json"]).then((t) => quotaAccounts(JSON.parse(t))).catch(() => new Map()),
      (async () => {
        const response = await (this.io.fetch ?? fetch)("http://127.0.0.1:3425/v1/magpie/usage?period=7d", {
          cache: "no-store", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error(`Magpie usage API failed (${response.status})`);
        return usageStats(await response.json());
      })(),
      readModelResults(this.db),
      readUsageSamples(now, this.io.usageLog).catch(() => undefined),
      readModelHealth(now, this.io.routingLogDir).catch(() => new Map()),
    ]);
    const known = new Map(classify(this.catalog).map((m) => [m.id, m]));
    const candidates = ids.map((id) => known.get(id) ?? { id, model: id.slice(id.lastIndexOf("/") + 1), tier: "sonnet" as Tier, prior: 2.5, estimated: true, context: 0 });
    const performance = new Map<string, {score:number;samples:number}>();
    for (const candidate of candidates) {
      const evidence = results.filter(r => canonicalModel(r.model) === canonicalModel(candidate.id));
      const samples = evidence.reduce((sum,r) => sum + r.weight, 0);
      if (samples > 0) performance.set(candidate.id,{score:Math.round(evidence.reduce((sum,r)=>sum+r.overall*r.weight,0)/samples*100)/100,samples});
    }
    const facts = modelFacts(ids, { catalog: this.catalog as never, quota, usage, performance });
    const gauges = await this.gaugeHistory.update(Object.fromEntries(facts.map(f => [f.id, {
      aaScore:f.aa?.score, aaRank:f.aa?.rank,
      remainingPct:f.accounts.some(a=>a.remainingPct!==undefined)?Math.min(...f.accounts.flatMap(a=>a.remainingPct===undefined?[]:[a.remainingPct])):undefined,
      inputPrice:f.price.input??undefined, outputPrice:f.price.output??undefined, cacheHitPrice:f.price.cacheHit??undefined,
    }])),now);
    for (const f of facts) {
      const trends: ModelTrends = {};
      const raw=observations?.rows.get(splitMember(f.id).id)??{};
      for(const [name,unit] of Object.entries({ttftMs:"ms",tokensPerSecond:"tokens/s",errorRate:"ratio",cacheHitRate:"ratio",ttftOver10sRate:"ratio"}))
        trends[name]=metricTrend(raw[name]??[],now,unit,"request");
      // One task is one independent quality observation, even if several employees used this model.
      const tasks = new Map<string,{at:number;sum:number;weight:number}>();
      for(const r of results.filter(r=>canonicalModel(r.model)===canonicalModel(f.id))) {
        if(!r.task)continue;
        const row=tasks.get(r.task)??{at:Date.parse(r.at),sum:0,weight:0};
        row.sum+=r.overall*r.weight;row.weight+=r.weight;row.at=Math.max(row.at,Date.parse(r.at));tasks.set(r.task,row);
      }
      const scores:Sample[]=[...tasks.values()].filter(r=>r.weight>0).map(r=>({at:r.at,value:r.sum/r.weight}));
      trends.performanceScore=metricTrend(scores,now,"score","task");
      for(const [name,unit] of Object.entries({aaScore:"score",aaRank:"rank",remainingPct:"percent",inputPrice:"USD/1M",outputPrice:"USD/1M",cacheHitPrice:"USD/1M"}))
        trends[name]=metricTrend(gauges[f.id]?.[name]??[],now,unit,"snapshot");
      f.trends=trends;
      const h=health.get(splitMember(f.id).id);
      if(h)f.health=h;
      f.trendSource={source:"magpie-usage.jsonl",available:!!observations,invalidLines:observations?.invalid??0,collectedAt:new Date(now).toISOString()};
    }
    return facts;
  }
  async applyOrders(orders: Record<string, string[]>, isCurrent: () => boolean = () => true): Promise<void> {
    // Serialize behind any periodic sync, then re-read the owner's current membership.
    while (this.pending) await this.pending;
    if (!isCurrent()) return;
    this.orders = { ...this.orders, ...orders };
    this.pending = this.sync(false,isCurrent).finally(() => {this.pending=undefined;});
    await this.pending;
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
  private async sync(preparing = false, isCurrent: () => boolean = () => true) {
    const [config] = await this.db.query<[RoutingConfig | undefined]>(
      "SELECT enabled,disabledModels,tierOverrides FROM ONLY company_meta:model_routing;",
    );
    this.enabled = preparing || config?.enabled === true;
    if (!this.enabled) {
      this.updated = Date.now();
      return;
    }
    if (!this.io.command) await this.refreshRemoteCatalogs();
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
    let state: { version?: string; known?: string[] } = {};
    try {
      state = JSON.parse(await readFile(join(dir0, "membership.json"), "utf8"));
    } catch {}
    const initializing = state.version !== GROUPING_VERSION;
    const known = new Set(initializing ? [] : state.known ?? []);
    const live = this.io.groups?.() ?? (this.io.command ? {} : readMagpieGroups());
    const stays = this.io.affinity?.() ?? (this.io.groups || this.io.command ? {} : readMagpieAffinity());
    const inventoryFile=join(dir0,"inventory.json");
    const inventory=await loadInventory(inventoryFile);
    const aliasFile = join(dir0, "aliases.json");
    const aliases = inventoryAliases(inventory,await loadAliases(aliasFile));
    useAliases(aliasMap(aliases));
    reconcileInventory(inventory,catalog.data,live,aliases,config?.disabledModels);
    await saveInventory(inventoryFile,inventory);
    if (this.io.jev) {
      const unnamed = catalog.data.filter(m=>routable(m)&&!inventory.decisions[m.id]&&!inventory.grouped[m.id]).slice(0,ALIAS_ASKS_PER_SYNC);
      for (const m of unnamed) {
        if(inventory.decisions[m.id])continue;
        const entry=await askAlias(this.io.jev,m as {id:string});
        aliases[m.id]=entry;recordDecision(inventory,m.id,entry);
        // Checkpoint each answer before any following call/group mutation can fail.
        await saveInventory(inventoryFile,inventory);
        await saveAliases(aliasFile,aliases);
      }
      useAliases(aliasMap(aliases));
    }
    const [ranking] = await this.db.query<[{ orders?: Record<string, string[]>; pins?: Record<string, string[]> } | undefined]>("SELECT orders,pins FROM ONLY company_meta:model_ranking;");
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
    const fresh = models.filter((m) => !known.has(m.id));
    const byId = new Map(models.map((m) => [m.id, m]));
    const levelsOf = (member: string) => catalog.data.find((m) => m.id === splitMember(member).id)?.reasoning_levels;
    const holds = (list: string[], id: string) => list.some((x) => splitMember(x).id === id);
    // The owner's rule ties a band to an AA score, and AA scores per reasoning level: a member
    // listed bare is pinned to the level it qualified at. A level the owner set stays.
    const pinned = (member: string) => {
      const { effort, fast } = splitMember(member);
      return effort || fast ? member : byId.get(member)?.member ?? member;
    };
    const issues: MemberIssue[] = [];
    const tiers = TIERS;
    for (const [level, tier] of tiers.entries()) {
      // Opus belongs to the owner in Magpie: no creation, membership/effort normalization,
      // new-model placement, persisted pins, ranking or routing/stickiness writes.
      if (tier === "opus") continue;
      // An empty staff tier borrows the next stronger one: an upgrade, never a silent downgrade.
      // Fable is owner-only and has nothing stronger; while its models are excluded it serves Opus.
      const pool = (t: Tier) => models.filter((m) => m.tier === tierPool(t));
      const bucket =
        [...tiers.slice(0, level + 1).reverse(), ...(tier === "fable" ? (["opus"] as Tier[]) : [])]
          .map(pool)
          .find((b) => b.length) ?? [];
      const current = live[`sck-${tier}`];
      const ids = initializing || !current
        ? bucket.map((m) => m.member ?? m.id)
        : [...current.map(pinned), ...fresh.filter((m) => tierPool(m.tier) === tierPool(tier) && !holds(current, m.id)).map((m) => m.member ?? m.id)];
      if (!ids.length) {
        groups[`sck-${tier}`] = digest("[]");
        routes[`group/sck-${tier}`] = [];
        if (initializing) throw Error(`magpie tier ${tier} has no models or stronger fallback`);
        continue; // emptied by hand: leave it as the owner set it
      }
      // A model added by hand may have no score: it keeps a neutral prior and is still ordered.
      const candidates = ids.map((member) => {
        const base = splitMember(member).id, known = byId.get(base);
        const score = resolveBenchmark(member, levelsOf(member))?.row.score;
        const prior = score === undefined ? 2.5 : Math.max(1, Math.min(5, 1 + score / 15));
        return { ...(known ?? { model: base.slice(base.lastIndexOf("/") + 1), tier, estimated: true, context: 0 }), id: member, prior };
      });
      const byRank = rank(candidates, results);
      const jev = tier === "fable" ? [] : this.orders[`sck-${tier}`] ?? [];
      // A member pinned since Jev last ranked keeps its place under its bare id.
      const at = (id: string) => {
        const i = jev.indexOf(id) >= 0 ? jev.indexOf(id) : jev.findIndex((x) => splitMember(x).id === splitMember(id).id);
        return i < 0 ? jev.length : i;
      };
      const baseOrder = tier === "fable" && !initializing ? candidates.map(m => byRank.find(r => r.id === m.id)!) : byRank;
      const ordered = baseOrder.map((m, i) => ({ m, i })).sort((a, b) => at(a.m.id) - at(b.m.id) || a.i - b.i).map((x) => x.m);
      const members = tier === "fable" ? ordered.map(m => m.id) : pinnedOrder(ordered.map(m => m.id), ranking?.pins?.[`sck-${tier}`]);
      const positions = new Map(members.map((id, i) => [id, i]));
      ordered.sort((a,b) => positions.get(a.id)! - positions.get(b.id)!);
      for (const member of members) {
        const reason = memberIssue(tier, member, levelsOf(member));
        if (reason) issues.push({ group: `sck-${tier}`, member, reason });
      }
      const signature = digest(JSON.stringify(members));
      groups[`sck-${tier}`] = signature;
      // A group whose stickiness differs is rewritten too: membership alone would leave it as it was.
      if (JSON.stringify(current) !== JSON.stringify(members) || (stays[`sck-${tier}`] ?? GROUP_STAYS) !== GROUP_STAYS)
        groupsToSet.push({ id: `sck-${tier}`, models: members, signature });
      routes[`group/sck-${tier}`] = ordered.map((m) => ({ model: m.id, score: m.score, samples: m.samples }));
    }
    const nextKnown = [...new Set([...known, ...models.map((m) => m.id), ...(config?.disabledModels ?? [])])];
    // Only private sck-* groups are touched; existing user groups/providers/accounts are never rewritten.
    if (!isCurrent()) return;
    if (this.io.command) {
      for (const g of groupsToSet) {
        if (!isCurrent()) return;
        await this.command([
          "group",
          "add",
          g.id,
          `models=${g.models.join(",")}`,
          "routing=order",
          `stays=${GROUP_STAYS}`,
        ]);
      }
    } else await saveMagpieGroups(this.cli, groupsToSet, isCurrent);
    if (!isCurrent()) return;

    // The old selector rewrote a tier to concrete-model route groups; once it is out, those groups go too.
    if (previous.__selector) {
      await this.command(["plugin", "rm", legacySelector(this.home)]).catch(() => {});
      await unlink(legacySelector(this.home)).catch(() => {});
    }
    const finalGroups={...live,...Object.fromEntries(groupsToSet.map(g=>[g.id,g.models]))};
    reconcileInventory(inventory,catalog.data,finalGroups,aliases,config?.disabledModels);
    await saveInventory(inventoryFile,inventory);
    const [storyModels] = await this.db.query<[string[]]>("SELECT VALUE model FROM employee_def WHERE role='story-author';");
    for (const id of Object.keys(previous)) {
      if (id === 'sck-opus' || !id.startsWith('sck-') || id in groups || storyModels?.includes(`group/${id}`)) continue;
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
      "UPSERT company_meta:model_routing_status CONTENT {at:time::now(),catalog:$models,routes:$routes,groups:$groups,issues:$issues,source:$source,enabled:$enabled};",
      {
        models,
        issues,
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
