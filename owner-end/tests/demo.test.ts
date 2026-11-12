import { expect, test } from 'bun:test';
import { parseSnapshot, sanitize, seed } from '../demo/data.ts';
import { DemoStore } from '../demo/store.ts';
import { handler } from '../demo/server.ts';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const origin='http://127.0.0.1:6006';
const request=(path:string,body?:unknown,headers:Record<string,string>={})=>new Request(origin+path,{headers:{host:'127.0.0.1:6006',...headers},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});

test('快照白名单替换所有自由文本、凭证和真实标识，保留状态和关联',()=>{
 const raw=seed();raw.products[0]={id:'secret-project',name:'客户名称'};
 raw.tasks[0]={id:'task:⟨private-task⟩',title:'客户资料',state:'doing',token:'secret-token'};
 raw.requirements[0]={id:'private-req',project:'secret-project',root_task:'private-task',title:'客户要求',problem:'客户正文',state:'implementing',revision:2,secret:'secret-token'};
 raw.feedback[0]={id:'private-feedback',project:'secret-project',requirement:'private-req',state:'linked',body:{text:'原始客户资料',contact:'private@example.com'}};
 const result=sanitize(raw);const text=JSON.stringify(result);
 for(const forbidden of ['secret-project','客户名称','private-task','客户资料','secret-token','客户正文','private-req','原始客户资料','private@example.com'])expect(text).not.toContain(forbidden);
 expect(result.requirements[0]!.root_task).toBe(result.tasks[0]!.id);
 expect(result.feedback[0]!.requirement).toBe(result.requirements[0]!.id);
 expect(result.requirements[0]!.state).toBe('implementing');
 expect(()=>parseSnapshot({format:'wrong'})).toThrow();
});
test('编辑、确认和暂停只修改内存，已确认内容锁定，重置还原',()=>{
 const initial=seed();const store=new DemoStore(initial);const r=store.data.requirements.find(r=>r.state==='pending')!;
 store.command('requirement.edit',{id:r.id,revision:r.revision,title:'本地修改',problem:r.problem,acceptance:r.acceptance,priority:1});
 store.command('requirement.approve',{id:r.id,revision:r.revision});expect(r.state).toBe('queued');
 expect(()=>store.command('requirement.edit',{id:r.id,revision:r.revision})).toThrow();
 store.command('requirement.control',{id:r.id,revision:r.revision,action:'pause'});expect(r.state).toBe('paused');
 expect(initial.requirements.find(x=>x.id===r.id)!.state).toBe('pending');
 store.reset();expect(store.data.requirements.find(x=>x.id===r.id)!.state).toBe('pending');
});
test('本地 HTTP 无未知命令回退、无数据库访问、拒绝跨来源和目录文件',async()=>{
 const serve=handler(new DemoStore(seed()),origin);
 for(const command of ['db.write','db.read','cf.api','host.exec','idp.client.reset','unknown']){
   const r=await serve(request('/api/cmd',{command,input:{sql:'DELETE task;'}}));expect(r.status).toBe(501);expect((await r.json()).error.message).toContain('没有执行外部操作');
 }
 expect((await serve(request('/api/cmd',{command:'task.pause'},{origin:'https://company.maplayer.top'}))).status).toBe(403);
 expect((await serve(new Request('http://evil.example:6006/',{headers:{host:'evil.example:6006'}}))).status).toBe(403);
 for(const path of ['/.env','/demo/auth.ts','/api/config','/feedback-widget.js'])expect((await serve(request(path))).status).toBe(404);
 const html=await serve(request('/'));expect(html.headers.get('content-security-policy')).toContain("connect-src 'self'");expect(await html.text()).toContain('本地设计模式');
 for(const command of ['product.iteration.list','requirement.list','task.list','note.list','note.consolidations','agent.list','guard.list','ops.job.list','audit.list','idp.status','status'])expect((await serve(request('/api/cmd',{command}))).status).toBe(200);
 expect((await serve(request('/api/board'))).status).toBe(200);
});
test('演示构建替换认证模块，不包含 OIDC 流程或生产会话存储键',async()=>{
 // 在独立 Bun 进程中验证真实构建，避免 bun test 的模块解析缓存影响打包器。
 const built=Bun.spawnSync([process.execPath,'-e',"const {buildDemo}=await import('./demo/server.ts');console.log(await(await buildDemo()).text());"],{cwd:resolve(import.meta.dir,'..')});
 expect(built.exitCode).toBe(0);
 const js=built.stdout.toString();
 expect(js).toContain('进入本地设计预览');expect(js).toContain('sck.design.logged-in');
 expect(js).not.toContain('sck.owner.session');expect(js).not.toContain('code_challenge_method');
});

