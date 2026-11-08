/** 待发消息表：建单时为执行岗与复核岗各生成一条 draft；返工/催办在触发时生成。 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { machineCriterionOf, routeBody, stepOfTask, templateFor, type MessageStep } from './outbound-render.ts';
import { deliveryBody } from './outbound-delivery.ts';
export { DEFAULT_MACHINE_CRITERION, renderMessage, templateFor } from './outbound-render.ts';

export type { MessageStep } from './outbound-render.ts';
export type MessageState = 'draft' | 'held' | 'sent';

export interface OutboundMessage {
  id: string;
  taskId: string;
  step: MessageStep;
  role: string;
  body: string;
  state: MessageState;
  hold: boolean;
  editedBy?: string;
  editedAt?: string;
  sentTo?: string;
  sentAt?: string;
  createdAt: string;
  /** 原文语言；缺失或空表示中文原文。 */
  lang?: string;
  /** 译文；与 translatedFromHash 一致时才投递。 */
  translatedText?: string;
  /** 译文对应原文的哈希，用于识别过期译文。 */
  translatedFromHash?: string;
  translatedAt?: string;
}

const STEPS: readonly MessageStep[] = ['execute', 'review', 'rework', 'nudge', 'eval', 'notice'];

/** A record id's key; a plain value stands for itself. */
const keyOf = (value: unknown): string => String((value as RecordId | undefined)?.id ?? value ?? '');

const rowView = (row: Record<string, unknown>): OutboundMessage => ({
  id: String((row.id as RecordId).id ?? row.id), taskId: String((row.task as RecordId)?.id ?? row.task ?? ''),
  step: String(row.step) as MessageStep, role: String(row.role ?? ''), body: String(row.body ?? ''),
  state: (String(row.state ?? 'draft')) as MessageState, hold: row.hold === true,
  editedBy: row.edited_by === undefined || row.edited_by === null ? undefined : String(row.edited_by),
  editedAt: row.edited_at === undefined || row.edited_at === null ? undefined : String(row.edited_at),
  sentTo: row.sent_to === undefined || row.sent_to === null ? undefined : String(row.sent_to),
  sentAt: row.sent_at === undefined || row.sent_at === null ? undefined : String(row.sent_at),
  createdAt: String(row.created_at ?? ''),
  lang: optionalText(row.lang), translatedText: optionalText(row.translated_text),
  translatedFromHash: optionalText(row.translated_from_hash), translatedAt: optionalText(row.translated_at),
});

/** 可选字段：缺失（未定义、NONE 即 null）读作 undefined。 */
const optionalText = (value: unknown): string | undefined => value === undefined || value === null ? undefined : String(value);

/** 按翻译规则选出投递正文；null 表示暂不投递。投递的消息记录带上所选文本。 */
const deliverable = (message: OutboundMessage, employeeId: string): { body: string; message: OutboundMessage } | null => {
  const body = deliveryBody(message);
  if (body === null) return null;
  return { body, message: { ...message, body, sentTo: employeeId } };
};

export class OutboundMessageStore {
  constructor(private readonly db: Surreal) {}
  private task(taskId: string) { return new RecordId('task', taskId); }
  private message(messageId: string) { return new RecordId('outbound_message', messageId); }

