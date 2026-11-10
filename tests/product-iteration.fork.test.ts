import { createHmac } from 'node:crypto';
import { beforeAll, afterAll, test, expect, setDefaultTimeout } from 'bun:test';
import { Surreal } from 'surrealdb';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Requirements } from '../src/iteration/requirements.ts';

setDefaultTimeout(60000);
async function denied(promise:Promise<unknown>,reason:string){const error=await promise.then(()=>'',e=>String(e));expect(error).toContain(reason);}
const run=process.env.RUN_SCK_ITERATION_TESTS==='1'?test:test.skip;
let endpoint:string;
const sessions:Surreal[]=[];
const secret="iteration-fixture-key-0123456789-abcdefgh";
let db:Surreal, store:Requirements, dir:string, server:ReturnType<typeof Bun.spawn>;
beforeAll(async()=>{
  if(process.env.RUN_SCK_ITERATION_TESTS!=='1')return;
  dir=realpathSync(mkdtempSync(join(tmpdir(),'sck-iteration-')));
  const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('ok')});const port=probe.port!;probe.stop(true);
  server=Bun.spawn([join(homedir(),'.surrealdb/surreal'),'start','--bind',`127.0.0.1:${port}`,'--user','root','--pass','fixture','--log','error',`rocksdb:${dir}/db`],{stdout:'ignore',stderr:'ignore'});
  for(let i=0;i<160;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await Bun.sleep(25);}
  endpoint=`ws://127.0.0.1:${port}/rpc`;db=new Surreal();await db.connect(endpoint);await db.signin({username:'root',password:'fixture'});
  await db.query('DEFINE NAMESPACE iteration; USE NS iteration; DEFINE DATABASE fixture;');await db.use({namespace:'iteration',database:'fixture'});
  await db.query('DEFINE TABLE project SCHEMALESS; CREATE project:sample SET name="测试产品";');
  await db.query(readFileSync(join(import.meta.dir,'../schema/063-product-iteration.surql'),'utf8'));
  for(const access of ['owner','gateway','runner','automation'])await db.query(`DEFINE ACCESS ${access} ON DATABASE TYPE JWT ALGORITHM HS512 KEY '${secret}';`);
  store=new Requirements(db);
},20000);
afterAll(async()=>{for(const session of sessions)await session.close();if(db)await db.close();if(server){server.kill();await server.exited;}if(dir)rmSync(dir,{recursive:true,force:true});});
const content={project:'sample',title:'反馈检索',problem:'反馈越来越多，需要检索',acceptance:'输入关键字能返回匹配反馈',priority:2};

run('需求独立于任务，配置缺失或验收未填写不能开工',async()=>{
  const r=await store.create(content,'owner');expect(r.state).toBe('pending');
  await expect(store.approve(r.id,1,'owner')).rejects.toThrow('请先启用');
  await store.configure('sample',{enabled:true,autoRelease:false,feedbackOrigins:['https://sample.example']},'owner');
  const empty=await store.create({...content,acceptance:''},'owner');
  await expect(store.approve(empty.id,1,'owner')).rejects.toThrow('验收标准');
  expect((await store.get(empty.id)).state).toBe('pending');
});
run('陈旧编辑和确认均拒绝，不会把旧文案签为新修订',async()=>{
  const r=await store.create(content,'owner');
  const updated=await store.edit(r.id,1,{title:'反馈全文检索'},'owner');expect(updated.revision).toBe(2);
  await expect(store.edit(r.id,1,{title:'陈旧窗口'},'owner')).rejects.toThrow('需求已被修改');
  await expect(store.approve(r.id,1,'owner')).rejects.toThrow('需求已被修改');
  const approved=await store.approve(r.id,2,'owner');expect(approved.content.title).toBe('反馈全文检索');
  await expect(store.edit(r.id,2,{title:'未重新确认的修改'},'owner')).rejects.toThrow();
});
run('确认快照不可随产品配置漂移，重复确认幂等且审批后尚无任务',async()=>{
  const r=await store.create(content,'owner');const first=await store.approve(r.id,1,'owner');
  await store.configure('sample',{enabled:false,autoRelease:false,feedbackOrigins:[]},'owner');
  expect(await store.approve(r.id,1,'owner')).toEqual(first);
  const req=await store.get(r.id);expect(req.state).toBe('queued');expect(req.root_task).toBeUndefined();
  const [rows]=await db.query<[unknown[]]>('SELECT * FROM requirement_approval WHERE requirement=$id',{id:r.id});expect(rows).toHaveLength(1);
  expect(first.policy.enabled).toBe(true);
});

