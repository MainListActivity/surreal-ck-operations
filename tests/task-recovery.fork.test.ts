import { faultNeedsNotice } from '../src/task-recovery.ts';
import { RecordId } from 'surrealdb';
import { Workforce } from '../src/workforce.ts';
import { faultBelongsToWait, parseExecutionWindow, windowExpired } from '../src/task-recovery.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { DEFAULT_CONFIG } from '../src/workforce.ts';
import { Dispatcher, type TickReport } from '../src/dispatcher/dispatcher.ts';
import type { LeaseProof, TaskView } from '../src/contracts.ts';

setDefaultTimeout(60000);
// Isolated company fork on a private RocksDB store: no production data, credentials or dispatcher.
const run = process.env.RUN_SCK_LOOP_BREAKER_TESTS === '1' ? test : test.skip;
let dir: string, server: ReturnType<typeof Bun.spawn>, db: CompanyDatabase, core: SurrealCompanyCore, owner: OwnerDesk, gm: string, eng: string, count = 0;

beforeAll(async () => {
  if (process.env.RUN_SCK_LOOP_BREAKER_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-loop-breaker-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', 'fixture-only', '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: 'fixture-only', namespace: 'loop_breaker_fixture', database: 'control_plane' });
  await db.connect(); await db.bootstrap();
  core = new SurrealCompanyCore(db); owner = new OwnerDesk(db);
  const admin = new LocalEnrollmentAdmin(db);
  gm = await admin.enroll('loop-gm', 'gm', ['execute', 'review', 'manage']);
  eng = await admin.enroll('loop-eng', 'engineering', ['execute', 'review']);
});
afterAll(async () => { if (!dir) return; await db.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); });

const text = (what: string) => ({ text: `${what} — long enough to satisfy the evidence validation`, idempotencyKey: `loop-ev-${++count}-${crypto.randomUUID()}` });
const proofOf = (c: { task: TaskView; deliveryId: string; fence: number }): LeaseProof => ({ taskId: c.task.id, deliveryId: c.deliveryId, fence: c.fence, expectedVersion: c.task.version });
const newTask = () => core.createTask(gm, { title: `Looping task ${++count}`, context: 'fixture', executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `loop-task-${++count}-${crypto.randomUUID()}` } as never);
/** One round trip: the employee blocks on the manager. The manager resumes it unless this is the last round. */
async function bounce(taskId: string, round: number, resume: boolean) {
  const claim = await core.claim(eng, taskId);
  await core.block(eng, proofOf(claim), 'gm', text(`第 ${round} 次阻塞：WS 连接 1006 无事件`));
  if (resume) await core.resume(gm, taskId, text(`经理第 ${round} 次回复`));
}
const breaker = () => new Dispatcher({ workforce: {} as never, owner, paseo: {} as never, env: {} as never, log: () => {} }) as unknown as
  { breakLoop(task: { id: string; version: number }, cfg: typeof DEFAULT_CONFIG, report: TickReport): Promise<boolean> };
const report = () => ({ decisions: [] as string[] } as TickReport);


run('dependency completion returns a manager continuation without dispatching execution', async () => {
  const source = await newTask(), dep = await newTask();
  await bounce(source.id, 1, false);
  const waiting = await core.deferTaskUntil(gm, { taskId: source.id, dependencies: [dep.id], continuation: 'manager', ...text('修复完成后经理必须安排新窗口与独立批准') });
  expect(waiting.state).toBe('blocked'); expect(waiting.blockedTo).toBeUndefined();
  const claim = await core.claim(eng, dep.id);
  const submitted = await core.submit(eng, proofOf(claim), text('dependency implementation complete'));
  const qa = await new LocalEnrollmentAdmin(db).enroll('recovery-qa', 'qa', ['execute', 'review']);
  const review = await core.claim(qa, dep.id);
  await core.accept(qa, proofOf(review), text('independently verified dependency complete'));
  const resumed = await core.getTask(gm, source.id);
  expect(resumed).toMatchObject({ state: 'blocked', blockedTo: 'gm', resumeState: 'doing' });
  expect(resumed.dependencyContinuation).toBeUndefined();
  expect(await core.claim(eng, source.id).catch(e => e.code)).toBe('conflict');
  await core.resume(gm, source.id, text('经理已经安排并落实全部所需前置，恢复执行'));
  expect((await core.getTask(gm, source.id)).state).toBe('ready');
});

