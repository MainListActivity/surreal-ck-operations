import { basename, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { installBunShim } from "./server/bun-shim";
import { company } from "./server/company";
import { createConsoleFetch } from "./server/console";
import { createQaConsoleFetch } from "./server/qa-console";
import { registerHandlers } from "./server/handlers";
import { startDispatch } from "./server/dispatch";
import { loadServiceEnv, serviceHome } from "./server/env";
import { startPreview, type PreviewHandle } from "./server/preview";
import { routingEnv, installRoutingSettings } from "./server/vendor/src/model-routing/gateway.ts";
import { registerScrub } from "./server/scrub";

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
  loadServiceEnv(); // SCK_SCRUB_ENV lives there, and the zsh shim is written below, before the company stack boots
  registerHandlers(server);
  const stopScrub = registerScrub(server, process.env, { zdotdir: join(serviceHome(), "zdot"), modelEnv: async request => {
    if(request.provider !== "claude") return {};
    const ctx=await company();
    if(!ctx.modelRouting.enabled) return {};
    const ref=request.env.SCK_COMM_DIR ? `employee:${basename(request.env.SCK_COMM_DIR)}` : request.agentId;
    const session=ctx.sidecar.routingSession(ref);
    if(session?.role === "story-author") return {};
    if(!session)throw new Error("公司模型路由尚未恢复员工会话登记");
    const env=routingEnv(`employee:${session.employee}`);
    installRoutingSettings(session.comm,env);
    return env;
  } });
  const stopDispatch = startDispatch(server);
  let preview!: PreviewHandle;
  const consoleFetch = createConsoleFetch({ home: serviceHome(), company, lanBase: () => preview.lanUrl });
  const qaConsoleFetch = createQaConsoleFetch({ home: serviceHome(), company });
  preview = startPreview({ consoleFetch, qaFetch: qaConsoleFetch });
  return () => {
    stopDispatch();
    void company().then(ctx=>ctx.stopModelGateway());
    void preview.stop();
    stopScrub();
  };
}
