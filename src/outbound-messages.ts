/** 待发消息表：建单时为执行岗与复核岗各生成一条 draft；返工/催办在触发时生成。 */
import { randomUUID } from 'node:crypto';
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';

export type MessageStep = 'execute' | 'review' | 'rework' | 'nudge' | 'eval';
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

const STEPS: readonly MessageStep[] = ['execute', 'review', 'rework', 'nudge', 'eval'];

/** 极简模板：只说做什么、在哪看需求、怎么交付。变量只替换工作目录行。 */
const EXECUTE_CODE = `实现 task.md 中的需求，合入并发布到生产，按验收标准在生产逐条自验，全部通过后：sck call submit '{"text":"…","idempotencyKey":"…"}'`;
const EXECUTE_PLAIN = `实现 task.md 中的需求，按验收标准逐条自验，全部通过后：sck call submit '{"text":"…","idempotencyKey":"…"}'`;
const REVIEW = `按 task.md 的验收标准在生产逐条复验，结论：sck call review '{"decision":"accept|return","text":"…","idempotencyKey":"…"}'`;
const REWORK = `修复 findings/round-NN.md 中的问题，重新发布并自验后：sck call submit '{"text":"…","idempotencyKey":"…"}'`;
const NUDGE = (phase: string) => phase === 'review'
  ? `按 task.md 的验收标准复验后：sck call review '{"decision":"accept|return","text":"…","idempotencyKey":"…"}'`
  : `完成 task.md 中的需求后：sck call submit '{"text":"…","idempotencyKey":"…"}'`;
const EVAL = `按 task.md 的评分规则为本轮参与员工打绩效分。`;

export const templateFor = (step: MessageStep, code = false, phase = 'doing'): string =>
  step === 'execute' ? (code ? EXECUTE_CODE : EXECUTE_PLAIN)
    : step === 'review' ? REVIEW
      : step === 'rework' ? REWORK
        : step === 'nudge' ? NUDGE(phase)
          : EVAL;

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

  async createDraft(taskId: string, step: MessageStep, role: string, code = false, phase = 'doing'): Promise<OutboundMessage> {
    if (!STEPS.includes(step)) throw new CompanyError('invalid', `unknown message step ${step}`);
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `CREATE outbound_message CONTENT { task: $task, step: $step, role: $role, body: $body,
        state: 'draft', hold: false, created_at: time::now() } RETURN AFTER;`,
      { task: this.task(taskId), step, role, body: templateFor(step, code, phase) });
    return rowView(rows[0]!);
  }

  /** 建任务时为执行岗与复核岗各生成一条 draft；幂等：已有 draft 不重复生成。 */
  async createTaskDrafts(taskId: string, executorRole: string, reviewerRole: string, code: boolean): Promise<OutboundMessage[]> {
    const [existing] = await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT * FROM outbound_message WHERE task = $task AND step IN ['execute','review'] AND state != 'sent' ORDER BY created_at;`,
      { task: this.task(taskId) });
    const have = new Set((existing ?? []).map(row => String(row.step)));
    const out: OutboundMessage[] = [];
    if (!have.has('execute')) out.push(await this.createDraft(taskId, 'execute', executorRole, code));
    if (!have.has('review')) out.push(await this.createDraft(taskId, 'review', reviewerRole, false, 'review'));
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

  async edit(messageId: string, body: string, actor: string): Promise<OutboundMessage> {
    if (!body.trim()) throw new CompanyError('invalid', 'message body must not be empty');
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `UPDATE ONLY $msg SET body = $body, edited_by = $actor, edited_at = time::now() RETURN AFTER;`,
      { msg: new RecordId('outbound_message', messageId), body, actor });
    const row = rows?.[0];
    if (!row) throw new CompanyError('not_found', 'message not found');
    if (String(row.state) === 'sent') throw new CompanyError('conflict', 'sent message is locked');
    return rowView(row);
  }

  async setHold(messageId: string, hold: boolean, actor: string): Promise<OutboundMessage> {
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `UPDATE ONLY $msg SET hold = $hold, state = IF $hold THEN 'held' ELSE 'draft' END,
        edited_by = $actor, edited_at = time::now() RETURN AFTER;`,
      { msg: new RecordId('outbound_message', messageId), hold, actor });
    const row = rows?.[0];
    if (!row) throw new CompanyError('not_found', 'message not found');
    if (String(row.state) === 'sent') throw new CompanyError('conflict', 'sent message is locked');
    return rowView(row);
  }

  /** hold=true 时不派工并进老板收件箱；否则锁定并留存原文。返回实际要发送的正文（null = 不放行）。 */
  async prepareSend(taskId: string, step: MessageStep, employeeId: string): Promise<{ body: string; message: OutboundMessage } | null> {
    const draft = await this.latestDraft(taskId, step);
    if (!draft) {
      // 旧任务没有草稿：按模板即时生成一条，保证派工正文永远来自这张表。
      const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
        `SELECT executor_role, reviewer_role, kind, work_intent FROM ONLY $task;`, { task: this.task(taskId) });
      const row = rows?.[0] as { work_intent?: { kind?: string }; kind?: string; reviewer_role?: string; executor_role?: string } | undefined;
      const code = step === 'execute' && (row?.work_intent?.kind === 'code' || ['release', 'deploy'].includes(String(row?.kind ?? '')));
      const role = step === 'review' ? String(row?.reviewer_role ?? 'qa') : String(row?.executor_role ?? 'engineering');
      const fresh = await this.createDraft(taskId, step, role, code, step === 'review' ? 'review' : 'doing');
      if (fresh.hold) return null;
      return this.markSent(fresh.id, employeeId, fresh.body);
    }
    if (draft.hold || draft.state === 'held') return null;
    return this.markSent(draft.id, employeeId, draft.body);
  }

  private async markSent(messageId: string, employeeId: string, body: string): Promise<{ body: string; message: OutboundMessage }> {
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `UPDATE ONLY $msg SET state = 'sent', sent_to = $employee, sent_at = time::now(), hold = false RETURN AFTER;`,
      { msg: new RecordId('outbound_message', messageId), employee: employeeId });
    if (!rows?.[0]) throw new CompanyError('not_found', 'message not found');
    return { body, message: rowView(rows[0]) };
  }

  /** 返工/催办触发时追加 draft（幂等：同一任务同一阶段已有未发草稿则不重复）。 */
  async ensureDraft(taskId: string, step: MessageStep, role: string, code = false, phase = 'doing'): Promise<OutboundMessage> {
    const found = await this.latestDraft(taskId, step);
    return found ?? this.createDraft(taskId, step, role, code, phase);
  }
}
