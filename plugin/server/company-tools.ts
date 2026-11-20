// 本机 Paseo 员工会话注入的公司工具：与云端公司 MCP 同名同参数（共 7 个，本机没有 company_job——
// 本机运维调用经 sidecar 同步返回）。本文件只是薄壳：绑定、校验、错误文案的唯一权威是
// src/runner/company-tools.ts 的 runCompanyTool（经 sidecar `company_tool` 工具执行），
// 这里只把 AgentToolResult 形状对上。身份来自 Paseo daemon 的 agentId（context.agent.id），
// 经 SidecarPool.callForAgent 走与 `sck call` 完全相同的 dispatch：租约、凭证、熔断一律照旧。
//
// Paseo 0.16.2 的 SDK 才有 tools 类型；插件锁定 0.10.1，不升级依赖——这里的结构类型照抄
// 0.16.2 的 AgentToolDefinition/Context/Result 形状（dist/server/agent-tools.d.ts），
// 运行时字段兼容即可。
import type { z } from "zod";
import { redactText, clip } from "./vendor/src/ops/redact.ts";
import { COMPANY_TOOL_SPECS } from "./vendor/src/runner/company-tools.ts";

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

/** sidecar 暴露给插件的能力（SidecarPool 的结构子集）：公司工具全部经 company_tool 统一转发。 */
export interface CompanySidecarFace {
  callForAgent(agentId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

export interface CompanyToolDeps {
  sidecar: () => Promise<CompanySidecarFace>;
}

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

export function companyAgentTools(deps: CompanyToolDeps): LocalAgentTool[] {
  return COMPANY_TOOL_SPECS.map(spec => ({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    input: spec.input,
    execute: async (input, context) => {
      try {
        const sidecar = await deps.sidecar();
        return fromRelay(await sidecar.callForAgent(context.agent.id, 'company_tool', { name: spec.name, args: input as Record<string, unknown> }));
      } catch (error) {
        return fail((error as { code?: string }).code ?? 'error', (error as Error).message);
      }
    },
  }));
}
