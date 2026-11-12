import { ITERATION_COMMANDS, iterationCommand } from './iteration-commands.ts';
import { isReadOnlyCommand as isReadOnly } from './command-effects.ts';
/**
 * 命令分流（POST /api/cmd）。按调用方身份决定命令怎么执行；写操作与被拒的调用都写 ops_audit（只存摘要，不存原文）。
 * - 老板（owner）：令牌直接连库（$access='owner'）。执行端命令（isRunnerCommand）排队到 ops_job，最多等 25 秒，超时返回 pending；
 *   其余在 Worker 内执行：身份、员工与权限、译文、数据库、Cloudflare 命令，其它交给 src/owner-api.ts。
 * - 员工（agent）：先过 command-guard.decide（停用、写死仅老板、保护命令、允许与禁止、当前任务的有效租约），
 *   再过按目标的硬锁（owner-locks.ts）与员工拒绝清单；通过后执行端命令以员工身份排队，其它用网关令牌执行。
 *   db.read 用查看者令牌。员工的每次调用（含被拒）都写审计。
 * - 运行器与定时任务（runner、automation）：一律拒绝老板命令。
 */
import type { Surreal } from 'surrealdb';
import { audit, decide, type AuditEntry } from '../../src/command-guard.ts';
import { CompanyError } from '../../src/core-errors.ts';
import type { CompanyDatabase } from '../../src/database.ts';
import { OutboundMessageStore, type OutboundMessage } from '../../src/outbound-messages.ts';
import { ownerApi, RUNNER_ONLY_COMMANDS, type OwnerApiContext } from '../../src/owner-api.ts';
import { OwnerDesk } from '../../src/owner.ts';
import { Workforce } from '../../src/workforce.ts';
import { auditSummary, listAudit } from './audit.ts';
import { commandCatalogOf } from './catalog.ts';
import type { Caller } from './auth/caller.ts';
import { dbRead, dbWrite } from './db-commands.ts';
import { withSession, type Sessions } from './db.ts';
import type { Config } from './env.ts';
import { cloudflareApi } from './cf.ts';
import { identityCommand, IDENTITY_COMMANDS } from './idp-commands.ts';
import { enqueueJob, jobDetail, jobFailure, jobOwnedBy, listJobs, PendingJob, waitForJob } from './jobs.ts';
import { OWNER_ONLY_FOR_AGENTS, hardTargetOwnerOnly } from './owner-locks.ts';
import { POLICY_COMMANDS, policyCommand } from './policy-commands.ts';
import { LANG_CODE, ownerLangOf } from '../../src/owner-lang.ts';
import { translateChecked, translateMessage, translatePreview, translationFresh, TRANSLATE_COMMANDS } from './messages.ts';
import { isRecord, textOf } from './rows.ts';
import { BACKEND_OWNER_COMMANDS } from './command-routing.ts';
export { BACKEND_OWNER_COMMANDS };

export type Input = Record<string, unknown>;

type OwnerCaller = Extract<Caller, { kind: 'owner' }>;
type AgentCaller = Extract<Caller, { kind: 'agent' }>;
type SystemCaller = Extract<Caller, { kind: 'system' }>;

/** 分派命令需要的依赖。cfg 缺省表示没有服务端配置（浏览器直连），只能执行不读配置、不调外部服务的命令。 */
export interface DispatchDeps {
  cfg?: Config;
  fetch?: typeof fetch;
  now?: () => Date;
  /** 执行端作业的等待毫秒数；缺省 25 秒。 */
  waitMs?: number;
}

/** 命令执行需要的依赖。fetch 与 now 只在测试里替换。 */
export interface GatewayDeps {
  cfg: Config;
  sessions: Sessions;
  fetch?: typeof fetch;
  now?: () => Date;
  /** 执行端作业的等待毫秒数；缺省 25 秒。 */
  waitMs?: number;
}

const COMMAND_NAME = /^[a-z][a-z0-9_.-]{0,119}$/;

/**
 * 执行端执行的命令（contract：RUNNER_ONLY_COMMANDS、全部 ops_*、host.exec）：
 * 写 ops_job 排队，网关最多等 25 秒，超时返回 pending。
 */
export function isRunnerCommand(command: string): boolean {
  return RUNNER_ONLY_COMMANDS.has(command) || command.startsWith('ops_') || command === 'host.exec';
}

