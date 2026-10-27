/**
 * SYS07 P2 · goal governance, outcome contract and business metrics.
 *
 * This module is deliberately pure: it receives rows the store read and returns the decisions both the console,
 * the daily brief and the tests use. Nothing here writes, closes a task or approves an owner gate. The final gate
 * is still an ordinary task; the only way to become `done` is a real accept/owner-relay decision on that task.
 */
import { isTimeZone } from './waits.ts';

export const GOAL_EVIDENCE_KINDS = [
  'implementation', 'release', 'deploy_qa', 'customer_activation', 'customer_adoption', 'feedback',
] as const;
export type GoalEvidenceKind = typeof GOAL_EVIDENCE_KINDS[number];

/** Final-gate evidence is derived from the final task, never typed in as an external receipt. */
export const FINAL_EVIDENCE_KINDS = ['final_acceptance', 'owner_final'] as const;
export type FinalEvidenceKind = typeof FINAL_EVIDENCE_KINDS[number];
export type RequiredEvidenceKind = GoalEvidenceKind | FinalEvidenceKind;

const REQUIRED_KINDS = new Set<string>([...GOAL_EVIDENCE_KINDS, ...FINAL_EVIDENCE_KINDS]);
const CUSTOMER_KINDS = new Set<GoalEvidenceKind>(['customer_activation', 'customer_adoption', 'feedback']);

export interface GoalFact {
  id: string;
  title: string;
  brief: string;
  state: 'triage' | 'active' | 'needs_repair' | 'done' | 'cancelled';
  tier?: string;
  pipeline?: string;
  project?: string;
  createdAt?: number;
  doneAt?: number;
  deadline?: number;
  deadlineTimezone?: string;
  needsRepair?: boolean;
  needsRepairReason?: string;
  version?: number;
  tasks: { intake?: string; plan?: string; manual?: string; acceptance?: string };
  anchors: string[];
}

export interface GoalTaskFact {
  id: string;
  title: string;
  state: string;
  kind?: string;
  executorRole: string;
  reviewerRole: string;
  blockedTo?: string;
  currentEmployee?: string;
  leaseExpiresAt?: number;
  dependencies: string[];
  version?: number;
  createdAt?: number;
  acceptedBy?: string;
  submittedBy?: string;
  supersededBy?: string;
  lineage?: string;
  revisionNo?: number;
  waitState?: string;
  waitKind?: string;
  waitNotBefore?: number;
  waitExpiresAt?: number;
  waitNextCheckAt?: number;
  waitOwnerRole?: string;
  waitEnteredAt?: number;
  dispatchBlockedPhase?: string;
  dispatchBlockedSince?: number;
}

export interface GoalWaitFact {
  taskId: string;
  waitKey: string;
  kind: string;
  state: string;
  ownerRole: string;
  notBefore?: number;
  expiresAt?: number;
  nextCheckAt?: number;
  enteredAt?: number;
  completed: string[];
  pendingAction?: string;
  reason: string;
  progressEmployee?: string;
}

export interface GoalFaultFact {
  taskId: string;
  phase: string;
  state: string;
  openedAt?: number;
  attempts?: number;
  maxAttempts?: number;
  nextAllowedAt?: number;
}

export interface GoalOutcomeFact {
  expected: string;
  requiredEvidence: RequiredEvidenceKind[];
  responsibleRole: string;
  deadline?: number;
  timezone?: string;
  version: number;
  source: string;
  updatedAt?: number;
}

export interface GoalEvidenceFact {
  id: string;
  kind: GoalEvidenceKind;
  summary: string;
  source: string;
  confirmedBy: string;
  evidenceType: 'external_receipt' | 'production_record' | 'manual_signoff';
  at: number;
  taskId?: string;
  digest: string;
}

export type GoalStageKey =
  | 'implementation' | 'release' | 'deploy_qa' | 'customer_activation' | 'customer_adoption' | 'owner_final';

export interface GoalStage {
  key: GoalStageKey;
  label: string;
  status: 'done' | 'active' | 'waiting' | 'missing' | 'not_required' | 'unknown';
  evidence: string[];
  note?: string;
}

