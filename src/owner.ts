import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import type { CompanyBrief, GoalTier, GoalView, OwnerDecision, TaskId, TaskView } from './contracts.ts';
import { GOAL_TIERS, goalTemplate } from './flows.ts';
import { ProjectStore } from './projects.ts';
import { asId, CompanyError, HASH, id, requireText, UNLOCK_SQL, view, type IdempotencyRow, type TaskRow } from './core.ts';

export type OwnerCommandKind = 'goal' | 'approve' | 'reject' | 'reply' | 'direction' | 'instruct' | 'pause' | 'resume';
export interface OwnerCommandRow {
  id: RecordId;
  kind: OwnerCommandKind;
  text?: string;
  tier?: GoalTier;
  project?: string;
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
  tier?: GoalTier;
  project?: RecordId;
  tasks: { intake?: RecordId; plan?: RecordId; manual?: RecordId; acceptance?: RecordId };
}

const goalView = (row: GoalRow): GoalView => ({
  id: asId(row.id), title: row.title, brief: row.brief, state: row.state, tier: row.tier,
  project: row.project ? asId(row.project) : undefined,
  tasks: Object.fromEntries(Object.entries(row.tasks ?? {}).filter(([, v]) => v).map(([k, v]) => [k, asId(v)])),
});

const EMIT_CREATED = (task: string) => `
  CREATE audit CONTENT { task: ${task}, actor: $source, action: 'create', version: 1, at: time::now() };
  LET $seq = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
  CREATE outbox CONTENT { task: ${task}, kind: 'created', sequence: $seq.value, payload: { state: ${task}.state }, at: time::now() };`;

/** Owner-side operations. Used by the owner CLI, the dispatcher (owner_command table) and gm relay. */
export class OwnerDesk {
  constructor(private readonly database: CompanyDatabase) {}
  private get db() { return this.database.db; }

  async createGoal(input: { text: string; source: string; key: string; note?: string; tier?: GoalTier; project?: string }): Promise<GoalView> {
    requireText(input.text, 'goal text', 2, 20000);
    if (input.tier !== undefined && !GOAL_TIERS.includes(input.tier)) throw new CompanyError('invalid', 'Invalid goal tier');
    const goalId = HASH(`goal\0${input.key}`).slice(0, 16);
    const goal = id('goal', goalId);
    let row = await this.db.select<GoalRow>(goal);
    if (!row) {
      const project = input.project ? id('project', input.project) : undefined;
      if (project && !(await this.db.select(project))) throw new CompanyError('not_found', `project ${input.project} not found`);
      const title = input.text.trim().split(/\r?\n/)[0].slice(0, 60);
      try {
        await this.db.query(`CREATE ONLY $goal CONTENT { title: $title, brief: $brief, state: 'triage', source: $source, note: $note,
          project: $project, tasks: {}, anchors: [], created_at: time::now() };`,
        { goal, title, brief: input.text.trim(), source: input.source, note: input.note ?? '', project });
      } catch (error) {
        if (!(await this.db.select<GoalRow>(goal))) throw error;
      }
      row = (await this.db.select<GoalRow>(goal))!;
    }
    return input.tier && row.state === 'triage' ? this.triage(goalId, input.tier, `${input.source} 指定`) : goalView(row);
  }

