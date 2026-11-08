/** 待发消息表：建单时为执行岗与复核岗各生成一条 draft；返工/催办在触发时生成。 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';

export type MessageStep = 'execute' | 'review' | 'rework' | 'nudge' | 'eval' | 'notice';
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
}

const STEPS: readonly MessageStep[] = ['execute', 'review', 'rework', 'nudge', 'eval', 'notice'];

/** The deploy-leg machine criterion id every code dispatch may name when the task carries no readable criteria. */
export const DEFAULT_MACHINE_CRITERION = 'AC-BASE-DEPLOY-1';

/** 表里保存短正文；派工时 renderMessage 才补上真实路径、工具绝对路径与任务 ID。 */
const NOTES = `先读 notes.md。`;
/** A session that stays in its turn after handing in burns tokens and cannot be woken for its own rework. */
const END_TURN = `提交后结束本轮，不要等结果；被退回时系统会再通知你。`;
const LEARNED = `多数任务不需要写笔记；只有今后同职能的任务都用得上的要求、方法或坑，才加 learned 数组（最多 5 条，每条一行，不写本次任务的内容）；被退回那一轮写的笔记不会生效。`;
/** 员工沙箱不能安装，也读不到生产控制台令牌：自验在最终提交上做，安装由自动升级完成。 */
const EXECUTE_CODE = `${NOTES}实现 task.md 中的需求，在最终提交上按验收标准逐条自验，合入 main 后：sck call submit '{"text":"<结果>","sha":"<合入提交>"}'。自动升级会把 main 装到生产，你不要安装，也不要登记升级卡。需要后续任务时在 submit 里加 next 数组。${LEARNED}${END_TURN}`;
const EXECUTE_PLAIN = `${NOTES}完成 task.md 中的需求，按验收标准自验后：sck call submit '{"text":"<结果>"}'。需要后续任务时在 submit 里加 next 数组。${LEARNED}${END_TURN}`;
/** 第 1 条写的是老板视角的结果：不成立就没必要再读其余标准；软件线只在最终合入提交上核对。 */
const REVIEW_FIRST = `先查验收标准第 1 条：这一条写的是老板视角的结果，不成立就直接退回，其余各条不用再看；成立后再逐条复验其余标准。`;
const REVIEW = `${NOTES}按 task.md 的验收标准复验。${REVIEW_FIRST}sck call review '{"decision":"accept|return","text":"<结论>"}'。${LEARNED}提交后结束本轮。`;
const REVIEW_CODE = `${NOTES}按 task.md 的验收标准复验。${REVIEW_FIRST}代码任务在最终合入提交上核对，不检查生产加载的版本。sck call review '{"decision":"accept|return","text":"<结论>"}'。${LEARNED}提交后结束本轮。`;
const REWORK_CODE = `修复 findings/round-NN.md 中的问题后，` + EXECUTE_CODE;
const REWORK_PLAIN = `修复 findings/round-NN.md 中的问题后，` + EXECUTE_PLAIN;
const NUDGE = (phase: string) => phase === 'review' ? REVIEW : EXECUTE_PLAIN;
/** eval 不读本任务 task.md：评分规则在运营仓的 agents/eval.md，由派工时补成绝对路径。 */
const EVAL = `任务 {taskId} 已完成，读 sck call get_task_history 和 sck call get_model_evidence，按 agents/eval.md 为全部参与员工打分，用 sck call record_score '{"taskId":"{taskId}","summary":"<本轮一句话总结>","complexity":3,"scores":[{"employee":"<员工编号>","quality":4,"evidence":4,"discipline":4,"timeliness":4,"overall":4,"notes":"<评语>","modelScores":[]}]}' 提交`;

/** A route's own template still has to point the session at its notes; the stored draft is the full text the owner previews. */
const routeBody = (body?: string): string | undefined =>
  body?.trim() ? (body.includes('notes.md') ? body : `${NOTES}${body}`) : undefined;

export const templateFor = (step: MessageStep, code = false, phase = 'doing'): string =>
  step === 'execute' ? (code ? EXECUTE_CODE : EXECUTE_PLAIN)
    : step === 'review' ? (code ? REVIEW_CODE : REVIEW)
      : step === 'rework' ? (code ? REWORK_CODE : REWORK_PLAIN)
        : step === 'nudge' ? NUDGE(phase)
          : EVAL;

/**
 * Pure send-time rewriting of the stored short body. The owner edits the short form; the employee receives
 * concrete absolute paths and a tool binary that is actually on disk. No database or host state is read here.
 */
