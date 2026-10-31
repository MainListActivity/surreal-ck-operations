import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import { CompanyProofStore } from '../src/ops/proof-store.ts';
import { APPROVAL_MARKER, PROOF_GOAL } from '../src/ops/proof-contract.ts';
import type { ExecutionWindow } from '../src/task-recovery.ts';
import type { LeaseProof, TaskView, WorktreeAssignment } from '../src/contracts.ts';

setDefaultTimeout(90000);
// FV06 P0/P1: bounded standby relay on a real company fork — no production data, no credentials, no sampling.
// 每个测试用全新员工（活动租约不跨测试残留）。
const run = process.env.RUN_SCK_STANDBY_RELAY_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, coreWt: SurrealCompanyCore,
  wf: Workforce, proof: CompanyProofStore, admin: LocalEnrollmentAdmin, count = 0;

beforeAll(async () => {
  if (process.env.RUN_SCK_STANDBY_RELAY_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-standby-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'standby_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db);
  // A second face with the worktree registry over a real git repo: the standby direct assignment must
  // register its scene through the same allocate path a claim uses.
  const repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'source.txt'), 'baseline');
  Bun.spawnSync(['git', '-C', repo, 'add', '.']);
  Bun.spawnSync(['git', '-C', repo, 'commit', '-qm', 'baseline']);
  coreWt = new SurrealCompanyCore(db, { worktrees: { opsRepo: repo } });
  wf = new Workforce(db, dir);
  proof = new CompanyProofStore(db.db);
  admin = new LocalEnrollmentAdmin(db);
  gmCred = await admin.enroll('sb-gm', 'gm', ['execute', 'review', 'manage']);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const text = (what: string) => ({ text: `${what} — 长度满足证据校验的说明文本`, idempotencyKey: `sb-ev-${++count}-${crypto.randomUUID()}` });
const proofOf = (c: { task: TaskView; deliveryId: string; fence: number }): LeaseProof =>
  ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });
const newTask = (executorRole: string, reviewerRole = 'qa', cred = gmCred) => core.createTask(cred, {
  title: `standby fixture ${++count}`, context: 'fixture', executorRole: executorRole as never,
  reviewerRole: reviewerRole as never, idempotencyKey: `sb-task-${count}-${crypto.randomUUID()}` } as never);

/** 每次调用登记一个全新员工；id 与凭证分开返回（standby 入参要 id，claim 要凭证）。 */
const actor = async (role: 'gm' | 'engineering' | 'qa' | 'product'): Promise<{ id: string; cred: string }> => {
  const id = `sb-${role}-${++count}`;
  return { id, cred: await admin.enroll(id, role, role === 'gm' ? ['execute', 'review', 'manage'] : ['execute', 'review']) };
};
let gmCred = '';
const gmTask = (executorRole: string, reviewerRole = 'qa') => newTask(executorRole, reviewerRole, gmCred);

/** A blocked-to-gm task with a valid execution window over a done approval dependency + registered candidate. */
async function windowedBlockedTask(label: string, executorRole = 'engineering'):
Promise<{ taskId: string; approvalId: string; window: ExecutionWindow; executor: { id: string; cred: string } }> {
  const executor = await actor(executorRole === 'engineering' ? 'engineering' : executorRole as 'qa');
  const task = await gmTask(executorRole);
  const approval = await gmTask('product', 'product');
  const expiry = new Date(Date.now() + 4 * 3600_000).toISOString();
  const window: ExecutionWindow = { approvalTask: approval.id, configurationDigest: 'a'.repeat(64),
    evidenceExpiresAt: expiry, minRemainingSeconds: 5400, notAfter: new Date(Date.now() + 3600_000).toISOString() };
  await db.db.query("UPDATE $dep SET state='done'; UPDATE $task SET dependencies=[$dep]; CREATE internal_ai_candidate CONTENT {task:$dep, digest:$digest, manifest_hash:$digest, document_hash:$digest, manifest_path:'fixture', document_path:'fixture', author:'fixture', env:'production', evidence_expires_at:$expiry};",
    { task: new RecordId('task', task.id), dep: new RecordId('task', approval.id), digest: window.configurationDigest, expiry });
  const claim = await core.claim(executor.cred, task.id);
  await core.block(executor.cred, proofOf(claim), 'gm', text(`${label}：等待独立批准接力`));
  return { taskId: task.id, approvalId: approval.id, window, executor };
}

