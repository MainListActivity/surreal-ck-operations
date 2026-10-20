// SYS01 R4: cross-process quota checks for the stored-listing store, on the company fork started by
// scripts/test-worktrees.ts. The capacity record query_snapshot_quota:global is shared through the database, and every
// writer here is a separate OS process (tests/snapshot-quota.child.ts) with its own connection, plus the test process.
// Each test gets its own fresh namespace, so the global quota starts empty and no other test file is affected.
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RecordId, type Surreal } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { CompanyError } from '../src/core-errors.ts';
import {
  DEFAULT_SNAPSHOT_LIMITS, SnapshotStore, type SnapshotLimits, type SnapshotHeader, type SnapshotReservation, type SnapshotStoreOptions,
} from '../src/snapshot-store.ts';
import type { ChildJob } from './snapshot-quota.child.ts';

setDefaultTimeout(60_000);

const CHILD = join(import.meta.dir, 'snapshot-quota.child.ts');
const DATABASE = 'snapshot_quota';
const TAKEN_AT = '2026-01-01T00:00:00.000Z';
const KB = 1024;
const suffix = randomUUID().slice(0, 8);
let seq = 0;

type BeginInput = Parameters<SnapshotStore['begin']>[0];
type Settled<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
type Batch<T> = { results: Settled<T>[]; window: { start: number; end: number } };
type Proc = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

const opened: CompanyDatabase[] = [];
const spawned: Proc[] = [];

/** One fresh namespace and database, bootstrapped by the normal company path (schema 001 to 022). */
async function fresh(limits: Partial<SnapshotLimits> = {}, options: SnapshotStoreOptions = {}) {
  const namespace = `sck_snapq_${suffix}_${++seq}`;
  const db = new CompanyDatabase({ ...loadDatabaseConfig(), namespace, database: DATABASE });
  opened.push(db);
  await db.connect();
  await db.bootstrap();
  const store = new SnapshotStore(db.db, { reserveWaitMs: 10_000, ...limits }, options);
  return { namespace, db, store };
}

const at = (owner: string, extra: Partial<BeginInput> = {}): BeginInput => ({
  owner, kind: 'context', digest: `dig-${owner}`, role: 'gm', takenAt: TAKEN_AT, rows: 1, bytes: KB, ...extra,
});

const within = <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  })]).finally(() => clearTimeout(timer));
};

const settle = async <T>(work: () => Promise<T>): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, code: (error as CompanyError).code ?? 'error', message: (error as Error).message };
  }
};

/** Parent-side batch: the same concurrent fan-out a child runs, with its window in flight. */
async function batch<T, R>(items: T[], call: (item: T) => Promise<R>): Promise<Batch<R>> {
  const start = Date.now();
  const results = await Promise.all(items.map(item => settle(() => call(item))));
  return { results, window: { start, end: Date.now() } };
}

const oks = <T>(results: Settled<T>[]): T[] => results.flatMap(result => (result.ok ? [result.value] : []));
const fails = <T>(results: Settled<T>[]): Array<Extract<Settled<T>, { ok: false }>> =>
  results.flatMap(result => (result.ok ? [] : [result]));
const overlapping = (windows: Array<{ start: number; end: number }>): boolean =>
  windows.some((a, i) => windows.slice(i + 1).some(b => a.start <= b.end && b.start <= a.end));

/** Reads one line-prefixed message from a child's stdout; other lines (SDK logs) are skipped. */
function lineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return async (prefix: string): Promise<string> => {
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.startsWith(prefix)) return line.slice(prefix.length);
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(`child exited before ${prefix.trim()}`);
      buffered += decoder.decode(value, { stream: true });
    }
  };
}

async function stderrOf(procs: Proc[]): Promise<string> {
  for (const proc of procs) proc.kill('SIGKILL');
  return (await Promise.all(procs.map(proc => new Response(proc.stderr).text()))).join(' | ').slice(0, 800);
}

/**
 * Starts one child process per job on the given database. Each child connects, reports READY, and waits for its job.
 * Once every child is READY, all jobs are sent together, and `alongside` (the parent's own calls) starts at the same
 * moment. Returns each child's RESULT, the processes (a child that holds a reservation stays alive), and `alongside`.
 */
