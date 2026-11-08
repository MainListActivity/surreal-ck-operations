/**
 * Lane note consolidation: merges near-duplicate notes, ages out the oldest ones past a soft target, and records every
 * run so the owner can undo it as a whole. It reads and writes the lane_note table through LaneNoteStore and needs
 * nothing but the database client, so it can run inside a Cloudflare Worker as well as the local company service.
 *
 * Only active, unpinned notes move. Pinned notes count toward the target but never change; proposals wait untouched.
 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { checkNoteText, LaneNoteStore, noteSimilarity, type LaneNote, type NoteState } from './lane-notes.ts';

/** Soft ceiling per lane. Past it the oldest unpinned notes age out. Pinned notes count toward it. */
export const NOTE_SOFT_TARGET = 20;
/** Notes at or above this similarity restate one lesson and merge. Looser on purpose: this is the same lesson written twice. */
export const NOTE_MERGE_SIMILARITY = 0.5;
/** The scheduler runs a consolidation pass at most this often. */
export const CONSOLIDATION_INTERVAL_MS = 24 * 3_600_000;

const CHANGED_DURING_RUN = '笔记在整理过程中被改动，本次整理已取消，请重试（conflict）';
const ALREADY_UNDONE = '这次整理已经撤销过了，不能重复撤销（conflict）';
const CHANGED_BEFORE_UNDO = '笔记在撤销前又被改动，撤销已取消，请刷新后重试（conflict）';
const CONFLICTS = [CHANGED_DURING_RUN, ALREADY_UNDONE, CHANGED_BEFORE_UNDO];

/** Writes one cluster's lesson as a single note. Its output must pass the note rules, or the newest original is kept. */
export type RewriteNotes = (texts: string[]) => Promise<string>;

export interface ConsolidationOptions {
  /** The run's time. Every note the run writes is stamped with it, so an undo can tell a later edit from the run. */
  now: Date;
  actor: string;
  dryRun?: boolean;
  /** Overrides NOTE_SOFT_TARGET. */
  target?: number;
  rewrite?: RewriteNotes;
  /** Test seam: runs after planning and before the guarded write, so a concurrent edit can be simulated. */
  beforeWrite?: () => Promise<void>;
}

export type ConsolidationReason = 'merged' | 'aged_out' | 'rewritten';

export interface NoteSnapshot { state: NoteState; text: string }

export interface ConsolidationChange {
  note: string;
  lane: string;
  reason: ConsolidationReason;
  before: NoteSnapshot;
  after: NoteSnapshot;
  /** merged: the note that keeps the lesson, and that note's text after the run. */
  mergedInto?: string;
  keptText?: string;
}

export interface LaneConsolidation {
  lane: string; active: number; pinned: number; merged: number; agedOut: number; rewritten: number; activeAfter: number;
}

export interface UndoSkip {
  note: string;
  lane: string;
  reason: 'changed_after_run' | 'missing';
  /** The note's text now, when it still exists. */
  text?: string;
}

export interface ConsolidationRun {
  id?: string;
  at: string;
  actor: string;
  dryRun: boolean;
  lanes: LaneConsolidation[];
  changes: ConsolidationChange[];
  undoneAt?: string;
  undoneBy?: string;
  undoSkipped: UndoSkip[];
}

export interface UndoResult { id: string; undoneAt: string; restored: number; skipped: UndoSkip[] }

interface Cluster { keeper: LaneNote; members: LaneNote[] }

export interface LanePlan {
  lane: string;
  active: number;
  pinned: number;
  /** Each cluster keeps its newest note and merges the others into it. */
  clusters: Cluster[];
  /** Oldest survivors first; these are removed to bring the lane down to its target. */
  aged: LaneNote[];
}

/** Oldest first. The id breaks ties, so every pass plans the same way from the same rows. */
const byAge = (a: LaneNote, b: LaneNote): number => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);

/**
 * Plans one lane without touching the database. Clusters are the transitive closure of similarity at or above the merge
 * threshold: A~B and B~C join all three even when A and C differ. The target counts pinned notes; only survivors age out.
 */
