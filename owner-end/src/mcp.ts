/**
 * 公司 MCP（第一期，只读工具）：云端执行者（先 Devin Cloud）经原生 MCP 调公司工具。
 * 身份是 ma_hono company 租户签发的访问令牌（issuer=cfg.idp.issuer、audience=<origin>/api/mcp、
 * scope 含 company.work）；哪些主体能用、各自允许哪些员工 provider 由 company_meta:mcp_principals
 * 登记（默认拒绝，老板用 mcp.principal.* 管理）。需要任务的工具按任务的 current_employee 绑定员工身份，
 * 再经命令守卫 decide 复用员工策略/停用/保护清单；每次调用（含被拒）写 ops_audit。
 * 传输无状态：每请求新建 McpServer 与 WebStandardStreamableHTTPServerTransport。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { RecordId, type Surreal } from 'surrealdb';
import { audit, decide } from '../../src/command-guard.ts';
import { CompanyError } from '../../src/core-errors.ts';
import { COMPANY_LANDSCAPE } from '../../src/landscape.ts';
import { mcpPrincipalsOf, type McpPrincipal } from '../../src/mcp-principals.ts';
import { clip, redactText } from '../../src/ops/redact.ts';
import { ProjectStore } from '../../src/projects.ts';
import { auditSummary } from './audit.ts';
import { ALGORITHMS, jwksFor } from './auth/jwt.ts';
import type { Sessions } from './db.ts';
import type { Config } from './env.ts';
import { enqueueJob, jobFailure, readJob, waitForJob, type JobRecord } from './jobs.ts';
import { isRecord } from './rows.ts';
import { runOwnerApi } from './commands.ts';

/** 第一期固定工具清单的白名单：company_ops 只允许这几个只读运维命令。 */
export const MCP_OPS_ALLOW = ['ops_origin_status', 'ops_origin_health', 'ops_release_diagnose', 'ops_product_pulse'] as const;

const MAX_BODY_BYTES = 256 * 1024;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BEARER = /^Bearer\s+(\S+)$/i;

/** 已验签的 MCP 令牌声明。 */
export interface McpToken {
  sub: string;
  scopes: string[];
  exp: number;
  clientId?: string;
}

/** 验证 MCP 访问令牌：issuer/audience/算法/签名/过期之外，scope 必须含 company.work，sub 必须非空。 */
export async function verifyMcpToken(
  token: string,
  cfg: Config,
  resource: string,
  keys: JWTVerifyGetKey = jwksFor(cfg.idp.jwksUrl),
): Promise<McpToken> {
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, keys, { issuer: cfg.idp.issuer, audience: resource, algorithms: ALGORITHMS });
    payload = verified.payload;
  } catch {
    throw new CompanyError('unauthorized', '令牌无效或已过期');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new CompanyError('unauthorized', '令牌缺少主体声明');
  }
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/u).filter(Boolean) : [];
  if (!scopes.includes('company.work')) throw new CompanyError('unauthorized', '令牌缺少 company.work scope');
  if (typeof payload.exp !== 'number') throw new CompanyError('unauthorized', '令牌缺少过期声明');
  const act = payload.act as { sub?: unknown } | undefined;
  return {
    sub: payload.sub,
    scopes,
    exp: payload.exp,
    clientId: typeof payload.client_id === 'string' ? payload.client_id
      : typeof act?.sub === 'string' ? act.sub : undefined,
  };
}

export interface McpDeps {
  cfg: Config;
  sessions: Sessions;
  keys?: JWTVerifyGetKey;
  now?: () => Date;
  /** 执行端作业的等待毫秒数；缺省与网关相同（25 秒）。 */
  waitMs?: number;
  fetch?: typeof fetch;
}

