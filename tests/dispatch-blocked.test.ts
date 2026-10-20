import { expect, test } from 'bun:test';
import { BLOCK_TEXT, dispatchNoticeText, evaluateDispatch, globalBlock, type BlockCode, type EvaluateInput, type EvaluatedEntry } from '../src/dispatcher/dispatch-blocked.ts';

// Pure evaluator: the same inputs must always give the same verdict, reasons and one-line summary.
const at = Date.parse('2026-10-15T04:00:00Z');
const verdict = (entries: EvaluatedEntry[] | undefined, extra: Partial<EvaluateInput> = {}) =>
  evaluateDispatch({ taskId: 't1', title: '实现任务', phase: 'execute', role: 'engineering', home: '/ops', entries, checkedAt: at, ...extra });

test('one eligible candidate makes the item dispatchable: no reasons, no waiting time', () => {
  const v = verdict([{ key: 'a', eligible: true }, { key: 'b', eligible: false, code: 'session_busy' }]);
  expect(v).toMatchObject({ dispatchable: true, eligibleCount: 1, reasons: [], feasible: true, waitingMinutes: 0, since: undefined });
  expect(v.summary).toBe('实现任务：执行可派工');
});

test('every candidate recused: not dispatchable and infeasible, reasons name the recused candidates for the gm', () => {
  const v = verdict([{ key: 'author', eligible: false, code: 'author_recusal' }, { key: 'rework', eligible: false, code: 'author_recusal' }],
    { phase: 'review' });
  expect(v).toMatchObject({ dispatchable: false, feasible: false, noticeKey: 'dispatch-blocked:t1:review' });
  expect(v.reasons).toEqual([expect.objectContaining({ code: 'author_recusal', candidates: ['author', 'rework'], owner: 'gm' })]);
});

test('a coarse early reason cannot hide author recusal: every effective code is reported with its candidates', () => {
  const v = verdict([
    { key: 'quota-inst', eligible: false, code: 'quota' },
    { key: 'author', eligible: false, code: 'author_recusal' },
    { key: 'spawn:d1', eligible: false, code: 'seat_full' },
  ], { phase: 'review' });
  expect(v.reasons.map(r => r.code)).toEqual(['author_recusal', 'quota', 'seat_full']);
  expect(v.reasons.find(r => r.code === 'quota')).toMatchObject({ candidates: ['quota-inst'], owner: 'owner' });
  expect(v.feasible).toBe(true);
});

test('pass-wide gates are reported alone: candidates are not read while they apply', () => {
  const v = evaluateDispatch({ taskId: 't1', title: '实现任务', phase: 'execute', role: 'engineering', home: '/ops',
    entries: [{ key: 'a', eligible: true }], globalBlocks: [globalBlock('paused')], checkedAt: at });
  expect(v.dispatchable).toBe(false);
  expect(v.reasons).toEqual([expect.objectContaining({ code: 'paused', candidates: ['*'], owner: 'gm', text: BLOCK_TEXT.paused })]);
  expect(v.feasible).toBe(true);
});

test('a budget gate belongs to the owner, and it clears by recharge rather than by a manager edit', () => {
  const v = evaluateDispatch({ taskId: 't1', title: '实现任务', phase: 'execute', role: 'engineering', home: '/ops',
    globalBlocks: [globalBlock('budget')], checkedAt: at });
  expect(v.reasons[0]).toMatchObject({ code: 'budget', owner: 'owner', text: BLOCK_TEXT.budget });
});

test('unknown state is material at once: infeasible, and never reported as busy', () => {
  const v = verdict(undefined);
  expect(v.reasons).toEqual([expect.objectContaining({ code: 'unknown', candidates: ['*'], text: BLOCK_TEXT.unknown })]);
  expect(v.feasible).toBe(false);
  expect(v.reasons.some(r => r.code === 'session_busy')).toBe(false);
});

test('no candidate at all is a manager decision: infeasible until staff is added', () => {
  const v = verdict([]);
  expect(v).toMatchObject({ dispatchable: false, feasible: false });
  expect(v.reasons[0]).toMatchObject({ code: 'no_candidate', owner: 'gm' });
});

test('owner-decision codes alone are infeasible; a busy candidate that can recover stays feasible', () => {
  expect(verdict([{ key: 'a', eligible: false, code: 'track_mismatch' }]).feasible).toBe(false);
  expect(verdict([{ key: 'a', eligible: false, code: 'implementer_mismatch' }]).feasible).toBe(false);
  expect(verdict([{ key: 'a', eligible: false, code: 'session_busy' }]).feasible).toBe(true);
});

test('waiting time counts whole minutes from the episode start, and the summary is stable across ticks', () => {
  const since = at - 7 * 60_000 - 30_000;
  const first = verdict([{ key: 'a', eligible: false, code: 'session_busy' }], { since });
  expect(first.waitingMinutes).toBe(7);
  expect(first.since).toBe(new Date(since).toISOString());
  const later = verdict([{ key: 'a', eligible: false, code: 'session_busy' }], { since, checkedAt: at + 3 * 60_000 });
  expect(later.waitingMinutes).toBe(10);
  expect(later.summary).toBe(first.summary);
  expect(dispatchNoticeText(later)).toContain(`自 ${new Date(since).toISOString()} 起等待`);
});

test('the notice lists reasons with their candidates and the owner-facing recovery', () => {
  const v = verdict([{ key: 'author', eligible: false, code: 'author_recusal' }, { key: 'rework', eligible: false, code: 'author_recusal' }],
    { phase: 'review' });
  const text = dispatchNoticeText(v);
  expect(text).toContain(`原因：${BLOCK_TEXT.author_recusal}（author、rework）`);
  expect(text).toContain('gm：经理增补独立复核人选');
});

test('the notice key is per task and phase, so a repeated tick keeps one episode', () => {
  expect(verdict([], { phase: 'execute' }).noticeKey).toBe('dispatch-blocked:t1:execute');
  expect(verdict([], { phase: 'review' }).noticeKey).toBe('dispatch-blocked:t1:review');
});

test('a candidate with an unknown state is material at once, with or without a code', () => {
  expect(verdict([{ key: 'a', eligible: false, code: 'unknown' }])).toMatchObject({
    feasible: false, reasons: [expect.objectContaining({ code: 'unknown', candidates: ['a'] })] });
  expect(verdict([{ key: 'a', eligible: false }]).feasible).toBe(false);
});

test('quota alone stays feasible: the subscription recovers by itself, so the task is not infeasible', () => {
  const v = verdict([{ key: 'codex-inst', eligible: false, code: 'quota' }]);
  expect(v).toMatchObject({ dispatchable: false, feasible: true });
  expect(v.reasons[0]).toMatchObject({ code: 'quota', candidates: ['codex-inst'], owner: 'owner' });
});

test('every code has owner-facing text, a recovery path and a next trigger', () => {
  const codes = Object.keys(BLOCK_TEXT) as BlockCode[];
  expect(codes.length).toBeGreaterThan(15);
  for (const code of codes) {
    const v = verdict([{ key: 'x', eligible: false, code }]);
    expect(v.reasons[0]).toMatchObject({ code, text: BLOCK_TEXT[code] });
    expect(v.reasons[0]!.recovery.length).toBeGreaterThan(0);
    expect(v.reasons[0]!.nextTrigger.length).toBeGreaterThan(0);
  }
});
