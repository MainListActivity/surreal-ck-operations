import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HARD_OWNER_ONLY, OWNER_API_COMMANDS, canonicalJson, digestOf, judge, matchesCommand,
  type ActorKind, type GuardFacts, type GuardRequest,
} from '../src/command-guard.ts';

const NOW = 1_800_000_000;
const request = (actorKind: ActorKind, command: string, over: Partial<GuardRequest> = {}): GuardRequest =>
  ({ actorKind, actor: actorKind === 'agent' ? 'emp-a' : `${actorKind}-1`, task: 'task-1', command, now: NOW, ...over });
const leased: GuardFacts = { lease: { holder: 'emp-a', expiresAt: NOW + 600 } };
const agent = (command: string, facts: GuardFacts = leased, over: Partial<GuardRequest> = {}) =>
  judge(request('agent', command, over), facts);

describe('命令守卫：老板', () => {
  test('老板全放行：专属命令、保护命令、停用与拒绝清单都不限制老板', () => {
    const facts: GuardFacts = { protectedOwnerOnly: true, policy: { disabled: true, deny: ['task.void'] } };
    for (const command of ['guard.protect', 'agent.policy.set', 'def.ensure', 'task.void', 'submit']) {
      expect(judge(request('owner', command, { actor: 'owner:web', task: undefined }), facts).allow).toBe(true);
    }
  });
});

describe('命令守卫：员工租约', () => {
  test('持有该任务的有效租约放行', () => {
    expect(agent('submit').allow).toBe(true);
  });

  test('没有带任务、没有租约、租约属于别人，都拒绝', () => {
    expect(agent('submit', leased, { task: undefined }).allow).toBe(false);
    expect(agent('submit', {}).allow).toBe(false);
    expect(agent('submit', { lease: { holder: null, expiresAt: NOW + 600 } }).allow).toBe(false);
    expect(agent('submit', { lease: { holder: 'emp-b', expiresAt: NOW + 600 } }).allow).toBe(false);
  });

  test('租约过期即拒：到期时刻也算过期，到期前一秒仍放行', () => {
    expect(agent('submit', { lease: { holder: 'emp-a', expiresAt: NOW } }).allow).toBe(false);
    expect(agent('submit', { lease: { holder: 'emp-a', expiresAt: NOW - 5 } }).allow).toBe(false);
    expect(agent('submit', { lease: { holder: 'emp-a', expiresAt: NOW + 1 } }).allow).toBe(true);
  });

  test('员工停用即拒，即使持有有效租约', () => {
    const result = agent('submit', { ...leased, policy: { disabled: true } });
    expect(result).toEqual({ allow: false, reason: '该员工已停用' });
  });
});

describe('命令守卫：硬性老板命令与保护清单', () => {
  test('HARD_OWNER_ONLY 命中即拒，对员工、运行器与自动化一视同仁', () => {
    for (const command of ['guard.protect', 'guard.unprotect', 'agent.policy.set', 'agent.policy.disable', 'owner.login.rotate', 'def.ensure']) {
      expect(agent(command).allow).toBe(false);
      expect(judge(request('runner', command), {}).allow).toBe(false);
      expect(judge(request('automation', command), {}).allow).toBe(false);
    }
  });

  test('保护清单 owner_only=true 的命令，员工与运行器都拒绝；owner_only=false 不拒', () => {
    expect(agent('submit', { ...leased, protectedOwnerOnly: true }).allow).toBe(false);
    expect(judge(request('runner', 'submit'), { protectedOwnerOnly: true }).allow).toBe(false);
    expect(agent('submit', { ...leased, protectedOwnerOnly: false }).allow).toBe(true);
  });
});