export function renderMessage(body: string, opts: {
  sckBin: string; commDir: string; findingsFile?: string; taskId: string; opsRepo?: string; acId?: string;
}): string {
  const { sckBin, commDir, findingsFile, taskId, opsRepo, acId } = opts;
  const taskFile = `${commDir.replace(/\/+$/, '')}/task.md`;
  const findings = findingsFile ? `${commDir.replace(/\/+$/, '')}/${findingsFile.replace(/^\/+/, '')}` : undefined;
  return body
    .replaceAll('{taskId}', taskId)
    .replaceAll('{acId}', acId ?? DEFAULT_MACHINE_CRITERION)
    .replaceAll('sck call', `'${sckBin}' call`)
    .replaceAll('task.md', taskFile)
    .replaceAll('notes.md', `${commDir.replace(/\/+$/, '')}/notes.md`)
    .replaceAll(/findings\/round-(?:\d+|NN)\.md/g, findings ?? 'findings/round-NN.md')
    .replaceAll('agents/eval.md', opsRepo ? `${opsRepo.replace(/\/+$/, '')}/agents/eval.md` : 'agents/eval.md');
}

const rowView = (row: Record<string, unknown>): OutboundMessage => ({
  id: String((row.id as RecordId).id ?? row.id), taskId: String((row.task as RecordId)?.id ?? row.task ?? ''),
  step: String(row.step) as MessageStep, role: String(row.role ?? ''), body: String(row.body ?? ''),
  state: (String(row.state ?? 'draft')) as MessageState, hold: row.hold === true,
  editedBy: row.edited_by === undefined || row.edited_by === null ? undefined : String(row.edited_by),
  editedAt: row.edited_at === undefined || row.edited_at === null ? undefined : String(row.edited_at),
  sentTo: row.sent_to === undefined || row.sent_to === null ? undefined : String(row.sent_to),
  sentAt: row.sent_at === undefined || row.sent_at === null ? undefined : String(row.sent_at),
  createdAt: String(row.created_at ?? ''),
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
    const raw = rows?.[0]?.acceptance_criteria;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item && typeof item === 'object' && (item as { kind?: unknown }).kind === 'machine' &&
          (item as { required?: unknown }).required === true && typeof (item as { id?: unknown }).id === 'string') {
          return (item as { id: string }).id;
        }
      }
    }
    return DEFAULT_MACHINE_CRITERION;
  }

  /** The next step of an unfinished task: the phase plus the audit's last return decides which draft applies. */
  async nextStep(taskId: string): Promise<MessageStep> {
    const [row, returns] = await Promise.all([
      this.db.query<[Array<{ state: string }>]>('SELECT state FROM $task;', { task: this.task(taskId) }).then(r => r[0]),
      this.db.query<[Array<{ id: unknown }>]>(
        "SELECT id, at FROM audit WHERE task = $task AND action IN ['return','owner_reject'] ORDER BY at DESC LIMIT 1;", { task: this.task(taskId) }).then(r => r[0]),
    ]);
    return row?.[0]?.state === 'review' ? 'review' : (returns?.length ?? 0) > 0 ? 'rework' : 'execute';
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
    if (!hold) await this.resolveHoldNotice(row.taskId, row.step);
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
   * Held messages do not send; otherwise locks in the table and returns the stored body. `null` means no send.
   * The mark stays in 'draft' until the caller's external send succeeded (see markSent), so a failed send
   * never loses the owner's edit. Every dispatch message comes from this table.
   */
  async prepareSend(taskId: string, step: MessageStep, employeeId: string): Promise<{ body: string; message: OutboundMessage } | null> {
    const draft = await this.latestDraft(taskId, step);
    if (!draft) {
      // 旧任务没有草稿：按模板即时生成一条，保证派工正文永远来自这张表。
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
      const fresh = await this.createDraft(taskId, step, role, code, step === 'review' ? 'review' : 'doing', sent?.[0]?.body);
      if (fresh.hold) return null;
      return { body: fresh.body, message: { ...fresh, sentTo: employeeId } };
    }
    if (draft.hold || draft.state === 'held') return null;
    return { body: draft.body, message: { ...draft, sentTo: employeeId } };
  }

  async markSent(messageId: string, employeeId: string, body: string): Promise<{ body: string; message: OutboundMessage }> {
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `UPDATE $msg SET state = 'sent', sent_to = $employee, sent_at = time::now(), hold = false WHERE state != 'sent' RETURN AFTER;`,
      { msg: this.message(messageId), employee: employeeId });
    if (!rows?.[0]) throw new CompanyError('conflict', 'message already sent or missing');
    await this.resolveHoldNotice(rows[0].task, rows[0].step);
    return { body, message: rowView(rows[0]) };
  }

  /** 返工/催办触发时追加 draft（幂等：同一任务同一阶段已有未发草稿则不重复）。 */
  async ensureDraft(taskId: string, step: MessageStep, role: string, code = false, phase = 'doing'): Promise<OutboundMessage> {
    const found = await this.latestDraft(taskId, step);
    return found ?? this.createDraft(taskId, step, role, code, phase);
  }
}
