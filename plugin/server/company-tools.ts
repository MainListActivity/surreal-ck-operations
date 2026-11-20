// 本机 Paseo 员工会话注入的公司工具：与云端公司 MCP 同名同参数（共 7 个，本机没有 company_job——
// 本机运维调用经 sidecar 同步返回）。身份来自 Paseo daemon 的 agentId（context.agent.id），
// 经 SidecarPool.callForAgent 走与 `sck call` 完全相同的 dispatch：租约、凭证、熔断一律照旧，
// 工具只是薄适配，不绕过任何判定。本机不加白名单/次数预算（本机员工经 sck 本就可调这些工具）。
//
// Paseo 0.16.2 的 SDK 才有 tools 类型；插件锁定 0.10.1，不升级依赖——这里的结构类型照抄
// 0.16.2 的 AgentToolDefinition/Context/Result 形状（dist/server/agent-tools.d.ts），
// 运行时字段兼容即可。
import { z } from "zod";
import { redactText, clip } from "./vendor/src/ops/redact.ts";

/** 0.16.2 AgentToolContext 的本地结构版（只声明用到的字段）。 */
export interface LocalAgentToolContext {
  agent: { id: string; provider: string; cwd: string };
  paseo: unknown;
  signal: AbortSignal;
}

/** 0.16.2 AgentToolResult 的本地结构版。 */
export interface LocalAgentToolResult {
  text?: string;
  structuredContent?: unknown;
  isError?: boolean;
}

/** 0.16.2 AgentToolDefinition 的本地结构版。 */
export interface LocalAgentTool {
  name: string;
  title?: string;
  description: string;
  input: z.ZodType;
  execute(input: unknown, context: LocalAgentToolContext): LocalAgentToolResult | Promise<LocalAgentToolResult>;
}

