import { spawn } from 'node:child_process';
import { mkdir,realpath,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyUpgrades,type UpgradeJob,type UpgradeStatus } from './company-upgrades.ts';
import { installedRelease,readCompanyRelease,git,compareRelease } from './company-release.ts';

export type UpgradeCommand=(exe:string,args:string[],cwd:string)=>Promise<void>;
export const command:UpgradeCommand=(exe,args,cwd)=>new Promise((resolve,reject)=>{
 const child=spawn(exe,args,{cwd,env:{...process.env,GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','inherit','inherit']});
 const timer=setTimeout(()=>{
  // The host worker owns a detached process group. Terminate the whole group on an
  // unknown timeout: no orphan installer may continue while another job starts.
  // Its durable job stays pending until the UI confirms the group is gone.
  try{process.kill(-process.pid,'SIGKILL');}catch{child.kill('SIGKILL');reject(Error('command timeout'));}
 },600_000);
 child.once('error',e=>{clearTimeout(timer);reject(e);});
 child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('command failed'));});
});
export async function verifyCompanyUpgrade(home:string,target:string,run:UpgradeCommand=command){
 const active=await installedRelease(home);
 if(active.path!==await realpath(target))throw Error('active mismatch');
 const ports=[Number(process.env.SCK_MCP_PORT??38473),Number(process.env.SCK_PREVIEW_PORT??18777),Number(process.env.SCK_PREVIEW_SIGNED_PORT??18778)];
 for(const [port,path] of [[ports[0],'/health'],[ports[0],'/ready'],[ports[1],'/healthz'],[ports[2],'/healthz']] as const){
  if(typeof port!=='number'||!Number.isInteger(port)||port<1||port>65535)throw Error('invalid health port');
  let ok=false;
  for(let i=0;i<30;i++){
   try{ok=(await fetch(`http://127.0.0.1:${port}${path}`,{signal:AbortSignal.timeout(2500)})).ok;}catch{}
   if(ok)break;await new Promise(r=>setTimeout(r,500));
  }
  if(!ok)throw Error('health check failed');
 }
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const {stdout}=await promisify(execFile)(process.env.SCK_PASEO_BIN??'/Applications/Paseo.app/Contents/Resources/bin/paseo',['plugin','ls','sck-company','--json'],{timeout:15_000,maxBuffer:64_000});
 const p=JSON.parse(stdout)[0];
 if(p?.status!=='running'||p.enabled!==true||await realpath(p.path)!==await realpath(join(target,'plugin')))throw Error('plugin source mismatch');
 await run('diff',['-qr',join(target,'schema'),join(target,'plugin/server/vendor/schema')],home);
 const {stdout:bunVersion}=await promisify(execFile)(join(home,'runtime-bun/bin/bun'),['--version'],{timeout:5000});
 for(const gate of ['comm-slow-pipe','sidecar-review']){
  const record=JSON.parse(await readFile(join(home,'gates',gate,`${active.sha}.json`),'utf8'));
  if(record.sha!==active.sha||record.result!=='pass'||record.bun!==bunVersion.trim()||record.platform!=='darwin')throw Error('release gate mismatch');
 }
 await run('sh',['-c','. "$1/scripts/release-content.sh"; release_matches_commit "$1" "$2" "$3"','verify-release',target,active.sha,process.env.SCK_OPS_REPO??'/Users/y/IdeaProjects/surreal-ck-operations'],home);

}
export async function runCompanyUpgrade(service:CompanyUpgrades,id:string,options:{run?:UpgradeCommand;verify?:(home:string,target:string)=>Promise<void>}={}){
 const run=options.run??command,verify=options.verify??verifyCompanyUpgrade;
 let job=await service.job(id);if(!job||!['queued','failed','awaiting_reply'].includes(job.status))throw Error('job not runnable');
 const db=service.database.db,{home,repo}=service.options;
 // Claim the durable job before any external action. A duplicate worker cannot install twice.
 const [claimed]=await db.query<[UpgradeJob[]]>(`UPDATE $job SET status='preparing',phase='准备升级',pid=$pid,updated_at=time::now()
   WHERE status IN ['queued','failed','awaiting_reply'] RETURN AFTER;`,{job:new RecordId('company_upgrade',id),pid:process.pid});
 if(!claimed.length)return;
 job=claimed[0]!;
 const beat=setInterval(()=>void db.query('UPDATE $job SET updated_at=time::now();',{job:job!.id}).catch(()=>{}),5000);beat.unref();
 let phase='校验版本',previous:string|undefined,targetPath:string|undefined,pausedVersion:number|undefined=job.pause_version,pausedBefore=job.paused_before??false,healthy=false,switched=false;
 const update=async(status:UpgradeStatus,next:string)=>{phase=next;await service.update(id,status,next);};
 try{
  await update('preparing','校验版本');
  await git(repo,['fetch','origin','main']);
  const plan=await readCompanyRelease(repo,job.plan.sha);
  if(plan.digest!==job.plan.digest)throw Error('approved plan changed');
  const current=await installedRelease(home);previous=current.path;
  const target=join(home,'releases',plan.sha);targetPath=target;
  if(current.sha!==plan.sha){
   if(compareRelease(plan.version,current.version)<=0)throw Error('version superseded');
   await git(repo,['merge-base','--is-ancestor',current.sha,plan.sha]);
   await update('preparing','生成固定发布快照');
   // Reuse only a complete, content-bound snapshot; the gate and installer verify it again.
   const {existsSync}=await import('node:fs');
   if(!existsSync(target)){
    await mkdir(target,{recursive:true});
    const archive=join(home,'upgrades',`${id}.tar`);await mkdir(join(home,'upgrades'),{recursive:true,mode:0o700});
    await run('git',['-C',repo,'archive','--format=tar',`--output=${archive}`,plan.sha],home);
    await run('tar',['-xf',archive,'-C',target],home);await rm(archive);
    await run('cp',['-RL',join(previous,'node_modules'),join(target,'node_modules')],home);
    await run('cp',['-RL',join(previous,'plugin/node_modules'),join(target,'plugin/node_modules')],home);
    await run('sh',[join(target,'plugin/scripts/vendor.sh')],home);
   }
   await run('sh',[join(target,'plugin/scripts/vendor.sh')],home);
   await run('pnpm',['--dir',target,'install','--frozen-lockfile'],home);
   await run('pnpm',['--dir',join(target,'plugin'),'install','--frozen-lockfile','--ignore-scripts'],home);
   await update('checking','检查代码与本机发布门禁');
   await run('pnpm',['--dir',target,'typecheck'],home);
   await run('pnpm',['--dir',join(target,'plugin'),'typecheck'],home);
   await run('sh',[join(target,'scripts/release-gate.sh'),'slow-pipe',target],home);
   await run('sh',[join(target,'scripts/release-gate.sh'),'sidecar-review',target],home);
   // Revalidate the owner's pending task after preparation; a stale click must not switch anything.
   const t=await db.select<{version:number;state:string;blocked_to?:string;reviewer_role:string}>(job.task);
   if(!t||t.version!==job.task_version||!((t.state==='blocked'&&t.blocked_to==='owner')||(t.state==='review'&&t.reviewer_role==='owner')))throw Error('owner task moved');
   if((await installedRelease(home)).sha!==current.sha)throw Error('another release replaced the current version');
   const [c]=await db.query<[{paused?:boolean;pause_version:number}]>('UPSERT ONLY company_meta:config SET paused=true,pause_version=(pause_version??0)+1 RETURN BEFORE;');
   pausedBefore=!!c?.paused;pausedVersion=(c?.pause_version??0)+1;
   await db.query('UPDATE $job SET previous=$previous,paused_before=$before,pause_version=$revision;',{job:job.id,previous, before:pausedBefore,revision:pausedVersion});
   await update('installing','安装版本并切换公司插件');
   targetPath=await realpath(target);
   switched=true;
   await run('sh',[join(target,'scripts/company-service.sh'),'install',target],home);
  }
  await update('verifying','验证实际运行版本与服务');
  await verify(home,target);healthy=true;
  const [installation]=await db.query<[{schema_version?:number}]>('SELECT schema_version FROM ONLY company_meta:installation;');
  if((installation?.schema_version??0)<41)throw Error('upgrade schema not applied');
  await db.query('CREATE audit CONTENT {task:$task,actor:$source,action:"company_upgrade_verified",evidence:$evidence,at:time::now()};',{task:job.task,source:job.source,evidence:`v${job.plan.version} ${job.plan.sha}；固定快照、双门禁、active、健康/ready、插件来源与schema/vendor核验通过。`});
  try{await service.finish(job);}catch{await service.update(id,'awaiting_reply','已升级，自动回复待完成','版本已验证上线，但任务状态已变化或验收条件尚未满足；未替代独立验收。');}
 }catch{
  let recovered=false;
  const failedPhase=phase;
  const activeNow=await installedRelease(home).catch(()=>undefined);
  if(switched&&previous&&targetPath&&(!activeNow||activeNow.path===targetPath||activeNow.path===previous)){
   try{await update('verifying','升级失败，恢复之前版本');await run('sh',[join(targetPath,'scripts/company-service.sh'),'install',previous],home);await verify(home,previous);recovered=true;healthy=true;}catch{}
  }else healthy=pausedVersion===undefined;
  await service.update(id,'failed','升级失败',`失败阶段：${failedPhase}。${recovered?'已恢复之前版本。':switched?'请检查当前运行状态，派工保持暂停。':'现役版本未切换。'}待办保留，未自动回复通过。`);
 }finally{
  clearInterval(beat);
  if(healthy&&pausedVersion!==undefined)await db.query('UPDATE company_meta:config SET paused=$paused,pause_version=pause_version+1 WHERE pause_version=$revision;',{paused:pausedBefore,revision:pausedVersion});
 }
}
