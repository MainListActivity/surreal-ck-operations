import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeRuntime, nativeArgs, parseNativeResult, type NativeOptions } from '../src/runner/native.ts';
import type { SpawnInput, TurnEnded } from '../src/runner/contracts.ts';

const input = (provider = 'factory-droid'): SpawnInput => ({ title: 'SCK · fixture', provider, model: 'fixture-model',
  cwd: tmpdir(), workspaceTitle: 'fixture', labels: { employee_id: 'fixture' }, env: { SECRET: 'never-persist-this' }, prompt: '你好 $(no-shell) `no-exec`' });
const until = async (fn: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await Bun.sleep(10); }
  throw new Error('fixture timeout');
};
function fixture(code: string, options: Partial<NativeOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sck-native-'));
  const script = join(root, 'fixture.cjs');
  writeFileSync(script, code);
  const events: TurnEnded[] = [];
  const runtime = new NativeRuntime({ root, host: 'test', command: () => [process.execPath, script],
    environment: async () => ({ PATH: process.env.PATH ?? '', FIXTURE_ROOT: root }),
    onEnded: async event => { events.push(event); }, stopGraceMs: 25, ...options });
  return { runtime, root, events, async close() { await runtime.close(); rmSync(root, { recursive: true, force: true }); } };
}
const success = `let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => prompt += s);
process.stdin.on('end', () => {
 require('fs').writeFileSync(process.env.FIXTURE_ROOT + '/received.json', JSON.stringify({ argv: process.argv.slice(2), prompt }));
 console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-session', result: '完成', usage: { input_tokens: 7 } }));
});`;

test('原生 CLI 首轮在绑定后激活；prompt 走 stdin，续跑固定 session，凭证不入持久状态', async () => {
  const f = fixture(success);
  try {
    const id = await f.runtime.spawn(input());
    expect((await f.runtime.status(id))?.status).toBe('running');
    expect(f.events).toHaveLength(0);
    await f.runtime.activate(id);
    await until(() => f.events.length === 1);
    expect(f.events[0]?.outcome.kind).toBe('completed');
    expect(await f.runtime.lastInputTokens(id)).toBe(7);
    const first = JSON.parse(readFileSync(join(f.root, 'received.json'), 'utf8'));
    expect(first.prompt).toBe(input().prompt);
    expect(first.argv).not.toContain(input().prompt);
    await f.runtime.send(id, '继续');
    await until(() => f.events.length === 2);
    expect(JSON.parse(readFileSync(join(f.root, 'received.json'), 'utf8')).argv).toContain('--session-id');
    const state = readFileSync(join(f.root, 'sessions.json'), 'utf8');
    expect(state).toContain('native-session');
    expect(state).not.toContain('never-persist-this');
    expect(state).not.toContain(input().prompt);
    expect(f.events[0]!.turnId).not.toBe(f.events[1]!.turnId);
  } finally { await f.close(); }
});

for (const [name, output, exit] of [
  ['空输出', '', 0], ['普通文本', 'looks done', 0],
  ['供应商失败', JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: '429 usage cap reached' }), 0],
  ['缺少会话标识', JSON.stringify({ type: 'result', subtype: 'success', is_error: false }), 0],
  ['非零退出', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's' }), 1],
] as const) test(`不能把${name}判为成功`, async () => {
  const f = fixture(`process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(output)}); process.exitCode = ${exit}; });`);
  try { const id = await f.runtime.spawn(input()); await f.runtime.activate(id); await until(() => f.events.length === 1);
    expect(f.events[0]?.outcome.kind).toBe('failed'); expect((await f.runtime.status(id))?.status).toBe('error');
  } finally { await f.close(); }
});

test('同一会话拒绝并发发送；stop 强制结束不响应 TERM 的进程且只产生一次取消事件', async () => {
  const f = fixture(`process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.env.FIXTURE_ROOT + '/ready', 'ready'); process.stdin.resume(); setInterval(() => {}, 1000);`);
  try {
    const id = await f.runtime.spawn(input()); await f.runtime.activate(id);
    await until(() => existsSync(join(f.root, 'ready')));
    await expect(f.runtime.send(id, 'duplicate')).rejects.toThrow('不可发送');
    await f.runtime.stop(id); expect(f.events).toHaveLength(1); expect(f.events[0]?.outcome.kind).toBe('canceled');
    expect((await f.runtime.status(id))?.status).not.toBe('running');
  } finally { await f.close(); }
});

