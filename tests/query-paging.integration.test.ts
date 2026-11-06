import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { CompanyError, SurrealCompanyCore, asId, id } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { ProjectStore } from '../src/projects.ts';
import { ensureCommDirs, reqDir, resDir, writeFileAtomic } from '../src/comm.ts';
import type { HistoryEntry, TaskTextField, TaskTextSegment, TaskView } from '../src/contracts.ts';
import type { EmployeeInst } from '../src/workforce.ts';
import { queryDigest } from '../src/query-input.ts';
import { RESPONSE_BUDGET_BYTES, answerBytes, guardRelayResponse, sealCursor, type ClaimEcho } from '../src/response-budget.ts';
import { SnapshotStore } from '../src/snapshot-store.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
import { connectCompanyClient } from '../src/mcp/client';
import { createMcpHttpService } from '../src/mcp/server';
import { countingFetch, lastBody } from './support/mcp-wire.ts';

// SYS01 bounded reads on the isolated company fork started by scripts/test-worktrees.ts. Never production.
const config = { ...loadDatabaseConfig(), namespace: 'sck_agent_company_test', database: 'control_plane' };
const database = new CompanyDatabase(config);
const core = new SurrealCompanyCore(database);
const owner = new OwnerDesk(database);
const enrollment = new LocalEnrollmentAdmin(database);
const suffix = randomUUID().slice(0, 8);
let seq = 0;
const key = (label: string) => `qp-${suffix}-${label}-${++seq}`;
setDefaultTimeout(600_000);

const ROOT = join(import.meta.dir, '..');
const ids = { gm: `qp-gm-${suffix}`, eng: `qp-eng-${suffix}`, cs: `qp-cs-${suffix}` };
const TOTAL = 1000;
const unit = '中文🙂字符';
let gm: string;
let eng: string;
let cs: string;
let tag: string;
let smallGoalId: string;
let goalId: string;
let expectedWorking: string[] = [];

/** `count` code points of mixed Chinese and emoji, starting with `prefix` (never splits a surrogate pair). */
function codePoints(count: number, prefix = ''): string {
  const body = [...unit.repeat(Math.ceil(count / 5) + 1)].slice(0, Math.max(0, count - [...prefix].length)).join('');
  return prefix + body;
}

const bytesOf = (value: unknown): number => answerBytes(value);
const utf8 = (text: string): number => Buffer.byteLength(text, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

async function expectRefused(promise: Promise<unknown>, code: CompanyError['code'], pattern: RegExp) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe(code);
  expect((error as CompanyError).message).toMatch(pattern);
}

async function workingIds(goal: string): Promise<string[]> {
  const [rows] = await database.db.query<[Array<{ id: RecordId }>]>(
    "SELECT id FROM task WHERE tag = $goal AND state IN ['ready', 'doing', 'review', 'blocked'];", { goal: goal });
  return (rows ?? []).map(row => asId(row.id));
}

async function countRows(table: string): Promise<number> {
  const [rows] = await database.db.query<[Array<{ n: number }>]>(`SELECT count() AS n FROM ${table} GROUP ALL;`);
  return rows?.[0]?.n ?? 0;
}

/** Audit rows of one task that history answers can name: every entry except routine ops_call reads. */
async function historyRows(taskId: string): Promise<number> {
  const [rows] = await database.db.query<[Array<{ n: number }>]>(
    "SELECT count() AS n FROM audit WHERE task = $task AND action != 'ops_call' GROUP ALL;", { task: id('task', taskId) });
  return rows?.[0]?.n ?? 0;
}

async function addAudit(taskId: string, evidence: string): Promise<void> {
  await database.db.query(
    'CREATE audit CONTENT { task: $task, actor: $actor, action: "checkpoint", evidence: $evidence, version: 1, at: time::now() };',
    { task: id('task', taskId), actor: id('employee', ids.gm), evidence });
}

/** Follows every page of one traversal and returns all items, in order. Each page is checked as it arrives. */
async function drain<T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>, start?: string, limit = 500): Promise<T[]> {
  const seen: T[] = [];
  let cursor: string | undefined = start;
  for (let page = 0; page < limit; page++) {
    const next = await fetchPage(cursor);
    seen.push(...next.items);
    if (!next.nextCursor) return seen;
    cursor = next.nextCursor;
  }
  throw new Error('traversal did not finish within the page limit');
}

/** Every page of one history traversal, checked against the budget. */
async function historyEntries(taskId: string): Promise<HistoryEntry[]> {
  return drain(async cursor => {
    const view = await core.historyView(gm, taskId, { pageSize: 9, ...(cursor ? { cursor } : {}) });
    expect(bytesOf(view)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    return { items: view.history, nextCursor: view.page.nextCursor };
  });
}

/**
 * Reads one text field in byte segments. The digest of the first segment is pinned on every later one, so a text
 * that changed mid-way is refused rather than mixed in. Every segment is whole UTF-8.
 */
async function reassemble(args: { taskId: string; field: TaskTextField; auditId?: string; limit: number }, credential = gm) {
  const pieces: Buffer[] = [];
  let offset: number | null = 0;
  let pinned: string | undefined;
  let totalBytes = -1;
  let segments = 0;
  while (offset !== null) {
    const segment = await core.taskText(credential, { ...args, offset, ...(pinned ? { expectSha256: pinned } : {}) });
    expect(segment.bytes).toBeLessThanOrEqual(args.limit);
    expect(segment.text).not.toContain('\uFFFD');
    // Every segment is also an answer the relay sends whole, so it must pass the same guard (SYS01, F2).
    const answer = { ok: true as const, data: segment };
    expect(guardRelayResponse(answer)).toBe(answer);
    pinned ??= segment.sha256;
    totalBytes = segment.totalBytes;
    pieces.push(Buffer.from(segment.text, 'utf8'));
    offset = segment.nextOffset;
    segments++;
  }
  return { text: Buffer.concat(pieces).toString('utf8'), totalBytes, sha256: pinned!, segments };
}

/**
 * A real sck round trip: the comm client writes the request file, a stand-in sidecar answers through the
 * same guard the sidecar uses, and the client prints what it received. Only the sidecar's core call is stubbed.
 */
async function relay(tool: string, args: Record<string, unknown>, answer: (input: Record<string, unknown>) => Promise<unknown>, dir = newCommDir()) {
  const child = Bun.spawn([process.execPath, join(ROOT, 'src/mcp/client-cli.ts'), 'call', tool, JSON.stringify(args)], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, SCK_COMM_DIR: dir, SCK_COMM_KEY: 'sys01-relay-key' },
  });
  for (;;) {
    const [file] = readdirSync(reqDir(dir)).filter(name => name.endsWith('.json'));
    if (file) {
      const request = JSON.parse(readFileSync(join(reqDir(dir), file), 'utf8')) as { args: Record<string, unknown> };
      unlinkSync(join(reqDir(dir), file));
      let res: { ok: boolean; data?: unknown; error?: string };
      try {
        res = { ok: true, data: await answer(request.args) };
      } catch (error) {
        const failure = error as CompanyError;
        res = { ok: false, error: `${failure.code}: ${failure.message}` };
      }
      writeFileAtomic(join(resDir(dir), file), JSON.stringify(guardRelayResponse(res)));
      break;
    }
    await Bun.sleep(20);
  }
  const out = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  return { out, stderr, exit: await child.exited };
}

/** The payload of a sealed cursor (v1.<payload>.<tag>), read without opening it, to compare what a cursor carries. */
const cursorBody = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));

function newCommDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sys01-relay-'));
  ensureCommDirs(dir);
  return dir;
}

/**
 * A caller that drops the connection: its request reaches the stand-in sidecar, the caller process is killed
 * before any answer is read, and the answer lands in the comm directory with nobody waiting for it.
 */
async function relayAndDrop(dir: string, tool: string, args: Record<string, unknown>, answer: (input: Record<string, unknown>) => Promise<unknown>) {
  const child = Bun.spawn([process.execPath, join(ROOT, 'src/mcp/client-cli.ts'), 'call', tool, JSON.stringify(args)], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, SCK_COMM_DIR: dir, SCK_COMM_KEY: 'sys01-relay-key' },
  });
  for (;;) {
    const [file] = readdirSync(reqDir(dir)).filter(name => name.endsWith('.json'));
    if (file) {
      const request = JSON.parse(readFileSync(join(reqDir(dir), file), 'utf8')) as { args: Record<string, unknown> };
      unlinkSync(join(reqDir(dir), file));
      child.kill('SIGKILL');
      await child.exited;
      writeFileAtomic(join(resDir(dir), file), JSON.stringify(guardRelayResponse({ ok: true, data: await answer(request.args) })));
      return request.args;
    }
    await Bun.sleep(20);
  }
}

beforeAll(async () => {
  await database.connect();
  await database.bootstrap();
  gm = await enrollment.enroll(ids.gm, 'owner', ['execute', 'review', 'manage']);
  eng = await enrollment.enroll(ids.eng, 'engineering', ['execute', 'review']);
  cs = await enrollment.enroll(ids.cs, 'cs', ['execute']);
  const goal = await core.createTask(gm, { title: `分页夹具目标 ${suffix}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key('goal') });
  goalId = goal.id;
  // Fixture: 1000 tasks with Chinese and emoji titles; every 25th context is long (about 6000 characters).
  for (let i = 0; i < TOTAL; i++) {
    await core.createTask(gm, {
      title: `分页样例 ${i} ${unit}`,
      context: i % 25 === 0 ? codePoints(6000, `第${i}条长正文 `) : `短正文 ${i} ${unit}`,
      executorRole: 'engineering', reviewerRole: 'qa', tag: goalId, idempotencyKey: key(`t${i}`),
    });
  }
  expectedWorking = await workingIds(goalId);
  // A second goal with three tasks of its own (tiering adds the triage template's tasks): its whole working set fits the budget.
  const small = await core.createTask(gm, { title: `分页小目标 ${suffix}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key('goal-small') });
  smallGoalId = small.id;
  for (let i = 0; i < 3; i++) {
    await core.createTask(gm, {
      title: `小目标样例 ${i} ${unit}`, context: i === 0 ? codePoints(1_500, '较长正文 ') : `短正文 ${i}`,
      executorRole: 'engineering', reviewerRole: 'qa', tag: smallGoalId, idempotencyKey: key(`small${i}`),
    });
  }
}, 1_200_000);

afterAll(async () => { await database.close(); });

test('the budget is 48 KiB of serialized UTF-8 and the working set holds at least the 1000-task fixture', () => {
  expect(RESPONSE_BUDGET_BYTES).toBe(48 * 1024);
  expect(expectedWorking.length).toBeGreaterThanOrEqual(TOTAL);
});

test('legacy get_context over the whole working set is refused as response_too_large, never a partial list (C2)', async () => {
  await expectRefused(core.contextView(gm, { tag: goalId }), 'response_too_large', /pageSize/);
});

