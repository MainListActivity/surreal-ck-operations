// 命令守卫：判定一次调用能不能执行，并把判定与调用摘要追加进 ops_audit（056）。
// 只用 Web 标准 API（crypto.subtle、TextEncoder）和 surrealdb SDK，不引入 Node 内置模块。
import { RecordId, type Surreal } from 'surrealdb';

export type ActorKind = 'owner' | 'agent' | 'runner' | 'automation';
export type AuditOutcome = 'ok' | 'denied' | 'error';

/** 模式：完整命令名，或以 `.*` 结尾的命名空间前缀（如 `task.*`）。 */
export function matchesCommand(pattern: string, command: string): boolean {
  return pattern.endsWith('.*') ? command.startsWith(pattern.slice(0, -1)) : command === pattern;
}

/**
 * 写死的老板专属命令：除老板外任何身份都不能调用，不受 protected_command 与 agent_policy 影响。
 * `owner.login.*` 为预留，对应老板登录方式相关命令（当前还没有这些命令）。
 */
export const HARD_OWNER_ONLY: readonly string[] = ['guard.*', 'agent.policy.*', 'owner.login.*', 'def.*'];

/** 老板接口（owner-api.ts）的全部命令。运行器与自动化不能直接调用；tests/command-guard.test.ts 核对它与 owner-api.ts 一致。 */
export const OWNER_API_COMMANDS: readonly string[] = [
  'approve', 'audit.list', 'brief', 'decide', 'def.disable', 'def.enable', 'def.ensure', 'def.list', 'direction.add',
  'inbox', 'instruct', 'message.edit', 'message.hold', 'message.list', 'message.records', 'message.release', 'message.send',
  'note.activate', 'note.add', 'note.edit', 'note.list', 'note.pin', 'note.preview', 'note.remove', 'notice.list',
  'notice.resolve', 'progress', 'reject', 'reply', 'route.disable', 'route.list', 'route.save', 'session.policy', 'status',
  'task.cost', 'task.create', 'task.delete', 'task.detail', 'task.list', 'task.pause', 'task.plan', 'task.reassign',
  'task.resume', 'task.revoke', 'task.update', 'task.void', 'upgrade.automatic', 'upgrade.list', 'upgrade.start',
];

export interface GuardRequest {
  actorKind: ActorKind;
  /** 调用者标识：员工 key（agent）或运行器、自动化的身份名；老板用 owner 标签。 */
  actor: string;
  /** 任务 key（不含 `task:` 前缀）。员工调用必须带，用来核对租约。 */
  task?: string;
  command: string;
  /** unix 秒，与 lease_expires_at 同一单位。 */
  now: number;
}

export interface Decision {
  allow: boolean;
  reason: string;
}

/** judge 需要的事实，由 decide 从库里读出。 */
export interface GuardFacts {
  /** agent_policy 中该员工的行；没有行即默认策略：启用、不限制、无拒绝。 */
  policy?: PolicyRow;
  /** protected_command 中该命令的 owner_only 为 true。 */
  protectedOwnerOnly?: boolean;
  /** 任务当前的租约：持有人与到期时间（unix 秒）。 */
  lease?: { holder?: string | null; expiresAt?: number | null };
}

interface PolicyRow {
  disabled?: boolean;
  allow?: string[] | null;
  deny?: string[] | null;
}

const allowed = (reason: string): Decision => ({ allow: true, reason });
const denied = (reason: string): Decision => ({ allow: false, reason });
const hits = (patterns: readonly string[] | null | undefined, command: string): boolean =>
  (patterns ?? []).some((pattern) => matchesCommand(pattern, command));

/** 纯判定：按固定顺序给出第一条拒绝理由；全部通过才放行。 */
export function judge(request: GuardRequest, facts: GuardFacts): Decision {
  const { actorKind, command, now } = request;
  if (actorKind === 'owner') return allowed('老板命令，放行');
  if (actorKind === 'agent' && facts.policy?.disabled) return denied('该员工已停用');
  if (hits(HARD_OWNER_ONLY, command)) return denied('老板专属命令，只有老板可以调用');
  if (facts.protectedOwnerOnly) return denied('老板保护的命令，只有老板可以调用');
  if (actorKind !== 'agent') {
    return hits(OWNER_API_COMMANDS, command) ? denied('运行器与自动化不能直接调用老板命令') : allowed('非老板命令，放行');
  }
  const allowList = facts.policy?.allow ?? undefined;
  if (allowList && !hits(allowList, command)) return denied('命令不在该员工的允许清单内');
  if (hits(facts.policy?.deny, command)) return denied('该员工不能调用此命令');
  const lease = facts.lease;
  if (!request.task || !lease || lease.holder !== request.actor || !((lease.expiresAt ?? 0) > now)) {
    return denied('没有该任务的有效租约');
  }
  return allowed('员工持有该任务的有效租约，放行');
}

/** 读出判定事实后判定。老板直接放行，不查库。 */
export async function decide(db: Surreal, request: GuardRequest): Promise<Decision> {
  if (request.actorKind === 'owner') return judge(request, {});
  return judge(request, await factsFor(db, request));
}

async function factsFor(db: Surreal, request: GuardRequest): Promise<GuardFacts> {
  const [protectedRows] = await db.query<[Array<{ owner_only?: boolean }>]>(
    'SELECT owner_only FROM protected_command WHERE command = $command LIMIT 1;', { command: request.command });
  const facts: GuardFacts = { protectedOwnerOnly: protectedRows[0]?.owner_only === true };
  if (request.actorKind !== 'agent') return facts;
  const [policyRows] = await db.query<[PolicyRow[]]>(
    'SELECT disabled, allow, deny FROM agent_policy WHERE agent = $agent LIMIT 1;', { agent: request.actor });
  facts.policy = policyRows[0];
  if (request.task) {
    const [taskRows] = await db.query<[Array<{ current_employee?: string | null; lease_expires_at?: number | null }>]>(
      'SELECT current_employee, lease_expires_at FROM $task;', { task: new RecordId('task', request.task) });
    facts.lease = { holder: taskRows[0]?.current_employee, expiresAt: taskRows[0]?.lease_expires_at };
  }
  return facts;
}

export interface AuditEntry {
  actorKind: ActorKind;
  actor: string;
  task?: string;
  command: string;
  /** 调用参数：只写摘要，原文不入库（参数里可能有凭据或客户资料）。 */
  args: unknown;
  outcome: AuditOutcome;
  reason?: string;
  /** 调用结果：同样只写摘要。 */
  result?: unknown;
}

/** 追加一条审计记录。ops_audit 只允许新增，修改与删除由库拒绝。 */
export async function audit(db: Surreal, entry: AuditEntry): Promise<void> {
  await db.query(`CREATE ops_audit CONTENT { actor_kind: $actorKind, actor: $actor, task: $task, command: $command,
    args_digest: $argsDigest, outcome: $outcome, reason: $reason, result_digest: $resultDigest };`, {
    actorKind: entry.actorKind,
    actor: entry.actor,
    task: entry.task ? new RecordId('task', entry.task) : undefined,
    command: entry.command,
    argsDigest: await digestOf(entry.args),
    outcome: entry.outcome,
    reason: entry.reason,
    resultDigest: entry.result === undefined ? undefined : await digestOf(entry.result),
  });
}

/** 摘要：键排序后的 JSON 取 SHA-256，形如 sha256:<hex>。同一内容不论键的书写顺序，摘要都相同。 */
export async function digestOf(value: unknown): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value))));
  return `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** 键排序的 JSON；undefined 记为 null。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  }) ?? 'null';
}
