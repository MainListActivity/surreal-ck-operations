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
  selectorPath,
} from "../src/model-routing/controller.ts";
import { RecordId } from "surrealdb";
import { restoreRoutingSettings } from "../src/model-routing/gateway.ts";
import { createPaseoCli } from "../src/dispatcher/paseo.ts";
import { execFileSync } from "node:child_process";
import { TIERS, employeeTier } from "../src/model-routing/policy.ts";
import { planRoutingRoster } from "../src/model-routing/roster.ts";
import { Workforce } from "../src/workforce.ts";
const release = resolve(import.meta.dir, "..");
const { loadServiceEnv, serviceHome } = await import("../plugin/server/env.ts");
loadServiceEnv();
const mode = process.argv[2];
if (!["enable", "migrate", "disable", "status"].includes(mode ?? ""))
  throw Error("usage: model-routing-admin.ts enable|disable|status");
const db = new CompanyDatabase(loadDatabaseConfig());
try {
  await db.connect();
  await db.useDatabase();
  if (mode === "enable" || mode === "migrate") {
    const [maintenance] = await db.db.query<[any]>("SELECT paused FROM ONLY company_meta:config;");
    if(maintenance?.paused!==true) throw Error("Pause dispatch before roster migration; existing leases continue normally");
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
    const router = new ModelRoutingController(
      db.db,
      serviceHome(),
      join(release, "magpie", "sck-performance.gateway.js"),
    );
    await router.prepare();
    // Apply the owner-approved roster before switching the running release. Never rewrite a live native session's provider.
    const changes = planRoutingRoster(defs);
    for (const def of changes) {
      await workforce.upsertDef(def.id, {role:def.role as any,provider:def.provider,model:def.model,
        enabled:def.enabled,tracks:def.tracks,maxInstances:def.maxInstances,quotaLimited:def.quotaLimited});
    }
    // Persist Claude employees' new defaults; a busy conversation reloads only after its current lease ends.
    await db.db.query(`UPDATE employee SET model = IF role='gm' THEN 'group/sck-opus' ELSE IF role='product' THEN 'group/sck-sonnet' ELSE 'group/sck-haiku' END END
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
    if (existsSync(backup)) {
      const workforce = new Workforce(db, join(serviceHome(), "private", "credentials"));
      for (const def of JSON.parse(readFileSync(backup, "utf8"))) {
        await workforce.upsertDef(def.id,{role:def.role,provider:def.provider,model:def.model,thinking:def.thinking,
          tracks:def.tracks,maxInstances:def.maxInstances,priority:def.priority,weight:def.weight,enabled:def.enabled,quotaLimited:def.quotaLimited});
      }
    }
    const [employees] = await db.db.query<
      [
        Array<{
          workspace_cwd?: string;
          paseo_agent_id?: string;
          active_task?: unknown;
        }>,
      ]
    >(
      "SELECT workspace_cwd,paseo_agent_id,active_task FROM employee WHERE provider='claude' AND retired!=true;",
    );
    const paseo = createPaseoCli(undefined, { timeoutMs: 5000 });
    let restored = 0,
      pending = 0;
    for (const e of employees) {
      if (e.workspace_cwd?.startsWith(join(serviceHome(), "comm") + "/"))
        restored += Number(restoreRoutingSettings(e.workspace_cwd));
      if (!e.paseo_agent_id) continue;
      const status = await paseo
        .status(e.paseo_agent_id)
        .catch(() => undefined);
      if (!e.active_task && status?.status === "idle")
        await paseo.reload(e.paseo_agent_id);
      else pending++;
    }
    execFileSync(
      "/Applications/magpie.app/Contents/MacOS/magpie",
      ["plugin", "off", selectorPath(serviceHome())],
      { stdio: "ignore", timeout: 20000 },
    );
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
