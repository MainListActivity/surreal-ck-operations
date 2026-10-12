import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readProofFile, loadProofFiles } from '../src/ops/proof-files.ts';
import { ProofSigner, verifyCompanyProof } from '../src/ops/proof-signer.ts';
import { TOKEN_PLAN_PLAN_TYPE_FREE, proofToolSchemas, PROOF_AUDIENCE, manifestSchema, evidenceSchema, configurationDigest, type ProofIdentity } from '../src/ops/proof-contract.ts';
import { InternalAiProofBridge } from '../src/ops/proof-bridge.ts';
import type { CompanyProofStore, ProofRow } from '../src/ops/proof-store.ts';
import type { OpsScope } from '../src/contracts.ts';
import { reviewedEvidenceSchema as productSchema } from './fixtures/product-1adf73ae-internal-ai-proof.ts';
import { disabledSenseNovaFixture } from './support/internal-ai-disabled-fixture.ts';
const now=Date.now(),sec=Math.floor(now/1000);
const evidenceModels = () => evidenceSchema.options.map(o => o.shape.model);
test('actual SenseNova version model parses in both fields and full development-disabled documents', () => {
  const { manifest, evidence } = disabledSenseNovaFixture();
  expect(manifestSchema.shape.service.shape.model.safeParse('sensenova-6.8-flash-lite').success).toBe(true);
  for (const schema of evidenceModels()) expect(schema.safeParse('sensenova-6.8-flash-lite').success).toBe(true);
  expect(manifestSchema.safeParse(manifest).success).toBe(true);
  expect(evidenceSchema.safeParse(evidence).success).toBe(true);
});
test('model keeps legacy identifiers and the 128-character bound; unsafe version segments reject', () => {
  for (const schema of [manifestSchema.shape.service.shape.model, ...evidenceModels()]) {
    for (const value of ['sensenova-flash-lite', 'gpt-4o-mini-2024-07-18', 'jev-1.13.0', 'A_B-9', 'a'.repeat(128), 'a'.repeat(126) + '.b']) {
      expect(schema.safeParse(value).success).toBe(true);
    }
    for (const value of ['', 'a'.repeat(129), ' a', 'a ', 'a b', 'a\n', 'a\r\n', 'a\nb', 'a\tb', '/a', 'a/b', 'a\\b', 'https://token.sensenova.cn', 'a?b', 'a#b', 'a%2eb', '模型', 'aé', '.a', 'a.', 'a..b', '.', '..']) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  }
});
test('model dots do not widen any other ref or allow unknown document fields', () => {
  const { manifest, evidence } = disabledSenseNovaFixture();
  expect(manifestSchema.safeParse({ ...manifest, activityId: 'activity.v1' }).success).toBe(false);
  for (const field of ['accountRef', 'priceRevision'] as const) {
    expect(manifestSchema.safeParse({ ...manifest, service: { ...manifest.service, [field]: 'ref.v1' } }).success).toBe(false);
    expect(evidenceSchema.safeParse({ ...evidence, [field]: 'ref.v1' }).success).toBe(false);
  }
  const request = { mode: 'register-disabled', manifestPath: '/fixture.json', documentPath: '/evidence.json', activityId: 'fixture', nonce: 'synthetic-nonce-1234', idempotencyKey: 'request', approvalTask: 'approved-task' };
  for (const field of ['activityId', 'approvalTask', 'idempotencyKey', 'nonce']) {
    expect(proofToolSchemas.ops_internal_ai_prove.safeParse({ ...request, [field]: 'synthetic-identifier.v1' }).success).toBe(false);
  }
  expect(manifestSchema.safeParse({ ...manifest, callerSubject: 'untrusted' }).success).toBe(false);
  expect(manifestSchema.safeParse({ ...manifest, service: { ...manifest.service, price: 0 } }).success).toBe(false);
  expect(evidenceSchema.safeParse({ ...evidence, tokenPlan: 'unreviewed' }).success).toBe(false);
});
test('reviewed-token-plan evidence follows the frozen quota contract; USD/missing/forged fields reject', () => {
  const tokenPlan = {
    schemaVersion: 2, type: 'reviewed-token-plan', accountRef: 'synthetic-sensenova-account',
    endpoint: 'https://token.sensenova.cn/v1', model: 'sensenova-6.8-flash-lite', priceRevision: 'sensenova-plan-2026-10-10',
    sampledAt: '2026-10-10T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', serviceApproved: true,
    planName: 'SenseNova Token Plan 公测档', planSourceUrl: 'https://www.sensenova.cn/token-plan', quotaUnit: 'points',
    quotaAmount: 100_000, quotaWindowSeconds: 18_000, quotaRemaining: 90_000, accountPlanType: TOKEN_PLAN_PLAN_TYPE_FREE,
  };
  for (const good of [tokenPlan, { ...tokenPlan, quotaRemaining: null }, { ...tokenPlan, quotaRemaining: 0 }]) {
    expect(evidenceSchema.parse(good)).toEqual(productSchema.parse(good));
  }
  expect(evidenceSchema.safeParse({ ...tokenPlan, quotaRemaining: null }).success).toBe(true);
  expect(evidenceSchema.safeParse({ ...tokenPlan, quotaRemaining: 0 }).success).toBe(true);
  const strip = (key: string) => { const clone: Record<string, unknown> = { ...tokenPlan }; delete clone[key]; return clone; };
  for (const bad of [
    { ...tokenPlan, quotaAmount: 0 }, { ...tokenPlan, quotaAmount: -1 }, { ...tokenPlan, quotaAmount: 1.5 },
    { ...tokenPlan, quotaWindowSeconds: 0 }, { ...tokenPlan, quotaRemaining: -1 },
    { ...tokenPlan, noPaymentInstrument: true }, { ...tokenPlan, autoTopupDisabled: true }, { ...tokenPlan, schemaVersion: 1 }, { ...tokenPlan, accountPlanType: 'TOKEN_PLAN_PLAN_TYPE_PRO' }, { ...tokenPlan, quotaUnit: 'credits' }, { ...tokenPlan, quotaUnit: 'usd' },
    { ...tokenPlan, planName: '' }, { ...tokenPlan, planName: 'a\nb' }, { ...tokenPlan, planName: 'x'.repeat(201) },
    { ...tokenPlan, planSourceUrl: 'http://www.sensenova.cn/token-plan' }, { ...tokenPlan, planSourceUrl: 'https://www.sensenova.cn/token-plan?a=1' },
    { ...tokenPlan, planSourceUrl: 'https://user@www.sensenova.cn/token-plan' }, { ...tokenPlan, planSourceUrl: 'https://www.sensenova.cn:8443/token-plan' },
    { ...tokenPlan, currency: 'USD' }, { ...tokenPlan, balanceNanoUsd: 0 }, { ...tokenPlan, type: 'reviewed-quota' }, { ...tokenPlan, unknownField: 1 },
    strip('planName'), strip('planSourceUrl'), strip('quotaUnit'), strip('quotaAmount'), strip('quotaWindowSeconds'), strip('quotaRemaining'), strip('accountPlanType'),
  ]) { expect(evidenceSchema.safeParse(bad).success).toBe(false); expect(productSchema.safeParse(bad).success).toBe(false); }
  // USD 两路径用同一 fixture 跑双端真实 schema，成功和拒绝结果保持一致。
  for (const type of ['development-disabled', 'reviewed-service']) {
    const usd = { ...disabledSenseNovaFixture().evidence, type };
    expect(evidenceSchema.parse(usd)).toEqual(productSchema.parse(usd));
    for (const bad of [{ ...usd, schemaVersion: 2 }, { ...usd, currency: 'CNY' }, { ...usd, autoTopupDisabled: false }, { ...usd, accountPlanType: TOKEN_PLAN_PLAN_TYPE_FREE }]) {
      expect(evidenceSchema.safeParse(bad).success).toBe(false);
      expect(productSchema.safeParse(bad).success).toBe(false);
    }
  }
  // USD 余额分支不接受配额字段，两族字段互不混入；旧类型形状不变。
  const { evidence } = disabledSenseNovaFixture();
  expect(evidenceSchema.safeParse({ ...evidence, quotaAmount: 1 }).success).toBe(false);
  expect(evidenceSchema.safeParse({ ...evidence, type: 'reviewed-service', quotaUnit: 'points' }).success).toBe(false);
  expect(evidenceSchema.safeParse({ ...evidence, type: 'reviewed-service' }).success).toBe(true);
});
test('real disabled SenseNova JSON bytes load; model mismatch and document/hash/configuration tampering reject', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'proof-model-unit-')));
  const task = 'synthetic-task';
  const root = join(home, 'evidence', task); await mkdir(root, { recursive: true });
  const manifestPath = join(root, 'manifest.json'), documentPath = join(root, 'evidence.json');
  const fixture = disabledSenseNovaFixture();
  const restore = async () => { await writeFile(documentPath, fixture.documentBytes); await writeFile(manifestPath, JSON.stringify(fixture.manifest)); };
  try {
    await restore();
    const files = await loadProofFiles(home, task, manifestPath, documentPath);
    expect(files.manifest.service.model).toBe('sensenova-6.8-flash-lite');
    expect(files.evidence.model).toBe('sensenova-6.8-flash-lite');
    expect(files.evidence).toMatchObject({ type: 'development-disabled', balanceNanoUsd: 0, serviceApproved: false });
    expect(files.documentHash).toBe(createHash('sha256').update(fixture.documentBytes).digest('hex'));
    await writeFile(documentPath, fixture.documentBytes + '\n');
    await expect(loadProofFiles(home, task, manifestPath, documentPath)).rejects.toBeDefined();
    await restore();
    await writeFile(manifestPath, JSON.stringify({ ...fixture.manifest, documentHash: 'a'.repeat(64) }));
    await expect(loadProofFiles(home, task, manifestPath, documentPath)).rejects.toBeDefined();
    await restore();
    await writeFile(manifestPath, JSON.stringify({ ...fixture.manifest, budget: { ...fixture.manifest.budget, maxAttempts: 29 } }));
    await expect(loadProofFiles(home, task, manifestPath, documentPath)).rejects.toBeDefined();
    // 两份文件都各自合法，摘要也同步更新，仍不能混用不同模型。
    const bytes = JSON.stringify({ ...fixture.evidence, model: 'sensenova-6.8-other' });
    const { configurationDigest: _digest, ...rest } = fixture.manifest;
    const changed = { ...rest, documentHash: createHash('sha256').update(bytes).digest('hex') };
    await writeFile(documentPath, bytes);
    await writeFile(manifestPath, JSON.stringify({ ...changed, configurationDigest: configurationDigest(changed) }));
    await expect(loadProofFiles(home, task, manifestPath, documentPath)).rejects.toBeDefined();
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('pinned Ed25519 signature rejects alteration, other key/kid/audience/type, expiry and stale status',()=>{
  const signer=new ProofSigner(ProofSigner.generate()), trust=signer.trust();
  const jwt=signer.sign('proof',{iat:sec,exp:sec+300,jti:'fixture'});
  expect(verifyCompanyProof(jwt,trust,'proof',now).aud).toBe(PROOF_AUDIENCE);
  expect(()=>verifyCompanyProof(jwt+'a',trust,'proof',now)).toThrow();
  expect(()=>verifyCompanyProof(jwt,new ProofSigner(ProofSigner.generate()).trust(),'proof',now)).toThrow();
  expect(()=>verifyCompanyProof(jwt,{...trust,kid:'other'},'proof',now)).toThrow();
  expect(()=>verifyCompanyProof(jwt,{...trust,audience:'other'},'proof',now)).toThrow();
  expect(()=>verifyCompanyProof(jwt,trust,'status',now)).toThrow();
  expect(()=>verifyCompanyProof(jwt,trust,'proof',now+300_000)).toThrow();
  const status=signer.sign('status',{valid:true,checkedAt:sec-61,iat:sec,exp:sec+60,nonce:'synthetic'});
  expect(()=>verifyCompanyProof(status,trust,'status',now)).toThrow();
  const future=signer.sign('status',{valid:true,checkedAt:sec+1,iat:sec,exp:sec+60});
  expect(()=>verifyCompanyProof(future,trust,'status',now)).toThrow();
  const publicText=JSON.stringify(trust);expect(publicText).not.toContain('PRIVATE KEY');expect(trust.jwk).not.toHaveProperty('d');
});
test('strict request schemas reject caller identity/role/hash/URL injection',()=>{
  const input={mode:'register-disabled',manifestPath:'/fixture.json',documentPath:'/evidence.json',activityId:'fixture',nonce:'synthetic-nonce-1234',idempotencyKey:'request'};
  expect(proofToolSchemas.ops_internal_ai_prove.safeParse(input).success).toBe(true);
  for(const extra of [{subject:'self-report'},{role:'owner'},{documentHash:'a'.repeat(64)},{jwksUrl:'https://untrusted.test'},{env:'staging'},{mode:'approve'}]) expect(proofToolSchemas.ops_internal_ai_prove.safeParse({...input,...extra}).success).toBe(false);
});
test('same fd bounded file bytes; hidden/env/escape/symlink/oversize denied',async()=>{
  const home=await realpath(await mkdtemp(join(tmpdir(),'proof-file-unit-')));
  const root=join(home,'evidence','task-fixture');await mkdir(root,{recursive:true});
  try {
    const file=join(root,'evidence.json');await writeFile(file,'{"fixture":true}');
    expect((await readProofFile(home,'task-fixture',file)).toString()).toBe('{"fixture":true}');
    const alias=join(root,'alias.json');await symlink(file,alias);
    const outside=join(home,'outside.json');await writeFile(outside,'{}');
    const secret=join(root,'credentials.json');await writeFile(secret,'{}');
    const large=join(root,'large.json');await writeFile(large,'x'.repeat(256*1024+1));
    for(const path of [outside,secret,alias,large,join(root,'.env'),root]) await expect(readProofFile(home,'task-fixture',path)).rejects.toBeDefined();
  }finally{await rm(home,{recursive:true,force:true});}
});
test('deliver resolves identities before the freshness window; status never resolves',async()=>{
  const home=await realpath(await mkdtemp(join(tmpdir(),'proof-bridge-unit-')));
  const taskId='synthetic-consumer';
  try {
    const root=join(home,'evidence',taskId);await mkdir(root,{recursive:true});
    const fixture=disabledSenseNovaFixture();
    const manifestPath=join(root,'manifest.json'),documentPath=join(root,'evidence.json');
    await writeFile(manifestPath,JSON.stringify(fixture.manifest));await writeFile(documentPath,fixture.documentBytes);
    const scope:OpsScope={taskId,project:'surreal_ck',actor:{employeeId:'synthetic-employee',role:'engineering',capabilities:[]}};
    const leaseStamp={taskId,employee:'synthetic-employee',delivery:'synthetic-delivery',fence:1,goal:'synthetic-goal',project:'surreal_ck',role:'engineering' as const};
    const rows=new Map<string,ProofRow>();
    const store={
      lease:async()=>leaseStamp, leaseValid:async()=>true,
      get:async(handleHash:string)=>rows.get(handleHash),
      put:async(row:ProofRow)=>{rows.set(String(row.id.id),row);return row;},
      status:async(hash:string)=>[...rows.values()].find(r=>r.status_hash===hash),
    } as unknown as CompanyProofStore;
    const signer=new ProofSigner(ProofSigner.generate()), key=Buffer.alloc(32,7);
    const identities:ProofIdentity[]=[
      {alias:'LCA04_REMOVABLE',subject:'user:synthetic-owner',spaceId:'workspace:synthetic',database:'ws_synthetic',workspaceRole:'admin',billingRole:'owner',billingAccountRef:'billing_account:synthetic'},
      {alias:'LCA04_MEMBER',subject:'user:synthetic-member',spaceId:'workspace:synthetic',database:'ws_synthetic',workspaceRole:'participant',billingRole:'member',billingAccountRef:'billing_account:synthetic'},
    ];
    // 一次完整解析把假时钟推过 60 秒窗：deliver 若在窗内解析会抛 temporarily_unavailable。
    let clock=1_700_000_000_000, identityCalls=0, resolved=identities, deliveredJwt:string|undefined;
    const bridge=new InternalAiProofBridge({
      store, home, key:()=>key, now:()=>clock, signer:async()=>signer,
      identities:async()=>{identityCalls++;clock+=61_000;return resolved;},
      rotate:async()=>{throw new Error('unused');},
      deliver:async(jwt)=>{deliveredJwt=jwt;return{status:200,ok:true};},
    });
    const prove=await bridge.call(scope,'production','ops_internal_ai_prove',{mode:'register-disabled',manifestPath,documentPath,activityId:fixture.manifest.activityId,nonce:'synthetic-nonce-0001',idempotencyKey:'unit-flow'}) as {proofHandle:string};
    expect(identityCalls).toBe(1);
    // 身份漂移仍 forbidden：digest 比对没有因为移出窗口而跳过，deps.deliver 不触发。
    resolved=identities.map((i,n)=>n===0?{...i,subject:'user:drifted'}:i);
    await expect(bridge.call(scope,'production','ops_internal_ai_deliver',{proofHandle:prove.proofHandle,session:'synthetic-session'})).rejects.toMatchObject({code:'forbidden'});
    expect(deliveredJwt).toBeUndefined();
    // identities 超过 60 秒仍完成下发：解析在窗外，60 秒只覆盖 valid 内的本地复查。
    resolved=identities;
    const callsBefore=identityCalls;
    const result=await bridge.call(scope,'production','ops_internal_ai_deliver',{proofHandle:prove.proofHandle,session:'synthetic-session'}) as {status:number,ok:boolean,paidCallsAllowed:number};
    expect(result).toMatchObject({status:200,ok:true,paidCallsAllowed:0});
    expect(identityCalls).toBe(callsBefore+1);
    expect(deliveredJwt).toBeString();
    // 状态路径零解析：不碰 identities/passwordLogin，valid 用行内已存 digest。
    const claims=verifyCompanyProof(deliveredJwt!,signer.trust(),'proof',clock);
    const bearer=(claims.status as {bearer:string}).bearer;
    const statusBefore=identityCalls;
    const response=await bridge.status(new Request('http://test.local/internal-ai/status',{headers:{authorization:'Bearer '+bearer,'x-sck-nonce':'synthetic-nonce-0002'}}));
    expect(response.status).toBe(200);
    const statusClaims=verifyCompanyProof((await response.json() as {status:string}).status,signer.trust(),'status',clock);
    expect(statusClaims).toMatchObject({valid:true,nonce:'synthetic-nonce-0002'});
    expect(identityCalls).toBe(statusBefore);
  }finally{await rm(home,{recursive:true,force:true});}
});
test('status requests append sanitized audit lines; deliver relays product errorCode',async()=>{
  const home=await realpath(await mkdtemp(join(tmpdir(),'proof-audit-unit-')));
  const taskId='synthetic-audit';
  try {
    const root=join(home,'evidence',taskId);await mkdir(root,{recursive:true});
    const fixture=disabledSenseNovaFixture();
    const manifestPath=join(root,'manifest.json'),documentPath=join(root,'evidence.json');
    await writeFile(manifestPath,JSON.stringify(fixture.manifest));await writeFile(documentPath,fixture.documentBytes);
    const scope:OpsScope={taskId,project:'surreal_ck',actor:{employeeId:'synthetic-employee',role:'engineering',capabilities:[]}};
    const leaseStamp={taskId,employee:'synthetic-employee',delivery:'synthetic-delivery',fence:1,goal:'synthetic-goal',project:'surreal_ck',role:'engineering' as const};
    const rows=new Map<string,ProofRow>();
    const store={
      lease:async()=>leaseStamp, leaseValid:async()=>true,
      get:async(handleHash:string)=>rows.get(handleHash),
      put:async(row:ProofRow)=>{rows.set(String(row.id.id),row);return row;},
      status:async(hash:string)=>[...rows.values()].find(r=>r.status_hash===hash),
    } as unknown as CompanyProofStore;
    const signer=new ProofSigner(ProofSigner.generate()), key=Buffer.alloc(32,9);
    const identities:ProofIdentity[]=[
      {alias:'LCA04_REMOVABLE',subject:'user:synthetic-owner',spaceId:'workspace:synthetic',database:'ws_synthetic',workspaceRole:'admin',billingRole:'owner',billingAccountRef:'billing_account:synthetic'},
      {alias:'LCA04_MEMBER',subject:'user:synthetic-member',spaceId:'workspace:synthetic',database:'ws_synthetic',workspaceRole:'participant',billingRole:'member',billingAccountRef:'billing_account:synthetic'},
    ];
    const clock=1_700_000_000_000;let deliveredJwt:string|undefined;
    const bridge=new InternalAiProofBridge({
      store,home,key:()=>key,now:()=>clock,signer:async()=>signer,
      identities:async()=>identities,
      rotate:async()=>{throw new Error('unused');},
      deliver:async(jwt)=>{deliveredJwt=jwt;return{status:422,ok:false,errorCode:'company-status-unavailable'};},
    });
    const prove=await bridge.call(scope,'production','ops_internal_ai_prove',{mode:'register-disabled',manifestPath,documentPath,activityId:fixture.manifest.activityId,nonce:'synthetic-nonce-2001',idempotencyKey:'audit-flow'}) as {proofHandle:string};
    const result=await bridge.call(scope,'production','ops_internal_ai_deliver',{proofHandle:prove.proofHandle,session:'synthetic-session'}) as {status:number,ok:boolean,errorCode?:string};
    expect(result).toMatchObject({status:422,ok:false,errorCode:'company-status-unavailable',paidCallsAllowed:0});
    const claims=verifyCompanyProof(deliveredJwt!,signer.trust(),'proof',clock);
    const bearer=(claims.status as {bearer:string}).bearer;
    const hashPrefix=(v:string)=>createHash('sha256').update(v).digest('hex').slice(0,8);
    const unknown='A'.repeat(43);
    const req=(init?:RequestInit)=>bridge.status(new Request('http://test.local/internal-ai/status',init));
    expect((await req({method:'POST'})).status).toBe(401);
    expect((await req({headers:{'x-sck-nonce':'synthetic-nonce-2002'}})).status).toBe(401);
    expect((await req({headers:{authorization:'Bearer '+bearer}})).status).toBe(401);
    expect((await req({headers:{authorization:'Bearer '+unknown,'x-sck-nonce':'synthetic-nonce-2002'}})).status).toBe(401);
    expect((await req({headers:{authorization:'Bearer '+bearer,'x-sck-nonce':'synthetic-nonce-2002'}})).status).toBe(200);
    [...rows.values()][0]!.revoked=true;
    expect((await req({headers:{authorization:'Bearer '+bearer,'x-sck-nonce':'synthetic-nonce-2003'}})).status).toBe(200);
    const auditFile=join(home,'logs','internal-ai-status.jsonl');
    expect((await stat(auditFile)).mode&0o777).toBe(0o600);
    const raw=await readFile(auditFile,'utf8');
    const lines=raw.trim().split('\n').map(l=>JSON.parse(l));
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatchObject({method:'POST',format:'bad-method',rowFound:false,valid:null,failReason:null,httpStatus:401,statusHashPrefix:null});
    expect(lines[1]).toMatchObject({method:'GET',format:'bad-bearer',rowFound:false,valid:null,failReason:null,httpStatus:401,statusHashPrefix:null});
    expect(lines[2]).toMatchObject({format:'bad-nonce',rowFound:false,valid:null,httpStatus:401,statusHashPrefix:hashPrefix(bearer)});
    expect(lines[3]).toMatchObject({format:'ok',rowFound:false,valid:null,httpStatus:401,statusHashPrefix:hashPrefix(unknown)});
    expect(lines[4]).toMatchObject({format:'ok',rowFound:true,valid:true,failReason:null,httpStatus:200,statusHashPrefix:hashPrefix(bearer),payloadSummary:{valid:true,version:1}});
    expect(lines[5]).toMatchObject({format:'ok',rowFound:true,valid:false,failReason:'proof expired or revoked',httpStatus:200,payloadSummary:{valid:false}});
    for(const line of raw.trim().split('\n')) expect(line.length).toBeLessThanOrEqual(2048);
    expect(lines.every(l=>typeof l.at==='string'&&!Number.isNaN(Date.parse(l.at)))).toBe(true);
    // 审计行绝不携带 bearer/JWT/subject/nonce 值/文件内容。
    for(const secret of [bearer,'synthetic-nonce-2002','synthetic-nonce-2003',deliveredJwt!,claims.jti as string,'user:synthetic-owner','user:synthetic-member','synthetic-session',fixture.manifest.documentHash]) expect(raw).not.toContain(secret);
    expect(raw).not.toContain(fixture.documentBytes);
  }finally{await rm(home,{recursive:true,force:true});}
});
test('status time claims carry a fixed clock margin; a verifier 5.5s behind the signing host still accepts',async()=>{
  const home=await realpath(await mkdtemp(join(tmpdir(),'proof-margin-unit-')));
  const taskId='synthetic-margin';
  try {
    const root=join(home,'evidence',taskId);await mkdir(root,{recursive:true});
    const fixture=disabledSenseNovaFixture();
    const manifestPath=join(root,'manifest.json'),documentPath=join(root,'evidence.json');
    await writeFile(manifestPath,JSON.stringify(fixture.manifest));await writeFile(documentPath,fixture.documentBytes);
    const scope:OpsScope={taskId,project:'surreal_ck',actor:{employeeId:'synthetic-employee',role:'engineering',capabilities:[]}};
    const leaseStamp={taskId,employee:'synthetic-employee',delivery:'synthetic-delivery',fence:1,goal:'synthetic-goal',project:'surreal_ck',role:'engineering' as const};
    const rows=new Map<string,ProofRow>();
    const store={
      lease:async()=>leaseStamp, leaseValid:async()=>true,
      get:async(handleHash:string)=>rows.get(handleHash),
      put:async(row:ProofRow)=>{rows.set(String(row.id.id),row);return row;},
      status:async(hash:string)=>[...rows.values()].find(r=>r.status_hash===hash),
    } as unknown as CompanyProofStore;
    const signer=new ProofSigner(ProofSigner.generate()), key=Buffer.alloc(32,11);
    const identities:ProofIdentity[]=[
      {alias:'LCA04_REMOVABLE',subject:'user:synthetic-owner',spaceId:'workspace:synthetic',database:'ws_synthetic',workspaceRole:'admin',billingRole:'owner',billingAccountRef:'billing_account:synthetic'},
      {alias:'LCA04_MEMBER',subject:'user:synthetic-member',spaceId:'workspace:synthetic',database:'ws_synthetic',workspaceRole:'participant',billingRole:'member',billingAccountRef:'billing_account:synthetic'},
    ];
    // 签约宿主时钟快 +5.5s：校验方（产品）真实时间比桥面 this.now() 慢 5.5 秒。
    const hostSkewMs=5_500;
    const clock=1_700_000_000_000;let deliveredJwt:string|undefined;
    const bridge=new InternalAiProofBridge({
      store,home,key:()=>key,now:()=>clock,signer:async()=>signer,
      identities:async()=>identities,
      rotate:async()=>{throw new Error('unused');},
      deliver:async(jwt)=>{deliveredJwt=jwt;return{status:200,ok:true};},
    });
    const prove=await bridge.call(scope,'production','ops_internal_ai_prove',{mode:'register-disabled',manifestPath,documentPath,activityId:fixture.manifest.activityId,nonce:'synthetic-nonce-3001',idempotencyKey:'margin-flow'}) as {proofHandle:string};
    await bridge.call(scope,'production','ops_internal_ai_deliver',{proofHandle:prove.proofHandle,session:'synthetic-session'});
    const claims=verifyCompanyProof(deliveredJwt!,signer.trust(),'proof',clock);
    const bearer=(claims.status as {bearer:string}).bearer;
    const response=await bridge.status(new Request('http://test.local/internal-ai/status',{headers:{authorization:'Bearer '+bearer,'x-sck-nonce':'synthetic-nonce-3002'}}));
    expect(response.status).toBe(200);
    const statusJwt=(await response.json() as {status:string}).status;
    const payload=JSON.parse(Buffer.from(statusJwt.split('.')[1]!,'base64url').toString()) as {checkedAt:number,iat:number,exp:number,valid:boolean,nonce:string};
    const seconds=Math.floor(clock/1000);
    // 固定 30 秒安全边距：checkedAt≈iat≈now−30s±1s，iat 与 checkedAt 同一 shifted 基准。
    expect(payload.checkedAt).toBeGreaterThanOrEqual(seconds-31);
    expect(payload.checkedAt).toBeLessThanOrEqual(seconds-29);
    expect(payload.iat).toBe(payload.checkedAt);
    // 窗口形状不变：exp−checkedAt=60。
    expect(payload.exp-payload.checkedAt).toBe(60);
    expect(payload).toMatchObject({valid:true,nonce:'synthetic-nonce-3002'});
    // 产品侧等价断言（checkedAt<=seconds 且 iat<=seconds）在校验方时钟慢 5.5s 时通过；
    // 修复前 checkedAt=iat=now 相对校验方显未来 5.5s，必拒（422 根因）。
    const productSeconds=(clock-hostSkewMs)/1000;
    expect(payload.checkedAt).toBeLessThanOrEqual(productSeconds);
    expect(payload.iat).toBeLessThanOrEqual(productSeconds);
    expect(verifyCompanyProof(statusJwt,signer.trust(),'status',clock-hostSkewMs)).toMatchObject({valid:true,nonce:'synthetic-nonce-3002'});
    // 边距不放大票据寿命：同形状（iat===checkedAt）但过旧 61 秒的状态仍被拒。
    const stale=signer.sign('status',{jti:claims.jti,valid:true,version:1,approvalVersion:null,checkedAt:seconds-61,iat:seconds-61,exp:seconds-1,nonce:'synthetic-nonce-3003'});
    expect(()=>verifyCompanyProof(stale,signer.trust(),'status',clock)).toThrow();
  }finally{await rm(home,{recursive:true,force:true});}
});
