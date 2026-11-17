import { afterAll, beforeAll, expect, test, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CompanyDatabase, CLOUD_SCHEMA_VERSION } from '../src/database.ts';
import { SurrealCompanyCore, HASH } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import { SidecarPool } from '../src/runner/sidecar.ts';
import { ExecutionJournal, workResult } from '../src/runner/lifecycle.ts';
import { saveRoute } from '../src/routes.ts';
import { HANDOVER_ROWS } from '../src/handover-window.ts';
setDefaultTimeout(60000);
const run = process.env.RUN_SCK_CLOUD_RUNNER_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, owner: string, wf: Workforce;
const pools: SidecarPool[] = [];
// Same read-only fact source the production runner injects: task lease identity, employee identity, and the
// idempotency record that proves this delivery's write already committed server-side. A failed read throws and
// stays unknown, exactly like production; tests inject transient failures through failIdempotencyReads.
let failIdempotencyReads = 0;
const resultFacts = async (taskId: string, employeeId: string, delivery?: { action: string; idempotencyKey: string }) => {
  const [tasks] = await db.db.query<[Array<{ state: string; current_employee?: string; delivery_id?: string; fence?: number }>]>(
    'SELECT state, current_employee, delivery_id, fence FROM $task;', { task: new RecordId('task', taskId) });
  const [employees] = await db.db.query<[Array<{ retired?: boolean; revoked?: boolean }>]>(
    'SELECT retired, revoked FROM $employee;', { employee: new RecordId('employee', employeeId) });
  if (delivery && failIdempotencyReads > 0) { failIdempotencyReads--; throw new Error('synthetic idempotency read failure'); }
  const stored = delivery
    ? await db.db.select(new RecordId('idempotency', HASH(`${employeeId}\0${delivery.action}\0${delivery.idempotencyKey}`)))
    : undefined;
  return {
    ...(tasks?.[0] ? { task: { state: tasks[0].state, currentEmployee: tasks[0].current_employee, deliveryId: tasks[0].delivery_id, fence: tasks[0].fence } } : {}),
    ...(employees?.[0] ? { employee: { retired: employees[0].retired === true, revoked: employees[0].revoked === true } } : { employee: { missing: true } }),
    ...(stored ? { landed: true } : {}),
  };
};
const journalFor = (runDir: string) =>
  new ExecutionJournal(join(dirname(runDir), 'private', 'executions', createHash('sha256').update(runDir).digest('hex')));
beforeAll(async () => {
  if (process.env.RUN_SCK_CLOUD_RUNNER_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-lifecycle-fork-')));
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
  const port = probe.port!; probe.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, namespace: 'lifecycle', database: 'fixture', rootUser: 'root', rootPassword: 'fixture' });
  await db.connect(); await db.bootstrap(); core = new SurrealCompanyCore(db); wf = new Workforce(db);
  owner = await new LocalEnrollmentAdmin(db).enroll('owner', 'owner', ['manage', 'execute', 'review']);
  await saveRoute(db.db, { type: 'lifecycle-fixture', label: 'lifecycle', executor_role: 'engineering', reviewer_role: 'qa', code: false, hold: false, enabled: true }, 'fixture');
});
afterAll(async () => { for (const pool of pools) pool.close(); if (db) await db.close(); if (server) { server.kill(); await server.exited; } if (dir) rmSync(dir, { recursive: true, force: true }); });
run('真实 fork：模型零生命周期命令，从领取、自动送审到独立 QA 验收完成', async () => {
  const task = await core.createTask(owner, { type: 'lifecycle-fixture', title: '执行端自动收尾', context: '验证自动状态转换', idempotencyKey: crypto.randomUUID() } as never);
  const report = `工作结果：完成\n已核对任务目标和验收要求，输出完整可核验的测试结果。\n报告与原始输出：/evidence/${task.id}/tests.log`;
  for (const role of ['engineering', 'qa'] as const) {
    await wf.upsertDef(`fixture-${role}`, { role, provider: 'claude', model: 'fixture' });
    const def = (await wf.defs()).find(d => d.id === `fixture-${role}`)!;
    const inst = await wf.spawnInst(def);
    const pool = new SidecarPool({ runDir: join(dir, role, 'comm'), core, workforce: wf, managedLifecycle: true }); pools.push(pool);
    pool.env(inst); inst.paseoAgentId = role; pool.bindAgent(inst.id, role);
    await pool.claim(inst, { id: task.id } as never);
    if (role === 'qa') {
      const commDir = pool.commDirFor(inst.id)!;
      expect(readFileSync(join(commDir, 'task.md'), 'utf8')).toContain(report);
      const snapshot = JSON.parse(readFileSync(join(commDir, 'claim.json'), 'utf8'));
      expect(snapshot.history.filter((h: { action: string }) => h.action === 'submit')).toHaveLength(1);
      expect(snapshot.historyComplete).toBe(false);
      expect(snapshot.historyCount).toBeGreaterThan(snapshot.history.length);
    }
    await pool.turnStarted(role, role + '-turn');
    const result = await pool.settleExecution({ agent: { id: role }, turnId: role + '-turn', outcome: { kind: 'completed' },
      timeline: [{ type: 'assistant_message', text: role === 'qa' ? '复核结论：通过\n已独立核对自动收尾的执行证据与结果，全部符合本任务验收要求。' : report }] });
    expect(result?.status).toBe('ingested');
    expect((await core.getTask(owner, task.id)).state).toBe(role === 'qa' ? 'done' : 'review');
    if (role === 'engineering') {
      // Ordinary protocol activity can push the submit outside the bounded handover window.
      for (let i = 0; i <= HANDOVER_ROWS; i++) {
        await db.db.query('CREATE audit CONTENT { task: $task, actor: "fixture", action: "handover_noise", evidence: "unrelated activity", at: time::now() };', { task: new RecordId('task', task.id) });
      }
    }
  }
  const history = await core.history(owner, task.id);
  expect(history.filter(h => h.action === 'submit')).toHaveLength(1);
  expect(history.filter(h => h.action === 'accept')).toHaveLength(1);
});

