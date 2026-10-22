import { expect, test } from 'bun:test';
import { CompanyError } from '../src/core-errors.ts';
import { deriveContributors, type ContributionEvent } from '../src/contributors.ts';
import { buildIndependenceIndex, independenceHit, INDEPENDENCE_LIMITS, normalizeIndependence } from '../src/independence.ts';
import { staffingPool, type StaffingInput } from '../src/dispatcher/dispatcher.ts';
import { BLOCK_TEXT } from '../src/dispatcher/dispatch-blocked.ts';
import type { EmployeeDef, EmployeeInst, SupervisedTask } from '../src/workforce.ts';

// SYS-DISP IR01/IR02 pure rules: policy validation, which source contributors the strict and all-handler modes exclude, the
// same-source rule by registered principal (an identity link, never a definition), and the staffing pool the dispatcher
// evaluates with that exclusion.

const claim = (actor: string, phase: 'execute' | 'review' = 'execute'): ContributionEvent => ({ action: 'claim', actor, phase });
const facts = (events: ContributionEvent[], implementer?: string) => deriveContributors(events, implementer);
// Registered principals, not definitions: two employees may share a def (a capacity template) and still be independent.
const PRINCIPALS: Record<string, string> = { 't-src': 'ppl-a', 't-alias': 'ppl-a', 't-indep': 'ppl-b', 't-explicit': 'ppl-c' };
const principalOf = (employee: string) => PRINCIPALS[employee];
const policy = (over: Partial<{ mode: 'execute_handlers' | 'all_handlers'; excluded: string[] }> = {}) =>
  ({ mode: 'execute_handlers' as const, excluded: [], ...over });

const reject = (run: () => unknown) => {
  try { run(); } catch (error) { return error as CompanyError; }
  throw new Error('expected the call to throw');
};

test('strict mode excludes every execute-phase handler of a source, including a claim that never submitted', () => {
  // `t-src` held an execute lease and released it without submitting: a prior hand. Ordinary review would only demote them;
  // a strict source excludes them outright, which is the whole point of the policy mode.
  const source = facts([claim('t-src'), { action: 'released', actor: 't-src', phase: 'execute' }, claim('t-sub'),
    { action: 'submit', actor: 't-sub' }]);
  const index = buildIndependenceIndex({ policy: policy(), sources: [{ taskId: 'P', facts: source }], principalOf });
  expect(independenceHit(index, 't-src')).toMatchObject({ via: 'contributor', source: 'P', matched: 't-src' });
  expect(independenceHit(index, 't-sub')).toMatchObject({ via: 'contributor', source: 'P', role: 'author' });
});

test('strict mode leaves reviewers of a source out; all_handlers adds them', () => {
  const source = facts([claim('t-src'), { action: 'accept', actor: 't-rev' }]);
  const strict = buildIndependenceIndex({ policy: policy(), sources: [{ taskId: 'P', facts: source }], principalOf });
  expect(independenceHit(strict, 't-rev')).toBeUndefined();
  const all = buildIndependenceIndex({ policy: policy({ mode: 'all_handlers' }), sources: [{ taskId: 'P', facts: source }], principalOf });
  expect(independenceHit(all, 't-rev')).toMatchObject({ via: 'contributor', source: 'P', role: 'reviewer' });
});

test('a legacy row without a phase or a decisive follow-up is an author (fail-closed)', () => {
  const source = facts([{ action: 'checkpoint', actor: 't-legacy' }]);
  const index = buildIndependenceIndex({ policy: policy(), sources: [{ taskId: 'P', facts: source }], principalOf });
  expect(independenceHit(index, 't-legacy')).toMatchObject({ via: 'contributor', source: 'P' });
});

test('the implementer recorded explicitly on a source is excluded even without audit rows', () => {
  const index = buildIndependenceIndex({ policy: policy(), sources: [{ taskId: 'P', facts: facts([], 't-taken') }], principalOf: () => undefined });
  expect(independenceHit(index, 't-taken')).toMatchObject({ via: 'contributor', source: 'P', role: 'implementer' });
});

test('explicit exclusions are named by the policy, not by any source', () => {
  const index = buildIndependenceIndex({ policy: policy({ excluded: ['t-explicit'] }), sources: [], principalOf });
  expect(independenceHit(index, 't-explicit')).toMatchObject({ via: 'explicit' });
  expect(independenceHit(index, 't-indep')).toBeUndefined();
});

