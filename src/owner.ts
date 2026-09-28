import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import type { CompanyBrief, GoalView, OwnerDecision, TaskId, TaskView } from './contracts.ts';
import { asId, CompanyError, HASH, id, requireText, UNLOCK_SQL, view, type IdempotencyRow, type TaskRow } from './core.ts';

export type OwnerCommandKind = 'goal' | 'approve' | 'reject' | 'reply' | 'direction' | 'pause' | 'resume';
export interface OwnerCommandRow {
  id: RecordId;
  kind: OwnerCommandKind;
  text?: string;
  task?: string;
  source: string;
  status: 'pending' | 'applying' | 'applied' | 'failed';
  created_at: Date;
}

export interface OwnerNotice { key: string; text: string; at: string }

export interface OwnerInbox {
  gates: Array<{ task: TaskView; submission?: string }>;
  questions: Array<{ task: TaskView; question?: string }>;
  notices: OwnerNotice[];
  pendingCommands: number;
}

interface GoalRow {
  id: RecordId;
  title: string;
  brief: string;
  state: GoalView['state'];
  tasks: { intake: RecordId; plan: RecordId; manual: RecordId; acceptance: RecordId };
}

const goalView = (row: GoalRow): GoalView => ({
  id: asId(row.id), title: row.title, brief: row.brief, state: row.state,
  tasks: {
    intake: asId(row.tasks.intake), plan: asId(row.tasks.plan),
    manual: asId(row.tasks.manual), acceptance: asId(row.tasks.acceptance),
  },
});

const EMIT_CREATED = (task: string) => `
  CREATE audit CONTENT { task: ${task}, actor: $source, action: 'create', version: 1, at: time::now() };
  LET $seq = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
  CREATE outbox CONTENT { task: ${task}, kind: 'created', sequence: $seq.value, payload: { state: ${task}.state }, at: time::now() };`;

function goalTaskContexts(title: string, brief: string, goalId: string) {
  const head = `所属目标：${title}（goal=${goalId}）\n老板原始输入：\n${brief}\n`;
  return {
    intake: `${head}
你是运营/产品。把老板的宽泛目标澄清为《目标澄清与范围提案》（模板见 operations 仓库 docs/templates.md「G1 范围提案」），写入 deliverables/${goalId}/G1-scope.md，并把全文作为 submit 证据。
必须包含：目标用户与场景、最小可用版本功能清单（按优先级）、明确不做、成本/时间/外部依赖假设、需要老板拍板的问题（最多 5 个，每个给选项与推荐）。
提交后由老板审批（G1 关口）；老板拒绝时会带意见退回给你修改。`,
    plan: `${head}
你是经理。G1 已由老板批准，先读本任务 history 里的 G1 提案与老板意见。
把目标拆成可独立验收的任务图：用 create_task 逐个创建，必须带 goalId="${goalId}"、清晰的执行岗位/验收岗位（执行者与验收者不同岗位或不同员工）、依赖、验收标准、可写范围、代码分支名。
涉及新增付费服务、注册外部账号、上生产、对外联系的节点，额外创建 kind="gate"、reviewerRole="owner" 的关口任务（G2）。
全部创建后提交本任务，证据写任务清单（id、标题、执行/验收岗位、依赖）。验收手册和最终验收任务已存在，会自动等待你创建的所有任务完成。`,
    manual: `${head}
你是运营/产品。目标下全部任务已验收。编写《真人验收操作手册》（模板见 docs/templates.md「真人验收操作手册」），写入 deliverables/${goalId}/acceptance-manual.md，全文作为 submit 证据。
写清：在哪里打开、需要什么账号/数据、逐步操作、每步预期结果、失败时如何判断与回退、已知限制。只写真实可操作的步骤。
提交后由 qa 按手册实际操作一遍验收。`,
    acceptance: `${head}
你是经理。验收手册已由 qa 实际操作验证。汇总《G3 最终验收申请》：交付清单、手册路径、qa 验证结论、已知限制、需要老板决定的事项；全文作为 submit 证据，提交后由老板最终验收。
若老板拒绝退回：读 history 中老板意见，用 create_task（带 goalId="${goalId}"）创建返工任务（必要时包含更新手册的任务）；创建返工任务会自动让本任务等待它们完成，随后结束本轮。`,
  };
}

