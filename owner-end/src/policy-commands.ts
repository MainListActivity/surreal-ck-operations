/**
 * 员工与权限命令（只由老板调用）：员工列表（身份、策略）、员工策略（停用、允许/禁止、默认语言），
 * 以及保护命令清单（protected_command）。写入由数据库的 EVENT 限定为老板，这里再做一次参数校验。
 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from '../../src/core-errors.ts';
import { HARD_OWNER_ONLY, OWNER_API_COMMANDS } from '../../src/command-guard.ts';
import { inServiceEmployees } from './employees.ts';
import { COMPANY_HOST, OWNER_ONLY_FOR_AGENTS, TARGET_LOCKS, type LockTargets } from './owner-locks.ts';
import { LANG } from './translate.ts';

/** 本模块处理的命令名。 */
export const POLICY_COMMANDS: ReadonlySet<string> = new Set([
  'agent.list', 'agent.policy.list', 'agent.policy.set', 'guard.list', 'guard.protect', 'guard.unprotect', 'guard.set',
]);

const EMPLOYEE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COMMAND_NAME = /^[a-z][a-z0-9_.*-]{0,119}$/;

type Row = Record<string, unknown>;

const keyOf = (value: unknown): string => String((value as RecordId | undefined)?.id ?? value ?? '');

function employeeOf(value: unknown): string {
  if (typeof value !== 'string' || !EMPLOYEE_ID.test(value.trim())) throw new CompanyError('invalid', 'employee invalid');
  return value.trim();
}

