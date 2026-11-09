// 运维作业执行器：认领网关写入的 queued 作业，按命令路由到注入的执行函数，结果写回作业记录。
// 本模块不接触任何 secret：员工凭证与租约由注入的 opsCall 解析，主机与发布动作由注入的函数执行。
// 作业字段形状按 schema 058：command、input、actor、result、error 均为 string（input/result/error 为 option<string>），
// input 与 result 存 JSON 文本，error 存 `${code}: ${message}` 形式的一句话。
import { RecordId, type Surreal } from 'surrealdb';
import { redactJson, redactText } from '../ops/redact.ts';
import type { HostExecInput } from './host-exec.ts';

export type OpsJobState = 'queued' | 'running' | 'done' | 'error';

export interface OpsJobDeps {
  db: Surreal;
  runner: string; // 执行端标识，例如 plugin:<pid>
  runnerOnlyCommands: ReadonlySet<string>; // 由调用方传入 RUNNER_ONLY_COMMANDS；本模块不 import owner-api
  opsCall(job: { actor: string; task: string; tool: string; args: Record<string, unknown> }): Promise<unknown>;
  runnerOnly(job: { command: string; input: Record<string, unknown> }): Promise<unknown>;
  hostExec(input: { host: string; command: string; timeoutSec?: number }): Promise<unknown>;
  releaseInstall(input: { sha: string }): Promise<unknown>;
  /**
   * 本执行端是否持有该作业执行者在该任务上的租约。ops_* 作业只由持有者认领，避免备用执行端把作业以 no_lease 写回失败。
   * 缺省视为持有（单执行端部署）。
   */
  holds?(job: { actor: string; task: string }): Promise<boolean> | boolean;
  log?: (message: string) => void;
}

/** 持有者认领窗口：入队超过这段时间仍无持有者认领的，任何执行端都可认领，由 opsCall 以 no_lease 写回错误。 */
const HOLDER_WINDOW_MS = 120_000;

/** 作业记录中本执行器关心的字段；RecordId 由 SDK 解析为对象。 */
interface OpsJobRow {
  id: RecordId;
  command?: unknown;
  input?: unknown;
  actor?: unknown;
  task?: unknown;
  created_at?: unknown;
}

type Outcome = { state: 'done'; result: string } | { state: 'error'; error: string };

const BATCH_LIMIT = 100; // 每轮最多处理的作业数
const RESULT_LIMIT_BYTES = 64 * 1024; // 结果 JSON 文本上限
const MESSAGE_LIMIT_CHARS = 200; // 错误信息正文上限
const ERROR_LIMIT_CHARS = 500; // 作业 error 字符串总上限（与 058 审计摘要上限一致）
const HOST_COMMAND_LIMIT_BYTES = 8192;
const HOST_TIMEOUT_MIN_SEC = 1;
const HOST_TIMEOUT_MAX_SEC = 900;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
// 本模块在 redactText 之外额外遮蔽形如 sk-xxxx 的密钥样式字符串。
const API_KEY_SHAPE = /\bsk-[A-Za-z0-9_-]{8,}/g;
// Bearer 令牌与 URL 中的用户名密码（scheme://user:pass@host）。
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// 协议名限 64 字符：不设上限时，长字母数字串上每个起点都要扫到串尾再回溯，整体为 O(n²)（70 KB 约 2.5 秒）。
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]{0,63}:\/\/)[^\s/?#@"']+@/gi;

// 认领仅在行仍为 queued 时成功；写回仅在本执行端仍持有 running 行时成功。两者都用 RETURN AFTER 检查是否真的更新到了行。
const CLAIM_SQL = "UPDATE $job SET state = 'running', runner = $runner, started_at = time::now() WHERE state = 'queued' RETURN AFTER;";
const DONE_SQL = "UPDATE $id SET state = 'done', result = $result, finished_at = time::now() WHERE state = 'running' AND runner = $runner RETURN AFTER;";
const ERROR_SQL = "UPDATE $id SET state = 'error', error = $error, finished_at = time::now() WHERE state = 'running' AND runner = $runner RETURN AFTER;";

/** 本模块内的输入校验错误，携带固定 code 'invalid'。 */
class InvalidJobError extends Error {
  readonly code = 'invalid';
}

function invalid(message: string): InvalidJobError {
  return new InvalidJobError(message);
}

/** 脱敏：先经 redactText，再遮蔽 Bearer 令牌、URL 中的凭证与密钥样式字符串。 */
function scrub(text: string): string {
  return redactText(text)
    .replace(BEARER_TOKEN, 'Bearer [redacted]')
    .replace(URL_CREDENTIAL, '$1[redacted]@')
    .replace(API_KEY_SHAPE, '[redacted]');
}

/** 按字符截断，不切开代理对。 */
function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return text.slice(0, cut);
}