export interface GoalBlocker {
  taskId: string;
  title: string;
  kind: 'wait' | 'owner' | 'manager' | 'fault' | 'dependency' | 'holder' | 'unassigned' | 'unknown';
  summary: string;
  responsibleRole: string;
  holder?: string;
  waitedSince?: number;
  waitedMinutes?: number;
  nextTrigger?: string;
  dependencyPath: Array<{ taskId: string; title: string }>;
  handoff?: {
    kind: string;
    ownerRole: string;
    pendingAction?: string;
    completed: string[];
    expiresAt?: number;
    nextCheckAt?: number;
  };
  waitKey?: string;
}

export interface GoalFinalGateView {
  taskId?: string;
  title?: string;
  state?: string;
  reviewerRole?: string;
  acceptedBy?: string;
  ownerGate: boolean;
  effective: boolean;
  superseded: boolean;
  evidenceTaskIds: string[];
}

export interface GoalAssessment {
  goalId: string;
  state: GoalFact['state'];
  finalGate: GoalFinalGateView;
  deadline: { status: 'exact' | 'unknown'; at?: number; timezone?: string; source: 'goal' | 'outcome' | 'none' };
  outcome: {
    registered: boolean;
    expected?: string;
    responsibleRole?: string;
    requiredEvidence: RequiredEvidenceKind[];
    satisfied: RequiredEvidenceKind[];
    missing: RequiredEvidenceKind[];
    complete: boolean;
    version?: number;
  };
  stages: GoalStage[];
  blockers: GoalBlocker[];
  dependencyPath: Array<{ taskId: string; title: string }>;
  graph: { cycle: boolean; dangling: Array<{ taskId: string; dependency: string }>; crossGoal: Array<{ taskId: string; dependency: string }> };
  repairReasons: Array<{ code: string; message: string; taskId?: string }>;
  needsRepair: boolean;
  readyToComplete: boolean;
  goalComplete: boolean;
  sourceTaskIds: string[];
}

export interface GoalCard extends GoalAssessment {
  taskTotal: number;
  blockersOmitted?: number;
  sourceTaskIdsTruncated?: boolean;
  title: string;
  brief: string;
  tier?: string;
  pipeline?: string;
  project?: string;
  createdAt?: number;
  needsRepairStored?: boolean;
}

const STAGE_LABELS: Record<GoalStageKey, string> = {
  implementation: '实现完成',
  release: '已上线',
  deploy_qa: '生产 QA',
  customer_activation: '真实客户激活',
  customer_adoption: '客户采纳',
  owner_final: '老板终验',
};

const TERMINAL = new Set(['done', 'void']);

/** Implementation work is settled by a real done task, or by a void task whose successor revision is done.
 * A bare retire (void without a completed successor) is a gap, not completion. */
function implementationSettled(task: GoalTaskFact, byId: Map<string, GoalTaskFact>, replaced: Set<string>): boolean {
  if (task.state === 'done') return true;
  // An authorized acceptance-reference repair replaces the old anchor by audit; it is not abandoned work.
  if (task.state === 'void' && replaced.has(task.id)) return true;
  if (task.state !== 'void' || !task.supersededBy) return false;
  return byId.get(task.supersededBy)?.state === 'done';
}

function sortedIds(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter(Boolean))].sort();
}

/** The live final gate: standard/program/video use `acceptance`; quick reuses its product acceptance as `manual`. */
export function finalGateId(goal: Pick<GoalFact, 'tasks'>): string | undefined {
  return goal.tasks.acceptance ?? goal.tasks.manual;
}

function evidenceFor(taskId: string | undefined, evidence: GoalEvidenceFact[]): string[] {
  if (!taskId) return [];
  return evidence.filter(item => item.taskId === taskId).map(item => item.id).sort();
}

function stage(
  key: GoalStageKey, status: GoalStage['status'], evidence: string[] = [], note?: string,
): GoalStage {
  return { key, label: STAGE_LABELS[key], status, evidence, ...(note ? { note } : {}) };
}

