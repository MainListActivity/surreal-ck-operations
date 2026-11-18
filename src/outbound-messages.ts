import { outboundRevisionSql } from './outbound-revision.ts';
/** 待发消息表：建单时为执行岗与复核岗各生成一条 draft；返工/催办在触发时生成。 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { rolePolicyOf } from './command-guard.ts';
import { langMatches, ownerLangOf } from './owner-lang.ts';
import { analysisLead, composeMessage, ownerLead, machineCriterionOf, routeBody, stepOfTask, type MessageStep, type PromptTask } from './outbound-render.ts';
import { latestAnswer, requirementOf } from './dispatcher/brief.ts';
import { deliveryOf, sourceHash } from './outbound-delivery.ts';
export { DEFAULT_MACHINE_CRITERION, composeMessage, renderMessage, renderDispatchBody } from './outbound-render.ts';

export type { MessageStep, PromptTask } from './outbound-render.ts';
export type MessageState = 'draft' | 'held' | 'sent';

export interface OutboundMessage {
  id: string;
  taskId: string;
  step: MessageStep;
  role: string;
  body: string;
  state: MessageState;
  hold: boolean;
  /** 系统按规则扣住时的原因（第二轮返工、新需求首次派工）；老板自己扣住的没有。 */
  holdReason?: string;
  /** 派出去那一刻记下的“为什么派给它”（调度器写，见 dispatcher/lane-preference.ts 的 dispatchReason）。 */
  dispatchReason?: string;
  editedBy?: string;
  editedAt?: string;
  /** 老板改过正文：投递时原样保留，不再做路径变量替换。 */
  bodyEdited?: boolean;
  /** 正文是老板写的字面文本：投递与看板都不再做路径替换。 */
  bodyVerbatim?: boolean;
  sentTo?: string;
  sentAt?: string;
  createdAt: string;
  dispatchRevision?: string;
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

/** 返工消息最多等完工分析这么久（从退回那一刻算，按库的时钟）；过了就不带分析照常派工。 */
export const ANALYSIS_WAIT = '4m';
/** 老板端的分析任务每分钟跑一次并留下心跳；这么久没有心跳就当它没在跑，返工不等分析。 */
const ANALYSIS_BEAT = '3m';

const STEPS: readonly MessageStep[] = ['execute', 'review', 'rework', 'nudge', 'notice'];

/** A record id's key; a plain value stands for itself. */
const keyOf = (value: unknown): string => String((value as RecordId | undefined)?.id ?? value ?? '');

/** A stored text field as a string, or undefined when the row has no value for it. */
const textOf = (value: unknown): string | undefined => value === undefined || value === null ? undefined : String(value);

const timestamp = (value: unknown): string | undefined => value instanceof Date ? value.toISOString() : textOf(value);

