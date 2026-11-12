import { ITERATION_COMMANDS } from '../src/iteration-commands.ts';
import { describe, expect, test } from 'bun:test';

import { commandCatalogOf, type CatalogEntry } from '../src/catalog.ts';
import { COMMAND_CATALOG } from '../src/command-catalog.ts';
import { isRunnerCommand } from '../src/commands.ts';
import { IDENTITY_COMMANDS } from '../src/idp-commands.ts';
import { TRANSLATE_COMMANDS } from '../src/messages.ts';
import { POLICY_COMMANDS } from '../src/policy-commands.ts';
import { OWNER_ONLY_FOR_AGENTS, TARGET_LOCKS } from '../src/owner-locks.ts';
import { HARD_OWNER_ONLY, OWNER_API_COMMANDS, matchesCommand, type PolicyRow, type ProtectedRow } from '../../src/command-guard.ts';
import { RUNNER_ONLY_COMMANDS } from '../../src/owner-api.ts';
import { fakeDb } from './_support.ts';

const namesOf = (entries: ReadonlyArray<{ command: string }>): string[] => entries.map((entry) => entry.command);
const specOf = (command: string) => COMMAND_CATALOG.find((spec) => spec.command === command);

/** 员工视角的目录：与 cmd.catalog 走同一条取数路径（策略行与保护清单）。 */
async function agentView(options: { policy?: PolicyRow; protectedRows?: ProtectedRow[] } = {}): Promise<CatalogEntry[]> {
  const { db } = fakeDb((sql) => {
    if (sql.includes('FROM agent_policy')) return options.policy ? [options.policy] : [];
    if (sql.includes('FROM protected_command')) return options.protectedRows ?? [];
    return [];
  });
  return (await commandCatalogOf(db, { owner: false, employee: 'alice' })).commands;
}

describe('命令目录的内容', () => {
  test('每条命令名唯一，且有标题与参数说明', () => {
    const names = namesOf(COMMAND_CATALOG);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of COMMAND_CATALOG) {
      expect(spec.title.trim()).not.toBe('');
      expect(spec.params.trim()).not.toBe('');
    }
  });

  test('覆盖网关全部老板命令，且没有网关不认识的命令', () => {
    // 网关在 commands.ts 的 dispatch 中直接分派的命令（不经老板接口、身份、策略与译文模块）。
    const local = [
      'db.read', 'db.write', 'cf.api', 'ops.job.list', 'ops.job.get', 'audit.list', 'cmd.catalog', 'owner.settings.get', 'owner.settings.set',
      'message.edit', 'message.edit_rendered', 'message.release', 'message.send', 'host.exec',
    ];
    const known = new Set([
      ...ITERATION_COMMANDS, ...OWNER_API_COMMANDS, ...RUNNER_ONLY_COMMANDS, ...IDENTITY_COMMANDS, ...POLICY_COMMANDS, ...TRANSLATE_COMMANDS, ...local,
    ]);
    const listed = new Set(namesOf(COMMAND_CATALOG));
    expect([...known].filter((command) => !listed.has(command))).toEqual([]);
    expect([...listed].filter((command) => !known.has(command))).toEqual([]);
  });

  test('执行端标记与网关的排队规则一致（isRunnerCommand），RUNNER_ONLY_COMMANDS 与 host.exec 都有标记', () => {
    for (const spec of COMMAND_CATALOG) {
      expect(spec.runner === true).toBe(isRunnerCommand(spec.command));
    }
    for (const command of [...RUNNER_ONLY_COMMANDS, 'host.exec']) {
      expect(specOf(command)?.runner).toBe(true);
    }
  });

  test('高危命令标为 high：会改变主机、生产或外部状态，或替老板作决定', () => {
    const risky = ['host.exec', 'cf.api', 'idp.request', 'db.write', 'decide', 'approve', 'message.send', 'instruct', 'direction.add'];
    for (const command of risky) {
      expect(specOf(command)?.risk).toBe('high');
    }
  });
});

describe('命令目录按身份过滤', () => {
  test('老板看到全部命令，包括员工看不到的；按目标锁的说明老板也能看到', async () => {
    const { db } = fakeDb();
    const result = await commandCatalogOf(db, { owner: true });
    expect(result.scope).toBe('owner');
    expect(result.commands).toHaveLength(COMMAND_CATALOG.length);
    expect(namesOf(result.commands)).toEqual(expect.arrayContaining(['guard.protect', 'db.write', 'agent.policy.set', 'ops.job.list']));
    const lock = TARGET_LOCKS.find((item) => item.command === 'idp.*')!.target;
    expect(result.commands.find((entry) => entry.command === 'idp.client.create')?.lock).toBe(lock);
  });

  test('写死仅老板的命令（agent.*、guard.*、def.*、db.write）员工看不到', async () => {
    const names = namesOf(await agentView());
    const hard = COMMAND_CATALOG.map((spec) => spec.command).filter((command) => HARD_OWNER_ONLY.some((pattern) => matchesCommand(pattern, command)));
    expect(hard).toEqual(expect.arrayContaining(['guard.list', 'agent.policy.set', 'def.ensure', 'db.write']));
    for (const command of hard) {
      expect(names).not.toContain(command);
    }
  });

  test('老板保护清单里 owner_only 的命令员工看不到（精确匹配与 .* 前缀）；没有 owner_only 的保护条目不影响', async () => {
    const names = namesOf(await agentView({
      protectedRows: [{ command: 'approve', owner_only: true }, { command: 'task.*', owner_only: true }, { command: 'route.save', owner_only: false }],
    }));
    expect(names).not.toContain('approve');
    expect(names.filter((command) => command.startsWith('task.'))).toEqual([]);
    expect(names).toContain('route.save');
    expect(names).toContain('message.list');
  });

  test('员工拒绝清单里的命令看不到；允许清单之外的命令看不到', async () => {
    const denied = namesOf(await agentView({ policy: { deny: ['note.*', 'route.save'] } }));
    expect(denied.filter((command) => command.startsWith('note.'))).toEqual([]);
    expect(denied).not.toContain('route.save');
    expect(denied).toContain('message.list');

    const allowed = namesOf(await agentView({ policy: { allow: ['status', 'message.list'] } }));
    expect(allowed.sort()).toEqual(['message.list', 'status']);
  });

  test('员工停用后目录为空', async () => {
    expect(await agentView({ policy: { disabled: true } })).toEqual([]);
  });

  test('老板观测命令（ops.job.list、audit.list）员工看不到；员工查自己的作业（ops.job.get）仍可见', async () => {
    const names = namesOf(await agentView());
    for (const command of OWNER_ONLY_FOR_AGENTS) {
      expect(names).not.toContain(command);
    }
    expect(names).toContain('ops.job.get');
  });

  test('按目标锁定的命令带锁定说明（来自 TARGET_LOCKS），只读的身份命令不带', async () => {
    const entries = await agentView();
    const idpLock = TARGET_LOCKS.find((item) => item.command === 'idp.*')!.target;
    const cfLock = TARGET_LOCKS.find((item) => item.command === 'cf.api')!.target;
    expect(entries.find((entry) => entry.command === 'idp.client.create')?.lock).toBe(idpLock);
    expect(entries.find((entry) => entry.command === 'cf.api')?.lock).toBe(cfLock);
    expect(entries.find((entry) => entry.command === 'idp.status')?.lock).toBeUndefined();
    expect(entries.find((entry) => entry.command === 'idp.user.list_agents')?.lock).toBeUndefined();
    expect(entries.find((entry) => entry.command === 'message.list')?.lock).toBeUndefined();
  });
});