function requiredSatisfied(
  kind: RequiredEvidenceKind,
  ctx: {
    tasks: GoalTaskFact[]; final: GoalTaskFact | undefined; outcome: GoalOutcomeFact;
    evidence: GoalEvidenceFact[]; ownerApproved: boolean; ownerFinalApproved: boolean;
    byId: Map<string, GoalTaskFact>; replacedAcceptance: Set<string>;
  },
): boolean {
  const { tasks, final, evidence, ownerFinalApproved, byId, replacedAcceptance } = ctx;
  switch (kind) {
    case 'implementation':
      return tasks.filter(task => task.id !== final?.id && task.kind !== 'gate')
        .every(task => implementationSettled(task, byId, replacedAcceptance));
    case 'release':
      return tasks.some(task => task.kind === 'release' && task.state === 'done') ||
        evidence.some(item => item.kind === 'release');
    case 'deploy_qa':
      return tasks.some(task => task.kind === 'deploy' && task.state === 'done') ||
        evidence.some(item => item.kind === 'deploy_qa');
    case 'customer_activation':
    case 'customer_adoption':
    case 'feedback':
      return evidence.some(item => item.kind === kind);
    case 'final_acceptance':
      return final?.state === 'done';
    case 'owner_final':
      return ownerFinalApproved;
  }
}

function dependencyPathTo(
  finalId: string | undefined, targetId: string, byId: Map<string, GoalTaskFact>,
): Array<{ taskId: string; title: string }> {
  if (!finalId) return byId.has(targetId) ? [{ taskId: targetId, title: byId.get(targetId)!.title }] : [];
  const parent = new Map<string, string>();
  const queue = [finalId];
  const seen = new Set<string>();
  while (queue.length && seen.size < 200) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const dep of byId.get(current)?.dependencies ?? []) {
      if (!byId.has(dep) || parent.has(dep)) continue;
      parent.set(dep, current);
      queue.push(dep);
    }
  }
  if (!seen.has(targetId)) return byId.has(targetId) ? [{ taskId: targetId, title: byId.get(targetId)!.title }] : [];
  const reverse = [targetId];
  let cursor = targetId;
  while (parent.has(cursor) && reverse.length < 12) {
    cursor = parent.get(cursor)!;
    reverse.push(cursor);
  }
  return reverse.reverse().map(taskId => ({ taskId, title: byId.get(taskId)?.title ?? taskId }));
}