test('legacy get_context answers whole when the set fits: the old keys, every task, and no page (C2)', async () => {
  // The goal's working set is read from the database: a tiered goal also gets its triage template tasks.
  const members = await workingIds(smallGoalId);
  expect(members.length).toBeGreaterThanOrEqual(3);
  const legacy = await core.contextView(gm, { tag: smallGoalId });
  expect(Object.keys(legacy).sort()).toEqual(['companyIncluded', 'companyRead', 'principal', 'tasks']);
  expect(legacy.companyIncluded).toBe(false);
  expect(legacy.page).toBeUndefined();
  expect(legacy.tasks!.map(task => String(task.id)).sort()).toEqual([...members].sort());
  expect(bytesOf(legacy)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  // A complete answer carries whole contexts, never a preview: the long one of this goal is returned in full (C2, C3).
  const long = legacy.tasks!.find(task => String(task.context).startsWith('较长正文'));
  expect(long?.context).toBe(codePoints(1_500, '较长正文 '));
  expect(long?.contextTruncated).toBe(false);
  expect(long?.contextBytes).toBe(utf8(String(long?.context)));
  expect(long?.contextSha256).toBe(sha256(String(long?.context)));
  expect(legacy.tasks!.every(task => task.contextTruncated === false)).toBe(true);
});

test('the company block is never trimmed: a legacy answer whose brief breaks the budget is refused, and a page carries it only on request (C2)', async () => {
  const original = core.companyBrief;
  const bulky = { directions: [], goals: [{ text: '超'.repeat(20_000) }], projects: [], paused: false } as never;
  try {
    core.companyBrief = async () => bulky;
    // AC-A: the block is not in a task answer by default, so the bulky block is only in an answer that asks for it.
    expect((await core.contextView(gm, { tag: smallGoalId })).companyIncluded).toBe(false);
    await expectRefused(core.contextView(gm, { tag: smallGoalId, includeCompany: true }), 'response_too_large', /budget/);
    const page = await core.contextView(gm, { tag: smallGoalId, pageSize: 100 });
    expect(page).not.toHaveProperty('company');
    expect(page.tasks!.length).toBe(await workingIds(smallGoalId).then(ids => ids.length));
    await expectRefused(core.contextView(gm, { tag: smallGoalId, pageSize: 5, includeCompany: true }), 'response_too_large', /budget/);
  } finally {
    core.companyBrief = original;
  }
  const withBrief = await core.contextView(gm, { tag: smallGoalId, pageSize: 5, includeCompany: true });
  expect(withBrief).toHaveProperty('company');
});

test('legacy get_task_history is the complete history with whole evidence when it fits, and refused when it does not (C2, C3)', async () => {
  const small = await core.createTask(gm, {
    title: '历史小样例', context: '历史小样例正文', executorRole: 'engineering', reviewerRole: 'qa', tag: goalId, idempotencyKey: key('hist-small'),
  });
  await addAudit(small.id, codePoints(3_000, '完整证据 '));
  const whole = await core.history(gm, small.id);
  expect(Array.isArray(whole)).toBe(true);
  expect(whole.length).toBe(await historyRows(small.id));
  const full = whole.find(entry => entry.evidence?.startsWith('完整证据'));
  expect(full?.evidence).toBe(codePoints(3_000, '完整证据 '));
  expect(full?.evidenceTruncated).toBe(false);
  const big = await core.createTask(gm, {
    title: '历史大样例', context: '历史大样例正文', executorRole: 'engineering', reviewerRole: 'qa', tag: goalId, idempotencyKey: key('hist-big'),
  });
  for (let i = 0; i < 30; i++) await addAudit(big.id, codePoints(6_000, `证据第${i}条 `));
  await expectRefused(core.history(gm, big.id), 'response_too_large', /pageSize/);
});

test('get_context by taskId returns the whole context when it fits, with its size and digest (C3)', async () => {
  const text = codePoints(4_000, '中等正文 ');
  const task = await core.createTask(gm, {
    title: '中等正文样例', context: text, executorRole: 'engineering', reviewerRole: 'qa', tag: goalId, idempotencyKey: key('medium'),
  });
  const detail = await core.contextView(gm, { taskId: task.id });
  const view = detail.tasks![0]!;
  expect(view.context).toBe(text);
  expect(view.contextBytes).toBe(utf8(text));
  expect(view.contextSha256).toBe(sha256(text));
  expect(detail.page).toBeUndefined();
  expect(bytesOf(detail)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
});

test('a context over the budget is refused whole with read_task_text guidance; segments verify, a changed text is refused, and each read is permission-checked (C3)', async () => {
  const text = '中'.repeat(19_000); // 57,000 bytes: above the 48 KiB budget
  const task = await core.createTask(gm, {
    title: '超大正文样例', context: text, executorRole: 'engineering', reviewerRole: 'qa', tag: goalId, idempotencyKey: key('huge'),
  });
  await expectRefused(core.contextView(gm, { taskId: task.id }), 'response_too_large', /read_task_text/);
  const first = await core.taskText(gm, { taskId: task.id, field: 'context', offset: 0, limit: 8_192 });
  expect(first.totalBytes).toBe(utf8(text));
  expect(first.sha256).toBe(sha256(text));
  const whole = await reassemble({ taskId: task.id, field: 'context', limit: 8_192 });
  expect(whole.text).toBe(text);
  expect(whole.totalBytes).toBe(utf8(text));
  expect(whole.sha256).toBe(sha256(text));
  // The text changes between two segments: a read still pinned to the old digest is refused, never mixed.
  await database.db.query('UPDATE ONLY $task SET context = $context;', { task: id('task', task.id), context: `${text} 已修改` });
  await expectRefused(core.taskText(gm, { taskId: task.id, field: 'context', offset: first.nextOffset!, limit: 8_192, expectSha256: first.sha256 }), 'conflict', /changed/);
  // Access is checked on every read: a role with no access to this task is refused even mid-reassembly.
  await expectRefused(core.taskText(cs, { taskId: task.id, field: 'context', offset: 0 }), 'forbidden', /access denied/);
  // A digest of the wrong form is refused before any read.
  await expectRefused(core.taskText(gm, { taskId: task.id, field: 'context', expectSha256: 'not-a-digest' }), 'invalid', /expectSha256/);
});

test('a text reassembles exactly from 4-byte segments of mixed Chinese and emoji, with its digest verified (C3)', async () => {
  const text = '中文🙂字符'.repeat(60);
  const task = await core.createTask(gm, {
    title: '分段样例', context: text, executorRole: 'engineering', reviewerRole: 'qa', tag: goalId, idempotencyKey: key('tiny'),
  });
  const whole = await reassemble({ taskId: task.id, field: 'context', limit: 4 });
  expect(whole.text).toBe(text);
  expect(whole.totalBytes).toBe(utf8(text));
  expect(whole.sha256).toBe(sha256(text));
  expect(whole.segments).toBeGreaterThanOrEqual(utf8(text) / 4);
});

test('a control-heavy or quote-dense text reads back whole through read_task_text, and every segment answer passes the relay guard (SYS01, F2)', async () => {
  // JSON writes a control character as six bytes and a quote as two. A context stops at 20,000 characters, so the escapes alone
  // push the whole text past 48 KiB (120,000 bytes of control characters, 80,000 of the mix): it must be read in segments.
  for (const text of ['\u0001'.repeat(20_000), '"\u0001'.repeat(10_000)]) {
    const task = await core.createTask(gm, {
      title: '转义样例', context: text, executorRole: 'engineering', reviewerRole: 'qa', tag: goalId, idempotencyKey: key('escape'),
    });
    const whole = await reassemble({ taskId: task.id, field: 'context', limit: 24 * 1024 });
    expect(whole.text).toBe(text);
    expect(whole.totalBytes).toBe(utf8(text));
    expect(whole.sha256).toBe(sha256(text));
    expect(whole.segments).toBeGreaterThan(1);
  }
});

test('a since that SurrealDB would refuse is invalid on every read that takes it, and a zoned time is normalized before the query (SYS01, F3)', async () => {
  await expectRefused(core.contextView(gm, { since: 'October 19, 2026', pageSize: 5 }), 'invalid', /since/);
  await expectRefused(core.adminSummary(gm, { since: '2026/10/19' }), 'invalid', /since/);
  const summary = await core.adminSummary(gm, { since: '2026-10-19T08:00:00+08:00' });
  expect(JSON.stringify(summary)).toContain('2026-10-19T00:00:00.000Z');
});

test('a read past offset 0 must pin the digest of its first segment, so two versions of one text are never mixed (C3)', async () => {
  const text = '中文🙂字符'.repeat(40);
  const task = await core.createTask(gm, {
    title: '版本样例', context: text, executorRole: 'engineering', reviewerRole: 'qa', tag: goalId, idempotencyKey: key('version'),
  });
  await expectRefused(core.taskText(gm, { taskId: task.id, field: 'context', offset: 8, limit: 16 }), 'invalid', /expectSha256/);
  const first = await core.taskText(gm, { taskId: task.id, field: 'context', offset: 0, limit: 16 });
  const second = await core.taskText(gm, { taskId: task.id, field: 'context', offset: first.nextOffset!, limit: 16, expectSha256: first.sha256 });
  expect(second.sha256).toBe(first.sha256);
  await database.db.query('UPDATE ONLY $task SET context = $context;', { task: id('task', task.id), context: `${text} 另一版` });
  await expectRefused(core.taskText(gm, { taskId: task.id, field: 'context', offset: second.nextOffset!, limit: 16, expectSha256: first.sha256 }), 'conflict', /changed/);
});

test('a paged traversal yields every working-set task exactly once, each page inside the budget', async () => {
  const expected = await workingIds(goalId);
  const seen = await drain(async cursor => {
    const page = await core.contextView(gm, { tag: goalId, pageSize: 37, ...(cursor ? { cursor } : {}) });
    expect(bytesOf(page)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    // Every item is whole unless it cannot fit a page on its own (C3). A cut item is flagged, and its size describes the full text.
    for (const task of page.tasks!) {
      if (task.contextTruncated === true) {
        expect(typeof task.contextNextOffset).toBe('number');
        expect(Number(task.contextBytes)).toBeGreaterThan(utf8(String(task.context)));
        continue;
      }
      expect(task.contextBytes).toBe(utf8(String(task.context)));
      expect(task.contextSha256).toBe(sha256(String(task.context)));
    }
    return { items: page.tasks!.map(task => String(task.id)), nextCursor: page.page!.nextCursor };
  });
  expect(new Set(seen).size).toBe(seen.length);
  expect([...seen].sort()).toEqual([...expected].sort());
});

test('a page item larger than the page budget on its own is cut at a character boundary and flagged; its rest reads by segment and the traversal goes on (C3, AC03)', async () => {
  const goal = await core.createTask(gm, { title: `超大条目目标 ${suffix}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key('goal-oversize') });
  const text = '超'.repeat(20_000); // 60,000 bytes: larger than one page item on its own
  const big = await core.createTask(gm, {
    title: `超大条目 ${unit}`, context: text, executorRole: 'engineering', reviewerRole: 'qa', tag: goal.id, idempotencyKey: key('oversize'),
  });
  for (let i = 0; i < 4; i++) {
    await core.createTask(gm, {
      title: `超大目标样例 ${i} ${unit}`, context: `短正文 ${i}`, executorRole: 'engineering', reviewerRole: 'qa', tag: goal.id, idempotencyKey: key(`oversize-${i}`),
    });
  }
  // A complete answer over this goal is refused, since the set does not fit whole (C2).
  await expectRefused(core.contextView(gm, { tag: goal.id }), 'response_too_large', /pageSize/);
  const expected = await workingIds(goal.id);
  const items: Array<Record<string, unknown>> = [];
  const seen = await drain(async cursor => {
    const page = await core.contextView(gm, { tag: goal.id, pageSize: 3, ...(cursor ? { cursor } : {}) });
    expect(bytesOf(page)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    items.push(...(page.tasks as Array<Record<string, unknown>>));
    return { items: page.tasks!.map(task => String(task.id)), nextCursor: page.page!.nextCursor };
  });
  expect([...seen].sort()).toEqual([...expected].sort());
  const cut = items.find(task => task.id === big.id)!;
  expect(cut.contextTruncated).toBe(true);
  expect(cut.contextBytes).toBe(utf8(text));
  expect(cut.contextSha256).toBe(sha256(text));
  const prefix = String(cut.context);
  expect(text.startsWith(prefix)).toBe(true);
  expect(cut.contextNextOffset).toBe(utf8(prefix));
  expect(items.filter(task => task !== cut).every(task => task.contextTruncated === false)).toBe(true);
  // The rest reads by segment from the flagged offset, pinned to the digest; the prefix plus the rest is the whole text.
  let rest = '';
  let offset: number | null = cut.contextNextOffset as number;
  while (offset !== null) {
    const segment = await core.taskText(gm, { taskId: big.id, field: 'context', offset, limit: 8_192, expectSha256: sha256(text) });
    rest += segment.text;
    offset = segment.nextOffset;
  }
  expect(prefix + rest).toBe(text);
});

test('a page item of 18 KiB of text, 36 KiB in both copies of the answer, stays whole for context and for evidence (C3)', async () => {
  const goal = await core.createTask(gm, { title: `中等条目目标 ${suffix}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key('goal-medium') });
  const text = '超'.repeat(6_000); // 18,000 bytes: 36 KiB in the text and in the JSON copy, still one page item
  const medium = await core.createTask(gm, {
    title: `中等条目 ${unit}`, context: text, executorRole: 'engineering', reviewerRole: 'qa', tag: goal.id, idempotencyKey: key('medium-item'),
  });
  await addAudit(medium.id, text);
  const expected = await workingIds(goal.id);
  const delivered: Array<Record<string, unknown>> = [];
  const seen = await drain(async cursor => {
    const page = await core.contextView(gm, { tag: goal.id, pageSize: 2, ...(cursor ? { cursor } : {}) });
    expect(bytesOf(page)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    delivered.push(...(page.tasks as Array<Record<string, unknown>>));
    return { items: page.tasks!.map(task => String(task.id)), nextCursor: page.page!.nextCursor };
  });
  expect([...seen].sort()).toEqual([...expected].sort());
  const whole = delivered.find(task => task.id === medium.id)!;
  expect(whole.context).toBe(text);
  expect(whole.contextTruncated).toBe(false);
  expect(whole.contextBytes).toBe(utf8(text));
  expect(whole.contextSha256).toBe(sha256(text));
  const entries = await historyEntries(medium.id);
  const evidence = entries.find(entry => entry.evidence === text);
  expect(evidence).toBeDefined();
  expect(evidence!.evidenceTruncated).toBe(false);
  expect(evidence!.evidenceBytes).toBe(utf8(text));
  expect(evidence!.evidenceSha256).toBe(sha256(text));
});

test('every page re-checks the caller: an identity revoked mid-traversal is refused on its next page as unauthorized (C4)', async () => {
  const revoked = `qp-revoked-${suffix}`;
  const credential = await enrollment.enroll(revoked, 'owner', ['execute', 'review', 'manage']);
  const first = await core.contextView(credential, { tag: goalId, pageSize: 5 });
  expect(first.page?.nextCursor).toBeDefined();
  await enrollment.revoke(revoked);
  await expectRefused(core.contextView(credential, { tag: goalId, pageSize: 5, cursor: first.page!.nextCursor }), 'unauthorized', /Invalid credential/);
});

test('a gm summary read while writers run is one consistent read: every answer passes its integrity checks (C5)', async () => {
  const writers = Promise.all(Array.from({ length: 3 }, (_, w) => (async () => {
    for (let i = 0; i < 5; i++) {
      const task = await core.createTask(gm, {
        title: `汇总并发样例 ${w}-${i} ${unit}`, context: `并发写入 ${w}-${i}`, executorRole: 'engineering', reviewerRole: 'qa', tag: goalId, idempotencyKey: key(`sum-${w}-${i}`),
      });
      await addAudit(task.id, `并发审计 ${w}-${i}`);
    }
  })()));
  const answers: Array<Awaited<ReturnType<typeof core.adminSummary>>> = [];
  while (answers.length < 8) answers.push(await core.adminSummary(gm, { tag: goalId }));
  await writers;
  for (const summary of answers) {
    expect(summary.integrity.complete).toBe(true);
    expect(summary.integrity.checks).toEqual({ taskCountsMatchRows: true, auditCountsMatchRows: true, statesKnown: true, repeatableRead: true });
  }
  // After the writers finish, the summary counts every task of the goal that the database holds.
  const [rows] = await database.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM task WHERE tag = $goal GROUP ALL;', { goal: goalId });
  const final = await core.adminSummary(gm, { tag: goalId });
  expect(final.integrity.complete).toBe(true);
  expect(final.integrity.taskRows).toBe(rows?.[0]?.n ?? 0);
});

test('a gm summary read while tasks change state and audit entries arrive is one consistent read: the task total holds, audit counts never fall (C5)', async () => {
  const busy = await core.createTask(gm, { title: `汇总移动目标 ${suffix}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key('goal-summary-moves') });
  // The goal needs at least six tasks of its own for the writers to move between states.
  for (let i = 0; i < 6; i++) {
    await core.createTask(gm, {
      title: `汇总移动样例 ${i} ${unit}`, context: `移动前的正文 ${i}`, executorRole: 'engineering', reviewerRole: 'qa', tag: busy.id, idempotencyKey: key(`moves-${i}`),
    });
  }
  const [rows] = await database.db.query<[Array<{ id: RecordId }>]>('SELECT id FROM task WHERE tag = $goal;', { goal: busy.id });
  const members = (rows ?? []).map(row => asId(row.id));
  const total = members.length;
  expect(total).toBeGreaterThanOrEqual(6);
  const writers = (async () => {
    for (let round = 0; round < 6; round++) {
      // Half the goal's tasks move between states on every round; the number of tasks never changes.
      const state = round % 2 === 0 ? 'done' : 'ready';
      await database.db.query('UPDATE task SET state = $state WHERE id IN $ids;', { state, ids: members.slice(0, Math.ceil(total / 2)).map(member => id('task', member)) });
      await addAudit(members[round % total]!, `汇总移动审计 ${round}`);
    }
  })();
  const answers: Array<Awaited<ReturnType<typeof core.adminSummary>>> = [];
  while (answers.length < 10) answers.push(await core.adminSummary(gm, { tag: busy.id }));
  await writers;
  let previousAudit = -1;
  let previousCutoff = '';
  for (const summary of answers) {
    expect(summary.integrity.complete).toBe(true);
    expect(summary.integrity.taskRows).toBe(total);
    expect(Object.values(summary.tasks).reduce((sum, n) => sum + n, 0)).toBe(total);
    expect(summary.integrity.auditRows).toBeGreaterThanOrEqual(previousAudit);
    expect(summary.cutoffAt >= previousCutoff).toBe(true);
    previousAudit = summary.integrity.auditRows;
    previousCutoff = summary.cutoffAt;
  }
  // Once the writers have finished, a fresh read counts every audit entry they wrote and agrees with the rows.
  const final = await core.adminSummary(gm, { tag: busy.id });
  expect(final.integrity.complete).toBe(true);
  expect(final.integrity.auditRows).toBeGreaterThanOrEqual(previousAudit);
  expect(final.integrity.auditRows).toBeGreaterThanOrEqual(6);
});

test('UTF-8 survives every page: Chinese titles and emoji parse back intact', async () => {
  const titles: string[] = [];
  await drain(async cursor => {
    const page = await core.contextView(gm, { tag: goalId, pageSize: 100, ...(cursor ? { cursor } : {}) });
    const parsed = JSON.parse(JSON.stringify(page)) as typeof page;
    for (const task of parsed.tasks!) {
      expect(String(task.context)).not.toContain('�');
      titles.push(String(task.title));
    }
    return { items: parsed.tasks!.map(task => String(task.id)), nextCursor: page.page!.nextCursor };
  });
  expect(titles.some(title => title.includes('分页样例') && title.includes('🙂'))).toBe(true);
});

test('a traversal keeps its snapshot: rows created mid-way are excluded and in-place updates neither repeat nor drop rows', async () => {
  const snapshot = await workingIds(goalId);
  const first = await core.contextView(gm, { tag: goalId, pageSize: 50 });
  const late: string[] = [];
  for (let i = 0; i < 3; i++) {
    const created = await core.createTask(gm, {
      title: `迟到样例 ${i}`, context: `创建于快照之后 ${i}`, executorRole: 'engineering', reviewerRole: 'qa', tag: goalId, idempotencyKey: key(`late${i}`),
    });
    late.push(created.id);
  }
  await database.db.query('UPDATE task SET title = title + " · 已更新" WHERE tag = $goal;', { goal: goalId });
  // Continue from the first page's cursor: the traversal started before the mid-way writes above.
  const rest = await drain(async cursor => {
    const page = await core.contextView(gm, { tag: goalId, pageSize: 50, ...(cursor ? { cursor } : {}) });
    return { items: page.tasks ?? [], nextCursor: page.page!.nextCursor };
  }, first.page!.nextCursor);
  const everything = [...first.tasks!, ...rest];
  const seen = everything.map(task => String(task.id));
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.every(taskId => snapshot.includes(taskId))).toBe(true);
  expect(seen.length).toBe(snapshot.length);
  expect(seen.some(taskId => late.includes(taskId))).toBe(false);
  // The listing shows the titles it was taken with, not the ones written after it.
  expect(everything.some(task => String(task.title).includes('已更新'))).toBe(false);
});

test('cursors are bound to the caller and the query, are sealed, and expire with their listing (C4)', async () => {
  const first = await core.contextView(gm, { tag: goalId, pageSize: 10 });
  const token = first.page!.nextCursor!;
  await expectRefused(core.contextView(gm, { tag: goalId, pageSize: 10, cursor: token.replace(/\.[^.]+$/, '.') }), 'invalid', /verification|malformed/);
  await expectRefused(core.contextView(eng, { tag: goalId, pageSize: 10, cursor: token }), 'forbidden', /another caller/);
  await expectRefused(core.contextView(gm, { tag: goalId, state: 'ready', pageSize: 10, cursor: token }), 'forbidden', /another query/);
  await expectRefused(core.contextView(gm, { tag: goalId, pageSize: 10, fields: ['id'], cursor: token }), 'forbidden', /another query/);
  const flipped = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
  await expectRefused(core.contextView(gm, { tag: goalId, pageSize: 10, cursor: flipped }), 'invalid', /verification|malformed/);
  // A cursor sealed with the stored key but already past its expiry names a listing that is gone.
  const keyRow = await database.db.select<{ key: string }>(id('company_meta', 'cursor_key'));
  const sealKey = Buffer.from(keyRow!.key, 'base64url');
  const expired = sealCursor({
    v: 1, k: 'context', c: ids.gm, q: queryDigest('context', { state: null, goalId, role: null, since: null, fields: null }),
    sid: randomUUID(), seq: 0, exp: Date.now() - 1_000,
  }, sealKey);
  await expectRefused(core.contextView(gm, { tag: goalId, pageSize: 10, cursor: expired }), 'snapshot_gone', /expired/);
  // The unmodified cursor still works for its own caller and query.
  const again = await core.contextView(gm, { tag: goalId, pageSize: 10, cursor: token });
  expect(again.tasks!.length).toBeGreaterThan(0);
});

test('a listing taken under one role is refused under another, and resumes once the role is back (C4)', async () => {
  const first = await core.contextView(gm, { tag: goalId, pageSize: 5 });
  const token = first.page!.nextCursor!;
  const record = id('query_snapshot', String(cursorBody(token).sid));
  await database.db.query('UPDATE ONLY $record SET role = "engineering";', { record });
  await expectRefused(core.contextView(gm, { tag: goalId, pageSize: 5, cursor: token }), 'forbidden', /another role/);
  await database.db.query('UPDATE ONLY $record SET role = "owner";', { record });
  const resumed = await core.contextView(gm, { tag: goalId, pageSize: 5, cursor: token });
  expect(resumed.tasks!.length).toBe(5);
});

test('task history pages stay inside the budget and yield every entry once; evidence over the page budget is cut, flagged and reassembles (C2, C3, C4)', async () => {
  const task = await core.createTask(gm, {
    title: '历史分页样例', context: '历史分页夹具', executorRole: 'engineering', reviewerRole: 'qa', tag: goalId, idempotencyKey: key('hist'),
  });
  for (let i = 0; i < 29; i++) await addAudit(task.id, codePoints(6_000, `证据第${i}条 `));
  const oversized = '超'.repeat(20_000); // 60,000 bytes: larger than a page can hold on its own
  await addAudit(task.id, oversized);
  const entries = await historyEntries(task.id);
  expect(new Set(entries.map(entry => entry.auditId)).size).toBe(entries.length);
  expect(entries.length).toBe(await historyRows(task.id));
  const cut = entries.find(entry => entry.evidenceTruncated === true);
  expect(cut).toBeDefined();
  expect(cut!.evidenceBytes).toBe(utf8(oversized));
  expect(cut!.evidenceSha256).toBe(sha256(oversized));
  expect(utf8(cut!.evidence!)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(oversized.startsWith(cut!.evidence!)).toBe(true);
  expect(cut!.evidenceNextOffset).toBe(utf8(cut!.evidence!));
  // The rest reads by segment from the flagged offset, pinned to the digest; prefix plus rest is the whole evidence.
  let rest = '';
  let offset: number | null = cut!.evidenceNextOffset as number;
  while (offset !== null) {
    const segment = await core.taskText(gm, { taskId: task.id, field: 'evidence', auditId: cut!.auditId, offset, limit: 4_096, expectSha256: sha256(oversized) });
    rest += segment.text;
    offset = segment.nextOffset;
  }
  expect(cut!.evidence! + rest).toBe(oversized);
});

test('the gm summary counts the fixture at a cutoff, reads repeatably, and everyone else is refused (C5)', async () => {
  const [rows] = await database.db.query<[Array<{ id: RecordId }>]>('SELECT id FROM task WHERE tag = $goal;', { goal: goalId });
  const summary = await core.adminSummary(gm, { tag: goalId });
  const counted = Object.values(summary.tasks).reduce((sum, n) => sum + n, 0);
  expect(counted).toBe((rows ?? []).length);
  expect(summary.cutoffAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(summary.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(summary.scope.tasks).toContain('since does not apply');
  expect(summary.integrity.complete).toBe(true);
  expect(summary.integrity.checks).toEqual({ taskCountsMatchRows: true, auditCountsMatchRows: true, statesKnown: true, repeatableRead: true });
  expect(summary.integrity.taskRows).toBe(counted);
  await expectRefused(core.adminSummary(eng, {}), 'forbidden', /Only owner/);
  await expectRefused(core.adminSummary(cs, {}), 'forbidden', /Only owner/);
});

test('audit counts cover [since, cutoffAt] and task counts ignore the window; with goalId the audit counts are that goal\'s (C5, AC04)', async () => {
  const wide = '2000-01-01T00:00:00.000Z';
  const everything = await core.adminSummary(gm, { tag: goalId, since: wide });
  // With goalId the audit counts are that goal's tasks' entries, so they are counted here through those tasks.
  const [audits] = await database.db.query<[Array<{ n: number }>]>(
    'SELECT count() AS n FROM audit WHERE task IN (SELECT VALUE id FROM task WHERE tag = $goal) AND at >= <datetime>$since AND at <= <datetime>$cutoff GROUP ALL;',
    { goal: goalId, since: wide, cutoff: everything.cutoffAt });
  const [allAudits] = await database.db.query<[Array<{ n: number }>]>(
    'SELECT count() AS n FROM audit WHERE at >= <datetime>$since AND at <= <datetime>$cutoff GROUP ALL;',
    { since: wide, cutoff: everything.cutoffAt });
  expect(everything.since).toBe(wide);
  expect(everything.scope.audit).toContain('this tag');
  expect(everything.integrity.auditRows).toBeGreaterThan(0);
  expect(everything.integrity.auditRows).toBe(audits?.[0]?.n ?? 0);
  expect(everything.integrity.auditRows).toBeLessThan(allAudits?.[0]?.n ?? 0);
  const futureSince = new Date(Date.now() + 3_600_000).toISOString();
  const future = await core.adminSummary(gm, { tag: goalId, since: futureSince });
  expect(future.since).toBe(futureSince);
  expect(future.integrity.auditRows).toBe(0);
  expect(future.tasks).toEqual(everything.tasks);
});

test('a role that may see no task gets an empty page, and an empty legacy answer, never the company listing', async () => {
  const page = await core.contextView(cs, { tag: goalId, pageSize: 5 });
  expect(page.tasks).toEqual([]);
  expect(page.page!.hasMore).toBe(false);
  const legacy = await core.contextView(cs, { tag: goalId });
  expect(legacy.tasks).toEqual([]);
  expect(legacy.page).toBeUndefined();
});

test('invalid arguments are refused before any query runs', async () => {
  await expectRefused(core.contextView(gm, { pageSize: 0 }), 'invalid', /pageSize/);
  await expectRefused(core.contextView(gm, { pageSize: 1000 }), 'invalid', /pageSize/);
  await expectRefused(core.contextView(gm, { pageSize: 1.5 }), 'invalid', /pageSize/);
  await expectRefused(core.contextView(gm, { state: 'bogus' }), 'invalid', /state/);
  await expectRefused(core.contextView(gm, { role: 'root' }), 'invalid', /role/);
  await expectRefused(core.contextView(gm, { fields: ['password'] }), 'invalid', /unknown task field/);
  await expectRefused(core.contextView(gm, { since: 'yesterday' }), 'invalid', /since/);
  await expectRefused(core.contextView(gm, { cursor: 'x'.repeat(3000) }), 'invalid', /cursor/);
  await expectRefused(core.taskText(gm, { taskId: 'missing', field: 'bogus' }), 'invalid', /field/);
  await expectRefused(core.taskText(gm, { taskId: 'missing', field: 'context', offset: -1 }), 'invalid', /offset/);
  await expectRefused(core.taskText(gm, { taskId: 'missing', field: 'context', limit: 999_999 }), 'invalid', /limit/);
});

test('reads add no task, audit or outbox state; the only new rows are stored listings and the cursor secret (RB01)', async () => {
  const listingIds = async () => {
    const [rows] = await database.db.query<[Array<{ id: RecordId }>]>('SELECT id FROM query_snapshot;');
    return (rows ?? []).map(row => String(row.id.id));
  };
  const before = { task: await countRows('task'), audit: await countRows('audit'), outbox: await countRows('outbox') };
  const listingsBefore = await listingIds();
  await core.contextView(gm, { tag: goalId, pageSize: 10 });
  await core.historyView(gm, expectedWorking[0]!, { pageSize: 5 });
  await core.adminSummary(gm, { tag: goalId });
  const emptyWorktrees = await core.worktreePage(gm, { pageSize: 5 });
  const after = { task: await countRows('task'), audit: await countRows('audit'), outbox: await countRows('outbox') };
  expect(after).toEqual(before);
  // Each non-empty paged first page stored exactly one listing; the worktree registry is empty in this fixture, and an empty
  // first page stores nothing at all (SYS01 AC02 production return). The per-identity cap may evict older listings of the same
  // caller, so the check is on the new listings, not on the total.
  expect(emptyWorktrees.worktrees).toEqual([]);
  expect(emptyWorktrees.page).toMatchObject({ returned: 0, hasMore: false, total: 0 });
  const created = (await listingIds()).filter(listing => !listingsBefore.includes(listing));
  expect(created.length).toBe(2);
  const keyRow = await database.db.select<{ key?: string }>(id('company_meta', 'cursor_key'));
  expect(keyRow?.key).toBeString();
});

test('sck relay round trip: the real comm client returns one complete, budgeted JSON page', async () => {
  const relayed = await relay('get_context', { tag: goalId, pageSize: 37 }, args => core.contextView(gm, args));
  expect(relayed.exit).toBe(0);
  expect(relayed.out.endsWith('\n')).toBe(true);
  expect(Buffer.byteLength(relayed.out, 'utf8')).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  const parsed = JSON.parse(relayed.out) as { tasks: Array<Record<string, unknown>>; page: { returned: number } };
  expect(parsed.page.returned).toBe(parsed.tasks.length);
  expect(parsed.tasks.length).toBeGreaterThan(0);
  expect(parsed.tasks.some(task => String(task.title).includes('分页样例'))).toBe(true);
});

test('an over-budget answer is refused as JSON with a non-zero exit, never a cut stream', async () => {
  const relayed = await relay('get_context', {}, async () => ({ blob: '中文🙂'.repeat(30_000) }));
  expect(relayed.exit).toBe(1);
  const parsed = JSON.parse(relayed.out) as { ok: boolean; error: string };
  expect(parsed.ok).toBe(false);
  expect(parsed.error).toContain('response_too_large');
});

test('an invalid query comes back as a JSON error with the reason on stderr', async () => {
  const relayed = await relay('get_context', { pageSize: 0 }, args => core.contextView(gm, args));
  expect(relayed.exit).toBe(1);
  expect(JSON.parse(relayed.out)).toMatchObject({ ok: false });
  expect(relayed.stderr).toContain('pageSize');
});

test('state, role and time filters narrow the listing, and the cursor stays bound to them', async () => {
  const [readyRows] = await database.db.query<[Array<{ id: RecordId }>]>(
    "SELECT id FROM task WHERE tag = $goal AND state = 'ready';", { goal: goalId });
  const readyDb = (readyRows ?? []).map(row => asId(row.id));
  const readySeen = await drain(async cursor => {
    const page = await core.contextView(gm, { tag: goalId, state: 'ready', pageSize: 100, ...(cursor ? { cursor } : {}) });
    expect(page.tasks!.every(task => task.state === 'ready')).toBe(true);
    return { items: page.tasks!.map(task => String(task.id)), nextCursor: page.page!.nextCursor };
  });
  expect([...readySeen].sort()).toEqual([...readyDb].sort());
  const engineering = await core.contextView(gm, { tag: goalId, role: 'engineering', pageSize: 100 });
  expect(engineering.tasks!.every(task => task.executorRole === 'engineering' || task.reviewerRole === 'engineering')).toBe(true);
  expect(engineering.tasks!.length).toBeGreaterThan(0);
  const future = await core.contextView(gm, { tag: goalId, since: new Date(Date.now() + 3_600_000).toISOString() });
  expect(future.tasks).toEqual([]);
  const someCursor = (await core.contextView(gm, { tag: goalId, state: 'ready', pageSize: 5 })).page!.nextCursor!;
  await expectRefused(core.contextView(gm, { tag: goalId, pageSize: 5, cursor: someCursor }), 'forbidden', /another query/);
});

test('list_worktrees is compact and paged: released references are counted, listed only on request, and the cursor is bound (C1, C4)', async () => {
  const reference = (taskId: string, state: string) => ({
    taskId, employee: 'eng', deliveryId: 'd', fence: 1, intent: { kind: 'code', lane: 'x' }, state, at: '2026-10-19T00:00:00Z',
  });
  const views = Array.from({ length: 60 }, (_, index) => ({
    id: `wt-${index}`, repo: '/repo/ops', worktreePath: `/tmp/wt-${String(index).padStart(3, '0')}`, mode: 'exclusive', branch: `task/${index}`,
    createdAt: '2026-10-19T00:00:00Z', lastUsedAt: '2026-10-19T00:00:00Z', status: 'present', deletable: false, reasons: [],
    references: [reference(`t${index}`, 'active'), ...Array.from({ length: 4 }, (_, r) => reference(`old${index}-${r}`, 'released'))],
  }));
  const original = core.listWorktrees;
  core.listWorktrees = async () => views as never;
  try {
    const first = await core.worktreePage(gm, { pageSize: 25 });
    expect(first.worktrees.length).toBe(25);
    expect(first.worktrees.every(worktree => (worktree.references as unknown[]).length === 1)).toBe(true);
    expect(first.worktrees.every(worktree => worktree.releasedReferences === 4)).toBe(true);
    const rest = await drain(async cursor => {
      const page = await core.worktreePage(gm, { pageSize: 25, ...(cursor ? { cursor } : {}) });
      return { items: page.worktrees.map(worktree => String(worktree.worktreePath)), nextCursor: page.page.nextCursor };
    }, first.page.nextCursor);
    const all = [...first.worktrees.map(worktree => String(worktree.worktreePath)), ...rest];
    expect(new Set(all).size).toBe(60);
    expect(all).toEqual(views.map(view => view.worktreePath).sort());
    const full = await core.worktreePage(gm, { pageSize: 5, includeReleased: true });
    expect(full.worktrees.every(worktree => (worktree.references as unknown[]).length === 5)).toBe(true);
    await expectRefused(core.worktreePage(gm, { pageSize: 25, includeReleased: true, cursor: first.page.nextCursor! }), 'forbidden', /another query/);
  } finally {
    core.listWorktrees = original;
  }
});

test('a worktree listing keeps its rows while the registry changes between pages (C4)', async () => {
  const view = (index: number, root: string) => ({
    id: `${root}-${index}`, repo: '/repo/ops', worktreePath: `/tmp/${root}-${String(index).padStart(3, '0')}`, mode: 'exclusive', branch: `task/${root}${index}`,
    createdAt: '2026-10-19T00:00:00Z', lastUsedAt: '2026-10-19T00:00:00Z', status: 'present', deletable: false, reasons: [],
    references: [{ taskId: `t-${root}-${index}`, employee: 'eng', deliveryId: 'd', fence: 1, intent: { kind: 'code', lane: 'x' }, state: 'active', at: '2026-10-19T00:00:00Z' }],
  });
  const before = Array.from({ length: 60 }, (_, index) => view(index, 'before'));
  const after = Array.from({ length: 80 }, (_, index) => view(index, 'after'));
  const original = core.listWorktrees;
  try {
    core.listWorktrees = async () => before as never;
    const first = await core.worktreePage(gm, { pageSize: 20 });
    // The registry changes between the pages of one traversal.
    core.listWorktrees = async () => after as never;
    const rest = await drain(async cursor => {
      const page = await core.worktreePage(gm, { pageSize: 20, ...(cursor ? { cursor } : {}) });
      return { items: page.worktrees.map(worktree => String(worktree.worktreePath)), nextCursor: page.page.nextCursor };
    }, first.page.nextCursor);
    const all = [...first.worktrees.map(worktree => String(worktree.worktreePath)), ...rest];
    expect(all).toEqual(before.map(item => item.worktreePath).sort());
    // A new listing reads the registry as it now stands.
    const fresh = await core.worktreePage(gm, { pageSize: 100 });
    expect(fresh.page.total).toBe(80);
  } finally {
    core.listWorktrees = original;
  }
});

test('a caller that drops mid-traversal retries the same cursor on a fresh connection and gets the same page (AC05)', async () => {
  const expected = await workingIds(goalId);
  const pageSize = 37;
  const first = await core.contextView(gm, { tag: goalId, pageSize });
  const cursor = first.page!.nextCursor!;
  // The answer to this page is lost in transit: nothing is kept on the caller side, so it asks again.
  const lost = await core.contextView(gm, { tag: goalId, pageSize, cursor });
  // A fresh connection (a new core with no state of its own) retries with the same cursor.
  const fresh = new SurrealCompanyCore(database);
  const retried = await fresh.contextView(gm, { tag: goalId, pageSize, cursor });
  // The retry is the same page of the same listing: same tasks, same snapshot, same continuation.
  expect(JSON.parse(JSON.stringify(retried.tasks))).toEqual(JSON.parse(JSON.stringify(lost.tasks)));
  expect(retried.page!.snapshotAt).toBe(lost.page!.snapshotAt);
  expect(cursorBody(retried.page!.nextCursor!)).toEqual(cursorBody(lost.page!.nextCursor!));
  // Through real comm client processes: the first caller is killed after its request left, then a new process retries.
  const dir = newCommDir();
  const dropped = await relayAndDrop(dir, 'get_context', { tag: goalId, pageSize, cursor }, args => core.contextView(gm, args));
  expect(dropped).toEqual({ tag: goalId, pageSize, cursor });
  const relayed = await relay('get_context', { tag: goalId, pageSize, cursor }, args => fresh.contextView(gm, args), dir);
  expect(relayed.exit).toBe(0);
  const page = JSON.parse(relayed.out) as { tasks: Array<{ id: unknown }>; page: { nextCursor?: string } };
  expect(page.tasks!.map(task => String(task.id))).toEqual(lost.tasks!.map(task => String(task.id)));
  // Continuing from the retried page reaches every task of the listing exactly once.
  const rest = await drain(async next => {
    const more = await fresh.contextView(gm, { tag: goalId, pageSize, ...(next ? { cursor: next } : {}) });
    return { items: more.tasks!.map(task => String(task.id)), nextCursor: more.page!.nextCursor };
  }, page.page.nextCursor);
  const seen = [...first.tasks!.map(task => String(task.id)), ...page.tasks!.map(task => String(task.id)), ...rest];
  expect(new Set(seen).size).toBe(seen.length);
  expect([...seen].sort()).toEqual([...expected].sort());
});

test('state moves, goal and role changes, and new tasks mid-traversal change nothing the listing delivers (C4)', async () => {
  const members = await workingIds(goalId);
  const [before] = await database.db.query<[Array<{ id: RecordId; state: string; executor_role: string }>]>(
    'SELECT id, state, executor_role FROM task WHERE tag = $goal;', { goal: goalId });
  const stateAt = new Map((before ?? []).map(row => [asId(row.id), row.state]));
  const roleAt = new Map((before ?? []).map(row => [asId(row.id), row.executor_role]));
  const first = await core.contextView(gm, { tag: goalId, pageSize: 40 });
  const other = await core.createTask(gm, { title: `分页另一目标 ${suffix}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key('goal-other') });
  // Mid-way: 100 tasks finish, 50 move to another goal, 50 change executor role, and three new tasks arrive.
  const finished = members.slice(0, 100).map(member => id('task', member));
  const moved = members.slice(100, 150).map(member => id('task', member));
  const rerolled = members.slice(150, 200).map(member => id('task', member));
  await database.db.query('UPDATE task SET state = "done" WHERE id IN $ids;', { ids: finished });
  await database.db.query('UPDATE task SET tag = $goal WHERE id IN $ids;', { goal: other.id, ids: moved });
  await database.db.query('UPDATE task SET executor_role = "qa" WHERE id IN $ids;', { ids: rerolled });
  const newcomers: string[] = [];
  for (let i = 0; i < 3; i++) {
    const created = await core.createTask(gm, {
      title: `中途样例 ${i}`, context: `中途新增 ${i}`, executorRole: 'engineering', reviewerRole: 'qa', tag: goalId, idempotencyKey: key(`mid${i}`),
    });
    newcomers.push(created.id);
  }
  const rest = await drain(async cursor => {
    const page = await core.contextView(gm, { tag: goalId, pageSize: 40, ...(cursor ? { cursor } : {}) });
    return { items: page.tasks ?? [], nextCursor: page.page!.nextCursor };
  }, first.page!.nextCursor);
  const delivered = [...first.tasks!, ...rest];
  const seen = delivered.map(task => String(task.id));
  expect(new Set(seen).size).toBe(seen.length);
  expect([...seen].sort()).toEqual([...members].sort());
  expect(seen.some(taskId => newcomers.includes(taskId))).toBe(false);
  // Each delivered row shows the state, goal and role it had when the listing was taken.
  for (const task of delivered) {
    const taskId = String(task.id);
    expect(task.state).toBe(stateAt.get(taskId));
    expect(task.tag).toBe(goalId);
    expect(task.executorRole).toBe(roleAt.get(taskId));
  }
});

test('a full traversal keeps every page inside the budget; heap growth is a measured upper bound (AC05 resource)', async () => {
  const expected = await workingIds(goalId);
  const pageSize = 25;
  Bun.gc(true);
  const heapBefore = process.memoryUsage().heapUsed;
  let heapPeak = heapBefore;
  const pages: Array<{ bytes: number; rows: number; ms: number }> = [];
  const seen = await drain(async cursor => {
    const started = performance.now();
    const page = await core.contextView(gm, { tag: goalId, pageSize, ...(cursor ? { cursor } : {}) });
    const ms = performance.now() - started;
    pages.push({ bytes: bytesOf(page), rows: page.tasks!.length, ms });
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    return { items: page.tasks!.map(task => String(task.id)), nextCursor: page.page!.nextCursor };
  });
  Bun.gc(true);
  const heapAfter = process.memoryUsage().heapUsed;
  const mib = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  const timings = pages.map(page => page.ms).sort((a, b) => a - b);
  const report = {
    tasks: seen.length, pageSize, pages: pages.length, maxRows: Math.max(...pages.map(page => page.rows)),
    maxPageBytes: Math.max(...pages.map(page => page.bytes)), budgetBytes: RESPONSE_BUDGET_BYTES,
    pageMsP50: Math.round(timings[Math.floor(timings.length / 2)]!), pageMsMax: Math.round(timings.at(-1)!),
    heapBaselineMiB: mib(heapBefore), heapPeakMiB: mib(heapPeak), heapAfterGcMiB: mib(heapAfter),
    heapDeltaUpperBoundMiB: mib(heapPeak - heapBefore),
  };
  console.log(`AC05 resource ${JSON.stringify(report)}`);
  expect(report.maxPageBytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(report.maxRows).toBeLessThanOrEqual(pageSize);
  expect(pages.length).toBeGreaterThanOrEqual(Math.ceil(expected.length / pageSize));
  expect(new Set(seen).size).toBe(seen.length);
  expect([...seen].sort()).toEqual([...expected].sort());
  // A guard against unbounded accumulation across pages, not a performance target.
  expect(heapPeak - heapBefore).toBeLessThan(64 * 1024 * 1024);
});

test('a listing past its expiry is refused as snapshot_gone, and the sweep removes it with its rows (C4)', async () => {
  const first = await core.contextView(gm, { tag: goalId, pageSize: 3 });
  const token = first.page!.nextCursor!;
  const sid = String(cursorBody(token).sid);
  await database.db.query('UPDATE ONLY $record SET expires_ms = 0;', { record: id('query_snapshot', sid) });
  await expectRefused(core.contextView(gm, { tag: goalId, pageSize: 3, cursor: token }), 'snapshot_gone', /start the listing again/);
  const store = new SnapshotStore(database.db);
  expect(await store.sweep()).toBeGreaterThanOrEqual(1);
  const gone = await database.db.select(id('query_snapshot', sid));
  expect(gone ?? null).toBeNull();
  const [rows] = await database.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM query_snapshot_row WHERE snapshot = $snapshot GROUP ALL;', { snapshot: sid });
  expect(rows?.[0]?.n ?? 0).toBe(0);
});

test('an identity past its listing cap loses its oldest listing, which then fails as snapshot_gone (C4)', async () => {
  const first = await core.contextView(gm, { tag: goalId, state: 'ready', pageSize: 5 });
  const oldest = first.page!.nextCursor!;
  // Six more listings for the same identity, each under its own query, push the first past the cap of four.
  for (let i = 0; i < 6; i++) {
    await core.contextView(gm, { tag: goalId, since: new Date(Date.now() - (i + 1) * 60_000).toISOString(), pageSize: 5 });
  }
  await expectRefused(core.contextView(gm, { tag: goalId, state: 'ready', pageSize: 5, cursor: oldest }), 'snapshot_gone', /start the listing again/);
  const [owned] = await database.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM query_snapshot WHERE owner = $owner GROUP ALL;', { owner: ids.gm });
  expect(owned?.[0]?.n ?? 0).toBeLessThanOrEqual(4);
});

test('a store at its listing capacity refuses the new listing as temporarily_unavailable and evicts nothing (C4)', async () => {
  const store = new SnapshotStore(database.db);
  await store.sweep();
  const census = await store.census();
  const owner = `qp-cap-${suffix}`;
  const tight = new SnapshotStore(database.db, { maxListings: census.listings + 1, maxPerOwner: 4 });
  const now = new Date().toISOString();
  const body = [JSON.stringify({ n: 1 })];
  const held = await tight.create({ owner, kind: 'context', digest: 'cap-held', role: 'owner', takenAt: now, bodies: body });
  await expectRefused(
    tight.create({ owner, kind: 'context', digest: 'cap-refused', role: 'owner', takenAt: now, bodies: body }),
    'temporarily_unavailable', /capacity/);
  expect((await tight.census()).listings).toBe(census.listings + 1);
  const read = await tight.read({ id: held.id, owner, kind: 'context', digest: 'cap-held', role: 'owner', after: 0, limit: 10 });
  expect(read.rows.length).toBe(1);
  await tight.remove(held.id);
});

test('a listing abandoned while it was being written is swept with its rows (C4)', async () => {
  const store = new SnapshotStore(database.db);
  const abandoned = randomUUID();
  await database.db.query(
    'CREATE ONLY $record CONTENT { owner: "qp-abandoned", kind: "context", digest: "abandoned", role: "owner", state: "building", row_count: 1, byte_count: 2, taken_at: "2026-01-01T00:00:00Z", created_ms: 1, expires_ms: 9999999999999 };',
    { record: id('query_snapshot', abandoned) });
  await database.db.query('CREATE query_snapshot_row CONTENT { snapshot: $snapshot, seq: 1, body: "{}" };', { snapshot: abandoned });
  await store.sweep();
  const gone = await database.db.select(id('query_snapshot', abandoned));
  expect(gone ?? null).toBeNull();
  const [rows] = await database.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM query_snapshot_row WHERE snapshot = $snapshot GROUP ALL;', { snapshot: abandoned });
  expect(rows?.[0]?.n ?? 0).toBe(0);
});

test('list_worktrees without pageSize or cursor keeps the array shape; an over-budget array is refused as JSON, never cut (C1)', async () => {
  const view = (index: number, path: string) => ({
    id: `wt-${index}`, repo: '/repo/ops', worktreePath: path, mode: 'exclusive', branch: `task/${index}`,
    createdAt: '2026-10-19T00:00:00Z', lastUsedAt: '2026-10-19T00:00:00Z', status: 'present', deletable: false, reasons: [],
    references: [
      { taskId: `t${index}`, employee: 'eng', deliveryId: 'd', fence: 1, intent: { kind: 'code', lane: 'x' }, state: 'active', at: '2026-10-19T00:00:00Z' },
      { taskId: `old${index}`, employee: 'eng', deliveryId: 'd', fence: 1, intent: { kind: 'code', lane: 'x' }, state: 'released', at: '2026-10-19T00:00:00Z' },
    ],
  });
  // 40 compact entries are about 35 KiB in both copies: the largest complete array the budget admits for this shape.
  const small = Array.from({ length: 40 }, (_, index) => view(index, `/tmp/wt-${String(index).padStart(3, '0')}`));
  const original = core.listWorktrees;
  try {
    core.listWorktrees = async () => small as never;
    const list = await core.worktreeList(gm, {});
    expect(Array.isArray(list)).toBe(true);
    expect(list.map(worktree => String(worktree.worktreePath))).toEqual(small.map(item => item.worktreePath));
    expect(list.every(worktree => (worktree.references as unknown[]).length === 1 && worktree.releasedReferences === 1)).toBe(true);
    const relayed = await relay('list_worktrees', {}, args => core.worktreeList(gm, args));
    expect(relayed.exit).toBe(0);
    expect(Array.isArray(JSON.parse(relayed.out))).toBe(true);
    // An array cannot carry a page: over the budget it is refused whole, as JSON, and nothing is dropped silently.
    const large = Array.from({ length: 300 }, (_, index) => view(index, `/tmp/large-${String(index).padStart(4, '0')}/${'路径'.repeat(24)}`));
    core.listWorktrees = async () => large as never;
    const refused = await relay('list_worktrees', {}, args => core.worktreeList(gm, args));
    expect(refused.exit).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({ ok: false });
    expect(refused.out).toContain('response_too_large');
    // A paged call over the same inventory returns the page object, which always fits the budget.
    const paged = await core.worktreePage(gm, { pageSize: 25 });
    expect(Object.keys(paged).sort()).toEqual(['page', 'worktrees']);
    expect(bytesOf(paged)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  } finally {
    core.listWorktrees = original;
  }
});

/**
 * The QA R1 production shape: 37 worktrees, the 18th a shared tree with one active and 128 released references. Long ids
 * and nanosecond timestamps make the entry larger than a page item, as the production shared tree was.
 */
function longReferences(root: string) {
  const at = '2026-10-21T17:01:51.123456789Z';
  const reference = (index: number, state: 'active' | 'released') => ({
    taskId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    employee: 'engineering-fixture-01',
    deliveryId: `delivery-${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
    fence: 1, intent: { kind: 'code' as const, lane: 'ops-governance' }, state, at,
  });
  const views = Array.from({ length: 37 }, (_, index) => ({
    id: `${root}-${index}`, repo: '/repo/ops', worktreePath: `/tmp/${root}-${String(index).padStart(3, '0')}`,
    mode: index === 17 ? 'shared' as const : 'exclusive' as const, branch: `task/${root}${index}`,
    createdAt: at, lastUsedAt: at, status: 'present' as const, deletable: false, reasons: [],
    references: index === 17
      ? [reference(0, 'active'), ...Array.from({ length: 128 }, (_, r) => reference(r + 1, 'released'))]
      : [reference(index, 'active')],
  }));
  const shared = views[17]!;
  return { views, shared, fullText: JSON.stringify(shared.references) };
}

test('a worktree whose references alone exceed a page is cut and flagged, pageSize 1 still traverses all 37 rows, and read_worktree_refs reassembles the whole list (SYS01 R1, AC03/AC05)', async () => {
  const { views, shared, fullText } = longReferences('r1');
  const original = core.listWorktrees;
  core.listWorktrees = async () => views as never;
  try {
    // The QA repro: a page may no longer hold every row, because the cut row is large, but it must hold rows and carry a
    // cursor, never fail. pageSize 1 is the variant that failed before.
    const first = await core.worktreePage(gm, { pageSize: 100, includeReleased: true });
    expect(first.page.total).toBe(37);
    expect(first.page.returned).toBeGreaterThan(0);
    expect(bytesOf(first)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const seen = await drain(async cursor => {
      const page = await core.worktreePage(gm, { pageSize: 1, includeReleased: true, ...(cursor ? { cursor } : {}) });
      expect(bytesOf(page)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      return { items: page.worktrees.map(worktree => String(worktree.worktreePath)), nextCursor: page.page.nextCursor };
    });
    expect(seen.length).toBe(37);
    expect(new Set(seen).size).toBe(37);
    expect([...seen].sort()).toEqual(views.map(view => view.worktreePath).sort());
    // The cut row is delivered once, with the whole list's count, digest and filter.
    const delivered = await drain(async cursor => {
      const page = await core.worktreePage(gm, { pageSize: 100, includeReleased: true, ...(cursor ? { cursor } : {}) });
      return { items: page.worktrees, nextCursor: page.page.nextCursor };
    });
    const cut = delivered.filter(worktree => worktree.worktreePath === shared.worktreePath);
    expect(cut).toHaveLength(1);
    expect(cut[0]!.referencesTruncated).toEqual({ count: 129, sha256: sha256(fullText), includeReleased: true, tool: 'read_worktree_refs' });
    expect((cut[0]!.references as unknown[]).length).toBeLessThan(129);
    // read_worktree_refs reads the whole list in segments; every answer fits, and the reassembly matches the flag.
    const pieces: string[] = [];
    let offset: number | null = 0;
    let pinned: string | undefined;
    while (offset !== null) {
      const segment = await core.worktreeRefs(gm, {
        worktreePath: shared.worktreePath, includeReleased: true, offset, limit: 16 * 1024,
        ...(pinned ? { expectSha256: pinned } : {}),
      });
      expect(bytesOf(segment)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      expect(segment.worktreePath).toBe(shared.worktreePath);
      expect(segment.includeReleased).toBe(true);
      expect(segment.totalBytes).toBe(utf8(fullText));
      expect(segment.sha256).toBe(sha256(fullText));
      expect(segment.text).not.toContain('�');
      pinned = segment.sha256;
      pieces.push(segment.text);
      offset = segment.nextOffset;
    }
    expect(pieces.join('')).toBe(fullText);
    expect(sha256(pieces.join(''))).toBe(sha256(fullText));
    const parsed = JSON.parse(pieces.join('')) as Array<{ taskId: string }>;
    expect(parsed).toEqual(JSON.parse(fullText));
    expect(new Set(parsed.map(reference => reference.taskId)).size).toBe(parsed.length);
    // A continuation with a foreign digest is refused, never mixed with another version.
    await expectRefused(core.worktreeRefs(gm, {
      worktreePath: shared.worktreePath, includeReleased: true, offset: 4, expectSha256: '0'.repeat(64),
    }), 'conflict', /references changed/);
    // Without includeReleased nothing is cut: the old behavior of the listing is unchanged.
    const without = await core.worktreePage(gm, { pageSize: 100 });
    expect(without.worktrees.every(worktree => worktree.referencesTruncated === undefined)).toBe(true);
    // Through the real comm client: a segment and the cut page are JSON, within the budget, and verifiable.
    const relayed = await relay('read_worktree_refs',
      { worktreePath: shared.worktreePath, includeReleased: true, offset: 0, limit: 16 * 1024 },
      args => core.worktreeRefs(gm, args));
    expect(relayed.exit).toBe(0);
    expect(Buffer.byteLength(relayed.out, 'utf8')).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const segment = JSON.parse(relayed.out) as { worktreePath: string; sha256: string; text: string };
    expect(segment.worktreePath).toBe(shared.worktreePath);
    expect(segment.sha256).toBe(sha256(fullText));
    expect(fullText.startsWith(segment.text)).toBe(true);
    const relayedList = await relay('list_worktrees', { pageSize: 1, includeReleased: true }, args => core.worktreePage(gm, args));
    expect(relayedList.exit).toBe(0);
    const row = JSON.parse(relayedList.out) as { worktrees: Array<{ worktreePath: string; referencesTruncated?: unknown }> };
    expect(row.worktrees).toHaveLength(1);
    expect(bytesOf(row)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  } finally {
    core.listWorktrees = original;
  }
});

test('read_worktree_refs keeps the list_worktrees scope: a global read is gm only, and a path outside the scope is not_found (SYS01 R1, R8)', async () => {
  await expectRefused(core.worktreeRefs(eng, { worktreePath: '/tmp/wt-000' }), 'forbidden', /owner/);
  await expectRefused(core.worktreeRefs(gm, { worktreePath: '/tmp/not-registered' }), 'not_found', /worktree not found/);
});

test('the cut worktree and its references read back through the real sidecar channel: every reply is whole, and the segments reassemble (SYS01 R1, AC05)', async () => {
  const { views, shared, fullText } = longReferences('r1');
  const original = core.listWorktrees;
  core.listWorktrees = async () => views as never;
  const runDir = mkdtempSync(join(tmpdir(), 'sys01-r1-sidecar-'));
  try {
    const pool = new SidecarPool({ core, workforce: { rotate: async () => gm } as unknown as SidecarDeps['workforce'], runDir, sweepMs: 5 });
    const call = sckCall(pool, 'r1', gm);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 60; page++) {
      const reply = await call('list_worktrees', { pageSize: 1, includeReleased: true, ...(cursor ? { cursor } : {}) });
      expect(reply.exit).toBe(0);
      expect(Buffer.byteLength(reply.out, 'utf8')).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      const body = JSON.parse(reply.out) as {
        worktrees: Array<{ worktreePath: string; referencesTruncated?: unknown }>;
        page: { nextCursor?: string };
      };
      for (const worktree of body.worktrees) {
        seen.push(worktree.worktreePath);
        if (worktree.worktreePath === shared.worktreePath) {
          expect(worktree.referencesTruncated).toMatchObject({ count: 129, includeReleased: true });
        }
      }
      if (!body.page.nextCursor) break;
      cursor = body.page.nextCursor;
    }
    expect(seen.length).toBe(37);
    expect(new Set(seen).size).toBe(37);
    const pieces: string[] = [];
    let offset: number | null = 0;
    let pinned: string | undefined;
    while (offset !== null) {
      const reply = await call('read_worktree_refs', {
        worktreePath: shared.worktreePath, includeReleased: true, offset, limit: 16 * 1024,
        ...(pinned ? { expectSha256: pinned } : {}),
      });
      expect(reply.exit).toBe(0);
      expect(Buffer.byteLength(reply.out, 'utf8')).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      const segment = JSON.parse(reply.out) as { sha256: string; text: string; nextOffset: number | null };
      pinned = segment.sha256;
      pieces.push(segment.text);
      offset = segment.nextOffset;
    }
    expect(pieces.join('')).toBe(fullText);
  } finally {
    core.listWorktrees = original;
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('read_worktree_refs over MCP: a cut worktree reassembles in segments, and each whole MCP response stays within 48 KiB (SYS01 R1)', async () => {
  const { views, shared, fullText } = longReferences('r1');
  const original = core.listWorktrees;
  core.listWorktrees = async () => views as never;
  const session = await mcpSession(gm);
  try {
    const pieces: string[] = [];
    let offset: number | null = 0;
    let pinned: string | undefined;
    while (offset !== null) {
      const answer = await session.client.callTool({
        name: 'read_worktree_refs',
        arguments: { worktreePath: shared.worktreePath, includeReleased: true, offset, limit: 16 * 1024, ...(pinned ? { expectSha256: pinned } : {}) },
      });
      expect(answer.structuredContent).toMatchObject({ ok: true });
      expect(lastBody(session)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      const segment = (answer.structuredContent as { data: { sha256: string; text: string; nextOffset: number | null } }).data;
      expect(segment.sha256).toBe(sha256(fullText));
      pinned = segment.sha256;
      pieces.push(segment.text);
      offset = segment.nextOffset;
    }
    expect(pieces.join('')).toBe(fullText);
    const listed = await session.client.callTool({ name: 'list_worktrees', arguments: { pageSize: 1, includeReleased: true } });
    expect(listed.structuredContent).toMatchObject({ ok: true });
    expect(lastBody(session)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const page = (listed.structuredContent as { data: { worktrees: Array<{ referencesTruncated?: unknown }> } }).data;
    expect(page.worktrees).toHaveLength(1);
  } finally {
    core.listWorktrees = original;
    await session.close();
  }
});

test('concurrent traversals with writers: each listing is delivered exactly once, with no duplicate and no miss, and each row shows its state at the listing (C4)', async () => {
  const concurrent = await core.createTask(gm, { title: `并发目标 ${suffix}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key('goal-conc') });
  for (let i = 0; i < 120; i++) {
    await core.createTask(gm, {
      title: `并发样例 ${i} ${unit}`, context: `并发正文 ${i}`, executorRole: 'engineering', reviewerRole: 'qa',
      tag: concurrent.id, idempotencyKey: key(`conc${i}`),
    });
  }
  const sizes = [7, 13, 30];
  // Three first pages at once: their listings are stored together, through the one admission queue.
  const firsts = await Promise.all(sizes.map(pageSize => core.contextView(gm, { tag: concurrent.id, pageSize })));
  // The writers start only now, so the membership and the states the listings hold are those of this instant.
  const members = await workingIds(concurrent.id);
  const [stateRows] = await database.db.query<[Array<{ id: RecordId; state: string }>]>(
    'SELECT id, state FROM task WHERE tag = $goal;', { goal: concurrent.id });
  const stateAt = new Map((stateRows ?? []).map(row => [asId(row.id), row.state]));
  const writers = (async () => {
    for (let round = 0; round < 3; round++) {
      await database.db.query('UPDATE task SET title = title + " · 并发更新" WHERE tag = $goal;', { goal: concurrent.id });
    }
    await database.db.query('UPDATE task SET state = "done" WHERE id IN $ids;', { ids: members.slice(0, 40).map(member => id('task', member)) });
  })();
  // Each traversal continues from its own first page while the writers run.
  const rests = await Promise.all(firsts.map((first, index) => drain(async cursor => {
    const page = await core.contextView(gm, { tag: concurrent.id, pageSize: sizes[index]!, ...(cursor ? { cursor } : {}) });
    return { items: page.tasks ?? [], nextCursor: page.page!.nextCursor };
  }, first.page!.nextCursor)));
  await writers;
  firsts.forEach((first, index) => {
    const delivered = [...first.tasks!, ...rests[index]!];
    const seen = delivered.map(task => String(task.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...members].sort());
    expect(first.page!.total).toBe(members.length);
    for (const task of delivered) expect(task.state).toBe(stateAt.get(String(task.id)));
  });
  // A second connection reads the same page as the first, at the same time: both get the same tasks.
  const fresh = new SurrealCompanyCore(database);
  const cursor = firsts[0]!.page!.nextCursor!;
  const [mine, theirs] = await Promise.all([
    core.contextView(gm, { tag: concurrent.id, pageSize: sizes[0], cursor }),
    fresh.contextView(gm, { tag: concurrent.id, pageSize: sizes[0], cursor }),
  ]);
  expect(JSON.stringify(theirs.tasks)).toBe(JSON.stringify(mine.tasks));
});

test('the real sidecar and comm client carry a traversal and the legacy answers, whole or refused, through the fork (AC01, AC03, C1 to C3)', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'sys01-sidecar-'));
  try {
    // The pool holds the credential it is given and never rotates it, so the workforce stub is never asked for one.
    const pool = new SidecarPool({ core, workforce: { rotate: async () => gm } as unknown as SidecarDeps['workforce'], runDir, sweepMs: 5 });
    const channel = pool.env({ id: `qp-e2e-${suffix}`, credential: gm } as unknown as EmployeeInst);
    const call = async (tool: string, args: Record<string, unknown>) => {
      const child = Bun.spawn([process.execPath, join(ROOT, 'src/mcp/client-cli.ts'), 'call', tool, JSON.stringify(args)], {
        cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, SCK_COMM_DIR: channel.SCK_COMM_DIR, SCK_COMM_KEY: channel.SCK_COMM_KEY },
      });
      const [out, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out, stderr, exit };
    };
    // A complete traversal through the channel: every page whole and inside the budget, every task exactly once.
    const expected = await workingIds(goalId);
    const seen: string[] = [];
    const pageBytes: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const reply = await call('get_context', { tag: goalId, pageSize: 100, ...(cursor ? { cursor } : {}) });
      expect(reply.exit).toBe(0);
      expect(Buffer.byteLength(reply.out, 'utf8')).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      const body = JSON.parse(reply.out) as { tasks: Array<{ id: unknown }>; page: { nextCursor?: string } };
      seen.push(...body.tasks.map(task => String(task.id)));
      pageBytes.push(Buffer.byteLength(reply.out, 'utf8'));
      if (!body.page.nextCursor) break;
      cursor = body.page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...expected].sort());
    // Legacy answers through the same channel: whole when they fit, refused as JSON when they do not.
    const whole = await call('get_context', { tag: smallGoalId });
    expect(whole.exit).toBe(0);
    expect(Object.keys(JSON.parse(whole.out) as object).sort()).toEqual(['companyIncluded', 'companyRead', 'principal', 'tasks']);
    const refused = await call('get_context', { tag: goalId });
    expect(refused.exit).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({ ok: false });
    expect(refused.out).toContain('response_too_large');
    // A long text read in byte segments through the channel reassembles to the exact text, verified by its digest.
    const longText = '中'.repeat(19_000);
    const longTask = await core.createTask(gm, {
      title: '通道长正文样例', context: longText, executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key('e2e-long'),
    });
    const pieces: string[] = [];
    let offset: number | null = 0;
    let pinned: string | undefined;
    for (let segment = 0; offset !== null && segment < 500; segment++) {
      const reply = await call('read_task_text', { taskId: longTask.id, field: 'context', offset, limit: 8192, ...(pinned ? { expectSha256: pinned } : {}) });
      expect(reply.exit).toBe(0);
      const part = JSON.parse(reply.out) as { text: string; sha256: string; nextOffset: number | null };
      pinned ??= part.sha256;
      pieces.push(part.text);
      offset = part.nextOffset;
    }
    expect(pieces.join('')).toBe(longText);
    expect(pinned).toBe(sha256(longText));
    // Legacy detail through the channel (C3): a context over the budget is refused with the read_task_text route, a short one whole.
    const longDetail = await call('get_context', { taskId: longTask.id });
    expect(longDetail.exit).toBe(1);
    expect(longDetail.out).toContain('read_task_text');
    const shortContext = '短正文 🙂 中文';
    const shortTask = await core.createTask(gm, {
      title: '通道短正文样例', context: shortContext, executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key('e2e-short'),
    });
    const shortDetail = await call('get_context', { taskId: shortTask.id });
    expect(shortDetail.exit).toBe(0);
    expect((JSON.parse(shortDetail.out) as { tasks: Array<{ context: string }> }).tasks[0]!.context).toBe(shortContext);
    // Byte evidence for the report: the largest page and the refused legacy list, against the budget.
    console.log(`AC03 channel bytes ${JSON.stringify({ tasks: expected.length, pages: pageBytes.length, maxPageBytes: Math.max(...pageBytes), refusedLegacyBytes: Buffer.byteLength(refused.out, 'utf8'), longDetailBytes: Buffer.byteLength(longDetail.out, 'utf8'), budgetBytes: RESPONSE_BUDGET_BYTES })}`);
    // Task history and worktrees keep their channel shapes when asked without paging.
    const history = await call('get_task_history', { taskId: longTask.id });
    expect(history.exit).toBe(0);
    expect(Object.keys(JSON.parse(history.out) as object)).toEqual(['history']);
    const worktrees = await call('list_worktrees', {});
    expect(worktrees.exit).toBe(0);
    expect(Array.isArray(JSON.parse(worktrees.out))).toBe(true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('a burst of first pages for one caller stays within its cap, and a listing the burst evicts is refused, never completed short (C4)', async () => {
  const earliest = new Date(Date.now() - 100 * 3_600_000).toISOString();
  const first = await core.contextView(gm, { tag: goalId, pageSize: 5, since: earliest });
  const token = first.page!.nextCursor!;
  // Eight first pages at once under eight different queries: each is admitted in turn, never past the cap.
  const burst = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    core.contextView(gm, { tag: goalId, pageSize: 5, since: new Date(Date.now() - (index + 1) * 3_600_000).toISOString() })));
  expect(burst.every(page => page.tasks!.length === 5 && page.page!.hasMore)).toBe(true);
  const [owned] = await database.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM query_snapshot WHERE owner = $owner GROUP ALL;', { owner: ids.gm });
  expect(owned?.[0]?.n ?? 0).toBeLessThanOrEqual(4);
  // The burst evicted the first listing: its next page is refused as gone, not answered with a short page.
  await expectRefused(core.contextView(gm, { tag: goalId, pageSize: 5, since: earliest, cursor: token }), 'snapshot_gone', /start the listing again/);
});

test('a write answers with its task inside the budget: a long context is cut and flagged, the committed create and checkpoint report it truthfully, and the replay agrees (SYS01)', async () => {
  // Chinese text is 3 bytes a character: 19,500 characters are 58,500 bytes, above the whole budget on their own.
  const context = '字'.repeat(19_500);
  expect(utf8(context)).toBeGreaterThan(RESPONSE_BUDGET_BYTES);
  // Through the relay the create's answer must arrive whole, never as response_too_large after the task exists.
  const created = await relay('create_task', {
    title: `回显样例 ${suffix} 长正文`, context, executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key('echo-create'),
  }, args => core.createTask(gm, args as never));
  expect(created.exit).toBe(0);
  const task = JSON.parse(created.out) as TaskView;
  expect(bytesOf(task)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(task.contextTruncated).toBe(true);
  expect(task.contextBytes).toBe(utf8(context));
  expect(task.contextSha256).toBe(sha256(context));
  expect(context.startsWith(task.context)).toBe(true);
  expect(task.contextNextOffset).toBe(utf8(task.context));
  // The claim keeps the whole text: claim.json is the holder's copy, not a budgeted answer.
  const claim = await core.claim(eng, task.id);
  expect(claim.task.context).toBe(context);
  const proof = { taskId: task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version };
  // The checkpoint commits, answers within the budget, and its replay answers the same echo.
  const checkpointArgs = { text: `长正文的检查点：${'证'.repeat(40)}`, idempotencyKey: key('echo-cp') };
  const checkpoint = await relay('checkpoint', checkpointArgs, args => core.checkpoint(eng, proof, {
    text: String(args.text), idempotencyKey: String(args.idempotencyKey),
  }));
  expect(checkpoint.exit).toBe(0);
  const echoed = JSON.parse(checkpoint.out) as TaskView;
  expect(echoed.version).toBe(proof.expectedVersion + 1);
  expect(echoed.contextTruncated).toBe(true);
  expect(echoed.contextSha256).toBe(sha256(context));
  expect(await core.checkpoint(eng, proof, checkpointArgs)).toEqual(echoed);
  // The stored text stays whole, and a reassembly from the first segment verifies it.
  expect((await core.getTask(gm, task.id)).context).toBe(context);
  const whole = await reassemble({ taskId: task.id, field: 'context', limit: 16 * 1024 }, eng);
  expect(whole.text).toBe(context);
  expect(whole.sha256).toBe(sha256(context));
});

test('claim_next over MCP answers a claim whose context is over the budget: the lease comes back, the context is cut and flagged, and the whole text reassembles (SYS01, defect 1)', async () => {
  // A claim commits before its answer is built (lease, audit, outbox, claim.json), so the answer must arrive whole, never as response_too_large.
  const claimant = await enrollment.enroll(`qp-claim-${suffix}`, 'engineering', ['execute', 'review']);
  const context = `认领回显 ${suffix} ` + '中'.repeat(19_000);
  expect(utf8(context)).toBeGreaterThan(RESPONSE_BUDGET_BYTES);
  const task = await core.createTask(gm, {
    title: `认领回显样例 ${suffix}`, context, executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key('claim-echo'),
  });
  const service = createMcpHttpService({ core, port: 0 });
  const wire = countingFetch();
  const connection = await connectCompanyClient({
    url: new URL(`http://127.0.0.1:${service.port}/mcp`), credential: claimant, clientName: 'sys01-claim-echo', fetch: wire.fetch,
  });
  try {
    const answer = await connection.client.callTool({ name: 'claim_next', arguments: { taskId: task.id } });
    expect(answer.structuredContent).toMatchObject({ ok: true });
    const data = (answer.structuredContent as { data: ClaimEcho }).data;
    expect(lastBody(wire)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(typeof data.deliveryId).toBe('string');
    expect(typeof data.fence).toBe('number');
    expect(typeof data.leaseExpiresAt).toBe('string');
    expect(data.task).toMatchObject({ id: task.id, contextTruncated: true, contextBytes: utf8(context), contextSha256: sha256(context) });
    expect(context.startsWith(data.task.context)).toBe(true);
    expect(data.task.contextNextOffset).toBe(utf8(data.task.context));
    // The lease is the one the claim committed; the rest of the text reads back whole, verified against its digest.
    expect((await core.getTask(gm, task.id)).currentEmployee).toBe(`qp-claim-${suffix}`);
    const whole = await reassemble({ taskId: task.id, field: 'context', limit: 16 * 1024 }, claimant);
    expect(whole.text).toBe(context);
    expect(whole.sha256).toBe(sha256(context));
  } finally {
    await connection.close();
    await service.close();
  }
});

// ---- SYS01 R3 (GM ruling v25): the claim, heartbeat and task-text echoes on the real MCP, sidecar and fork paths. ----
// Each test enrolls its own employee. The concept-design role has no other task in this file, so the queue path
// (claim_next without taskId) can only pick the task the test created.

const designerCredential = (label: string) => enrollment.enroll(`qp-${label}-${suffix}`, 'concept-design', ['execute', 'review']);

/** A real MCP client on a fresh HTTP service, for one caller. `bodies` counts the whole response of each tools/call (SYS01, F5). */
async function mcpSession(credential: string) {
  const service = createMcpHttpService({ core, port: 0 });
  const wire = countingFetch();
  const connection = await connectCompanyClient({
    url: new URL(`http://127.0.0.1:${service.port}/mcp`), credential, clientName: `sys01-r3-${suffix}`, fetch: wire.fetch,
  });
  return {
    client: connection.client,
    bodies: wire.bodies,
    close: async () => { await connection.close(); await service.close(); },
  };
}

/** One audit entry at a fixed time, so that the history order is known. Returns the audit id. */
async function seedAudit(taskId: string, evidence: string, at: string): Promise<string> {
  const auditId = randomUUID();
  await database.db.query(
    'CREATE $rid CONTENT { task: $task, actor: $actor, action: "checkpoint", evidence: $evidence, version: 1, at: <datetime>$at };',
    { rid: id('audit', auditId), task: id('task', taskId), actor: id('employee', ids.gm), evidence, at });
  return auditId;
}

/** A sck call through the real comm client and an in-process sidecar pool, as the employee's own calls run. */
function sckCall(pool: SidecarPool, label: string, credential: string) {
  const channel = pool.env({ id: `qp-${label}-${suffix}`, credential } as unknown as EmployeeInst);
  return async (tool: string, args: Record<string, unknown>) => {
    const child = Bun.spawn([process.execPath, join(ROOT, 'src/mcp/client-cli.ts'), 'call', tool, JSON.stringify(args)], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, SCK_COMM_DIR: channel.SCK_COMM_DIR, SCK_COMM_KEY: channel.SCK_COMM_KEY },
    });
    const [out, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, stderr, exit };
  };
}

test('claim_next over MCP with no taskId claims from the queue: a 57 KB Chinese and emoji context is cut and flagged inside the budget, reassembles whole through read_task_text, and the heartbeat echoes the same lease (SYS01 R3)', async () => {
  const holder = await designerCredential('queue');
  // createTask caps a context at 20,000 UTF-16 units; this one is 19,914 units and 57,7xx UTF-8 bytes (CJK 3 bytes, emoji 4 bytes).
  const context = `队列认领 ${suffix} ` + '中'.repeat(17_900) + '🙂'.repeat(1_000);
  expect(utf8(context)).toBeGreaterThan(56 * 1024);
  const task = await core.createTask(gm, {
    title: `队列认领样例 ${suffix}`, context, executorRole: 'concept-design', reviewerRole: 'qa', idempotencyKey: key('queue-echo'),
  });
  const session = await mcpSession(holder);
  try {
    const answer = await session.client.callTool({ name: 'claim_next', arguments: {} });
    expect(answer.structuredContent).toMatchObject({ ok: true });
    const claim = (answer.structuredContent as { data: ClaimEcho }).data;
    expect(claim.task.id).toBe(task.id);
    expect(lastBody(session)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    // The lease fields are read out and checked one by one: Bun's toMatchObject writes its matchers into the object it checks.
    const { deliveryId, fence } = claim;
    expect(typeof deliveryId).toBe('string');
    expect(typeof fence).toBe('number');
    expect(typeof claim.leaseExpiresAt).toBe('string');
    expect(claim.task).toMatchObject({ contextTruncated: true, contextBytes: utf8(context), contextSha256: sha256(context) });
    expect(context.startsWith(claim.task.context)).toBe(true);
    const beat = await session.client.callTool({
      name: 'heartbeat', arguments: { taskId: task.id, deliveryId, fence, expectedVersion: claim.task.version },
    });
    expect(beat.structuredContent).toMatchObject({ ok: true });
    const lease = (beat.structuredContent as { data: ClaimEcho }).data;
    expect(lastBody(session)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(lease.deliveryId).toBe(deliveryId);
    expect(lease.fence).toBe(fence);
    expect(typeof lease.leaseExpiresAt).toBe('string');
    // A heartbeat reads no history, so it carries no history flags and no entries.
    expect(lease).not.toHaveProperty('historyComplete');
    expect(lease.history).toEqual([]);
    expect(lease.task).toMatchObject({ id: task.id, contextTruncated: true, contextSha256: sha256(context) });
    expect((await reassemble({ taskId: task.id, field: 'context', limit: 16 * 1024 }, holder)).text).toBe(context);
  } finally {
    await session.close();
  }
});

test('a claim over more than 16 KiB of history echoes the newest entries that fit: the count is whole, historyComplete is false, the cut entry reads back whole, and the pages reach every entry (SYS01 R3)', async () => {
  const holder = await designerCredential('history');
  const task = await core.createTask(gm, {
    title: `历史回显样例 ${suffix}`, context: '短正文', executorRole: 'concept-design', reviewerRole: 'qa', idempotencyKey: key('history-echo'),
  });
  // Seeded history, oldest first: 70 entries of about 250 bytes (about 1 KiB each in both copies), and one entry of 96 KB that is
  // 30th from the newest. The 29 newer entries fit the echo room whole, so the big entry is the boundary, cut at its longest prefix.
  const base = Date.parse('2026-10-18T08:00:00Z');
  const at = (i: number) => new Date(base + i * 60_000).toISOString();
  const big = codePoints(30_000, `大条目 ${suffix} `);
  let bigId = '';
  for (let i = 0; i < 70; i++) {
    if (i === 40) {
      bigId = await seedAudit(task.id, big, at(i));
    } else {
      await seedAudit(task.id, `历史条目 ${i} ${suffix} ` + '证'.repeat(60), at(i));
    }
  }
  const session = await mcpSession(holder);
  try {
    const answer = await session.client.callTool({ name: 'claim_next', arguments: { taskId: task.id } });
    expect(answer.structuredContent).toMatchObject({ ok: true });
    const claim = (answer.structuredContent as { data: ClaimEcho }).data;
    expect(lastBody(session)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const count = await historyRows(task.id);
    expect(count).toBeGreaterThan(70);
    expect(claim.historyCount).toBe(count);
    expect(claim.historyComplete).toBe(false);
    expect(claim.history.length).toBeGreaterThan(0);
    expect(claim.history.length).toBeLessThan(count);
    // The echo holds the newest suffix of the history, oldest first.
    const everything = await historyEntries(task.id);
    expect(new Set(everything.map(entry => entry.auditId)).size).toBe(count);
    const oldestFirst = [...everything].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    expect(claim.history.map(entry => entry.auditId)).toEqual(oldestFirst.slice(-claim.history.length).map(entry => entry.auditId));
    // The entry over 2 KiB is cut at its boundary: its leading part, with the size and digest of the whole text.
    const cut = claim.history.find(entry => entry.evidenceTruncated === true);
    expect(cut).toMatchObject({ auditId: bigId, evidenceBytes: utf8(big), evidenceSha256: sha256(big) });
    expect(big.startsWith(cut!.evidence!)).toBe(true);
    expect(cut!.evidenceNextOffset).toBe(utf8(cut!.evidence!));
    // read_task_text continues the entry, and its segments reassemble to the whole text.
    expect((await reassemble({ taskId: task.id, field: 'evidence', auditId: bigId, limit: 16 * 1024 }, holder)).text).toBe(big);
    // The pages carry the same entry; it is cut there as well, because it is larger than one page.
    expect(everything.find(entry => entry.auditId === bigId)).toMatchObject({ evidenceBytes: utf8(big), evidenceSha256: sha256(big), evidenceTruncated: true });
  } finally {
    await session.close();
  }
});

test('a claim with a long project, dependency list and intent paths echoes each part in the budget and flags it; the holder reads each back whole through MCP and through the real sidecar, and another employee is refused the project (SYS01 R3)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sys01-r3-project-'));
  const projectId = `qp-r3-${suffix}`;
  await new ProjectStore(database.db).upsert({
    id: projectId, name: `长项目 ${suffix}`, repoPath: dir, release: '本地发布', envs: [],
    redLines: Array.from({ length: 40 }, (_, i) => `红线${i}：${'禁'.repeat(300)}`),
  });
  const holder = await designerCredential('long');
  const outsider = await designerCredential('outsider');
  const paths = Array.from({ length: 50 }, (_, i) => `资产/第${i}组/${'镜头草图'.repeat(20)}-${i}`);
  const task = await core.createTask(gm, {
    title: `长列表样例 ${suffix} ` + '题'.repeat(180), context: '短正文', executorRole: 'concept-design', reviewerRole: 'qa',
    project: projectId, workIntent: { kind: 'assets', paths }, idempotencyKey: key('long-lists'),
  });
  const wholeProject = (await new ProjectStore(database.db).get(projectId))!;
  const session = await mcpSession(holder);
  const pool = new SidecarPool({ core, workforce: { rotate: async () => holder } as unknown as SidecarDeps['workforce'], runDir: mkdtempSync(join(tmpdir(), 'sys01-r3-sidecar-')), sweepMs: 5 });
  try {
    const answer = await session.client.callTool({ name: 'claim_next', arguments: { taskId: task.id } });
    expect(answer.structuredContent).toMatchObject({ ok: true });
    const claim = (answer.structuredContent as { data: ClaimEcho }).data;
    expect(lastBody(session)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(claim.projectTruncated).toBe(true);
    expect(claim.projectBytes).toBe(utf8(JSON.stringify(wholeProject)));
    expect(claim.projectSha256).toBe(sha256(JSON.stringify(wholeProject)));
    expect(claim.project).toMatchObject({ id: projectId, name: `长项目 ${suffix}` });
    expect(claim.project!.redLines!.length).toBeGreaterThan(0);
    expect(claim.project!.redLines!.length).toBeLessThan(40);
    expect(claim.listsTruncated).toMatchObject({ workIntentPaths: { count: 50 } });
    expect(claim.listsTruncated!.workIntentPaths!.sha256).toBe(sha256(JSON.stringify(paths)));
    // Each cut list reads back whole through read_task_text, verified against the digest the echo carried.
    const readWhole = async (field: TaskTextField, credential: string) => (await reassemble({ taskId: task.id, field, limit: 16 * 1024 }, credential)).text;
    expect(JSON.parse(await readWhole('workIntentPaths', holder))).toEqual(paths);
    const projectText = await readWhole('project', holder);
    expect(JSON.parse(projectText)).toEqual(wholeProject);
    expect(claim.projectSha256).toBeDefined();
    expect(sha256(projectText)).toBe(claim.projectSha256!);
    // The same reads through the real sidecar and comm client: the holder's sck gets the project, the other employee is refused it.
    const mine = sckCall(pool, 'r3-holder', holder);
    const theirs = sckCall(pool, 'r3-outsider', outsider);
    const viaSidecar = await mine('read_task_text', { taskId: task.id, field: 'project', offset: 0, limit: 16 * 1024 });
    expect(viaSidecar.exit).toBe(0);
    expect(JSON.parse(viaSidecar.out)).toMatchObject({ field: 'project', sha256: claim.projectSha256 });
    const refused = await theirs('read_task_text', { taskId: task.id, field: 'project', offset: 0, limit: 16 * 1024 });
    expect(refused.exit).toBe(1);
    expect(refused.out).toContain('owner or the holder of a valid task lease');
    // A page of this task's history through the sidecar stays inside the budget.
    const history = await mine('get_task_history', { taskId: task.id, pageSize: 5 });
    expect(history.exit).toBe(0);
    expect(Buffer.byteLength(history.out, 'utf8')).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    // gm reads the project too.
    expect(JSON.parse((await reassemble({ taskId: task.id, field: 'project', limit: 16 * 1024 }, gm)).text)).toEqual(wholeProject);
  } finally {
    pool.close();
    await session.close();
  }
});

test('create_task over MCP with 50 long asset paths: the committed write answers inside the budget, its cut list is flagged with the whole count and digest, and the whole list reads back through read_task_text (SYS01 R3)', async () => {
  // 50 relative directories of 300 characters each (892 bytes): the longest list validateIntent accepts. The list alone is about 45 KB.
  const paths = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(3, '0')}-${'甲'.repeat(296)}`);
  expect(utf8(JSON.stringify(paths))).toBeGreaterThan(40 * 1024);
  const session = await mcpSession(gm);
  try {
    const answer = await session.client.callTool({
      name: 'create_task',
      arguments: {
        title: `写入回显样例 ${suffix}`, context: `写入回显 ${suffix}`, executorRole: 'concept-design', reviewerRole: 'qa',
        workIntent: { kind: 'assets', paths }, idempotencyKey: key('write-echo-lists'),
      },
    });
    expect(answer.structuredContent).toMatchObject({ ok: true });
    const created = (answer.structuredContent as { data: TaskView }).data;
    expect(lastBody(session)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(created.workIntent).toMatchObject({ kind: 'assets' });
    expect(created.workIntent!.paths!.length).toBeGreaterThan(0);
    expect(created.workIntent!.paths!.length).toBeLessThan(50);
    expect(created.workIntent!.paths).toEqual(paths.slice(0, created.workIntent!.paths!.length));
    expect(created.listsTruncated).toEqual({ workIntentPaths: { count: 50, sha256: sha256(JSON.stringify(paths)) } });
    // The commit stands: the whole list is stored, and read_task_text returns it whole, verified against the digest.
    const stored = await reassemble({ taskId: created.id, field: 'workIntentPaths', limit: 16 * 1024 }, gm);
    expect(sha256(stored.text)).toBe(sha256(JSON.stringify(paths)));
    expect(JSON.parse(stored.text)).toEqual(paths);
  } finally {
    await session.close();
  }
});

test('read_task_text over MCP: a 57 KB Chinese and emoji context reads back in 24 KiB segments, each whole MCP response stays within 48 KiB, and the segments reassemble to the original (SYS01, F5)', async () => {
  const context = `分段读取 ${suffix} ` + '中'.repeat(17_900) + '🙂'.repeat(1_000);
  expect(utf8(context)).toBeGreaterThan(56 * 1024);
  const task = await core.createTask(gm, {
    title: `分段读取样例 ${suffix}`, context, executorRole: 'concept-design', reviewerRole: 'qa', idempotencyKey: key('segments-mcp'),
  });
  const session = await mcpSession(gm);
  try {
    const pieces: Buffer[] = [];
    let offset: number | null = 0;
    let expectSha256: string | undefined;
    let segments = 0;
    while (offset !== null) {
      const answer = await session.client.callTool({
        name: 'read_task_text',
        arguments: { taskId: task.id, field: 'context', offset, limit: 24 * 1024, ...(expectSha256 ? { expectSha256 } : {}) },
      });
      expect(answer.structuredContent).toMatchObject({ ok: true });
      // The whole response of this segment is inside the budget, text copy and frame included.
      expect(lastBody(session)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      const segment = (answer.structuredContent as { data: TaskTextSegment }).data;
      expect(segment.totalBytes).toBe(utf8(context));
      expect(segment.sha256).toBe(sha256(context));
      pieces.push(Buffer.from(segment.text, 'utf8'));
      expectSha256 = segment.sha256;
      offset = segment.nextOffset;
      segments++;
      expect(segments).toBeLessThan(20);
    }
    expect(segments).toBeGreaterThan(1);
    const whole = Buffer.concat(pieces).toString('utf8');
    expect(whole).toBe(context);
    expect(sha256(whole)).toBe(sha256(context));
  } finally {
    await session.close();
  }
});
