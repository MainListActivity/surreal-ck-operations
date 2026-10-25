import type { PluginServerContext } from "@getpaseo/plugin/server";
import { MagpieUsage } from "./vendor/src/usage/magpie.ts";
import { digest, TIERS } from "./vendor/src/model-routing/policy.ts";
import { usageOverview, usageRequests, usageLive } from "../shared/usage";
import { currentCompany } from "./company";
import { isQaContext } from "./owner-context";
export function registerUsage(server: PluginServerContext) {
  const source = new MagpieUsage();
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
    // The lease is local sidecar state. Never query the remote DB or infer sessions from model names.
    const lease = currentCompany()?.sidecar.routingLease(agentId);
    if (lease)
      for (const tier of TIERS)
        sessions.add(
          `sck-${digest(`${lease.task}:${lease.employee}:${lease.fence}:${lease.phase}:${tier}`)}`,
        );
    return source.live(sessions);
  });
  return () => source.stop();
}
