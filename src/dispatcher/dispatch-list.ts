/**
 * Bounded owner-facing lists for the pulse and roster answers. A tick can hold any number of blocked work items, so each list
 * keeps at most LIST_ITEM_LIMIT items within LIST_BYTE_BUDGET serialized bytes, and every candidate or people list keeps a few
 * names. Nothing is cut silently: `bound` reports the count before the cap and whether the answer left items out.
 */
import { goalRootBlockers, type DispatchPhase, type DispatchReason, type DispatchVerdict, type GoalRootFacts, type GoalWorkflowWaitRoot, type GoalWorkflowWaitSummary, type RecoveryAction, type WorkflowState } from './dispatch-blocked.ts';

/** Items per list. */
export const LIST_ITEM_LIMIT = 40;
/** Serialized bytes per list. One maximal row (every reason code, full candidate and people lists, longest path) fits well inside it. */
export const LIST_BYTE_BUDGET = 32 * 1024;
/** Candidate ids kept per reason; the rest are counted in `candidatesOmitted`. */
export const CANDIDATE_LIMIT = 6;
/** Names kept per people list on a goal root; the rest are counted in `peopleOmitted`. */
export const PEOPLE_LIMIT = 6;

export interface ListBound {
  /** Items before the cap. */
  total: number;
  /** Items in the answer. */
  shown: number;
  /** True when the answer left some items out. */
  truncated: boolean;
}

export interface BoundedList<T> {
  items: T[];
  bound: ListBound;
}

export interface ReasonRow {
  code: string;
  text: string;
  candidates: string[];
  candidatesOmitted?: number;
  owner: 'gm' | 'owner' | 'system';
  basis: string;
  recovery: string;
  actions: RecoveryAction[];
  nextTrigger: string;
}

export interface DispatchBlockedRow {
  taskId: string;
  goalId?: string;
  title: string;
  phase: DispatchPhase;
  /** The task's workflow state (ready or review); the dispatch status is the row itself: every row is blocked. */
  workflowState: WorkflowState;
  summary: string;
  feasible: boolean;
  /** When the conclusion was checked (the tick that produced it), ISO 8601. The row is that conclusion, not the request time. */
  checkedAt: string;
  /** Eligible candidates at the check: 0 for every row, stated so a reader sees the zero rather than a missing field. */
  eligibleCount: number;
  since?: string;
  waitingMinutes: number;
  reasons: ReasonRow[];
}

export interface GoalBlockerRow {
  goalId: string;
  taskId: string;
  title: string;
  phase: DispatchPhase;
  workflowState: WorkflowState;
  summary: string;
  feasible: boolean;
  /** The root's conclusion time (ISO 8601): the goal card's data time. */
  checkedAt: string;
  eligibleCount: number;
  since?: string;
  waitingMinutes: number;
  /** Blocked work of the goal, the root included: 无法派工 is this count, shown apart from the normal waits (impact). */
  undispatchable: number;
  others: number;
  /** Unfinished tasks waiting on this root through dependencies: normal waiting, not a dispatch failure. */
  impact: number;
  dependencyPath: Array<{ taskId: string; title: string }>;
  people: { implementer?: string; authors: string[]; reviewers: string[]; submitter?: string; submitCommit?: string; peopleOmitted?: number };
  reasons: ReasonRow[];
}

/** The first `limit` values, and how many were left out. */
export function capValues<T>(values: readonly T[], limit: number): { values: T[]; omitted: number } {
  return { values: values.slice(0, limit), omitted: Math.max(0, values.length - limit) };
}

/** Keeps items in order while both the count and the serialized byte budget allow it. Stops at the first item that does not fit. */
export function boundList<T>(items: readonly T[], limit = LIST_ITEM_LIMIT, budget = LIST_BYTE_BUDGET): BoundedList<T> {
  const kept: T[] = [];
  let bytes = 2; // the enclosing brackets
  for (const item of items) {
    if (kept.length === limit) break;
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + (kept.length > 0 ? 1 : 0);
    if (bytes + size > budget) break;
    kept.push(item);
    bytes += size;
  }
  return { items: kept, bound: { total: items.length, shown: kept.length, truncated: kept.length < items.length } };
}

const reasonRow = (reason: DispatchReason): ReasonRow => {
  const cut = capValues(reason.candidates, CANDIDATE_LIMIT);
  return { code: reason.code, text: reason.text, candidates: cut.values, ...(cut.omitted ? { candidatesOmitted: cut.omitted } : {}),
    owner: reason.owner, basis: reason.basis, recovery: reason.recovery, actions: reason.actions.map(action => ({ ...action })),
    nextTrigger: reason.nextTrigger };
};