function blockerFor(
  task: GoalTaskFact, wait: GoalWaitFact | undefined, fault: GoalFaultFact | undefined,
  byId: Map<string, GoalTaskFact>, finalId: string | undefined, now: number,
  unresolved: Set<string>,
): GoalBlocker {
  const path = dependencyPathTo(finalId, task.id, byId);
  const base = {
    taskId: task.id, title: task.title, responsibleRole: task.executorRole,
    ...(task.currentEmployee ? { holder: task.currentEmployee } : {}),
    dependencyPath: path,
  };
  if (wait) {
    const since = wait.enteredAt;
    const handoff = CUSTOMER_KINDS.has(wait.kind as GoalEvidenceKind) || wait.kind === 'owner_handoff' ? {
      handoff: {
        kind: wait.kind, ownerRole: wait.ownerRole,
        ...(wait.pendingAction ? { pendingAction: wait.pendingAction } : {}),
        completed: wait.completed ?? [],
        ...(wait.expiresAt ? { expiresAt: wait.expiresAt } : {}),
        ...(wait.nextCheckAt ? { nextCheckAt: wait.nextCheckAt } : {}),
      },
    } : {};
    const timing = {
      ...(since ? { waitedSince: since, waitedMinutes: Math.max(0, Math.floor((now - since) / 60_000)) } : {}),
      ...(wait.notBefore ? { nextTrigger: new Date(wait.notBefore).toISOString() } :
        wait.nextCheckAt ? { nextTrigger: new Date(wait.nextCheckAt).toISOString() } :
        wait.expiresAt ? { nextTrigger: `到期 ${new Date(wait.expiresAt).toISOString()}` } : {}),
    };
    // An expired SYS05 wait stays visible: it must be cancelled or extended, not silently treated as waiting.
    if (wait.state === 'expired') {
      return { ...base, ...timing, ...handoff, kind: 'wait',
        summary: `等待已过期：${wait.reason}`,
        nextTrigger: wait.nextCheckAt ? new Date(wait.nextCheckAt).toISOString() : wait.expiresAt ? `到期 ${new Date(wait.expiresAt).toISOString()}` : '需取消等待或先延期再补受信事件',
        waitKey: wait.waitKey };
    }
    // An owner_handoff wait is an owner action, not an ordinary dependency wait; the handoff facts stay attached.
    if (wait.kind === 'owner_handoff') {
      return { ...base, ...timing, ...handoff, kind: 'owner', responsibleRole: 'owner',
        summary: `等待老板交接：${wait.reason}`, waitKey: wait.waitKey };
    }
    return {
      ...base, ...timing, ...handoff, kind: 'wait',
      summary: `等待${wait.kind === 'time' ? '时间窗口' : wait.kind === 'customer_activation' ? '客户激活' : wait.kind === 'feedback' ? '外部反馈' : '依赖'}：${wait.reason}`,
      waitKey: wait.waitKey,
    };
  }
  if (fault) {
    return { ...base, kind: 'fault', summary: `故障 ${fault.phase}：${fault.state}`,
      ...(fault.nextAllowedAt ? { nextTrigger: new Date(fault.nextAllowedAt).toISOString() } : {}) };
  }
  if (task.blockedTo === 'owner') {
    return { ...base, kind: 'owner', summary: '等待老板动作', responsibleRole: 'owner',
      ...(task.dispatchBlockedSince ? { waitedSince: task.dispatchBlockedSince * 1000,
        waitedMinutes: Math.max(0, Math.floor((now - task.dispatchBlockedSince * 1000) / 60_000)) } : {}) };
  }
  if (task.blockedTo === 'gm') {
    return { ...base, kind: 'manager', summary: '等待经理动作', responsibleRole: 'gm' };
  }
  const openDeps = task.dependencies.filter(dep => unresolved.has(dep));
  if (task.state === 'blocked' && openDeps.length) {
    return { ...base, kind: 'dependency', summary: `等待依赖 ${openDeps.length} 项完成` };
  }
  if (task.currentEmployee && (task.leaseExpiresAt ?? 0) * 1000 > now) {
    return { ...base, kind: 'holder', summary: '有员工持有，不在等待队列',
      nextTrigger: task.leaseExpiresAt ? `租约到 ${new Date(task.leaseExpiresAt * 1000).toISOString()}` : undefined };
  }
  if (['ready', 'doing', 'review'].includes(task.state)) {
    return { ...base, kind: 'unassigned', summary: task.state === 'review' ? '待复核但未派工' : '可派工但未持有' };
  }
  return { ...base, kind: 'unknown', summary: `任务状态 ${task.state}，无进一步阻塞事实` };
}