run('already complete dependencies still require the explicitly requested manager continuation', async () => {
  const source = await newTask(), dep = await newTask();
  await db.db.query("UPDATE $task SET state='done';", { task: new RecordId('task', dep.id) });
  await bounce(source.id, 1, false);
  const result = await core.deferTaskUntil(gm, { taskId: source.id, dependencies: [dep.id], continuation: 'manager', ...text('所有依赖虽完成，但还需要经理补齐新窗口') });
  expect(result).toMatchObject({ state: 'blocked', blockedTo: 'gm', resumeState: 'doing' });
});

run('expired and altered windows are refused; queue expiry becomes one manager wait', async () => {
  const source = await newTask(), approval = await newTask();
  const expiry = new Date(Date.now() + 4 * 3600_000).toISOString();
  const window = { approvalTask: approval.id, configurationDigest: 'a'.repeat(64), evidenceExpiresAt: expiry,
    minRemainingSeconds: 5400, notAfter: new Date(Date.now() + 3600_000).toISOString() };
  await db.db.query("UPDATE $dep SET state='done'; UPDATE $task SET dependencies=[$dep]; CREATE internal_ai_candidate CONTENT {task:$dep, digest:$digest, manifest_hash:$digest, document_hash:$digest, manifest_path:'fixture', document_path:'fixture', author:'fixture', env:'production', evidence_expires_at:$expiry};",
    { task: new RecordId('task', source.id), dep: new RecordId('task', approval.id), digest: window.configurationDigest, expiry });
  await bounce(source.id, 1, false);
  expect(await core.resume(gm, source.id, { ...text('拒绝一个已经过期的执行窗口'), executionWindow: { ...window, notAfter: new Date(Date.now()-1000).toISOString() } }).catch(e => e.code)).toBe('invalid');
  expect(await core.resume(gm, source.id, { ...text('拒绝篡改已批准证据有效期的窗口'), executionWindow: { ...window, evidenceExpiresAt: new Date(Date.now()+8*3600_000).toISOString() } }).catch(e => e.code)).toBe('invalid');
  await core.resume(gm, source.id, { ...text('批准件与摘要正确，绑定足够时长的执行窗口'), executionWindow: window });
  expect((await core.getTask(gm, source.id)).executionWindow).toEqual(window);
  await db.db.query('UPDATE $task SET execution_window.notAfter=$past;', { task: new RecordId('task', source.id), past: new Date(Date.now()-1000).toISOString() });
  expect(await core.claim(eng, source.id).catch(e => e.code)).toBe('invalid');
  const blocked = await core.getTask(gm, source.id);
  expect(blocked).toMatchObject({ state:'blocked', blockedTo:'gm', resumeState:'ready' });
  expect(await core.resume(gm, source.id, text('不能通过普通恢复操作续期旧批准')).catch(e => e.code)).toBe('invalid');
  const [audit] = await db.db.query<[Array<{recovery_reason:string}>]>("SELECT recovery_reason FROM audit WHERE task=$task AND action='block';",{task:new RecordId('task',source.id)});
  expect(audit.filter(a=>a.recovery_reason==='stale_window')).toHaveLength(1);
});