/** sidecar 暴露给插件的三件能力（SidecarPool 的结构子集）。 */
export interface CompanySidecarFace {
  callForAgent(agentId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  leaseForAgent(agentId: string): { employee: string; taskId: string; phase: 'doing' | 'review'; leaseExpiresAt?: number } | undefined;
  capabilityTools(): string[];
}

export interface CompanyToolDeps {
  sidecar: () => Promise<CompanySidecarFace>;
  /** 复用插件服务 `sck owner landscape.get` 的现有路径（ownerApi 的 landscape.get 分支 + 公司库会话）。 */
  landscape: (args: { host?: string; repo?: string }) => Promise<unknown>;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PR_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

const ok = (value: unknown): LocalAgentToolResult => ({ text: JSON.stringify(value), structuredContent: value });
const fail = (code: string, message: string): LocalAgentToolResult => {
  const error = { code, message: clip(redactText(message), 500) };
  return { isError: true, text: JSON.stringify({ error }), structuredContent: { error } };
};
/** CommResponse 的 error 形如 "code: message"；没有冒号时整体当 message。 */
const fromRelay = (res: { ok: boolean; data?: unknown; error?: string }): LocalAgentToolResult => {
  if (res.ok) return ok(res.data);
  const error = res.error ?? 'error: 未知错误';
  const colon = error.indexOf(':');
  const code = colon > 0 ? error.slice(0, colon).trim() : 'error';
  return fail(code, colon > 0 ? error.slice(colon + 1).trim() : error);
};

/** taskId 归一化（接受 task:x 或 x）+ 租约绑定：必须等于该会话当前在租任务。 */
const bindTask = async (deps: CompanyToolDeps, agentId: string, taskIdArg: unknown): Promise<{ taskId: string; lease: NonNullable<ReturnType<CompanySidecarFace['leaseForAgent']>> } | LocalAgentToolResult> => {
  const raw = typeof taskIdArg === 'string' ? taskIdArg.trim() : '';
  const taskId = raw.startsWith('task:') ? raw.slice(5) : raw;
  if (!TASK_ID.test(taskId)) return fail('invalid', 'taskId invalid');
  const sidecar = await deps.sidecar();
  const lease = sidecar.leaseForAgent(agentId);
  if (!lease) return fail('forbidden', '当前没有在租任务');
  if (lease.taskId !== taskId) return fail('forbidden', 'taskId 不是你当前在租的任务');
  return { taskId, lease };
};

const text = (value: unknown, name: string, min: number, max: number): string => {
  const t = typeof value === 'string' ? value.trim() : '';
  if (t.length < min || t.length > max) throw Object.assign(new Error(`${name} 需要 ${min}..${max} 字符`), { code: 'invalid' });
  return t;
};

export function companyAgentTools(deps: CompanyToolDeps): LocalAgentTool[] {
  const call = async (context: LocalAgentToolContext, tool: string, args: Record<string, unknown>): Promise<LocalAgentToolResult> => {
    const sidecar = await deps.sidecar();
    return fromRelay(await sidecar.callForAgent(context.agent.id, tool, args));
  };
  /** 绑定失败直接返回错误结果；绑定成功跑 body。 */
  const bound = async (context: LocalAgentToolContext, args: Record<string, unknown>,
    body: (taskId: string, lease: NonNullable<ReturnType<CompanySidecarFace['leaseForAgent']>>) => Promise<LocalAgentToolResult>): Promise<LocalAgentToolResult> => {
    try {
      const b = await bindTask(deps, context.agent.id, args.taskId);
      if (!('lease' in b)) return b;
      return await body(b.taskId, b.lease);
    } catch (error) {
      return fail((error as { code?: string }).code ?? 'error', (error as Error).message);
    }
  };

  const tools: LocalAgentTool[] = [
    {
      name: 'company_landscape',
      description: '查公司服务全景：有哪些仓库、每个仓库部署成哪些服务、跑在哪台主机、怎么部署和回滚（含最近一次实机核对）。可选 host/repo 过滤。无需任务绑定。',
      input: z.object({ host: z.string().optional(), repo: z.string().optional() }),
      execute: async (input) => {
        try { return ok(await deps.landscape(input as { host?: string; repo?: string })); }
        catch (error) { return fail((error as { code?: string }).code ?? 'error', (error as Error).message); }
      },
    },
    {
      name: 'task_current',
      description: '你当前在租的公司任务（taskId 与阶段 doing/review）；没有租约返回空清单。无需参数。',
      input: z.object({}),
      execute: async (_input, context) => {
        try {
          const lease = (await deps.sidecar()).leaseForAgent(context.agent.id);
          return ok({ tasks: lease ? [{ taskId: lease.taskId, phase: lease.phase, leaseExpiresAt: lease.leaseExpiresAt }] : [] });
        } catch (error) { return fail((error as { code?: string }).code ?? 'error', (error as Error).message); }
      },
    },
    {
      name: 'task_context',
      description: '读你当前在租任务的全貌（需求、验收、历史等）。taskId 必须是当前在租任务（可用 task: 前缀）。',
      input: z.object({ taskId: z.string() }),
      execute: async (input, context) => bound(context, input as Record<string, unknown>, () => call(context, 'get_context', {})),
    },
    {
      name: 'company_ops',
      description: '调本机运维/媒体/浏览器/同步能力工具（ops_*、media_*、sync_* 等，作用于你当前租约任务）。tool 必须是能力工具名；其余能力用 sck list 查看。',
      input: z.object({ taskId: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
      execute: async (input, context) => {
        const args = input as { taskId?: unknown; tool?: unknown; args?: Record<string, unknown> };
        const sidecar = await deps.sidecar();
        if (typeof args.tool !== 'string' || !sidecar.capabilityTools().includes(args.tool)) {
          return fail('forbidden', '不是运维能力工具；其余能力用 sck list 查看');
        }
        return bound(context, args, () => call(context, args.tool as string, args.args ?? {}));
      },
    },
    {
      name: 'task_submit',
      description: '执行阶段交卷：summary 写清完成情况、验证结果和产物位置（20..8000 字）；可选 PR 链接与完整 40 位提交 sha。taskId 必须是当前在租任务。',
      input: z.object({ taskId: z.string(), summary: z.string(), pr: z.string().optional(), sha: z.string().optional() }),
      execute: async (input, context) => {
        const args = input as { taskId?: unknown; summary?: unknown; pr?: unknown; sha?: unknown };
        return bound(context, args, async (_taskId, lease) => {
          if (lease.phase !== 'doing') throw Object.assign(new Error('复核阶段请用 task_review'), { code: 'invalid' });
          const summary = text(args.summary, 'summary', 20, 8000);
          const pr = args.pr === undefined ? undefined : (typeof args.pr === 'string' && PR_RE.test(args.pr.trim()) ? args.pr.trim() : undefined);
          if (args.pr !== undefined && !pr) throw Object.assign(new Error('pr 需要形如 https://github.com/<owner>/<repo>/pull/<n> 的链接'), { code: 'invalid' });
          const sha = args.sha === undefined ? undefined : String(args.sha).trim().toLowerCase();
          if (args.sha !== undefined && !(sha && SHA_RE.test(sha)))
            throw Object.assign(new Error('本机交卷的 sha 需要完整 40 位提交'), { code: 'invalid' });
          return call(context, 'submit', { text: pr ? `${summary}\nPR: ${pr}` : summary, ...(sha ? { sha } : {}) });
        });
      },
    },
    {
      name: 'task_review',
      description: '复核阶段给结论：verdict pass 通过 / return 退回；findings 逐条写证据（20..8000 字）。taskId 必须是当前在租任务。',
      input: z.object({ taskId: z.string(), verdict: z.enum(['pass', 'return']), findings: z.string() }),
      execute: async (input, context) => {
        const args = input as { taskId?: unknown; verdict?: unknown; findings?: unknown };
        return bound(context, args, async (_taskId, lease) => {
          if (lease.phase !== 'review') throw Object.assign(new Error('执行阶段请用 task_submit'), { code: 'invalid' });
          if (args.verdict !== 'pass' && args.verdict !== 'return') throw Object.assign(new Error('verdict 需要 pass 或 return'), { code: 'invalid' });
          const findings = text(args.findings, 'findings', 20, 8000);
          return call(context, 'review', { decision: args.verdict === 'pass' ? 'accept' : 'return', text: findings });
        });
      },
    },
    {
      name: 'task_block',
      description: '缺前置条件做不下去时报受阻：reason 说明缺什么（20..4000 字）。taskId 必须是当前在租任务。',
      input: z.object({ taskId: z.string(), reason: z.string() }),
      execute: async (input, context) => {
        const args = input as { taskId?: unknown; reason?: unknown };
        return bound(context, args, async () => call(context, 'report_blocker', { text: text(args.reason, 'reason', 20, 4000) }));
      },
    },
  ];
  for (const tool of tools) {
    if (!NAME_RE.test(tool.name) || tool.name.length > 64) throw new Error(`公司工具名无效：${tool.name}`);
  }
  return tools;
}