/** Owner-side operations. Used by the owner CLI, the dispatcher (owner_command table) and gm relay. */
export class OwnerDesk {
  constructor(private readonly database: CompanyDatabase) {}
  private get db() { return this.database.db; }

  async createGoal(input: { text: string; source: string; key: string; note?: string }): Promise<GoalView> {
    requireText(input.text, 'goal text', 2, 20000);
    const goalId = HASH(`goal\0${input.key}`).slice(0, 16);
    const goal = id('goal', goalId);
    const existing = await this.db.select<GoalRow>(goal);
    if (existing) return goalView(existing);
    const title = input.text.trim().split(/\r?\n/)[0].slice(0, 60);
    const ctx = goalTaskContexts(title, input.text.trim(), goalId);
    const t = { intake: randomUUID(), plan: randomUUID(), manual: randomUUID(), acceptance: randomUUID() };
    const vars = {
      goal, title, brief: input.text.trim(), source: input.source, note: input.note ?? '',
      intake: id('task', t.intake), plan: id('task', t.plan), manual: id('task', t.manual), acceptance: id('task', t.acceptance),
      ctx,
    };
    const base = `version: 1, fence: 0, goal: $goal, resume_state: 'ready', created_at: time::now()`;
    try {
      await this.run(`BEGIN;
        CREATE ONLY $goal CONTENT { title: $title, brief: $brief, state: 'active', source: $source, note: $note,
          tasks: { intake: $intake, plan: $plan, manual: $manual, acceptance: $acceptance },
          anchors: [$manual, $acceptance], created_at: time::now() };
        CREATE ONLY $intake CONTENT { title: '[目标] ' + $title + ' · G1 范围提案', context: $ctx.intake, kind: 'gate',
          executor_role: 'product', reviewer_role: 'owner', dependencies: [], state: 'ready', ${base} };
        CREATE ONLY $plan CONTENT { title: '[目标] ' + $title + ' · 任务拆解与分派', context: $ctx.plan, kind: 'task',
          executor_role: 'gm', reviewer_role: 'product', dependencies: [$intake], state: 'blocked', ${base} };
        CREATE ONLY $manual CONTENT { title: '[目标] ' + $title + ' · 真人验收操作手册', context: $ctx.manual, kind: 'task',
          executor_role: 'product', reviewer_role: 'qa', dependencies: [$plan], state: 'blocked', ${base} };
        CREATE ONLY $acceptance CONTENT { title: '[目标] ' + $title + ' · G3 老板最终验收', context: $ctx.acceptance, kind: 'gate',
          executor_role: 'gm', reviewer_role: 'owner', dependencies: [$manual], state: 'blocked', ${base} };
        ${EMIT_CREATED('$intake')}${EMIT_CREATED('$plan')}${EMIT_CREATED('$manual')}${EMIT_CREATED('$acceptance')}
        COMMIT;`, vars);
    } catch (error) {
      const raced = await this.db.select<GoalRow>(goal);
      if (raced) return goalView(raced);
      throw error;
    }
    return goalView((await this.db.select<GoalRow>(goal))!);
  }

