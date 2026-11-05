import {mkdtempSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'bun:test';
import {employeeSessionLookup} from '../plugin/server/employee-session.ts';
import {managedModel, employeeClientModel, selectedTier} from '../src/model-routing/policy.ts';
import {StreamMetrics} from '../src/model-routing/request-metrics.ts';

test('registry identity is stable across model names; outages are never a negative', async () => {
  let calls=0, unavailable=false;
  const lookup=employeeSessionLookup(async id=>{calls++;if(unavailable)throw Error('offline');return id==='employee';});
  expect(await lookup('employee')).toBe(true);
  unavailable=true;
  expect(await lookup('employee')).toBe(true);
  await expect(lookup('manual')).rejects.toThrow('offline');
  unavailable=false;
  expect(await lookup('manual')).toBe(false);
  expect(calls).toBe(3);
});

test('native Claude clients stay managed, Factory and authors remain exceptions', () => {
  for(const [role,tier] of [['owner','opus'],['product','sonnet'],['qa','haiku']] as const) {
    const model=employeeClientModel(role);
    expect(selectedTier(model)).toBe(tier);
    expect(managedModel({provider:'claude',role,model})).toBe(true);
  }
  expect(managedModel({provider:'claude',role:'story-author',model:'claude-haiku-5-5'})).toBe(false);
  expect(managedModel({provider:'factory-droid',role:'engineering',model:'native'})).toBe(false);
});

test('actual effort is unknown until explicitly reported upstream, never copied from a model suffix', () => {
  const metrics=new StreamMetrics(0,()=>1);
  metrics.observe({type:'message_start',message:{model:'backend:max',thinking:{type:'adaptive'}}});
  expect(metrics.snapshot().reported_effort).toBeUndefined();
  metrics.observe({type:'message_start',message:{output_config:{effort:'high'}}});
  expect(metrics.snapshot().reported_effort).toBe('high');
});

test('employee identity survives plugin restart without trusting a lookalike title or model', async () => {
  const dir=mkdtempSync(join(tmpdir(),'sck-employee-identity-'));
  try {
    const file=join(dir,'registry.json');
    const first=employeeSessionLookup(async()=>false,file);
    first.remember('company-agent');
    const restored=employeeSessionLookup(async()=>{throw Error('database unavailable');},file);
    expect(await restored('company-agent')).toBe(true);
    await expect(restored('manual-agent')).rejects.toThrow('unavailable');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('native Haiku requests stay in the authorized group and preserve requested Max', async () => {
  const {startModelGateway}=await import('../src/model-routing/gateway.ts');
  const {createServer}=await import('node:http');
  let sent:Record<string,unknown>|undefined;
  const rows:Record<string,unknown>[]=[];
  const upstream=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    sent=JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200,{'content-type':'application/json','x-magpie-provider':'vendor','x-magpie-model':'backend'});
    res.end(JSON.stringify({model:'backend',usage:{output_tokens:1}}));
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const port=(upstream.address() as import('node:net').AddressInfo).port;
  const gateway=await startModelGateway({
    upstream:`http://127.0.0.1:${port}`,
    lease:async()=>({employee:'qa',task:'task',fence:1,role:'qa',tier:'haiku',phase:'execute'}),
    record:async row=>{rows.push(row);},complete:async()=>{},
  },0);
  try {
    const response=await fetch(`http://127.0.0.1:${gateway.port}/a/employee%3Aqa/v1/messages`,{
      method:'POST',body:JSON.stringify({model:'claude-haiku-5-5',output_config:{effort:'max'},messages:[]})});
    await response.text();
    expect(response.status).toBe(200);
    expect(sent?.model).toBe('group/sck-haiku');
    expect(sent?.output_config).toEqual({effort:'max'});
    expect(rows[0]?.effort_requested).toBe('max');
    expect(rows[0]?.reported_effort).toBeNull();
  } finally {await gateway.stop();await new Promise<void>((resolve,reject)=>upstream.close(e=>e?reject(e):resolve()));}
});

test('v3 transport setup alone cannot skip native model and Max migration; root cwd rollback restores private settings', async () => {
  const {needsEmployeeActivation}=await import('../src/model-routing/controller.ts');
  const {installRoutingSettings,routingEnv,restoreEmployeeRoutingSettings}=await import('../src/model-routing/gateway.ts');
  const home=mkdtempSync(join(tmpdir(),'sck-routing-rollback-')),comm=join(home,'comm','qa');
  try {
    installRoutingSettings(comm,routingEnv('employee:qa'));
    expect(needsEmployeeActivation(comm,'qa')).toBe(true);
    writeFileSync(join(comm,'.sck-native-client'),JSON.stringify({model:'claude-haiku-5-5',thinking:'max'}));
    expect(needsEmployeeActivation(comm,'qa')).toBe(false);
    expect(restoreEmployeeRoutingSettings(home,'qa','/physical/project')).toBe(true);
    expect(existsSync(join(comm,'.sck-native-client'))).toBe(false);
    expect(needsEmployeeActivation(comm,'qa')).toBe(true);
  } finally {rmSync(home,{recursive:true,force:true});}
});
