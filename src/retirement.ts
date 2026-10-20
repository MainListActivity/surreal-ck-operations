import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { CONTRIBUTION_ACTIONS, readContributionView, type ContributionFacts } from './contributors.ts';

/**
 * The retirement gate (SYS-DISP R1). Retiring an employee revokes its credential, so the refusal rules sit at the one boundary
 * every retirement passes through (`Workforce.retire`: admin CLI, dispatcher rotation and failure paths, scene archive, MCP and
 * plugin), not in the callers. An employee is refused while:
 *  - it holds a task lease, in any phase (`active_lease`);
 *  - it is the explicit implementer of an unfinished task: ready rework, review wait and blocked (dependency or manager wait)
 *    alike (`bound_implementer`);
 *  - a task has no explicit implementer and the employee is its derived implementer, the sole author (`legacy_implementer`), or
 *    one of several authors with no implementer recorded (`implementer_unresolved`). Unknown-phase legacy rows count as authors,
 *    as contributors.ts does (fail-closed).
 * Reviewers who are not authors never block, and finished or voided tasks never block. The refusal is decided before any write,
 * and the write re-checks every task version the decision used, in the same transaction (see Workforce.retire).
 */
export const RETIRE_REFUSED = 'retire_refused';

export type RetireRefusalReason = 'active_lease' | 'bound_implementer' | 'legacy_implementer' | 'implementer_unresolved';

export interface RetireRefusalItem {
  taskId: string;
  /** The task state the relation was read in. */
  state: string;
  /** execute: the code work is open or waits on its implementer; review: the task waits for a reviewer. */
  phase: 'execute' | 'review';
  reason: RetireRefusalReason;
}

/** One unfinished task that may hold a relation with the employee, read with the version its decision used. */
export interface RetirementCandidate {
  taskId: string;
  version: number;
  state: string;
  holder?: string;
  explicitImplementer?: string;
  facts: ContributionFacts;
}

/** Task states that no longer relate an employee to work: a finished or voided task never blocks retirement. */
export const FINISHED_STATES = ['done', 'void'];

/** The refusals for `employeeId` among `candidates`: one per task, the strongest reason wins. Pure. */
export function retirementRefusals(employeeId: string, candidates: readonly RetirementCandidate[]): RetireRefusalItem[] {
  return candidates.flatMap((candidate): RetireRefusalItem[] => {
    const phase = candidate.state === 'review' ? 'review' : 'execute';
    const refuse = (reason: RetireRefusalReason): RetireRefusalItem[] => [{ taskId: candidate.taskId, state: candidate.state, phase, reason }];
    if (candidate.holder === employeeId) return refuse('active_lease');
    if (candidate.explicitImplementer !== undefined) return candidate.explicitImplementer === employeeId ? refuse('bound_implementer') : [];
    if (!candidate.facts.authors.includes(employeeId)) return [];
    return refuse(candidate.facts.ambiguous ? 'implementer_unresolved' : 'legacy_implementer');
  });
}

const idsOf = (reasons: readonly RetireRefusalItem[], reason: RetireRefusalReason): string =>
  [...new Set(reasons.filter(item => item.reason === reason).map(item => item.taskId))].join('、');

/** The legal next steps for each refusal reason. Each one ends the relation; none is a way around the gate. */
export function retirementLegalActions(reasons: readonly RetireRefusalItem[]): string[] {
  const actions: string[] = [];
  const lease = idsOf(reasons, 'active_lease');
  if (lease) actions.push(`任务 ${lease} 仍有租约：等待任务结束（完成或作废），或等租约过期被调度器收回；需要提前退役时，经理先用 implementer_takeover 受控交接。`);
  const bound = idsOf(reasons, 'bound_implementer');
  if (bound) actions.push(`任务 ${bound} 绑定该员工为实现人且尚未结束（返修、待复核或阻塞中）：等待任务结束；需要提前退役时，经理先用 implementer_takeover 把实现人交接给其他工程员工。`);
  const legacy = idsOf(reasons, 'legacy_implementer');
  if (legacy) actions.push(`任务 ${legacy} 缺少实现人字段，无法在线确认：经理核实贡献记录后用 implementer_takeover 记录实现人，或等待任务结束。`);
  const unresolved = idsOf(reasons, 'implementer_unresolved');
  if (unresolved) actions.push(`任务 ${unresolved} 有多位作者且无实现人：经理用 implementer_takeover 记录唯一实现人，或等待任务结束。`);
  return actions;
}

/** The stable refusal. No write has happened: the credential stays valid and the lease, fence and task are untouched. */
export function retireRefused(employeeId: string, reasons: readonly RetireRefusalItem[]): CompanyError {
  const summary = reasons.map(item => `${item.taskId}（${item.phase === 'review' ? '复核阶段' : '执行阶段'}，${item.state}，${item.reason}）`).join('；');
  const legalActions = retirementLegalActions(reasons);
  return new CompanyError(RETIRE_REFUSED, `员工 ${employeeId} 仍有在办任务，暂不退役，凭证保持有效：${summary}。合法动作：${legalActions.join('')}`, false, {
    employeeId, reasons: [...reasons], legalActions,
  });
}

/** True when a caught error is the gate's refusal: the caller keeps the instance as it is and reports the refusal. */
export const isRetireRefused = (error: unknown): boolean => error instanceof CompanyError && error.code === RETIRE_REFUSED;

/**
 * The unfinished tasks that may relate to `employeeId`: its open lease, its explicit implementer, or any task it wrote contribution
 * rows on (derived implementers and authors). Each one is read with its facts, version and holder in one transaction.
 */
export async function readRetirementCandidates(db: Surreal, employeeId: string): Promise<RetirementCandidate[]> {
  const [touched] = await db.query<[RecordId[]]>('SELECT VALUE task FROM audit WHERE actor = $actor AND action IN $actions;', {
    actor: new RecordId('employee', employeeId), actions: [...CONTRIBUTION_ACTIONS],
  });
  const [ids] = await db.query<[RecordId[]]>(`SELECT VALUE id FROM task WHERE state NOT IN $finished
    AND (current_employee = $employee OR implementer = $employee OR id IN $touched);`, {
    finished: FINISHED_STATES, employee: employeeId, touched: touched ?? [],
  });
  const candidates: RetirementCandidate[] = [];
  for (const record of ids ?? []) {
    const taskId = String(record.id);
    const view = await readContributionView(db, taskId);
    // Gone or finished since the list was read: it no longer relates to the employee.
    if (view.state === undefined || FINISHED_STATES.includes(view.state)) continue;
    // An unfinished task whose version cannot be read has facts the gate cannot check: fail closed, never skip it.
    if (view.version === undefined) throw new CompanyError('temporarily_unavailable', 'Retirement facts are unreadable; retry', true);
    candidates.push({ taskId, version: view.version, state: view.state, holder: view.holder,
      explicitImplementer: view.explicitImplementer, facts: view.facts });
  }
  return candidates;
}