const OWNER_ONLY_REASON = '该命令只能由老板调用';


function configOf(deps: DispatchDeps): Config {
  if (!deps.cfg) throw new CompanyError('unavailable', '该命令需要服务端执行');
  return deps.cfg;
}


const reasonOf = (error: unknown): string => error instanceof CompanyError ? error.message : '服务暂时出错';

/** 命令参数里的任务号（task:x 与 x 同义）；不是字符串的无法与租约任务核对，视为不符。 */

/** 读取 /api/cmd 的请求体：必须是 {command, input} 形状，input 缺省为空对象。 */
export function parseCommandBody(body: unknown): { command: string; input: Input } {
  if (!isRecord(body)) throw new CompanyError('invalid', '请求体必须是 JSON 对象');
  const command = body.command;
  if (typeof command !== 'string' || !COMMAND_NAME.test(command)) throw new CompanyError('invalid', '命令名不合法');
  const input = body.input === undefined ? {} : body.input;
  if (!isRecord(input)) throw new CompanyError('invalid', 'input 必须是对象');
  return { command, input };
}

/** 只放行老板。其它身份返回 forbidden（页面据此显示“当前账号不是老板”）。 */
export function requireOwner(caller: Caller): OwnerCaller {
  if (caller.kind !== 'owner') throw new CompanyError('forbidden', '当前账号不是老板');
  return caller;
}

/**
 * 网关里没有执行端宿主，RUNNER_ONLY_COMMANDS 先在 runCommand 里排队，不会走到 core。
 * 其余老板命令只用到数据库会话，所以用只带 db 的适配对象代替 CompanyDatabase。
 */
const NO_CORE = {} as OwnerApiContext['core'];

/** 老板接口（src/owner-api.ts）在 Worker 里的上下文。 */
export function ownerContextOf(db: Surreal): OwnerApiContext {
  const database = { db } as unknown as CompanyDatabase;
  return {
    db: database,
    core: NO_CORE,
    owner: new OwnerDesk(database),
    workforce: new Workforce(database),
    messages: new OutboundMessageStore(db),
    opsRepo: '',
  };
}

function runOwnerApi(db: Surreal, command: string, input: Input, via = 'web'): Promise<unknown> {
  return ownerApi(ownerContextOf(db), { ...input, command }, via);
}

/** 员工令牌的 sub 是 ma_hono 的 agent 用户 id；对应的员工见 agent_identity。 */
export async function employeeOfIdentity(db: Surreal, userId: string): Promise<string | undefined> {
  const [rows] = await db.query<[Array<{ employee?: unknown }>]>(
    'SELECT employee FROM agent_identity WHERE idp_user = $user LIMIT 1;', { user: userId });
  const employee = rows?.[0]?.employee;
  return typeof employee === 'string' && employee ? employee : undefined;
}

/** 调用入口：按身份分流。 */
export async function runCommand(deps: GatewayDeps, caller: Caller, command: string, input: Input): Promise<unknown> {
  if (caller.kind === 'owner') return ownerCall(deps, caller, command, input);
  if (caller.kind === 'agent') return agentCall(deps, caller, command, input);
  return systemCall(deps, caller, command, input);
}

type AuditBase = Pick<AuditEntry, 'actorKind' | 'actor' | 'task' | 'command' | 'args'>;

/** 命令的调用方：老板（网页）或员工（经网关，带任务绑定）。执行端作业与核心写入的标签据此区分。 */
interface Who {
  actorKind: 'owner' | 'agent';
  actor: string;
  task?: string;
  via: 'web' | 'agent';
}

/** 写操作的审计：执行后记一条（成功、已排队或出错）。被拒与出错时保留原来的错误。 */
async function audited<T>(db: Surreal, base: AuditBase, run: () => Promise<T>): Promise<T> {
  const summary = auditSummary(base.command, isRecord(base.args) ? base.args : {});
  let result: T;
  try {
    result = await run();
  } catch (error) {
    if (error instanceof PendingJob) {
      await audit(db, { ...base, outcome: 'ok', reason: `已排队：${error.jobId}`, summary });
    } else {
      await audit(db, { ...base, outcome: 'error', reason: reasonOf(error), summary }).catch(() => undefined);
    }
    throw error;
  }
  await audit(db, { ...base, outcome: 'ok', result, summary });
  return result;
}

