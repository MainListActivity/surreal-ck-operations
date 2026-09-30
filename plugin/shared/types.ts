// Plain JSON shapes mirroring the company DB views. Kept self-contained: shared/ cannot import the repo.

export type GoalTier = "quick" | "standard" | "program";
export type TaskState = "blocked" | "ready" | "doing" | "review" | "done";
export type Role = "gm" | "product" | "engineering" | "ai-content" | "qa" | "cs" | "eval";
export type TaskKind = "goal" | "task" | "gate" | "release" | "deploy";

export interface TaskView {
  id: string;
  title: string;
  context: string;
  state: TaskState;
  executorRole: Role;
  reviewerRole: Role | "owner";
  kind: TaskKind;
  goalId?: string;
  dependencies: string[];
  version: number;
  submittedBy?: string;
  currentEmployee?: string;
  deliveryId?: string;
  leaseExpiresAt?: string;
  blockedTo?: "gm" | "owner";
  previousEmployee?: string;
}

export interface GoalView {
  id: string;
  title: string;
  brief: string;
  state: "triage" | "active" | "done" | "cancelled";
  tier?: GoalTier;
  project?: string;
  tasks: { intake?: string; plan?: string; manual?: string; acceptance?: string };
}

export interface ProjectView {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  release: string;
  rollback?: string;
  redLines: string[];
  runbooks: string[];
  notes?: string;
  envs: Array<{ name: string; url?: string; healthUrl?: string; verify?: string }>;
}

export interface AuditEntry {
  action: string;
  actor: string;
  evidence?: string;
  version?: number;
  at: string;
}

export interface Inbox {
  gates: Array<{ task: TaskView; submission?: string }>;
  questions: Array<{ task: TaskView; question?: string }>;
  notices: Array<{ key: string; text: string; at: string }>;
  pendingCommands: number;
}

export interface Brief {
  directions: Array<{ text: string; source: string; at: string }>;
  goals: GoalView[];
  projects: ProjectView[];
  paused: boolean;
}

export interface ProviderUsageView {
  providerId: string;
  displayName: string;
  planLabel?: string | null;
  status: string;
  windows: Array<{ label: string; remainingPct?: number | null; resetsAt?: string | null; tone?: string }>;
  balances: Array<{ label: string; remaining?: number | null; limit?: number | null; unit?: string; tone?: string }>;
}

export interface Roster {
  paused: boolean;
  usage: ProviderUsageView[];
  defs: Array<{ id: string; role: string; provider: string; model: string; enabled: boolean; maxInstances: number; weight?: number }>;
  instances: Array<{ id: string; def?: string; role: string; provider?: string; cwd?: string; agentId?: string; agentStatus?: string }>;
  health: Array<{ provider: string; state: string; lastError?: string; until?: number }>;
}

export interface ModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
  thinkingOptions: Array<{ id: string; label: string; isDefault?: boolean }>;
}

export interface ProviderOption {
  id: string;
  label: string;
  status: string;
  families: Array<{ slot: string; resolvesTo: string }>;
  models: ModelOption[];
}

export interface ProviderOptionsResult {
  roles: string[];
  providers: ProviderOption[];
}

export interface PermissionRequest {
  agentId: string;
  title?: string;
  employeeId?: string;
  role?: string;
  request: { id: string; kind?: string; summary?: string; detail?: string };
}
