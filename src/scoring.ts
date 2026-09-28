import { createHash } from 'node:crypto';
import { RecordId, type Surreal } from 'surrealdb';
import type { EmployeeScore, Role, TaskId } from './contracts.ts';

const HASH = (value: string) => createHash('sha256').update(value).digest('hex');
const asId = (record: RecordId | string): string => record instanceof RecordId ? String(record.id) : record;
const id = (table: string, key: string): RecordId => new RecordId(table, key);

export interface EvalMetrics {
  claims: number; checkpoints: number; submits: number; reviews: number; returnsReceived: number; revocations: number;
}

export interface EvalTimelineEntry { at: string; action: string; actor: string; evidence?: string }

/** Everything a judge (Jev or LLM eval employee) needs to score a finished task. */
export interface EvalState {
  taskId: TaskId;
  goalId?: string;
  title: string;
  context: string;
  state: string;
  executorRole: string;
  reviewerRole: string;
  participants: string[];
  metrics: Record<string, EvalMetrics>;
  timeline: EvalTimelineEntry[];
}

const TIMELINE_LIMIT = 40;
const TIMELINE_EVIDENCE_CHARS = 400;
const CONTEXT_CHARS = 3000;

/** Read audit + revocation events for a finished task and derive per-participant behavior metrics. */
export async function collectEvalState(db: Surreal, taskId: TaskId, excludeEmployeeId?: string): Promise<EvalState> {
  const task = id('task', taskId);
  const row = await db.select<{ title: string; context: string; state: string; executor_role: Role; reviewer_role: Role; goal?: RecordId }>(task);
  if (!row) throw { code: 'not_found' };

  const [auditRows, revokedRows] = await db.query<[
    Array<{ action: string; actor: unknown; at?: unknown; evidence?: string }>,
    Array<{ employee?: string }>,
  ]>(
    `SELECT action, actor, at, evidence FROM audit WHERE task = $task ORDER BY at ASC;
     SELECT payload.employee AS employee FROM outbox WHERE task = $task AND kind = 'revoked';`,
    { task });

  const participants = new Set<string>();
  const metrics = new Map<string, EvalMetrics>();
  const metric = (emp: string) => {
    const m = metrics.get(emp) ?? { claims: 0, checkpoints: 0, submits: 0, reviews: 0, returnsReceived: 0, revocations: 0 };
    metrics.set(emp, m);
    return m;
  };
  const timeline: EvalTimelineEntry[] = [];
  let lastSubmitter: string | undefined;
  for (const r of auditRows) {
    const isEmployee = r.actor instanceof RecordId && r.actor.table.name === 'employee';
    const actor = isEmployee ? asId(r.actor as RecordId) : String(r.actor ?? 'system');
    if (r.action !== 'evaluated' && timeline.length < TIMELINE_LIMIT) {
      timeline.push({ at: String(r.at ?? ''), action: r.action, actor,
        evidence: typeof r.evidence === 'string' ? r.evidence.slice(0, TIMELINE_EVIDENCE_CHARS) : undefined });
    }
    if (!isEmployee || r.action === 'evaluated') continue;
    const emp = actor;
    participants.add(emp);
    const m = metric(emp);
    if (r.action === 'claim') m.claims++;
    else if (r.action === 'checkpoint') m.checkpoints++;
    else if (r.action === 'submit') { m.submits++; lastSubmitter = emp; }
    else if (r.action === 'accept' || r.action === 'return') {
      m.reviews++;
      if (r.action === 'return' && lastSubmitter && lastSubmitter !== emp) metric(lastSubmitter).returnsReceived++;
    }
  }
  for (const r of revokedRows) {
    if (!r.employee) continue;
    participants.add(String(r.employee));
    metric(String(r.employee)).revocations++;
  }
  if (excludeEmployeeId) participants.delete(excludeEmployeeId);

  return {
    taskId, goalId: row.goal ? asId(row.goal) : undefined,
    title: row.title, context: String(row.context ?? '').slice(0, CONTEXT_CHARS),
    state: row.state, executorRole: row.executor_role, reviewerRole: row.reviewer_role,
    participants: [...participants].sort(), metrics: Object.fromEntries(metrics), timeline,
  };
}

export interface ScoredEmployee extends EmployeeScore {
  confidence?: number;
  probabilities?: Record<string, Record<string, number>>;
  flagged?: boolean;
}

