import { expect, test } from 'bun:test';
import { parseSnapshot, sanitize, seed } from '../demo/data.ts';
import { DemoStore } from '../demo/store.ts';
import { handler } from '../demo/server.ts';
import { resolve } from 'node:path';

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
   const results:Record<string,unknown>={'product.iteration.list':{products:data.products},'requirement.list':{requirements:data.requirements},'feedback.list':{feedback:[]},'task.list':{tasks:data.tasks},'agent.list':{agents:data.agents},'note.list':{notes:data.notes}};
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