/** Material blocks first, then the longest wait, then task id: the order an owner reads a blocked queue in. */
const byPriority = (a: DispatchVerdict, b: DispatchVerdict) =>
  Number(a.feasible) - Number(b.feasible) || b.waitingMinutes - a.waitingMinutes
  || a.taskId.localeCompare(b.taskId) || a.phase.localeCompare(b.phase);

/** Blocked work from the latest pass. Dispatchable work has no verdict, so it is never listed. */
export function dispatchBlockedRows(verdicts: readonly DispatchVerdict[]): DispatchBlockedRow[] {
  return verdicts.filter(v => !v.dispatchable).sort(byPriority).map((v): DispatchBlockedRow => ({
    taskId: v.taskId, goalId: v.goalId, title: v.title, phase: v.phase, summary: v.summary, feasible: v.feasible,
    workflowState: v.workflowState, eligibleCount: v.eligibleCount, checkedAt: v.checkedAt,
    since: v.since, waitingMinutes: v.waitingMinutes, reasons: v.reasons.map(reasonRow),
  }));
}

/** The bounded view of dispatchBlockedRows: at most `limit` rows and LIST_BYTE_BUDGET bytes, with the marker. */
export function dispatchBlockedList(verdicts: readonly DispatchVerdict[], limit = LIST_ITEM_LIMIT): BoundedList<DispatchBlockedRow> {
  return boundList(dispatchBlockedRows(verdicts), limit);
}

/** Material blocks first, then the longest wait, then goal id: the order the goal tab reads its roots in. */
const goalPriority = (a: GoalBlockerRow, b: GoalBlockerRow) =>
  Number(a.feasible) - Number(b.feasible) || b.waitingMinutes - a.waitingMinutes || a.goalId.localeCompare(b.goalId);

/**
 * One root blocker per goal, with people capped. Without facts the people and impact fields stay empty. Rows are ranked
 * before the cap, so a cut drops the least urgent roots.
 */
export function goalBlockerRows(verdicts: readonly DispatchVerdict[], facts?: GoalRootFacts): GoalBlockerRow[] {
  const rows = goalRootBlockers(verdicts, facts).map((root): GoalBlockerRow => {
    const authors = capValues(root.people.authors, PEOPLE_LIMIT);
    const reviewers = capValues(root.people.reviewers, PEOPLE_LIMIT);
    const omitted = authors.omitted + reviewers.omitted;
    return {
      goalId: root.goalId, taskId: root.taskId, title: root.title, phase: root.phase, summary: root.summary, feasible: root.feasible,
      since: root.since, waitingMinutes: root.waitingMinutes, others: root.others, impact: root.impact,
      undispatchable: root.undispatchable, workflowState: root.workflowState, eligibleCount: root.eligibleCount, checkedAt: root.checkedAt,
      dependencyPath: root.dependencyPath,
      people: { ...root.people, authors: authors.values, reviewers: reviewers.values, ...(omitted ? { peopleOmitted: omitted } : {}) },
      reasons: root.reasons.map(reasonRow),
    };
  });
  return rows.sort(goalPriority);
}

/** Owner pulse projection for workflow waits. Root order and classification come from the shared evaluator. */
export function goalWorkflowWaitRows(summary: GoalWorkflowWaitSummary): GoalWorkflowWaitRoot[] {
  return summary.roots.map(root => {
    if (!root.people) return { ...root, dependencyPath: root.dependencyPath?.map(item => ({ ...item })) };
    const authors = capValues(root.people.authors, PEOPLE_LIMIT);
    const reviewers = capValues(root.people.reviewers, PEOPLE_LIMIT);
    const omitted = authors.omitted + reviewers.omitted;
    return {
      ...root,
      dependencyPath: root.dependencyPath?.map(item => ({ ...item })),
      people: { ...root.people, authors: authors.values, reviewers: reviewers.values,
        ...(omitted ? { peopleOmitted: omitted } : {}) },
    };
  });
}

/** The bounded view of goalBlockerRows: at most `limit` rows and LIST_BYTE_BUDGET bytes, with the marker. */
export function goalBlockerList(verdicts: readonly DispatchVerdict[], facts?: GoalRootFacts, limit = LIST_ITEM_LIMIT): BoundedList<GoalBlockerRow> {
  return boundList(goalBlockerRows(verdicts, facts), limit);
}
