import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
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
import { COMPANY_PART_BYTES, reassembleCompany } from '../src/company-context.ts';
import type { CompanyBrief, CompanyPart, ContextView } from '../src/contracts.ts';
import { RESPONSE_BUDGET_BYTES, answerBytes } from '../src/response-budget.ts';
import { connectCompanyClient } from '../src/mcp/client';
import { createMcpHttpService } from '../src/mcp/server';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
import type { EmployeeInst } from '../src/workforce.ts';
import { countingFetch, lastBody } from './support/mcp-wire.ts';

// SYS01 AC-A on the isolated company fork (scripts/test-worktrees.ts): get_context with scope company, the company block read in
// stored parts, and the task answers that now leave the block out by default. The same block is read through core, the MCP HTTP
// service and the sidecar channel, and every answer is measured against the budget as it is sent. Never production.
const NS = 'sck_agent_company_test_scope';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
const core = new SurrealCompanyCore(database);
const owner = new OwnerDesk(database);
const suffix = randomUUID().slice(0, 8);
let seq = 0;
const key = (label: string) => `cs-${suffix}-${label}-${++seq}`;
setDefaultTimeout(600_000);
const ROOT = join(import.meta.dir, '..');

const unit = '中文🙂字符';
/** About `bytes` UTF-8 bytes of mixed Chinese and emoji, starting with `prefix`. */
function textOf(bytes: number, prefix = ''): string {
  let text = prefix;
  while (Buffer.byteLength(text, 'utf8') < bytes) text += unit;
  return text;
}

/** A text of at most `units` UTF-16 units (directions and goals are capped in characters), mixed Chinese and emoji. */
function unitsOf(units: number, prefix = ''): string {
  let text = prefix;
  while (text.length + unit.length <= units) text += unit;
  return text;
}

let gm: string;
let eng: string;

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  const enrollment = new LocalEnrollmentAdmin(database);
  gm = await enrollment.enroll(`cs-gm-${suffix}`, 'gm', ['execute', 'review', 'manage']);
  eng = await enrollment.enroll(`cs-eng-${suffix}`, 'engineering', ['execute', 'review']);
});

afterAll(async () => {
  await database.close();
});

const live = (): Promise<CompanyBrief> => core.companyBrief(gm);
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
  for (const goal of brief.goals) expect(items.get(`goals\0${goal.id}`)!.value).toEqual(jsonOf(goal));
  for (const project of brief.projects) expect(items.get(`projects\0${project.id}`)!.value).toEqual(jsonOf(project));
  expect(items.size).toBe(1 + brief.directions.length + brief.goals.length + brief.projects.length);
}

