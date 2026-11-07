import { expect, test } from 'bun:test';
import { checkLearned, checkNoteText, laneOf, notesFit, NOTES_MAX_LINES, renderNotes } from '../src/lane-notes.ts';
import { renderMessage, templateFor } from '../src/outbound-messages.ts';
import { continuitySession, finishedSessions, reclaimIdleSessions } from '../src/dispatcher/idle-sessions.ts';
import { observeRuntimeIdle } from '../src/dispatcher/memory-lru.ts';
import { RecordId } from 'surrealdb';
import type { EmployeeInst, SupervisedTask } from '../src/workforce.ts';

const note = (id: string, text: string, createdAt: string, pinned = false) => ({ id, text, createdAt, pinned });

test('a lane is project × role, and a task without a project belongs to the company lane', () => {
  expect(laneOf('surreal_ck', 'qa')).toBe('surreal_ck:qa');
  expect(laneOf(undefined, 'qa')).toBe('company:qa');
});

test('notes.md puts pinned notes first, then the newest', () => {
  const text = renderNotes('p:qa', [note('a', '旧', '2026-11-01T00:00:00.000Z'), note('b', '新', '2026-11-03T00:00:00.000Z'), note('c', '置顶', '2026-10-01T00:00:00.000Z', true)]);
  expect(text.split('\n').filter(line => line.startsWith('- '))).toEqual(['- 置顶', '- 新', '- 旧']);
  expect(renderNotes('p:qa', [])).toContain('还没有笔记');
});

