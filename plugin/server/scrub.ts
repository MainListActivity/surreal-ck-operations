// Company agents are children of the Paseo daemon, so they inherit whatever credentials its
// environment holds (Cloudflare token, Jev key, ...). Credentials belong to the ops broker:
// every company session is launched with those variables blanked.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { isCompanyAgent } from "./company-agent";

/**
 * Infrastructure credentials no company agent may inherit, by exact name or prefix. Provider login
 * variables (OPENAI_API_KEY and the like) stay out on purpose: the provider process shares the
 * agent's environment, so blanking them would break the agent. `SCK_SCRUB_ENV` (comma separated)
 * adds names or prefixes without a code change.
 */
const EXTERNAL = ["CLOUDFLARE_", "CF_API_", "SURREAL", "JEV_", "TYPESAFE_"];
/** Plumbing variables only the company itself sets; a shell startup file never exports these. */
const INTERNAL = ["SCK_OPS_", "SCK_PRODUCT_ENV", "SCK_MCP_TOKEN", "SCK_SERVICE_GATE", "SCK_EMPLOYEE_CREDENTIAL"];

const LOOKUP_MS = 2_000;
const ZSH_STARTUP = [".zshenv", ".zprofile", ".zshrc", ".zlogin"];

type Env = Record<string, string | undefined>;

const extras = (extra: string | undefined) => (extra ?? "").split(",").map(item => item.trim()).filter(Boolean);

export function blockedPatterns(extra: string | undefined = process.env.SCK_SCRUB_ENV): string[] {
  return [...EXTERNAL, ...INTERNAL, ...extras(extra)];
}

/** What a shell startup file could plausibly export: the plumbing variables are the company's own and are left out. */
export function externalPatterns(extra: string | undefined = process.env.SCK_SCRUB_ENV): string[] {
  return [...EXTERNAL, ...extras(extra)];
}

/**
 * The launch environment is not the whole story: a user who exports a token in ~/.zshrc gets it back in every
 * interactive zsh, and codex runs its commands through a snapshot of exactly that. Company sessions therefore
 * start zsh from a shim directory (ZDOTDIR) that sources the user's own startup files and then unsets the
 * credential names again, so PATH and the rest of the user's setup survive.
 */
export function zdotFiles(userDir: string, patterns: string[]): Record<string, string> {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const names = patterns.filter(item => /^[A-Za-z0-9_]+$/.test(item));
  const strip = names.length
    ? `for _sck_name in \${(k)parameters[(I)(${names.join("|")})*]}; do unset "$_sck_name" 2>/dev/null; done\nunset _sck_name\n`
    : "";
  return Object.fromEntries(ZSH_STARTUP.map(file => {
    const path = quote(`${userDir}/${file}`);
    return [file, `[ -r ${path} ] && . ${path}\n${strip}`];
  }));
}

/** The user's own zsh directory, never the shim itself: a plugin started from a company shell would otherwise source its own shim forever. */
export function userZshDir(shimDir: string, inherited: Env = process.env): string {
  return [inherited.ZDOTDIR, inherited.HOME].find(dir => dir && resolve(dir) !== resolve(shimDir)) ?? homedir();
}

/** Rewritten on every plugin start, so a changed SCK_SCRUB_ENV or user zsh directory takes effect after a reload. */
export function installZdot(dir: string, userDir: string, patterns: string[]): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const [file, text] of Object.entries(zdotFiles(userDir, patterns))) writeFileSync(join(dir, file), text, { mode: 0o600 });
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

export interface ScrubOptions {
  /** Directory for the zsh startup shim; without it company shells keep whatever the user's startup files export. */
  zdotdir?: string;
}

/**
 * Environment overrides are not persisted with an agent, so a resumed company session no longer
 * carries its launch marker: remember agent ids seen with one, and fall back to the agent's labels.
 */
export function registerScrub(server: PluginServerContext, inherited: Env = process.env, options: ScrubOptions = {}): () => void {
  let zdotdir = options.zdotdir;
  if (zdotdir) {
    try {
      installZdot(zdotdir, userZshDir(zdotdir, inherited), externalPatterns());
    } catch (error) {
      console.warn(`scrub: zsh startup shim not installed (${(error as Error).message}); company shells keep what ~/.zshrc exports`);
      zdotdir = undefined;
    }
  }
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
    if (zdotdir && env.ZDOTDIR === undefined) env.ZDOTDIR = zdotdir;
    console.log(`scrub ${request.agentId} (${request.reason}): blanked ${blanked.length} credential variable(s)${blanked.length ? ` [${blanked.join(", ")}]` : ""}${env.ZDOTDIR === zdotdir && zdotdir ? "; zsh startup shimmed" : ""}`);
    return { ...request, env };
  });
}
