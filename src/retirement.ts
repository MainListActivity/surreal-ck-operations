import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { CONTRIBUTION_ACTIONS, readContributionView, type ContributionFacts } from './contributors.ts';

/**
 * The retirement gate (SYS-DISP R1). Retiring an employee revokes its credential, so the refusal rules sit at the one boundary
 * every retirement and credential revocation passes (`gateCredentialChange`): `Workforce.retire` (admin CLI, dispatcher rotation and failure paths,
 * scene archive, MCP and plugin) and the admin revocation (`LocalEnrollmentAdmin.revoke`), not in the callers. An employee is
 * refused while:
 *  - it holds a task lease, in any phase (`active_lease`);
 *  - it is the explicit implementer of an unfinished task: ready rework, review wait and blocked (dependency or manager wait)
 *    alike (`bound_implementer`);
 *  - a task has no explicit implementer and the employee is one of its execute-phase handlers — an author, its derived
 *    implementer, or a claim-only handler (`hands`) — refused as `implementer_unresolved` when the facts are ambiguous
 *    (several authors, or several claim-only handlers) and `legacy_implementer` otherwise. Unknown-phase legacy rows count
 *    as authors, as contributors.ts does (fail-closed); a pure reviewer is never refused.
 * Reviewers who are not authors never block, and finished or voided tasks never block. The refusal is decided before any write,
 * and the write re-checks every task version the decision used, in the same transaction.
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
    // SYS-DISP IR01/Q1: a claim-only handler is demoted, not erased, and the gate must not lose it (GM v71: 实现者和退役
    // 门禁不得因该修复失效). What relates an employee to unfinished code is every execute-phase handler — `strictExcluded`
    // names exactly that set (authors, the derived implementer and `hands`) and never a pure reviewer.
    if (!candidate.facts.strictExcluded.includes(employeeId)) return [];
    return refuse(candidate.facts.ambiguous ? 'implementer_unresolved' : 'legacy_implementer');
  });
}

/**
 * The legal next step for one group of refusals. A takeover (`implementer_takeover`) exists for the execute phase only (ready,
 * doing, blocked), so a review-phase group never names it: it waits for the review, or for the review's return to execute work.
 * No group names a way around the gate, and none says that releasing a lease ends a binding.
 */
function legalActionFor(phase: 'execute' | 'review', reason: RetireRefusalReason, ids: string): string {
  if (phase === 'review') {
    if (reason === 'active_lease') return `任务 ${ids} 处于复核阶段且该员工持有复核租约：等待复核完成；租约过期后由调度器收回，并重新安排独立复核。复核阶段不能提前接手，也没有受权的提前释放入口，需要提前退役时报经理`;
    if (reason === 'bound_implementer') return `任务 ${ids} 处于复核阶段且该员工为实现人：等待复核完成（通过则结束，退回则回到执行阶段）；回到执行阶段后，才可由经理按执行阶段规则交接实现人`;
    return `任务 ${ids} 处于复核阶段且缺少实现人字段：等待复核完成；退回到执行阶段后，经理核对贡献记录，再按执行阶段规则记录唯一实现人`;
  }
  if (reason === 'active_lease') return `任务 ${ids} 仍有租约：等待任务结束（完成或作废）。租约过期或被收回不会解除该员工与任务的关系（实现人或作者），需要提前退役时，经理用 implementer_takeover 把实现人交接给其他工程员工，原租约随之撤销`;
  if (reason === 'bound_implementer') return `任务 ${ids} 绑定该员工为实现人且尚未结束（返修或阻塞中）：等待任务结束；需要提前退役时，经理用 implementer_takeover 把实现人交接给其他工程员工`;
  if (reason === 'legacy_implementer') return `任务 ${ids} 缺少实现人字段，无法在线确认：经理用 contributor_dryrun 核对贡献记录后，用 implementer_takeover 记录唯一实现人，或等待任务结束`;
  return `任务 ${ids} 有多名经手人且无实现人：经理用 contributor_dryrun 核对后，用 implementer_takeover 记录唯一实现人，或等待任务结束`;
}

/** The legal next steps, one per phase and reason, with the task ids of that group. Each one ends the relation; none goes around the gate. */
export function retirementLegalActions(reasons: readonly RetireRefusalItem[]): string[] {
  const groups = new Map<string, { phase: 'execute' | 'review'; reason: RetireRefusalReason; ids: string[] }>();
  for (const item of reasons) {
    const key = `${item.phase}:${item.reason}`;
    const group = groups.get(key) ?? { phase: item.phase, reason: item.reason, ids: [] };
    if (!group.ids.includes(item.taskId)) group.ids.push(item.taskId);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => legalActionFor(group.phase, group.reason, group.ids.join('、')));
}

