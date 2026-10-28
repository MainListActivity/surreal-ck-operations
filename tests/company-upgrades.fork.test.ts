import {beforeAll,afterAll,expect,test,setDefaultTimeout} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {RecordId} from 'surrealdb';
import {CompanyDatabase} from '../src/database.ts';
import {OwnerDesk} from '../src/owner.ts';
import {SurrealCompanyCore} from '../src/core.ts';
import {LocalEnrollmentAdmin} from '../src/enrollment.ts';
import {Workforce} from '../src/workforce.ts';
import {Dispatcher} from '../src/dispatcher/dispatcher.ts';
import {CompanyUpgrades} from '../src/company-upgrades.ts';
import {runCompanyUpgrade,type UpgradeCommand} from '../src/company-upgrade-runner.ts';
import {readCompanyRelease,compareRelease,releaseNotesSchema} from '../src/company-release.ts';
setDefaultTimeout(60_000);
const run=process.env.RUN_SCK_UPGRADE_FORK_TESTS==='1'?test:test.skip;
let dir:string,repo:string,home:string,oldSha:string,newSha:string,db:CompanyDatabase,core:SurrealCompanyCore,owner:OwnerDesk,eng:string,server:ReturnType<typeof Bun.spawn>,count=0,launches=0;
let service:CompanyUpgrades;
const note=(text='公司系统升级交付说明与验证证据已准备完成，等待老板确认执行')=>({text,idempotencyKey:`upgrade-${++count}-${crypto.randomUUID()}`});
const git=(args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
const notes={version:'0.2.0',title:'收件箱升级',changes:['更新任务派工与上线入口'],impact:['切换期间短暂停止新派工'],migration:'只新增作业记录',rollback:'恢复旧发布'};
beforeAll(async()=>{
 if(process.env.RUN_SCK_UPGRADE_FORK_TESTS!=='1')return;
 dir=realpathSync(mkdtempSync(join(tmpdir(),'sck-company-upgrade-')));repo=join(dir,'repo');home=join(dir,'service');mkdirSync(repo);mkdirSync(join(home,'releases'),{recursive:true});
 git(['init','-b','main']);writeFileSync(join(repo,'package.json'),'{"version":"0.1.0"}');git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@invalid','commit','-m','old']);oldSha=git(['rev-parse','HEAD']);
 writeFileSync(join(repo,'package.json'),'{"version":"0.2.0"}');writeFileSync(join(repo,'company-release.json'),JSON.stringify(notes));git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@invalid','commit','-m','new']);newSha=git(['rev-parse','HEAD']);git(['remote','add','origin',repo]);git(['fetch','origin','main']);
 for(const [sha,version] of [[oldSha,'0.1.0'],[newSha,'0.2.0']]){mkdirSync(join(home,'releases',sha!),{recursive:true});writeFileSync(join(home,'releases',sha!,'package.json'),JSON.stringify({version}));}
 symlinkSync(join(home,'releases',oldSha),join(home,'active'));
 const listener=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('fixture')});const port=listener.port!;listener.stop(true);
 server=Bun.spawn([join(homedir(),'.surrealdb/surreal'),'start','--bind',`127.0.0.1:${port}`,'--user','root','--pass','isolated-fixture','--log','error',`rocksdb:${dir}/db`],{stdout:'ignore',stderr:'ignore'});
 for(let n=0;n<160;n++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await Bun.sleep(25);}
 db=new CompanyDatabase({url:`ws://127.0.0.1:${port}/rpc`,rootUser:'root',rootPassword:'isolated-fixture',namespace:'company_upgrade_fixture',database:'control_plane'});await db.connect();await db.bootstrap();owner=new OwnerDesk(db);core=new SurrealCompanyCore(db,{companyReleaseRepo:repo});eng=await new LocalEnrollmentAdmin(db).enroll('upgrade-engineer','engineering',['execute','review']);service=new CompanyUpgrades(db,owner,{home,repo,launch:()=>{launches++;}});
});
afterAll(async()=>{if(!dir)return;await db.close();server.kill();await server.exited;rmSync(dir,{recursive:true,force:true});});
async function task(){
 const taskId=crypto.randomUUID();await db.db.query("CREATE $task CONTENT {title:'公司系统上线',context:'fixture',kind:'deploy',executor_role:'engineering',reviewer_role:'qa',state:'ready',version:1,fence:0,dependencies:[],code_repo_path:$repo};",{task:new RecordId('task',taskId),repo});
 const c=await core.claim(eng,taskId);const t=await core.block(eng,{taskId,deliveryId:c.deliveryId,fence:c.fence,expectedVersion:c.task.version},'owner',{...note(),companyUpgrade:{sha:newSha}});return t;
}
run('release metadata and version ordering are stable and human-readable',async()=>{
 const p=await readCompanyRelease(repo,newSha);expect(p.version).toBe('0.2.0');expect(p.digest).toHaveLength(64);expect(p.changes).toEqual(notes.changes);expect(compareRelease('0.10.0','0.2.0')).toBeGreaterThan(0);expect(releaseNotesSchema.safeParse({...notes,changes:[]}).success).toBe(false);
});
run('lease-gated structured block renders an upgrade, duplicate clicks start only one job',async()=>{
 const t=await task();expect(t.companyUpgrade?.sha).toBe(newSha);
 const state=await service.state();expect(state.current.version).toBe('0.1.0');expect(state.items.find(i=>i.taskId===t.id)?.plan.changes).toEqual(notes.changes);
 const input={taskId:t.id,taskVersion:t.version,digest:t.companyUpgrade!.digest};
 const a=await service.start(input,'owner:test'),b=await service.start(input,'owner:test');expect(a.jobId).toBe(b.jobId);expect(launches).toBe(1);
});
run('actual runner validates before replying, keeps owner task on failure and restores the prior pause',async()=>{
 // First job from the preceding test is the single owner-authorized operation.
 const [rows]=await db.db.query<[Array<{id:RecordId}>]>('SELECT id FROM company_upgrade;');const id=String(rows[0]!.id.id);
 const calls:string[]=[];
 const command:UpgradeCommand=async(exe,args)=>{calls.push([exe,...args].join(' '));if(args[1]==='install'){rmSync(join(home,'active'));symlinkSync(args[2]!,join(home,'active'));}};
 await runCompanyUpgrade(service,id,{run:command,verify:async()=>{const j=await service.job(id);const t=await core.getTask(eng,String(j!.task.id));expect(t.blockedTo).toBe('owner');calls.push('verified');}});
 expect((await service.job(id))!.status).toBe('succeeded');expect(calls.some(x=>x.includes('sidecar-review'))).toBe(true);
 const [audit]=await db.db.query<[Array<{action:string;at:unknown}>]>("SELECT action,at FROM audit WHERE task=$task AND action IN ['company_upgrade_verified','owner_reply'] ORDER BY at;",{task:(await service.job(id))!.task});expect(audit.map(a=>a.action)).toEqual(['company_upgrade_verified','owner_reply']);
 // A separate click for a new task may acknowledge an already installed exact version, without re-installing it.
 const t=await task();const j=await service.start({taskId:t.id,taskVersion:t.version,digest:t.companyUpgrade!.digest},'owner:test');
 rmSync(join(home,'active'));symlinkSync(join(home,'releases',oldSha),join(home,'active'));
 await runCompanyUpgrade(service,j.jobId,{run:command,verify:async(_home,target)=>{if(target.endsWith(newSha))throw Error('unhealthy');expect(target.endsWith(oldSha)).toBe(true);}});
 expect((await service.job(j.jobId))!.status).toBe('failed');expect((await core.getTask(eng,t.id)).blockedTo).toBe('owner');
 const [cfg]=await db.db.query<[{paused:boolean}]>('SELECT paused FROM ONLY company_meta:config;');expect(cfg.paused).toBe(false);
});
run('task changes and unmerged SHA cannot authorize host installation',async()=>{
 const t=await task();expect(await service.start({taskId:t.id,taskVersion:t.version-1,digest:t.companyUpgrade!.digest},'owner:test').catch(e=>e.code)).toBe('conflict');
 expect(await readCompanyRelease(repo,'f'.repeat(40)).catch(e=>e.code)).toBe('invalid');
});
run('a manual pause during upgrade is preserved, and stale jobs can be retried without approving',async()=>{
 const t=await task();const j=await service.start({taskId:t.id,taskVersion:t.version,digest:t.companyUpgrade!.digest},'owner:test');
 await db.db.query("UPDATE $job SET updated_at=time::now()-2m;",{job:new RecordId('company_upgrade',j.jobId)});
 const state=await service.state();expect(state.items.find(x=>x.taskId===t.id)?.status).toBe('failed');
 expect((await core.getTask(eng,t.id)).blockedTo).toBe('owner');
 await owner.setPaused(false);
 const retry=await service.start({taskId:t.id,taskVersion:t.version,digest:t.companyUpgrade!.digest},'owner:test');
 await runCompanyUpgrade(service,retry.jobId,{run:async(_exe,args)=>{if(args[1]==='install'){rmSync(join(home,'active'));symlinkSync(args[2]!,join(home,'active'));await owner.setPaused(true);}},verify:async()=>{}});
 const [cfg]=await db.db.query<[{paused:boolean}]>('SELECT paused FROM ONLY company_meta:config;');expect(cfg.paused).toBe(true);
});

