import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConsoleFetch,consoleUrl} from '../plugin/server/console.ts';
test('owner console upgrade route checks origin and renders version notes as text',async()=>{
 const home=mkdtempSync(join(tmpdir(),'upgrade-console-'));let starts=0;
 const upgrades={inbox:async()=>({gates:[],questions:[],notices:[],pendingCommands:0,upgrades:{current:{version:'0.1.0',sha:'a'.repeat(40)},items:[]}}),start:async(input:any)=>{starts++;expect(input.taskVersion).toBe(2);return {jobId:'fixture',status:'queued'};}};
 const fetcher=createConsoleFetch({home,lanBase:()=> 'http://127.0.0.1',company:async()=>({upgrades}) as never});
 try{
  const base=consoleUrl(home,()=> 'http://127.0.0.1').replace(/\/$/,'')+'/';
  const page=await (await fetcher(new Request(base))).text();
  const script=page.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  expect(()=>new Function(script)).not.toThrow();
  expect(page).toContain('上线内容');expect(page).toContain('影响范围');expect(page).toContain('升级至 v');
  const body=JSON.stringify({taskId:'fixture',taskVersion:2,digest:'b'.repeat(64)});
  expect((await fetcher(new Request(base+'api/upgrade',{method:'POST',headers:{origin:'https://other.invalid','content-type':'application/json'},body}))).status).toBe(403);
  expect(starts).toBe(0);
  expect((await fetcher(new Request(base+'api/upgrade',{method:'POST',headers:{origin:'http://127.0.0.1','content-type':'application/json'},body}))).status).toBe(200);expect(starts).toBe(1);
 }finally{rmSync(home,{recursive:true,force:true});}
});


test('automatic upgrade policy uses an owner route with strict boolean input and cross-origin refusal',async()=>{
 const home=mkdtempSync(join(tmpdir(),'auto-upgrade-console-'));const values:boolean[]=[];
 const upgrades={setAuto:async(enabled:boolean,source:string)=>{expect(source).toContain('owner:');values.push(enabled);return {enabled,revision:values.length};}};
 const fetcher=createConsoleFetch({home,lanBase:()=> 'http://127.0.0.1',company:async()=>({upgrades}) as never});
 try{
  const base=consoleUrl(home,()=> 'http://127.0.0.1').replace(/\/$/,'')+'/';
  const request=(enabled:unknown,origin='http://127.0.0.1')=>fetcher(new Request(base+'api/upgrade/automatic',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({enabled})}));
  expect((await request(true,'https://untrusted.invalid')).status).toBe(403);expect(values).toEqual([]);
  expect((await request('true')).status).toBe(400);expect(values).toEqual([]);
  expect(await (await request(true)).json()).toEqual({enabled:true,revision:1});
  expect(await (await request(false)).json()).toEqual({enabled:false,revision:2});
  const page=await (await fetcher(new Request(base))).text();
  expect(page).toContain("api('upgrade/automatic'");
  expect(page).toContain('自动升级已开启');
 }finally{rmSync(home,{recursive:true,force:true});}
});