async function runChildren<T, A = undefined>(
  namespace: string, jobs: ChildJob[], alongside?: () => Promise<A>,
): Promise<{ values: T[]; procs: Proc[]; extra: A | undefined }> {
  const procs = jobs.map(() => Bun.spawn([process.execPath, CHILD, namespace, DATABASE], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: process.env,
  }));
  spawned.push(...procs);
  const readers = procs.map(proc => lineReader(proc.stdout));
  try {
    await Promise.all(readers.map(read => within(read('@@READY'), 20_000, 'child ready')));
    procs.forEach((proc, index) => {
      proc.stdin.write(`${JSON.stringify(jobs[index])}\n`);
      proc.stdin.flush();
    });
    const [values, extra] = await Promise.all([
      Promise.all(readers.map(read => within(read('@@RESULT '), 30_000, 'child result'))),
      alongside ? alongside() : Promise.resolve(undefined),
    ]);
    return { values: values.map(value => JSON.parse(value) as T), procs, extra: extra as A | undefined };
  } catch (error) {
    throw new Error(`${(error as Error).message}; child stderr: ${await stderrOf(procs)}`);
  }
}

async function ownerCount(db: CompanyDatabase, owner: string): Promise<number> {
  const [rows] = await db.db.query<[Array<{ n: number }>]>(
    'SELECT count() AS n FROM query_snapshot WHERE owner = $owner GROUP ALL;', { owner });
  return rows?.[0]?.n ?? 0;
}

const quotaOf = async (store: SnapshotStore) => {
  const acct = await store.accounting();
  return { listings: acct.listings, bytes: acct.bytes, rows: acct.rows, quotaListings: acct.quota.listings, quotaBytes: acct.quota.bytes };
};

/** A build connection whose statements first wait for `before`, so a test can slow a build down or hold one statement. */
const throughChannel = (db: Surreal, before: (sql: string) => Promise<void>): Surreal => new Proxy(db, {
  get(target, prop) {
    if (prop !== 'query') {
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    }
    return (sql: string, vars?: Record<string, unknown>) => ({
      then: (onOk: (value: unknown) => unknown, onFail?: (reason: unknown) => unknown) =>
        (async () => { await before(sql); return target.query(sql, vars); })().then(onOk, onFail),
      responses: async () => { await before(sql); return target.query(sql, vars).responses(); },
    });
  },
});

afterAll(async () => {
  for (const proc of spawned) {
    try { proc.kill('SIGKILL'); } catch { /* already exited */ }
  }
  for (const db of opened) {
    try { await db.db.query(`REMOVE NAMESPACE IF EXISTS ${db.config.namespace};`); } catch { /* best effort */ }
    await db.close();
  }
});

test('setup: bootstrap applies schema 022, creating the quota table and the installation at schema 22', async () => {
  const { db, store } = await fresh();
  const [info] = await db.db.query<[Record<string, unknown>]>('INFO FOR DB;');
  expect(Object.keys((info.tables ?? {}) as Record<string, string>)).toContain('query_snapshot_quota');
  const marker = await db.db.select<{ schema_version: number }>(new RecordId('company_meta', 'installation'));
  expect(marker?.schema_version).toBe(22);
  expect(await store.accounting()).toMatchObject({ listings: 0, bytes: 0, rows: 0, quota: { listings: 0, bytes: 0 } });
});

test('(a) 20 begins from three processes against maxListings 7 admit exactly 7 and the quota equals storage', async () => {
  const { namespace, store } = await fresh({ maxListings: 7, maxTotalBytes: 1024 * KB });
  const jobs: ChildJob[] = [0, 1].map(child => ({
    op: 'begin-all', limits: store.limits, inputs: Array.from({ length: 7 }, (_, i) => at(`a-c${child}-${i}`)),
  }));
  const parentInputs = Array.from({ length: 6 }, (_, i) => at(`a-p-${i}`));
  const { values, extra } = await runChildren<Batch<SnapshotReservation>, Batch<SnapshotReservation>>(
    namespace, jobs, () => batch(parentInputs, input => store.begin(input)));
  const batches = [...values, extra!];
  const calls = batches.flatMap(one => one.results);
  expect(calls.length).toBe(20);
  const admitted = oks(calls);
  const refused = fails(calls);
  expect(admitted.length).toBe(7);
  expect(refused.length).toBe(13);
  expect(refused.map(result => result.code)).toEqual(Array(13).fill('temporarily_unavailable'));
  expect(overlapping(batches.map(one => one.window))).toBe(true);

  const acct = await store.accounting();
  expect(acct.quota.listings).toBe(7);
  expect(acct.listings).toBe(7);
  expect(acct.quota.bytes).toBe(7 * KB);
  expect(acct.bytes).toBe(acct.quota.bytes);
  expect(acct.rows).toBe(0);
  expect(await store.census()).toEqual({ listings: 7, rows: 0 });

  const released = await Promise.all(admitted.map(reservation => store.release(reservation.id)));
  expect(released.filter(outcome => outcome === 'released').length).toBe(7);
  expect(await quotaOf(store)).toEqual({ listings: 0, bytes: 0, rows: 0, quotaListings: 0, quotaBytes: 0 });
});

