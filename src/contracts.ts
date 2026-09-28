/** v1 core/adapter boundary. The MCP adapter supplies an opaque credential on every call. */
/** 'eval' is a workforce-only judge role: it reads task history and writes scorecards, never claims tasks. */
export type Role = 'gm' | 'product' | 'engineering' | 'ai-content' | 'qa' | 'cs' | 'eval';
export type TaskState = 'blocked' | 'ready' | 'doing' | 'review' | 'done';
/** 'owner' is the human company owner; only owner decisions can accept an owner-reviewed gate. */
export type ReviewerRole = Role | 'owner';
export type TaskKind = 'goal' | 'task' | 'gate';
export type EmployeeId = string;
export type TaskId = string;
export type DeliveryId = string;
export type Credential = string;

export interface Principal {
  employeeId: EmployeeId;
  role: Role;
  capabilities: readonly ('execute' | 'review' | 'manage')[];
}

export interface TaskView {
  id: TaskId;
  title: string;
  context: string;
  state: TaskState;
  executorRole: Role;
  reviewerRole: ReviewerRole;
  kind: TaskKind;
  goalId?: string;
  dependencies: TaskId[];
  version: number;
  submittedBy?: EmployeeId;
  currentEmployee?: EmployeeId;
  deliveryId?: DeliveryId;
  leaseExpiresAt?: string;
  fence: number;
  blockedTo?: 'gm' | 'owner';
  /** Set when the previous holder's lease was revoked; the next holder must read the handover history. */
  handover?: boolean;
  previousEmployee?: EmployeeId;
}

export interface HistoryEntry {
  action: string;
  actor: string;
  evidence?: string;
  version?: number;
  at: string;
}

export interface CreateTask {
  title: string;
  context: string;
  executorRole: Role;
  reviewerRole: ReviewerRole;
  kind?: Exclude<TaskKind, 'goal'>;
  goalId?: string;
  dependencies?: TaskId[];
  idempotencyKey: string;
}

export interface ClaimResult {
  task: TaskView;
  deliveryId: DeliveryId;
  fence: number;
  leaseExpiresAt: string;
  /** Prior claims, checkpoints, returns, owner decisions and revocation handovers for this task. */
  history: HistoryEntry[];
}

/** deliveryId + fence are mandatory for every write after claim. */
export interface LeaseProof {
  taskId: TaskId;
  deliveryId: DeliveryId;
  fence: number;
  expectedVersion: number;
}

export interface Evidence {
  text: string;
  idempotencyKey: string;
}

export interface OutboxEvent {
  id: string;
  sequence: number;
  kind: string;
  taskId: TaskId;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CompanyCore {
  authenticate(credential: Credential): Promise<Principal>;
  listTasks(credential: Credential, state?: TaskState): Promise<TaskView[]>;
  getTask(credential: Credential, taskId: TaskId): Promise<TaskView>;
  createTask(credential: Credential, input: CreateTask): Promise<TaskView>;
  claim(credential: Credential, taskId: TaskId): Promise<ClaimResult>;
  heartbeat(credential: Credential, proof: LeaseProof): Promise<ClaimResult>;
  checkpoint(credential: Credential, proof: LeaseProof, evidence: Evidence): Promise<TaskView>;
  submit(credential: Credential, proof: LeaseProof, evidence: Evidence): Promise<TaskView>;
  accept(credential: Credential, proof: LeaseProof, evidence: Evidence): Promise<TaskView>;
  returnTask(credential: Credential, proof: LeaseProof, evidence: Evidence): Promise<TaskView>;
  block(credential: Credential, proof: LeaseProof, to: 'gm' | 'owner', evidence: Evidence): Promise<TaskView>;
  resume(credential: Credential, taskId: TaskId, evidence: Evidence): Promise<TaskView>;
  listOutbox(credential: Credential, after?: string): Promise<OutboxEvent[]>;
  history(credential: Credential, taskId: TaskId): Promise<HistoryEntry[]>;
  companyBrief(credential: Credential): Promise<CompanyBrief>;
  /** gm relays an owner instruction received in a direct conversation; audited as gm-relayed. */
  relayGoal(credential: Credential, input: { text: string; ownerQuote: string; idempotencyKey: string }): Promise<GoalView>;
  relayOwnerDecision(credential: Credential, input: OwnerDecisionInput & { ownerQuote: string }): Promise<TaskView>;
  relayDirection(credential: Credential, input: { text: string; ownerQuote: string; idempotencyKey: string }): Promise<void>;
  /** eval role only: score every employee who participated in a finished task. Marks the task evaluated. */
  recordScore(credential: Credential, input: { taskId: TaskId; summary: string; scores: EmployeeScore[] }): Promise<{ recorded: number; participants: string[] }>;
}

export interface EmployeeScore {
  employee: EmployeeId;
  quality: number;
  evidence: number;
  discipline: number;
  timeliness: number;
  overall: number;
  notes?: string;
}

export type OwnerDecision = 'approve' | 'reject' | 'reply';
export interface OwnerDecisionInput {
  taskId: TaskId;
  decision: OwnerDecision;
  note: string;
  idempotencyKey: string;
}

export interface GoalView {
  id: string;
  title: string;
  brief: string;
  state: 'active' | 'done' | 'cancelled';
  tasks: { intake: TaskId; plan: TaskId; manual: TaskId; acceptance: TaskId };
}

export interface CompanyBrief {
  directions: { text: string; source: string; at: string }[];
  goals: GoalView[];
  paused: boolean;
}

/** Administrative enrollment is deliberately outside the MCP adapter. */
export interface EnrollmentAdmin {
  enroll(employeeId: EmployeeId, role: Role, capabilities: Principal['capabilities']): Promise<Credential>;
  revoke(employeeId: EmployeeId): Promise<void>;
}