run('installation success does not override a task that changed during verification',async()=>{
 const t=await task();const j=await service.start({taskId:t.id,taskVersion:t.version,digest:t.companyUpgrade!.digest},'owner:test');
 await runCompanyUpgrade(service,j.jobId,{run:async()=>{},verify:async()=>{await db.db.query('UPDATE $task SET version+=1;',{task:new RecordId('task',t.id)});}});
 expect((await service.job(j.jobId))!.status).toBe('awaiting_reply');expect((await core.getTask(eng,t.id)).blockedTo).toBe('owner');
});

run('a retry after pausing keeps the original dispatch state and atomically records its recovery snapshot',async()=>{
 rmSync(join(home,'active'));symlinkSync(join(home,'releases',oldSha),join(home,'active'));
 await owner.setPaused(false);
 const t=await task(),input={taskId:t.id,taskVersion:t.version,digest:t.companyUpgrade!.digest};
 const first=await service.start(input,'owner:test');
 const [c]=await db.db.query<[{pause_version:number}]>('SELECT pause_version FROM ONLY company_meta:config;');
 await db.db.query("UPDATE company_meta:config SET paused=true,pause_version+=1; UPDATE $job SET status='failed',previous=$previous,paused_before=false,pause_version=$revision;",{job:new RecordId('company_upgrade',first.jobId),previous:join(home,'releases',oldSha),revision:c.pause_version+1});
 const retry=await service.start(input,'owner:test');
 await runCompanyUpgrade(service,retry.jobId,{run:async(_exe,args)=>{if(args[1]==='install'){const j=await service.job(retry.jobId);expect(j!.paused_before).toBe(false);expect(j!.previous).toBe(join(home,'releases',oldSha));rmSync(join(home,'active'));symlinkSync(args[2]!,join(home,'active'));}},verify:async()=>{}});
 expect((await service.job(retry.jobId))!.status).toBe('succeeded');
 const [cfg]=await db.db.query<[{paused:boolean}]>('SELECT paused FROM ONLY company_meta:config;');expect(cfg.paused).toBe(false);
});
run('a retry after switching rolls back to the durable previous version if target verification fails',async()=>{
 const t=await task(),input={taskId:t.id,taskVersion:t.version,digest:t.companyUpgrade!.digest};
 const first=await service.start(input,'owner:test');
 await db.db.query("UPDATE $job SET status='failed',previous=$previous,paused_before=false;",{job:new RecordId('company_upgrade',first.jobId),previous:join(home,'releases',oldSha)});
 const retry=await service.start(input,'owner:test');let restored=false;
 await runCompanyUpgrade(service,retry.jobId,{run:async(_exe,args)=>{if(args[1]==='install'){expect(args[2]).toBe(join(home,'releases',oldSha));rmSync(join(home,'active'));symlinkSync(args[2]!,join(home,'active'));restored=true;}},verify:async(_home,target)=>{if(target.endsWith(newSha))throw Error('target failed');}});
 expect(restored).toBe(true);expect((await service.job(retry.jobId))!.status).toBe('failed');expect((await core.getTask(eng,t.id)).blockedTo).toBe('owner');
});
run('an interrupted extraction never exposes a partial release and the next click can prepare it again',async()=>{
 rmSync(join(home,'releases',newSha),{recursive:true});
 const t=await task(),input={taskId:t.id,taskVersion:t.version,digest:t.companyUpgrade!.digest};
 const first=await service.start(input,'owner:test');
 await runCompanyUpgrade(service,first.jobId,{run:async(exe,args)=>{if(exe==='git')execFileSync(exe,args);if(exe==='tar')throw Error('interrupted extract');},verify:async()=>{}});
 expect(existsSync(join(home,'releases',newSha))).toBe(false);
 const retry=await service.start(input,'owner:test');
 await runCompanyUpgrade(service,retry.jobId,{run:async(exe,args)=>{if(exe==='git'||exe==='tar')execFileSync(exe,args);if(args[1]==='install'){rmSync(join(home,'active'));symlinkSync(args[2]!,join(home,'active'));}},verify:async()=>{}});
 expect((await service.job(retry.jobId))!.status).toBe('succeeded');expect(JSON.parse(await Bun.file(join(home,'releases',newSha,'company-release.json')).text()).version).toBe('0.2.0');
});
run('stale reaping cannot overwrite a worker that progressed after the inbox snapshot',async()=>{
 const t=await task(),j=await service.start({taskId:t.id,taskVersion:t.version,digest:t.companyUpgrade!.digest},'owner:test');
 await db.db.query('UPDATE $job SET updated_at=time::now()-2m;',{job:new RecordId('company_upgrade',j.jobId)});
 const original=db.db.query.bind(db.db);
 db.db.query=((sql:unknown,vars:unknown)=>{
  const result=original(sql as string,vars as never);
  if(String(sql).startsWith('SELECT * FROM company_upgrade ORDER'))return (async()=>{const rows=await result;await original("UPDATE $job SET status='checking',updated_at=time::now();",{job:new RecordId('company_upgrade',j.jobId)});return rows;})();
  return result;
 }) as typeof db.db.query;
 try{await service.state();}finally{db.db.query=original;}
 expect((await service.job(j.jobId))!.status).toBe('checking');
 await service.update(j.jobId,'failed','fixture cleanup');
});