run('真实 fork：撤租约并退休的旧员工结果终态 superseded，保留成果且不再重复提交', async () => {
  const task = await core.createTask(owner, { type: 'lifecycle-fixture', title: '旧结果生命周期', context: '验证撤租约后旧投递不再重放', idempotencyKey: crypto.randomUUID() } as never);
  await wf.upsertDef('fixture-legacy', { role: 'engineering', provider: 'claude', model: 'fixture' });
  const def = (await wf.defs()).find(d => d.id === 'fixture-legacy')!;
  const inst = await wf.spawnInst(def);
  const runDir = join(dir, 'legacy', 'comm');
  const pool = new SidecarPool({ runDir, core, workforce: wf, managedLifecycle: true, resultFacts });
  pools.push(pool);
  pool.env(inst); inst.paseoAgentId = 'legacy'; pool.bindAgent(inst.id, 'legacy');
  const claim = await pool.claim(inst, { id: task.id } as never);
  expect(claim).toBeDefined();
  const proof = { taskId: task.id, deliveryId: claim!.deliveryId!, fence: claim!.fence, expectedVersion: claim!.task.version };
  // A captured result that never reached the core: the exact state the real journal kept for the retired reviewer.
  const journal = journalFor(runDir);
  const text = '工作结果：完成\n旧投递的成果与验证证据已经保存在执行记录，等待自动送审。';
  const row = journal.reserve(inst.id, 'doing', proof);
  row.state = 'pending'; row.finalText = text;
  row.result = workResult(text, 'doing');
  journal.save(row);
  // The lease is withdrawn server-side without a verdict, then the identity is retired; both are authoritative facts.
  await core.release(inst.credential!, proof, { text: 'fixture：撤租约以验证旧投递不再重放', idempotencyKey: crypto.randomUUID() });
  await wf.retire(inst.id, 'fixture：会话轮换', 'rotation');
  pool.dropLease(inst.id, task.id);
  for (const pending of journal.rows()) { pending.nextRetry = 0; journal.save(pending); }
  await pool.retryExecutions();
  const after = journal.read(inst.id, proof.deliveryId)!;
  expect(after.state).toBe('superseded');
  expect(['employee_gone', 'task_not_active'].includes(after.supersededCause!)).toBe(true);
  expect(after.result?.action).toBe('submit');
  expect(after.result?.evidence.text).toContain('旧投递的成果与验证证据');
  const refused = (await core.history(owner, task.id)).filter(h => h.action === 'submit' || h.action === 'block');
  expect(refused).toHaveLength(0);
  for (const pending of journal.rows()) { pending.nextRetry = 0; journal.save(pending); }
  await pool.retryExecutions();
  expect(journal.read(inst.id, proof.deliveryId)?.state).toBe('superseded');
  expect((await core.history(owner, task.id)).filter(h => h.action === 'submit' || h.action === 'block')).toHaveLength(0);
});

