import { expect, test } from 'bun:test';
import { ActivityCollector, activityText } from '../src/agent-activity.ts';
import { parseNativeResult } from '../src/runner/native.ts';

test('只采集公开文本、工具状态和每个动作的一行摘要；不保存思考、用户资料、文件内容或工具结果', () => {
  const c = new ActivityCollector('a', 't', 1);
  c.ingest('claude', {type: 'assistant', message: {content: [
    {type: 'thinking', thinking: 'PRIVATE_THOUGHT'}, {type: 'text', text: '检查接口'},
    {type: 'tool_use', id: 'u', name: 'Read', input: {path: 'src/app.ts', content: 'PRIVATE_CONTENT', old_string: 'PRIVATE_OLD'}},
  ]}}, 2);
  expect(c.snapshot(2)).toMatchObject({tool: 'Read', toolsCompleted: 0});
  c.ingest('claude', {type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'u', content: 'PRIVATE_RESULT'}]}}, 3);
  c.ingest('factory-droid', {type: 'message', role: 'user', text: 'PRIVATE_USER'}, 4);
  expect(c.snapshot(4).toolsCompleted).toBe(1);
  expect(JSON.stringify(c.snapshot(4))).not.toContain('PRIVATE_');
  expect(c.snapshot(4).tool).toBeUndefined();
  expect(c.snapshot(4).actions).toEqual([{ at: 2, tool: 'Read', text: '读文件：src/app.ts', state: 'ok', endedAt: 3 }]);
});

test('动作摘要：命令、读写改文件、搜索、网址、子任务各一行；凭证脱敏；认不出的只留工具名', async () => {
  const { actionSummary, paseoActionSummary, ACTION_LIMIT } = await import('../src/agent-activity.ts');
  expect(actionSummary('Bash', { command: 'git status\n  && bun test' })).toBe('执行命令：git status && bun test');
  expect(actionSummary('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnop123456" https://x.test/a?token=zzz' })).not.toContain('abcdefghijklmnop');
  expect(actionSummary('Edit', { file_path: '/repo/src/a.ts', old_string: 'SECRET_OLD', new_string: 'SECRET_NEW' })).toBe('改文件：/repo/src/a.ts');
  expect(actionSummary('Write', { file_path: '/repo/b.md', content: 'SECRET' })).toBe('写文件：/repo/b.md');
  expect(actionSummary('Grep', { pattern: 'TODO' })).toBe('搜索：TODO');
  expect(actionSummary('Grep', { pattern: 'TODO', path: 'src' })).toBe('搜索：TODO');
  expect(actionSummary('Bash', { command: 'mysql --password hunter2 -u root' })).toBe('执行命令：mysql --password [已隐藏] -u root');
  expect(actionSummary('Bash', { command: 'tool --token=abc123 --api-key "k v" run' })).toBe('执行命令：tool --token=[已隐藏] --api-key [已隐藏] run');
  expect(actionSummary('Bash', { command: 'curl -u admin:s3cret https://x.test' })).toBe('执行命令：curl -u [已隐藏] https://x.test');
  expect(actionSummary('WebFetch', { url: 'https://docs.test/page?key=abc' })).toBe('打开网址：https://docs.test/page?[参数已隐藏]');
  expect(actionSummary('Task', { description: '查三处引用', prompt: 'SECRET_PROMPT' })).toBe('派子任务：查三处引用');
  expect(actionSummary('mcp__x__do', { payload: { a: 1 } })).toBe('调用 mcp__x__do');
  expect(actionSummary('Bash', { command: 'x'.repeat(500) }).length).toBeLessThanOrEqual(166);
  expect(paseoActionSummary('shell', { type: 'shell', command: 'ls -la', output: 'SECRET_OUT' })).toBe('执行命令：ls -la');
  expect(paseoActionSummary('edit', { type: 'edit', filePath: 'a.ts', unifiedDiff: 'SECRET' })).toBe('改文件：a.ts');
  // 各家事件都进同一条动作流：codex 的命令、通道的进展；一轮超过上限丢最早的并计数。
  const c = new ActivityCollector('a', 't', 1);
  c.ingest('codex', { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test' } }, 2);
  c.ingest('codex', { type: 'item.completed', item: { id: 'c1', type: 'command_execution', exit_code: 1 } }, 3);
  c.ingest('muse-web', { type: 'lane_status', status: '已发给 Muse（abc）' }, 4);
  expect(c.snapshot(5).actions).toEqual([
    { at: 2, tool: '命令执行', text: '执行命令：npm test', state: 'failed', endedAt: 3 }, { at: 4, tool: '通道', text: '已发给 Muse（abc）', state: 'ok' }]);
  for (let i = 0; i < ACTION_LIMIT + 5; i++) c.ingest('warp', { type: 'lane_status', status: `步骤 ${i}` }, 10 + i);
  expect(c.snapshot(999).actions).toHaveLength(ACTION_LIMIT);
  expect(c.snapshot(999).actionsDropped).toBe(7);
  // 待办清单的内容不存。
  const t = new ActivityCollector('a', 't2', 1);
  t.ingest('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w', name: 'TodoWrite', input: { todos: [{ status: 'pending', content: 'SECRET_TODO' }] } }] } }, 2);
  expect(JSON.stringify(t.snapshot(3))).not.toContain('SECRET_TODO');
  expect(t.snapshot(3).actions![0]!.text).toBe('更新待办清单');
});