export function planLane(lane: string, notes: readonly LaneNote[], target = NOTE_SOFT_TARGET): LanePlan {
  const active = notes.filter(note => note.state === 'active');
  const pinned = active.filter(note => note.pinned);
  const free = active.filter(note => !note.pinned);
  const parent = free.map((_, index) => index);
  const root = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]!]!;
      cursor = parent[cursor]!;
    }
    return cursor;
  };
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      if (noteSimilarity(free[i]!.text, free[j]!.text) >= NOTE_MERGE_SIMILARITY) parent[root(i)] = root(j);
    }
  }
  const groups = new Map<number, LaneNote[]>();
  free.forEach((note, index) => {
    const key = root(index);
    groups.set(key, [...(groups.get(key) ?? []), note]);
  });
  const clusters: Cluster[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const newestFirst = [...group].sort((a, b) => byAge(b, a));
    clusters.push({ keeper: newestFirst[0]!, members: newestFirst.slice(1) });
  }
  const merged = new Set(clusters.flatMap(cluster => cluster.members.map(note => note.id)));
  const survivors = free.filter(note => !merged.has(note.id));
  const excess = pinned.length + survivors.length - target;
  const aged = excess > 0 ? [...survivors].sort(byAge).slice(0, excess) : [];
  return { lane, active: active.length, pinned: pinned.length, clusters, aged };
}

/** The rewrite's text when it passes the rules a hand-written note meets; otherwise undefined. */
function acceptedText(value: unknown): string | undefined {
  try { return checkNoteText(value); } catch { return undefined; }
}

/** Asks the rewrite for each surviving cluster. A failed or unusable answer keeps the newest original. */
async function rewriteClusters(plan: LanePlan, rewrite: RewriteNotes | undefined): Promise<Map<string, string>> {
  const rewritten = new Map<string, string>();
  if (!rewrite) return rewritten;
  const aged = new Set(plan.aged.map(note => note.id));
  for (const { keeper, members } of plan.clusters) {
    if (aged.has(keeper.id)) continue;
    let next: string | undefined;
    try { next = acceptedText(await rewrite([keeper, ...members].map(note => note.text))); } catch { next = undefined; }
    if (next !== undefined && next !== keeper.text) rewritten.set(keeper.id, next);
  }
  return rewritten;
}

function changesOf(plan: LanePlan, rewritten: ReadonlyMap<string, string>): ConsolidationChange[] {
  const changes: ConsolidationChange[] = [];
  for (const { keeper, members } of plan.clusters) {
    const keptText = rewritten.get(keeper.id) ?? keeper.text;
    if (rewritten.has(keeper.id)) {
      changes.push({ note: keeper.id, lane: plan.lane, reason: 'rewritten',
        before: { state: 'active', text: keeper.text }, after: { state: 'active', text: keptText } });
    }
    for (const member of members) {
      changes.push({ note: member.id, lane: plan.lane, reason: 'merged', mergedInto: keeper.id, keptText,
        before: { state: 'active', text: member.text }, after: { state: 'removed', text: member.text } });
    }
  }
  for (const note of plan.aged) {
    changes.push({ note: note.id, lane: plan.lane, reason: 'aged_out',
      before: { state: 'active', text: note.text }, after: { state: 'removed', text: note.text } });
  }
  return changes;
}

function summaryOf(plan: LanePlan, changes: readonly ConsolidationChange[]): LaneConsolidation {
  const count = (reason: ConsolidationReason): number => changes.filter(change => change.reason === reason).length;
  const merged = count('merged');
  const agedOut = count('aged_out');
  return { lane: plan.lane, active: plan.active, pinned: plan.pinned, merged, agedOut, rewritten: count('rewritten'),
    activeAfter: plan.active - merged - agedOut };
}

/** Throws the cause of a failed transaction: the first statement that failed on its own, not the ones it cancelled. */
function settle(responses: ReadonlyArray<{ success: boolean; error?: { message: string } }>): void {
  const failed = responses.filter(response => !response.success).map(response => response.error?.message ?? 'transaction failed');
  const cause = failed.find(message => !/not executed due to|Cannot COMMIT/.test(message)) ?? failed[0];
  if (cause === undefined) return;
  const conflict = CONFLICTS.find(message => cause.includes(message));
  throw conflict ? new CompanyError('conflict', conflict) : new Error(cause);
}

/** Drops undefined fields. The record stores what is set, so an optional field is left out rather than sent as undefined. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * One transaction for the whole run. Each change is guarded by the state the plan read: still active, unpinned and with
 * the same text. A guard that fails cancels everything, so a concurrent edit leaves every lane as it was.
 */
