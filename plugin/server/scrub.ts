// Company agents are children of the Paseo daemon, so they inherit whatever credentials its
// environment holds (Cloudflare token, Jev key, ...). Credentials belong to the ops broker:
// every company session is launched with those variables blanked.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { isCompanyAgent } from "./company-agent";

/**
 * Infrastructure credentials no company agent may inherit, by exact name or prefix. Provider login
 * variables (OPENAI_API_KEY and the like) stay out on purpose: the provider process shares the
 * agent's environment, so blanking them would break the agent. `SCK_SCRUB_ENV` (comma separated)
 * adds names or prefixes without a code change.
 */
const BLOCKED = [
  "CLOUDFLARE_", "CF_API_", "SURREAL", "JEV_", "TYPESAFE_",
  "SCK_OPS_", "SCK_PRODUCT_ENV", "SCK_MCP_TOKEN", "SCK_SERVICE_GATE", "SCK_EMPLOYEE_CREDENTIAL",
];

const LOOKUP_MS = 2_000;

type Env = Record<string, string | undefined>;

export function blockedPatterns(extra: string | undefined = process.env.SCK_SCRUB_ENV): string[] {
  return [...BLOCKED, ...(extra ?? "").split(",").map(item => item.trim()).filter(Boolean)];
}

/** Launch env with every inherited credential variable overridden by an empty value; explicit launch values win. */
export function scrubEnv(launch: Record<string, string>, inherited: Env = process.env, patterns: string[] = blockedPatterns()): Record<string, string> {
  const blank: Record<string, string> = {};
  for (const name of Object.keys(inherited)) {
    if (patterns.some(pattern => name === pattern || name.startsWith(pattern))) blank[name] = "";
  }
  return { ...blank, ...launch };
}

interface SessionOpen { agentId: string; reason: string; env: Record<string, string> }

/** A company launch always carries its channel (comm mode) or credential file (legacy mode). */
const launchedByCompany = (env: Record<string, string>) =>
  env.SCK_COMM_DIR !== undefined || env.SCK_EMPLOYEE_CREDENTIAL_FILE !== undefined;

/** Resolves false instead of waiting: a hook that stalls would stall every agent the user opens. */
function withinLookup<T>(work: Promise<T>, fallback: T, signal: AbortSignal): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), LOOKUP_MS);
    const done = (value: T) => { clearTimeout(timer); resolve(value); };
    signal.addEventListener("abort", () => done(fallback), { once: true });
    work.then(done, () => done(fallback));
  });
}

/**
 * Environment overrides are not persisted with an agent, so a resumed company session no longer
 * carries its launch marker: remember agent ids seen with one, and fall back to the agent's labels.
 */
export function registerScrub(server: PluginServerContext, inherited: Env = process.env): () => void {
  const known = new Set<string>();
  const isCompany = async (request: SessionOpen, paseo: PaseoApi, signal: AbortSignal): Promise<boolean> => {
    if (launchedByCompany(request.env ?? {})) { known.add(request.agentId); return true; }
    if (known.has(request.agentId)) return true;
    if (request.reason === "create") return false; // company launches are marked; this is somebody else's agent
    const found = await withinLookup(isCompanyAgent(paseo, { id: request.agentId }), false, signal);
    if (found) known.add(request.agentId);
    return found;
  };
  return server.before("agent.session_open", async ({ request }, { paseo, signal }) => {
    if (!(await isCompany(request, paseo, signal))) return undefined;
    const env = scrubEnv(request.env ?? {}, inherited);
    const blanked = Object.keys(env).filter(name => env[name] === "" && request.env?.[name] === undefined);
    console.log(`scrub ${request.agentId} (${request.reason}): blanked ${blanked.length} credential variable(s)${blanked.length ? ` [${blanked.join(", ")}]` : ""}`);
    return { ...request, env };
  });
}
