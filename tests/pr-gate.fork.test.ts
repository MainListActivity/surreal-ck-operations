import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import type { ClaimResult, LeaseProof } from '../src/contracts.ts';
import { createHash } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { SidecarPool } from '../src/runner/sidecar.ts';
import { ExecutionJournal } from '../src/runner/lifecycle.ts';
import { refuseEmployeeCiBlock } from '../src/github-ci-control.ts';
import { referenceReport, referenceSentence } from './fixtures/ci-reference-report.ts';
import { citationLinksAllowed, citationSentenceBreakBlockers, citationWordBypassBlockers, customerBillingPositives, customerBillingWaits, customerContinuationBlockers, descriptiveHidesStateBlockers, disclaimerKeepsStateBlockers, existingGapBlockers, invisibleSpellingBlockers, noPunctuationBypassBlockers, reportShapedDescriptiveBilling, silentSentenceBlockers, urlGluedBypassBlockers } from './fixtures/ci-billing-boundary.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private RocksDB store: no production data, credentials, dispatcher or GitHub.
const run = process.env.RUN_SCK_PR_GATE_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, gm: string, qa: string, admin: LocalEnrollmentAdmin, count = 0;
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
  core = new SurrealCompanyCore(db, { submitCheck: async input => { asked.push(input); return input.text.includes('CONFLICT') ? { reason: 'PR 与主干有冲突：先解决冲突再提交。' } : undefined; } });
  admin = new LocalEnrollmentAdmin(db);
  gm = await admin.enroll('gate-gm', 'owner', ['execute', 'review', 'manage']);
  qa = await admin.enroll('gate-qa', 'qa', ['execute', 'review']);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const proofOf = (c: ClaimResult): LeaseProof => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });
const make = (executorRole: string, extra: Record<string, unknown> = {}) => core.createTask(gm, { title: `Gate task ${++count}`, context: 'fixture', executorRole, reviewerRole: 'qa', idempotencyKey: `gate-task-${++count}-${crypto.randomUUID()}`, ...extra } as never);
// Evidence needs 20 trimmed characters (requireText). Only a shorter sample gets a neutral tail; a longer sample reaches
// Core.block exactly as written, which is the same text the classifier unit tests read.
const evidence = (text: string) => ({ text: text.trim().length < 20 ? `${text} — padded so the evidence is long enough` : text, idempotencyKey: `gate-ev-${++count}-${crypto.randomUUID()}` });
// Each sample takes its own engineer. A failed expectation then strands only that employee's lease, so the next sample
// and the next test never inherit "already leased" and the first real failure stays the only failure.
const engineer = async (): Promise<{ id: string; credential: string }> => {
  const id = `gate-eng-${++count}`;
  return { id, credential: await admin.enroll(id, 'engineering', ['execute', 'review']) };
};

run('an implementation submit that the check refuses never reaches review, and can be resubmitted once fixed', async () => {
  const { credential: eng } = await engineer();
  const claim = await core.claim(eng, (await make('engineering')).id);
  await expect(core.submit(eng, proofOf(claim), evidence('PR https://github.com/o/r/pull/7 CONFLICT'))).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('提交被退回（未进入验收）') });
  expect((await core.getTask(gm, claim.task.id)).state).toBe('doing');
  const fixed = await core.submit(eng, proofOf(claim), evidence('PR https://github.com/o/r/pull/7 rebased'));
  expect(fixed.state).toBe('review');
  expect(asked.filter(a => a.text.includes('pull/7'))).toHaveLength(2);
});

run('other roles are not checked', async () => {
  const before = asked.length;
  const qaClaim = await core.claim(qa, (await make('qa')).id);
  expect((await core.submit(qa, proofOf(qaClaim), evidence('CONFLICT in prose only'))).state).toBe('review');
  expect(asked.length).toBe(before);
});

run('a core without a check behaves exactly as before', async () => {
  const { credential: eng } = await engineer();
  const plain = new SurrealCompanyCore(db);
  const claim = await plain.claim(eng, (await make('engineering')).id);
  expect((await plain.submit(eng, proofOf(claim), evidence('PR https://github.com/o/r/pull/8 CONFLICT'))).state).toBe('review');
});

const ciCriteria = [{ id: 'AC-CI', kind: 'machine', required: true, layer: 'ci', evidence: 'ci-run', verify: 'ci' }];