run('old fault notices do not hide a new post-dependency manager stage; same-stage dedup remains', async () => {
  const t = await newTask();
  await db.db.query(`CREATE $episode_row CONTENT {episode:$episode,fingerprint:'fixture',incident:'fixture',phase:'request',task:$task,state:'stopped',notified:true,evidence_revision:1,opened_at:d'2026-01-01T00:00:00Z',updated_at:d'2026-01-01T00:00:00Z'};
    CREATE audit CONTENT {task:$task,action:'dependency_unlocked',at:d'2026-01-02T00:00:00Z'};`,
    {task:new RecordId('task',t.id),episode:'same-cause#'+t.id,episode_row:new RecordId('fault_episode','same-cause#'+t.id)});
  const facts = await new Workforce(db, dir).faultEpisodes({tasks:[t.id]});
  const episode = facts!.byTask.get(t.id)![0]!;
  expect(faultBelongsToWait(episode.updatedAt,facts!.blockedAt?.get(t.id))).toBe(false);
  await db.db.query("UPDATE fault_episode SET updated_at=d'2026-01-03T00:00:00Z' WHERE task=$task;",{task:new RecordId('task',t.id)});
  const fresh=await new Workforce(db, dir).faultEpisodes({tasks:[t.id]});
  expect(faultBelongsToWait(fresh!.byTask.get(t.id)![0]!.updatedAt,fresh!.blockedAt?.get(t.id))).toBe(true);
  expect(fresh!.byTask.get(t.id)![0]!.notified).toBe(true);
  expect(faultNeedsNotice(fresh!.byTask.get(t.id)![0]!, fresh!.blockedAt?.get(t.id))).toBe(true);
  expect(await new Workforce(db,dir).markFaultEpisodeNotified(episode.episode, fresh!.blockedAt?.get(t.id))).toBe(true);
  const notified=await new Workforce(db,dir).faultEpisodes({tasks:[t.id]});
  expect(faultNeedsNotice(notified!.byTask.get(t.id)![0]!,notified!.blockedAt?.get(t.id))).toBe(false);
  expect(await new Workforce(db,dir).markFaultEpisodeNotified(episode.episode, fresh!.blockedAt?.get(t.id))).toBe(false);
  const nextStage=Date.parse('2026-01-04T00:00:00Z');
  // Even when an S1 notification lands after wall clock has passed S2, it only acknowledges S1.
  expect(faultNeedsNotice(notified!.byTask.get(t.id)![0]!,nextStage)).toBe(true);
  expect(await new Workforce(db,dir).markFaultEpisodeNotified(episode.episode,nextStage)).toBe(true);
  expect(await new Workforce(db,dir).markFaultEpisodeNotified(episode.episode,fresh!.blockedAt?.get(t.id))).toBe(false);
  const nextNotified=await new Workforce(db,dir).faultEpisodes({tasks:[t.id]});
  expect(faultNeedsNotice(nextNotified!.byTask.get(t.id)![0]!,nextStage)).toBe(false);

});

run('classified loops get one owned recovery task and a second exhausted cycle stops automatically', async () => {
  const t=await newTask();
  for(let n=0;n<2;n++) {
    const c=await core.claim(eng,t.id);
    await core.block(eng,proofOf(c),'gm',{...text('缺少新窗口和独立批准，需要经理补齐依赖'),recoveryReason:'missing_prerequisite'});
    if(n===0) await core.resume(gm,t.id,text('经理第一次恢复，不代表业务成功'));
  }
  expect(await breaker().breakLoop(await core.getTask(gm,t.id),{...DEFAULT_CONFIG,blockLoopLimit:2},report())).toBe(true);
  const source=await core.getTask(gm,t.id);
  expect(source.state).toBe('blocked');expect(source.blockedTo).toBeUndefined();
  const [recoveries]=await db.db.query<[Array<{id:RecordId;executor_role:string;reviewer_role:string}>]>('SELECT id,executor_role,reviewer_role FROM task WHERE recovery_source=$task;',{task:new RecordId('task',t.id)});
  expect(recoveries).toHaveLength(1);expect(recoveries[0]!.executor_role).toBe('gm');expect(recoveries[0]!.reviewer_role).toBe('product');
  expect(source.dependencies).toContain(String(recoveries[0]!.id.id));
  // Real independent review of the recovery handoff still returns the source to the manager.
  const recoveryId=String(recoveries[0]!.id.id);
  const recoveryClaim=await core.claim(gm,recoveryId);
  await core.submit(gm,proofOf(recoveryClaim),text('恢复安排已落实；新采样与独立批准仍需按源任务执行'));
  const product=await new LocalEnrollmentAdmin(db).enroll('recovery-product','product',['execute','review']);
  const recoveryReview=await core.claim(product,recoveryId);
  await core.accept(product,proofOf(recoveryReview),text('独立复核恢复安排完成，不代表源业务验收通过'));
  expect((await core.getTask(gm,t.id)).blockedTo).toBe('gm');
  expect(await owner.escalateLooping(await core.getTask(gm,t.id),2,['仍缺少前置'])).toBe(true);
  const [stopped]=await db.db.query<[Array<{recovery_stopped:boolean}>]>('SELECT recovery_stopped FROM $task;',{task:new RecordId('task',t.id)});
  expect(stopped[0]!.recovery_stopped).toBe(true);
  expect((await core.getTask(gm,t.id)).blockedTo).toBe('gm');
  expect(await core.resume(gm,t.id,text('普通恢复不能绕过第二轮自动停止')).catch(e=>e.code)).toBe('invalid');
});

