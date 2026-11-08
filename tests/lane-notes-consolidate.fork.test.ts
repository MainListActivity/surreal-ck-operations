import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { LaneNoteStore, type LaneNote } from '../src/lane-notes.ts';
import { consolidateDue, consolidateLane, listConsolidations, undoConsolidation, type ConsolidationOptions } from '../src/lane-notes-consolidate.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';
import { ownerApi } from '../src/owner-api.ts';
import { A, B, C, DISTINCT, MERGED, UNRELATED } from './support/lane-note-fixtures.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private store: no production data, credentials or dispatcher.
const run = process.env.RUN_SCK_TASK_ROUTES_TESTS === '1' ? test : test.skip;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const OWNER = 'owner:test';
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, notes: LaneNoteStore;

beforeAll(async () => {
  if (process.env.RUN_SCK_TASK_ROUTES_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-lane-consolidate-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', `rocksdb:${join(dir, 'db')}`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'lane_consolidate_fixture', database: 'control_plane' } as never);
  await db.connect(); await db.bootstrap();
  notes = new LaneNoteStore(db.db);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

/** Adds an owner note and pins its age, so the planner's order does not depend on how fast the test wrote the rows. */
const add = async (lane: string, text: string, n: number, options: { pinned?: boolean } = {}): Promise<LaneNote> => {
  const note = await notes.add(lane, text, OWNER, options);
  await db.db.query('UPDATE $n SET created_at = $at, updated_at = $at;', { n: new RecordId('lane_note', note.id), at: new Date(Date.now() - (100 - n) * DAY) });
  return note;
};
const texts = async (lane: string) => (await notes.active(lane)).map(note => note.text).sort();
/** Every row of a lane as stored: state, text and the consolidation fields, with absent fields as null. */
const stored = async (lane: string) => {
  const [rows] = await db.db.query<[Array<{ id: RecordId; state: string; text: string; removed_reason?: string; merged_into?: RecordId }>]>(
    'SELECT id, state, text, removed_reason, merged_into FROM lane_note WHERE lane = $lane;', { lane });
  return new Map(rows.map(row => [String(row.id.id), {
    state: row.state, text: row.text, reason: row.removed_reason ?? null, mergedInto: row.merged_into ? String(row.merged_into.id) : null,
  }]));
};
const recorded = async (id: string | undefined) => (await listConsolidations(db.db, 100)).find(item => item.id === id);
const consolidate = (lane: string, options: Partial<ConsolidationOptions> = {}) =>
  consolidateLane(db.db, lane, { now: new Date(), actor: OWNER, ...options });
const undo = (id: string, options: { beforeWrite?: () => Promise<void> } = {}) =>
  undoConsolidation(db.db, id, OWNER, { now: new Date(), ...options });

run('restating notes merge into the newest one; the unrelated note stays', async () => {
  const lane = 'cons-merge:qa';
  const a = await add(lane, A, 1);
  const b = await add(lane, B, 2);
  const c = await add(lane, C, 3);
  const d = await add(lane, UNRELATED, 4);
  const result = await consolidate(lane);
  expect(result.lanes).toEqual([expect.objectContaining({ lane, active: 4, pinned: 0, merged: 2, agedOut: 0, rewritten: 0, activeAfter: 2 })]);
  expect(result.changes.map(change => [change.reason, change.note, change.mergedInto])).toEqual([
    ['merged', b.id, c.id], ['merged', a.id, c.id],
  ]);
  expect(await texts(lane)).toEqual([C, UNRELATED].sort());
  const after = await stored(lane);
  expect(after.get(a.id)).toEqual({ state: 'removed', text: A, reason: 'merged', mergedInto: c.id });
  expect(after.get(b.id)).toEqual({ state: 'removed', text: B, reason: 'merged', mergedInto: c.id });
  expect(after.get(c.id)).toEqual({ state: 'active', text: C, reason: null, mergedInto: null });
  expect(after.get(d.id)).toEqual({ state: 'active', text: UNRELATED, reason: null, mergedInto: null });
  expect(await recorded(result.id)).toMatchObject({ id: result.id, actor: OWNER, dryRun: false, lanes: result.lanes, changes: result.changes });
});

run('pinned notes never merge, and they are never aged out even when they are the oldest', async () => {
  const lane = 'cons-pin:qa';
  const pinned = await add(lane, A, 1, { pinned: true });
  const free = await add(lane, C, 2);
  // A pinned note restating a free one is not a merge.
  expect((await consolidate(lane)).changes).toEqual([]);
  expect(await texts(lane)).toEqual([A, C].sort());
  for (const [i, text] of DISTINCT.slice(0, 19).entries()) await add(lane, text, 3 + i);
  // 21 notes, one of them pinned: the oldest unpinned note goes, and the pinned one stays although it is the oldest.
  const result = await consolidate(lane);
  expect(result.changes.map(change => [change.note, change.reason])).toEqual([[free.id, 'aged_out']]);
  expect(result.lanes[0]).toMatchObject({ active: 21, pinned: 1, merged: 0, agedOut: 1, activeAfter: 20 });
  expect(await notes.get(pinned.id)).toMatchObject({ state: 'active', pinned: true, text: A });
  expect(await texts(lane)).toEqual([A, ...DISTINCT.slice(0, 19)].sort());
});

run('past the target of 20, the oldest unpinned notes age out, and a pass with nothing to do writes no record', async () => {
  const lane = 'cons-age:qa';
  const added: LaneNote[] = [];
  for (const [i, text] of DISTINCT.slice(0, 22).entries()) added.push(await add(lane, text, i + 1));
  const result = await consolidate(lane);
  expect(result.lanes).toEqual([expect.objectContaining({ active: 22, merged: 0, agedOut: 2, rewritten: 0, activeAfter: 20 })]);
  expect(result.changes.map(change => [change.note, change.reason])).toEqual([[added[0]!.id, 'aged_out'], [added[1]!.id, 'aged_out']]);
  expect(await texts(lane)).toEqual(DISTINCT.slice(2, 22).sort());
  expect(await recorded(result.id)).toMatchObject({ changes: result.changes });
  const runs = (await listConsolidations(db.db, 100)).length;
  expect((await consolidate(lane)).changes).toEqual([]);
  expect((await listConsolidations(db.db, 100)).length).toBe(runs);
});

run('a dry run previews the changes and writes nothing', async () => {
  const lane = 'cons-dry:qa';
  await add(lane, A, 1);
  await add(lane, B, 2);
  await add(lane, C, 3);
  const before = await stored(lane);
  const runs = (await listConsolidations(db.db, 100)).length;
  const preview = await consolidate(lane, { dryRun: true });
  expect(preview).toMatchObject({ dryRun: true, lanes: [expect.objectContaining({ merged: 2, activeAfter: 1 })] });
  expect(preview.changes).toHaveLength(2);
  expect(preview.id).toBeUndefined();
  expect(await stored(lane)).toEqual(before);
  expect((await listConsolidations(db.db, 100)).length).toBe(runs);
});

run('a rewrite that breaks the note rules, or fails, keeps the newest original', async () => {
  const lane = 'cons-long:qa';
  await add(lane, A, 1);
  await add(lane, B, 2);
  const kept = await add(lane, C, 3);
  const seen: string[][] = [];
  const result = await consolidate(lane, { rewrite: async inputs => { seen.push(inputs); return '长'.repeat(241); } });
  expect(seen).toEqual([[C, B, A]]);
  expect(result.changes.map(change => change.reason)).toEqual(['merged', 'merged']);
  expect(await texts(lane)).toEqual([C]);
  expect(await notes.get(kept.id)).toMatchObject({ state: 'active', text: C });

  const failing = 'cons-fail:qa';
  await add(failing, A, 1);
  await add(failing, B, 2);
  const failingKept = await add(failing, C, 3);
  await consolidate(failing, { rewrite: async () => { throw new Error('rewrite offline'); } });
  expect(await texts(failing)).toEqual([C]);
  expect(await notes.get(failingKept.id)).toMatchObject({ state: 'active', text: C });
});

run('a rewrite that passes the note rules replaces the kept note, and the run records it', async () => {
  const lane = 'cons-rewrite:qa';
  await add(lane, A, 1);
  await add(lane, B, 2);
  const c = await add(lane, C, 3);
  const result = await consolidate(lane, { rewrite: async () => MERGED });
  expect(result.changes.map(change => change.reason).sort()).toEqual(['merged', 'merged', 'rewritten']);
  expect(result.changes.find(change => change.reason === 'rewritten')).toMatchObject({
    note: c.id, before: { state: 'active', text: C }, after: { state: 'active', text: MERGED },
  });
  expect(result.lanes[0]).toMatchObject({ merged: 2, rewritten: 1, activeAfter: 1 });
  expect(await texts(lane)).toEqual([MERGED]);
});

run('undo puts every changed note back in the state and text it had before the run', async () => {
  const lane = 'cons-undo:qa';
  await add(lane, A, 1);
  await add(lane, B, 2);
  await add(lane, C, 3);
  const before = await stored(lane);
  const result = await consolidate(lane, { rewrite: async () => MERGED });
  expect(await stored(lane)).not.toEqual(before);
  const undone = await undo(result.id!);
  expect(undone).toMatchObject({ id: result.id, restored: 3, skipped: [] });
  expect(await stored(lane)).toEqual(before);
  expect(await recorded(result.id)).toMatchObject({ undoneBy: OWNER, undoSkipped: [] });
});

run('a run can be undone once, and an unknown run is not found', async () => {
  const lane = 'cons-once:qa';
  await add(lane, A, 1);
  await add(lane, B, 2);
  await add(lane, C, 3);
  const result = await consolidate(lane);
  await undo(result.id!);
  await expect(undo(result.id!)).rejects.toMatchObject({ code: 'conflict' });
  await expect(undo('no-such-run')).rejects.toMatchObject({ code: 'not_found' });
});

run('a note edited after the run is left as it is, and the undo lists it as skipped', async () => {
  const lane = 'cons-skip:qa';
  await add(lane, A, 1);
  await add(lane, B, 2);
  const c = await add(lane, C, 3);
  const result = await consolidate(lane, { rewrite: async () => MERGED });
  await notes.edit(c.id, '老板改过的经验');
  const undone = await undo(result.id!);
  expect(undone.restored).toBe(2);
  expect(undone.skipped).toEqual([{ note: c.id, lane, reason: 'changed_after_run', text: '老板改过的经验' }]);
  expect(await texts(lane)).toEqual([A, B, '老板改过的经验'].sort());
  expect((await recorded(result.id))?.undoSkipped).toEqual(undone.skipped);
});

run('a note edited while the run is planned cancels the whole run and records nothing', async () => {
  const lane = 'cons-race:qa';
  const a = await add(lane, A, 1);
  const b = await add(lane, B, 2);
  const c = await add(lane, C, 3);
  const runs = (await listConsolidations(db.db, 100)).length;
  // The merge of B is written inside the transaction before the guard on A fails, so the rollback has to undo it.
  await expect(consolidate(lane, { beforeWrite: async () => { await notes.edit(a.id, '并发改过的笔记'); } }))
    .rejects.toMatchObject({ code: 'conflict' });
  const after = await stored(lane);
  expect(after.get(b.id)).toMatchObject({ state: 'active', reason: null, mergedInto: null });
  expect(after.get(c.id)).toMatchObject({ state: 'active', text: C });
  expect(after.get(a.id)).toMatchObject({ state: 'active', text: '并发改过的笔记' });
  expect((await listConsolidations(db.db, 100)).length).toBe(runs);
});

run('a note edited between an undo\'s check and its write cancels that undo, and a retry skips the note', async () => {
  const lane = 'cons-undo-race:qa';
  const a = await add(lane, A, 1);
  const b = await add(lane, B, 2);
  const c = await add(lane, C, 3);
  const result = await consolidate(lane);
  // Restoring B happens inside the transaction before the guard on A fails, so B must still be merged afterwards.
  await expect(undo(result.id!, { beforeWrite: async () => { await notes.edit(a.id, '撤销前又改过'); } }))
    .rejects.toMatchObject({ code: 'conflict' });
  expect((await stored(lane)).get(b.id)).toMatchObject({ state: 'removed', reason: 'merged', mergedInto: c.id });
  expect((await recorded(result.id))?.undoneAt).toBeUndefined();
  const retry = await undo(result.id!);
  expect(retry.restored).toBe(1);
  expect(retry.skipped).toEqual([{ note: a.id, lane, reason: 'changed_after_run', text: '撤销前又改过' }]);
});

run('owner commands preview, run, list and undo a consolidation', async () => {
  const lane = 'cons-owner:qa';
  await add(lane, A, 1);
  await add(lane, B, 2);
  await add(lane, C, 3);
  const ctx = { db, core: undefined, owner: {}, workforce: {}, messages: new OutboundMessageStore(db.db), opsRepo: '/tmp/ops' } as never;
  const command = (input: Record<string, unknown>) => ownerApi(ctx, input, 'web');
  const preview = await command({ command: 'note.consolidate', lane, dryRun: true }) as { id?: string; dryRun: boolean; changes: unknown[] };
  expect(preview).toMatchObject({ dryRun: true, changes: [expect.anything(), expect.anything()] });
  expect(preview.id).toBeUndefined();
  expect(await texts(lane)).toEqual([A, B, C].sort());
  const ran = await command({ command: 'note.consolidate', lane }) as { id: string; actor: string; dryRun: boolean };
  expect(ran).toMatchObject({ actor: 'owner:web', dryRun: false });
  expect(await texts(lane)).toEqual([C]);
  const { consolidations } = await command({ command: 'note.consolidations', limit: 100 }) as { consolidations: Array<{ id: string }> };
  expect(consolidations.map(item => item.id)).toContain(ran.id);
  const undone = await command({ command: 'note.consolidation.undo', id: ran.id }) as { restored: number; skipped: unknown[] };
  expect(undone).toMatchObject({ id: ran.id, restored: 2, skipped: [] });
  expect(await texts(lane)).toEqual([A, B, C].sort());
});

run('the daily pass runs when a day has passed since its last check, and not before', async () => {
  const lane = 'cons-due:qa';
  await add(lane, A, 1);
  await add(lane, B, 2);
  await add(lane, C, 3);
  const day1 = new Date(Date.now() + DAY + HOUR);
  const first = await consolidateDue(db.db, { now: day1, actor: 'system:consolidation' });
  expect(first).toMatchObject({ actor: 'system:consolidation', dryRun: false });
  expect(await texts(lane)).toEqual([C]);
  expect(await consolidateDue(db.db, { now: new Date(day1.getTime() + HOUR), actor: 'system:consolidation' })).toBeUndefined();
  expect(await consolidateDue(db.db, { now: new Date(day1.getTime() + DAY + HOUR), actor: 'system:consolidation' })).toBeDefined();
});
