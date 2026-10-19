import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { CompanyError, SurrealCompanyCore, asId, id } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { ensureCommDirs, reqDir, resDir, writeFileAtomic } from '../src/comm.ts';
import { RESPONSE_BUDGET_BYTES, guardRelayResponse, jsonBytes, sealCursor } from '../src/response-budget.ts';
import { queryDigest } from '../src/query-input.ts';

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
let goalId: string;
let expectedWorking: string[] = [];

/** `count` code points of mixed Chinese and emoji, starting with `prefix` (never splits a surrogate pair). */
function codePoints(count: number, prefix = ''): string {
  const body = [...unit.repeat(Math.ceil(count / 5) + 1)].slice(0, Math.max(0, count - [...prefix].length)).join('');
  return prefix + body;
}

const bytesOf = (value: unknown): number => jsonBytes({ ok: true, data: value });

async function expectRefused(promise: Promise<unknown>, code: CompanyError['code'], pattern: RegExp) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe(code);
  expect((error as CompanyError).message).toMatch(pattern);
}

async function workingIds(goal: string): Promise<string[]> {
  const [rows] = await database.db.query<[Array<{ id: RecordId }>]>(
    "SELECT id FROM task WHERE goal = $goal AND state IN ['ready', 'doing', 'review', 'blocked'];", { goal: id('goal', goal) });
  return (rows ?? []).map(row => asId(row.id));
}

async function countRows(table: string): Promise<number> {
  const [rows] = await database.db.query<[Array<{ n: number }>]>(`SELECT count() AS n FROM ${table} GROUP ALL;`);
  return rows?.[0]?.n ?? 0;
}

/** Walks every page of one listing, checking each page against the byte budget as it arrives. */
async function walk(fetchPage: (cursor?: string) => Promise<{ items: string[]; nextCursor?: string }>, limit = 500, start?: string): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined = start;
  for (let page = 0; page < limit; page++) {
    const next = await fetchPage(cursor);
    seen.push(...next.items);
    if (!next.nextCursor) return seen;
    cursor = next.nextCursor;
  }
  throw new Error('traversal did not finish within the page limit');
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
  gm = await enrollment.enroll(ids.gm, 'gm', ['execute', 'review', 'manage']);
  eng = await enrollment.enroll(ids.eng, 'engineering', ['execute', 'review']);
  cs = await enrollment.enroll(ids.cs, 'cs', ['execute']);
  const goal = await owner.createGoal({ text: `分页夹具目标 ${suffix}`, source: 'owner:test', key: key('goal'), tier: 'standard' });
  goalId = goal.id;
  // Fixture: 1000 tasks with Chinese and emoji titles; every 25th context is long (about 6000 characters).
  for (let i = 0; i < TOTAL; i++) {
    await core.createTask(gm, {
      title: `分页样例 ${i} ${unit}`,
      context: i % 25 === 0 ? codePoints(6000, `第${i}条长正文 `) : `短正文 ${i} ${unit}`,
      executorRole: 'engineering', reviewerRole: 'qa', goalId, idempotencyKey: key(`t${i}`),
    });
  }
  expectedWorking = await workingIds(goalId);
}, 1_200_000);

afterAll(async () => { await database.close(); });

test('the budget is 48 KiB of serialized UTF-8 and the paged working set is at least the 1000-task fixture', () => {
  expect(RESPONSE_BUDGET_BYTES).toBe(49_152);
  expect(expectedWorking.length).toBeGreaterThanOrEqual(TOTAL);
});

