// Runs the company dispatcher tick loop inside the plugin subprocess and wakes it early on
// Paseo lifecycle events, replacing the org.surrealck.company-dispatcher launchd service.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { company, type Company } from "./company";

const COMPANY_TITLE = "SCK · ";

async function isCompanyAgent(paseo: PaseoApi, agent: { id: string; title?: string | null }): Promise<boolean> {
  if (agent.title?.startsWith(COMPANY_TITLE)) return true;
  const detail = await paseo.agents.ref(agent.id).refresh().catch(() => undefined);
  return (detail as { agent?: { labels?: Record<string, string> } } | null | undefined)?.agent?.labels?.company === "surreal-ck";
}

export function startDispatch(server: PluginServerContext): () => void {
  let stopped = false;
  let wake: (() => void) | undefined;
  let running = true;

  const nap = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(() => { wake = undefined; resolve(); }, ms);
    wake = () => { wake = undefined; clearTimeout(timer); resolve(); };
  });

  const loop = async () => {
    let failures = 0;
    while (!stopped) {
      let wait = 20_000;
      try {
        const ctx: Company = await company();
        wait = (await ctx.workforce.config()).pollSeconds * 1000;
        const report = await ctx.dispatcher.tick();
        failures = 0;
        const changed = report.commands || report.revoked.length || report.woke.length || report.retired.length ||
          report.exhausted.length || report.notices.length || report.evals.length || (report.decisions?.length ?? 0);
        if (changed) console.log(`tick ${JSON.stringify(report)}`);
        await ctx.db.db.query("UPSERT company_meta:dispatcher_heartbeat SET at = time::now();");
      } catch (error) {
        failures++;
        wait = Math.min(wait * 2 ** Math.min(failures, 5), 300_000);
        console.error(`tick failed: ${(error as Error).message}`);
      }
      await nap(wait);
    }
  };
  void loop();

  // A finished turn usually means a checkpoint/submit/review landed; dispatch immediately
  // instead of waiting out the poll interval.
  const kick = () => { if (!stopped && running) wake?.(); };
  const removers = [
    server.on("agent.turn_ended", (event, { paseo }) => {
      void isCompanyAgent(paseo, event.agent).then(ok => ok && kick());
    }),
    server.on("agent.archived", (event, { paseo }) => {
      void isCompanyAgent(paseo, event.agent).then(ok => ok && kick());
    }),
    server.on("workspace.archived", () => kick()),
    server.on("agent.permission_requested", (event, { paseo }) => {
      void isCompanyAgent(paseo, event.agent).then(ok => {
        if (!ok) return;
        console.log(`permission requested by ${event.agent.title ?? event.agent.id}: ${JSON.stringify(event.request).slice(0, 300)}`);
      });
    }),
  ];

  return () => {
    stopped = true;
    wake?.();
    for (const remove of removers) remove();
  };
}
