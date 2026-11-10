import { OutboundMessageStore } from '../src/outbound-messages.ts';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseConfig, type DatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { Workforce } from '../src/workforce.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
// Surreal QueryPromise is lazy. Call .then before Bun's .rejects so its native Promise inspection cannot leave the query undispatched.
const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;

async function fixture(override?: DatabaseConfig) {
  const config = { ...(override ?? loadDatabaseConfig()), namespace: `dispatch_attempt_${randomUUID().replaceAll('-', '')}`, database: 'control_plane' };
  const db = new CompanyDatabase(config);
  await db.connect(); await db.bootstrap();
  const core = new SurrealCompanyCore(db), wf = new Workforce(db), enrollment = new LocalEnrollmentAdmin(db);
  const owner = await enrollment.enroll('owner', 'owner', ['manage', 'execute', 'review']);
  const employee = await enrollment.enroll('synthetic', 'engineering', ['execute', 'review']);
  const reviewer = await enrollment.enroll('reviewer', 'qa', ['execute', 'review']);
  const task = await core.createTask(owner, { title: 'isolated dispatch fixture', context: 'Synthetic read-only dispatch test', executorRole: 'engineering', reviewerRole: 'qa', workIntent: { kind: 'read' }, idempotencyKey: randomUUID() });
  const claim = await core.claim(employee, task.id);
  const record = new RecordId('task', task.id), message = new RecordId('outbound_message', 'fixture');
  await db.db.query('DELETE outbound_message WHERE task = $task; CREATE $message CONTENT { task: $task, step: "execute", role: "engineering", body: "fixture", state: "draft", hold: false };', { message, task: record });
  const body = 'Synthetic dispatch message';
  const input = { employee: 'synthetic', task: task.id, kind: 'spawn' as const, delivery: claim.deliveryId, fence: claim.fence, message: 'fixture', body, bodyHash: createHash('sha256').update(body).digest('hex') };
  return { db, config, core, wf, owner, employee, reviewer, task, record, input, claim };
}

