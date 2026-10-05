import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { installBunShim } from "./server/bun-shim";
import { registerHandlers } from "./server/handlers";
import { startDispatch } from "./server/dispatch";
import { loadServiceEnv, serviceHome } from "./server/env";
import { startPreview } from "./server/preview";
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
  const stopScrub = registerScrub(server, process.env, { zdotdir: join(serviceHome(), "zdot") });
  const stopDispatch = startDispatch(server);
  const preview = startPreview();
  return () => {
    stopDispatch();
    void preview.stop();
    stopScrub();
  };
}
