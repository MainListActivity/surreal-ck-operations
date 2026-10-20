// SYS01 AC-D (M1) on the isolated company fork (scripts/test-worktrees.ts): a listing call is answered within the reply ceiling
// even when its first page is never read, and the listing stored for that call is released rather than left behind.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { CompanyError } from '../src/core-errors.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { REPLY_CEILING_MS } from '../src/snapshot-store.ts';

setDefaultTimeout(120_000);

const NS = `sck_agent_reply_ceiling_${randomUUID().slice(0, 8)}`;
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
const core = new SurrealCompanyCore(database);
const suffix = randomUUID().slice(0, 8);
let gm: string;
let reader: string;

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  const enrollment = new LocalEnrollmentAdmin(database);
  gm = await enrollment.enroll(`rc-gm-${suffix}`, 'gm', ['execute', 'review', 'manage']);
  reader = await enrollment.enroll(`rc-reader-${suffix}`, 'engineering', ['execute', 'review']);
  await core.createTask(gm, {
    title: 'reply ceiling fixture', context: 'Synthetic fixture for the reply ceiling test',
    executorRole: 'engineering', reviewerRole: 'engineering', idempotencyKey: `rc-${suffix}`,
  });
});

afterAll(async () => {
  try { await database.db.query(`REMOVE NAMESPACE IF EXISTS ${NS};`); } catch { /* best effort */ }
  await database.close();
});

/** The snapshot store behind the core, typed for the two calls this test steers. */
const store = (core as unknown as {
  snapshots: { census(): Promise<{ listings: number; rows: number }>; read: (...args: never[]) => Promise<unknown> };
}).snapshots;

test('a first page that is never read is answered at the reply ceiling, and the listing stored for that call is released', async () => {
  const before = await store.census();
  const realRead = store.read;
  store.read = () => new Promise<never>(() => undefined);
  const started = performance.now();
  const error = await core.contextView(reader, { pageSize: 1 }).then(() => undefined, (reason: unknown) => reason);
  const elapsed = performance.now() - started;
  store.read = realRead;
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe('temporarily_unavailable');
  expect((error as CompanyError).retryable).toBe(true);
  // Answered at the reply ceiling: the build, the stalled read and the release all end within it.
  expect(elapsed).toBeGreaterThanOrEqual(REPLY_CEILING_MS - 1_000);
  expect(elapsed).toBeLessThan(REPLY_CEILING_MS + 600);
  // The listing the call stored is released in the background; the count returns to where it was.
  const until = Date.now() + 3_000;
  while (Date.now() < until && (await store.census()).listings !== before.listings) await Bun.sleep(20);
  expect(await store.census()).toEqual(before);
});

test('a listing whose query matches exactly one task answers with that task', async () => {
  const answer = await core.contextView(reader, { pageSize: 25 });
  expect(answer.tasks?.map(task => task.title)).toEqual(['reply ceiling fixture']);
  expect(answer.page?.hasMore).toBe(false);
});
