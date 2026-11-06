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
import { ROLES, type CreateTask, type Role } from './contracts.ts';
import { HASH, REQUIRED_TRACKS } from './core.ts';
import { getRoute, listRoutes, saveRoute, disableRoute } from './routes.ts';
import { defaultAcceptanceCriteria } from './acceptance.ts';
import { readTaskCost, recordTaskCost, COST_LIST_SQL } from './task-cost.ts';

export type OwnerVia = string;
export interface OwnerApiContext { db: CompanyDatabase; core: CompanyCore & {
  contributorDryRun(credential: string, input: { taskIds: string[] }): Promise<unknown>;
}; owner: OwnerDesk; workforce: Workforce; messages: OutboundMessageStore; opsRepo: string; upgrades?: { inbox(): Promise<unknown>; setAuto(enabled: boolean, source: string): Promise<unknown>; start(input: { taskId: string; taskVersion: number; digest: string }, source: string): Promise<unknown> } }

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
  const idemp = typeof input.idempotencyKey === 'string' && /^[A-Za-z0-9_:.-]{8,120}$/.test(input.idempotencyKey)
    ? input.idempotencyKey : undefined;
  const key = () => idemp ? `owner:${via}:${command}:${idemp}` : `owner:${via}:${command}:${randomUUID()}`;
  const db = ctx.db.db;
  const ownerCredential = (): string => {
    const token = process.env.SCK_OWNER_TOKEN;
    if (!token) throw new CompanyError('temporarily_unavailable', 'owner token not configured');
    return token;
  };
  switch (command) {
    // ---- 任务 ----
    case 'route.list': return { routes: await listRoutes(db) };
    case 'route.save': {
      const row = await saveRoute(db, {
        type: text(input.type, 'type'), label: text(input.label, 'label'),
        executor_role: text(input.executorRole, 'executorRole') as Role,
        reviewer_role: text(input.reviewerRole, 'reviewerRole') as Role | 'owner',
        code: input.code === true,
        execute_body: optionalText(input.executeBody), review_body: optionalText(input.reviewBody),
        next: optionalText(input.next), hold: input.hold === true, enabled: true,
      }, 'owner');
      return row;
    }
    case 'route.disable': {
      await disableRoute(db, text(input.type, 'type'), 'owner');
      return { disabled: text(input.type, 'type') };
    }
    case 'task.plan': {
      // The whole chain around a task: walk up through parent to the root, then down breadth-first.
      const taskId = text(input.taskId, 'taskId');
      const seen = new Set<string>();
      let cursor: string | undefined = taskId;
      const chainIds: string[] = [];
      while (cursor && !seen.has(cursor) && chainIds.length < 50) {
        seen.add(cursor); chainIds.push(cursor);
        const parentRows: Array<{ parent?: RecordId }> | undefined = (await db.query<[Array<{ parent?: RecordId }>]>('SELECT parent FROM $t;', { t: new RecordId('task', cursor) }))[0];
        cursor = parentRows?.[0]?.parent ? String(parentRows[0].parent.id) : undefined;
      }
      const frontier = [...chainIds];
      for (let i = 0; i < frontier.length && frontier.length < 200; i++) {
        const [children] = await db.query<[Array<{ id: RecordId }>]>(
          'SELECT id FROM task WHERE parent = $p;', { p: new RecordId('task', frontier[i]!) });
        for (const c of children ?? []) { const cid = String(c.id.id); if (!seen.has(cid)) { seen.add(cid); frontier.push(cid); } }
      }
      const [tasks] = await db.query<[unknown[]]>('SELECT * FROM task WHERE id IN $ids ORDER BY created_at;', { ids: frontier.map(t => new RecordId('task', t)) });
      const messages: Record<string, unknown> = {};
      for (const tid of frontier) messages[tid] = await ctx.messages.list(tid);
      return { tasks, messages };
    }
    case 'task.create': {
      const type = optionalText(input.type);
      const requirement = text(input.requirement, 'requirement');
      const acceptanceText = input.acceptanceText ?? input.acceptance_text ?? input.acceptance;
      const ownerCred = ownerCredential();
      if (type) {
        const route = await getRoute(db, type);
        if (!route?.enabled) throw new CompanyError('invalid', `route type ${type} is missing or disabled`);
        const task = await ctx.core.createTask(ownerCred, {
          title: text(input.title, 'title', 3), context: requirement,
          executorRole: route.executor_role, reviewerRole: route.reviewer_role,
          type, parent: optionalText(input.parent),
          requirement, acceptanceText: acceptanceText === undefined ? undefined : text(acceptanceText, 'acceptanceText'),
          project: optionalText(input.project), codeRepoPath: optionalText(input.codeRepoPath),
          tag: optionalText(input.tag), hold: input.hold === true ? true : undefined,
          kind: 'task',
          workIntent: route.code ? { kind: 'code' as const } : undefined,
          idempotencyKey: key(),
        } as never);
        const [planned] = await db.query<[unknown[]]>('SELECT * FROM task WHERE parent = $p AND state = $s;', { p: new RecordId('task', task.id), s: 'planned' });
        return { task, planned: planned ?? [] };
      }
      const requirement2 = requirement;
      const acceptance = text(input.acceptanceText ?? input.acceptance_text ?? input.acceptance, 'acceptanceText');
      const executor = text(input.executorRole, 'executorRole') as Role;
      const reviewer = text(input.reviewerRole, 'reviewerRole') as Role | 'owner';
      if (!ROLES.includes(executor)) throw new CompanyError('invalid', 'unknown executorRole');
      if (reviewer !== 'owner' && !ROLES.includes(reviewer)) throw new CompanyError('invalid', 'unknown reviewerRole');
      const isEngineering = executor === 'engineering';
      const discipline = optionalText(input.discipline) ?? (isEngineering ? undefined : REQUIRED_TRACKS[executor]);
      const codeRepoPath = optionalText(input.codeRepoPath);
      const workIntent = isEngineering && !input.workIntent
        ? { kind: 'code' as const }
        : input.workIntent as CreateTask['workIntent'] | undefined;
      const acceptanceCriteria = isEngineering && !input.acceptanceCriteria
        ? defaultAcceptanceCriteria('deploy')
        : input.acceptanceCriteria as CreateTask['acceptanceCriteria'] | undefined;
      const task = await ctx.core.createTask(ownerCred, {
        title: text(input.title, 'title', 3), context: requirement2,
        executorRole: executor, reviewerRole: reviewer,
        project: optionalText(input.project),
        kind: 'task',
        discipline, codeRepoPath, workIntent, acceptanceCriteria,
        idempotencyKey: key(),
      } as never);
      await db.query('UPDATE ONLY $task SET requirement = $requirement, acceptance_text = $acceptance;',
        { task: new RecordId('task', task.id), requirement: requirement2, acceptance: acceptanceText });
      await ctx.messages.createTaskDrafts(task.id, executor, reviewer, isEngineering);
      return task;
    }
    case 'task.update': {
      const taskId = text(input.taskId, 'taskId');
      const patch: Record<string, string> = {};
      if (input.requirement !== undefined) patch.requirement = text(input.requirement, 'requirement');
      if (input.acceptanceText !== undefined || input.acceptance_text !== undefined || input.acceptance !== undefined) patch.acceptance_text = text(input.acceptanceText ?? input.acceptance_text ?? input.acceptance, 'acceptanceText');
      if (input.title !== undefined) patch.title = text(input.title, 'title', 3);
      if (!Object.keys(patch).length) throw new CompanyError('invalid', 'no fields to update');
      const taskRecord = new RecordId('task', taskId);
      const [rows] = await db.query<[unknown[]]>('UPDATE $task MERGE $patch RETURN AFTER;', { task: taskRecord, patch });
      if (!rows?.length) throw new CompanyError('not_found', 'task not found');
      await db.query("CREATE audit CONTENT { task: $task, actor: $actor, action: 'owner_task_update', evidence: $evidence, at: time::now() };",
        { task: taskRecord, actor: a, evidence: Object.keys(patch).join(', ') });
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
    case 'task.pause': await ctx.owner.setPaused(true); return { paused: true };
    case 'task.resume': await ctx.owner.setPaused(false); return { paused: false };
    case 'task.cost': {
      if (input.taskId !== undefined) {
        const taskId = text(input.taskId, 'taskId');
        const cost = await readTaskCost(db, taskId) ?? await recordTaskCost(db, taskId);
        return { cost: cost ?? null };
      }
      const days = typeof input.days === 'number' && Number.isFinite(input.days) && input.days > 0 ? Math.min(60, input.days) : 7;
      const [rows] = await db.query<[unknown[]]>(COST_LIST_SQL, { span: `${days}d` });
      return { costs: rows };
    }
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
    case 'direction.add':
      await ctx.owner.addDirection({ text: text(input.text, 'text', 2), source: a, key: key() });
      return { ok: true };
    case 'instruct':
      return ctx.owner.instruct({ text: text(input.text, 'text', 2), source: a, key: key() });
    case 'notice.resolve':
      await ctx.owner.resolveNotice(text(input.key, 'key'));
      return { ok: true };
    case 'notice.list':
      return { notices: await ctx.owner.openNotices() };

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
