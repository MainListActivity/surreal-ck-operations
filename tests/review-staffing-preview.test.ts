import { expect, test } from 'bun:test';
import { reviewStaffingPreviews } from '../src/dispatcher/dispatcher.ts';
import type { EmployeeDef, EmployeeInst, SupervisedTask, Workforce } from '../src/workforce.ts';

// SYS-DISP AC05 (R5): a review preview is ready only when a candidate can take the review now. Zero candidates are blocked, a
// pool where nobody qualifies is blocked with the reasons kept, and an unreadable author history is history_unavailable.
const task = {
  id: 'rev-task', title: 'R5 复核预览', state: 'review', reviewerRole: 'engineering', executorRole: 'engineering',
  repoPath: '/fixture/repo', submittedBy: 'emp-author', currentEmployee: undefined,
} as unknown as SupervisedTask;

const base = {
  defs: [] as EmployeeDef[], insts: [] as EmployeeInst[], states: new Map<string, 'idle'>(), holding: new Set<string>(),
  health: new Map(), quotaBlocked: new Map<string, string>(), busyBy: new Map<string, number>(), providerMax: { claude: 2 },
  slots: new Map<string, string>(), opsRepo: '/fixture/ops', sidecar: false, now: 0,
};
const readable = { contributors: async () => ({ excluded: ['emp-author'] }) } as unknown as Pick<Workforce, 'contributors'>;
const unreadable = { contributors: async () => { throw new Error('history read failed'); } } as unknown as Pick<Workforce, 'contributors'>;

const def = { id: 'def-eng', role: 'engineering', provider: 'claude', model: 'fixture-model', enabled: true, maxInstances: 2, weight: 1, tracks: [] } as unknown as EmployeeDef;
const reviewer = { id: 'emp-reviewer', def: 'def-eng', role: 'engineering', provider: 'claude', model: 'fixture-model', repoHome: '/fixture/repo' } as unknown as EmployeeInst;

const preview = (over: Partial<typeof base>, workforce: Pick<Workforce, 'contributors'> = readable) =>
  reviewStaffingPreviews([task], { ...base, ...over }, workforce).then(([p]) => p!);

test('zero candidates is blocked, never ready', async () => {
  const p = await preview({});
  expect(p.status).toBe('blocked');
  expect(p.entries).toEqual([]);
});

test('candidates that none of them qualifies for are blocked, and their reasons are kept', async () => {
  const p = await preview({ defs: [{ ...def, enabled: false }], insts: [{ ...reviewer, id: 'emp-author' }], states: new Map([['emp-author', 'idle' as const]]) });
  expect(p.status).toBe('blocked');
  expect(p.entries.map(entry => entry.code).sort()).toEqual(['def_disabled', 'prior_submitter']);
  expect(p.entries.every(entry => !entry.eligible)).toBe(true);
});

test('one candidate that can take the review makes the preview ready', async () => {
  const p = await preview({ defs: [def], insts: [reviewer], states: new Map([['emp-reviewer', 'idle' as const]]) });
  expect(p.status).toBe('ready');
  expect(p.entries.some(entry => entry.eligible)).toBe(true);
});

test('A, B and C all recused, the only reviewer seat full and its provider out of quota: blocked, every exclusion kept, nothing ready', async () => {
  // R3: the preview names each recused author and the capacity that is missing, so the page shows the root cause.
  const authors = { contributors: async () => ({ excluded: ['emp-a', 'emp-b', 'emp-c'] }) } as unknown as Pick<Workforce, 'contributors'>;
  const engineer = (id: string) => ({ ...reviewer, id }) as EmployeeInst;
  const p = await preview({ defs: [{ ...def, maxInstances: 3 }], insts: ['emp-a', 'emp-b', 'emp-c'].map(engineer),
    states: new Map<string, 'busy'>([['emp-a', 'busy'], ['emp-b', 'busy'], ['emp-c', 'busy']]) as never,
    quotaBlocked: new Map([['claude', 'quota reset pending']]) }, authors);
  expect(p.status).toBe('blocked');
  expect(p.entries.filter(entry => entry.code === 'prior_submitter')).toHaveLength(3);
  expect(p.entries.some(entry => entry.code === 'seat_full' || entry.code === 'quota')).toBe(true);
  expect(p.entries.every(entry => !entry.eligible)).toBe(true);
});

test('an unreadable author history is history_unavailable, and every candidate reads as unknown', async () => {
  const p = await preview({ defs: [def], insts: [reviewer], states: new Map([['emp-reviewer', 'idle' as const]]) }, unreadable);
  expect(p.status).toBe('history_unavailable');
  expect(p.entries.every(entry => !entry.eligible && entry.code === 'unknown')).toBe(true);
});
