import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
const script=join(import.meta.dir,'../scripts/company-db-runtime.sh');
test('database launcher bounds native caches and tracked allocations without exposing credentials or changing argv storage',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sck-db-budget-'));
 try{const fake=join(root,'fork'),out=join(root,'settings');writeFileSync(fake,'#!/bin/sh\nprintf "%s\\n" "$SURREAL_MEMORY_THRESHOLD" "$SURREAL_ROCKSDB_BLOCK_CACHE_SIZE" "$SURREAL_ROCKSDB_WRITE_BUFFER_SIZE" "$SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER" "$@" > "$FIXTURE_OUTPUT"\n');chmodSync(fake,0o700);
 const env={PATH:process.env.PATH!,FIXTURE_OUTPUT:out,SURREAL_PASS:'fixture-credential'};
 const child=Bun.spawn(['sh',script,fake,'127.0.0.1:0',join(root,'db with spaces')],{env,stdout:'pipe',stderr:'pipe'});expect(await child.exited).toBe(0);expect(readFileSync(out,'utf8').split('\n').slice(0,4)).toEqual(['2147483648','536870912','33554432','4']);const stdout=await new Response(child.stdout).text();expect(stdout).not.toContain('fixture-credential');expect(readFileSync(out,'utf8')).toContain('rocksdb:'+join(root,'db with spaces'));
 const bad=Bun.spawn(['sh',script,fake,'127.0.0.1:0',root],{env:{...env,SURREAL_MEMORY_THRESHOLD:'2GB'},stdout:'ignore',stderr:'ignore'});expect(await bad.exited).toBe(2);
 const override=Bun.spawn(['sh',script,fake,'127.0.0.1:0',root],{env:{...env,SURREAL_MEMORY_THRESHOLD:'3221225472'},stdout:'ignore',stderr:'ignore'});expect(await override.exited).toBe(0);expect(readFileSync(out,'utf8').startsWith('3221225472\n')).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('installation keeps the database entry independent of the active release for rollback',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sck-db-install-'));
 try{const home=join(root,'home'),service=join(root,'service'),bin=join(root,'bin');const {mkdirSync}=await import('node:fs');mkdirSync(join(home,'Library/LaunchAgents'),{recursive:true});mkdirSync(bin);
 for(const name of ['launchctl','curl']){writeFileSync(join(bin,name),'#!/bin/sh\nexit 0\n');chmodSync(join(bin,name),0o700);}
 const fake=join(bin,'company-fork');writeFileSync(fake,'#!/bin/sh\nprintf "%s\\n" "$SURREAL_ROCKSDB_BLOCK_CACHE_SIZE"\n');chmodSync(fake,0o700);
 const env={PATH:bin+':'+process.env.PATH,HOME:home,SCK_SERVICE_HOME:service,SCK_SURREAL_BIN:fake};
 const install=Bun.spawn(['sh',join(import.meta.dir,'../scripts/company-db.sh'),'install'],{env,stdout:'ignore',stderr:'pipe'});expect(await install.exited).toBe(0);
 const launcher=readFileSync(join(service,'bin/company-db'),'utf8');expect(launcher).toContain(join(service,'bin/company-db-runtime'));expect(launcher).not.toContain('/active/scripts/company-db-runtime');
 const run=Bun.spawn(['sh',join(service,'bin/company-db')],{env,stdout:'pipe',stderr:'pipe'});expect(await run.exited).toBe(0);expect(await new Response(run.stdout).text()).toContain('536870912');
 }finally{rmSync(root,{recursive:true,force:true});}
});
