import { describe, expect, test } from 'bun:test';
import { outcomeOf, onUnauthorized } from '../src/ui/api.ts';
import {
  draftOf, errorText, isDirty, pageOf, parseJsonObject, splitLines, taskIdOf, validateReassign, validateTaskForm, withDraft, withoutDraft,
  type Drafts,
} from '../src/ui/model.ts';

describe('草稿：按 messageId 保存，刷新后保留', () => {
  test('同一条消息的草稿只保存一份，其它消息互不影响', () => {
    let drafts: Drafts = {};
    drafts = withDraft(drafts, 'm2', '改了一半');
    drafts = withDraft(drafts, 'm3', '另一条');
    drafts = withDraft(drafts, 'm2', '改完了');
    expect(draftOf(drafts, 'm2')).toBe('改完了');
    expect(draftOf(drafts, 'm3')).toBe('另一条');
    expect(Object.keys(drafts).sort()).toEqual(['m2', 'm3']);
  });

  test('刷新前后草稿不变：保存的是草稿副本，不是服务端原文', () => {
    const drafts = withDraft({}, 'm2', '老板正在输入');
    // 模拟刷新：服务端原文变了，草稿仍然是老板的文字
    expect(draftOf(drafts, 'm2')).toBe('老板正在输入');
    expect(isDirty(drafts, 'm2', '服务端新原文')).toBe(true);
  });

  test('草稿与原文相同不算未保存修改；没有草稿也不算', () => {
    const drafts = withDraft({}, 'm2', '原文');
    expect(isDirty(drafts, 'm2', '原文')).toBe(false);
    expect(isDirty({}, 'm2', '原文')).toBe(false);
  });

  test('删除草稿不改动其它草稿，且不修改入参', () => {
    const before: Drafts = { m2: 'a', m3: 'b' };
    const after = withoutDraft(before, 'm2');
    expect(after).toEqual({ m3: 'b' });
    expect(before).toEqual({ m2: 'a', m3: 'b' });
  });

  test('编号形如 __proto__ 的草稿不会串到原型上', () => {
    const drafts = withDraft({}, '__proto__', 'x');
    expect(draftOf(drafts, 'constructor')).toBeUndefined();
    expect(draftOf(drafts, '__proto__')).toBe('x');
  });
});

describe('错误文案', () => {
  test('服务端给了 message 就原样显示', () => {
    expect(errorText({ code: 'invalid', message: 'task not found' })).toBe('task not found');
  });

  test('没有 message 时按错误码给中文说明', () => {
    expect(errorText({ code: 'unauthorized' })).toBe('登录已过期，请重新登录');
    expect(errorText({ code: 'conflict', message: '  ' })).toBe('状态已变化，请刷新后重试');
    expect(errorText({ code: 'upstream_error' })).toBe('上游服务出错，请稍后重试');
    expect(errorText({ code: 'pending' })).toBe('已排队，执行端处理中');
  });

  test('未知错误码带上码本身', () => {
    expect(errorText({ code: 'weird' })).toBe('操作失败（weird）');
    expect(errorText({})).toBe('操作失败');
  });
});

describe('HTTP 响应归类', () => {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  test('200 且 ok:true 为成功，取 result', async () => {
    const out = await outcomeOf<{ n: number }>(json({ ok: true, result: { n: 1 } }, 200));
    expect(out).toEqual({ kind: 'ok', result: { n: 1 } });
  });

  test('202 为排队中，带上 jobId', async () => {
    const out = await outcomeOf(json({ ok: false, error: { code: 'pending', message: '执行端处理中', jobId: 'job:1' } }, 202));
    expect(out).toEqual({ kind: 'pending', jobId: 'job:1', message: '执行端处理中' });
  });

  test('错误响应取服务端 code 与 message；没有 code 时按 HTTP 状态映射', async () => {
    expect(await outcomeOf(json({ ok: false, error: { code: 'forbidden', message: '只有老板能执行' } }, 403)))
      .toEqual({ kind: 'error', status: 403, code: 'forbidden', message: '只有老板能执行', jobId: undefined });
    const bare = await outcomeOf(new Response('upstream down', { status: 503 }));
    expect(bare).toMatchObject({ kind: 'error', status: 503, code: 'unavailable' });
  });

  test('401 通知壳层回到登录页', async () => {
    let called = 0;
    onUnauthorized(() => { called += 1; });
    const out = await outcomeOf(json({ ok: false, error: { code: 'unauthorized', message: '未登录' } }, 401));
    expect(out).toMatchObject({ kind: 'error', code: 'unauthorized' });
    expect(called).toBe(1);
    onUnauthorized(() => undefined);
  });
});

describe('表单解析与校验', () => {
  test('splitLines 去掉空行与重复，保持顺序', () => {
    expect(splitLines('  a \n\nb\r\na\n')).toEqual(['a', 'b']);
    expect(splitLines('   ')).toEqual([]);
  });

  test('parseJsonObject：空串为无值，对象通过，数组与语法错误不通过', () => {
    expect(parseJsonObject('  ')).toEqual({ ok: true, value: undefined });
    expect(parseJsonObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonObject('[1]')).toEqual({ ok: false, error: '参数必须是 JSON 对象' });
    expect(parseJsonObject('{a')).toEqual({ ok: false, error: '参数不是合法的 JSON' });
  });

  test('taskIdOf 兼容 task:⟨x⟩、task:x 与对象形式', () => {
    expect(taskIdOf({ id: 'task:⟨open1⟩' })).toBe('open1');
    expect(taskIdOf({ id: 'task:plain' })).toBe('plain');
    expect(taskIdOf({ id: { tb: 'task', id: 'obj1' } })).toBe('obj1');
    expect(taskIdOf({})).toBe('');
  });

  test('新建需求必填项', () => {
    expect(validateTaskForm({ title: ' ', requirement: '', acceptanceText: '', executorRole: '', reviewerRole: '', type: '' })).toEqual([
      '标题必填', '需求原文必填', '验收标准必填', '请选择执行岗', '请选择复核岗',
    ]);
    expect(validateTaskForm({ title: 't', requirement: 'r', acceptanceText: 'a', executorRole: 'engineering', reviewerRole: 'owner', type: '' })).toEqual([]);
  });

  test('改派至少改一个岗位并写原因', () => {
    expect(validateReassign({ executorRole: '', reviewerRole: '', note: '' })).toEqual(['改派至少选一个岗位', '请写明改派原因']);
    expect(validateReassign({ executorRole: 'qa', reviewerRole: '', note: '换人' })).toEqual([]);
  });

  test('路由按 hash 取页面，未知值回到首页', () => {
    expect(pageOf('')).toBe('today');
    expect(pageOf('#tasks')).toBe('tasks');
    expect(pageOf('#/ops')).toBe('ops');
    expect(pageOf('#unknown')).toBe('today');
    expect(pageOf('#board')).toBe('board');
  });
});