  /** approve/reject an owner-reviewed gate, or reply to a task blocked to the owner. */
  async decide(input: { taskId: TaskId; decision: OwnerDecision; note: string; source: string; key: string }): Promise<TaskView> {
    if (!['approve', 'reject', 'reply'].includes(input.decision)) throw new CompanyError('invalid', 'Invalid decision');
    requireText(input.note ?? '', 'note', input.decision === 'approve' ? 0 : 2, 20000);
    const idem = id('idempotency', HASH(`owner\0decide\0${input.key}`));
    const digest = HASH(JSON.stringify({ taskId: input.taskId, decision: input.decision, note: input.note }));
    const prior = await this.db.select<IdempotencyRow>(idem);
    if (prior) {
      if (prior.payload_digest !== digest) throw new CompanyError('conflict', 'Idempotency key reused with different input');
      return view(prior.result);
    }
    const evidence = `来源：${input.source}\n决定：${input.decision}\n${input.note ?? ''}`.trim();
    const rows = await this.run(`BEGIN;
      LET $t = SELECT * FROM ONLY $task;
      IF $t = NONE { THROW 'task not found' };
      IF $decision IN ['approve', 'reject'] AND ($t.state != 'review' OR $t.reviewer_role != 'owner') { THROW 'task is not awaiting owner review' };
      IF $decision = 'reply' AND ($t.state != 'blocked' OR $t.blocked_to != 'owner') { THROW 'task is not waiting for an owner answer' };
      LET $remaining = SELECT * FROM task WHERE id IN $t.dependencies AND state != 'done';
      LET $next = UPDATE ONLY $task SET
        state = IF $decision = 'approve' THEN 'done'
          ELSE IF $decision = 'reject' THEN 'ready'
          ELSE IF array::len($remaining) = 0 THEN ($t.resume_state ?? 'ready') ELSE 'blocked' END,
        accepted_by = IF $decision = 'approve' THEN 'owner' ELSE $t.accepted_by END,
        blocked_to = NONE, resume_role = NONE, resume_state = NONE, current_employee = NONE,
        delivery_id = NONE, lease_expires_at = NONE, version = $t.version + 1
        RETURN AFTER;
      CREATE audit CONTENT { task: $task, actor: $actor, action: 'owner_' + $decision, evidence: $evidence, version: $next.version, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $task, kind: 'owner_decision', sequence: $sequence.value, payload: { decision: $decision, state: $next.state }, at: time::now() };
      IF $decision = 'approve' { ${UNLOCK_SQL} };
      CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $next };
      RETURN $next;
      COMMIT;`, {
      task: id('task', input.taskId), decision: input.decision, evidence, actor: input.source, idem, digest,
    });
    return view(rows.at(-2) as TaskRow);
  }

  async addDirection(input: { text: string; source: string; key: string }): Promise<void> {
    requireText(input.text, 'direction', 2, 20000);
    const record = id('direction', HASH(`direction\0${input.key}`).slice(0, 16));
    if (await this.db.select(record)) return;
    await this.db.query('CREATE $record CONTENT { text: $text, source: $source, at: time::now() };',
      { record, text: input.text.trim(), source: input.source });
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.db.query('UPSERT company_meta:config MERGE { paused: $paused };', { paused });
  }

  async brief(): Promise<CompanyBrief> {
    const [directions, goals, config] = await this.db.query<[
      Array<{ text: string; source: string; at: unknown }>, GoalRow[], Array<{ paused?: boolean }>,
    ]>(`SELECT text, source, at FROM direction ORDER BY at DESC LIMIT 10;
      SELECT * FROM goal WHERE state = 'active' ORDER BY created_at;
      SELECT paused FROM company_meta:config;`);
    return {
      directions: directions.map(d => ({ text: d.text, source: d.source, at: String(d.at) })),
      goals: goals.map(goalView), paused: Boolean(config[0]?.paused),
    };
  }

  async raiseNotice(key: string, text: string): Promise<boolean> {
    const record = id('owner_notice', HASH(key).slice(0, 24));
    const existing = await this.db.select<{ resolved_at?: unknown; text: string }>(record);
    if (existing && !existing.resolved_at && existing.text === text) return false;
    await this.db.query('UPSERT $record CONTENT { key: $key, text: $text, at: time::now(), resolved_at: NONE };', { record, key, text });
    return !existing || Boolean(existing.resolved_at);
  }

  async resolveNotice(key: string): Promise<void> {
    await this.db.query('UPDATE $record SET resolved_at = time::now() WHERE resolved_at = NONE;',
      { record: id('owner_notice', HASH(key).slice(0, 24)) });
  }