async function sessionFor(ac:string){
  const now=Math.floor(Date.now()/1000);
  const b64=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const head=b64({alg:'HS512',typ:'JWT'}),body=b64({ns:'iteration',db:'fixture',ac,rl:['Editor'],sub:'test-'+ac,iat:now,nbf:now,exp:now+600});
  const token=`${head}.${body}.${createHmac('sha512',secret).update(`${head}.${body}`).digest('base64url')}`;
  const conn=new Surreal();await conn.connect(endpoint);await conn.use({namespace:'iteration',database:'fixture'});await conn.authenticate(token);sessions.push(conn);return conn;
}
run('真实 JWT 身份：员工网关、执行端、自动整理均不能代签；老板也不能改删已签快照',async()=>{
  for(const ac of ['gateway','runner','automation']){
    const conn=await sessionFor(ac);
    await denied(conn.query('CREATE requirement_approval CONTENT {requirement:"forged",revision:1,snapshot:"{}"};'),'requires owner');
    await denied(conn.query('UPDATE product_iteration:sample SET policy="{}";'),'requires owner');
  }
  const owner=await sessionFor('owner');const requirements=new Requirements(owner);
  await requirements.configure('sample',{enabled:true,autoRelease:false,feedbackOrigins:[]},'owner');
  const r=await requirements.create(content,'owner');await requirements.approve(r.id,1,'owner');
  await denied(owner.query('UPDATE requirement_approval SET snapshot="forged" WHERE requirement=$id;',{id:r.id}),'immutable');
  await denied(owner.query('DELETE requirement_approval WHERE requirement=$id;',{id:r.id}),'immutable');
});

run('真实反馈到需求：幂等接收、限流、去掉联系信息、只生成待确认草稿',async()=>{
  const {receiveFeedback}=await import('../src/iteration/feedback.ts');
  const {triageFeedback}=await import('../src/iteration/triage.ts');
  await store.configure('sample',{enabled:true,autoRelease:false,feedbackOrigins:['https://sample.example']},'owner');
  const input={requestKey:'feedback-test-001',text:'无法保存设置',page:'https://sample.example/settings?secret=hidden',contact:'private@example.com'};
  const receipt=await receiveFeedback(db,'sample','https://sample.example','192.0.2.1',input);
  expect(await receiveFeedback(db,'sample','https://sample.example','192.0.2.1',input)).toEqual(receipt);
  const triage=await triageFeedback(db,async input=>{
    expect(input.feedback.contact).toBe('');expect(input.feedback.page).toBe('https://sample.example/settings');
    return {disposition:'new',category:'bug',reason:'可整理为缺陷',title:'修复保存设置',problem:'点击保存没有生效',acceptance:'保存后刷新保留新值',priority:1};
  });
  expect(triage.linked).toBe(1);
  const req=await store.get('feedback-'+receipt.id);expect(req.state).toBe('pending');expect(req.approved_revision).toBeUndefined();
  for(let i=1;i<20;i++)await receiveFeedback(db,'sample','https://sample.example','192.0.2.1',{...input,requestKey:`feedback-test-${i+100}`});
  await denied(receiveFeedback(db,'sample','https://sample.example','192.0.2.1',{...input,requestKey:'feedback-too-many'}),'过于频繁');
});

