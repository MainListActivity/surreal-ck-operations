import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {installNativeService} from '../scripts/native-service.ts';
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
