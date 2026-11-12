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
 * 只有六类：保护开关（guard.*）、员工身份与策略（agent.*，覆盖原先的 agent.policy.*）、老板登录方式（owner.login.*，预留）、老板设置（owner.settings.*）、
 * 能力定义（def.*）、任意 SurrealQL 写入（db.write，员工不能拿到任意写语句）。
 * 其余老板命令（任务、决策、消息、笔记、路由、身份、云端）由员工按身份、当前租约、保护清单与允许/禁止清单判定；
 * 老板可以在“仅老板”清单里把它们加入保护。按目标的硬锁（公司租户、老板端 Worker 等）在 owner-end/src/owner-locks.ts。
 */
export const HARD_OWNER_ONLY: readonly string[] = ['guard.*', 'agent.*', 'owner.login.*', 'owner.settings.*', 'def.*', 'db.write'];

/** 老板接口（owner-api.ts）的全部命令。运行器与自动化不能直接调用；tests/command-guard.test.ts 核对它与 owner-api.ts 一致。 */
export const OWNER_API_COMMANDS: readonly string[] = [
  'approve', 'audit.list', 'board.snapshot', 'brief', 'decide', 'def.disable', 'def.enable', 'def.ensure', 'def.list', 'direction.add',
  'inbox', 'instruct', 'message.edit', 'message.edit_rendered', 'message.hold', 'message.list', 'message.records', 'message.release', 'message.send',
  'note.activate', 'note.add', 'note.consolidate', 'note.consolidation.undo', 'note.consolidations', 'note.edit', 'note.list', 'note.pin', 'note.preview', 'note.remove', 'notice.list',
  'notice.resolve', 'progress', 'reject', 'reply', 'route.disable', 'route.list', 'route.save', 'session.policy', 'status',
  'task.cost', 'task.create', 'task.delete', 'task.detail', 'task.list', 'task.pause', 'task.plan', 'task.reassign',
  'task.resume', 'task.revoke', 'task.update', 'task.void',
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
  /** agent_policy 中该员工所属职能的行；没有行即默认策略：启用、不限制、无拒绝。 */
  policy?: PolicyRow;
  /** protected_command 中该命令的 owner_only 为 true。 */
  protectedOwnerOnly?: boolean;
  /** 任务当前的租约：持有人与到期时间（unix 秒）。 */
  lease?: { holder?: string | null; expiresAt?: number | null };
}

export interface PolicyRow {
  disabled?: boolean;
  allow?: string[] | null;
  deny?: string[] | null;
}

/** protected_command 中的一条（command 为完整名或 `.*` 前缀模式）。 */
export interface ProtectedRow {
  command?: unknown;
  owner_only?: boolean;
}

const allowed = (reason: string): Decision => ({ allow: true, reason });
const denied = (reason: string): Decision => ({ allow: false, reason });
const hits = (patterns: readonly string[] | null | undefined, command: string): boolean =>
  (patterns ?? []).some((pattern) => matchesCommand(pattern, command));

/** 保护清单里是否有仅老板的条目命中该命令。 */
export function protectedOwnerOnlyOf(rows: readonly ProtectedRow[], command: string): boolean {
  return rows.some((row) => row.owner_only === true && typeof row.command === 'string' && matchesCommand(row.command, command));
}

/** 写死仅老板与保护清单：对所有非老板身份生效，与租约无关。命中返回拒绝理由。 */
function ownerOnlyRefusal(command: string, protectedOwnerOnly: boolean): string | undefined {
  if (hits(HARD_OWNER_ONLY, command)) return '老板专属命令，只有老板可以调用';
  if (protectedOwnerOnly) return '老板保护的命令，只有老板可以调用';
  return undefined;
}

/**
 * 员工在不看租约时的拒绝理由，按固定顺序：停用、写死与保护、允许清单、禁止清单。
 * judge 与命令目录（cmd.catalog）共用：目录只列出这里通过的命令，租约另行核对。
 */
export function agentRefusal(command: string, policy: PolicyRow | undefined, protectedOwnerOnly: boolean): string | undefined {
  if (policy?.disabled) return '该员工已停用';
  const owner = ownerOnlyRefusal(command, protectedOwnerOnly);
  if (owner) return owner;
  const allowList = policy?.allow ?? undefined;
  if (allowList && !hits(allowList, command)) return '命令不在该员工的允许清单内';
  if (hits(policy?.deny, command)) return '该员工不能调用此命令';
  return undefined;
}

