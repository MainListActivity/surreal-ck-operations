/**
 * SYS07 P2 · read/write layer for goal outcomes, evidence and the console.
 *
 * All writes are additive, compare-and-set and audited. Reads never write. The final-gate decision itself is
 * made by assessGoal; this class only persists `needs_repair` and a legal, CAS-checked reference repair.
 */
import { createHash, randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import {
  assessGoal, cardSort, finalGateId, normalizeEvidence, normalizeOutcome,
  type GoalAssessment, type GoalCard, type GoalEvidenceFact, type GoalEvidenceInput, type GoalEvidenceKind,
  type GoalFact, type GoalFaultFact, type GoalOutcomeFact, type GoalOutcomeInput, type GoalStage, type GoalTaskFact,
  type GoalWaitFact,
} from './goal-governance.ts';
import { isTimeZone } from './waits.ts';
import { computeGoalMetrics, type GoalMetricsView, type GoalMetricsWindow, type MetricAuditRow, type MetricEvidenceRow,
  type MetricGoalRow, type MetricTaskRow, type MetricUsageRow, type MetricWakeRow } from './goal-metrics.ts';

export interface GoalDb {
  query<T extends unknown[] = unknown[]>(sql: string, vars?: Record<string, unknown>): Promise<T>;
  select<T>(id: unknown): Promise<T | undefined>;
}

const HASH = (value: string) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown): string => String(value ?? '').replace(/^goal:/, '').replace(/^task:/, '').replace(/[⟨⟩]/g, '');
const ms = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
};
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const arr = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : [];

export interface GoalRecord {
  id: string;
  title: string;
  brief: string;
  state: GoalFact['state'];
  tier?: string;
  pipeline?: string;
  project?: string;
  created_at?: unknown;
  done_at?: unknown;
  deadline?: unknown;
  deadline_timezone?: string;
  needs_repair?: boolean;
  needs_repair_reason?: string;
  version?: number;
  tasks?: Record<string, unknown>;
  anchors?: unknown[];
}

export interface GoalTaskRecord {
  id: unknown;
  title: string;
  state: string;
  kind?: string;
  goal?: unknown;
  executor_role: string;
  reviewer_role: string;
  version?: number;
  blocked_to?: string;
  current_employee?: string;
  lease_expires_at?: number;
  dependencies?: unknown[];
  created_at?: unknown;
  accepted_by?: string;
  submitted_by?: string;
  superseded_by?: unknown;
  lineage?: unknown;
  revision_no?: number;
  wait_state?: string;
  wait_kind?: string;
  wait_not_before?: number;
  wait_expires_at?: number;
  wait_next_check_at?: number;
  wait_owner_role?: string;
  wait_entered_at?: unknown;
  dispatch_blocked_phase?: string;
  dispatch_blocked_since?: number;
}

export const GOAL_TASK_FIELDS = `id, goal, title, state, kind, executor_role, reviewer_role, version, blocked_to, current_employee,
  lease_expires_at, dependencies, created_at, accepted_by, submitted_by, superseded_by, lineage, revision_no, acceptance_attempt,
  wait_state, wait_kind, wait_not_before, wait_expires_at, wait_next_check_at, wait_owner_role, wait_entered_at,
  dispatch_blocked_phase, dispatch_blocked_since`;

function goalFact(row: GoalRecord): GoalFact {
  const refs = row.tasks ?? {};
  const pick = (key: string): string | undefined => refs[key] === undefined || refs[key] === null ? undefined : text(refs[key]);
  return {
    id: text(row.id), title: row.title, brief: row.brief, state: row.state,
    ...(row.tier ? { tier: row.tier } : {}), ...(row.pipeline ? { pipeline: row.pipeline } : {}),
    ...(row.project ? { project: text(row.project) } : {}),
    ...(ms(row.created_at) !== undefined ? { createdAt: ms(row.created_at) } : {}),
    ...(ms(row.done_at) !== undefined ? { doneAt: ms(row.done_at) } : {}),
    ...(ms(row.deadline) !== undefined ? { deadline: ms(row.deadline) } : {}),
    ...(row.deadline_timezone ? { deadlineTimezone: row.deadline_timezone } : {}),
    ...(row.needs_repair !== undefined ? { needsRepair: row.needs_repair } : {}),
    ...(row.needs_repair_reason ? { needsRepairReason: row.needs_repair_reason } : {}),
    ...(row.version !== undefined ? { version: row.version } : {}),
    tasks: { ...(pick('intake') ? { intake: pick('intake') } : {}), ...(pick('plan') ? { plan: pick('plan') } : {}),
      ...(pick('manual') ? { manual: pick('manual') } : {}), ...(pick('acceptance') ? { acceptance: pick('acceptance') } : {}) },
    anchors: arr(row.anchors),
  };
}

function taskFact(row: GoalTaskRecord): GoalTaskFact {
  return {
    id: text(row.id), title: row.title, state: row.state,
    ...(row.kind ? { kind: row.kind } : {}),
    executorRole: row.executor_role, reviewerRole: row.reviewer_role,
    ...(row.blocked_to ? { blockedTo: row.blocked_to } : {}),
    ...(row.current_employee ? { currentEmployee: row.current_employee } : {}),
    ...(row.lease_expires_at !== undefined ? { leaseExpiresAt: row.lease_expires_at } : {}),
    dependencies: arr(row.dependencies),
    ...(row.version !== undefined ? { version: row.version } : {}),
    ...(ms(row.created_at) !== undefined ? { createdAt: ms(row.created_at) } : {}),
    ...(row.accepted_by ? { acceptedBy: row.accepted_by } : {}),
    ...(row.submitted_by ? { submittedBy: row.submitted_by } : {}),
    ...(row.superseded_by ? { supersededBy: text(row.superseded_by) } : {}),
    ...(row.lineage ? { lineage: text(row.lineage) } : {}),
    ...(row.revision_no !== undefined ? { revisionNo: row.revision_no } : {}),
    ...(row.wait_state ? { waitState: row.wait_state } : {}),
    ...(row.wait_kind ? { waitKind: row.wait_kind } : {}),
    ...(num(row.wait_not_before) !== undefined ? { waitNotBefore: num(row.wait_not_before) } : {}),
    ...(num(row.wait_expires_at) !== undefined ? { waitExpiresAt: num(row.wait_expires_at) } : {}),
    ...(num(row.wait_next_check_at) !== undefined ? { waitNextCheckAt: num(row.wait_next_check_at) } : {}),
    ...(row.wait_owner_role ? { waitOwnerRole: row.wait_owner_role } : {}),
    ...(ms(row.wait_entered_at) !== undefined ? { waitEnteredAt: ms(row.wait_entered_at) } : {}),
    ...(row.dispatch_blocked_phase ? { dispatchBlockedPhase: row.dispatch_blocked_phase } : {}),
    ...(num(row.dispatch_blocked_since) !== undefined ? { dispatchBlockedSince: num(row.dispatch_blocked_since) } : {}),
  };
}