run('确认后规划与执行可恢复，暂停不推进，手动发布门禁及生产证据完整才闭环',async()=>{
  const {planRequirements}=await import('../src/iteration/planning.ts');
  const {reconcileIterations}=await import('../src/iteration/execution.ts');
  const {RecordId}=await import('surrealdb');
  await db.query("UPDATE product_requirement SET state='paused' WHERE state='queued';");
  await store.configure('sample',{enabled:true,autoRelease:false,feedbackOrigins:[],releaseInstructions:'按项目发布工作流部署',verifyInstructions:'检查生产版本及保存行为',rollbackInstructions:'回退到上一成功版本'},'owner');
  const req=await store.create(content,'owner');
  let planCalls=0;
  const planner=async()=>{planCalls++;return {steps:[{title:'实现反馈检索',context:'实现检索并添加真实检索测试',acceptance:'检索结果符合输入关键字'}]};};
  let now=Date.now()+1000;
  expect((await planRequirements(db,planner,now)).planned).toBe(0);expect(planCalls).toBe(0);
  await store.approve(req.id,1,'owner');
  const automation=await sessionFor('automation');
  expect((await planRequirements(automation,planner,now)).planned).toBe(1);
  expect((await planRequirements(automation,planner,now+180000)).planned).toBe(0);expect(planCalls).toBe(1);
  const taskIds=new Map<string,string>();let interrupt=true;
  const host={create:async(input:import('../src/contracts.ts').CreateTask)=>{
    let id=taskIds.get(input.idempotencyKey);
    if(!id){id=crypto.randomUUID();taskIds.set(input.idempotencyKey,id);await db.query('CREATE $id CONTENT {state:"ready",title:$title};',{id:new RecordId('task',id),title:input.title});}
    if(interrupt){interrupt=false;throw new Error('simulate crash after task creation');}
    return {id};
  }};
  const tick=()=>reconcileIterations(db,host,now+=180000);
  expect((await tick()).failed).toBe(1);expect(taskIds.size).toBe(1);
  expect((await tick()).advanced).toBe(1);expect(taskIds.size).toBe(1);
  await store.control(req.id,1,'pause','owner');await tick();expect(taskIds.size).toBe(1);
  await store.control(req.id,1,'resume','owner');await tick();expect(taskIds.size).toBe(1);
  const finish=async()=>{const id=[...taskIds.values()].at(-1)!;await db.query('UPDATE $id SET state="done";',{id:new RecordId('task',id)});return id;};
  await finish();await tick();expect(taskIds.size).toBe(2);
  await finish();await tick();expect(taskIds.size).toBe(2);expect((await store.get(req.id)).state).toBe('release_pending');
  const owner=await sessionFor('owner');await new Requirements(owner).approveRelease(req.id,1,'owner');
  await tick();expect(taskIds.size).toBe(3);
  const deploy=await finish();await tick();expect(taskIds.size).toBe(3);expect((await store.get(req.id)).state).toBe('release_pending');
  const ref=new RecordId('task',deploy);
  await db.query('UPDATE $task SET acceptance_head="abcdef", acceptance_attempt=2; CREATE acceptance_evidence CONTENT { task:$task,verified:true,sha:"wrong",environment:"production",attempt:2,kind:"machine",verifier:"github-actions",source:{deployment:{deploymentId:"fixture"}} };',{task:ref});
  await tick();expect(taskIds.size).toBe(3);
  await db.query('UPDATE acceptance_evidence SET sha="abcdef" WHERE task=$task; CREATE acceptance_evidence CONTENT {task:$task,verified:true,sha:"abcdef",environment:"production",attempt:2,kind:"human",verifier:"reviewer",source:{}};',{task:ref});
  await tick();expect(taskIds.size).toBe(4);expect((await store.get(req.id)).state).toBe('release_pending');
  await finish();await tick();expect((await store.get(req.id)).state).toBe('released');
  await tick();expect(taskIds.size).toBe(4);
});