run('company version actions bypass Jev routing and approval, including stale dispatcher snapshots',async()=>{
 const t=await task(),wf=new Workforce(db,join(dir,'credentials')),before=t.version;
 expect(await wf.rerouteToGm(t.id,before,'Jev proposes GM')).toBe(false);
 expect((await core.getTask(eng,t.id)).blockedTo).toBe('owner');
 await db.db.query("UPDATE $task SET state='review',reviewer_role='owner',acceptance_legacy=true;",{task:new RecordId('task',t.id)});
 expect(await wf.jevAccept(t.id,before,'Jev proposes automatic acceptance')).toBe(false);
 expect((await core.getTask(eng,t.id)).state).toBe('review');
 let calls=0;
 const dispatcher=new Dispatcher({workforce:{tasks:async()=>[{kind:'release',state:'review',version:before,row:{company_upgrade:t.companyUpgrade}},{kind:'deploy',state:'blocked',blockedTo:'owner',version:before,row:{company_upgrade:t.companyUpgrade}}],judgeInput:async()=>{calls++;throw Error('must not ask Jev');}},owner:{triagePending:async()=>[]},jev:{model:'fixture',ask:async()=>{calls++;throw Error('must not call Jev');}}} as never);
 await (dispatcher as any).jevDecisions({jevDecisions:true},{decisions:[],errors:[]});expect(calls).toBe(0);
});