function waitFact(row: Record<string, unknown>): GoalWaitFact {
  return {
    taskId: text(row.task), waitKey: String(row.wait_key ?? ''), kind: String(row.kind ?? ''), state: String(row.state ?? ''),
    ownerRole: String(row.owner_role ?? ''), reason: String(row.reason ?? ''),
    ...(num(row.not_before) !== undefined ? { notBefore: num(row.not_before) } : {}),
    ...(num(row.expires_at) !== undefined ? { expiresAt: num(row.expires_at) } : {}),
    ...(num(row.next_check_at) !== undefined ? { nextCheckAt: num(row.next_check_at) } : {}),
    ...(ms(row.entered_at) !== undefined ? { enteredAt: ms(row.entered_at) } : {}),
    completed: arr(row.completed),
    ...(row.pending_action ? { pendingAction: String(row.pending_action) } : {}),
    ...(row.progress && typeof row.progress === 'object' && (row.progress as { employee?: string }).employee
      ? { progressEmployee: String((row.progress as { employee?: string }).employee) } : {}),
  };
}

function outcomeFact(row: Record<string, unknown>): GoalOutcomeFact {
  return {
    expected: String(row.expected ?? ''), requiredEvidence: Array.isArray(row.required_evidence)
      ? row.required_evidence.map(String) as GoalOutcomeFact['requiredEvidence'] : [],
    responsibleRole: String(row.responsible_role ?? ''), version: Number(row.version ?? 1),
    source: String(row.source ?? ''), ...(ms(row.updated_at) !== undefined ? { updatedAt: ms(row.updated_at) } : {}),
    ...(ms(row.deadline) !== undefined ? { deadline: ms(row.deadline) } : {}),
    ...(row.timezone ? { timezone: String(row.timezone) } : {}),
  };
}

function evidenceFact(row: Record<string, unknown>): GoalEvidenceFact {
  return {
    id: text(row.id), kind: String(row.kind ?? '') as GoalEvidenceKind, summary: String(row.summary ?? ''),
    source: String(row.source ?? ''), confirmedBy: String(row.confirmed_by ?? ''),
    evidenceType: String(row.evidence_type ?? 'manual_signoff') as GoalEvidenceFact['evidenceType'],
    at: ms(row.at) ?? Date.now(), digest: String(row.digest ?? ''),
    ...(row.task ? { taskId: text(row.task) } : {}),
  };
}

export interface GoalPageInput {
  goalId?: string;
  includeClosed?: boolean;
  cursor?: string;
  pageSize?: number;
  needsRepairOnly?: boolean;
}

export interface GoalPageView {
  goals: GoalCard[];
  page: { pageSize: number; returned: number; hasMore: boolean; nextCursor?: string; total: number; snapshotAt: string; budgetBytes: number };
  dataCutoff: string;
  coverage: {
    goals: number; tasks: number; missingOutcome: number; unknownDeadline: number;
    byPipeline: Record<string, number>;
    blockers: Record<string, number>;
  };
  guidance: string;
}

export interface GoalScanView {
  dryRun: true;
  scanned: number;
  goals: GoalCard[];
  /** Cards omitted from this response for size; counts and scanned still cover every goal. Use goal_console to page. */
  truncated?: number;
  counts: { needsRepair: number; missingOutcome: number; finalGateGap: number; graphIssues: number; unknownDeadline: number };
  dataCutoff: string;
  guidance: string;
}

export interface GoalOutcomeView extends Omit<GoalOutcomeFact, 'updatedAt'> {
  goalId: string;
  registeredAt?: string;
  updatedAt?: string;
}

export interface GoalFinalGateCandidate {
  taskId: string; title: string; state: string; executorRole: string; reviewerRole: string;
  version: number; dependencies: string[]; missing: string[];
}

export interface GoalFinalGatePreview {
  goalId: string;
  goalVersion: number;
  currentFinalGate?: { taskId: string; title: string; state: string; reviewerRole: string; superseded: boolean; voided: boolean };
  candidate?: GoalFinalGateCandidate;
  violations: Array<{ code: string; message: string }>;
  ready: boolean;
  unfinished: Array<{ taskId: string; title: string; state: string }>;
  snapshot: { version: 1; hash: string };
}

export interface GoalFinalGateRepairInput {
  goalId: string; candidateTaskId: string; expectedOldTaskId?: string; expectedGoalVersion: number;
  snapshotHash: string; reason: string; actor: string; idempotencyKey: string;
}

export interface GoalFinalGateRepairResult {
  goalId: string; oldTaskId?: string; newTaskId: string; goalVersion: number; snapshotHash: string; repairedAt: string;
}

export class GoalGovernanceStore {
  constructor(private readonly db: GoalDb, private readonly clock: () => number = Date.now) {}

  private async now(): Promise<number> {
    try {
      const [rows] = await this.db.query<[Array<{ at?: unknown }>]>('SELECT time::now() AS at;');
      return ms(rows?.[0]?.at) ?? this.clock();
    } catch {
      return this.clock();
    }
  }

  private cursorDigest(input: GoalPageInput): string {
    return HASH(JSON.stringify({
      goalId: input.goalId ?? null, includeClosed: input.includeClosed === true, needsRepairOnly: input.needsRepairOnly === true,
    }));
  }

  private sealCursor(input: GoalPageInput, offset: number, asOf: number): string {
    return Buffer.from(JSON.stringify({ v: 1, q: this.cursorDigest(input), o: offset, t: asOf })).toString('base64url');
  }