test('一个节点只允许一个写者；正常退出后重新加载会话可续跑', async () => {
  const f = fixture(success);
  let replacement: NativeRuntime | undefined;
  try {
    expect(() => new NativeRuntime({ root: f.root, host: 'test', command: () => [], environment: async () => ({}) })).toThrow();
    const id = await f.runtime.spawn(input()); await f.runtime.activate(id); await until(() => f.events.length === 1);
    await f.runtime.close();
    replacement = new NativeRuntime({ root: f.root, host: 'test', command: () => [process.execPath, join(f.root, 'fixture.cjs')],
      environment: async () => ({ FIXTURE_ROOT: f.root }) });
    expect(replacement.describe(id)?.nativeSessionId).toBe('native-session');
    await replacement.send(id, 'after restart');
    await until(async () => (await replacement!.status(id))?.status === 'idle');
  } finally { await replacement?.close(); await f.close(); }
});

test('崩溃后仍存活的原进程标记 unknown，拒绝重载和重复发送', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sck-native-orphan-'));
  writeFileSync(join(root, 'sessions.json'), JSON.stringify({ version: 1, host: 'test', workspaces: [], sessions: [{
    id: 'orphan', host: 'test', provider: 'factory-droid', status: 'running', pid: process.pid, nativeSessionId: 's', labels: {},
  }] }));
  const runtime = new NativeRuntime({ root, host: 'test', command: () => [], environment: async () => ({}) });
  try { expect((await runtime.status('orphan'))?.status).toBe('unknown');
    await expect(runtime.reload('orphan')).rejects.toThrow(); await expect(runtime.send('orphan', 'duplicate')).rejects.toThrow();
  } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('输出超限杀掉进程并报错；关闭执行端不触发派工收尾', async () => {
  const f = fixture(`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('x'.repeat(2000)));`, { maxOutputBytes: 30 });
  try { const id = await f.runtime.spawn(input()); await f.runtime.activate(id); await until(() => f.events.length === 1);
    expect(await f.runtime.lastError(id)).toContain('超过限制');
  } finally { await f.close(); }
  const g = fixture(`process.stdin.resume(); setInterval(() => {}, 1000);`);
  try { const id = await g.runtime.spawn(input()); await g.runtime.activate(id); await g.runtime.close(); expect(g.events).toHaveLength(0); }
  finally { await g.close(); }
});

test('不存在的 CLI 路径返回启动失败并退出 running', async () => {
  const f = fixture('', { command: () => ['/nonexistent/sck-fixture'] });
  try { const id = await f.runtime.spawn(input()); await expect(f.runtime.activate(id)).rejects.toThrow();
    await until(() => f.events.length === 1); expect((await f.runtime.status(id))?.status).toBe('error');
  } finally { await f.close(); }
});

test('Claude 与 Codex 使用原生明确续跑参数，Codex 只接受正式终态', () => {
  expect(nativeArgs({ provider: 'claude', model: 'm', nativeSessionId: 'session' })).toEqual(['-p', '--output-format', 'json', '--model', 'm', '--resume', 'session']);
  expect(nativeArgs({ provider: 'codex', model: 'm', nativeSessionId: 'session' }).slice(0, 4)).toEqual(['exec', 'resume', 'session', '--json']);
  const lines = [{ type: 'thread.started', thread_id: 's' }, { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }];
  expect(parseNativeResult('codex', lines.map(value => JSON.stringify(value)).join('\n')).completed).toBe(false);
  const done = [...lines, { type: 'turn.completed', usage: { input_tokens: 9 } }].map(value => JSON.stringify(value)).join('\n');
  expect(parseNativeResult('codex', done)).toMatchObject({ completed: true, sessionId: 's', inputTokens: 9 });
  expect(parseNativeResult('codex', done + '\n' + JSON.stringify({ type: 'turn.failed', error: { message: 'failure' } })).completed).toBe(false);
});

test('业务收尾完成前保持忙碌，关闭等待收尾后才释放节点写锁', async () => {
  let finish!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(success, { onEnded: async () => { entered = true; await gate; } });
  try {
    const id = await f.runtime.spawn(input()); await f.runtime.activate(id); await until(() => entered);
    expect((await f.runtime.status(id))?.status).toBe('running');
    let closed = false;
    const stopping = f.runtime.close().then(() => { closed = true; });
    await Bun.sleep(10); expect(closed).toBe(false);
    finish(); await stopping; expect(closed).toBe(true);
  } finally { finish(); await f.close(); }
});

test('环境解析期间停止不会留下迟到启动的进程', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(success, { environment: async () => { await gate; return {}; } });
  try {
    const id = await f.runtime.spawn(input());
    const starting = f.runtime.activate(id);
    const result = starting.then(() => undefined, error => error as Error);
    const stopping = f.runtime.close();
    release(); expect((await result)?.message).toContain('正在关闭'); await stopping;
    expect(f.events).toHaveLength(0);
  } finally { release(); await f.close(); }
});

 test('Claude verbose JSON 数组只以最后的正式 result 判断完成', () => {
  const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'real-session', result: 'done' };
  expect(parseNativeResult('claude', JSON.stringify([{ type: 'system' }, result]))).toMatchObject({ completed: true, sessionId: 'real-session', text: 'done' });
  expect(parseNativeResult('claude', JSON.stringify([result, { type: 'assistant' }])).completed).toBe(false);
  expect(parseNativeResult('claude', '[]').completed).toBe(false);
  expect(nativeArgs({ provider: 'codex', model: '' })).toContain('--skip-git-repo-check');
  expect(nativeArgs({ provider: 'codex', model: '', nativeSessionId: 'resumed' })).toContain('--skip-git-repo-check');
});

