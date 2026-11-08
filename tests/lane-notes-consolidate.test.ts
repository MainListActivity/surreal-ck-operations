import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noteSimilarity, type LaneNote } from '../src/lane-notes.ts';
import { CONSOLIDATION_INTERVAL_MS, NOTE_MERGE_SIMILARITY, NOTE_SOFT_TARGET, planLane } from '../src/lane-notes-consolidate.ts';
import { A, B, C, DISTINCT, UNRELATED } from './support/lane-note-fixtures.ts';

const note = (id: string, text: string, day: number, extra: Partial<LaneNote> = {}): LaneNote => {
  const at = new Date(Date.UTC(2026, 0, day)).toISOString();
  return { id, lane: 'test:qa', text, state: 'active', author: 'owner:test', pinned: false, createdAt: at, updatedAt: at, ...extra };
};

test('the consolidation constants match the agreed rules', () => {
  expect(NOTE_MERGE_SIMILARITY).toBe(0.5);
  expect(NOTE_SOFT_TARGET).toBe(20);
  expect(CONSOLIDATION_INTERVAL_MS).toBe(24 * 3_600_000);
});

test('the fixtures are what the rules assume: restatements merge, distinct notes do not', () => {
  for (const [left, right] of [[A, B], [B, C], [A, C]] as const) expect(noteSimilarity(left, right)).toBeGreaterThanOrEqual(NOTE_MERGE_SIMILARITY);
  for (const text of DISTINCT) for (const other of DISTINCT) if (text !== other) expect(noteSimilarity(text, other)).toBeLessThan(NOTE_MERGE_SIMILARITY);
});

test('restatements form one cluster around the newest note; the others merge into it', () => {
  const plan = planLane('test:qa', [note('a', A, 1), note('b', B, 2), note('c', C, 3), note('d', UNRELATED, 4)]);
  expect(plan.clusters.map(cluster => [cluster.keeper.id, cluster.members.map(member => member.id)])).toEqual([['c', ['b', 'a']]]);
  expect(plan.aged).toEqual([]);
});

test('merging is transitive: a chain of similar neighbours joins notes that are not similar to each other', () => {
  // Characters 0-11, 3-14 and 6-17 of one sequence: neighbours share 8 of 11 bigrams, the outer two only 5.
  const chars = [...'甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未'];
  const [x, y, z] = [chars.slice(0, 12), chars.slice(3, 15), chars.slice(6, 18)].map(part => part.join(''));
  expect(noteSimilarity(x!, y!)).toBeGreaterThanOrEqual(NOTE_MERGE_SIMILARITY);
  expect(noteSimilarity(y!, z!)).toBeGreaterThanOrEqual(NOTE_MERGE_SIMILARITY);
  expect(noteSimilarity(x!, z!)).toBeLessThan(NOTE_MERGE_SIMILARITY);
  const plan = planLane('test:qa', [note('x', x!, 1), note('y', y!, 2), note('z', z!, 3)]);
  expect(plan.clusters).toHaveLength(1);
  expect(plan.clusters[0]!.keeper.id).toBe('z');
  expect(plan.clusters[0]!.members.map(member => member.id)).toEqual(['y', 'x']);
});

test('pinned notes never merge, and they are never aged out even when they are the oldest', () => {
  const pinned = note('p', A, 1, { pinned: true });
  const free = note('n', C, 3);
  expect(planLane('test:qa', [pinned, free]).clusters).toEqual([]);
  const crowded = [pinned, note('q', DISTINCT[1]!, 2, { pinned: true }), ...DISTINCT.slice(2, 21).map((text, i) => note(`f${i}`, text, 3 + i))];
  const plan = planLane('test:qa', crowded);
  expect(plan.pinned).toBe(2);
  expect(plan.aged.map(item => item.id)).toEqual(['f0']);
});

test('past the target the oldest unpinned survivors age out, and pinned notes count toward the target', () => {
  const plan = planLane('test:qa', DISTINCT.map((text, i) => note(`d${i}`, text, i + 1)));
  expect(plan.active).toBe(DISTINCT.length);
  expect(plan.aged.map(item => item.id)).toEqual(['d0', 'd1', 'd2', 'd3']);
  // 24 active notes, target 20: four age out. A lower target removes more, and the target is a parameter.
  expect(planLane('test:qa', DISTINCT.map((text, i) => note(`d${i}`, text, i + 1)), 22).aged).toHaveLength(2);
});

test('merged members leave the lane before the target is applied, so a merge can prevent aging', () => {
  const merged = [note('a', A, 1), note('b', B, 2), note('c', C, 3)];
  const others = DISTINCT.slice(0, 18).map((text, i) => note(`o${i}`, text, 4 + i));
  const plan = planLane('test:qa', [...merged, ...others]);
  expect(plan.active).toBe(21);
  expect(plan.clusters[0]!.members).toHaveLength(2);
  expect(plan.aged).toEqual([]);
});

test('the planner reads active notes only: proposed and removed notes are neither merged nor counted', () => {
  const plan = planLane('test:qa', [
    note('a', A, 1), note('b', B, 2, { state: 'proposed' }), note('c', C, 3, { state: 'removed' }),
  ]);
  expect(plan.active).toBe(1);
  expect(plan.clusters).toEqual([]);
});

test('the consolidation module reads only the database, so it can run inside a Cloudflare Worker', () => {
  const source = readFileSync(join(import.meta.dir, '../src/lane-notes-consolidate.ts'), 'utf8');
  expect(source).not.toContain('node:');
  expect(source).not.toMatch(/from ['"](fs|os|path)['"]/);
  expect(source).not.toMatch(/\brequire\(/);
});