/** 按 UTF-8 字节截断；截断产生的残缺字符被丢弃。 */
function cutBytes(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  return buf.subarray(0, Math.max(0, max)).toString('utf8').replace(/\uFFFD$/, '');
}

/** RecordId 取其 id 字段的字符串形式；普通字符串原样返回；其他类型视为缺失。 */
function idOf(value: unknown): string | undefined {
  if (value instanceof RecordId) return String(value.id);
  return typeof value === 'string' ? value : undefined;
}

/** 入队时刻（毫秒）；取不到或无法解析时按 0 计，即视为早已入队，不会因此被卡住。 */
function createdAtMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? 0 : ms;
}

function plainObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(message);
  return value as Record<string, unknown>;
}

/** 作业 input 按 058 为 JSON 文本；缺失视为空对象；已是对象（非 058 形状的旧数据）原样使用。 */
function jobInput(value: unknown): unknown {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalid('input 不是合法的 JSON 文本');
  }
}

/** 校验 host.exec 输入，返回规范化的副本。 */
function hostExecInput(value: unknown): HostExecInput {
  const input = plainObject(value, 'host.exec 输入必须是对象');
  const { host, command, timeoutSec } = input;
  if (typeof host !== 'string') throw invalid('host 必须是字符串');
  if (typeof command !== 'string' || command.trim() === '') throw invalid('command 必须是非空字符串');
  if (Buffer.byteLength(command, 'utf8') > HOST_COMMAND_LIMIT_BYTES || command.includes('\u0000')) {
    throw invalid('command 超过 8192 字节或含 NUL 字符');
  }
  if (timeoutSec !== undefined && timeoutSec !== null) {
    const ok = typeof timeoutSec === 'number' && Number.isInteger(timeoutSec)
      && timeoutSec >= HOST_TIMEOUT_MIN_SEC && timeoutSec <= HOST_TIMEOUT_MAX_SEC;
    if (!ok) throw invalid('timeoutSec 必须是 1..900 的整数');
    return { host, command, timeoutSec: timeoutSec as number };
  }
  return { host, command };
}

/** 校验 company.release.install 输入，返回提交号。 */
function releaseSha(value: unknown): string {
  const input = plainObject(value, 'company.release.install 输入必须是对象');
  const sha = input.sha;
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) throw invalid('sha 必须是 40 位小写十六进制提交号');
  return sha;
}

/**
 * 把任意错误转为作业 error 字符串：`${code}: ${message}`。
 * code 为字符串时沿用，否则为 upstream_error；message 先脱敏再截断到 200 字符，整体再脱敏并截断到 500 字符。
 */
function failure(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  const raw = err instanceof Error ? err.message : String(err);
  const name = typeof code === 'string' ? code : 'upstream_error';
  const message = scrub(clipChars(scrub(raw), MESSAGE_LIMIT_CHARS));
  return clipChars(scrub(`${name}: ${message}`), ERROR_LIMIT_CHARS);
}

/**
 * 结果存库形式（JSON 文本字符串）：
 * - 未超过 64 KiB 且脱敏后仍为合法 JSON：返回脱敏并经 redactJson（遮蔽 token 类字段）后的 JSON 文本；
 * - 否则返回 {"truncated":true,"preview":...} 的 JSON 文本，preview 为先脱敏再按字节截断的文本，整体不超过 64 KiB。
 */
export function storeResult(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null';
  if (Buffer.byteLength(text, 'utf8') <= RESULT_LIMIT_BYTES) {
    try {
      const stored = JSON.stringify(redactJson(JSON.parse(scrub(text))));
      if (Buffer.byteLength(stored, 'utf8') <= RESULT_LIMIT_BYTES) return stored;
    } catch {
      // 脱敏后的文本不是合法 JSON，按预览形式存放。
    }
  }
  const redacted = scrub(text);
  // 预览经 JSON 转义后可能变长，逐步收紧字节预算，直到包装后的整体不超过上限。
  let budget = RESULT_LIMIT_BYTES;
  for (;;) {
    const preview = JSON.stringify({ truncated: true, preview: cutBytes(redacted, budget) });
    if (Buffer.byteLength(preview, 'utf8') <= RESULT_LIMIT_BYTES || budget <= 0) return preview;
    budget -= 1024;
  }
}

export class OpsJobRunner {
  private inflight: Promise<number> | undefined;
  // 执行中又有人请求 drain：本轮结束后补跑一轮，免得漏掉轮次开始之后才入队的作业。
  private again = false;

