import { expect, test } from 'bun:test';
import { UNATTENDED_MODE } from '../src/dispatcher/paseo.ts';

// 员工无人值守运行的前提：spawn 时 provider 映射到 Paseo 的免询问 mode。
// claude 缺表曾导致编制派到 claude 后全程弹权限框——表缺项就是静默退回默认询问模式。
test('every staffable provider maps to its unattended Paseo mode', () => {
  expect(UNATTENDED_MODE.codex).toBe('full-access');
  expect(UNATTENDED_MODE.claude).toBe('bypassPermissions');
  expect(UNATTENDED_MODE.devin).toBe('bypass');
  expect(UNATTENDED_MODE['factory-droid']).toBe('auto-high');
  // grok 无 mode 概念，刻意缺席。
  expect('grok' in UNATTENDED_MODE).toBe(false);
});
