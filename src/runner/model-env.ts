import { basename } from "node:path";
import { employeeEnv, readMagpieKey, restoreLegacyRoutingSettings, writeEmployeeSettings } from "../model-routing/employee-env.ts";
import { sessionKey } from "../model-routing/magpie-contract.ts";

/** The sidecar's registry: which company employee a Paseo agent is, and the task its model session serves. */
export interface SessionLookup {
  sessionOf(ref: string): { employee: string; comm: string; role?: string; task?: string } | undefined;
}

export interface ModelEnvRequest {
  agentId: string;
  env?: Record<string, string>;
  provider?: string;
  runtime?: 'native';
}

/**
 * The model environment of a company session (the scrub hook's modelEnv). Only Claude employee sessions go to magpie.
 * story-author keeps the model its author configured. A session the plugin never registered is refused, because its
 * usage could not be attributed to a task.
 */
export function employeeModelEnv(request: ModelEnvRequest, sidecar: SessionLookup, serviceHome: string): Record<string, string> {
  if (request.provider !== "claude") return {};
  const comm = request.env?.SCK_COMM_DIR;
  const session = sidecar.sessionOf(comm ? `employee:${basename(comm)}` : request.agentId);
  // Comm dirs the retired local gateway wrote are cleaned first; the employee settings below replace what it set.
  if (session) restoreLegacyRoutingSettings(session.comm);
  if (session?.role === "story-author" && request.runtime !== 'native') return {};
  if (!session) throw new Error("员工会话尚未在插件中登记，拒绝启动");
  // One magpie session per (task, employee). A session without a task keys on the empty task and matches no task's usage.
  const env: Record<string, string> = session.role === 'story-author' ? {} :
    employeeEnv({ key: readMagpieKey(serviceHome), session: sessionKey(session.task ?? "", session.employee) });
  if (request.runtime === 'native') {
    // Custom group model IDs do not receive task tools by default in Claude Code >= 2.1.268.
    // The activity collector consumes successful TodoWrite snapshots, not incremental Task* events.
    env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1';
    env.CLAUDE_CODE_ENABLE_TASKS = '0';
  }
  // The settings file is what Claude Code applies over a user's global settings.env; the launcher loads it with --settings.
  return { ...env, SCK_CLAUDE_SETTINGS: writeEmployeeSettings(session.comm, env) };
}
