import {expect,test} from 'bun:test';
import {generatedModel,routable,classify,modelIdentity} from '../src/model-routing/policy.ts';
import {askAlias,aliasCandidates,aliasMap} from '../src/model-routing/alias.ts';
import {reconcileInventory,inventoryView,type ModelInventory} from '../src/model-routing/inventory.ts';
import {generatedGroupCleanup} from '../src/model-routing/group-cleanup.ts';
import {modelFacts,jevOrder} from '../src/model-routing/ranking.ts';
import {summarizeModelEvidence} from '../src/scoring.ts';
const generated=['group/sck-haiku','auto/GLM-5.3','remote-magpie/group/work','remote-magpie/auto/GLM-5.3:max','other/remote-magpie/auto/model:high'];

test('all generated router path segments are rejected, including remote wrappers and effort suffixes',()=>{
 for(const id of generated){
  expect(generatedModel(id)).toBe(true);expect(routable({id})).toBe(false);
  expect(classify([{id}])).toEqual([]);expect(aliasCandidates(id)).toEqual([]);
  expect(modelIdentity('remote-magpie',id)).toBeUndefined();
 }
 for(const id of ['claude/claude-haiku-5-5:max','remote-magpie/qoder/qfmodel','vendor/autoencoder','vendor/grouped-model'])expect(generatedModel(id)).toBe(false);
});

test('generated ids never reach Jev identity or ranking requests, even through direct entrypoints',async()=>{
 let calls=0;const jev={model:'test',ask:async()=>{calls++;throw Error('must not be called');}};
 for(const id of generated)await expect(askAlias(jev,{id})).rejects.toThrow('not eligible');
 const facts=generated.map(id=>({id,model:id,provider:'remote',accounts:[],price:{free:false}}));
 expect(await jevOrder(jev,'haiku','',facts)).toEqual([]);
 expect(modelFacts(generated,{catalog:[],quota:new Map(),usage:new Map(),performance:new Map()})).toEqual([]);
 expect(calls).toBe(0);
});

test('historical alias and group decisions stay recorded but cannot create pending judgements or model evidence',()=>{
 const id=generated[3]!;const alias={slug:'claude-haiku-5-5',by:'owner' as const,at:'2026-10-28'};
 expect(aliasMap({[id]:alias})).toEqual({});
 const inv:ModelInventory={version:1,at:'',present:[],grouped:{},decisions:{}};
 reconcileInventory(inv,[{id}],{'sck-haiku':[id]}, {[id]:alias});
 expect(inv.decisions[id]).toBeDefined();
 expect(inventoryView(inv)).toMatchObject({grouped:[],decidedUngrouped:[],pending:[]});
 expect(summarizeModelEvidence([{employee:'e',model:id,fence:1,phase:'execute',at:'2026-10-28'}])).toEqual([]);
});

test('one-time cleanup retains member order and every group setting; unrelated groups stay untouched',()=>{
 const groups=[{id:'sck-haiku',name:'custom',members:['vendor/autoencoder',generated[3]!,'vendor/real:max'],levels:['max'],routing:'order'},
 {id:'sck-opus',members:['group/router'],routing:'manual',affinity:'session'},
 {id:'personal',members:['group/valid-nesting']}];
 const plan=generatedGroupCleanup(groups);
 expect(plan.map(g=>({id:g.id,models:g.models,removed:g.removed}))).toEqual([
  {id:'sck-haiku',models:['vendor/autoencoder','vendor/real:max'],removed:[generated[3]!]},{id:'sck-opus',models:[],removed:['group/router']}]);
 expect(plan[0]!.existing).toBe(groups[0]);expect(groups[0]!.members).toHaveLength(3);
 expect(generatedGroupCleanup([{id:'sck-fable',members:null}])).toEqual([]);
});

test('mixed Jev input renumbers only concrete models and never asks a generated model question',async()=>{
 const group={id:'remote-magpie/auto/claude-haiku-5-5',accounts:[],price:{free:false}};
 const real={id:'claude/claude-haiku-5-5',accounts:[],price:{free:false}};
 expect(classify([{id:group.id},{id:real.id}]).map(m=>m.id)).toEqual([real.id]);
 const order=await jevOrder({model:'test',ask:async(payload:any,questions:any)=>{
  expect(Object.keys(payload.models)).toEqual(['m0']);expect(payload.models.m0.id).toBe(real.id);
  expect(Object.keys(questions)).toEqual(['m0']);
  return {model:'test',answers:{m0:{type:'score' as const,score:3,confidence:1}}};
 }},'haiku','',[group,real]);
 expect(order).toEqual([real.id]);
});

test('old generated execution rows never require or receive a final model assessment',async()=>{
 const {scoreModels}=await import('../src/model-routing/store.ts');
 const writes:unknown[]=[];let reads=0;
 const db={select:async()=>({state:'done'}),query:async(_sql:string,vars?:Record<string,unknown>)=>{
  if(reads++===0)return [[{model:'remote-magpie/auto/x',status:200,completed:true,domain:'general'},
   {model:'vendor/real',status:200,completed:true,domain:'general'}]];
  writes.push(vars);return [];
 }};
 expect(await scoreModels(db as never,'task','employee',4)).toEqual(['vendor/real']);
 const data=writes[0] as Record<string,any>;expect(data.data0.model).toBe('vendor/real');expect(data.data1).toBeUndefined();
});


test('cleanup SaveGroup requests retain owner settings and empty groups; failures propagate',async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {saveMagpieGroups}=await import('../src/model-routing/magpie-admin.ts');
 const dir=await mkdtemp(join(tmpdir(),'sck-group-api-')),cli=join(dir,'magpie'),out=join(dir,'requests.jsonl');
 try{
  await writeFile(cli,`#!/usr/bin/env node
const http=require('node:http'),fs=require('node:fs');
const addr=process.argv[process.argv.indexOf('--addr')+1],port=Number(addr.split(':').pop());
http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{if(req.method==='POST'){fs.appendFileSync(${JSON.stringify(out)},body+'\\n');const data=JSON.parse(body);res.statusCode=data.id==='sck-fail'?503:200;}res.end('ok');});}).listen(port,'127.0.0.1');
`,{mode:0o700});
  const original={id:'sck-opus',name:'Owner choice',routing:'order',affinity:'session',levels:['max'],members:['group/router']};
  await saveMagpieGroups(cli,generatedGroupCleanup([original]));
  expect(JSON.parse((await readFile(out,'utf8')).trim())).toEqual({...original,members:[]});
  await expect(saveMagpieGroups(cli,[{id:'sck-fail',models:['vendor/model']}])).rejects.toThrow('HTTP 503');
 }finally{await rm(dir,{recursive:true,force:true});}
},10000);
