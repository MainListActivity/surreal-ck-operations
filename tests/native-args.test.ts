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

test('云端通道：桥接进程参数只有 --resume 与非 default 的 --model', () => {
  expect(nativeArgs({ provider: 'codex-cloud', model: 'default' })).toEqual([]);
  expect(nativeArgs({ provider: 'devin-cloud', model: 'default', nativeSessionId: 'lane-1' })).toEqual(['--resume', 'lane-1']);
  expect(nativeArgs({ provider: 'jules', model: 'other' })).toEqual(['--model', 'other']);
  expect(launchPreview({ provider: 'jules', model: 'default' }).argv)
    .toEqual(['bun', 'src/runner/cloud-lane/main.ts', 'jules']);
});

test('warp 走本地桥接：launchPreview 指向 warp main.ts，参数与通道一致', () => {
  const preview = launchPreview({ provider: 'warp', model: 'default' });
  expect(preview.via).toBe('native');
  expect(preview.argv.slice(0, 3)).toEqual(['bun', 'src/runner/warp/main.ts', 'warp']);
  const resumed = launchPreview({ provider: 'warp', model: 'oz-big' });
  expect(resumed.argv).toEqual(expect.arrayContaining(['--model', 'oz-big']));
});