async function writeRun(db: Surreal, id: string, run: ConsolidationRun, options: ConsolidationOptions): Promise<void> {
  await options.beforeWrite?.();
  const vars: Record<string, unknown> = {
    now: options.now, record: new RecordId('note_consolidation', id),
    run: { at: options.now, actor: run.actor, lanes: plain(run.lanes), changes: plain(run.changes) },
  };
  const statements = ['BEGIN TRANSACTION;'];
  run.changes.forEach((change, k) => {
    vars[`note${k}`] = new RecordId('lane_note', change.note);
    vars[`was${k}`] = change.before.text;
    const guard = `WHERE state = 'active' AND pinned = false AND text = $was${k} RETURN AFTER`;
    if (change.reason === 'rewritten') {
      vars[`text${k}`] = change.after.text;
      statements.push(`LET $c${k} = (UPDATE $note${k} SET text = $text${k}, updated_at = $now ${guard});`);
    } else if (change.reason === 'merged') {
      vars[`into${k}`] = new RecordId('lane_note', change.mergedInto!);
      statements.push(`LET $c${k} = (UPDATE $note${k} SET state = 'removed', removed_reason = 'merged', merged_into = $into${k}, updated_at = $now ${guard});`);
    } else {
      statements.push(`LET $c${k} = (UPDATE $note${k} SET state = 'removed', removed_reason = 'aged_out', updated_at = $now ${guard});`);
    }
    statements.push(`IF array::len($c${k}) != 1 { THROW '${CHANGED_DURING_RUN}' };`);
  });
  statements.push('CREATE $record CONTENT $run RETURN NONE;', 'COMMIT TRANSACTION;');
  settle(await db.query(statements.join('\n'), vars).responses());
}

async function consolidate(
  db: Surreal, lanes: ReadonlyArray<{ lane: string; notes: readonly LaneNote[] }>, options: ConsolidationOptions,
): Promise<ConsolidationRun> {
  const laneSummaries: LaneConsolidation[] = [];
  const changes: ConsolidationChange[] = [];
  for (const { lane, notes } of lanes) {
    const plan = planLane(lane, notes, options.target ?? NOTE_SOFT_TARGET);
    const laneChanges = changesOf(plan, await rewriteClusters(plan, options.rewrite));
    if (!laneChanges.length) continue;
    laneSummaries.push(summaryOf(plan, laneChanges));
    changes.push(...laneChanges);
  }
  const run: ConsolidationRun = {
    at: options.now.toISOString(), actor: options.actor, dryRun: options.dryRun === true,
    lanes: laneSummaries, changes, undoSkipped: [],
  };
  // A dry run and a pass with nothing to change write nothing, not even a record.
  if (run.dryRun || !changes.length) return run;
  const id = crypto.randomUUID();
  await writeRun(db, id, run, options);
  return { ...run, id };
}

/** Consolidates one lane. Returns the plan when dryRun is set, otherwise the run as recorded. */
export async function consolidateLane(db: Surreal, lane: string, options: ConsolidationOptions): Promise<ConsolidationRun> {
  const notes = await new LaneNoteStore(db).active(lane);
  return consolidate(db, [{ lane, notes }], options);
}

/** Consolidates every lane that has active notes, in one recorded run. */
export async function consolidateAll(db: Surreal, options: ConsolidationOptions): Promise<ConsolidationRun> {
  const byLane = new Map<string, LaneNote[]>();
  for (const note of await new LaneNoteStore(db).list()) {
    if (note.state !== 'active') continue;
    byLane.set(note.lane, [...(byLane.get(note.lane) ?? []), note]);
  }
  return consolidate(db, [...byLane].map(([lane, notes]) => ({ lane, notes })), options);
}

/**
 * Puts back every note a run changed, in the state and with the text it had before. A note that was edited, pinned or
 * moved since the run is left as it is and listed in the result. A run can be undone once.
 */
