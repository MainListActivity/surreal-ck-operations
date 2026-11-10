import type { RetirementKind } from '../contracts.ts';
/**
 * `model` is the model the session is actually serving (`ls -g` prints `provider/model`), which a
 * provider may have switched under us when a subscription hit its allowance. Undefined when Paseo
 * prints a bare provider id: unknown, never "unchanged".
 */
export interface AgentInfo { id: string; status: string; model?: string }
/** Sessions with no task behind them (day-to-day maintenance) share one container. */
export const MAINTENANCE_WORKSPACE = '日常维护';
/** The owner reads this in the Paseo sidebar: a goal or task name, never an employee or record ID. */
export const workspaceTitleOf = (title?: string): string => (title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || '未命名任务';

export interface RuntimeWorkspace { workspaceId: string; name: string; cwd: string; project?: string }
export interface RuntimeProject { projectId: string; name: string; path: string; kind?: string }
/** One row of `paseo plugin ls --json`: the host's own record of where a plugin is registered from. */
export interface RuntimePlugin {
  id?: string;
  path?: string;
  enabled?: boolean;
  status?: string;
  installation?: { identity?: { kind?: string; path?: string } };
}
export interface SceneCleanupResult { workspacesArchived: number; projectsDeleted: number; employeesRetired?: number }

/** The dispatcher-facing fields of an employee instance that scene cleanup needs. */
export interface SceneEmployee { id: string; cwd?: string; paseoAgentId?: string | null }
export interface SceneEmployees {
  insts(): Promise<SceneEmployee[]>;
  retire(id: string, reason: string, kind: RetirementKind): Promise<unknown>;
  /** In-process sidecar cleanup — binding drop + quarantine — when the plugin process wires it. */
  detach?(inst: SceneEmployee): void;
}

export interface SpawnInput {
  title: string;
  provider: string;
  model: string;
  thinking?: string;
  mode?: string;
  cwd: string;
  /** Legacy title, or a goal title within the explicitly registered repository project. */
  workspaceTitle: string;
  /** An existing container; without it the title resolves one. */
  workspaceId?: string;
  workspaceScope?: string;
  repoHome?: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  prompt: string;
}

/** The dispatcher's only view of Paseo. Implemented by the paseo CLI; faked in tests. */
export interface AgentRuntime {
  heartbeat?(): Promise<void>;
  /** Bounded public progress; separate from business completion. */
  activity?(): import('../agent-activity.ts').AgentActivity[];
  acknowledgeActivity?(agent: string, turn: string): void;
  list(): Promise<Map<string, AgentInfo>>;
  /**
   * `undefined` only when the CLI confirms the agent does not exist (AGENT_NOT_FOUND). When the CLI could not answer
   * (non-zero exit, timeout, non-JSON or empty stdout, no Status field) the status is `'unknown'`: the dispatcher must
   * neither dispatch to it nor treat it as missing, idle or busy.
   */
  status(agentId: string): Promise<{ status: string; pendingPermissions: number } | undefined>;
  lastError(agentId: string): Promise<string>;
  logsTail(agentId: string, entries: number): Promise<string>;
  /** Input tokens of the agent's last turn; a proxy for how large its session context has grown. */
  lastInputTokens(agentId: string): Promise<number | undefined>;
  spawn(input: SpawnInput): Promise<string>;
  activate?(agentId: string): Promise<void>;
  send(agentId: string, prompt: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  /** Close only the runtime via native MCP; keep agent persistence and archive state. */
  sleep?(agentId: string, beforeClose?: () => Promise<boolean>): Promise<void>;
  /**
   * Restart the session's underlying process in place, keeping the agent, its conversation and
   * its channel binding. A session parked in `error` never leaves that state on its own — the
   * dispatcher only dispatches into idle sessions — so this is how a seat comes back after the
   * subscription that failed it recovers.
   */
  reload(agentId: string): Promise<void>;
  /** Soft-delete the agent's session (its transcript stays in Paseo history). */
  archive(agentId: string): Promise<void>;
  /** Active workspaces; archived ones no longer appear. */
  listWorkspaces(): Promise<RuntimeWorkspace[]>;
  /** Registered projects; each maps a directory to the workspaces under it. */
  listProjects(): Promise<RuntimeProject[]>;
  /** Registered plugins as the host records them (id, status and the installation source). Optional so a
   *  focused dispatcher test double need not stub a host query the dispatcher itself never makes. */
  plugins?(): Promise<RuntimePlugin[]>;
  /** A new container for the sessions of one task chain. Titles are not unique, so the caller keeps the ID. */
  createWorkspace?(title: string, cwd: string, repoHome?: string): Promise<string>;
  /** Archive a workspace and everything it owns; the transcript stays in history. */
  archiveWorkspace(workspaceId: string): Promise<void>;
  /** Delete a project and its workspaces. */
  deleteProject(projectId: string): Promise<void>;
}


export interface TurnEnded {
  /** 本机收到事件的时刻，早于任何异步数据库/身份检查。 */
  observedAt?: number;
  agent: { id: string; title?: string | null; provider?: string };
  turnId?: string | null;
  outcome: { kind: string; error?: { message: string; code?: string } };
  timeline: ReadonlyArray<{ type: string; text?: string; message?: string }>;
}
