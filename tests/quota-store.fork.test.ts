import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { readProviderQuotas, readQuotaEntries } from '../src/dispatcher/quota-store.ts';

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;

/**
 * The quota snapshot is written under `quota_<providerId>`. A provider id with a hyphen
 * (`factory-droid`) makes SurrealDB print the record as `company_meta:⟨quota_factory-droid⟩`,
 * so an id-string prefix test silently skipped exactly the providers that were out of budget.
 * These rows are read by record *name*, and this test pins that on a real fork instance.
 */
run('quota rows are read by record name, including hyphenated provider ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-store-fork-'));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const password = 'isolated-quota-store-test-only';
  const server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root',
    '--pass', password, '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: password,
    namespace: 'quota_store_fixture', database: 'control_plane' });
  try {
    let ready = false;
    for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true);
    await db.connect(); await db.bootstrap();
    const now = new Date().toISOString();
    for (const [name, provider, week] of [['quota_claude', 'claude', 19], ['quota_factory-droid', 'factory-droid', 0]] as const) {
      await db.db.upsert(new RecordId('company_meta', name)).content({
        provider, summary: `${provider} weekly ${week}%`, lowest_pct: week, weekly_pct: week,
        status: 'available', fetched_at: now, at: now, payload: { providerId: provider, windows: [{ id: 'weekly', remainingPct: week }] },
      });
    }
    // A row that is not a quota row must stay out of both readers.
    await db.db.upsert(new RecordId('company_meta', 'config')).content({ paused: false });

    // Calibration: the printed id of a hyphenated row is quoted (⟨…⟩ or `…`, depending on the
    // server version), so the id-prefix predicate the readers used to run matched none of these
    // rows. The predicate result is the proof, not the quoting character.
    const [printed] = await db.db.query<[string]>(`RETURN <string>type::record('company_meta', 'quota_factory-droid');`);
    expect(printed).not.toBe('company_meta:quota_factory-droid');
    const [oldPredicate] = await db.db.query<[boolean]>(
      `RETURN string::starts_with(<string>type::record('company_meta', 'quota_factory-droid'), 'company_meta:quota_');`);
    expect(oldPredicate).toBe(false);

    const quotas = await readProviderQuotas(db.db);
    expect(quotas.map(q => q.provider).sort()).toEqual(['claude', 'factory-droid']);
    expect(quotas.find(q => q.provider === 'factory-droid')).toMatchObject({ weeklyPct: 0, lowestPct: 0 });

    const entries = await readQuotaEntries<{ providerId: string }>(db.db);
    expect(entries.map(e => e.providerId).sort()).toEqual(['claude', 'factory-droid']);
  } finally {
    await db.close().catch(() => undefined);
    server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Migration 022 first defined `quota_limited` as a non-optional bool. SurrealDB validates the whole record on UPDATE,
 * so every def row that predated the field became unwritable: a def edit failed with "Expected `bool` but found `NONE`".
 * The field is optional now; this pins that a row without it stays writable.
 */
run('a def row without quota_limited stays writable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-store-def-'));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const password = 'isolated-quota-store-def-test-only';
  const server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root',
    '--pass', password, '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: password,
    namespace: 'quota_store_def_fixture', database: 'control_plane' });
  try {
    let ready = false;
    for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true);
    await db.connect(); await db.bootstrap();
    // An old def row: the field is cleared, exactly as migration 022 left the rows created before it.
    await db.db.query(`CREATE employee_def:⟨fixture-legacy⟩ CONTENT { role: 'engineering', provider: 'codex', model: 'fixture' };`);
    await db.db.query(`UPDATE employee_def:⟨fixture-legacy⟩ UNSET quota_limited;`);
    // The write that used to fail: an UPDATE validates the whole record.
    await db.db.query(`UPDATE employee_def:⟨fixture-legacy⟩ SET model = 'fixture-next';`);
    const [rows] = await db.db.query<[Array<{ model: string }>]>(`SELECT model FROM employee_def:⟨fixture-legacy⟩;`);
    expect(rows?.[0]).toMatchObject({ model: 'fixture-next' });
  } finally {
    await db.close().catch(() => undefined);
    server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true });
  }
});