test('(b) 20 concurrent reservations of 1 KiB across processes admit exactly the 10 KiB byte cap', async () => {
  const { namespace, store } = await fresh({ maxListings: 100, maxTotalBytes: 10 * KB });
  const jobs: ChildJob[] = [0, 1].map(child => ({
    op: 'begin-all', limits: store.limits, inputs: Array.from({ length: 8 }, (_, i) => at(`b-c${child}-${i}`)),
  }));
  const parentInputs = Array.from({ length: 4 }, (_, i) => at(`b-p-${i}`));
  const { values, extra } = await runChildren<Batch<SnapshotReservation>, Batch<SnapshotReservation>>(
    namespace, jobs, () => batch(parentInputs, input => store.begin(input)));
  const calls = [...values, extra!].flatMap(one => one.results);
  expect(calls.length).toBe(20);
  const admitted = oks(calls);
  expect(admitted.length).toBe(10);
  expect(fails(calls).map(result => result.code)).toEqual(Array(10).fill('temporarily_unavailable'));

  const acct = await store.accounting();
  expect(acct.quota.bytes).toBe(10 * KB);
  expect(acct.quota.bytes).toBeLessThanOrEqual(10 * KB);
  expect(acct.bytes).toBe(acct.quota.bytes);
  expect(acct.quota.listings).toBe(10);
  expect(acct.listings).toBe(10);

  await Promise.all(admitted.map(reservation => store.release(reservation.id)));
  expect(await quotaOf(store)).toEqual({ listings: 0, bytes: 0, rows: 0, quotaListings: 0, quotaBytes: 0 });
});

test('(c) per-owner cap holds under concurrent creates from three processes: at most 4 listings, evicted ones read snapshot_gone, a listing being written is never evicted', async () => {
  const { namespace, db, store } = await fresh({ maxPerOwner: 4, maxListings: 100, maxTotalBytes: 1024 * KB });
  const owner = 'c-owner';
  const shape = { owner, kind: 'context' as const, digest: 'dig-c', role: 'gm', takenAt: TAKEN_AT };
  // One listing of this owner is still being written (reserved, not committed) while the creates run.
  // The listing's rows are written in one call below; a second call on the same listing is covered by test (h).
  const writing = await store.begin({ ...shape, rows: 2, bytes: 6 });

  const jobs: ChildJob[] = [0, 1, 2].map(child => ({
    op: 'create-all', limits: store.limits,
    inputs: Array.from({ length: 3 }, (_, i) => ({ ...shape, bodies: [`p${child}-${i}`] })),
  }));
  const { values } = await runChildren<Batch<SnapshotHeader>>(namespace, jobs);
  const created = values.flatMap(one => one.results);
  expect(fails(created)).toEqual([]);
  const ids = oks(created).map(header => header.id);
  expect(ids.length).toBe(9);

  // Held: the writing listing plus the three newest committed ones.
  expect(await ownerCount(db, owner)).toBe(4);
  let survivors = 0;
  let gone = 0;
  for (const id of ids) {
    try {
      await store.read({ id, owner, kind: 'context', digest: shape.digest, role: 'gm', after: 0, limit: 10 });
      survivors++;
    } catch (error) {
      expect((error as CompanyError).code).toBe('snapshot_gone');
      gone++;
    }
  }
  expect(survivors).toBe(3);
  expect(gone).toBe(6);

  // The writing listing was never evicted: its rows are intact and it commits once its last row is written.
  await store.writeRows(writing, ['abc', 'def']);
  await store.commit(writing);
  const back = await store.read({ id: writing.id, owner, kind: 'context', digest: shape.digest, role: 'gm', after: 0, limit: 10 });
  expect(back.rows.map(row => row.body)).toEqual(['abc', 'def']);
  expect(await ownerCount(db, owner)).toBe(4);
  expect(await quotaOf(store)).toEqual({
    listings: 4, bytes: 6 + 3 * 4, rows: 2 + 3, quotaListings: 4, quotaBytes: 6 + 3 * 4,
  });
});