run('模板迁移可重复执行，保留老板修改的正文与已发送记录', async () => {
  const { readFileSync } = await import('node:fs');
  const { OutboundMessageStore } = await import('../src/outbound-messages.ts');
  const { RecordId } = await import('surrealdb');
  const migration = readFileSync(join(import.meta.dir, '../schema/064-runner-lifecycle.surql'), 'utf8');
  const old = '先读 notes.md。按 task.md 完成当前步骤，记录可验证证据；有前置缺口请报告阻塞。 使用派工消息中的 sck 命令记录 checkpoint / submit。不要创建后继任务，由迭代流程统一推进。提交后结束本轮。';
  const store = new OutboundMessageStore(db.db);
  const one = await store.createDraft('fixture-template', 'execute', 'product', false, 'doing', old);
  const edited = await store.createDraft('fixture-template', 'execute', 'product', false, 'doing', old + '老板补充：只读核对。');
  const sent = await store.createDraft('fixture-template', 'execute', 'product', false, 'doing', old);
  await db.db.query('UPDATE $id SET state="sent";', { id: new RecordId('outbound_message', sent.id) });
  await db.db.query(migration); await db.db.query(migration);
  expect((await store.get(one.id))?.body).not.toContain('checkpoint / submit');
  expect((await store.get(edited.id))?.body).toBe(old + '老板补充：只读核对。');
  expect((await store.get(sent.id))?.body).toBe(old);
});

run('完整迁移保存当前 schema 回执，重复迁移不降级', async () => {
  await db.applySchema(false);
  const [rows] = await db.db.query('SELECT schema_version FROM company_meta:installation;');
  expect((rows as Array<{schema_version:number}>)[0]?.schema_version).toBe(CLOUD_SCHEMA_VERSION);
});

run('真实 fork：提交已落库但回复丢失，同一幂等键重放结算且核心只记一次提交', async () => {
  const task = await core.createTask(owner, { type: 'lifecycle-fixture', title: '落库后回复丢失', context: '验证重放恢复', idempotencyKey: crypto.randomUUID() } as never);
  await wf.upsertDef('fixture-lost', { role: 'engineering', provider: 'claude', model: 'fixture' });
  const def = (await wf.defs()).find(d => d.id === 'fixture-lost')!;
  const inst = await wf.spawnInst(def);
  let thrown = false;
  const losing = Object.create(core) as SurrealCompanyCore;
  // The write commits; only the reply is lost. The retry must reach the stored transition, not a fresh write.
  losing.submit = async (cred, proof, evidence) => {
    const view = await core.submit(cred, proof, evidence);
    if (!thrown) { thrown = true; throw new Error('synthetic reply lost after commit'); }
    return view;
  };
  const runDir = join(dir, 'lost', 'comm');
  const pool = new SidecarPool({ runDir, core: losing, workforce: wf, managedLifecycle: true, resultFacts });
  pools.push(pool);
  pool.env(inst); inst.paseoAgentId = 'lost'; pool.bindAgent(inst.id, 'lost');
  const claim = await pool.claim(inst, { id: task.id } as never);
  const proof = { taskId: task.id, deliveryId: claim!.deliveryId!, fence: claim!.fence, expectedVersion: claim!.task.version };
  await pool.turnStarted('lost', 'lost-turn');
  const result = await pool.settleExecution({ agent: { id: 'lost' }, turnId: 'lost-turn', outcome: { kind: 'completed' },
    timeline: [{ type: 'assistant_message', text: '工作结果：完成\n已核对任务目标与验收要求，输出可核验的结果。' }] });
  expect(result?.status).toBe('ingested');
  const journal = journalFor(runDir);
  const row = journal.read(inst.id, proof.deliveryId)!;
  expect(row.state).toBe('settled');
  expect(row.supersededCause).toBeUndefined();
  expect((await core.getTask(owner, task.id)).state).toBe('review');
  expect((await core.history(owner, task.id)).filter(h => h.action === 'submit')).toHaveLength(1);
  for (const pending of journal.rows()) { pending.nextRetry = 0; journal.save(pending); }
  await pool.retryExecutions();
  expect((await core.history(owner, task.id)).filter(h => h.action === 'submit')).toHaveLength(1);
});

