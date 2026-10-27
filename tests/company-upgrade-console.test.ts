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
