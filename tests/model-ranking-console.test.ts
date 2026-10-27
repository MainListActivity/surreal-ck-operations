import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createConsoleFetch,consoleUrl} from '../plugin/server/console.ts';
import {startPreview} from '../plugin/server/preview.ts';
import {DEFAULT_RANKING_RULES} from '../src/model-routing/ranking.ts';
import {rankingPage} from '../plugin/server/ranking-page.ts';
import {relayDesignCss} from '../plugin/shared/relay-design.ts';
const homes:string[]=[];
afterEach(()=>{for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'sck-ranking-console-'));homes.push(home);let settings={ranking_rules:'原规则',ranking_refresh_minutes:5};const resets:number[]=[];const pins:unknown[]=[];
 const db={query:async(sql:string,vars?:any)=>{
  if(sql.startsWith('SELECT ranking_rules'))return [settings];
  if(sql.startsWith('SELECT at,error,orders,results,pins'))return [{at:new Date('2026-10-24T08:00:00Z'),orders:{},results:{}}];
  if(sql.startsWith('SELECT tier,at,payload'))return [[]];
  if(sql.startsWith('UPSERT company_meta:model_routing')){settings={ranking_rules:vars.rules,ranking_refresh_minutes:vars.minutes};return [undefined];}
  throw Error('Unexpected query');
 }};
 const fetch=createConsoleFetch({home,lanBase:()=> 'http://localhost',company:async()=>({db:{db},modelRanking:{setPin:async(...args:unknown[])=>{pins.push(args);},reset:(minutes:number)=>resets.push(minutes)}} as any)});
 const base=consoleUrl(home,()=> 'http://localhost')+'/';
 const request=(path:string,body?:unknown,origin?:string)=>fetch(new Request(base+path,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)}));
 return {fetch,request,resets,pins,home,base};
}
test('owner ranking page uses supplied Figma layout, real API, light/dark tokens and a review-console return link',async()=>{
 const f=fixture();expect((await f.fetch(new Request('http://localhost/o/wrong/ranking'))).status).toBe(404);
 const response=await f.request('ranking');expect(response.status).toBe(200);const html=await response.text();
 for(const part of ['id="policy-editor"','api/model-ranking/preview','class="workspace"','class="settings-panel"','class="results-panel"','class="model-list"','model-row-main','role="tablist"','href="./"','api/model-ranking','aria-expanded'])expect(html).toContain(part);
 expect(html).toContain('prefers-color-scheme:light');expect(html).toContain('<title>模型排序');expect(html).toContain('Opus 的成员、顺序和组内配置由你在 Magpie 手动维护');expect(html).not.toContain('seedModels');expect(html).not.toContain('makeModels');
 const script=rankingPage.match(/<script>([\s\S]*?)<\/script>/)![1]!;
 expect(()=>new Function(script)).not.toThrow();
 expect(html).not.toMatch(/\.metrics small\s*\{\s*display:\s*none/);
 expect(script).toContain('EWMA');
 expect(html).not.toContain('<textarea');
 expect(script).toContain("$('rule').textContent=state.rules");
 expect(script).not.toContain("$('rule').value");
 expect(script).toContain('rules:state.rules,refreshMinutes:Number');
 expect((await (await f.request('')).text())).toContain("location.href='ranking'");
 expect(relayDesignCss).toContain('grid-template-columns: 340px minmax(0, 1fr)');
});
test('owner ranking GET shares settings without triggering a refresh; saves validate and reset the existing refresher',async()=>{
 const f=fixture();const get=await f.request('api/model-ranking');expect(get.status).toBe(200);expect(await get.json()).toMatchObject({rules:DEFAULT_RANKING_RULES,refreshMinutes:5});expect(f.resets).toEqual([]);
 expect((await f.request('api/model-ranking',{rules:'速度优先',refreshMinutes:2},'https://other.example')).status).toBe(403);
 for(const body of [{rules:'x',refreshMinutes:15},{rules:5,refreshMinutes:5},{rules:'x'.repeat(8001),refreshMinutes:5}])expect((await f.request('api/model-ranking',body)).status).toBe(400);
 expect(f.resets).toEqual([]);expect((await f.request('api/model-ranking',{rules:'速度优先',refreshMinutes:2},'http://localhost')).status).toBe(200);
 expect(f.resets).toEqual([2]);expect(await (await f.request('api/model-ranking')).json()).toMatchObject({rules:DEFAULT_RANKING_RULES,refreshMinutes:2});
});

test('owner pin endpoint validates membership arguments and origin independently of rule saves',async()=>{
 const f=fixture();
 expect((await f.request('api/model-ranking/pin',{group:'sck-haiku',model:'p/a:max',pinned:true},'https://other.example')).status).toBe(403);
 for(const body of [{group:'sck-fable',model:'p/a',pinned:true},{group:'sck-haiku',model:'',pinned:true},{group:'sck-haiku',model:'p/a',pinned:'true'}])expect((await f.request('api/model-ranking/pin',body)).status).toBe(400);
 expect(f.pins).toEqual([]);
 expect((await f.request('api/model-ranking/pin',{group:'sck-haiku',model:'p/a:max',pinned:true},'http://localhost')).status).toBe(200);
 expect(f.pins).toEqual([['sck-haiku','p/a:max',true]]);expect(f.resets).toEqual([]);
});

test('real preview HTTP transport preserves browser origin for pinning and rejects foreign sites',async()=>{
 const f=fixture();const server=startPreview({home:f.home,port:0,secret:'',consoleFetch:f.fetch,coreFactory:()=>async()=>new Response('unused'),log:()=>{}});
 try {
  const port=await server.ready,origin=`http://127.0.0.1:${port}`,path=new URL(f.base).pathname+'api/model-ranking/pin';
  const send=(site:string)=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',origin:site},body:JSON.stringify({group:'sck-haiku',model:'p/a:max',pinned:true})});
  const good=await send(origin);expect(good.status).toBe(200);expect(f.pins).toEqual([['sck-haiku','p/a:max',true]]);
  expect((await send('http://other.example')).status).toBe(403);expect(f.pins).toHaveLength(1);
 } finally {await server.stop();}
});
