// Controlled local OCI CLI broker.
// Employees never receive OCI credentials or host OCI env vars; they pass an argv array to
// `ops_oci`, this trusted module executes the local `oci` binary directly (no shell) pinned
// to the managed config file/profile with `--auth api_key`, and permissions are enforced by
// OCI IAM policies. Only redacted, size-bounded output returns to the employee.
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Role } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import { clip, redactJson, redactText } from './redact.ts';

const VALID_ROLES: readonly Role[] = [
  'gm', 'owner', 'product', 'engineering', 'ai-content', 'concept-design',
  'asset-production', 'screenwriter', 'story-author', 'cinematography', 'qa', 'cs',
];
export const DEFAULT_OCI_ROLES: readonly Role[] = ['engineering', 'qa', 'product', 'gm', 'owner'];
const DEFAULT_BIN_CANDIDATES = ['/opt/homebrew/bin/oci', '/usr/local/bin/oci', '/usr/bin/oci'] as const;

const MAX_ARGS = 64;
const MAX_ARG_BYTES = 4096;
const DEFAULT_TIMEOUT_SEC = 45;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 90;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const STDOUT_LIMIT_CHARS = 48_000;
const STDERR_LIMIT_CHARS = 8_000;

const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const REGION_RE = /^[a-z0-9-]{2,64}$/;

/**
 * Global flags that would redirect credentials, endpoints, local files, debug auth dumps, or
 * interactive TTY prompts. Business flags (including `-c` / `--compartment-id`, `--region`,
 * `--query`, `--output`, etc.) pass through; authorization is enforced by OCI IAM.
 */
const BLOCKED_FLAGS = new Set([
  '--config-file',
  '--profile',
  '--cli-rc-file',
  '--defaults-file',
  '--auth',
  '--auth-purpose',
  '--cert-bundle',
  '--endpoint',
  '--federation-endpoint',
  '--debug',
  '--interactive',
]);

/** Interactive top-level commands that mutate local `~/.oci` config or browser sessions. */
const BLOCKED_COMMANDS = new Set(['setup', 'session']);

const invalid = (message: string) => new CompanyError('invalid', message);

export interface OciControlConfig {
  /** Absolute path to the managed OCI config file (never falls back to `~/.oci/config`). */
  configFile: string;
  /** Profile name inside `configFile` (default: `DEFAULT`). */
  profile: string;
  /** Optional explicit path to the `oci` binary; auto-detected from standard paths when omitted. */
  bin?: string;
  /** Optional default region passed when the caller did not specify `--region`. */
  region?: string;
  /** Roles allowed to invoke `ops_oci` when the task's project has no `project_env.broker`. */
  roles: readonly Role[];
}

export interface OciRequest {
  argv: string[];
  timeoutSec: number;
}

export interface OciRunOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface OciResult {
  ok: boolean;
  exitCode: number;
  data?: unknown;
  stdout?: string;
  stderr?: string;
  truncated: boolean;
  durationMs: number;
}

export type OciRunner = (cfg: OciControlConfig, req: OciRequest) => Promise<OciRunOutput>;

function parseRoles(raw: string | undefined): readonly Role[] {
  if (!raw || !raw.trim()) return DEFAULT_OCI_ROLES;
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parsed.length || parsed.some((role) => !VALID_ROLES.includes(role as Role))) {
    throw new CompanyError('not_configured', 'SCK_OPS_OCI_ROLES 包含无效角色名');
  }
  return [...new Set(parsed as Role[])];
}

/**
 * Resolves the managed OCI CLI settings from the control-plane environment and service home.
 * Defaults to `<serviceHome>/private/oci/config` so the broker never silently touches the
 * owner's personal `~/.oci/config`.
 */