test('Paseo 时间线投影成同一形状的动作流：同一工具调用的 running 与 completed 合并，推理和工具输出不取', async () => {
  const { activityFromTimeline } = await import('../src/runner/paseo-activity.ts');
  const e = (seqEnd: number, item: Record<string, unknown>) => ({ seqEnd, turnId: 't', timestamp: new Date(1000 * seqEnd).toISOString(), item: item as never });
  const entries = [
    e(1, { type: 'reasoning', text: 'PRIVATE_THOUGHT' }),
    e(2, { type: 'tool_call', callId: 'k1', name: 'shell', status: 'running', detail: { type: 'shell', command: 'bun test' } }),
    e(3, { type: 'tool_call', callId: 'k1', name: 'shell', status: 'completed', detail: { type: 'shell', command: 'bun test', output: 'PRIVATE_OUT' } }),
    e(4, { type: 'tool_call', callId: 'k2', name: 'edit', status: 'failed', detail: { type: 'edit', filePath: 'src/a.ts', newString: 'PRIVATE_NEW' } }),
    e(5, { type: 'tool_call', callId: 'k3', name: 'read', status: 'running', detail: { type: 'read', filePath: 'src/b.ts' } }),
    e(6, { type: 'assistant_message', text: '测试通过，正在改 b.ts' }),
  ];
  const running = activityFromTimeline('agent-1', 't', entries, true, 9000)!;
  expect(running).toMatchObject({ agent: 'agent-1', turn: 't', runtime: 'paseo', state: 'running', tool: 'read', toolsCompleted: 2, startedAt: 1000 });
  expect(running.actions).toEqual([
    { at: 2000, tool: 'shell', text: '执行命令：bun test', state: 'ok', endedAt: 3000 },
    { at: 4000, tool: 'edit', text: '改文件：src/a.ts', state: 'failed', endedAt: 4000 },
    { at: 5000, tool: 'read', text: '读文件：src/b.ts', state: 'running' }]);
  expect(running.events.map(x => x.kind)).toEqual(['tool_start', 'tool_start', 'tool_start', 'output']);
  expect(JSON.stringify(running)).not.toContain('PRIVATE_');
  const ended = activityFromTimeline('agent-1', 't', entries, false, 9000)!;
  expect(ended.state).toBe('completed');
  expect(ended.actions!.at(-1)).toMatchObject({ state: 'failed', endedAt: 6000 });
  expect(activityFromTimeline('agent-1', 't', [], true, 1)).toBeUndefined();
});

