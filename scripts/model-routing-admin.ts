// Owner maintenance entry. Execute only from a merged main release, with the service env loader.
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { loadDatabaseConfig } from "../src/config.ts";
import { CompanyDatabase } from "../src/database.ts";
import {
  ModelRoutingController,
} from "../src/model-routing/controller.ts";
import { RecordId } from "surrealdb";
import { restoreEmployeeRoutingSettings } from "../src/model-routing/gateway.ts";
import { createPaseoCli } from "../src/dispatcher/paseo.ts";
import { setAgentModel } from "../src/dispatcher/agent-model.ts";
import { execFileSync } from "node:child_process";
import { TIERS, employeeTier, employeeClientModel } from "../src/model-routing/policy.ts";
import { applyRoutingRoster } from "../src/model-routing/roster.ts";
import { Workforce } from "../src/workforce.ts";
const release = resolve(import.meta.dir, "..");
const { loadServiceEnv, serviceHome } = await import("../plugin/server/env.ts");
loadServiceEnv();
const mode = process.argv[2];
if (!["enable", "migrate", "roster", "disable", "status", "clients"].includes(mode ?? ""))
  throw Error("usage: model-routing-admin.ts enable|migrate|roster|disable|status|clients");
const db = new CompanyDatabase(loadDatabaseConfig());
try {
  await db.connect();
  await db.useDatabase();
  if (mode === "clients") {
    const [config] = await db.db.query<[{paused?:boolean}]>("SELECT paused FROM ONLY company_meta:config;");
    if (config?.paused !== true) throw Error("Pause dispatch before updating employee client defaults");
    const workforce = new Workforce(db,join(serviceHome(),"private","credentials"));
    const defs = (await workforce.defs()).filter(d=>d.provider==='claude'&&d.role!=='story-author');
    const dir=join(serviceHome(),"model-routing");mkdirSync(dir,{recursive:true,mode:0o700});
    const backup=join(dir,"employee-native-clients-before.json");
    if(!existsSync(backup))writeFileSync(backup,JSON.stringify(defs,null,2),{mode:0o600});
    for(const def of defs) await workforce.upsertDef(def.id,{...def,model:employeeClientModel(def.role),
      thinking:employeeTier(def.role)==='haiku'?'max':def.thinking});
    await db.db.query("UPDATE employee SET model = IF role='gm' THEN 'claude-opus-5-5' ELSE IF role='product' THEN 'claude-sonnet-5-5' ELSE 'claude-haiku-5-5' END WHERE provider='claude' AND role!='story-author' AND retired!=true RETURN NONE;");
    console.log(JSON.stringify({updatedDefinitions:defs.length,runningSessions:'unchanged; native model and v3 settings applied only after lease ends'}));
  }
  if (mode === "roster") {
    const workforce = new Workforce(db,join(serviceHome(),"private","credentials"));
    const dir=join(serviceHome(),"model-routing");mkdirSync(dir,{recursive:true,mode:0o700});
    const backup=join(dir,"employee-defs-factory-first-before.json");
    if (!existsSync(backup)) writeFileSync(backup,JSON.stringify(await workforce.defs(),null,2),{mode:0o600});
    const result=await applyRoutingRoster(workforce,db.db);
    console.log(JSON.stringify({changes:result.changes,removed:result.removed.map(d=>d.id),storyAuthors:'unchanged'}));
  }
  if (mode === "enable" || mode === "migrate") {
    const [maintenance] = await db.db.query<[any]>("SELECT paused FROM ONLY company_meta:config;");
    if(maintenance?.paused!==true) throw Error("Pause dispatch before roster migration; existing leases continue normally");
    await db.db.query(readFileSync(join(release,"schema","033-four-tier-routing.surql"),"utf8"));
    const workforce = new Workforce(db, join(serviceHome(), "private", "credentials"));
    const defs = await workforce.defs();
    const dir = join(serviceHome(), "model-routing");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const backup = join(dir, "employee-defs-four-tier-before.json");
    if (!existsSync(backup))
      writeFileSync(backup, JSON.stringify(defs, null, 2), { mode: 0o600 });
    await db.db.query(
      "UPSERT company_meta:model_routing MERGE {enabled:false,preparing:true,tierOverrides:{}};",
    );
    const router = new ModelRoutingController(db.db, serviceHome());
    await router.prepare();
    // Apply the owner-approved roster before switching the running release. Never rewrite a live native session's provider.
    const changes = (await applyRoutingRoster(workforce,db.db)).changes;
    const created = changes.filter(d=>!defs.some(old=>old.id===d.id)).map(d=>new RecordId('employee_def',d.id));
    await db.db.query("UPDATE company_meta:model_routing SET created_defs=array::union(created_defs??[],$created);",{created});
    // Persist Claude employees' new defaults; a busy conversation reloads only after its current lease ends.
    await db.db.query(`UPDATE employee SET model = IF role='gm' THEN 'claude-opus-5-5' ELSE IF role='product' THEN 'claude-sonnet-5-5' ELSE 'claude-haiku-5-5' END
      WHERE provider='claude' AND role!='story-author' AND retired!=true RETURN NONE;`);
    console.log(JSON.stringify({rosterChanges:changes.map(d=>({id:d.id,role:d.role,provider:d.provider,model:d.model,enabled:d.enabled})),storyAuthors:'unchanged'}));

    await db.db.query(
      "BEGIN; UPSERT company_meta:model_routing MERGE {enabled:true,preparing:false,enabled_at:time::now()}; UPDATE company_meta:model_routing_status SET enabled=true RETURN NONE; COMMIT;",
    );
    writeFileSync(
      join(dir, "activation.json.tmp"),
      JSON.stringify({ enabled: true }),
      { mode: 0o600 },
    );
    renameSync(join(dir, "activation.json.tmp"), join(dir, "activation.json"));
  }
  if (mode === "disable") {
    const dir = join(serviceHome(), "model-routing");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, "activation.json"),
      JSON.stringify({ enabled: false }),
      { mode: 0o600 },
    );
    await db.db.query(
      "BEGIN; UPSERT company_meta:model_routing MERGE {enabled:false,preparing:false}; UPDATE company_meta:model_routing_status SET enabled=false RETURN NONE; COMMIT;",
    );
    const backup = join(
      serviceHome(),
      "model-routing",
      "employee-defs-four-tier-before.json",
    );
    const workforce = new Workforce(db, join(serviceHome(), "private", "credentials"));
    const [migration] = await db.db.query<[any]>("SELECT created_defs FROM ONLY company_meta:model_routing;");
    await db.db.query("UPDATE employee_def SET enabled=false WHERE id IN $created RETURN NONE;",{created:migration?.created_defs ?? []});
    if (existsSync(backup)) {
      for (const def of JSON.parse(readFileSync(backup, "utf8"))) {
        if(def.role==='story-author') continue;
        await workforce.upsertDef(def.id,{role:def.role,provider:def.provider,model:def.model,thinking:def.thinking,
          tracks:def.tracks,maxInstances:def.maxInstances,priority:def.priority,weight:def.weight,enabled:def.enabled,quotaLimited:def.quotaLimited ?? true});
      }
    }
    await db.db.query("UPDATE employee SET model=def.model WHERE provider='claude' AND role!='story-author' AND retired!=true RETURN NONE;");
    const [employees] = await db.db.query<
      [
        Array<{
          workspace_cwd?: string;
          paseo_agent_id?: string;
          active_task?: unknown;
          model?: string;
          def?:RecordId;
          id?:RecordId;
        }>,
      ]
    >(
      "SELECT id,def,model,workspace_cwd,paseo_agent_id,active_task FROM employee WHERE provider='claude' AND role!='story-author' AND retired!=true;",
    );
    const paseo = createPaseoCli(undefined, { timeoutMs: 5000 });
    let restored = 0,
      pending = 0;
    for (const e of employees) {
      if (e.id) restored += Number(restoreEmployeeRoutingSettings(serviceHome(),String(e.id.id),e.workspace_cwd));
      if (!e.paseo_agent_id) continue;
      const status = await paseo
        .status(e.paseo_agent_id)
        .catch(() => undefined);
      if (!e.active_task && status?.status === "idle") {
        if(migration?.created_defs?.some((d:any)=>String(d)===String(e.def))) {
          try {await workforce.retire(String(e.id?.id),'模型路由回滚，停用迁移新增编制','rotation');await paseo.archive(e.paseo_agent_id);}
          catch {pending++;}
        } else {
          if(e.model && !await setAgentModel(e.paseo_agent_id,e.model)) {pending++;continue;}
          await paseo.reload(e.paseo_agent_id);
        }
      }
      else pending++;
    }
    console.log(JSON.stringify({ restored, pendingSessionReloads: pending }));
  }
  const [status] = await db.db.query<[any]>(
    "SELECT enabled,at,catalog,routes,groups,source FROM ONLY company_meta:model_routing_status;",
  );
  console.log(
    JSON.stringify({
      enabled: status?.enabled,
      at: status?.at,
      models: status?.catalog?.length,
      tiers: TIERS.map((tier) => ({
        tier,
        count: status?.catalog?.filter((m: any) => m.tier === tier).length,
      })),
      groups: status?.groups?.length,
      source: status?.source,
    }),
  );
} finally {
  await db.close();
}