test('(d) rows above maxRows and bytes above maxBytes are refused as response_too_large and leave accounting unchanged', async () => {
  const { namespace, store } = await fresh({ maxRows: 3, maxBytes: 8 });
  const before = await store.accounting();
  const beforeTotals = await quotaOf(store);
  const { values } = await runChildren<Batch<SnapshotReservation> | Batch<SnapshotHeader>>(namespace, [
    { op: 'begin-all', limits: store.limits, inputs: [at('d-rows', { rows: 4, bytes: 4 }), at('d-bytes', { rows: 1, bytes: 9 })] },
    {
      op: 'create-all', limits: store.limits,
      inputs: [{ owner: 'd-create', kind: 'context', digest: 'dig-d', role: 'gm', takenAt: TAKEN_AT, bodies: ['a', 'b', 'c', 'd'] }],
    },
  ]);
  const [beginBatch, createBatch] = values as Array<Batch<SnapshotReservation>>;
  expect(beginBatch!.results.map(result => (result.ok ? 'ok' : result.code)))
    .toEqual(['response_too_large', 'response_too_large']);
  expect((createBatch as unknown as Batch<SnapshotHeader>).results.map(result => (result.ok ? 'ok' : result.code)))
    .toEqual(['response_too_large']);
  // Refusals write nothing: the totals and the quota version are as they were.
  const afterRefusals = await store.accounting();
  expect(afterRefusals.quota.version).toBe(before.quota.version);
  expect(await quotaOf(store)).toEqual(beforeTotals);

  // The limits are inclusive: a listing of exactly maxRows rows and maxBytes bytes is admitted.
  const { values: edge } = await runChildren<Batch<SnapshotReservation>>(namespace, [
    { op: 'begin-all', limits: store.limits, inputs: [at('d-edge', { rows: 3, bytes: 8 })] },
  ]);
  const [edgeResult] = oks(edge[0]!.results);
  expect(edgeResult).toBeDefined();
  expect(await quotaOf(store)).toEqual({ ...beforeTotals, listings: 1, bytes: 8, quotaListings: 1, quotaBytes: 8 });
  await store.release(edgeResult!.id);
  expect(await quotaOf(store)).toEqual(beforeTotals);
});

test('(e) a writeRows failure releases the reserved room: accounting is unchanged and a full-cap reservation fits again', async () => {
  const { namespace, db, store } = await fresh({ maxTotalBytes: 5 });
  const before = await quotaOf(store);
  const { values: [outcome] } = await runChildren<{ id: string; write: string; released: string }>(namespace, [
    { op: 'write-fail', limits: store.limits, input: at('e-owner', { rows: 1, bytes: 5 }), body: '123456789' },
  ]);
  expect(outcome!.write).toBe('temporarily_unavailable');
  expect(outcome!.released).toBe('released');
  expect(await quotaOf(store)).toEqual(before);
  expect(await store.census()).toEqual({ listings: 0, rows: 0 });
  expect(await db.db.select(new RecordId('query_snapshot', outcome!.id))).toBeFalsy();

  // The room is free: a reservation of the whole 5-byte cap is admitted, and only after it is released does the cap refill.
  const fit = await store.begin(at('e-after', { rows: 1, bytes: 5 }));
  await expect(store.begin(at('e-full', { rows: 1, bytes: 1 }))).rejects.toMatchObject({ code: 'temporarily_unavailable' });
  expect(await store.release(fit.id)).toBe('released');
  expect(await quotaOf(store)).toEqual(before);
});

test('(f) a writer SIGKILLed before commit keeps its room until sweep removes the listing and its rows', async () => {
  const { namespace, store } = await fresh();
  const baseline = await quotaOf(store);
  const { values: [held], procs } = await runChildren<{ id: string; rows: number; bytes: number }>(namespace, [
    { op: 'hold', limits: store.limits, input: at('f-owner', { rows: 3, bytes: 30 }), bodies: ['0123456789'] },
  ]);
  expect(held!.rows).toBe(3);
  expect(held!.bytes).toBe(30);
  expect(await quotaOf(store)).toEqual({ ...baseline, listings: 1, bytes: 30, rows: 1, quotaListings: 1, quotaBytes: 30 });

  procs[0]!.kill('SIGKILL');
  await procs[0]!.exited;
  expect(procs[0]!.signalCode).toBe('SIGKILL');

  // Still inside the build timeout: nothing is swept and the room stays held.
  const held2 = await quotaOf(store);
  expect(await store.sweep(Date.now())).toBe(0);
  expect(await quotaOf(store)).toEqual(held2);
  expect(held2.quotaBytes).toBe(30);

  const removed = await store.sweep(Date.now() + store.limits.buildTimeoutMs + 1);
  expect(removed).toBe(1);
  expect(await quotaOf(store)).toEqual(baseline);
  expect(await store.census()).toEqual({ listings: 0, rows: 0 });
});

