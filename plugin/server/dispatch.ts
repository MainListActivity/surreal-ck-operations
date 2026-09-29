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

function providerQuotaSummary(entry: ProviderUsageEntry): string {
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
  return parts.length ? parts.join("；") : `状态 ${entry.status}`;
}

/** Lowest remaining percentage across windows and balances; undefined when the provider reports no numbers. */
function lowestRemainingPct(entry: ProviderUsageEntry): number | undefined {
  const pcts: number[] = [];
  for (const w of entry.windows ?? []) if (w.remainingPct != null) pcts.push(w.remainingPct);
  for (const b of entry.balances ?? []) {
    if (b.remaining != null && b.limit != null && b.limit > 0) pcts.push((b.remaining / b.limit) * 100);
  }
  return pcts.length ? Math.min(...pcts) : undefined;
}

function formatProviderUsage(entry: ProviderUsageEntry): string {
  const plan = entry.planLabel ? `（${entry.planLabel}）` : "";
  return `${entry.providerId}${plan} 提交时额度：${providerQuotaSummary(entry)}`;
}

let quotaRefreshedAt = 0;
// Lifecycle hooks and RPC handlers are the only places a paseo handle is handed out;
// remember the latest one so the tick loop can also refresh quota during quiet periods.
let paseoHandle: PaseoApi | undefined;

/** Hooks carry the only paseo handle: persist latest quota to company_meta so the dispatcher can read it. */
export async function refreshQuota(paseo: PaseoApi, ctx: Company): Promise<ProviderUsageEntry[]> {
  paseoHandle = paseo;
  if (Date.now() - quotaRefreshedAt < 45_000) return readQuotaEntries(ctx);
  quotaRefreshedAt = Date.now();
  const usage = await paseo.providers.listUsage().catch(() => undefined);
  const providers = (usage as { fetchedAt?: string; providers?: ProviderUsageEntry[] } | undefined)?.providers ?? [];
  if (!providers.length) return [];
  const { RecordId } = await import("surrealdb");
  for (const entry of providers) {
    await ctx.db.db.query(
      `UPSERT $meta CONTENT { provider: $provider, summary: $summary, lowest_pct: $lowest, status: $status, fetched_at: $fetched, payload: $entry, at: time::now() };`,
      { meta: new RecordId("company_meta", `quota_${entry.providerId}`), provider: entry.providerId,
        summary: providerQuotaSummary(entry), lowest: lowestRemainingPct(entry), status: entry.status,
        fetched: usage?.fetchedAt, entry });
  }
  return providers;
}

async function readQuotaEntries(ctx: Company): Promise<ProviderUsageEntry[]> {
  const [rows] = await ctx.db.db.query<[Array<{ payload?: ProviderUsageEntry }>]>(
    `SELECT payload FROM company_meta WHERE string::starts_with(<string>id, 'company_meta:quota_');`);
  return (rows ?? []).map(r => r.payload).filter((p): p is ProviderUsageEntry => !!p);
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
  const providers = await refreshQuota(paseo, ctx);
  const fresh = providers.length ? providers : await readQuotaEntries(ctx);
  const entry = fresh.find(p => p.providerId === agent.provider);
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
        if (paseoHandle && Date.now() - quotaRefreshedAt > 300_000) {
          await refreshQuota(paseoHandle, ctx).catch((error) => console.warn(`quota refresh failed: ${(error as Error).message}`));
        }
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
        console.log(`turn_ended ${event.agent.title ?? event.agent.id} company=${ok}`);
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
      void isCompanyAgent(paseo, event.agent).then(async ok => {
        if (!ok) return;
        await refreshQuota(paseo, await company()).catch(() => {});
        kick();
      });
    }),
    server.on("workspace.archived", () => kick()),
    server.on("agent.permission_requested", (event, { paseo }) => {
      void isCompanyAgent(paseo, event.agent).then(async ok => {
        if (!ok) return;
        await refreshQuota(paseo, await company()).catch(() => {});
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
