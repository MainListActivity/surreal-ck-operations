import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import type { ClaimResult, LeaseProof } from '../src/contracts.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private RocksDB store: no production data, credentials, dispatcher or GitHub.
const run = process.env.RUN_SCK_PR_GATE_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, gm: string, eng: string, qa: string, count = 0;
const asked: Array<{ branch?: string; text: string }> = [];

beforeAll(async () => {
  if (process.env.RUN_SCK_PR_GATE_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-pr-gate-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'pr_gate_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db, { submitCheck: async input => { asked.push(input); return input.text.includes('CONFLICT') ? 'PR 与主干有冲突：先解决冲突再提交。' : undefined; } });
  const admin = new LocalEnrollmentAdmin(db);
  gm = await admin.enroll('gate-gm', 'gm', ['execute', 'review', 'manage']);
  eng = await admin.enroll('gate-eng', 'engineering', ['execute', 'review']);
  qa = await admin.enroll('gate-qa', 'qa', ['execute', 'review']);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const proofOf = (c: ClaimResult): LeaseProof => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });
const make = (executorRole: string, extra: Record<string, unknown> = {}) => core.createTask(gm, { title: `Gate task ${++count}`, context: 'fixture', executorRole, reviewerRole: 'qa', idempotencyKey: `gate-task-${++count}-${crypto.randomUUID()}`, ...extra } as never);
const evidence = (text: string) => ({ text: `${text} — padded so the evidence is long enough`, idempotencyKey: `gate-ev-${++count}-${crypto.randomUUID()}` });

run('an implementation submit that the check refuses never reaches review, and can be resubmitted once fixed', async () => {
  const claim = await core.claim(eng, (await make('engineering')).id);
  await expect(core.submit(eng, proofOf(claim), evidence('PR https://github.com/o/r/pull/7 CONFLICT'))).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('提交被退回（未进入验收）') });
  expect((await core.getTask(gm, claim.task.id)).state).toBe('doing');
  const fixed = await core.submit(eng, proofOf(claim), evidence('PR https://github.com/o/r/pull/7 rebased'));
  expect(fixed.state).toBe('review');
  expect(asked.filter(a => a.text.includes('pull/7'))).toHaveLength(2);
});

run('other roles and other delivery legs are not checked', async () => {
  const before = asked.length;
  const qaClaim = await core.claim(qa, (await make('qa')).id);
  expect((await core.submit(qa, proofOf(qaClaim), evidence('CONFLICT in prose only'))).state).toBe('review');
  const release = await core.claim(eng, (await make('engineering', { kind: 'release' })).id);
  expect((await core.submit(eng, proofOf(release), evidence('release request CONFLICT mention'))).state).toBe('review');
  expect(asked.length).toBe(before);
});

run('a core without a check behaves exactly as before', async () => {
  const plain = new SurrealCompanyCore(db);
  const claim = await plain.claim(eng, (await make('engineering')).id);
  expect((await plain.submit(eng, proofOf(claim), evidence('PR https://github.com/o/r/pull/8 CONFLICT'))).state).toBe('review');
});