test('(g) two processes releasing the same listing at the same time free it exactly once', async () => {
  const { namespace, store } = await fresh();
  const header = await store.create({ owner: 'g-owner', kind: 'context', digest: 'dig-g', role: 'gm', takenAt: TAKEN_AT, bodies: ['abcdefg'] });
  expect(await quotaOf(store)).toEqual({ listings: 1, bytes: 7, rows: 1, quotaListings: 1, quotaBytes: 7 });

  const { values } = await runChildren<Batch<'released' | 'absent'>>(namespace, [0, 1].map(() => ({
    op: 'release-all', limits: store.limits, ids: [header.id],
  })));
  const outcomes = values.map(one => one.results[0]!).map(result => (result.ok ? result.value : result.code)).sort();
  expect(outcomes).toEqual(['absent', 'released']);
  expect(await quotaOf(store)).toEqual({ listings: 0, bytes: 0, rows: 0, quotaListings: 0, quotaBytes: 0 });

  // A later release from this process finds nothing and subtracts nothing.
  expect(await store.release(header.id)).toBe('absent');
  expect(await quotaOf(store)).toEqual({ listings: 0, bytes: 0, rows: 0, quotaListings: 0, quotaBytes: 0 });
});

test('(h) writeRows numbers rows across calls and batches, and a write past the reserved bytes is refused and writes nothing', async () => {
  const { store } = await fresh();
  const big = 'x'.repeat(300 * KB);
  const first = await store.begin(at('h-owner', { rows: 4, bytes: 6 + 2 * 300 * KB }));
  await store.writeRows(first, ['abc']);
  // Two 300 KiB bodies do not fit one 512 KiB batch, so this second call runs in two transactions.
  await store.writeRows(first, ['def', big, big]);
  await store.commit(first);
  const back = await store.read({ id: first.id, owner: 'h-owner', kind: 'context', digest: 'dig-h-owner', role: 'gm', after: 0, limit: 10 });
  expect(back.rows.map(row => row.seq)).toEqual([1, 2, 3, 4]);
  expect(back.rows.map(row => row.body)).toEqual(['abc', 'def', big, big]);

  // A write that would pass the reserved bytes is refused, and the reservation keeps the rows it already had.
  const small = await store.begin(at('h-small', { rows: 1, bytes: 2 }));
  await expect(store.writeRows(small, ['abc'])).rejects.toMatchObject({ code: 'temporarily_unavailable' });
  expect(await store.release(small.id)).toBe('released');
  const held = { listings: 1, bytes: 6 + 2 * 300 * KB, rows: 4, quotaListings: 1, quotaBytes: 6 + 2 * 300 * KB };
  expect(await quotaOf(store)).toEqual(held);
  expect(await store.release(first.id)).toBe('released');
  expect(await quotaOf(store)).toEqual({ listings: 0, bytes: 0, rows: 0, quotaListings: 0, quotaBytes: 0 });
});

test('(i) an expired listing is released by the sweep that finds it, exactly once, and its cursors then read snapshot_gone', async () => {
  const { store } = await fresh({ ttlMs: 1_000 });
  const now = Date.now();
  const header = await store.create({ owner: 'i-owner', kind: 'context', digest: 'dig-i', role: 'gm', takenAt: TAKEN_AT, bodies: ['abc'] }, now);
  expect(await store.sweep(now + 999)).toBe(0);
  expect(await store.sweep(now + 1_000)).toBe(1);
  expect(await store.sweep(now + 1_000)).toBe(0);
  expect(await quotaOf(store)).toEqual({ listings: 0, bytes: 0, rows: 0, quotaListings: 0, quotaBytes: 0 });
  await expect(store.read({ id: header.id, owner: 'i-owner', kind: 'context', digest: 'dig-i', role: 'gm', after: 0, limit: 10 }, now + 1_000))
    .rejects.toMatchObject({ code: 'snapshot_gone' });
});

