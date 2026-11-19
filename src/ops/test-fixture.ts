/**
 * 测试夹具（test fixture）的纯逻辑：确定性命名、本机台账与合成样本。
 *
 * 设计约束：
 * - 资产名由 project/env/task/alias 派生，天然按租约隔离；两个租约不会得到同一个名字。
 * - 台账是判断“这个既有资产是不是本任务创建”的唯一依据；台账没有记录时一律不认领、不删除。
 * - 台账与样本只落本机，任何 token、密码、会话句柄都不写入；句柄只留在 OpsBroker 的会话存储里。
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CompanyError } from '../core-errors.ts';
import type { Role } from '../contracts.ts';

/** 夹具只对工程/QA 开放；环境配置里的角色列表仍先做一层门禁。 */
export const FIXTURE_ROLES: readonly Role[] = ['engineering', 'qa'];
export const FIXTURE_ALIAS_PREFIX = 'TEST_';
/** 每个外部阶段的总期限；单次调用不会在期限之后补充重试。 */
export const FIXTURE_STAGE_BUDGET_MS = {
  account: 30_000,
  login: 75_000,
  workspace: 60_000,
  sample: 10_000,
  browser: 45_000,
} as const;
export type FixtureStage = keyof typeof FIXTURE_STAGE_BUDGET_MS;
/** 与既有浏览器注入一致：只对瞬断再试一次，退避固定。 */
export const FIXTURE_STAGE_ATTEMPTS = 2;
export const FIXTURE_STAGE_BACKOFF_MS = 1_000;

