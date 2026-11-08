/** 线的笔记：一条线 = 项目 × 职能。长期知识存这里，会话只是工作记忆；派工时渲染成 notes.md。 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';

export const NOTE_MAX_CHARS = 240;
export const LEARNED_MAX = 5;
/** How many effective notes one lane may carry; pinned notes count too. Past this, new proposals keep queuing. */
export const NOTE_MAX_ACTIVE = 30;
/** Same ceiling Claude Code gives MEMORY.md: past it the notes stop being read closely. */
export const NOTES_MAX_LINES = 200;
export const NOTES_MAX_BYTES = 25 * 1024;

export type NoteState = 'proposed' | 'active' | 'removed';
export type NotePhase = 'execute' | 'review';

export interface LaneNote {
  id: string; lane: string; text: string; state: NoteState; phase?: NotePhase;
  sourceTask?: string; sourceAudit?: string; author: string; pinned: boolean; createdAt: string; updatedAt: string;
}

/** A task without a project belongs to the company's own lane of that role. */
export const laneOf = (project: string | undefined, role: string): string => `${project || 'company'}:${role}`;

const SECRET = /\bsck_[A-Za-z0-9_-]{16,}|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY/;

/** Notes reach every later session of the lane, so a credential here would outlive any rotation of the task that leaked it. */
export function checkNoteText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new CompanyError('invalid', '笔记不能为空');
  const text = value.trim();
  if (text.includes('\n')) throw new CompanyError('invalid', '一条笔记只能一行');
  if ([...text].length > NOTE_MAX_CHARS) throw new CompanyError('invalid', `一条笔记不超过 ${NOTE_MAX_CHARS} 字`);
  if (SECRET.test(text)) throw new CompanyError('invalid', '笔记不能包含凭证');
  return text;
}

export function checkLearned(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > LEARNED_MAX) {
    throw new CompanyError('invalid', `learned must be a non-empty list of at most ${LEARNED_MAX} notes`);
  }
  return value.map(checkNoteText);
}

const byPinThenNewest = (a: LaneNote, b: LaneNote): number =>
  Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

/** Letters and digits only: punctuation and spacing must not hide a note that says the same thing twice. */
const foldNote = (text: string): string => text.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');

/** Chinese has no word boundaries, so adjacent character pairs are the reliable unit of similarity. */
function noteBigrams(text: string): Set<string> {
  const chars = [...foldNote(text)];
  if (chars.length < 2) return new Set(chars);
  const grams = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) grams.add(chars[i]! + chars[i + 1]!);
  return grams;
}

/** 0..1 Dice coefficient over character bigrams; two identical notes score 1. */
export function noteSimilarity(a: string, b: string): number {
  const [left, right] = [noteBigrams(a), noteBigrams(b)];
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return (2 * shared) / (left.size + right.size);
}

/** Restatements score well above this; unrelated notes of one lane score far below it. */
export const NOTE_DUPLICATE_THRESHOLD = 0.6;
/** Shortest shared fragment treated as a restatement when one note contains the other whole. */
const NOTE_CONTAINMENT_MIN = 12;

/** True when `text` adds nothing: it repeats or closely paraphrases one of `others`. */
export function isDuplicateNote(text: string, others: readonly string[]): boolean {
  const folded = foldNote(text);
  for (const other of others) {
    const otherFolded = foldNote(other);
    if (folded && otherFolded && Math.min(folded.length, otherFolded.length) >= NOTE_CONTAINMENT_MIN &&
      (folded === otherFolded || otherFolded.includes(folded) || folded.includes(otherFolded))) return true;
    if (noteSimilarity(text, other) >= NOTE_DUPLICATE_THRESHOLD) return true;
  }
  return false;
}

/** notes.md: pinned first, then newest. Pure, so the console previews the exact text a session will read. */
export function renderNotes(lane: string, notes: readonly Pick<LaneNote, 'text' | 'pinned' | 'createdAt' | 'id'>[]): string {
  const rows = [...notes].sort((a, b) => byPinThenNewest(a as LaneNote, b as LaneNote));
  const body = rows.length ? rows.map(row => `- ${row.text}`).join('\n') : '（这条线还没有笔记）';
  return `# 线的笔记：${lane}\n\n${body}\n`;
}

export function notesFit(lane: string, notes: readonly Pick<LaneNote, 'text' | 'pinned' | 'createdAt' | 'id'>[]): boolean {
  const text = renderNotes(lane, notes);
  return text.split('\n').length <= NOTES_MAX_LINES && new TextEncoder().encode(text).byteLength <= NOTES_MAX_BYTES;
}

const rowView = (row: Record<string, unknown>): LaneNote => ({
  id: String((row.id as RecordId).id), lane: String(row.lane), text: String(row.text), state: row.state as NoteState,
  phase: (row.phase ?? undefined) as NotePhase | undefined,
  sourceTask: row.source_task ? String((row.source_task as RecordId).id) : undefined,
  sourceAudit: row.source_audit ? String((row.source_audit as RecordId).id) : undefined,
  author: String(row.author ?? ''), pinned: row.pinned === true,
  createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString(),
});