test('legacy get_context keeps its keys and returns a budgeted first page with a continuation', async () => {
  const legacy = await core.contextView(gm, { goalId });
  expect(Object.keys(legacy)).toEqual(expect.arrayContaining(['principal', 'company', 'tasks', 'page']));
  expect(legacy.page.hasMore).toBe(true);
  expect(legacy.tasks.length).toBeGreaterThan(0);
  expect(legacy.tasks.length).toBeLessThan(TOTAL);
  expect(bytesOf(legacy)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(legacy.page.nextCursor).toBeString();
});

test('a paged traversal yields every working-set task exactly once, each page inside the budget', async () => {
  const seen = await walk(async cursor => {
    const page = await core.contextView(gm, { goalId, pageSize: 37, ...(cursor ? { cursor } : {}) });
    expect(bytesOf(page)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    return { items: page.tasks.map(task => String(task.id)), nextCursor: page.page.nextCursor };
  });
  expect(new Set(seen).size).toBe(seen.length);
  expect([...seen].sort()).toEqual([...expectedWorking].sort());
});

test('UTF-8 survives every page: Chinese titles and emoji parse back intact', async () => {
  const page = await core.contextView(gm, { goalId, pageSize: 20 });
  const parsed = JSON.parse(JSON.stringify(page)) as typeof page;
  expect(parsed.tasks.some(task => String(task.title).includes('分页样例') && String(task.title).includes('🙂'))).toBe(true);
  for (const task of parsed.tasks) expect(String(task.context)).not.toContain('�');
});

test('a traversal keeps its snapshot: rows created mid-way are excluded and in-place updates neither repeat nor drop rows', async () => {
  const snapshot = [...expectedWorking];
  const first = await core.contextView(gm, { goalId, pageSize: 50 });
  for (let i = 0; i < 3; i++) {
    await core.createTask(gm, {
      title: `迟到样例 ${i}`, context: `创建于快照之后 ${i}`, executorRole: 'engineering', reviewerRole: 'qa', goalId, idempotencyKey: key(`late${i}`),
    });
  }
  await database.db.query('UPDATE task SET title = title + " · 已更新" WHERE goal = $goal;', { goal: id('goal', goalId) });
  // Continue from the first page's cursor: the traversal started before the mid-way writes above.
  const rest = await walk(async cursor => {
    const page = await core.contextView(gm, { goalId, pageSize: 50, ...(cursor ? { cursor } : {}) });
    return { items: page.tasks.map(task => String(task.id)), nextCursor: page.page.nextCursor };
  }, 500, first.page.nextCursor);
  const seen = [...first.tasks.map(task => String(task.id)), ...rest];
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.every(taskId => snapshot.includes(taskId))).toBe(true);
  expect(seen.length).toBe(snapshot.length);
});

test('cursors are bound to the caller and the query, are sealed, and expire', async () => {
  const first = await core.contextView(gm, { goalId, pageSize: 10 });
  const token = first.page.nextCursor!;
  await expectRefused(core.contextView(gm, { goalId, pageSize: 10, cursor: token.replace(/\.[^.]+$/, '.') }), 'invalid', /verification|malformed/);
  await expectRefused(core.contextView(eng, { goalId, pageSize: 10, cursor: token }), 'forbidden', /another caller/);
  await expectRefused(core.contextView(gm, { goalId, state: 'ready', pageSize: 10, cursor: token }), 'forbidden', /another query/);
  const flipped = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
  await expectRefused(core.contextView(gm, { goalId, pageSize: 10, cursor: flipped }), 'invalid', /verification|malformed/);
  // An expired cursor, sealed with the stored key, is refused with its own reason.
  const keyRow = await database.db.select<{ key: string }>(id('company_meta', 'cursor_key'));
  const sealKey = Buffer.from(keyRow!.key, 'base64url');
  const expired = sealCursor({
    v: 1, k: 'context', c: ids.gm, q: queryDigest('context', { state: null, goalId, role: null, since: null }),
    snap: new Date().toISOString(), exp: Date.now() - 1_000,
  }, sealKey);
  await expectRefused(core.contextView(gm, { goalId, pageSize: 10, cursor: expired }), 'invalid', /expired/);
  // The unmodified cursor still works for its own caller and query.
  const again = await core.contextView(gm, { goalId, pageSize: 10, cursor: token });
  expect(again.tasks.length).toBeGreaterThan(0);
});

test('a long single task is previewed with its size and digest, and its full text reassembles from byte segments', async () => {
  const text = codePoints(12_000, '长篇正文开头 ');
  const task = await core.createTask(gm, {
    title: '超长正文样例', context: text, executorRole: 'engineering', reviewerRole: 'qa', goalId, idempotencyKey: key('long'),
  });
  const detail = await core.contextView(gm, { taskId: task.id });
  const view = detail.tasks[0]!;
  expect(view.contextTruncated).toBe(true);
  expect(Number(view.contextBytes)).toBeGreaterThan(16_384);
  expect(bytesOf(detail)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  const pieces: Buffer[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const segment = await core.taskText(gm, { taskId: task.id, field: 'context', offset, limit: 8_192 });
    expect(segment.bytes).toBeLessThanOrEqual(8_192);
    pieces.push(Buffer.from(segment.text, 'utf8'));
    offset = segment.nextOffset;
  }
  const assembled = Buffer.concat(pieces).toString('utf8');
  expect(assembled).toBe(text);
  expect(createHash('sha256').update(assembled).digest('hex')).toBe(String(view.contextSha256));
});

test('task history pages stay inside the budget, previews carry size and digest, and evidence reassembles by segments', async () => {
  const task = await core.createTask(gm, {
    title: '历史分页样例', context: '历史分页夹具', executorRole: 'engineering', reviewerRole: 'qa', goalId, idempotencyKey: key('hist'),
  });
  const taskRecord = id('task', task.id);
  const actorRecord = id('employee', ids.gm);
  for (let i = 0; i < 30; i++) {
    await database.db.query(
      'CREATE audit CONTENT { task: $task, actor: $actor, action: "checkpoint", evidence: $evidence, version: 1, at: time::now() };',
      { task: taskRecord, actor: actorRecord, evidence: `${codePoints(6_000, `证据第${i}条 `)}` });
  }
  const seen = await walk(async cursor => {
    const page = await core.historyView(gm, task.id, { pageSize: 9, ...(cursor ? { cursor } : {}) });
    expect(bytesOf(page)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    return { items: page.history.map(entry => String(entry.auditId)), nextCursor: page.page.nextCursor };
  });
  expect(new Set(seen).size).toBe(seen.length);
  const checkpoints = await core.historyView(gm, task.id, { pageSize: 100 });
  const sample = checkpoints.history.find(entry => entry.action === 'checkpoint' && entry.evidenceTruncated)!;
  expect(sample).toBeDefined();
  expect(sample.evidenceBytes).toBeGreaterThan(2048);
  expect(sample.evidence!.length).toBeLessThan(2048);
  const pieces: Buffer[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const segment = await core.taskText(gm, { taskId: task.id, field: 'evidence', auditId: sample.auditId, offset, limit: 4_096 });
    pieces.push(Buffer.from(segment.text, 'utf8'));
    offset = segment.nextOffset;
  }
  const full = Buffer.concat(pieces).toString('utf8');
  expect(Buffer.byteLength(full, 'utf8')).toBe(sample.evidenceBytes!);
  expect(createHash('sha256').update(full).digest('hex')).toBe(sample.evidenceSha256!);
  expect(seen.length).toBeGreaterThanOrEqual(30);
});

test('the gm summary counts the fixture at a cutoff, and everyone else is refused', async () => {
  const [rows] = await database.db.query<[Array<{ id: RecordId }>]>('SELECT id FROM task WHERE goal = $goal;', { goal: id('goal', goalId) });
  const summary = await core.adminSummary(gm, { goalId });
  const counted = Object.values(summary.tasks).reduce((sum, n) => sum + n, 0);
  expect(counted).toBe((rows ?? []).length);
  expect(summary.cutoffAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(summary.scope.tasks).toContain('since does not apply');
  expect(summary.integrity.complete).toBe(true);
  expect(summary.integrity.checks).toEqual({ taskCountsMatchRows: true, auditCountsMatchRows: true, statesKnown: true });
  expect(summary.integrity.taskRows).toBe(counted);
  await expectRefused(core.adminSummary(eng, {}), 'forbidden', /Only gm/);
  await expectRefused(core.adminSummary(cs, {}), 'forbidden', /Only gm/);
});

test('audit counts cover [since, cutoffAt] and task counts ignore the window', async () => {
  const wide = '2000-01-01T00:00:00.000Z';
  const everything = await core.adminSummary(gm, { goalId, since: wide });
  const [audits] = await database.db.query<[Array<{ n: number }>]>(
    'SELECT count() AS n FROM audit WHERE at >= <datetime>$since AND at <= <datetime>$cutoff GROUP ALL;',
    { since: wide, cutoff: everything.cutoffAt });
  expect(everything.integrity.auditRows).toBeGreaterThan(0);
  expect(everything.integrity.auditRows).toBe(audits?.[0]?.n ?? 0);
  const future = await core.adminSummary(gm, { goalId, since: new Date(Date.now() + 3_600_000).toISOString() });
  expect(future.integrity.auditRows).toBe(0);
  expect(future.tasks).toEqual(everything.tasks);
});

test('a role that may see no task gets an empty page and never the company listing', async () => {
  const page = await core.contextView(cs, { goalId, pageSize: 5 });
  expect(page.tasks).toEqual([]);
  expect(page.page.hasMore).toBe(false);
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

test('reads add no task, audit or outbox state: the only new row is the cursor secret (RB01)', async () => {
  const before = { task: await countRows('task'), audit: await countRows('audit'), outbox: await countRows('outbox') };
  await core.contextView(gm, { goalId, pageSize: 10 });
  await core.historyView(gm, expectedWorking[0]!, { pageSize: 5 });
  await core.adminSummary(gm, { goalId });
  await core.worktreePage(gm, { pageSize: 5 });
  const after = { task: await countRows('task'), audit: await countRows('audit'), outbox: await countRows('outbox') };
  expect(after).toEqual(before);
  const keyRow = await database.db.select<{ key?: string }>(id('company_meta', 'cursor_key'));
  expect(keyRow?.key).toBeString();
});

test('sck relay round trip: the real comm client returns one complete, budgeted JSON page', async () => {
  const relayed = await relay('get_context', { goalId, pageSize: 37 }, args => core.contextView(gm, args));
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

test('state, role, goal and time filters narrow the listing and the cursor stays bound to them', async () => {
  const readyDb = (await database.db.query<[Array<{ id: RecordId }>]>(
    "SELECT id FROM task WHERE goal = $goal AND state = 'ready';", { goal: id('goal', goalId) }))[0]!.map(row => asId(row.id));
  const readySeen = await walk(async cursor => {
    const page = await core.contextView(gm, { goalId, state: 'ready', pageSize: 100, ...(cursor ? { cursor } : {}) });
    expect(page.tasks.every(task => task.state === 'ready')).toBe(true);
    return { items: page.tasks.map(task => String(task.id)), nextCursor: page.page.nextCursor };
  });
  expect([...readySeen].sort()).toEqual([...readyDb].sort());
  const engineering = await core.contextView(gm, { goalId, role: 'engineering', pageSize: 100 });
  expect(engineering.tasks.every(task => task.executorRole === 'engineering' || task.reviewerRole === 'engineering')).toBe(true);
  expect(engineering.tasks.length).toBeGreaterThan(0);
  const future = await core.contextView(gm, { goalId, since: new Date(Date.now() + 3_600_000).toISOString() });
  expect(future.tasks).toEqual([]);
  const someCursor = (await core.contextView(gm, { goalId, state: 'ready', pageSize: 5 })).page.nextCursor!;
  await expectRefused(core.contextView(gm, { goalId, pageSize: 5, cursor: someCursor }), 'forbidden', /another query/);
});

test('list_worktrees is compact and paged: released references are counted, listed only on request, and the cursor is bound', async () => {
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
    const rest = await walk(async cursor => {
      const page = await core.worktreePage(gm, { pageSize: 25, ...(cursor ? { cursor } : {}) });
      return { items: page.worktrees.map(worktree => String(worktree.worktreePath)), nextCursor: page.page.nextCursor };
    }, 100, first.page.nextCursor);
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

test('a caller that drops mid-traversal retries the same cursor on a fresh connection and gets the same page (AC05)', async () => {
  const expected = await workingIds(goalId);
  const pageSize = 37;
  const first = await core.contextView(gm, { goalId, pageSize });
  const cursor = first.page.nextCursor!;
  // The answer to this page is lost in transit: nothing is kept on the caller side, so it asks again.
  const lost = await core.contextView(gm, { goalId, pageSize, cursor });
  // A fresh connection (a new core with no state of its own) retries with the same cursor.
  const fresh = new SurrealCompanyCore(database);
  const retried = await fresh.contextView(gm, { goalId, pageSize, cursor });
  // The retry is the same page: same tasks and snapshot; its next cursor differs only in the expiry it was issued with.
  expect(JSON.parse(JSON.stringify(retried.tasks))).toEqual(JSON.parse(JSON.stringify(lost.tasks)));
  expect(retried.page.snapshotAt).toBe(lost.page.snapshotAt);
  expect(cursorBody(retried.page.nextCursor!)).toEqual({ ...cursorBody(lost.page.nextCursor!), exp: expect.any(Number) });
  // Through real comm client processes: the first caller is killed after its request left, then a new process retries.
  const dir = newCommDir();
  const dropped = await relayAndDrop(dir, 'get_context', { goalId, pageSize, cursor }, args => core.contextView(gm, args));
  expect(dropped).toEqual({ goalId, pageSize, cursor });
  const relayed = await relay('get_context', { goalId, pageSize, cursor }, args => fresh.contextView(gm, args), dir);
  expect(relayed.exit).toBe(0);
  const page = JSON.parse(relayed.out) as { tasks: Array<{ id: unknown }>; page: { nextCursor?: string } };
  expect(page.tasks.map(task => String(task.id))).toEqual(lost.tasks.map(task => String(task.id)));
  // Continuing from the retried page reaches every task of the snapshot exactly once.
  const rest = await walk(async next => {
    const more = await fresh.contextView(gm, { goalId, pageSize, ...(next ? { cursor: next } : {}) });
    return { items: more.tasks.map(task => String(task.id)), nextCursor: more.page.nextCursor };
  }, 500, page.page.nextCursor);
  const seen = [...first.tasks.map(task => String(task.id)), ...page.tasks.map(task => String(task.id)), ...rest];
  expect(new Set(seen).size).toBe(seen.length);
  expect([...seen].sort()).toEqual([...expected].sort());
});

test('a full traversal keeps every response inside the budget and the heap flat (AC05 resource)', async () => {
  const expected = await workingIds(goalId);
  const pageSize = 25;
  Bun.gc(true);
  const heapBefore = process.memoryUsage().heapUsed;
  let heapPeak = heapBefore;
  const pages: Array<{ bytes: number; rows: number; ms: number }> = [];
  const seen = await walk(async cursor => {
    const started = performance.now();
    const page = await core.contextView(gm, { goalId, pageSize, ...(cursor ? { cursor } : {}) });
    const ms = performance.now() - started;
    pages.push({ bytes: bytesOf(page), rows: page.tasks.length, ms });
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    return { items: page.tasks.map(task => String(task.id)), nextCursor: page.page.nextCursor };
  }, 500);
  Bun.gc(true);
  const heapAfter = process.memoryUsage().heapUsed;
  const mib = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  const timings = pages.map(page => page.ms).sort((a, b) => a - b);
  const report = {
    tasks: seen.length, pageSize, pages: pages.length, maxRows: Math.max(...pages.map(page => page.rows)),
    maxPageBytes: Math.max(...pages.map(page => page.bytes)), budgetBytes: RESPONSE_BUDGET_BYTES,
    pageMsP50: Math.round(timings[Math.floor(timings.length / 2)]!), pageMsMax: Math.round(timings.at(-1)!),
    heapBeforeMiB: mib(heapBefore), heapAfterMiB: mib(heapAfter), heapPeakMiB: mib(heapPeak),
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

test('list_worktrees without pageSize or cursor keeps the array shape; an over-budget array is refused as JSON, never cut (C1)', async () => {
  const view = (index: number, path: string) => ({
    id: `wt-${index}`, repo: '/repo/ops', worktreePath: path, mode: 'exclusive', branch: `task/${index}`,
    createdAt: '2026-10-19T00:00:00Z', lastUsedAt: '2026-10-19T00:00:00Z', status: 'present', deletable: false, reasons: [],
    references: [
      { taskId: `t${index}`, employee: 'eng', deliveryId: 'd', fence: 1, intent: { kind: 'code', lane: 'x' }, state: 'active', at: '2026-10-19T00:00:00Z' },
      { taskId: `old${index}`, employee: 'eng', deliveryId: 'd', fence: 1, intent: { kind: 'code', lane: 'x' }, state: 'released', at: '2026-10-19T00:00:00Z' },
    ],
  });
  const small = Array.from({ length: 60 }, (_, index) => view(index, `/tmp/wt-${String(index).padStart(3, '0')}`));
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
