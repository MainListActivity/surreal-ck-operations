import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWarpTurn, type WarpDeps, type WarpProcess } from '../src/runner/warp/turn.ts';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

const stream = (text: string): AsyncIterable<Uint8Array> => (async function* () { yield new TextEncoder().encode(text); })();

interface SpawnCall { cmd: string; args: string[]; cwd: string }
function fakeSpawn(lines: string[], opts: { code?: number; stderr?: string } = {}) {
  const calls: SpawnCall[] = [];
  const spawn: WarpDeps['spawn'] = (cmd, args, o) => {
    calls.push({ cmd, args: [...args], cwd: o.cwd });
    return { stdout: stream(`${lines.join('\n')}\n`), stderr: stream(opts.stderr ?? ''),
      exited: Promise.resolve(opts.code ?? 0), kill() {} } satisfies WarpProcess;
  };
  return { calls, spawn };
}

const commWith = (worktree?: { path: string; branch: string }) => {
  const commDir = tmp('sck-warp-comm-');
  if (worktree) writeFileSync(join(commDir, 'claim.json'),
    JSON.stringify({ worktree: { worktreePath: worktree.path, branch: worktree.branch, intent: { kind: 'code' }, mode: 'exclusive' } }));
  return commDir;
};

const NDJSON = [
  '{"type":"system","event_type":"run_started","run_id":"r1","run_url":"https://oz.warp.dev/runs/r1"}',
  '{"type":"system","event_type":"conversation_started","conversation_id":"cd2c7f38-aaaa"}',
  '{"type":"agent","text":"工作结果：完成\\n"}',
];

describe('warp 本地通道', () => {
  test('claim 工作树优先作为 -C；conversation_id 为会话 ID；进展带 run_url；prompt 走文件不进 argv', async () => {
    const shared = tmp('sck-warp-shared-');
    const worktree = tmp('sck-warp-task-');
    const commDir = commWith({ path: worktree, branch: 'task/x' });
    const { calls, spawn } = fakeSpawn(NDJSON);
    const progress: string[] = [];
    const out = await runWarpTurn(
      { prompt: '# 任务\n\n实现需求甲。', cwd: shared, commDir, config: { bin: { oz: '/opt/oz/bin/oz' } } },
      { spawn, now: () => 1_000, progress: s => progress.push(s) });
    expect(out.status).toBe('success');
    expect(out.sessionId).toBe('cd2c7f38-aaaa');
    expect(out.text).toContain('工作结果：完成');
    expect(progress.some(s => s.includes('https://oz.warp.dev/runs/r1'))).toBe(true);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.cmd).toBe('/opt/oz/bin/oz');
    expect(call.cwd).toBe(worktree);
    const cIdx = call.args.indexOf('-C');
    expect(call.args[cIdx + 1]).toBe(worktree);
    // prompt 正文不出现在任何参数里；只有文件路径。
    expect(call.args.every(a => !a.includes('需求甲'))).toBe(true);
    const pIdx = call.args.indexOf('--prompt');
    expect(call.args[pIdx + 1]).toContain('.warp/turn-');
    const file = join(commDir, '.warp', 'turn-1000.md');
    expect(readFileSync(file, 'utf8')).toBe('# 任务\n\n实现需求甲。');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('--resume 续轮传 --conversation；非 default 模型传 --model；无 claim 用会话 cwd', async () => {
    const shared = tmp('sck-warp-shared-');
    const commDir = commWith();
    const { calls, spawn } = fakeSpawn(NDJSON);
    const out = await runWarpTurn(
      { prompt: '继续', cwd: shared, commDir, resumeId: 'conv-1', model: 'oz-big', config: { bin: { oz: '/usr/bin/oz' } } },
      { spawn, now: () => 5, progress: () => {} });
    expect(out.status).toBe('success');
    const call = calls[0]!;
    expect(call.args).toEqual(expect.arrayContaining(['--conversation', 'conv-1']));
    expect(call.args).toEqual(expect.arrayContaining(['--model', 'oz-big']));
    expect(call.cwd).toBe(shared);
  });

  test('default 模型不传 --model', async () => {
    const commDir = commWith();
    const { calls, spawn } = fakeSpawn(NDJSON);
    await runWarpTurn({ prompt: 'p', cwd: '/tmp', commDir, model: 'default' },
      { spawn, now: () => 5, progress: () => {} });
    expect(calls[0]!.args).not.toContain('--model');
  });

  test('非零退出 → error 且不含 prompt 正文', async () => {
    const commDir = commWith();
    const { spawn } = fakeSpawn(NDJSON.slice(0, 1), { code: 3, stderr: 'oz exploded\n' });
    const out = await runWarpTurn({ prompt: '秘密需求正文', cwd: '/tmp', commDir },
      { spawn, now: () => 5, progress: () => {} });
    expect(out.status).toBe('error');
    expect(out.text).toContain('退出码 3');
    expect(out.text).toContain('oz exploded');
    expect(out.text).not.toContain('秘密需求正文');
  });

  test('没有 agent 文本 → error', async () => {
    const commDir = commWith();
    const { spawn } = fakeSpawn(NDJSON.slice(0, 2));
    const out = await runWarpTurn({ prompt: 'p', cwd: '/tmp', commDir },
      { spawn, now: () => 5, progress: () => {} });
    expect(out.status).toBe('error');
    expect(out.text).toContain('没有给出答复');
  });
});
