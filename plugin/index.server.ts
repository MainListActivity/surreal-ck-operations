import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { installBunShim } from "./server/bun-shim";
import { registerHandlers } from "./server/handlers";
import { startDispatch } from "./server/dispatch";
import { loadServiceEnv, serviceHome } from "./server/env";
import { registerScrub } from "./server/scrub";

export default function contribute(server: PluginServerContext) {
  installBunShim();
  loadServiceEnv(); // SCK_SCRUB_ENV lives there, and the zsh shim is written below, before the company stack boots
  registerHandlers(server);
  const stopScrub = registerScrub(server, process.env, { zdotdir: join(serviceHome(), "zdot") });
  const stopDispatch = startDispatch(server);
  return () => {
    stopDispatch();
    stopScrub();
  };
}
