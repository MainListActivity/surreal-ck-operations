import type { PluginServerContext } from "@getpaseo/plugin/server";
import { installBunShim } from "./server/bun-shim";
import { registerHandlers } from "./server/handlers";
import { startDispatch } from "./server/dispatch";
import { registerScrub } from "./server/scrub";

export default function contribute(server: PluginServerContext) {
  installBunShim();
  registerHandlers(server);
  const stopScrub = registerScrub(server);
  const stopDispatch = startDispatch(server);
  return () => {
    stopDispatch();
    stopScrub();
  };
}