test('生产导出脚本仅请求固定只读接口，下载文件不含会话或客户正文',async()=>{
 const built=Bun.spawnSync([process.execPath,'build','./demo/export.ts','--target','browser','--format','iife'],{cwd:resolve(import.meta.dir,'..')});
 expect(built.exitCode).toBe(0);
 const data=seed();data.requirements[0]!.problem='PRIVATE_CUSTOMER_TEXT';
 const calls:string[]=[];let download:Blob|undefined;
 const {runInNewContext}=await import('node:vm');
 const script=runInNewContext(built.stdout.toString(),{
  location:{origin:'https://company.maplayer.top'},
  sessionStorage:{getItem:()=>JSON.stringify({accessToken:'PRIVATE_SESSION_TOKEN'})},
  fetch:async(path:string,init:RequestInit)=>{
   expect(path).toBe('/api/cmd');const {command}=JSON.parse(String(init.body));calls.push(command);
   const results:Record<string,unknown>={'product.iteration.list':{products:data.products},'requirement.list':{requirements:data.requirements},'feedback.list':{feedback:[]},'task.list':{tasks:data.tasks},'agent.list':{roles:data.agents.map(a=>({role:a.role,defs:[],onDuty:[],policy:a.policy}))},'note.list':{notes:data.notes}};
   if(!(command in results))throw Error('不允许的请求');return Response.json({ok:true,result:results[command]});
  },Blob,AbortSignal,URL:{createObjectURL:(blob:Blob)=>{download=blob;return'blob:local';},revokeObjectURL:()=>{}},
  document:{createElement:()=>({click:()=>{}})},setTimeout:(fn:()=>void)=>fn(),console:{info:()=>{},error:(message:string)=>{throw Error(message);}},
 });
 await script;
 // IIFE 输出包含异步入口，等待微任务链完成，不发真实网络请求。
 for(let i=0;i<100&&!download;i++)await Promise.resolve();
 expect(download).toBeDefined();const text=await download!.text();
 expect(text).not.toContain('PRIVATE_SESSION_TOKEN');expect(text).not.toContain('PRIVATE_CUSTOMER_TEXT');
 expect(parseSnapshot(JSON.parse(text)).requirements.length).toBe(9);
 expect(calls).not.toContain('db.write');expect(calls).not.toContain('db.read');
});

test('仓库生产快照可直接加载，关联有效且本地修改不污染快照', async()=>{
 const original=await Bun.file(resolve(import.meta.dir,'../demo/production.snapshot.json')).json();
 expect(original.source).toBe('sanitized-production');
 const data=parseSnapshot(original);
 expect([data.products.length,data.requirements.length,data.feedback.length,data.tasks.length,data.agents.length,data.notes.length]).toEqual([3,1,1,13,1,88]);
 const store=new DemoStore(data);
 for(const row of data.requirements)expect(data.products.some(p=>p.id===row.project)).toBe(true);
 for(const row of data.feedback){expect(data.products.some(p=>p.id===row.project)).toBe(true);if(row.requirement)expect(data.requirements.some(r=>r.id===row.requirement)).toBe(true);}
 const before=JSON.stringify(original);
 store.command('requirement.create',{project:data.products[0]!.id,title:'设计师本地新增',problem:'测试本地编辑',acceptance:'只修改内存'});
 expect(store.data.requirements.length).toBe(2);
 store.reset();expect(store.data.requirements.length).toBe(1);
 expect(JSON.stringify(await Bun.file(resolve(import.meta.dir,'../demo/production.snapshot.json')).json())).toBe(before);
});

