import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { GROUP_CONTEXT_TOKENS, MAGPIE_BASE } from "./magpie-contract.ts";

/** Relative to the service home. Only the path is used here; the key itself never reaches logs, evidence or outputs. */
export const MAGPIE_KEY_RELATIVE = join("private", "magpie-remote.key");
/** Written by the retired 18779 gateway; restoreLegacyRoutingSettings removes it from old comm dirs. */
const LEGACY_GATEWAY = /^http:\/\/127\.0\.0\.1:18779\/a\//;
const LEGACY_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_MAX_CONTEXT_TOKENS"] as const;

/** The dedicated employee key. A missing or empty file refuses the launch: no silent fallback to another endpoint. */
export function readMagpieKey(serviceHome: string): string {
  const file = join(serviceHome, MAGPIE_KEY_RELATIVE);
  let key: string;
  try {
    key = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`员工模型密钥文件缺失：${file}，拒绝启动员工会话`);
  }
  if (!key) throw new Error(`员工模型密钥文件为空：${file}，拒绝启动员工会话`);
  return key;
}

/** The same key as an Authorization header: usage reads, quota reads and task cost settlement all call the VPS with it. */
export const magpieAuthorization = (serviceHome: string): Record<string, string> => ({ Authorization: `Bearer ${readMagpieKey(serviceHome)}` });

/**
 * Optional key for the VPS `/v1/magpie/quotas` read. The employee key is model-scoped and the quota endpoint answers
 * it 403, so the runner reads quota with this key when the owner has placed one; otherwise it falls back to the
 * employee key. It never reaches an employee session: only the runner process reads it, and the sandbox denies `private/`.
 */
export const MAGPIE_QUOTA_KEY_RELATIVE = join("private", "magpie-quota.key");
export function magpieQuotaAuthorization(serviceHome: string): Record<string, string> {
  try {
    const key = readFileSync(join(serviceHome, MAGPIE_QUOTA_KEY_RELATIVE), "utf8").trim();
    if (key) return { Authorization: `Bearer ${key}` };
  } catch { /* no dedicated quota key: use the employee key */ }
  return magpieAuthorization(serviceHome);
}

/**
 * Environment of an employee Claude session. The same values go to the process env and to the private settings file,
 * because a user's global settings.env wins over the process env (verified against Claude Code 2.1.319).
 * The alias pins keep Claude Code's own aliases (haiku/sonnet/opus) on the groups: without them a subagent or a
 * background call would send a native model id such as claude-haiku-5-5 to magpie.
 */
export function employeeEnv(input: { key: string; session: string }): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: MAGPIE_BASE,
    ANTHROPIC_AUTH_TOKEN: input.key,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_CUSTOM_HEADERS: `x-magpie-session: ${input.session}`,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(GROUP_CONTEXT_TOKENS),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "group/sck-haiku",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "group/sck-sonnet",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "group/sck-opus",
  };
}

/** Writes the private employee settings (launched with --settings through SCK_CLAUDE_SETTINGS). Returns the file path. */
export function writeEmployeeSettings(comm: string, env: Record<string, string>): string {
  const dir = join(comm, ".claude"), file = join(dir, "settings.local.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let settings: Record<string, any> = {};
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = JSON.stringify({ ...settings, env: { ...settings.env, ...env } }, null, 2) + "\n";
  writeFileSync(file + ".tmp", next, { mode: 0o600 });
  renameSync(file + ".tmp", file);
  return file;
}

/**
 * Removes what the retired 18779 gateway wrote into a comm dir, restoring the values it displaced. Story-author dirs
 * and sessions from older releases still carry those values; without this they would dial a port nothing listens on.
 */
export function restoreLegacyRoutingSettings(comm: string): boolean {
  const file = join(comm, ".claude", "settings.local.json");
  const backup = file + ".sck-before";
  const marker = join(comm, ".sck-model-router");
  const native = join(comm, ".sck-native-client");
  if (!existsSync(file)) return false;
  const settings = JSON.parse(readFileSync(file, "utf8"));
  if (!LEGACY_GATEWAY.test(settings.env?.ANTHROPIC_BASE_URL ?? "")) return false;
  const before = existsSync(backup) ? JSON.parse(readFileSync(backup, "utf8")) : { existed: false, env: {} };
  for (const key of LEGACY_KEYS) {
    if (Object.hasOwn(before.env ?? {}, key)) settings.env[key] = before.env[key];
    else delete settings.env[key];
  }
  if (settings.env && !Object.keys(settings.env).length) delete settings.env;
  if (!before.existed && !Object.keys(settings).length) unlinkSync(file);
  else writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  for (const path of [backup, marker, native]) {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
  return true;
}
