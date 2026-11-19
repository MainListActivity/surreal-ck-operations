/**
 * 同目录本地写锁（N1）：独立于跨节点租约。
 * 证据只证明「同一 native/<id> 目录上第二写者失败」；不得用跨目录共库租约测试替代。
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireNativeWriter } from '../src/runner/native-lock.ts';
import { NativeRuntime } from '../src/runner/native.ts';

const until = async (fn: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await Bun.sleep(10); }
  throw new Error('fixture timeout');
};

test('N1：同一目录第二写者抢 writer.lock 失败；原写者继续；host 不匹配拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'sck-writer-lock-n1-'));
  const lock = join(root, 'writer.lock');
  let releaseA: (() => void) | undefined;
  let runtime: NativeRuntime | undefined;
  try {
    releaseA = acquireNativeWriter(lock, 'node-a');
    expect(() => acquireNativeWriter(lock, 'node-a')).toThrow(/写锁已占用|不可用/);
    expect(() => acquireNativeWriter(lock, 'node-b')).toThrow(/写锁已占用|不可用|身份不匹配/);
    const meta = JSON.parse(readFileSync(lock, 'utf8')) as { version: number; host: string; pid: number };
    expect(meta).toMatchObject({ version: 2, host: 'node-a', pid: process.pid });
    releaseA(); releaseA = undefined;

    // 释放后换 host 的残留元数据拒绝猜测接管。
    writeFileSync(lock, JSON.stringify({ version: 2, host: 'other-node', pid: process.pid }));
    expect(() => acquireNativeWriter(lock, 'node-a')).toThrow(/节点身份不匹配/);

    // 恢复为本 host 元数据后再验「同目录第二 Runtime 失败」。
    writeFileSync(lock, JSON.stringify({ version: 2, host: 'node-a', pid: process.pid }));
    runtime = new NativeRuntime({ root, host: 'node-a', command: () => [], environment: async () => ({}) });
    expect(() => new NativeRuntime({ root, host: 'node-a', command: () => [], environment: async () => ({}) })).toThrow(/写锁/);
  } finally {
    releaseA?.();
    void runtime?.close().finally(() => rmSync(root, { recursive: true, force: true }));
  }
});

test('N1 并发：真实多进程同目录仅一个写者胜出；胜者退出后可再接管', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sck-writer-lock-race-'));
  const source = join(import.meta.dir, '../src/runner/native.ts');
  const script = join(root, 'contender.ts');
  writeFileSync(script, `import { NativeRuntime } from ${JSON.stringify(source)};
    import { writeFileSync, existsSync } from 'node:fs';
    while (!existsSync(${JSON.stringify(join(root, 'go'))})) await Bun.sleep(5);
    try {
      const r = new NativeRuntime({ root: ${JSON.stringify(root)}, host: 'lock-race', command: () => [], environment: async () => ({}) });
      writeFileSync(${JSON.stringify(root)} + '/winner-' + process.pid, 'held');
      setInterval(() => {}, 1000);
    } catch { process.exit(17); }`);
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  const launch = () => { const p = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'ignore' }); children.push(p); return p; };
  try {
    writeFileSync(join(root, 'writer.lock'), JSON.stringify({ version: 2, host: 'lock-race', pid: process.pid }));
    const first = Array.from({ length: 6 }, launch);
    writeFileSync(join(root, 'go'), 'go');
    await until(() => first.filter(p => p.exitCode !== null).length === 5);
    expect(first.filter(p => existsSync(join(root, `winner-${p.pid}`)))).toHaveLength(1);
    expect(first.filter(p => p.exitCode === 17)).toHaveLength(5);
    const winner = first.find(p => p.exitCode === null)!;
    winner.kill('SIGKILL'); await winner.exited;
    const next = Array.from({ length: 6 }, launch);
    await until(() => next.filter(p => p.exitCode !== null).length === 5);
    expect(next.filter(p => existsSync(join(root, `winner-${p.pid}`)))).toHaveLength(1);
  } finally {
    for (const p of children) if (p.exitCode === null) p.kill('SIGKILL');
    await Promise.all(children.map(p => p.exited));
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('同目录写锁与跨节点租约独立：两目录可同时持锁，不共享 inode', () => {
  const a = mkdtempSync(join(tmpdir(), 'sck-writer-a-'));
  const b = mkdtempSync(join(tmpdir(), 'sck-writer-b-'));
  let ra: (() => void) | undefined;
  let rb: (() => void) | undefined;
  try {
    ra = acquireNativeWriter(join(a, 'writer.lock'), 'runner-a');
    rb = acquireNativeWriter(join(b, 'writer.lock'), 'runner-b');
    expect(JSON.parse(readFileSync(join(a, 'writer.lock'), 'utf8')).host).toBe('runner-a');
    expect(JSON.parse(readFileSync(join(b, 'writer.lock'), 'utf8')).host).toBe('runner-b');
    expect(() => acquireNativeWriter(join(a, 'writer.lock'), 'runner-a')).toThrow(/写锁/);
  } finally {
    ra?.(); rb?.();
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