async function ownerCall(deps: GatewayDeps, caller: OwnerCaller, command: string, input: Input): Promise<unknown> {
  return withSession(await deps.sessions.owner(caller.token.token), (db) => runOwnerCommandOn(deps, db, caller.sub, command, input));
}

/** 老板命令在给定的老板连接上执行（不关闭连接）。服务端与浏览器直连共用；写命令照常记审计。 */
export function runOwnerCommandOn(deps: DispatchDeps, db: Surreal, actor: string, command: string, input: Input): Promise<unknown> {
  if (!deps.cfg && BACKEND_OWNER_COMMANDS.has(command)) return Promise.reject(new CompanyError('unavailable', '该命令需要服务端执行'));
  const who: Who = { actorKind: 'owner', actor, via: 'web' };
  const run = () => dispatch(deps, db, who, command, input);
  if (isReadOnly(command)) return run();
  return audited(db, { actorKind: 'owner', actor, command, args: input }, run);
}

/** 按命令分派。老板与员工共用，差别只在 who：执行端作业的身份与任务、核心写入的标签。 */
async function dispatch(deps: DispatchDeps, db: Surreal, who: Who, command: string, input: Input): Promise<unknown> {
  const cfg = () => configOf(deps);
  if (ITERATION_COMMANDS.has(command)) {
    if (who.actorKind !== 'owner') throw new CompanyError('forbidden', '需求决策只能由老板执行');
    return iterationCommand(db, command, input, who.actor);
  }
  if (isRunnerCommand(command)) return queueJob(deps, db, who, command, input);
  if (IDENTITY_COMMANDS.has(command)) return identityCommand(cfg(), db, command, input, deps.fetch);
  if (POLICY_COMMANDS.has(command)) return policyCommand(db, command, input, who.actor, cfg().locks);
  if (TRANSLATE_COMMANDS.has(command)) {
    if (command === 'translate.preview') return translatePreview(cfg(), input, deps.fetch);
    return translateMessage(new OutboundMessageStore(db), cfg(), input, who.actor, deps.fetch);
  }
  switch (command) {
    case 'db.read': return dbRead(db, input);
    case 'db.write': return dbWrite(db, input);
    case 'cf.api': return cloudflareApi(cfg(), { method: String(input.method ?? ''), path: String(input.path ?? ''), body: input.body }, deps.fetch);
    case 'ops.job.list': return { jobs: await listJobs(db, input) };
    case 'ops.job.get': return { job: await jobDetail(db, textOf(input.id, 'id', 200)) };
    case 'audit.list': return listAudit(db, input);
    case 'cmd.catalog': return commandCatalogOf(db, who.actorKind === 'agent' ? { owner: false, employee: who.actor } : { owner: true });
    case 'owner.settings.get': return { lang: await ownerLangOf(db) };
    case 'owner.settings.set': {
      // 老板常用语言：员工回报译成这种语言；职能语言与之相同的消息不翻译。写死仅老板（HARD_OWNER_ONLY 的 owner.settings.*）。
      if (who.actorKind !== 'owner') throw new CompanyError('forbidden', '只有老板可以修改老板设置');
      const lang = typeof input.lang === 'string' ? input.lang.trim() : '';
      if (!LANG_CODE.test(lang)) throw new CompanyError('invalid', 'lang invalid');
      await db.query('UPSERT company_meta:config SET owner_lang = $lang;', { lang });
      return { lang };
    }
    case 'message.edit':
    case 'message.edit_rendered': return translateSaved(deps, db, await runOwnerApi(db, command, input, who.via), who.actor);
    case 'message.release':
    case 'message.send': return release(deps, db, command, input, who);
    default: return runOwnerApi(db, command, input, who.via);
  }
}

/**
 * 执行端命令：排队到 ops_job（员工的作业带员工与任务，执行端据此核对租约），最多等 25 秒。
 * 完成返回结果，失败转为对应错误，超时返回 pending（202，附任务号）。
 */
async function queueJob(deps: DispatchDeps, db: Surreal, who: Who, command: string, input: Input): Promise<unknown> {
  const jobId = await enqueueJob(db, { command, input, actorKind: who.actorKind, actor: who.actor, task: who.task }, deps.now?.());
  const outcome = await waitForJob(db, jobId, deps.waitMs);
  if (outcome.state === 'done') return outcome.result;
  if (outcome.state === 'error') throw jobFailure(outcome);
  throw new PendingJob(jobId);
}

