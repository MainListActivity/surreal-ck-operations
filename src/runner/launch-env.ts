import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
/**
 * Infrastructure credentials no company agent may inherit, by exact name or prefix. Provider login
 * variables (OPENAI_API_KEY and the like) stay out on purpose: the provider process shares the
 * agent's environment, so blanking them would break the agent. `SCK_SCRUB_ENV` (comma separated)
 * adds names or prefixes without a code change.
 */
const EXTERNAL = ["CLOUDFLARE_", "CF_API_", "SURREAL", "JEV_", "TYPESAFE_", "ELEVENLABS_", "XI_API_KEY", "COMPANY_", "RUNNER_", "IDP_", "GATEWAY_"];
/** Plumbing variables only the company itself sets; a shell startup file never exports these. */
const INTERNAL = ["SCK_OPS_", "SCK_PRODUCT_ENV", "SCK_MCP_TOKEN", "SCK_OWNER_TOKEN", "SCK_SERVICE_GATE", "SCK_EMPLOYEE_CREDENTIAL"];

export const SANDBOX_MARKER = { SCK_SANDBOX: "employee" } as const;
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