const rowOf = async (taskId: string): Promise<Record<string, unknown> | undefined> => {
  const [rows] = await db.db.query<[Array<Record<string, unknown>>]>('SELECT * FROM $task LIMIT 1;', { task: new RecordId('task', taskId) });
  return rows?.[0];
};

run('standby resume assigns a real lease atomically: doing + lease + progress_at + standby_until + window (P0 spec 1)', async () => {
  const gm = await actor('gm');
  const { taskId, window, executor } = await windowedBlockedTask('engineering 同实现人待命');
  const before = await rowOf(taskId);
  const resumed = await core.resumeStandby(gm.cred, taskId, { ...text('窗口与批准件核对无误，原实现人有界待命接力'), executionWindow: window }, executor.id);
  expect(resumed.state).toBe('doing');
  expect(resumed.currentEmployee).toBe(executor.id);
  expect(resumed.fence).toBe((before!.fence as number) + 1);
  expect(resumed.deliveryId).toBeDefined();
  expect(resumed.deliveryId).not.toBe(before!.delivery_id);
  // lease ≈ 600s；progress_at 重置为 now；standby_until = min(notAfter, now+budget)，缺省预算 600s
  const nowSec = Date.now() / 1000;
  expect((resumed.leaseExpiresAt ? Date.parse(resumed.leaseExpiresAt) / 1000 : 0)).toBeGreaterThan(nowSec + 540);
  expect(resumed.standbyUntil).toBeDefined();
  const standbySec = Math.floor(Date.parse(resumed.standbyUntil!) / 1000);
  expect(standbySec).toBeLessThanOrEqual(Date.parse(window.notAfter) / 1000 + 1);
  expect(standbySec).toBeGreaterThan(nowSec + 540);
  const row = await rowOf(taskId);
  expect(row!.progress_at as number).toBeGreaterThan(nowSec - 30);
  expect(row!.standby_until as number).toBe(standbySec);
  expect(String(row!.lease_policy_hash ?? '')).not.toBe('');
  // audit 带 standby 与两个时限；outbox payload 带 employee 与 standbyUntil
  const [audit] = await db.db.query<[Array<Record<string, unknown>>]>("SELECT * FROM audit WHERE task=$task AND action='resume' ORDER BY at DESC LIMIT 1;", { task: new RecordId('task', taskId) });
  expect(audit[0]!.standby).toBe(executor.id);
  expect(audit[0]!.standby_until).toBe(standbySec);
  expect(audit[0]!.lease_expires_at).toBeGreaterThan(nowSec + 540);
  const [outboxRows] = await db.db.query<[Array<{ payload: Record<string, unknown> }>]>('SELECT payload FROM outbox WHERE task = $task AND kind = \'resumed\';', { task: new RecordId('task', taskId) });
  const outbox = outboxRows.slice(-1);
  expect(outbox[0]!.payload.employee).toBe(executor.id);
  expect(outbox[0]!.payload.standbyUntil).toBe(standbySec);
});

run('standby resume registers the worktree through the claim registry path, never an unauthorised scene (worktree 归属)', async () => {
  const gm = await actor('gm');
  const { taskId, window, executor } = await windowedBlockedTask('engineering 登记工作区');
  const resumed = await coreWt.resumeStandby(gm.cred, taskId, { ...text('窗口有效；原实现人有界待命接力'), executionWindow: window }, executor.id);
  expect(resumed.state).toBe('doing');
  expect(resumed.currentEmployee).toBe(executor.id);
  const assignment = resumed.worktree as WorktreeAssignment;
  expect(assignment).toBeDefined();
  expect(assignment.mode).toBe('exclusive');
  expect(assignment.branch).toBe(`task/${taskId.slice(0, 8)}`);
  expect(assignment.intent.kind).toBe('code');
  const [ref] = await db.db.query<[Array<Record<string, unknown>>]>('SELECT * FROM worktree_ref WHERE task=$task;', { task: new RecordId('task', taskId) });
  expect(String(ref[0]!.employee)).toBe(executor.id);
  expect(String(ref[0]!.delivery)).toBe(String(resumed.deliveryId));
});

