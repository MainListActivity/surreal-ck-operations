/** 线的笔记：一条线 = 项目 × 职能。长期知识存这里，会话只是工作记忆；派工时渲染成 notes.md。 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';

export const NOTE_MAX_CHARS = 240;
export const LEARNED_MAX = 5;
/** Same ceiling Claude Code gives MEMORY.md: past it the notes stop being read closely. */
export const NOTES_MAX_LINES = 200;
export const NOTES_MAX_BYTES = 25 * 1024;

export type NoteState = 'proposed' | 'active' | 'removed';
export type NotePhase = 'execute' | 'review';

export interface LaneNote {
  id: string; lane: string; text: string; state: NoteState; phase?: NotePhase;
  sourceTask?: string; author: string; pinned: boolean; createdAt: string; updatedAt: string;
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

/** notes.md: pinned first, then newest. Pure, so the console previews the exact text a session will read. */
export function renderNotes(lane: string, notes: readonly Pick<LaneNote, 'text' | 'pinned' | 'createdAt' | 'id'>[]): string {
  const rows = [...notes].sort((a, b) => byPinThenNewest(a as LaneNote, b as LaneNote));
  const body = rows.length ? rows.map(row => `- ${row.text}`).join('\n') : '（这条线还没有笔记）';
  return `# 线的笔记：${lane}\n\n${body}\n`;
}

export function notesFit(lane: string, notes: readonly Pick<LaneNote, 'text' | 'pinned' | 'createdAt' | 'id'>[]): boolean {
  const text = renderNotes(lane, notes);
  return text.split('\n').length <= NOTES_MAX_LINES && Buffer.byteLength(text) <= NOTES_MAX_BYTES;
}

const rowView = (row: Record<string, unknown>): LaneNote => ({
  id: String((row.id as RecordId).id), lane: String(row.lane), text: String(row.text), state: row.state as NoteState,
  phase: (row.phase ?? undefined) as NotePhase | undefined,
  sourceTask: row.source_task ? String((row.source_task as RecordId).id) : undefined,
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

  private async create(input: { lane: string; text: string; state: NoteState; phase?: NotePhase; task?: string; author: string; pinned?: boolean }): Promise<LaneNote> {
    const [rows] = await this.db.query<[Array<Record<string, unknown>>]>(
      `CREATE lane_note CONTENT { lane: $lane, text: $text, state: $state, phase: $phase, source_task: $task, author: $author, pinned: $pinned,
        created_at: time::now(), updated_at: time::now() } RETURN AFTER;`,
      { lane: input.lane, text: input.text, state: input.state, phase: input.phase, author: input.author, pinned: input.pinned === true,
        task: input.task ? new RecordId('task', input.task) : undefined });
    return rowView(rows[0]!);
  }

  /** A session's proposal: it takes effect only once its task is done. */
  async propose(lane: string, taskId: string, phase: NotePhase, texts: readonly string[], author: string): Promise<void> {
    for (const text of texts) await this.create({ lane, text, state: 'proposed', phase, task: taskId, author });
  }

  private async assertRoom(lane: string, text: string, without?: string): Promise<void> {
    const rows = (await this.active(lane)).filter(row => row.id !== without);
    const next = [...rows, { id: 'new', text, pinned: false, createdAt: new Date().toISOString() }];
    if (!notesFit(lane, next)) throw new CompanyError('invalid', `线 ${lane} 的笔记已到上限，先删减再添加`);
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
   * other terminal outcome discards them. A full lane keeps its proposals queued and is reported so the owner can trim it.
   * Notes without a source task wait for the owner.
   */
  async settle(): Promise<SettleResult> {
    const [pending] = await this.db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM lane_note WHERE state = 'proposed' AND source_task != NONE;`);
    const notes = (pending ?? []).map(rowView).filter(note => note.sourceTask).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const result: SettleResult = { activated: 0, discarded: 0, fullLanes: [], openLanes: [] };
    if (!notes.length) return result;
    const ids = [...new Set(notes.map(note => note.sourceTask!))].map(task => new RecordId('task', task));
    const [tasks] = await this.db.query<[Array<{ id: RecordId; state: string }>]>('SELECT id, state FROM task WHERE id IN $ids;', { ids });
    const states = new Map((tasks ?? []).map(task => [String(task.id.id), task.state]));
    const full = new Set<string>();
    const open = new Set<string>();
    for (const note of notes) {
      const state = states.get(note.sourceTask!);
      if (state === undefined || state === 'void') {
        await this.db.query(`UPDATE $n SET state = 'removed', updated_at = time::now();`, { n: this.note(note.id) });
        result.discarded++;
      } else if (state === 'done') {
        const rows = await this.active(note.lane);
        if (!notesFit(note.lane, [...rows, note])) { full.add(note.lane); continue; }
        await this.db.query(`UPDATE $n SET state = 'active', updated_at = time::now();`, { n: this.note(note.id) });
        result.activated++;
        open.add(note.lane);
      }
    }
    result.fullLanes = [...full];
    result.openLanes = [...open].filter(lane => !full.has(lane));
    return result;
  }
}