/** 本请求的 MCP 受保护资源标识：公开 origin 下的 /api/mcp。 */
export function mcpResourceOf(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/api/mcp`;
}

const metadataUrlOf = (resource: string): string =>
  `${new URL(resource).origin}/api/mcp/.well-known/oauth-protected-resource`;

const unauthorized = (resource: string): Response => Response.json(
  { error: { code: 'unauthorized', message: '需要有效的公司 MCP 令牌' } },
  {
    status: 401,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'www-authenticate': `Bearer resource_metadata="${metadataUrlOf(resource)}"`,
    },
  },
);

function jsonSafe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: { code: 'serialization_error', message: '工具结果无法序列化' } });
  }
}

function toolSuccess(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: jsonSafe(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toolError(error: unknown) {
  const payload = error instanceof CompanyError
    ? { error: { code: error.code, message: clip(redactText(error.message), 200) } }
    : { error: { code: 'internal', message: '工具执行失败' } };
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: jsonSafe(payload) }],
    structuredContent: payload,
  };
}

const forbidden = (reason: string): CompanyError => new CompanyError('forbidden', reason);
const invalid = (reason: string): CompanyError => new CompanyError('invalid', reason);

/** 绑定已知时的拒绝/出错：审计里 actor 记员工（而不是 mcp:<sub>），task 记任务。 */
class McpToolRefusal extends CompanyError {
  readonly actor: string;
  readonly task?: string;
  constructor(code: ConstructorParameters<typeof CompanyError>[0], reason: string, actor: string, task?: string) {
    super(code, reason);
    this.actor = actor;
    this.task = task;
  }
}

/** taskId 输入：接受 task:x 或裸 id。 */
function taskKeyOf(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const id = raw.startsWith('task:') ? raw.slice(5) : raw;
  if (!TASK_ID.test(id)) throw invalid('taskId invalid');
  return id;
}

interface TaskRow extends Record<string, unknown> {
  title?: string;
  state?: string;
  project?: unknown;
  discipline?: string;
  executor_role?: string;
  requirement?: string;
  acceptance_text?: string;
  worktree?: { branch?: string };
  current_employee?: string | null;
  lease_expires_at?: number | null;
}

/** 任务绑定判定（全部满足才放行）：任务存在、current_employee 非空、租约未过期、持有者 provider ∈ 主体 providers。 */
async function bindTask(
  db: Surreal,
  principal: McpPrincipal,
  taskId: string,
  nowSeconds: number,
): Promise<{ task: TaskRow; employee: string }> {
  const task = await db.select<TaskRow>(new RecordId('task', taskId));
  if (!task) throw forbidden('任务不存在');
  const holder = typeof task.current_employee === 'string' ? task.current_employee : '';
  const expiresAt = typeof task.lease_expires_at === 'number' ? task.lease_expires_at : 0;
  if (!holder) throw forbidden('任务没有租约持有者');
  if (!(expiresAt > nowSeconds)) throw new McpToolRefusal('forbidden', '任务租约已过期', holder, taskId);
  const employee = await db.select<{ provider?: unknown }>(new RecordId('employee', holder));
  const provider = typeof employee?.provider === 'string' ? employee.provider : '';
  if (!principal.providers.includes(provider)) throw new McpToolRefusal('forbidden', '这不是本身份的任务', holder, taskId);
  return { task, employee: holder };
}

/** 每请求上下文：验签后的主体、库会话与审计帮手。 */
interface ToolContext {
  db: Surreal;
  deps: McpDeps;
  token: McpToken;
  nowSeconds: number;
}

/** 登记主体：未登记或 enabled=false 即拒绝（令牌有效，工具禁用）；每次调用重读，停用立即生效。 */
async function principalOf(ctx: ToolContext): Promise<McpPrincipal> {
  const principal = (await mcpPrincipalsOf(ctx.db)).find((item) => item.sub === ctx.token.sub);
  if (!principal || !principal.enabled) throw forbidden('该主体没有登记或已停用');
  return principal;
}

/** 记一条 ops_audit（含被拒），reason 前缀 mcp:；审计失败不盖掉原错误。 */
async function auditCall(
  ctx: ToolContext,
  entry: { actor: string; task?: string; command: string; args: unknown; outcome: 'ok' | 'denied' | 'error'; reason?: string; result?: unknown },
): Promise<void> {
  await audit(ctx.db, {
    actorKind: 'agent',
    actor: entry.actor,
    ...(entry.task ? { task: entry.task } : {}),
    command: entry.command,
    args: entry.args,
    outcome: entry.outcome,
    ...(entry.reason ? { reason: `mcp:${entry.reason}` } : {}),
    ...(entry.result !== undefined ? { result: entry.result } : {}),
    summary: auditSummary(entry.command, isRecord(entry.args) ? entry.args : {}),
  }).catch(() => undefined);
}

/** 包装工具实现：统一记审计、统一转 isError；reason 一律 mcp: 前缀。 */
function guard<T extends Record<string, unknown>>(
  ctx: ToolContext,
  name: string,
  run: (args: T) => Promise<{ actor: string; task?: string; value: unknown }>,
) {
  return async (args: T) => {
    try {
      const { actor, task, value } = await run(args);
      await auditCall(ctx, { actor, task, command: name, args, outcome: 'ok', result: value });
      return toolSuccess(value);
    } catch (error) {
      const reason = error instanceof CompanyError ? error.message : '工具执行失败';
      const refusal = error instanceof McpToolRefusal ? error : undefined;
      await auditCall(ctx, {
        actor: refusal?.actor ?? `mcp:${ctx.token.sub}`,
        task: refusal?.task,
        command: name, args,
        outcome: error instanceof CompanyError && error.code === 'forbidden' ? 'denied' : 'error',
        reason,
      });
      return toolError(error);
    }
  };
}

const keyOfRecord = (value: unknown): string | undefined => {
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === 'string') return id;
    if (id && typeof id === 'object' && 'id' in id) {
      const inner = (id as { id: unknown }).id;
      return typeof inner === 'string' ? inner : inner != null ? String(inner) : undefined;
    }
  }
  return undefined;
};

const textCap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value ? clip(redactText(value), max) : undefined;

async function latestEvidence(db: Surreal, taskId: string, actions: readonly string[]): Promise<unknown> {
  const [rows] = await db.query<[Array<{ evidence?: unknown; action?: string; at?: unknown }>]>(
    'SELECT evidence, action, at FROM audit WHERE task = $task AND action IN $actions ORDER BY at DESC LIMIT 1;',
    { task: new RecordId('task', taskId), actions: [...actions] });
  return rows?.[0]?.evidence;
}

/** 把项目档案投影成对外安全形状：不含 repoPath 本机路径与任何 secrets。 */
function projectProfileOf(view: Awaited<ReturnType<ProjectStore['get']>>) {
  if (!view) return undefined;
  return {
    id: view.id,
    name: view.name,
    defaultBranch: view.defaultBranch,
    release: view.release,
    rollback: view.rollback,
    redLines: view.redLines,
    services: view.services,
    runbooks: view.runbooks,
    envs: view.envs.map((env) => ({ name: env.name, url: env.url, healthUrl: env.healthUrl, verify: env.verify })),
  };
}

async function taskContextValue(ctx: ToolContext, task: TaskRow, taskId: string): Promise<unknown> {
  const projectId = keyOfRecord(task.project);
  const [lastReturn, lastSubmit] = await Promise.all([
    latestEvidence(ctx.db, taskId, ['return']),
    latestEvidence(ctx.db, taskId, ['submit', 'owner_submit']),
  ]);
  const projectProfile = projectId ? projectProfileOf(await new ProjectStore(ctx.db).get(projectId)) : undefined;
  const repo = projectId ? COMPANY_LANDSCAPE.repos.find((item) => item.project === projectId) : undefined;
  const evidenceText = (value: unknown): unknown =>
    typeof value === 'string' ? clip(redactText(value), 4000) : value;
  const value: Record<string, unknown> = {
    taskId,
    title: textCap(task.title, 2000),
    state: textCap(task.state, 2000),
    ...(projectId ? { project: projectId } : {}),
    ...(textCap(task.discipline, 2000) ? { discipline: textCap(task.discipline, 2000) } : {}),
    ...(textCap(task.executor_role, 2000) ? { executorRole: textCap(task.executor_role, 2000) } : {}),
    ...(textCap(task.requirement, 8000) ? { requirement: textCap(task.requirement, 8000) } : {}),
    ...(textCap(task.acceptance_text, 8000) ?? textCap(task.requirement, 8000)
      ? { acceptance: textCap(task.acceptance_text, 8000) ?? textCap(task.requirement, 8000) } : {}),
    ...(task.worktree && typeof task.worktree === 'object' && typeof task.worktree.branch === 'string'
      ? { branch: task.worktree.branch } : {}),
    ...(repo ? { repo: { id: repo.id, github: repo.github } } : {}),
    ...(lastReturn !== undefined && lastReturn !== null ? { lastReturn: evidenceText(lastReturn) } : {}),
    ...(lastSubmit !== undefined && lastSubmit !== null ? { lastSubmit: evidenceText(lastSubmit) } : {}),
    ...(projectProfile ? { projectProfile } : {}),
  };
  // 整体 ≤64KB：超出时截掉最长的字符串字段并标 truncated。
  let serialized = jsonSafe(value);
  if (serialized.length <= 64 * 1024) return value;
  let longestKey = '';
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.length > (value[longestKey]?.toString().length ?? -1)) longestKey = key;
  }
  if (longestKey) {
    value[longestKey] = clip(String(value[longestKey]), 2000);
    value.truncated = true;
    serialized = jsonSafe(value);
  }
  if (serialized.length > 64 * 1024) {
    return { truncated: true, taskId, title: value.title, state: value.state, project: value.project };
  }
  return value;
}

function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'sck-company', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: '公司只读工具。task_context / company_ops / company_job 需要任务租约绑定：任务必须派给你（员工 provider 在你主体的 providers 内）且租约未过期。',
    },
  );

  server.registerTool(
    'company_landscape',
    {
      title: '公司服务全景',
      description: '仓库、服务、主机、部署与回滚登记表，以及最近一次实机核对（host 过滤只看该主机）。',
      inputSchema: z.object({ host: z.string().optional(), repo: z.string().optional() }),
    },
    guard<Record<string, unknown>>(ctx, 'mcp.company_landscape', async (args) => {
      await principalOf(ctx);
      const value = await runOwnerApi(ctx.db, 'landscape.get', args, 'mcp');
      return { actor: `mcp:${ctx.token.sub}`, value };
    }),
  );

  server.registerTool(
    'task_current',
    {
      title: '当前在租任务',
      description: '列出当前租约持有者实例 provider 属于你主体 providers 且租约未过期的任务（最多 20 条）。',
      inputSchema: z.object({}),
    },
    guard<Record<string, unknown>>(ctx, 'mcp.task_current', async () => {
      const principal = await principalOf(ctx);
      const [tasks] = await ctx.db.query<[TaskRow[]]>(
        'SELECT id, title, state, project, current_employee, lease_expires_at FROM task WHERE current_employee != NONE AND lease_expires_at > $now ORDER BY lease_expires_at ASC LIMIT 100;',
        { now: ctx.nowSeconds });
      const holders = [...new Set((tasks ?? []).map((t) => t.current_employee).filter((h): h is string => typeof h === 'string' && h.length > 0))];
      const [employees] = await ctx.db.query<[Array<{ id: unknown; provider?: unknown }>]>(
        'SELECT id, provider FROM employee WHERE id IN $ids;',
        { ids: holders.map((holder) => new RecordId('employee', holder)) });
      const providers = new Map<string, string>();
      for (const row of employees ?? []) {
        const id = keyOfRecord(row.id) ?? keyOfRecord(row);
        if (id && typeof row.provider === 'string') providers.set(id, row.provider);
      }
      const value = {
        tasks: (tasks ?? [])
          .filter((task) => {
            const provider = providers.get(String(task.current_employee));
            return provider !== undefined && principal.providers.includes(provider);
          })
          .slice(0, 20)
          .map((task) => ({
            taskId: keyOfRecord(task.id) ?? String(task.id ?? ''),
            title: task.title,
            state: task.state,
            project: keyOfRecord(task.project),
            leaseExpiresAt: task.lease_expires_at,
          })),
      };
      return { actor: `mcp:${ctx.token.sub}`, value };
    }),
  );

  server.registerTool(
    'task_context',
    {
      title: '任务上下文',
      description: '任务投影：需求、验收、分支、项目档案（不含本机路径与密钥）、最近一次退回与提交证据。需任务绑定。',
      inputSchema: z.object({ taskId: z.string() }),
    },
    guard<Record<string, unknown>>(ctx, 'mcp.task_context', async (args) => {
      const principal = await principalOf(ctx);
      const taskId = taskKeyOf(args.taskId);
      const { task, employee } = await bindTask(ctx.db, principal, taskId, ctx.nowSeconds);
      const decision = await decide(ctx.db, {
        actorKind: 'agent', actor: employee, task: taskId, command: 'mcp.task_context', now: ctx.nowSeconds,
      });
      if (!decision.allow) throw new McpToolRefusal('forbidden', decision.reason, employee, taskId);
      return { actor: employee, task: taskId, value: await taskContextValue(ctx, task, taskId) };
    }),
  );

  server.registerTool(
    'company_ops',
    {
      title: '公司只读运维命令',
      description: `把白名单内的只读运维命令排队为执行端作业（${MCP_OPS_ALLOW.join('、')}）。需任务绑定。`,
      inputSchema: z.object({ taskId: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
    },
    guard<Record<string, unknown>>(ctx, 'mcp.company_ops', async (args) => {
      const principal = await principalOf(ctx);
      const taskId = taskKeyOf(args.taskId);
      const tool = typeof args.tool === 'string' ? args.tool : '';
      if (!(MCP_OPS_ALLOW as readonly string[]).includes(tool)) throw forbidden('该工具不在公司 MCP 白名单内');
      const { employee } = await bindTask(ctx.db, principal, taskId, ctx.nowSeconds);
      const decision = await decide(ctx.db, {
        actorKind: 'agent', actor: employee, task: taskId, command: tool, now: ctx.nowSeconds,
      });
      if (!decision.allow) throw new McpToolRefusal('forbidden', decision.reason, employee, taskId);
      const input = isRecord(args.args) ? args.args : {};
      const jobId = await enqueueJob(ctx.db, {
        command: tool, input, actorKind: 'agent', actor: employee, task: taskId,
      }, ctx.deps.now?.());
      const outcome = await waitForJob(ctx.db, jobId, ctx.deps.waitMs);
      if (outcome.state === 'error') {
        const failure = jobFailure(outcome);
        throw new McpToolRefusal(failure.code, failure.message, employee, taskId);
      }
      return { actor: employee, task: taskId, value: outcome.state === 'pending' ? { pending: true, jobId } : outcome.result };
    }),
  );

  server.registerTool(
    'company_job',
    {
      title: '执行端作业详情',
      description: '查本身份（作业 actor 的 provider 在你主体 providers 内）发起的执行端作业。',
      inputSchema: z.object({ jobId: z.string() }),
    },
    guard<Record<string, unknown>>(ctx, 'mcp.company_job', async (args) => {
      const principal = await principalOf(ctx);
      const jobId = typeof args.jobId === 'string' ? args.jobId : '';
      if (!jobId || jobId.length > 200) throw invalid('jobId invalid');
      const job: JobRecord | undefined = await readJob(ctx.db, jobId);
      if (!job) throw forbidden('查不到该作业');
      const holder = typeof job.actor === 'string' ? job.actor : '';
      let allowed = false;
      if (job.actor_kind === 'agent' && holder) {
        const employee = await ctx.db.select<{ provider?: unknown }>(new RecordId('employee', holder));
        const provider = typeof employee?.provider === 'string' ? employee.provider : '';
        allowed = principal.providers.includes(provider);
      }
      if (!allowed) {
        const [leased] = await ctx.db.query<[Array<{ current_employee?: string }>]>(
          'SELECT current_employee FROM task WHERE current_employee = $actor AND lease_expires_at > $now LIMIT 1;',
          { actor: holder, now: ctx.nowSeconds });
        allowed = leased?.[0]?.current_employee === holder && holder.length > 0;
      }
      if (!allowed) throw forbidden('只能查看本身份任务员工发起的作业');
      return { actor: holder || `mcp:${ctx.token.sub}`, task: undefined, value: job };
    }),
  );

  return server;
}

/**
 * /api/mcp 的请求处理器：先验签（401 带 resource_metadata 挑战），再无状态跑 SDK 传输。
 * 主体登记与任务绑定在每个工具内判定，被拒调用写 ops_audit。
 */
export async function handleCompanyMcp(request: Request, deps: McpDeps): Promise<Response> {
  const resource = mcpResourceOf(request.url);
  const header = request.headers.get('authorization');
  const match = header === null ? null : BEARER.exec(header.trim());
  if (!match) return unauthorized(resource);
  let token: McpToken;
  try {
    token = await verifyMcpToken(match[1]!, deps.cfg, resource, deps.keys);
  } catch {
    return unauthorized(resource);
  }

  // 请求体上限沿用 256KB：先量再交给 SDK 传输。
  const body = await request.clone().arrayBuffer().catch(() => null);
  if (body !== null && body.byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: { code: 'invalid', message: '请求体过大' } }, { status: 400 });
  }

  const db = await deps.sessions.gateway();
  const nowSeconds = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  try {
    const server = buildServer({ db, deps, token, nowSeconds });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  } finally {
    await db.close().catch(() => undefined);
  }
}
