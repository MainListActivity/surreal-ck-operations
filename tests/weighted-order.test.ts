import { expect, test } from 'bun:test';
import { effectiveWeight, weightedOrder, type EmployeeDef } from '../src/workforce.ts';

const def = (id: string, weight: number): EmployeeDef =>
  ({ id, role: 'engineering', provider: 'x', model: 'm', enabled: true, maxInstances: 1, priority: 100,
    weight, errorStreak: 0 });

test('weightedOrder picks in proportion to weights', () => {
  const items = ['a', 'b', 'c'];
  const weights: Record<string, number> = { a: 60, b: 25, c: 15 };
  const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
  // Deterministic coverage of the rand space.
  let rand = 0;
  const seq = () => (rand = (rand + 0.01) % 1);
  for (let i = 0; i < 1000; i++) counts[weightedOrder(items, i => weights[i], seq)[0]]++;
  expect(counts.a).toBeGreaterThan(counts.b);
  expect(counts.b).toBeGreaterThan(counts.c);
  expect(counts.a).toBeGreaterThan(500);
  expect(counts.c).toBeLessThan(250);
  // Ordering without replacement returns every item exactly once.
  const order = weightedOrder(items, i => weights[i], () => 0.5);
  expect(order.sort()).toEqual(['a', 'b', 'c']);
});

test('weightedOrder: weight 0 is never picked while a positive weight exists', () => {
  const items = ['zero', 'one'];
  for (const r of [0, 0.25, 0.5, 0.999]) {
    expect(weightedOrder(items, i => (i === 'zero' ? 0 : 1), () => r)[0]).toBe('one');
  }
  // All-zero weights fall back to uniform selection.
  expect(weightedOrder(['x', 'y'], () => 0, () => 0)).toEqual(['x', 'y']);
});

test('effectiveWeight is the configured weight, floored at 0', () => {
  expect(effectiveWeight(def('d1', 60))).toBe(60);
  expect(effectiveWeight(def('d2', 0))).toBe(0);              // 0 = never picked on its own
  expect(effectiveWeight(def('d3', -5))).toBe(0);             // negative weights are clamped
  expect(effectiveWeight(undefined)).toBe(10);                // unknown def: default weight
});
