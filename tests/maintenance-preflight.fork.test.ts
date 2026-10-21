import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { collectPreflightInput, evaluatePreflightWithDependencyCheck, type AdminSummaryView, type PreflightCall } from '../src/maintenance-preflight.ts';

// SYS-DISP 843d4e75 R5: the preflight over the real GM read paths — get_admin_summary and paged get_context on a
// company fork — in the production shape: hundreds of finished tasks, void rows and a review the caller submitted
// (which paged get_context hides). The script's own collection path is used, not a hand-built row list.
setDefaultTimeout(120_000);

test('the preflight reads the real GM views on a fork and stays usable with done/void rows and a hidden own review', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-preflight-fork-')));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'sck_preflight_fork', database: 'control_plane' });
  try {
    for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
    await db.connect(); await db.bootstrap();
    const core = new SurrealCompanyCore(db);
    const enrollment = new LocalEnrollmentAdmin(db);
    const owner = new OwnerDesk(db);
    const gm = await enrollment.enroll('pf-gm', 'gm', ['execute', 'review', 'manage']);
    const engineer = await enrollment.enroll('pf-eng', 'engineering', ['execute', 'review']);
    const reviewer = await enrollment.enroll('pf-qa', 'qa', ['execute', 'review']);
    const key = () => `pf-${crypto.randomUUID()}`;

    // 1) A finished and a void task: the summary counts them, the working set never lists them.
    const done = await core.createTask(gm, { title: '已完成的交付', context: 'x——预检夹具的合成证据记录，用于验证汇总与分页口径。'.repeat(200), executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
    const claim = await core.claim(engineer, done.id);
    await core.submit(engineer, { taskId: done.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version }, { text: '合成完成：预检夹具的已完成交付。——预检夹具的合成证据记录，用于验证汇总与分页口径。', idempotencyKey: key() });
    const review = await core.claim(reviewer, done.id);
    await core.accept(reviewer, { taskId: done.id, deliveryId: review.deliveryId, fence: review.fence, expectedVersion: review.task.version }, { text: '合成验收通过记录：预检夹具里那个已经完成的交付，用于验证汇总与分页口径。', idempotencyKey: key() });
    const voided = await core.createTask(gm, { title: '已作废的交付', context: 'y——预检夹具的合成证据记录，用于验证汇总与分页口径。'.repeat(200), executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
    await core.retireTask(gm, { taskId: voided.id, text: '合成作废记录：预检夹具里那个已作废的交付，用于验证汇总口径包含终态。', idempotencyKey: key() });

    // 2) 500+ finished tasks, so the summary is far larger than the working set.
    const bulk = 520;
    for (let i = 0; i < bulk; i++) {
      const t = await core.createTask(gm, { title: `批量完成 ${i}`, context: 'z——预检夹具的合成证据记录，用于验证汇总与分页口径。'.repeat(120), executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
      const c = await core.claim(engineer, t.id);
      await core.submit(engineer, { taskId: t.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version }, { text: '合成批量提交记录：预检夹具里那批完成的交付之一，用于验证汇总与分页口径。', idempotencyKey: key() });
      const r = await core.claim(reviewer, t.id);
      await core.accept(reviewer, { taskId: t.id, deliveryId: r.deliveryId, fence: r.fence, expectedVersion: r.task.version }, { text: '合成批量验收记录：预检夹具里那批完成的交付之一，用于验证汇总与分页口径。', idempotencyKey: key() });
    }

    // 3) A review the GM submitted itself: paged get_context hides it, the summary still counts it.
    const own = await core.createTask(gm, { title: '经理自己提交的复核', context: 'w——预检夹具的合成证据记录，用于验证汇总与分页口径。'.repeat(200), executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
    const ownClaim = await core.claim(engineer, own.id);
    await core.submit(engineer, { taskId: own.id, deliveryId: ownClaim.deliveryId, fence: ownClaim.fence, expectedVersion: ownClaim.task.version }, { text: '合成提交记录：经理自己提交的那一行，用于验证本人复核会被分页隐藏的语义。', idempotencyKey: key() });
    // The row stays in review and names the GM as its submitter: the paged view hides it from the GM, the summary counts it.
    await db.db.query('UPDATE $t SET submitted_by = $me;', { t: new RecordId('task', own.id), me: 'pf-gm' });
    const ownRow = (await db.db.query<[{ state: string }]>('SELECT state FROM ONLY $t;', { t: new RecordId('task', own.id) }))[0]!;
    expect(ownRow.state).toBe('review');
    expect((await core.contextView(gm, { pageSize: 100, fields: ['id', 'state'] })).tasks?.some(t => t.id === own.id)).toBe(false);

    // The script's own collection path, over the real core.
    const call: PreflightCall = async (tool, args) => {
      if (tool === 'get_admin_summary') return await core.adminSummary(gm, args) as unknown as Record<string, unknown>;
      if (tool === 'get_context') return await core.contextView(gm, args) as unknown as Record<string, unknown>;
      throw new Error(`unexpected tool ${tool}`);
    };
    const { summary, pages, readDependencies } = await collectPreflightInput(call, { pageSize: 100 });
    const rows = pages.flatMap(page => page.rows);
    const verdict = await evaluatePreflightWithDependencyCheck({ summary, pages, extras: { triageGoals: 0, pendingEvals: 0, gmAttention: 0 }, readDependencies });

    // The summary counts every state; the pages list only the working set; the difference is the hidden own review.
    expect(summary.tasks.done).toBeGreaterThanOrEqual(bulk);
    expect(summary.tasks.void).toBeGreaterThanOrEqual(1);
    expect(summary.integrity.complete).toBe(true);
    expect(verdict.capability.complete).toBe(true);
    expect(verdict.capability.reasons).toEqual([]);
    expect(verdict.capability.hiddenReviews).toBe(1);
    // The hidden review is still a candidate: the window is refused, and the reason names it.
    expect(verdict.window.allowed).toBe(false);
    expect(verdict.window.reasons.join(' ')).toMatch(/review/);
    // A read that is not the paged shape is refused by the collector itself.
    await expect(collectPreflightInput(async () => ({ tasks: [] }))).rejects.toThrow(/paged task shape/);

    // A dependency list that the page cut is refused: the whole list is re-read and compared.
    const withDeps = await core.createTask(gm, { title: '带依赖的等待行', context: '合成夹具：带依赖的 blocked 任务。', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() } as never);
    const depsLease = await core.claim(engineer, withDeps.id);
    await core.block(engineer, { taskId: withDeps.id, deliveryId: depsLease.deliveryId, fence: depsLease.fence, expectedVersion: depsLease.task.version }, 'gm', { text: '合成阻塞记录：带依赖的等待行，用于验证依赖截断会被拒绝。', idempotencyKey: key() });
    await db.db.query('UPDATE $t SET dependencies = $deps;', { t: new RecordId('task', withDeps.id), deps: [new RecordId('task', done.id)] });
    const cut = await evaluatePreflightWithDependencyCheck({
      summary: await core.adminSummary(gm, {}) as unknown as AdminSummaryView,
      pages: [{ rows: [{ id: withDeps.id, state: 'blocked', executorRole: 'engineering', reviewerRole: 'qa', fence: 1, version: 1, dependencies: [] }], hasMore: false, total: 1, snapshotAt: 'cut' }],
      extras: { triageGoals: 0, pendingEvals: 0, gmAttention: 0 },
      readDependencies: async () => [done.id],
    });
    expect(cut.capability.complete).toBe(false);
    expect(cut.capability.reasons.join(' ')).toMatch(/dependency list/);
    expect(cut.window.allowed).toBe(false);
  } finally {
    await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true });
  }
});
