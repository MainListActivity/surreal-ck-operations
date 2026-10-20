// SYS01 M3 on the isolated company fork (scripts/test-worktrees.ts): a project's environments and their credential aliases (names and
// roles) are shown to gm and to the holder of a valid lease on a task of that project, and to nobody else, through the company
// block, its sections, its pages and its continuations. Project identity stays visible to everyone. The owner's console keeps the
// full view. Everything here is synthetic; the secret value must never appear in any answer.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { CompanyError } from '../src/core-errors.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { ProjectStore } from '../src/projects.ts';
import type { ClaimResult, CompanyBrief, CompanyPart, ContextView, LeaseProof } from '../src/contracts.ts';

setDefaultTimeout(120_000);

const NS = `sck_agent_env_visibility_${randomUUID().slice(0, 8)}`;
const PROJECT = 'env-proj';
const ENV = 'staging';
const SECRET = 'deploy-token';
const SECRET_VALUE = 'synthetic-secret-value-never-shown';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
const core = new SurrealCompanyCore(database);
// A core whose leases are one second long, for the expiry check.
const shortCore = new SurrealCompanyCore(database, { leaseSeconds: 1 });
const owner = new OwnerDesk(database);
const projects = new ProjectStore(database.db);
const suffix = randomUUID().slice(0, 8);
let count = 0;

let gm: string;
let holder: string;
let other: string;
let expiring: string;
let pager: string;
let taskHolder: string;
let taskExpiring: string;
let taskPager: string;

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  const enrollment = new LocalEnrollmentAdmin(database);
  gm = await enrollment.enroll(`ev-gm-${suffix}`, 'gm', ['execute', 'review', 'manage']);
  holder = await enrollment.enroll(`ev-holder-${suffix}`, 'engineering', ['execute', 'review']);
  other = await enrollment.enroll(`ev-other-${suffix}`, 'engineering', ['execute', 'review']);
  expiring = await enrollment.enroll(`ev-expiring-${suffix}`, 'engineering', ['execute', 'review']);
  pager = await enrollment.enroll(`ev-pager-${suffix}`, 'engineering', ['execute', 'review']);
  await projects.upsert({
    id: PROJECT, name: 'Environment visibility fixture', repoPath: '/tmp/sck-env-visibility-fixture', defaultBranch: 'main', release: 'none',
    envs: [{ name: ENV, url: 'https://staging.synthetic.example.test', verify: 'synthetic check' }],
  });
  await projects.setSecret({ project: PROJECT, env: ENV, name: SECRET, value: SECRET_VALUE, roles: ['engineering'] }, randomBytes(32));
  const task = () => core.createTask(gm, {
    title: `env visibility fixture ${++count}`, context: 'Synthetic fixture for the project environment visibility test',
    executorRole: 'engineering', reviewerRole: 'engineering', project: PROJECT, idempotencyKey: `env-visibility-${suffix}-${count}`,
  });
  taskHolder = (await task()).id;
  taskExpiring = (await task()).id;
  taskPager = (await task()).id;
});

afterAll(async () => {
  try { await database.db.query(`REMOVE NAMESPACE IF EXISTS ${NS};`); } catch { /* best effort */ }
  await database.close();
});

const proof = (claim: ClaimResult): LeaseProof => ({ taskId: claim.task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version });
const projectOf = (brief: CompanyBrief) => {
  const found = brief.projects.find(project => project.id === PROJECT);
  if (!found) throw new Error('the fixture project is missing from the company block');
  return found;
};
/** Every part of one listing, page after page; each answer is checked to be a page of the same listing. */
async function everyPart(read: (cursor?: string) => Promise<ContextView>): Promise<CompanyPart[]> {
  const parts: CompanyPart[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const view = await read(cursor);
    parts.push(...(view.parts ?? []));
    if (!view.page?.nextCursor) return parts;
    cursor = view.page.nextCursor;
  }
  throw new Error('the company listing did not end');
}
async function expectRefused(promise: Promise<unknown>, code: CompanyError['code'], pattern: RegExp) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe(code);
  expect((error as CompanyError).message).toMatch(pattern);
}

test('a manage holder with no lease on the project gets the project identity back from project_disciplines_update, never its environments', async () => {
  const product = await new LocalEnrollmentAdmin(database).enroll(`ev-product-${suffix}`, 'product', ['execute', 'review', 'manage']);
  const answer = await core.updateProjectDisciplines(product, { project: PROJECT, disciplines: [{ name: 'fixture-track' }] });
  expect(answer.id).toBe(PROJECT);
  expect(answer.envs).toEqual([]);
  expect(answer.envsWithheld).toBe(true);
  expect(JSON.stringify(answer)).not.toContain(SECRET);
  const full = await core.updateProjectDisciplines(gm, { project: PROJECT, disciplines: [{ name: 'fixture-track' }] });
  expect(full.envs).toEqual([expect.objectContaining({ name: ENV })]);
});

test('the owner console keeps the full environment view, with its credential aliases and roles', async () => {
  const project = (await owner.brief()).projects.find(item => item.id === PROJECT);
  expect(project?.envs).toEqual([expect.objectContaining({ name: ENV, secrets: [{ name: SECRET, roles: ['engineering'] }] })]);
  expect(project?.envsWithheld).toBeUndefined();
});