const rowView = (row: Record<string, unknown>): OutboundMessage => ({
  id: String((row.id as RecordId).id ?? row.id), taskId: String((row.task as RecordId)?.id ?? row.task ?? ''),
  step: String(row.step) as MessageStep, role: String(row.role ?? ''), body: String(row.body ?? ''),
  state: (String(row.state ?? 'draft')) as MessageState, hold: row.hold === true,
  holdReason: textOf(row.hold_reason),
  dispatchReason: textOf(row.dispatch_reason),
  editedBy: row.edited_by === undefined || row.edited_by === null ? undefined : String(row.edited_by),
  editedAt: timestamp(row.edited_at),
  ...(row.body_edited === true ? { bodyEdited: true } : {}),
  ...(row.body_verbatim === true ? { bodyVerbatim: true } : {}),
  sentTo: row.sent_to === undefined || row.sent_to === null ? undefined : String(row.sent_to),
  sentAt: timestamp(row.sent_at),
  createdAt: timestamp(row.created_at) ?? '',
  dispatchRevision: textOf(row.dispatch_revision),
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

  /**
   * body 给了就原样存（路线、需求流水线的自定义正文，或照抄上一次发出的正文）；没给就按任务卡组装。
   * leads 记下正文里带的两段开头（老板答复、上一轮复盘）和复盘已经按哪条退回定过：重派照抄时据此去掉旧段，不会叠两段。
   */
  async createDraft(taskId: string, step: MessageStep, role: string, code = false, phase = 'doing', body?: string,
    leads: { answer?: string; analysis?: string; analysisSource?: string } = {}, verbatim = false): Promise<OutboundMessage> {
    if (!STEPS.includes(step)) throw new CompanyError('invalid', `unknown message step ${step}`);
    let card: PromptTask | undefined;
    if (body === undefined) {
      const full = await this.promptTask(taskId);
      const { answer: _answer, notes: _notes, ...plain } = full;
      card = { ...this.leadsFor(step, step, full, plain), analysisLead: leads.analysis };
    }
    const params = { task: this.task(taskId), step, role, body: body ?? composeMessage(step, card!, code, phase),
      composed: card ? { code, phase } : undefined, answer_lead: card ? ownerLead(card) : leads.answer,
      analysis_lead: leads.analysis, analysis_source: leads.analysisSource, ...(verbatim ? { body_verbatim: true } : {}) };
    // 同任务同阶段只允许一条未发送的活动草稿：并发补稿在一个事务里先查后建，不会出现平行草稿。
    {
      const msg = new RecordId('outbound_message', crypto.randomUUID());
      try {
        await this.db.query(`BEGIN;
          LET $open = SELECT id FROM outbound_message WHERE task = $task AND step = $step AND state != 'sent' LIMIT 1;
          IF array::len($open) > 0 { THROW 'draft already open'; };
          CREATE $msg CONTENT { task: $task, step: $step, role: $role, body: $body, composed: $composed, answer_lead: $answer_lead,
            analysis_lead: $analysis_lead, analysis_source: $analysis_source, body_verbatim: $body_verbatim, body_edited: $body_verbatim, state: 'draft', hold: false, created_at: time::now() };
          COMMIT;`, { ...params, msg });
      } catch (error) {
        // 事务内 THROW 或被并发写打断都意味着同阶段已有活动草稿：统一按冲突交给补稿方读回那一条。
        if (/draft already open|failed transaction/i.test((error as Error).message)) throw new CompanyError('conflict', 'draft already open');
        throw error;
      }
      const [created] = await this.db.query<[Array<Record<string, unknown>>]>('SELECT * FROM $msg;', { msg });
      if (!created?.[0]) throw new CompanyError('conflict', 'draft creation lost');
      return rowView(created[0]);
    }
  }

  /** 任务卡上决定派工正文的字段：做什么、可以用什么、如何验证。 */
  async promptTask(taskId: string): Promise<PromptTask> {
    const [rows] = await this.db.query<[Array<{ title?: string; context?: string; requirement?: string; resources?: string; acceptance_text?: string }>]>(
      'SELECT title, context, requirement, resources, acceptance_text FROM $task;', { task: this.task(taskId) });
    const row = rows?.[0];
    // 老板对上次受阻的答复：只要还没有新的工作结果跟上，就随下一条消息带给员工。
    const [events] = await this.db.query<[Array<{ action: string; evidence?: unknown; at: unknown }>]>(
      `SELECT action, evidence, at FROM audit WHERE task = $task AND action IN ['block', 'owner_reply', 'submit', 'owner_submit', 'return', 'accept', 'owner_reject', 'owner_approve']
        ORDER BY at DESC LIMIT 8;`, { task: this.task(taskId) });
    const answer = latestAnswer((events ?? []).reverse().map(event => ({ action: event.action, actor: '', at: String(event.at),
      evidence: typeof event.evidence === 'string' ? event.evidence : undefined })));
    // 老板在进行中插的话：这张任务最近一次发出执行或返工消息之后记下的，随下一条执行或返工消息带出，带出一次即算送达。
    // 复核消息不带也不算送达：话是说给干活的人的，员工先交了的话留给之后的返工。
    const [[lastSent], [noteRows]] = await Promise.all([
      this.db.query<[Array<{ sent_at?: unknown }>]>("SELECT sent_at FROM outbound_message WHERE task = $task AND state = 'sent' AND sent_at != NONE AND step IN ['execute', 'rework'] ORDER BY sent_at DESC LIMIT 1;", { task: this.task(taskId) }),
      this.db.query<[Array<{ evidence?: unknown; at: unknown }>]>("SELECT evidence, at FROM audit WHERE task = $task AND action = 'owner_note' ORDER BY at DESC LIMIT 10;", { task: this.task(taskId) }),
    ]);
    const since = lastSent?.[0]?.sent_at ? new Date(lastSent[0].sent_at as string).getTime() : 0;
    const notes = (noteRows ?? []).filter(row => typeof row.evidence === 'string' && new Date(row.at as string).getTime() > since)
      .reverse().map(row => String(row.evidence));
    return { title: row?.title, requirement: row?.requirement?.trim() || requirementOf(row?.context ?? ''),
      resources: row?.resources ?? undefined, acceptance: row?.acceptance_text ?? undefined, ...(answer ? { answer } : {}), ...(notes.length ? { notes } : {}) };
  }

  /** 公司配置 auto_hold：false 时关闭系统自动扣住（第二轮返工、新需求首次派工）；缺省开启。 */
  private async autoHold(): Promise<boolean> {
    const [rows] = await this.db.query<[Array<{ auto_hold?: unknown }>]>('SELECT auto_hold FROM company_meta:config;');
    return rows?.[0]?.auto_hold !== false;
  }

  /**
   * 系统按规则扣住一条草稿，等老板看过再放行。不写 edited_by：这不是老板的操作，也不算改过正文。
   * 已发出或正在派出的消息不动；老板放行时原因一并清掉。
   */
  async holdForPolicy(messageId: string, reason: string): Promise<boolean> {
    if (!await this.autoHold()) return false;
    const [rows] = await this.db.query<[unknown[]]>(
      "UPDATE $msg SET hold = true, state = 'held', hold_reason = $reason WHERE state = 'draft' AND dispatch_attempt = NONE RETURN AFTER;",
      { msg: this.message(messageId), reason });
    return Boolean(rows?.length);
  }

  /** 一条草稿该带哪些老板的话：答复给下一步要发的那条和它的催办；插话只给下一步的执行或返工消息。 */
  private leadsFor(step: MessageStep, next: MessageStep | undefined, full: PromptTask, plain: PromptTask): PromptTask {
    const answer = step === next || step === 'nudge' ? full.answer : undefined;
    const notes = step === next && (step === 'execute' || step === 'rework') ? full.notes : undefined;
    return { ...plain, ...(answer ? { answer } : {}), ...(notes ? { notes } : {}) };
  }

  /**
   * 不随任务卡重算的草稿（路线、需求流水线的自定义正文）也要带上老板的话：在正文最前面就地换掉那一段。
   * 存下加进去的原文（answer_lead），下次换的时候先去掉旧的。老板改过正文的草稿不动。
   */
  private async attachOwnerLead(taskId: string, next: MessageStep | undefined, full: PromptTask, plain: PromptTask): Promise<void> {
    const [drafts] = await this.db.query<[Array<{ id: RecordId; step: MessageStep; body: string; answer_lead?: string }>]>(
      "SELECT id, step, body, answer_lead FROM outbound_message WHERE task = $task AND state != 'sent' AND body_edited != true AND composed = NONE AND dispatch_attempt = NONE;",
      { task: this.task(taskId) });
    for (const draft of drafts ?? []) {
      const lead = ownerLead(this.leadsFor(draft.step, next, full, plain));
      if ((lead ?? '') === (draft.answer_lead ?? '')) continue;
      const prior = draft.answer_lead ? `${draft.answer_lead}\n\n` : '';
      const base = prior && draft.body.startsWith(prior) ? draft.body.slice(prior.length) : draft.body;
      await this.db.query("UPDATE $msg SET body = $body, answer_lead = $lead WHERE state != 'sent' AND body_edited != true AND body = $expected AND dispatch_attempt = NONE;",
        { msg: draft.id, body: lead ? `${lead}\n\n${base}` : base, lead, expected: draft.body });
    }
  }

  /** 老板暂停任务：把下一步要发的那条消息扣住（没有草稿先补一条）。放行就是恢复。 */
  async holdNext(taskId: string, actor: string): Promise<OutboundMessage> {
    const step = await this.nextStep(taskId);
    const draft = await this.latestDraft(taskId, step) ?? await this.seedDraft(taskId, step);
    return draft.hold ? draft : this.setHold(draft.id, true, actor);
  }

  /** 老板在任务进行中插话：记进任务记录，随这张任务的下一条消息带给员工；没发出的草稿立即带上。 */
  async addNote(taskId: string, text: string, actor: string): Promise<void> {
    const [rows] = await this.db.query<[Array<{ version?: number; state?: string }>]>('SELECT version, state FROM $task;', { task: this.task(taskId) });
    if (!rows?.[0]) throw new CompanyError('not_found', 'task not found');
    if (rows[0].state === 'done' || rows[0].state === 'void') throw new CompanyError('conflict', '任务已结束，不能再插话');
    await this.db.query("CREATE audit CONTENT { task: $task, actor: $actor, action: 'owner_note', evidence: $text, version: $version, at: time::now() };",
      { task: this.task(taskId), actor, text, version: rows[0].version });
    await this.refreshDrafts(taskId).catch(error => console.warn(`draft refresh failed for ${taskId}: ${(error as Error).message}`));
  }

  /** 这一步的草稿被扣住的原因：系统规则扣住时有，老板自己扣住的没有。 */
  /** 记下这条消息为什么派给了收到它的那位员工。 */
  async setReason(messageId: string, reason: string): Promise<void> {
    await this.db.query('UPDATE $msg SET dispatch_reason = $reason;', { msg: new RecordId('outbound_message', messageId), reason: reason.slice(0, 300) });
  }

  async holdReason(taskId: string, step: MessageStep): Promise<string | undefined> {
    const draft = await this.latestDraft(taskId, step);
    return draft?.hold ? draft.holdReason : undefined;
  }

  /** 最近一次退回或老板驳回：编号、是否还在等分析的时限内（按库的时钟）、有没有可分析的退回意见（【通道回滚】是执行端自己的记录，不算）。 */
  private async latestReturn(taskId: string): Promise<{ id: RecordId; at: unknown; fresh: boolean; analyzable: boolean } | undefined> {
    const [rows] = await this.db.query<[Array<{ id: RecordId; at: unknown; fresh: boolean; analyzable: boolean }>]>(
      `SELECT id, at, at > time::now() - ${ANALYSIS_WAIT} AS fresh,
        (type::is_string(evidence) AND evidence != '' AND !string::starts_with(evidence, '【通道回滚】')) AS analyzable
        FROM audit WHERE task = $task AND action IN ['return', 'owner_reject'] ORDER BY at DESC LIMIT 1;`, { task: this.task(taskId) });
    return rows?.[0];
  }

  /**
   * 把最近一次退回的完工分析定到还没发出的返工草稿上，每条草稿对每次退回只定一次（analysis_source 记下定过）：
   * 老板放行之后不会因为同一份分析再被扣住。把握足的直接写进正文；把握不足的同一次更新里扣住等老板看，
   * 扣不了（公司关了自动扣住）就不写进正文——模型没把握的话不能没人看过就发给员工。
   * 老板改过正文的、正在派出的草稿不动。按任务卡组装的草稿只记下这段，正文由 refreshDrafts 重算；照抄的正文在这里直接加。
   */
  private async attachAnalysis(taskId: string): Promise<void> {
    const [drafts] = await this.db.query<[Array<{ id: RecordId; body: string; composed?: unknown; answer_lead?: string; hold?: boolean; state?: string }>]>(
      `SELECT id, body, composed, answer_lead, hold, state FROM outbound_message WHERE task = $task AND step = 'rework' AND state != 'sent'
        AND body_edited != true AND dispatch_attempt = NONE AND analysis_source = NONE;`, { task: this.task(taskId) });
    if (!drafts?.length) return;
    const last = await this.latestReturn(taskId);
    if (!last?.analyzable) return;
    const [rows] = await this.db.query<[Array<{ summary?: string; next?: string; confidence?: string }>]>(
      'SELECT summary, next, confidence FROM $rid;', { rid: new RecordId('turn_analysis', String(last.id.id)) });
    // 同一轮返工已经发过（重派），草稿却没定过——旧版本留下的草稿：照上次发的来，不再加分析也不再扣。
    const [resent] = await this.db.query<[unknown[]]>(
      "SELECT id FROM outbound_message WHERE task = $task AND step = 'rework' AND state = 'sent' AND sent_at > $since LIMIT 1;", { task: this.task(taskId), since: last.at });
    if (resent?.length) {
      await this.db.query("UPDATE $ids SET analysis_source = 'none' WHERE state != 'sent' AND analysis_source = NONE;", { ids: drafts.map(draft => draft.id) });
      return;
    }
    const analysis = rows?.[0];
    if (!analysis?.summary) return;
    const lead = analysisLead(analysis.next);
    const low = analysis.confidence !== 'high';
    const source = String(last.id.id);
    for (const draft of drafts) {
      const held = draft.hold === true || draft.state === 'held';
      const hold = Boolean(lead) && low && !held && await this.autoHold();
      const use = lead && (!low || held || hold) ? lead : undefined;
      let body = draft.body;
      if (use && !draft.composed) {
        const answer = draft.answer_lead && body.startsWith(`${draft.answer_lead}\n\n`) ? `${draft.answer_lead}\n\n` : '';
        body = `${answer}${use}\n\n${body.slice(answer.length)}`;
      }
      await this.db.query(
        `UPDATE $msg SET analysis_source = $source, analysis_lead = $lead, body = $body${hold ? ", hold = true, state = 'held', hold_reason = $reason" : ''}
          WHERE state ${hold ? "= 'draft'" : "!= 'sent'"} AND body_edited != true AND dispatch_attempt = NONE AND analysis_source = NONE AND body = $expected;`,
        { msg: draft.id, source, lead: use, body, expected: draft.body, reason: '完工分析把握不足' });
    }
  }

  /**
   * 返工消息在等最近一次退回的完工分析：退回后 ANALYSIS_WAIT 内、分析还没出来也没失败过、老板端的分析任务在跑（有心跳）。
   * 过了时限、分析失败过一次、或分析任务没在跑，都不等，照常派工。扣住的、老板改过的、已经定过的草稿不等。只读。
   */
  async awaitingAnalysis(taskId: string, step: MessageStep): Promise<boolean> {
    if (step !== 'rework') return false;
    const [drafts] = await this.db.query<[Array<{ hold?: boolean; state?: string; body_edited?: boolean; analysis_source?: string; dispatch_attempt?: unknown }>]>(
      `SELECT hold, state, body_edited, analysis_source, dispatch_attempt, created_at FROM outbound_message
        WHERE task = $task AND step = 'rework' AND state != 'sent' ORDER BY created_at DESC LIMIT 1;`, { task: this.task(taskId) });
    const draft = drafts?.[0];
    if (draft && (draft.hold === true || draft.state === 'held' || draft.body_edited === true || draft.analysis_source || draft.dispatch_attempt)) return false;
    const last = await this.latestReturn(taskId);
    if (!last?.analyzable || !last.fresh) return false;
    // 没有草稿时，同一轮返工已经发过的（重派）照上次发的来，不等。
    if (!draft) {
      const [resent] = await this.db.query<[unknown[]]>(
        "SELECT id FROM outbound_message WHERE task = $task AND step = 'rework' AND state = 'sent' AND sent_at > $since LIMIT 1;", { task: this.task(taskId), since: last.at });
      if (resent?.length) return false;
    }
    const [[beat], [row]] = await this.db.query<[Array<{ alive?: boolean }>, Array<{ summary?: string; attempts?: number }>]>(
      `SELECT at > time::now() - ${ANALYSIS_BEAT} AS alive FROM company_meta:analysis; SELECT summary, attempts FROM $rid;`,
      { rid: new RecordId('turn_analysis', String(last.id.id)) });
    if (beat?.alive !== true) return false;
    return !row?.summary && !((row?.attempts ?? 0) > 0);
  }

  /**
   * 任务卡改了之后，让还没发出、老板没改过的草稿跟着重算。只动按任务卡组装的草稿（composed 标记）：
   * 老板改过的、路线或需求流水线自定义正文的草稿保持原样。
   */
  async refreshDrafts(taskId: string): Promise<number> {
    // 先把刚出来的完工分析定到返工草稿上（含把握不足时扣住），下面再按它重算正文。失败不挡重算。
    await this.attachAnalysis(taskId).catch(error => console.warn(`analysis attach failed for ${taskId}: ${(error as Error).message}`));
    const full = await this.promptTask(taskId);
    // 老板的答复和插话只给下一步要发的那条（和它的催办）：还没轮到的复核草稿不带执行岗受阻的答复。
    const next = full.answer || full.notes ? await this.nextStep(taskId) : undefined;
    const { answer: _answer, notes: _notes, ...plain } = full;
    await this.attachOwnerLead(taskId, next, full, plain).catch(error => console.warn(`owner lead attach failed for ${taskId}: ${(error as Error).message}`));
    const [rows] = await this.db.query<[Array<{ id: unknown; step: MessageStep; body: string; composed: { code?: boolean; phase?: string }; analysis_lead?: string }>]>(
      "SELECT id, step, body, composed, analysis_lead FROM outbound_message WHERE task = $task AND state != 'sent' AND body_edited != true AND composed != NONE AND dispatch_attempt = NONE;",
      { task: this.task(taskId) });
    let changed = 0;
    for (const draft of rows ?? []) {
      const card = { ...this.leadsFor(draft.step, next, full, plain), analysisLead: draft.analysis_lead };
      const body = composeMessage(draft.step, card, draft.composed.code === true, draft.composed.phase ?? 'doing');
      if (body === draft.body) continue;
      // 条件更新：这期间老板改了正文或消息已发出，就不动它。正在派出的消息（dispatch_attempt）正文已冻结，上面已排除。
      const [done] = await this.db.query<[unknown[]]>(
        "UPDATE $msg SET body = $body, answer_lead = $answer_lead WHERE state != 'sent' AND body_edited != true AND body = $expected AND dispatch_attempt = NONE RETURN AFTER;",
        { msg: draft.id, body, expected: draft.body, answer_lead: ownerLead(card as PromptTask) });
      if (done?.length) changed++;
    }
    return changed;
  }

  /** 建任务时为执行岗与复核岗各生成一条 draft；幂等：已有 draft 不重复生成。 */
  async createTaskDrafts(taskId: string, executorRole: string, reviewerRole: string, code: boolean,
    bodies: { execute?: string; review?: string; includeSent?: boolean } = {}): Promise<OutboundMessage[]> {
    const [existing] = await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT * FROM outbound_message WHERE task = $task AND step IN ['execute','review'] ${bodies.includeSent ? '' : "AND state != 'sent'"} ORDER BY created_at;`,
      { task: this.task(taskId) });
    const have = new Set((existing ?? []).map(row => String(row.step)));
    const out: OutboundMessage[] = [];
    const once = async (step: MessageStep, role: string, phase: string, body?: string): Promise<OutboundMessage> => {
      try {
        return await this.createDraft(taskId, step, role, code, phase, routeBody(body));
      } catch (error) {
        // 另一路并发已经补上了同阶段草稿：用它，绝不并行再建一条。
        if ((error as CompanyError).code === 'conflict') {
          const open = await this.latestDraft(taskId, step);
          if (open) return open;
        }
        throw error;
      }
    };
    if (!have.has('execute')) out.push(await once('execute', executorRole, 'doing', bodies.execute));
    // 复核草稿与执行草稿用同一个 code 标记：软件线的复核才需要写明最终合入提交与不检查生产版本。
    if (!have.has('review')) out.push(await once('review', reviewerRole, 'review', bodies.review));
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
   * language yet (the owner hold is a separate question, see isHeld). Languages live on roles, so with no employee yet the role about to
   * be dispatched decides: a new instance of that role takes its language. With neither, only a language the owner chose can make the
   * message wait. Writes nothing, so it can run before a lease is taken or an employee made.
   */
  async awaitingTranslation(taskId: string, step: MessageStep, employeeId: string | undefined, role?: string): Promise<boolean> {
    const employeeLang = await this.langOf(employeeId, role);
    const draft = await this.latestDraft(taskId, step);
    // No draft yet: prepareSend would seed a fresh one, which takes the employee's language and never carries a translation.
    if (!draft) return Boolean(employeeLang);
    if (draft.hold || draft.state === 'held') return false;
    return !deliveryOf(draft, employeeLang).ok;
  }

  async edit(messageId: string, body: string, actor: string, expectedBody?: string, verbatim = true): Promise<OutboundMessage> {
    if (!body.trim()) throw new CompanyError('invalid', 'message body must not be empty');
    const msg = this.message(messageId);
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      // body_edited 只在改正文时写：扣住、放行也会写 edited_by，不能拿它判断正文是否被老板改过。
      // body_verbatim 区分字面正文与可还原模板：字面正文投递时不再替换路径变量。
      `UPDATE $msg SET body = $body, body_edited = true, body_verbatim = $verbatim, edited_by = $actor, edited_at = time::now() WHERE state != 'sent' AND ($expected = NONE OR body = $expected) RETURN AFTER;`,
      { msg, body, actor, verbatim, expected: expectedBody });
    const row = rows?.[0];
    if (!row && expectedBody !== undefined) {
      const current = await this.get(messageId);
      if (current && current.state !== 'sent') throw new CompanyError('conflict', '消息已被修改，请核对最新正文后重新保存');
    }
    if (!row) throw await this.refusal(msg);
    return rowView(row);
  }

  async setHold(messageId: string, hold: boolean, actor: string): Promise<OutboundMessage> {
    const msg = this.message(messageId);
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `UPDATE $msg SET hold = $hold, state = IF $hold THEN 'held' ELSE 'draft' END, hold_reason = NONE,
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
    // 发出前按任务卡与最新进展（如老板刚答复了受阻）重算一次没改过的草稿：发出去的永远是当前事实。失败不挡派工。
    await this.refreshDrafts(taskId).catch(error => console.warn(`draft refresh before send failed for ${taskId}: ${(error as Error).message}`));
    // 旧任务没有草稿：按模板即时生成一条，保证派工正文永远来自这张表。
    let draft = await this.latestDraft(taskId, step) ?? await this.seedDraft(taskId, step);
    if (draft.hold || draft.state === 'held') return null;
    // 返工消息在时限内等一等上一轮的完工分析（催办不等）；等不到就照常发。
    if (await this.awaitingAnalysis(taskId, step).catch(() => false)) return null;
    draft = await this.stampLang(draft, employeeLang);
    // Re-read payload + database-computed revision together after language alignment.
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT *, ${outboundRevisionSql()} AS dispatch_revision FROM $msg;`, { msg: this.message(draft.id) });
    if (!rows?.[0]) return null;
    draft = rowView(rows[0]);
    if (draft.hold || draft.state !== 'draft') return null;
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
  async alignLanguage(taskId: string, step: MessageStep, employeeId: string | undefined, role?: string): Promise<void> {
    const draft = await this.latestDraft(taskId, step) ?? await this.seedDraft(taskId, step);
    await this.stampLang(draft, await this.langOf(employeeId, role));
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

  /**
   * The language of the employee's role, from agent_policy (keyed by role); with no employee, the language of the given role (the role a
   * new instance would be spawned for). Undefined when the role has none (the original body is sent).
   */
  private async langOf(employeeId: string | undefined, role?: string): Promise<string | undefined> {
    let lang: unknown;
    if (employeeId) lang = (await rolePolicyOf(this.db, employeeId))?.lang;
    else if (role) {
      const [rows] = await this.db.query<[Array<{ lang?: unknown }>]>('SELECT lang FROM agent_policy WHERE agent = $role LIMIT 1;', { role });
      lang = rows?.[0]?.lang;
    }
    if (typeof lang !== 'string' || !lang) return undefined;
    // A role that speaks the owner's language needs no translation: the owner wrote the message in it.
    return langMatches(lang, await ownerLangOf(this.db)) ? undefined : lang;
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
      this.db.query<[Array<{ task: unknown; step: string; analysis_source?: string; body_edited?: boolean }>]>(
        "SELECT task, step, analysis_source, body_edited FROM outbound_message WHERE task IN $ids AND state != 'sent';", { ids }).then(r => r[0] ?? []),
    ]);
    const returned = new Set(returns.map(row => keyOf(row.task)));
    const have = new Set(drafts.map(row => `${keyOf(row.task)}:${row.step}`));
    for (const task of tasks) {
      const taskId = keyOf(task.id);
      const step = stepOfTask(task.state, returned.has(taskId));
      if (!have.has(`${taskId}:${step}`)) await this.seedDraft(taskId, step);
    }
    // 返工草稿还没按完工分析定过的：分析出来了就在领租约之前定上（把握不足的此时扣住，派工循环随后看到的就是扣住的草稿）。
    const open = new Set(drafts.filter(row => row.step === 'rework' && !row.analysis_source && row.body_edited !== true).map(row => keyOf(row.task)));
    const waiting = tasks.filter(task => stepOfTask(task.state, returned.has(keyOf(task.id))) === 'rework').map(task => keyOf(task.id))
      .filter(taskId => open.has(taskId) || !have.has(`${taskId}:rework`));
    if (waiting.length === 0) return;
    const [ready] = await this.db.query<[Array<{ task: unknown }>]>(
      "SELECT task FROM turn_analysis WHERE task IN $ids AND action IN ['return', 'owner_reject'] AND summary != NONE;", { ids: waiting.map(id => this.task(id)) });
    for (const taskId of new Set((ready ?? []).map(row => keyOf(row.task)))) {
      await this.refreshDrafts(taskId).catch(error => console.warn(`analysis attach failed for ${taskId}: ${(error as Error).message}`));
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
    // A re-dispatch of the same step (lease expired, instance replaced) repeats what was last sent, so an owner edit or a custom
    // body survives. Only a body composed from the task card and never edited is composed again: the card is the source of truth.
    const [sent] = await this.db.query<[Array<{ body?: string; body_edited?: boolean; body_verbatim?: boolean; composed?: unknown; answer_lead?: string; analysis_lead?: string; analysis_source?: string }>]>(
      `SELECT body, body_edited, body_verbatim, composed, answer_lead, analysis_lead, analysis_source, created_at FROM outbound_message WHERE task = $task AND step = $step AND state = 'sent' ORDER BY created_at DESC LIMIT 1;`,
      { task: this.task(taskId), step });
    const last = sent?.[0];
    const recompose = !last?.body || (last.composed && last.body_edited !== true);
    // 返工：数一数是第几轮，以及最近一次退回之后是否已经发过返工消息（同一轮的重派：租约过期、换实例）。
    let rounds = 0, sameRound = false;
    if (step === 'rework') {
      const [returns] = await this.db.query<[Array<{ at: unknown }>]>(
        // 【通道回滚】不是谁发现的缺陷，不算一轮（与 task-progress 的缺陷口径一致）。
        "SELECT at FROM audit WHERE task = $task AND action IN ['return', 'owner_reject'] AND (evidence = NONE OR !string::starts_with(evidence, '【通道回滚】')) ORDER BY at DESC;", { task: this.task(taskId) });
      const [resent] = await this.db.query<[unknown[]]>(
        "SELECT id FROM outbound_message WHERE task = $task AND step = 'rework' AND state = 'sent' AND sent_at > $since LIMIT 1;",
        { task: this.task(taskId), since: returns?.[0]?.at });
      rounds = returns?.length ?? 0;
      sameRound = Boolean(resent?.length);
    }
    // 上一轮复盘：同一轮的重派照上次发的来（带过就带、没带过就不带，迟到的分析不再加）；新一轮先不带，等这一轮的分析出来再定。
    const analysis = sameRound ? { analysis: last?.analysis_lead, analysisSource: last?.analysis_source ?? 'none' } : {};
    // 照抄旧正文（老板改过的、路线或需求流水线自定义的、旧模板的）时，先去掉里面旧的老板答复和旧的复盘（存的是当时加进去的原文），
    // 再把待转达的老板答复加在最前面：下次再受阻、再答复、再退回时不会叠两段。按任务卡重新组装的正文自己会带上这两段。
    let body: string | undefined, lead: string | undefined;
    if (!recompose && last?.body_verbatim === true) {
      // 老板的字面正文不是可更新模板，跨回合重派也不能删改或插入系统复盘段。
      body = last.body;
    } else if (!recompose) {
      const cut = (text: string, part?: string): string => {
        const at = part ? text.indexOf(`${part}\n\n`) : -1;
        return at >= 0 ? text.slice(0, at) + text.slice(at + part!.length + 2) : text;
      };
      let base = cut(last!.body!, last!.answer_lead);
      if (!sameRound) base = cut(base, last!.analysis_lead);
      const full = await this.promptTask(taskId);
      const { answer: _answer, notes: _notes, ...plain } = full;
      lead = ownerLead(this.leadsFor(step, step, full, plain));
      body = lead ? `${lead}\n\n${base}` : base;
    }
    let draft: OutboundMessage;
    try {
      draft = await this.createDraft(taskId, step, role, code, step === 'review' ? 'review' : 'doing', body, { answer: lead, ...analysis }, !recompose && last?.body_verbatim === true);
    } catch (error) {
      // 同一阶段已经有一条未发送草稿（含老板扣住或改过正文的）：补稿任务到此为止，返回那一条，绝不平行新建。
      if ((error as CompanyError).code === 'conflict') {
        const open = await this.latestDraft(taskId, step);
        if (open) return open;
      }
      throw error;
    }
    // 第二轮及以上返工先扣住等老板看：反复退回多半是需求或验收有分歧，继续自动派只会空转。同一轮返工的重派不再扣。
    if (step === 'rework' && rounds >= 2 && !sameRound && await this.holdForPolicy(draft.id, `第 ${rounds} 轮返工`)) {
      return { ...draft, hold: true, state: 'held', holdReason: `第 ${rounds} 轮返工` };
    }
    return draft;
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
    if (found) return found;
    try {
      return await this.createDraft(taskId, step, role, code, phase);
    } catch (error) {
      if ((error as CompanyError).code === 'conflict') {
        const open = await this.latestDraft(taskId, step);
        if (open) return open;
      }
      throw error;
    }
  }
}
