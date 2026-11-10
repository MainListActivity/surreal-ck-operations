import { describe, expect, test } from 'bun:test';
import { COMMAND_CATALOG, type CommandSpec } from '../src/command-catalog.ts';
import { catalogGroups, catalogTags } from '../src/ui/model.ts';

const spec = (command: string): CommandSpec => {
  const found = COMMAND_CATALOG.find(item => item.command === command);
  if (!found) throw new Error(`命令目录缺少 ${command}`);
  return found;
};

const commandsOf = (query: string): string[] => catalogGroups(COMMAND_CATALOG, query).flatMap(view => view.commands.map(item => item.command));

describe('命令面板的分组与筛选', () => {
  test('不填关键字时每条命令出现一次，组按目录里首次出现的顺序排列', () => {
    const groups = catalogGroups(COMMAND_CATALOG, '');
    expect(commandsOf('').sort()).toEqual(COMMAND_CATALOG.map(item => item.command).sort());
    expect(groups.map(view => view.group)).toEqual([...new Set(COMMAND_CATALOG.map(item => item.group))]);
    for (const view of groups) expect(view.commands.every(item => item.group === view.group)).toBe(true);
  });

  test('关键字不分大小写，匹配命令名、用途或分组', () => {
    expect(commandsOf('HOST.EXEC')).toEqual(['host.exec']);
    expect(commandsOf('主机与发布')).toEqual(['host.exec']);
    expect(catalogGroups(COMMAND_CATALOG, '翻译').map(view => view.group)).toEqual(['翻译']);
  });

  test('没有匹配时返回空数组，只有空白的关键字等同于不填', () => {
    expect(catalogGroups(COMMAND_CATALOG, '没有这样的命令')).toEqual([]);
    expect(catalogGroups(COMMAND_CATALOG, '   ')).toEqual(catalogGroups(COMMAND_CATALOG, ''));
  });
});

describe('命令的标记', () => {
  test('高危、执行端、只读分别标出；没有标记的命令为空', () => {
    expect(catalogTags(spec('host.exec'))).toEqual(['高危', '执行端']);
    expect(catalogTags(spec('cmd.catalog'))).toEqual(['只读']);
    expect(catalogTags(spec('task.update'))).toEqual([]);
  });
});