run('真实 core 领取：原子占位、并发续租不缩短、新连接 finalization、旧回调不得复活员工', async () => {
  const w = await fixture(); let second: CompanyDatabase | undefined;
  try {
    second = new CompanyDatabase(w.config); await second.connect(); await second.useDatabase(); const restarted = new Workforce(second);
    console.info('dispatch-fork: competing begin on two connections');
    const results = await Promise.allSettled([w.wf.beginDispatchAttempt({ ...w.input, request: randomUUID() }), restarted.beginDispatchAttempt({ ...w.input, request: randomUUID() })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const attempt = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<string>).value;
    console.info('dispatch-fork: reject claim');
    await expect(w.core.claim(w.employee, w.task.id)).rejects.toThrow();
    console.info('dispatch-fork: reject void');
    await expect(w.db.db.query('UPDATE $task SET state = "void", current_employee = NONE, delivery_id = NONE;', { task: w.record }).then(value => value)).rejects.toThrow();
    console.info('dispatch-fork: reject rebind');
    await expect(w.db.db.query('UPDATE $task SET project = project:other;', { task: w.record }).then(value => value)).rejects.toThrow();
    console.info('dispatch-fork: reject revoke');
    expect(await w.wf.revokeLease(w.task.id, 'synthetic', 'synthetic', 'synthetic')).toBe(false);
    console.info('dispatch-fork: concurrent recovery');
    const future = Math.floor(Date.now() / 1000) + 600;
    await w.db.db.query('UPDATE $task SET lease_expires_at = $future;', { task: w.record, future });
    await Promise.all([w.wf.recoverDispatchBindings(), restarted.recoverDispatchBindings()]);
    const [leases] = await w.db.db.query<[Array<{ lease_expires_at: number }>]>("SELECT lease_expires_at FROM $task;", { task: w.record });
    expect(leases[0]!.lease_expires_at).toBeGreaterThanOrEqual(future);
    console.info('dispatch-fork: acknowledge');
    await restarted.acknowledgeDispatchAttempt(attempt, 'synthetic-agent');
    await w.db.db.query('UPDATE $task SET lease_expires_at = 1;', { task: w.record });
    console.info('dispatch-fork: finalization recovery');
    // Simulated client replacement after receipt (not a process restart): a new workforce finalizes without another runtime call.
    expect(await restarted.recoverDispatchBindings()).toEqual([]);
    expect(await restarted.pendingDispatchAttempts()).toEqual([]);
    const [renewed] = await w.db.db.query<[Array<{ lease_expires_at: number }>]>("SELECT lease_expires_at FROM $task;", { task: w.record });
    expect(renewed[0]!.lease_expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const [before] = await w.db.db.query<[Array<{ wake_count: number; paseo_agent_id: string }>]>("SELECT wake_count, paseo_agent_id FROM employee:synthetic;");
    expect(before[0]).toMatchObject({ wake_count: 1, paseo_agent_id: 'synthetic-agent' });
    await w.db.db.query('UPDATE employee:synthetic SET retired = true;');
    await expect(w.wf.finishDispatchAttempt(attempt, 'synthetic-agent')).rejects.toThrow();
    await expect(w.wf.acknowledgeDispatchAttempt(attempt, 'other-agent')).rejects.toThrow();
    const [after] = await w.db.db.query<[Array<{ retired: boolean; wake_count: number; paseo_agent_id: string }>]>("SELECT retired, wake_count, paseo_agent_id FROM employee:synthetic;");
    expect(after[0]).toMatchObject({ retired: true, wake_count: 1, paseo_agent_id: 'synthetic-agent' });
  } finally { await second?.close(); await w.db.close(); }
}, 20000);

run('真实 core 快提交：核验审计，结果与收尾分离，新连接扫描不丢失，旧回调不覆盖新代际', async () => {
  const w = await fixture(); let second: CompanyDatabase | undefined;
  try {
    const attempt = await w.wf.beginDispatchAttempt({ ...w.input, request: randomUUID() });
    const attemptRecord = new RecordId('dispatch_attempt', attempt);
    // Nonempty but unrelated audit IDs must not authorize an identity transition.
    await w.db.db.query('CREATE audit:fake CONTENT { task: task:other, actor: employee:other, action: "submit", version: 999 }; UPDATE $attempt SET result_confirmed = true, result_action = "submit", result_version = $version, result_audit = audit:fake;', { attempt: attemptRecord, version: w.claim.task.version });
    await expect(w.db.db.query('UPDATE $task SET state = "review", current_employee = NONE, delivery_id = NONE, version += 1;', { task: w.record }).then(value => value)).rejects.toThrow();
    await w.db.db.query('UPDATE $attempt SET result_confirmed = NONE, result_action = NONE, result_version = NONE, result_audit = NONE;', { attempt: attemptRecord });
    await w.core.submit(w.employee, { taskId: w.task.id, deliveryId: w.claim.deliveryId, fence: w.claim.fence, expectedVersion: w.claim.task.version }, { text: 'Synthetic verification completed for the read-only fixture task.', idempotencyKey: randomUUID() });
    const pending = await w.wf.pendingDispatchAttempts();
    expect(pending).toHaveLength(1); expect(pending[0]!.result_confirmed).toBe(true);
    await expect(w.core.claim(w.reviewer, w.task.id)).rejects.toThrow();
    await expect(w.db.db.query('UPDATE employee:synthetic SET retired = true;').then(value => value)).rejects.toThrow();
    second = new CompanyDatabase(w.config); await second.connect(); await second.useDatabase(); const restarted = new Workforce(second);
    expect((await restarted.recoverDispatchBindings())[0]).toContain('runtime agent receipt missing');
    expect(await restarted.pendingDispatchAttempts()).toHaveLength(1);
    await restarted.acknowledgeDispatchAttempt(attempt, 'synthetic-agent');
    expect(await restarted.recoverDispatchBindings()).toEqual([]);
    expect(await restarted.pendingDispatchAttempts()).toEqual([]);
    const next = await w.core.claim(w.reviewer, w.task.id);
    await expect(w.wf.finishDispatchAttempt(attempt, 'synthetic-agent')).rejects.toThrow();
    const after = await w.core.getTask(w.reviewer, w.task.id);
    expect(after.currentEmployee).toBe('reviewer'); expect(after.fence).toBe(next.fence);
  } finally { await second?.close(); await w.db.close(); }
}, 20000);

run('真实 prepareSend→begin：毫秒/纳秒版本不经过 Date 往返，消息改变拒绝旧版本', async () => {
  const w = await fixture();
  try {
    await w.db.db.query("UPDATE outbound_message:fixture SET created_at = <datetime>'2026-11-10T01:02:03.123456789Z', edited_at = <datetime>'2026-11-10T01:02:03.987654321Z';");
    const messages = new OutboundMessageStore(w.db.db);
    const prepared = await messages.prepareSend(w.task.id, 'execute', 'synthetic');
    expect(prepared?.message.dispatchRevision).toMatch(/^[a-f0-9]{64}$/);
    const input = { ...w.input, body: prepared!.body, bodyHash: createHash('sha256').update(prepared!.body).digest('hex'), messageRevision: prepared!.message.dispatchRevision };
    await w.db.db.query("UPDATE outbound_message:fixture SET body = 'changed without timestamp change';");
    await expect(w.wf.beginDispatchAttempt({ ...input, request: randomUUID() })).rejects.toThrow();
    const fresh = await messages.prepareSend(w.task.id, 'execute', 'synthetic');
    await w.wf.beginDispatchAttempt({ ...input, body: fresh!.body, bodyHash: createHash('sha256').update(fresh!.body).digest('hex'), messageRevision: fresh!.message.dispatchRevision, request: randomUUID() });
    expect(await w.wf.pendingDispatchAttempts()).toHaveLength(1);
  } finally { await w.db.close(); }
}, 20000);

run('需要 activate 的运行端：收到 spawn 回执不能收尾，激活不确定跨连接保留隔离', async () => {
  const w = await fixture(); let second: CompanyDatabase | undefined;
  try {
    const attempt = await w.wf.beginDispatchAttempt({ ...w.input, activationRequired: true, request: randomUUID() });
    await w.wf.acknowledgeDispatchAttempt(attempt, 'native-fixture');
    await expect(w.wf.finishDispatchAttempt(attempt, 'native-fixture')).rejects.toThrow();
    await w.wf.recoverDispatchBindings();
    expect(await w.wf.pendingDispatchAttempts()).toHaveLength(1);
    await w.wf.prepareDispatchActivation(attempt, 'native-fixture');
    second = new CompanyDatabase(w.config); await second.connect(); await second.useDatabase(); const restarted = new Workforce(second);
    await restarted.recoverDispatchBindings();
    const pending = await restarted.pendingDispatchAttempts();
    expect(pending[0]!.activation_state).toBe('calling');
    const [messages] = await w.db.db.query<[Array<{ state: string }>]>("SELECT state FROM outbound_message:fixture;");
    expect(messages[0]!.state).toBe('draft');
    await expect(restarted.finishDispatchAttempt(attempt, 'native-fixture')).rejects.toThrow();
    await restarted.confirmDispatchActivation(attempt, 'native-fixture');
    await restarted.finishDispatchAttempt(attempt, 'native-fixture');
    expect(await restarted.pendingDispatchAttempts()).toEqual([]);
  } finally { await second?.close(); await w.db.close(); }
}, 20000);

run('故障注入：sent消息事件失败时收尾整体回滚，恢复后sent_body精确一致', async () => {
  const w = await fixture();
  try {
    const attempt = await w.wf.beginDispatchAttempt({ ...w.input, request: randomUUID() });
    await w.wf.acknowledgeDispatchAttempt(attempt, 'rollback-agent');
    await w.db.db.query("DEFINE EVENT test_fail_sent ON TABLE outbound_message WHEN $after.state = 'sent' THEN { THROW 'synthetic finalization failure'; };");
    await expect(w.wf.finishDispatchAttempt(attempt, 'rollback-agent')).rejects.toThrow();
    const [employees, messages] = await w.db.db.query<[Array<{ wake_count?: number; paseo_agent_id?: string; dispatch_attempt?: unknown }>, Array<{ state: string; sent_body?: string; dispatch_attempt?: unknown }>]>("SELECT wake_count, paseo_agent_id, dispatch_attempt FROM employee:synthetic; SELECT state, sent_body, dispatch_attempt FROM outbound_message:fixture;");
    expect(employees[0]!.wake_count ?? 0).toBe(0);
    expect(employees[0]!.paseo_agent_id ?? null).toBeNull();
    expect(employees[0]!.dispatch_attempt).toBeDefined();
    expect(messages[0]!.state).toBe('draft'); expect(messages[0]!.sent_body ?? null).toBeNull();
    expect(await w.wf.pendingDispatchAttempts()).toHaveLength(1);
    await w.db.db.query('REMOVE EVENT test_fail_sent ON TABLE outbound_message;');
    expect(await w.wf.recoverDispatchBindings()).toEqual([]);
    const [sent] = await w.db.db.query<[Array<{ state: string; sent_body: string; sent_to: string }>]>("SELECT state, sent_body, sent_to FROM outbound_message:fixture;");
    expect(sent[0]).toMatchObject({ state: 'sent', sent_body: w.input.body, sent_to: 'synthetic' });
    expect(await w.wf.pendingDispatchAttempts()).toEqual([]);
  } finally { await w.db.close(); }
}, 20000);

run('双连接结果提交与收尾竞争：一个结果审计、一次唤醒计数、屏障最终一致', async () => {
  const w = await fixture(); let second: CompanyDatabase | undefined;
  try {
    const attempt = await w.wf.beginDispatchAttempt({ ...w.input, request: randomUUID() });
    await w.wf.acknowledgeDispatchAttempt(attempt, 'race-agent');
    second = new CompanyDatabase(w.config); await second.connect(); await second.useDatabase();
    const otherCore = new SurrealCompanyCore(second);
    const results = await Promise.allSettled([
      otherCore.submit(w.employee, { taskId: w.task.id, deliveryId: w.claim.deliveryId, fence: w.claim.fence, expectedVersion: w.claim.task.version }, { text: 'Synthetic read-only result submitted while dispatch finalization is racing.', idempotencyKey: randomUUID() }),
      w.wf.finishDispatchAttempt(attempt, 'race-agent'),
    ]);
    expect(results[0]!.status).toBe('fulfilled');
    expect(await w.wf.recoverDispatchBindings()).toEqual([]);
    const [audits, employees, messages] = await w.db.db.query<[Array<unknown>, Array<{ wake_count: number }>, Array<{ state: string; sent_body: string }>]>("SELECT id FROM audit WHERE task = $task AND action = 'submit'; SELECT wake_count FROM employee:synthetic; SELECT state, sent_body FROM outbound_message:fixture;", { task: w.record });
    expect(audits).toHaveLength(1); expect(employees[0]!.wake_count).toBe(1);
    expect(messages[0]).toMatchObject({ state: 'sent', sent_body: w.input.body });
    expect(await w.wf.pendingDispatchAttempts()).toEqual([]);
    expect((await w.core.getTask(w.employee, w.task.id)).state).toBe('review');
  } finally { await second?.close(); await w.db.close(); }
}, 20000);

for (const action of ['accept', 'return', 'block'] as const) {
  run(`真实 core ${action}：合法结果保留屏障，事件故障回滚审计后可重试`, async () => {
    const w = await fixture();
    try {
      let actor = w.employee, claim = w.claim, employee = 'synthetic';
      if (action !== 'block') {
        await w.core.submit(w.employee, { taskId: w.task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version }, { text: 'Read-only fixture ready for independent review.', idempotencyKey: randomUUID() });
        actor = w.reviewer; employee = 'reviewer'; claim = await w.core.claim(actor, w.task.id);
        await w.db.db.query('DELETE outbound_message WHERE task = $task; CREATE outbound_message:fixture CONTENT { task: $task, step: "review", role: "qa", body: "fixture", state: "draft", hold: false };', { task: w.record });
      }
      const attempt = await w.wf.beginDispatchAttempt({ ...w.input, employee, delivery: claim.deliveryId, fence: claim.fence, request: randomUUID() });
      await w.wf.acknowledgeDispatchAttempt(attempt, 'result-agent');
      const proof = { taskId: w.task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version };
      const evidence = { text: 'Synthetic independent verification has completed; missing fixture input requires owner decision.', idempotencyKey: randomUUID() };
      const invoke = () => action === 'accept' ? w.core.accept(actor, proof, evidence) : action === 'return' ? w.core.returnTask(actor, proof, evidence) : w.core.block(actor, proof, 'owner', evidence);
      await w.db.db.query("DEFINE EVENT test_fail_transition ON TABLE task WHEN $after.version > $before.version THEN { THROW 'synthetic transition rollback'; };", { task: w.record });
      await expect(invoke()).rejects.toThrow();
      expect((await w.wf.pendingDispatchAttempts())[0]!.result_confirmed ?? false).toBe(false);
      const [before] = await w.db.db.query<[unknown[]]>('SELECT id FROM audit WHERE task = $task AND action = $action;', { task: w.record, action });
      expect(before).toHaveLength(0);
      await w.db.db.query('REMOVE EVENT test_fail_transition ON TABLE task;');
      await invoke();
      expect((await w.wf.pendingDispatchAttempts())[0]!.result_confirmed).toBe(true);
      await w.wf.finishDispatchAttempt(attempt, 'result-agent');
      expect(await w.wf.pendingDispatchAttempts()).toHaveLength(0);
      const [audits] = await w.db.db.query<[unknown[]]>('SELECT id FROM audit WHERE task = $task AND action = $action;', { task: w.record, action });
      expect(audits).toHaveLength(1);
    } finally { await w.db.close(); }
  }, 20000);
}

run('确定性收尾先于业务结果：后续真实 submit 一次，旧回调拒绝', async () => {
  const w = await fixture();
  try {
    const attempt = await w.wf.beginDispatchAttempt({ ...w.input, request: randomUUID() });
    await w.wf.acknowledgeDispatchAttempt(attempt, 'ordered-agent');
    await w.wf.finishDispatchAttempt(attempt, 'ordered-agent');
    await w.core.submit(w.employee, { taskId: w.task.id, deliveryId: w.claim.deliveryId, fence: w.claim.fence, expectedVersion: w.claim.task.version }, { text: 'Finalization was committed before this synthetic business result.', idempotencyKey: randomUUID() });
    await expect(w.wf.finishDispatchAttempt(attempt, 'ordered-agent')).rejects.toThrow();
    expect((await w.core.getTask(w.employee, w.task.id)).state).toBe('review');
    const [rows] = await w.db.db.query<[Array<{ wake_count: number }>]>("SELECT wake_count FROM employee:synthetic;");
    expect(rows[0]!.wake_count).toBe(1);
  } finally { await w.db.close(); }
}, 20000);

run('真实数据库 SIGKILL 重启：持久化 activation calling 隔离，已确认收尾重启不重复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-crash-'));
  const socket = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = socket.port!; socket.stop(true);
  const config: DatabaseConfig = { url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'isolated-crash-fixture', namespace: 'unused', database: 'control_plane' };
  let server: ReturnType<typeof Bun.spawn> | undefined, db: CompanyDatabase | undefined;
  const start = async () => {
    server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', config.rootUser, '--pass', config.rootPassword, '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
    for (let n = 0; n < 160; n++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
      await Bun.sleep(25);
    }
    throw new Error('test-owned fork restart failed');
  };
  const crash = async () => { await db?.close(); db = undefined; server!.kill('SIGKILL'); await server!.exited; server = undefined; };
  try {
    await start(); const w = await fixture(config); db = w.db;
    const attempt = await w.wf.beginDispatchAttempt({ ...w.input, activationRequired: true, request: randomUUID() });
    await w.wf.acknowledgeDispatchAttempt(attempt, 'persisted-agent');
    await w.wf.prepareDispatchActivation(attempt, 'persisted-agent');
    await crash(); await start();
    db = new CompanyDatabase(w.config); await db.connect(); await db.useDatabase();
    let wf = new Workforce(db);
    expect((await wf.pendingDispatchAttempts())[0]!.activation_state).toBe('calling');
    await wf.recoverDispatchBindings();
    await expect(wf.finishDispatchAttempt(attempt, 'persisted-agent')).rejects.toThrow();
    const [before] = await db.db.query<[Array<{ state: string }>]>("SELECT state FROM outbound_message:fixture;");
    expect(before[0]!.state).toBe('draft');
    // Synthetic trusted activation receipt, not a real runtime receipt.
    await wf.confirmDispatchActivation(attempt, 'persisted-agent'); await wf.finishDispatchAttempt(attempt, 'persisted-agent');
    await crash(); await start();
    db = new CompanyDatabase(w.config); await db.connect(); await db.useDatabase(); wf = new Workforce(db);
    expect(await wf.recoverDispatchBindings()).toEqual([]);
    const [rows, messages] = await db.db.query<[Array<{ wake_count: number }>, Array<{ sent_body: string }>]>("SELECT wake_count FROM employee:synthetic; SELECT sent_body FROM outbound_message:fixture;");
    expect(rows[0]!.wake_count).toBe(1); expect(messages[0]!.sent_body).toBe(w.input.body);
  } finally { await db?.close(); if (server) { server.kill(); await server.exited; } await rm(dir, { recursive: true, force: true }); }
}, 30000);

