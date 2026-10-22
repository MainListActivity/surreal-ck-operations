import { expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyDatabase } from '../src/database.ts';
import { loadDatabaseConfig } from '../src/config.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
run('real fork: the third ops refusal blocks exactly the held task and drops its lease', async () => {
 const root=mkdtempSync(join(tmpdir(),'ops-circuit-fork-'));
 const db=new CompanyDatabase({...loadDatabaseConfig(),namespace:'ops_circuit_fixture',database:'control_plane'});
 let pool:SidecarPool|undefined;
 try {
  await db.connect();await db.bootstrap();
  const workforce=new Workforce(db,join(root,'unused-credentials'));
  const core=new SurrealCompanyCore(db,{workforce});
  const admin=new LocalEnrollmentAdmin(db);
  const gm=await admin.enroll('fixture-gm','gm',['manage','execute','review']);
  const qa=await admin.enroll('fixture-qa','qa',['execute','review']);
  const task=await core.createTask(gm,{title:'受控熔断验证',context:'合成工具拒绝，不访问任何外部系统。',executorRole:'qa',reviewerRole:'gm',idempotencyKey:'fixture-ops-circuit'});
  let calls=0;
  pool=new SidecarPool({core,workforce:workforce as unknown as SidecarDeps['workforce'],runDir:root,sweepMs:2,heartbeatMs:100000,
   ops:{tools:['ops_request'],release:()=>{},call:async()=>{calls++;return {status:403,ok:false};}}});
  const inst={id:'fixture-qa',role:'qa' as const,credential:qa};
  const env=pool.env(inst);pool.bindAgent(inst.id,'fixture-agent');await pool.claim(inst,{id:task.id} as never);
  for(let n=0;n<3;n++) {
   const file=`${n}.json`,response=join(env.SCK_COMM_DIR,'res',file);
   writeFileSync(join(env.SCK_COMM_DIR,'req',file),JSON.stringify({key:env.SCK_COMM_KEY,tool:'ops_request',args:{}}));
   for(let i=0;i<200&&!existsSync(response);i++)await Bun.sleep(5);
   expect(existsSync(response)).toBe(true);
   if(n===2)expect(JSON.parse(readFileSync(response,'utf8')).error).toContain('熔断');
  }
  expect(calls).toBe(3);
  const actual=await core.getTask(gm,task.id);
  expect(actual).toMatchObject({state:'blocked',blockedTo:'gm'});
  expect(actual.currentEmployee).toBeUndefined();
  expect((await pool.settle('fixture-agent')).status).toBe('no_claim');
 } finally {pool?.close();await db.close();rmSync(root,{recursive:true,force:true});}
});
