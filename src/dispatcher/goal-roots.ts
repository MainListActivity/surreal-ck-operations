import { RecordId, type Surreal } from 'surrealdb';
import type { Workforce } from '../workforce.ts';
import {
  goalWorkflowWaitRoots, submitCommitOf,
  type GoalRootFacts, type GoalRootPeople, type GoalWorkflowTaskFact, type GoalWorkflowWaitRoot, type GoalWorkflowWaitSummary,
} from './dispatch-blocked.ts';

/** A record id such as task:⟨uuid⟩ as the bare id the verdicts carry. */
export const bareId = (value: unknown): string => {
  const text = String(value);
  const colon = text.indexOf(':');
  return (colon >= 0 ? text.slice(colon + 1) : text).replace(/^⟨|⟩$/g, '');
};

type WorkflowTaskRow = {
  id: unknown; goal?: unknown; title?: string | null; state?: string | null; dependencies?: unknown[] | null;
  blocked_to?: string | null; resume_state?: string | null; executor_role?: string | null; reviewer_role?: string | null;
  current_employee?: unknown; lease_expires_at?: number | null; goal_anchors?: unknown[] | null;
};

/**
 * Reads one goal's task graph and the database clock in one read transaction. Supplying no goal is reserved for owner pulse;
 * the QA adapter always supplies its authorized scope goal so foreign nodes and edges never enter its evaluator.
 */
export async function readGoalWorkflowFacts(db: Surreal, goalId?: string): Promise<GoalRootFacts> {
  const scoped = goalId !== undefined;
  const query = `BEGIN TRANSACTION;
    LET $at = time::now();
    LET $rows = SELECT id, goal, title, state, dependencies, blocked_to, resume_state, executor_role, reviewer_role,
      current_employee, lease_expires_at, goal.anchors AS goal_anchors
      FROM task WHERE ${scoped ? 'goal = $goal' : 'goal != NONE'};
    RETURN { read: { at: <string>$at, rows: $rows } };
    COMMIT TRANSACTION;`;
  const responses = await db.query<unknown[]>(query, scoped ? { goal: new RecordId('goal', goalId) } : {}).responses();
  const found = responses.every(response => response.success)
    ? responses.map(response => response.success ? response.result : undefined)
      .find((value): value is { read: { at: string; rows: WorkflowTaskRow[] } } =>
        typeof value === 'object' && value !== null && 'read' in value)
    : undefined;
  if (!found) throw new Error('goal workflow graph read did not complete');

  const rows = found.read.rows ?? [];
  const taskIds = new Set(rows.map(row => bareId(row.id)));
  const dependencies = new Map<string, string[]>();
  const titles = new Map<string, string>();
  const tasks = new Map<string, GoalWorkflowTaskFact>();
  for (const row of rows) {
    const taskId = bareId(row.id);
    const rawDependencies = (row.dependencies ?? []).map(bareId);
    // Keep the node set and dependency edges within this goal before returning facts to the shared evaluator.
    const visibleDependencies = rawDependencies.filter(dependency => taskIds.has(dependency));
    const state = row.state == null ? 'unknown' : String(row.state);
    const title = row.title ?? taskId;
    const goalAnchorIds = (row.goal_anchors ?? []).map(bareId);
    const fact: GoalWorkflowTaskFact = {
      taskId,
      ...(row.goal ? { goalId: bareId(row.goal) } : {}),
      title,
      state,
      dependencies: visibleDependencies,
      hiddenDependencies: rawDependencies.length - visibleDependencies.length,
      blockedTo: row.blocked_to == null ? undefined : String(row.blocked_to),
      resumeState: row.resume_state == null ? undefined : String(row.resume_state),
      executorRole: row.executor_role == null ? undefined : String(row.executor_role),
      reviewerRole: row.reviewer_role == null ? undefined : String(row.reviewer_role),
      goalAnchor: goalAnchorIds.includes(taskId),
      currentEmployee: row.current_employee == null ? undefined : bareId(row.current_employee),
      leaseExpiresAt: row.lease_expires_at == null ? undefined : Number(row.lease_expires_at),
    };
    tasks.set(taskId, fact);
    titles.set(taskId, title);
    // Keep the legacy dispatch impact graph unfinished-only, while `tasks` retains terminal nodes to prove edges satisfied.
    if (state !== 'done' && state !== 'void') dependencies.set(taskId, visibleDependencies);
  }
  return { dependencies, titles, people: new Map(), tasks, collectedAt: found.read.at };
}

export interface GoalRootPersonFacts {
  people?: GoalRootPeople;
  peopleSource?: 'contributor-audit';
  submitter?: string;
  submitterSource?: 'submit-audit';
  submitCommit?: string;
  submitCommitSource?: 'submit-audit-evidence';
  peopleCheckedAt?: string;
  submitCheckedAt?: string;
}

