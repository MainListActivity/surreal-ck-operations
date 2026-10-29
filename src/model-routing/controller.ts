import {UrgencyTracker} from './urgency.ts';
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { type Surreal } from "surrealdb";
import {
  admissionAnchor,
  benchmarkRows,
  classify,
  resolveBenchmark,
  routable,
  generatedModel,
  splitMember,
  tierOf,
  useAliases,
  TIERS,
  selectedTier,
  performanceModel,
  digest,
  rank,
  type CatalogModel,
  type Domain,
  type Tier,
} from "./policy.ts";
import { ROUTING_SETTINGS_VERSION } from "./gateway.ts";
import { setAgentModel } from "../dispatcher/agent-model.ts";
import { employeeTier, employeeClientModel } from "./policy.ts";
import { createPaseoCli } from "../dispatcher/paseo.ts";
import { GROUP_STAYS, GROUP_LEVELS, saveMagpieGroups, magpieEnvironment, type ManagedGroup } from "./magpie-admin.ts";
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
const REMOTE_DISCOVERY_MS = 60_000;
export interface MemberIssue { group: string; member: string; reason: string }
/** Report a member below the dynamic Luna Max floor or outside its AA input-price band; never remove owner members. */
export function memberIssue(tier: Tier, member: string, levels: string[] | undefined): string | undefined {
  const r = resolveBenchmark(member, levels);
  if (!r) return splitMember(member).effort ? "AA 没有该思考等级的分数" : "AA 没有可用思考等级下的分数";
  const floor=admissionAnchor();
  if (r.row.score < floor.score) return `AA ${r.row.score.toFixed(1)} 低于 ${floor.name} (${floor.score.toFixed(2)})`;
  const band = tierOf(r.row.priceInput);
  if(band==='opus')return "AA 输入价格未知或超过 $2/M，不自动入组";
  if (band !== tier)
    return `AA ${r.row.score.toFixed(1)} 属于 ${band} 档`;
  return;
}
const exec = promisify(execFile);
/** Bump to re-run the one-time grouping (owner rule changes). Otherwise membership is the owner's. */
export const GROUPING_VERSION = "anchors-2026-10-23";
/** magpie keeps routing groups in providers.json; read-only here, writes go through its save API. */
/** Group members the catalog no longer lists: the state a closed-then-reopened vendor window leaves.
 * Only sck-* groups count — other groups belong to the owner and are never sync-owned. */