run('真实 fork：验收通过已落库但回复丢失，重放后结算为 done 且核心只记一次验收', async () => {
  const task = await core.createTask(owner, { type: 'lifecycle-fixture', title: '验收落库后回复丢失', context: '验证重放恢复', idempotencyKey: crypto.randomUUID() } as never);
  for (const [role, defId] of [['engineering', 'fixture-eng-lost'], ['qa', 'fixture-qa-lost']] as const) {
    await wf.upsertDef(defId, { role, provider: 'claude', model: 'fixture' });
  }
  const engDef = (await wf.defs()).find(d => d.id === 'fixture-eng-lost')!;
  const qaDef = (await wf.defs()).find(d => d.id === 'fixture-qa-lost')!;
  const eng = await wf.spawnInst(engDef);
  const engDir = join(dir, 'eng-lost', 'comm');
  const engPool = new SidecarPool({ runDir: engDir, core, workforce: wf, managedLifecycle: true, resultFacts });
  pools.push(engPool);
  engPool.env(eng); eng.paseoAgentId = 'eng-lost'; engPool.bindAgent(eng.id, 'eng-lost');
  await engPool.claim(eng, { id: task.id } as never);
  await engPool.turnStarted('eng-lost', 'eng-turn');
  const submitted = await engPool.settleExecution({ agent: { id: 'eng-lost' }, turnId: 'eng-turn', outcome: { kind: 'completed' },
    timeline: [{ type: 'assistant_message', text: '工作结果：完成\n实施与验证均已完成，证据齐全。' }] });
  expect(submitted?.status).toBe('ingested');
  expect((await core.getTask(owner, task.id)).state).toBe('review');
  const qa = await wf.spawnInst(qaDef);
  let thrown = false;
  const losing = Object.create(core) as SurrealCompanyCore;
  losing.accept = async (cred, proof, evidence) => {
    const view = await core.accept(cred, proof, evidence);
    if (!thrown) { thrown = true; throw new Error('synthetic reply lost after commit'); }
    return view;
  };
  const qaDir = join(dir, 'qa-lost', 'comm');
  const qaPool = new SidecarPool({ runDir: qaDir, core: losing, workforce: wf, managedLifecycle: true, resultFacts });
  pools.push(qaPool);
  qaPool.env(qa); qa.paseoAgentId = 'qa-lost'; qaPool.bindAgent(qa.id, 'qa-lost');
  const claim = await qaPool.claim(qa, { id: task.id } as never);
  const proof = { taskId: task.id, deliveryId: claim!.deliveryId!, fence: claim!.fence, expectedVersion: claim!.task.version };
  await qaPool.turnStarted('qa-lost', 'qa-turn');
  const accepted = await qaPool.settleExecution({ agent: { id: 'qa-lost' }, turnId: 'qa-turn', outcome: { kind: 'completed' },
    timeline: [{ type: 'assistant_message', text: '复核结论：通过\n已独立核对执行证据与结果，全部符合验收要求。' }] });
  expect(accepted?.status).toBe('ingested');
  const journal = journalFor(qaDir);
  expect(journal.read(qa.id, proof.deliveryId)?.state).toBe('settled');
  expect((await core.getTask(owner, task.id)).state).toBe('done');
  const history = await core.history(owner, task.id);
  expect(history.filter(h => h.action === 'submit')).toHaveLength(1);
  expect(history.filter(h => h.action === 'accept')).toHaveLength(1);
});