/** Reads only contributor and submit audit facts for the bounded roots selected by the shared evaluator. */
export async function readGoalRootPeople(db: Surreal, workforce: Pick<Workforce, 'contributors'> | undefined,
  roots: readonly string[], log: (message: string) => void = () => {}): Promise<Map<string, GoalRootPersonFacts>> {
  const unique = [...new Set(roots)];
  const entries = await Promise.all(unique.map(async root => {
    let contributor: GoalRootPeople | undefined;
    let peopleCheckedAt: string | undefined;
    if (workforce) {
      try {
        const facts = await workforce.contributors(root);
        contributor = { implementer: facts.implementer, authors: [...facts.authors], reviewers: [...facts.reviewers] };
        peopleCheckedAt = facts.checkedAt;
      } catch (error) {
        log(`goal root people: contributors read failed for ${root}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let found: { read: { at: string; submits: Array<{ actor?: unknown; evidence?: string | null }> } } | undefined;
    try {
      const responses = await db.query<unknown[]>(`BEGIN TRANSACTION;
        LET $at = time::now();
        LET $submits = SELECT actor, evidence, at FROM audit WHERE task = $task AND action = 'submit' ORDER BY at DESC LIMIT 1;
        RETURN { read: { at: <string>$at, submits: $submits } };
        COMMIT TRANSACTION;`, { task: new RecordId('task', root) }).responses();
      found = responses.every(response => response.success)
        ? responses.map(response => response.success ? response.result : undefined)
          .find((value): value is { read: { at: string; submits: Array<{ actor?: unknown; evidence?: string | null }> } } =>
            typeof value === 'object' && value !== null && 'read' in value)
        : undefined;
      if (!found) log(`goal root people: submit audit read incomplete for ${root}`);
    } catch (error) {
      log(`goal root people: submit audit read failed for ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const last = found?.read.submits?.[0];
    const submitter = last?.actor == null ? undefined : bareId(last.actor);
    const submitCommit = last?.evidence ? submitCommitOf(last.evidence) : undefined;
    return [root, {
      ...(contributor ? { people: contributor, peopleSource: 'contributor-audit' as const } : {}),
      ...(last ? { ...(submitter ? { submitter } : {}), submitterSource: 'submit-audit' as const } : {}),
      ...(submitCommit ? { submitCommit, submitCommitSource: 'submit-audit-evidence' as const } : {}),
      ...(peopleCheckedAt ? { peopleCheckedAt } : {}),
      ...(found?.read.at ? { submitCheckedAt: found.read.at } : {}),
    }] as const;
  }));
  return new Map(entries);
}

export interface GoalWorkflowWaitSnapshot {
  facts: GoalRootFacts;
  summary: GoalWorkflowWaitSummary;
}

/** One graph read and one bounded people read back both workflow waits and dispatch goal roots. */
export async function readGoalWorkflowWaitSnapshot(db: Surreal, workforce?: Pick<Workforce, 'contributors'>,
  options: { goalId?: string; roots?: readonly string[]; limit?: number; log?: (message: string) => void } = {}): Promise<GoalWorkflowWaitSnapshot> {
  const facts = await readGoalWorkflowFacts(db, options.goalId);
  const summary = goalWorkflowWaitRoots(facts, options.limit);
  const roots = [...new Set([...summary.roots.map(root => root.taskId), ...(options.roots ?? [])])];
  const peopleFacts = await readGoalRootPeople(db, workforce, roots, options.log);
  const people = new Map<string, GoalRootPeople>();
  for (const [taskId, value] of peopleFacts) {
    people.set(taskId, {
      ...(value.people ?? { authors: [], reviewers: [] }),
      ...(value.submitter ? { submitter: value.submitter } : {}),
      ...(value.submitCommit ? { submitCommit: value.submitCommit } : {}),
    });
  }
  const withSources = new Map(peopleFacts);
  return {
    facts: { ...facts, people },
    summary: { ...summary, roots: summary.roots.map(root => withPeople(root, withSources.get(root.taskId))) },
  };
}

function withPeople(root: GoalWorkflowWaitRoot, facts: GoalRootPersonFacts | undefined): GoalWorkflowWaitRoot {
  if (!facts) return root;
  const base = facts.people;
  const people = base || facts.submitter || facts.submitCommit
    ? { ...(base ?? { authors: [], reviewers: [] }), ...(facts.submitter ? { submitter: facts.submitter } : {}),
        ...(facts.submitCommit ? { submitCommit: facts.submitCommit } : {}) }
    : undefined;
  return { ...root, ...(people ? { people } : {}),
    ...(facts.peopleSource ? { peopleSource: facts.peopleSource } : {}),
    ...(facts.submitterSource ? { submitterSource: facts.submitterSource } : {}),
    ...(facts.submitCommitSource ? { submitCommitSource: facts.submitCommitSource } : {}),
    ...(facts.peopleCheckedAt ? { peopleCheckedAt: facts.peopleCheckedAt } : {}),
    ...(facts.submitCheckedAt ? { submitCheckedAt: facts.submitCheckedAt } : {}),
  };
}
