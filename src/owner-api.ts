import { ownerLangOf, replyTranslationsOf } from './owner-lang.ts';
import { parseWorkHours } from './work-hours.ts';
/**
 * 老板接口：任何持有 owner-token 的 agent 都能调用（网页控制台与 sck owner 共用同一套 JSON 命令）。
 * 所有写操作记 actor=owner 并带 via 标签（请求头 X-Owner-Agent，没有则 web）。
 */
import { LaneNoteStore } from './lane-notes.ts';
import { consolidateAll, consolidateLane, listConsolidations, undoConsolidation } from './lane-notes-consolidate.ts';
import { readProgress } from './task-progress.ts';
import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import { OwnerDesk, withSessionCheck } from './owner.ts';
import type { CompanyCore } from './contracts.ts';
import { preferredProviderValue, Workforce } from './workforce.ts';
import { lanePreferenceValue } from './dispatcher/lane-preference.ts';
import { OutboundMessageStore, type OutboundMessage } from './outbound-messages.ts';
import { bodyOfDispatch } from './outbound-render.ts';
import { turnAnalysesOf } from './turn-analysis.ts';
import { findingsFileOf, readBoard, readBoardView, renderContextFor } from './board.ts';
import { CompanyError } from './core-errors.ts';
import { ROLES, type CreateTask, type Role } from './contracts.ts';
import { HASH, REQUIRED_TRACKS } from './core.ts';
import { DEFAULT_FAULT_BUDGET } from './faults.ts';
import { FaultGrantRefusal, FaultStore, type FaultRecoveryGrantReceipt } from './fault-store.ts';
import { getRoute, listRoutes, saveRoute, disableRoute } from './routes.ts';
import { defaultAcceptanceCriteria } from './acceptance.ts';
import { readTaskCost, COST_LIST_SQL } from './task-cost.ts';
import { QUOTA_ROWS } from './dispatcher/quota-store.ts';
import { hostIOOrUndefined } from './host-io.ts';
import { planMessage, readMessageChains } from './message-chain.ts';
import type { AgentAction, AgentActivity } from './agent-activity.ts';
import { redactSecrets } from './ops/redact.ts';
import { COMPANY_LANDSCAPE } from './landscape.ts';
import { observationRecordId } from './landscape-report.ts';
import type { NodeSteward } from './steward/steward.ts';

export type OwnerVia = string;
export interface OwnerApiContext { db: CompanyDatabase; core: CompanyCore & {
  contributorDryRun(credential: string, input: { taskIds: string[] }): Promise<unknown>;
}; owner: OwnerDesk; workforce: Workforce; messages: OutboundMessageStore; opsRepo: string;
  steward?: Pick<NodeSteward, 'draft'> }

const actor = (via: string) => `owner:${via || 'web'}`;
const text = (value: unknown, field: string, min = 1, max = 20000): string => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new CompanyError('invalid', `${field} invalid`);
  return value.trim();
};
const optionalText = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
/** 正文校验与其他文本相同，但不裁掉老板有意保留的空格、缩进和换行。 */
const messageText = (value: unknown, field: string): string => {
  text(value, field);
  return value as string;
};
const strArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * Commands that act on the machine they run on: task.create signs the new task with the owner's credential (SCK_OWNER_TOKEN), which only the local owner process holds.
 * A process without an execution host (a Worker, for one) answers them with CompanyError('unavailable'); the owner gateway
 * queues them as ops_job records for the execution end instead.
 */
export const RUNNER_ONLY_COMMANDS: ReadonlySet<string> = new Set(['task.create', 'message.draft']);