  async createDraft(taskId: string, step: MessageStep, role: string, code = false, phase = 'doing', body?: string): Promise<OutboundMessage> {
    if (!STEPS.includes(step)) throw new CompanyError('invalid', `unknown message step ${step}`);
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `CREATE outbound_message CONTENT { task: $task, step: $step, role: $role, body: $body,
        state: 'draft', hold: false, created_at: time::now() } RETURN AFTER;`,
      { task: this.task(taskId), step, role, body: body ?? templateFor(step, code, phase) });
    return rowView(rows[0]!);
  }

  /** 建任务时为执行岗与复核岗各生成一条 draft；幂等：已有 draft 不重复生成。 */
  async createTaskDrafts(taskId: string, executorRole: string, reviewerRole: string, code: boolean,
    bodies: { execute?: string; review?: string } = {}): Promise<OutboundMessage[]> {
    const [existing] = await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT * FROM outbound_message WHERE task = $task AND step IN ['execute','review'] AND state != 'sent' ORDER BY created_at;`,
      { task: this.task(taskId) });
    const have = new Set((existing ?? []).map(row => String(row.step)));
    const out: OutboundMessage[] = [];
    if (!have.has('execute')) out.push(await this.createDraft(taskId, 'execute', executorRole, code, 'doing', routeBody(bodies.execute)));
    // 复核草稿与执行草稿用同一个 code 标记：软件线的复核才需要写明最终合入提交与不检查生产版本。
    if (!have.has('review')) out.push(await this.createDraft(taskId, 'review', reviewerRole, code, 'review', routeBody(bodies.review)));
    return out;
  }

  async list(taskId?: string, includeSent = true): Promise<OutboundMessage[]> {
    const [rows] = taskId
      ? await this.db.query<[Array<Record<string, unknown>>]>(
        `SELECT * FROM outbound_message WHERE task = $task ${includeSent ? '' : "AND state != 'sent'"} ORDER BY created_at;`, { task: this.task(taskId) })
      : await this.db.query<[Array<Record<string, unknown>>]>(
        `SELECT * FROM outbound_message ${includeSent ? '' : "WHERE state != 'sent'"} ORDER BY created_at DESC LIMIT 300;`);
    return (rows ?? []).map(rowView);
  }

  /** One message by id, whatever its state. */
  async get(messageId: string): Promise<OutboundMessage | undefined> {
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>('SELECT * FROM $msg;', { msg: this.message(messageId) });
    return rows?.[0] ? rowView(rows[0]) : undefined;
  }

  /** 最新 draft：同一任务同一步骤可有多条编辑草稿，发送只认最新的一条。 */
  async latestDraft(taskId: string, step: MessageStep): Promise<OutboundMessage | undefined> {
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT * FROM outbound_message WHERE task = $task AND step = $step AND state != 'sent' ORDER BY created_at DESC LIMIT 1;`,
      { task: this.task(taskId), step });
    return rows?.[0] ? rowView(rows[0]) : undefined;
  }

  /** The id of the first required machine criterion of this task; the dispatch message names it to the executor. */
  async machineCriterionId(taskId: string): Promise<string> {
    const [rows] = await this.db.query<[Array<{ acceptance_criteria?: unknown }>]>(
      'SELECT acceptance_criteria FROM $task;', { task: this.task(taskId) });
    return machineCriterionOf(rows?.[0]?.acceptance_criteria);
  }

  /** The next step of an unfinished task: the phase plus the audit's last return decides which draft applies. */
  async nextStep(taskId: string): Promise<MessageStep> {
    const [row, returns] = await Promise.all([
      this.db.query<[Array<{ state: string }>]>('SELECT state FROM $task;', { task: this.task(taskId) }).then(r => r[0]),
      this.db.query<[Array<{ id: unknown }>]>(
        "SELECT id, at FROM audit WHERE task = $task AND action IN ['return','owner_reject'] ORDER BY at DESC LIMIT 1;", { task: this.task(taskId) }).then(r => r[0]),
    ]);
    return stepOfTask(row?.[0]?.state, (returns?.length ?? 0) > 0);
  }

  /** Whether the next dispatch of this task is held by the owner. Checks a draft and, absent one, what prepareSend would create. */
  async isHeld(taskId: string, step: MessageStep): Promise<boolean> {
    const draft = await this.latestDraft(taskId, step);
    if (draft) return draft.hold || draft.state === 'held';
    return false;
  }

  /** Public send path for the eval dispatch: marks the table row sent only after the external send succeeded. */
  async sendPrepared(prepared: { body: string; message: OutboundMessage }): Promise<void> {
    await this.markSent(prepared.message.id, prepared.message.sentTo ?? '', prepared.body);
  }

  async edit(messageId: string, body: string, actor: string): Promise<OutboundMessage> {
    if (!body.trim()) throw new CompanyError('invalid', 'message body must not be empty');
    const msg = this.message(messageId);
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `UPDATE $msg SET body = $body, edited_by = $actor, edited_at = time::now() WHERE state != 'sent' RETURN AFTER;`,
      { msg, body, actor });
    const row = rows?.[0];
    if (!row) throw await this.refusal(msg);
    return rowView(row);
  }

  async setHold(messageId: string, hold: boolean, actor: string): Promise<OutboundMessage> {
    const msg = this.message(messageId);
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `UPDATE $msg SET hold = $hold, state = IF $hold THEN 'held' ELSE 'draft' END,
        edited_by = $actor, edited_at = time::now() WHERE state != 'sent' RETURN AFTER;`,
      { msg, hold, actor });
    const row = rows?.[0];
    if (!row) throw await this.refusal(msg);
    // A released message has been waiting in the owner inbox; close the notice in the same command.
    if (!hold) await this.resolveHoldNotice(row.task, row.step);
    return rowView(row);
  }

  /** The guarded UPDATE matched nothing: a sent message is locked, anything else does not exist. */
  private async refusal(msg: RecordId): Promise<CompanyError> {
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(`SELECT state FROM $msg;`, { msg });
    return rows?.[0] ? new CompanyError('conflict', 'sent message is locked') : new CompanyError('not_found', 'message not found');
  }

  /** The notice key is derived from task+step, exactly as the dispatcher raises it. No owner desk dependency here. */
  private async resolveHoldNotice(task: unknown, step: unknown): Promise<void> {
    const taskId = String((task as RecordId)?.id ?? task ?? '');
    if (!taskId) return;
    const key = `message-hold:${taskId}:${String(step ?? '')}`;
    const [rows] = await this.db.query<[Array<{ id: unknown }>]>('SELECT id FROM owner_notice WHERE key = $key AND resolved_at = NONE;', { key });
    for (const row of rows ?? []) await this.db.query('UPDATE $notice SET resolved_at = time::now();', { notice: row.id });
  }

  /**
   * Held messages do not send; otherwise locks in the table and returns the body to deliver. `null` means no send:
   * held by the owner, or a translated message whose translation is missing or stale (the gateway fills it in later).
   * The body follows the translation rule (deliveryBody): a message without lang delivers its own text.
   * The mark stays in 'draft' until the caller's external send succeeded (see markSent), so a failed send
   * never loses the owner's edit. Every dispatch message comes from this table.
   */
  async prepareSend(taskId: string, step: MessageStep, employeeId: string): Promise<{ body: string; message: OutboundMessage } | null> {
    const draft = await this.latestDraft(taskId, step);
    if (!draft) {
      // 旧任务没有草稿：按模板即时生成一条，保证派工正文永远来自这张表。
      const fresh = await this.seedDraft(taskId, step);
      if (fresh.hold) return null;
      return deliverable(fresh, employeeId);
    }
    if (draft.hold || draft.state === 'held') return null;
    return deliverable(draft, employeeId);
  }

  /**
   * Gives each queued task its next step's draft before the owner board reads it, so a rework message exists from the moment its
   * task is queued, not only at its first dispatch. Idempotent: a step with an unsent draft is left alone. The step is the one the
   * next dispatch sends (stepOfTask over the task state and its returns).
   */
  async ensureQueuedDrafts(taskIds: readonly string[]): Promise<void> {
    if (taskIds.length === 0) return;
    const ids = taskIds.map(id => this.task(id));
    const [tasks, returns, drafts] = await Promise.all([
      this.db.query<[Array<{ id: unknown; state: string }>]>('SELECT id, state FROM task WHERE id IN $ids;', { ids }).then(r => r[0] ?? []),
      this.db.query<[Array<{ task: unknown }>]>("SELECT task FROM audit WHERE task IN $ids AND action IN ['return', 'owner_reject'];", { ids })
        .then(r => r[0] ?? []),
      this.db.query<[Array<{ task: unknown; step: string }>]>("SELECT task, step FROM outbound_message WHERE task IN $ids AND state != 'sent';", { ids })
        .then(r => r[0] ?? []),
    ]);
    const returned = new Set(returns.map(row => keyOf(row.task)));
    const have = new Set(drafts.map(row => `${keyOf(row.task)}:${row.step}`));
    for (const task of tasks) {
      const taskId = keyOf(task.id);
      const step = stepOfTask(task.state, returned.has(taskId));
      if (!have.has(`${taskId}:${step}`)) await this.seedDraft(taskId, step);
    }
  }

  /**
   * The draft a step gets when it has none: the template, or what was last sent for the same step, so an owner edit survives a
   * re-dispatch. The send path and the queue both create drafts here, so they produce the same text.
   */
  private async seedDraft(taskId: string, step: MessageStep): Promise<OutboundMessage> {
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT executor_role, reviewer_role, kind, work_intent FROM $task;`, { task: this.task(taskId) });
    const row = rows?.[0] as { work_intent?: { kind?: string }; kind?: string; reviewer_role?: string; executor_role?: string } | undefined;
    // 复核与执行看同一个代码工作标记：review 草稿缺失时也要按工作种类选模板。
    const code = (step === 'execute' || step === 'rework' || step === 'review') &&
      (row?.work_intent?.kind === 'code' || ['release', 'deploy'].includes(String(row?.kind ?? '')));
    const role = step === 'review' ? String(row?.reviewer_role ?? 'qa') : String(row?.executor_role ?? 'engineering');
    // A re-dispatch of the same step (lease expired, instance replaced) repeats what was last sent, so an owner edit survives.
    const [sent] = await this.db.query<[Array<{ body?: string }>]>(
      `SELECT body, created_at FROM outbound_message WHERE task = $task AND step = $step AND state = 'sent' ORDER BY created_at DESC LIMIT 1;`,
      { task: this.task(taskId), step });
    return this.createDraft(taskId, step, role, code, step === 'review' ? 'review' : 'doing', sent?.[0]?.body);
  }

  async markSent(messageId: string, employeeId: string, body: string): Promise<{ body: string; message: OutboundMessage }> {
    // 认领即条件 UPDATE：同一条消息只有一个调用方的 WHERE state != 'sent' 命中并返回行。
    // 并发写同一行时 SurrealDB 可能直接报 Transaction conflict（可重试）；重试时该行已是 sent，条件不再命中，因此统一映射为 conflict。
    const row = await this.guardedMarkSent(messageId, employeeId);
    if (!row) throw new CompanyError('conflict', 'message already sent or missing');
    await this.resolveHoldNotice(row.task, row.step);
    return { body, message: rowView(row) };
  }

  private async guardedMarkSent(messageId: string, employeeId: string): Promise<Record<string, unknown> | undefined> {
    for (let attempt = 1; ; attempt++) {
      try {
        const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
          `UPDATE $msg SET state = 'sent', sent_to = $employee, sent_at = time::now(), hold = false WHERE state != 'sent' RETURN AFTER;`,
          { msg: this.message(messageId), employee: employeeId });
        return rows?.[0];
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (attempt >= 3 || !/transaction conflict/i.test(text)) throw error;
      }
    }
  }

  /** 返工/催办触发时追加 draft（幂等：同一任务同一阶段已有未发草稿则不重复）。 */
  async ensureDraft(taskId: string, step: MessageStep, role: string, code = false, phase = 'doing'): Promise<OutboundMessage> {
    const found = await this.latestDraft(taskId, step);
    return found ?? this.createDraft(taskId, step, role, code, phase);
  }
}
