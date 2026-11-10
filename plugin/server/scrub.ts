// Company agents are children of the Paseo daemon, so they inherit whatever credentials its
// environment holds (Cloudflare token, Jev key, ...). Credentials belong to the ops broker:
// every company session is launched with those variables blanked, and marked so the provider
// launcher (scripts/sandbox/launch.sh) starts it inside the employee sandbox.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";


/**
 * Infrastructure credentials no company agent may inherit, by exact name or prefix. Provider login
 * variables (OPENAI_API_KEY and the like) stay out on purpose: the provider process shares the
 * agent's environment, so blanking them would break the agent. `SCK_SCRUB_ENV` (comma separated)
 * adds names or prefixes without a code change.
 */
const EXTERNAL = ["CLOUDFLARE_", "CF_API_", "SURREAL", "JEV_", "TYPESAFE_", "ELEVENLABS_", "XI_API_KEY"];
/** Plumbing variables only the company itself sets; a shell startup file never exports these. */
const INTERNAL = ["SCK_OPS_", "SCK_PRODUCT_ENV", "SCK_OWNER_TOKEN", "SCK_SERVICE_GATE"];

const LOOKUP_MS = 2_000;
/** Read by scripts/sandbox/launch.sh, which Paseo runs in place of each provider binary. */
export const SANDBOX_MARKER = { SCK_SANDBOX: "employee" } as const;
/** Providers whose launch scripts/sandbox/install.sh wraps; codex shares one app-server across agents and cannot be. */
const WRAPPERS: Record<string, string> = { claude: "claude", "factory-droid": "droid", antigravity: "agy" };

/**
 * Why a company session of this provider would start outside the sandbox, or undefined when Paseo
 * launches it through the installed wrapper. Read on every open so a reverted config fails closed.
 */
export function sandboxGap(provider: string, paseoConfig: string, wrapperDir: string): string | undefined {
  const wrapper = WRAPPERS[provider];
  if (!wrapper) return `provider ${provider} 无法放进员工沙箱`;
  let command: unknown;
  try {
    command = JSON.parse(readFileSync(paseoConfig, "utf8"))?.agents?.providers?.[provider]?.command;
  } catch (error) {
    return `读不到 Paseo 配置（${(error as Error).message}）`;
  }
  if (!Array.isArray(command) || command[0] !== join(wrapperDir, wrapper))
    return `Paseo 的 ${provider} 启动命令没有指向 ${wrapperDir}，先运行 scripts/sandbox/install.sh`;
}
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

/** A company launch always carries its comm channel (SCK_COMM_DIR). */
const launchedByCompany = (env: Record<string, string>) => env.SCK_COMM_DIR !== undefined;

/** Bound startup waits, but never turn a registry outage into permission to bypass employee routing. */
function withinLookup<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = () => reject(new Error("公司员工身份登记暂不可核实，请稍后重试"));
    const timer = setTimeout(() => finish(fail), LOOKUP_MS);
    const finish = (action: () => void) => { clearTimeout(timer); signal.removeEventListener("abort", abort); action(); };
    const abort = () => finish(fail);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    work.then(value => finish(() => resolve(value)), () => finish(fail));
  });
}

export interface ScrubOptions {
  employee?: (agentId: string) => Promise<boolean>;
  rememberEmployee?: (agentId: string) => void;
  /** Directory for the zsh startup shim; without it company shells keep whatever the user's startup files export. */
  zdotdir?: string;
  modelEnv?: (request: {agentId:string;env:Record<string,string>;provider?:string}) => Promise<Record<string,string>>;
  /** Refuses an interactive company session the sandbox would not cover; history views stay readable. */
  sandbox?: (provider: string) => string | undefined;
}

/**
 * Environment overrides are not persisted with an agent: resumed sessions use the durable employee
 * registry. Marked company launches are remembered locally before their agent binding is persisted.
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
    if (launchedByCompany(request.env ?? {})) { options.rememberEmployee?.(request.agentId); known.add(request.agentId); return true; }
    if (known.has(request.agentId)) return true;
    if (request.reason === "create") return false; // company launches are marked; this is somebody else's agent
    if (!options.employee) throw new Error("公司员工身份登记查询未配置");
    const found = await withinLookup(options.employee(request.agentId), signal);
    if (found) known.add(request.agentId);
    return found;
  };
  return server.before("agent.session_open", async ({ request }, { paseo, signal }) => {
    if (!(await isCompany(request, paseo, signal))) return undefined;
    const gap = request.purpose === "history" ? undefined : options.sandbox?.(request.provider);
    if (gap) {
      console.warn(`scrub ${request.agentId} (${request.reason}): refused, ${gap}`);
      throw new Error(`公司会话必须在员工沙箱中启动：${gap}`);
    }
    const env: Record<string, string> = { ...scrubEnv(request.env ?? {}, inherited), ...SANDBOX_MARKER };
    if (request.purpose !== "history" && options.modelEnv) Object.assign(env, await options.modelEnv(request));
    const blanked = Object.keys(env).filter(name => env[name] === "" && request.env?.[name] === undefined);
    if (zdotdir && env.ZDOTDIR === undefined) env.ZDOTDIR = zdotdir;
    console.log(`scrub ${request.agentId} (${request.reason}): blanked ${blanked.length} credential variable(s)${blanked.length ? ` [${blanked.join(", ")}]` : ""}${env.ZDOTDIR === zdotdir && zdotdir ? "; zsh startup shimmed" : ""}`);
    return { ...request, env };
  });
}