run('旁证报告经真实 Core.block 正常受阻、一次审计、owner恢复与重放幂等', async () => {
  let sourceReads = 0;
  const guarded = new SurrealCompanyCore(db, { ciBillingCheck: async () => {
    sourceReads++;
    return { runUrl: 'https://github.com/o/r/actions/runs/9', sha: 'a'.repeat(40) };
  } });
  for (const text of [referenceSentence, referenceReport,
    'GitHub CI 已完成，当前等待老板确认客户账单，未申请任何 CI 豁免。',
    '本轮重新抓取计费页和 GitHub release 页，引文与报告一致，未发现失败。',
    '本轮核对计费文档；GitHub release 页无法作为 CI 判定依据，仅作研究旁证。',
    '已抓取 GitHub 计费页面，页面内容无阻塞说明，等待内部元数据处置。',
    reportShapedDescriptiveBilling, ...citationLinksAllowed]) {
    const { credential: eng } = await engineer();
    const claim = await guarded.claim(eng, (await make('engineering', { acceptanceCriteria: ciCriteria })).id);
    expect(claim.task.acceptanceCriteria).toHaveLength(1);
    const proof = proofOf(claim), ev = evidence(text);
    const blocked = await guarded.block(eng, proof, 'owner', ev);
    expect(blocked.state).toBe('blocked');
    expect(blocked.version).toBe(claim.task.version + 1);
    expect(blocked.currentEmployee).toBeUndefined();
    expect(blocked.deliveryId).toBeUndefined();
    expect(await guarded.block(eng, proof, 'owner', ev)).toEqual(blocked);
    expect((await guarded.activeLeases(eng)).filter(l => l.taskId === claim.task.id)).toHaveLength(0);
    const resumeEv = evidence('内部元数据处置已由测试owner确认，恢复正常工作');
    const resumed = await guarded.resume(gm, claim.task.id, resumeEv);
    expect(resumed.state).toBe('ready');
    expect(resumed.version).toBe(blocked.version + 1);
    expect(await guarded.resume(gm, claim.task.id, resumeEv)).toEqual(resumed);
    await guarded.block(eng, proof, 'owner', ev);
    expect((await guarded.getTask(gm, claim.task.id)).state).toBe('ready');
    const history = await guarded.history(gm, claim.task.id);
    expect(history.filter(h => h.action === 'block')).toHaveLength(1);
    expect(history.find(h => h.action === 'block')?.evidence).toBe(ev.text);
    expect(history.filter(h => h.action === 'resume')).toHaveLength(1);
  }
  expect(sourceReads).toBe(0);
});

run('真实Core拒绝当前CI计费阻塞/等待，每条写法都经来源核验且拒绝前零副作用', async () => {
  let sourceReads = 0;
  const guarded = new SurrealCompanyCore(db, { ciBillingCheck: async () => {
    sourceReads++;
    return { runUrl: 'https://github.com/o/r/actions/runs/9', sha: 'a'.repeat(40) };
  } });
  for (const text of ['GitHub CI 因账户付款失败未启动，等待老板付款。',
    'CI 等待账户问题解决后执行，本报告仅为旁证，不申请豁免。',
    '检查未启动，需老板处理后才能继续。',
    'GitHub CI 账单未付，需老板处理。',
    'GitHub CI 账单需老板付款，才能跑 workflow。',
    'GitHub CI billing issue; waiting for owner payment.',
    'GitHub Actions spending limit needs to be raised before jobs can run.',
    'GitHub CI 账单已逾期，需老板付款后才能继续。',
    'GitHub CI 账单需付款，老板付款后再运行。',
    'GitHub Actions 因账单问题未运行，需老板付款。',
    'GitHub CI 暂停，原因是账户付款问题，需老板付款。',
    'GitHub CI 显示 spending limit 已达上限，需老板提高上限。',
    'CI 账户问题未解决，需老板处理。',
    'GitHub CI 已通过（计费页已核对）；但 CI 账单未付，需老板付款。',
    '核对计费页后确认：GitHub CI 账户问题需要老板处理。',
    '引用 billing 页面：GitHub CI 因账户付款卡住，请老板付款。',
    '引文核对后确认：GitHub Actions 计费额度耗尽，需老板处理。',
    '已核对计费页：GitHub CI 账户余额不足，需老板充值后再跑。',
    '引文核对：GitHub CI 账户付款卡住，引用仅为旁证。',
    'GitHub CI 已通过，账户付款卡住，需老板付款。',
    'quotation: GitHub Actions is blocked by the account payment hold.']) {
    const { credential: eng } = await engineer();
    const claim = await guarded.claim(eng, (await make('engineering', { acceptanceCriteria: ciCriteria })).id);
    const before = await guarded.getTask(gm, claim.task.id);
    const history = await guarded.history(gm, claim.task.id);
    const reads = sourceReads;
    await expect(guarded.block(eng, proofOf(claim), 'owner', evidence(text))).rejects.toMatchObject({ code: 'invalid' });
    // Every cause phrasing enters trusted-source verification before the refusal lands.
    expect(sourceReads).toBe(reads + 1);
    expect(await guarded.getTask(gm, claim.task.id)).toEqual(before);
    expect(await guarded.history(gm, claim.task.id)).toEqual(history);
    await guarded.release(eng, proofOf(claim), evidence('测试拒绝校验完成，释放隔离测试租约'));
  }
  expect(sourceReads).toBe(21);
});