run('standby refusals leave the task blocked with no lease (P0 spec 2+3): window, role, binding, active task, revoked, provider, quota', async () => {
  const gm = await actor('gm');
  const { taskId, window, executor } = await windowedBlockedTask('工程拒绝矩阵');
  const other = await actor('engineering');
  const before = await rowOf(taskId);
  // 窗口过期 / 批准件不是直接依赖 / digest 或 expiry 不匹配
  expect(await core.resumeStandby(gm.cred, taskId, { ...text('窗口已过期'), executionWindow: { ...window, notAfter: new Date(Date.now() - 1000).toISOString() } }, executor.id).catch(e => e.code)).toBe('invalid');
  expect(await core.resumeStandby(gm.cred, taskId, { ...text('批准任务不在依赖里'), executionWindow: { ...window, approvalTask: (await gmTask('product', 'product')).id } }, executor.id).catch(e => e.code)).toBe('invalid');
  expect(await core.resumeStandby(gm.cred, taskId, { ...text('digest 不匹配'), executionWindow: { ...window, configurationDigest: 'b'.repeat(64) } }, executor.id).catch(e => e.code)).toBe('invalid');
  expect(await core.resumeStandby(gm.cred, taskId, { ...text('expiry 不匹配'), executionWindow: { ...window, evidenceExpiresAt: new Date(Date.now() + 9 * 3600_000).toISOString() } }, executor.id).catch(e => e.code)).toBe('invalid');
  // 没有窗口不给 standby
  expect(await core.resumeStandby(gm.cred, taskId, text('缺窗口'), executor.id).catch(e => e.code)).toBe('invalid');
  // 岗位不符
  const qaForeign = await actor('qa');
  expect(await core.resumeStandby(gm.cred, taskId, { ...text('qa 待命工程任务'), executionWindow: window }, qaForeign.id).catch(e => String((e as Error)?.message ?? ''))).toContain('standby_role_denied');
  // 实现人绑定：另一个工程员工不能待命
  expect(await core.resumeStandby(gm.cred, taskId, { ...text('非实现人待命'), executionWindow: window }, other.id).catch(e => String((e as Error)?.message ?? ''))).toContain('bound_to_another_implementer');
  // 待命员工另持活动租约（admission 读出 busy）
  const busyHolder = await actor('engineering');
  const otherTask = await gmTask('engineering');
  await core.claim(busyHolder.cred, otherTask.id);
  expect(await core.resumeStandby(gm.cred, taskId, { ...text('待命员工忙'), executionWindow: window }, busyHolder.id).catch(e => String((e as Error)?.message ?? ''))).toContain('standby_employee_busy');
  // 撤销凭证的员工
  const revoked = await actor('engineering');
  await db.db.query('UPDATE $e SET revoked = true;', { e: new RecordId('employee', revoked.id) });
  expect(await core.resumeStandby(gm.cred, taskId, { ...text('已撤销员工'), executionWindow: window }, revoked.id).catch(e => String((e as Error)?.message ?? ''))).toContain('standby_employee_unavailable');
  // provider 冷却中（与调度器同一闸门）
  const nowSec = Math.floor(Date.now() / 1000);
  await db.db.query("CREATE provider_health:codex CONTENT { state: 'exhausted', until: $until, failures: 2, last_error: 'fixture quota' };", { until: nowSec + 3600 });
  await db.db.query('UPDATE $e SET provider = $p;', { e: new RecordId('employee', executor.id), p: 'codex' });
  expect(await core.resumeStandby(gm.cred, taskId, { ...text('provider 冷却'), executionWindow: window }, executor.id).catch(e => String((e as Error)?.message ?? ''))).toContain('standby_provider_blocked');
  // 额度快照低于下限（与调度器同一 quota 行读取）
  await db.db.query('DELETE provider_health:codex; CREATE company_meta:quota_codex CONTENT { provider: \'codex\', lowest_pct: 1, session_pct: 1, at: time::now() };');
  expect(await core.resumeStandby(gm.cred, taskId, { ...text('额度低于下限'), executionWindow: window }, executor.id).catch(e => String((e as Error)?.message ?? ''))).toContain('standby_provider_blocked');
  // 全部拒绝后任务保持 blocked、无租约、无 standby、版本未动
  const after = await rowOf(taskId);
  expect(after!.state).toBe('blocked');
  expect(after!.blocked_to).toBe('gm');
  expect(after!.current_employee ?? null).toBeNull();
  expect(after!.standby_until ?? null).toBeNull();
  expect(after!.version).toBe(before!.version);
});

