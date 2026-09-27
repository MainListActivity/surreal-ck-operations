/** v1 core/adapter boundary. The MCP adapter supplies an opaque credential on every call. */
export type Role = 'gm' | 'product' | 'engineering' | 'ai-content' | 'qa' | 'cs';
export type TaskState = 'blocked' | 'ready' | 'doing' | 'review' | 'done';
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
  reviewerRole: Role;
  dependencies: TaskId[];
  version: number;
  submittedBy?: EmployeeId;
  currentEmployee?: EmployeeId;
  deliveryId?: DeliveryId;
  leaseExpiresAt?: string;
  fence: number;
  blockedTo?: 'gm' | 'owner';
}

export interface CreateTask {
  title: string;
  context: string;
  executorRole: Role;
  reviewerRole: Role;
  dependencies?: TaskId[];
  idempotencyKey: string;
}

export interface ClaimResult {
  task: TaskView;
  deliveryId: DeliveryId;
  fence: number;
  leaseExpiresAt: string;
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
}

/** Administrative enrollment is deliberately outside the MCP adapter. */
export interface EnrollmentAdmin {
  enroll(employeeId: EmployeeId, role: Role, capabilities: Principal['capabilities']): Promise<Credential>;
  revoke(employeeId: EmployeeId): Promise<void>;
}