describe('命令守卫：员工策略的允许与拒绝清单', () => {
  test('有允许清单时只放行清单内的命令；空清单全部拒绝', () => {
    expect(agent('submit', { ...leased, policy: { allow: ['submit', 'checkpoint'] } }).allow).toBe(true);
    expect(agent('block', { ...leased, policy: { allow: ['submit', 'checkpoint'] } })).toEqual({ allow: false, reason: '命令不在该员工的允许清单内' });
    expect(agent('submit', { ...leased, policy: { allow: [] } }).allow).toBe(false);
  });

  test('允许清单与拒绝清单都支持命名空间前缀', () => {
    expect(agent('task.cost', { ...leased, policy: { allow: ['task.*'] } }).allow).toBe(true);
    expect(agent('note.add', { ...leased, policy: { allow: ['task.*'] } }).allow).toBe(false);
    expect(agent('submit', { ...leased, policy: { deny: ['task.*'] } }).allow).toBe(true);
    expect(agent('task.void', { ...leased, policy: { deny: ['task.*'] } }).allow).toBe(false);
    expect(agent('checkpoint', { ...leased, policy: { deny: ['checkpoint'] } })).toEqual({ allow: false, reason: '该员工不能调用此命令' });
  });

  test('同时在允许与拒绝清单里的命令，拒绝优先', () => {
    expect(agent('submit', { ...leased, policy: { allow: ['submit'], deny: ['submit'] } }).allow).toBe(false);
  });
});

describe('命令守卫：运行器与自动化', () => {
  test('不能直接调用老板接口的命令', () => {
    expect(judge(request('runner', 'task.void'), {}).allow).toBe(false);
    expect(judge(request('automation', 'message.send'), {}).allow).toBe(false);
    expect(judge(request('runner', 'task.void'), {}).reason).toBe('运行器与自动化不能直接调用老板命令');
  });

  test('非老板命令放行，且不看员工策略与租约', () => {
    expect(judge(request('runner', 'submit'), { policy: { disabled: true } }).allow).toBe(true);
    expect(judge(request('automation', 'checkpoint'), {}).allow).toBe(true);
  });
});

describe('命令守卫：模式与清单', () => {
  test('完整名精确匹配，前缀只在 .* 结尾时生效', () => {
    expect(matchesCommand('task.void', 'task.void')).toBe(true);
    expect(matchesCommand('task.void', 'task.voidx')).toBe(false);
    expect(matchesCommand('task.*', 'task.void')).toBe(true);
    expect(matchesCommand('task.*', 'tasks.void')).toBe(false);
    expect(matchesCommand('task.*', 'task')).toBe(false);
  });

  test('HARD_OWNER_ONLY 含规格列出的写命令前缀', () => {
    expect(HARD_OWNER_ONLY).toEqual(expect.arrayContaining(['guard.*', 'agent.policy.*', 'owner.login.*']));
  });

  test('OWNER_API_COMMANDS 与 owner-api.ts 的命令分支一致：新增老板命令必须同时归类', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'owner-api.ts'), 'utf8');
    const cases = [...new Set([...source.matchAll(/case '([^']+)'/g)].map((match) => match[1]))].sort();
    expect([...OWNER_API_COMMANDS].sort()).toEqual(cases);
  });
});

describe('命令守卫：摘要', () => {
  test('键排序的 JSON：同一内容不论键的书写顺序，结果相同', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [{ y: 2, x: 1 }] } })).toBe('{"a":{"c":[{"x":1,"y":2}],"d":1},"b":1}');
    expect(canonicalJson(undefined)).toBe('null');
  });

  test('digestOf 形如 sha256:<64 位十六进制>，同内容同摘要，不同内容不同摘要', async () => {
    const first = await digestOf({ text: '正文', idempotencyKey: 'k-1' });
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await digestOf({ idempotencyKey: 'k-1', text: '正文' })).toBe(first);
    expect(await digestOf({ text: '另一段', idempotencyKey: 'k-1' })).not.toBe(first);
  });
});

describe('命令守卫：源码边界', () => {
  test('命令守卫源码不引入 node: 内置模块（字符串或导入形式都不出现）', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'command-guard.ts'), 'utf8');
    expect(source).not.toMatch(/['"`]node:/);
  });
});