test('(j) a build past its deadline is cancelled: no statement starts after it, nothing is kept, the room is released, and the store builds again', async () => {
  const holder: { db?: Surreal } = {};
  const statements: string[] = [];
  const observed: Array<{ outcome: string }> = [];
  let slow = true;
  let aborts = 0;
  const { db, store } = await fresh({ buildDeadlineMs: 2_000, batchBytes: 4 * KB }, {
    channel: {
      connection: async () => throughChannel(holder.db!, async sql => {
        statements.push(sql);
        if (slow) await Bun.sleep(250);
      }),
      abort: async () => { aborts++; },
    },
    observe: stats => observed.push(stats),
  });
  holder.db = db.db;
  const baseline = await quotaOf(store);
  // Twenty batches of four 1 KiB rows, about five seconds of statements: the 2-second deadline falls in the middle of the writes.
  const bodies = Array.from({ length: 80 }, (_, index) => `${index}`.padEnd(KB, 'x'));
  const started = performance.now();
  const error = await store.build({
    owner: 'j-owner', kind: 'context', digest: 'dig-j', role: 'gm', guidance: 'narrow the query', load: async () => ({ takenAt: TAKEN_AT, bodies }),
  }).then(() => undefined, (reason: unknown) => reason);
  const elapsed = performance.now() - started;
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe('temporarily_unavailable');
  expect((error as CompanyError).retryable).toBe(true);
  expect((error as CompanyError).message).toMatch(/not built within 2 seconds, so it was cancelled and nothing was kept; narrow the query, then retry/);
  expect(elapsed).toBeLessThan(4_000);
  const writes = statements.filter(sql => sql.includes('INSERT INTO query_snapshot_row')).length;
  expect(writes).toBeGreaterThan(0);
  expect(writes).toBeLessThan(20);
  expect(observed.at(-1)).toMatchObject({ outcome: 'timed_out' });
  // Nothing starts once the build has given up. The statement in flight finished within the cleanup wait, so the channel was kept.
  const atGiveUp = statements.length;
  await Bun.sleep(600);
  expect(statements.length).toBe(atGiveUp);
  expect(aborts).toBe(0);
  expect(await store.census()).toEqual({ listings: 0, rows: 0 });
  expect(await quotaOf(store)).toEqual(baseline);

  slow = false;
  const header = await store.create({ owner: 'j-owner', kind: 'context', digest: 'dig-j-again', role: 'gm', takenAt: TAKEN_AT, bodies: ['again'] });
  expect(header.rows).toBe(1);
  expect(await store.release(header.id)).toBe('released');
  expect(await quotaOf(store)).toEqual(baseline);
});

test('(k) a statement still in flight after the cleanup wait drops the channel; the build ends as temporarily_unavailable and releases its room', async () => {
  const holder: { db?: Surreal } = {};
  const observed: Array<{ outcome: string }> = [];
  let hold = true;
  let aborts = 0;
  const { db, store } = await fresh({ buildDeadlineMs: 2_000 }, {
    channel: {
      connection: async () => throughChannel(holder.db!, async sql => {
        // The row write never answers while `hold` is set, so the build is stuck inside its one batch.
        if (hold && sql.includes('INSERT INTO query_snapshot_row')) await new Promise<never>(() => undefined);
      }),
      abort: async () => { aborts++; },
    },
    observe: stats => observed.push(stats),
  });
  holder.db = db.db;
  const baseline = await quotaOf(store);
  const started = performance.now();
  const error = await store.create({ owner: 'k-owner', kind: 'context', digest: 'dig-k', role: 'gm', takenAt: TAKEN_AT, bodies: ['abc', 'def'] })
    .then(() => undefined, (reason: unknown) => reason);
  const elapsed = performance.now() - started;
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe('temporarily_unavailable');
  expect((error as CompanyError).retryable).toBe(true);
  // The 2-second deadline passes first, then the 2-second cleanup wait, and only then is the channel dropped.
  expect(elapsed).toBeGreaterThanOrEqual(3_900);
  expect(elapsed).toBeLessThan(6_000);
  expect(aborts).toBe(1);
  expect(observed.at(-1)).toMatchObject({ outcome: 'timed_out' });
  expect(await store.census()).toEqual({ listings: 0, rows: 0 });
  expect(await quotaOf(store)).toEqual(baseline);

  hold = false;
  const header = await store.create({ owner: 'k-owner', kind: 'context', digest: 'dig-k-again', role: 'gm', takenAt: TAKEN_AT, bodies: ['again'] });
  expect(await store.release(header.id)).toBe('released');
  expect(await quotaOf(store)).toEqual(baseline);
});
