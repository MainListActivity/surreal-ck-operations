import { RecordId, type Surreal } from 'surrealdb';

/**
 * Who has touched an engineering task's code, derived from the task's audit stream.
 *
 * Pure on purpose: core claim/transition, the dispatcher's candidate gate and the dry-run
 * repair read one definition, and unit tests replay real histories through it.
 *
 *  - Author: anyone who submitted, or who held an execute-phase lease (claim, checkpoint,
 *    block, released). Authorship is permanent; a return, revocation or reassignment never
 *    removes it, so nobody can be "un-authored" to make an independent review possible.
 *  - Reviewer: a review-phase holder who is neither an author nor the implementer. Reviewing,
 *    returning or accepting never makes someone an author; reviewers may review again but
 *    never implement.
 *  - Legacy rows (written before audit rows carried `phase`) take the phase of the same
 *    actor's next decisive action: submit = execute, accept/return = review. A row with no
 *    decisive follow-up is unknown and its actor counts as an author (fail-closed).
 *  - Implementer: the explicit `implementer` field when set, otherwise the single author.
 *    Several authors with no explicit implementer is ambiguous: nobody may execute until a
 *    manager records one.
 */

/** The phase a contribution was made in: writing code, or reviewing it. */
export type WorkPhase = 'execute' | 'review';

/** One audit row, reduced to what authorship depends on. */
export interface ContributionEvent {
  action: string;
  /** Employee id. Absent for system or other non-employee actors, which never author. */
  actor?: string;
  /** Recorded on rows written by this code; legacy rows have none. */
  phase?: WorkPhase;
  at?: string;
}

export interface UnknownContribution {
  actor: string;
  action: string;
  at?: string;
  reason: string;
}

export interface ContributionFacts {
  /** Permanent authors, sorted. Includes unknown-phase actors (fail-closed). */
  authors: string[];
  /** Review-phase holders who are neither authors nor the implementer, sorted. Never implement. */
  reviewers: string[];
  /** Legacy rows whose phase could not be inferred; shown to the owner so the count is never silent. */
  unknown: UnknownContribution[];
  /** Explicit implementer, or the only author when there is exactly one. */
  implementer?: string;
  /** Several authors and no explicit implementer: nobody may execute until a manager records one. */
  ambiguous: boolean;
  /** Authors plus the implementer. Nobody in this set may review or accept the task. */
  excluded: string[];
}

/** Audit actions that can carry authorship. Everything else (resume, defer, ops_call, takeover) is ignored. */
export const CONTRIBUTION_ACTIONS = ['claim', 'checkpoint', 'released', 'block', 'submit', 'accept', 'return'] as const;

/** Phase of a legacy row, from the same actor's next decisive action before that actor claims again. */
function inferPhase(rows: readonly ContributionEvent[], index: number): WorkPhase | undefined {
  const actor = rows[index]!.actor;
  for (let next = index + 1; next < rows.length; next++) {
    const event = rows[next]!;
    if (event.actor !== actor) continue;
    if (event.action === 'claim') return undefined;
    if (event.action === 'submit') return 'execute';
    if (event.action === 'accept' || event.action === 'return') return 'review';
  }
  return undefined;
}

/** Derives authorship from audit events in chronological order. */
export function deriveContributors(events: readonly ContributionEvent[], explicitImplementer?: string): ContributionFacts {
  const rows = events.filter(event => event.actor && (CONTRIBUTION_ACTIONS as readonly string[]).includes(event.action));
  const authors = new Set<string>();
  const reviewers = new Set<string>();
  const unknown: UnknownContribution[] = [];
  rows.forEach((event, index) => {
    const actor = event.actor!;
    if (event.action === 'submit') {
      authors.add(actor);
    } else if (event.action === 'accept' || event.action === 'return') {
      reviewers.add(actor);
    } else {
      const phase = event.phase ?? inferPhase(rows, index);
      if (phase === 'review') {
        reviewers.add(actor);
      } else {
        authors.add(actor);
        if (phase === undefined) {
          unknown.push({ actor, action: event.action, at: event.at, reason: '历史行缺少阶段且之后无可判定动作，按作者处理（fail-closed）' });
        }
      }
    }
  });
  const sortedAuthors = [...authors].sort();
  const explicit = explicitImplementer || undefined;
  const implementer = explicit ?? (sortedAuthors.length === 1 ? sortedAuthors[0] : undefined);
  const excluded = [...new Set([...sortedAuthors, ...(implementer ? [implementer] : [])])].sort();
  return {
    authors: sortedAuthors,
    reviewers: [...reviewers].filter(actor => !excluded.includes(actor)).sort(),
    unknown,
    implementer,
    ambiguous: !explicit && sortedAuthors.length > 1,
    excluded,
  };
}

const employeeOf = (value: unknown): string | undefined =>
  value instanceof RecordId && value.table.name === 'employee' ? String(value.id) : undefined;

/** Reads the task's explicit implementer and contribution-bearing audit rows, then derives the facts. */
export async function readContributors(db: Surreal, taskId: string): Promise<ContributionFacts> {
  const [taskRows, auditRows] = await db.query<[
    Array<{ implementer?: string }>,
    Array<{ action: string; actor?: unknown; phase?: string; at?: unknown }>,
  ]>(
    `SELECT implementer FROM task WHERE id = $task;
     SELECT action, actor, phase, at FROM audit WHERE task = $task AND action IN $actions ORDER BY at ASC;`,
    { task: new RecordId('task', taskId), actions: [...CONTRIBUTION_ACTIONS] });
  const events: ContributionEvent[] = (auditRows ?? []).map(row => ({
    action: row.action,
    actor: employeeOf(row.actor),
    phase: row.phase === 'execute' || row.phase === 'review' ? row.phase : undefined,
    at: String(row.at ?? ''),
  }));
  return deriveContributors(events, taskRows?.[0]?.implementer ?? undefined);
}

/**
 * The dispatcher's execute gate. Only the implementer may take code work. No implementer and no
 * ambiguity means a fresh task: whoever claims first becomes the implementer.
 */
export function executeGate(facts: Pick<ContributionFacts, 'implementer' | 'ambiguous'>): { implementer?: string; unresolved: boolean } {
  return { implementer: facts.implementer, unresolved: facts.ambiguous };
}