run('真实 fork：成果落库、回复连续丢失且写入被拒后，权威幂等记录确认已交付并结算', async () => {
  const task = await core.createTask(owner, { type: 'lifecycle-fixture', title: '落库后身份失效', context: '验证幂等事实判定', idempotencyKey: crypto.randomUUID() } as never);
  await wf.upsertDef('fixture-gone', { role: 'engineering', provider: 'claude', model: 'fixture' });
  const def = (await wf.defs()).find(d => d.id === 'fixture-gone')!;
  const inst = await wf.spawnInst(def);
  let calls = 0;
  const losing = Object.create(core) as SurrealCompanyCore;
  // First call commits and loses the reply; every later call is refused at the lease level. The runner must
  // still learn from the stored idempotency record that the result was delivered instead of superseding it.
  losing.submit = async (cred, proof, evidence) => {
    calls++;
    if (calls === 1) { await core.submit(cred, proof, evidence); throw new Error('synthetic reply lost after commit'); }
    throw Object.assign(new Error('stale lease or version'), { code: 'conflict' });
  };
  const runDir = join(dir, 'gone', 'comm');
  const pool = new SidecarPool({ runDir, core: losing, workforce: wf, managedLifecycle: true, resultFacts });
  pools.push(pool);
  pool.env(inst); inst.paseoAgentId = 'gone'; pool.bindAgent(inst.id, 'gone');
  const claim = await pool.claim(inst, { id: task.id } as never);
  const proof = { taskId: task.id, deliveryId: claim!.deliveryId!, fence: claim!.fence, expectedVersion: claim!.task.version };
  await pool.turnStarted('gone', 'gone-turn');
  const result = await pool.settleExecution({ agent: { id: 'gone' }, turnId: 'gone-turn', outcome: { kind: 'completed' },
    timeline: [{ type: 'assistant_message', text: '工作结果：完成\n成果已交付服务端，回复在传输中丢失。' }] });
  expect(result?.status).toBe('ingested');
  const journal = journalFor(runDir);
  const row = journal.read(inst.id, proof.deliveryId)!;
  expect(row.state).toBe('settled');
  expect(row.supersededCause).toBeUndefined();
  expect((await core.getTask(owner, task.id)).state).toBe('review');
  // The employee is retired after the landing: no further write may be attempted for the delivered result.
  await wf.retire(inst.id, 'fixture：落库后退休', 'rotation');
  for (const pending of journal.rows()) { pending.nextRetry = 0; journal.save(pending); }
  await pool.retryExecutions();
  expect(journal.read(inst.id, proof.deliveryId)?.state).toBe('settled');
  expect(calls).toBe(2);
  expect((await core.history(owner, task.id)).filter(h => h.action === 'submit')).toHaveLength(1);
});

run('真实 fork：成果落库、员工退休且判定时幂等读取瞬时失败，先 pending 后 settled 且核心只记一次提交', async () => {
  const task = await core.createTask(owner, { type: 'lifecycle-fixture', title: '判定时读取失败', context: '验证读取失败不误判失效', idempotencyKey: crypto.randomUUID() } as never);
  await wf.upsertDef('fixture-readfail', { role: 'engineering', provider: 'claude', model: 'fixture' });
  const def = (await wf.defs()).find(d => d.id === 'fixture-readfail')!;
  const inst = await wf.spawnInst(def);
  let calls = 0;
  const losing = Object.create(core) as SurrealCompanyCore;
  // The write commits, the identity is retired while its reply is in flight, and every later call is refused at
  // authentication. The stored idempotency record is the only fact that can prove the delivery landed.
  losing.submit = async (cred, proof, evidence) => {
    calls++;
    if (calls === 1) {
      const view = await core.submit(cred, proof, evidence);
      await wf.retire(inst.id, 'fixture：落库后退休', 'rotation');
      throw new Error('synthetic reply lost after commit');
    }
    return core.submit(cred, proof, evidence);
  };
  const runDir = join(dir, 'readfail', 'comm');
  const pool = new SidecarPool({ runDir, core: losing, workforce: wf, managedLifecycle: true, resultFacts });
  pools.push(pool);
  pool.env(inst); inst.paseoAgentId = 'readfail'; pool.bindAgent(inst.id, 'readfail');
  const claim = await pool.claim(inst, { id: task.id } as never);
  const proof = { taskId: task.id, deliveryId: claim!.deliveryId!, fence: claim!.fence, expectedVersion: claim!.task.version };
  await pool.turnStarted('readfail', 'readfail-turn');
  failIdempotencyReads = 1;
  const result = await pool.settleExecution({ agent: { id: 'readfail' }, turnId: 'readfail-turn', outcome: { kind: 'completed' },
    timeline: [{ type: 'assistant_message', text: '工作结果：完成\n成果已交付服务端，回复与幂等读取同时抖动。' }] });
  expect(result?.status).toBe('pending');
  const journal = journalFor(runDir);
  const row = journal.read(inst.id, proof.deliveryId)!;
  // A failed read is unknown, never "not landed": the delivered result waits instead of being superseded.
  expect(row.state).toBe('pending');
  expect(row.supersededCause).toBeUndefined();
  for (const pending of journal.rows()) { pending.nextRetry = 0; journal.save(pending); }
  await pool.retryExecutions();
  expect(journal.read(inst.id, proof.deliveryId)?.state).toBe('settled');
  expect((await core.getTask(owner, task.id)).state).toBe('review');
  expect((await core.history(owner, task.id)).filter(h => h.action === 'submit')).toHaveLength(1);
  for (const pending of journal.rows()) { pending.nextRetry = 0; journal.save(pending); }
  await pool.retryExecutions();
  expect((await core.history(owner, task.id)).filter(h => h.action === 'submit')).toHaveLength(1);
});