test('a note is one bounded line without credentials', () => {
  expect(checkNoteText('  复验要逐条实测  ')).toBe('复验要逐条实测');
  expect(() => checkNoteText('两行\n内容')).toThrow('一行');
  expect(() => checkNoteText('字'.repeat(241))).toThrow('240');
  expect(checkNoteText('字'.repeat(240))).toHaveLength(240);
  expect(() => checkNoteText(`token sck_${'a'.repeat(32)}`)).toThrow('凭证');
  expect(() => checkNoteText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toThrow('凭证');
  expect(() => checkLearned([])).toThrow();
  expect(() => checkLearned(['1', '2', '3', '4', '5', '6'])).toThrow();
});

test('the notes ceiling counts lines and bytes', () => {
  const rows = (n: number, size = 4) => Array.from({ length: n }, (_, i) => note(String(i), 'x'.repeat(size), '2026-11-01T00:00:00.000Z'));
  expect(notesFit('p:qa', rows(NOTES_MAX_LINES - 10))).toBe(true);
  expect(notesFit('p:qa', rows(NOTES_MAX_LINES))).toBe(false);
  expect(notesFit('p:qa', rows(120, 240))).toBe(false);
});

test('dispatch messages name notes.md and render it next to task.md', () => {
  for (const body of [templateFor('execute', true), templateFor('execute'), templateFor('review', true, 'review'), templateFor('review', false, 'review')]) {
    expect(body).toContain('notes.md');
    expect(body).toContain('learned');
  }
  const sent = renderMessage(templateFor('execute'), { sckBin: '/bin/sck', commDir: '/comm/x/', taskId: 't' });
  expect(sent).toContain('/comm/x/notes.md');
  expect(sent).toContain('/comm/x/task.md');
});

const inst = (over: Partial<EmployeeInst>): EmployeeInst => ({ id: 'i1', role: 'qa', paseoAgentId: 'agent', idleSince: 10, workspaceScope: 'maintenance', ...over });
const reclaim = (state: string, status: string, over: Partial<EmployeeInst> = {}) => {
  const retired: string[] = [];
  return reclaimIdleSessions({
    instances: [inst(over)], states: new Map([['i1', state]]), held: new Set(), bound: new Set(), now: 100_000, minutes: 120,
    workforce: { observeSessionIdle: async () => {}, retireIdle: async (i: EmployeeInst) => { retired.push(i.id); }, openPendingWakes: async () => [] } as never,
    paseo: { status: async () => ({ status, pendingPermissions: 0 }), archive: async () => {} } as never,
    archiveScene: async () => {}, log: () => {},
  }).then(out => ({ out, retired }));
};

test('idle cleanup ends a scoped session, including one whose runtime is already closed', async () => {
  expect((await reclaim('idle', 'idle')).out).toEqual(['i1']);
  expect((await reclaim('sleeping', 'closed', { workspaceScope: 'e159e40ad4e50080' })).out).toEqual(['i1']);
  expect((await reclaim('busy', 'running')).out).toEqual([]);
  expect((await reclaim('sleeping', 'running')).out).toEqual([]);
  expect((await reclaim('idle', 'idle', { activeTask: 't' })).out).toEqual([]);
});

test('a closed runtime keeps its idle clock instead of restarting it every pass', async () => {
  const updates: unknown[] = [];
  await observeRuntimeIdle({ instances: [inst({ idleSince: 50, lastWakeAt: 10 })], states: new Map([['i1', 'sleeping']]), tasks: [], now: 100,
    workforce: { observeSessionIdle: async (rows: unknown[]) => { updates.push(...rows); } } as never });
  expect(updates).toEqual([]);
});

const sessionTask = (id: string, row: Record<string, unknown> = {}) => ({ id, executorRole: 'engineering', row } as unknown as SupervisedTask);
const session = (id: string, over: Partial<EmployeeInst>): EmployeeInst => ({ id, role: 'engineering', paseoAgentId: `agent-${id}`, ...over });
const idle = (...ids: string[]) => new Map(ids.map(id => [id, 'idle']));
const child = (parent: string, project?: string) => sessionTask('child', { parent: new RecordId('task', parent), project: project ? new RecordId('project', project) : undefined });

test('oneshot continuity: a task returns to the session that last worked it in that phase', () => {
  const executor = session('a', { lastTask: 't', lastPhase: 'execute', lane: 'p:engineering' });
  const reviewer = session('b', { lastTask: 't', lastPhase: 'review', lane: 'p:qa' });
  const other = session('c', { lastTask: 'x', lastPhase: 'execute', lane: 'p:engineering' });
  const states = idle('a', 'b', 'c');
  expect(continuitySession([other, reviewer, executor], states, sessionTask('t'), false)?.id).toBe('a');
  expect(continuitySession([other, executor, reviewer], states, sessionTask('t'), true)?.id).toBe('b');
  expect(continuitySession([other, executor], states, sessionTask('new'), false)).toBeUndefined();
  expect(continuitySession([executor], new Map([['a', 'busy']]), sessionTask('t'), false)).toBeUndefined();
  const older = session('d', { lastTask: 't', lastPhase: 'review', lastWakeAt: 1 });
  const newer = session('e', { lastTask: 't', lastPhase: 'review', lastWakeAt: 2 });
  expect(continuitySession([older, newer], idle('d', 'e'), sessionTask('t'), true)?.id).toBe('e');
});

test('oneshot continuity: a follow-up continues the parent executor only within the lane', () => {
  const executor = session('a', { lastTask: 'p', lastPhase: 'execute', lane: 'proj:engineering' });
  expect(continuitySession([executor], idle('a'), child('p', 'proj'), false)?.id).toBe('a');
  expect(continuitySession([executor], idle('a'), child('p', 'other'), false)).toBeUndefined();
  expect(continuitySession([executor], idle('a'), child('p', 'proj'), true)).toBeUndefined();
  const reviewer = session('b', { lastTask: 'p', lastPhase: 'review', lane: 'proj:engineering' });
  expect(continuitySession([reviewer], idle('b'), child('p', 'proj'), false)).toBeUndefined();
  const moved = session('c', { lastTask: 'sibling', lastPhase: 'execute', lane: 'proj:engineering' });
  expect(continuitySession([moved], idle('c'), child('p', 'proj'), false)).toBeUndefined();
});

test('oneshot finish: only a waiting session whose task is over and has no follow-up in its lane ends', () => {
  const facts = { states: new Map([['done', 'done'], ['void', 'void'], ['open', 'review'], ['chain', 'done']]), followUps: [{ parent: 'chain', lane: 'p:engineering' }] };
  const ended = (inst: EmployeeInst, state = 'idle', held = new Set<string>()) =>
    finishedSessions({ instances: [inst], states: new Map([[inst.id, state]]), held, facts }).length === 1;
  const on = (lastTask: string, over: Partial<EmployeeInst> = {}) => session('s', { lastTask, lastPhase: 'execute', lane: 'p:engineering', ...over });
  expect(ended(on('done'))).toBe(true);
  expect(ended(on('void'))).toBe(true);
  expect(ended(on('gone'))).toBe(true); // A deleted task is over too.
  expect(ended(on('done'), 'sleeping')).toBe(true);
  expect(ended(on('open'))).toBe(false);
  expect(ended(on('chain'))).toBe(false);
  expect(ended(on('chain', { lastPhase: 'review', lane: 'p:qa' }))).toBe(true);
  expect(ended(on('chain', { lane: 'p:qa' }))).toBe(true);
  expect(ended(on('done'), 'busy')).toBe(false);
  expect(ended(on('done', { activeTask: 'x' }))).toBe(false);
  expect(ended(on('done'), 'idle', new Set(['s']))).toBe(false);
  expect(ended(session('s', {}))).toBe(false); // A session that predates these fields is left to idle cleanup.
});