run('standby resume replays the same idempotency key once and refuses the same key with different input (重放/漂移)', async () => {
  const gm = await actor('gm');
  const { taskId, window } = await windowedBlockedTask('重放与键漂移', 'qa');
  const standby = await actor('qa');
  const evidence = { ...text('同一幂等键重放'), executionWindow: window };
  const first = await core.resumeStandby(gm.cred, taskId, evidence, standby.id);
  const replay = await core.resumeStandby(gm.cred, taskId, evidence, standby.id);
  expect(replay.deliveryId).toBe(first.deliveryId);
  expect(replay.fence).toBe(first.fence);
  const [resumes] = await db.db.query<[Array<{ count: number }>]>('SELECT count() AS count FROM audit WHERE task=$task AND action=\'resume\' GROUP ALL;', { task: new RecordId('task', taskId) });
  expect(resumes[0]!.count).toBe(1);
  const different = await actor('qa');
  // 同一键、不同输入（换待命人+换文本）→ 幂等冲突
  const drifted = { ...evidence, text: `${evidence.text}（换人重放）` };
  expect(await core.resumeStandby(gm.cred, taskId, drifted, different.id).catch(e => e.code)).toBe('conflict');
});

run('two concurrent standby resumes produce exactly one winner and no ready intermediate (并发)', async () => {
  const gm = await actor('gm');
  const { taskId, window } = await windowedBlockedTask('并发抢派', 'qa');
  const a = await actor('qa');
  const b = await actor('qa');
  const [ra, rb] = await Promise.allSettled([
    core.resumeStandby(gm.cred, taskId, { ...text('并发 A'), executionWindow: window }, a.id),
    core.resumeStandby(gm.cred, taskId, { ...text('并发 B'), executionWindow: window }, b.id),
  ]);
  const fulfilled = [ra, rb].filter(s => s.status === 'fulfilled') as PromiseFulfilledResult<TaskView>[];
  expect(fulfilled).toHaveLength(1);
  expect(fulfilled[0]!.value.state).toBe('doing');
  const row = await rowOf(taskId);
  expect(['doing', 'blocked']).toContain(row!.state as string);
  if (row!.state === 'doing') {
    expect(row!.current_employee).toBeTruthy();
    expect(row!.standby_until).toBeTruthy();
    expect(row!.lease_expires_at).toBeTruthy();
  } else {
    expect(row!.current_employee ?? null).toBeNull();
  }
});

run('plain resume keeps the old contract byte for byte: ready, no holder, no standby fields (旧行为对照)', async () => {
  const gm = await actor('gm');
  const { taskId, window } = await windowedBlockedTask('普通恢复对照');
  const before = await rowOf(taskId);
  const progressBefore = before!.progress_at as number | null;
  const resumed = await core.resume(gm.cred, taskId, { ...text('不传 standbyEmployee 的普通恢复'), executionWindow: window });
  expect(resumed.state).toBe('ready');
  expect(resumed.currentEmployee).toBeUndefined();
  expect(resumed.standbyUntil).toBeUndefined();
  const row = await rowOf(taskId);
  expect(row!.standby_until ?? null).toBeNull();
  expect(row!.progress_at ?? null).toBe(progressBefore);
  const [audit] = await db.db.query<[Array<Record<string, unknown>>]>("SELECT * FROM audit WHERE task=$task AND action='resume' ORDER BY at DESC LIMIT 1;", { task: new RecordId('task', taskId) });
  expect(audit[0]!.standby ?? null).toBeNull();
});

