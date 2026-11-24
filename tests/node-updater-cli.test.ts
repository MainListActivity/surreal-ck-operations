import { expect, test } from 'bun:test';
import { main, RETIRED_NOTICE } from '../scripts/node-updater.ts';

// 旧定时更新器过渡入口：只说明已由执行端接管，不连云端、不切换版本。
test('run 与 status 只打印接管说明并返回 0', async () => {
  for (const command of ['run', 'status']) {
    const lines: string[] = [];
    expect(await main([command], { log: line => lines.push(line) })).toBe(0);
    expect(lines).toEqual([RETIRED_NOTICE]);
  }
});

test('未知命令返回 1', async () => {
  const lines: string[] = [];
  expect(await main(['install'], { log: line => lines.push(line) })).toBe(1);
  expect(lines.join('\n')).toContain('用法');
});
