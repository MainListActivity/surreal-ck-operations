import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'bun:test';
import {employeeSessionLookup} from '../plugin/server/employee-session.ts';
import {employeeModelEnv} from '../plugin/server/model-env.ts';
import {
  employeeEnv, readMagpieKey, restoreLegacyRoutingSettings, writeEmployeeSettings,
} from '../src/model-routing/employee-env.ts';
import { MAGPIE_BASE, groupModel, isGroupModel, sessionKey } from '../src/model-routing/magpie-contract.ts';
import {managedModel} from '../src/model-routing/policy.ts';

test('registry identity is stable across model names; outages are never a negative', async () => {
  let calls=0, unavailable=false;
  const lookup=employeeSessionLookup(async id=>{calls++;if(unavailable)throw Error('offline');return id==='employee';});
  expect(await lookup('employee')).toBe(true);
  unavailable=true;
  expect(await lookup('employee')).toBe(true);
  await expect(lookup('manual')).rejects.toThrow('offline');
  unavailable=false;
  expect(await lookup('manual')).toBe(false);
  expect(calls).toBe(3);
});

test('employee identity survives plugin restart without trusting a lookalike title or model', async () => {
  const dir=mkdtempSync(join(tmpdir(),'sck-employee-identity-'));
  try {
    const file=join(dir,'registry.json');
    const first=employeeSessionLookup(async()=>false,file);
    first.remember('company-agent');
    const restored=employeeSessionLookup(async()=>{throw Error('database unavailable');},file);
    expect(await restored('company-agent')).toBe(true);
    await expect(restored('manual-agent')).rejects.toThrow('unavailable');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('each tier maps to its magpie group; owner-only fable clamps to the role tier', () => {
  expect(groupModel('opus', 'owner')).toBe('group/sck-opus');
  expect(groupModel('sonnet', 'product')).toBe('group/sck-sonnet');
  expect(groupModel('haiku', 'qa')).toBe('group/sck-haiku');
  expect(groupModel('fable', 'owner')).toBe('group/sck-opus');
  expect(groupModel('fable', 'qa')).toBe('group/sck-haiku');
  expect(isGroupModel('group/sck-sonnet')).toBe(true);
  expect(isGroupModel('claude-haiku-5-5')).toBe(false);
});

test('native Claude employees stay managed; Factory and story-author remain exceptions', () => {
  for (const role of ['owner', 'product', 'qa', 'engineering']) {
    expect(managedModel({provider:'claude',role,model:'claude-haiku-5-5'})).toBe(true);
  }
  expect(managedModel({provider:'claude',role:'story-author',model:'claude-haiku-5-5'})).toBe(false);
  expect(managedModel({provider:'factory-droid',role:'engineering',model:'native'})).toBe(false);
});

test('the employee environment sends every model call to the VPS magpie with the employee key and session header', () => {
  expect(MAGPIE_BASE).toBe('https://data.maplayer.top/ofm');
  expect(employeeEnv({key:'employee-key', session:'sck-0123456789abcdef'})).toEqual({
    ANTHROPIC_BASE_URL: 'https://data.maplayer.top/ofm',
    ANTHROPIC_AUTH_TOKEN: 'employee-key',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_CUSTOM_HEADERS: 'x-magpie-session: sck-0123456789abcdef',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1048576',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'group/sck-haiku',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'group/sck-sonnet',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'group/sck-opus',
  });
});

test('the employee key is read from the service home; a missing or empty file refuses the launch', () => {
  const home=mkdtempSync(join(tmpdir(),'sck-magpie-key-'));
  const file=join(home,'private','magpie-remote.key');
  try {
    expect(() => readMagpieKey(home)).toThrow('拒绝启动员工会话');
    mkdirSync(join(home,'private'),{recursive:true});
    writeFileSync(file,' \n');
    expect(() => readMagpieKey(home)).toThrow('拒绝启动员工会话');
    writeFileSync(file,'employee-key\n');
    expect(readMagpieKey(home)).toBe('employee-key');
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('the employee settings file carries the same environment, keeps the user settings and is private', () => {
  const comm=mkdtempSync(join(tmpdir(),'sck-employee-settings-'));
  try {
    mkdirSync(join(comm,'.claude'),{recursive:true});
    writeFileSync(join(comm,'.claude','settings.local.json'),JSON.stringify({model:'opus',env:{KEEP:'1'}}));
    const env=employeeEnv({key:'employee-key', session:'sck-1'});
    const file=writeEmployeeSettings(comm,env);
    const saved=JSON.parse(readFileSync(file,'utf8'));
    expect(saved.model).toBe('opus');
    expect(saved.env).toEqual({KEEP:'1',...env});
    expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {rmSync(comm,{recursive:true,force:true});}
});

test('a comm dir the retired local gateway wrote is restored to what it displaced, and its markers are removed', () => {
  const comm=mkdtempSync(join(tmpdir(),'sck-legacy-settings-'));
  try {
    mkdirSync(join(comm,'.claude'),{recursive:true});
    const file=join(comm,'.claude','settings.local.json');
    writeFileSync(file,JSON.stringify({model:'opus',env:{
      ANTHROPIC_BASE_URL:'http://127.0.0.1:18779/a/employee%3Aqa',ANTHROPIC_AUTH_TOKEN:'local',CLAUDE_CODE_MAX_CONTEXT_TOKENS:'1048576',
    }}));
    writeFileSync(`${file}.sck-before`,JSON.stringify({existed:true,env:{ANTHROPIC_BASE_URL:'https://user.example'}}));
    writeFileSync(join(comm,'.sck-model-router'),'');
    expect(restoreLegacyRoutingSettings(comm)).toBe(true);
    expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({model:'opus',env:{ANTHROPIC_BASE_URL:'https://user.example'}});
    expect(existsSync(`${file}.sck-before`)).toBe(false);
    expect(existsSync(join(comm,'.sck-model-router'))).toBe(false);
    expect(restoreLegacyRoutingSettings(comm)).toBe(false);
  } finally {rmSync(comm,{recursive:true,force:true});}
});

test('a registered employee session gets its magpie environment, settings file and task session key', () => {
  const comm=mkdtempSync(join(tmpdir(),'sck-model-env-comm-'));
  const home=mkdtempSync(join(tmpdir(),'sck-model-env-home-'));
  try {
    mkdirSync(join(home,'private'),{recursive:true});
    writeFileSync(join(home,'private','magpie-remote.key'),'employee-key\n');
    const seen:string[]=[];
    const sidecar={sessionOf:(ref:string)=>{seen.push(ref);return ref==='employee:qa-1'?{employee:'qa-1',comm,role:'qa',task:'task-7'}:undefined;}};
    const env=employeeModelEnv({agentId:'agent-1',provider:'claude',env:{SCK_COMM_DIR:'/runs/comm/qa-1'}},sidecar,home);
    expect(seen).toEqual(['employee:qa-1']);
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL:'https://data.maplayer.top/ofm',
      ANTHROPIC_AUTH_TOKEN:'employee-key',
      ANTHROPIC_CUSTOM_HEADERS:`x-magpie-session: ${sessionKey('task-7','qa-1')}`,
      ANTHROPIC_DEFAULT_HAIKU_MODEL:'group/sck-haiku',
    });
    // The launcher loads this file with --settings, so the same values win over a user's global settings.env.
    expect(env.SCK_CLAUDE_SETTINGS).toBe(join(comm,'.claude','settings.local.json'));
    expect(JSON.parse(readFileSync(env.SCK_CLAUDE_SETTINGS!,'utf8')).env).toMatchObject({ANTHROPIC_AUTH_TOKEN:'employee-key'});
  } finally {rmSync(comm,{recursive:true,force:true});rmSync(home,{recursive:true,force:true});}
});

test('a session without a registered task keys on the empty task, so it matches no task usage', () => {
  const comm=mkdtempSync(join(tmpdir(),'sck-model-env-notask-'));
  const home=mkdtempSync(join(tmpdir(),'sck-model-env-home-'));
  try {
    mkdirSync(join(home,'private'),{recursive:true});
    writeFileSync(join(home,'private','magpie-remote.key'),'employee-key');
    const env=employeeModelEnv({agentId:'agent-2',provider:'claude'},{sessionOf:()=>({employee:'qa-2',comm})},home);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(`x-magpie-session: ${sessionKey('','qa-2')}`);
  } finally {rmSync(comm,{recursive:true,force:true});rmSync(home,{recursive:true,force:true});}
});

test('story-author keeps its configured model and its legacy routing values are cleaned; no employee settings are written', () => {
  const comm=mkdtempSync(join(tmpdir(),'sck-model-env-author-'));
  const home=mkdtempSync(join(tmpdir(),'sck-model-env-author-home-'));
  try {
    mkdirSync(join(comm,'.claude'),{recursive:true});
    const file=join(comm,'.claude','settings.local.json');
    writeFileSync(file,JSON.stringify({env:{ANTHROPIC_BASE_URL:'http://127.0.0.1:18779/a/employee%3Aauthor'}}));
    const env=employeeModelEnv({agentId:'agent-3',provider:'claude',env:{SCK_COMM_DIR:'/runs/comm/author'}},
      {sessionOf:()=>({employee:'author',comm,role:'story-author',task:'task-8'})},home);
    expect(env).toEqual({});
    expect(existsSync(file)).toBe(false);
  } finally {rmSync(comm,{recursive:true,force:true});rmSync(home,{recursive:true,force:true});}
});

test('a session the plugin never registered is refused; other providers are left alone', () => {
  const home=mkdtempSync(join(tmpdir(),'sck-model-env-unknown-'));
  try {
    const none={sessionOf:()=>undefined};
    expect(() => employeeModelEnv({agentId:'agent-4',provider:'claude',env:{SCK_COMM_DIR:'/runs/comm/ghost'}},none,home)).toThrow('拒绝启动');
    expect(employeeModelEnv({agentId:'agent-5',provider:'codex'},none,home)).toEqual({});
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('a missing employee key refuses the launch and writes no settings file', () => {
  const comm=mkdtempSync(join(tmpdir(),'sck-model-env-nokey-comm-'));
  const home=mkdtempSync(join(tmpdir(),'sck-model-env-nokey-home-'));
  try {
    expect(() => employeeModelEnv({agentId:'agent-6',provider:'claude'},
      {sessionOf:()=>({employee:'qa-6',comm,role:'qa',task:'task-9'})},home)).toThrow('拒绝启动员工会话');
    expect(existsSync(join(comm,'.claude','settings.local.json'))).toBe(false);
  } finally {rmSync(comm,{recursive:true,force:true});rmSync(home,{recursive:true,force:true});}
});
