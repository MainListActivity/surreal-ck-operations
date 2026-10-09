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
import { PROOF_GOAL, configurationDigest, sha256, APPROVAL_MARKER, type ProofManifest } from '../src/ops/proof-contract.ts';
import { ProofSigner, verifyCompanyProof } from '../src/ops/proof-signer.ts';
import { loadProofFiles } from '../src/ops/proof-files.ts';
import { brokerConfig, FakeWorld, OPS_DIRECT_CLIENT, OPS_DIRECT_REDIRECT, OPS_RESOURCE } from './support/ops-world.ts';
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
async function files(task: string, type: 'reviewed-service'|'development-disabled' = 'reviewed-service') {
  const root = join(dir, 'evidence', task); await mkdir(root,{recursive:true});
  const evidence = {schemaVersion:1,type,accountRef:'existing-service-opaque',endpoint:'https://api.openai.com/v1',model:'gpt-4o-mini-2024-07-18',priceRevision:'openai-mini-2026-10-09',currency:'USD',balanceNanoUsd:1_000_000_000,sampledAt:new Date(clock-1000).toISOString(),expiresAt:new Date(clock+3_600_000).toISOString(),autoTopupDisabled:true,serviceApproved:type==='reviewed-service'};
  const bytes = JSON.stringify(evidence);
  const rest = {schemaVersion:1 as const,goalId:PROOF_GOAL as typeof PROOF_GOAL,project:'surreal_ck' as const,env:'production' as const,activityId:'ui01-internal',workspaceSlug:'sck-ui01',documentHash:sha256(bytes),service:{accountRef:evidence.accountRef,endpoint:evidence.endpoint,model:evidence.model,priceRevision:evidence.priceRevision},budget:{currency:'USD' as const,totalNanoUsd:1_000_000_000,perAttemptNanoUsd:100_000_000,maxAttempts:30,autoTopupDisabled:true as const},identities:[{alias:'LCA04_REMOVABLE' as const,workspaceRole:'admin' as const,billingRole:'owner' as const},{alias:'LCA04_MEMBER' as const,workspaceRole:'participant' as const,billingRole:'member' as const}] as ProofManifest['identities']};
  const m = {...rest,configurationDigest:configurationDigest(rest)};
  const mp=join(root,'internal-ai-manifest.json'),dp=join(root,'internal-ai-evidence.json');
  await writeFile(dp, bytes); await writeFile(mp, JSON.stringify(m));
  return {manifestPath:mp,documentPath:dp,manifest:m};
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
  const task=await core.createTask(gm,{title:'Synthetic consuming task',context:'Only test fixtures',executorRole:'engineering',reviewerRole:'qa',goalId:PROOF_GOAL,idempotencyKey:randomUUID()});
  consumerTask=task.id; await core.claim(consumer,task.id);
  trusted=await request('ops_internal_ai_trust') as ReturnType<ProofSigner['trust']>;
},20_000);
afterAll(async()=>{if(enabled){await stop();world.sqlite.close();await rm(dir,{recursive:true,force:true});}});
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
  world.workspaces.get('sck-ui01')!.members[1]!.disabled=true;expect((await status(delivered!)).valid).toBe(false);world.workspaces.get('sck-ui01')!.members[1]!.disabled=false;
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
