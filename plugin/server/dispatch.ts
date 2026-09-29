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

type ProviderUsageEntry = {
  providerId: string;
  displayName: string;
  planLabel: string | null;
  status: "error" | "unavailable" | "available";
  windows?: Array<{ id: string; label: string; remainingPct?: number | null; resetsAt?: string | null; tone?: string }>;
  balances?: Array<{ id: string; label: string; remaining?: number | null; limit?: number | null; unit?: string; tone?: string }>;
};

function formatProviderUsage(entry: ProviderUsageEntry): string {
  const parts: string[] = [];
  for (const w of entry.windows ?? []) {
    if (w.remainingPct == null) continue;
    const reset = w.resetsAt ? `，${w.resetsAt.slice(5, 16).replace("T", " ")} 重置` : "";
    parts.push(`${w.label} 剩余 ${Math.round(w.remainingPct)}%${reset}`);
  }
  for (const b of entry.balances ?? []) {
    if (b.remaining == null) continue;
    parts.push(`${b.label} 剩 ${b.remaining}${b.limit != null ? `/${b.limit}` : ""} ${b.unit ?? ""}`);
  }
  const plan = entry.planLabel ? `（${entry.planLabel}）` : "";
  return `${entry.providerId}${plan} 提交时额度：${parts.length ? parts.join("；") : `状态 ${entry.status}`}`;
}

/** When an employee's turn ends right after submit, stamp the provider's remaining quota into the task audit. */
async function snapshotSubmitUsage(paseo: PaseoApi, ctx: Company, agent: { id: string; provider?: string }): Promise<void> {
  const detail = await paseo.agents.ref(agent.id).refresh().catch(() => undefined);
  const labels = (detail as { agent?: { labels?: Record<string, string> } } | null | undefined)?.agent?.labels;
  const employeeId = labels?.employee_id;
  if (!employeeId) return;
  const { RecordId } = await import("surrealdb");
  const [tasks] = await ctx.db.db.query<[Array<{ id: InstanceType<typeof RecordId>; version?: number }>]>(
    `SELECT id, version FROM task WHERE current_employee = $e AND state = 'review';`,
    { e: new RecordId("employee", employeeId) });
  if (!tasks?.length) return;
  const usage = await paseo.providers.listUsage().catch(() => undefined);
  const entry = (usage as { providers?: ProviderUsageEntry[] } | undefined)?.providers
    ?.find(p => p.providerId === agent.provider);
  if (!entry) {
    console.log(`usage snapshot skipped: no ${agent.provider} usage entry`);
    return;
  }
  const evidence = formatProviderUsage(entry);
  for (const task of tasks) {
    const [dup] = await ctx.db.db.query<[unknown[]]>(
      `SELECT id FROM audit WHERE task = $task AND action = 'provider_usage' AND version = $version LIMIT 1;`,
      { task: task.id, version: task.version });
    if (dup?.length) continue;
    await ctx.db.db.query(
      `CREATE audit CONTENT { task: $task, actor: 'owner:paseo-plugin', action: 'provider_usage', evidence: $evidence, version: $version, payload: $payload, at: time::now() };`,
      { task: task.id, evidence, version: task.version, payload: entry });
    console.log(`usage snapshot for ${String(task.id).split("⟨").pop()?.replace("⟩", "")}: ${evidence}`);
  }
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
      void isCompanyAgent(paseo, event.agent).then(async ok => {
        if (!ok) return;
        try {
          await snapshotSubmitUsage(paseo, await company(), event.agent);
        } catch (error) {
          console.warn(`usage snapshot failed: ${(error as Error).message}`);
        }
        kick();
      });
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
