import { expect, test } from 'bun:test';
import { launchPreview, nativeArgs } from '../src/runner/native-args.ts';
import { nativeArgs as runtimeArgs } from '../src/runner/native.ts';
import { UNATTENDED_MODE } from '../src/dispatcher/paseo.ts';

test('老板端的启动命令预览与执行端实际参数同源：可执行文件名 + nativeArgs（派工用的无人值守模式）', () => {
  expect(runtimeArgs).toBe(nativeArgs);
  expect(launchPreview({ provider: 'claude', model: 'claude-haiku-5-5', thinking: 'max' })).toEqual({
    via: 'native',
    argv: ['claude', ...nativeArgs({ provider: 'claude', model: 'claude-haiku-5-5', thinking: 'max', mode: UNATTENDED_MODE.claude })],
  });
  expect(launchPreview({ provider: 'claude', model: 'm', thinking: 'max' }).argv.join(' '))
    .toBe('claude -p --output-format stream-json --verbose --model m --effort max --permission-mode bypassPermissions');
  expect(launchPreview({ provider: 'factory-droid', model: 'm' }).argv.join(' ')).toBe('droid exec --output-format stream-json --model m --auto high');
  expect(launchPreview({ provider: 'codex', model: 'auto:sol', thinking: 'high' }).argv).toContain('--dangerously-bypass-approvals-and-sandbox');
});

test('经 Paseo 启动的 provider 没有命令行可预览；空的思考强度不出现 --effort', () => {
  expect(launchPreview({ provider: 'antigravity', model: 'gemini-3.8-flash-medium' })).toEqual({ via: 'paseo', argv: [] });
  expect(launchPreview({ provider: 'claude', model: 'm', thinking: '' }).argv).not.toContain('--effort');
});