export async function undoConsolidation(
  db: Surreal, id: string, options: { actor: string; now: Date; beforeWrite?: () => Promise<void> },
): Promise<UndoResult> {
  const record = new RecordId('note_consolidation', id);
  const row = await db.select<Record<string, unknown>>(record);
  if (!row) throw new CompanyError('not_found', `consolidation ${id} not found`);
  if (row.undone_at) throw new CompanyError('conflict', ALREADY_UNDONE);
  const ranAt = new Date(row.at as Date);
  const store = new LaneNoteStore(db);
  const restore: ConsolidationChange[] = [];
  const skipped: UndoSkip[] = [];
  for (const change of (row.changes ?? []) as ConsolidationChange[]) {
    let current: LaneNote;
    try {
      current = await store.get(change.note);
    } catch (error) {
      if (!(error instanceof CompanyError && error.code === 'not_found')) throw error;
      skipped.push({ note: change.note, lane: change.lane, reason: 'missing' });
      continue;
    }
    if (Date.parse(current.updatedAt) > ranAt.getTime() || current.state !== change.after.state || current.text !== change.after.text) {
      skipped.push({ note: change.note, lane: change.lane, reason: 'changed_after_run', text: current.text });
      continue;
    }
    restore.push(change);
  }
  await options.beforeWrite?.();
  const vars: Record<string, unknown> = {
    record, now: options.now, actor: options.actor, ranAt, skipped: plain(skipped),
  };
  const statements = ['BEGIN TRANSACTION;',
    'LET $undone = (UPDATE $record SET undone_at = $now, undone_by = $actor, undo_skipped = $skipped WHERE undone_at = NONE RETURN AFTER);',
    `IF array::len($undone) != 1 { THROW '${ALREADY_UNDONE}' };`];
  restore.forEach((change, k) => {
    vars[`note${k}`] = new RecordId('lane_note', change.note);
    vars[`to${k}`] = change.before.text;
    vars[`toState${k}`] = change.before.state;
    vars[`was${k}`] = change.after.text;
    vars[`wasState${k}`] = change.after.state;
    statements.push(`LET $r${k} = (UPDATE $note${k} SET state = $toState${k}, text = $to${k}, merged_into = NONE, removed_reason = NONE, updated_at = $now
      WHERE state = $wasState${k} AND text = $was${k} AND updated_at <= $ranAt RETURN AFTER);`);
    statements.push(`IF array::len($r${k}) != 1 { THROW '${CHANGED_BEFORE_UNDO}' };`);
  });
  statements.push('COMMIT TRANSACTION;');
  settle(await db.query(statements.join('\n'), vars).responses());
  return { id, undoneAt: options.now.toISOString(), restored: restore.length, skipped };
}

function runView(row: Record<string, unknown>): ConsolidationRun {
  const undone = row.undone_at
    ? { undoneAt: new Date(row.undone_at as Date).toISOString(), undoneBy: String(row.undone_by ?? '') } : {};
  return {
    id: String((row.id as RecordId).id), at: new Date(row.at as Date).toISOString(), actor: String(row.actor ?? ''), dryRun: false,
    lanes: (row.lanes ?? []) as LaneConsolidation[], changes: (row.changes ?? []) as ConsolidationChange[],
    undoSkipped: (row.undo_skipped ?? []) as UndoSkip[], ...undone,
  };
}

/** Recorded runs, newest first. */
export async function listConsolidations(db: Surreal, limit = 20): Promise<ConsolidationRun[]> {
  const bounded = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
  const [rows] = await db.query<[Array<Record<string, unknown>>]>(
    'SELECT * FROM note_consolidation ORDER BY at DESC LIMIT $limit;', { limit: bounded });
  return (rows ?? []).map(runView);
}

/**
 * The scheduler's entry point: consolidates every lane when the last check or the last recorded run is at least
 * `intervalMs` old, and returns undefined when it is not due. A pass that fails records no check, so the next tick retries.
 */
export async function consolidateDue(
  db: Surreal, options: { now: Date; actor: string; intervalMs?: number },
): Promise<ConsolidationRun | undefined> {
  const marker = new RecordId('company_meta', 'note_consolidation');
  const checked = await db.select<{ checked_at?: Date }>(marker);
  const [recent] = await db.query<[Array<{ at: Date }>]>('SELECT at FROM note_consolidation ORDER BY at DESC LIMIT 1;');
  const seen = [checked?.checked_at, recent?.[0]?.at]
    .filter(value => value !== undefined && value !== null)
    .map(value => new Date(value as Date).getTime());
  const elapsed = options.now.getTime() - Math.max(0, ...seen);
  if (seen.length && elapsed >= 0 && elapsed < (options.intervalMs ?? CONSOLIDATION_INTERVAL_MS)) return undefined;
  const run = await consolidateAll(db, { now: options.now, actor: options.actor });
  await db.query('UPSERT $marker CONTENT { checked_at: $now } RETURN NONE;', { marker, now: options.now });
  return run;
}