run('真实Core对非计费CI失败仍正常受阻：核验通过且无豁免时接受普通阻塞', async () => {
  const { credential: eng } = await engineer();
  let sourceReads = 0;
  const guarded = new SurrealCompanyCore(db, { ciBillingCheck: async () => { sourceReads++; return undefined; } });
  const claim = await guarded.claim(eng, (await make('engineering', { acceptanceCriteria: ciCriteria })).id);
  const proof = proofOf(claim), ev = evidence('GitHub CI 断言测试失败，需修复后重跑。');
  const blocked = await guarded.block(eng, proof, 'owner', ev);
  expect(blocked.state).toBe('blocked');
  expect(sourceReads).toBe(1);
  expect(await guarded.block(eng, proof, 'owner', ev)).toEqual(blocked);
  expect((await guarded.history(gm, claim.task.id)).filter(h => h.action === 'block')).toHaveLength(1);
});

run('执行端invalid block超过十次仍pending，同一请求恢复后真实Core仅阻塞一次且可恢复', async () => {
  const { id: engId, credential: eng } = await engineer();
  const claimTask = await make('engineering', { acceptanceCriteria: ciCriteria });
  const runDir = join(dir, 'reference-pending', 'comm');
  const journal = new ExecutionJournal(join(dir, 'reference-pending', 'private', 'executions', createHash('sha256').update(runDir).digest('hex')));
  const inst = { id: engId, role: 'engineering' as const, credential: eng, paseoAgentId: undefined as string | undefined };
  const requests: Array<{ proof: LeaseProof; key: string; text: string }> = [];
  let oldRefusal = true, loseReply = true;
  const guarded = new SurrealCompanyCore(db, { ciBillingCheck: async () => { throw Error('unrelated report must not read CI'); } });
  const boundary = new Proxy(guarded, { get(target, prop) {
    if (prop === 'block') return async (cred: string, proof: LeaseProof, to: 'owner', ev: { text: string; idempotencyKey: string }) => {
      requests.push({ proof: { ...proof }, key: ev.idempotencyKey, text: ev.text });
      // Simulate the old service's exact refusal; never read or edit a production journal.
      if (oldRefusal) refuseEmployeeCiBlock();
      const result = await target.block(cred, proof, to, ev);
      if (loseReply) { loseReply = false; throw Error('synthetic lost reply after commit'); }
      return result;
    };
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const options = { runDir, core: boundary, workforce: { rotate: async () => eng } as never,
    managedLifecycle: true, heartbeatMs: 600000 };
  let pool = new SidecarPool(options);
  const retry = async () => {
    const row = journal.rows()[0]!;
    row.nextRetry = 0; journal.save(row); await pool.retryExecutions();
  };
  try {
    pool.env(inst); inst.paseoAgentId = 'fixture-reference-session'; pool.bindAgent(inst.id, inst.paseoAgentId);
    await pool.claim(inst, { id: claimTask.id } as never);
    await pool.turnStarted(inst.paseoAgentId, 'fixture-reference-turn');
    expect((await pool.settleExecution({ agent: { id: inst.paseoAgentId }, turnId: 'fixture-reference-turn',
      outcome: { kind: 'completed' }, timeline: [{ type: 'assistant_message', text: referenceReport }] }))?.status).toBe('pending');
    for (let n = 0; n < 11; n++) await retry();
    expect(journal.rows()[0]).toMatchObject({ state: 'pending', tries: 12, error: 'invalid' });
    expect(journal.rows()[0]?.lastRefusal).toContain('系统判定');
    expect((await guarded.getTask(gm, claimTask.id)).state).toBe('doing');
    expect((await guarded.history(gm, claimTask.id)).filter(h => h.action === 'block')).toHaveLength(0);
    const original = journal.rows()[0]!.result;
    pool.close();
    pool = new SidecarPool(options);
    await pool.adopt([inst] as never);
    oldRefusal = false;
    await retry(); // Real transaction commits; the reply is deliberately lost.
    expect(journal.rows()[0]?.state).toBe('pending');
    expect((await guarded.getTask(gm, claimTask.id)).state).toBe('blocked');
    await retry(); await retry();
    expect(journal.rows()[0]?.state).toBe('settled');
    expect(journal.rows()[0]?.result).toEqual(original);
    expect(requests).toHaveLength(14);
    expect(requests.every(r => JSON.stringify(r) === JSON.stringify(requests[0]))).toBe(true);
    expect(pool.holdsLease(inst.id, claimTask.id)).toBe(false);
    expect((await guarded.history(gm, claimTask.id)).filter(h => h.action === 'block')).toHaveLength(1);
    expect((await guarded.resume(gm, claimTask.id, evidence('隔离测试确认内部元数据处置完成后恢复'))).state).toBe('ready');
    const next = await guarded.claim(eng, claimTask.id);
    expect(next.deliveryId).not.toBe(requests[0]!.proof.deliveryId);
    expect(next.fence).toBeGreaterThan(requests[0]!.proof.fence);
    await guarded.release(eng, proofOf(next), evidence('恢复后已取得新租约，结束本隔离测试'));
    const row = await db.db.select<{ state: string }>(new RecordId('task', claimTask.id));
    expect(row?.state).toBe('ready');
  } finally { pool.close(); }
});

run('真实Core拒绝引文包裹、无标点、紧贴链接、引文句与空行切断、零宽字符及既有缺口中的当前CI计费状态：有无来源核验都不放行，拒绝前零副作用', async () => {
  let sourceReads = 0, verified: { runUrl: string; sha: string } | undefined;
  const guarded = new SurrealCompanyCore(db, { ciBillingCheck: async () => { sourceReads++; return verified; } });
  for (const source of [{ runUrl: 'https://github.com/o/r/actions/runs/9', sha: 'a'.repeat(40) }, undefined]) {
    verified = source;
    for (const text of [...citationWordBypassBlockers, ...existingGapBlockers, ...noPunctuationBypassBlockers,
      ...urlGluedBypassBlockers, ...citationSentenceBreakBlockers, ...invisibleSpellingBlockers,
      ...silentSentenceBlockers, ...customerContinuationBlockers, ...disclaimerKeepsStateBlockers,
      ...descriptiveHidesStateBlockers]) {
      const { credential: eng } = await engineer();
      const claim = await guarded.claim(eng, (await make('engineering', { acceptanceCriteria: ciCriteria })).id);
      const before = await guarded.getTask(gm, claim.task.id);
      const history = await guarded.history(gm, claim.task.id);
      const reads = sourceReads;
      await expect(guarded.block(eng, proofOf(claim), 'owner', evidence(text)))
        .rejects.toMatchObject({ code: 'invalid', details: { reason: 'github_ci_system_owned' } });
      expect(sourceReads).toBe(reads + 1);
      expect(await guarded.getTask(gm, claim.task.id)).toEqual(before);
      expect(await guarded.history(gm, claim.task.id)).toEqual(history);
      await guarded.release(eng, proofOf(claim), evidence('测试拒绝校验完成，释放隔离测试租约'));
    }
  }
});

run('客户账单付款等待（含CI已完成旁的续句）是无关业务：真实Core正常受阻、重放幂等，且不读取CI来源', async () => {
  let sourceReads = 0;
  const guarded = new SurrealCompanyCore(db, { ciBillingCheck: async () => {
    sourceReads++;
    return { runUrl: 'https://github.com/o/r/actions/runs/9', sha: 'a'.repeat(40) };
  } });
  for (const text of [...customerBillingWaits, ...customerBillingPositives]) {
    const { credential: eng } = await engineer();
    const claim = await guarded.claim(eng, (await make('engineering', { acceptanceCriteria: ciCriteria })).id);
    const proof = proofOf(claim), ev = evidence(text);
    const blocked = await guarded.block(eng, proof, 'owner', ev);
    expect(blocked.state).toBe('blocked');
    expect(await guarded.block(eng, proof, 'owner', ev)).toEqual(blocked);
    expect((await guarded.history(gm, claim.task.id)).filter(h => h.action === 'block')).toHaveLength(1);
    expect((await guarded.resume(gm, claim.task.id, evidence('客户账单已由测试owner确认，恢复正常工作'))).state).toBe('ready');
  }
  expect(sourceReads).toBe(0);
});