run('真实 core 级联作废：子任务事件拒绝时父任务、子任务、审计整体回滚', async () => {
  const w = await fixture();
  try {
    const child = await w.core.createTask(w.owner, { title: 'planned child', context: 'synthetic cascade fixture', executorRole: 'engineering', reviewerRole: 'qa', parent: w.task.id, workIntent: { kind: 'read' }, idempotencyKey: randomUUID() });
    // Construct a planned descendant, then drive the real retire path rather than raw parent mutation.
    await w.db.db.query("UPDATE $child SET state = 'planned'; DEFINE EVENT test_fail_cascade ON TABLE task WHEN $before.parent != NONE AND $after.state = 'void' THEN { THROW 'synthetic child conflict'; };", { child: new RecordId('task', child.id) });
    const input = { taskId: w.task.id, expectedVersion: w.claim.task.version, text: 'Synthetic cascade retirement for rollback verification', idempotencyKey: randomUUID() };
    await expect(w.core.retireTask(w.owner, input)).rejects.toThrow();
    expect((await w.core.getTask(w.owner, w.task.id)).state).toBe('doing');
    expect((await w.core.getTask(w.owner, child.id)).state).toBe('planned');
    const [audits] = await w.db.db.query<[unknown[]]>("SELECT id FROM audit WHERE task IN $tasks AND action IN ['retire', 'planned_voided'];", { tasks: [w.record, new RecordId('task', child.id)] });
    expect(audits).toHaveLength(0);
    await w.db.db.query('REMOVE EVENT test_fail_cascade ON TABLE task;');
    await w.core.retireTask(w.owner, input);
    expect((await w.core.getTask(w.owner, w.task.id)).state).toBe('void');
    expect((await w.core.getTask(w.owner, child.id)).state).toBe('void');
  } finally { await w.db.close(); }
}, 20000);