export function missingCatalogMembers(
  models: Array<{ id: string }>,
  groups: Record<string, string[]>,
): boolean {
  const listed = new Set(models.map((m) => m.id));
  return Object.entries(groups).some(
    ([id, members]) =>
      id.startsWith("sck-") && (members ?? []).some((member) => !listed.has(splitMember(member).id)),
  );
}
export function readMagpieGroups(file = join(homedir(), ".config", "magpie", "providers.json")): Record<string, string[]> {
  try {
    const groups = (JSON.parse(readFileSync(file, "utf8")) as { groups?: Array<{ id: string; members?: string[] }> }).groups ?? [];
    return Object.fromEntries(groups.map((g) => [g.id, g.members ?? []]));
  } catch {
    return {};
  }
}
export function readMagpieLevels(file = join(homedir(), ".config/magpie/providers.json")): Record<string, string[]> {
  const groups = JSON.parse(readFileSync(file, "utf8"))?.groups ?? [];
  return Object.fromEntries(groups.map((g: {id:string; levels?:string[]}) => [g.id, g.levels ?? []]));
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
export function readMagpieProviderRouting(file=join(homedir(),'.config/magpie/providers.json')):Record<string,string>{
 try{const data=JSON.parse(readFileSync(file,'utf8'));return Object.fromEntries((data.providers??[]).map((p:{id:string;routing?:string})=>[p.id,p.routing??'smart']));}catch{return {};}
}
const nativeClientSignature = (role: string) => JSON.stringify({model:employeeClientModel(role),thinking:employeeTier(role)==='haiku'?'max':null});
/** Installing transport settings is not proof that the native client model/effort was migrated. */
export function needsEmployeeActivation(comm: string, role: string): boolean {
  try {
    return readFileSync(join(comm,".sck-model-router"),"utf8") !== ROUTING_SETTINGS_VERSION ||
      readFileSync(join(comm,".sck-native-client"),"utf8") !== nativeClientSignature(role);
  } catch {return true;}
}
export class ModelRoutingController {
  enabled = false;
  /** Latest rule order per group; members it has not seen yet follow in performance order. */
  private orders: Record<string, string[]> = {};
  private readonly ruleOrders=new Set<string>();
  private catalog: CatalogModel[] = [];
  private updated = 0;
  private sessionsChecked = 0;
  private readonly urgencyTracker: UrgencyTracker;
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
      groupSettings?: () => Record<string, {id:string;[key:string]:unknown}>;
      saveGroups?: (groups: ManagedGroup[]) => Promise<void>;
      affinity?: () => Record<string, string>;
      levels?: () => Record<string, string[]>;
      providerRouting?: () => Record<string,string>;
      jev?: JevClient;
      usageLog?: string;
      /** Magpie's per-try routing log; tests point it at a fixture. */
      routingLogDir?: string;
      now?: () => number;
    } = {},
  ) {
    this.urgencyTracker=new UrgencyTracker(join(home,"model-routing","urgency.json"));
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
   * until then. Once a minute every remote-magpie provider is fetched again. A forced run (group members
   * missing from the catalog) keeps its own shorter stamp so a permanently removed model is checked
   * every few minutes rather than repeatedly within one sync. */
  private async refreshRemoteCatalogs(now = Date.now(), force = false): Promise<boolean> {
    const stamp = join(this.home, "model-routing", force ? "catalog-refresh-missing.json" : "catalog-refresh.json");
    try {
      if (now - JSON.parse(await readFile(stamp, "utf8")).at < (force ? 5 * 60_000 : REMOTE_DISCOVERY_MS)) return false;
    } catch {}
    let providers: Array<{ id: string; preset?: string }> = [];
    try {
      providers = JSON.parse(await readFile(join(homedir(), ".config", "magpie", "providers.json"), "utf8")).providers ?? [];
    } catch {}
    for (const p of providers.filter((p) => p.preset === "remote-magpie"))
      // `provider models <id>` is the CLI's fetch-and-list verb; `provider refresh` is not a
      // subcommand and failed silently inside the catch, leaving catalog discovery a no-op.
      await this.output(["provider", "models", p.id]).catch((e) => console.warn(`magpie provider models ${p.id}: ${(e as Error).message.slice(0, 160)}`));
    await mkdir(join(this.home, "model-routing"), { recursive: true, mode: 0o700 });
    await writeFile(stamp, JSON.stringify({ at: now }), { mode: 0o600 });
    // A forced fetch refreshed every relay provider, so the normal discovery stamp is current too.
    if (force) await writeFile(join(this.home, "model-routing", "catalog-refresh.json"), JSON.stringify({ at: now }), { mode: 0o600 });
    return true;
  }
  private async fetchCatalog(): Promise<{ data: CatalogModel[] }> {
    const reply = await (this.io.fetch ?? fetch)(
      "http://127.0.0.1:3425/v1/models",
      { signal: AbortSignal.timeout(10000) },
    );
    if (!reply.ok) throw Error(`magpie catalog unavailable: ${reply.status}`);
    return (await reply.json()) as { data: CatalogModel[] };
  }
  /** True when an sck-* group still routes to a member the catalog no longer lists (or never listed):
   * that is exactly the state a closed-then-reopened vendor window leaves behind. */
  private async catalogMissesMembers(models: CatalogModel[]): Promise<boolean> {
    return missingCatalogMembers(models, this.io.groups?.() ?? readMagpieGroups());
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
  /** Paginated live catalog for both owner surfaces. Never calls Jev. */
  async catalogPage(query='',offset=0,limit=40) {
    if (!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100||query.length>200) throw Error('模型查询参数无效');
    const catalog=(await this.fetchCatalog()).data.filter(m=>!generatedModel(m.id));
    const groups=this.io.groups?.()??readMagpieGroups();
    const inventory=await loadInventory(join(this.home,'model-routing','inventory.json'));
    const aliases=inventoryAliases(inventory,await loadAliases(join(this.home,'model-routing','aliases.json')));
    const matches=catalog.filter(m=>(m.id+' '+(m.display_name??'')).toLowerCase().includes(query.trim().toLowerCase()));
    const models=matches.slice(offset,offset+limit).map(m=>{
      const resolved=resolveBenchmark(m.id,m.reasoning_levels),alias=aliases[m.id];
      return {id:m.id,name:m.display_name??m.id,levels:m.reasoning_levels??[],
        groups:Object.entries(groups).filter(([,members])=>members.some(member=>splitMember(member).id===m.id)).map(([group])=>group),
        members:Object.fromEntries(Object.entries(groups).filter(([group])=>group.startsWith('sck-')).map(([group,members])=>[group,members.filter(member=>splitMember(member).id===m.id)])),
        slug:alias?.slug===null?null:alias?.slug??resolved?.row.slug??null,
        aa:resolved?{score:resolved.row.score,name:resolved.row.name??resolved.row.slug}:undefined,
        status:inventory.grouped[m.id]?'grouped':inventory.decisions[m.id]?'decided':'pending'};
    });
    return {models,total:matches.length,offset,nextOffset:offset+limit<matches.length?offset+limit:null,
      benchmarks:[...benchmarkRows()].filter(b=>Number.isFinite(b.score)).map(b=>({slug:b.slug,name:b.name??b.slug,score:b.score})),
      groups:Object.keys(groups).filter(group=>['sck-haiku','sck-sonnet','sck-opus','sck-fable'].includes(group))};
  }

  /** Change only membership, serialized with sync/ranking; preserve all owner group settings. */
  async setMembership(input:{group:string;model:string;present:boolean;expectedMembers:string[]}) {
    if(!['sck-haiku','sck-sonnet','sck-opus','sck-fable'].includes(input.group)||generatedModel(input.model)||typeof input.present!=='boolean')throw Error('分组参数无效');
    while(this.pending)await this.pending.catch(()=>undefined);
    const operation=async()=>{
      const catalog=(await this.fetchCatalog()).data,base=splitMember(input.model),entry=catalog.find(m=>m.id===base.id);
      if(input.present&&(!entry||base.effort&&!(entry.reasoning_levels??[]).includes(base.effort)))throw Error('模型或思考等级不在当前 Magpie 目录中');
      const live=this.io.groups?.()??readMagpieGroups(),current=live[input.group]??[];
      const currentMembers=current.filter(member=>splitMember(member).id===base.id);
      if(JSON.stringify(currentMembers)!==JSON.stringify(input.expectedMembers))throw Error('分组成员已变化，请刷新后重试');
      const members=input.present?(current.includes(input.model)?current:[...current,input.model]):current.filter(member=>member!==input.model);
      const settings=this.io.groupSettings?.()??Object.fromEntries((JSON.parse(await readFile(join(homedir(),'.config/magpie/providers.json'),'utf8')).groups??[]).map((g:{id:string})=>[g.id,g]));
      const existing=settings[input.group];
      if(live[input.group]&&!existing)throw Error('当前分组配置不可读，未覆盖设置');
      const changes=[{id:input.group,models:members,existing:existing??{id:input.group,name:input.group,routing:'order',affinity:GROUP_STAYS,levels:GROUP_LEVELS}}];
      const dir=join(this.home,'model-routing');await mkdir(dir,{recursive:true,mode:0o700});
      const file=join(dir,'membership.json');let state:{version?:string;known?:string[];manualRemovals?:Record<string,string[]>}={};
      try{state=JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}

      if(!state||typeof state!=='object'||Array.isArray(state)||state.known!==undefined&&(!Array.isArray(state.known)||state.known.some(id=>typeof id!=='string'))||state.version!==undefined&&typeof state.version!=='string')throw Error('已知模型清单不可读，未修改分组');
      if(state.manualRemovals!==undefined&&(!state.manualRemovals||typeof state.manualRemovals!=='object'||Array.isArray(state.manualRemovals)||Object.values(state.manualRemovals).some(v=>!Array.isArray(v)||v.some(g=>typeof g!=='string'))))throw Error('人工移除清单不可读，未修改分组');
      const manualRemovals={...state.manualRemovals};
      if(input.present){manualRemovals[base.id]=(manualRemovals[base.id]??[]).filter(g=>g!==input.group);if(!manualRemovals[base.id]!.length)delete manualRemovals[base.id];}
      else if(!members.some(member=>splitMember(member).id===base.id))manualRemovals[base.id]=[...new Set([...(manualRemovals[base.id]??[]),input.group])];
      const inventory=await loadInventory(join(dir,'inventory.json'));
      const aliases=inventoryAliases(inventory,await loadAliases(join(dir,'aliases.json')));
      await (this.io.saveGroups??((groups:ManagedGroup[])=>saveMagpieGroups(this.cli,groups)))(changes);
      await writeFile(file+'.tmp',JSON.stringify({...state,manualRemovals,version:state.version??GROUPING_VERSION,known:[...new Set([...(state.known??[]),base.id])]}),{mode:0o600});await rename(file+'.tmp',file);
      const finalGroups={...live,[input.group]:members};
      reconcileInventory(inventory,catalog,finalGroups,aliases);
      await saveInventory(join(dir,'inventory.json'),inventory);
    };
    this.pending=operation().finally(()=>{this.pending=undefined;});await this.pending;
  }

  /** Owner's decision on a vendor name; a model not yet in any group is placed by it on the next sync. */
  async setAlias(model: string, slug: string | null): Promise<{synchronized:boolean}> {
    if(generatedModel(model))throw Error('生成分组不能关联 AA');
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
          if (!state.manualRemovals?.[model]?.length) state.known = (state.known ?? []).filter((id: string) => id !== model);
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

  /** Discover new grants as well as old ones; a cached card cannot announce a new activity. */
  private async rankingQuota(now:number,ids:string[]){
    const rows=JSON.parse(await this.output(["quota","--json"])) as Parameters<typeof quotaAccounts>[0];
    const providersInUse=new Set(ids.map(id=>{const base=splitMember(id).id;return base.slice(0,base.lastIndexOf('/'));}));
    const near=(at?:string)=>!!at&&Date.parse(at)>now&&Date.parse(at)<=now+24*3600_000;
    const providers=[...new Set(rows.filter(q=>{
      if(!q.provider.startsWith('remote-magpie/')||!providersInUse.has(q.provider))return false;
      const pending=q.renew==='off'&&near(q.until)||(q.windows??[]).some(w=>near(w.runsOutAt)||near(w.resetsAt));
      return !q.readAt||Date.parse(q.readAt)<now-(pending?30_000:REMOTE_DISCOVERY_MS);
    }).map(q=>q.provider))];
    for(let i=0;i<providers.length;i+=3)await Promise.all(providers.slice(i,i+3).map(async provider=>{
      try{
        const fresh=JSON.parse(await this.output(['quota','refresh',provider,'--json'])) as typeof rows;
        if(!Array.isArray(fresh))return;
        const own=fresh.filter(q=>q.provider===provider);if(!own.length)return;
        for(let n=rows.length-1;n>=0;n--)if(rows[n]!.provider===provider)rows.splice(n,1);
        rows.push(...own);
      }catch{/* Old readings retain their timestamp; stale cards never qualify for urgency. */}
    }));
    return quotaAccounts(rows,now);
  }
  /** Jev's input for one group: accounts and quota, AA rank and price, 7-day usage, task performance. */
  async rankingFacts(ids: string[]): Promise<ModelFacts[]> {
    ids = ids.filter(id=>!generatedModel(id));
    const now = this.io.now?.() ?? Date.now();
    const [quota, usage, results, observations, health] = await Promise.all([
      this.rankingQuota(now,ids).catch(() => new Map()),
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
      const evidence = results.filter(r => performanceModel(r.model) === performanceModel(candidate.id));
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
      for(const [name,unit] of Object.entries({ttftMs:"ms",tokensPerSecond:"tokens/s",errorRate:"ratio",cacheHitRate:"ratio",ttftOver10sRate:"ratio",ttftOver20sRate:"ratio"}))
        trends[name]=metricTrend(raw[name]??[],now,unit,"request");
      // One task is one independent quality observation, even if several employees used this model.
      const tasks = new Map<string,{at:number;sum:number;weight:number}>();
      for(const r of results.filter(r=>performanceModel(r.model)===performanceModel(f.id))) {
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
    if(!observations)return facts; // No usage evidence: never start an unbounded urgent experiment.
    return this.urgencyTracker.update(facts,observations.largeRequests??[],this.io.now?.()??Date.now()).catch(()=>{
      console.warn('临期额度观测不可读，保留普通排序');return facts;
    });
  }
  async applyOrders(orders: Record<string, string[]>, isCurrent: () => boolean = () => true): Promise<void> {
    // Serialize behind any periodic sync, then re-read the owner's current membership.
    while (this.pending) await this.pending;
    if (!isCurrent()) return;
    // Provider account selection is native PACE; model order remains group-local.
    // A remote Magpie's inner providers remain owned by that remote instance.
    const operation=async()=>{
      const providers=this.io.providerRouting?.()??readMagpieProviderRouting();
      const used=new Set(Object.keys(orders).filter(g=>g==='sck-haiku'||g==='sck-sonnet').flatMap(g=>(this.io.groups?.()??readMagpieGroups())[g]??[]).map(id=>id.split('/')[0]!));
      for(const id of used){
        if(!isCurrent())return;
        if(providers[id]===undefined||providers[id]==='pace')continue;
        const dir=join(this.home,'model-routing'),file=join(dir,'account-routing.json');
        let original:Record<string,string>={};
        try{
          const saved=JSON.parse(await readFile(file,'utf8'));
          if(!saved?.original||typeof saved.original!=='object'||Array.isArray(saved.original)||Object.values(saved.original).some(v=>typeof v!=='string'))throw Error('invalid backup');
          original=saved.original;
        }catch(error){
          if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('账号路由恢复记录不可读，未修改供应商策略');
        }
        if(original[id]===undefined)original[id]=providers[id]!;
        await mkdir(dir,{recursive:true,mode:0o700});
        await writeFile(file+'.tmp',JSON.stringify({original}),{mode:0o600});
        await rename(file+'.tmp',file);
        if(!isCurrent())return;
        await this.command(['provider','set',id,'routing=pace']);
      }
      if(!isCurrent())return;
      const previousOrders=this.orders,previousRules=new Set(this.ruleOrders);
      this.orders = { ...this.orders, ...orders };
      for(const group of Object.keys(orders))if(group==='sck-haiku'||group==='sck-sonnet')this.ruleOrders.add(group);
      let completed=false;
      try{await this.sync(false,isCurrent);completed=isCurrent();}
      finally{
        if(!completed){
          this.orders=previousOrders;
          this.ruleOrders.clear();for(const group of previousRules)this.ruleOrders.add(group);
        }
      }
    };
    this.pending = operation().finally(() => {this.pending=undefined;});
    await this.pending;
  }
  refresh(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.updated < REMOTE_DISCOVERY_MS) return Promise.resolve();
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
      [Array<{ id: {id:unknown}; paseo_agent_id: string; workspace_cwd?: string; role:string }>]
    >(
      "SELECT id,paseo_agent_id,workspace_cwd,role FROM employee WHERE provider='claude' AND role!='story-author' AND retired!=true AND revoked!=true AND paseo_agent_id!=NONE AND active_task=NONE LIMIT 100;",
    );
    const paseo = createPaseoCli(undefined, { timeoutMs: 5000 });
    const pending = rows
      .filter(
        (row) =>
          row.workspace_cwd &&
          needsEmployeeActivation(join(this.home,"comm",String(row.id.id)),row.role),
      )
      .slice(0, 3);
    for (const row of pending) {
      const status = await paseo
        .status(row.paseo_agent_id)
        .catch(() => undefined);
      if (status?.status === "idle" && status.pendingPermissions === 0) {
        if (!await setAgentModel(row.paseo_agent_id,employeeClientModel(row.role), {thinkingOptionId:employeeTier(row.role)==='haiku'?'max':undefined})) continue;
        await paseo.reload(row.paseo_agent_id);
        await writeFile(join(this.home,"comm",String(row.id.id),".sck-native-client"),nativeClientSignature(row.role),{mode:0o600});
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
    let catalog = await this.fetchCatalog();
    // A relay can drop a vendor's models when a trial window closes and bring them back when a new
    // window opens. A cached remote list could leave the group routing to members the
    // catalog cannot see, so any group member missing from the catalog forces a refresh of the relay
    // providers — rate-limited so a permanently removed model does not poll them on every sync.
    if (!this.io.command && await this.catalogMissesMembers(catalog.data)) {
      if (await this.refreshRemoteCatalogs(Date.now(), true)) catalog = await this.fetchCatalog();
    }
    this.catalog = catalog.data;
    const dir0 = join(this.home, "model-routing");
    await mkdir(dir0, { recursive: true, mode: 0o700 });
    // Daily AA scores and prices, so new models are placed by today's leaderboard, not the bundled one.
    const aa = this.io.command ? loadAa(join(dir0, "aa.json")) : await refreshAa(join(dir0, "aa.json"));
    if (aa?.admissionBlocked) throw Error("AA 最新 Luna Max 锚点缺失，暂停新增分组，保留现有配置");
    if (aa) useBenchmarks(aa.models);
    let state: { version?: string; known?: string[]; manualRemovals?:Record<string,string[]> } = {};
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
    const [ranking] = await this.db.query<[{ orders?: Record<string, string[]>; pins?: Record<string, string[]>; results?:Record<string,{engine?:string}> } | undefined]>("SELECT orders,pins,results FROM ONLY company_meta:model_ranking;");
    this.orders = { ...ranking?.orders, ...this.orders };
    const models = classify(catalog.data).filter(
      (m) => !config?.disabledModels?.includes(m.id),
    );
    // Legacy overrides do not bypass new-model admission; manual group membership stays authoritative.

    const results = await readModelResults(this.db);
    const dir = join(this.home, "model-routing");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let previous: Record<string, string> = {};
    try {
      previous = JSON.parse(await readFile(join(dir, "groups.json"), "utf8"));
    } catch {}
    const groups: Record<string, string> = {};
    const routes: Record<string, Array<{ model: string; score: number; samples: number }>> = {};
    const groupLevels = this.io.levels?.() ?? (this.io.command ? {} : readMagpieLevels());
    const groupsToSet: Array<{ id: string; models: string[]; signature: string }> = [];
    // Membership is the owner's. Automatic grouping runs once per GROUPING_VERSION and afterwards
    // only places models this controller has never seen; manual adds and removals in magpie stay.
    // The controller only reorders members by ranking.
    const fresh = models.filter((m) => !known.has(m.id)&&!state.manualRemovals?.[m.id]?.length);
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
    for (const tier of tiers) {
      // Manual groups belong to the owner in Magpie: no creation, membership/effort normalization,
      // new-model placement, persisted pins, ranking or routing/stickiness writes.
      if (tier === "opus" || tier === "fable") continue;
      // Staff groups have independent price bands; an empty group never borrows another band.
      const bucket = models.filter(m=>m.tier===tier);
      const current = live[`sck-${tier}`];
      const ids = initializing || !current
        ? bucket.filter(m=>!state.manualRemovals?.[m.id]?.length).map((m) => m.member ?? m.id)
        : [...current.filter(member=>!generatedModel(member)).map(pinned), ...fresh.filter((m) => m.tier === tier && !holds(current, m.id)).map((m) => m.member ?? m.id)];
      if (!ids.length) {
        groups[`sck-${tier}`] = digest("[]");
        routes[`group/sck-${tier}`] = [];

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
      const jev = this.orders[`sck-${tier}`] ?? [];
      // A member pinned since Jev last ranked keeps its place under its bare id.
      const at = (id: string) => {
        const i = jev.indexOf(id) >= 0 ? jev.indexOf(id) : jev.findIndex((x) => splitMember(x).id === splitMember(id).id);
        return i < 0 ? jev.length : i;
      };
      const baseOrder = byRank;
      const ordered = baseOrder.map((m, i) => ({ m, i })).sort((a, b) => at(a.m.id) - at(b.m.id) || a.i - b.i).map((x) => x.m);
      const members = this.ruleOrders.has(`sck-${tier}`)||ranking?.results?.[`sck-${tier}`]?.engine?.startsWith('quality-pace-')
        ?ordered.map(m=>m.id):pinnedOrder(ordered.map(m=>m.id),ranking?.pins?.[`sck-${tier}`]);
      const positions = new Map(members.map((id, i) => [id, i]));
      ordered.sort((a,b) => positions.get(a.id)! - positions.get(b.id)!);
      for (const member of members) {
        const reason = memberIssue(tier, member, levelsOf(member));
        if (reason) issues.push({ group: `sck-${tier}`, member, reason });
      }
      const signature = digest(JSON.stringify(members));
      groups[`sck-${tier}`] = signature;
      // A group whose stickiness differs is rewritten too: membership alone would leave it as it was.
      if (JSON.stringify(current) !== JSON.stringify(members) || (stays[`sck-${tier}`] ?? GROUP_STAYS) !== GROUP_STAYS || JSON.stringify(groupLevels[`sck-${tier}`] ?? []) !== JSON.stringify(GROUP_LEVELS))
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
          `levels=${GROUP_LEVELS.join(",")}`,
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
      if (id === 'sck-opus' || id === 'sck-fable' || !id.startsWith('sck-') || id in groups || storyModels?.includes(`group/${id}`)) continue;
      if (preparing) groups[id] = previous[id]!; // the previous gateway still owns live leases until release switch
      // Already gone is done: a sync that died after removing groups but before writing groups.json
      // (or a concurrent one) must not fail every later sync.
      else await this.command(['group','rm',id]).catch((e: Error) => { if (!/no group/.test(e.message)) throw e; });
    }
    await writeFile(join(dir, "membership.json.tmp"), JSON.stringify({ ...state, version: GROUPING_VERSION, known: nextKnown }), { mode: 0o600 });
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
