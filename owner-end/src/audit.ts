/**
 * 审计：一句话摘要（老板看得懂的参数说明，经脱敏并截断）与审计时间线（读 ops_audit，可按员工、任务、命令筛选）。
 * ops_audit 只存参数与结果的摘要（args_digest / result_digest），原文不入库；summary 是给人看的那一句。
 */
import { RecordId, type Surreal } from 'surrealdb';
import { redactJson, redactText } from '../../src/ops/redact.ts';
import { boundedInt, isoOf, keyOf, textOf, type Row } from './rows.ts';

/** 命令的摘要字段：标签与参数名。未列出的命令取前几个非敏感参数。 */
const FIELDS: ReadonlyMap<string, ReadonlyArray<readonly [label: string, key: string]>> = new Map([
  ['task.create', [['标题', 'title'], ['指派', 'executorRole'], ['复核', 'reviewerRole'], ['类型', 'type']]],
  ['task.update', [['任务', 'taskId'], ['标题', 'title']]],
  ['task.reassign', [['任务', 'taskId'], ['指派', 'executorRole'], ['复核', 'reviewerRole']]],
  ['task.void', [['任务', 'taskId']]],
  ['task.delete', [['任务', 'taskId']]],
  ['task.revoke', [['任务', 'taskId']]],
  ['decide', [['任务', 'taskId'], ['决定', 'decision']]],
  ['approve', [['任务', 'taskId']]],
  ['reject', [['任务', 'taskId']]],
  ['reply', [['任务', 'taskId']]],
  ['instruct', [['内容', 'text']]],
  ['direction.add', [['内容', 'text']]],
  ['message.edit', [['消息', 'messageId']]],
  ['message.edit_rendered', [['消息', 'messageId'], ['员工', 'employeeId']]],
  ['message.hold', [['消息', 'messageId']]],
  ['message.release', [['消息', 'messageId']]],
  ['message.send', [['消息', 'messageId']]],
  ['translate.message', [['消息', 'messageId'], ['语言', 'lang']]],
  ['agent.policy.set', [['职能', 'role'], ['停用', 'disabled'], ['语言', 'lang'], ['允许', 'allow'], ['禁止', 'deny']]],
  ['agent.identity.ensure', [['员工', 'employee']]],
  ['guard.protect', [['命令', 'command'], ['仅老板', 'ownerOnly']]],
  ['guard.unprotect', [['命令', 'command']]],
  ['idp.tenant.create', [['标识', 'slug'], ['名称', 'displayName']]],
  ['idp.client.ensure', [['角色', 'role'], ['名称', 'clientName']]],
  ['idp.client.reset', [['客户端', 'clientId']]],
  ['idp.client.claims.set', [['客户端', 'clientId'], ['角色', 'role']]],
  ['idp.request', [['方法', 'method'], ['路径', 'path']]],
  ['cf.api', [['方法', 'method'], ['路径', 'path']]],
  ['db.read', [['语句', 'sql']]],
  ['db.write', [['语句', 'sql']]],
  ['note.add', [['线', 'lane'], ['内容', 'text']]],
  ['note.consolidate', [['线', 'lane'], ['试运行', 'dryRun']]],
  ['note.consolidation.undo', [['整理', 'id']]],
  ['route.save', [['类型', 'type'], ['名称', 'label']]],
  ['route.disable', [['类型', 'type']]],
  ['def.ensure', [['编号', 'id'], ['职能', 'role']]],
  ['def.disable', [['编号', 'id']]],
  ['def.enable', [['编号', 'id']]],
  ['session.policy', [['策略', 'policy']]],
  ['notice.resolve', [['通知', 'key']]],
]);

/** 参数名含这些字样的一律不进摘要。 */
const SECRET_NAME = /token|secret|password|passwd|authorization|verifier/i;
const SUMMARY_VALUE_MAX = 80;

/** 取前 max 个字符（码点），超出加省略号。 */
function short(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return short(redactText(value.replace(/\s+/g, ' ').trim()), SUMMARY_VALUE_MAX);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return short(JSON.stringify(redactJson(value)) ?? '', SUMMARY_VALUE_MAX);
}

/**
 * 审计摘要：命令名加上关键参数，形如 `task.create 标题=… 指派=…`。空值与敏感参数不出现；长度由 command-guard 再截到 500 字。
 */
export function auditSummary(command: string, input: Record<string, unknown>): string {
  const listed = FIELDS.get(command);
  const pairs = listed
    ? listed
      .filter(([, key]) => input[key] !== undefined && input[key] !== null && input[key] !== '')
      .map(([label, key]) => `${label}=${valueText(input[key])}`)
    : Object.keys(input).filter((key) => !SECRET_NAME.test(key)).slice(0, 4).map((key) => `${key}=${valueText(input[key])}`);
  return [command, ...pairs].join(' ');
}

/** 页面看到的一条审计记录。 */
export interface AuditView {
  at: string | null;
  actorKind: string;
  actor: string;
  task: string | null;
  command: string;
  outcome: string;
  reason: string | null;
  summary: string | null;
}

const textOrNull = (value: unknown): string | null => typeof value === 'string' && value ? value : null;

function viewOf(row: Row): AuditView {
  return {
    at: isoOf(row.at),
    actorKind: String(row.actor_kind ?? ''),
    actor: String(row.actor ?? ''),
    task: row.task ? keyOf(row.task) : null,
    command: String(row.command ?? ''),
    outcome: String(row.outcome ?? ''),
    reason: textOrNull(row.reason),
    summary: textOrNull(row.summary),
  };
}

const optional = (value: unknown, field: string, max: number): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : textOf(value, field, max);

/** 审计时间线，新的在前。可按员工（agent）、任务、命令筛选。 */
export async function listAudit(db: Surreal, input: Record<string, unknown>): Promise<{ audit: AuditView[] }> {
  const limit = boundedInt(input.limit, 50, 200);
  const agent = optional(input.agent, 'agent', 64);
  const task = optional(input.task, 'task', 128);
  const command = optional(input.command, 'command', 120);
  const where: string[] = [];
  const vars: Record<string, unknown> = { limit };
  if (agent) { where.push("actor_kind = 'agent' AND actor = $agent"); vars.agent = agent; }
  if (task) { where.push('task = $task'); vars.task = new RecordId('task', task); }
  if (command) { where.push('command = $command'); vars.command = command; }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await db.query<[Row[]]>(`SELECT * FROM ops_audit ${clause} ORDER BY at DESC LIMIT $limit;`, vars);
  return { audit: (rows ?? []).map(viewOf) };
}