run('standby timeout returns the task to the gm gate, never the ready pool (待命超时)', async () => {
  const gm = await actor('gm');
  const { taskId, window } = await windowedBlockedTask('超时回关口', 'qa');
  const standby = await actor('qa');
  await core.resumeStandby(gm.cred, taskId, { ...text('待命后超时'), executionWindow: window }, standby.id);
  const holder = await rowOf(taskId);
  const handed = await wf.standbyTimeout(taskId, String(holder!.current_employee), '待命超时：回经理关口', '【交接包】fixture');
  expect(handed).toBe(true);
  const row = await rowOf(taskId);
  expect(row!.state).toBe('blocked');
  expect(row!.blocked_to).toBe('gm');
  expect(row!.resume_state).toBe('doing');
  expect(row!.current_employee ?? null).toBeNull();
  expect(row!.delivery_id ?? null).toBeNull();
  expect(row!.lease_expires_at ?? null).toBeNull();
  expect(row!.standby_until ?? null).toBeNull();
  expect(row!.previous_employee).toBe(standby.id);
  const [audit] = await db.db.query<[Array<Record<string, unknown>>]>("SELECT * FROM audit WHERE task=$task AND action='standby_timeout';", { task: new RecordId('task', taskId) });
  expect(audit).toHaveLength(1);
  // 再来一次：租约已变，拒绝
  expect(await wf.standbyTimeout(taskId, standby.id, '再次收回', 'x')).toBe(false);
  // 经理换人重新 standby 仍合法
  const again = await actor('qa');
  const resumed = await core.resumeStandby(gm.cred, taskId, { ...text('换人重新待命'), executionWindow: window }, again.id);
  expect(resumed.state).toBe('doing');
  expect(resumed.currentEmployee).toBe(again.id);
});

run('verify_standby is read-only, per-item coded, and audited (P1 spec 7)', async () => {
  const gm = await actor('gm');
  const { taskId, window, executor } = await windowedBlockedTask('只读预检', 'qa');
  const standby = await actor('qa');
  const engForeign = await actor('engineering');
  const beforeVersion = (await rowOf(taskId))!.version;
  const result = await core.verifyStandby(gm.cred, { items: [
    { taskId, employeeId: standby.id, executionWindow: window },   // ok（预检发生在绑窗前，随 item 带上待绑窗口）
    { taskId, employeeId: engForeign.id, executionWindow: window }, // 岗位不符（qa 任务、engineering 员工）
    { taskId, employeeId: 'sb-ghost', executionWindow: window },   // 不存在的员工
  ], idempotencyKey: `verify-${count}-${crypto.randomUUID()}` });
  expect(result.items[0]).toMatchObject({ taskId, employeeId: standby.id, ok: true });
  expect(result.items[1]!.ok).toBe(false);
  expect(result.items[1]!.code).toBe('standby_role_denied');
  expect(result.items[2]!.ok).toBe(false);
  expect(result.items[2]!.code).toBe('standby_employee_unavailable');
  expect((await rowOf(taskId))!.version).toBe(beforeVersion);
  expect((await rowOf(taskId))!.current_employee ?? null).toBeNull();
  const [audits] = await db.db.query<[Array<{ count: number }>]>('SELECT count() AS count FROM audit WHERE task=$task AND action=\'verify_standby\' GROUP ALL;', { task: new RecordId('task', taskId) });
  expect(audits[0]!.count).toBe(3);
  // 无窗口的任务：逐项给 execution_window_invalid
  const claimer = await actor('qa');
  const plain = await gmTask('qa');
  const blocked = await core.claim(claimer.cred, plain.id);
  await core.block(claimer.cred, proofOf(blocked), 'gm', text('无窗口阻塞'));
  const noWindow = await core.verifyStandby(gm.cred, { items: [{ taskId: plain.id, employeeId: standby.id }], idempotencyKey: `verify-nw-${count}` });
  expect(noWindow.items[0]).toMatchObject({ ok: false, code: 'execution_window_invalid' });
  // 非 gm 拒绝
  expect(await core.verifyStandby(claimer.cred, { items: [{ taskId, employeeId: standby.id }], idempotencyKey: `verify-non-gm-${count}` }).catch(e => e.code)).toBe('forbidden');
});

// ---- G1: sampler identity on the registration chain, 同人批准机器拒绝 ----

const proofLease = (taskId: string, employee: string) => ({
  taskId, employee, delivery: `delivery-${taskId}`, fence: 1, goal: PROOF_GOAL, project: 'surreal_ck', role: 'product' as const });