  async openNotices(): Promise<OwnerNotice[]> {
    const [rows] = await this.db.query<[Array<{ key: string; text: string; at: unknown }>]>(
      'SELECT key, text, at FROM owner_notice WHERE resolved_at = NONE ORDER BY at;');
    return rows.map(r => ({ key: r.key, text: r.text, at: String(r.at) }));
  }

  async inbox(): Promise<OwnerInbox> {
    const [gates, questions, pending] = await this.db.query<[TaskRow[], TaskRow[], Array<{ count: number }>]>(
      `SELECT * FROM task WHERE state = 'review' AND reviewer_role = 'owner' ORDER BY id;
      SELECT * FROM task WHERE state = 'blocked' AND blocked_to = 'owner' ORDER BY id;
      SELECT count() FROM owner_command WHERE status IN ['pending', 'applying'] GROUP ALL;`);
    const latest = async (task: RecordId, action: string) => {
      const [rows] = await this.db.query<[Array<{ evidence?: string }>]>(
        'SELECT evidence, at FROM audit WHERE task = $task AND action = $action ORDER BY at DESC LIMIT 1;', { task, action });
      return rows[0]?.evidence;
    };
    return {
      gates: await Promise.all(gates.map(async row => ({ task: view(row), submission: await latest(row.id, 'submit') }))),
      questions: await Promise.all(questions.map(async row => ({ task: view(row), question: await latest(row.id, 'block') }))),
      notices: await this.openNotices(),
      pendingCommands: pending[0]?.count ?? 0,
    };
  }

  /** Applies owner_command rows written by the CLI or directly into SurrealDB. Safe to run concurrently. */
  async applyPending(limit = 20): Promise<Array<{ id: string; kind: string; status: string; result?: string }>> {
    await this.db.query(`UPDATE owner_command SET status = 'pending'
      WHERE status = 'applying' AND claimed_at < time::now() - 5m;`);
    const [rows] = await this.db.query<[OwnerCommandRow[]]>(
      "SELECT * FROM owner_command WHERE status = 'pending' ORDER BY created_at LIMIT $limit;", { limit });
    const results = [];
    for (const row of rows) {
      const [claimed] = await this.db.query<[OwnerCommandRow[]]>(
        "UPDATE $id SET status = 'applying', claimed_at = time::now() WHERE status = 'pending' RETURN AFTER;", { id: row.id });
      if (!claimed?.length) continue;
      const key = `command:${asId(row.id)}`;
      const source = `owner:${row.source ?? 'db'}`;
      let status = 'applied', result = '';
      try {
        switch (row.kind) {
          case 'goal': result = `goal=${(await this.createGoal({ text: row.text ?? '', source, key })).id}`; break;
          case 'approve': case 'reject': case 'reply':
            if (!row.task) throw new CompanyError('invalid', 'task is required');
            result = `state=${(await this.decide({ taskId: row.task, decision: row.kind, note: row.text ?? '', source, key })).state}`;
            break;
          case 'direction': await this.addDirection({ text: row.text ?? '', source, key }); break;
          case 'pause': case 'resume': await this.setPaused(row.kind === 'pause'); break;
          default: throw new CompanyError('invalid', 'unknown command kind');
        }
      } catch (error) {
        status = 'failed';
        result = error instanceof Error ? error.message : String(error);
      }
      await this.db.query('UPDATE $id SET status = $status, result = $result, applied_at = time::now();',
        { id: row.id, status, result });
      results.push({ id: asId(row.id), kind: row.kind, status, result });
    }
    return results;
  }

  private async run(query: string, vars: Record<string, unknown>): Promise<unknown[]> {
    const responses = await this.db.query<unknown[]>(query, vars).responses();
    const failure = responses.find(r => !r.success && !r.error.message.includes('not executed due to') && !r.error.message.startsWith('Cannot COMMIT'));
    if (failure && !failure.success) {
      const message = failure.error.message;
      if (/not found/i.test(message)) throw new CompanyError('not_found', message);
      if (/not awaiting|not waiting/i.test(message)) throw new CompanyError('conflict', message);
      throw new CompanyError('conflict', 'Owner operation conflicted; retry');
    }
    return responses.map(r => r.success ? r.result : undefined);
  }
}

