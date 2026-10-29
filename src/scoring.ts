import { generatedModel } from './model-routing/policy.ts';
import { createHash } from 'node:crypto';
import { RecordId, type Surreal } from 'surrealdb';
import { scoreModels } from './model-routing/store.ts';
import { QUOTA_RELEASE } from './dispatcher/quota-failure.ts';
import type { EmployeeScore, Role, TaskId } from './contracts.ts';
import { costBaseline, readTaskCost, recordTaskCost, type TaskCost, type UsageFetch } from './task-cost.ts';

const HASH = (value: string) => createHash('sha256').update(value).digest('hex');
const asId = (record: RecordId | string): string => record instanceof RecordId ? String(record.id) : record;
const id = (table: string, key: string): RecordId => new RecordId(table, key);

export interface EvalMetrics {
  claims: number; checkpoints: number; submits: number; reviews: number; returnsReceived: number; revocations: number;
  /** Submits the system checks refused before review (submit_check_failed). */
  checkFailures?: number;
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
  timelineTruncated?: boolean;
  modelExecutions?: Array<{employee:string;model?:string;fence:number;phase:string;at:string;ended_at?:string}>;
  /** What the task consumed (tokens, USD, model time, elapsed), when Magpie usage was readable. */
  cost?: TaskCost;
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
    `SELECT action, actor, at, evidence FROM audit WHERE task = $task AND action != 'ops_call' ORDER BY at ASC;
     SELECT payload.employee AS employee FROM outbox WHERE task = $task AND kind = 'revoked';`,
    { task });

  // Remove only claim-only rounds positively identified as infrastructure failures.
  // Keep genuine work from the same employee in any earlier/later round.
  const ignoredClaims = new Set<number>();
  const open = new Map<string, { index: number; worked: boolean }>();
  for (const [index, r] of auditRows.entries()) {
    if (!(r.actor instanceof RecordId) || r.actor.table.name !== 'employee') continue;
    const employee = asId(r.actor);
    if (r.action === 'claim') open.set(employee, { index, worked: false });
    const round = open.get(employee);
    if (!round) continue;
    if (['checkpoint', 'submit', 'accept', 'return', 'block'].includes(r.action)) round.worked = true;
    if (r.action === 'released') {
      if (r.evidence?.includes(QUOTA_RELEASE) && !round.worked) ignoredClaims.add(round.index);
      open.delete(employee);
    }
  }
  const participants = new Set<string>();
  const metrics = new Map<string, EvalMetrics>();
  const metric = (emp: string) => {
    const m = metrics.get(emp) ?? { claims: 0, checkpoints: 0, submits: 0, reviews: 0, returnsReceived: 0, revocations: 0 };
    metrics.set(emp, m);
    return m;
  };
  const timeline: EvalTimelineEntry[] = [];
  let lastSubmitter: string | undefined;
  for (const [index, r] of auditRows.entries()) {
    if (ignoredClaims.has(index)) continue;
    const infrastructure = r.action === 'released' && r.evidence?.includes(QUOTA_RELEASE);
    const isEmployee = !infrastructure && r.actor instanceof RecordId && r.actor.table.name === 'employee';
    const actor = infrastructure ? 'infrastructure' : isEmployee ? asId(r.actor as RecordId) : String(r.actor ?? 'system');
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
    else if (r.action === 'submit_check_failed') m.checkFailures = (m.checkFailures ?? 0) + 1;
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

  const [modelExecutions] = await db.query<[NonNullable<EvalState['modelExecutions']>]>(
    "SELECT employee,model,fence,phase,<string>at AS at,<string>ended_at AS ended_at FROM model_execution WHERE task=$task AND completed=true AND status>=200 AND status<300 AND phase!='auxiliary' ORDER BY at ASC LIMIT 2001;", {task});
  if (modelExecutions.length>2000) throw new Error("Model evidence exceeds 2000 executions; final evaluation requires a complete timeline");
  const cost = await readTaskCost(db, taskId).catch(() => undefined);
  return {
    ...(cost ? { cost } : {}),
    modelExecutions:modelExecutions.filter(r=>!r.model||!generatedModel(r.model)),
    timelineTruncated:auditRows.length>TIMELINE_LIMIT,
    taskId, goalId: row.goal ? asId(row.goal) : undefined,
    title: row.title, context: String(row.context ?? '').slice(0, CONTEXT_CHARS),
    state: row.state, executorRole: row.executor_role, reviewerRole: row.reviewer_role,
    participants: [...participants].sort(), metrics: Object.fromEntries(metrics), timeline,
  };
}