const fakeFiles = (digest: string) => ({
  manifest: { configurationDigest: digest } as never, evidence: { expiresAt: new Date(Date.now() + 3600_000).toISOString() } as never,
  manifestHash: digest.slice(0, 32), documentHash: digest.slice(32), manifestPath: 'm', documentPath: 'd' });

/** 一个 PROOF_GOAL 下的批准任务（登记人持活租约），可选登记候选与 accept 审计。 */
async function approvalWorld(opts: { acceptedBy?: string; candidate?: { digest: string; sampler?: string } } = {}) {
  const holder = await actor('product');
  await db.db.query("UPSERT type::record('goal', $goal) CONTENT { name: 'g1 fixture', project: type::record('project','surreal_ck') };", { goal: PROOF_GOAL });
  const task = await gmTask('product', 'product');
  await db.db.query(`UPDATE $task SET goal = type::record('goal', $goal), kind = 'task', state = 'doing', current_employee = $holder, submitted_by = $holder,
    lease_expires_at = time::unix(time::now()) + 600, delivery_id = $delivery, fence = 1, version = 1
    ${opts.acceptedBy ? ", accepted_by = $accepted, reviewer_role = 'product', state = 'done', current_employee = NONE" : ''};`,
    { task: new RecordId('task', task.id), goal: PROOF_GOAL, holder: holder.id, delivery: `delivery-${task.id}`,
      accepted: opts.acceptedBy });
  if (opts.candidate) {
    await proof.prepare(proofLease(task.id, holder.id), 'production', fakeFiles(opts.candidate.digest), opts.candidate.sampler);
  }
  if (opts.acceptedBy) {
    const digest = opts.candidate?.digest ?? 'a'.repeat(64);
    await db.db.query(`CREATE audit CONTENT { task: $task, actor: type::record('employee', $accepted), action: 'accept',
      evidence: $evidence, version: 1, at: time::now() };`,
      { task: new RecordId('task', task.id), accepted: opts.acceptedBy, evidence: `${APPROVAL_MARKER}${digest}` });
  }
  return { taskId: task.id, holder: holder.id };
}

run('G1: prepare refuses sampler == registering holder and the row carries an immutable sampler identity', async () => {
  const { taskId, holder } = await approvalWorld({});
  const lease = proofLease(taskId, holder);
  expect(await proof.prepare(lease, 'production', fakeFiles('a'.repeat(64)), holder).catch(e => e.code)).toBe('invalid');
  const sampler = await actor('engineering');
  await proof.prepare(lease, 'production', fakeFiles('a'.repeat(64)), sampler.id);
  expect((await proof.candidate(taskId))!.sampler).toBe(sampler.id);
  // 同文件同采样者重放幂等；换采样者或换文件都冲突
  await proof.prepare(lease, 'production', fakeFiles('a'.repeat(64)), sampler.id);
  const otherSampler = await actor('engineering');
  expect(await proof.prepare(lease, 'production', fakeFiles('a'.repeat(64)), otherSampler.id).catch(e => e.code)).toBe('conflict');
  // fork 对 readonly digest 的原地改写有原生守卫：换文件登记会被整体拒绝（错误码随驱动，语义=不可变）
  await expect(proof.prepare(lease, 'production', fakeFiles('b'.repeat(64)), sampler.id)).rejects.toThrow();
});

run('G1: approval machine-rejects sampler == accepted_by; sampler-less legacy candidates keep approving (同人批准拒绝 + 旧契约回归)', async () => {
  const digest = 'a'.repeat(64);
  const files = fakeFiles(digest);
  const sampler = await actor('engineering');
  const approver = await actor('product');
  // 同人：登记采样者与批准者同一员工 → approval denied
  const same = await approvalWorld({ candidate: { digest, sampler: sampler.id }, acceptedBy: sampler.id });
  await expect(proof.approval(same.taskId, 'production', files)).rejects.toMatchObject({ code: 'forbidden' });
  // 异人：采样者与批准者不同 → approval 通过
  const other = await approvalWorld({ candidate: { digest, sampler: sampler.id }, acceptedBy: approver.id });
  const receipt = await proof.approval(other.taskId, 'production', files);
  expect(receipt.reviewer).toBe(approver.id);
  // 旧契约：无 sampler 的既有候选保持可验收
  const legacy = await approvalWorld({ candidate: { digest }, acceptedBy: approver.id });
  expect((await proof.approval(legacy.taskId, 'production', files)).reviewer).toBe(approver.id);
});

