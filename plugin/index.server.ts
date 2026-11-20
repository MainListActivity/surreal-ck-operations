import { employeeSessionLookup } from "./server/employee-session";
import {registerUsage} from './server/usage';
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { installBunShim } from "./server/bun-shim";
import { installNodeHost } from "./server/vendor/src/host-node.ts";
import { company } from "./server/company";
import { createConsoleFetch } from "./server/console";
import { registerHandlers } from "./server/handlers";
import { startDispatch } from "./server/dispatch";
import { loadServiceEnv, serviceHome } from "./server/env";
import { employeeModelEnv } from "./server/model-env";
import { startPreview, type PreviewHandle } from "./server/preview";
import { registerScrub, sandboxGap } from "./server/scrub";
import { companyAgentTools } from "./server/company-tools";
import { ownerApi } from "./server/vendor/src/owner-api.ts";

// The company DB lives on a remote WSS; when it drops, the SDK rejects every
// in-flight call. A stray floating promise becoming an unhandled rejection would
// kill the plugin process (Node default) — log and survive instead.
process.on("unhandledRejection", (reason) => {
  console.error(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
process.on("uncaughtException", (error) => {
  console.error(`uncaught exception: ${error.stack ?? error.message}`);
});

export default function contribute(server: PluginServerContext) {
  installBunShim();
  installNodeHost();
  loadServiceEnv(); // SCK_SCRUB_ENV lives there, and the zsh shim is written below, before the company stack boots
  registerHandlers(server);
  const stopUsage=registerUsage(server);
  const paseoConfig = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "config.json");
  const identifyEmployee = employeeSessionLookup(async agentId => {
      const ctx = await company();
      const [rows] = await ctx.db.db.query<[Array<{ id: unknown }>]>(
        "SELECT id FROM employee WHERE paseo_agent_id=$agent LIMIT 1;", { agent: agentId });
      return rows.length > 0;
    }, join(serviceHome(), "private", "employee-agents.json"));
  const stopScrub = registerScrub(server, process.env, { zdotdir: join(serviceHome(), "zdot"),
    employee: identifyEmployee, rememberEmployee: identifyEmployee.remember,
    sandbox: provider => sandboxGap(provider, paseoConfig, join(serviceHome(), "sandbox", "bin")),
    modelEnv: async request => employeeModelEnv(request, (await company()).sidecar, serviceHome()),
    tools: () => companyAgentTools({
      sidecar: async () => (await company()).sidecar,
      // landscape.get 只读 ctx.db：与 sck owner landscape.get 同一条 ownerApi 路径。
      landscape: async args => ownerApi({ db: (await company()).db } as never,
        { command: 'landscape.get', input: args }, 'agent-tool') as Promise<unknown>,
    }) });
  const stopDispatch = startDispatch(server);
  let preview!: PreviewHandle;
  const consoleFetch = createConsoleFetch({ home: serviceHome(), company, lanBase: () => preview.lanUrl });
  preview = startPreview({ consoleFetch });
  return () => {
    stopDispatch();
    stopUsage();
    void preview.stop();
    stopScrub();
  };
}