function stringList(value: unknown, field: string): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 200 || value.some((item) => typeof item !== 'string' || item.length > 200)) {
    throw new CompanyError('invalid', `${field} invalid`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

/** 员工策略的读出形状（与老板页面的 AgentPolicy 一致）。没有策略行即默认：启用、不限制、无拒绝、无语言。 */
function policyOf(row: Row | undefined) {
  return {
    disabled: row?.disabled === true,
    allow: Array.isArray(row?.allow) ? (row?.allow as string[]) : null,
    deny: Array.isArray(row?.deny) ? (row?.deny as string[]) : [],
    lang: typeof row?.lang === 'string' && row.lang ? row.lang : null,
  };
}

/** 员工列表：在岗员工（与看板的筛选一致），附身份、策略。 */
async function agentList(db: Surreal) {
  const staff = await inServiceEmployees(db);
  const [policies] = await db.query<[Row[]]>('SELECT * FROM agent_policy;');
  const [identities] = await db.query<[Row[]]>('SELECT employee, idp_user FROM agent_identity;');
  const policyBy = new Map((policies ?? []).map((row) => [String(row.agent), row]));
  const identityBy = new Map((identities ?? []).map((row) => [String(row.employee), String(row.idp_user ?? '')]));
  return {
    agents: staff.map((member) => {
      const idpUser = identityBy.get(member.employee);
      return {
        employee: member.employee,
        name: member.name,
        role: member.role,
        ...(idpUser ? { idpUser } : {}),
        policy: policyOf(policyBy.get(member.employee)),
      };
    }),
  };
}

/** 员工策略写入。null 表示清空（allow 为 NONE 即不限制；lang 为 NONE 即中文原文）。未给出的字段保持不变。 */
async function setPolicy(db: Surreal, input: Row, actor: string) {
  const employee = employeeOf(input.agent ?? input.employee);
  const sets: string[] = ['agent = $agent', 'updated_by = $actor', 'updated_at = time::now()'];
  const vars: Record<string, unknown> = { rid: new RecordId('agent_policy', employee), agent: employee, actor };
  if (input.disabled !== undefined) {
    if (typeof input.disabled !== 'boolean') throw new CompanyError('invalid', 'disabled invalid');
    sets.push('disabled = $disabled');
    vars.disabled = input.disabled;
  }
  const allow = stringList(input.allow, 'allow');
  if (allow === null) sets.push('allow = NONE');
  else if (allow !== undefined) { sets.push('allow = $allow'); vars.allow = allow; }
  const deny = stringList(input.deny, 'deny');
  if (deny !== undefined) { sets.push('deny = $deny'); vars.deny = deny ?? []; }
  if (input.lang === null) {
    sets.push('lang = NONE');
  } else if (input.lang !== undefined) {
    if (typeof input.lang !== 'string' || !LANG.test(input.lang.trim())) throw new CompanyError('invalid', 'lang invalid');
    sets.push('lang = $lang');
    vars.lang = input.lang.trim();
  }
  await db.query(`UPSERT $rid SET ${sets.join(', ')};`, vars);
  const [rows] = await db.query<[Row[]]>('SELECT * FROM $rid;', { rid: vars.rid });
  return { employee, policy: policyOf(rows?.[0]) };
}

/**
 * 保护命令清单。hardOwnerOnly 是写死仅老板的命令（页面锁定显示）；targetLocks 与 lockedTargets 是按目标的锁
 * （公司租户、受保护的脚本与 D1，见 owner-locks.ts）；ownerOnlyForAgents 是员工调用即拒绝的老板观测命令。
 */
async function guardList(db: Surreal, locks: LockTargets) {
  const [rows] = await db.query<[Row[]]>('SELECT command, owner_only FROM protected_command ORDER BY command;');
  return {
    protected: (rows ?? []).map((row) => ({ command: String(row.command), ownerOnly: row.owner_only !== false })),
    hardOwnerOnly: [...HARD_OWNER_ONLY],
    targetLocks: TARGET_LOCKS.map((lock) => ({ ...lock })),
    lockedTargets: {
      companyTenantId: locks.companyTenantId || null,
      companyHost: COMPANY_HOST,
      scripts: [...locks.scripts],
      d1Ids: [...locks.d1Ids],
    },
    ownerOnlyForAgents: [...OWNER_ONLY_FOR_AGENTS],
    ownerApiCommands: [...OWNER_API_COMMANDS],
  };
}

function commandOf(value: unknown): string {
  if (typeof value !== 'string' || !COMMAND_NAME.test(value.trim())) throw new CompanyError('invalid', 'command invalid');
  return value.trim();
}

/** 设为保护（或取消老板专属）。命令名可以是 `task.*` 这样的前缀模式。 */
async function protectCommand(db: Surreal, input: Row, actor: string) {
  const command = commandOf(input.command);
  const ownerOnly = input.ownerOnly !== false;
  await db.query('UPSERT $rid SET command = $command, owner_only = $ownerOnly, updated_by = $actor, updated_at = time::now();', {
    rid: new RecordId('protected_command', command), command, ownerOnly, actor,
  });
  return { command, ownerOnly };
}

/** 取消保护：删除该条记录。 */
async function unprotectCommand(db: Surreal, input: Row) {
  const command = commandOf(input.command);
  await db.query('DELETE $rid;', { rid: new RecordId('protected_command', command) });
  return { command, removed: true };
}

/** 员工与权限命令。只能处理 POLICY_COMMANDS 中的命令。locks 只用于 guard.list 展示。 */
export async function policyCommand(db: Surreal, command: string, input: Row, actor: string, locks: LockTargets): Promise<unknown> {
  switch (command) {
    case 'agent.list': return agentList(db);
    case 'agent.policy.list': {
      const [rows] = await db.query<[Row[]]>('SELECT * FROM agent_policy ORDER BY agent;');
      return { policies: rows ?? [] };
    }
    case 'agent.policy.set': return setPolicy(db, input, actor);
    case 'guard.list': return guardList(db, locks);
    case 'guard.protect': return protectCommand(db, input, actor);
    case 'guard.set': return protectCommand(db, input, actor);
    case 'guard.unprotect': return unprotectCommand(db, input);
    default: throw new CompanyError('invalid', `unknown policy command: ${command}`);
  }
}
