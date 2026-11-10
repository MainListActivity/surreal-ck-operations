import { policy, type Row, type Snapshot } from './data.ts';
import type { OwnerBoard } from '../src/ui/types.ts';
export class DemoError extends Error { constructor(message:string,readonly status=400){super(message);} }
export class DemoStore {
  data:Snapshot; paused=false; policies=new Map<string,Row>(); executions=new Map<string,Row>(); timers=new Map<string,number>(); messages:Row[]=[]; guards:Row[]=[{command:'task.void',ownerOnly:true}];
  constructor(readonly initial:Snapshot){this.data=structuredClone(initial);this.reset();}
  reset(){this.data=structuredClone(this.initial);this.paused=false;this.policies=new Map(Object.entries(structuredClone(this.initial.policies??{})));this.executions=new Map(Object.entries(structuredClone(this.initial.executions??{})));this.timers.clear();this.guards=[{command:'task.void',ownerOnly:true}];this.messages=this.data.tasks.slice(0,3).map((t,i)=>({messageId:`msg-${i+1}`,taskId:t.id,title:t.title,step:'execute',state:i===1?'held':'draft',hold:i===1,body:'请核对当前任务范围和验收标准。这是可编辑的本地示例消息。',editable:true}));return{reset:true};}
  /** 本地模拟推进：确认后约 4 秒生成计划与任务；授权发布后约 5 秒完成部署验证。只改内存，不触发任何员工。 */
  tick(now=Date.now()){
    for(const r of this.data.requirements){
      const due=this.timers.get(r.id);if(due===undefined||now<due)continue;
      this.timers.delete(r.id);
      if(r.state==='queued'&&!r.planning_error&&!this.executions.has(r.id)){
        const steps=['梳理方案与影响范围','实现并自测','按验收标准逐条核对'];
        const tasks=steps.map((title,i)=>({id:`${r.id}-local-${i+1}`,title:`【本地模拟】${title}`,state:i===0?'doing':'ready',executor_role:i===2?'qa':'engineering',reviewer_role:i===2?'product':'qa',project:r.project,parent:i?`${r.id}-local-1`:undefined,requirement:`${r.title}\n\n${title}（本地模拟任务，不会派给任何员工）`,acceptanceText:r.acceptance}));
        this.data.tasks.unshift(...tasks);
        this.executions.set(r.id,{execution:{stage:'running',note:`任务 ${tasks[0]!.id}：doing`},plan:{steps:steps.map(title=>({title,context:`${title}（本地模拟计划）`,acceptance:r.acceptance}))},tasks:tasks.map(t=>t.id)});
        r.root_task=tasks[0]!.id;r.state='implementing';r.updated_at=new Date(now).toISOString();
      }else if(r.state==='release_pending'){
        const e=this.executions.get(r.id);
        this.executions.set(r.id,{...(e??{plan:null,tasks:[]}),execution:{stage:'released',note:'本地模拟：部署证据、复核与上线回归均已完成',released_sha:`demo-${r.id.slice(-6)}`}});
        r.state='released';r.updated_at=new Date(now).toISOString();
      }
    }
  }
  touch(r:Row){r.updated_at=new Date().toISOString();}
  find(list:Row[],id:unknown,key='id'){const row=list.find(x=>x[key]===id);if(!row)throw new DemoError('本地记录不存在',404);return row;}
  board():OwnerBoard {
    const now=Date.now();
    return {at:now,scheduler:{at:now,ageMs:0},runner:{state:'online',id:'demo-node',host:'本地设计环境',version:'demo',at:now},
      employees:this.data.agents.map((a,i)=>{const t=this.data.tasks.find(t=>(t.state==='doing'&&t.executor_role===a.role)||(t.state==='review'&&t.reviewer_role===a.role));return{id:a.employee,name:a.name,role:a.role,provider:'demo',model:'静态示例',now:t?{state:'leased' as const,taskId:t.id,title:t.title,phase:t.state==='review'?'review' as const:'execute' as const,leaseActive:true,elapsedSeconds:240,progress:{at:now,action:'checkpoint',label:'正在核对',summary:'仅模拟展示，不会启动 agent。'}}:{state:'idle' as const,idleSeconds:90},next:[],outbox:[]};}),
      unassigned:this.data.tasks.filter(t=>['ready','blocked'].includes(t.state)).map((t,i)=>({taskId:t.id,title:t.title,phase:'execute',position:i+1,blocked:t.state==='blocked',eligible:t.state!=='blocked',reason:t.state==='blocked'?'等待老板补充验收资料':'等待可用员工'})),
      recent:this.data.tasks.slice(0,4).map((t,i)=>({at:now-i*60000,actor:'示例员工',action:'checkpoint',label:'更新进度',taskId:t.id,taskTitle:t.title})),messages:this.messages as OwnerBoard['messages']};
  }
  command(command:string,input:Row={}):unknown {
    this.tick();
    const page=(list:Row[],limit:number)=>list.slice(Number(input.offset)||0,(Number(input.offset)||0)+limit);
    const filtered=(list:Row[])=>input.project?list.filter(r=>r.project===input.project):list;
    const req=()=>this.find(this.data.requirements,input.id);
    const editable=()=>{const r=req();if(r.revision!==input.revision||!['draft','pending','rejected'].includes(r.state))throw new DemoError('需求已确认或修订已变化，请刷新',409);return r;};
    switch(command){
      case 'product.iteration.list':return{products:this.data.products};
      case 'product.iteration.get':return{policy:this.policies.get(input.project)??policy()};
      case 'product.iteration.configure':{this.find(this.data.products,input.project);const value={enabled:!!input.enabled,autoRelease:!!input.autoRelease,feedbackOrigins:input.feedbackOrigins??[],releaseInstructions:String(input.releaseInstructions??''),verifyInstructions:String(input.verifyInstructions??''),rollbackInstructions:String(input.rollbackInstructions??'')};this.policies.set(input.project,value);return{policy:value};}
      case 'requirement.list':return{requirements:page(filtered(this.data.requirements),100)};
      case 'requirement.get':return{requirement:req()};
      case 'requirement.create':{this.find(this.data.products,input.project);if(!input.title?.trim()||!input.problem?.trim())throw new DemoError('请填写标题和问题');const r={id:crypto.randomUUID(),project:input.project,title:input.title,problem:input.problem,acceptance:input.acceptance??'',priority:input.priority??2,state:'pending',revision:1,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};this.data.requirements.unshift(r);return{requirement:r};}
      case 'requirement.edit':{const r=editable();Object.assign(r,{title:input.title,problem:input.problem,acceptance:input.acceptance,priority:input.priority,revision:r.revision+1,state:'pending'});this.touch(r);return{requirement:r};}
      case 'requirement.approve':{const r=req();if(r.approved_revision===input.revision)return{approval:{revision:r.revision}};editable();if(!(this.policies.get(r.project)??policy()).enabled||!r.acceptance?.trim())throw new DemoError('请启用产品并填写验收标准');r.approved_revision=r.revision;r.state='queued';this.touch(r);this.timers.set(r.id,Date.now()+4000);return{approval:{revision:r.revision},requirement:r};}
      case 'requirement.control':{const r=req();if(input.revision!==r.revision)throw new DemoError('修订已变化',409);if(input.action==='pause'&&['queued','implementing','release_pending'].includes(r.state)){r.paused_from=r.state;r.state='paused';}else if(input.action==='resume'&&r.state==='paused')r.state=r.paused_from??'queued';else if(input.action==='reject'&&['draft','pending'].includes(r.state))r.state='rejected';else if(input.action==='retry'&&r.state==='queued'){delete r.planning_error;this.timers.set(r.id,Date.now()+4000);}else throw new DemoError('当前状态不支持该操作',409);this.touch(r);const e=this.executions.get(r.id);if(e?.execution&&(input.action==='pause'||input.action==='resume'))e.execution={...e.execution,note:input.action==='pause'?'已暂停：当前步骤完成后不再推进':'已恢复推进'};return{requirement:r};}
      case 'requirement.release':{const r=req();if(r.state!=='release_pending')throw new DemoError('尚未到待发布阶段',409);const e=this.executions.get(r.id);const stage=e?.execution?.stage;if(stage==='release_not_configured'||!String((this.policies.get(r.project)??policy()).releaseInstructions??'').trim())throw new DemoError('请先在产品设置中填写发布、生产验证与回退流程',409);if(stage==='awaiting_evidence')throw new DemoError('发布任务缺少生产部署证据或独立复核，暂不能确认发布',409);if(stage==='deploying')return{approved:true,simulated:true};this.executions.set(r.id,{...(e??{plan:null,tasks:[]}),execution:{stage:'deploying',note:'已获老板授权（本地模拟），正在部署与生产验证'}});this.touch(r);this.timers.set(r.id,Date.now()+5000);return{approved:true,simulated:true};}
      case 'requirement.execution':{const r=req();const known=this.executions.get(r.id);if(known)return{execution:known.execution??null,plan:known.plan??null,tasks:(known.tasks as string[]).map(id=>this.data.tasks.find(t=>t.id===id)).filter(Boolean)};const t=this.data.tasks.find(t=>t.id===r.root_task);const active=['implementing','release_pending','released'].includes(r.state)||!!t;return{execution:active?{stage:r.state==='released'?'released':'running',note:'静态执行示例；本地确认不会创建真实任务',...(r.state==='released'?{released_sha:'demo-commit'}:{})}:null,plan:active?{steps:[{title:'核对并实施需求',context:'本地展示用计划',acceptance:r.acceptance}]}:null,tasks:t?[t]:[]};}
      case 'feedback.list':return{feedback:page(filtered(this.data.feedback).filter(f=>!input.requirement||f.requirement===input.requirement).filter(f=>!input.state||f.state===input.state),50)};
      case 'feedback.retry':{const f=this.find(this.data.feedback,input.id);f.state='new';delete f.reason;delete f.last_error;return{retried:true};}
      case 'task.list':return{tasks:this.data.tasks};
      case 'task.detail':return{task:this.find(this.data.tasks,input.taskId),audit:[{at:new Date().toISOString(),actor:'本地示例',action:'create',evidence:'用于设计预览'}],messages:this.messages.filter(m=>m.taskId===input.taskId)};
      case 'task.create':{const t={id:crypto.randomUUID(),title:input.title,requirement:input.requirement,acceptanceText:input.acceptanceText,executor_role:input.executorRole,reviewer_role:input.reviewerRole,state:'ready',parent:input.parent};this.data.tasks.unshift(t);return{task:t};}
      case 'task.reassign':Object.assign(this.find(this.data.tasks,input.taskId),{executor_role:input.executorRole,reviewer_role:input.reviewerRole});return{updated:true};
      case 'task.void':this.find(this.data.tasks,input.taskId).state='void';return{voided:true};
      case 'status':return{paused:this.paused};
      case 'task.pause':this.paused=true;return{paused:true};
      case 'task.resume':this.paused=false;return{paused:false};
      case 'agent.list':return{agents:this.data.agents};
      case 'agent.policy.set':this.find(this.data.agents,input.agent,'employee').policy={disabled:!!input.disabled,allow:input.allow,deny:input.deny??[],lang:input.lang};return{updated:true};
      case 'agent.identity.ensure':this.find(this.data.agents,input.employee,'employee').idpUser='local-demo-identity';return{created:true};
      case 'guard.list':return{protected:this.guards,hardOwnerOnly:['db.write','requirement.approve'],ownerApiCommands:['task.list','task.create','requirement.list'],targetLocks:[],ownerOnlyForAgents:['product.iteration.configure']};
      case 'guard.protect':this.guards=this.guards.filter(g=>g.command!==input.command);this.guards.push({command:input.command,ownerOnly:!!input.ownerOnly});return{updated:true};
      case 'guard.unprotect':this.guards=this.guards.filter(g=>g.command!==input.command);return{updated:true};
      case 'note.list':return{notes:this.data.notes.filter(n=>!input.lane||n.lane===input.lane)};
      case 'note.add':this.data.notes.unshift({id:crypto.randomUUID(),text:input.text,lane:input.lane??'company',state:'active',pinned:false,updatedAt:new Date().toISOString()});return{created:true};
      case 'note.edit':this.find(this.data.notes,input.noteId).text=input.text;return{updated:true};
      case 'note.pin':this.find(this.data.notes,input.noteId).pinned=!!input.pinned;return{updated:true};
      case 'note.activate':this.find(this.data.notes,input.noteId).state='active';return{updated:true};
      case 'note.remove':this.find(this.data.notes,input.noteId).state='removed';return{updated:true};
      case 'note.consolidations':return{consolidations:[]};
      case 'ops.job.list':return{jobs:this.jobs().filter(j=>!input.state||j.state===input.state)};
      case 'ops.job.get':return{job:this.find(this.jobs(),input.id)};
      case 'audit.list':return{audit:[{at:new Date().toISOString(),actorKind:'owner',actor:'本地老板',command:'requirement.approve',outcome:'ok',summary:'本地模拟确认，不执行生产操作'}]};
      case 'idp.status':return{tenantId:'demo-tenant',configured:{gateway:true,runner:true,automation:false}};
      case 'message.edit':case 'message.edit_rendered':this.find(this.messages,input.messageId,'messageId').body=input.body??input.rendered;return{updated:true};
      case 'message.hold':case 'message.release':{const m=this.find(this.messages,input.messageId,'messageId');m.hold=command==='message.hold';m.state=m.hold?'held':'draft';return{updated:true};}
      case 'message.send':this.messages=this.messages.filter(m=>m.messageId!==input.messageId);return{sent:true,simulated:true};
      default:throw new DemoError(`设计模式未模拟 ${command}，没有执行外部操作。`,501);
    }
  }
  jobs(){return['queued','running','done','error'].map((state,i)=>({id:`job-${i}`,command:['host.status','task.create','node.status','host.exec'][i],state,actorKind:'owner',actor:'本地示例',createdAt:new Date().toISOString(),...(state==='error'?{error:'示例失败：执行节点暂时离线'}:{})}));}
}