  /** Instantiates the flow template of a goal waiting in triage. Idempotent: a triaged goal is returned as is. */
  async triage(goalId: string, tier: GoalTier, via: string): Promise<GoalView> {
    if (!GOAL_TIERS.includes(tier)) throw new CompanyError('invalid', 'Invalid goal tier');
    const goal = id('goal', goalId);
    const row = await this.db.select<GoalRow>(goal);
    if (!row) throw new CompanyError('not_found', 'goal not found');
    if (row.state !== 'triage') return goalView(row);
    const template = goalTemplate(tier, row.title, row.brief, goalId);
    const ids = Object.fromEntries(template.tasks.map(t => [t.ref, id('task', randomUUID())]));
    const vars: Record<string, unknown> = { goal, tier, via, source: `triage:${via}`.slice(0, 200) };
    const creates = template.tasks.map((t, i) => {
      vars[`t${i}`] = ids[t.ref];
      vars[`spec${i}`] = { title: `[目标] ${row.title} · ${t.title}`, context: t.context, kind: t.kind,
        executor_role: t.executorRole, reviewer_role: t.reviewerRole, dependencies: t.deps.map(d => ids[d]) };
      return `CREATE ONLY $t${i} CONTENT { title: $spec${i}.title, context: $spec${i}.context, kind: $spec${i}.kind,
          executor_role: $spec${i}.executor_role, reviewer_role: $spec${i}.reviewer_role, dependencies: $spec${i}.dependencies,
          state: IF array::len($spec${i}.dependencies) = 0 THEN 'ready' ELSE 'blocked' END,
          version: 1, fence: 0, goal: $goal, resume_state: 'ready', created_at: time::now() };
        ${EMIT_CREATED(`$t${i}`)}`;
    });
    const refs = Object.fromEntries(Object.entries(template.refs).filter(([, ref]) => ref).map(([k, ref]) => [k, ids[ref!]]));
    vars.refs = refs;
    vars.anchors = template.anchors.map(ref => ids[ref]);
    await this.run(`BEGIN;
      LET $g = SELECT * FROM ONLY $goal;
      IF $g.state != 'triage' { THROW 'goal already triaged' };
      ${creates.join('\n')}
      UPDATE ONLY $goal SET state = 'active', tier = $tier, triage_via = $via, tasks = $refs, anchors = $anchors;
      COMMIT;`, vars).catch(async error => {
      const again = await this.db.select<GoalRow>(goal);
      if (again?.state !== 'triage') return [];
      throw error;
    });
    return goalView((await this.db.select<GoalRow>(goal))!);
  }

  async triagePending(): Promise<GoalView[]> {
    const [rows] = await this.db.query<[GoalRow[]]>("SELECT * FROM goal WHERE state = 'triage' ORDER BY created_at;");
    return rows.map(goalView);
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
      LET $remaining = SELECT * FROM task WHERE id IN $t.dependencies AND (state != 'done' AND (state != 'void' OR (reviewer_role = 'owner' AND ($t.goal = NONE OR $t.id NOT IN ($t.goal.anchors ?? [])))));
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
      SELECT * FROM goal WHERE state IN ['triage', 'active'] ORDER BY created_at;
      SELECT paused FROM company_meta:config;`);
    return {
      directions: directions.map(d => ({ text: d.text, source: d.source, at: String(d.at) })),
      goals: goals.map(goalView), projects: await new ProjectStore(this.db).list(), paused: Boolean(config[0]?.paused),
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

  /** Free-form owner instruction routed to the manager as a gm task; gm decides how to act on it. */
  async instruct(input: { text: string; source: string; key: string }): Promise<{ taskId: string }> {
    requireText(input.text, 'instruction text', 2, 10000);
    const taskId = HASH(`instruct\0${input.key}`).slice(0, 16);
    const task = id('task', taskId);
    if (await this.db.select(task)) return { taskId };
    const title = `老板指示：${input.text.trim().split(/\r?\n/)[0].slice(0, 60)}`;
    await this.db.query(`CREATE ONLY $task CONTENT { title: $title, context: $context, kind: 'task',
      executor_role: 'gm', reviewer_role: 'product', dependencies: [], state: 'ready',
      version: 1, fence: 0, resume_state: 'ready', created_at: time::now() };
      ${EMIT_CREATED('$task')}`, { task, title, context: `老板原话：\n${input.text.trim()}\n\n来源：${input.source}` });
    return { taskId };
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
          case 'goal': result = `goal=${(await this.createGoal({ text: row.text ?? '', source, key, tier: row.tier, project: row.project })).id}`; break;
          case 'approve': case 'reject': case 'reply':
            if (!row.task) throw new CompanyError('invalid', 'task is required');
            result = `state=${(await this.decide({ taskId: row.task, decision: row.kind, note: row.text ?? '', source, key })).state}`;
            break;
          case 'direction': await this.addDirection({ text: row.text ?? '', source, key }); break;
          case 'instruct': result = `task=${(await this.instruct({ text: row.text ?? '', source, key })).taskId}`; break;
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

