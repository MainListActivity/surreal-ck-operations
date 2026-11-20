import { expect, mock, test } from 'bun:test';
import type { Surreal } from 'surrealdb';
import { SnapshotStore } from '../src/snapshot-store.ts';

const failed = (message: string) => ({ success: false, error: new Error(message) });
const succeeded = { success: true, result: [], stats: {} };

function fixture(batches: unknown[][]) {
  const responses = mock(async () => batches.shift() ?? []);
  const db = { query: () => ({ responses }) } as unknown as Surreal;
  const store = new SnapshotStore(db);
  return { run: () => store['transact'](db, 'BEGIN; COMMIT;', {}), responses };
}

test('snapshot transaction accepts successful and empty responses', async () => {
  for (const batch of [[succeeded], []]) {
    const f = fixture([batch]);
    expect(await f.run()).toEqual({ outcome: 'done' });
    expect(f.responses).toHaveBeenCalledTimes(1);
  }
});

test('snapshot transaction retries a 4.0 conflict reported only by COMMIT', async () => {
  const f = fixture([
    [failed('The query was not executed due to a failed transaction'),
      failed('Cannot COMMIT: Transaction conflict: Write conflict, retry the transaction. This transaction can be retried')],
    [succeeded],
  ]);
  expect(await f.run()).toEqual({ outcome: 'done' });
  expect(f.responses).toHaveBeenCalledTimes(2);
});

test('snapshot transaction preserves a statement refusal before COMMIT', async () => {
  const f = fixture([[failed('snapshot write refused'), failed('Cannot COMMIT: transaction failed')]]);
  expect(await f.run()).toEqual({ outcome: 'refused' });
  expect(f.responses).toHaveBeenCalledTimes(1);
});

test('snapshot transaction does not retry an unrelated COMMIT error', async () => {
  const f = fixture([[failed('Cannot COMMIT: storage unavailable')]]);
  await expect(f.run()).rejects.toMatchObject({ code: 'temporarily_unavailable' });
  expect(f.responses).toHaveBeenCalledTimes(1);
});