test('原生回合结束通知失败后持久保存结果，重启只重放结果不重跑模型', async () => {
  const f = fixture(success, { onEnded: async () => { throw new Error('synthetic host unavailable'); } });
  let replacement: NativeRuntime | undefined;
  try {
    const id = await f.runtime.spawn(input()); await f.runtime.activate(id);
    await until(() => !!f.runtime.describe(id)?.pendingEnd);
    await f.runtime.close();
    const recovered: TurnEnded[] = [];
    replacement = new NativeRuntime({ root: f.root, host: 'test', command: () => { throw new Error('must not start a process'); },
      environment: async () => ({}), onEnded: async event => { recovered.push(event); } });
    await replacement.recoverFinishedTurns(); await replacement.recoverFinishedTurns();
    expect(recovered).toHaveLength(1); expect(recovered[0]?.outcome.kind).toBe('completed');
    expect(recovered[0]?.timeline[0]?.text).toBe('完成');
    expect(replacement.describe(id)?.pendingEnd).toBeUndefined();
  } finally { await replacement?.close(); await f.close(); }
});

test('真实执行端进程 SIGKILL 后内核锁释放，可接管但不自动激活或重发', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sck-native-process-crash-'));
  const source = new URL('../src/runner/native.ts', import.meta.url).pathname;
  const script = join(root, 'runner.ts');
  const ready = join(root, 'ready');
  writeFileSync(script, `import { NativeRuntime } from ${JSON.stringify(source)};
    import { writeFileSync } from 'node:fs';
    const runtime = new NativeRuntime({ root: ${JSON.stringify(root)}, host: 'crash-fixture',
      command: () => { throw new Error('No execution permitted in this fixture'); }, environment: async () => ({}) });
    if (process.env.REOPEN === '1') {
      writeFileSync(${JSON.stringify(join(root, 'reopened'))}, JSON.stringify([...await runtime.list()]));
      await runtime.close();
    } else {
      const id = await runtime.spawn(${JSON.stringify(input())});
      writeFileSync(${JSON.stringify(ready)}, id); setInterval(() => {}, 1000);
    }`);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'ignore' });
    await until(() => existsSync(ready));
    child.kill('SIGKILL'); await child.exited; child = undefined;
    const before = readFileSync(join(root, 'sessions.json'), 'utf8');
    expect(JSON.parse(before).sessions[0].status).toBe('starting');
    const replacement = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'pipe', env: { ...process.env, REOPEN: '1' } });
    child = replacement;
    expect(await replacement.exited).toBe(0);
    const recovered = JSON.parse(readFileSync(join(root, 'reopened'), 'utf8'));
    expect(recovered).toHaveLength(1); expect(recovered[0][1].status).toBe('error');
    expect(readFileSync(join(root, 'sessions.json'), 'utf8')).toBe(before);
    // Permanent inode remains; takeover never deletes the lock or replays a prompt.
  } finally { if (child && child.exitCode === null) { child.kill(); await child.exited; } rmSync(root, { recursive: true, force: true }); }
}, 10000);

