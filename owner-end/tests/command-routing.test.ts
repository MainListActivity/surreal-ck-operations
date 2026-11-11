import { expect, test } from 'bun:test';
import { BACKEND_OWNER_COMMANDS } from '../src/command-routing.ts';
import { runOwnerCommandOn } from '../src/commands.ts';
import { COMMAND_CATALOG } from '../src/command-catalog.ts';
import { IDENTITY_COMMANDS } from '../src/idp-commands.ts';
import { POLICY_COMMANDS } from '../src/policy-commands.ts';
import { TRANSLATE_COMMANDS } from '../src/messages.ts';
import { fakeDb } from './_support.ts';

test('服务端执行清单覆盖 dispatch 里所有读配置或调外部服务的命令组', () => {
  for (const command of [...IDENTITY_COMMANDS, ...POLICY_COMMANDS, ...TRANSLATE_COMMANDS,
    'cf.api', 'message.edit', 'message.edit_rendered', 'message.release', 'message.send']) {
    expect(BACKEND_OWNER_COMMANDS.has(command)).toBe(true);
  }
});

test('服务端执行清单里的每条命令都在命令目录里（没有写错的名字）', () => {
  const catalog = new Set(COMMAND_CATALOG.map((spec) => spec.command));
  for (const command of BACKEND_OWNER_COMMANDS) expect(catalog.has(command)).toBe(true);
});

test('没有服务端配置时（页面直连），服务端命令明确拒绝且不触库', async () => {
  const { db, calls } = fakeDb();
  for (const command of BACKEND_OWNER_COMMANDS) {
    await expect(runOwnerCommandOn({}, db, 'owner-user', command, {})).rejects.toMatchObject({ code: 'unavailable' });
  }
  expect(calls).toHaveLength(0);
});
