import { afterAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { CompanyError } from '../src/core-errors.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { ProjectStore } from '../src/projects.ts';
import { COMPANY_PART_BYTES, companyBlock, reassembleCompany } from '../src/company-context.ts';
import type { CompanyBrief, CompanyPart } from '../src/contracts.ts';
import { RESPONSE_BUDGET_BYTES, answerBytes } from '../src/response-budget.ts';
import { connectCompanyClient } from '../src/mcp/client';
import { createMcpHttpService } from '../src/mcp/server';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
import type { EmployeeInst } from '../src/workforce.ts';
import { countingFetch, lastBody } from './support/mcp-wire.ts';

// SYS01 AC-A, sample by sample. Each test builds its own fresh namespace on the company fork (scripts/test-worktrees.ts) and
// reads the company block through core, the MCP HTTP service and the sidecar channel. The samples are: the 30683-byte operations
// sample; a 131 KiB sample with over-long CJK and emoji items and a growing project set. Every answer is measured against the
// 49152-byte budget as it is sent. Never production.

setDefaultTimeout(600_000);

const ROOT = join(import.meta.dir, '..');
const suffix = randomUUID().slice(0, 8);
let seq = 0;
const opened: CompanyDatabase[] = [];

/** The operations sample: the company block (paused, directions, goals, projects) as a complete answer carries it, in bytes. */
const OPERATIONS_BLOCK_BYTES = 30683;
/** The byte count of a company block as an answer carries it: the JSON of the block without the answer envelope. */
const blockBytes = (brief: CompanyBrief): number => Buffer.byteLength(JSON.stringify(companyBlock(brief)), 'utf8');

/** A mixed Chinese and emoji unit: 16 UTF-8 bytes for 6 UTF-16 units. */
const unit = '中文🙂字符';
/** About `bytes` UTF-8 bytes of mixed text, starting with `prefix`. */
function textOf(bytes: number, prefix = ''): string {
  let text = prefix;
  while (Buffer.byteLength(text, 'utf8') < bytes) text += unit;
  return text;
}
/** About `units` UTF-16 units of mixed text (directions and goals are capped in characters). */
function unitsOf(units: number, prefix = ''): string {
  let text = prefix;
  while (text.length + unit.length <= units) text += unit;
  return text;
}

type Credential = Parameters<SurrealCompanyCore['contextView']>[0];
type Fixture = {
  database: CompanyDatabase; core: SurrealCompanyCore; owner: OwnerDesk; projects: ProjectStore; enrollment: LocalEnrollmentAdmin;
  gm: Credential; eng: Credential;
};

/** One fresh namespace, bootstrapped by the normal company path, with a gm and an engineer enrolled. */
async function fresh(): Promise<Fixture> {
  const namespace = `sck_cpage_${suffix}_${++seq}`;
  const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace, database: 'control_plane' });
  opened.push(database);
  await database.connect();
  await database.bootstrap();
  const enrollment = new LocalEnrollmentAdmin(database);
  const gm = await enrollment.enroll(`cp-gm-${suffix}-${seq}`, 'owner', ['execute', 'review', 'manage']);
  const eng = await enrollment.enroll(`cp-eng-${suffix}-${seq}`, 'engineering', ['execute', 'review']);
  return {
    database, core: new SurrealCompanyCore(database), owner: new OwnerDesk(database), projects: new ProjectStore(database.db), enrollment, gm, eng,
  };
}

afterAll(async () => {
  for (const database of opened) await database.close();
});

const jsonOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function expectRefused(promise: Promise<unknown>, code: CompanyError['code'], pattern: RegExp) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe(code);
  expect((error as CompanyError).message).toMatch(pattern);
}

/** The reader's check of a whole block: meta, every direction, goal and project equal to the live block, and nothing else. */
function expectBlock(items: ReturnType<typeof reassembleCompany>, brief: CompanyBrief) {
  expect(items.get('meta\0company')!.value).toEqual({ paused: brief.paused });
  brief.directions.forEach((direction, index) => expect(items.get(`directions\0direction-${index}`)!.value).toEqual(jsonOf(direction)));
  for (const project of brief.projects) expect(items.get(`projects\0${project.id}`)!.value).toEqual(jsonOf(project));
  expect(items.size).toBe(1 + brief.directions.length + brief.projects.length);
}