// ---- 复验修复面（R1–R4）：标记生命周期、admission 补口、sampler 校验、幂等与 clamp ----

run('R1: standby→submit→reviewer claim never triggers wake/timeout; the stale marker cannot destroy later leases', async () => {
  const gm = await actor('gm');
  const { taskId, window } = await windowedBlockedTask('标记生命周期', 'qa');
  const standby = await actor('qa');
  await core.resumeStandby(gm.cred, taskId, { ...text('待命后提交'), executionWindow: window }, standby.id);
  expect((await rowOf(taskId))!.standby_until).toBeTruthy();
  // 待命持有人提交：任务进复核相位——旧 deadline 不得再管辖这条租约
  const holderRow = await rowOf(taskId);
  const submitProof = { taskId, deliveryId: String(holderRow!.delivery_id), fence: holderRow!.fence as number, expectedVersion: holderRow!.version as number };
  await core.submit(standby.cred, submitProof, text('待命接力工作完成，交独立复核'));
  expect((await rowOf(taskId))!.state).toBe('review');
  // state=doing 门：复核相位上 standbyTimeout 必须拒绝，租约原样
  expect(await wf.standbyTimeout(taskId, standby.id, '超时（应被拒）', 'x')).toBe(false);
  // 复核者领取：新领清除旧标记
  const reviewer = await actor('qa');
  const reviewClaim = await core.claim(reviewer.cred, taskId);
  expect(reviewClaim.task.state).toBe('review');
  expect((await rowOf(taskId))!.standby_until ?? null).toBeNull();
  expect(await wf.standbyTimeout(taskId, reviewer.id, '超时（应被拒）', 'x')).toBe(false);
  const after = await rowOf(taskId);
  expect(after!.state).toBe('review');
  expect(after!.current_employee).toBe(reviewer.id);
  expect(after!.lease_expires_at).toBeTruthy();
});

run('R1: revoke→reclaim clears the marker; the next holder is never timeout-reclaimed (路径 B)', async () => {
  const gm = await actor('gm');
  const { taskId, window } = await windowedBlockedTask('收回再领取', 'qa');
  const standby = await actor('qa');
  await core.resumeStandby(gm.cred, taskId, { ...text('待命后会被收回'), executionWindow: window }, standby.id);
  expect(await wf.revokeLease(taskId, standby.id, '会话中断', '【交接包】fixture')).toBe(true);
  const revoked = await rowOf(taskId);
  expect(revoked!.state).toBe('ready');
  expect(revoked!.standby_until ?? null).toBeNull();
  const next = await actor('qa');
  await core.claim(next.cred, taskId);
  expect((await rowOf(taskId))!.standby_until ?? null).toBeNull();
  expect(await wf.standbyTimeout(taskId, next.id, '超时（应被拒）', 'x')).toBe(false);
});

run('R2: admission checks execute capability and unmet dependencies; verify_standby codes them', async () => {
  const gm = await actor('gm');
  const { taskId, window } = await windowedBlockedTask('能力与依赖预检', 'qa');
  const reviewOnlyId = `sb-qa-ro-${++count}`;
  await admin.enroll(reviewOnlyId, 'qa', ['review']);
  const noCap = await core.verifyStandby(gm.cred, { items: [{ taskId, employeeId: reviewOnlyId, executionWindow: window }], idempotencyKey: `verify-cap-${count}` });
  expect(noCap.items[0]).toMatchObject({ ok: false, code: 'standby_capability_denied' });
  // 依赖未满足：额外挂一个未完成前置
  const unfinished = await gmTask('product', 'product');
  await db.db.query('UPDATE $task SET dependencies = array::append(dependencies, $extra);', { task: new RecordId('task', taskId), extra: new RecordId('task', unfinished.id) });
  const standby = await actor('qa');
  const unmet = await core.verifyStandby(gm.cred, { items: [{ taskId, employeeId: standby.id, executionWindow: window }], idempotencyKey: `verify-dep-${count}` });
  expect(unmet.items[0]).toMatchObject({ ok: false, code: 'dependencies_unmet' });
  // 前置完成后预检放行
  await db.db.query("UPDATE $extra SET state='done';", { extra: new RecordId('task', unfinished.id) });
  const okNow = await core.verifyStandby(gm.cred, { items: [{ taskId, employeeId: standby.id, executionWindow: window }], idempotencyKey: `verify-dep2-${count}` });
  expect(okNow.items[0]).toMatchObject({ ok: true });
});

