import {beforeAll,afterAll,expect,test,setDefaultTimeout} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {RecordId} from 'surrealdb';
import {CompanyDatabase} from '../src/database.ts';
import {OwnerDesk} from '../src/owner.ts';
import {SurrealCompanyCore} from '../src/core.ts';
import {LocalEnrollmentAdmin} from '../src/enrollment.ts';
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
 dir=mkdtempSync(join(tmpdir(),'sck-company-upgrade-'));repo=join(dir,'repo');home=join(dir,'service');mkdirSync(repo);mkdirSync(join(home,'releases'),{recursive:true});
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
