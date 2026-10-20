import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';

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
 *  - Consistency: every authorship change bumps the task version in the same transaction as
 *    its audit row. Lease transactions compare the version they read the facts at, so a
 *    change that lands in between is refused and the caller re-reads (CONTRIBUTION_MOVED).
 */

/** The phase a contribution was made in: writing code, or reviewing it. */
export type WorkPhase = 'execute' | 'review';

/** What one audit row means for its actor: an author, a reviewer, unknown (fail-closed as author), or none. */
export type ContributionRole = 'author' | 'reviewer' | 'unknown' | 'none';

/** One audit row, reduced to what authorship depends on. */
export interface ContributionEvent {
  action: string;
  /** Employee id. Absent for system or other non-employee actors, which never author. */
  actor?: string;
  /** Recorded on rows written by this code; legacy rows have none. */
  phase?: WorkPhase;
  at?: string;
  /** Task version the row was written at (timeline only). */
  version?: number;
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

/** Phrase a transaction raises when the contribution facts it was built from are stale (see readContributionView). */
export const CONTRIBUTION_MOVED = 'contribution history moved';

/** True when a lease transaction refused because the facts it used were stale: the caller re-reads and retries. */
export const isContributionMoved = (error: unknown): boolean =>
  error instanceof CompanyError && error.message.toLowerCase().includes(CONTRIBUTION_MOVED);

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

/**
 * The task's open lease, when someone holds it now: the holder and the phase the task is in. A lease ends at every decisive
 * action (submit, accept, return, block, release), so the holder's rows after their last decisive action belong to this phase,
 * even when the rows are legacy rows without a recorded phase. Without this, a reviewer holding a review lease would be
 * counted as an unknown author and could not decide the review (fail-closed does not mean locked out of its own lease).
 */
export interface OpenLease { actor: string; phase: WorkPhase }

/** Indexes of the open holder's rows that follow their last decisive action. */
function openRowIndexes(rows: readonly ContributionEvent[], open?: OpenLease): Set<number> {
  const indexes = new Set<number>();
  if (!open) return indexes;
  let lastDecisive = -1;
  rows.forEach((event, index) => {
    if (event.actor === open.actor && (event.action === 'submit' || event.action === 'accept' || event.action === 'return')) lastDecisive = index;
  });
  rows.forEach((event, index) => {
    if (event.actor === open.actor && index > lastDecisive) indexes.add(index);
  });
  return indexes;
}

/**
 * The role of every contribution row in `rows` (contribution actions only, chronological). Submits author; accepts and returns
 * review; every other row follows its recorded phase, else the open lease's phase, else the phase inferred for legacy rows.
 */
export function rolesOf(rows: readonly ContributionEvent[], open?: OpenLease): ContributionRole[] {
  const openIndexes = openRowIndexes(rows, open);
  return rows.map((event, index) => {
    if (event.action === 'submit') return 'author';
    if (event.action === 'accept' || event.action === 'return') return 'reviewer';
    const phase = event.phase ?? (openIndexes.has(index) ? open!.phase : inferPhase(rows, index));
    if (phase === 'review') return 'reviewer';
    return phase === undefined ? 'unknown' : 'author';
  });
}

/** Derives authorship from audit events in chronological order. */
export function deriveContributors(events: readonly ContributionEvent[], explicitImplementer?: string, open?: OpenLease): ContributionFacts {
  const rows = events.filter(event => event.actor && (CONTRIBUTION_ACTIONS as readonly string[]).includes(event.action));
  const authors = new Set<string>();
  const reviewers = new Set<string>();
  const unknown: UnknownContribution[] = [];
  const roles = rolesOf(rows, open);
  rows.forEach((event, index) => {
    const actor = event.actor!;
    const role = roles[index]!;
    if (role === 'reviewer') {
      reviewers.add(actor);
      return;
    }
    authors.add(actor);
    if (role === 'unknown') {
      unknown.push({ actor, action: event.action, at: event.at, reason: '历史行缺少阶段且之后无可判定动作，按作者处理（fail-closed）' });
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

const isoOf = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value ?? '');

/** The open lease a task row describes: its holder, in the phase the task state names. Undefined when nobody holds it. */
export function openLeaseOf(holder: string | null | undefined, state: string | null | undefined): OpenLease | undefined {
  if (!holder || (state !== 'doing' && state !== 'review')) return undefined;
  return { actor: holder, phase: state === 'review' ? 'review' : 'execute' };
}

/** The facts and the task version they were read at. `version` is undefined when the task does not exist. */
export interface ContributionView {
  facts: ContributionFacts;
  version?: number;
}

interface ContributionRead {
  implementer?: string | null;
  version?: number | null;
  state?: string | null;
  holder?: string | null;
  rows?: Array<{ action: string; actor?: unknown; phase?: string | null; at?: unknown }> | null;
}

/**
 * The task's explicit implementer, its version and its contribution-bearing audit rows, read in one transaction so the three
 * describe the same database state. A lease transaction that writes the facts' version check (`seen`) is refused with
 * CONTRIBUTION_MOVED when another authorship change landed after this read.
 */
export async function readContributionView(db: Surreal, taskId: string): Promise<ContributionView> {
  const responses = await db.query<unknown[]>(`BEGIN TRANSACTION;
    LET $row = SELECT implementer, version, state, current_employee AS holder FROM ONLY $task;
    LET $rows = SELECT action, actor, phase, at FROM audit WHERE task = $task AND action IN $actions ORDER BY at ASC;
    RETURN { read: { implementer: $row.implementer, version: $row.version, state: $row.state, holder: $row.holder, rows: $rows } };
    COMMIT TRANSACTION;`,
  { task: new RecordId('task', taskId), actions: [...CONTRIBUTION_ACTIONS] }).responses();
  const found = responses.every(response => response.success)
    ? responses.map(response => response.success ? response.result : undefined)
      .find((value): value is { read: ContributionRead } => typeof value === 'object' && value !== null && 'read' in value)
    : undefined;
  if (!found) throw new CompanyError('temporarily_unavailable', 'contribution history read did not complete; retry', true);
  const { read } = found;
  const events: ContributionEvent[] = (read.rows ?? []).map(row => ({
    action: row.action,
    actor: employeeOf(row.actor),
    phase: row.phase === 'execute' || row.phase === 'review' ? row.phase : undefined,
    at: isoOf(row.at),
  }));
  const open = openLeaseOf(read.holder, read.state);
  return {
    facts: deriveContributors(events, read.implementer ?? undefined, open),
    version: typeof read.version === 'number' ? read.version : undefined,
  };
}

/** The facts only, for callers that do not check the version (dispatcher reads, previews). */
export async function readContributors(db: Surreal, taskId: string): Promise<ContributionFacts> {
  return (await readContributionView(db, taskId)).facts;
}

/**
 * The dispatcher's execute gate. Only the implementer may take code work. No implementer and no
 * ambiguity means a fresh task: whoever claims first becomes the implementer.
 */
export function executeGate(facts: Pick<ContributionFacts, 'implementer' | 'ambiguous'>): { implementer?: string; unresolved: boolean } {
  return { implementer: facts.implementer, unresolved: facts.ambiguous };
}

/** One audit row of the timeline: who did what at which version, and the role that row plays for its actor. */
export interface TimelineEntry {
  at: string;
  version?: number;
  actor?: string;
  action: string;
  /** The phase recorded on the row, or the phase implied by its role for legacy rows. */
  phase?: WorkPhase;
  /** `recorded` when the row carries its phase, `inferred` when the phase comes from the role, absent otherwise. */
  phaseSource?: 'recorded' | 'inferred';
  role: ContributionRole;
}

/**
 * Every audit row of a task, oldest first, with the role each contribution row plays. Read-only: the input is the audit stream,
 * so the same function explains the live database and an exported history alike.
 */
export function contributionTimeline(events: readonly ContributionEvent[], open?: OpenLease): TimelineEntry[] {
  const contributing = events.flatMap((event, index) =>
    event.actor && (CONTRIBUTION_ACTIONS as readonly string[]).includes(event.action) ? [index] : []);
  const rows = contributing.map(index => events[index]!);
  const rowRoles = rolesOf(rows, open);
  const roles = new Map(contributing.map((index, position) => [index, rowRoles[position]!] as const));
  return events.map((event, index) => {
    const role = roles.get(index) ?? 'none';
    const implied: WorkPhase | undefined = role === 'reviewer' ? 'review' : role === 'author' || role === 'unknown' ? 'execute' : undefined;
    const phase = event.phase ?? implied;
    return {
      at: event.at ?? '', version: event.version, actor: event.actor, action: event.action,
      ...(phase ? { phase } : {}),
      ...(phase ? { phaseSource: event.phase ? 'recorded' as const : 'inferred' as const } : {}),
      role,
    };
  });
}

/** Read of a task's full audit stream for the timeline (every action except routine ops calls). */
export async function readAuditTimeline(db: Surreal, taskId: string, limit = 300, open?: OpenLease): Promise<TimelineEntry[]> {
  const [rows] = await db.query<[Array<{ action: string; actor?: unknown; phase?: string | null; at?: unknown; version?: number | null }>]>(
    `SELECT id, action, actor, phase, at, version FROM audit WHERE task = $task AND action != 'ops_call' ORDER BY at ASC, id ASC LIMIT $limit;`,
    { task: new RecordId('task', taskId), limit });
  const events: ContributionEvent[] = (rows ?? []).map(row => ({
    action: row.action,
    actor: employeeOf(row.actor),
    phase: row.phase === 'execute' || row.phase === 'review' ? row.phase : undefined,
    at: isoOf(row.at),
    version: typeof row.version === 'number' ? row.version : undefined,
  }));
  return contributionTimeline(events, open);
}

export type ImplementerStatus = 'bound' | 'proposal' | 'manager_decision' | 'fresh';

/** What the derivation says about a task's implementer, and what it would suggest. Nothing here is written. */
export interface ImplementerProposal {
  taskId: string;
  status: ImplementerStatus;
  /** The recorded implementer, when one is recorded. */
  implementer?: string;
  /** Suggestion only, for status `proposal`: the single author. Writing it needs owner authorization. */
  suggestedImplementer?: string;
  authors: string[];
  reviewers: string[];
  excluded: string[];
  unknown: UnknownContribution[];
  note: string;
}

/** The implementer status of one task, from its facts and its recorded implementer (if any). Pure. */
export function proposeImplementer(taskId: string, facts: ContributionFacts, explicit?: string): ImplementerProposal {
  const recorded = explicit || undefined;
  const base = { taskId, authors: facts.authors, reviewers: facts.reviewers, excluded: facts.excluded, unknown: facts.unknown };
  const unknownNote = facts.unknown.length ? `；${facts.unknown.length} 条历史无法判定阶段，按作者处理` : '';
  if (recorded) return { ...base, status: 'bound', implementer: recorded, note: `已绑定实现负责人，不做变更${unknownNote}` };
  if (facts.ambiguous) {
    return { ...base, status: 'manager_decision', note: `多个作者且无显式实现负责人，需经理用 implementer_takeover 指定其一${unknownNote}` };
  }
  if (facts.authors.length === 1) {
    return { ...base, status: 'proposal', suggestedImplementer: facts.authors[0],
      note: `唯一作者可建议记为实现负责人（仅建议，写入需受权）${unknownNote}` };
  }
  return { ...base, status: 'fresh', note: `尚无作者，首位领取执行的员工将成为实现负责人${unknownNote}` };
}
