import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import { ProjectStore } from '../src/projects.ts';
import { OpsBroker } from '../src/ops/broker.ts';
import { InternalAiProofBridge } from '../src/ops/proof-bridge.ts';
import { diagnosticFailureByCheck, type ApprovalDiagnosis } from '../src/ops/approval-diagnosis.ts';
import { CompanyProofStore } from '../src/ops/proof-store.ts';
import { TOKEN_PLAN_PLAN_TYPE_FREE, PROOF_GOAL, configurationDigest, evidenceSchema, sha256, APPROVAL_MARKER, type ProofManifest, type ProofManifestBody } from '../src/ops/proof-contract.ts';
import { ProofSigner, verifyCompanyProof } from '../src/ops/proof-signer.ts';
import { loadProofFiles } from '../src/ops/proof-files.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import type { OwnerDesk } from '../src/owner.ts';
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
let loginBarrier: ((username: string) => Promise<void>) | undefined;
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
    magpie: { base: world.magpie.base, endpointSource: 'injected', readProviders: async () => JSON.stringify(world.magpie.providers) },
    fetch: async (input, init) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (u.pathname === '/api/login/ck/password' && loginBarrier) await loginBarrier(new URLSearchParams(String(init?.body)).get('username') ?? '');
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
async function files(task: string, type: 'reviewed-service'|'development-disabled'|'reviewed-token-plan'|'reviewed-token-plan-v3' = 'reviewed-service') {
  const root = join(dir, 'evidence', task); await mkdir(root,{recursive:true});
  const base = {schemaVersion:1,type,accountRef:'existing-service-opaque',endpoint:'https://api.openai.com/v1',model:'gpt-4o-mini-2024-07-18',priceRevision:'openai-mini-2026-10-09',sampledAt:new Date(clock-1000).toISOString(),expiresAt:new Date(clock+3_600_000).toISOString()};
  const v3Reset5h=new Date(clock+3_600_000).toISOString(), v3Reset7d=new Date(clock+86_400_000).toISOString();
  const evidence = type === 'reviewed-token-plan'
    ? {...base,schemaVersion:2,serviceApproved:true,planName:'SenseNova Token Plan 公测档',planSourceUrl:'https://www.sensenova.cn/token-plan',quotaUnit:'points',quotaAmount:100_000,quotaWindowSeconds:18_000,quotaRemaining:90_000,accountPlanType:TOKEN_PLAN_PLAN_TYPE_FREE}
    : type === 'reviewed-token-plan-v3'
      ? {...base,type:'reviewed-token-plan',schemaVersion:3,evidenceClass:'promotional-account-bound',serviceApproved:true,planName:'SenseNova Token Plan Free · 公测 · 限时账号绑定',planSourceUrl:'https://www.sensenova.cn/token-plan',
          planSource:{url:'https://www.sensenova.cn/token-plan',fetchedAt:new Date(clock-1000).toISOString(),httpDate:new Date(clock-1000).toISOString(),clockSkewMs:0,status:200,eetag:'"fork-v3"',rawSha256:sha256('raw')},
          normalization:{algorithm:'html-text-flat/1',flatSha256:sha256('flat'),flatChars:4},
          accountPlanType:TOKEN_PLAN_PLAN_TYPE_FREE,accountBound:true,accountBoundSource:'console-pool-usage-cross-bound-to-sealed-api-key',
          quotaUnit:'points',quotaAmount:60_000,quotaWindowSeconds:18_000,quotaRemaining:90_000,quotaSource:'account-bound-observation',
          governingPool:{poolType:'dedicated',basis:'dedicated-pool-for-bound-model'},
          pools:[{poolType:'dedicated',name:'Flash-Lite',accountBound:true,window5h:{limit:120_000,used:30_000,remaining:90_000,resetAt:v3Reset5h},window7d:{limit:1_200_000,used:100_000,remaining:1_100_000,resetAt:v3Reset7d},usedSource5h:'reported',usedSource7d:'reported'}],
          autoTopupDisabled:true,promotional:true,revalidateBeforeUse:true,terminationRisk:'unknown-promotional-end',promotionalEndsAt:null}
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
  gm=await enroll.enroll('test-gm','owner',['execute','review','manage']);
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
  // The Magpie sampler binds the sealed supplier identity to the gateway account; the fake gateway
  // serves that account on its loopback surfaces.
  await projects.setSecret({project:'surreal_ck',env:'production',name:'SUPPLIER_SNV_FORK_USERNAME',value:world.magpie.accountUser},key);
  await projects.setSecret({project:'surreal_ck',env:'production',name:'SUPPLIER_SNV_FORK_PASSWORD',value:'synthetic-magpie-password'},key);
  const owner=world.user('sck-lca04-removable')!, member=world.user('sck-lca04-member')!;
  world.workspaces.set('sck-ui01',{slug:'sck-ui01',name:'synthetic',dbName:'ws_ui01',members:[{id:'owner',email:owner.email,displayName:'owner',subject:owner.id,isAdmin:true,disabled:false},{id:'member',email:member.email,displayName:'member',subject:member.id,isAdmin:false,disabled:false}]});
  broker();
  const approval=await core.createTask(gm,{title:'Synthetic service evidence approval',context:'Only test fixtures',executorRole:'engineering',reviewerRole:'qa',tag:PROOF_GOAL,idempotencyKey:randomUUID()});
  approvalTask=approval.id; const claim=await core.claim(author,approval.id);
  ({manifestPath,documentPath,manifest}=await files(approval.id));
  const prepared=await ops.call(author,approval.id,'ops_internal_ai_prepare',{manifestPath,documentPath}) as {approvalMarker:string};
  await core.submit(author,{taskId:approval.id,deliveryId:claim.deliveryId,fence:claim.fence,expectedVersion:claim.task.version},{text:'Synthetic reviewed files',idempotencyKey:randomUUID()});
  const review=await core.claim(reviewer,approval.id);
  await core.accept(reviewer,{taskId:approval.id,deliveryId:review.deliveryId,fence:review.fence,expectedVersion:review.task.version},{text:prepared.approvalMarker,idempotencyKey:randomUUID()});
  const task=await core.createTask(gm,{title:'Synthetic consuming task',context:'Only test fixtures',executorRole:'engineering',reviewerRole:'qa',tag:PROOF_GOAL,idempotencyKey:randomUUID()});
  consumerTask=task.id; await core.claim(consumer,task.id);
  trusted=await request('ops_internal_ai_trust') as ReturnType<ProofSigner['trust']>;
},20_000);
afterAll(async()=>{if(enabled){await stop();world.sqlite.close();await rm(dir,{recursive:true,force:true});}});
check('actual versioned SenseNova disabled files prepare an immutable candidate across fork restart without identity or model calls', async () => {
  const preparer = await new LocalEnrollmentAdmin(database).enroll('test-disabled-preparer', 'engineering', ['execute', 'review']);
  const task = await core.createTask(gm, { title: 'Synthetic disabled SenseNova preparation', context: 'No supplier evidence or paid calls', executorRole: 'engineering', reviewerRole: 'qa', tag: PROOF_GOAL, idempotencyKey: randomUUID() });
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
type DiagnosticResult = Extract<ApprovalDiagnosis, {outcome:'evaluated'}> & {codeVersion:string; expired:boolean};
const diagnoseArgs = () => ({approvalTask, manifestPath, documentPath, activityId: manifest.activityId});
check('diagnosis is referenced, scoped, read-only, content-versioned and never signs or resolves identities', async () => {
  const store = new CompanyProofStore(database.db, now);
  const scope = await core.opsScope(consumer, consumerTask);
  const unused = async (): Promise<never> => { throw new Error('diagnosis must not call signing, identities or delivery'); };
  const bridge = new InternalAiProofBridge({store,home:dir,now,key:()=>{throw new Error('no sealing key');},signer:unused,identities:unused,rotate:unused,deliver:unused});
  const [before] = await database.db.query<[unknown[]]>('SELECT * FROM internal_ai_candidate;');
  const output = await bridge.call(scope,'production','ops_internal_ai_approval_diagnose',diagnoseArgs()) as DiagnosticResult;
  expect(output).toMatchObject({outcome:'evaluated',failure:'none',snapshotStable:true,allApplicableChecksMatch:true,expired:false});
  expect(output.codeVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(output.checks).sort()).toEqual(Object.keys(diagnosticFailureByCheck).sort());
  for (const check of Object.values(output.checks)) { expect(typeof check.evaluated).toBe('boolean'); expect(typeof check.matched).toBe('boolean'); if (!check.evaluated) expect(check.matched).toBe(false); }
  const serialized = JSON.stringify(output);
  for (const value of [manifestPath,documentPath,manifest.configurationDigest,manifest.documentHash,scope.actor.employeeId,approvalTask]) expect(serialized).not.toContain(value);
  const [after] = await database.db.query<[unknown[]]>('SELECT * FROM internal_ai_candidate;');expect(after).toEqual(before);
  const reads=identityReads; const output2=await request('ops_internal_ai_approval_diagnose',diagnoseArgs());expect(output2).toEqual(output);expect(identityReads).toBe(reads);
  const [proofs,audits] = await database.db.query<[unknown[],Array<{evidence:string}>]>('SELECT * FROM internal_ai_proof; SELECT evidence, at FROM audit WHERE task=$task AND action="ops_proof" ORDER BY at DESC LIMIT 1;', {task:new RecordId('task',consumerTask)});
  expect(proofs).toHaveLength(0);expect(audits[0]?.evidence).toBe('ops_internal_ai_approval_diagnose outcome=evaluated failure=none');
  // Caller identity/role cannot be supplied by the request.
  await expect(request('ops_internal_ai_approval_diagnose',{...diagnoseArgs(),role:'engineering',sql:'SELECT * FROM employee'})).rejects.toBeDefined();
  const product = await new LocalEnrollmentAdmin(database).enroll('test-diagnosis-product','product',['execute','review']);
  const task = await core.createTask(gm,{title:'Synthetic product caller',context:'Only test fixtures',executorRole:'product',reviewerRole:'qa',tag:PROOF_GOAL,idempotencyKey:randomUUID()});
  await core.claim(product,task.id);
  expect(await bridge.call(await core.opsScope(product,task.id),'production','ops_internal_ai_approval_diagnose',diagnoseArgs())).toEqual({outcome:'denied',failure:'scope-denied'});
  expect(await request('ops_internal_ai_approval_diagnose',{...diagnoseArgs(),approvalTask:'missing-task'})).toEqual({outcome:'denied',failure:'scope-denied'});
  const unreferenced = await core.createTask(gm,{title:'Synthetic unreferenced approval',context:approvalTask,executorRole:'engineering',reviewerRole:'qa',tag:PROOF_GOAL,idempotencyKey:randomUUID()});
  expect(await request('ops_internal_ai_approval_diagnose',{...diagnoseArgs(),approvalTask:unreferenced.id})).toEqual({outcome:'denied',failure:'scope-denied'});
});
check('cross-goal, cross-project, no lease and unreferenced callers fail closed before diagnosis', async () => {
  const target = new RecordId('task',approvalTask), caller = new RecordId('task',consumerTask);
  const [rows] = await database.db.query<[Array<{lease_expires_at:number;dependencies:RecordId[]}>]>('SELECT lease_expires_at, dependencies FROM $caller;',{caller});
  const otherGoal = new RecordId('goal','synthetic-other-goal');
  await database.db.query('CREATE $goal CONTENT {project:$project};',{goal:otherGoal,project:new RecordId('project','surreal_ck')});
  try {
    await database.db.query('UPDATE $target SET goal=$other;',{target,other:otherGoal});
    expect(await request('ops_internal_ai_approval_diagnose',diagnoseArgs())).toEqual({outcome:'denied',failure:'scope-denied'});
    await database.db.query('UPDATE $target SET goal=$goal; UPDATE $goal SET project=$other;',{target,goal:new RecordId('goal',PROOF_GOAL),other:new RecordId('project','other-project')});
    await expect(request('ops_internal_ai_approval_diagnose',diagnoseArgs())).rejects.toBeDefined();
    await database.db.query('UPDATE $goal SET project=$project; UPDATE $caller SET dependencies=[];',{goal:new RecordId('goal',PROOF_GOAL),project:new RecordId('project','surreal_ck'),caller});
    expect(await request('ops_internal_ai_approval_diagnose',diagnoseArgs())).toEqual({outcome:'denied',failure:'scope-denied'});
    await database.db.query('UPDATE $caller SET dependencies=$deps, lease_expires_at=0;',{caller,deps:rows[0]!.dependencies});
    await expect(request('ops_internal_ai_approval_diagnose',diagnoseArgs())).rejects.toBeDefined();
  } finally {
    await database.db.query('UPDATE $target SET goal=$goal; UPDATE $goal SET project=$project; UPDATE $caller SET dependencies=$deps,lease_expires_at=$expiry;', {target,goal:new RecordId('goal',PROOF_GOAL),project:new RecordId('project','surreal_ck'),caller,deps:rows[0]!.dependencies,expiry:rows[0]!.lease_expires_at});
  }
});
check('diagnostic rereads detect real fork snapshot changes and redact database failures', async () => {
  const realDb = database.db;
  let snapshots = 0;
  const proxy = new Proxy(realDb, {get(target,property) {
    if (property === 'query') return async (sql:string,vars:Record<string,unknown>) => {
      if (sql.startsWith('SELECT task, digest')) {
        snapshots++;
        if (snapshots === 2) await realDb.query('UPDATE $task SET version+=1;',{task:new RecordId('task',approvalTask)});
      }
      return target.query(sql,vars);
    };
    const value = Reflect.get(target,property);return typeof value === 'function' ? value.bind(target) : value;
  }});
  const [rows] = await realDb.query<[Array<{version:number}>]>('SELECT version FROM $task;',{task:new RecordId('task',approvalTask)});
  const store = new CompanyProofStore(proxy,now);
  const scope = await core.opsScope(consumer,consumerTask);
  const unused = async (): Promise<never> => {throw new Error('must not sign');};
  const bridge = new InternalAiProofBridge({store,home:dir,now,key:()=>Buffer.alloc(32),signer:unused,identities:unused,rotate:unused,deliver:unused});
  try {
    const result = await bridge.call(scope,'production','ops_internal_ai_approval_diagnose',diagnoseArgs()) as DiagnosticResult;
    expect(result).toMatchObject({failure:'snapshot-unstable',snapshotStable:false,allApplicableChecksMatch:false});
  } finally { await realDb.query('UPDATE $task SET version=$version;',{task:new RecordId('task',approvalTask),version:rows[0]!.version}); }
  const lease = await new CompanyProofStore(realDb,now).lease(scope);
  const unavailable = {lease:async()=>lease,authorizeDiagnosis:async()=>true,diagnoseApproval:async()=>{throw new Error('JWT synthetic-secret-body token sealed ciphertext /private/sensitive.json');}} as unknown as CompanyProofStore;
  const failureBridge = new InternalAiProofBridge({store:unavailable,home:dir,now,key:()=>Buffer.alloc(32),signer:unused,identities:unused,rotate:unused,deliver:unused});
  const result = await failureBridge.call(scope,'production','ops_internal_ai_approval_diagnose',diagnoseArgs());
  expect(result).toMatchObject({failure:'dependency-unavailable',allApplicableChecksMatch:false});
  for(const value of ['synthetic-secret-body','JWT','sealed','ciphertext','/private/']) expect(JSON.stringify(result)).not.toContain(value);
});
check('real fork rejects each candidate, author, audit, actor and reviewer mismatch with a precise diagnosis', async () => {
  const store = new CompanyProofStore(database.db, now);
  const loaded = await loadProofFiles(dir,approvalTask,manifestPath,documentPath);
  const [candidates,tasks,audits] = await database.db.query<[Array<Record<string,unknown>>,Array<Record<string,unknown>>,Array<Record<string,unknown>>]>(
    "SELECT * FROM internal_ai_candidate WHERE task=$task; SELECT * FROM $task; SELECT * FROM audit WHERE task=$task AND action='accept' ORDER BY at DESC LIMIT 1;",
    {task:new RecordId('task',approvalTask)});
  const candidate = candidates[0]!, task = tasks[0]!, audit = audits[0]!;
  const actor = audit.actor as RecordId;
  const [who] = await database.db.query<[Array<Record<string,unknown>>]>('SELECT * FROM $actor;',{actor});
  const restore = async () => { await database.db.query('DELETE $c; CREATE $c CONTENT $candidate; UPSERT $t CONTENT $task; UPSERT $a CONTENT $audit; UPSERT $r CONTENT $reviewer;', {c:candidate.id,t:task.id,a:audit.id,r:actor,candidate,task,audit,reviewer:who[0]}); };
  const scenarios = [
    ['UPDATE $c SET env="wrong";','candidate-env-mismatch'],
    ['UPDATE $c SET digest="'+'0'.repeat(64)+'";','candidate-digest-mismatch'],
    ['UPDATE $c SET manifest_hash="wrong";','candidate-manifest-hash-mismatch'],
    ['UPDATE $c SET document_hash="wrong";','candidate-document-hash-mismatch'],
    ['UPDATE $c SET manifest_path="wrong";','candidate-manifest-path-mismatch'],
    ['UPDATE $c SET document_path="wrong";','candidate-document-path-mismatch'],
    ['UPDATE $c SET author="synthetic-other-author";','candidate-author-mismatch'],
    ['UPDATE $t SET version += 1;','audit-version-mismatch'],
    ['UPDATE $t SET state="void";','approval-task-not-done'],
    ['UPDATE $t SET kind="other";','approval-task-kind-ineligible'],
    ['UPDATE $a SET evidence="prefix '+APPROVAL_MARKER+'";','audit-marker-missing'],
    ['UPDATE $a SET actor="employee:synthetic-string";','audit-actor-not-record-id'],
    ['UPDATE $t SET accepted_by="synthetic-mismatch";','audit-actor-mismatch'],
    ['UPDATE $c SET author=$actorId; UPDATE $t SET submitted_by=$actorId;','self-review'],
    ['UPDATE $r SET revoked=true;','reviewer-revoked'],
    ['UPDATE $r SET retired=true;','reviewer-retired'],
    ['DELETE $r;','reviewer-missing'],
    ['DELETE $c;','candidate-missing'],
    ['DELETE $a;','approval-audit-missing'],
  ] as const;
  try {
    for (const [sql,failure] of scenarios) {
      await restore();
      let command = sql!, changed = candidate;
      const match = /^UPDATE \$c SET ([a-z_]+)="([^"]*)";/.exec(command);
      if (match) { changed = {...candidate,[match[1]!]:match[2]}; command = command.replace(match[0], 'DELETE $c; CREATE $c CONTENT $changed;'); }
      else if (command.startsWith('UPDATE $c SET author=$actorId;')) { changed={...candidate,author:String(actor.id)}; command=command.replace('UPDATE $c SET author=$actorId;', 'DELETE $c; CREATE $c CONTENT $changed;'); }
      await database.db.query(command,{c:candidate.id,t:task.id,a:audit.id,r:actor,actorId:String(actor.id),changed});
      const result = await request('ops_internal_ai_approval_diagnose',diagnoseArgs()) as DiagnosticResult;
      expect(result.failure).toBe(failure!);expect(result.allApplicableChecksMatch).toBe(false);
      await expect(store.approval(approvalTask,'production',loaded)).rejects.toBeDefined();
    }
    await restore();
    // Exact line semantics: CRLF with surrounding whitespace is legal; embedded/backtick markers are not.
    await database.db.query('UPDATE $a SET evidence=$e;',{a:audit.id,e:'review notes\r\n  '+APPROVAL_MARKER+manifest.configurationDigest+'  \r\nend'});
    expect((await request('ops_internal_ai_approval_diagnose',diagnoseArgs()) as DiagnosticResult).failure).toBe('none');
    await store.approval(approvalTask,'production',loaded);
    await database.db.query('UPDATE $a SET evidence=$e;',{a:audit.id,e:'`'+APPROVAL_MARKER+manifest.configurationDigest+'`'});
    expect((await request('ops_internal_ai_approval_diagnose',diagnoseArgs()) as DiagnosticResult).failure).toBe('audit-marker-missing');
    await restore();
    await database.db.query('UPDATE $r SET archived=true;',{r:actor});
    expect((await request('ops_internal_ai_approval_diagnose',diagnoseArgs()) as DiagnosticResult).failure).toBe('none');
    await store.approval(approvalTask,'production',loaded);
    // Diagnostic must never follow an arbitrary non-employee RecordId into another table.
    await database.db.query('UPDATE $a SET actor=$foreign;',{a:audit.id,foreign:new RecordId('project',String(actor.id))});
    expect(await request('ops_internal_ai_approval_diagnose',diagnoseArgs())).toEqual({outcome:'denied',failure:'scope-denied'});
    await restore();
    await database.db.query('UPDATE $a SET action="owner_approve"; UPDATE $t SET accepted_by="owner", reviewer_role="owner";',{a:audit.id,t:task.id});
    const owner = await request('ops_internal_ai_approval_diagnose',diagnoseArgs()) as DiagnosticResult;
    expect(owner.failure).toBe('none');expect(owner.checks.reviewerExists.evaluated).toBe(false);expect(owner.checks.ownerAcceptedByMatches.matched).toBe(true);
    await store.approval(approvalTask,'production',loaded);
    // The same timestamp has no unique latest review: diagnostic refuses to combine an ambiguous snapshot.
    const duplicate = new RecordId('audit','synthetic-ambiguous');
    await database.db.query('CREATE $id CONTENT $row;',{id:duplicate,row:{...audit,id:duplicate}});
    expect((await request('ops_internal_ai_approval_diagnose',diagnoseArgs()) as DiagnosticResult).failure).toBe('snapshot-unstable');
    await database.db.query('DELETE $id;',{id:duplicate});
  } finally { await restore(); }
});
check('expired evidence remains diagnostic-only; wrong roots, schema, digest, hash and activity identify exact failures', async () => {
  const originalManifest = await Bun.file(manifestPath).text(), originalDocument = await Bun.file(documentPath).text();
  const diagnose = async (args:Record<string,unknown>={}) => request('ops_internal_ai_approval_diagnose',{...diagnoseArgs(),...args}) as Promise<DiagnosticResult>;
  const initial = clock;
  const [leases] = await database.db.query<[Array<{lease_expires_at:number}>]>('SELECT lease_expires_at FROM $task;', {task:new RecordId('task',consumerTask)});
  try {
    expect((await diagnose({manifestPath:'/outside/manifest.json'})).failure).toBe('manifest-root-mismatch');
    expect((await diagnose({activityId:'wrong'})).failure).toBe('activity-mismatch');
    await writeFile(manifestPath,'{}');expect((await diagnose()).failure).toBe('manifest-schema-invalid');
    await writeFile(manifestPath,JSON.stringify({...manifest,configurationDigest:'0'.repeat(64)}));expect((await diagnose()).failure).toBe('configuration-digest-invalid');
    await writeFile(manifestPath,originalManifest);await writeFile(documentPath,originalDocument+'\n');expect((await diagnose()).failure).toBe('document-hash-invalid');
    await writeFile(documentPath,originalDocument);
    clock = Date.parse((JSON.parse(originalDocument) as {expiresAt:string}).expiresAt);
    await database.db.query('UPDATE $task SET lease_expires_at=$expiry;', {task:new RecordId('task',consumerTask),expiry:clock/1000+600});
    const expired = await diagnose();expect(expired).toMatchObject({failure:'evidence-expired',expired:true,allApplicableChecksMatch:false});
    expect(expired.checks.auditMarkerExactLine.matched).toBe(true);
    await expect(request('ops_internal_ai_prove',proofArgs('expired-only'))).rejects.toBeDefined();
  } finally { clock=initial; await database.db.query('UPDATE $task SET lease_expires_at=$expiry;', {task:new RecordId('task',consumerTask),expiry:leases[0]!.lease_expires_at}); await writeFile(manifestPath,originalManifest);await writeFile(documentPath,originalDocument); }
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
check('proof resolves both live aliases concurrently and does not deliver before both pass', async () => {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  loginBarrier = async () => {
    arrived++;
    if (arrived === 2) release();
    await Promise.race([gate, Bun.sleep(200).then(() => { throw new Error('second alias never started'); })]);
  };
  const originalDelivered = delivered;
  try {
    const result = await request('ops_internal_ai_prove', proofArgs('concurrent-aliases'));
    expect(result.proofHandle).toBeString();
    expect(arrived).toBe(2);
    expect(delivered).toBe(originalDelivered);
  } finally { loginBarrier = undefined; release(); }
});

check('a failed alias waits for its sibling cleanup, exposes only its stage and never delivers', async () => {
  let arrived = 0, completed = 0;
  const originalDelivered = delivered;
  loginBarrier = async username => {
    arrived++;
    if (username === 'sck-lca04-removable') throw new Error('synthetic-password-and-subject-must-stay-private');
    await Bun.sleep(40);
    completed++;
  };
  try {
    const error = await request('ops_internal_ai_prove', proofArgs('concurrent-alias-failure')).then(() => undefined, error => error);
    expect(error).toMatchObject({ code: 'upstream_error', retryable: true });
    expect(error.message).toContain('identity-login');
    expect(error.message).not.toContain('synthetic-password-and-subject');
    expect(arrived).toBe(3);
    expect(completed).toBe(1);
    expect(delivered).toBe(originalDelivered);
  } finally { loginBarrier = undefined; }
});

check('parallel logins keep an existing operator session when seven handles are open', async () => {
  const sessions: unknown[] = [];
  try {
    for (let i = 0; i < 7; i++) sessions.push((await request('ops_login', { alias: 'LCA04_OPS', audience: 'ops' })).session);
    expect((await request('ops_internal_ai_prove', proofArgs('operator-session-preserved'))).proofHandle).toBeString();
    for (const session of sessions) expect(await request('ops_logout', { session })).toEqual({ closed: true });
  } finally { ops.release('test-consumer'); }
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
  const task=await core.createTask(gm,{title:'Synthetic token-plan approval',context:'Only isolated fixtures',executorRole:'engineering',reviewerRole:'qa',tag:PROOF_GOAL,idempotencyKey:randomUUID()});
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
check('reviewed-token-plan v3 promotional/account-bound evidence signs approved-service; contract gaps reject at prepare',async()=>{
  const task=await core.createTask(gm,{title:'Synthetic token-plan v3 approval',context:'Only isolated fixtures',executorRole:'engineering',reviewerRole:'qa',tag:PROOF_GOAL,idempotencyKey:randomUUID()});
  const claim=await core.claim(author,task.id);
  const f=await files(task.id,'reviewed-token-plan-v3');
  const prepared=await ops.call(author,task.id,'ops_internal_ai_prepare',{manifestPath:f.manifestPath,documentPath:f.documentPath}) as {approvalMarker:string;documentHash:string};
  expect(prepared.documentHash).toBe(f.manifest.documentHash);
  const disabled=await ops.call(author,task.id,'ops_internal_ai_prove',{mode:'register-disabled',manifestPath:f.manifestPath,documentPath:f.documentPath,activityId:f.manifest.activityId,nonce:'v3-disabled-nonce-0001',idempotencyKey:'v3-disabled'});
  expect(disabled).toMatchObject({type:'development-disabled',scope:'register-disabled',paidCallsAllowed:0,documentHash:f.manifest.documentHash});
  await core.submit(author,{taskId:task.id,deliveryId:claim.deliveryId,fence:claim.fence,expectedVersion:claim.task.version},{text:'Synthetic reviewed token-plan v3 files',idempotencyKey:randomUUID()});
  const review=await core.claim(reviewer,task.id);
  await core.accept(reviewer,{taskId:task.id,deliveryId:review.deliveryId,fence:review.fence,expectedVersion:review.task.version},{text:prepared.approvalMarker,idempotencyKey:randomUUID()});
  const args=(id:string)=>({mode:'enable',approvalTask:task.id,manifestPath:f.manifestPath,documentPath:f.documentPath,activityId:f.manifest.activityId,nonce:'v3-nonce-'+id+'-000000000000',idempotencyKey:'v3-'+id});
  const a=await request('ops_internal_ai_prove',args('enable'));
  expect(a.type).toBe('approved-service'); expect(a.paidCallsAllowed).toBe(1);
  const priorDelivered=delivered;
  const login=await request('ops_login',{alias:'LCA04_OPS',audience:'ops'});
  await request('ops_internal_ai_deliver',{proofHandle:a.proofHandle,session:login.session});
  const payload=verifyCompanyProof(delivered!,trusted,'proof',clock);
  delivered=priorDelivered;
  expect(payload.type).toBe('approved-service'); expect(payload.paidCallsAllowed).toBe(1); expect(payload.documentHash).toBe(f.manifest.documentHash);
  // Contract-level v3 gaps are refused at prepare (a fresh consumer file, no stale candidate).
  const own=await files(consumerTask,'reviewed-token-plan-v3');
  const violations:Array<[string,EvidenceDoc]>=[
    ['noPools',(()=>{const {pools:_p,...rest}=own.evidence as EvidenceDoc;return rest;})()],
    ['capTooHigh',{...own.evidence,quotaAmount:60_001}],
    ['windowTooLong',{...own.evidence,quotaWindowSeconds:18_001}],
    ['notPromotional',{...own.evidence,promotional:false}],
    ['notBound',{...own.evidence,accountBound:false}],
    ['noPlanSource',(()=>{const {planSource:_s,...rest}=own.evidence as EvidenceDoc;return rest;})()],
    ['missing7d',{...own.evidence,pools:[{...(own.evidence as any).pools[0],window7d:undefined}]}],
  ];
  for(const [id,bad] of violations){await rewrite(own,bad);await expect(request('ops_internal_ai_prepare',{manifestPath:own.manifestPath,documentPath:own.documentPath})).rejects.toMatchObject({code:'invalid'});}
  await files(task.id,'reviewed-token-plan-v3');
});
check('a v2 Magpie manifest and v4 route evidence prepare, are independently approved, prove and open a window; old v3 and cross-contract pairs reject',async()=>{
  world.clock=clock; // the fake gateway and the broker share the same capture clock
  const approval=await core.createTask(gm,{title:'Synthetic Magpie v4 approval',context:'Only isolated fixtures',executorRole:'engineering',reviewerRole:'qa',tag:PROOF_GOAL,idempotencyKey:randomUUID()});
  const claim=await core.claim(author,approval.id);
  // A fresh consumer employee and task keep this regression independent of the earlier
  // deliberate-failure tests: the SYS04 fault budget is scoped to each task id, and one employee
  // can only hold one lease.
  const prover=await new LocalEnrollmentAdmin(database).enroll('test-magpie-consumer','engineering',['execute','review']);
  const proofTask=await core.createTask(gm,{title:'Synthetic Magpie v4 consumer',context:'Only isolated fixtures',executorRole:'engineering',reviewerRole:'qa',tag:PROOF_GOAL,idempotencyKey:randomUUID()});
  await core.claim(prover,proofTask.id);
  const proofRoot=join(dir,'evidence',proofTask.id);
  // The real sampler reads the fake loopback gateway and the sealed supplier identity; it writes
  // the v4 document under the approval task's evidence root.
  const sampled=await ops.call(author,approval.id,'ops_magpie_route_sample',{alias:'SNV_FORK',purpose:'synthetic fork route evidence'}) as {status:string;document:Record<string,any>;documentSha256:string;receipt:Record<string,any>};
  expect(sampled.status).toBe('sampled');
  expect(sampled.document.schemaVersion).toBe(4);
  expect(sampled.document.account.binding).toBe('company-sealed-account');
  // A reviewed price decision turns the sampler's unreviewed snapshot into an eligible one.
  const reviewed:Record<string,any>={...sampled.document,pricing:{...sampled.document.pricing,reviewed:true},approvalReadiness:{ready:true,blockedReasons:[]}};
  expect(evidenceSchema.safeParse(reviewed).success).toBe(true);
  const root=join(dir,'evidence',approval.id); await mkdir(root,{recursive:true});
  const documentPath=join(root,'magpie-v4-reviewed.json'), manifestPath=join(root,'magpie-v2-manifest.json');
  const documentBytes=Buffer.from(JSON.stringify(reviewed));
  const body:ProofManifestBody={
    schemaVersion:2 as const,goalId:PROOF_GOAL,project:'surreal_ck' as const,env:'production' as const,activityId:'ui01-internal',workspaceSlug:'sck-ui01',
    documentHash:sha256(documentBytes),
    service:{kind:'magpie-route' as const,accountRef:reviewed.accountRef,endpoint:reviewed.endpoint,routeId:'group/work' as const,routeDigest:reviewed.route.digest,priceRevision:reviewed.priceRevision},
    budget:{currency:'USD' as const,totalNanoUsd:1_000_000_000,perAttemptNanoUsd:100_000_000,maxAttempts:30,autoTopupDisabled:true as const},
    identities:[{alias:'LCA04_REMOVABLE' as const,workspaceRole:'admin' as const,billingRole:'owner' as const},{alias:'LCA04_MEMBER' as const,workspaceRole:'participant' as const,billingRole:'member' as const}],
  };
  const manifest={...body,configurationDigest:configurationDigest(body)};
  await writeFile(documentPath,documentBytes); await writeFile(manifestPath,JSON.stringify(manifest));
  const prepared=await ops.call(author,approval.id,'ops_internal_ai_prepare',{manifestPath,documentPath}) as {digest:string;documentHash:string;approvalMarker:string};
  expect(prepared.digest).toBe(manifest.configurationDigest);
  expect(prepared.documentHash).toBe(sha256(documentBytes));
  // Tampered bytes or digests never reach the approval store (checks run while the author still
  // holds the approval task's lease).
  const badHashPath=join(dir,'evidence',approval.id,'magpie-v2-bad-hash.json');
  await writeFile(badHashPath,JSON.stringify({...manifest,documentHash:'a'.repeat(64)}));
  await expect(ops.call(author,approval.id,'ops_internal_ai_prepare',{manifestPath:badHashPath,documentPath})).rejects.toMatchObject({code:'invalid'});
  const badDigestPath=join(dir,'evidence',approval.id,'magpie-v2-bad-digest.json');
  await writeFile(badDigestPath,JSON.stringify({...manifest,configurationDigest:'b'.repeat(64)}));
  await expect(ops.call(author,approval.id,'ops_internal_ai_prepare',{manifestPath:badDigestPath,documentPath})).rejects.toMatchObject({code:'invalid'});
  const disabled=await ops.call(author,approval.id,'ops_internal_ai_prove',{mode:'register-disabled',manifestPath,documentPath,activityId:'ui01-internal',nonce:'magpie-disabled-nonce-0001',idempotencyKey:'magpie-disabled'}) as Record<string,unknown>;
  expect(disabled).toMatchObject({type:'development-disabled',scope:'register-disabled',paidCallsAllowed:0,documentHash:manifest.documentHash});
  await core.submit(author,{taskId:approval.id,deliveryId:claim.deliveryId,fence:claim.fence,expectedVersion:claim.task.version},{text:'Synthetic Magpie v4 files',idempotencyKey:randomUUID()});
  const review=await core.claim(reviewer,approval.id);
  await core.accept(reviewer,{taskId:approval.id,deliveryId:review.deliveryId,fence:review.fence,expectedVersion:review.task.version},{text:prepared.approvalMarker,idempotencyKey:randomUUID()});
  const proven=await ops.call(prover,proofTask.id,'ops_internal_ai_prove',{mode:'enable',approvalTask:approval.id,manifestPath,documentPath,activityId:'ui01-internal',nonce:'magpie-enable-nonce-0001',idempotencyKey:'magpie-enable'}) as Record<string,unknown>;
  expect(proven).toMatchObject({type:'approved-service',paidCallsAllowed:1,documentHash:manifest.documentHash});
  // The window proxy reads the approval task's root from the caller's separate task lease and
  // binds exactly this manifest digest and evidence expiry.
  const window=await ops.call(prover,proofTask.id,'ops_magpie_window_prepare',{approvalTask:approval.id,manifestPath,documentPath}) as Record<string,any>;
  expect(window.eligible).toBe(true);
  expect(window.window).toMatchObject({approvalTask:approval.id,configurationDigest:manifest.configurationDigest,evidenceExpiresAt:reviewed.expiresAt});
  expect(window.manifestHash).toBe(sha256(Buffer.from(JSON.stringify(manifest))));
  expect(window.documentHash).toBe(sha256(documentBytes));
  // Frozen old v3 evidence cannot be bound to a v2 Magpie manifest.
  const v3=await files(proofTask.id,'reviewed-token-plan-v3');
  const v3Bytes=await readFile(v3.documentPath);
  const v3Body:ProofManifestBody={...body,documentHash:sha256(v3Bytes)};
  const v3ManifestPath=join(proofRoot,'magpie-v2-over-v3.json');
  await writeFile(v3ManifestPath,JSON.stringify({...v3Body,configurationDigest:configurationDigest(v3Body)}));
  await expect(ops.call(prover,proofTask.id,'ops_internal_ai_prepare',{manifestPath:v3ManifestPath,documentPath:v3.documentPath})).rejects.toMatchObject({code:'invalid'});
  // A v1 manifest cannot carry v4 Magpie evidence, and v2 Magpie evidence cannot ride a v1 body.
  const v1=await files(proofTask.id,'reviewed-service');
  await rewrite(v1,reviewed);
  await expect(ops.call(prover,proofTask.id,'ops_internal_ai_prepare',{manifestPath:v1.manifestPath,documentPath:v1.documentPath})).rejects.toMatchObject({code:'invalid'});
  const v1Bytes=await readFile((await files(proofTask.id,'reviewed-service')).documentPath);
  const crossBody:ProofManifestBody={...body,documentHash:sha256(v1Bytes)};
  const crossPath=join(proofRoot,'magpie-v2-over-v1.json');
  await writeFile(crossPath,JSON.stringify({...crossBody,configurationDigest:configurationDigest(crossBody)}));
  await expect(ops.call(prover,proofTask.id,'ops_internal_ai_prepare',{manifestPath:crossPath,documentPath:join(proofRoot,'internal-ai-evidence.json')})).rejects.toMatchObject({code:'invalid'});
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
  const task=await core.createTask(gm,{title:'Synthetic key rotation approval',context:'Only isolated fixture',executorRole:'engineering',reviewerRole:'qa',tag:PROOF_GOAL,idempotencyKey:randomUUID()});
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
/** FV06 批准生命周期：每个用例自带作者、评审、消费者与批准任务，不改动上方共享夹具。 */
async function lifecycleApproval(label: string) {
  const enroll = new LocalEnrollmentAdmin(database);
  const authorId = `lc-${label}-author`, reviewerId = `lc-${label}-reviewer`, consumerId = `lc-${label}-consumer`;
  const author = await enroll.enroll(authorId, 'engineering', ['execute', 'review']);
  const reviewer = await enroll.enroll(reviewerId, 'qa', ['execute', 'review']);
  const consumer = await enroll.enroll(consumerId, 'engineering', ['execute', 'review']);
  const approval = await core.createTask(gm, {title:`Synthetic lifecycle ${label}`, context:'Only test fixtures', executorRole:'engineering', reviewerRole:'qa', tag:PROOF_GOAL, idempotencyKey:randomUUID()});
  const claim = await core.claim(author, approval.id);
  const f = await files(approval.id);
  const prepared = await ops.call(author, approval.id, 'ops_internal_ai_prepare', {manifestPath:f.manifestPath, documentPath:f.documentPath}) as {approvalMarker:string};
  await core.submit(author, {taskId:approval.id, deliveryId:claim.deliveryId, fence:claim.fence, expectedVersion:claim.task.version}, {text:'Synthetic reviewed files', idempotencyKey:randomUUID()});
  const review = await core.claim(reviewer, approval.id);
  await core.accept(reviewer, {taskId:approval.id, deliveryId:review.deliveryId, fence:review.fence, expectedVersion:review.task.version}, {text:prepared.approvalMarker, idempotencyKey:randomUUID()});
  const consuming = await core.createTask(gm, {title:`Synthetic lifecycle consumer ${label}`, context:'Only test fixtures', executorRole:'engineering', reviewerRole:'qa', tag:PROOF_GOAL, idempotencyKey:randomUUID()});
  await core.claim(consumer, consuming.id);
  return {approval: approval.id, consuming: consuming.id, authorId, reviewerId, consumerId, consumer, files: f};
}
type Lifecycle = Awaited<ReturnType<typeof lifecycleApproval>>;
const lifecycleDiagnose = (c: Lifecycle) => ops.call(c.consumer, c.consuming, 'ops_internal_ai_approval_diagnose', {approvalTask:c.approval, manifestPath:c.files.manifestPath, documentPath:c.files.documentPath, activityId:'ui01-internal'}) as Promise<DiagnosticResult>;
const lifecycleProve = (c: Lifecycle, key: string) => ops.call(c.consumer, c.consuming, 'ops_internal_ai_prove', {mode:'enable', approvalTask:c.approval, manifestPath:c.files.manifestPath, documentPath:c.files.documentPath, activityId:'ui01-internal', nonce:'nonce-lifecycle-'+key, idempotencyKey:key}) as Promise<Record<string,unknown>>;
check('FV06 normal session rotation and archive keep a formed independent approval valid for diagnosis, approval and prove', async () => {
  const workforce = new Workforce(database);
  for (const kind of ['rotation', 'archive'] as const) {
    const c = await lifecycleApproval(kind);
    await workforce.retire(c.reviewerId, `synthetic ${kind}`, kind);
    expect(await lifecycleDiagnose(c)).toMatchObject({failure:'none', allApplicableChecksMatch:true, checks:{reviewerNotRevoked:{matched:true}, reviewerNotRetired:{matched:true}}});
    await new CompanyProofStore(database.db, now).approval(c.approval, 'production', await loadProofFiles(dir, c.approval, c.files.manifestPath, c.files.documentPath));
    const granted = await lifecycleProve(c, `${kind}-enable`) as {proofHandle:string;paidCallsAllowed:number};
    expect(granted).toMatchObject({paidCallsAllowed:1});
    // 交付与状态使用同一授权判定：正常轮换后的证明仍然有效。
    const login = await ops.call(c.consumer, c.consuming, 'ops_login', {alias:'LCA04_OPS', audience:'ops'}) as {session:string};
    await ops.call(c.consumer, c.consuming, 'ops_internal_ai_deliver', {proofHandle:granted.proofHandle, session:login.session});
    expect((await status(delivered!)).valid).toBe(true);
  }
});
check('FV06 security revocation, unknown or failed retirement, forged audit and stale or raced evidence still fail closed without writes', async () => {
  const workforce = new Workforce(database), enroll = new LocalEnrollmentAdmin(database);
  const writes = () => world.sql.filter(r => /^\s*(INSERT|UPDATE|DELETE|CREATE)\b/i.test(r.sql)).length;
  const requestsBefore = world.requests.length, writesBefore = writes(), deliveredBefore = delivered;
  // 显式安全撤权覆盖曾正常轮换的历史评审人。
  const security = await lifecycleApproval('security');
  await workforce.retire(security.reviewerId, 'synthetic rotation', 'rotation');
  await enroll.revoke(security.reviewerId);
  expect(await lifecycleDiagnose(security)).toMatchObject({failure:'reviewer-revoked', allApplicableChecksMatch:false});
  await expect(lifecycleProve(security, 'security-enable')).rejects.toBeDefined();
  // 改动前写入的退役记录没有可信类型：不自动追认，需要新批准。
  const legacy = await lifecycleApproval('legacy');
  await database.db.query('UPDATE $e SET retired = true, revoked = true, retired_reason = "pre-FV06";', {e:new RecordId('employee', legacy.reviewerId)});
  expect(await lifecycleDiagnose(legacy)).toMatchObject({failure:'reviewer-revoked', allApplicableChecksMatch:false});
  await expect(lifecycleProve(legacy, 'legacy-enable')).rejects.toBeDefined();
  // 失败与手动退役都不是正常结束；之后的正常退役不能洗掉先发生的非正常退役。
  const failed = await lifecycleApproval('failed');
  await workforce.retire(failed.reviewerId, 'session error', 'failure');
  await workforce.retire(failed.reviewerId, 'synthetic rotation after failure', 'rotation');
  expect(await lifecycleDiagnose(failed)).toMatchObject({failure:'reviewer-revoked'});
  const manual = await lifecycleApproval('manual');
  await workforce.retire(manual.reviewerId, 'operator retire', 'manual');
  expect(await lifecycleDiagnose(manual)).toMatchObject({failure:'reviewer-revoked'});
  // 伪造的审计主体：即使评审人正常轮换也拒绝。
  const forged = await lifecycleApproval('forged');
  await workforce.retire(forged.reviewerId, 'synthetic rotation', 'rotation');
  await database.db.query('UPDATE audit SET actor = $other WHERE task = $task AND action = "accept";', {task:new RecordId('task', forged.approval), other:new RecordId('employee', forged.consumerId)});
  expect(await lifecycleDiagnose(forged)).toMatchObject({failure:'audit-actor-mismatch'});
  // 过期证据：正常轮换不延长证据有效期。
  const stale = await lifecycleApproval('stale');
  await workforce.retire(stale.reviewerId, 'synthetic rotation', 'rotation');
  const savedClock = clock;
  clock += 2 * 3600_000;
  try {
    await database.db.query('UPDATE $t SET lease_expires_at = $far;', {t:new RecordId('task', stale.consuming), far:(clock + 3600_000) / 1000});
    expect(await lifecycleDiagnose(stale)).toMatchObject({failure:'evidence-expired'});
  } finally { clock = savedClock; }
  // 同一时刻的两条接受审计没有唯一的最新评审：诊断拒绝合并不稳定快照。
  const raced = await lifecycleApproval('raced');
  await workforce.retire(raced.reviewerId, 'synthetic rotation', 'rotation');
  const [audits] = await database.db.query<[Array<Record<string,unknown>>]>('SELECT * FROM audit WHERE task = $task AND action = "accept";', {task:new RecordId('task', raced.approval)});
  const twin = new RecordId('audit', 'synthetic-lifecycle-twin');
  await database.db.query('CREATE $id CONTENT $row;', {id:twin, row:{...audits[0]!, id:twin}});
  try { expect(await lifecycleDiagnose(raced)).toMatchObject({failure:'snapshot-unstable'}); }
  finally { await database.db.query('DELETE $id;', {id:twin}); }
  // 自验：候选作者与提交人都是评审人本人，即使其身份正常轮换也拒绝。
  const selfish = await lifecycleApproval('selfish');
  await workforce.retire(selfish.reviewerId, 'synthetic rotation', 'rotation');
  await database.db.query('UPDATE internal_ai_candidate SET author = $who WHERE task = $task; UPDATE $task SET submitted_by = $who;', {who:selfish.reviewerId, task:new RecordId('task', selfish.approval)});
  expect(await lifecycleDiagnose(selfish)).toMatchObject({failure:'self-review'});
  // 调用方租约被撤回：诊断与授权在读取批准之前即拒绝。
  const withdrawn = await lifecycleApproval('withdrawn');
  await workforce.retire(withdrawn.reviewerId, 'synthetic rotation', 'rotation');
  await database.db.query('UPDATE $t SET lease_expires_at = 0;', {t:new RecordId('task', withdrawn.consuming)});
  await expect(lifecycleDiagnose(withdrawn)).rejects.toBeDefined();
  await expect(lifecycleProve(withdrawn, 'withdrawn-enable')).rejects.toBeDefined();
  // 拒绝例不产生产品写入、不把证明交给产品、不新增付费调用授权。
  expect(delivered).toBe(deliveredBefore);
  expect(world.requests.length).toBe(requestsBefore);
  expect(writes()).toBe(writesBefore);
});
check('FV06 key rotation approval shares the reviewer lifecycle: normal retirement passes, security revocation rejects', async () => {
  const enroll = new LocalEnrollmentAdmin(database);
  const author = await enroll.enroll('lc-keyrot-author', 'engineering', ['execute', 'review']);
  const reviewer = await enroll.enroll('lc-keyrot-reviewer', 'qa', ['execute', 'review']);
  const task = await core.createTask(gm, {title:'Synthetic lifecycle key rotation', context:'Only isolated fixture', executorRole:'engineering', reviewerRole:'qa', tag:PROOF_GOAL, idempotencyKey:randomUUID()});
  const claim = await core.claim(author, task.id);
  await core.submit(author, {taskId:task.id, deliveryId:claim.deliveryId, fence:claim.fence, expectedVersion:claim.task.version}, {text:'Rotate isolated test key', idempotencyKey:randomUUID()});
  const review = await core.claim(reviewer, task.id);
  await core.accept(reviewer, {taskId:task.id, deliveryId:review.deliveryId, fence:review.fence, expectedVersion:review.task.version}, {text:'company-internal-ai-key-rotation:v1:surreal_ck:production:'+trusted.kid, idempotencyKey:randomUUID()});
  const store = new CompanyProofStore(database.db, now);
  await new Workforce(database).retire('lc-keyrot-reviewer', 'synthetic rotation', 'rotation');
  await expect(store.rotationApproval(task.id, trusted.kid)).resolves.toBeUndefined();
  await enroll.revoke('lc-keyrot-reviewer');
  await expect(store.rotationApproval(task.id, trusted.kid)).rejects.toBeDefined();
});
check('FV06 real archive entry: a dispatcher tick after the agent is archived keeps the approval; a crashed session still fails closed', async () => {
  const workforce = new Workforce(database);
  const writes = () => world.sql.filter(r => /^\s*(INSERT|UPDATE|DELETE|CREATE)\b/i.test(r.sql)).length;
  // 真实 Paseo 接缝：名册不含已归档会话，status 按服务端 Archived 标记报 'archived'。
  const agentsMap = new Map<string, { id: string; status: string }>();
  const paseo = {
    list: async () => new Map([...agentsMap].filter(([, a]) => a.status !== 'archived').map(([k, a]) => [k, { id: a.id, status: a.status }] as const)),
    status: async (id: string) => { const a = agentsMap.get(id); return a ? { status: a.status, pendingPermissions: 0 } : undefined; },
    lastError: async () => 'session crashed', logsTail: async () => 'fixture transcript', lastInputTokens: async () => 0,
    spawn: async () => { throw new Error('fixture does not spawn'); }, send: async () => {}, stop: async () => {},
    archive: async (id: string) => { const a = agentsMap.get(id); if (a) a.status = 'archived'; },
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {},
  } as unknown as PaseoGateway;
  const owner = { applyPending: async () => [], resolveNotice: async () => true, openNotices: async () => [], triagePending: async () => [], raiseNotice: async () => true };
  // No sidecar here on purpose: the archive and crash retirements this tick checks run without one.
  const dispatcher = new Dispatcher({ workforce, owner: owner as unknown as OwnerDesk, paseo, env: { opsRepo: dir, sckBin: 'sck', paseoBin: 'paseo' }, rand: () => 0 } as unknown as ConstructorParameters<typeof Dispatcher>[0]);
  // 正常归档走真实入口：评审人实例绑定 Paseo 代理 → 代理被归档（名册消失、status=archived）→ tick 退役。
  const archived = await lifecycleApproval('realarch');
  await workforce.bind(archived.reviewerId, { agentId: 'agent-realarch', cwd: dir });
  agentsMap.set('agent-realarch', { id: 'agent-realarch', status: 'idle' });
  await paseo.archive('agent-realarch');
  await dispatcher.tick();
  const [kindRow] = await database.db.query<[Array<{ retired_kind: string }>]>('SELECT retired_kind FROM $e;', { e: new RecordId('employee', archived.reviewerId) });
  expect(kindRow?.[0]?.retired_kind).toBe('archive');
  expect(await lifecycleDiagnose(archived)).toMatchObject({ failure: 'none', allApplicableChecksMatch: true, checks: { reviewerNotRevoked: { matched: true }, reviewerNotRetired: { matched: true } } });
  expect(await lifecycleProve(archived, 'realarch-enable')).toMatchObject({ paidCallsAllowed: 1 });
  // 崩溃会话不是正常结束：error 状态仍按 failure 退役，批准 fail closed，零产品写入。
  const crashed = await lifecycleApproval('realcrash');
  await workforce.bind(crashed.reviewerId, { agentId: 'agent-realcrash', cwd: dir });
  agentsMap.set('agent-realcrash', { id: 'agent-realcrash', status: 'error' });
  const requestsBefore = world.requests.length, writesBefore = writes(), deliveredBefore = delivered;
  await dispatcher.tick();
  const [crashKind] = await database.db.query<[Array<{ retired_kind: string }>]>('SELECT retired_kind FROM $e;', { e: new RecordId('employee', crashed.reviewerId) });
  expect(crashKind?.[0]?.retired_kind).toBe('failure');
  expect(await lifecycleDiagnose(crashed)).toMatchObject({ failure: 'reviewer-revoked' });
  await expect(lifecycleProve(crashed, 'realcrash-enable')).rejects.toBeDefined();
  expect(delivered).toBe(deliveredBefore);
  expect(world.requests.length).toBe(requestsBefore);
  expect(writes()).toBe(writesBefore);
});
