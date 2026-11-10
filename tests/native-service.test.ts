import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {installNativeService} from '../scripts/native-service.ts';
import {loadNativeOwnerCredential} from '../src/runner/env.ts';
test('独立服务离线安装支持含空格和引号的路径，不改变路由，不添加定时任务',()=>{
  const home=mkdtempSync(join(tmpdir(),"native 'service-"));
  try {
    mkdirSync(join(home,'current/server/vendor/src/runner'),{recursive:true});mkdirSync(join(home,'bin'));
    writeFileSync(join(home,'current/server/vendor/src/runner/run.ts'),'');writeFileSync(join(home,'bin/bun-runtime.sh'),'');
    const config=join(home,'config.json');writeFileSync(config,JSON.stringify({commands:{claude:['/fixture/claude']}}));
    for(const platform of ['darwin','linux']){
      const path=installNativeService({home,userHome:home,id:'fixture',config,platform,load:false});
      const text=readFileSync(path,'utf8');expect(text).not.toContain('StartInterval');expect(text).not.toContain('[Timer]');
      execFileSync('/bin/sh',['-n',join(home,'native/fixture/run.sh')]);
    }
    expect(existsSync(join(home,'private/runtime-routes.json'))).toBe(false);
    expect(()=>installNativeService({home,userHome:home,id:'../bad',config,platform:'darwin',load:false})).toThrow();
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('独立执行端只使用已有私有老板凭证，不生成或覆盖文件；缺失与空文件拒绝启动', () => {
  const home=mkdtempSync(join(tmpdir(),'native-owner-'));
  const original=process.env.SCK_OWNER_TOKEN;
  try {
    mkdirSync(join(home,'private'));
    const path=join(home,'private/owner-token');
    expect(()=>loadNativeOwnerCredential(home)).toThrow();
    expect(existsSync(path)).toBe(false);
    writeFileSync(path,'\n',{mode:0o600});expect(()=>loadNativeOwnerCredential(home)).toThrow();
    writeFileSync(path,'isolated-fixture-owner-credential\n',{mode:0o600});
    loadNativeOwnerCredential(home);
    expect(process.env.SCK_OWNER_TOKEN === readFileSync(path,'utf8').trim()).toBe(true);
    expect(readFileSync(path,'utf8').endsWith('\n')).toBe(true);
  } finally {
    if(original===undefined) delete process.env.SCK_OWNER_TOKEN;else process.env.SCK_OWNER_TOKEN=original;
    rmSync(home,{recursive:true,force:true});
  }
});