test('same source is judged by the registered principal: an alias of a contributor is excluded, an unrelated identity is not', () => {
  const index = buildIndependenceIndex({ policy: policy(), sources: [{ taskId: 'P', facts: facts([claim('t-src')]) }], principalOf });
  expect(independenceHit(index, 't-alias', 'ppl-a')).toMatchObject({ via: 'same_principal', matched: 't-src', principal: 'ppl-a' });
  expect(independenceHit(index, 't-indep', 'ppl-b')).toBeUndefined();
  // Identity is never inferred from a definition, provider, model or name: no principal link, no alias.
  expect(independenceHit(index, 't-unregistered', undefined)).toBeUndefined();
});

test('a registered definition is not an identity: two independent employees of one def stay independent (SYS-DISP Q3)', () => {
  // t-src and t-same-def share the engineering-factory-droid definition but have no principal link.
  const index = buildIndependenceIndex({ policy: policy(), sources: [{ taskId: 'P', facts: facts([claim('t-src')]) }],
    principalOf: () => undefined });
  expect(independenceHit(index, 't-same-def', undefined)).toBeUndefined();
  expect(independenceHit(index, 't-same-def', 'eng-factory')).toBeUndefined();
  expect(independenceHit(index, 't-src')).toMatchObject({ via: 'contributor', source: 'P' });
});

test('an explicit exclusion reaches the registered identity it links to, and only that identity', () => {
  const index = buildIndependenceIndex({ policy: policy({ excluded: ['t-explicit'] }), sources: [], principalOf });
  expect(independenceHit(index, 't-explicit')).toMatchObject({ via: 'explicit' });
  // t-alias shares principal ppl-c with the named employee, so it is excluded through the link, not through any def.
  expect(independenceHit(index, 't-alias', 'ppl-c')).toMatchObject({ via: 'same_principal', matched: 't-explicit', principal: 'ppl-c' });
  expect(independenceHit(index, 't-indep', 'ppl-b')).toBeUndefined();
});

test('validation accepts a minimal policy and dedupes repeated stages and sources', () => {
  const fields = normalizeIndependence({ taskId: 'D', stages: ['execute', 'execute'], sources: ['P', 'P'], mode: 'execute_handlers',
    excluded: ['t-explicit'], reason: '独立审查：来源经手人回避' });
  expect(fields.stages).toEqual(['execute']);
  expect(fields.sources).toEqual(['P']);
});

test('validation refuses a bad stage, mode, empty scope or self-reference', () => {
  const base = { taskId: 'D', stages: ['execute'], sources: ['P'], mode: 'execute_handlers', excluded: [], reason: '独立审查：来源经手人回避' };
  expect(reject(() => normalizeIndependence({ ...base, stages: [] })).code).toBe('invalid');
  expect(reject(() => normalizeIndependence({ ...base, stages: ['merge'] as never })).code).toBe('invalid');
  expect(reject(() => normalizeIndependence({ ...base, mode: 'bogus' as never })).code).toBe('invalid');
  expect(reject(() => normalizeIndependence({ ...base, sources: [], excluded: [] })).code).toBe('invalid');
  expect(reject(() => normalizeIndependence({ ...base, sources: ['D'] })).code).toBe('invalid');
});

test('validation counts raw entries before dedupe, so a flood of one repeated id is refused', () => {
  const base = { taskId: 'D', stages: ['execute'], mode: 'execute_handlers', excluded: [], reason: '独立审查：来源经手人回避' };
  const repeated = Array.from({ length: INDEPENDENCE_LIMITS.sources + 1 }, () => 'P');
  expect(reject(() => normalizeIndependence({ ...base, sources: repeated })).code).toBe('invalid');
  const explicit = Array.from({ length: INDEPENDENCE_LIMITS.excluded + 1 }, (_, n) => `t-${n}`);
  expect(reject(() => normalizeIndependence({ ...base, sources: ['P'], excluded: explicit })).code).toBe('invalid');
});

test('validation bounds identifiers and the reason in UTF-8 bytes', () => {
  const base = { taskId: 'D', stages: ['execute'], sources: ['P'], mode: 'execute_handlers', excluded: [] };
  expect(reject(() => normalizeIndependence({ ...base, reason: '独立审查：来源经手人回避', excluded: ['x'.repeat(201)] })).code).toBe('invalid');
  expect(reject(() => normalizeIndependence({ ...base, reason: '   ' })).code).toBe('invalid');
  expect(normalizeIndependence({ ...base, reason: '中'.repeat(682) }).reason).toHaveLength(682);
  expect(reject(() => normalizeIndependence({ ...base, reason: '中'.repeat(683) })).code).toBe('invalid');
});