/** A task parked on an owner handoff, exactly as SYS05 leaves it: blocked_to cleared, the condition in task_wait. */
async function handoffTask(){
 const taskId=crypto.randomUUID();
 await db.db.query("CREATE $task CONTENT {title:'公司系统上线交接',context:'fixture',kind:'deploy',executor_role:'engineering',reviewer_role:'qa',state:'ready',version:1,fence:0,dependencies:[],code_repo_path:$repo};",{task:new RecordId('task',taskId),repo});
 // One employee holds one active task at a time; each handoff gets its own engineer.
 const who=await new LocalEnrollmentAdmin(db).enroll(`handoff-engineer-${++count}`,  'engineering',['execute','review']);
 const c=await core.claim(who,taskId);
 // The real sequence: the engineer submits the merged release, gets it returned for the deployment leg, and then parks
 // the task on the owner handoff whose pendingAction is the owner's version click — the state 0029e642 is in.
 const submitted=await core.submit(who,{taskId,deliveryId:c.deliveryId,fence:c.fence,expectedVersion:c.task.version},
  {...note('公司系统已合入 main，等待老板点升级卡执行双面部署。'),companyUpgrade:{sha:newSha}});
 const reviewer=await new LocalEnrollmentAdmin(db).enroll(`handoff-qa-${count}`,'qa',['execute','review']);
 const rc=await core.claim(reviewer,taskId);
 const returned=await core.returnTask(reviewer,{taskId,deliveryId:rc.deliveryId,fence:rc.fence,expectedVersion:rc.task.version},
  note('交付未完成：部署腿须由老板点升级卡触发，先按交接等待退回实现人继续收口。'));
 // The returned task is ready again; the engineer takes it back before parking it on the owner handoff.
 const again=await core.claim(who,taskId);
 return core.wait(who,{taskId,deliveryId:again.deliveryId,fence:again.fence,expectedVersion:again.task.version},
  {text:'fixture: 公司 v0.2.0 已合入 main，部署须由老板点升级卡触发独立升级作业。',idempotencyKey:`handoff-${count}-${taskId}`},
  {kind:'owner_handoff',reason:'公司版本已合入 main，受控双面部署须由老板点击升级卡触发独立升级作业。',
   completed:['PR 已合入 origin/main'],pendingAction:'老板在收件箱点击「升级至 v0.2.0」',text:'fixture owner handoff'} as never);
}

