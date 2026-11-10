/** 待发消息表：建单时为执行岗与复核岗各生成一条 draft；返工/催办在触发时生成。 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { machineCriterionOf, routeBody, stepOfTask, templateFor, type MessageStep } from './outbound-render.ts';
import { deliveryOf, sourceHash } from './outbound-delivery.ts';
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
  /** 译文的语言；缺省即中文原文。员工默认语言在派工时写入（见 prepareSend）。 */
  lang?: string;
  /** 老板为这条消息选过语言（含选“原文”）：选过后不再套用员工默认语言。 */
  langChosen?: boolean;
  /** 译文正文：只在投递给 lang 语言的员工时才会使用。 */
  translatedText?: string;
  /** 译文时的原文哈希（SHA-256，小写十六进制）：与当前原文不一致即过期。 */
  translatedFromHash?: string;
  translatedAt?: string;
  /** 最近一次补译失败的时间：定时补译据此轮流处理译不出的消息（见 owner-end/src/cron.ts）。 */
  translateFailedAt?: string;
}

const STEPS: readonly MessageStep[] = ['execute', 'review', 'rework', 'nudge', 'notice'];

/** A record id's key; a plain value stands for itself. */
const keyOf = (value: unknown): string => String((value as RecordId | undefined)?.id ?? value ?? '');

/** A stored text field as a string, or undefined when the row has no value for it. */
const textOf = (value: unknown): string | undefined => value === undefined || value === null ? undefined : String(value);