async function rememberStyle(ctx: OwnerApiContext, before: OutboundMessage, after: OutboundMessage): Promise<void> {
  if (before.body === after.body) return;
  try {
    const [rows] = await ctx.db.db.query<[Array<{ project?: unknown }>]>(
      'SELECT project FROM $task;', { task: new RecordId('task', after.taskId) });
    await ctx.db.db.query(`CREATE owner_style_memory CONTENT {
      task: $task, project: $project, step: $step, before_body: $before_body, after_body: $after_body, at: time::now()
    };`, {
      task: new RecordId('task', after.taskId),
      project: rows?.[0]?.project == null ? undefined : redactSecrets(String(rows[0].project)), step: after.step,
      before_body: redactSecrets(before.body), after_body: redactSecrets(after.body),
    });
  } catch { console.warn('owner_style_memory write failed'); }
}

async function editMessage(ctx: OwnerApiContext, id: string, body: string, actor: string, expected?: string): Promise<OutboundMessage> {
  const before = await ctx.messages.get(id);
  if (!before) throw new CompanyError('not_found', 'message not found');
  const after = await ctx.messages.edit(id, body, actor, expected ?? before.body);
  await rememberStyle(ctx, before, after);
  return after;
}

/**
 * The owner edits the text an employee would receive: the board's outbox text, which is the stored body rendered with that employee's
 * paths. Owner edits are literal, even when a path cannot be reversed to a placeholder.
 * The workdir line belongs to the claim and is not part of the edit.
 */
async function editRenderedMessage(ctx: OwnerApiContext,
  input: { messageId: string; employeeId: string; rendered: string; actor: string }): Promise<OutboundMessage> {
  const message = await ctx.messages.get(input.messageId);
  if (!message) throw new CompanyError('not_found', 'message not found');
  if (message.state === 'sent') throw new CompanyError('conflict', 'conflict: message already sent');
  const db = ctx.db.db;
  const task = new RecordId('task', message.taskId);
  const [rows] = await db.query<[Array<{ acceptance_criteria?: unknown }>]>('SELECT acceptance_criteria FROM $task;', { task });
  if (!rows?.[0]) throw new CompanyError('not_found', 'task not found');
  // The board shows only the draft of the step the next dispatch sends; an older step's draft is not what the employee would read.
  const next = await ctx.messages.nextStep(message.taskId);
  if (next !== message.step) throw new CompanyError('conflict', 'conflict: message is not the next one of its task');
  const view = await readBoardView(db);
  if (!view) throw new CompanyError('temporarily_unavailable', 'temporarily_unavailable: owner board not written yet');
  const renderCtx = renderContextFor(view, input.employeeId, { taskId: message.taskId, step: message.step,
    acceptanceCriteria: rows[0].acceptance_criteria, findingsFile: await findingsFileOf(db, task) });
  if (!renderCtx) throw new CompanyError('not_found', 'employee not found on the owner board');
  // 只有未编辑模板才替换路径；老板改过的正文按原文存储和投递，不要求能逆向还原占位符。
  const stripped = bodyOfDispatch(input.rendered);
  if (!stripped.trim()) throw new CompanyError('invalid', 'rendered text invalid: 正文不能为空');
  return editMessage(ctx, input.messageId, stripped, input.actor, message.body);
}

/** Every command is a flat JSON object: { command, ...args }. */
/**
 * 收回租约，并给持有它的员工记一个“停掉会话”的请求：老板端碰不到执行端的进程，执行端按独立计时器（15 秒）读到请求后停掉正在跑的会话
 *（runner/dispatch.ts 的 stopRequested）。不记这个请求的话，租约收回了，会话还会跑到自己结束。
 */
async function stopTask(ctx: OwnerApiContext, db: import('surrealdb').Surreal, taskId: string, note: string, actor: string): Promise<{ ok: boolean; employee?: string }> {
  const result = await ctx.workforce.revokeTaskLease(taskId, note, '【交接包】老板终止了上一棒的在途执行。', actor);
  if (result.ok && result.employee) {
    await db.query('UPDATE $employee SET stop_requested = { task: $task, at: time::now() };', { employee: new RecordId('employee', result.employee), task: taskId })
      .catch(error => console.warn(`stop request not recorded for ${result.employee}: ${(error as Error).message}`));
  }
  return result;
}