run('多个接收者并发重放同一反馈只落一条；整理失败有上限且可人工恢复',async()=>{
  const {receiveFeedback}=await import('../src/iteration/feedback.ts');
  const {triageFeedback}=await import('../src/iteration/triage.ts');
  const {retryFeedback}=await import('../src/iteration/inspection.ts');
  await store.configure('sample',{enabled:true,autoRelease:false,feedbackOrigins:['https://sample.example']},'owner');
  const input={requestKey:'parallel-feedback-001',text:'并发反馈',page:'https://sample.example/'};
  const replies=await Promise.all(Array.from({length:4},()=>receiveFeedback(db,'sample','https://sample.example','192.0.2.44',input)));
  expect(new Set(replies.map(r=>r.id)).size).toBe(1);
  await db.query("UPDATE product_feedback SET state='dismissed' WHERE request_key!=$key;",{key:input.requestKey});
  for(let i=0;i<3;i++)await triageFeedback(db,async()=>{throw new Error('upstream failure');});
  const [rows]=await db.query<[Array<{id:import('surrealdb').RecordId;state:string;attempts:number}>]>('SELECT * FROM product_feedback WHERE request_key=$key;',{key:input.requestKey});
  expect(rows[0]?.state).toBe('failed');expect(rows[0]?.attempts).toBe(3);
  await retryFeedback(db,String(rows[0]!.id.id),'owner');
  const out=await triageFeedback(db,async()=>({disposition:'dismiss',category:'noise',reason:'测试反馈'}));expect(out.dismissed).toBe(1);
});

run('完整公司 schema 与真实 core：幂等建规划单、真实租约提交评审、工程任务建立及消息恢复',async()=>{
  const {CompanyDatabase}=await import('../src/database.ts');
  const {SurrealCompanyCore}=await import('../src/core.ts');
  const {LocalEnrollmentAdmin}=await import('../src/enrollment.ts');
  const {OutboundMessageStore}=await import('../src/outbound-messages.ts');
  const {reconcileIterations,iterationMessages}=await import('../src/iteration/execution.ts');
  const {planRequirements}=await import('../src/iteration/planning.ts');
  const database=new CompanyDatabase({url:endpoint,rootUser:'root',rootPassword:'fixture',namespace:'iteration_core',database:'fixture'});
  try{
    await database.connect();await database.bootstrap();
    const core=new SurrealCompanyCore(database),enrollment=new LocalEnrollmentAdmin(database),messages=new OutboundMessageStore(database.db);
    const owner=await enrollment.enroll('fixture-owner','owner',['execute','review','manage']);
    const product=await enrollment.enroll('fixture-product','product',['execute','review']);
    const qa=await enrollment.enroll('fixture-qa','qa',['execute','review']);
    await database.db.query('CREATE project:sample CONTENT { name:"产品", repo_path:$repo, default_branch:"main" };',{repo:process.cwd()});
    const requirements=new Requirements(database.db);
    await requirements.configure('sample',{enabled:true,autoRelease:false,feedbackOrigins:[]},'owner');
    const req=await requirements.create(content,'owner');await requirements.approve(req.id,1,'owner');
    let now=Date.now();await planRequirements(database.db,async()=>({steps:[{title:'实现检索测试',context:'为检索实现增加测试',acceptance:'检索用例通过'}]}),now);
    const host={create:async(input:import('../src/contracts.ts').CreateTask)=>{const task=await core.createTask(owner,input);await messages.createTaskDrafts(task.id,task.executorRole,task.reviewerRole,input.workIntent?.kind==='code',iterationMessages(input));return task;}};
    expect((await reconcileIterations(database.db,host,now+=180000)).failed).toBe(0);
    const planning=(await requirements.get(req.id)).root_task!;expect(planning).toBeTruthy();
    const claim=await core.claim(product,planning);
    await core.submit(product,{taskId:planning,deliveryId:claim.deliveryId,fence:claim.fence,expectedVersion:claim.task.version},{text:'测试 fixture 核对计划符合验收，仓库与测试入口已确认',idempotencyKey:'iteration-plan-submit'});
    const review=await core.claim(qa,planning);
    await core.accept(qa,{taskId:planning,deliveryId:review.deliveryId,fence:review.fence,expectedVersion:review.task.version},{text:'测试 fixture 独立复核通过：计划覆盖验收要求，测试入口与仓库已核对',idempotencyKey:'iteration-plan-review'});
    const advance=await reconcileIterations(database.db,host,now+=180000);expect(advance.failed).toBe(0);expect(advance.advanced).toBe(1);
    const tasks=await core.listTasks(owner);expect(tasks.length).toBe(1);expect((await core.getTask(owner,planning)).state).toBe('done');
    const engineering=tasks.find(t=>t.executorRole==='engineering')!;expect(engineering.parent).toBe(planning);expect(engineering.workIntent?.kind).toBe('code');expect(engineering.projectOverlay).toBe('sample');
    const drafts=await messages.list(engineering.id);expect(drafts).toHaveLength(2);expect(drafts.find(m=>m.step==='execute')?.body).toContain('不要合并 PR');
    await database.db.query("UPDATE outbound_message SET state='sent' WHERE task=$task;",{task:new (await import('surrealdb')).RecordId('task',engineering.id)});
    await messages.createTaskDrafts(engineering.id,'engineering','qa',true,{includeSent:true});expect(await messages.list(engineering.id)).toHaveLength(2);
  }finally{await database.close();}
});

