import { expect, test } from 'bun:test';
import { buildProgress, type ProgressEvent, type ProgressTask } from '../src/task-progress.ts';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const ago = (minutes: number) => NOW - minutes * 60_000;
const task = (id: string, state: string, extra: Partial<ProgressTask> = {}): ProgressTask => ({ id, title: `任务 ${id}`, state, ...extra });
const event = (t: string, action: string, minutes: number, text = '', actor = 'employee:⟨qa-1⟩'): ProgressEvent => ({ task: t, action, actor, text, at: ago(minutes) });
const finished = (t: string, took: number, from = 500) => [event(t, 'claim', from), event(t, 'accept', from - took)];

test('a chain finishes with its longest branch at its own pace', () => {
  const p = buildProgress([
    task('root', 'done'), task('a', 'ready', { parent: 'root' }), task('b', 'ready', { parent: 'root' }), task('c', 'planned', { parent: 'a' }),
  ], finished('root', 30), NOW);
  const chain = p.chains[0]!;
  expect(p.chains).toHaveLength(1);
  expect(chain.counts).toEqual({ done: 1, doing: 0, waiting: 3, blocked: 0, total: 4 });
  expect(chain.forecast).toMatchObject({ remainingMinutes: 60, basis: 'chain', samples: 1, medianMinutes: 30 });
  expect(chain.forecast.finishAt).toBe(new Date(NOW + 60 * 60_000).toISOString());
});

test('a running task counts what is left of the pace and never reaches zero', () => {
  const tasks = [task('root', 'done'), task('run', 'doing', { parent: 'root' })];
  const pace = finished('root', 40);
  expect(buildProgress(tasks, [...pace, event('run', 'claim', 10)], NOW).chains[0]!.forecast.remainingMinutes).toBe(30);
  expect(buildProgress(tasks, [...pace, event('run', 'claim', 90)], NOW).chains[0]!.forecast.remainingMinutes).toBe(10);
});

test('a chain with no finished task borrows the company pace, and with none anywhere it says so', () => {
  const borrowed = buildProgress([task('old', 'done'), task('new', 'ready')], finished('old', 20), NOW);
  expect(borrowed.chains[1]!.forecast).toMatchObject({ remainingMinutes: 20, basis: 'company' });
  const blank = buildProgress([task('new', 'ready')], [], NOW);
  expect(blank.chains[0]!.forecast).toMatchObject({ remainingMinutes: null, basis: 'none' });
  expect(blank.forecast.remainingMinutes).toBeNull();
});

test('finished and voided work leaves nothing to forecast', () => {
  const p = buildProgress([task('d', 'done'), task('v', 'void', { parent: 'd' })], finished('d', 5), NOW);
  expect(p.chains[0]!.counts.total).toBe(1);
  expect(p.chains[0]!.forecast.remainingMinutes).toBe(0);
  expect(p.forecast.remainingMinutes).toBe(0);
});

test('the company forecast is the slowest chain, and owner gates are called out', () => {
  const p = buildProgress([
    task('r1', 'done'), task('a', 'ready', { parent: 'r1' }),
    task('r2', 'done'), task('b', 'blocked', { parent: 'r2', blockedTo: 'owner' }),
  ], [...finished('r1', 10), ...finished('r2', 50)], NOW);
  expect(p.forecast.remainingMinutes).toBe(50);
  expect(p.forecast.ownerWaiting).toBe(1);
});

test('a return is a defect, the next submit its fix, and acceptance closes it', () => {
  const p = buildProgress([task('t', 'done')], [
    event('t', 'claim', 100), event('t', 'submit', 90, '第一版'), event('t', 'return', 80, '缺项目名称'),
    event('t', 'submit', 70, '补上项目名称', 'employee:⟨eng-1⟩'), event('t', 'accept', 60),
  ], NOW);
  expect(p.defects).toHaveLength(1);
  expect(p.defects[0]).toMatchObject({ id: 't#1', problem: '缺项目名称', fix: '补上项目名称', fixedBy: 'eng-1', foundBy: 'qa-1', state: 'fixed' });
});

test('a fix that is returned again stays on record and the new return is the open defect', () => {
  const p = buildProgress([task('t', 'doing')], [
    event('t', 'return', 80, '缺名称'), event('t', 'submit', 70, '补了'), event('t', 'return', 60, '还是缺'),
  ], NOW);
  expect(p.defects.map(d => d.state).sort()).toEqual(['fixing', 'reopened']);
});

test('awaiting review reads as verifying; a voided task drops its open defects', () => {
  const events = [event('t', 'return', 80, '缺名称'), event('t', 'submit', 70, '补了')];
  expect(buildProgress([task('t', 'review')], events, NOW).defects[0]!.state).toBe('verifying');
  expect(buildProgress([task('t', 'void')], events, NOW).defects[0]!.state).toBe('dropped');
});

test('a mechanical rollback and an owner rejection are told apart', () => {
  const p = buildProgress([task('t', 'doing')], [
    event('t', 'return', 80, '【通道回滚】会话丢失'), event('t', 'owner_reject', 70, '老板要求补证据', 'owner'),
  ], NOW);
  expect(p.defects).toHaveLength(1);
  expect(p.defects[0]).toMatchObject({ problem: '老板要求补证据', foundBy: 'owner' });
});

test('a parent outside the read window leaves a chain, and a parent cycle cannot hang the walk', () => {
  const p = buildProgress([task('orphan', 'ready', { parent: 'gone' })], [], NOW);
  expect(p.chains.map(c => c.root)).toEqual(['orphan']);
  expect(buildProgress([task('a', 'ready', { parent: 'b' }), task('b', 'ready', { parent: 'a' })], [], NOW).chains).toEqual([]);
});
