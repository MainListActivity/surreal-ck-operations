import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';

/**
 * The retirement gate. Retiring an employee revokes its credential, so the refusal sits at the one boundary every
 * retirement and credential revocation passes (`gateCredentialChange`): `Workforce.retire` (admin CLI, dispatcher
 * rotation and failure paths, scene archive, MCP and plugin) and the admin revocation (`LocalEnrollmentAdmin.revoke`),
 * not in the callers. An employee is refused while it holds a task lease (`active_lease`). Finished or voided tasks
 * never block. The refusal is decided before any write, and the write re-checks every task version the decision used,
 * in the same transaction.
 */
export const RETIRE_REFUSED = 'retire_refused';

export type RetireRefusalReason = 'active_lease';

export interface RetireRefusalItem {
  taskId: string;
  /** The task state the relation was read in. */
  state: string;
  /** execute: the code work is open or waits on its holder; review: the task waits for a reviewer. */
  phase: 'execute' | 'review';
  reason: RetireRefusalReason;
}

/** One unfinished task that may hold a relation with the employee, read with the version its decision used. */
export interface RetirementCandidate {
  taskId: string;
  version: number;
  state: string;
  holder?: string;
}

/** Task states that no longer relate an employee to work: a finished or voided task never blocks retirement. */
export const FINISHED_STATES = ['done', 'void'];

/** The refusals for `employeeId` among `candidates`: one per task, the strongest reason wins. Pure. */
export function retirementRefusals(employeeId: string, candidates: readonly RetirementCandidate[]): RetireRefusalItem[] {
  return candidates.flatMap((candidate): RetireRefusalItem[] => {
    const phase = candidate.state === 'review' ? 'review' : 'execute';
    const refuse = (reason: RetireRefusalReason): RetireRefusalItem[] => [{ taskId: candidate.taskId, state: candidate.state, phase, reason }];
    if (candidate.holder === employeeId) return refuse('active_lease');
    return [];
  });
}

/** The legal next step for one group of refusals: wait for the lease, or have the owner reassign/void the task. */
function legalActionFor(phase: 'execute' | 'review', _reason: RetireRefusalReason, ids: string): string {
  if (phase === 'review') return `任务 ${ids} 处于复核阶段且该员工持有复核租约：等待复核完成；租约过期后由调度器收回，并重新安排复核。需要提前退役时报老板`;
  return `任务 ${ids} 仍有租约：等待任务结束（完成或作废），或老板在 owner API 改派或作废任务`;
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
 * The unfinished tasks that may relate to `employeeId`: its open lease. Each one is read with its facts, version and
 * holder in one transaction.
 */
export async function readRetirementCandidates(db: Surreal, employeeId: string): Promise<RetirementCandidate[]> {
  const [rows] = await db.query<[Array<{ id: RecordId; version?: number; state: string; current_employee?: string }>]>(
    `SELECT id, version, state, current_employee FROM task WHERE state NOT IN $finished
     AND current_employee = $employee;`,
    { finished: FINISHED_STATES, employee: employeeId });
  const candidates: RetirementCandidate[] = [];
  for (const row of rows ?? []) {
    if (row.version === undefined) throw new CompanyError('temporarily_unavailable', 'Retirement facts are unreadable; retry', true);
    candidates.push({ taskId: String(row.id.id), version: row.version, state: row.state, holder: row.current_employee });
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
      await new Promise<void>(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

/** One transaction: the relations and versions must still be the decided ones, then the credential change is written. */
async function writeGuarded(db: Surreal, employeeId: string, candidates: readonly RetirementCandidate[], change: CredentialChange): Promise<void> {
  const responses = await db.query<unknown[]>(`BEGIN TRANSACTION;
    LET $live = SELECT VALUE id FROM task WHERE state NOT IN $finished AND current_employee = $key;
    IF array::len($live) != $expected OR array::len(array::complement($live, $ids)) > 0 { THROW 'retire moved: task set changed' };
    FOR $c IN $candidates {
      LET $seen = SELECT VALUE version FROM ONLY $c.id;
      IF $seen = NONE OR $seen != $c.version { THROW 'retire moved: task facts changed' };
    };
    ${change.statement}
    COMMIT TRANSACTION;`, {
    ...change.vars, employee: new RecordId('employee', employeeId), key: employeeId,
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