run('公开反馈 HTTP：来源隔离、预检、JSON 与体积限制、仅返回收件号',async()=>{
  const {handleFeedbackRequest}=await import('../owner-end/src/feedback.ts');
  const origin='https://sample.example';
  await store.configure('sample',{enabled:true,autoRelease:false,feedbackOrigins:[origin]},'owner');
  const send=(method:string,source:string,body?:string,contentType='application/json')=>handleFeedbackRequest(new Request('https://company.example/api/feedback/sample',{method,headers:{origin:source,'content-type':contentType,'cf-connecting-ip':'192.0.2.55'},body}),db,'sample');
  expect((await send('OPTIONS','https://other.example')).status).toBe(403);
  const preflight=await send('OPTIONS',origin);expect(preflight.status).toBe(204);expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
  expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
  expect((await send('POST',origin,'not-json')).status).toBe(400);
  expect((await send('POST',origin,'{}','text/plain')).status).toBe(400);
  expect((await send('POST',origin,'x'.repeat(32001))).status).toBe(400);
  const response=await send('POST',origin,JSON.stringify({requestKey:'public-endpoint-test',text:'页面无法保存',page:origin+'/settings?private=yes'}));
  expect(response.status).toBe(202);const body=await response.json();expect(Object.keys(body.result)).toEqual(['id']);
  const wrong=await send('POST','https://other.example',JSON.stringify({requestKey:'public-endpoint-test',text:'页面无法保存'}));expect(wrong.status).toBe(403);expect(wrong.headers.get('access-control-allow-origin')).toBeNull();
});

run('页面展示的发布策略发生变化时拒绝确认，员工不能伪造发布批准或计划',async()=>{
  const policy=await store.configure('sample',{enabled:true,autoRelease:false,feedbackOrigins:[]},'owner');
  const req=await store.create(content,'owner');
  await store.configure('sample',{...policy,autoRelease:true,releaseInstructions:'受控发布',verifyInstructions:'生产验证',rollbackInstructions:'回退版本'},'owner');
  await denied(store.approve(req.id,1,'owner',policy as unknown as Record<string,unknown>),'策略已变更');
  expect((await store.get(req.id)).state).toBe('pending');
  for(const ac of ['gateway','runner','automation']){
    const conn=await sessionFor(ac);
    await denied(conn.query('CREATE requirement_release_approval CONTENT {requirement:"forged",revision:1,policy:"{}"};'),'requires owner');
    if(ac!=='automation')await denied(conn.query('CREATE requirement_plan CONTENT {body:"{}"};'),'requires automation');
  }
  const before=await store.policy('sample');
  const results=await Promise.allSettled(Array.from({length:3},()=>store.approve(req.id,1,'owner',before as unknown as Record<string,unknown>)));
  expect(results.every(r=>r.status==='fulfilled')).toBe(true);
  const [approvals]=await db.query<[unknown[]]>('SELECT * FROM requirement_approval WHERE requirement=$id;',{id:req.id});expect(approvals).toHaveLength(1);
});