const rowView = (row: Record<string, unknown>): OutboundMessage => ({
  id: String((row.id as RecordId).id ?? row.id), taskId: String((row.task as RecordId)?.id ?? row.task ?? ''),
  step: String(row.step) as MessageStep, role: String(row.role ?? ''), body: String(row.body ?? ''),
  state: (String(row.state ?? 'draft')) as MessageState, hold: row.hold === true,
  editedBy: row.edited_by === undefined || row.edited_by === null ? undefined : String(row.edited_by),
  editedAt: row.edited_at === undefined || row.edited_at === null ? undefined : String(row.edited_at),
  sentTo: row.sent_to === undefined || row.sent_to === null ? undefined : String(row.sent_to),
  sentAt: row.sent_at === undefined || row.sent_at === null ? undefined : String(row.sent_at),
  createdAt: String(row.created_at ?? ''),
  lang: textOf(row.lang),
  ...(row.lang_chosen === true ? { langChosen: true } : {}),
  translatedText: textOf(row.translated_text),
  translatedFromHash: textOf(row.translated_from_hash),
  translatedAt: textOf(row.translated_at),
  // SDK 把 datetime 读成 Date；转成 ISO 字符串，补译排序才能按时间比较。
  translateFailedAt: row.translate_failed_at instanceof Date ? row.translate_failed_at.toISOString() : textOf(row.translate_failed_at),
});

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
    bodies: { execute?: string; review?: string; includeSent?: boolean } = {}): Promise<OutboundMessage[]> {
    const [existing] = await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT * FROM outbound_message WHERE task = $task AND step IN ['execute','review'] ${bodies.includeSent ? '' : "AND state != 'sent'"} ORDER BY created_at;`,
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

  /**
   * Read-only twin of prepareSend's null for translation: true when the step's message has no ready translation for the employee's
   * language yet (the owner hold is a separate question, see isHeld). No employee means a new one, which has no default language, so
   * only a language the owner chose can make the message wait. Writes nothing, so it can run before a lease is taken or an employee made.
   */
  async awaitingTranslation(taskId: string, step: MessageStep, employeeId: string | undefined): Promise<boolean> {
    const employeeLang = employeeId ? await this.langOf(employeeId) : undefined;
    const draft = await this.latestDraft(taskId, step);
    // No draft yet: prepareSend would seed a fresh one, which takes the employee's language and never carries a translation.
    if (!draft) return Boolean(employeeLang);
    if (draft.hold || draft.state === 'held') return false;
    return !deliveryOf(draft, employeeLang).ok;
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

  /**
   * Stores a translation of the message's body for one language. The guard is the body the translator saw: when the owner edited the
   * body since, nothing matches and the caller must translate again. The owner's edit fields stay as they are (a translation is not an edit).
   */
  async setTranslation(messageId: string, lang: string, translatedText: string, expectedBody: string, _actor: string): Promise<OutboundMessage> {
    if (!translatedText.trim()) throw new CompanyError('invalid', 'translation must not be empty');
    const msg = this.message(messageId);
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `UPDATE $msg SET lang = $lang, translated_text = $text, translated_from_hash = $hash, translated_at = time::now()
        WHERE state != 'sent' AND body = $expectedBody RETURN AFTER;`,
      { msg, lang, text: translatedText, hash: sourceHash(expectedBody), expectedBody });
    const row = rows?.[0];
    if (!row) throw await this.translationRefusal(msg);
    return rowView(row);
  }

  /** 补译失败：记下失败时间，定时补译据此把它排到其它待译消息之后。已发送的消息不记。 */
  async markTranslationFailed(messageId: string): Promise<void> {
    await this.db.query(`UPDATE $msg SET translate_failed_at = time::now() WHERE state != 'sent';`, { msg: this.message(messageId) });
  }

  /** The guarded translation UPDATE matched nothing: a missing message, a sent one, or one whose body moved on. */
  private async translationRefusal(msg: RecordId): Promise<CompanyError> {
    const [rows] = await this.db.query<[Array<{ state?: string }>]>(`SELECT state FROM $msg;`, { msg });
    const row = rows?.[0];
    if (!row) return new CompanyError('not_found', 'message not found');
    if (row.state === 'sent') return new CompanyError('conflict', 'conflict: message already sent');
    return new CompanyError('conflict', 'conflict: body changed, translate again');
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
   * Held messages do not send. Otherwise the delivery rule (deliveryOf) picks the body: the stored body for a message without a
   * language, the translation for the employee's language once it is ready, and `null` while it waits for that translation.
   * `null` means no send; the hold and the state stay as they are. The mark stays in 'draft' until the caller's external send
   * succeeded (see markSent), so a failed send never loses the owner's edit. Every dispatch message comes from this table.
   */
  async prepareSend(taskId: string, step: MessageStep, employeeId: string): Promise<{ body: string; message: OutboundMessage } | null> {
    const employeeLang = await this.langOf(employeeId);
    // 旧任务没有草稿：按模板即时生成一条，保证派工正文永远来自这张表。
    let draft = await this.latestDraft(taskId, step) ?? await this.seedDraft(taskId, step);
    if (draft.hold || draft.state === 'held') return null;
    draft = await this.stampLang(draft, employeeLang);
    const delivery = deliveryOf(draft, employeeLang);
    if (!delivery.ok) return null;
    return { body: delivery.body, message: { ...draft, sentTo: employeeId } };
  }

  /**
   * 派工前把消息的语言对齐到收件员工的默认语言（只对没选过语言的消息）：员工换了（改派）或默认语言改了，消息上的语言跟着变。
   * 语言变了，旧译文一并清掉（它是另一种语言的），由网关补译成新语言；译文就绪前投递会等待。已经对齐则不写库。
   */
  async stampLang(draft: OutboundMessage, employeeLang: string | undefined): Promise<OutboundMessage> {
    if (draft.langChosen || (draft.lang || undefined) === (employeeLang || undefined)) return draft;
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `UPDATE $msg SET ${employeeLang ? 'lang = $lang' : 'lang = NONE'}, translated_text = NONE, translated_from_hash = NONE,
        translated_at = NONE WHERE state != 'sent' AND lang_chosen != true RETURN AFTER;`,
      { msg: this.message(draft.id), ...(employeeLang ? { lang: employeeLang } : {}) });
    return rows?.[0] ? rowView(rows[0]) : draft;
  }

  /**
   * 派工循环在领租约之前调用：没有草稿的先补一条，再把语言对齐到员工默认语言。已对齐则只读。
   * 不先对齐的话，有语言的员工会一直等一份没有人开始补译的译文（补译只译已带语言的消息），派工卡住。
   */
  async alignLanguage(taskId: string, step: MessageStep, employeeId: string): Promise<void> {
    const draft = await this.latestDraft(taskId, step) ?? await this.seedDraft(taskId, step);
    await this.stampLang(draft, await this.langOf(employeeId));
  }

  /**
   * 老板为消息选择（或清除）译文语言：换语言即作废旧译文。清除（lang 为 undefined）即回到中文原文投递，
   * 并记下 lang_chosen，之后不再套用员工默认语言。
   */
  async setLanguage(messageId: string, lang: string | undefined): Promise<OutboundMessage> {
    const msg = this.message(messageId);
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `UPDATE $msg SET ${lang ? 'lang = $lang' : 'lang = NONE'}, translated_text = NONE, translated_from_hash = NONE,
        translated_at = NONE, lang_chosen = true WHERE state != 'sent' RETURN AFTER;`,
      { msg, ...(lang ? { lang } : {}) });
    const row = rows?.[0];
    if (!row) throw await this.refusal(msg);
    return rowView(row);
  }

  /** The employee's language from agent_policy; undefined when the employee has none (the original body is sent). */
  private async langOf(employeeId: string): Promise<string | undefined> {
    const [rows] = await this.db.query<[Array<{ lang?: unknown }>]>('SELECT lang FROM agent_policy WHERE agent = $agent LIMIT 1;', { agent: employeeId });
    const lang = rows?.[0]?.lang;
    return typeof lang === 'string' && lang ? lang : undefined;
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
    const row = await this.guardedMarkSent(messageId, employeeId, body);
    if (!row) throw new CompanyError('conflict', 'message already sent or missing');
    await this.resolveHoldNotice(row.task, row.step);
    return { body, message: rowView(row) };
  }

  private async guardedMarkSent(messageId: string, employeeId: string, body: string): Promise<Record<string, unknown> | undefined> {
    for (let attempt = 1; ; attempt++) {
      try {
        const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
          `UPDATE $msg SET state = 'sent', sent_body = $body, sent_to = $employee, sent_at = time::now(), hold = false WHERE state != 'sent' RETURN AFTER;`,
          { msg: this.message(messageId), employee: employeeId, body });
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