test('已恢复的工具错误不作为回合失败；正式失败事件不能被 completion 覆盖', () => {
  const stream = (events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n');
  const end = {type: 'completion', session_id: 's', finalText: '完成'};
  expect(parseNativeResult('factory-droid', stream([{type: 'tool_result', isError: true}, end])).completed).toBe(true);
  expect(parseNativeResult('factory-droid', stream([{type: 'error', message: 'provider failed'}, end])).completed).toBe(false);
  expect(parseNativeResult('factory-droid', stream([end, {type: 'message', role: 'assistant', text: 'extra'}])).completed).toBe(false);
  expect(parseNativeResult('factory-droid', stream([{type: 'message', role: 'assistant', text: 'done'}])).completed).toBe(false);
});

test('限制事件数量、文本长度和存储时间；常见凭证脱敏', () => {
  const c = new ActivityCollector('a', 't', 0);
  for (let i = 1; i <= 50; i++) c.ingest('factory-droid', {type: 'message', role: 'assistant', text: 'x'.repeat(2000)}, i);
  expect(c.snapshot(50).events).toHaveLength(40);
  expect(c.snapshot(50).events[0]!.text).toHaveLength(1200);
  expect(c.snapshot(86_400_051).events).toHaveLength(0);
  const safe = activityText('Bearer abcdefghijklmnop api_key=privatevalue https://host/a?secret=xyz sk-abcdefghijklmnop');
  for (const secret of ['abcdefghijklmnop', 'privatevalue', 'xyz']) expect(safe).not.toContain(secret);
});

test('Factory stream-json 以 toolId 配对，工具结果正文不进入进度', () => {
  const c = new ActivityCollector('a','t',1);
  c.ingest('factory-droid',{type:'tool_call',id:'event1',toolId:'tool-1',toolName:'Read',parameters:{file:'SECRET'}},2);
  c.ingest('factory-droid',{type:'tool_result',id:'event2',toolId:'tool-1',isError:false,value:'SECRET'},3);
  expect(c.snapshot(3).toolsCompleted).toBe(1); expect(c.snapshot(3).tool).toBeUndefined();
  expect(JSON.stringify(c.snapshot(3))).not.toContain('SECRET');
});

test('JSON/env 形式的凭证与 URL 用户密码也脱敏',()=>{
  expect(activityText('{"API_KEY":"private-a", "token": "private-b"} SECRET=private-c https://user:private-d@host/path')).not.toMatch(/private-[abcd]/);
});

test('工作清单只接受成功更新，保存计数而不保存清单正文', () => {
  const c=new ActivityCollector('a','t',1);
  const start=(id:string,statuses:string[],at:number)=>c.ingest('claude',{type:'assistant',message:{content:[{type:'tool_use',id,name:'TodoWrite',input:{todos:statuses.map(status=>({status,content:'PRIVATE_TASK'}))}}]}},at);
  const end=(id:string,at:number,is_error=false)=>c.ingest('claude',{type:'user',message:{content:[{type:'tool_result',tool_use_id:id,is_error}]}},at);
  start('first',['completed','pending'],2);
  expect(c.snapshot(2).checklist).toBeUndefined();
  end('first',3);
  expect(c.snapshot(3).checklist).toEqual({done:1,total:2,at:2});
  start('failed',['completed','completed'],4);end('failed',5,true);
  expect(c.snapshot(5).checklist?.done).toBe(1);
  expect(JSON.stringify(c.snapshot(5))).not.toContain('PRIVATE_TASK');
  c.finish('completed','完成本轮',6);
  expect(c.snapshot(6).checklist?.done).toBe(1); // provider 结束不等于清单、任务全部验收
});

test('晚返回的旧 TodoWrite 不覆盖更新的清单，开始时间相同也按事件顺序处理', () => {
  const c=new ActivityCollector('a','t',1);
  const start=(id:string,status:string)=>c.ingest('factory-droid',{type:'tool_call',toolId:id,toolName:'TodoWrite',parameters:{todos:[{status,content:'SECRET'}]}},2);
  const end=(id:string)=>c.ingest('factory-droid',{type:'tool_result',toolId:id,isError:false},3);
  start('old','pending');start('new','completed');end('new');end('old');
  expect(c.snapshot(3).checklist).toEqual({done:1,total:1,at:2});
  expect(JSON.stringify(c.snapshot(3))).not.toContain('SECRET');
});

test('未知清单格式不生成百分比，普通工具参数不能伪装清单', () => {
  const c=new ActivityCollector('a','t',1);
  for(const [i,name,todos] of [[1,'Read',[{status:'completed'}]],[2,'TodoWrite','- [x] one'],[3,'TodoWrite',[{status:'unknown'}]],[4,'TodoWrite',[]]] as const){
    c.ingest('factory-droid',{type:'tool_call',id:String(i),toolName:name,parameters:{todos}},2);
    c.ingest('factory-droid',{type:'tool_result',id:String(i),isError:false},3);
  }
  expect(c.snapshot(3).checklist).toBeUndefined();
});

test('Factory 原生带状态的文本清单可量化，混入未知格式时整份不估算', () => {
  const c=new ActivityCollector('a','t',1);
  const update=(id:string,todos:string)=>{
    c.ingest('factory-droid',{type:'tool_call',id,toolName:'TodoWrite',parameters:{todos}},2);
    c.ingest('factory-droid',{type:'tool_result',id,isError:false},3);
  };
  update('one','1. [completed] PRIVATE_A\n2. [in_progress] PRIVATE_B\n3. [pending] PRIVATE_C');
  expect(c.snapshot(3).checklist).toEqual({done:1,total:3,at:2});
  expect(JSON.stringify(c.snapshot(3))).not.toContain('PRIVATE_');
  update('two','1. [completed] PRIVATE_A\n2. unknown');
  expect(c.snapshot(3).checklist).toBeUndefined();
});

test('云端通道动作：尝试提交记运行中，只有取得受理证据才记完成；未受理或没有结论的尝试记失败', () => {
  const c = new ActivityCollector('a', 't', 1);
  const lane = (status: string, phase: 'attempt' | 'accepted' | 'failed', at: number) => c.ingest('devin-cloud', { type: 'lane_status', status, phase }, at);
  lane('尝试提交 Devin Cloud 会话（同步等待）', 'attempt', 2);
  expect(c.snapshot(2).actions).toEqual([{ at: 2, tool: '通道', text: '尝试提交 Devin Cloud 会话（同步等待）', state: 'running' }]);
  // 退出码非零：没有受理证据，不能记成提交成功。
  lane('Devin Cloud 会话未取得受理证据（退出码 1）', 'failed', 3);
  expect(c.snapshot(3).actions).toEqual([{ at: 2, tool: '通道', text: 'Devin Cloud 会话未取得受理证据（退出码 1）', state: 'failed', endedAt: 3 }]);
  lane('尝试提交 Devin Cloud 会话（同步等待）', 'attempt', 4);
  lane('Devin Cloud 已受理并返回答复', 'accepted', 5);
  expect(c.snapshot(5).actions!.at(-1)).toEqual({ at: 4, tool: '通道', text: 'Devin Cloud 已受理并返回答复', state: 'ok', endedAt: 5 });
  // 尝试之后一直没有结论（进程中断）：一轮结束时按未受理记。
  lane('尝试提交 Devin Cloud 会话（同步等待）', 'attempt', 6);
  c.finish('failed', '', 7);
  expect(c.snapshot(7).actions!.at(-1)).toMatchObject({ state: 'failed', endedAt: 7 });
  // 没有阶段的进展（其它通道）照旧按已完成记。
  c.ingest('muse-web', { type: 'lane_status', status: '已发给 Muse（abc）' }, 8);
  expect(c.snapshot(8).actions!.at(-1)).toEqual({ at: 8, tool: '通道', text: '已发给 Muse（abc）', state: 'ok' });
});