export function resolveOciConfig(
  serviceHome: string,
  env: Record<string, string | undefined> = process.env,
): OciControlConfig {
  const configFile = env.SCK_OPS_OCI_CONFIG_FILE?.trim() || join(serviceHome, 'private', 'oci', 'config');
  if (!isAbsolute(configFile) || configFile.includes('\0') || configFile.includes('\n')) {
    throw new CompanyError('not_configured', 'SCK_OPS_OCI_CONFIG_FILE 必须是合法的绝对路径');
  }
  const profile = env.SCK_OPS_OCI_PROFILE?.trim() || 'DEFAULT';
  if (!PROFILE_RE.test(profile)) {
    throw new CompanyError('not_configured', 'SCK_OPS_OCI_PROFILE 格式无效');
  }
  const bin = env.SCK_OPS_OCI_BIN?.trim() || undefined;
  if (bin !== undefined && (!isAbsolute(bin) || bin.includes('\0') || bin.includes('\n'))) {
    throw new CompanyError('not_configured', 'SCK_OPS_OCI_BIN 必须是合法的绝对路径');
  }
  const region = env.SCK_OPS_OCI_REGION?.trim() || undefined;
  if (region !== undefined && !REGION_RE.test(region)) {
    throw new CompanyError('not_configured', 'SCK_OPS_OCI_REGION 格式无效');
  }
  return { configFile, profile, ...(bin ? { bin } : {}), ...(region ? { region } : {}), roles: parseRoles(env.SCK_OPS_OCI_ROLES) };
}

function flagNameOf(token: string): string | undefined {
  if (!token.startsWith('--')) return undefined;
  const eq = token.indexOf('=');
  return (eq > 0 ? token.slice(0, eq) : token).toLowerCase();
}

function hasRegionFlag(argv: readonly string[]): boolean {
  return argv.some((token) => token === '--region' || token.startsWith('--region='));
}

/** Validates `ops_oci` tool arguments and blocks credential/host-file escape flags. */
export function parseOciRequest(args: Record<string, unknown>): OciRequest {
  const allowed = new Set(['argv', 'timeoutSec', 'env']);
  const extra = Object.keys(args).filter((key) => !allowed.has(key));
  if (extra.length) throw invalid(`ops_oci 只接受 argv、timeoutSec 与 env（拒绝：${extra.join(', ')}）`);

  const rawArgv = args.argv;
  if (!Array.isArray(rawArgv) || rawArgv.length === 0) {
    throw invalid('argv 必须是非空字符串数组，例如 ["os","ns","get"]');
  }
  if (rawArgv.length > MAX_ARGS) throw invalid(`argv 最多包含 ${MAX_ARGS} 个参数`);

  const argv: string[] = [];
  let firstCommand: string | undefined;
  for (let i = 0; i < rawArgv.length; i++) {
    const token = rawArgv[i];
    if (typeof token !== 'string' || token.length === 0) throw invalid(`argv[${i}] 必须是非空字符串`);
    if (token.includes('\0')) throw invalid(`argv[${i}] 不能包含 NUL 字符`);
    if (Buffer.byteLength(token, 'utf8') > MAX_ARG_BYTES) throw invalid(`argv[${i}] 超过 ${MAX_ARG_BYTES} 字节上限`);
    if (/file:\/\//i.test(token)) throw invalid('ops_oci 禁止使用 file:// 读取宿主机本地文件，请直接传内联参数');

    const flag = flagNameOf(token);
    if (flag && BLOCKED_FLAGS.has(flag)) {
      throw invalid(`ops_oci 禁止覆盖受控选项 ${flag}`);
    }
    if (firstCommand === undefined) {
      if (token === '-i') throw invalid('ops_oci 禁止交互模式选项 -i');
      if (!token.startsWith('-')) {
        firstCommand = token.toLowerCase();
        if (BLOCKED_COMMANDS.has(firstCommand)) {
          throw invalid(`ops_oci 禁止本地配置/会话管理命令 ${firstCommand}`);
        }
      }
    }
    argv.push(token);
  }

  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (args.timeoutSec !== undefined) {
    if (typeof args.timeoutSec !== 'number' || !Number.isInteger(args.timeoutSec)
      || args.timeoutSec < MIN_TIMEOUT_SEC || args.timeoutSec > MAX_TIMEOUT_SEC) {
      throw invalid(`timeoutSec 必须是 ${MIN_TIMEOUT_SEC}..${MAX_TIMEOUT_SEC} 的整数`);
    }
    timeoutSec = args.timeoutSec;
  }

  return { argv, timeoutSec };
}

/** Builds a compact, secret-free audit summary (command verbs + arg count, never flag values). */
export function ociAuditSummary(argv: readonly string[]): string {
  const verbs: string[] = [];
  for (const token of argv) {
    if (token.startsWith('-')) break;
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(token)) verbs.push(token);
    if (verbs.length >= 4) break;
  }
  const head = verbs.length ? verbs.join(' ') : '(flags)';
  return `${head} (argc=${argv.length})`;
}