run('an owner handoff task keeps its upgrade card reachable',async()=>{
 const t=await handoffTask();
 expect(t.state).toBe('blocked');expect(t.blockedTo).toBeUndefined();
 const [only]=await db.db.query<[{wait_kind:string;wait_owner_role:string}]>('SELECT wait_kind,wait_owner_role FROM ONLY $t;',{t:new RecordId('task',t.id)});
 expect(only.wait_kind).toBe('owner_handoff');expect(only.wait_owner_role).toBe('owner');
 const state=await service.state();
 const card=state.items.find(i=>i.taskId===t.id);
 expect(card?.plan.version).toBe('0.2.0');
 const j=await service.start({taskId:t.id,taskVersion:t.version,digest:card!.plan.digest},'owner:test');
 await runCompanyUpgrade(service,j.jobId,{run:async(_exe,args)=>{if(args[1]==='install'){rmSync(join(home,'active'));symlinkSync(args[2]!,join(home,'active'));}},verify:async()=>{}});
 expect((await service.job(j.jobId))!.status).toBe('succeeded');
 const [after]=await db.db.query<[{state:string;wait_kind?:string;blocked_to?:string}]>(
  'SELECT state,wait_kind,blocked_to FROM ONLY $t;',{t:new RecordId('task',t.id)});
 expect(after!.wait_kind).toBeUndefined();expect(after!.state).toBe('ready');
 const [waits]=await db.db.query<[Array<{state:string}>]>('SELECT state FROM task_wait WHERE task=$t;',{t:new RecordId('task',t.id)});
 expect(waits.every(w=>w.state==='released')).toBe(true);
});

