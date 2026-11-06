import { RecordId } from 'surrealdb';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync,openSync,closeSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CompanyDatabase } from './database.ts';
import type { OwnerDesk, OwnerInbox } from './owner.ts';
import { CompanyError } from './core-errors.ts';
import { compareRelease,installedRelease,readCompanyRelease,type CompanyRelease } from './company-release.ts';
export type UpgradeStatus='queued'|'preparing'|'checking'|'installing'|'verifying'|'succeeded'|'failed'|'awaiting_reply';
export interface UpgradeJob {id:RecordId;task:RecordId;task_version:number;plan:CompanyRelease;status:UpgradeStatus;phase:string;error?:string;pid?:number;at:unknown;updated_at:unknown;source:string;decision:'approve'|'reply';authorization?:'owner'|'automatic';policy_revision?:number;previous?:string;pause_version?:number;paused_before?:boolean}
export interface UpgradeCard {taskId:string;taskVersion:number;plan:CompanyRelease;status:UpgradeStatus|'available';phase:string;error?:string;jobId?:string;retired?:boolean}
/** What ending one task's pending version card did: the owner handoff was released, or the card belonged to a superseded version. */
export interface UpgradeClosure {taskId:string;version:string;released:boolean;reason:'released'|'superseded'}
const AUTO_SOURCE='system:auto-upgrade';
const running=(s:string)=>['queued','preparing','checking','installing','verifying'].includes(s);
/** A card whose version is already behind what is installed can no longer install anything; it is history, not a decision. */
const retired=(c:Pick<UpgradeCard,'status'|'plan'>,installed:string)=>c.status!=='succeeded'&&compareRelease(c.plan.version,installed)<0;
export class CompanyUpgrades {
 constructor(readonly database:CompanyDatabase,readonly owner:OwnerDesk,readonly options:{home:string;repo:string;launch?:(jobId:string)=>void}){}
 private get db(){return this.database.db;}
 async state(box?:OwnerInbox){
  const current=await installedRelease(this.options.home);
  const inbox=box??await this.owner.inbox();
  const [jobs]=await this.db.query<[UpgradeJob[]]>('SELECT * FROM company_upgrade ORDER BY at DESC LIMIT 20;');
  for(const j of jobs){
   if(!running(j.status)||Date.now()-Date.parse(String(j.updated_at))<60_000)continue;
   let alive=false;if(j.pid){try{process.kill(-j.pid,0);alive=true;}catch{}}
   if(!alive){
    // Do not overwrite a worker that started or made progress after this read.
    const [changed]=await this.db.query<[UpgradeJob[]]>(`UPDATE $job SET status='failed',phase='升级进程已中断',error='请重试升级；系统会先核验当前版本，未自动回复通过。',updated_at=time::now()
      WHERE status=$status AND updated_at=$at AND pid=$pid RETURN AFTER;`,{job:j.id,status:j.status,at:j.updated_at,pid:j.pid});
    if(changed[0])Object.assign(j,changed[0]);
   }
  }
  const items:UpgradeCard[]=[];
  const seen=new Set<string>();
  for(const entry of [...inbox.gates,...inbox.questions]){
   const t=entry.task,plan=t.companyUpgrade;if(!plan)continue;
   seen.add(t.id);const job=jobs.find(j=>String(j.task.id)===t.id&&j.plan.digest===plan.digest);
   items.push({taskId:t.id,taskVersion:t.version,plan,status:job?.status??'available',phase:job?.phase??'待升级',error:job?.error,jobId:job?String(job.id.id):undefined});
  }
  for(const j of jobs.slice(0,3))if(!seen.has(String(j.task.id)))items.push({taskId:String(j.task.id),taskVersion:j.task_version,plan:j.plan,status:j.status,phase:j.phase,error:j.error,jobId:String(j.id.id)});
  return {automatic:await this.autoPolicy(),current:{version:current.version,sha:current.sha},items:items.map(item=>retired(item,current.version)?{...item,phase:'已被 v'+current.version+' 替代',retired:true}:item)};
 }
 async inbox(){const box=await this.owner.inbox();return {...box,upgrades:await this.state(box)};}
 async autoPolicy(){
  const [c]=await this.db.query<[{company_auto_upgrade?:boolean;company_auto_upgrade_revision?:number}]>('SELECT company_auto_upgrade,company_auto_upgrade_revision FROM ONLY company_meta:config;');
  return {enabled:c?.company_auto_upgrade===true,revision:c?.company_auto_upgrade_revision??0};
 }
 async setAuto(enabled:boolean,source:string){
  if(typeof enabled!=='boolean')throw new CompanyError('invalid','自动升级设置无效');
  await this.db.query(`BEGIN;
   UPSERT ONLY company_meta:config SET company_auto_upgrade=$enabled,company_auto_upgrade_revision=(company_auto_upgrade_revision??0)+1;
   CREATE audit CONTENT {actor:$source,action:'company_auto_upgrade_policy_changed',evidence:$evidence,at:time::now()};
   COMMIT;`,{enabled,source,evidence:enabled?'老板授权自动安装已合 main 的公司版本；全部机器门禁和原有任务验收保持有效。':'老板关闭公司自动升级；尚未进入安装阶段的自动作业停止。'});
  return this.autoPolicy();
 }
 /** Called by the control loop, never on an inference request. The detached runner owns expensive work. */
 async autoStart(){
  if(!(await this.autoPolicy()).enabled)return;
  const [cfg]=await this.db.query<[{paused?:boolean}]>('SELECT paused FROM ONLY company_meta:config;');
  if(cfg?.paused)return;
  // Reconcile vanished workers before checking the durable single-flight lock.
  const box=await this.owner.inbox();
  const pendingIds=new Set([...box.gates.map(x=>x.task.id),...box.questions.map(x=>x.task.id)]);
  const state=await this.state(box);
  if(state.items.some(x=>running(x.status)))return;
  const candidates=state.items.filter(x=>pendingIds.has(x.taskId)&&!x.retired&&!['succeeded','awaiting_reply'].includes(x.status)&&(compareRelease(x.plan.version,state.current.version)>0||x.plan.sha===state.current.sha))
    .sort((a,b)=>compareRelease(b.plan.version,a.plan.version)||a.taskId.localeCompare(b.taskId));
  const latest=candidates[0];if(!latest)return;
  return this.start({taskId:latest.taskId,taskVersion:latest.taskVersion,digest:latest.plan.digest},AUTO_SOURCE,true);
 }
 async assertAutomatic(job:UpgradeJob){
  if(job.authorization!=='automatic')return;
  const policy=await this.autoPolicy();
  if(!policy.enabled||policy.revision!==job.policy_revision)throw new CompanyError('conflict','自动升级授权已关闭或变更');
 }
 async start(input:{taskId:string;taskVersion:number;digest:string},source:string,automatic=false){
  if(!/^[a-zA-Z0-9_-]{1,200}$/.test(input.taskId)||!Number.isSafeInteger(input.taskVersion)||!/^[a-f0-9]{64}$/.test(input.digest))throw new CompanyError('invalid','升级参数无效，请刷新后重试');
  const t=await this.db.select<{company_upgrade?:CompanyRelease}>(new RecordId('task',input.taskId));
  if(!t?.company_upgrade||t.company_upgrade.digest!==input.digest)throw new CompanyError('conflict','升级内容已变化，请刷新后重新查看');
  const plan=await readCompanyRelease(this.options.repo,t.company_upgrade.sha);
  if(plan.digest!==input.digest)throw new CompanyError('conflict','版本说明与已提交的升级内容不一致');
  const current=await installedRelease(this.options.home);
  if(current.sha!==plan.sha&&compareRelease(plan.version,current.version)<0)throw new CompanyError('invalid','该版本已被现役版本取代，无需再安装；请改为关闭这张旧待办');
  if(current.sha!==plan.sha&&compareRelease(plan.version,current.version)===0)throw new CompanyError('invalid','目标版本不高于当前版本，请工程提交新的版本号');
  const jobId=randomUUID();
  const results=await this.db.query(`BEGIN;
   LET $t=SELECT * FROM ONLY $task;
   LET $policy=SELECT * FROM ONLY company_meta:config;
   IF $automatic AND ($policy.company_auto_upgrade!=true OR $policy.paused=true) {THROW '自动升级已关闭或派工已暂停';};
   IF $t.version!=$version OR $t.company_upgrade.digest!=$digest OR $t.company_upgrade.sha!=$sha {THROW '升级内容或任务版本已变化，请刷新';};
   IF $t.company_upgrade=NONE OR NOT (($t.state='blocked' AND $t.blocked_to='owner') OR ($t.state='review' AND $t.reviewer_role='owner')) {THROW '任务已不在老板收件箱，不能升级';};
   IF $automatic {
   };
   LET $lock=SELECT * FROM ONLY company_meta:upgrade_job;
   LET $active=SELECT * FROM ONLY $lock.job;
   IF $active!=NONE AND $active.status IN ['queued','preparing','checking','installing','verifying'] {
    IF $active.task!=$task OR $active.plan.digest!=$digest {THROW '已有公司升级正在执行';};
    RETURN $active;
   } ELSE {
    IF $automatic {
     LET $attempts=SELECT status,at,updated_at,authorization FROM company_upgrade WHERE plan.sha=$sha ORDER BY at DESC;
     IF array::len(array::filter($attempts,|$a|$a.authorization='automatic' AND $a.status='failed'))>=2 {THROW '该版本自动升级次数已达上限，请人工重试或提交新版本';};
     IF array::len(array::filter($attempts,|$a|$a.status='failed' AND ($a.updated_at??$a.at)>time::now()-24h))>0 {THROW '该版本自动升级处于24小时退避';};
    };
    CREATE ONLY $job CONTENT {task:$task,task_version:$version,plan:$plan,authorization:IF $automatic THEN 'automatic' ELSE 'owner' END,policy_revision:IF $automatic THEN $policy.company_auto_upgrade_revision??0 ELSE NONE END,status:'queued',phase:'已排队',previous:IF $active.task=$task AND $active.plan.digest=$digest AND $active.status IN ['failed','awaiting_reply'] THEN $active.previous ELSE NONE END,paused_before:IF $active.task=$task AND $active.plan.digest=$digest AND $active.status IN ['failed','awaiting_reply'] THEN $active.paused_before ELSE NONE END,pause_version:IF $active.task=$task AND $active.plan.digest=$digest AND $active.status IN ['failed','awaiting_reply'] THEN $active.pause_version ELSE NONE END,source:$source,decision:IF $t.state='review' THEN 'approve' ELSE 'reply' END,at:time::now(),updated_at:time::now()};
    UPSERT ONLY company_meta:upgrade_job SET job=$job;
    CREATE audit CONTENT {task:$task,actor:$source,action:IF $automatic THEN 'company_upgrade_auto_authorized' ELSE 'company_upgrade_authorized' END,evidence:$evidence,version:$version,at:time::now()};
    RETURN SELECT * FROM ONLY $job;
   };
   COMMIT;`,{task:new RecordId('task',input.taskId),version:input.taskVersion,digest:input.digest,sha:plan.sha,plan,job:new RecordId('company_upgrade',jobId),source,automatic,evidence:`${automatic?'按老板开启的自动升级策略安装':'老板授权升级至'} v${plan.version}；SHA ${plan.sha}；仅验证成功后自动回复通过。`}).responses();
  const error=results.find(r=>!r.success&&!r.error.message.includes('not executed')&&!r.error.message.startsWith('Cannot COMMIT'));
  if(error&&!error.success)throw new CompanyError('conflict',error.error.message);
  const result=results.filter(r=>r.success&&r.result&&typeof r.result==='object'&&!Array.isArray(r.result)).at(-1);
  if(!result?.success)throw new CompanyError('temporarily_unavailable','无法登记升级作业');
  const job=result.result as UpgradeJob;
  if(String(job.id.id)===jobId){
   try{(this.options.launch??(id=>this.launch(id)))(jobId);}
   catch{await this.update(jobId,'failed','启动失败','无法启动升级，请重试');}
  }
  return {jobId:String(job.id.id),status:job.status};
 }
 private launch(id:string){
  const home=this.options.home;
  mkdirSync(join(home,'upgrades'),{recursive:true,mode:0o700});
  const log=openSync(join(home,'upgrades',`${id}.log`),'a',0o600);
  try{
   const runtime=join(home,'runtime-bun/bin/bun'),worker=join(home,'active/src/company-upgrade-worker.ts');
   if(!existsSync(runtime)||!existsSync(worker))throw Error('worker unavailable');
   const child=spawn(runtime,[worker,id],{cwd:home,detached:true,stdio:['ignore',log,log],env:{HOME:process.env.HOME,USER:process.env.USER,PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,SSH_AUTH_SOCK:process.env.SSH_AUTH_SOCK,SCK_SERVICE_HOME:home,SCK_AGENT_CWD:this.options.repo}});
   child.on('error',()=>void this.update(id,'failed','启动失败','升级工作进程未能启动'));child.unref();
  }finally{closeSync(log);}
 }
 async update(id:string,status:UpgradeStatus,phase:string,error?:string){await this.db.query('UPDATE $job SET status=$status,phase=$phase,error=$error,updated_at=time::now();',{job:new RecordId('company_upgrade',id),status,phase,error});}
 async job(id:string){return this.db.select<UpgradeJob>(new RecordId('company_upgrade',id));}
 /** The version actually installed, or undefined when the active release cannot be read. */
 async installed(){return installedRelease(this.options.home).catch(()=>undefined);}
 async finish(job:UpgradeJob){
  const decision=job.decision;
  const note=`通过：公司系统已升级至 v${job.plan.version}（${job.plan.sha}）。\n上线内容：${job.plan.changes.join('；')}\n影响范围：${job.plan.impact.join('；')}\n双面安装、健康检查、版本及门禁验证通过。请员工继续独立业务验收。`;
  const taskId=String(job.task.id);
  await this.owner.decide({taskId,expectedVersion:job.task_version,decision,note,source:job.source,key:`company-upgrade:${String(job.id.id)}`});
  await this.update(String(job.id.id),'succeeded','升级成功，已自动回复通过');
 }
 /**
  * Close the pending version card of every task whose version is older than the one now running. Installing a version
  * answers every older card by construction — the owner asked for that version only because it was not live yet — so
  * leaving those cards waiting would keep the owner's inbox asking for something that already happened. A task still
  * waiting on its own owner handoff is released the same way `finish` releases it; a gate or question is answered with
  * an explicit reply carrying the installed version. Cards at or above the running version are untouched: those are
  * still real decisions.
  */
 async closeSuperseded(installed:{version:string;sha:string},source:string):Promise<UpgradeClosure[]>{
  const [rows]=await this.db.query<[Array<{id:RecordId;version:number;title:string;company_upgrade?:CompanyRelease}>]>(
   `SELECT id,version,title,company_upgrade FROM task
    WHERE company_upgrade != NONE AND state IN ['blocked','review']
    ORDER BY id;`);
  const closed:UpgradeClosure[]=[];
  for(const row of rows??[]){
   const plan=row.company_upgrade,taskId=String(row.id.id);
   if(!plan||compareRelease(plan.version,installed.version)>=0)continue;
   const note=`你的版本 v${plan.version}（${plan.sha}）已被现役 v${installed.version}（${installed.sha}）取代，不需要再单独安装。`
    +`\n这张待办按已上线处理；请在该任务的验收证据里记录它随 v${installed.version} 一起上线，再继续你自己的业务验收。`;
   try{
    await this.owner.decide({taskId,decision:'reply',note,source,key:`company-upgrade-superseded:${installed.sha}:${taskId}`});
    closed.push({taskId,version:plan.version,released:true,reason:'superseded'});
   }catch(error){
    // A card that moved on since the read keeps its own path; the next pass retries instead of forcing a state.
    if((error as {code?:string}).code==='conflict')continue;
    throw error;
   }
  }
  if(closed.length)await this.db.query(
   `CREATE audit CONTENT {actor:$source,action:'company_upgrade_cards_closed',evidence:$evidence,at:time::now()};`,
   {source,evidence:`现役 v${installed.version} ${installed.sha}；关闭旧版本待办 ${closed.length} 张：${closed.map(c=>`${c.taskId}@${c.version}`).join('、')}`});
  return closed;
 }
}
