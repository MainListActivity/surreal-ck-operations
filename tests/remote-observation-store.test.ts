// The broker keeps its own record of each remote observation for window checks. The record count is capped,
// and the oldest record is evicted first. A candidate whose record was evicted is refused as observation-untrusted.
import { expect, test } from 'bun:test';
import { REMOTE_OBSERVATION_LIMIT, OpsBroker } from '../src/ops/broker.ts';

// Drives the broker's own store through its private method, so the test checks the real eviction path.
function storeOf(broker: OpsBroker) {
  return (broker as unknown as { remoteObservations: Map<string, unknown>; rememberRemoteObservation(d: string, r: unknown): void });
}
const record = (n: number) => ({ observation: { observationSnapshot: { digest: String(n) } } as never, author: 'engineering-1' });

test('the remote observation store never holds more than the cap, and evicts the oldest first', () => {
  const broker = new OpsBroker({ core: {} as never, projects: {} as never, secretKey: () => Buffer.alloc(32), serviceHome: '/tmp/unused' } as never);
  const s = storeOf(broker);
  const total = REMOTE_OBSERVATION_LIMIT + 5;
  for (let n = 0; n < total; n++) s.rememberRemoteObservation(`d${n}`, record(n));
  expect(s.remoteObservations.size).toBe(REMOTE_OBSERVATION_LIMIT);
  // The five oldest are gone, the newest is kept.
  for (let n = 0; n < 5; n++) expect(s.remoteObservations.has(`d${n}`)).toBe(false);
  expect(s.remoteObservations.has(`d${total - 1}`)).toBe(true);
});

test('re-remembering a digest refreshes its position instead of duplicating it', () => {
  const broker = new OpsBroker({ core: {} as never, projects: {} as never, secretKey: () => Buffer.alloc(32), serviceHome: '/tmp/unused' } as never);
  const s = storeOf(broker);
  for (let n = 0; n < REMOTE_OBSERVATION_LIMIT; n++) s.rememberRemoteObservation(`d${n}`, record(n));
  // Touch the oldest, then add one more: the touched digest must survive and the next-oldest is evicted.
  s.rememberRemoteObservation('d0', record(0));
  s.rememberRemoteObservation('new', record(999));
  expect(s.remoteObservations.size).toBe(REMOTE_OBSERVATION_LIMIT);
  expect(s.remoteObservations.has('d0')).toBe(true);
  expect(s.remoteObservations.has('d1')).toBe(false);
});