  /** The cursor pins the offset and the listing instant, so a goal created between pages cannot shift or duplicate. */
  private openCursor(input: GoalPageInput, cursor: string): { offset: number; asOf: number } {
    try {
      const body = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: number; q?: string; o?: number; t?: number };
      if (body.v !== 1 || body.q !== this.cursorDigest(input) || !Number.isSafeInteger(body.o) || (body.o ?? -1) < 0 ||
        !Number.isSafeInteger(body.t) || (body.t ?? -1) <= 0) {
        throw new Error('bad cursor');
      }
      return { offset: body.o!, asOf: body.t! };
    } catch {
      throw new Error('goal console cursor is invalid or belongs to another query');
    }
  }

  /** Run a multi-statement transaction and surface the failing statement's message, not the generic wrapper. */
  private async run(sql: string, vars: Record<string, unknown>): Promise<void> {
    const query = this.db.query(sql, vars) as unknown as {
      responses?: () => Promise<Array<{ success: boolean; error?: { message?: string } }>>;
      then?: Promise<unknown>['then'];
    };
    if (typeof query.responses === 'function') {
      const results = await query.responses();
      const failure = results.find(result => !result.success &&
        !(result.error?.message ?? '').includes('not executed due to') &&
        !(result.error?.message ?? '').startsWith('Cannot COMMIT'));
      if (failure) throw new Error(failure.error?.message ?? 'transaction failed');
      return;
    }
    await (query as Promise<unknown>);
  }

  private async goalRows(ids?: string[]): Promise<GoalRecord[]> {
    const [rows] = ids?.length
      ? await this.db.query<[GoalRecord[]]>('SELECT * FROM goal WHERE id IN $ids;', { ids: ids.map(id => new RecordId('goal', id)) })
      : await this.db.query<[GoalRecord[]]>('SELECT * FROM goal ORDER BY created_at, id;');
    return rows ?? [];
  }

  private async tasksOfGoals(goalIds: string[]): Promise<GoalTaskRecord[]> {
    if (!goalIds.length) return [];
    const [rows] = await this.db.query<[GoalTaskRecord[]]>(
      `SELECT ${GOAL_TASK_FIELDS} FROM task WHERE goal IN $goals ORDER BY created_at, id;`,
      { goals: goalIds.map(id => new RecordId('goal', id)) });
    return rows ?? [];
  }

  private async waitsOfTasks(taskIds: string[]): Promise<GoalWaitFact[]> {
    if (!taskIds.length) return [];
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT * FROM task_wait WHERE task IN $tasks AND state IN ['waiting', 'held', 'expired'] ORDER BY entered_at;`,
      { tasks: taskIds.map(id => new RecordId('task', id)) });
    return (rows ?? []).map(waitFact);
  }

  private async faultsOfTasks(taskIds: string[]): Promise<GoalFaultFact[]> {
    if (!taskIds.length) return [];
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT task, phase, state, opened_at FROM fault_episode WHERE task IN $tasks AND state NOT IN ['resolved'] ORDER BY opened_at;`,
      { tasks: taskIds.map(id => new RecordId('task', id)) }).catch(() => [[]] as [Array<Record<string, unknown>>]);
    return (rows ?? []).map(row => ({
      taskId: text(row.task), phase: String(row.phase ?? ''), state: String(row.state ?? ''),
      ...(ms(row.opened_at) !== undefined ? { openedAt: ms(row.opened_at) } : {}),
    }));
  }

  private async outcomesOf(goalIds: string[]): Promise<Map<string, GoalOutcomeFact>> {
    if (!goalIds.length) return new Map();
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      'SELECT * FROM goal_outcome WHERE goal IN $goals;', { goals: goalIds.map(id => new RecordId('goal', id)) });
    return new Map((rows ?? []).map(row => [text(row.goal), outcomeFact(row)]));
  }

  private async evidenceOf(goalIds: string[]): Promise<Map<string, GoalEvidenceFact[]>> {
    if (!goalIds.length) return new Map();
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      'SELECT * FROM goal_evidence WHERE goal IN $goals ORDER BY at, id;', { goals: goalIds.map(id => new RecordId('goal', id)) });
    const result = new Map<string, GoalEvidenceFact[]>();
    for (const row of rows ?? []) {
      const goalId = text(row.goal);
      const list = result.get(goalId) ?? [];
      list.push(evidenceFact(row));
      result.set(goalId, list);
    }
    return result;
  }

  private async cardsFor(goalRows: GoalRecord[], now: number): Promise<GoalCard[]> {
    const goalIds = goalRows.map(row => text(row.id));
    const [tasks, outcomes, evidence] = await Promise.all([
      this.tasksOfGoals(goalIds), this.outcomesOf(goalIds), this.evidenceOf(goalIds),
    ]);
    const taskIds = tasks.map(task => text(task.id));
    const taskIdSet = new Set(taskIds);
    const missingDeps = [...new Set(tasks.flatMap(task => taskFact(task).dependencies).filter(dep => !taskIdSet.has(dep)))];
    const [externalRows] = missingDeps.length ? await this.db.query<[Array<{ id: unknown; goal?: unknown }>]>(
      'SELECT id, goal FROM task WHERE id IN $deps;', { deps: missingDeps.map(dep => new RecordId('task', dep)) }) : [[] as Array<{ id: unknown; goal?: unknown }>];
    const externalGoalByTask = new Map((externalRows ?? []).map(row => [text(row.id), text(row.goal)]));
    const [waits, faults] = await Promise.all([this.waitsOfTasks(taskIds), this.faultsOfTasks(taskIds)]);
    const tasksByGoal = new Map<string, GoalTaskFact[]>();
    const externalByGoal = new Map<string, Array<{ taskId: string; dependency: string; goalId?: string }>>();
    for (const row of tasks) {
      const goalId = row.goal ? text(row.goal) : undefined;
      if (!goalId) continue;
      const fact = taskFact(row);
      for (const dep of fact.dependencies) {
        const otherGoal = externalGoalByTask.get(dep);
        if (taskIdSet.has(dep) || !otherGoal || otherGoal === goalId) continue;
        const list = externalByGoal.get(goalId) ?? [];
        list.push({ taskId: fact.id, dependency: dep, goalId: otherGoal });
        externalByGoal.set(goalId, list);
      }
    }
    for (const row of tasks) {
      const goalId = row.goal ? text(row.goal) : undefined;
      if (!goalId) continue;
      const list = tasksByGoal.get(goalId) ?? [];
      list.push(taskFact(row));
      tasksByGoal.set(goalId, list);
    }
    const waitsByTask = new Map(waits.map(wait => [wait.taskId, wait]));
    const faultsByTask = new Map(faults.map(fault => [fault.taskId, fault]));
    return goalRows.map(row => {
      const goal = goalFact(row);
      const goalTasks = tasksByGoal.get(goal.id) ?? [];
      const goalWaits = goalTasks.map(task => waitsByTask.get(task.id)).filter((wait): wait is GoalWaitFact => Boolean(wait));
      const goalFaults = goalTasks.map(task => faultsByTask.get(task.id)).filter((fault): fault is GoalFaultFact => Boolean(fault));
      const assessment = assessGoal({
        goal, tasks: goalTasks, waits: goalWaits, faults: goalFaults,
        ...(outcomes.get(goal.id) ? { outcome: outcomes.get(goal.id)! } : {}),
        evidence: evidence.get(goal.id) ?? [], ...(externalByGoal.get(goal.id) ? { externalDependencies: externalByGoal.get(goal.id)! } : {}),
        now,
      });
      const blockerCap = 8, taskCap = 20, reasonCap = 12;
      return {
        ...assessment,
        needsRepair: assessment.needsRepair || goal.state === 'needs_repair',
        blockers: assessment.blockers.slice(0, blockerCap).map(blocker => ({
          ...blocker, dependencyPath: blocker.dependencyPath.slice(0, 8),
        })),
        ...(assessment.blockers.length > blockerCap ? { blockersOmitted: assessment.blockers.length - blockerCap } : {}),
        repairReasons: assessment.repairReasons.slice(0, reasonCap),
        sourceTaskIds: assessment.sourceTaskIds.slice(0, taskCap),
        ...(assessment.sourceTaskIds.length > taskCap ? { sourceTaskIdsTruncated: true } : {}),
        title: goal.title, brief: goal.brief.slice(0, 800),
        ...(goal.tier ? { tier: goal.tier } : {}), ...(goal.pipeline ? { pipeline: goal.pipeline } : {}),
        ...(goal.project ? { project: goal.project } : {}),
        ...(goal.createdAt !== undefined ? { createdAt: goal.createdAt } : {}),
        ...(goal.needsRepair !== undefined ? { needsRepairStored: goal.needsRepair } : {}),
        taskTotal: goalTasks.length,
      } satisfies GoalCard;
    });
  }

  /** Paged read. `total` counts the filtered listing before paging; `hasMore` is deterministic. */
  async page(input: GoalPageInput = {}): Promise<GoalPageView> {
    // The console carries source ids and blockers per card, so its page stays small; the full task list is a
    // separate get_context listing by goalId.
    const pageSize = Math.max(1, Math.min(25, Math.trunc(input.pageSize ?? 10)));
    const now = await this.now();
    const cursor = input.cursor ? this.openCursor(input, input.cursor) : undefined;
    const asOf = cursor?.asOf ?? now;
    let rows = await this.goalRows();
    // Existing goals created after the first page's instant belong to a later listing, not to this pagination.
    rows = rows.filter(row => {
      const createdAt = ms(row.created_at);
      return createdAt === undefined || createdAt <= asOf;
    });
    if (input.goalId) rows = rows.filter(row => text(row.id) === input.goalId);
    if (!input.includeClosed) rows = rows.filter(row => row.state === 'active' || row.state === 'triage' || row.state === 'needs_repair');
    if (input.needsRepairOnly) {
      const prior = await this.cardsFor(rows, now);
      const keep = new Set(prior.filter(card => card.needsRepair).map(card => card.goalId));
      rows = rows.filter(row => keep.has(text(row.id)));
    }
    const offset = cursor?.offset ?? 0;
    const selected = rows.slice(offset, offset + pageSize);
    const cards = (await this.cardsFor(selected, now)).sort(cardSort);
    const end = offset + selected.length;
    const hasMore = end < rows.length;
    const pipelineCounts: Record<string, number> = {};
    const blockerCounts: Record<string, number> = {};
    let missingOutcome = 0;
    let unknownDeadline = 0;
    for (const card of cards) {
      pipelineCounts[card.pipeline ?? 'software'] = (pipelineCounts[card.pipeline ?? 'software'] ?? 0) + 1;
      if (!card.outcome.registered) missingOutcome++;
      if (card.deadline.status === 'unknown') unknownDeadline++;
      for (const blocker of card.blockers) blockerCounts[blocker.kind] = (blockerCounts[blocker.kind] ?? 0) + 1;
    }
    return {
      goals: cards,
      page: {
        pageSize, returned: cards.length, hasMore, total: rows.length, snapshotAt: new Date(asOf).toISOString(), budgetBytes: 48 * 1024,
        ...(hasMore ? { nextCursor: this.sealCursor(input, end, asOf) } : {}),
      },
      dataCutoff: new Date(now).toISOString(),
      coverage: { goals: rows.length, tasks: cards.reduce((sum, card) => sum + card.taskTotal, 0),
        missingOutcome, unknownDeadline, byPipeline: pipelineCounts, blockers: blockerCounts },
      guidance: '完整任务用 get_context 传 goalId 与 pageSize 分页读取；每张卡只带阻塞事实和源任务 id。',
    };
  }

  /** Read-only dry-run over active, needs_repair and done goals; writes nothing and never closes/voids/approves anything. */
  async scan(limit = 20): Promise<GoalScanView> {
    const now = await this.now();
    // Done goals are read too: a historical goal whose gate was voided or whose customer receipt never existed is
    // surfaced as goal_done_without_evidence, never silently treated as complete. The scan still writes nothing.
    const rows = (await this.goalRows()).filter(row => row.state === 'active' || row.state === 'needs_repair' || row.state === 'done');
    const cards = (await this.cardsFor(rows, now)).sort(cardSort);
    const counts = {
      needsRepair: cards.filter(card => card.needsRepair).length,
      missingOutcome: cards.filter(card => !card.outcome.registered).length,
      finalGateGap: cards.filter(card => card.repairReasons.some(reason =>
        reason.code === 'final_gate_missing' || reason.code === 'final_gate_void' || reason.code === 'final_gate_superseded')).length,
      graphIssues: cards.filter(card => card.graph.cycle || card.graph.dangling.length > 0 || card.graph.crossGoal.length > 0).length,
      unknownDeadline: cards.filter(card => card.deadline.status === 'unknown').length,
    };
    const shown = cards.slice(0, Math.max(1, Math.min(50, limit)));
    return { dryRun: true, scanned: cards.length, goals: shown, counts, dataCutoff: new Date(now).toISOString(),
      ...(shown.length < cards.length ? { truncated: cards.length - shown.length } : {}),
      guidance: '只读扫描：不会撤销、关闭或批准任何历史任务；counts 覆盖全部目标，未展示的卡片用 goal_console 分页；修复需按目标显式预览并 CAS 提交。' };
  }

  async card(goalId: string): Promise<GoalCard | undefined> {
    const rows = await this.goalRows([goalId]);
    if (!rows.length) return undefined;
    return (await this.cardsFor(rows, await this.now()))[0];
  }

  /** Persist goal_outcome under a version CAS. A scope change is an authorized new version, not a silent edit. */
  async registerOutcome(input: {
    goalId: string; outcome: GoalOutcomeInput; expectedVersion: number; actor: string; source: string;
    reason: string; auditId: string; outboxId: string;
  }): Promise<GoalOutcomeView> {
    const normalized = normalizeOutcome(input.outcome);
    const now = await this.now();
    const goal = new RecordId('goal', input.goalId);
    const outcomeId = new RecordId('goal_outcome', input.goalId);
    const existing = await this.db.select<Record<string, unknown>>(outcomeId);
    if (input.expectedVersion === 0 && existing) throw new Error('outcome already registered');
    if (input.expectedVersion > 0 && (!existing || Number(existing.version) !== input.expectedVersion)) {
      throw new Error('outcome version moved');
    }
    const nextVersion = input.expectedVersion + 1;
    await this.run(`BEGIN;
      LET $g = SELECT * FROM ONLY $goal;
      IF $g = NONE OR $g.state = 'cancelled' { THROW 'goal not available' };
      LET $old = SELECT * FROM ONLY $outcome;
      IF $expected = 0 AND $old != NONE { THROW 'outcome already registered' };
      IF $expected > 0 AND ($old = NONE OR $old.version != $expected) { THROW 'outcome version moved' };
      UPSERT $outcome CONTENT {
        goal: $goal, expected: $expected_text, required_evidence: $required, responsible_role: $role,
        deadline: $deadline, timezone: $timezone, version: $next, source: $source, actor: $actor,
        reason: $reason, created_at: IF $old = NONE THEN time::now() ELSE $old.created_at END, updated_at: time::now()
      };
      LET $gv = ($g.version ?? 0) + 1;
      UPDATE ONLY $goal SET version = $gv, deadline = $deadline, deadline_timezone = $timezone,
        outcome_updated_at = time::now();
      CREATE audit CONTENT { goal: $goal, actor: $actor, action: 'goal_outcome_registered',
        evidence: $evidence, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { kind: 'goal_outcome_registered', sequence: $sequence.value,
        payload: { goal: $goal_key, version: $next, required: $required }, at: time::now() };
      COMMIT;`, {
      goal, outcome: outcomeId, expected: input.expectedVersion, expected_text: normalized.expected,
      required: normalized.requiredEvidence, role: normalized.responsibleRole,
      deadline: normalized.deadline === undefined ? undefined : new Date(normalized.deadline),
      timezone: normalized.timezone ?? undefined, next: nextVersion, source: input.source, actor: input.actor,
      reason: input.reason, evidence: JSON.stringify({ expected: normalized.expected, required: normalized.requiredEvidence,
        version: nextVersion, deadline: normalized.deadline ?? null, timezone: normalized.timezone ?? null,
        reason: input.reason.slice(0, 500) }),
      goal_key: input.goalId,
    });
    return {
      goalId: input.goalId, ...normalized, version: nextVersion, source: input.source,
      updatedAt: new Date(now).toISOString(),
    };
  }

  /** Record one immutable outcome receipt. `owner_final` is rejected by the pure normalizer. */
  async recordEvidence(input: {
    goalId: string; evidence: GoalEvidenceInput; actor: string; reason: string;
    auditId: string; outboxId: string;
  }): Promise<GoalEvidenceFact> {
    const normalized = normalizeEvidence(input.evidence, await this.now());
    const goal = new RecordId('goal', input.goalId);
    const g = await this.db.select<Record<string, unknown>>(goal);
    if (!g) throw new Error('goal not found');
    if (g.state === 'cancelled') throw new Error('goal is cancelled');
    if (normalized.taskId) {
      const task = await this.db.select<Record<string, unknown>>(new RecordId('task', normalized.taskId));
      if (!task || text(task.goal) !== input.goalId) throw new Error('evidence task is not in this goal');
    }
    const digest = HASH(JSON.stringify({ ...normalized, actor: input.actor }));
    const id = new RecordId('goal_evidence', randomUUID());
    try {
      await this.run(`BEGIN;
        LET $g = SELECT * FROM ONLY $goal;
        IF $g = NONE OR $g.state = 'cancelled' { THROW 'goal not available' };
        CREATE ONLY $evidence CONTENT {
          goal: $goal, kind: $kind, summary: $summary, source: $source, confirmed_by: $confirmed_by,
          evidence_type: $evidence_type, task: $task, at: $at, actor: $actor, version: 1,
          digest: $digest, created_at: time::now()
        };
        CREATE audit CONTENT { goal: $goal, task: $task, actor: $actor, action: 'goal_evidence_recorded',
          evidence: $audit_text, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE outbox CONTENT { task: $task, kind: 'goal_evidence_recorded', sequence: $sequence.value,
          payload: { goal: $goal_key, kind: $kind, digest: $digest }, at: time::now() };
        COMMIT;`, {
        goal, evidence: id, kind: normalized.kind, summary: normalized.summary, source: normalized.source,
        confirmed_by: normalized.confirmedBy, evidence_type: normalized.evidenceType,
        task: normalized.taskId ? new RecordId('task', normalized.taskId) : undefined,
        at: new Date(normalized.at), actor: input.actor, digest,
        audit_text: JSON.stringify({ kind: normalized.kind, source: normalized.source,
          confirmedBy: normalized.confirmedBy, at: new Date(normalized.at).toISOString(), digest,
          reason: input.reason.slice(0, 500) }),
        goal_key: input.goalId,
      });
    } catch (error) {
      if (/digest|already exists/i.test((error as Error).message)) {
        const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
          'SELECT * FROM goal_evidence WHERE goal = $goal AND kind = $kind AND digest = $digest LIMIT 1;',
          { goal, kind: normalized.kind, digest });
        if (rows?.[0]) return evidenceFact(rows[0]);
        throw new Error('evidence already recorded');
      }
      throw new Error((error as Error).message);
    }
    return {
      id: text(id), kind: normalized.kind, summary: normalized.summary, source: normalized.source,
      confirmedBy: normalized.confirmedBy, evidenceType: normalized.evidenceType, at: normalized.at, digest,
      ...(normalized.taskId ? { taskId: normalized.taskId } : {}),
    };
  }

  /** Re-evaluate one goal and persist the verdict. Never rewrites a task or an owner decision. */
  async finalize(goalId: string, actor: string, acceptedTaskId?: string): Promise<{ card: GoalCard; changed: boolean; state: string }> {
    const card = await this.card(goalId);
    if (!card) throw new Error('goal not found');
    // Ordinary task acceptance is not a goal verdict; only the effective final gate can close or park the goal.
    if (acceptedTaskId !== undefined && card.finalGate.taskId !== acceptedTaskId) {
      return { card, changed: false, state: card.state };
    }
    if (card.state !== 'active' && card.state !== 'needs_repair') return { card, changed: false, state: card.state };
    const reasons = card.repairReasons.map(reason => reason.message);
    const now = await this.now();
    const row = (await this.goalRows([goalId]))[0]!;
    const version = row.version ?? 0;
    if (card.readyToComplete) {
      await this.run(`BEGIN;
        LET $g = SELECT * FROM ONLY $goal;
        IF $g = NONE OR $g.state NOT IN ['active', 'needs_repair'] OR ($g.version ?? 0) != $version { THROW 'goal version moved' };
        LET $next = UPDATE ONLY $goal SET state = 'done', done_at = time::now(), needs_repair = false,
          needs_repair_reason = NONE, outcome_complete = true, outcome_updated_at = time::now(),
          version = ($g.version ?? 0) + 1 RETURN AFTER;
        CREATE audit CONTENT { goal: $goal, task: $final_gate, actor: $actor, action: 'goal_completed',
          evidence: $evidence, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE outbox CONTENT { task: $final_gate, kind: 'goal_completed', sequence: $sequence.value,
          payload: { goal: $goal_key, version: $next.version }, at: time::now() };
        COMMIT;`, { goal: new RecordId('goal', goalId), final_gate: card.finalGate.taskId ? new RecordId('task', card.finalGate.taskId) : null,
        version, actor, goal_key: goalId, evidence: JSON.stringify({ finalGate: card.finalGate, stages: card.stages }) });
      return { card: (await this.card(goalId))!, changed: true, state: 'done' };
    }
    if (reasons.length) {
      const reason = reasons.slice(0, 8).join('；').slice(0, 1000) || '终验缺口';
      await this.run(`BEGIN;
        LET $g = SELECT * FROM ONLY $goal;
        IF $g = NONE OR $g.state NOT IN ['active', 'needs_repair'] OR ($g.version ?? 0) != $version { THROW 'goal version moved' };
        UPDATE ONLY $goal SET state = 'needs_repair', needs_repair = true, needs_repair_reason = $reason, needs_repair_at = time::now(),
          outcome_complete = false, outcome_updated_at = time::now(), version = ($g.version ?? 0) + 1;
        CREATE audit CONTENT { goal: $goal, task: $final_gate, actor: $actor, action: 'goal_needs_repair',
          evidence: $evidence, at: time::now() };
        LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
        CREATE outbox CONTENT { task: $final_gate, kind: 'goal_needs_repair', sequence: $sequence.value,
          payload: { goal: $goal_key, reason: $reason }, at: time::now() };
        COMMIT;`, { goal: new RecordId('goal', goalId), final_gate: card.finalGate.taskId ? new RecordId('task', card.finalGate.taskId) : null,
        version, reason, actor, goal_key: goalId, evidence: JSON.stringify({ reasons: card.repairReasons, now }) });
      return { card: (await this.card(goalId))!, changed: true, state: 'needs_repair' };
    }
    if (card.state === 'needs_repair') {
      await this.run(`BEGIN;
        LET $g = SELECT * FROM ONLY $goal;
        IF $g = NONE OR $g.state != 'needs_repair' OR ($g.version ?? 0) != $version { THROW 'goal version moved' };
        UPDATE ONLY $goal SET state = 'active', needs_repair = false, needs_repair_reason = NONE,
          needs_repair_at = NONE, version = ($g.version ?? 0) + 1;
        CREATE audit CONTENT { goal: $goal, actor: $actor, action: 'goal_repair_cleared',
          evidence: $evidence, at: time::now() };
        COMMIT;`, { goal: new RecordId('goal', goalId),
        version, actor, evidence: JSON.stringify({ repaired: true, now }) });
      return { card: (await this.card(goalId))!, changed: true, state: 'active' };
    }
    return { card, changed: false, state: card.state };
  }

  /** Read-only repair preview for a goal whose final gate is void, superseded or missing. */
  async finalGatePreview(input: { goalId: string; candidateTaskId?: string }): Promise<GoalFinalGatePreview> {
    const now = await this.now();
    const rows = await this.goalRows([input.goalId]);
    if (!rows.length) throw new Error('goal not found');
    const row = rows[0]!;
    const goal = goalFact(row);
    const tasks = (await this.tasksOfGoals([input.goalId])).map(taskFact);
    const byId = new Map(tasks.map(task => [task.id, task]));
    const currentId = finalGateId(goal);
    const current = currentId ? byId.get(currentId) : undefined;
    const candidate = input.candidateTaskId ? byId.get(input.candidateTaskId) : undefined;
    const unfinished = tasks.filter(task => !['done', 'void'].includes(task.state) && task.id !== input.candidateTaskId);
    const violations: Array<{ code: string; message: string }> = [];
    if (goal.state !== 'active' && goal.state !== 'needs_repair') violations.push({ code: 'conflict', message: `goal is ${goal.state}, not active` });
    if (!input.candidateTaskId) violations.push({ code: 'invalid', message: 'candidateTaskId is required' });
    else if (!candidate) violations.push({ code: 'not_found', message: 'candidate task not found in this goal' });
    else {
      if (candidate.id === currentId) violations.push({ code: 'invalid', message: 'candidate is already the final gate' });
      if (['done', 'void'].includes(candidate.state)) violations.push({ code: 'conflict', message: `candidate must be open, found ${candidate.state}` });
      if (candidate.submittedBy) violations.push({ code: 'conflict', message: 'candidate already has a submission' });
      if (candidate.currentEmployee && (candidate.leaseExpiresAt ?? 0) * 1000 > now) violations.push({ code: 'conflict', message: 'candidate holds an active lease' });
      const expectedReviewer = goal.tier === 'quick' && (goal.pipeline ?? 'software') === 'software' ? 'gm' : 'owner';
      if (candidate.reviewerRole !== expectedReviewer) {
        violations.push({ code: 'invalid', message: `candidate reviewer must be ${expectedReviewer}` });
      }
      const missing = unfinished.filter(task => !candidate.dependencies.includes(task.id));
      if (missing.length) violations.push({ code: 'invalid', message: `candidate does not depend on unfinished goal work: ${missing.map(task => task.id).join(', ')}` });
      if (candidate.dependencies.includes(candidate.id)) violations.push({ code: 'invalid', message: 'candidate depends on itself' });
      for (const dep of candidate.dependencies) {
        if (!byId.has(dep)) violations.push({ code: 'not_found', message: `candidate dependency ${dep} is outside this goal` });
      }
      const seen = new Set<string>(candidate.dependencies);
      let frontier = [...candidate.dependencies];
      while (frontier.length) {
        const next = [...new Set(frontier.flatMap(id => byId.get(id)?.dependencies ?? []).filter(id => !seen.has(id)))];
        if (next.includes(candidate.id)) { violations.push({ code: 'invalid', message: 'candidate would form a dependency cycle' }); break; }
        for (const id of next) seen.add(id);
        frontier = next;
        if (seen.size > 200) break;
      }
    }
    const hash = HASH(JSON.stringify({ v: 1, goalId: input.goalId, goalVersion: row.version ?? 0,
      current: currentId ?? null, candidate: candidate ? { id: candidate.id, version: candidate.version ?? 0, state: candidate.state,
        reviewer: candidate.reviewerRole, dependencies: [...candidate.dependencies].sort() } : null,
      unfinished: unfinished.map(task => task.id).sort() }));
    return {
      goalId: input.goalId, goalVersion: row.version ?? 0,
      ...(current ? { currentFinalGate: { taskId: current.id, title: current.title, state: current.state,
        reviewerRole: current.reviewerRole, superseded: Boolean(current.supersededBy),
        voided: current.state === 'void' } } : {}),
      ...(candidate ? { candidate: { taskId: candidate.id, title: candidate.title, state: candidate.state,
        executorRole: candidate.executorRole, reviewerRole: candidate.reviewerRole, version: candidate.version ?? 0,
        dependencies: candidate.dependencies, missing: unfinished.filter(task => !candidate.dependencies.includes(task.id)).map(task => task.id) } } : {}),
      violations, ready: violations.length === 0,
      unfinished: unfinished.map(task => ({ taskId: task.id, title: task.title, state: task.state })),
      snapshot: { version: 1, hash },
    };
  }

  /** CAS apply. Repairs only the reference graph; never releases a lease, approves a gate or closes the goal. */
  async finalGateRepair(input: GoalFinalGateRepairInput): Promise<GoalFinalGateRepairResult> {
    const preview = await this.finalGatePreview({ goalId: input.goalId, candidateTaskId: input.candidateTaskId });
    if (!preview.ready) throw new Error(preview.violations.map(item => item.message).join('; '));
    if (preview.snapshot.hash !== input.snapshotHash) throw new Error('goal repair snapshot moved');
    const row = (await this.goalRows([input.goalId]))[0]!;
    if ((row.version ?? 0) !== input.expectedGoalVersion) throw new Error('goal version moved');
    const currentId = finalGateId(goalFact(row));
    if (input.expectedOldTaskId !== undefined && currentId !== input.expectedOldTaskId) throw new Error('goal final gate moved');
    const candidate = (await this.tasksOfGoals([input.goalId])).map(taskFact).find(task => task.id === input.candidateTaskId)!;
    const goal = new RecordId('goal', input.goalId);
    const nextVersion = input.expectedGoalVersion + 1;
    const quickSame = goalFact(row).tasks.manual === currentId && goalFact(row).tasks.acceptance === currentId;
    await this.run(`BEGIN;
      LET $g = SELECT * FROM ONLY $goal;
      IF $g = NONE OR $g.state NOT IN ['active', 'needs_repair'] OR ($g.version ?? 0) != $expected_version { THROW 'goal version moved' };
      LET $c = SELECT * FROM ONLY $candidate;
      IF $c = NONE OR $c.version != $candidate_version OR $c.state IN ['done', 'void'] { THROW 'candidate moved or terminal' };
      IF $expected_old != NONE AND $g.tasks.acceptance != $expected_old { THROW 'goal final gate moved' };
      UPDATE ONLY $goal SET tasks.acceptance = $candidate, tasks.manual = IF $quick THEN $candidate ELSE $g.tasks.manual END,
        anchors = array::map($g.anchors ?? [], |$a| IF $a = $expected_old OR $quick THEN $candidate ELSE $a END),
        state = 'needs_repair', needs_repair = true,
        needs_repair_reason = '终验关口引用已替换；待新关口验收后重算，旧版因此不能自动关闭目标',
        needs_repair_at = time::now(), version = $next_version;
      CREATE audit CONTENT { goal: $goal, task: $candidate, actor: $actor, action: 'goal_final_gate_repair',
        evidence: $evidence, at: time::now() };
      LET $sequence = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
      CREATE outbox CONTENT { task: $candidate, kind: 'goal_final_gate_repaired', sequence: $sequence.value,
        payload: { goal: $goal_key, old: $expected_old, new: $candidate_key, snapshot: $snapshot }, at: time::now() };
      COMMIT;`, {
      goal, candidate: new RecordId('task', input.candidateTaskId), candidate_version: candidate.version ?? 0,
      expected_version: input.expectedGoalVersion, expected_old: currentId ? new RecordId('task', currentId) : null,
      quick: quickSame, next_version: nextVersion, actor: input.actor,
      evidence: `${input.reason}\n[goal_final_gate_repair] goal=${input.goalId} old=${currentId ?? '-'} new=${input.candidateTaskId} snapshot=${input.snapshotHash}`,
      goal_key: input.goalId, candidate_key: input.candidateTaskId, snapshot: input.snapshotHash,
    });
    return { goalId: input.goalId, ...(currentId ? { oldTaskId: currentId } : {}), newTaskId: input.candidateTaskId,
      goalVersion: nextVersion, snapshotHash: input.snapshotHash, repairedAt: new Date(await this.now()).toISOString() };
  }

  /** Metrics for one window. The store only reads; missing usage stays unknown. */
  async metrics(input: { from: string; to: string; timezone: string; goalId?: string; explicit?: boolean }): Promise<GoalMetricsView> {
    const fromMs = Date.parse(input.from), toMs = Date.parse(input.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error('metrics window must be absolute instants');
    if (toMs <= fromMs) throw new Error('metrics window must be positive');
    if (!isTimeZone(input.timezone)) throw new Error('timezone must be an IANA zone');
    const cutoffMs = await this.now();
    const window: GoalMetricsWindow = {
      from: input.from, to: input.to, fromMs, toMs, timezone: input.timezone,
      cutoffAt: new Date(cutoffMs).toISOString(), explicit: input.explicit !== false,
    };
    const goalRows = (await this.goalRows()).filter(row => !input.goalId || text(row.id) === input.goalId);
    const tasks = await this.tasksOfGoals(goalRows.map(row => text(row.id)));
    const taskIds = tasks.map(task => text(task.id));
    const goalIdByTask = new Map(tasks.map(task => [text(task.id), task.goal ? text(task.goal) : undefined]));
    const [acceptRows] = taskIds.length ? await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT task, action, at FROM audit WHERE task IN $tasks AND action IN ['accept', 'owner_approve']
       AND at >= <datetime>$from AND at < <datetime>$to ORDER BY at;`,
      { tasks: taskIds.map(id => new RecordId('task', id)), from: input.from, to: input.to }) : [[] as Array<Record<string, unknown>>];
    const acceptedAtByTask = new Map<string, number>();
    for (const row of acceptRows ?? []) {
      const taskId = text(row.task);
      if (!acceptedAtByTask.has(taskId)) acceptedAtByTask.set(taskId, ms(row.at) ?? 0);
    }
    const taskByGoal = new Map<string, number>();
    for (const task of taskIds) {
      const goalId = goalIdByTask.get(task);
      if (goalId) taskByGoal.set(goalId, (taskByGoal.get(goalId) ?? 0) + 1);
    }
    const metricTasks: MetricTaskRow[] = tasks.map(task => {
      const row = task as unknown as Record<string, unknown>;
      return {
        id: text(task.id), title: task.title, goalId: task.goal ? text(task.goal) : undefined,
        ...(task.kind ? { kind: task.kind } : {}), state: task.state,
        ...(ms(task.created_at) !== undefined ? { createdAt: ms(task.created_at) } : {}),
        ...(acceptedAtByTask.get(text(task.id)) !== undefined ? { acceptedAt: acceptedAtByTask.get(text(task.id)) } : {}),
        ...(num(row.acceptance_attempt) !== undefined ? { acceptanceAttempt: num(row.acceptance_attempt) } : {}),
        executorRole: task.executor_role,
      };
    });
    const metricGoals: MetricGoalRow[] = goalRows.map(row => ({
      id: text(row.id), title: row.title, state: row.state,
      ...(row.tier ? { tier: row.tier } : {}), ...(row.pipeline ? { pipeline: row.pipeline } : {}),
      ...(ms(row.created_at) !== undefined ? { createdAt: ms(row.created_at) } : {}),
      ...(ms(row.done_at) !== undefined ? { doneAt: ms(row.done_at) } : {}),
    })).filter(goal => !input.goalId || goal.id === input.goalId);
    const [auditRows] = taskIds.length ? await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT task, action, phase, at, actor, evidence FROM audit WHERE task IN $tasks
       AND at >= <datetime>$from AND at < <datetime>$to
       AND action IN ['block','resume','released','revoked','return','retire','dependency_unlocked','dispatch_unblocked','checkpoint','submit','accept','owner_approve']
       ORDER BY at;`, { tasks: taskIds.map(id => new RecordId('task', id)), from: input.from, to: input.to }) : [[] as Array<Record<string, unknown>>];
    const audits: MetricAuditRow[] = (auditRows ?? []).map(row => ({
      taskId: text(row.task), action: String(row.action ?? ''), at: ms(row.at) ?? 0,
      ...(row.phase ? { phase: String(row.phase) } : {}), ...(row.actor ? { actor: String(row.actor) } : {}),
      ...(String(row.action ?? '') === 'return' && /^【通道回滚】/.test(String(row.evidence ?? '')) ? { mechanical: true } : {}),
    }));
    const [wakeRows] = taskIds.length ? await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT task, at, evidence FROM audit WHERE task IN $tasks AND action = 'manager_wake_acquired'
       AND at >= <datetime>$from AND at < <datetime>$to ORDER BY at;`,
      { tasks: taskIds.map(id => new RecordId('task', id)), from: input.from, to: input.to }) : [[] as Array<Record<string, unknown>>];
    const wakes: MetricWakeRow[] = [];
    for (const row of wakeRows ?? []) {
      try {
        const evidence = JSON.parse(String(row.evidence ?? '{}')) as { phase?: string; episode?: string; attempt?: number; taskId?: string };
        wakes.push({ taskId: text(row.task), phase: evidence.phase ?? 'execute', episode: evidence.episode ?? 'default',
          attempt: Number(evidence.attempt ?? 1), at: ms(row.at) ?? 0 });
      } catch { /* malformed legacy wake remains out of the sample and is counted by coverage */ }
    }
    const [usageRows] = taskIds.length ? await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT task, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, completed, at
       FROM model_execution WHERE task IN $tasks AND at >= <datetime>$from AND at < <datetime>$to ORDER BY at;`,
      { tasks: taskIds.map(id => new RecordId('task', id)), from: input.from, to: input.to }) : [[] as Array<Record<string, unknown>>];
    const usage: MetricUsageRow[] = (usageRows ?? []).map(row => ({
      taskId: text(row.task), completed: row.completed === true, at: ms(row.at) ?? 0,
      ...(row.model ? { model: String(row.model) } : {}),
      ...(num(row.input_tokens) !== undefined ? { inputTokens: num(row.input_tokens) } : {}),
      ...(num(row.output_tokens) !== undefined ? { outputTokens: num(row.output_tokens) } : {}),
      ...(num(row.cache_read_tokens) !== undefined ? { cacheReadTokens: num(row.cache_read_tokens) } : {}),
      ...(num(row.cost_usd) !== undefined ? { costUsd: num(row.cost_usd) } : {}),
    }));
    const [evidenceRows] = goalRows.length ? await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT goal, kind, at FROM goal_evidence WHERE goal IN $goals AND at >= <datetime>$from AND at < <datetime>$to ORDER BY at;`,
      { goals: goalRows.map(row => new RecordId('goal', text(row.id))), from: input.from, to: input.to }) : [[] as Array<Record<string, unknown>>];
    const evidence: MetricEvidenceRow[] = (evidenceRows ?? []).map(row => ({
      goalId: text(row.goal), kind: String(row.kind ?? '') as GoalEvidenceKind, at: ms(row.at) ?? 0,
    }));
    const metrics = computeGoalMetrics({ window, goals: metricGoals, tasks: metricTasks, audits, wakes, usage, evidence });
    if (toMs - fromMs > 7 * 86_400_000) {
      metrics.exclusions.push('model_execution 仅保留 7 天；窗口超过 7 天的 token/成本覆盖为 unknown，不回溯推算');
    }
    return metrics;
  }
}