run('R3: prepare validates the sampler is a registered active employee', async () => {
  const { taskId, holder } = await approvalWorld({});
  const lease = proofLease(taskId, holder);
  expect(await proof.prepare(lease, 'production', fakeFiles('c'.repeat(64)), 'sb-ghost').catch(e => e.code)).toBe('invalid');
  const sampler = await actor('engineering');
  await proof.prepare(lease, 'production', fakeFiles('c'.repeat(64)), sampler.id);
  await db.db.query('UPDATE $e SET revoked = true;', { e: new RecordId('employee', sampler.id) });
  const second = await approvalWorld({});
  expect(await proof.prepare(proofLease(second.taskId, second.holder), 'production', fakeFiles('c'.repeat(64)), sampler.id).catch(e => e.code)).toBe('invalid');
});

run('R4: verify_standby replays idempotently (no duplicate audits) and the budget clamps to the lease', async () => {
  const gm = await actor('gm');
  const { taskId, window } = await windowedBlockedTask('幂等预检', 'qa');
  const standby = await actor('qa');
  const key = `verify-idem-${count}-${crypto.randomUUID()}`;
  const first = await core.verifyStandby(gm.cred, { items: [{ taskId, employeeId: standby.id, executionWindow: window }], idempotencyKey: key });
  const replay = await core.verifyStandby(gm.cred, { items: [{ taskId, employeeId: standby.id, executionWindow: window }], idempotencyKey: key });
  expect(replay.items).toEqual(first.items);
  const [audits] = await db.db.query<[Array<{ count: number }>]>('SELECT count() AS count FROM audit WHERE task = $task AND action = \'verify_standby\' GROUP ALL;', { task: new RecordId('task', taskId) });
  expect(audits[0]!.count).toBe(1);
  // 同键不同输入 → conflict
  const other = await actor('qa');
  expect(await core.verifyStandby(gm.cred, { items: [{ taskId, employeeId: other.id, executionWindow: window }], idempotencyKey: key }).catch(e => e.code)).toBe('conflict');
  // 预算 clamp：配置 900s > 租约 600s → standby_until 不晚于租约到期
  await db.db.query('UPSERT company_meta:config MERGE { standby_budget_seconds: 900 };');
  const clampedTask = (await windowedBlockedTask('预算收敛', 'qa'));
  const holder = await actor('qa');
  const resumed = await core.resumeStandby(gm.cred, clampedTask.taskId, { ...text('配置超预算时收敛到租约长度'), executionWindow: clampedTask.window }, holder.id);
  const standbySec = Math.floor(Date.parse(resumed.standbyUntil!) / 1000);
  const leaseSec = Math.floor(Date.parse(resumed.leaseExpiresAt!) / 1000);
  expect(standbySec).toBeLessThanOrEqual(leaseSec);
  expect(leaseSec - standbySec).toBeLessThanOrEqual(2);
  await db.db.query('UPSERT company_meta:config MERGE { standby_budget_seconds: 600 };');
});

run('R6: releasing a standby lease clears standby_until so the ready view never shows a stale deadline', async () => {
  const gm = await actor('gm');
  const { taskId, window, executor } = await windowedBlockedTask('释放待命租约');
  const resumed = await core.resumeStandby(gm.cred, taskId, { ...text('待命建立后立刻释放，检查标记生命周期'), executionWindow: window }, executor.id);
  expect(resumed.standbyUntil).toBeDefined();
  const released = await core.release(executor.cred,
    { taskId, deliveryId: resumed.deliveryId!, fence: resumed.fence!, expectedVersion: resumed.version },
    text('释放待命租约：待命窗口随租约一起结束'));
  expect(released.state).toBe('ready');
  expect(released.standbyUntil).toBeUndefined();
  const row = await rowOf(taskId);
  expect(row!.standby_until ?? null).toBeNull();
  expect(row!.current_employee ?? null).toBeNull();
});
