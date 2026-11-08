import { expect, test } from 'bun:test';
import { ownerApi, type OwnerApiContext } from '../src/owner-api.ts';
import { renderContextFor, type BoardView, type OwnerBoard } from '../src/board.ts';
import { DEFAULT_MACHINE_CRITERION, bodyOfDispatch, dispatchText, renderMessage, unrenderMessage } from '../src/outbound-render.ts';

// The owner board commands over a database that holds nothing: the read answers empty, and a malformed edit fails before any read.
// The full edit path (a stored message, a claimed employee, a sent message) runs against a real fork in dispatch-board.fork.test.ts.
function emptyCtx() {
  const queries: string[] = [];
  const db = { query: async (sql: string) => { queries.push(sql); return [[]]; }, select: async () => undefined };
  const ctx = { db: { db } as never, core: {} as never, owner: {} as never, workforce: {} as never, messages: {} as never,
    opsRepo: '/fake/ops' } as OwnerApiContext;
  return { ctx, queries };
}

test('board.snapshot reads the board through the owner API at the time the owner asked for', async () => {
  const { ctx, queries } = emptyCtx();
  const board = await ownerApi(ctx, { command: 'board.snapshot', now: 1_000_000 }, 'cli') as OwnerBoard;
  expect(board).toEqual({ at: 1_000_000, runner: { state: 'unknown' }, employees: [], unassigned: [], recent: [] });
  // The snapshot only reads: no statement it sends writes.
  expect(queries.length).toBeGreaterThan(0);
  expect(queries.filter(sql => /\b(CREATE|UPDATE|UPSERT|DELETE|INSERT|RELATE)\b/.test(sql))).toEqual([]);
});

test('message.edit_rendered rejects a malformed request before it reads anything', async () => {
  const { ctx, queries } = emptyCtx();
  await expect(ownerApi(ctx, { command: 'message.edit_rendered', employeeId: 'e1', rendered: '实现' }, 'cli')).rejects.toThrow('messageId invalid');
  await expect(ownerApi(ctx, { command: 'message.edit_rendered', messageId: 'm1', rendered: '实现' }, 'cli')).rejects.toThrow('employeeId invalid');
  await expect(ownerApi(ctx, { command: 'message.edit_rendered', messageId: 'm1', employeeId: 'e1', rendered: '   ' }, 'cli'))
    .rejects.toThrow('rendered invalid');
  expect(queries).toEqual([]);
});

test('bodyOfDispatch takes off only the workdir line a dispatch appends', () => {
  const body = renderMessage('先读 notes.md。完成 task.md 中的需求。', { sckBin: '/bin/sck', commDir: '/comm/e1', taskId: 't1' });
  expect(bodyOfDispatch(dispatchText(body, '/wt/t1'))).toBe(body);
  expect(bodyOfDispatch(body)).toBe(body);
  // A workdir-looking line that is not the last line is text the owner wrote, so it stays for the reverse check to judge.
  const middle = `${body}\n工作目录：/wt/t1\n补充`;
  expect(bodyOfDispatch(middle)).toBe(middle);
});

test('an edit that swaps a rendered path for a bare file name cannot be reversed to a stored body', () => {
  const ctx = { sckBin: '/bin/sck', commDir: '/comm/e1', taskId: 't1' };
  const shown = renderMessage('完成 task.md 中的需求。', ctx);
  expect(shown).toBe('完成 /comm/e1/task.md 中的需求。');
  expect(unrenderMessage(shown, ctx)).toBe('完成 task.md 中的需求。');
  expect(unrenderMessage(shown.replace('/comm/e1/task.md', 'task.md'), ctx)).toBeUndefined();
});

test('renderContextFor renders for an employee the view saw, with the view paths and the step criterion only', () => {
  const view: BoardView = { at: 1, env: { sckBin: '/bin/sck', opsRepo: '/ops' }, queue: [], employees: { e1: { commDir: '/comm/e1', next: [] } } };
  expect(renderContextFor(view, 'e2', { taskId: 't1', step: 'execute', acceptanceCriteria: undefined })).toBeUndefined();
  expect(renderContextFor(view, 'e1', { taskId: 't1', step: 'execute', acceptanceCriteria: undefined }))
    .toEqual({ sckBin: '/bin/sck', commDir: '/comm/e1', taskId: 't1', opsRepo: '/ops', acId: DEFAULT_MACHINE_CRITERION });
  expect(renderContextFor(view, 'e1', { taskId: 't1', step: 'review', acceptanceCriteria: undefined, findingsFile: 'findings/round-01.md' }))
    .toEqual({ sckBin: '/bin/sck', commDir: '/comm/e1', taskId: 't1', findingsFile: 'findings/round-01.md', opsRepo: '/ops' });
});
