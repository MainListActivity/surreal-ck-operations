// SYS-DISP 876e36e2 H1: the startup reaper's keep/reap decisions, exercised through its exported interface with an
// injected liveness probe and a scripted ledger. The real SurrealDB behaviour (row states, audit row, drain effect)
// is covered by tests/dispatch-pause.fork.test.ts; this file pins the fail-closed decision table without a database.
import { expect, test } from 'bun:test';
import process from 'node:process';
import { RecordId, type Surreal } from 'surrealdb';
import { processAlive, reapStaleRunningPasses } from '../src/dispatch-pause.ts';

const HOST = 'reap-test-host';

/** Scripted ledger: responses shaped exactly like the driver's per-statement list (what run() consumes). */
function ledger(rows: Array<{ id: RecordId; instance?: string }>, mode: 'ok' | 'failRead' | 'failWrite' = 'ok') {
  const writes: Array<{ query: string; vars: Record<string, unknown> }> = [];
  const db = {
    query(query: string, vars: Record<string, unknown>) {
      return {
        responses: async () => {
          if (mode === 'failRead') return [{ success: false, error: { message: 'ledger read failed on purpose' } }];
          if (query.includes("SELECT id, instance FROM dispatch_pass")) return [{ success: true, result: rows }];
          writes.push({ query, vars });
          if (mode === 'failWrite') return [{ success: false, error: { message: 'write conflict on purpose' } }];
          return [{ success: true, result: null }];
        },
      };
    },
  } as unknown as Surreal;
  return { db, writes };
}

const row = (instance: string | undefined, n: number) => ({ id: new RecordId('dispatch_pass', `p${n}`), instance });

test('processAlive: own pid and pid 1 answer, a huge pid is provably dead, junk pids fail closed', () => {
  expect(processAlive(process.pid)).toBe(true);
  expect(processAlive(1)).toBe(true); // root-owned: EPERM here means "exists", never death
  expect(processAlive(1_000_000)).toBe(false); // beyond the pid space: ESRCH is a death proof
  for (const junk of [0, -5, 1.5, NaN, Infinity]) expect(processAlive(junk)).toBe(true);
});

test('same-host row with a provably dead pid is reaped: abandoned in one audited transaction, nothing deleted', async () => {
  const instance = `${HOST}:4242:dead01`;
  const { db, writes } = ledger([row(instance, 1)]);
  const summary = await reapStaleRunningPasses(db, HOST, () => false, 9999);
  expect(summary).toMatchObject({ scanned: 1, reaped: 1, keptUnknown: 0 });
  expect(summary.reapedIds).toEqual(['dispatch_pass:p1']);
  expect(writes).toHaveLength(1);
  const txn = writes[0]!.query;
  expect(txn).toContain("UPDATE ONLY $pass SET state = 'abandoned'");
  expect(txn).toContain("WHERE state = 'running'"); // a pass that ended in between aborts instead of a false audit
  expect(txn).toContain("action: 'dispatch_pass_reaped'");
  expect(txn).toContain('COMMIT');
  expect(writes[0]!.vars).toMatchObject({ instance });
  expect(String((writes[0]!.vars as { evidence: string }).evidence)).toContain('dispatcher startup reap');
});

test('the reap never touches: foreign host, live pid, own pid, malformed instances', async () => {
  const cases = [
    row('other-host:4242:abcd', 1),            // different host: not ours to judge
    row(`${HOST}:4242:abcd2`, 2),              // answers the probe (same pid as the live check): alive
    row(`${HOST}:9999:abcd`, 3),               // this exact pid is our own process
    row(`${HOST}:4244`, 4),                    // two parts only: no uuid, shape unrecognised
    row(`${HOST}:4245:a:b`, 5),                // four parts: unrecognised
    row(`${HOST}:notapid:abcd`, 6),            // pid not a number
    row(`${HOST}:0:abcd`, 7),                  // pid 0
    row(`${HOST}:-1:abcd`, 8),                 // negative pid
    row(undefined, 9),                         // instance missing entirely
    row('', 10),                               // instance empty
  ];
  const { db, writes } = ledger(cases);
  const summary = await reapStaleRunningPasses(db, HOST, pid => pid === 4242, 9999);
  expect(summary).toMatchObject({ scanned: 10, reaped: 0, keptUnknown: 10, reapedIds: [] });
  expect(writes).toHaveLength(0);
});

test('ledger read failure: scanned reports -1, nothing is written, every row stays running (fail closed)', async () => {
  const { db, writes } = ledger([row(`${HOST}:4242:abcd`, 1)], 'failRead');
  const summary = await reapStaleRunningPasses(db, HOST, () => false, 9999);
  expect(summary).toMatchObject({ scanned: -1, reaped: 0, keptUnknown: 0, reapedIds: [] });
  expect(writes).toHaveLength(0);
});

test('write failure on one row does not stop the scan and never counts that row as reaped', async () => {
  const rows = [row(`${HOST}:4242:a1`, 1), row(`${HOST}:4243:a2`, 2)];
  const writes: unknown[] = [];
  const db = {
    query(query: string, vars: Record<string, unknown>) {
      return {
        responses: async () => {
          if (query.includes("SELECT id, instance FROM dispatch_pass")) return [{ success: true, result: rows }];
          writes.push(vars);
          return [{ success: false, error: { message: 'write conflict on purpose' } }];
        },
      };
    },
  } as unknown as Surreal;
  const summary = await reapStaleRunningPasses(db, HOST, () => false, 9999);
  expect(summary).toMatchObject({ scanned: 2, reaped: 0, keptUnknown: 2, reapedIds: [] });
  expect(writes).toHaveLength(2); // both rows attempted, both failed, both left running
});