test('validation refuses a policy whose serialized form exceeds 8 KiB', () => {
  const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, n) => `${prefix}${String(n).padStart(3, '0')}`.padEnd(200, 'x'));
  const oversized = { taskId: 'D', stages: ['execute'], sources: ids('p', 20), mode: 'execute_handlers', excluded: ids('e', 100),
    reason: '独立审查：来源经手人回避' };
  expect(reject(() => normalizeIndependence(oversized)).code).toBe('invalid');
});

const def = (id: string, over: Partial<EmployeeDef> = {}): EmployeeDef =>
  ({ id, role: 'engineering', provider: 'codex', model: 'm1', enabled: true, maxInstances: 2,
    priority: 100, weight: 10, scored: 0, errorStreak: 0, ...over });
const inst = (id: string, over: Partial<EmployeeInst> = {}): EmployeeInst =>
  ({ id, role: 'engineering', def: 'eng-claude', provider: 'codex', model: 'm1', paseoAgentId: `ag-${id}`, ...over });
const OPS = '/ops/repo';
const base = (over: Partial<StaffingInput> = {}): StaffingInput => ({
  role: 'engineering', home: OPS, defs: [], insts: [], states: new Map(), holding: new Set(),
  health: new Map(), quotaBlocked: new Map(), busyBy: new Map(), providerMax: { codex: 9 }, slots: new Map(),
  opsRepo: OPS, sidecar: false, now: 1_000_000, ...over,
});

test('dispatch: the source contributor and its registered alias are never eligible, previousEmployee included; a same-def independent employee and its spawn stay eligible', () => {
  const index = buildIndependenceIndex({ policy: policy(), sources: [{ taskId: 'P', facts: facts([claim('t-src')]) }], principalOf });
  const task = { id: 'D', previousEmployee: 't-src' } as unknown as SupervisedTask;
  const entries = staffingPool(base({
    defs: [def('eng-factory', { maxInstances: 4 }), def('eng-claude')], task,
    insts: [inst('t-src', { def: 'eng-factory', principal: 'ppl-a' }), inst('t-alias', { def: 'eng-factory', principal: 'ppl-a' }),
      inst('t-same-def', { def: 'eng-factory' }), inst('t-indep', { def: 'eng-claude', principal: 'ppl-b' })],
    states: new Map([['t-src', 'idle'], ['t-alias', 'idle'], ['t-same-def', 'idle'], ['t-indep', 'idle']]),
    independence: { kind: 'index', index },
  }));
  expect(entries.find(e => e.key === 't-src')).toMatchObject({ eligible: false, code: 'independence_conflict' });
  expect(entries.find(e => e.key === 't-alias')).toMatchObject({ eligible: false, code: 'independence_conflict' });
  // A spawn is a brand-new employee id with no principal link: independent, even of the same definition.
  expect(entries.find(e => e.key === 'spawn:eng-factory')).toMatchObject({ eligible: true });
  expect(entries.find(e => e.key === 't-same-def')).toMatchObject({ eligible: true });
  expect(entries.find(e => e.key === 't-indep')).toMatchObject({ eligible: true });
  expect(entries.find(e => e.key === 'spawn:eng-claude')).toMatchObject({ eligible: true });
});

test('dispatch: an unreadable source history blocks every candidate as unknown, never as clear', () => {
  const entries = staffingPool(base({
    defs: [def('eng-claude')], insts: [inst('t-indep')], states: new Map([['t-indep', 'idle']]),
    independence: { kind: 'unverifiable', reason: 'source P history unreadable' },
  }));
  expect(entries.every(e => !e.eligible)).toBe(true);
  expect(entries.every(e => e.code === 'unknown')).toBe(true);
  expect(entries[0]!.reason).toBe(BLOCK_TEXT.unknown);
});

test('dispatch: an unreadable source names itself in the candidate reason, and still blocks every candidate as unknown', () => {
  const entries = staffingPool(base({
    defs: [def('eng-claude')], insts: [inst('t-indep')], states: new Map([['t-indep', 'idle']]),
    independence: { kind: 'unverifiable', reason: 'Independence source history unreadable: P; retry', source: 'P' },
  }));
  expect(entries.every(e => !e.eligible && e.code === 'unknown')).toBe(true);
  expect(entries[0]!.reason).toContain('来源任务 P');
});
