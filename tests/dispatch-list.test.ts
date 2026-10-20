import { expect, test } from 'bun:test';
import { BLOCK_TEXT, evaluateDispatch, type BlockCode, type EvaluatedEntry, type GoalRootFacts } from '../src/dispatcher/dispatch-blocked.ts';
import { CANDIDATE_LIMIT, LIST_BYTE_BUDGET, LIST_ITEM_LIMIT, PEOPLE_LIMIT, boundList, dispatchBlockedList, goalBlockerList } from '../src/dispatcher/dispatch-list.ts';

// SYS-DISP R3 (AC02/AC03): pulse and roster lists stay bounded however many items the tick holds, and say what they left out.
const now = Date.UTC(2026, 9, 20, 4, 0, 0);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const names = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
const verdictOf = (taskId: string, entries: EvaluatedEntry[], options: { goalId?: string; phase?: 'execute' | 'review'; waitedMin?: number } = {}) =>
  evaluateDispatch({ taskId, goalId: options.goalId, title: `任务 ${taskId}`, phase: options.phase ?? 'execute', role: 'engineering', home: '/ops',
    entries, checkedAt: now, since: now - (options.waitedMin ?? 0) * 60_000 });
const busy = (prefix: string, count: number): EvaluatedEntry[] =>
  Array.from({ length: count }, (_, i) => ({ key: `${prefix}-${i}`, eligible: false, code: 'session_busy' as const }));
// Every block code at once, each with more candidates than the cap keeps: the largest row the evaluator can produce.
const everyCode = (count: number): EvaluatedEntry[] => (Object.keys(BLOCK_TEXT) as BlockCode[]).flatMap(code =>
  Array.from({ length: count }, (_, i) => ({ key: `${code}-candidate-${i}-with-a-long-identifier`, eligible: false, code })));

test('a short list is shown whole, dispatchable work is not listed, and material blocks come before the longest wait', () => {
  const free = evaluateDispatch({ taskId: 'free', title: '可派工', phase: 'execute', role: 'engineering', home: '/ops', entries: [{ key: 'a', eligible: true }], checkedAt: now });
  const waiting = verdictOf('waiting', busy('w', 1), { waitedMin: 30 });
  const material = verdictOf('material', [{ key: 'author', eligible: false, code: 'author_recusal' }], { phase: 'review', waitedMin: 1 });
  const list = dispatchBlockedList([free, waiting, material]);
  expect(list.items.map(item => item.taskId)).toEqual(['material', 'waiting']);
  expect(list.bound).toEqual({ total: 2, shown: 2, truncated: false });
  expect(list.items[1]!.reasons[0]).toMatchObject({ basis: expect.any(String), actions: [expect.objectContaining({ executable: false })] });
});

test('goal rows rank material blocks first and then the longest wait, so a cut drops the least urgent roots', () => {
  const calm = verdictOf('calm', busy('calm', 1), { goalId: 'goal-a', waitedMin: 90 });
  const material = verdictOf('material', [{ key: 'author', eligible: false, code: 'author_recusal' }], { goalId: 'goal-z', phase: 'review', waitedMin: 1 });
  const short = verdictOf('short', busy('short', 1), { goalId: 'goal-b', waitedMin: 5 });
  expect(goalBlockerList([calm, short, material]).items.map(item => item.goalId)).toEqual(['goal-z', 'goal-a', 'goal-b']);
});

test('a large blocked sample stays inside the item and byte budgets, keeps the longest waits, and reports what it left out', () => {
  const blocked = Array.from({ length: 1_500 }, (_, i) => verdictOf(`task-${i}`, busy(`c${i}`, 60), { waitedMin: i % 90 }));
  const free = Array.from({ length: 500 }, (_, i) => evaluateDispatch({ taskId: `free-${i}`, title: '可派工', phase: 'execute', role: 'engineering', home: '/ops', entries: [{ key: 'x', eligible: true }], checkedAt: now }));
  const list = dispatchBlockedList([...blocked, ...free]);
  expect(list.bound).toEqual({ total: 1_500, shown: list.items.length, truncated: true });
  expect(list.items.length).toBeLessThanOrEqual(LIST_ITEM_LIMIT);
  expect(bytes(list.items)).toBeLessThanOrEqual(LIST_BYTE_BUDGET);
  expect(list.items[0]!.waitingMinutes).toBe(89);
  for (const item of list.items) {
    expect(item.reasons).toHaveLength(1);
    expect(item.reasons[0]!.candidates).toHaveLength(CANDIDATE_LIMIT);
    expect(item.reasons[0]!.candidatesOmitted).toBe(60 - CANDIDATE_LIMIT);
  }
});