/** Every part once, each at most COMPANY_PART_BYTES, and the parts of one item numbered 0 to parts-1. */
function expectPartsWellFormed(parts: CompanyPart[]) {
  expect(new Set(parts.map(part => `${part.section}\0${part.key}\0${part.part}`)).size).toBe(parts.length);
  expect(parts.every(part => Buffer.byteLength(part.json, 'utf8') <= COMPANY_PART_BYTES)).toBe(true);
}

/** The operations sample: 9000 + 6000 bytes of directions, 7000 + 3000 bytes of goals, a project with two 2 KiB runbooks, then a
 *  final direction sized so the block is exactly OPERATIONS_BLOCK_BYTES. The final direction is written short and then lengthened in
 *  place. Its `at` is a nanosecond timestamp whose text drops trailing zeros, so the overhead of one direction is not that of another. */
async function operationsSample(fx: Fixture): Promise<CompanyBrief> {
  await fx.owner.addDirection({ text: textOf(9000, '方向一 '), source: 'owner:test', key: `ops-${suffix}-dir-a` });
  await fx.owner.addDirection({ text: textOf(6000, '方向二 🙂 '), source: 'owner:test', key: `ops-${suffix}-dir-b` });
  await fx.projects.upsert({
    id: `ops-proj-${suffix}`, name: '样本项目', repoPath: '/fixture/ops', release: 'local', envs: [], runbooks: [textOf(2000, '运行手册甲 '), textOf(2000, '运行手册乙 ')],
  });
  // The owner desk needs at least two characters, so the tuning direction starts as 'yy'. Each 'y' is one byte of JSON and is not
  // escaped, so lengthening the text by n characters grows the block by exactly n bytes, and the `at` written with it stays as it is.
  await fx.owner.addDirection({ text: 'yy', source: 'owner:test', key: `tune-${suffix}` });
  const short = blockBytes(await fx.core.companyBrief(fx.gm));
  expect(short).toBeLessThan(OPERATIONS_BLOCK_BYTES);
  await fx.database.db.query("UPDATE direction SET text = $text WHERE text = 'yy';", { text: 'y'.repeat(OPERATIONS_BLOCK_BYTES - short + 2) });
  const brief = await fx.core.companyBrief(fx.gm);
  expect(blockBytes(brief)).toBe(OPERATIONS_BLOCK_BYTES);
  return brief;
}

/** The 131 KiB sample: a direction of about 50 KiB and two of about 50 and 40 KiB (CJK and emoji), a goal of 40 KiB, and a project set
 *  that grows to 40 projects with long runbooks. */
async function growthSample(fx: Fixture): Promise<CompanyBrief> {
  await fx.owner.addDirection({ text: unitsOf(19_000, '单方向超长 '), source: 'owner:test', key: `grow-${suffix}-dir-huge` });
  await fx.owner.addDirection({ text: unitsOf(19_000, '第二超长方向 '), source: 'owner:test', key: `grow-${suffix}-dir-big` });
  await fx.owner.addDirection({ text: unitsOf(15_000, '第三方向 '), source: 'owner:test', key: `grow-${suffix}-dir-third` });
  for (let index = 0; index < 40; index++) {
    await fx.projects.upsert({
      id: `grow-proj-${index}-${suffix}`, name: `增长项目 ${index}`, repoPath: `/fixture/grow-${index}`, release: 'local', envs: [],
      runbooks: [textOf(1200, `手册 ${index} `)],
    });
  }
  return fx.core.companyBrief(fx.gm);
}