test('会议室 4/8 人案例和项目进度来自同一份内存任务，重置不会污染来源快照',async()=>{
 const {DemoRuntime}=await import('../demo/runtime.ts');
 const source=seed(),before=JSON.stringify(source),store=new DemoStore(source),runtime=new DemoRuntime(store);
 expect(runtime.snapshot().projects?.map(p=>p.id)).toEqual(expect.arrayContaining(source.products.map(p=>p.id)));
 for(const count of [4,8,4]){
   expect(runtime.crowd()).toMatchObject({employees:count,project:'design-crowd'});
   const snapshot=runtime.snapshot();
   const room=snapshot.projects!.find(p=>p.id==='design-crowd')!;
   const employees=snapshot.agents.filter(a=>a.project?.id===room.id);
   expect(employees).toHaveLength(count);
   expect(new Set(employees.map(a=>a.taskId)).size).toBe(count);
   expect(room.progress).toMatchObject({done:2,total:2*count+2,percent:Math.round(2/(2*count+2)*100)});
   expect(room.blocked).toBe(1);expect(room.estimate.status).toBe('unavailable');
   expect(room.estimateReason).toBe('存在阻塞');
   expect(room.pendingMessages).toHaveLength(count);
   for(const employee of employees){
     expect(employee.name).toContain('【设计案例】');
     expect(employee.model).toBeTruthy();expect(employee.activity?.checklist?.total).toBe(7);
     expect(employee.pendingMessages).toHaveLength(1);
     const message=employee.pendingMessages![0]!;
     expect(message.assignment).toBe('candidate');
     expect(message.taskId).not.toBe(employee.taskId);
     expect(employee.next?.taskId).toBe(message.taskId);
     expect(message.stage).toBe(employee.taskState==='blocked'?'later':'next');
     expect(store.messages.find(m=>m.messageId===message.messageId)?.step).toBe(employee.role==='qa'?'review':'execute');
     expect(store.data.tasks.some(t=>t.id===message.taskId&&t.project===room.id)).toBe(true);
     expect(store.data.tasks.some(t=>t.id===employee.taskId)).toBe(true);
   }
   expect(employees.filter(a=>a.state==='running').every(a=>a.estimate?.status==='estimated')).toBe(true);
 }
 expect(JSON.stringify(source)).toBe(before);
 runtime.reset();store.reset();
 expect(runtime.snapshot().projects?.some(p=>p.id==='design-crowd')).toBe(false);
 expect(store.data.agents).toEqual(source.agents);
});

test('本地消息编辑采用正文比较，拒绝冲突和已发送消息，页面读到保存后的同一正文',async()=>{
 const {DemoRuntime}=await import('../demo/runtime.ts');
 const store=new DemoStore(seed()),runtime=new DemoRuntime(store);runtime.crowd();
 const message=store.messages.find(m=>m.messageId.startsWith('design-crowd-'))!;
 const original=message.body;
 store.command('message.edit',{messageId:message.messageId,body:'【设计案例】老板修改后的工作要求',expectedBody:original});
 expect(()=>store.command('message.edit',{messageId:message.messageId,body:'旧窗口覆盖',expectedBody:original})).toThrow('消息已被修改');
 const snapshot=runtime.snapshot();
 expect(snapshot.agents.find(a=>a.id===message.candidateEmployeeId)!.pendingMessages![0]!.preview).toBe(message.body);
 expect(snapshot.projects!.find(p=>p.id==='design-crowd')!.pendingMessages.find(m=>m.messageId===message.messageId)!.body).toBe(message.body);
 expect(snapshot.agents.find(a=>a.id===message.candidateEmployeeId)!.pendingMessages![0]!.context?.files.some(f=>f.name==='task.md'&&f.text.includes('验收'))).toBe(true);
 store.command('message.send',{messageId:message.messageId});
 expect(()=>store.command('message.edit',{messageId:message.messageId,body:'不能重写'})).toThrow('消息已发送');
 expect(store.board().messages?.some(m=>m.messageId===message.messageId)).toBe(false);
 expect(runtime.snapshot().agents.flatMap(a=>a.pendingMessages??[]).some(m=>m.messageId===message.messageId)).toBe(false);
 expect(()=>store.command('message.edit',{messageId:'missing',body:'不存在'})).toThrow('本地记录不存在');
});

