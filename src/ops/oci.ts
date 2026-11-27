// Controlled OCI CLI broker facade backed by sck-vault.
// The OCI private key lives ONLY in the macOS login Keychain under an ACL bound to the signed
// `sck-vault` binary — never on disk, never in employee env, never inside the Node/Bun runner.
// Employees pass an argv array to `ops_oci`; this module validates arguments against credential/
// host-file escapes, delegates execution over `vault.sock` to `sck-vault`, and redacts/bounds
// the output. Command authorization is enforced by OCI IAM policies.
import type { Role } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import type { VaultClient } from '../media/vault.ts';
import { clip, redactJson, redactText } from './redact.ts';

const VALID_ROLES: readonly Role[] = [
  'gm', 'owner', 'product', 'engineering', 'ai-content', 'concept-design',
  'asset-production', 'screenwriter', 'story-author', 'cinematography', 'qa', 'cs',
];
export const DEFAULT_OCI_ROLES: readonly Role[] = ['engineering', 'qa', 'product', 'gm', 'owner'];

const MAX_ARGS = 64;
const MAX_ARG_BYTES = 4096;
const DEFAULT_TIMEOUT_SEC = 45;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 90;
const STDOUT_LIMIT_CHARS = 48_000;
const STDERR_LIMIT_CHARS = 8_000;

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

export type OciRunner = (req: OciRequest) => Promise<OciRunOutput>;

/** Resolves the roles allowed to call `ops_oci` when the task's project has no `project_env.broker`. */
export function resolveOciRoles(env: Record<string, string | undefined> = process.env): readonly Role[] {
  const raw = env.SCK_OPS_OCI_ROLES;
  if (!raw || !raw.trim()) return DEFAULT_OCI_ROLES;
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parsed.length || parsed.some((role) => !VALID_ROLES.includes(role as Role))) {
    throw new CompanyError('not_configured', 'SCK_OPS_OCI_ROLES 包含无效角色名');
  }
  return [...new Set(parsed as Role[])];
}

function flagNameOf(token: string): string | undefined {
  if (!token.startsWith('--')) return undefined;
  const eq = token.indexOf('=');
  return (eq > 0 ? token.slice(0, eq) : token).toLowerCase();
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

/** Delegates OCI CLI execution to the signed `sck-vault` daemon over its private Unix socket. */
export function vaultOciRunner(vault: Pick<VaultClient, 'oci'>): OciRunner {
  return (req) => vault.oci(req.argv, req.timeoutSec);
}

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
