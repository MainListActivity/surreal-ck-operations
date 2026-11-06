import { describe, expect, test } from 'bun:test';
import { CompanyError } from '../src/core-errors.ts';
import { contributionTimeline, deriveContributors, isContributionMoved, proposeImplementer, type ContributionEvent } from '../src/contributors.ts';

// SYS-DISP AC01/AC05 on real history: the contribution-relevant audit rows of task 04195c93, in order, as the claim history
// recorded them (legacy rows: no phase). gm resume rows are omitted here because they never carry authorship.
const A = 'engineering-claude-3da797';
const B = 'engineering-factory-droid-f4978d';
const C = 'engineering-factory-droid-b954f0';
const R = 'engineering-claude-e3d236';
const LEGACY_04195C93: Array<[string, string]> = [
  ['claim', A], ['checkpoint', A], ['checkpoint', A], ['submit', A],
  ['claim', B], ['checkpoint', B], ['return', B],
  ['claim', B], ['checkpoint', B], ['checkpoint', B], ['block', B],
  ['claim', B], ['checkpoint', B], ['checkpoint', B], ['checkpoint', B], ['submit', B],
  ['claim', C], ['return', C],
  ['claim', B], ['block', B],
  ['claim', C], ['checkpoint', C], ['checkpoint', C], ['checkpoint', C], ['checkpoint', C], ['submit', C],
  ['claim', R], ['checkpoint', R], ['return', R],
  ['claim', B], ['submit', B],
  ['claim', R],
];
const replay = (rows: Array<[string, string]>, phased = false): ContributionEvent[] =>
  rows.map(([action, actor], index) => ({ action, actor, at: new Date(Date.UTC(2026, 9, 19, 0, index)).toISOString(), version: index + 1 }))
    .map((event, index) => phased ? { ...event, phase: phaseOf(rows, index) } : event);
/** Recorded phase for the phased replay: what the code now writes (review in review state, execute otherwise). */
function phaseOf(rows: Array<[string, string]>, index: number): 'execute' | 'review' {
  // Review state begins at the first submit and returns to execute state at each return; claims follow the state they meet.
  let state: 'execute' | 'review' = 'execute';
  for (let i = 0; i < index; i++) {
    const action = rows[i]![0];
    if (action === 'submit') state = 'review';
    if (action === 'return') state = 'execute';
  }
  return state;
}

describe('04195c93 replayed through the derivation', () => {
  test('three engineers wrote it: all three are excluded from review, and the reviewer of record is none of them', () => {
    // R holds the open review lease now (state review), so its last claim is a review, not an unknown authorship.
    const facts = deriveContributors(replay(LEGACY_04195C93), undefined, { actor: R, phase: 'review' });
    expect(facts.authors).toEqual([A, B, C].sort());
    expect(facts.ambiguous).toBe(true);
    expect(facts.implementer).toBeUndefined();
    expect(facts.excluded).toEqual([A, B, C].sort());
    expect(facts.reviewers).toEqual([R]);
  });

  test('the legacy claim that became a fresh author with no decisive follow-up is shown, not hidden', () => {
    const facts = deriveContributors(replay(LEGACY_04195C93), undefined, { actor: R, phase: 'review' });
    expect(facts.unknown.length).toBeGreaterThan(0);
    expect(facts.unknown.every(row => row.reason.includes('fail-closed'))).toBe(true);
  });

  test('replayed with recorded phases the same authors result, and the implementer status is a manager decision', () => {
    // (no open lease needed: every row carries its phase)
    const facts = deriveContributors(replay(LEGACY_04195C93, true));
    expect(facts.authors).toEqual([A, B, C].sort());
    expect(facts.unknown).toEqual([]);
    const proposal = proposeImplementer('04195c93-c792-4012-9f45-7a1fe17950fc', facts);
    expect(proposal.status).toBe('manager_decision');
    expect(proposal.note).toContain('implementer.takeover');
  });
});