run('an expired execute window cannot mutate a foreign workspace or block same-role independent review', async()=>{
  const t=await newTask();
  const foreign=await new LocalEnrollmentAdmin(db).enroll('foreign-eng','engineering',['execute','review']);
  await db.db.query("UPDATE $employee SET workspace_scope='foreign-goal'; UPDATE $task SET execution_window={notAfter:$past};",
    {employee:new RecordId('employee','foreign-eng'),task:new RecordId('task',t.id),past:new Date(Date.now()-1000).toISOString()});
  const before=await core.getTask(gm,t.id);
  expect(await core.claim(foreign,t.id).catch(e=>e.code)).toBe('forbidden');
  expect((await core.getTask(gm,t.id)).version).toBe(before.version);
  expect((await core.getTask(gm,t.id)).state).toBe('ready');
  // Execute already complete: only the ordinary independence and review lease checks apply.
  const qa=await new LocalEnrollmentAdmin(db).enroll('same-role-reviewer','engineering',['execute','review']);
  await db.db.query("UPDATE $task SET state='review', reviewer_role='engineering', submitted_by='other-author';",{task:new RecordId('task',t.id)});
  const review=await core.claim(qa,t.id);
  expect(review.task.state).toBe('review');
});

run('adding completed prerequisites does not reset a stopped recovery while an older dependency waits',async()=>{
  const source=await newTask(),oldDep=await newTask(),finished=await newTask(),newDep=await newTask();
  await db.db.query("UPDATE $task SET state='blocked',blocked_to='gm',resume_state='doing',dependencies=[$old],recovery_stopped=true; UPDATE $finished SET state='done';",
    {task:new RecordId('task',source.id),old:new RecordId('task',oldDep.id),finished:new RecordId('task',finished.id)});
  expect(await core.deferTaskUntil(gm,{taskId:source.id,dependencies:[finished.id],continuation:'execute',...text('已完成依赖不能解除停止并直接派工')}).catch(e=>e.code)).toBe('conflict');
  await core.deferTaskUntil(gm,{taskId:source.id,dependencies:[finished.id],continuation:'manager',...text('新增一个已完成依赖不能伪装实际恢复进展')});
  const [still]=await db.db.query<[Array<{recovery_stopped:boolean}>]>('SELECT recovery_stopped FROM $task;',{task:new RecordId('task',source.id)});
  expect(still[0]!.recovery_stopped).toBe(true);
  await db.db.query("UPDATE $task SET blocked_to='gm';",{task:new RecordId('task',source.id)});
  await core.deferTaskUntil(gm,{taskId:source.id,dependencies:[newDep.id],continuation:'manager',...text('新增真实尚未完成的前置才进入新恢复阶段')});
  const [after]=await db.db.query<[Array<{recovery_stopped?:boolean}>]>('SELECT recovery_stopped FROM $task;',{task:new RecordId('task',source.id)});
  expect(after[0]!.recovery_stopped).not.toBe(true);
});
