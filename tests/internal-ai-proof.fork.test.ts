import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { ProjectStore } from '../src/projects.ts';
import { OpsBroker } from '../src/ops/broker.ts';
import { CompanyProofStore } from '../src/ops/proof-store.ts';
import { TOKEN_PLAN_PLAN_TYPE_FREE, PROOF_GOAL, configurationDigest, sha256, APPROVAL_MARKER, type ProofManifest } from '../src/ops/proof-contract.ts';
import { ProofSigner, verifyCompanyProof } from '../src/ops/proof-signer.ts';
import { loadProofFiles } from '../src/ops/proof-files.ts';
import { brokerConfig, FakeWorld, OPS_DIRECT_CLIENT, OPS_DIRECT_REDIRECT, OPS_RESOURCE } from './support/ops-world.ts';
import { disabledSenseNovaFixture } from './support/internal-ai-disabled-fixture.ts';
const enabled = process.env.RUN_COMPANY_PROOF_FORK_TESTS === '1';
const check = test.skipIf(!enabled);
let dir: string, url: string, child: ReturnType<typeof Bun.spawn>, database: CompanyDatabase;
let core: SurrealCompanyCore, projects: ProjectStore, ops: OpsBroker, world: FakeWorld;
let gm: string, author: string, reviewer: string, consumer: string, approvalTask: string, consumerTask: string;
let trusted: ReturnType<ProofSigner['trust']>, manifestPath: string, documentPath: string, manifest: ProofManifest;
let clock = Date.now(); const now = () => clock;
const key = Buffer.alloc(32, 19); // synthetic sealing key, no real service credentials
let delivered: string | undefined;
let identityAvailable = true;
// Trusted-identity read counters at the product boundary: one full identities resolution reads
// /api/internal-ai/identity once per manifest alias (two aliases → two reads).
let identityReads = 0, identityFailAfter = 0, identityDelayMs = 0;
async function connect() {
  database = new CompanyDatabase({url: url + '/rpc', rootUser:'root', rootPassword:'root', namespace:'proof_test', database:'control_plane'});
  await database.connect(); await database.bootstrap(); core = new SurrealCompanyCore(database); projects = new ProjectStore(database.db);
}
async function start() {
  const binary = join(homedir(), '.surrealdb/surreal');
  child = Bun.spawn([binary, 'start', '--no-banner', '--log', 'none', '--bind', url.replace('ws://',''), '--user','root','--pass','root','rocksdb:' + join(dir,'db')], {stdout:'ignore',stderr:'ignore'});
  for (let i=0;i<100;i++) { const p=Bun.spawn([binary,'is-ready','--endpoint',url],{stdout:'ignore',stderr:'ignore'}); if (await p.exited===0) return; await Bun.sleep(50); }
  throw new Error('company fork unavailable');
}
async function stop() { await database.close(); child.kill(); await child.exited; }
function broker() {
  ops = new OpsBroker({ core, projects, secretKey: () => key, proofStore: new CompanyProofStore(database.db, now), serviceHome:dir, now,
    fetch: async (input, init) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (u.pathname === '/api/internal-ai/identity') {
        identityReads++;
        if (identityDelayMs) clock += identityDelayMs; // 注入 IdP 慢读：假时钟前进，验证解析不在 60 秒窗内
        if (identityFailAfter > 0 && identityReads > identityFailAfter) return Response.json({}, {status:503});
        if (!identityAvailable) return Response.json({}, {status:404});
        const token = new Headers(init?.headers).get('authorization')!.slice(7);
        const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {sub:string};
        const owner = world.user('sck-lca04-removable')!;
        const member = world.workspaces.get('sck-ui01')!.members.find(m => m.subject === payload.sub && !m.disabled);
        if (!member) return Response.json({}, {status:403});
        return Response.json({ subject:payload.sub, spaceId:'workspace:ui01', database:'ws_ui01', workspaceRole:member.isAdmin?'admin':'participant', billingRole:payload.sub===owner.id?'owner':'member', billingAccountRef:'billing_account:ui01' });
      }
      if (u.pathname === '/api/ops/internal-ai/company-proof') { delivered = (JSON.parse(String(init?.body)) as {proof:string}).proof; return Response.json({ok:true}); }
      return world.fetch(input, init);
    },
    queryAsUser: async (input) => {
      const rows = await world.queryAsUser(input) as [Array<{subject:string;is_admin:boolean}>];
      return [rows[0].filter(r => r.subject === input.vars?.subject)];
    },
  });
}
type EvidenceDoc = Record<string, unknown>;
async function files(task: string, type: 'reviewed-service'|'development-disabled'|'reviewed-token-plan' = 'reviewed-service') {
  const root = join(dir, 'evidence', task); await mkdir(root,{recursive:true});
  const base = {schemaVersion:1,type,accountRef:'existing-service-opaque',endpoint:'https://api.openai.com/v1',model:'gpt-4o-mini-2024-07-18',priceRevision:'openai-mini-2026-10-09',sampledAt:new Date(clock-1000).toISOString(),expiresAt:new Date(clock+3_600_000).toISOString()};
  const evidence = type === 'reviewed-token-plan'
    ? {...base,schemaVersion:2,serviceApproved:true,planName:'SenseNova Token Plan 公测档',planSourceUrl:'https://www.sensenova.cn/token-plan',quotaUnit:'points',quotaAmount:100_000,quotaWindowSeconds:18_000,quotaRemaining:90_000,accountPlanType:TOKEN_PLAN_PLAN_TYPE_FREE}
    : {...base,autoTopupDisabled:true,serviceApproved:type==='reviewed-service',currency:'USD',balanceNanoUsd:1_000_000_000};
  const bytes = JSON.stringify(evidence);
  const rest = {schemaVersion:1 as const,goalId:PROOF_GOAL as typeof PROOF_GOAL,project:'surreal_ck' as const,env:'production' as const,activityId:'ui01-internal',workspaceSlug:'sck-ui01',documentHash:sha256(bytes),service:{accountRef:evidence.accountRef,endpoint:evidence.endpoint,model:evidence.model,priceRevision:evidence.priceRevision},budget:{currency:'USD' as const,totalNanoUsd:1_000_000_000,perAttemptNanoUsd:100_000_000,maxAttempts:30,autoTopupDisabled:true as const},identities:[{alias:'LCA04_REMOVABLE' as const,workspaceRole:'admin' as const,billingRole:'owner' as const},{alias:'LCA04_MEMBER' as const,workspaceRole:'participant' as const,billingRole:'member' as const}] as ProofManifest['identities']};
  const m = {...rest,configurationDigest:configurationDigest(rest)};
  const mp=join(root,'internal-ai-manifest.json'),dp=join(root,'internal-ai-evidence.json');
  await writeFile(dp, bytes); await writeFile(mp, JSON.stringify(m));
  return {manifestPath:mp,documentPath:dp,manifest:m,evidence};
}
/** 以同一审批任务重写文档字节并保持 manifest 摘要一致：逐层区分契约拒与配额断言拒。 */
async function rewrite(f: {manifestPath:string,documentPath:string,manifest:ProofManifest}, evidence: EvidenceDoc) {
  const bytes = JSON.stringify(evidence);
  const {configurationDigest:_d, ...rest} = f.manifest;
  const changed = {...rest, documentHash: sha256(bytes)};
  await writeFile(f.documentPath, bytes);
  await writeFile(f.manifestPath, JSON.stringify({...changed, configurationDigest: configurationDigest(changed)}));
}
const proofArgs = (id = 'initial') => ({mode:'enable',approvalTask,manifestPath,documentPath,activityId:'ui01-internal',nonce:'nonce-for-product-'+id,idempotencyKey:id});
async function request(tool:string,args:Record<string,unknown>={}) { return ops.call(consumer,consumerTask,tool,args) as Promise<Record<string,unknown>>; }
async function status(jwt:string, nonce='fresh-status-nonce-0001') {
  const claims = verifyCompanyProof(jwt,trusted,'proof',clock);
  const bearer = (claims.status as {bearer:string}).bearer;
  const response=await ops.proofStatus(new Request('http://preview.local/internal-ai/status',{headers:{authorization:'Bearer '+bearer,'x-sck-nonce':nonce}}));
  const body=await response.json() as {status:string};
  return verifyCompanyProof(body.status,trusted,'status',clock);
}
beforeAll(async () => {
  if (!enabled) return;
  dir=await realpath(await mkdtemp(join(tmpdir(),'company-proof-fork-')));
  const port=await new Promise<number>(resolve => {const s=createServer();s.listen(0,'127.0.0.1',()=>{const a=s.address() as {port:number};s.close(()=>resolve(a.port));});});
  url='ws://127.0.0.1:'+port; await start(); await connect();
  const enroll=new LocalEnrollmentAdmin(database);
  gm=await enroll.enroll('test-gm','gm',['execute','review','manage']);
  author=await enroll.enroll('test-author','engineering',['execute','review']);
  reviewer=await enroll.enroll('test-reviewer','qa',['execute','review']);
  consumer=await enroll.enroll('test-consumer','engineering',['execute','review']);
  await projects.upsert({id:'surreal_ck',name:'synthetic',repoPath:dir,release:'synthetic',envs:[{name:'production',broker:brokerConfig({idp:{issuer:'https://idp.test/t/ck',clientId:'client-ck-1234',audience:'https://auth.test',redirectUri:'https://app.test/auth/callback',ops:{clientId:OPS_DIRECT_CLIENT,redirectUri:OPS_DIRECT_REDIRECT,audience:OPS_RESOURCE}}})}]});
  await database.db.query('CREATE $goal CONTENT {state:"active",project:$project,anchors:[],tasks:{}};',{goal:new RecordId('goal',PROOF_GOAL),project:new RecordId('project','surreal_ck')});
  world=new FakeWorld(); world.clock=clock;
  for (const alias of ['LCA04_REMOVABLE','LCA04_MEMBER','LCA04_OPS']) {
    const password='synthetic-'+alias; await world.addAccount('sck-'+alias.toLowerCase().replaceAll('_','-'),password);
    await projects.setSecret({project:'surreal_ck',env:'production',name:alias+'_PASSWORD',value:password},key);
  }
  const owner=world.user('sck-lca04-removable')!, member=world.user('sck-lca04-member')!;
  world.workspaces.set('sck-ui01',{slug:'sck-ui01',name:'synthetic',dbName:'ws_ui01',members:[{id:'owner',email:owner.email,displayName:'owner',subject:owner.id,isAdmin:true,disabled:false},{id:'member',email:member.email,displayName:'member',subject:member.id,isAdmin:false,disabled:false}]});
  broker();
  const approval=await core.createTask(gm,{title:'Synthetic service evidence approval',context:'Only test fixtures',executorRole:'engineering',reviewerRole:'qa',goalId:PROOF_GOAL,idempotencyKey:randomUUID()});
  approvalTask=approval.id; const claim=await core.claim(author,approval.id);
  ({manifestPath,documentPath,manifest}=await files(approval.id));
  const prepared=await ops.call(author,approval.id,'ops_internal_ai_prepare',{manifestPath,documentPath}) as {approvalMarker:string};
  await core.submit(author,{taskId:approval.id,deliveryId:claim.deliveryId,fence:claim.fence,expectedVersion:claim.task.version},{text:'Synthetic reviewed files',idempotencyKey:randomUUID()});
  const review=await core.claim(reviewer,approval.id);
  await core.accept(reviewer,{taskId:approval.id,deliveryId:review.deliveryId,fence:review.fence,expectedVersion:review.task.version},{text:prepared.approvalMarker,idempotencyKey:randomUUID()});
  const task=await core.createTask(gm,{title:'Synthetic consuming task',context:'Only test fixtures',executorRole:'engineering',reviewerRole:'qa',goalId:PROOF_GOAL,dependencies:[approvalTask],idempotencyKey:randomUUID()});
  consumerTask=task.id; await core.claim(consumer,task.id);
  trusted=await request('ops_internal_ai_trust') as ReturnType<ProofSigner['trust']>;
},20_000);
afterAll(async()=>{if(enabled){await stop();world.sqlite.close();await rm(dir,{recursive:true,force:true});}});
check('actual versioned SenseNova disabled files prepare an immutable candidate across fork restart without identity or model calls', async () => {
  const preparer = await new LocalEnrollmentAdmin(database).enroll('test-disabled-preparer', 'engineering', ['execute', 'review']);
  const task = await core.createTask(gm, { title: 'Synthetic disabled SenseNova preparation', context: 'No supplier evidence or paid calls', executorRole: 'engineering', reviewerRole: 'qa', goalId: PROOF_GOAL, idempotencyKey: randomUUID() });
  await core.claim(preparer, task.id);
  const fixture = disabledSenseNovaFixture();
  const root = join(dir, 'evidence', task.id); await mkdir(root, { recursive: true });
  const mp = join(root, 'manifest.json'), dp = join(root, 'evidence.json');
  await writeFile(mp, JSON.stringify(fixture.manifest)); await writeFile(dp, fixture.documentBytes);
  const files = await loadProofFiles(dir, task.id, mp, dp);
  const requestsBefore = world.requests.length;
  const prepare = () => ops.call(preparer, task.id, 'ops_internal_ai_prepare', { manifestPath: mp, documentPath: dp });
  expect(await prepare()).toMatchObject({ documentHash: files.documentHash, digest: fixture.manifest.configurationDigest, paidCallsAllowed: 0 });
  const stored = await new CompanyProofStore(database.db, now).candidate(task.id);
  expect(stored?.document_hash).toBe(files.documentHash);
  expect(stored?.manifest_hash).toBe(files.manifestHash);
  expect(world.requests.length).toBe(requestsBefore);
  await stop(); await start(); await connect(); broker();
  expect(await new CompanyProofStore(database.db, now).candidate(task.id)).toEqual(stored);
  expect(await prepare()).toMatchObject({ paidCallsAllowed: 0 });
  // 无审批/未核定资料即使模型格式合法也不签 enable。
  await expect(ops.call(preparer, task.id, 'ops_internal_ai_prove', { mode: 'enable', manifestPath: mp, documentPath: dp, activityId: fixture.manifest.activityId, nonce: 'synthetic-sensenova-nonce', idempotencyKey: 'synthetic-enable' })).rejects.toBeDefined();
  await writeFile(mp, JSON.stringify({ ...fixture.manifest, configurationDigest: '0'.repeat(64) }));
  await expect(prepare()).rejects.toBeDefined();
  expect(world.requests.length).toBe(requestsBefore);
});
check('diagnosis matches real approval marker and actor predicates without changing approval', async () => {
  const store = new CompanyProofStore(database.db, now);
  const loaded = await loadProofFiles(dir, approvalTask, manifestPath, documentPath);
  const lease = await store.lease({taskId: consumerTask, project: 'surreal_ck', actor: {employeeId: String((await core.opsScope(consumer, consumerTask)).actor.employeeId), role: 'engineering', capabilities: []}});
  const before = await store.approval(approvalTask, 'production', loaded);
  const result = await store.diagnoseApproval(approvalTask, 'production', loaded, lease);
  expect(result).toMatchObject({checks: {auditMarkerExactLine: {evaluated:true,matched:true}, auditActorMatchesAcceptedBy: {evaluated:true,matched:true}}, snapshotStable: true});
  expect(await store.approval(approvalTask, 'production', loaded)).toEqual(before);
});
check('real approval, byte hashes, normal alias mapping, encrypted proof and public signature',async()=>{
  await new CompanyProofStore(database.db,now).approval(approvalTask,'production',await loadProofFiles(dir,approvalTask,manifestPath,documentPath));
  const a=await request('ops_internal_ai_prove',proofArgs());
  const b=await request('ops_internal_ai_prove',proofArgs()); expect(b).toEqual(a);
  expect(JSON.stringify(a)).not.toContain('subject'); expect(a.paidCallsAllowed).toBe(1);
  const login=await request('ops_login',{alias:'LCA04_OPS',audience:'ops'});
  await request('ops_internal_ai_deliver',{proofHandle:a.proofHandle,session:login.session});
  expect(delivered).toBeString();
  const payload=verifyCompanyProof(delivered!,trusted,'proof',clock);
  expect(payload.documentHash).toBe(manifest.documentHash); expect(payload.configurationDigest).toBe(manifest.configurationDigest);
  expect((payload.identities as Array<{subject:string}>)[0]!.subject).toBe(world.user('sck-lca04-removable')!.id);
  expect((payload.approval as {action:string}).action).toBe('accept'); expect((await status(delivered!)).valid).toBe(true);
  const [rows]=await database.db.query<[Array<{sealed:unknown}>]>('SELECT sealed FROM internal_ai_proof;');
  expect(JSON.stringify(rows)).not.toContain(delivered!);
  expect(JSON.stringify(a)).not.toContain('PRIVATE KEY');
});
check('status time claims carry the 30s clock margin; a verifier 5.5s behind the signing host still accepts',async()=>{
  // 签约宿主时钟快 +5.5s（生产根因）：产品按真实时间校验，checkedAt/iat 必须不显未来。
  const claims=await status(delivered!,'margin-status-nonce-0001');
  const seconds=Math.floor(clock/1000);
  expect(Number(claims.checkedAt)).toBeGreaterThanOrEqual(seconds-31);
  expect(Number(claims.checkedAt)).toBeLessThanOrEqual(seconds-29);
  expect(Number(claims.iat)).toBe(Number(claims.checkedAt));
  expect(Number(claims.exp)-Number(claims.checkedAt)).toBe(60);
  const productSeconds=(clock-5_500)/1000;
  expect(Number(claims.checkedAt)).toBeLessThanOrEqual(productSeconds);
  expect(Number(claims.iat)).toBeLessThanOrEqual(productSeconds);
});
check('prove resolves identities once per request; IdP failure after the first resolution cannot fail prove; digest comparison retained',async()=>{
  // a) 新签发路径：两 alias 各读一次身份 = 单请求恰一次完整解析（修复前 valid 里会再来两次读）。
  const before=identityReads;
  const v=await request('ops_internal_ai_prove',proofArgs('reuse'));
  expect(identityReads-before).toBe(2);
  // a) 重放路径：同一幂等键重放同样只解析一次，结果一致。
  const replay=await request('ops_internal_ai_prove',proofArgs('reuse'));
  expect(replay).toEqual(v);
  expect(identityReads-before).toBe(4);
  // b) 首次解析成功后 IdP 一直 503（IdP 抖动场景）：prove 仍返回 handle——不再有第二次解析。
  const flake=identityReads;
  identityFailAfter=flake+2;
  const p=await request('ops_internal_ai_prove',proofArgs('flake'));
  expect(p.proofHandle).toBeString();
  expect(identityReads).toBe(identityFailAfter); // 故障窗口从未被越过：单请求只有首次解析
  identityFailAfter=0;
  // c) 身份快照比对保留：行内 digest 与请求内解析 digest 不同 → forbidden（复用不跳过比对）。
  const rowId=new RecordId('internal_ai_proof',sha256(String(p.proofHandle)));
  const [digest]=await database.db.query<[Array<{identities_digest:string}>]>('SELECT identities_digest FROM $id;',{id:rowId});
  const original=digest[0]!.identities_digest;
  await database.db.query('UPDATE $id SET identities_digest=$d;',{id:rowId,d:'f'.repeat(64)});
  await expect(request('ops_internal_ai_prove',proofArgs('flake'))).rejects.toMatchObject({code:'forbidden'});
  await database.db.query('UPDATE $id SET identities_digest=$d;',{id:rowId,d:original});
  // c) identities 解析失败（IdP 不可用）在重放路径同样失败：复用不跳过实时解析本身。
  identityAvailable=false;
  await expect(request('ops_internal_ai_prove',proofArgs('flake'))).rejects.toBeDefined();
  identityAvailable=true;
  expect(await request('ops_internal_ai_prove',proofArgs('flake'))).toEqual(p);
});
check('deliver resolves identities outside the freshness window; a >60s IdP pass still reaches the product',async()=>{
  identityDelayMs=35_000; // 两个别名各读一次身份 → 每次完整解析推假时钟约 +70s，旧实现会在 valid 内超窗
  const clock0=clock, delivered0=delivered; // files() 的字节与后续用例的 delivered JWT 都以 clock0 为基准：一并恢复
  try {
    const before=identityReads;
    const v=await request('ops_internal_ai_prove',proofArgs('slow'));
    const login=await request('ops_login',{alias:'LCA04_OPS',audience:'ops'});
    const priorDelivered=delivered;
    const res=await request('ops_internal_ai_deliver',{proofHandle:v.proofHandle,session:login.session});
    expect(res).toMatchObject({status:200,ok:true,paidCallsAllowed:1});
    expect(delivered).toBeString();expect(delivered).not.toBe(priorDelivered);
    expect(identityReads-before).toBe(4); // prove、deliver 各恰一次完整解析；valid 内不再解析
    verifyCompanyProof(delivered!,trusted,'proof',clock);
  } finally { identityDelayMs=0; clock=clock0; delivered=delivered0; }
});
check('reviewed-token-plan quota evidence signs approved-service; quota, schema and USD-balance violations reject',async()=>{
  const task=await core.createTask(gm,{title:'Synthetic token-plan approval',context:'Only isolated fixtures',executorRole:'engineering',reviewerRole:'qa',goalId:PROOF_GOAL,idempotencyKey:randomUUID()});
  const claim=await core.claim(author,task.id);
  const f=await files(task.id,'reviewed-token-plan');
  const prepared=await ops.call(author,task.id,'ops_internal_ai_prepare',{manifestPath:f.manifestPath,documentPath:f.documentPath}) as {approvalMarker:string};
  const disabled = await ops.call(author,task.id,'ops_internal_ai_prove',{mode:'register-disabled',manifestPath:f.manifestPath,documentPath:f.documentPath,activityId:f.manifest.activityId,nonce:'v2-disabled-nonce-0001',idempotencyKey:'v2-disabled'});
  expect(disabled).toMatchObject({type:'development-disabled',scope:'register-disabled',paidCallsAllowed:0,documentHash:f.manifest.documentHash});
  await core.submit(author,{taskId:task.id,deliveryId:claim.deliveryId,fence:claim.fence,expectedVersion:claim.task.version},{text:'Synthetic reviewed token-plan files',idempotencyKey:randomUUID()});
  const review=await core.claim(reviewer,task.id);
  await core.accept(reviewer,{taskId:task.id,deliveryId:review.deliveryId,fence:review.fence,expectedVersion:review.task.version},{text:prepared.approvalMarker,idempotencyKey:randomUUID()});
  const args=(id:string)=>({mode:'enable',approvalTask:task.id,manifestPath:f.manifestPath,documentPath:f.documentPath,activityId:f.manifest.activityId,nonce:'token-plan-nonce-'+id,idempotencyKey:'token-plan-'+id});
  const a=await request('ops_internal_ai_prove',args('enable'));
  expect(a.type).toBe('approved-service'); expect(a.paidCallsAllowed).toBe(1);
  const priorDelivered=delivered;
  const login=await request('ops_login',{alias:'LCA04_OPS',audience:'ops'});
  await request('ops_internal_ai_deliver',{proofHandle:a.proofHandle,session:login.session});
  const payload=verifyCompanyProof(delivered!,trusted,'proof',clock);
  delivered=priorDelivered;
  expect(payload.type).toBe('approved-service'); expect(payload.paidCallsAllowed).toBe(1); expect(payload.documentHash).toBe(f.manifest.documentHash);
  // 断言层拒绝：文档契约合法但配额语义不满足 enable（剩余为 0、未批准、采样在未来、已过期）。
  const assertViolations:Array<[string,EvidenceDoc]>=[
    ['empty',{...f.evidence,quotaRemaining:0}],
    ['stale',{...f.evidence,sampledAt:new Date(clock-86_400_001).toISOString()}],
    ['unapproved',{...f.evidence,serviceApproved:false}],
    ['future',{...f.evidence,sampledAt:new Date(clock+60_000).toISOString()}],
    ['expired',{...f.evidence,expiresAt:new Date(clock-60_000).toISOString()}],
  ];
  for(const [id,bad] of assertViolations){await rewrite(f,bad);await expect(request('ops_internal_ai_prove',args(id))).rejects.toMatchObject({code:'forbidden'});}
  // 契约层拒绝：缺配额字段、accountPlanType 缺失/非 FREE 或混入旧字段、quotaAmount 非正、USD 字段混入配额文档。
  const {accountPlanType:_np,...withoutPayment}=f.evidence as EvidenceDoc;
  const {planName:_pn,...withoutPlan}=f.evidence as EvidenceDoc;
  const schemaViolations:Array<[string,EvidenceDoc]>=[
    ['nopay',withoutPayment],
    ['nonfree',{...f.evidence,accountPlanType:'TOKEN_PLAN_PLAN_TYPE_PRO'}],
    ['v1',{...f.evidence,schemaVersion:1}],
    ['oldpayment',{...f.evidence,noPaymentInstrument:true}],
    ['oldtopup',{...f.evidence,autoTopupDisabled:true}],
    ['noplan',withoutPlan],
    ['zeroamount',{...f.evidence,quotaAmount:0}],
    ['usdmix',{...f.evidence,currency:'USD',balanceNanoUsd:1}],
  ];
  const own = await files(consumerTask,'reviewed-token-plan');
  for(const [id,bad] of schemaViolations){
    await rewrite(f,bad);
    await rewrite(own,bad);
    await expect(request('ops_internal_ai_prepare',{manifestPath:own.manifestPath,documentPath:own.documentPath})).rejects.toMatchObject({code:'invalid'});
    await expect(request('ops_internal_ai_prove',{...args(id),mode:'register-disabled',manifestPath:own.manifestPath,documentPath:own.documentPath})).rejects.toMatchObject({code:'invalid'});
    await expect(request('ops_internal_ai_prove',args(id))).rejects.toMatchObject({code:'invalid'});
  }
  // USD 余额分支行为不变：余额低于预算仍拒签，不放宽余额检查。
  const {planName:_1,planSourceUrl:_2,quotaUnit:_3,quotaAmount:_4,quotaWindowSeconds:_5,quotaRemaining:_6,accountPlanType:_7,...shared}=f.evidence as EvidenceDoc;
  await rewrite(f,{...shared,schemaVersion:1,autoTopupDisabled:true,type:'reviewed-service',currency:'USD',balanceNanoUsd:0});
  await expect(request('ops_internal_ai_prove',args('lowbalance'))).rejects.toMatchObject({code:'forbidden'});
  await files(task.id,'reviewed-token-plan');
});
check('missing approval, wrong manifest/hash/activity/scope and idempotency conflicts reject',async()=>{
  await expect(request('ops_internal_ai_prove',{...proofArgs('none'),approvalTask:consumerTask})).rejects.toBeDefined();
  await expect(request('ops_internal_ai_prove',{...proofArgs('wrong'),activityId:'other'})).rejects.toBeDefined();
  await expect(request('ops_internal_ai_prove',{...proofArgs(),nonce:'different-product-nonce'})).rejects.toMatchObject({code:'conflict'});
  await expect(request('ops_internal_ai_prove',{...proofArgs('env'),env:'staging'})).rejects.toBeDefined();
  await expect(request('ops_internal_ai_prove',{...proofArgs('body'),subject:'caller-supplied'})).rejects.toBeDefined();
  const original=JSON.stringify(manifest);
  await writeFile(manifestPath,JSON.stringify({...manifest,documentHash:'a'.repeat(64)}));
  await expect(request('ops_internal_ai_prove',proofArgs('hash'))).rejects.toBeDefined();
  await writeFile(manifestPath,original);
});
check('disabled preparation is explicitly development; missing billing/member evidence and consent refuse without writes',async()=>{
  const f=await files(consumerTask,'development-disabled');
  const args={mode:'register-disabled',manifestPath:f.manifestPath,documentPath:f.documentPath,activityId:f.manifest.activityId,nonce:'disabled-product-nonce',idempotencyKey:'disabled'};
  const value=await request('ops_internal_ai_prove',args); expect(value.type).toBe('development-disabled');expect(value.paidCallsAllowed).toBe(0);
  identityAvailable=false; await expect(request('ops_internal_ai_prove',{...args,idempotencyKey:'missing'})).rejects.toBeDefined();identityAvailable=true;
  world.workspaces.get('sck-ui01')!.members[1]!.disabled=true;
  await expect(request('ops_internal_ai_prove',{...args,idempotencyKey:'removed'})).rejects.toBeDefined();
  world.workspaces.get('sck-ui01')!.members[1]!.disabled=false;
  world.consentClients.add('client-ck-1234');
  await expect(request('ops_internal_ai_prove',{...args,idempotencyKey:'consent'})).rejects.toBeDefined();
  world.consentClients.delete('client-ck-1234');
  expect(world.requests.some(r=>r.method==='POST'&&r.url.endsWith('/api/workspaces'))).toBe(false);
  expect(world.sql.some(r=>r.sql.startsWith('INSERT')||r.sql.startsWith('UPDATE'))).toBe(false);
});
check('protected status, nonce, signed reply expiry, wrong audience/type and member revocation',async()=>{
  expect((await ops.proofStatus(new Request('http://preview.local/internal-ai/status'))).status).toBe(401);
  const current=await status(delivered!,'status-challenge-current');expect(current.nonce).toBe('status-challenge-current');
  expect(()=>verifyCompanyProof(delivered!,{...trusted,audience:'other'},'proof',clock)).toThrow();
  expect(()=>verifyCompanyProof(delivered!,trusted,'status',clock)).toThrow();
  expect(()=>verifyCompanyProof(delivered!,trusted,'proof',clock+300_000)).toThrow();
  // 状态路径零身份解析：不碰 IdP 登录也不读产品身份接口（5 秒预算内必须返回）。
  const readsBefore=identityReads,requestsBefore=world.requests.length;
  expect((await status(delivered!,'status-no-resolve')).valid).toBe(true);
  expect(identityReads).toBe(readsBefore);expect(world.requests.length).toBe(requestsBefore);
  // 成员禁用是身份漂移：状态面按行内已存 digest 仍判 valid，漂移由 prove/deliver 的现场比对负责——deliver 拒绝。
  const drift=await request('ops_internal_ai_prove',proofArgs('drift'));
  world.workspaces.get('sck-ui01')!.members[1]!.disabled=true;
  expect((await status(delivered!)).valid).toBe(true);
  const driftLogin=await request('ops_login',{alias:'LCA04_OPS',audience:'ops'});
  await expect(request('ops_internal_ai_deliver',{proofHandle:drift.proofHandle,session:driftLogin.session})).rejects.toBeDefined();
  world.workspaces.get('sck-ui01')!.members[1]!.disabled=false;
});
check('symlink/escape/hidden/oversize rejected; changed evidence invalidates old status',async()=>{
  const f=await files(consumerTask,'development-disabled');
  const link=join(dir,'evidence',consumerTask,'alias.json');await symlink(documentPath,link);
  await expect(loadProofFiles(dir,consumerTask,f.manifestPath,link)).rejects.toBeDefined();
  await expect(loadProofFiles(dir,consumerTask,manifestPath,documentPath)).rejects.toBeDefined();
  const large=join(dir,'evidence',consumerTask,'large.json');await writeFile(large,'x'.repeat(256*1024+1));
  await expect(loadProofFiles(dir,consumerTask,f.manifestPath,large)).rejects.toBeDefined();
  await writeFile(documentPath,'{}');expect((await status(delivered!)).valid).toBe(false);await files(approvalTask);
});
check('restart preserves pinned sealed key, approved proof, revocation and task-bound handle',async()=>{
  const value=await request('ops_internal_ai_prove',proofArgs('restart'));
  const login=await request('ops_login',{alias:'LCA04_OPS',audience:'ops'});
  await request('ops_internal_ai_deliver',{proofHandle:value.proofHandle,session:login.session});const jwt=delivered!;
  await stop(); await start();await connect();broker();
  expect(await request('ops_internal_ai_trust')).toEqual(trusted);
  expect((await status(jwt)).valid).toBe(true);
  await request('ops_internal_ai_revoke',{proofHandle:value.proofHandle});
  expect((await status(jwt)).valid).toBe(false);
  await expect(request('ops_internal_ai_prove',proofArgs('restart'))).rejects.toBeDefined();
});
check('key rotation requires explicit independently accepted scope and invalidates old proofs',async()=>{
  await expect(request('ops_internal_ai_rotate_key',{approvalTask,expectedKid:trusted.kid})).rejects.toBeDefined();
  const oldClaims=verifyCompanyProof(delivered!,trusted,'proof',clock);
  const task=await core.createTask(gm,{title:'Synthetic key rotation approval',context:'Only isolated fixture',executorRole:'engineering',reviewerRole:'qa',goalId:PROOF_GOAL,idempotencyKey:randomUUID()});
  const claim=await core.claim(author,task.id);
  await core.submit(author,{taskId:task.id,deliveryId:claim.deliveryId,fence:claim.fence,expectedVersion:claim.task.version},{text:'Rotate isolated test key',idempotencyKey:randomUUID()});
  const review=await core.claim(reviewer,task.id);
  await core.accept(reviewer,{taskId:task.id,deliveryId:review.deliveryId,fence:review.fence,expectedVersion:review.task.version},{text:'company-internal-ai-key-rotation:v1:surreal_ck:production:'+trusted.kid,idempotencyKey:randomUUID()});
  const next=await request('ops_internal_ai_rotate_key',{approvalTask:task.id,expectedKid:trusted.kid}) as ReturnType<ProofSigner['trust']>;
  expect(next.kid===trusted.kid).toBe(false);trusted=next;
  const res=await ops.proofStatus(new Request('http://preview.local/internal-ai/status',{headers:{authorization:'Bearer '+(oldClaims.status as {bearer:string}).bearer,'x-sck-nonce':'rotation-status-nonce'}}));
  const body=await res.json() as {status:string};expect(verifyCompanyProof(body.status,trusted,'status',clock).valid).toBe(false);
});
check('approval version cancellation and live task lease revocation fail closed',async()=>{
  const v=await request('ops_internal_ai_prove',proofArgs('cancel'));
  const login=await request('ops_login',{alias:'LCA04_OPS',audience:'ops'});await request('ops_internal_ai_deliver',{proofHandle:v.proofHandle,session:login.session});const jwt=delivered!;
  await database.db.query('UPDATE $task SET version += 1;',{task:new RecordId('task',approvalTask)});
  expect((await status(jwt)).valid).toBe(false);
  await expect(request('ops_internal_ai_prove',proofArgs('new'))).rejects.toBeDefined();
  await database.db.query('UPDATE $task SET lease_expires_at = 0;',{task:new RecordId('task',consumerTask)});
  await expect(request('ops_internal_ai_trust')).rejects.toBeDefined();
  expect((await status(jwt)).valid).toBe(false);
});
