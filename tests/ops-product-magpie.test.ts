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

// ---- bounded usage paging, binding and route fields ----

type Row=Record<string,unknown>;
const row=(patch:Row={}):Row=>({req:'group/work',served:'deepseek',provider:'sn',providerAccount:'private-account-name',status:200,stop:'stop',ms:2000,in:500,out:50,priced:false,cost:0,route_id:1,t:'2026-10-29T02:59:00Z',...patch});
const other=(n:number):Row[]=>Array.from({length:n},(_,i)=>row({req:'group/other',route_id:i}));
function paged(pages:Row[][],total:number,opts:{failAt?:number;oversizeAt?:number;catalog?:Row[];usageBytes?:number}={}){
 const seen:string[]=[];const now=Date.parse('2026-10-29T03:00:00Z');
 const fetcher=async(url:string|URL|Request)=>{
  const text=String(url);seen.push(text);
  if(text.endsWith('/models'))return Response.json({data:opts.catalog??[{id:'group/work'},{id:'sn/deepseek',pricing:{prompt:'0',completion:'0'}}]});
  if(text.endsWith('/quotas'))return Response.json({data:[{provider:'sn',user:'private-account-name',windows:[]}]});
  const offset=Number(new URL(text).searchParams.get('offset'));const index=offset/200;
  if(opts.failAt===index)return new Response('',{status:500});
  if(opts.oversizeAt===index)return new Response('x'.repeat(1024*1024+1),{status:200});
  return Response.json({total,rows:pages[index]??[]});
 };
 return {seen,fetcher,now};
}
test('a matching row beyond the first page is found and the scan reports its range',async()=>{
 const first=other(200),second=[row({served:'deepseek-v2'})];
 const s=paged([first,second],201);
 const out=await observeProductMagpie({readProvider:()=>provider,fetch:s.fetcher,now:()=>s.now});
 expect(out.usage).toHaveLength(1);expect(out.usage[0]!.servedModel).toBe('deepseek-v2');
 expect(out.coverage).toMatchObject({pages:2,rowsRead:201,matchingRows:1,complete:true,truncated:false,stoppedReason:'end-of-window',scannedOffset:[0,201]});
 expect(s.seen.filter(u=>u.includes('/usage/')).map(u=>new URL(u).searchParams.get('offset'))).toEqual(['0','200']);
 expect(JSON.stringify(out)).not.toContain('private-account-name');
});
test('a complete scan with no match is reported as complete, not as a missing group',async()=>{
 const s=paged([[row({req:'group/other'})]],1);
 const out=await observeProductMagpie({readProvider:()=>provider,fetch:s.fetcher,now:()=>s.now});
 expect(out.route.present).toBe(true);expect(out.usage).toEqual([]);
 expect(out.coverage).toMatchObject({rowsRead:1,matchingRows:0,complete:true,truncated:false,stoppedReason:'end-of-window'});
 expect(out.route.servedModel).toBeNull();expect(out.route.gaps.some(g=>g.field==='servedModel')).toBe(true);
});
test('a huge window stops at the page bound instead of claiming no data',async()=>{
 const s=paged([other(200),other(200),other(200),other(200),other(200)],45852);
 const out=await observeProductMagpie({readProvider:()=>provider,fetch:s.fetcher,now:()=>s.now});
 expect(out.usage).toEqual([]);expect(out.coverage).toMatchObject({rowsRead:1000,pages:5,total:45852,complete:false,truncated:true,stoppedReason:'page-cap',requestCount:7});
 expect(out.coverage.bounds).toMatchObject({pageSize:200,maxPages:5,maxRows:1000});
 expect(s.seen.filter(u=>u.includes('/usage/'))).toHaveLength(5);
});
test('a remote that ignores the page size still stops at the row bound',async()=>{
 const seen:string[]=[];
 const fetcher=async(url:string|URL|Request)=>{
  const text=String(url);seen.push(text);
  if(text.endsWith('/models'))return Response.json({data:[{id:'group/work'},{id:'sn/deepseek'}]});
  if(text.endsWith('/quotas'))return Response.json({data:[]});
  return Response.json({total:5000,rows:other(300)});
 };
 const out=await observeProductMagpie({readProvider:()=>provider,fetch:fetcher,now:()=>Date.parse('2026-10-29T03:00:00Z')});
 expect(out.coverage).toMatchObject({rowsRead:1200,pages:4,complete:false,stoppedReason:'row-cap'});
});
test('a page that does not advance while rows remain fails closed',async()=>{
 const s=paged([[]],500);
 await expect(observeProductMagpie({readProvider:()=>provider,fetch:s.fetcher,now:()=>s.now})).rejects.toThrow('分页未推进');
});
test('a later failing or oversized page fails the whole observation instead of returning a partial success',async()=>{
 const fail=paged([other(200),other(200)],5000,{failAt:1});
 await expect(observeProductMagpie({readProvider:()=>provider,fetch:fail.fetcher,now:()=>fail.now})).rejects.toMatchObject({code:'upstream_error'});
 const big=paged([other(200),other(200)],5000,{oversizeAt:1});
 await expect(observeProductMagpie({readProvider:()=>provider,fetch:big.fetcher,now:()=>big.now})).rejects.toMatchObject({code:'response_too_large'});
});
test('accountBinding equals the derived accountRef and stays unknown without an upstream identity',async()=>{
 const withIdentity=paged([[row()]],1);
 const bound=await observeProductMagpie({readProvider:()=>provider,fetch:withIdentity.fetcher,now:()=>withIdentity.now});
 expect(bound.usage[0]!.accountRef).toMatch(/^mgp[0-9a-f]{24}$/);
 expect(bound.usage[0]!.accountBinding).toBe(bound.usage[0]!.accountRef!);

 const anonymous=paged([[row({providerAccount:undefined,providerKeyId:undefined})]],1,{catalog:[{id:'group/work'},{id:'sn/deepseek'}]});
 const unbound=await observeProductMagpie({readProvider:()=>provider,fetch:anonymous.fetcher,now:()=>anonymous.now});
 expect(unbound.usage[0]!.accountRef).toBeNull();expect(unbound.usage[0]!.accountBinding).toBe('unknown');
 expect(unbound.usage[0]!.pricing.inputPerToken).toBeNull();
});
test('route fields come from the remote read-only surfaces and are null with gaps otherwise',async()=>{
 const rich=paged([[row({t:'2026-10-29T02:58:00Z'})]],1,{catalog:[{id:'group/work',revision:'r-7',digest:'sha256:abc',max_output_tokens:8192,expires_at:'2026-11-01T00:00:00Z'},{id:'sn/deepseek'}]});
 const out=await observeProductMagpie({readProvider:()=>provider,fetch:rich.fetcher,now:()=>rich.now});
 expect(out.route).toMatchObject({present:true,revision:'r-7',digest:'sha256:abc',servedModel:'deepseek',maxOutputTokens:8192,sampledAt:'2026-10-29T02:58:00Z',expiresAt:'2026-11-01T00:00:00Z',gaps:[]});
 expect(out.coverage.routeFieldsComplete).toBe(true);

 const bare=paged([[row()]],1);
 const plain=await observeProductMagpie({readProvider:()=>provider,fetch:bare.fetcher,now:()=>bare.now});
 expect(plain.route).toMatchObject({revision:null,digest:null,maxOutputTokens:null,expiresAt:null});
 expect(plain.route.sampledAt).toBe('2026-10-29T02:59:00Z');
 expect(plain.coverage.routeFieldsComplete).toBe(false);
 expect(plain.route.gaps.map(g=>g.field)).toEqual(['revision','digest','maxOutputTokens','expiresAt']);
});
test('an empty scan reports sampledAt as a gap rather than the local capture time',async()=>{
 const s=paged([[]],0);
 const out=await observeProductMagpie({readProvider:()=>provider,fetch:s.fetcher,now:()=>s.now});
 expect(out.route.sampledAt).toBeNull();expect(out.route.gaps.some(g=>g.field==='sampledAt')).toBe(true);
 expect(out.route.sampledAt).not.toBe(out.capturedAt);
});