test('4/8 人交接案例覆盖隔人、跨排与离场头像，关联当前任务且不增加在场人数',async()=>{
 const {withDesignCases}=await import('../demo/data.ts');
 const {DemoRuntime}=await import('../demo/runtime.ts');
 const {roomAgents,roomHandoffs}=await import('../src/ui/meeting-rooms.ts');
 const source=withDesignCases(seed()),before=JSON.stringify(source),store=new DemoStore(source),runtime=new DemoRuntime(store);
 const project='design-crowd',employee=(position:number)=>`${project}-employee-${position}`;
 const departed=`${project}-previous-engineer`;
 for(const count of [4,8]){
   runtime.crowd();
   if(count===4)expect(runtime.snapshot().transfers).toHaveLength(0);
   for(const kind of ['review','rework'] as const){
     runtime.transfer();
     const snapshot=runtime.snapshot(),present=roomAgents(snapshot,project);
     expect(present).toHaveLength(count);
     expect(present.some(a=>a.id===departed)).toBe(false);
     const previous=snapshot.agents.find(a=>a.id===departed)!;
     expect(previous.state).toBe('idle');
     expect(previous.taskId).toBeUndefined();expect(previous.project).toBeUndefined();
     const base=snapshot.transfers.find(t=>t.id.startsWith('design-transfer-'))!;
     expect(base.kind).toBe(kind);
     expect(snapshot.agents.find(a=>a.id===base.to)?.taskId).toBe(base.taskId);
     expect(snapshot.agents.find(a=>a.id===base.from)?.state).toBe('idle');
     const handoffs=roomHandoffs(snapshot,project,new Set());
     expect(handoffs.transfers.map(t=>[t.from,t.to])).toEqual([
       [employee(1),employee(3)],
       [employee(2),employee(count===8?7:4)],
       [departed,employee(count===8?8:2)],
     ]);
     expect(new Set(handoffs.transfers.map(t=>t.taskId)).size).toBe(3);
     expect(handoffs.references).toHaveLength(1);
     expect(handoffs.references[0]).toMatchObject({id:departed,status:'已离场'});
     for(const transfer of handoffs.transfers){
       expect(snapshot.agents.some(a=>a.id===transfer.from)).toBe(true);
       expect(present.find(a=>a.id===transfer.to)?.taskId).toBe(transfer.taskId);
       expect(snapshot.events.some(e=>e.id===transfer.id&&e.taskId===transfer.taskId)).toBe(true);
     }
     // 快照重复读取保持关系标识，只有新的演示交接才产生新事件。
     expect(runtime.snapshot().transfers).toEqual(snapshot.transfers);
   }
 }
 expect(JSON.stringify(source)).toBe(before);
 runtime.reset();store.reset();
 expect(runtime.snapshot().transfers).toHaveLength(0);
 expect(store.data.agents.some(a=>String(a.employee).startsWith(project))).toBe(false);
});