run('只读核验：精确身份、脱敏指纹、过期读集改变，无外呼或取消入口', async () => {
  const { inspectDispatchRecovery } = await import('../src/dispatch-recovery-inspection.ts');
  const w = await fixture();
  try {
    const attempt = await w.wf.beginDispatchAttempt({ ...w.input, request: randomUUID() });
    const first = await inspectDispatchRecovery(w.db, attempt);
    expect(first.request).toBe(attempt); expect(first.fingerprint).toHaveLength(64);
    expect(JSON.stringify(first)).not.toContain(w.input.body);
    expect(first.cancellation).toContain('blocked'); expect(first.execution).toContain('disabled');
    expect((await inspectDispatchRecovery(w.db, attempt)).fingerprint).toBe(first.fingerprint);
    await w.wf.acknowledgeDispatchAttempt(attempt, 'inspection-agent');
    expect((await inspectDispatchRecovery(w.db, attempt)).fingerprint).not.toBe(first.fingerprint);
    expect(await w.wf.pendingDispatchAttempts()).toHaveLength(1);
    await expect(inspectDispatchRecovery(w.db, '../not-an-id')).rejects.toThrow();
  } finally { await w.db.close(); }
}, 20000);

for (const boundary of ['before-activation', 'running-child', 'after-result'] as const) {
  run(`真实fork+执行端进程：${boundary} SIGKILL后接管，不重发且收尾可核验`, async () => {
    const { writeFile, readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-runtime-db-'));
    const w = await fixture();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let modelPid: number | undefined;
    const wait = async (path: string) => { for (let n = 0; n < 1000; n++) { if (existsSync(path)) return; if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`fixture child exited ${child.exitCode}`); await Bun.sleep(10); } throw new Error('runtime fixture barrier timeout'); };
    try {
      const attempt = await w.wf.beginDispatchAttempt({ ...w.input, activationRequired: true, request: randomUUID() });
      const script = join(dir, 'runner.ts'), model = join(dir, 'model.cjs'), barrier = join(dir, 'barrier'), receipt = join(dir, 'recovered.json');
      const modulePath = (name: string) => new URL(`../src/${name}.ts`, import.meta.url).pathname;
      await writeFile(model, `const fs = require('fs'); process.stdin.resume(); process.stdin.on('end', () => { fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, 'call\\n'); console.log(JSON.stringify({type:'result', subtype:'success', is_error:false, session_id:'synthetic-real-session', result:'Synthetic verification result'})); });`);
      if (boundary === 'running-child') await writeFile(model, `const fs = require('fs'); process.stdin.resume(); process.stdin.on('end', () => { fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, 'call\\n'); fs.writeFileSync(${JSON.stringify(barrier)}, String(process.pid)); setInterval(() => {}, 1000); });`);
      await writeFile(script, `import { NativeRuntime } from ${JSON.stringify(modulePath('runner/native'))};
        import { CompanyDatabase } from ${JSON.stringify(modulePath('database'))};
        import { Workforce } from ${JSON.stringify(modulePath('workforce'))};
        import { SurrealCompanyCore } from ${JSON.stringify(modulePath('core'))};
        import { writeFileSync, readFileSync } from 'node:fs';
        const db = new CompanyDatabase(${JSON.stringify(w.config)}); await db.connect(); await db.useDatabase();
        const wf = new Workforce(db), core = new SurrealCompanyCore(db);
        const runtime = new NativeRuntime({ root: ${JSON.stringify(join(dir, 'native'))}, host:'fixture',
          command: () => [process.execPath, ${JSON.stringify(model)}], environment: async () => ({}),
          onEnded: async () => { await core.submit(${JSON.stringify(w.employee)}, ${JSON.stringify({ taskId: w.task.id, deliveryId: w.claim.deliveryId, fence: w.claim.fence, expectedVersion: w.claim.task.version })}, {text:'Synthetic real runtime result verifies the read-only task.', idempotencyKey:'real-runtime-result'}); writeFileSync(${JSON.stringify(barrier)}, 'result'); }
        });
        if (process.env.RECOVER === '1') {
          const errors = await wf.recoverDispatchBindings();
          await runtime.recoverFinishedTurns();
          writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({errors, pending: await wf.pendingDispatchAttempts(), sessions: [...await runtime.list()]}));
          await runtime.close(); await db.close();
        } else {
          const agent = await runtime.spawn({ title:'synthetic', provider:'factory-droid', model:'fixture', cwd:${JSON.stringify(dir)}, workspaceTitle:'fixture', labels:{dispatch_request:${JSON.stringify(attempt)}}, env:{}, prompt:${JSON.stringify(w.input.body)} });
          await wf.acknowledgeDispatchAttempt(${JSON.stringify(attempt)}, agent); await wf.prepareDispatchActivation(${JSON.stringify(attempt)}, agent);
          if (${JSON.stringify(boundary)} === 'before-activation') writeFileSync(${JSON.stringify(barrier)}, 'prepared');
          else await runtime.activate(agent);
          setInterval(() => {}, 1000);
        }`, { mode: 0o600 });
      child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'inherit' });
      await wait(barrier);
      if (boundary === 'running-child') modelPid = Number(await readFile(barrier, 'utf8'));
      child.kill('SIGKILL'); await child.exited;
      child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'inherit', env: { ...process.env, RECOVER: '1' } });
      expect(await child.exited).toBe(0);
      const report = JSON.parse(await readFile(receipt, 'utf8'));
      const [messages, employees] = await w.db.db.query<[Array<{ state: string; sent_body?: string }>, Array<{ wake_count?: number }>]>("SELECT state, sent_body FROM outbound_message:fixture; SELECT wake_count FROM employee:synthetic;");
      if (boundary === 'running-child') {
        expect(report.pending).toHaveLength(1); expect(report.sessions[0][1].status).toBe('unknown');
        expect(messages[0]!.state).toBe('draft'); expect(await readFile(join(dir, 'calls'), 'utf8')).toBe('call\n');
      } else if (boundary === 'before-activation') {
        expect(report.pending).toHaveLength(1); expect(report.pending[0].activation_state).toBe('calling');
        expect(messages[0]!.state).toBe('draft'); expect(existsSync(join(dir, 'calls'))).toBe(false);
      } else {
        expect(report.errors).toEqual([]); expect(report.pending).toHaveLength(0);
        expect(messages[0]).toMatchObject({ state: 'sent', sent_body: w.input.body });
        expect(employees[0]!.wake_count).toBe(1); expect(await readFile(join(dir, 'calls'), 'utf8')).toBe('call\n');
        expect((await w.core.getTask(w.employee, w.task.id)).state).toBe('review');
        const [audits] = await w.db.db.query<[unknown[]]>("SELECT id FROM audit WHERE task = $task AND action = 'submit';", { task: w.record });
        expect(audits).toHaveLength(1);
      }
    } finally { if (modelPid) { try { process.kill(modelPid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } } if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } await w.db.close(); await rm(dir, { recursive: true, force: true }); }
  }, 30000);
}