export interface SettleResult { activated: number; discarded: number; fullLanes: string[]; openLanes: string[] }

export class LaneNoteStore {
  constructor(private readonly db: Surreal) {}
  private note(noteId: string) { return new RecordId('lane_note', noteId); }

  async get(noteId: string): Promise<LaneNote> {
    const row = await this.db.select<Record<string, unknown>>(this.note(noteId));
    if (!row) throw new CompanyError('not_found', `note ${noteId} not found`);
    return rowView(row);
  }

  /** Every note of a lane that is not removed, or of all lanes. */
  async list(lane?: string): Promise<LaneNote[]> {
    const [rows] = lane
      ? await this.db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM lane_note WHERE lane = $lane AND state != 'removed';`, { lane })
      : await this.db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM lane_note WHERE state != 'removed';`);
    return (rows ?? []).map(rowView).sort(byPinThenNewest);
  }

  async active(lane: string): Promise<LaneNote[]> {
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM lane_note WHERE lane = $lane AND state = 'active';`, { lane });
    return (rows ?? []).map(rowView);
  }

  async render(lane: string): Promise<string> { return renderNotes(lane, await this.active(lane)); }

  private async create(input: { lane: string; text: string; state: NoteState; phase?: NotePhase; task?: string; audit?: string; author: string; pinned?: boolean }): Promise<LaneNote> {
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `CREATE lane_note CONTENT { lane: $lane, text: $text, state: $state, phase: $phase, source_task: $task, source_audit: $audit,
        author: $author, pinned: $pinned, created_at: time::now(), updated_at: time::now() } RETURN AFTER;`,
      { lane: input.lane, text: input.text, state: input.state, phase: input.phase, author: input.author, pinned: input.pinned === true,
        task: input.task ? new RecordId('task', input.task) : undefined,
        audit: input.audit ? new RecordId('audit', input.audit) : undefined });
    return rowView(rows[0]!);
  }

  /**
   * A session's proposal: it takes effect only once its task is done. A proposal that restates an effective note of the
   * lane, or an earlier proposal of the same task, adds nothing and is dropped. A proposal from a round that has already
   * been returned is obsolete: keeping its row would let a later round revive a lesson the review rejected.
   */
  async propose(lane: string, taskId: string, phase: NotePhase, texts: readonly string[], author: string, sourceAudit?: string): Promise<void> {
    const active = await this.active(lane);
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `SELECT * FROM lane_note WHERE lane = $lane AND source_task = $task AND state = 'proposed' ORDER BY created_at;`,
      { lane, task: new RecordId('task', taskId) });
    const queued = (rows ?? []).map(rowView);
    // An accepted proposal always carries the audit id of its delivery; a proposal without one predates this rule.
    // Proposals of the same phase from an older delivery belong to a round that was returned or superseded.
    const obsolete = queued.filter(note => note.phase === phase && note.sourceAudit !== undefined &&
      note.sourceAudit !== sourceAudit);
    for (const note of obsolete) {
      await this.db.query(`UPDATE $n SET state = 'removed', updated_at = time::now();`, { n: this.note(note.id) });
    }
    const earlier = queued.filter(note => !obsolete.includes(note));
    for (const text of texts) {
      if (isDuplicateNote(text, active.map(note => note.text)) || isDuplicateNote(text, earlier.map(note => note.text))) continue;
      earlier.push(await this.create({ lane, text, state: 'proposed', phase, task: taskId, audit: sourceAudit, author }));
    }
  }

  private async assertRoom(lane: string, text: string, without?: string): Promise<void> {
    const rows = (await this.active(lane)).filter(row => row.id !== without);
    const next = [...rows, { id: 'new', text, pinned: false, createdAt: new Date().toISOString() }];
    if (rows.length >= NOTE_MAX_ACTIVE || !notesFit(lane, next)) throw new CompanyError('invalid', `线 ${lane} 的笔记已到上限，先删减再添加`);
  }

  /** The owner's own note takes effect at once; `proposed` queues it for review (seed notes). */
  async add(lane: string, text: string, author: string, options: { pinned?: boolean; proposed?: boolean } = {}): Promise<LaneNote> {
    const checked = checkNoteText(text);
    if (!lane.includes(':')) throw new CompanyError('invalid', 'lane 格式为 <项目>:<职能>');
    if (!options.proposed) await this.assertRoom(lane, checked);
    return this.create({ lane, text: checked, state: options.proposed ? 'proposed' : 'active', author, pinned: options.pinned });
  }

  async edit(noteId: string, text: string): Promise<LaneNote> {
    const checked = checkNoteText(text);
    const note = await this.get(noteId);
    if (note.state === 'active') await this.assertRoom(note.lane, checked, noteId);
    await this.db.query('UPDATE $n SET text = $text, updated_at = time::now();', { n: this.note(noteId), text: checked });
    return this.get(noteId);
  }

  async pin(noteId: string, pinned: boolean): Promise<LaneNote> {
    await this.get(noteId);
    await this.db.query('UPDATE $n SET pinned = $pinned, updated_at = time::now();', { n: this.note(noteId), pinned });
    return this.get(noteId);
  }

  async remove(noteId: string): Promise<void> {
    await this.get(noteId);
    await this.db.query(`UPDATE $n SET state = 'removed', updated_at = time::now();`, { n: this.note(noteId) });
  }

  /** The owner approves a queued note, whatever its task's state. */
  async activate(noteId: string): Promise<LaneNote> {
    const note = await this.get(noteId);
    if (note.state !== 'proposed') throw new CompanyError('conflict', '只有待生效的笔记可以生效');
    await this.assertRoom(note.lane, note.text);
    await this.db.query(`UPDATE $n SET state = 'active', updated_at = time::now();`, { n: this.note(noteId) });
    return this.get(noteId);
  }

  /**
   * One path for every way a task ends (accept, owner approval, void, deletion): a done task's proposals take effect, any
   * other terminal outcome discards them. Of a done task only the last submit round and the review that passed it count;
   * a proposal from an earlier round is discarded. A full lane keeps its proposals queued and is reported so the owner
   * can trim it. Notes without a source task wait for the owner; proposals written before rounds were recorded have no
   * audit binding and keep the old rule rather than being lost on upgrade.
   */
  async settle(): Promise<SettleResult> {
    const [pending] = await this.db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM lane_note WHERE state = 'proposed' AND source_task != NONE;`);
    const notes = (pending ?? []).map(rowView).filter(note => note.sourceTask).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const result: SettleResult = { activated: 0, discarded: 0, fullLanes: [], openLanes: [] };
    if (!notes.length) return result;
    const ids = [...new Set(notes.map(note => note.sourceTask!))].map(task => new RecordId('task', task));
    const [tasks] = await this.db.query<[Array<{ id: RecordId; state: string }>]>('SELECT id, state FROM task WHERE id IN $ids;', { ids });
    const states = new Map((tasks ?? []).map(task => [String(task.id.id), task.state]));
    const rounds = new Map<string, { submit?: string; accept?: string }>();
    const roundOf = async (taskId: string): Promise<{ submit?: string; accept?: string }> => {
      const known = rounds.get(taskId);
      if (known) return known;
      const task = new RecordId('task', taskId);
      const [submits, accepts] = await Promise.all([
        this.db.query<[Array<{ id: RecordId }>]>(
          `SELECT id, at FROM audit WHERE task = $task AND action = 'submit' ORDER BY at DESC, id DESC LIMIT 1;`, { task }).then(r => r[0]),
        this.db.query<[Array<{ id: RecordId }>]>(
          `SELECT id, at FROM audit WHERE task = $task AND action IN ['accept', 'owner_approve'] ORDER BY at DESC, id DESC LIMIT 1;`, { task }).then(r => r[0]),
      ]);
      const round = {
        submit: submits?.[0] ? String(submits[0].id.id) : undefined,
        accept: accepts?.[0] ? String(accepts[0].id.id) : undefined,
      };
      rounds.set(taskId, round);
      return round;
    };
    const full = new Set<string>();
    const open = new Set<string>();
    const activated = new Set<string>();
    for (const note of notes) {
      const state = states.get(note.sourceTask!);
      if (state === undefined || state === 'void') {
        await this.db.query(`UPDATE $n SET state = 'removed', updated_at = time::now();`, { n: this.note(note.id) });
        result.discarded++;
      } else if (state === 'done') {
        const round = await roundOf(note.sourceTask!);
        const current = note.sourceAudit === undefined ||
          (note.phase === 'execute' ? note.sourceAudit === round.submit : note.sourceAudit === round.accept);
        if (!current) {
          await this.db.query(`UPDATE $n SET state = 'removed', updated_at = time::now();`, { n: this.note(note.id) });
          result.discarded++;
          continue;
        }
        const rows = await this.active(note.lane);
        // Every limit still applies: 30 effective notes, the notes.md line count and its byte ceiling.
        if (rows.length >= NOTE_MAX_ACTIVE || !notesFit(note.lane, [...rows, note])) { full.add(note.lane); continue; }
        // Proposals queued before another note became effective, or activated earlier in this pass, are dropped.
        if (isDuplicateNote(note.text, [...rows.map(row => row.text), ...activated])) {
          await this.db.query(`UPDATE $n SET state = 'removed', updated_at = time::now();`, { n: this.note(note.id) });
          result.discarded++;
          continue;
        }
        await this.db.query(`UPDATE $n SET state = 'active', updated_at = time::now();`, { n: this.note(note.id) });
        result.activated++;
        activated.add(note.text);
        open.add(note.lane);
      }
    }
    result.fullLanes = [...full];
    result.openLanes = [...open].filter(lane => !full.has(lane));
    return result;
  }
}
