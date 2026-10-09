import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readProofFile } from '../src/ops/proof-files.ts';
import { ProofSigner, verifyCompanyProof } from '../src/ops/proof-signer.ts';
import { proofToolSchemas, PROOF_AUDIENCE } from '../src/ops/proof-contract.ts';
const now=Date.now(),sec=Math.floor(now/1000);
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