  constructor(private readonly deps: OpsJobDeps) {}

  /**
   * 认领并执行当前所有 queued 作业。单飞：执行中再次调用返回同一个 promise，并让它在本轮结束后再跑一轮。
   * 返回整段执行中写入 done/error 的作业数。
   */
  drain(): Promise<number> {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = this.rounds();
    return this.inflight;
  }

  /**
   * 连续执行轮次，直到某轮结束时没有新的 drain 请求。inflight 在最后一次检查 again 的同一个同步步骤里清掉，
   * 两者之间不让出，所以不会漏掉在此之前到达的 drain 请求。
   */
  private async rounds(): Promise<number> {
    let written = 0;
    try {
      for (;;) {
        this.again = false;
        written += await this.round();
        if (!this.again) return written;
      }
    } finally {
      this.inflight = undefined;
    }
  }

  private async round(): Promise<number> {
    const [rows] = await this.deps.db.query<[OpsJobRow[]]>(
      `SELECT id, command, input, actor, task, created_at FROM ops_job WHERE state = 'queued' ORDER BY created_at LIMIT ${BATCH_LIMIT};`,
    );
    let written = 0;
    for (const row of (rows ?? []).slice(0, BATCH_LIMIT)) {
      try {
        if (!(await this.mayClaim(row))) continue;
        if (await this.handle(row)) written++;
      } catch (err) {
        // 单个作业异常只记录，不中断本轮。
        this.deps.log?.(`运维作业 ${String(row.id)} 处理异常：${clipChars(scrub(errorText(err)), MESSAGE_LIMIT_CHARS)}`);
      }
    }
    return written;
  }

  /**
   * ops_* 作业只由持有该员工租约的执行端认领：本机不持有且入队不久的作业留给持有者。
   * 入队超过 HOLDER_WINDOW_MS 仍无人认领时，任何执行端都可认领，由 opsCall 以 no_lease 写回错误，不会一直停在 queued。
   */
  private async mayClaim(row: OpsJobRow): Promise<boolean> {
    const { holds } = this.deps;
    if (!holds || typeof row.command !== 'string' || !row.command.startsWith('ops_')) return true;
    const actor = idOf(row.actor);
    const task = idOf(row.task);
    if (!actor || !task) return true; // 交给 route 判为 invalid，写回 error
    if (await holds({ actor, task })) return true;
    return Date.now() - createdAtMs(row.created_at) > HOLDER_WINDOW_MS;
  }

  /** 认领、执行并写回一个作业；返回是否写入了 done/error。 */
  private async handle(row: OpsJobRow): Promise<boolean> {
    const { db, runner } = this.deps;
    const [claimed] = await db.query<[unknown[]]>(CLAIM_SQL, { job: row.id, runner });
    if (!claimed || claimed.length === 0) return false; // 已被其他执行端认领

    let outcome: Outcome;
    try {
      outcome = { state: 'done', result: storeResult(await this.route(row)) };
    } catch (err) {
      outcome = { state: 'error', error: failure(err) };
    }

    const [written] = outcome.state === 'done'
      ? await db.query<[unknown[]]>(DONE_SQL, { id: row.id, runner, result: outcome.result })
      : await db.query<[unknown[]]>(ERROR_SQL, { id: row.id, runner, error: outcome.error });
    if (!written || written.length === 0) {
      this.deps.log?.(`运维作业 ${String(row.id)} 状态已变化，未写回结果`);
      return false;
    }
    return true;
  }

  /** 按 command 路由到注入的执行函数；actor 缺失或为空一律 invalid。 */
  private async route(row: OpsJobRow): Promise<unknown> {
    const { command } = row;
    if (typeof command !== 'string') throw invalid('未知命令');
    const actor = idOf(row.actor);
    if (!actor || actor.trim() === '') throw invalid('作业缺少 actor');
    const input = jobInput(row.input);

    if (command.startsWith('ops_')) {
      const task = idOf(row.task);
      if (!task || task.trim() === '') throw invalid('ops_* 作业缺少 task');
      return this.deps.opsCall({ actor, task, tool: command, args: plainObject(input, 'input 必须是对象') });
    }
    if (this.deps.runnerOnlyCommands.has(command)) {
      return this.deps.runnerOnly({ command, input: plainObject(input, 'input 必须是对象') });
    }
    if (command === 'host.exec') {
      return this.deps.hostExec(hostExecInput(input));
    }
    if (command === 'company.release.install') {
      return this.deps.releaseInstall({ sha: releaseSha(input) });
    }
    throw invalid('未知命令');
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
