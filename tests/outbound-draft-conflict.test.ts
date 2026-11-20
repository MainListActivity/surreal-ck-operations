import { expect, test } from 'bun:test';
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from '../src/core-errors.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';

const draft = (db: Surreal) => new OutboundMessageStore(db).createDraft('fixture', 'execute', 'engineering', false, 'doing', 'fixture body');

for (const message of ['draft already open', 'The query was not executed due to a failed transaction',
  'Cannot COMMIT: Transaction conflict: Transaction write conflict', 'Quota admission conflicted with another transaction']) {
  test(`draft creation maps ${message} to a draft conflict`, async () => {
    const db = { query: async () => { throw new Error(message); } } as unknown as Surreal;
    await expect(draft(db)).rejects.toMatchObject({ code: 'conflict', message: 'draft already open' });
  });
}

test('draft creation preserves an unrelated quota refusal', async () => {
  const error = new Error('Quota admission denied: capacity exhausted');
  const db = { query: async () => { throw error; } } as unknown as Surreal;
  await expect(draft(db)).rejects.toBe(error);
});

test('draft creation returns the stored draft', async () => {
  let calls = 0;
  const db = { query: async () => ++calls === 1 ? [] : [[{
    id: new RecordId('outbound_message', 'stored'), task: new RecordId('task', 'fixture'),
    step: 'execute', role: 'engineering', body: 'fixture body', state: 'draft', hold: false,
  }]] } as unknown as Surreal;
  expect(await draft(db)).toMatchObject({ id: 'stored', taskId: 'fixture', body: 'fixture body', state: 'draft' });
});

test('draft creation refuses an empty readback', async () => {
  const db = { query: async () => [[]] } as unknown as Surreal;
  await expect(draft(db)).rejects.toBeInstanceOf(CompanyError);
  await expect(draft(db)).rejects.toMatchObject({ code: 'conflict', message: 'draft creation lost' });
});
