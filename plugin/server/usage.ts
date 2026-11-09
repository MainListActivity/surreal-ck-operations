import type { PluginServerContext } from "@getpaseo/plugin/server";
import { MagpieUsage } from "./vendor/src/usage/magpie.ts";
import { magpieAuthorization } from "./vendor/src/model-routing/employee-env.ts";
import { sessionKey } from "./vendor/src/model-routing/magpie-contract.ts";
import { usageOverview, usageRequests, usageLive } from "../shared/usage";
import { currentCompany } from "./company";
import { isQaContext } from "./owner-context";
import { serviceHome } from "./env";
export function registerUsage(server: PluginServerContext) {
  // The employee key authorizes these reads against the VPS magpie. It is read per request, so a missing key fails the read, not the plugin.
  const source = new MagpieUsage(undefined, undefined, undefined, () => magpieAuthorization(serviceHome()));
  server.handle(usageOverview, async (input, context) => {
    if (isQaContext(context)) throw Error("用量仅对老板开放");
    return source.overview(input);
  });
  server.handle(usageRequests, async (input, context) => {
    if (isQaContext(context)) throw Error("用量仅对老板开放");
    return source.page(input);
  });
  server.handle(usageLive, async ({ agentId }, context) => {
    if (isQaContext(context)) throw Error("用量仅对老板开放");
    const snapshot = await context.paseo.agents.ref(agentId).refresh();
    if (!snapshot) throw Error("会话不存在");
    const sessions = new Set<string>();
    const session = snapshot.agent.runtimeInfo?.sessionId ?? snapshot.agent.persistence?.sessionId;
    if (session) sessions.add(session);
    // The session key is local sidecar state. Never query the remote DB or infer sessions from model names.
    const bound = currentCompany()?.sidecar.sessionOf(agentId);
    if (bound) sessions.add(sessionKey(bound.task ?? "", bound.employee));
    return source.live(sessions);
  });
  return () => source.stop();
}