/** Walks every page of one listing, each answer inside the budget, and returns the parts in the order the pages gave them. */
async function walk(read: (cursor?: string) => Promise<{ parts: CompanyPart[]; nextCursor?: string; bytes: number }>): Promise<CompanyPart[]> {
  const parts: CompanyPart[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const answer = await read(cursor);
    expect(answer.bytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    parts.push(...answer.parts);
    if (!answer.nextCursor) return parts;
    cursor = answer.nextCursor;
  }
  throw new Error('the company listing did not end');
}

const coreWalk = (pageSize: number, section?: 'directions' | 'goals' | 'projects') => walk(async cursor => {
  const view = await core.contextView(gm, { scope: 'company', pageSize, ...(section ? { section } : {}), ...(cursor ? { cursor } : {}) });
  return { parts: view.parts!, nextCursor: view.page!.nextCursor, bytes: answerBytes(view) };
});

test('task answers leave the company block out by default, and say whether they carry it and how it is read', async () => {
  const legacy = await core.contextView(gm, {});
  expect(Object.keys(legacy).sort()).toEqual(['companyIncluded', 'companyRead', 'principal', 'tasks']);
  expect(legacy.companyIncluded).toBe(false);
  expect(legacy.companyRead).toEqual({ scope: 'company', pageSize: 25 });
  const paged = await core.contextView(gm, { pageSize: 5 });
  expect(paged).not.toHaveProperty('company');
  expect(paged.companyIncluded).toBe(false);
  expect(await core.contextView(gm, { includeCompany: false })).not.toHaveProperty('company');
  // A block that fits is kept whole: the answer counts the block twice (content text and structuredContent), and this one is small.
  expect((await core.contextView(gm, { includeCompany: true, state: 'done' })).company).toBeDefined();
  expect(Object.keys((await core.contextView(gm, { scope: 'company' })) as ContextView).sort()).toEqual(['company', 'principal', 'scope']);
});

test('the 31 KiB sample: the block pages back whole, and task answers keep it whole while it fits', async () => {
  // The operations sample is a 30683-byte company block: long directions, goals and a project with a long runbook.
  await owner.addDirection({ text: textOf(9000, '方向一 '), source: 'owner:test', key: key('dir-a') });
  await owner.addDirection({ text: textOf(6000, '方向二 🙂 '), source: 'owner:test', key: key('dir-b') });
  await owner.createGoal({ text: textOf(7000, '目标简报 '), source: 'owner:test', key: key('goal-a'), tier: 'standard' });
  await owner.createGoal({ text: textOf(3000, '第二目标 '), source: 'owner:test', key: key('goal-b'), tier: 'standard' });
  await new ProjectStore(database.db).upsert({ id: `cs-proj-a-${suffix}`, name: '样本项目', repoPath: '/fixture/cs-a', release: 'local', envs: [], runbooks: [textOf(4000, '运行手册 "引号" ')] });
  const brief = await live();
  // About 30 KiB of block is about 60 KiB of answer, so neither the task answer nor the complete company answer can carry it whole.
  await expectRefused(core.contextView(gm, { includeCompany: true, state: 'done' }), 'response_too_large', /pageSize/);
  await expectRefused(core.contextView(gm, { scope: 'company' }), 'response_too_large', /pageSize/);
  expectBlock(reassembleCompany(await coreWalk(4)), brief);
});

test('the 128 KiB sample: a block that does not fit is refused with paging guidance, and pages reassemble exactly', async () => {
  // Two long directions (about 50 KiB each, emoji-rich), a third of about 40 KiB, a long goal and a project set that grows.
  await owner.addDirection({ text: unitsOf(19_000, '单方向超长 '), source: 'owner:test', key: key('dir-huge') });
  await owner.addDirection({ text: unitsOf(19_000, '第二超长方向 '), source: 'owner:test', key: key('dir-big') });
  await owner.addDirection({ text: unitsOf(15_000, '第三方向 '), source: 'owner:test', key: key('dir-third') });
  await owner.createGoal({ text: textOf(40 * 1024, '大目标 🙂 '), source: 'owner:test', key: key('goal-big'), tier: 'standard' });
  const projects = new ProjectStore(database.db);
  for (let index = 0; index < 40; index++) {
    await projects.upsert({ id: `cs-proj-${index}-${suffix}`, name: `增长项目 ${index}`, repoPath: `/fixture/cs-${index}`, release: 'local', envs: [], runbooks: [textOf(1200, `手册 ${index} `)] });
  }
  const brief = await live();
  await expectRefused(core.contextView(gm, { includeCompany: true, state: 'done' }), 'response_too_large', /pageSize/);
  await expectRefused(core.contextView(gm, { includeCompany: true, state: 'done' }), 'response_too_large', /scope/);
  await expectRefused(core.contextView(gm, { scope: 'company' }), 'response_too_large', /pageSize/);
  // The block is complete on the pages: every part once, every item equal to the live block.
  const parts = await coreWalk(3);
  expect(new Set(parts.map(part => `${part.section}\0${part.key}\0${part.part}`)).size).toBe(parts.length);
  expect(parts.every(part => Buffer.byteLength(part.json, 'utf8') <= COMPANY_PART_BYTES)).toBe(true);
  expectBlock(reassembleCompany(parts), brief);
  // One section is read on its own; the meta part still comes with it.
  const goals = reassembleCompany(await coreWalk(5, 'goals'));
  expect([...goals.keys()].every(name => name.startsWith('meta\0') || name.startsWith('goals\0'))).toBe(true);
  expect(goals.size).toBe(1 + brief.goals.length);
});

test('a company cursor is bound to its caller, its section and its scope, and an altered one is refused', async () => {
  const first = await core.contextView(gm, { scope: 'company', pageSize: 2 });
  const cursor = first.page!.nextCursor!;
  expect(cursor.length).toBeGreaterThan(0);
  await expectRefused(core.contextView(eng, { scope: 'company', pageSize: 2, cursor }), 'forbidden', /another caller/);
  await expectRefused(core.contextView(gm, { scope: 'company', section: 'goals', pageSize: 2, cursor }), 'forbidden', /another query/);
  await expectRefused(core.contextView(gm, { pageSize: 2, cursor }), 'forbidden', /another query/);
  // The first payload character changes, so the signature no longer verifies (a change to the last character of the signature
  // can leave its decoded bytes unchanged, and is not an alteration).
  const altered = cursor.replace(/^v1\.(.)/, (_, first: string) => `v1.${first === 'A' ? 'B' : 'A'}`);
  expect(altered).not.toBe(cursor);
  await expectRefused(core.contextView(gm, { scope: 'company', pageSize: 2, cursor: altered }), 'invalid', /altered|verification/);
});

test('the MCP HTTP service returns the same block, and every answer on the wire stays inside the budget', async () => {
  const service = createMcpHttpService({ core, port: 0 });
  const wire = countingFetch();
  const connection = await connectCompanyClient({
    url: new URL(`http://127.0.0.1:${service.port}/mcp`), credential: gm, clientName: 'company-scope', fetch: wire.fetch,
  });
  try {
    const parts: CompanyPart[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const answer = await connection.client.callTool({ name: 'get_context', arguments: { scope: 'company', pageSize: 6, ...(cursor ? { cursor } : {}) } });
      expect(answer.structuredContent).toMatchObject({ ok: true });
      expect(lastBody(wire)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      const data = (answer.structuredContent as { data: { parts: CompanyPart[]; page: { hasMore: boolean; nextCursor?: string } } }).data;
      parts.push(...data.parts);
      if (!data.page.hasMore) break;
      cursor = data.page.nextCursor;
    }
    expectBlock(reassembleCompany(parts), await live());
    const tasks = await connection.client.callTool({ name: 'get_context', arguments: { pageSize: 2 } });
    expect(tasks.structuredContent).toMatchObject({ ok: true, data: { companyIncluded: false, companyRead: { scope: 'company', pageSize: 25 } } });
    expect(lastBody(wire)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  } finally {
    await connection.close();
    await service.close();
  }
});

test('the real sidecar channel and comm client read the same block in pages, every page inside the budget', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'cs-sidecar-'));
  try {
    // The pool holds the credential it is given and never rotates it, so the workforce stub is never asked for one.
    const pool = new SidecarPool({ core, workforce: { rotate: async () => gm } as unknown as SidecarDeps['workforce'], runDir, sweepMs: 5 });
    const channel = pool.env({ id: `cs-channel-${suffix}`, credential: gm } as unknown as EmployeeInst);
    const call = async (args: Record<string, unknown>) => {
      const child = Bun.spawn([process.execPath, join(ROOT, 'src/mcp/client-cli.ts'), 'call', 'get_context', JSON.stringify(args)], {
        cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, SCK_COMM_DIR: channel.SCK_COMM_DIR, SCK_COMM_KEY: channel.SCK_COMM_KEY },
      });
      const [out, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return { out, exit };
    };
    const parts = await walk(async cursor => {
      const reply = await call({ scope: 'company', pageSize: 8, ...(cursor ? { cursor } : {}) });
      expect(reply.exit).toBe(0);
      const body = JSON.parse(reply.out) as { parts: CompanyPart[]; page: { nextCursor?: string } };
      return { parts: body.parts, nextCursor: body.page.nextCursor, bytes: Buffer.byteLength(reply.out, 'utf8') };
    });
    expectBlock(reassembleCompany(parts), await live());
    // Legacy task answers over the channel: the keys say the block is not in them.
    const legacy = await call({ pageSize: 2 });
    expect(legacy.exit).toBe(0);
    expect(Object.keys(JSON.parse(legacy.out) as object).sort()).toEqual(['companyIncluded', 'companyRead', 'page', 'principal', 'tasks']);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