/** One goal's invariants, stages, blockers and terminal decision. This is the only completion evaluator. */
export function assessGoal(input: {
  goal: GoalFact; tasks: GoalTaskFact[]; waits?: GoalWaitFact[]; faults?: GoalFaultFact[];
  outcome?: GoalOutcomeFact; evidence?: GoalEvidenceFact[];
  /** Dependencies resolved by the store to a task in another goal; the pure rule never invents that fact. */
  externalDependencies?: Array<{ taskId: string; dependency: string; goalId?: string }>;
  /** Old quick acceptance anchors replaced by goal_acceptance_repair; their void is an authorized replacement. */
  replacedAcceptanceTaskIds?: string[];
  now: number;
}): GoalAssessment {
  const { goal, now } = input;
  const tasks = input.tasks;
  const waits = input.waits ?? [];
  const faults = input.faults ?? [];
  const evidence = input.evidence ?? [];
  const byId = new Map(tasks.map(task => [task.id, task]));
  const replacedAcceptance = new Set(input.replacedAcceptanceTaskIds ?? []);
  const finalId = finalGateId(goal);
  const final = finalId ? byId.get(finalId) : undefined;
  // A final gate is effective only when it is the lineage tip: a superseded_by pointer or a newer revision in
  // the same lineage makes the old gate a historical record, never an approval the goal can lean on.
  const superseded = Boolean(final?.supersededBy) ||
    Boolean(final?.lineage && final.revisionNo !== undefined &&
      tasks.some(task => task.lineage === final.lineage && (task.revisionNo ?? 0) > final.revisionNo!));

  const repairReasons: GoalAssessment['repairReasons'] = [];
  const dangling: Array<{ taskId: string; dependency: string }> = [];
  const crossGoal: Array<{ taskId: string; dependency: string }> = [];
  const external = new Map((input.externalDependencies ?? []).map(item => [`${item.taskId}\0${item.dependency}`, item.goalId]));
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (byId.has(dep)) continue;
      const otherGoal = external.get(`${task.id}\0${dep}`);
      // Cross-goal edges are invisible in the task list; the store resolves them and passes the facts. A missing
      // dependency that no goal owns remains dangling, never silently treated as a satisfied edge.
      if (otherGoal !== undefined && otherGoal !== goal.id) crossGoal.push({ taskId: task.id, dependency: dep });
      else dangling.push({ taskId: task.id, dependency: dep });
    }
  }
  let cycle = false;
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): void => {
    const mark = state.get(id) ?? 0;
    if (mark === 1) { cycle = true; return; }
    if (mark === 2) return;
    state.set(id, 1);
    for (const dep of byId.get(id)?.dependencies ?? []) if (byId.has(dep)) visit(dep);
    state.set(id, 2);
  };
  for (const task of tasks) visit(task.id);
  if (!finalId) repairReasons.push({ code: 'final_gate_missing', message: '目标没有有效的最终交付/验收关口' });
  else if (!final) repairReasons.push({ code: 'final_gate_missing', message: `终验关口 ${finalId} 不存在` });
  else {
    if (superseded) repairReasons.push({ code: 'final_gate_superseded', message: '终验关口已被新版本替代', taskId: final.id });
    if (final.state === 'void') repairReasons.push({ code: 'final_gate_void', message: '终验关口已作废，目标不能自动完成', taskId: final.id });
    if (final.state === 'done' && final.reviewerRole === 'owner' && final.acceptedBy !== 'owner') {
      repairReasons.push({ code: 'owner_approval_missing', message: '终验关口已完成但不是老板本人批准', taskId: final.id });
    }
  }
  if (cycle) repairReasons.push({ code: 'dependency_cycle', message: '目标任务依赖存在循环' });
  for (const item of dangling) repairReasons.push({ code: 'dependency_dangling', message: `依赖 ${item.dependency} 不存在`, taskId: item.taskId });
  for (const item of crossGoal) repairReasons.push({ code: 'dependency_cross_goal', message: `依赖 ${item.dependency} 属于其他目标`, taskId: item.taskId });

  const ownerApproved = final?.state === 'done' && (final.reviewerRole !== 'owner' || final.acceptedBy === 'owner');
  // A required owner_final is only satisfied by an owner-reviewed final gate accepted by the owner himself;
  // a manager/quick gate is real acceptance for its own flow, but it is not the boss's final approval.
  const ownerFinalApproved = final?.state === 'done' && final.reviewerRole === 'owner' && final.acceptedBy === 'owner';
  const required = input.outcome?.requiredEvidence ?? [];
  const satisfied = required.filter(kind => requiredSatisfied(kind, { tasks, final, outcome: input.outcome!, evidence,
    ownerApproved, ownerFinalApproved, byId, replacedAcceptance }));
  const missing = required.filter(kind => !satisfied.includes(kind));
  if (!input.outcome) repairReasons.push({ code: 'outcome_missing', message: '目标尚未登记结构化成果与 required 证据' });
  if (final?.state === 'done' && (missing.length || !ownerApproved)) {
    repairReasons.push({
      code: 'final_evidence_incomplete',
      message: !ownerApproved ? '老板终验缺少真实 owner relay 批准' : `终验缺少 required 证据：${missing.join(', ')}`,
      ...(final ? { taskId: final.id } : {}),
    });
  }
  if (goal.state === 'done' && (missing.length || !final || final.state !== 'done' || !ownerApproved)) {
    repairReasons.push({ code: 'goal_done_without_evidence', message: '目标已标记完成，但终验图或 required 证据不成立' });
  }
  const nonFinal = tasks.filter(task => task.id !== finalId);
  const earlyFinal = final?.state === 'done' && nonFinal.some(task => !TERMINAL.has(task.state));
  if (earlyFinal) {
    repairReasons.push({ code: 'final_gate_early', message: '最终关口已完成，但目标仍有未完成工作，不能据此完成目标',
      ...(final ? { taskId: final.id } : {}) });
  }

  const implementationRequired = required.includes('implementation');
  const retiredImplementation = implementationRequired ? nonFinal.filter(task => task.state === 'void' && task.kind !== 'gate' &&
    !implementationSettled(task, byId, replacedAcceptance)) : [];
  for (const task of retiredImplementation) {
    repairReasons.push({ code: 'implementation_void', message: '实现任务已作废且没有已完成的继任修订，不能算实现完成', taskId: task.id });
  }

  const done = goal.state === 'done';
  // The verdict and the gap list must agree: any recorded repair reason blocks a completion claim.
  const complete = Boolean(input.outcome) && final?.state === 'done' && ownerApproved && missing.length === 0 && repairReasons.length === 0;
  const needsRepair = repairReasons.length > 0;

  const stages: GoalStage[] = [];
  const implementationDone = nonFinal.length > 0 && nonFinal.every(task => implementationSettled(task, byId, replacedAcceptance));
  const releaseTask = tasks.find(task => task.kind === 'release');
  const deployTask = tasks.find(task => task.kind === 'deploy');
  const evidenceIds = (kind: GoalEvidenceKind) => evidence.filter(item => item.kind === kind).map(item => item.id).sort();
  stages.push(stage('implementation',
    retiredImplementation.length ? 'missing' : !implementationRequired && nonFinal.some(task => task.state === 'void') ? 'not_required' :
      implementationDone ? 'done' : nonFinal.length ? 'active' : 'unknown',
    [], retiredImplementation.length ? '实现任务已作废且没有已完成的继任修订；需授权变更成果契约或取消目标' :
      !implementationRequired && nonFinal.some(task => task.state === 'void') ? '实现已完成但任务被作废；当前成果契约不要求 implementation' : undefined));
  stages.push(stage('release',
    evidenceIds('release').length || releaseTask?.state === 'done' ? 'done' :
      releaseTask ? 'waiting' : required.includes('release') ? 'missing' : 'unknown',
    evidenceIds('release')));
  stages.push(stage('deploy_qa',
    evidenceIds('deploy_qa').length || deployTask?.state === 'done' ? 'done' :
      deployTask ? 'waiting' : required.includes('deploy_qa') ? 'missing' : 'unknown',
    evidenceIds('deploy_qa')));
  for (const kind of ['customer_activation', 'customer_adoption'] as const) {
    const ids = evidenceIds(kind);
    const wait = waits.find(item => item.kind === kind);
    const expired = wait?.state === 'expired';
    stages.push(stage(kind,
      ids.length ? 'done' : expired ? 'missing' : wait ? 'waiting' : required.includes(kind) ? 'missing' : 'not_required',
      ids, expired ? `${wait.reason}（SYS05 等待已过期，需取消或延期后补受信事件）` : wait ? wait.reason : undefined));
  }
  const ownerRequired = required.includes('owner_final');
  const ownerStage = final?.reviewerRole === 'owner'
    ? final.state === 'done' ? (final.acceptedBy === 'owner' ? 'done' : 'missing') :
      final.state === 'void' ? 'missing' : 'waiting'
    : ownerRequired ? 'missing' : 'not_required';
  stages.push(stage('owner_final', ownerStage, evidenceFor(final?.id, evidence),
    final?.reviewerRole !== 'owner' && ownerRequired ? 'required owner_final 需要 owner 终验关口且由老板本人批准' :
      final?.state === 'void' ? '终验关口已作废' : undefined));

  const waitByTask = new Map(waits.filter(wait => ['waiting', 'held', 'expired'].includes(wait.state)).map(wait => [wait.taskId, wait]));
  const faultByTask = new Map(faults.filter(fault => fault.state !== 'resolved' && fault.state !== 'closed').map(fault => [fault.taskId, fault]));
  const unresolved = new Set(tasks.filter(task => !TERMINAL.has(task.state)).map(task => task.id));
  const blockers = tasks
    .filter(task => !TERMINAL.has(task.state))
    .map(task => blockerFor(task, waitByTask.get(task.id), faultByTask.get(task.id), byId, finalId, now, unresolved))
    .sort((a, b) => severity(b) - severity(a) || (b.waitedMinutes ?? 0) - (a.waitedMinutes ?? 0) || a.taskId.localeCompare(b.taskId));

  const effectiveFinalView = final ? !superseded : false;
  const deadline = goal.deadline !== undefined
    ? { status: 'exact' as const, at: goal.deadline, timezone: goal.deadlineTimezone ?? input.outcome?.timezone, source: 'goal' as const }
    : input.outcome?.deadline !== undefined
      ? { status: 'exact' as const, at: input.outcome.deadline, timezone: input.outcome.timezone, source: 'outcome' as const }
      : { status: 'unknown' as const, source: 'none' as const };

  return {
    goalId: goal.id, state: goal.state,
    finalGate: {
      ...(final ? { taskId: final.id, title: final.title, state: final.state, reviewerRole: final.reviewerRole } : {}),
      ...(final?.acceptedBy ? { acceptedBy: final.acceptedBy } : {}),
      ownerGate: final?.reviewerRole === 'owner',
      effective: effectiveFinalView,
      superseded,
      evidenceTaskIds: evidenceFor(final?.id, evidence),
    },
    deadline,
    outcome: {
      registered: Boolean(input.outcome),
      ...(input.outcome ? {
        expected: input.outcome.expected, responsibleRole: input.outcome.responsibleRole,
        requiredEvidence: required, version: input.outcome.version,
      } : { requiredEvidence: [] }),
      satisfied, missing, complete,
    },
    stages, blockers,
    dependencyPath: blockers[0]?.dependencyPath ?? [],
    graph: { cycle, dangling, crossGoal },
    repairReasons, needsRepair,
    readyToComplete: (goal.state === 'active' || goal.state === 'needs_repair') && Boolean(input.outcome) &&
      final?.state === 'done' && ownerApproved && missing.length === 0 && repairReasons.length === 0,
    goalComplete: done && complete,
    sourceTaskIds: sortedIds(tasks.map(task => task.id)),
  };
}