run('受控人工收尾：过期/错身份/陈旧核验拒绝，故障回滚，并发与响应丢失重放仅一次', async () => {
  const { inspectDispatchRecovery } = await import('../src/dispatch-recovery-inspection.ts');
  const { finalizeApprovedDispatch } = await import('../src/dispatch-recovery-finalize.ts');
  const w = await fixture(); let second: CompanyDatabase | undefined;
  try {
    const request = await w.wf.beginDispatchAttempt({ ...w.input, activationRequired: true, request: randomUUID() });
    await w.wf.acknowledgeDispatchAttempt(request, 'approved-agent');
    await w.core.submit(w.employee, { taskId: w.task.id, deliveryId: w.claim.deliveryId, fence: w.claim.fence, expectedVersion: w.claim.task.version }, {text:'Synthetic verified result ready for approved bookkeeping only.', idempotencyKey: randomUUID()});
    const report = await inspectDispatchRecovery(w.db, request);
    const input = { request, agent:'approved-agent', approval:randomUUID(), operation:randomUUID(), fingerprint:report.fingerprint };
    await expect(finalizeApprovedDispatch(w.db, input)).rejects.toThrow();
    const approval = new RecordId('dispatch_recovery_approval', input.approval);
    await w.db.db.query("CREATE $approval CONTENT { action:'finalize_result', request:$request, agent:$agent, fingerprint:$fingerprint, operation:$operation, operator:'synthetic-owner', confirmation_ref:'synthetic-explicit-confirmation', expires_at:time::now()-1s };", {...input, approval});
    await expect(finalizeApprovedDispatch(w.db, input)).rejects.toThrow();
    await w.db.db.query('UPDATE $approval SET expires_at=time::now()+5m;', {approval});
    await expect(finalizeApprovedDispatch(w.db, {...input, agent:'wrong-agent'})).rejects.toThrow();
    await w.db.db.query("UPDATE employee:synthetic SET wake_count=2;");
    await expect(finalizeApprovedDispatch(w.db, input)).rejects.toThrow();
    // A fresh observation requires a fresh approval, not silently changing the supplied hash.
    const fresh = await inspectDispatchRecovery(w.db, request);
    input.fingerprint = fresh.fingerprint;
    await w.db.db.query('UPDATE $approval SET fingerprint=$fingerprint;', {approval, fingerprint:input.fingerprint});
    await w.db.db.query("DEFINE EVENT fail_recovery_receipt ON TABLE dispatch_recovery_receipt WHEN true THEN { THROW 'synthetic receipt write failure'; };");
    await expect(finalizeApprovedDispatch(w.db, input)).rejects.toThrow();
    expect(await w.wf.pendingDispatchAttempts()).toHaveLength(1);
    const [rows] = await w.db.db.query<[Array<{used_by?:unknown}>]>('SELECT used_by FROM $approval;', {approval});
    expect(rows[0]!.used_by ?? null).toBeNull();
    await w.db.db.query('REMOVE EVENT fail_recovery_receipt ON TABLE dispatch_recovery_receipt;');
    second = new CompanyDatabase(w.config); await second.connect(); await second.useDatabase();
    const results = await Promise.allSettled([finalizeApprovedDispatch(w.db,input),finalizeApprovedDispatch(second,input)]);
    expect(results.some(r=>r.status==='fulfilled')).toBe(true);
    const receipt = await finalizeApprovedDispatch(w.db,input); // exact operation replay after lost response
    expect(receipt).toMatchObject({request, action:'finalize_result'});
    await expect(finalizeApprovedDispatch(w.db,{...input,request:randomUUID()})).rejects.toThrow();
    const [receipts, employees] = await w.db.db.query<[unknown[],Array<{wake_count:number}>]>("SELECT id FROM dispatch_recovery_receipt; SELECT wake_count FROM employee:synthetic;");
    expect(receipts).toHaveLength(1); expect(employees[0]!.wake_count).toBe(3); expect(await w.wf.pendingDispatchAttempts()).toHaveLength(0);
  } finally { await second?.close(); await w.db.close(); }
},20000);
