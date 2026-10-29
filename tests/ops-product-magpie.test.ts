import {expect,test} from 'bun:test';
import {OpsBroker} from '../src/ops/broker.ts';
import {FakeCompany,FakeWorld,brokerConfig} from './support/ops-world.ts';
function rig(){const world=new FakeWorld(),company=new FakeCompany();company.env('surreal_ck','production',brokerConfig());return {company,world,token:company.lease('qa-1','qa','task-1','surreal_ck'),broker:new OpsBroker({core:company.core,projects:company.projects as never,secretKey:()=>Buffer.alloc(32),fetch:world.fetch,now:world.now})};}
test('product tasks cannot diagnose the Mac subscription gateway as the product gateway',async()=>{
 const r=rig();for(const [tool,args] of [['ops_magpie_route_sample',{alias:'MAGPIE',purpose:'FV06 diagnosis'}],['ops_magpie_route_restore',{mode:'plan',alias:'MAGPIE',purpose:'FV06 diagnosis'}]] as const){
  await expect(r.broker.call(r.token,'task-1',tool,args)).rejects.toMatchObject({code:'invalid',details:{reason:'product_gateway_source_mismatch',nextTool:'ops_product_magpie_observe'}});
 }
 expect(r.world.requests).toHaveLength(0);
});

import {observeProductMagpie} from '../src/ops/product-magpie.ts';
const provider={id:'remote-magpie',chat:'https://remote.test/ofm/v1',key:'secret-fixture-key'};
function remote(){const requests:Array<{url:string;method:string|undefined}>=[];const now=Date.parse('2026-10-29T03:00:00Z');
 const catalog={data:[{id:'group/work'},{id:'sn/deepseek',pricing:{prompt:'0',completion:'0'}}]};
 const quotas={data:[{provider:'sn',user:'private-account-name',kind:'subscription',windows:[{name:'daily',remaining:50}],readAt:new Date(now).toISOString()}]};
 const usage={total:1,rows:[{req:'group/work',served:'deepseek',provider:'sn',providerAccount:'private-account-name',status:200,stop:'stop',ms:2000,in:500,out:50,priced:false,cost:0,route_id:123,t:new Date(now).toISOString()}]};
 const fetcher=async(url:string|URL|Request,init?:RequestInit)=>{requests.push({url:String(url),method:init?.method});expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-fixture-key');return Response.json(String(url).endsWith('/models')?catalog:String(url).endsWith('/quotas')?quotas:usage);};
 return {requests,catalog,quotas,usage,fetcher,now};
}
test('remote observation uses actual req/served/in/out and string prices without a local group or sealed supplier alias',async()=>{
 const r=remote(),out=await observeProductMagpie({readProvider:()=>provider,fetch:r.fetcher,now:()=>r.now});
 expect(r.requests.every(r=>r.url.startsWith('https://remote.test/ofm/v1/')&&r.method==='GET')).toBe(true);
 expect(out.route.present).toBe(true);expect(out.authorization.executable).toBe(false);expect(out.authorization.newBudgetGranted).toBe(false);
 expect(out.usage[0]).toMatchObject({completed:true,servedModel:'deepseek',usage:{input:500,output:50},pricing:{free:true},cost:null,costUnknown:true,routeId:'123'});
 expect(out.usage[0]!.accountRef).toBe(out.accounts[0]!.accountRef);
 expect(JSON.stringify(out)).not.toContain(provider.key);expect(JSON.stringify(out)).not.toContain('private-account-name');
});
test('missing bounded historical samples does not become a missing-group or missing-account diagnosis',async()=>{
 const r=remote();r.usage.rows[0]!.req='group/other';r.usage.total=300;
 const out=await observeProductMagpie({readProvider:()=>provider,fetch:r.fetcher,now:()=>r.now});expect(out.route.present).toBe(true);expect(out.usage).toEqual([]);expect(out.coverage.complete).toBe(false);
});
test('partial request and unknown pricing are not fabricated into completion or free pricing',async()=>{
 const r=remote();r.usage.rows[0]!.stop='';r.catalog.data[1]!.pricing=undefined;
 const out=await observeProductMagpie({readProvider:()=>provider,fetch:r.fetcher,now:()=>r.now});expect(out.usage[0]!.completed).toBe(false);expect(out.usage[0]!.pricing.free).toBe(false);expect(out.usage[0]!.pricing.inputPerToken).toBeNull();
});
test('untrusted overrides, missing connection, redirects and malformed bodies fail without local fallback',async()=>{
 const r=remote();for(const config of [undefined,{...provider,chat:'http://127.0.0.1:3425/v1'},{...provider,chat:'https://user:pass@remote.test/v1'}])await expect(observeProductMagpie({readProvider:()=>config,fetch:r.fetcher})).rejects.toMatchObject({code:'not_configured'});expect(r.requests).toHaveLength(0);
 await expect(observeProductMagpie({readProvider:()=>provider,fetch:async()=>new Response('secret-fixture-key',{status:302})})).rejects.toThrow('HTTP 302');
 await expect(observeProductMagpie({readProvider:()=>provider,fetch:async()=>Response.json({bad:true})})).rejects.toThrow('结构不兼容');
});
test('employee surface exposes remote observation and rejects arbitrary source overrides',async()=>{
 const r=rig();const info=await r.broker.call(r.token,'task-1','ops_info') as any;expect(info.productMagpieObservation.source).toBe('configured-remote-magpie');expect(info.magpieRouteSampling.applicable).toBe(false);
 await expect(r.broker.call(r.token,'task-1','ops_product_magpie_observe',{url:'http://127.0.0.1:3425'})).rejects.toMatchObject({code:'invalid'});
});

test('64-bit route ids retain their original integer text for product correlation',async()=>{
 const r=remote();const fetcher=async(url:string|URL|Request,init?:RequestInit)=>String(url).includes('/usage/')?new Response(JSON.stringify(r.usage).replace('"route_id":123','"route_id":9007199254740993')):r.fetcher(url,init);
 const result=await observeProductMagpie({readProvider:()=>provider,fetch:fetcher,now:()=>r.now});expect(result.usage[0]!.routeId).toBe('9007199254740993');
});