/** Validate that a score entry is a participant with all five dimensions inside 1-5. */
export function validateScores(state: EvalState, scores: EmployeeScore[]): string | undefined {
  const dims = ['quality', 'evidence', 'discipline', 'timeliness', 'overall'] as const;
  for (const s of scores) {
    if (!state.participants.includes(s.employee)) return `Not a participant: ${s.employee}`;
    for (const d of dims) {
      if (typeof s[d] !== 'number' || !Number.isFinite(s[d]) || s[d] < 1 || s[d] > 5) return `Invalid ${d} score`;
    }
  }
  return undefined;
}

/**
 * Idempotently write one scorecard per (task, employee), mark the task evaluated,
 * emit the audit/outbox events, and roll averages into employee + employee_def.
 * Shared by the LLM eval role (core.recordScore) and the dispatcher's Jev path.
 */
export async function writeScorecards(
  db: Surreal,
  input: { taskId: TaskId; summary: string; judge: string; judgeKind: 'llm' | 'jev'; scores: ScoredEmployee[]; state: EvalState; topPerformer?: string },
): Promise<{ recorded: number; participants: string[] }> {
  const task = id('task', input.taskId);
  const written = new Set<string>();
  for (const s of input.scores) {
    const emp = await db.select<{ role?: Role; def?: RecordId; provider?: string; model?: string }>(id('employee', s.employee));
    await db.query(`UPSERT $card CONTENT { task: $task, goal: $goal, employee: $emp, role: $role, def: $def,
      provider: $provider, model: $model, quality: $quality, evidence: $evidence, discipline: $discipline,
      timeliness: $timeliness, overall: $overall, notes: $notes, metrics: $metrics, eval_by: $by,
      judge: $judgeKind, confidence: $confidence, probabilities: $probabilities, flagged: $flagged, at: time::now() };`, {
      card: id('scorecard', HASH(`${input.taskId}${s.employee}`).slice(0, 24)),
      task, goal: input.state.goalId ? id('goal', input.state.goalId) : undefined,
      emp: s.employee, role: emp?.role ?? input.state.executorRole,
      def: emp?.def ? asId(emp.def) : undefined, provider: emp?.provider, model: emp?.model,
      quality: s.quality, evidence: s.evidence, discipline: s.discipline, timeliness: s.timeliness,
      overall: s.overall, notes: s.notes, metrics: input.state.metrics[s.employee], by: input.judge,
      judgeKind: input.judgeKind, confidence: s.confidence, probabilities: s.probabilities, flagged: s.flagged === true,
    });
    written.add(s.employee);
  }

  await db.query(`BEGIN;
    UPDATE ONLY $task SET evaluated_at = IF evaluated_at = NONE THEN time::now() ELSE evaluated_at END, eval_via = $judgeKind;
    CREATE audit CONTENT { task: $task, actor: $actor, action: 'evaluated', evidence: $summary, at: time::now() };
    LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
    CREATE outbox CONTENT { task: $task, kind: 'evaluated', sequence: $sequence.value,
      payload: { by: $evalBy, judge: $judgeKind, employees: $count, top: $top }, at: time::now() };
    COMMIT;`, {
    task, actor: input.judgeKind === 'llm' ? id('employee', input.judge) : input.judge,
    summary: input.summary, evalBy: input.judge, judgeKind: input.judgeKind,
    count: written.size, top: input.topPerformer,
  });

  const defs = new Set<string>();
  for (const empId of written) {
    const emp = await db.select<{ def?: RecordId }>(id('employee', empId));
    await rescore(db, 'employee', empId, 'employee');
    if (emp?.def) defs.add(asId(emp.def));
  }
  for (const defId of defs) await rescore(db, 'employee_def', defId, 'def');
  return { recorded: written.size, participants: input.state.participants };
}

export async function rescore(db: Surreal, table: 'employee' | 'employee_def', key: string, scoreField: 'employee' | 'def'): Promise<void> {
  const [[agg]] = await db.query<[[{ avg?: number; n?: number }]]>(
    `SELECT math::mean(overall) AS avg, count() AS n FROM scorecard WHERE ${scoreField} = $key GROUP ALL;`, { key });
  await db.query('UPDATE $r SET scored = $n, avg_score = $a;', { r: id(table, key), n: agg?.n ?? 0, a: agg?.avg ?? undefined });
}