test('one maximal blocked row still fits the budget, so a single worst-case verdict is shown and never dropped', () => {
  const list = dispatchBlockedList([verdictOf('worst', everyCode(60), { goalId: 'goal-worst', waitedMin: 500 })]);
  expect(list.bound).toEqual({ total: 1, shown: 1, truncated: false });
  expect(list.items[0]!.reasons).toHaveLength(Object.keys(BLOCK_TEXT).length);
  expect(bytes(list.items)).toBeLessThanOrEqual(LIST_BYTE_BUDGET);
});

test('a large goal sample keeps every row inside the budgets, and each people list reports the names it left out', () => {
  const verdicts = Array.from({ length: 300 }, (_, i) => verdictOf(`root-${i}`, busy(`r${i}`, 2), { goalId: `goal-${String(i).padStart(3, '0')}`, waitedMin: 10 }));
  const facts: GoalRootFacts = { dependencies: new Map(), titles: new Map(), people: new Map(verdicts.map(v => [v.taskId, {
    implementer: 'engineer-0', authors: names('engineer', 400), reviewers: names('reviewer', 400), submitter: 'engineer-1', submitCommit: 'abcdef1',
  }])) };
  const goals = goalBlockerList(verdicts, facts);
  expect(goals.bound).toEqual({ total: 300, shown: goals.items.length, truncated: true });
  expect(goals.items.length).toBeLessThanOrEqual(LIST_ITEM_LIMIT);
  expect(bytes(goals.items)).toBeLessThanOrEqual(LIST_BYTE_BUDGET);
  expect(goals.items[0]!.people).toMatchObject({ implementer: 'engineer-0', submitCommit: 'abcdef1', peopleOmitted: (400 - PEOPLE_LIMIT) * 2 });
  expect(goals.items[0]!.people.authors).toHaveLength(PEOPLE_LIMIT);
  expect(goals.items[0]!.people.reviewers).toHaveLength(PEOPLE_LIMIT);
});

test('one maximal goal row, with every reason, full people lists and the longest dependency chain, fits the budget', () => {
  const root = verdictOf('worst-root', everyCode(60), { goalId: 'goal-worst', waitedMin: 500 });
  const chain = Array.from({ length: 8 }, (_, i) => `p${i + 1}`);
  const facts: GoalRootFacts = {
    dependencies: new Map(chain.map((task, i) => [task, [i === 0 ? 'worst-root' : chain[i - 1]!]])),
    titles: new Map(chain.map(task => [task, `${task} ${'很长的依赖任务标题'.repeat(10)}`])),
    people: new Map([['worst-root', { implementer: 'engineer-0', authors: names('engineer', 400), reviewers: names('reviewer', 400), submitter: 'engineer-1', submitCommit: 'abcdef1' }]]),
  };
  const goals = goalBlockerList([root], facts);
  expect(goals.bound).toEqual({ total: 1, shown: 1, truncated: false });
  expect(goals.items[0]!.dependencyPath.length).toBeLessThanOrEqual(8);
  expect(goals.items[0]!.people.peopleOmitted).toBe((400 - PEOPLE_LIMIT) * 2);
  expect(bytes(goals.items)).toBeLessThanOrEqual(LIST_BYTE_BUDGET);
});

test('the byte budget cuts at the first item that does not fit, and the marker says so', () => {
  expect(boundList(['a', 'bb', 'ccc'], 2)).toEqual({ items: ['a', 'bb'], bound: { total: 3, shown: 2, truncated: true } });
  // A single item bigger than the budget is left out with the marker set, never silently dropped.
  expect(boundList(['x'.repeat(50)], 10, 20)).toEqual({ items: [], bound: { total: 1, shown: 0, truncated: true } });
});