/**
 * 原文已保存。消息选了语言的，立即补译；补译失败不回滚原文，返回里带 translationPending，
 * 由定时任务稍后补上（见 cron.ts）。
 */
async function translateSaved(deps: DispatchDeps, db: Surreal, saved: unknown, actor: string): Promise<unknown> {
  const message = saved as OutboundMessage;
  if (!message.lang) return message;
  try {
    const translated = await translateChecked(configOf(deps), message.body, message.lang, deps.fetch);
    return await new OutboundMessageStore(db).setTranslation(message.id, message.lang, translated, message.body, actor);
  } catch (error) {
    return { ...message, translationPending: reasonOf(error) };
  }
}

/** 放行（message.release / message.send）：选了语言而译文未就绪的，先译好再放行；译文失败则不放行。 */
async function release(deps: DispatchDeps, db: Surreal, command: string, input: Input, who: Who): Promise<unknown> {
  const messageId = textOf(input.messageId, 'messageId', 200);
  const store = new OutboundMessageStore(db);
  const message = await store.get(messageId);
  if (message && message.state !== 'sent' && message.lang && !translationFresh(message)) {
    const translated = await translateChecked(configOf(deps), message.body, message.lang, deps.fetch);
    await store.setTranslation(message.id, message.lang, translated, message.body, who.actor);
  }
  return runOwnerApi(db, command, { ...input, messageId }, who.via);
}

async function agentCall(deps: GatewayDeps, caller: AgentCaller, command: string, input: Input): Promise<unknown> {
  const now = deps.now?.() ?? new Date();
  return withSession(await deps.sessions.gateway(), async (db) => {
    const employee = await employeeOfIdentity(db, caller.sub);
    const base: AuditBase = { actorKind: 'agent', actor: employee ?? caller.sub, task: caller.task, command, args: input };
    const refuse = async (reason: string): Promise<never> => {
      await audit(db, { ...base, outcome: 'denied', reason, summary: auditSummary(command, input) });
      throw new CompanyError('forbidden', reason);
    };
    if (!employee) return refuse('该令牌没有登记的员工身份');
    const decision = await decide(db, { actorKind: 'agent', actor: employee, task: caller.task, command, now: Math.floor(now.getTime() / 1000) });
    if (!decision.allow) return refuse(decision.reason);
    // 老板定：员工持有任意任务租约时即可操作老板端全部命令（包括别的任务与消息），限制靠“仅老板”保护清单与员工策略。
    const locked = hardTargetOwnerOnly(command, input, deps.cfg.locks);
    if (locked) return refuse(locked);
    if (OWNER_ONLY_FOR_AGENTS.includes(command)) return refuse(OWNER_ONLY_REASON);
    if (command === 'ops.job.get' && !(await jobOwnedBy(db, input.id, employee))) return refuse('只能查看本员工发起的作业');
    const who: Who = { actorKind: 'agent', actor: employee, task: caller.task, via: 'agent' };
    // db.read 走查看者令牌（只读），其它命令按 dispatch 分派：执行端命令排队，其余用网关令牌。
    const run = async () => (command === 'db.read'
      ? withSession(await deps.sessions.viewer(), (viewer) => dbRead(viewer, input))
      : dispatch(deps, db, who, command, input));
    return audited(db, base, run);
  });
}

/** 运行器与定时任务不能调用老板命令；它们的拒绝也记审计。网关、查看者、迁移的令牌不应出现在这里，直接拒绝。 */
async function systemCall(deps: GatewayDeps, caller: SystemCaller, command: string, input: Input): Promise<never> {
  if (caller.ac === 'runner' || caller.ac === 'automation') {
    const actorKind = caller.ac === 'runner' ? 'runner' : 'automation';
    await withSession(await deps.sessions.gateway(), (db) => audit(db, {
      actorKind, actor: caller.sub, command, args: input, outcome: 'denied', reason: '运行器与定时任务不能调用老板命令',
      summary: auditSummary(command, input),
    })).catch(() => undefined);
  }
  throw new CompanyError('forbidden', '该身份不能调用老板命令');
}