export interface FixtureIdentity {
  /** 台账键：project/env/task/alias 四元组，跨任一维度都不复用。 */
  key: string;
  /** 真正写入 IdP 的测试专用别名（带 TEST_ 前缀与任务摘要后缀）。 */
  alias: string;
  username: string;
  workspaceSlug: string;
  workspaceName: string;
  /** 请求方给的别名，仅用于派生，不直接当作资产名。 */
  requestedAlias: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const SAFE = /[^a-z0-9-]/g;

function slugPart(value: string, max: number): string {
  return value.toLowerCase().replaceAll('_', '-').replace(SAFE, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
}

/**
 * 由租约派生确定性名字。`ref` 取 project/env/task/fence/alias 的摘要：同一员工/任务重新取得租约时
 * fence 变化，得到一套全新的资产名，旧租约的账号、workspace 与样本不会被新租约继承或回收。
 */
export function fixtureIdentity(input: {
  project: string; env: string; taskId: string; alias: string; accountPrefix: string; workspacePrefix: string;
  /** 租约代际；缺省 0，兼容没有 fence 的调用方。 */
  leaseFence?: number;
}): FixtureIdentity {
  const requestedAlias = input.alias;
  const fence = Number.isSafeInteger(input.leaseFence) && (input.leaseFence as number) >= 0 ? input.leaseFence as number : 0;
  const ref = sha256(`${input.project}\n${input.env}\n${input.taskId}\n${fence}\n${requestedAlias}`).slice(0, 8);
  const base = requestedAlias.slice(0, 26);
  const alias = `${FIXTURE_ALIAS_PREFIX}${base}_${ref}`;
  const username = `${input.accountPrefix}${alias.toLowerCase().replaceAll('_', '-')}`;
  // 前缀预留后再生成长度预算，保证任务摘要（ref）永远落在 40 字符以内、不被截掉。
  const room = Math.max(0, 40 - input.workspacePrefix.length - 'test-'.length - ref.length - 1);
  const part = slugPart(base, Math.min(18, room));
  const workspaceSlug = `${input.workspacePrefix}test-${part ? `${part}-` : ''}${ref}`.slice(0, 40);
  return {
    key: `${input.project}/${input.env}/${input.taskId}/${fence}/${alias}`,
    alias, username, workspaceSlug,
    workspaceName: `QA fixture ${alias}`.slice(0, 80),
    requestedAlias,
  };
}

export interface FixtureSample {
  body: string;
  digest: string;
  handle: string;
  records: number;
}

/** 小型合成样本：固定的三条明显虚构记录，内容只由固定骨架与夹具摘要组成。 */
export function fixtureSample(id: FixtureIdentity): FixtureSample {
  const scope = sha256(id.key).slice(0, 12);
  const records = [
    { id: 'fx-1', name: '合成客户甲', email: 'fixture-1@example.invalid', amount: 1200, status: 'active' },
    { id: 'fx-2', name: '合成客户乙', email: 'fixture-2@example.invalid', amount: 0, status: 'pending' },
    { id: 'fx-3', name: '合成客户丙', email: 'fixture-3@example.invalid', amount: 88, status: 'closed' },
  ];
  const body = `${JSON.stringify({
    fixture: { kind: 'synthetic', version: 1, scope, synthetic: true },
    records,
  }, null, 2)}\n`;
  return { body, digest: sha256(body), handle: `fx_${sha256(id.key).slice(0, 16)}`, records: records.length };
}

export function fixtureSamplePath(root: string, id: FixtureIdentity): string {
  const task = id.key.split('/')[2]!.replace(SAFE, '-').slice(0, 64) || 'task';
  return join(root, task, `${id.alias.toLowerCase().replaceAll('_', '-')}.json`);
}

/** 同一份合成样本的 CSV 投影，供 CK CSV 复验；内容仍只来自固定合成记录。 */
export function fixtureSampleCsv(id: FixtureIdentity): string {
  const records = JSON.parse(fixtureSample(id).body).records as Array<Record<string, unknown>>;
  const columns = ['id', 'name', 'email', 'amount', 'status'];
  const cell = (value: unknown) => {
    const raw = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
  };
  return `${columns.join(',')}\n${records.map(record => columns.map(column => cell(record[column])).join(',')).join('\n')}\n`;
}

export interface FixtureRecord {
  taskId: string;
  employeeId: string;
  project: string;
  env: string;
  /** 创建本记录时的租约 fence；新租约（更大 fence）一律视为非本卡资产。 */
  leaseFence: number;
  alias: string;
  username: string;
  workspaceSlug: string;
  workspaceName: string;
  samplePath: string;
  sampleHandle: string;
  sampleDigest: string;
  /** 外部创建已完成；false 表示尚无记录，不据此认领既有资产。 */
  created: { account: boolean; workspace: boolean; sample: boolean };
  /** 已发出的创建意图：只有它存在时，创建中途崩溃留下的同名资产才可被同一租约接续。 */
  intent: { account: boolean; workspace: boolean; sample: boolean };
  /**
   * 写入结果未知：外部调用已经发出，但响应未在期限内返回。再次准备时只按幂等核对，禁止盲重试。
   * 键是阶段名，值为 true 表示该阶段有一笔未确认的写。
   */
  uncertain?: Partial<Record<'account' | 'workspace' | 'sample', true>>;
  status: 'ready' | 'failed' | 'retained';
  updatedAt: string;
}

interface JournalFile { version: 1; fixtures: Record<string, FixtureRecord> }

/**
 * 本机夹具台账。读写都只落在私有目录（目录 0700、文件 0600）；任何解析失败都按“无法判定”处理，
 * 由调用方拒绝删除，而不是把损坏的台账当成空台账。
 */
export class FixtureJournal {
  constructor(readonly path: string) {}

  read(): JournalFile {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as JournalFile;
      if (!parsed || parsed.version !== 1 || typeof parsed.fixtures !== 'object' || parsed.fixtures === null) {
        throw new CompanyError('conflict', `fixture journal ${this.path} 结构不可识别；拒绝认领或删除任何既有资产`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, fixtures: {} };
      if (error instanceof CompanyError) throw error;
      throw new CompanyError('conflict', `fixture journal ${this.path} 不可读；拒绝认领或删除任何既有资产`);
    }
  }

  get(key: string): FixtureRecord | undefined { return this.read().fixtures[key]; }

  put(record: FixtureRecord): void {
    const journal = this.read();
    journal.fixtures[recordKey(record)] = record;
    this.write(journal);
  }

  write(journal: JournalFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* 只读文件系统由上层错误报告 */ }
  }
}

const recordKey = (record: FixtureRecord) =>
  `${record.project}/${record.env}/${record.taskId}/${record.leaseFence}/${record.alias}`;

/** 阶段失败：只携带固定阶段名、耗时与错误码，消息由调用方补充可清理状态。 */
export class FixtureStageError extends CompanyError {
  constructor(readonly stage: FixtureStage, readonly elapsedMs: number, cause: CompanyError, readonly timedOut = false) {
    super(cause.code, cause.message, cause.retryable);
    this.name = 'FixtureStageError';
  }
}

/** 能被安全重试的错误：网络瞬断或上游 5xx；确定性拒绝（invalid/forbidden/conflict/not_found）不再重试。 */
const transientFailure = (error: unknown): boolean => {
  if (!(error instanceof CompanyError)) return false;
  return error.retryable && (error.code === 'upstream_error' || error.code === 'login_failed');
};

export type FixtureStageOutcome<T> =
  | { status: 'ok'; value: T; elapsedMs: number; attempts: number }
  | { status: 'timed_out'; elapsedMs: number; attempts: number; error: FixtureStageError }
  | { status: 'failed'; elapsedMs: number; attempts: number; error: FixtureStageError };

/**
 * 固定次数的阶段执行器：`work()` 本身受预算限制。
 * - 真实挂起：用原生定时器在期限到达时停止等待（不取消已发出的外部写）。
 * - 假时钟：work 自己把 now 推过期限再返回时，完成后的 elapsed 检查仍判为 timed_out。
 * 超时不得等同“未写入”：调用方必须按事实核对并在台账上标记 uncertain，禁止盲重试。
 * 故障预算仍在 OpsBroker 外层。
 */
export async function runFixtureStage<T>(
  stage: FixtureStage,
  work: () => Promise<T>,
  clocks: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<FixtureStageOutcome<T>> {
  const budget = FIXTURE_STAGE_BUDGET_MS[stage];
  const started = clocks.now();
  let attempts = 0;
  let last: unknown;

  for (let attempt = 1; attempt <= FIXTURE_STAGE_ATTEMPTS; attempt++) {
    attempts = attempt;
    if (clocks.now() - started >= budget) break;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = Math.max(1, budget - (clocks.now() - started));
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(
          new CompanyError('upstream_error', `${stage} 阶段超过 ${budget}ms 期限`, true),
          { timedOut: true as const },
        ));
      }, remaining);
    });

    try {
      const value = await Promise.race([work(), deadline]);
      if (timer) clearTimeout(timer);
      const elapsedMs = Math.max(0, Math.round(clocks.now() - started));
      if (elapsedMs >= budget) {
        return {
          status: 'timed_out', elapsedMs, attempts,
          error: new FixtureStageError(stage, elapsedMs,
            new CompanyError('upstream_error', `${stage} 阶段超过 ${budget}ms 期限`, true), true),
        };
      }
      return { status: 'ok', value, elapsedMs, attempts };
    } catch (error) {
      if (timer) clearTimeout(timer);
      last = error;
      const timedOut = !!(error as { timedOut?: boolean }).timedOut;
      if (timedOut) {
        const elapsedMs = Math.max(0, Math.round(clocks.now() - started));
        const cause = error instanceof CompanyError
          ? error
          : new CompanyError('upstream_error', `${stage} 阶段超过 ${budget}ms 期限`, true);
        return {
          status: 'timed_out', elapsedMs, attempts,
          error: new FixtureStageError(stage, elapsedMs, cause, true),
        };
      }
      const elapsed = clocks.now() - started;
      if (!transientFailure(error) || attempt === FIXTURE_STAGE_ATTEMPTS) break;
      if (elapsed + FIXTURE_STAGE_BACKOFF_MS >= budget) break;
      await clocks.sleep(FIXTURE_STAGE_BACKOFF_MS);
    }
  }

  const cause = last instanceof CompanyError
    ? last
    : new CompanyError('upstream_error', `${(last as Error)?.name ?? 'Error'}: ${String((last as Error)?.message ?? last).slice(0, 160)}`, true);
  const elapsedMs = Math.max(0, Math.round(clocks.now() - started));
  return {
    status: 'failed', elapsedMs, attempts,
    error: new FixtureStageError(stage, elapsedMs, cause, false),
  };
}