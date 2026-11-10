import { expect, test } from 'bun:test';
import { ActivityCollector, activityText } from '../src/agent-activity.ts';
import { parseNativeResult } from '../src/runner/native.ts';

test('只采集公开文本与工具状态，不保存思考、用户资料、参数或工具结果', () => {
  const c = new ActivityCollector('a', 't', 1);
  c.ingest('claude', {type: 'assistant', message: {content: [
    {type: 'thinking', thinking: 'PRIVATE_THOUGHT'}, {type: 'text', text: '检查接口'},
    {type: 'tool_use', id: 'u', name: 'Read', input: {path: 'PRIVATE_ARG'}},
  ]}}, 2);
  expect(c.snapshot(2)).toMatchObject({tool: 'Read', toolsCompleted: 0});
  c.ingest('claude', {type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'u', content: 'PRIVATE_RESULT'}]}}, 3);
  c.ingest('factory-droid', {type: 'message', role: 'user', text: 'PRIVATE_USER'}, 4);
  expect(c.snapshot(4).toolsCompleted).toBe(1);
  expect(JSON.stringify(c.snapshot(4))).not.toContain('PRIVATE_');
  expect(c.snapshot(4).tool).toBeUndefined();
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