function resolveOciBinary(configured?: string): string {
  if (configured) {
    try {
      accessSync(configured, constants.X_OK);
      return configured;
    } catch {
      throw new CompanyError('not_configured', `指定的 OCI CLI 不可执行：${configured}`);
    }
  }
  for (const candidate of DEFAULT_BIN_CANDIDATES) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* try next candidate */ }
  }
  throw new CompanyError('not_configured', '本机未找到可执行 oci CLI（可安装 oci-cli 或设置 SCK_OPS_OCI_BIN）');
}

function assertReadableConfig(configFile: string): void {
  try {
    accessSync(configFile, constants.R_OK);
  } catch {
    throw new CompanyError(
      'not_configured',
      `未配置受控 OCI 凭据文件（默认路径 <serviceHome>/private/oci/config，或设置 SCK_OPS_OCI_CONFIG_FILE）`,
    );
  }
}

/**
 * Executes the local `oci` CLI directly (`shell: false`) pinned to the managed config/profile
 * with `--auth api_key` and a scrubbed child environment.
 */
export const execOciCli: OciRunner = async (cfg, req) => {
  assertReadableConfig(cfg.configFile);
  const bin = resolveOciBinary(cfg.bin);
  const pinned: string[] = ['--config-file', cfg.configFile, '--profile', cfg.profile, '--auth', 'api_key'];
  if (cfg.region && !hasRegionFlag(req.argv)) pinned.push('--region', cfg.region);
  const fullArgv = [...pinned, ...req.argv];
  const env: NodeJS.ProcessEnv = {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: dirname(cfg.configFile),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING: 'True',
  };
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(bin, fullArgv, {
      shell: false,
      timeout: req.timeoutSec * 1000,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: 'utf8',
      env,
    }, (error, stdout, stderr) => {
      const durationMs = Math.max(0, Date.now() - started);
      if (!error) {
        return resolve({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), durationMs });
      }
      const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return reject(new CompanyError('upstream_error', 'oci 命令输出超过 2MiB 上限，请使用 --limit 或 --query 缩小返回范围', false));
      }
      if (err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
        return reject(new CompanyError('upstream_error', `oci 命令执行超时（${req.timeoutSec}s）`, true));
      }
      if (typeof err.code === 'number') {
        // Non-zero exit from OCI CLI (e.g. IAM 403/404 NotAuthorizedOrNotFound, bad parameter):
        // return structured output so the agent can see the exact OCI service message.
        return resolve({ exitCode: err.code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), durationMs });
      }
      const reason = err.code ? String(err.code) : (err.message || 'exec failed').slice(0, 160);
      reject(new CompanyError('upstream_error', `oci CLI 启动失败：${reason}`, true));
    });
  });
};

/** Redacts and size-bounds raw OCI CLI output; parses valid JSON stdout into structured `data`. */
export function formatOciResult(out: OciRunOutput, knownSecrets: readonly string[] = []): OciResult {
  const rawStdout = out.stdout ?? '';
  const safeStderr = redactText(out.stderr ?? '', knownSecrets);
  const stderrTruncated = safeStderr.length > STDERR_LIMIT_CHARS;
  const trimmedRaw = rawStdout.trim();
  const trimmedErr = safeStderr.trim();

  let data: unknown;
  let hasData = false;
  let stdout: string | undefined;
  let stdoutTruncated = false;

  if (trimmedRaw) {
    if (trimmedRaw.length <= STDOUT_LIMIT_CHARS) {
      try {
        const parsed = JSON.parse(trimmedRaw);
        const redacted = redactJson(parsed, knownSecrets);
        const serialized = JSON.stringify(redacted) ?? '';
        if (serialized.length <= STDOUT_LIMIT_CHARS) {
          data = redacted;
          hasData = true;
        }
      } catch { /* plain text output */ }
    }
    if (!hasData) {
      const safeStdout = redactText(rawStdout, knownSecrets);
      stdoutTruncated = safeStdout.length > STDOUT_LIMIT_CHARS;
      stdout = clip(safeStdout, STDOUT_LIMIT_CHARS);
    }
  }

  return {
    ok: out.exitCode === 0,
    exitCode: out.exitCode,
    ...(hasData ? { data } : {}),
    ...(stdout !== undefined ? { stdout } : {}),
    ...(trimmedErr ? { stderr: clip(trimmedErr, STDERR_LIMIT_CHARS) } : {}),
    truncated: stdoutTruncated || stderrTruncated,
    durationMs: out.durationMs,
  };
}
