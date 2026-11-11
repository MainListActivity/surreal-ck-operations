import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { employeeModelEnv } from '../src/runner/model-env.ts';
import { NativeRuntime } from '../src/runner/native.ts';
import { scrubEnv, SANDBOX_MARKER } from '../src/runner/launch-env.ts';
import type { TurnEnded } from '../src/runner/contracts.ts';

const switches = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TASKS: '0' };
const opposite = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '0', CLAUDE_CODE_ENABLE_TASKS: '1' };
const pickSwitches = (env: Record<string,string | undefined>) => Object.fromEntries(Object.keys(switches).map(key => [key,env[key]]));

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'sck-native-progress-')));
  const comm = join(root,'comm','employee');
  mkdirSync(join(root,'private'),{recursive:true});
  mkdirSync(join(comm,'.claude'),{recursive:true});
  writeFileSync(join(root,'private','magpie-remote.key'),'fixture-only-key');
  return {root,comm,sidecar:{sessionOf:()=>({employee:'employee',comm,role:'engineering',task:'fixture-task'})}};
}

test('仅原生 Claude 将可采集的 TodoWrite 开关写入环境与最终私有设置',()=>{
  const f = fixture();
  try {
    const settings = join(f.comm,'.claude','settings.local.json');
    writeFileSync(settings,JSON.stringify({model:'group/sck-sonnet',env:{...opposite,KEEP:'preserved'}}));
    const env = employeeModelEnv({agentId:'agent',provider:'claude',runtime:'native',env:{SCK_COMM_DIR:f.comm}},f.sidecar,f.root);
    expect(pickSwitches(env)).toEqual(switches);
    expect(env.SCK_CLAUDE_SETTINGS).toBe(settings);
    const saved = JSON.parse(readFileSync(settings,'utf8'));
    expect(pickSwitches(saved.env)).toEqual(switches);
    expect(saved.env.KEEP).toBe('preserved');
    expect(saved.model).toBe('group/sck-sonnet');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('group/sck-sonnet');
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test('Paseo 兼容入口不强制清单开关，Factory 和 Codex 不生成 Claude 设置',()=>{
  const f = fixture();
  try {
    const env = employeeModelEnv({agentId:'agent',provider:'claude'},f.sidecar,f.root);
    expect(Object.values(pickSwitches(env))).toEqual([undefined,undefined]);
    expect(Object.values(pickSwitches(JSON.parse(readFileSync(env.SCK_CLAUDE_SETTINGS!,'utf8')).env))).toEqual([undefined,undefined]);
    rmSync(join(f.comm,'.claude'),{recursive:true});
    const unused = {sessionOf:()=>{throw Error('其他运行时不应读取 Claude 员工身份');}};
    for (const provider of ['factory-droid','codex']) expect(employeeModelEnv({agentId:'agent',provider,runtime:'native'},unused,f.root)).toEqual({});
    expect(existsSync(join(f.comm,'.claude','settings.local.json'))).toBe(false);
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test('原生 Claude 的 story-author 保留模型路由，只启用清单；未登记员工仍拒绝启动',()=>{
  const f = fixture();
  try {
    rmSync(join(f.root,'private','magpie-remote.key'));
    const sidecar = {sessionOf:()=>({employee:'employee',comm:f.comm,role:'story-author'})};
    const env = employeeModelEnv({agentId:'agent',provider:'claude',runtime:'native'},sidecar,f.root);
    expect(pickSwitches(env)).toEqual(switches);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(JSON.parse(readFileSync(env.SCK_CLAUDE_SETTINGS!,'utf8')).env).toEqual(switches);
    expect(()=>employeeModelEnv({agentId:'agent',provider:'claude',runtime:'native'},{sessionOf:()=>undefined},f.root)).toThrow('拒绝启动');
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test.skipIf(process.platform !== 'darwin')('原生子进程穿过员工沙盒后仍收到开关与覆盖旧值的 --settings',async()=>{
  const f = fixture();
  const events: TurnEnded[] = [];
  let runtime: NativeRuntime | undefined;
  try {
    const sandbox = join(f.root,'sandbox');
    mkdirSync(sandbox);
    for (const file of ['launch.sh','employee.sb']) copyFileSync(join(import.meta.dir,'../scripts/sandbox',file),join(sandbox,file));
    chmodSync(join(sandbox,'launch.sh'),0o755);
    const inspector = join(f.root,'inspect.cjs'), binary = join(f.root,'claude');
    const settings = join(f.comm,'.claude','settings.local.json');
    writeFileSync(settings,JSON.stringify({env:opposite}));
    writeFileSync(inspector,`const fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{
      const argv=process.argv.slice(2),path=argv[argv.lastIndexOf('--settings')+1];
      const settings=JSON.parse(fs.readFileSync(path,'utf8'));
      const keys=['CLAUDE_CODE_ENABLE_TODO_TOOLS','CLAUDE_CODE_ENABLE_TASKS'];
      fs.writeFileSync(process.env.INSPECTION_FILE,JSON.stringify({
        env:Object.fromEntries(keys.map(k=>[k,process.env[k]])),
        settings:Object.fromEntries(keys.map(k=>[k,settings.env[k]])),
        settingsPath:path,model:argv[argv.indexOf('--model')+1],sandbox:process.env.SCK_SANDBOX
      }));
      console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'fixture-session',result:'fixture complete'}));
    });`);
    const quote = (value:string) => `'${value.replaceAll("'",`'\\''`)}'`;
    writeFileSync(binary,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(inspector)} "$@"\n`);
    chmodSync(binary,0o755);
    const inspectionFile = join(f.root,'received.json');
    runtime = new NativeRuntime({root:join(f.root,'runtime'),host:'fixture',
      command:()=>[join(sandbox,'launch.sh'),binary],
      environment:async session=>{
        const channel = {SCK_COMM_DIR:f.comm};
        const inherited = {PATH:'/usr/bin:/bin',HOME:process.env.HOME??'/tmp',...opposite};
        const modelEnv = employeeModelEnv({agentId:session.id,provider:session.provider,env:channel,runtime:'native'},f.sidecar,f.root);
        return {...inherited,...scrubEnv(channel,inherited),...SANDBOX_MARKER,...modelEnv,INSPECTION_FILE:inspectionFile};
      },onEnded:async event=>{events.push(event);},
    });
    const id = await runtime.spawn({provider:'claude',title:'fixture',model:'group/sck-sonnet',cwd:f.root,workspaceTitle:'fixture',labels:{employee_id:'employee'},env:{},prompt:'fixture only'});
    await runtime.activate(id);
    for (let i=0;!events.length && i<300;i++) await Bun.sleep(10);
    expect(events[0]?.outcome.kind).toBe('completed');
    expect(JSON.parse(readFileSync(inspectionFile,'utf8'))).toEqual({env:switches,settings:switches,settingsPath:settings,model:'group/sck-sonnet',sandbox:'employee'});
  } finally { await runtime?.close(); rmSync(f.root,{recursive:true,force:true}); }
});