function severity(blocker: GoalBlocker): number {
  switch (blocker.kind) {
    case 'fault': return 7;
    case 'owner': return 6;
    case 'manager': return 5;
    case 'wait': return 4;
    case 'dependency': return 3;
    case 'unassigned': return 2;
    case 'holder': return 1;
    default: return 0;
  }
}

/** Stable risk ordering for a page: repairable goals first, then the oldest. */
export function cardSort(a: GoalCard, b: GoalCard): number {
  return Number(b.needsRepair) - Number(a.needsRepair) ||
    (a.deadline.at ?? Number.MAX_SAFE_INTEGER) - (b.deadline.at ?? Number.MAX_SAFE_INTEGER) ||
    (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.goalId.localeCompare(b.goalId);
}

export interface GoalOutcomeInput {
  expected: string;
  requiredEvidence: RequiredEvidenceKind[];
  responsibleRole: string;
  deadline?: string;
  timezone?: string;
  reason: string;
}

export function normalizeOutcome(input: GoalOutcomeInput): {
  expected: string; requiredEvidence: RequiredEvidenceKind[]; responsibleRole: string;
  deadline?: number; timezone?: string;
} {
  const expected = String(input.expected ?? '').trim();
  if (expected.length < 4 || expected.length > 4000) throw new Error('预期成果需为 4-4000 字');
  const required = [...new Set((input.requiredEvidence ?? []).map(String))];
  if (required.some(kind => !REQUIRED_KINDS.has(kind))) throw new Error('requiredEvidence 含未知证据类型');
  const responsibleRole = String(input.responsibleRole ?? '').trim();
  if (!responsibleRole || responsibleRole.length > 80) throw new Error('responsibleRole 必填');
  let deadline: number | undefined;
  if (input.deadline !== undefined) {
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(input.deadline) || !Number.isFinite(Date.parse(input.deadline))) {
      throw new Error('deadline 必须是带时区偏移的绝对时刻');
    }
    deadline = Date.parse(input.deadline);
  }
  let timezone: string | undefined;
  if (input.timezone !== undefined) {
    if (!isTimeZone(input.timezone)) throw new Error('timezone 必须是 IANA 时区');
    timezone = input.timezone;
  }
  if (String(input.reason ?? '').trim().length < 10) throw new Error('理由需为 10-2000 字');
  return { expected, requiredEvidence: required as RequiredEvidenceKind[], responsibleRole,
    ...(deadline === undefined ? {} : { deadline }), ...(timezone === undefined ? {} : { timezone }) };
}

