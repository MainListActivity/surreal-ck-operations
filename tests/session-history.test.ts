import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readSessionHistory,historyEntry} from '../plugin/server/session-history.ts';
const agentId='11111111-1111-4111-8111-111111111111',sessionId='22222222-2222-4222-8222-222222222222';
function fixture(provider='claude'){
 const home=mkdtempSync(join(tmpdir(),'sck-history-')),paseoHome=join(home,'.paseo');
 const registry=join(paseoHome,'agents','repo');mkdirSync(registry,{recursive:true});
 const record={id:agentId,provider,title:'员工工作',labels:{company:'surreal-ck'},lastStatus:'closed',persistence:{sessionId}};
 const registryFile=join(registry,agentId+'.json');writeFileSync(registryFile,JSON.stringify(record));
 const root=join(home,provider==='claude'?'.claude':'.factory',provider==='claude'?'projects':'sessions','repo');mkdirSync(root,{recursive:true});
 const file=join(root,sessionId+'.jsonl');
 const read=(cursor=0)=>readSessionHistory({home,paseoHome,agentId,cursor});
 return {home,record,registryFile,file,read,close:()=>rmSync(home,{recursive:true,force:true})};
}
test('closed unarchived and archived histories read without a runtime, credential or lease',async()=>{
 const f=fixture();try{writeFileSync(f.file,JSON.stringify({type:'assistant',timestamp:'2026-10-30T19:08:39Z',message:{role:'assistant',content:[{type:'thinking',thinking:'hidden'},{type:'text',text:'任务已提交'}]}})+'\n');
 expect((await f.read()).entries).toEqual([{role:'assistant',at:'2026-10-30T19:08:39Z',text:'任务已提交'}]);
 writeFileSync(f.registryFile,JSON.stringify({...f.record,archivedAt:'2026-10-30T20:00:00Z'}));expect((await f.read()).entries).toHaveLength(1);
 }finally{f.close();}
});
test('Factory native transcript is readable after its original cwd is gone',async()=>{
 const f=fixture('factory-droid');try{writeFileSync(f.file,JSON.stringify({type:'message',message:{role:'user',content:[{type:'text',text:'核对交付'}]}})+'\n');expect((await f.read()).entries[0]?.text).toBe('核对交付');}finally{f.close();}
});
test('pages are byte bounded, complete and stable across UTF-8 and large histories',async()=>{
 const f=fixture();try{writeFileSync(f.file,Array.from({length:103},(_,n)=>JSON.stringify({type:'assistant',message:{content:[{type:'text',text:`第${n}条`}]}})).join('\n')+'\n');
 let cursor=0;const texts:string[]=[];for(let i=0;i<10;i++){const p=await f.read(cursor);texts.push(...p.entries.map(e=>e.text));if(p.next===undefined)break;expect(p.next).toBeGreaterThan(cursor);cursor=p.next;}
 expect(texts).toEqual(Array.from({length:103},(_,n)=>`第${n}条`));
 }finally{f.close();}
});
test('an oversized record never wedges pagination and the following work is preserved',async()=>{
 const f=fixture();try{writeFileSync(f.file,JSON.stringify({type:'assistant',message:{content:'x'.repeat(3*1024*1024)}})+'\n'+JSON.stringify({type:'assistant',message:{content:'最终交付'}})+'\n');let cursor=0;const texts:string[]=[];for(let i=0;i<6;i++){const p=await f.read(cursor);texts.push(...p.entries.map(e=>e.text));if(p.next===undefined)break;expect(p.next).toBeGreaterThan(cursor);cursor=p.next;}expect(texts).toContain('最终交付');expect(texts.join('')).not.toContain('x'.repeat(100));}finally{f.close();}
});
test('hidden reasoning, native configuration and tool inputs are never rendered; common credentials are redacted',()=>{
 const row=historyEntry({type:'assistant',message:{content:[{type:'thinking',thinking:'hidden'},{type:'tool_use',name:'Bash',input:{command:'secret command'}},{type:'text',text:'Authorization: Bearer abcdef-secret'}]}})!;
 expect(row.text).toContain('[工具调用] Bash');expect(row.text).not.toContain('secret command');expect(row.text).not.toContain('abcdef-secret');expect(row.text).not.toContain('hidden');
});
test('foreign agents, malformed IDs and transcript symlinks outside native storage are rejected',async()=>{
 const f=fixture();try{writeFileSync(f.registryFile,JSON.stringify({...f.record,labels:{}}));await expect(f.read()).rejects.toThrow('公司员工');
 writeFileSync(f.registryFile,JSON.stringify(f.record));const outside=join(f.home,'outside');writeFileSync(outside,'{}');symlinkSync(outside,f.file);await expect(f.read()).rejects.toThrow('未找到本地历史');
 await expect(readSessionHistory({home:f.home,paseoHome:f.home,agentId:'../private',cursor:0})).rejects.toThrow('无效');
 }finally{f.close();}
});