describe('timeline: each row carries the role it plays for its actor', () => {
  test('recorded phases are kept and say so; resume and takeover rows are not contributions', () => {
    const events: ContributionEvent[] = [
      { action: 'claim', actor: A, phase: 'execute', at: '2026-10-19T00:00:00.000Z', version: 1 },
      { action: 'submit', actor: A, phase: 'execute', at: '2026-10-19T00:01:00.000Z', version: 2 },
      { action: 'claim', actor: R, phase: 'review', at: '2026-10-19T00:02:00.000Z', version: 3 },
      { action: 'return', actor: R, phase: 'review', at: '2026-10-19T00:03:00.000Z', version: 4 },
      { action: 'resume', actor: 'gm-01', at: '2026-10-19T00:04:00.000Z', version: 5 },
      { action: 'implementer_takeover', actor: 'gm-01', at: '2026-10-19T00:05:00.000Z', version: 6 },
    ];
    const timeline = contributionTimeline(events);
    expect(timeline.map(row => row.role)).toEqual(['author', 'author', 'reviewer', 'reviewer', 'none', 'none']);
    expect(timeline[0]).toMatchObject({ phase: 'execute', phaseSource: 'recorded', version: 1 });
    expect(timeline[4]).not.toHaveProperty('phase');
  });

  test('legacy rows show the phase implied by their role, marked as inferred', () => {
    const timeline = contributionTimeline(replay([['claim', A], ['submit', A], ['claim', R], ['return', R]]));
    expect(timeline.map(row => row.phaseSource)).toEqual(['inferred', 'inferred', 'inferred', 'inferred']);
    expect(timeline.map(row => row.role)).toEqual(['author', 'author', 'reviewer', 'reviewer']);
  });
});

describe('an open lease counts in the phase of its holder, not as unknown authorship', () => {
  test('a holder of a review lease with no decisive follow-up is a reviewer and may still decide', () => {
    const facts = deriveContributors(replay([['claim', A], ['submit', A], ['claim', R]]), undefined, { actor: R, phase: 'review' });
    expect(facts.authors).toEqual([A]);
    expect(facts.reviewers).toEqual([R]);
    expect(facts.excluded).toEqual([A]);
  });

  test('without the open lease the same row is fail-closed as an author', () => {
    const facts = deriveContributors(replay([['claim', A], ['submit', A], ['claim', R]]));
    expect(facts.authors).toEqual([A, R]);
    expect(facts.unknown.map(row => row.actor)).toEqual([R]);
  });
});

describe('implementer status: one reading of the facts, with a suggestion that writes nothing', () => {
  test('a recorded implementer is bound and stays as recorded', () => {
    const facts = deriveContributors(replay([['claim', A], ['submit', A]]), A);
    expect(proposeImplementer('t', facts, A)).toMatchObject({ status: 'bound', implementer: A });
  });

  test('a single author is a suggestion, not a binding', () => {
    const facts = deriveContributors(replay([['claim', A], ['submit', A]]));
    const proposal = proposeImplementer('t', facts);
    expect(proposal).toMatchObject({ status: 'proposal', suggestedImplementer: A });
    expect(proposal).not.toHaveProperty('implementer');
  });

  test('a task nobody wrote is fresh: the first execute claim will bind it', () => {
    expect(proposeImplementer('t', deriveContributors([]))).toMatchObject({ status: 'fresh', authors: [], excluded: [] });
  });

  test('a reviewer who never wrote is a reviewer, never a suggested implementer', () => {
    const facts = deriveContributors(replay([['claim', A], ['submit', A], ['claim', R], ['return', R]]));
    expect(proposeImplementer('t', facts)).toMatchObject({ status: 'proposal', suggestedImplementer: A, reviewers: [R] });
  });
});

describe('CONTRIBUTION_MOVED: only the moved refusal is retried', () => {
  test('a CompanyError that names the moved contribution history is recognised', () => {
    expect(isContributionMoved(new CompanyError('conflict', 'Task contribution history moved; retry the request'))).toBe(true);
  });

  test('other conflicts, and plain errors with the same words, are not retried', () => {
    expect(isContributionMoved(new CompanyError('conflict', 'Task changed or transaction conflicted'))).toBe(false);
    expect(isContributionMoved(new Error('contribution history moved'))).toBe(false);
    expect(isContributionMoved(undefined)).toBe(false);
  });
});