/** One employee's actual models on a task: what modelScores must cover, without the per-request rows. */
export interface ModelEvidence {
  employee: string;
  models: Array<{ model: string; executions: number; fences: number[]; phases: string[]; first: string; last: string }>;
}

/**
 * Per (employee, model) rollup of successful executions. A long task has hundreds of rows that exceed the reply
 * budget; the rollup is a few lines per participant and is exactly the set validateScores enforces.
 */
export function summarizeModelEvidence(rows: NonNullable<EvalState['modelExecutions']>): ModelEvidence[] {
  const by = new Map<string, Map<string, ModelEvidence['models'][number]>>();
  for (const r of rows) {
    if (!r.model || generatedModel(r.model)) continue;
    const models = by.get(r.employee) ?? new Map();
    by.set(r.employee, models);
    const m = models.get(r.model) ?? { model: r.model, executions: 0, fences: [], phases: [], first: r.at, last: r.at };
    models.set(r.model, m);
    m.executions++;
    if (!m.fences.includes(r.fence)) m.fences.push(r.fence);
    if (!m.phases.includes(r.phase)) m.phases.push(r.phase);
    if (r.at < m.first) m.first = r.at;
    if (r.at > m.last) m.last = r.at;
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([employee, models]) => ({
    employee, models: [...models.values()].sort((a, b) => a.model.localeCompare(b.model)).map(m => ({ ...m, fences: m.fences.sort((a, b) => a - b) })),
  }));
}

/**
 * Rule-based calibration the judge cannot override: the LLM's overall is kept as judge_overall, and the overall that
 * feeds every average is the judge's score minus deductions for facts in the audit trail, plus an efficiency step
 * against the median cost and elapsed time of other tasks of the same complexity (authors only: reviewers do not drive
 * a task's cost). Every step names its basis so an employee can see why a score moved.
 */
export interface Calibration {
  judgeOverall: number;
  overall: number;
  complexity: number;
  adjustments: Array<{ code: string; points: number; basis: string }>;
  usd?: number; elapsedSeconds?: number;
  baseline?: { usd: number; elapsedSeconds: number; samples: number };
}

const clampScore = (x: number) => Math.min(5, Math.max(1, Math.round(x * 100) / 100));

export function calibrate(input: {
  judgeOverall: number; metrics?: EvalMetrics; complexity: number; author: boolean;
  cost?: Pick<TaskCost, 'usd' | 'elapsedSeconds'>; baseline?: Calibration['baseline'];
}): Calibration {
  const m = input.metrics;
  const adjustments: Calibration['adjustments'] = [];
  const deduct = (code: string, count: number, each: number, cap: number, basis: string) => {
    if (count > 0) adjustments.push({ code, points: -Math.min(cap, count * each), basis });
  };
  deduct('returns', m?.returnsReceived ?? 0, 0.5, 1.5, `被退回 ${m?.returnsReceived ?? 0} 次`);
  deduct('revocations', m?.revocations ?? 0, 0.5, 1, `租约被收回 ${m?.revocations ?? 0} 次`);
  deduct('check_failures', m?.checkFailures ?? 0, 0.5, 1, `系统检查退回提交 ${m?.checkFailures ?? 0} 次`);
  const { cost, baseline } = input;
  if (input.author && cost && baseline && cost.usd > 0 && cost.elapsedSeconds) {
    const ratio = Math.max(cost.usd / baseline.usd, cost.elapsedSeconds / baseline.elapsedSeconds);
    const basis = `成本 $${cost.usd.toFixed(4)}/中位 $${baseline.usd.toFixed(4)}，耗时 ${Math.round(cost.elapsedSeconds / 60)}/${Math.round(baseline.elapsedSeconds / 60)} 分钟（复杂度 ${input.complexity}，${baseline.samples} 个样本）`;
    if (ratio > 4) adjustments.push({ code: 'efficiency', points: -1, basis });
    else if (ratio > 2) adjustments.push({ code: 'efficiency', points: -0.5, basis });
    else if (ratio < 0.5 && !adjustments.length) adjustments.push({ code: 'efficiency', points: 0.5, basis });
  }
  const total = adjustments.reduce((a, x) => a + x.points, 0);
  // No rule fired: the judge's score stands exactly as given.
  return { judgeOverall: input.judgeOverall, overall: adjustments.length ? clampScore(input.judgeOverall + total) : input.judgeOverall, complexity: input.complexity, adjustments,
    ...(cost ? { usd: cost.usd, ...(cost.elapsedSeconds !== undefined ? { elapsedSeconds: cost.elapsedSeconds } : {}) } : {}),
    ...(baseline ? { baseline } : {}) };
}

