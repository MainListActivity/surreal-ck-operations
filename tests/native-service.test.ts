import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {installNativeService,launcherScript,CONFIRM_ATTEMPTS} from '../scripts/native-service.ts';
import {loadNativeOwnerCredential} from '../src/runner/env.ts';
test('独立服务离线安装支持含空格和引号的路径，不改变路由，不添加定时任务',()=>{
  const home=mkdtempSync(join(tmpdir(),"native 'service-"));
  try {
    mkdirSync(join(home,'current/server/vendor/src/runner'),{recursive:true});mkdirSync(join(home,'bin'));
    writeFileSync(join(home,'current/server/vendor/src/runner/run.ts'),'');writeFileSync(join(home,'bin/bun-runtime.sh'),'');
    const config=join(home,'config.json');writeFileSync(config,JSON.stringify({
      commands:{claude:['/fixture/claude','/extra/bun'],'codex-cloud':['/fixture/launch.sh','/extra/bun']},
      lanes:{'codex-cloud':{bin:{codex:'/Users/y/node/bin/codex',gh:'/fixture/gh'}}},
    }));
    for(const platform of ['darwin','linux']){
      const path=installNativeService({home,userHome:home,id:'fixture',config,platform,load:false});
      const text=readFileSync(path,'utf8');expect(text).not.toContain('StartInterval');expect(text).not.toContain('[Timer]');
      execFileSync('/bin/sh',['-n',join(home,'bin/native-fixture.sh')]);
      // commands 与 lanes.*.bin 里绝对路径的目录追加进服务 PATH（去重、既有条目在前）。
      const launcher=readFileSync(join(home,'bin/native-fixture.sh'),'utf8');
      expect(launcher).toContain('/Users/y/node/bin');
      expect(launcher.split('/fixture').length-1).toBeGreaterThan(0);
      expect(launcher.split(':/extra').length-1).toBe(1);   // dedupe：/extra 只出现一次
      // 既有条目在前：最后一个标准目录 /sbin 仍在所有新增目录之前。
      const pathLine=(launcher.match(/^export PATH='(.+)'$/m)??[])[1]!;
      expect(pathLine.indexOf('/sbin')).toBeLessThan(pathLine.indexOf('/Users/y/node/bin'));
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

// 启动脚本的自更新兜底：真实 /bin/sh 执行，bun 替身只打印入口路径。
function launcherHome() {
  const home=mkdtempSync(join(tmpdir(),'native launcher-'));
  for (const sha of ['a','b']) {
    const dir=join(home,'plugin-releases',sha.repeat(40),'plugin/server/vendor/src/runner');
    mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'run.ts'),'');
  }
  mkdirSync(join(home,'bin'));mkdirSync(join(home,'updater'));
  writeFileSync(join(home,'bin/bun-runtime.sh'),'resolve_bun() { BUN=/bin/echo; }\n');
  const script=join(home,'bin/launch.sh');
  writeFileSync(script,launcherScript({home,id:'fixture',config:join(home,'config.json'),path:'/usr/bin:/bin'}),{mode:0o700});
  const payload=(sha:string)=>join(home,'plugin-releases',sha.repeat(40),'plugin');
  const point=(sha:string)=>{rmSync(join(home,'current'),{force:true});symlinkSync(payload(sha),join(home,'current'));};
  const run=()=>execFileSync('/bin/sh',[script],{encoding:'utf8'}).trim();
  return {home,payload,point,run};
}

test('启动脚本：没有待确认标记时照常启动 current 里的执行端',()=>{
  const {home,point,run,payload}=launcherHome();
  try {
    point('a');
    expect(run()).toBe(join(home,'current/server/vendor/src/runner/run.ts'));
    expect(realpathSync(join(home,'current'))).toBe(realpathSync(payload('a')));
  } finally {rmSync(home,{recursive:true,force:true});}
});

test(`启动脚本：新版本连续 ${CONFIRM_ATTEMPTS} 次启动未确认后指回旧版本，并留下回退计数`,()=>{
  const {home,point,run,payload}=launcherHome();
  try {
    point('b');
    writeFileSync(join(home,'updater/pending'),`${payload('b')}\n${payload('a')}\n{}\n`);
    for (let n=1;n<=CONFIRM_ATTEMPTS;n++) {
      run();
      expect(readFileSync(join(home,'updater/pending.attempts'),'utf8').trim()).toBe(String(n));
      expect(realpathSync(join(home,'current'))).toBe(realpathSync(payload('b')));
    }
    run();
    expect(realpathSync(join(home,'current'))).toBe(realpathSync(payload('a')));
    expect(readFileSync(join(home,'updater/pending.rolled-back'),'utf8').trim()).toBe(String(CONFIRM_ATTEMPTS));
    // 已回退：标记仍在（留给旧版本补记），但 current 不再指向新版本，不再计数。
    run();
    expect(realpathSync(join(home,'current'))).toBe(realpathSync(payload('a')));
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('启动脚本：没有旧版本可回退时只计数，不改 current',()=>{
  const {home,point,run,payload}=launcherHome();
  try {
    point('b');
    writeFileSync(join(home,'updater/pending'),`${payload('b')}\n\n{}\n`);
    for (let n=0;n<=CONFIRM_ATTEMPTS+1;n++) run();
    expect(realpathSync(join(home,'current'))).toBe(realpathSync(payload('b')));
    expect(existsSync(join(home,'updater/pending.rolled-back'))).toBe(false);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('启动脚本：运行目录换成 src/ 布局时仍能找到执行端入口',()=>{
  const {home,run}=launcherHome();
  try {
    const dir=join(home,'plugin-releases','c'.repeat(40),'runtime/src/runner');
    mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'run.ts'),'');
    symlinkSync(join(home,'plugin-releases','c'.repeat(40),'runtime'),join(home,'current'));
    expect(run()).toBe(join(home,'current/src/runner/run.ts'));
  } finally {rmSync(home,{recursive:true,force:true});}
});