const AI_RECEIPT = /\b(ai|agent|model|bot|assistant|自动化|模型|机器人)\b/i;
const TEST_SOURCE = /(^|[^a-z])(test|testing|qa\+|example\.com|localhost)([^a-z]|$)/i;

export interface GoalEvidenceInput {
  kind: GoalEvidenceKind;
  summary: string;
  source: string;
  confirmedBy: string;
  evidenceType: 'external_receipt' | 'production_record' | 'manual_signoff';
  at?: string;
  taskId?: string;
  reason: string;
}

export function normalizeEvidence(input: GoalEvidenceInput, now: number): {
  kind: GoalEvidenceKind; summary: string; source: string; confirmedBy: string;
  evidenceType: GoalEvidenceInput['evidenceType']; at: number; taskId?: string;
} {
  const kind = String(input.kind ?? '') as GoalEvidenceKind;
  if (!CUSTOMER_KINDS.has(kind) && kind !== 'release' && kind !== 'deploy_qa' && kind !== 'implementation') {
    throw new Error('证据类型不在目标成果契约内');
  }
  if (kind === 'implementation') throw new Error('实现完成从任务图派生，不接受人工证据');
  const summary = String(input.summary ?? '').trim();
  if (summary.length < 4 || summary.length > 2000) throw new Error('证据摘要需为 4-2000 字');
  const source = String(input.source ?? '').trim();
  if (source.length < 2 || source.length > 1000) throw new Error('证据来源需为 2-1000 字');
  const confirmedBy = String(input.confirmedBy ?? '').trim();
  if (confirmedBy.length < 2 || confirmedBy.length > 200) throw new Error('确认人需为 2-200 字');
  if (AI_RECEIPT.test(confirmedBy)) throw new Error('确认人必须是人或外部回执，不能是 AI/模型');
  if (TEST_SOURCE.test(source)) throw new Error('证据来源不能是测试账号或本地测试地址');
  if (!['external_receipt', 'production_record', 'manual_signoff'].includes(input.evidenceType)) {
    throw new Error('evidenceType 必须是 external_receipt / production_record / manual_signoff');
  }
  if (String(input.reason ?? '').trim().length < 10) throw new Error('理由需为 10-2000 字');
  let at = now;
  if (input.at !== undefined) {
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(input.at) || !Number.isFinite(Date.parse(input.at))) {
      throw new Error('at 必须是带时区偏移的绝对时刻');
    }
    at = Date.parse(input.at);
    if (at > now + 5 * 60_000) throw new Error('证据时间不能晚于当前时间');
  }
  return { kind, summary, source, confirmedBy, evidenceType: input.evidenceType,
    at, ...(input.taskId ? { taskId: String(input.taskId) } : {}) };
}