test('gm reads every environment and credential alias in the company block', async () => {
  const project = projectOf(await core.companyBrief(gm));
  expect(project.envsWithheld).toBeUndefined();
  expect(project.envs).toEqual([expect.objectContaining({ name: ENV, secrets: [{ name: SECRET, roles: ['engineering'] }] })]);
});

test('an unrelated employee reads the project identity, and no environment, credential alias or role', async () => {
  const project = projectOf(await core.companyBrief(other));
  expect(project).toMatchObject({ id: PROJECT, name: 'Environment visibility fixture', repoPath: '/tmp/sck-env-visibility-fixture', defaultBranch: 'main' });
  expect(project.envs).toEqual([]);
  expect(project.envsWithheld).toBe(true);
  const text = JSON.stringify(await core.companyBrief(other));
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(ENV);
  expect(text).not.toContain(SECRET_VALUE);
});

test('the holder of a valid lease on a task of the project reads its environments; the lease ends, the view is withheld again', async () => {
  const claim = await core.claim(holder, taskHolder);
  expect(projectOf(await core.companyBrief(holder)).envs).toEqual([expect.objectContaining({ name: ENV })]);
  await core.submit(holder, proof(claim), { text: 'Synthetic delivery for the environment visibility test', idempotencyKey: `ev-submit-${suffix}` });
  // The lease is released by the submit: the same reader sees the identity only.
  expect(projectOf(await core.companyBrief(holder)).envsWithheld).toBe(true);
});

test('an expired lease withholds the environments at once', async () => {
  await shortCore.claim(expiring, taskExpiring);
  expect(projectOf(await core.companyBrief(expiring)).envs).toEqual([expect.objectContaining({ name: ENV })]);
  await Bun.sleep(2_100);
  expect(projectOf(await core.companyBrief(expiring)).envsWithheld).toBe(true);
});

test('a company listing read by an unrelated employee has no environment in any page, its section or its non-paged answer', async () => {
  const pages = await everyPart(cursor => core.contextView(other, { scope: 'company', pageSize: 1, ...(cursor ? { cursor } : {}) }));
  const text = JSON.stringify(pages);
  expect(text).toContain(PROJECT);
  expect(text).toContain('envsWithheld');
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(SECRET_VALUE);
  const section = JSON.stringify(await everyPart(cursor => core.contextView(other, { scope: 'company', section: 'projects', pageSize: 1, ...(cursor ? { cursor } : {}) })));
  expect(section).not.toContain(SECRET);
  expect(section).toContain('envsWithheld');
  const whole = await core.contextView(other, { scope: 'company' });
  expect(JSON.stringify(whole)).not.toContain(SECRET);
  expect(JSON.stringify(whole)).toContain('envsWithheld');
});

test('a listing read by gm keeps every environment page after page; a listing is bound to its caller', async () => {
  const pages = await everyPart(cursor => core.contextView(gm, { scope: 'company', pageSize: 1, ...(cursor ? { cursor } : {}) }));
  expect(JSON.stringify(pages)).toContain(SECRET);
  expect(JSON.stringify(pages)).not.toContain('envsWithheld');
  const first = await core.contextView(gm, { scope: 'company', pageSize: 1 });
  await expectRefused(core.contextView(other, { scope: 'company', pageSize: 1, cursor: first.page!.nextCursor }), 'forbidden', /another caller/);
});

test('a listing taken under a valid lease is refused once the lease ends: its later pages never carry the environments', async () => {
  const claim = await core.claim(pager, taskPager);
  const first = await core.contextView(pager, { scope: 'company', pageSize: 1 });
  expect(first.page?.nextCursor).toBeDefined();
  // Under the lease the listing's pages carry the environments: the first page is the meta part, and the project follows it.
  const taken = JSON.stringify(await everyPart(cursor => core.contextView(pager, { scope: 'company', pageSize: 1, ...(cursor ? { cursor } : {}) })));
  expect(taken).toContain(ENV);
  await core.submit(pager, proof(claim), { text: 'Synthetic delivery for the continuation test', idempotencyKey: `ev-pager-${suffix}` });
  await expectRefused(core.contextView(pager, { scope: 'company', pageSize: 1, cursor: first.page!.nextCursor }), 'forbidden',
    /other access to project environments/);
  const restarted = JSON.stringify(await everyPart(cursor => core.contextView(pager, { scope: 'company', pageSize: 1, ...(cursor ? { cursor } : {}) })));
  expect(restarted).not.toContain(SECRET);
  expect(restarted).toContain('envsWithheld');
});

test('read_task_text of the project field: gm and the valid holder read it; an unrelated employee is refused', async () => {
  const read = (who: string, taskId: string) => core.taskText(who, { taskId, field: 'project' });
  expect(JSON.stringify(await read(gm, taskHolder))).toContain(ENV);
  await expectRefused(Promise.resolve().then(() => read(other, taskHolder)), 'forbidden', /gm or the holder of a valid task lease/);
  // The expired holder's lease on taskExpiring has ended, so that holder is refused as well.
  await expectRefused(Promise.resolve().then(() => read(expiring, taskExpiring)), 'forbidden', /gm or the holder of a valid task lease/);
});
