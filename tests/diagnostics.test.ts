import { expect, spyOn, test } from 'bun:test';
import { RecordId } from 'surrealdb';
import { SurrealCompanyCore } from '../src/core.ts';
import type { CompanyDatabase } from '../src/database.ts';
import { DispatchTimings } from '../src/diagnostics.ts';

test('real authentication path preserves concurrent results, revocation and errors without logging secrets', async () => {
  const credential = 'sck_synthetic-private-credential';
  const failure = new Error('synthetic-private-query-error');
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => { output.push(line); });
  let mode: 'pending' | 'revoked' | 'failure' = 'pending';
  const pending: Array<(value: unknown[][]) => void> = [];
  const database = { db: { query: () => {
    if (mode === 'failure') return Promise.reject(failure);
    if (mode === 'revoked') return Promise.resolve([[{ revoked: true }]]);
    return new Promise<unknown[][]>(resolve => { pending.push(resolve); });
  } } } as unknown as CompanyDatabase;
  const core = new SurrealCompanyCore(database);
  try {
    const a = core.authenticate(credential), b = core.authenticate(credential);
    const row = { id: new RecordId('employee', 'fixture'), role: 'qa', capabilities: ['execute'] };
    for (const resolve of pending) resolve([[row]]);
    expect(await a).toMatchObject({ employeeId: 'fixture', role: 'qa' });
    expect(await b).toMatchObject({ employeeId: 'fixture', role: 'qa' });
    expect(output.some(line => line.includes('concurrentAtStart=2'))).toBe(true);
    mode = 'failure'; await expect(core.authenticate(credential)).rejects.toBe(failure);
    expect(output.at(-1)).toContain('queryOk=false');
    mode = 'revoked'; await expect(core.authenticate(credential)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(output.at(-1)).toContain('concurrentAtStart=1');
    expect(output.join('\n')).not.toContain(credential);
    expect(output.join('\n')).not.toContain(failure.message);
    expect(output.join('\n')).not.toContain('SELECT');
  } finally { log.mockRestore(); }
});

test('dispatch diagnostics attribute a slow stage and propagate its original failure without error content', async () => {
  let clock = 0;
  const timing = new DispatchTimings(() => clock);
  await timing.measure('quota', async () => { clock += 12; });
  const failure = new Error('private-provider-response');
  await expect(timing.measure('tick', async () => { clock += 20000; throw failure; })).rejects.toBe(failure);
  expect(timing.summary()).toEqual({ totalMs: 20012, stagesMs: { quota: 12, tick: 20000 }, ok: false, failedStage: 'tick' });
  expect(JSON.stringify(timing.summary())).not.toContain(failure.message);
});
