import {expect,test} from 'bun:test';
import {RecordId} from 'surrealdb';
import {CompanyDatabase} from '../src/database.ts';
import {loadDatabaseConfig} from '../src/config.ts';
import {Workforce} from '../src/workforce.ts';
import {LocalEnrollmentAdmin} from '../src/enrollment.ts';
import {SurrealCompanyCore} from '../src/core.ts';
const run=process.env.RUN_SCK_CHANNEL_FORK_TESTS==='1'?test:test.skip;
run('runtime sleep reservation fences claims and manager wakes while preserving identity, bindings and credentials',async()=>{
 const db=new CompanyDatabase({...loadDatabaseConfig(),namespace:'memory_lru_fixture',database:'control_plane'});
 try{
  await db.connect();await db.bootstrap();const wf=new Workforce(db),core=new SurrealCompanyCore(db),enroll=new LocalEnrollmentAdmin(db);
  const gm=await enroll.enroll('manager','owner',['manage','execute','review']),worker=await enroll.enroll('worker','qa',['execute','review']);
  const now=await wf.serverNow();
  await db.db.query('UPDATE employee:worker SET paseo_agent_id="agent-worker", idle_since=$since,last_wake_at=$wake;',{since:now-7200,wake:now-7300});
  const find=async()=>(await wf.insts()).find(i=>i.id==='worker')!;
  const task=await core.createTask(gm,{title:'memory LRU integration',context:'read only fixture',executorRole:'qa',reviewerRole:'owner',idempotencyKey:'lru-task'});
  const before=(await db.db.select<any>(new RecordId('employee','worker')))!;
  expect(await wf.reserveRuntimeSleep(await find(),now)).toBe(true);
  expect(await wf.confirmRuntimeSleep(await find(),now)).toBe(true);
  await expect(core.claim(worker,task.id)).rejects.toThrow('suspending');
  const wake=await wf.acquirePendingWake({taskId:task.id,phase:'execute',episode:1,version:1,repo:'/tmp',reason:'fixture'});
  expect(wake).toBeDefined();expect(await wf.markPendingWakeRunning(wake!,'worker','agent-worker')).toBe(false);
  await wf.releaseRuntimeSleep('worker',now);
  expect(await wf.confirmRuntimeSleep(await find(),now)).toBe(false);
  const claim=await core.claim(worker,task.id);expect(claim.task.id).toBe(task.id);
  const after=(await db.db.select<any>(new RecordId('employee','worker')))!;
  expect(after.credential_digest).toBe(before.credential_digest);expect(after.paseo_agent_id).toBe(before.paseo_agent_id);expect(after.revoked).toBe(before.revoked);expect(after.retired).toBe(before.retired);
  expect(await wf.reserveRuntimeSleep(await find(),now)).toBe(false);
 }finally{await db.close()}
});
run('stale idle snapshots and active task ownership cannot reserve sleep; idle CAS survives activity events',async()=>{
 const db=new CompanyDatabase({...loadDatabaseConfig(),namespace:'memory_lru_races',database:'control_plane'});
 try{
  await db.connect();await db.bootstrap();const wf=new Workforce(db),now=await wf.serverNow();
  await db.db.query('CREATE employee:worker CONTENT {role:"engineering",paseo_agent_id:"agent-worker",idle_since:$since,last_wake_at:1,revoked:false,retired:false};',{since:now-7200});
  const old=(await wf.insts())[0];await wf.clearIdleForAgent('agent-worker');
  await wf.observeSessionIdle([{id:'worker',since:old.idleSince,lastWakeAt:old.lastWakeAt,previousIdleSince:old.idleSince}]);
  expect((await wf.insts())[0].idleSince).toBeUndefined();expect(await wf.reserveRuntimeSleep(old,now)).toBe(false);
  await db.db.query('UPDATE employee:worker SET idle_since=$since; CREATE task:held CONTENT {state:"doing",current_employee:"worker"};',{since:old.idleSince});
  expect(await wf.reserveRuntimeSleep(old,now)).toBe(false);
 }finally{await db.close()}
});