run('installing a version closes the pending cards of every older version',async()=>{
 rmSync(join(home,'active'));symlinkSync(join(home,'releases',oldSha),join(home,'active'));
 const current=await handoffTask(),pending=await handoffTask();
 // The second card asks for a version older than the one being installed, so it is an obsoleted TODO.
 await db.db.query('UPDATE $t SET company_upgrade=$plan;',{t:new RecordId('task',pending.id),
  plan:{...(await readCompanyRelease(repo,newSha)),version:'0.1.5'}});
 const j=await service.start({taskId:current.id,taskVersion:current.version,digest:current.companyUpgrade!.digest},'owner:test');
 await runCompanyUpgrade(service,j.jobId,{run:async(_exe,args)=>{if(args[1]==='install'){rmSync(join(home,'active'));symlinkSync(args[2]!,join(home,'active'));}},verify:async()=>{}});
 expect((await service.job(j.jobId))!.status).toBe('succeeded');
 const [closed]=await db.db.query<[{state:string;wait_kind?:string}]>(
  'SELECT state,wait_kind FROM ONLY $t;',{t:new RecordId('task',pending.id)});
 expect(closed!.wait_kind).toBeUndefined();expect(closed!.state).toBe('ready');
 const [waits]=await db.db.query<[Array<{state:string}>]>('SELECT state FROM task_wait WHERE task=$t;',{t:new RecordId('task',pending.id)});
 expect(waits.every(w=>w.state==='released')).toBe(true);
});

run('an obsoleted version card is shown as retired and cannot be installed again',async()=>{
 rmSync(join(home,'active'));symlinkSync(join(home,'releases',newSha),join(home,'active'));
 // A real older release exists in history, so the plan's version and package.json agree and only the ordering refuses it.
 const old=git(['rev-parse',`${newSha}~1`]);
 writeFileSync(join(repo,'package.json'),'{"version":"0.1.5"}');
 writeFileSync(join(repo,'company-release.json'),JSON.stringify({...notes,version:'0.1.5'}));
 git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@invalid','commit','-m','older']);const olderSha=git(['rev-parse','HEAD']);
 git(['fetch','origin','main']);
 const t=await task();
 await db.db.query('UPDATE $t SET company_upgrade=$plan;',{t:new RecordId('task',t.id),plan:{...(await readCompanyRelease(repo,olderSha))}});
 const state=await service.state();
 const card=state.items.find(i=>i.taskId===t.id);
 expect(card?.retired).toBe(true);expect(card?.phase).toContain('替代');
 expect(await service.start({taskId:t.id,taskVersion:t.version,digest:card!.plan.digest},'owner:test').catch((e:{code?:string})=>e.code)).toBe('invalid');
});