/** Walks every page through core, each answer inside the budget, and returns the parts in the order the pages gave them. */
async function walkCore(fx: Fixture, pageSize: number, section?: 'directions' | 'goals' | 'projects'): Promise<CompanyPart[]> {
  const parts: CompanyPart[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const view = await fx.core.contextView(fx.gm, { scope: 'company', pageSize, ...(section ? { section } : {}), ...(cursor ? { cursor } : {}) });
    expect(answerBytes(view)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    parts.push(...view.parts!);
    if (!view.page!.nextCursor) return parts;
    cursor = view.page!.nextCursor;
  }
  throw new Error('the company listing did not end');
}

/** Walks every page through the MCP HTTP service; every tools/call body on the wire is counted and must fit the budget. */
async function walkMcp(connection: Awaited<ReturnType<typeof connectCompanyClient>>, wire: ReturnType<typeof countingFetch>, args: Record<string, unknown>): Promise<CompanyPart[]> {
  const parts: CompanyPart[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const answer = await connection.client.callTool({ name: 'get_context', arguments: { ...args, ...(cursor ? { cursor } : {}) } });
    expect(answer.structuredContent).toMatchObject({ ok: true });
    expect(lastBody(wire)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const data = (answer.structuredContent as { data: { parts: CompanyPart[]; page: { hasMore: boolean; nextCursor?: string } } }).data;
    parts.push(...data.parts);
    if (!data.page.hasMore) return parts;
    cursor = data.page.nextCursor;
  }
  throw new Error('the company listing did not end over MCP');
}

type SidecarEnv = ReturnType<SidecarPool['env']>;

/** One call through the real comm client (the same process the agents run), with its stdout and exit code. */
async function sidecarCall(channel: SidecarEnv, args: Record<string, unknown>): Promise<{ out: string; exit: number }> {
  const child = Bun.spawn([process.execPath, join(ROOT, 'src/mcp/client-cli.ts'), 'call', 'get_context', JSON.stringify(args)], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, SCK_COMM_DIR: channel.SCK_COMM_DIR, SCK_COMM_KEY: channel.SCK_COMM_KEY },
  });
  const [out, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { out, exit };
}

/** Walks every page through the sidecar channel; each printed answer is measured in bytes and must fit the budget. */
async function walkSidecar(channel: SidecarEnv, args: Record<string, unknown>): Promise<CompanyPart[]> {
  const parts: CompanyPart[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const reply = await sidecarCall(channel, { ...args, ...(cursor ? { cursor } : {}) });
    expect(reply.exit).toBe(0);
    expect(Buffer.byteLength(reply.out, 'utf8')).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const body = JSON.parse(reply.out) as { parts: CompanyPart[]; page: { hasMore: boolean; nextCursor?: string } };
    parts.push(...body.parts);
    if (!body.page.hasMore) return parts;
    cursor = body.page.nextCursor;
  }
  throw new Error('the company listing did not end over the sidecar');
}

test('AC-A 30683-byte sample (core): task answers leave the block out, the complete block is refused, pages reassemble it exactly', async () => {
  const fx = await fresh();
  const brief = await operationsSample(fx);
  // The fixture's live tasks hold about 86 KB of text, so the legacy answer is read over a state that fits the budget.
  const legacy = await fx.core.contextView(fx.gm, { state: 'done' });
  expect(Object.keys(legacy).sort()).toEqual(['companyIncluded', 'companyRead', 'principal', 'tasks']);
  expect(legacy.companyIncluded).toBe(false);
  expect(legacy.companyRead).toEqual({ scope: 'company', pageSize: 25 });
  // A task answer with the block cannot carry it whole, and a complete company answer cannot either.
  await expectRefused(fx.core.contextView(fx.gm, { includeCompany: true, state: 'done' }), 'response_too_large', /pageSize/);
  await expectRefused(fx.core.contextView(fx.gm, { scope: 'company' }), 'response_too_large', /pageSize/);
  // A pinned task detail is answered by default whatever the block weighs: the block is read only when includeCompany asks for it.
  const pinned = await fx.core.createTask(fx.gm, {
    title: `定点详情 ${suffix}`, context: textOf(600, '任务上下文 '), executorRole: 'engineering', reviewerRole: 'qa',
    idempotencyKey: `pinned-ops-${suffix}`,
  });
  const detail = await fx.core.contextView(fx.gm, { taskId: pinned.id });
  expect(detail.companyIncluded).toBe(false);
  expect(detail.tasks).toHaveLength(1);
  expect(answerBytes(detail)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  const parts = await walkCore(fx, 4);
  expectPartsWellFormed(parts);
  expectBlock(reassembleCompany(parts), brief);
});

test('AC-A 131 KiB sample (core): over-long CJK and emoji items are cut into parts and page back whole, and a project added mid-walk is not in that walk', async () => {
  const fx = await fresh();
  const brief = await growthSample(fx);
  // The same pinned-detail default on the 131 KiB sample: the growing block never stands between a reader and one task.
  const pinned = await fx.core.createTask(fx.gm, {
    title: `定点详情 131 ${suffix}`, context: textOf(600, '任务上下文 '), executorRole: 'engineering', reviewerRole: 'qa',
    idempotencyKey: `pinned-grow-${suffix}`,
  });
  const detail = await fx.core.contextView(fx.gm, { taskId: pinned.id });
  expect(detail.companyIncluded).toBe(false);
  expect(detail.tasks).toHaveLength(1);
  expect(answerBytes(detail)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  const parts = await walkCore(fx, 3);
  expectPartsWellFormed(parts);
  // The 50 KiB direction alone needs at least four parts of at most 16 KiB.
  const perItem = new Map<string, number>();
  for (const part of parts) perItem.set(`${part.section}\0${part.key}`, part.parts);
  expect(Math.max(...perItem.values())).toBeGreaterThanOrEqual(4);
  expectBlock(reassembleCompany(parts), brief);
  // The listing is fixed at its first page: a project added while the pages are read is not in that walk, and the next walk has it.
  const first = await fx.core.contextView(fx.gm, { scope: 'company', pageSize: 3 });
  await fx.projects.upsert({ id: `grow-late-${suffix}`, name: '中途新增', repoPath: '/fixture/late', release: 'local', envs: [], runbooks: [] });
  const rest: CompanyPart[] = [...first.parts!];
  let cursor = first.page!.nextCursor;
  while (cursor) {
    const view = await fx.core.contextView(fx.gm, { scope: 'company', pageSize: 3, cursor });
    rest.push(...view.parts!);
    cursor = view.page!.nextCursor;
  }
  expect(reassembleCompany(rest).has(`projects\0grow-late-${suffix}`)).toBe(false);
  expectBlock(reassembleCompany(rest), brief);
  expectBlock(reassembleCompany(await walkCore(fx, 5)), await fx.core.companyBrief(fx.gm));
});

test('AC-A reassembly refuses a missing, repeated or altered part of a stored item', async () => {
  const fx = await fresh();
  await fx.owner.addDirection({ text: unitsOf(19_000, '超长方向 '), source: 'owner:test', key: `re-${suffix}-dir` });
  const parts = await walkCore(fx, 100, 'directions');
  const item = parts.filter(part => part.section === 'directions');
  expect(item.length).toBeGreaterThan(1);
  expect(() => reassembleCompany(item)).not.toThrow();
  const refusal = (candidate: CompanyPart[]) => {
    try { reassembleCompany(candidate); } catch (error) { return error; }
    return undefined;
  };
  // A missing part, a repeated part and an altered part are each refused, never read as a shorter item.
  const missing = refusal(item.slice(0, -1));
  expect(missing).toBeInstanceOf(CompanyError);
  expect((missing as CompanyError).code).toBe('invalid');
  const repeated = refusal([...item, item[0]!]);
  expect(repeated).toBeInstanceOf(CompanyError);
  expect((repeated as CompanyError).code).toBe('invalid');
  // A part whose text changed keeps its byte count and fails the SHA-256 check.
  const altered = refusal(item.map((part, index) => (index === 0 ? { ...part, json: ` ${part.json.slice(1)}` } : part)));
  expect(altered).toBeInstanceOf(CompanyError);
  expect((altered as CompanyError).code).toBe('invalid');
  expect((altered as CompanyError).message).toMatch(/SHA-256/);
});

test('AC-A rejections: another caller, another section, another query, an altered cursor, an expired cursor and a revoked identity are refused', async () => {
  const fx = await fresh();
  await fx.owner.addDirection({ text: textOf(20_000, '权限样本 '), source: 'owner:test', key: `auth-${suffix}-dir` });
  const first = await fx.core.contextView(fx.gm, { scope: 'company', pageSize: 1 });
  const cursor = first.page!.nextCursor!;
  expect(cursor.length).toBeGreaterThan(0);
  // Another caller, another section, another query: each forbidden.
  await expectRefused(fx.core.contextView(fx.eng, { scope: 'company', pageSize: 1, cursor }), 'forbidden', /another caller or query/);
  await expectRefused(fx.core.contextView(fx.gm, { scope: 'company', section: 'goals', pageSize: 1, cursor }), 'forbidden', /another caller or query/);
  await expectRefused(fx.core.contextView(fx.gm, { pageSize: 1, cursor }), 'forbidden', /another caller or another query/);
  // An altered cursor: the first payload character changes, so the signature no longer verifies.
  const altered = cursor.replace(/^v1\.(.)/, (_, head: string) => `v1.${head === 'A' ? 'B' : 'A'}`);
  expect(altered).not.toBe(cursor);
  await expectRefused(fx.core.contextView(fx.gm, { scope: 'company', pageSize: 1, cursor: altered }), 'invalid', /altered|verification/);
  // Refusals leave the listing intact: the untouched cursor still reads the next part.
  const next = await fx.core.contextView(fx.gm, { scope: 'company', pageSize: 1, cursor });
  expect(next.parts).toHaveLength(1);
  // An expired cursor: the clock moves past the six-hour listing, so the listing is gone.
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 7 * 60 * 60 * 1000);
  try {
    await expectRefused(fx.core.contextView(fx.gm, { scope: 'company', pageSize: 1, cursor }), 'snapshot_gone', /expired/);
  } finally {
    clock.mockRestore();
  }
  // A revoked identity is refused on its next page, before the listing is read.
  const leaver = await fx.enrollment.enroll(`cp-leaver-${suffix}-${seq}`, 'engineering', ['execute', 'review']);
  const leaverFirst = await fx.core.contextView(leaver, { scope: 'company', pageSize: 1 });
  await fx.enrollment.revoke(`cp-leaver-${suffix}-${seq}`);
  await expectRefused(fx.core.contextView(leaver, { scope: 'company', pageSize: 1, cursor: leaverFirst.page!.nextCursor! }), 'unauthorized', /./);
});

test('AC-A 30683-byte sample (MCP HTTP): the block pages back whole, every tools/call body on the wire fits the budget, and the complete answers are refused on the wire', async () => {
  const fx = await fresh();
  const brief = await operationsSample(fx);
  const service = createMcpHttpService({ core: fx.core, port: 0 });
  const wire = countingFetch();
  const connection = await connectCompanyClient({
    url: new URL(`http://127.0.0.1:${service.port}/mcp`), credential: fx.gm, clientName: 'company-paging-samples', fetch: wire.fetch,
  });
  try {
    expectBlock(reassembleCompany(await walkMcp(connection, wire, { scope: 'company', pageSize: 4 })), brief);
    const refused = await connection.client.callTool({ name: 'get_context', arguments: { scope: 'company' } });
    expect(refused.structuredContent).toMatchObject({ ok: false, code: 'response_too_large' });
    expect(lastBody(wire)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const withBlock = await connection.client.callTool({ name: 'get_context', arguments: { includeCompany: true, state: 'done' } });
    expect(withBlock.structuredContent).toMatchObject({ ok: false, code: 'response_too_large' });
    expect(lastBody(wire)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const legacy = await connection.client.callTool({ name: 'get_context', arguments: { state: 'done' } });
    expect(legacy.structuredContent).toMatchObject({
      ok: true, data: { companyIncluded: false, companyRead: { scope: 'company', pageSize: 25 } },
    });
    expect((legacy.structuredContent as { data: object }).data).not.toHaveProperty('company');
    expect(lastBody(wire)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  } finally {
    await connection.close();
    await service.close();
  }
});

test('AC-A 131 KiB sample (MCP HTTP and sidecar channel): both readers return the same parts as core, every answer inside the budget', async () => {
  const fx = await fresh();
  const brief = await growthSample(fx);
  const fromCore = await walkCore(fx, 5);
  const service = createMcpHttpService({ core: fx.core, port: 0 });
  const wire = countingFetch();
  const connection = await connectCompanyClient({
    url: new URL(`http://127.0.0.1:${service.port}/mcp`), credential: fx.gm, clientName: 'company-paging-samples', fetch: wire.fetch,
  });
  const runDir = mkdtempSync(join(tmpdir(), 'cp-sidecar-'));
  try {
    const fromMcp = await walkMcp(connection, wire, { scope: 'company', pageSize: 5 });
    expect(fromMcp).toEqual(fromCore);
    expectBlock(reassembleCompany(fromMcp), brief);
    // The sidecar channel holds the credential it is given (the workforce stub is never asked for another).
    const pool = new SidecarPool({ core: fx.core, workforce: { rotate: async () => fx.gm } as unknown as SidecarDeps['workforce'], runDir, sweepMs: 5 });
    const channel = pool.env({ id: `cp-channel-${suffix}`, credential: fx.gm } as unknown as EmployeeInst);
    const fromSidecar = await walkSidecar(channel, { scope: 'company', pageSize: 8 });
    expect(fromSidecar).toEqual(fromCore);
    expectBlock(reassembleCompany(fromSidecar), brief);
  } finally {
    await connection.close();
    await service.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('AC-A 30683-byte sample (sidecar channel): pages reassemble, the legacy answer keeps the block out, and the complete answer is refused', async () => {
  const fx = await fresh();
  const brief = await operationsSample(fx);
  const runDir = mkdtempSync(join(tmpdir(), 'cp-sidecar-'));
  try {
    const pool = new SidecarPool({ core: fx.core, workforce: { rotate: async () => fx.gm } as unknown as SidecarDeps['workforce'], runDir, sweepMs: 5 });
    const channel = pool.env({ id: `cp-channel-ops-${suffix}`, credential: fx.gm } as unknown as EmployeeInst);
    expectBlock(reassembleCompany(await walkSidecar(channel, { scope: 'company', pageSize: 8 })), brief);
    const refused = await sidecarCall(channel, { scope: 'company' });
    expect(refused.exit).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({ ok: false, code: 'response_too_large' });
    const legacy = await sidecarCall(channel, { pageSize: 2 });
    expect(legacy.exit).toBe(0);
    const body = JSON.parse(legacy.out) as object;
    expect(Object.keys(body).sort()).toEqual(['companyIncluded', 'companyRead', 'page', 'principal', 'tasks']);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('R4 Chinese byte overflow (core): tasks under the budget in characters but over it in UTF-8 bytes are refused before their text is loaded, and page back whole', async () => {
  const fx = await fresh();
  const since = new Date(Date.now() - 1_000).toISOString();
  // Three tasks of 7000 CJK characters each: about 21000 characters, under the 49152 budget, but about 63000 UTF-8 bytes, over it.
  const contexts = [0, 1, 2].map(index => `样例 ${index} ${'中'.repeat(7_000)}`);
  const characters = contexts.reduce((sum, text) => sum + [...text].length, 0);
  const bytes = contexts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
  expect(characters).toBeLessThan(RESPONSE_BUDGET_BYTES);
  expect(bytes).toBeGreaterThan(RESPONSE_BUDGET_BYTES);
  const ids: string[] = [];
  for (const [index, context] of contexts.entries()) {
    const task = await fx.core.createTask(fx.gm, {
      title: `R4 中文字节 ${index}`, context, executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `r4-${suffix}-${index}`,
    });
    ids.push(task.id);
  }
  // The byte total is read first, and no task text is loaded while it is over the budget.
  const reads = spyOn(fx.core as unknown as { consistentRead: (...args: unknown[]) => unknown }, 'consistentRead');
  try {
    await expectRefused(fx.core.contextView(fx.gm, { state: 'ready', since }), 'response_too_large',
      new RegExp(`bytes of text, above the ${RESPONSE_BUDGET_BYTES}-byte budget`));
    const probes = (await Promise.all(reads.mock.results.map(result => result.value as Promise<Record<string, unknown>>)))
      .filter(read => 'textBytes' in read);
    expect(probes).toHaveLength(1);
    expect(Number(probes[0]!.textBytes)).toBe(bytes);
    expect(probes[0]!.rows).toEqual([]);
  } finally {
    reads.mockRestore();
  }
  // Read a page at a time, the same tasks come back whole, each answer inside the budget.
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const view = await fx.core.contextView(fx.gm, { state: 'ready', since, pageSize: 1, ...(cursor ? { cursor } : {}) });
    expect(answerBytes(view)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    seen.push(...(view.tasks ?? []).map(task => String(task.id)));
    cursor = view.page?.hasMore ? view.page.nextCursor : undefined;
  } while (cursor);
  expect(seen.sort()).toEqual([...ids].sort());
});
