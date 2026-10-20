import { RecordId, type Surreal } from 'surrealdb';
import type { Workforce } from '../workforce.ts';
import { submitCommitOf, type GoalRootFacts, type GoalRootPeople } from './dispatch-blocked.ts';

// SYS-DISP AC03 (R2): the facts a goal card names beyond the pure verdicts. Reads only. A root whose contribution history cannot
// be read keeps empty people, so the card shows nobody rather than inventing an implementer.

/** A record id such as task:⟨uuid⟩ as the bare id the verdicts carry. */
export const bareId = (value: unknown): string => {
  const text = String(value);
  const colon = text.indexOf(':');
  return (colon >= 0 ? text.slice(colon + 1) : text).replace(/^⟨|⟩$/g, '');
};

export async function readGoalRootFacts(db: Surreal, workforce: Pick<Workforce, 'contributors'>, roots: readonly string[],
  log: (message: string) => void = () => {}): Promise<GoalRootFacts> {
  const [rows] = await db.query<[Array<{ id: unknown; title?: string | null; dependencies?: unknown[] | null }>]>(
    "SELECT id, title, dependencies FROM task WHERE goal != NONE AND state NOT IN ['done', 'void'];");
  const dependencies = new Map<string, string[]>();
  const titles = new Map<string, string>();
  for (const row of rows ?? []) {
    const id = bareId(row.id);
    dependencies.set(id, (row.dependencies ?? []).map(bareId));
    titles.set(id, row.title ?? id);
  }
  const people = new Map<string, GoalRootPeople>();
  for (const root of roots) {
    let facts: GoalRootPeople = { authors: [], reviewers: [] };
    try {
      const contribution = await workforce.contributors(root);
      facts = { implementer: contribution.implementer, authors: contribution.authors, reviewers: contribution.reviewers };
    } catch (error) {
      log(`goal root people: contributors read failed for ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const [submits] = await db.query<[Array<{ actor?: unknown; evidence?: string | null }>]>(
      "SELECT actor, evidence, at FROM audit WHERE task = $task AND action = 'submit' ORDER BY at DESC LIMIT 1;",
      { task: new RecordId('task', root) });
    const last = submits?.[0];
    people.set(root, {
      ...facts,
      submitter: last?.actor === undefined || last.actor === null ? undefined : bareId(last.actor),
      submitCommit: last?.evidence ? submitCommitOf(last.evidence) : undefined,
    });
  }
  return { dependencies, titles, people };
}