/** The stable refusal. No write has happened: the credential stays valid and the lease, fence and task are untouched. */
export function retireRefused(employeeId: string, reasons: readonly RetireRefusalItem[], operation: 'retire' | 'revoke' = 'retire'): CompanyError {
  const summary = reasons.map(item => `${item.taskId}（${item.phase === 'review' ? '复核阶段' : '执行阶段'}，${item.state}，${item.reason}）`).join('；');
  const legalActions = retirementLegalActions(reasons);
  const numbered = legalActions.map((action, index) => `${index + 1}）${action}`).join('；');
  const verb = operation === 'revoke' ? '撤销凭证' : '退役';
  return new CompanyError(RETIRE_REFUSED, `员工 ${employeeId} 仍有在办任务，暂不${verb}，凭证保持有效：${summary}。合法动作：${numbered}。`, false, {
    employeeId, operation, reasons: [...reasons], legalActions,
  });
}

/** True when a caught error is the gate's refusal: the caller keeps the instance as it is and reports the refusal. */
export const isRetireRefused = (error: unknown): boolean => error instanceof CompanyError && error.code === RETIRE_REFUSED;

/**
 * The unfinished tasks that may relate to `employeeId`: its open lease, its explicit implementer, or any task it wrote contribution
 * rows on (derived implementers, authors and claim-only handlers). Each one is read with its facts, version and holder in one
 * transaction.
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

/** One change to the credential that the gate guards: a statement on the employee record, run in the decision's transaction. */
export interface CredentialChange {
  operation: 'retire' | 'revoke';
  statement: string;
  vars: Record<string, unknown>;
}

/**
 * The one boundary every credential change passes (SYS-DISP R1): the retirement and the admin revocation alike. It decides on the
 * unfinished relations and refuses before any write. An accepted change is one transaction that re-derives those relations and
 * writes only if they are exactly the decided ones at the decided versions (see writeGuarded). `afterDecision` is a test seam for
 * deterministic interleavings. A claim or takeover that binds the employee writes the employee record too, so it conflicts with the
 * change instead of slipping past it.
 */
export async function gateCredentialChange(db: Surreal, employeeId: string, change: CredentialChange,
  afterDecision?: (employeeId: string) => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const candidates = await readRetirementCandidates(db, employeeId);
    const refusals = retirementRefusals(employeeId, candidates);
    if (refusals.length) throw retireRefused(employeeId, refusals, change.operation);
    await afterDecision?.(employeeId);
    try {
      await writeGuarded(db, employeeId, candidates, change);
      return;
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      if (!/retire moved|conflict/i.test(cause)) throw error;
      if (attempt >= 4) throw new CompanyError('temporarily_unavailable', 'Credential facts moved while deciding; retry', true);
      await Bun.sleep(10 * (attempt + 1));
    }
  }
}

/** One transaction: the relations and versions must still be the decided ones, then the credential change is written. */
async function writeGuarded(db: Surreal, employeeId: string, candidates: readonly RetirementCandidate[], change: CredentialChange): Promise<void> {
  const responses = await db.query<unknown[]>(`BEGIN TRANSACTION;
    LET $touched = SELECT VALUE task FROM audit WHERE actor = $employee AND action IN $actions;
    LET $live = SELECT VALUE id FROM task WHERE state NOT IN $finished AND (current_employee = $key OR implementer = $key OR id IN $touched);
    IF array::len($live) != $expected OR array::len(array::complement($live, $ids)) > 0 { THROW 'retire moved: task set changed' };
    FOR $c IN $candidates {
      LET $seen = SELECT VALUE version FROM ONLY $c.id;
      IF $seen = NONE OR $seen != $c.version { THROW 'retire moved: task facts changed' };
    };
    ${change.statement}
    COMMIT TRANSACTION;`, {
    ...change.vars, employee: new RecordId('employee', employeeId), key: employeeId, actions: [...CONTRIBUTION_ACTIONS],
    finished: FINISHED_STATES, expected: candidates.length,
    ids: candidates.map(candidate => new RecordId('task', candidate.taskId)),
    candidates: candidates.map(candidate => ({ id: new RecordId('task', candidate.taskId), version: candidate.version })),
  }).responses();
  const failures = responses.filter(response => !response.success);
  if (failures.length) {
    // A THROW of the decision's facts names its cause. A commit that lost to a concurrent write names none: it is a moved decision too,
    // so the caller re-decides (and refuses with the stable code if a relation now exists) instead of surfacing a generic failure.
    throw new Error(failures.map(response => response.error.message)
      .find(message => !message.includes('not executed due to') && !message.startsWith('Cannot COMMIT')) ?? 'retire moved: transaction did not commit');
  }
}