/** 一张任务各轮的动作记录，按开始时间排。只带动作与状态，不带输出文本。 */
export async function taskTurns(db: import('surrealdb').Surreal, taskId: string): Promise<Array<{ employee: string; runtime: string; state: string; startedAt: number; lastActivityAt: number;
  actions: AgentAction[]; actionsDropped?: number }>> {
  const [rows] = await db.query<[Array<{ employee?: string; activity?: Partial<AgentActivity> }>]>(
    'SELECT employee, activity FROM agent_activity WHERE task = $task AND expires_at > time::now() LIMIT 100;', { task: new RecordId('task', taskId) });
  return (rows ?? []).filter(row => row.activity).map(row => ({
    employee: String(row.employee ?? ''), runtime: String(row.activity!.runtime ?? 'native'), state: String(row.activity!.state ?? ''),
    startedAt: Number(row.activity!.startedAt ?? 0), lastActivityAt: Number(row.activity!.lastActivityAt ?? 0),
    actions: Array.isArray(row.activity!.actions) ? row.activity!.actions : [],
    ...(row.activity!.actionsDropped ? { actionsDropped: row.activity!.actionsDropped } : {}),
  })).sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * The owner's receipt of a recovery grant: what was granted, whether this request only replayed it, and where the window
 * opens. The window is not opened by the grant; the employee's next real attempt opens it.
 */
function faultGrantReceipt(receipt: FaultRecoveryGrantReceipt): unknown {
  return {
    replayed: receipt.replayed,
    grant: receipt.grant,
    window: {
      maxAttempts: DEFAULT_FAULT_BUDGET.maxAttempts,
      totalDeadlineMs: DEFAULT_FAULT_BUDGET.totalDeadlineMs,
      opensAt: '员工的下一次真实恢复尝试消费授权时开始计时',
    },
    next: '员工重新领取任务后的下一次真实尝试即消费本授权。窗口内仍失败而耗尽时，同一事件不再授权，只能走修复链。',
  };
}

/**
 * One task as the owner reads it: the row, its audit and messages, and what the board needs to show them. A missing row is not_found
 * here; withSessionCheck decides whether that absence can be trusted.
 */
async function taskDetail(db: import('surrealdb').Surreal, taskId: string): Promise<unknown> {
  const [rows] = await db.query<[Array<Record<string, unknown>>]>('SELECT * FROM $task;', { task: new RecordId('task', taskId) });
  if (!rows?.length) throw new CompanyError('not_found', 'task not found');
  const [audit] = await db.query<[unknown[]]>('SELECT * FROM audit WHERE task = $task ORDER BY at;', { task: new RecordId('task', taskId) });
  const [messages] = await db.query<[unknown[]]>('SELECT * FROM outbound_message WHERE task = $task ORDER BY created_at;', { task: new RecordId('task', taskId) });
  // 员工回报的译文（audit 编号 → 老板常用语言的译文）；没有译文的回报照原文显示。
  const translations = Object.fromEntries(await replyTranslationsOf(db,
    (audit ?? []) as Array<{ id?: unknown; evidence?: unknown; action?: unknown }>, await ownerLangOf(db)));
  // 完工分析（审计编号 → 分析）：只展示，不参与派工。
  const analyses = await turnAnalysesOf(db, (audit ?? []) as Array<{ id?: unknown }>).catch(() => ({}));
  // 动作记录：每一轮里员工做了什么（一行一个动作），保留 7 天。读不出不影响任务详情。
  const turns = await taskTurns(db, taskId).catch(() => []);
  return { task: rows[0], audit, messages, translations, analyses, turns };
}

export async function ownerApi(ctx: OwnerApiContext, input: Record<string, unknown>, via: OwnerVia): Promise<unknown> {
  const command = String(input.command ?? '');
  if (RUNNER_ONLY_COMMANDS.has(command) && hostIOOrUndefined() === undefined) {
    throw new CompanyError('unavailable', `${command} 需要执行端（本机服务或 owner CLI），当前运行环境没有本机宿主`);
  }
  const a = actor(via);
  const idemp = typeof input.idempotencyKey === 'string' && /^[A-Za-z0-9_:.-]{8,120}$/.test(input.idempotencyKey)
    ? input.idempotencyKey : undefined;
  const key = () => idemp ? `owner:${via}:${command}:${idemp}` : `owner:${via}:${command}:${randomUUID()}`;
  const db = ctx.db.db;
  const notes = () => new LaneNoteStore(db);
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
      const resources = optionalText(input.resources);
      const ownerCred = ownerCredential();
      if (type) {
        const route = await getRoute(db, type);
        if (!route?.enabled) throw new CompanyError('invalid', `route type ${type} is missing or disabled`);
        const task = await ctx.core.createTask(ownerCred, {
          title: text(input.title, 'title', 3), context: requirement,
          executorRole: route.executor_role, reviewerRole: route.reviewer_role,
          type, parent: optionalText(input.parent),
          requirement, resources, acceptanceText: acceptanceText === undefined ? undefined : text(acceptanceText, 'acceptanceText'),
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
      // deploy 模板（CI + QA 生产签署）只给代码工作；只读巡检等非代码的工程任务走默认的老板签署。
      const acceptanceCriteria = isEngineering && workIntent?.kind === 'code' && !input.acceptanceCriteria
        ? defaultAcceptanceCriteria('deploy')
        : input.acceptanceCriteria as CreateTask['acceptanceCriteria'] | undefined;
      const task = await ctx.core.createTask(ownerCred, {
        title: text(input.title, 'title', 3), context: requirement2,
        executorRole: executor, reviewerRole: reviewer,
        project: optionalText(input.project),
        kind: 'task',
        discipline, codeRepoPath, workIntent, acceptanceCriteria,
        hold: input.hold === true ? true : undefined,
        idempotencyKey: key(),
      } as never);
      await db.query('UPDATE ONLY $task SET requirement = $requirement, acceptance_text = $acceptance, resources = $resources;',
        { task: new RecordId('task', task.id), requirement: requirement2, acceptance: acceptanceText, resources });
      const drafts = await ctx.messages.createTaskDrafts(task.id, executor, reviewer, isEngineering);
      // 扣住 = 扣住派工消息（调度器派工前核对 isHeld）；与按路线建单的 hold 语义一致。
      if (input.hold === true) for (const draft of drafts) await ctx.messages.setHold(draft.id, true, 'owner');
      return task;
    }
    case 'task.update': {
      const taskId = text(input.taskId, 'taskId');
      const patch: Record<string, string> = {};
      if (input.requirement !== undefined) patch.requirement = text(input.requirement, 'requirement');
      if (input.acceptanceText !== undefined || input.acceptance_text !== undefined || input.acceptance !== undefined) patch.acceptance_text = text(input.acceptanceText ?? input.acceptance_text ?? input.acceptance, 'acceptanceText');
      if (input.title !== undefined) patch.title = text(input.title, 'title', 3);
      // 可以用什么可以清空：空串即没有额外资源。
      if (input.resources !== undefined) patch.resources = typeof input.resources === 'string' ? input.resources.trim() : text(input.resources, 'resources');
      if (!Object.keys(patch).length) throw new CompanyError('invalid', 'no fields to update');
      const taskRecord = new RecordId('task', taskId);
      const [rows] = await db.query<[unknown[]]>('UPDATE $task MERGE $patch RETURN AFTER;', { task: taskRecord, patch });
      if (!rows?.length) throw new CompanyError('not_found', 'task not found');
      await db.query("CREATE audit CONTENT { task: $task, actor: $actor, action: 'owner_task_update', evidence: $evidence, at: time::now() };",
        { task: taskRecord, actor: a, evidence: Object.keys(patch).join(', ') });
      // 任务卡是事实来源：还没发出、老板没改过的派工草稿跟着重算。
      // 重算失败不能让已经落库并写了审计的任务修改报错：记日志，草稿留到重派时按任务卡重新组装。
      await ctx.messages.refreshDrafts(taskId).catch(error => console.warn(`draft refresh failed for ${taskId}: ${(error as Error).message}`));
      return rows[0];
    }
    case 'task.delete': return ctx.owner.retire({ taskId: text(input.taskId, 'taskId'), note: text(input.note, 'note', 2), source: a, key: key() });
    case 'task.detail': {
      const taskId = text(input.taskId, 'taskId');
      return withSessionCheck(ctx.db, () => taskDetail(db, taskId));
    }
    case 'progress': return readProgress(db);
    case 'task.list': { const [rows] = await db.query<[unknown[]]>('SELECT * FROM task ORDER BY created_at DESC LIMIT 300;'); return { tasks: rows }; }
    case 'task.reassign': return ctx.owner.reassign({ taskId: text(input.taskId, 'taskId'),
      executorRole: optionalText(input.executorRole) as Role | undefined,
      reviewerRole: optionalText(input.reviewerRole) as Role | 'owner' | undefined,
      note: text(input.note, 'note'), source: a, key: key() });
    case 'task.void': return ctx.owner.retire({ taskId: text(input.taskId, 'taskId'), note: text(input.note, 'note', 2), source: a, key: key() });
    case 'task.revoke': return stopTask(ctx, db, text(input.taskId, 'taskId'), text(input.note ?? '老板终止在途执行', 'note'), a);
    // 中止这一轮：收回租约并让执行端停掉正在跑的会话；任务回到队列，下一次派工带上交接。hold=true 即暂停：下一条消息先扣住，放行才继续。
    case 'task.stop': {
      const taskId = text(input.taskId, 'taskId');
      // 暂停先扣住下一条消息再收回租约：反过来的话，两步之间的一次派工循环会把任务不带扣住地重新派出去。
      const held = input.hold === true ? (await ctx.messages.holdNext(taskId, a)).id : undefined;
      const stopped = await stopTask(ctx, db, taskId, text(input.note ?? (input.hold === true ? '老板暂停了任务' : '老板中止了这一轮'), 'note'), a);
      if (!stopped.ok && input.hold !== true) throw new CompanyError('conflict', '任务当前没有在途执行');
      return { ...stopped, ...(held ? { heldMessage: held } : {}) };
    }
    // 插话：老板的话随这张任务的下一条消息带给员工。interrupt=true 时同时中止这一轮，带着这句话立刻重派。
    case 'task.interject': {
      const taskId = text(input.taskId, 'taskId');
      await ctx.messages.addNote(taskId, text(input.text, 'text', 2, 4000), a);
      const stopped = input.interrupt === true ? await stopTask(ctx, db, taskId, '老板插话并要求立即按新要求重做', a) : { ok: false };
      return { ok: true, interrupted: stopped.ok };
    }
    case 'task.pause': await ctx.owner.setPaused(true); return { paused: true };
    case 'task.resume': await ctx.owner.setPaused(false); return { paused: false };
    case 'task.cost': {
      if (input.taskId !== undefined) {
        const taskId = text(input.taskId, 'taskId');
        // Read only: settlement runs in the dispatch pass, which holds the magpie reader.
        const cost = await readTaskCost(db, taskId);
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
    case 'inbox': return ctx.owner.inbox();
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

    // ---- 公司服务全景 ----
    // 登记表 + 最近一次实机核对（company_meta:⟨landscape_observed:<hostId>⟩）。host 过滤只看该主机的服务与观测。
    case 'landscape.get': {
      const host = optionalText(input.host);
      if (host && !COMPANY_LANDSCAPE.hosts.some((item) => item.id === host)) {
        throw new CompanyError('invalid', `host invalid: ${host}`);
      }
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        'SELECT * FROM company_meta WHERE id IN $ids;',
        { ids: COMPANY_LANDSCAPE.hosts.map((item) => observationRecordId(item.id)) });
      const observations = (rows ?? []).filter((row) => !host || row.host === host);
      return {
        landscape: host
          ? { ...COMPANY_LANDSCAPE, services: COMPANY_LANDSCAPE.services.filter((service) => service.host === host) }
          : COMPANY_LANDSCAPE,
        observations,
      };
    }

    // ---- 故障恢复授权 ----
    // 给一条已耗尽的恢复预算授权一次新窗口。授权只记下决定，预算不动：窗口在员工的下一次真实尝试消费授权时才开始。
    case 'fault.grant': {
      const idempotencyKey = input.idempotencyKey;
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_:.-]{8,120}$/.test(idempotencyKey)) {
        throw new CompanyError('invalid', 'idempotencyKey invalid: 8-120 characters of letters, digits, _ : . -');
      }
      const grantInput = {
        taskId: text(input.taskId, 'taskId'), target: text(input.target, 'target'), phase: text(input.phase, 'phase'),
        incident: text(input.incident, 'incident', 1, 500), evidence: text(input.note, 'note', 2, 2000),
      };
      try {
        return faultGrantReceipt(await new FaultStore(db).grantRecovery({
          ...grantInput, now: Date.now(), limits: DEFAULT_FAULT_BUDGET, grantedBy: a, idempotencyKey,
          payloadDigest: HASH(JSON.stringify(grantInput)),
        }));
      } catch (error) {
        if (error instanceof FaultGrantRefusal) {
          throw new CompanyError(error.reason === 'not_found' ? 'not_found' : 'conflict', error.message);
        }
        throw error;
      }
    }

    // ---- 待发消息 ----
    case 'message.list': return { messages: await ctx.messages.list(optionalText(input.taskId), input.includeSent !== false) };
    case 'message.edit': return editMessage(ctx, text(input.messageId, 'messageId'), bodyOfDispatch(messageText(input.body, 'body')), a,
      typeof input.expectedBody === 'string' ? input.expectedBody : undefined);
    case 'message.draft': {
      const taskId = text(input.taskId, 'taskId');
      const step = optionalText(input.step) ?? await ctx.messages.nextStep(taskId);
      if (!step || !['execute', 'review', 'rework', 'nudge', 'notice'].includes(step))
        throw new CompanyError('invalid', 'step invalid');
      const draft = await ctx.messages.latestDraft(taskId, step as OutboundMessage['step']);
      if (!draft || draft.state === 'sent') throw new CompanyError('not_found', 'unsent draft not found');
      const [tasks] = await db.query<[Array<Record<string, unknown>>]>(
        'SELECT title, requirement, resources, acceptance_text, project, discipline FROM $task;', { task: new RecordId('task', taskId) });
      if (!tasks?.[0]) throw new CompanyError('not_found', 'task not found');
      const [samples] = await db.query<[unknown[]]>(
        'SELECT before_body, after_body, at FROM owner_style_memory ORDER BY at DESC LIMIT 5;');
      const styleSamples = (samples ?? []).slice(0, 5);
      const steward = ctx.steward;
      if (!steward) throw new CompanyError('unavailable', 'NodeSteward 需要执行端');
      const body = await steward.draft({ task: redactSecrets(tasks[0]) as Record<string, unknown>, step,
        channel: optionalText(input.channel), styleSamples: redactSecrets(styleSamples) as unknown[] });
      if (!body) throw new CompanyError('temporarily_unavailable', 'NodeSteward 无法安全起草，请稍后重试');
      // 起草不是老板改稿，不能把模型自己的输出学成老板偏好；edit 不改变 hold/state。
      const message = await ctx.messages.edit(draft.id, messageText(body, 'draft'), a, draft.body);
      return { message, styleSamplesUsed: styleSamples.length };
    }
    case 'message.hold': return ctx.messages.setHold(text(input.messageId, 'messageId'), true, a);
    case 'message.release': return ctx.messages.setHold(text(input.messageId, 'messageId'), false, a);
    case 'message.send': {
      // 放行：清 hold 后由调度器在下一轮实际派工（正文仍来自表里）。
      return ctx.messages.setHold(text(input.messageId, 'messageId'), false, a);
    }
    case 'message.chains': return { chains: await readMessageChains(db) };
    case 'message.plan': {
      const step = text(input.step, 'step');
      if (step !== 'execute' && step !== 'review') throw new CompanyError('invalid', 'step 只能是 execute 或 review');
      if (input.body !== undefined && input.body !== null && (typeof input.body !== 'string' || input.body.length > 20000)) throw new CompanyError('invalid', '正文无效或过长');
      return planMessage(db, { requirement: text(input.requirement, 'requirement'), revision: Number(input.revision), index: Number(input.index), step,
        ...(input.body !== undefined ? { body: input.body as string | null } : {}), ...(typeof input.hold === 'boolean' ? { hold: input.hold } : {}) }, a);
    }
    case 'message.records': {
      const [rows] = await db.query<[unknown[]]>("SELECT * FROM outbound_message WHERE state = 'sent' ORDER BY sent_at DESC LIMIT 300;");
      return { records: rows };
    }

    case 'message.edit_rendered': return editRenderedMessage(ctx, { messageId: text(input.messageId, 'messageId'),
      employeeId: text(input.employeeId, 'employeeId'), rendered: messageText(input.rendered, 'rendered'), actor: a });

    // ---- 老板看板 ----
    case 'board.snapshot': return readBoard(db, { now: typeof input.now === 'number' ? input.now : undefined });

    // ---- 编制 ----
    // ---- 线的笔记 ----
    case 'note.list': return { notes: await notes().list(optionalText(input.lane)) };
    case 'note.preview': { const lane = text(input.lane, 'lane'); return { lane, text: await notes().render(lane) }; }
    case 'note.add': return notes().add(text(input.lane, 'lane'), text(input.text, 'text', 1, 2000), a, { pinned: input.pinned === true, proposed: input.proposed === true });
    case 'note.edit': return notes().edit(text(input.noteId, 'noteId'), text(input.text, 'text', 1, 2000));
    case 'note.pin': return notes().pin(text(input.noteId, 'noteId'), input.pinned === true);
    case 'note.activate': return notes().activate(text(input.noteId, 'noteId'));
    case 'note.remove': await notes().remove(text(input.noteId, 'noteId')); return { removed: true };
    // No rewrite here: the command and the daily pass only merge and age out, keeping the newest original text.
    // dryRun returns the plan without writing anything.
    case 'note.consolidate': {
      const options = { now: new Date(), actor: a, dryRun: input.dryRun === true };
      const lane = optionalText(input.lane);
      return lane ? consolidateLane(db, lane, options) : consolidateAll(db, options);
    }
    case 'note.consolidations': return { consolidations: await listConsolidations(db, typeof input.limit === 'number' ? input.limit : undefined) };
    case 'note.consolidation.undo': return undoConsolidation(db, text(input.id, 'id', 1, 200), a);
    // ---- 优先订阅 ----
    case 'dispatch.preference': {
      if (input.provider !== undefined) {
        const provider = preferredProviderValue(input.provider);
        await db.query('UPSERT company_meta:config MERGE $patch;', { patch: { preferred_provider: provider } });
        await db.query("CREATE audit CONTENT { actor: $actor, action: 'owner_dispatch_preference', evidence: $evidence, at: time::now() };",
          { actor: a, evidence: `preferred_provider=${input.provider === '' ? '（不设优先）' : input.provider}` });
      }
      if (input.lanePreference !== undefined) {
        const lanePreference = lanePreferenceValue(input.lanePreference);
        // 整份替换：MERGE 会把对象逐键合并，传 {} 清不掉已有的键（0.13.23 生产实测清不掉）。
        await db.query('UPSERT company_meta:config SET lane_preference = $value;', { value: lanePreference });
        await db.query("CREATE audit CONTENT { actor: $actor, action: 'owner_dispatch_preference', evidence: $evidence, at: time::now() };",
          { actor: a, evidence: `lane_preference=${JSON.stringify(lanePreference).slice(0, 900)}` });
      }
      const config = await ctx.workforce.config();
      return { preferredProvider: config.preferredProvider, lanePreference: config.lanePreference };
    }
    // ---- 会话策略 ----
    case 'session.policy': {
      if (input.policy !== undefined) {
        if (input.policy !== 'reuse' && input.policy !== 'oneshot') throw new CompanyError('invalid', 'policy must be reuse or oneshot');
        await db.query('UPSERT company_meta:config MERGE $patch;', { patch: { session_policy: input.policy } });
      }
      return { policy: (await ctx.workforce.config()).sessionPolicy };
    }
    // 老板端看全量编制：defs() 被 company.ts 按路由过滤后只剩本端可见的 provider。
    case 'def.list': return { defs: await ctx.workforce.allDefs() };
    case 'quota.list': {
      // 与 quota-store 同一谓词：连字符 provider 的 id 打印为 company_meta:⟨quota_codex-cloud⟩，
      // 对整行字符串做前缀测试会漏掉这些行，必须只取记录名比较。
      const [quotas] = await db.query<[unknown[]]>(`SELECT * FROM company_meta WHERE ${QUOTA_ROWS};`);
      const [exhausted] = await db.query<[unknown[]]>(
        `SELECT * FROM provider_health WHERE state = 'exhausted';`);
      return { quotas: quotas ?? [], exhausted: exhausted ?? [] };
    }
    case 'def.ensure': {
      const defId = text(input.id, 'id');
      const role = text(input.role, 'role') as Role;
      if (!ROLES.includes(role)) throw new CompanyError('invalid', 'unknown role');
      // 修改已有定义时，没有给出的字段保持原值（thinking 传 null 才清空）；启用状态只经 enabled 或 def.enable/def.disable 改变。
      const existing = (await ctx.workforce.allDefs()).find((def) => def.id === defId);
      const count = (value: unknown, field: string): number | undefined => {
        if (value === undefined) return undefined;
        if (typeof value !== 'number' || !Number.isInteger(value)) throw new CompanyError('invalid', `${field} invalid`);
        return value;
      };
      const tracks = input.tracks === undefined ? undefined
        : Array.isArray(input.tracks) && input.tracks.length <= 50 && input.tracks.every((item) => typeof item === 'string' && item.trim() && item.length <= 40)
          ? (input.tracks as string[]).map((item) => item.trim())
          : (() => { throw new CompanyError('invalid', 'tracks invalid'); })();
      if (input.quotaLimited !== undefined && typeof input.quotaLimited !== 'boolean') throw new CompanyError('invalid', 'quotaLimited invalid');
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new CompanyError('invalid', 'enabled invalid');
      const workHours = input.workHours === undefined || input.workHours === null ? input.workHours as undefined | null
        : parseWorkHours(input.workHours) ?? (() => { throw new CompanyError('invalid', 'workHours invalid'); })();
      const def = await ctx.workforce.upsertDef(defId, { role, provider: text(input.provider, 'provider'),
        model: text(input.model, 'model'),
        thinking: input.thinking === null ? undefined : optionalText(input.thinking) ?? existing?.thinking,
        maxInstances: count(input.maxInstances, 'maxInstances') ?? existing?.maxInstances,
        priority: count(input.priority, 'priority') ?? existing?.priority,
        weight: count(input.weight, 'weight') ?? existing?.weight,
        enabled: typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true,
        tracks, quotaLimited: input.quotaLimited as boolean | undefined, workHours });
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
