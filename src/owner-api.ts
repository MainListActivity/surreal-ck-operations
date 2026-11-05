/**
 * 老板接口：任何持有 owner-token 的 agent 都能调用（网页控制台与 sck owner 共用同一套 JSON 命令）。
 * 所有写操作记 actor=owner 并带 via 标签（请求头 X-Owner-Agent，没有则 web）。
 */
import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import { OwnerDesk } from './owner.ts';
import type { CompanyCore } from './contracts.ts';
import { Workforce } from './workforce.ts';
import { OutboundMessageStore } from './outbound-messages.ts';
import { CompanyError } from './core-errors.ts';
import { ROLES, type GoalTier, type Role } from './contracts.ts';
import { isPipeline } from './flows.ts';

export type OwnerVia = string;
export interface OwnerApiContext { db: CompanyDatabase; core: CompanyCore; owner: OwnerDesk; workforce: Workforce; messages: OutboundMessageStore; opsRepo: string; upgrades?: { inbox(): Promise<unknown>; setAuto(enabled: boolean, source: string): Promise<unknown>; start(input: { taskId: string; taskVersion: number; digest: string }, source: string): Promise<unknown> } }

const actor = (via: string) => `owner:${via || 'web'}`;
const text = (value: unknown, field: string, min = 1, max = 20000): string => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new CompanyError('invalid', `${field} invalid`);
  return value.trim();
};
const optionalText = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const strArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Every command is a flat JSON object: { command, ...args }. */
export async function ownerApi(ctx: OwnerApiContext, input: Record<string, unknown>, via: OwnerVia): Promise<unknown> {
  const command = String(input.command ?? '');
  const a = actor(via);
  const key = () => `owner:${via}:${command}:${randomUUID()}`;
  const db = ctx.db.db;
  switch (command) {
    // ---- 目标 ----
    case 'goal.create': return ctx.owner.createGoal({ text: text(input.text, 'text', 2), source: a, key: key(),
      tier: input.tier as GoalTier | undefined, project: optionalText(input.project), pipeline: optionalText(input.pipeline) });
    case 'goal.triage': return ctx.owner.triage(text(input.goalId, 'goalId'), text(input.tier, 'tier') as GoalTier, a);
    case 'goal.cancel': return ctx.owner.cancelGoal({ goalId: text(input.goalId, 'goalId'), note: text(input.note, 'note', 2), source: a, key: key() });
    case 'goal.list': { const [rows] = await db.query<[unknown[]]>('SELECT * FROM goal ORDER BY created_at DESC LIMIT 200;'); return { goals: rows }; }

    // ---- 任务 ----
    case 'task.create': {
      const requirement = text(input.requirement, 'requirement');
      const acceptance = text(input.acceptanceText ?? input.acceptance_text, 'acceptanceText');
      const executor = text(input.executorRole, 'executorRole') as Role;
      const reviewer = text(input.reviewerRole, 'reviewerRole') as Role | 'owner';
      if (!ROLES.includes(executor)) throw new CompanyError('invalid', 'unknown executorRole');
      if (reviewer !== 'owner' && !ROLES.includes(reviewer)) throw new CompanyError('invalid', 'unknown reviewerRole');
      const deps = strArray(input.dependencies);
      // The owner control-plane credential is only available to the HTTP process; use core's internal create path
      // under the owner principal through a direct employee credential minted at boot.
      const ownerCred = process.env.SCK_OWNER_TOKEN;
      if (!ownerCred) throw new CompanyError('temporarily_unavailable', 'owner token not configured');
      const task = await ctx.core.createTask(ownerCred, { title: text(input.title, 'title', 3), context: requirement,
        executorRole: executor, reviewerRole: reviewer, dependencies: deps, goalId: optionalText(input.goalId),
        project: optionalText(input.project), idempotencyKey: key() } as never);
      await db.query('UPDATE ONLY $task SET requirement = $requirement, acceptance_text = $acceptance;',
        { task: new RecordId('task', task.id), requirement, acceptance });
      await ctx.messages.createTaskDrafts(task.id, executor, reviewer, executor === 'engineering');
      return task;
    }
    case 'task.update': {
      const taskId = text(input.taskId, 'taskId');
      const patch: Record<string, string> = {};
      if (input.requirement !== undefined) patch.requirement = text(input.requirement, 'requirement');
      if (input.acceptanceText !== undefined || input.acceptance_text !== undefined) patch.acceptance_text = text(input.acceptanceText ?? input.acceptance_text, 'acceptanceText');
      if (input.title !== undefined) patch.title = text(input.title, 'title', 3);
      if (!Object.keys(patch).length) throw new CompanyError('invalid', 'no fields to update');
      const [rows] = await db.query<[unknown[]]>('UPDATE ONLY $task MERGE $patch RETURN AFTER;', { task: new RecordId('task', taskId), patch });
      if (!rows?.length) throw new CompanyError('not_found', 'task not found');
      return rows[0];
    }
    case 'task.delete': return ctx.owner.retire({ taskId: text(input.taskId, 'taskId'), note: text(input.note, 'note', 2), source: a, key: key() });
    case 'task.detail': {
      const taskId = text(input.taskId, 'taskId');
      const [rows] = await db.query<[Array<Record<string, unknown>>]>('SELECT * FROM $task;', { task: new RecordId('task', taskId) });
      if (!rows?.length) throw new CompanyError('not_found', 'task not found');
      const [audit] = await db.query<[unknown[]]>('SELECT * FROM audit WHERE task = $task ORDER BY at;', { task: new RecordId('task', taskId) });
      const [messages] = await db.query<[unknown[]]>('SELECT * FROM outbound_message WHERE task = $task ORDER BY created_at;', { task: new RecordId('task', taskId) });
      return { task: rows[0], audit, messages };
    }
    case 'task.list': { const [rows] = await db.query<[unknown[]]>('SELECT * FROM task ORDER BY created_at DESC LIMIT 300;'); return { tasks: rows }; }
    case 'task.reassign': return ctx.owner.reassign({ taskId: text(input.taskId, 'taskId'),
      executorRole: optionalText(input.executorRole) as Role | undefined,
      reviewerRole: optionalText(input.reviewerRole) as Role | 'owner' | undefined,
      note: text(input.note, 'note'), source: a, key: key() });
    case 'task.void': return ctx.owner.retire({ taskId: text(input.taskId, 'taskId'), note: text(input.note, 'note', 2), source: a, key: key() });
    case 'task.revoke': return ctx.workforce.revokeTaskLease(text(input.taskId, 'taskId'), text(input.note ?? '老板终止在途执行', 'note'),
      '【交接包】老板终止了上一棒的在途执行。', a);
    case 'task.unlock': return { unlocked: await ctx.owner.unlockDependents({ taskId: text(input.taskId, 'taskId'), source: a }) };
    case 'task.pause': await ctx.owner.setPaused(true); return { paused: true };
    case 'task.resume': await ctx.owner.setPaused(false); return { paused: false };
    case 'decide': case 'approve': case 'reject': case 'reply': {
      const decision = command === 'decide' ? text(input.decision, 'decision') : command;
      return ctx.owner.decide({ taskId: text(input.taskId, 'taskId'), decision: decision as 'approve' | 'reject' | 'reply',
        note: text(input.note ?? '', 'note', command === 'approve' ? 0 : 2), source: a, key: key() });
    }
    case 'inbox': {
      const inbox = await ctx.owner.inbox();
      if (ctx.upgrades) return { ...inbox, upgrades: await ctx.upgrades.inbox() };
      return inbox;
    }
    case 'upgrade.list': return ctx.upgrades ? await ctx.upgrades.inbox() : { upgrades: { items: [] } };
    case 'upgrade.automatic': { const enabled = input.enabled === true; return ctx.upgrades ? await ctx.upgrades.setAuto(enabled, a) : { ok: false }; }
    case 'upgrade.start': return ctx.upgrades ? await ctx.upgrades.start({ taskId: text(input.taskId, 'taskId'), taskVersion: Number(input.taskVersion), digest: text(input.digest, 'digest') }, a) : { ok: false };
    case 'brief': return ctx.owner.brief();

    // ---- 待发消息 ----
    case 'message.list': return { messages: await ctx.messages.list(optionalText(input.taskId), input.includeSent !== false) };
    case 'message.edit': return ctx.messages.edit(text(input.messageId, 'messageId'), text(input.body, 'body'), a);
    case 'message.hold': return ctx.messages.setHold(text(input.messageId, 'messageId'), true, a);
    case 'message.release': return ctx.messages.setHold(text(input.messageId, 'messageId'), false, a);
    case 'message.send': {
      // 放行：清 hold 后由调度器在下一轮实际派工（正文仍来自表里）。
      return ctx.messages.setHold(text(input.messageId, 'messageId'), false, a);
    }
    case 'message.records': {
      const [rows] = await db.query<[unknown[]]>("SELECT * FROM outbound_message WHERE state = 'sent' ORDER BY sent_at DESC LIMIT 300;");
      return { records: rows };
    }

    // ---- 编制 ----
    case 'def.list': return { defs: await ctx.workforce.defs() };
    case 'def.ensure': {
      const defId = text(input.id, 'id');
      const role = text(input.role, 'role') as Role;
      if (!ROLES.includes(role)) throw new CompanyError('invalid', 'unknown role');
      const def = await ctx.workforce.upsertDef(defId, { role, provider: text(input.provider, 'provider'),
        model: text(input.model, 'model'), thinking: optionalText(input.thinking),
        maxInstances: typeof input.maxInstances === 'number' ? input.maxInstances : undefined,
        priority: typeof input.priority === 'number' ? input.priority : undefined,
        weight: typeof input.weight === 'number' ? input.weight : undefined });
      if (input.enabled === false) await db.query('UPDATE $def SET enabled = false;', { def: new RecordId('employee_def', defId) });
      return def;
    }
    case 'def.disable': { const defId = text(input.id, 'id'); await db.query('UPDATE $def SET enabled = false, disabled_reason = $reason;',
      { def: new RecordId('employee_def', defId), reason: text(input.reason ?? '老板停用', 'reason') }); return { ok: true }; }
    case 'def.enable': { await db.query('UPDATE $def SET enabled = true, error_streak = 0, disabled_reason = NONE;',
      { def: new RecordId('employee_def', text(input.id, 'id')) }); return { ok: true }; }

    // ---- 审计 ----
    case 'audit.list': { const [rows] = await db.query<[unknown[]]>(
      'SELECT * FROM audit ORDER BY at DESC LIMIT 300;'); return { audit: rows }; }
    case 'status': {
      const [tasks] = await db.query<[Array<{ state: string }>]>('SELECT state FROM task;');
      return { tasks: tasks.length, paused: (await ctx.workforce.config()).paused,
        drafts: (await ctx.messages.list(undefined, false)).length, via: a };
    }
    default: throw new CompanyError('invalid', `unknown owner command: ${command}`);
  }
}