test('4/8 人切换与消息编辑经 HTTP 主动推送，人物图片只开放固定文件',async()=>{
 const store=new DemoStore(seed()),serve=handler(store,origin);
 const reader=(await serve(request('/api/events'))).body!.getReader();await reader.read();
 const decoder=new TextDecoder();
 const crowd=await serve(request('/api/demo/crowd',{}));expect(crowd.status).toBe(200);
 expect((await crowd.json()).result.employees).toBe(4);
 expect(decoder.decode((await reader.read()).value)).toContain('event: change');
 const message=store.messages.find(m=>m.messageId.startsWith('design-crowd-'))!;
 const body=message.body;
 expect((await serve(request('/api/cmd',{command:'message.edit',input:{messageId:message.messageId,body:'【设计案例】HTTP 更新',expectedBody:body}}))).status).toBe(200);
 expect(decoder.decode((await reader.read()).value)).toContain('event: change');
 expect((await serve(request('/api/cmd',{command:'message.edit',input:{messageId:message.messageId,body:'过期写入',expectedBody:body}}))).status).toBe(409);
 const snapshot=(await (await serve(request('/api/dashboard'))).json()).result;
 expect(snapshot.agents.flatMap((a:any)=>a.pendingMessages??[]).find((m:any)=>m.messageId===message.messageId).body).toBe('【设计案例】HTTP 更新');
 const css=await Bun.file(resolve(import.meta.dir,'../public/app.css')).text();
 const paths=[...new Set([...css.matchAll(/url\('(\/people\/[^']+\.webp)'\)/g)].map(match=>match[1]!))];
 expect(paths).toHaveLength(3);
 const headers=await Bun.file(resolve(import.meta.dir,'../public/_headers')).text();
 expect(headers.split('\n').filter(line=>line.startsWith('/')).sort()).toEqual([...paths].sort());
 let bytes=0;
 for(const path of paths){
   const image=await serve(request(path));
   expect(image.status).toBe(200);expect(image.headers.get('content-type')).toBe('image/webp');
   expect(image.headers.get('cache-control')).toBe('no-store'); // 本地设计刷新继续读取修改。
   const body=Buffer.from(await image.arrayBuffer());bytes+=body.byteLength;
   expect(body.toString('ascii',0,4)).toBe('RIFF');expect(body.toString('ascii',8,12)).toBe('WEBP');
   expect(path).toContain(`.${createHash('sha256').update(body).digest('hex').slice(0,12)}.webp`);
   expect(headers).toContain(`${path}\n  Cache-Control: public, max-age=31536000, immutable`);
 }
 expect(bytes).toBeLessThan(500_000);
 const redirects=await Bun.file(resolve(import.meta.dir,'../public/_redirects')).text();
 const rules=redirects.split('\n').filter(line=>line.startsWith('/')).map(line=>line.split(/\s+/));
 expect(rules).toHaveLength(3);
 for(const [legacy,target,status] of rules){
   expect(legacy).toMatch(/^\/people\/(team-atlas|meeting-room|office-closeup)\.png$/);
   expect(paths).toContain(target!);expect(status).toBe('302');
   const response=await serve(request(legacy!));expect(response.status).toBe(302);
   expect(response.headers.get('location')).toBe(target!);expect(response.headers.get('cache-control')).toBe('no-store');
   expect(await Bun.file(resolve(import.meta.dir,'../public'+legacy)).exists()).toBe(false);
 }
 for(const path of ['/people/other.webp','/people/other.png'])
   expect((await serve(request(path))).status).toBe(404);
 await reader.cancel();
});

test('已上线设计案例的计划只含实施步骤，不虚增未派工范围',async()=>{
 const {withDesignCases}=await import('../demo/data.ts');
 const {DemoRuntime}=await import('../demo/runtime.ts');
 const store=new DemoStore(withDesignCases(seed()));
 const released=store.data.requirements.filter(r=>r.state==='released'&&r.id.startsWith('design-req-'));
 for(const r of released){
   const run=store.executions.get(r.id)!;
   expect(run.plan.steps.length+2).toBe(run.tasks.length);
   expect(run.tasks.every((id:string)=>store.data.tasks.find(t=>t.id===id)?.state==='done')).toBe(true);
 }
 // 保留一个已完成范围，确认与生产范围算法一致。
 const r=released[0]!;
 store.data.requirements=[r];
 store.data.products=store.data.products.filter(p=>p.id===r.project);
 const ids=store.executions.get(r.id)!.tasks;
 store.data.tasks=store.data.tasks.filter(t=>ids.includes(t.id));
 const room=new DemoRuntime(store).snapshot().projects!.find(p=>p.id===r.project)!;
 expect(room.progress.percent).toBe(100);expect(room.queued).toBe(0);
});

test('演示只展示调度可消费的最新派工模板，不把系统提醒当作可修改的待发工作',async()=>{
 const {DemoRuntime}=await import('../demo/runtime.ts');
 const store=new DemoStore(seed()),runtime=new DemoRuntime(store);runtime.crowd();
 const first=store.messages.find(m=>m.messageId==='design-crowd-message-1')!;
 store.messages.push({...first,messageId:'design-newest-template',body:'【设计案例】最新候选派工正文'});
 for(const step of ['nudge','notice'])store.messages.push({...first,messageId:`design-ignored-${step}`,step});
 const snapshot=runtime.snapshot(),employee=snapshot.agents.find(a=>a.id===first.candidateEmployeeId)!;
 expect(employee.pendingMessages).toHaveLength(1);
 expect(employee.pendingMessages![0]).toMatchObject({messageId:'design-newest-template',assignment:'candidate',stage:'next'});
 expect(snapshot.projects!.flatMap(p=>p.pendingMessages).some(m=>m.messageId.startsWith('design-ignored-'))).toBe(false);
});