async function resetAutomaticFixture(){
 await db.db.query('DELETE company_upgrade; DELETE task WHERE company_upgrade!=NONE; DELETE company_meta:upgrade_job; UPDATE company_meta:config SET paused=false;');
 rmSync(join(home,'active'));symlinkSync(join(home,'releases',oldSha),join(home,'active'));
 await service.setAuto(false,'owner:test');
}
run('automatic upgrades are opt-in, pause-aware, single-flight and distinctly audited',async()=>{
 await resetAutomaticFixture();const t=await task(),before=launches;
 expect(await service.autoStart()).toBeUndefined();expect(launches).toBe(before);
 await service.setAuto(true,'owner:test');await owner.setPaused(true);
 expect(await service.autoStart()).toBeUndefined();await owner.setPaused(false);
 const job=await service.autoStart();expect(job).toBeDefined();expect(launches).toBe(before+1);
 expect((await service.job(job!.jobId))?.authorization).toBe('automatic');
 expect(await service.autoStart()).toBeUndefined();expect(launches).toBe(before+1);
 const [audits]=await db.db.query<[Array<{action:string;actor:string}>]>("SELECT action,actor FROM audit WHERE task=$task AND action CONTAINS 'company_upgrade_';",{task:new RecordId('task',t.id)});
 expect(audits.some(a=>a.action==='company_upgrade_auto_authorized'&&a.actor==='system:auto-upgrade')).toBe(true);
 expect(audits.some(a=>a.action==='company_upgrade_authorized')).toBe(false);
});
run('failed automatic versions back off 24h, stop after two attempts, and keep manual retry available',async()=>{
 await resetAutomaticFixture();const t=await task();await service.setAuto(true,'owner:test');
 const first=await service.autoStart();await service.update(first!.jobId,'failed','fixture');
 await expect(service.autoStart()).rejects.toThrow('24小时');
 await db.db.query('UPDATE $job SET at=time::now()-25h,updated_at=time::now()-25h;',{job:new RecordId('company_upgrade',first!.jobId)});
 const second=await service.autoStart();expect(second!.jobId).not.toBe(first!.jobId);
 await service.update(second!.jobId,'failed','fixture');
 await db.db.query('UPDATE $job SET at=time::now()-25h,updated_at=time::now()-25h;',{job:new RecordId('company_upgrade',second!.jobId)});
 await expect(service.autoStart()).rejects.toThrow('上限');
 expect(await service.start({taskId:t.id,taskVersion:t.version,digest:t.companyUpgrade!.digest},'owner:test')).toBeDefined();
});
run('disabling automatic authorization during checking prevents install and never replies success',async()=>{
 await resetAutomaticFixture();const t=await task();await service.setAuto(true,'owner:test');const j=await service.autoStart();let installed=false;
 await runCompanyUpgrade(service,j!.jobId,{run:async(_exe,args)=>{
  if(args.includes('sidecar-review'))await service.setAuto(false,'owner:test');
  if(args[1]==='install')installed=true;
 },verify:async()=>{}});
 expect(installed).toBe(false);expect((await service.job(j!.jobId))?.status).toBe('failed');
 expect((await core.getTask(eng,t.id)).blockedTo).toBe('owner');
});
run('automatic task dependencies are rechecked and must be accepted before any job starts',async()=>{
 await resetAutomaticFixture();const t=await task();await service.setAuto(true,'owner:test');
 const dep=new RecordId('task',crypto.randomUUID());
 await db.db.query("CREATE $dep CONTENT {title:'待独立验收',state:'review',version:1}; UPDATE $task SET dependencies=[$dep];",{dep,task:new RecordId('task',t.id)});
 await expect(service.autoStart()).rejects.toThrow('前置');
 await db.db.query("UPDATE $dep SET state='done';",{dep});expect(await service.autoStart()).toBeDefined();
});
run('automatic upgrade completes real reply without inventing a boss click',async()=>{
 await resetAutomaticFixture();const t=await task();await service.setAuto(true,'owner:test');const j=await service.autoStart();
 await runCompanyUpgrade(service,j!.jobId,{run:async(_exe,args)=>{if(args[1]==='install'){rmSync(join(home,'active'));symlinkSync(args[2]!,join(home,'active'));}},verify:async()=>{}});
 expect((await service.job(j!.jobId))?.status).toBe('succeeded');
 expect((await core.getTask(eng,t.id)).blockedTo).toBeUndefined();
 const [cfg]=await db.db.query<[{paused:boolean}]>('SELECT paused FROM ONLY company_meta:config;');expect(cfg.paused).toBe(false);
});
run('an automatic exact-version acknowledgement verifies without installing twice',async()=>{
 await resetAutomaticFixture();const t=await task();await service.setAuto(true,'owner:test');
 rmSync(join(home,'active'));symlinkSync(join(home,'releases',newSha),join(home,'active'));
 const j=await service.autoStart();expect(j).toBeDefined();let installs=0;
 await runCompanyUpgrade(service,j!.jobId,{run:async(_exe,args)=>{if(args[1]==='install')installs++;},verify:async()=>{}});
 expect(installs).toBe(0);expect((await service.job(j!.jobId))?.status).toBe('succeeded');
 expect((await core.getTask(eng,t.id)).blockedTo).toBeUndefined();
});
run('reopened prerequisites and a replacement automatic grant both block the installation boundary',async()=>{
 await resetAutomaticFixture();const t=await task();await service.setAuto(true,'owner:test');
 const dep=new RecordId('task',crypto.randomUUID());
 await db.db.query("CREATE $dep CONTENT {title:'已验收前置',state:'done',version:1};UPDATE $task SET dependencies=[$dep];",{dep,task:new RecordId('task',t.id)});
 const j=await service.autoStart();let installs=0;
 await runCompanyUpgrade(service,j!.jobId,{run:async(_exe,args)=>{
  if(args.includes('sidecar-review'))await db.db.query("UPDATE $dep SET state='review';",{dep});
  if(args[1]==='install')installs++;
 },verify:async()=>{}});
 expect(installs).toBe(0);expect((await service.job(j!.jobId))?.status).toBe('failed');
 await resetAutomaticFixture();await task();await service.setAuto(true,'owner:test');const second=await service.autoStart();
 await runCompanyUpgrade(service,second!.jobId,{run:async(_exe,args)=>{
  if(args.includes('sidecar-review')){await service.setAuto(false,'owner:test');await service.setAuto(true,'owner:test');}
  if(args[1]==='install')installs++;
 },verify:async()=>{}});
 expect(installs).toBe(0);expect((await service.job(second!.jobId))?.status).toBe('failed');
});
run('concurrent automatic scans can launch only one durable worker',async()=>{
 await resetAutomaticFixture();await task();await service.setAuto(true,'owner:test');const before=launches;
 await Promise.allSettled([service.autoStart(),service.autoStart(),service.autoStart()]);
 const [rows]=await db.db.query<[Array<{id:RecordId}>]>('SELECT id FROM company_upgrade;');
 expect(rows).toHaveLength(1);expect(launches).toBe(before+1);
});
run('failed health of an already installed SHA still observes automatic retry backoff and budget',async()=>{
 await resetAutomaticFixture();await task();await service.setAuto(true,'owner:test');
 rmSync(join(home,'active'));symlinkSync(join(home,'releases',newSha),join(home,'active'));
 const first=await service.autoStart();
 await runCompanyUpgrade(service,first!.jobId,{run:async()=>{},verify:async()=>{throw Error('unhealthy');}});
 expect((await service.job(first!.jobId))?.status).toBe('failed');
 await expect(service.autoStart()).rejects.toThrow('24小时');
 await db.db.query('UPDATE $job SET at=time::now()-25h,updated_at=time::now()-25h;',{job:new RecordId('company_upgrade',first!.jobId)});
 const second=await service.autoStart();await service.update(second!.jobId,'failed','fixture');
 await expect(service.autoStart()).rejects.toThrow('上限');
});
run('a manual pause during preparation stops installation; entering installing is atomic with its pause revision',async()=>{
 await resetAutomaticFixture();await task();await service.setAuto(true,'owner:test');const j=await service.autoStart();let installs=0;
 await runCompanyUpgrade(service,j!.jobId,{run:async(_exe,args)=>{
  if(args.includes('sidecar-review'))await owner.setPaused(true);
  if(args[1]==='install')installs++;
 },verify:async()=>{}});
 expect(installs).toBe(0);expect((await service.job(j!.jobId))?.status).toBe('failed');
 const [paused]=await db.db.query<[{paused:boolean}]>('SELECT paused FROM ONLY company_meta:config;');expect(paused.paused).toBe(true);
 await resetAutomaticFixture();await task();await service.setAuto(true,'owner:test');const second=await service.autoStart();
 await runCompanyUpgrade(service,second!.jobId,{run:async(_exe,args)=>{
  if(args[1]==='install'){
   const state=await service.job(second!.jobId);expect(state?.status).toBe('installing');expect(typeof state?.pause_version).toBe('number');
   const [config]=await db.db.query<[{paused:boolean;pause_version:number}]>('SELECT paused,pause_version FROM ONLY company_meta:config;');
   expect(config.paused).toBe(true);expect(state!.pause_version).toBe(config.pause_version);
   rmSync(join(home,'active'));symlinkSync(args[2]!,join(home,'active'));
  }
 },verify:async()=>{}});
 expect((await service.job(second!.jobId))?.status).toBe('succeeded');
});
run('automatic scanning chooses the highest pending version and ignores job-history-only cards',async()=>{
 await resetAutomaticFixture();const high=await task(),low=await task();await service.setAuto(true,'owner:test');
 const lowPlan=await readCompanyRelease(repo,git(['rev-parse','HEAD']));expect(lowPlan.version).toBe('0.1.5');
 await db.db.query('UPDATE $task SET company_upgrade=$plan;',{task:new RecordId('task',low.id),plan:lowPlan});
 const first=await service.autoStart();expect(String((await service.job(first!.jobId))!.task.id)).toBe(high.id);
 await service.update(first!.jobId,'failed','fixture');
 // A completed high-version task can remain in the last three job history cards, but is no longer pending.
 await db.db.query("UPDATE $task SET state='done',blocked_to=NONE;",{task:new RecordId('task',high.id)});
 const second=await service.autoStart();expect(String((await service.job(second!.jobId))!.task.id)).toBe(low.id);
});
