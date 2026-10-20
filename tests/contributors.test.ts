import { describe, expect, test } from 'bun:test';
import { deriveContributors, executeGate, type ContributionEvent, type WorkPhase } from '../src/contributors.ts';

// Replays of real hand-offs. Phase-tagged rows are what new code writes; untagged rows are legacy.
const ev = (action: string, actor?: string, phase?: WorkPhase): ContributionEvent => ({ action, actor, phase });
const legacy = (action: string, actor?: string): ContributionEvent => ev(action, actor);

describe('deriveContributors', () => {
  test('A implements, B reviews and returns, A fixes, B reviews again: B never becomes an author', () => {
    const facts = deriveContributors([
      ev('claim', 'A', 'execute'), ev('checkpoint', 'A', 'execute'), ev('submit', 'A'),
      ev('claim', 'B', 'review'), ev('return', 'B'),
      ev('claim', 'A', 'execute'), ev('submit', 'A'),
      ev('claim', 'B', 'review'), ev('return', 'B'),
    ]);
    expect(facts.authors).toEqual(['A']);
    expect(facts.reviewers).toEqual(['B']);
    expect(facts.implementer).toBe('A');
    expect(facts.ambiguous).toBe(false);
    expect(facts.excluded).toEqual(['A']);
  });

  test('a review-only holder is a reviewer, not an author, and a fresh task has no implementer yet', () => {
    const facts = deriveContributors([ev('claim', 'R', 'review'), ev('checkpoint', 'R', 'review'), ev('return', 'R')]);
    expect(facts.authors).toEqual([]);
    expect(facts.reviewers).toEqual(['R']);
    expect(facts.implementer).toBeUndefined();
    expect(facts.ambiguous).toBe(false);
    expect(facts.excluded).toEqual([]);
  });

  test('an execute claim that was revoked before any submit still makes its holder the permanent author', () => {
    const facts = deriveContributors([ev('claim', 'X', 'execute'), ev('released', 'X', 'execute'), ev('claim', 'Y', 'review')]);
    expect(facts.authors).toEqual(['X']);
    expect(facts.implementer).toBe('X');
    expect(facts.reviewers).toEqual(['Y']);
    expect(facts.excluded).toEqual(['X']);
  });

  test('a review-phase block or checkpoint never authors', () => {
    const facts = deriveContributors([ev('claim', 'R', 'review'), ev('block', 'R', 'review')]);
    expect(facts.authors).toEqual([]);
    expect(facts.reviewers).toEqual(['R']);
  });

  test('legacy rows take the phase of the same actor next decisive action', () => {
    const facts = deriveContributors([
      legacy('claim', 'A'), legacy('submit', 'A'),
      legacy('claim', 'B'), legacy('return', 'B'),
      legacy('claim', 'B'), legacy('submit', 'B'),
    ]);
    expect(facts.authors).toEqual(['A', 'B']);
    expect(facts.reviewers).toEqual([]);
    expect(facts.unknown).toEqual([]);
    expect(facts.ambiguous).toBe(true);
  });

  test('the 04195c93 history (three legacy authors, one fresh return cycle each) keeps all three excluded', () => {
    const facts = deriveContributors([
      legacy('claim', 'A'), legacy('submit', 'A'),
      legacy('claim', 'B'), legacy('return', 'B'), legacy('claim', 'B'), legacy('submit', 'B'),
      legacy('claim', 'C'), legacy('return', 'C'), legacy('claim', 'C'), legacy('submit', 'C'),
    ]);
    expect(facts.authors).toEqual(['A', 'B', 'C']);
    expect(facts.excluded).toEqual(['A', 'B', 'C']);
    expect(facts.implementer).toBeUndefined();
    expect(facts.ambiguous).toBe(true);
    expect(executeGate(facts)).toEqual({ implementer: undefined, unresolved: true });
  });

  test('legacy rows with no decisive follow-up are unknown and fail closed as authors', () => {
    const facts = deriveContributors([legacy('claim', 'X'), legacy('released', 'X')]);
    expect(facts.authors).toEqual(['X']);
    expect(facts.unknown.map(u => u.action)).toEqual(['claim', 'released']);
    expect(facts.unknown.every(u => u.actor === 'X' && u.reason.length > 0)).toBe(true);
    expect(facts.implementer).toBe('X');
  });

  test('an explicit implementer resolves ambiguity and stays excluded from review', () => {
    const facts = deriveContributors([
      legacy('claim', 'A'), legacy('submit', 'A'), legacy('claim', 'B'), legacy('submit', 'B'),
    ], 'B');
    expect(facts.implementer).toBe('B');
    expect(facts.ambiguous).toBe(false);
    expect(facts.excluded).toEqual(['A', 'B']);
  });

  test('a reviewer taken over as implementer is excluded from reviewing before it ever claims code', () => {
    const facts = deriveContributors([
      ev('claim', 'A', 'execute'), ev('submit', 'A'), ev('claim', 'R', 'review'), ev('return', 'R'),
    ], 'R');
    expect(facts.reviewers).toEqual([]);
    expect(facts.excluded).toEqual(['A', 'R']);
    expect(facts.implementer).toBe('R');
  });

  test('non-employee actors and non-contribution actions never create authors', () => {
    const facts = deriveContributors([
      { action: 'claim' }, { action: 'resume', actor: 'Z' }, { action: 'defer', actor: 'Z' }, { action: 'claim', actor: 'Z', phase: 'review' },
    ]);
    expect(facts.authors).toEqual([]);
    expect(facts.reviewers).toEqual(['Z']);
  });

  test('an explicit implementer that is blank is treated as absent', () => {
    expect(deriveContributors([], '').implementer).toBeUndefined();
  });
});