test('真实并发启动仅一个写者；SIGKILL后多个候选仍仅一个；PID复用不影响内核锁', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sck-writer-contenders-'));
  const source = new URL('../src/runner/native.ts', import.meta.url).pathname;
  const script = join(root, 'contender.ts');
  writeFileSync(script, `import { NativeRuntime } from ${JSON.stringify(source)};
    import { writeFileSync, existsSync } from 'node:fs';
    while (!existsSync(${JSON.stringify(join(root, 'go'))})) await Bun.sleep(5);
    try {
      const r = new NativeRuntime({ root: ${JSON.stringify(root)}, host: 'test', command: () => [], environment: async () => ({}) });
      writeFileSync(${JSON.stringify(root)} + '/winner-' + process.pid, 'held');
      setInterval(() => {}, 1000);
    } catch { process.exit(17); }`);
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  const launch = () => { const p = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'ignore' }); children.push(p); return p; };
  try {
    // Stale v2 metadata deliberately names a live unrelated process (simulated PID reuse).
    // Kernel ownership, not this diagnostic PID, determines who may enter.
    writeFileSync(join(root, 'writer.lock'), JSON.stringify({ version: 2, host: 'test', pid: process.pid }));
    const first = Array.from({ length: 6 }, launch);
    writeFileSync(join(root, 'go'), 'go');
    await until(() => first.filter(p => p.exitCode !== null).length === 5);
    const winner = first.find(p => p.exitCode === null)!;
    expect(first.filter(p => existsSync(join(root, `winner-${p.pid}`)))).toHaveLength(1);
    expect(first.filter(p => p.exitCode === 17)).toHaveLength(5);
    const liveContender = launch(); expect(await liveContender.exited).toBe(17);
    winner.kill('SIGKILL'); await winner.exited;
    const next = Array.from({ length: 6 }, launch);
    await until(() => next.filter(p => p.exitCode !== null).length === 5);
    expect(next.filter(p => existsSync(join(root, `winner-${p.pid}`)))).toHaveLength(1);
    expect(next.filter(p => p.exitCode === 17)).toHaveLength(5);
  } finally {
    for (const p of children) if (p.exitCode === null) p.kill('SIGKILL');
    await Promise.all(children.map(p => p.exited)); rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('旧锁迁移：活PID及损坏锁保守拒绝，实测已退出PID可接管', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sck-legacy-lock-'));
  const options = { root, host: 'test', command: () => [], environment: async () => ({}) };
  let runtime: NativeRuntime | undefined;
  try {
    writeFileSync(join(root, 'writer.lock'), JSON.stringify({ host: 'test', pid: process.pid }));
    expect(() => new NativeRuntime(options)).toThrow('旧执行端仍存活');
    writeFileSync(join(root, 'writer.lock'), '');
    expect(() => new NativeRuntime(options)).toThrow('损坏');
    const dead = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], { stdout: 'ignore', stderr: 'ignore' }); await dead.exited;
    writeFileSync(join(root, 'writer.lock'), JSON.stringify({ host: 'test', pid: dead.pid }));
    runtime = new NativeRuntime(options);
    expect(JSON.parse(readFileSync(join(root, 'writer.lock'), 'utf8')).version).toBe(2);
    expect(() => new NativeRuntime(options)).toThrow('写锁已占用');
    await runtime.close(); runtime = new NativeRuntime(options); await runtime.close();
  } finally { await runtime?.close(); rmSync(root, { recursive: true, force: true }); }
});