/** Task complexity 1-5 as the judge rated it; 3 when not given. */
export function clampComplexity(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? Math.min(5, Math.max(1, Math.round(x))) : 3;
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
    const required = new Set(state.modelExecutions?.filter(r=>r.employee===s.employee && r.model && !generatedModel(r.model)).map(r=>r.model));
    // Name the gap: an eval employee is entitled to these models, and a bare refusal turned scoring into guessing.
    const missing = [...required].filter(m=>!s.modelScores?.some(a=>a.model===m)).sort();
    if (required.size>1 && missing.length) return `Missing model assessments: ${s.employee} needs ${missing.join(', ')}`;
    const models = s.modelScores;
    if (models) {
      const actual = new Set(state.modelExecutions?.filter(r=>r.employee===s.employee && r.model && !generatedModel(r.model)).map(r=>r.model));
      if (new Set(models.map(m=>m.model)).size !== models.length) return `Duplicate model assessment: ${s.employee}`;
      for (const m of models) {
        if (!actual.has(m.model)) return `Invalid model assessment: ${m.model} is not a model of ${s.employee} (actual: ${[...actual].sort().join(', ') || 'none'})`;
        if (!Number.isFinite(m.overall) || m.overall<1 || m.overall>5) return `Invalid model assessment: ${m.model}`;
      }
    }
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
  input: { taskId: TaskId; summary: string; judge: string; judgeKind: 'llm' | 'jev'; scores: ScoredEmployee[]; state: EvalState; topPerformer?: string;
    complexity?: number; fetchUsage?: UsageFetch },
): Promise<{ recorded: number; participants: string[] }> {
  const invalid = validateScores(input.state,input.scores);
  if(invalid) throw new Error(invalid);
  const task = id('task', input.taskId);
  const written = new Set<string>();
  // The cost is settled before the raw model_execution rows become prunable (they are kept until evaluated_at).
  const cost = input.state.cost ?? await recordTaskCost(db, input.taskId, input.fetchUsage).catch(() => undefined);
  const complexity = clampComplexity(input.complexity);
  if (cost) await db.query('UPDATE $c SET complexity = $complexity RETURN NONE;', { c: id('task_cost', input.taskId), complexity });
  const baseline = cost ? await costBaseline(db, complexity, input.taskId).catch(() => undefined) : undefined;
  for (const judged of input.scores) {
    const calibration = calibrate({ judgeOverall: judged.overall, metrics: input.state.metrics[judged.employee], complexity,
      author: (input.state.metrics[judged.employee]?.submits ?? 0) > 0, ...(cost ? { cost } : {}), ...(baseline ? { baseline } : {}) });
    const s = { ...judged, overall: calibration.overall };
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
    await db.query('UPDATE $card SET judge_overall = $judge, calibration = $calibration RETURN NONE;',
      { card: id('scorecard', HASH(`${input.taskId}${s.employee}`).slice(0, 24)), judge: judged.overall, calibration });
    const actualModels = await scoreModels(db, input.taskId, s.employee, s.overall, s.modelScores);
    await db.query('UPDATE $card SET model_scores=$assessments,configured_model=$configured,model=$model,actual_models=$models, model_attribution=$basis RETURN NONE;', {card: id('scorecard', HASH(`${input.taskId}${s.employee}`).slice(0,24)), assessments:s.modelScores,models:actualModels, configured:emp?.model,model:actualModels.length===1?actualModels[0]:actualModels.length?'mixed':'unknown', basis:actualModels.length ? 'gateway-completed-requests' : 'unknown'});
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

/**
 * Recomputes every aggregate the scoring path writes, from the scorecards alone. writeScorecards records the cards and
 * marks the task evaluated before it rolls the averages; a failure in that last step (a row the schema refuses, a
 * timeout) leaves `scored`/`avg_score` one run behind, and recordScore's early return on `evaluated_at` means no retry
 * repairs them. This is the repeatable repair entry: idempotent, reads scorecards, writes only the two aggregate columns.
 */
export async function rescoreAggregates(db: Surreal): Promise<{ employees: number; defs: number }> {
  const [empRows] = await db.query<[Array<{ employee: string }>]>('SELECT employee FROM scorecard GROUP BY employee;');
  const [defRows] = await db.query<[Array<{ def: string }>]>('SELECT def FROM scorecard WHERE def IS NOT NONE GROUP BY def;');
  const employees = [...new Set((empRows ?? []).map(r => String(r.employee ?? '')).filter(Boolean))];
  const defs = [...new Set((defRows ?? []).map(r => String(r.def ?? '')).filter(Boolean))];
  for (const key of employees) await rescore(db, 'employee', key, 'employee');
  for (const key of defs) await rescore(db, 'employee_def', key, 'def');
  return { employees: employees.length, defs: defs.length };
}

export async function rescore(db: Surreal, table: 'employee' | 'employee_def', key: string, scoreField: 'employee' | 'def'): Promise<void> {
  const [[agg]] = await db.query<[[{ avg?: number; n?: number }]]>(
    `SELECT math::mean(overall) AS avg, count() AS n FROM scorecard WHERE ${scoreField} = $key AND excluded_infrastructure != true GROUP ALL;`, { key });
  await db.query('UPDATE $r SET scored = $n, avg_score = $a;', { r: id(table, key), n: agg?.n ?? 0, a: agg?.avg ?? undefined });
}


/** Conservative, reversible repair: retain original scorecards; exclude only proven quota-only participants. */
export async function repairInfrastructureScores(db: Surreal, execute = false): Promise<{ candidates: string[]; applied: boolean }> {
  const [cards] = await db.query<[Array<{id: RecordId; task: RecordId; employee: string}>]>(
    "SELECT id, task, employee FROM scorecard WHERE excluded_infrastructure != true AND task IN (SELECT VALUE task FROM audit WHERE action = 'released' AND string::contains(evidence ?? '', $marker));", { marker: QUOTA_RELEASE });
  const states = new Map<string, EvalState>();
  const candidates: string[] = [];
  for (const card of cards) {
    const taskId = asId(card.task);
    let state = states.get(taskId);
    if (!state) { state = await collectEvalState(db, taskId); states.set(taskId, state); }
    if (state.participants.includes(card.employee)) continue;
    // Absence alone is not proof (old/incomplete audit data). Require the explicit
    // infrastructure release for this exact employee, which collectEvalState labels.
    const [releases] = await db.query<[Array<{id: RecordId}>]>(
      "SELECT id FROM audit WHERE task = $task AND actor = $actor AND action = 'released' AND string::contains(evidence ?? '', $marker) LIMIT 1;",
      { task: card.task, actor: id('employee', card.employee), marker: QUOTA_RELEASE });
    if (!releases.length) continue;
    candidates.push(asId(card.id));
    if (execute) await db.query('UPDATE $card SET excluded_infrastructure = true, exclusion_reason = $reason, exclusion_at = time::now();',
      { card: card.id, reason: QUOTA_RELEASE });
  }
  if (execute) await rescoreAggregates(db);
  return { candidates, applied: execute };
}
