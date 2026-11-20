// 本机公司工具的唯一权威：与云端公司 MCP 同名同参数的 7 个工具（本机没有 company_job——
// 本机运维调用经 sidecar 同步返回）。工具逻辑与传输无关：Paseo 会话经插件薄壳、
// 原生执行端经 `sck mcp` stdio 服务器，最终都汇到 sidecar dispatch 的 `company_tool` 用本模块执行。
// 租约、凭证、熔断一律走与 `sck call` 相同的 dispatch，本模块只是绑定与校验，不绕过任何判定。
// 本机不加白名单/次数预算（本机员工经 sck 本就可调这些工具）。
import { z } from 'zod';
import { redactText, clip } from '../ops/redact.ts';
import type { CommResponse } from '../comm.ts';

/** 调用方面对的执行端能力（sidecar dispatch 内构造；插件薄壳不直接用）。 */
export interface CompanyToolFace {
  /** 本次请求对应的租约（与 live() 同一语义）；没有返回 undefined。 */
  lease(): { taskId: string; phase: 'doing' | 'review'; leaseExpiresAt?: number } | undefined;
  /** 内层工具调用：与 sck call 相同的 dispatch；不得为 company_tool。 */
  call(tool: string, args: Record<string, unknown>): Promise<CommResponse>;
  /** 本机运维/媒体/浏览器/同步能力工具名并集。 */
  capabilityTools(): string[];
  /** 公司全景查询（landscape.get）；未注入时 company_landscape 返回 not_configured。 */
  landscape?(args: { host?: string; repo?: string }): Promise<unknown>;
}

export interface CompanyToolSpec {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PR_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

export const COMPANY_TOOL_SPECS: ReadonlyArray<CompanyToolSpec> = [
  {
    name: 'company_landscape', title: '公司服务全景',
    description: '查公司服务全景：有哪些仓库、每个仓库部署成哪些服务、跑在哪台主机、怎么部署和回滚（含最近一次实机核对）。可选 host/repo 过滤。无需任务绑定。',
    input: z.object({ host: z.string().optional(), repo: z.string().optional() }),
  },
  {
    name: 'task_current', title: '当前在租任务',
    description: '你当前在租的公司任务（taskId 与阶段 doing/review）；没有租约返回空清单。无需参数。',
    input: z.object({}),
  },
  {
    name: 'task_context', title: '任务全貌',
    description: '读你当前在租任务的全貌（需求、验收、历史等）。taskId 必须是当前在租任务（可用 task: 前缀）。',
    input: z.object({ taskId: z.string() }),
  },
  {
    name: 'company_ops', title: '运维能力调用',
    description: '调本机运维/媒体/浏览器/同步能力工具（ops_*、media_*、sync_* 等，作用于你当前租约任务）。tool 必须是能力工具名；其余能力用 sck list 查看。',
    input: z.object({ taskId: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
  },
  {
    name: 'task_submit', title: '执行交卷',
    description: '执行阶段交卷：summary 写清完成情况、验证结果和产物位置（20..8000 字）；可选 PR 链接与完整 40 位提交 sha。taskId 必须是当前在租任务。',
    input: z.object({ taskId: z.string(), summary: z.string(), pr: z.string().optional(), sha: z.string().optional() }),
  },
  {
    name: 'task_review', title: '复核结论',
    description: '复核阶段给结论：verdict pass 通过 / return 退回；findings 逐条写证据（20..8000 字）。taskId 必须是当前在租任务。',
    input: z.object({ taskId: z.string(), verdict: z.enum(['pass', 'return']), findings: z.string() }),
  },
  {
    name: 'task_block', title: '报受阻',
    description: '缺前置条件做不下去时报受阻：reason 说明缺什么（20..4000 字）。taskId 必须是当前在租任务。',
    input: z.object({ taskId: z.string(), reason: z.string() }),
  },
];
for (const spec of COMPANY_TOOL_SPECS) {
  if (!NAME_RE.test(spec.name) || spec.name.length > 64) throw new Error(`公司工具名无效：${spec.name}`);
}

export type CompanyToolOutcome = { ok: true; value: unknown } | { ok: false; code: string; message: string };

const ok = (value: unknown): CompanyToolOutcome => ({ ok: true, value });
const err = (code: string, message: string): CompanyToolOutcome => ({ ok: false, code, message: clip(redactText(message), 500) });
const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'invalid' }); };

const text = (value: unknown, name: string, min: number, max: number): string => {
  const t = typeof value === 'string' ? value.trim() : '';
  if (t.length < min || t.length > max) invalid(`${name} 需要 ${min}..${max} 字符`);
  return t;
};