/** 纯判定：按固定顺序给出第一条拒绝理由；全部通过才放行。 */
export function judge(request: GuardRequest, facts: GuardFacts): Decision {
  const { actorKind, command, now } = request;
  if (actorKind === 'owner') return allowed('老板命令，放行');
  if (actorKind !== 'agent') {
    const owner = ownerOnlyRefusal(command, facts.protectedOwnerOnly === true);
    if (owner) return denied(owner);
    return hits(OWNER_API_COMMANDS, command) ? denied('运行器与自动化不能直接调用老板命令') : allowed('非老板命令，放行');
  }
  const refusal = agentRefusal(command, facts.policy, facts.protectedOwnerOnly === true);
  if (refusal) return denied(refusal);
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

/**
 * 判定需要的库内记录：全部保护清单条目；指定员工时还有该员工的策略行（没有即默认策略）。
 * 命令目录（cmd.catalog）与 decide 读同一份，两边的判定才会一致。
 */
export async function guardRowsOf(db: Surreal, agent?: string): Promise<{ protectedRows: ProtectedRow[]; policy?: PolicyRow }> {
  // 保护清单可以写成 `task.*` 这样的模式，所以取全部条目，再用同一套匹配规则判断（清单很短）。
  const [protectedRows] = await db.query<[ProtectedRow[]]>('SELECT command, owner_only FROM protected_command;');
  if (agent === undefined) return { protectedRows: protectedRows ?? [] };
  return { protectedRows: protectedRows ?? [], policy: await rolePolicyOf(db, agent) };
}

/**
 * 员工策略按职能保存：agent_policy.agent 存的是职能（如 `engineering`），不是员工实例。
 * 一次性会话下实例只活一轮，按实例存的策略会随实例退休失效；同一职能的所有实例共用一条策略。
 * 按员工实例 key 查它所属职能的策略行；员工不存在或职能没有策略行时返回 undefined（默认策略）。
 */
export async function rolePolicyOf(db: Surreal, employee: string): Promise<(PolicyRow & { lang?: unknown }) | undefined> {
  const [rows] = await db.query<[Array<PolicyRow & { lang?: unknown }>]>(
    'SELECT disabled, allow, deny, lang FROM agent_policy WHERE agent = $employee.role LIMIT 1;',
    { employee: new RecordId('employee', employee) });
  return rows?.[0];
}

async function factsFor(db: Surreal, request: GuardRequest): Promise<GuardFacts> {
  const rows = await guardRowsOf(db, request.actorKind === 'agent' ? request.actor : undefined);
  const facts: GuardFacts = { protectedOwnerOnly: protectedOwnerOnlyOf(rows.protectedRows, request.command) };
  if (request.actorKind !== 'agent') return facts;
  facts.policy = rows.policy;
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
  /** 一句话摘要：去首尾空白，超过 500 个字符截断，空则不写。 */
  summary?: string;
}

/** 审计摘要的字符上限（与 058 中 ops_audit.summary 的断言一致）。 */
export const AUDIT_SUMMARY_MAX = 500;

/** 审计摘要：去首尾空白后按字符（码点）截断到上限；空串得到 undefined，即不写该字段。 */
export function summaryOf(summary: string | undefined): string | undefined {
  const trimmed = summary?.trim() ?? '';
  if (!trimmed) return undefined;
  return Array.from(trimmed).slice(0, AUDIT_SUMMARY_MAX).join('');
}

/** 追加一条审计记录。ops_audit 只允许新增，修改与删除由库拒绝。 */
export async function audit(db: Surreal, entry: AuditEntry): Promise<void> {
  await db.query(`CREATE ops_audit CONTENT { actor_kind: $actorKind, actor: $actor, task: $task, command: $command,
    args_digest: $argsDigest, outcome: $outcome, reason: $reason, result_digest: $resultDigest, summary: $summary };`, {
    actorKind: entry.actorKind,
    actor: entry.actor,
    task: entry.task ? new RecordId('task', entry.task) : undefined,
    command: entry.command,
    argsDigest: await digestOf(entry.args),
    outcome: entry.outcome,
    reason: entry.reason,
    resultDigest: entry.result === undefined ? undefined : await digestOf(entry.result),
    summary: summaryOf(entry.summary),
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