/** taskId 归一化（接受 task:x 或 x）+ 租约绑定：必须等于调用方当前在租任务。 */
const bindTask = (face: CompanyToolFace, taskIdArg: unknown): { taskId: string; lease: NonNullable<ReturnType<CompanyToolFace['lease']>> } => {
  const raw = typeof taskIdArg === 'string' ? taskIdArg.trim() : '';
  const taskId = raw.startsWith('task:') ? raw.slice(5) : raw;
  if (!TASK_ID.test(taskId)) invalid('taskId invalid');
  const lease = face.lease();
  if (!lease) throw Object.assign(new Error('当前没有在租任务'), { code: 'forbidden' });
  if (lease.taskId !== taskId) throw Object.assign(new Error('taskId 不是你当前在租的任务'), { code: 'forbidden' });
  return { taskId, lease };
};

/** 内层 dispatch：CommResponse 的 error 形如 "code: message"；失败转成带 code 的异常。 */
const relay = async (face: CompanyToolFace, tool: string, args: Record<string, unknown>): Promise<unknown> => {
  const res = await face.call(tool, args);
  if (res.ok) return res.data;
  const error = res.error ?? 'error: 未知错误';
  const colon = error.indexOf(':');
  throw Object.assign(new Error(colon > 0 ? error.slice(colon + 1).trim() : error), { code: colon > 0 ? error.slice(0, colon).trim() : 'error' });
};

/** 执行一个公司工具：绑定与校验全在这里，face 只提供租约与 dispatch。 */
export async function runCompanyTool(name: string, args: unknown, face: CompanyToolFace): Promise<CompanyToolOutcome> {
  const spec = COMPANY_TOOL_SPECS.find(item => item.name === name);
  if (!spec) return err('invalid', `未知公司工具 ${String(name)}`);
  const parsed = spec.input.safeParse(args ?? {});
  if (!parsed.success) return err('invalid', parsed.error.issues[0]?.message ?? '参数无效');
  const input = parsed.data as Record<string, unknown>;
  try {
    switch (spec.name) {
      case 'company_landscape': {
        if (!face.landscape) throw Object.assign(new Error('本机没有公司全景查询通道'), { code: 'not_configured' });
        return ok(await face.landscape(input as { host?: string; repo?: string }));
      }
      case 'task_current': {
        const lease = face.lease();
        return ok({ tasks: lease ? [{ taskId: lease.taskId, phase: lease.phase, leaseExpiresAt: lease.leaseExpiresAt }] : [] });
      }
      case 'task_context': {
        bindTask(face, input.taskId);
        return ok(await relay(face, 'get_context', {}));
      }
      case 'company_ops': {
        if (typeof input.tool !== 'string' || !face.capabilityTools().includes(input.tool))
          throw Object.assign(new Error('不是运维能力工具；其余能力用 sck list 查看'), { code: 'forbidden' });
        bindTask(face, input.taskId);
        return ok(await relay(face, input.tool, (input.args as Record<string, unknown> | undefined) ?? {}));
      }
      case 'task_submit': {
        const { lease } = bindTask(face, input.taskId);
        if (lease.phase !== 'doing') invalid('复核阶段请用 task_review');
        const summary = text(input.summary, 'summary', 20, 8000);
        const pr = input.pr === undefined ? undefined : (typeof input.pr === 'string' && PR_RE.test(input.pr.trim()) ? input.pr.trim() : undefined);
        if (input.pr !== undefined && !pr) invalid('pr 需要形如 https://github.com/<owner>/<repo>/pull/<n> 的链接');
        const sha = input.sha === undefined ? undefined : String(input.sha).trim().toLowerCase();
        if (input.sha !== undefined && !(sha && SHA_RE.test(sha))) invalid('本机交卷的 sha 需要完整 40 位提交');
        return ok(await relay(face, 'submit', { text: pr ? `${summary}\nPR: ${pr}` : summary, ...(sha ? { sha } : {}) }));
      }
      case 'task_review': {
        const { lease } = bindTask(face, input.taskId);
        if (lease.phase !== 'review') invalid('执行阶段请用 task_submit');
        const findings = text(input.findings, 'findings', 20, 8000);
        return ok(await relay(face, 'review', { decision: input.verdict === 'pass' ? 'accept' : 'return', text: findings }));
      }
      case 'task_block': {
        bindTask(face, input.taskId);
        return ok(await relay(face, 'report_blocker', { text: text(input.reason, 'reason', 20, 4000) }));
      }
      default:
        return err('invalid', `未知公司工具 ${spec.name}`);
    }
  } catch (error) {
    return err((error as { code?: string }).code ?? 'error', (error as Error).message);
  }
}
