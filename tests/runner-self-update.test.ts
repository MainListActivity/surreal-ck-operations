// 执行端自更新循环、旧定时更新器退役与执行端内预览服务。不调用 launchctl，不连云端。
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateOutcome } from '../src/node-updater.ts';
import { LEGACY_UPDATER_LABEL, retireLegacyUpdater, startSelfUpdate, summarize } from '../src/runner/self-update.ts';
import { startPreviewHost } from '../src/runner/preview-host.ts';

const trash: string[] = [];
afterEach(() => { for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempHome = () => { const dir = mkdtempSync(join(tmpdir(), 'sck-self-update-')); trash.push(dir); return dir; };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('自更新循环：未切换时按间隔继续；切换后通知调用方并停止安排下一轮', async () => {
  const outcomes: UpdateOutcome[] = [{ kind: 'current', version: '1.0.0', sha: 'a'.repeat(40) }, { kind: 'switched', version: '1.0.1', sha: 'b'.repeat(40) }];
  let runs = 0, retires = 0, switched = 0;
  const lines: string[] = [];
  const stop = startSelfUpdate({ home: tempHome(), nodeId: 'n', db: undefined as never, idle: async () => true,
    onSwitched: () => { switched++; }, log: line => lines.push(line), firstDelayMs: 1, intervalMs: 5,
    runOnce: async () => outcomes[runs++] ?? { kind: 'no_release' }, retire: async () => { retires++; } });
  await wait(80);
  stop();
  expect(runs).toBe(2);
  expect(retires).toBe(2);
  expect(switched).toBe(1);
  expect(lines.some(line => line.includes('已切换 版本=1.0.1'))).toBe(true);
});

test('自更新循环：一轮抛错记为失败，不中断循环', async () => {
  let runs = 0;
  const lines: string[] = [];
  const stop = startSelfUpdate({ home: tempHome(), nodeId: 'n', db: undefined as never, idle: async () => true,
    onSwitched: () => {}, log: line => lines.push(line), firstDelayMs: 1, intervalMs: 5,
    runOnce: async () => { runs++; throw new Error('gh 超时 https://x.example/a'); }, retire: async () => {} });
  await wait(60);
  stop();
  expect(runs).toBeGreaterThan(1);
  expect(lines[0]).toContain('失败');
  expect(lines[0]).not.toContain('x.example');
});

test('退役旧定时更新器：卸载并把 plist 移到 retired/；不存在即 absent；更新锁被占用时等待', async () => {
  const home = tempHome();
  const userHome = tempHome();
  const agents = join(userHome, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  const plist = join(agents, `${LEGACY_UPDATER_LABEL}.plist`);
  writeFileSync(plist, '<plist/>');
  const calls: string[][] = [];
  const launchctl = async (args: string[]) => { calls.push(args); };
  // 旧更新器正持有更新锁：不打断它。
  mkdirSync(join(home, 'updater'), { recursive: true });
  writeFileSync(join(home, 'updater', 'lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  expect(await retireLegacyUpdater({ home, userHome, uid: 501, platform: 'darwin', launchctl, log: () => {} })).toBe('busy');
  expect(calls).toEqual([]);
  rmSync(join(home, 'updater', 'lock'));
  expect(await retireLegacyUpdater({ home, userHome, uid: 501, platform: 'darwin', launchctl, log: () => {} })).toBe('retired');
  expect(calls).toEqual([['bootout', `gui/501/${LEGACY_UPDATER_LABEL}`]]);
  expect(existsSync(plist)).toBe(false);
  expect(readFileSync(join(home, 'retired', `${LEGACY_UPDATER_LABEL}.plist`), 'utf8')).toBe('<plist/>');
  expect(await retireLegacyUpdater({ home, userHome, uid: 501, platform: 'darwin', launchctl, log: () => {} })).toBe('absent');
  expect(await retireLegacyUpdater({ home, userHome, platform: 'linux', launchctl, log: () => {} })).toBe('unsupported');
});

test('退役旧定时更新器：bootout 报错（未加载）时照常移走 plist', async () => {
  const home = tempHome();
  const userHome = tempHome();
  mkdirSync(join(userHome, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(userHome, 'Library', 'LaunchAgents', `${LEGACY_UPDATER_LABEL}.plist`), '<plist/>');
  const out = await retireLegacyUpdater({ home, userHome, uid: 501, platform: 'darwin', log: () => {},
    launchctl: async () => { throw new Error('Boot-out failed: 3: No such process'); } });
  expect(out).toBe('retired');
});

test('结果摘要', () => {
  expect(summarize({ kind: 'deferred', reason: '本节点有进行中的租约' })).toBe('暂缓 原因=本节点有进行中的租约');
  expect(summarize({ kind: 'no_release' })).toBe('没有正式发行版本');
});

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    server.close(() => resolve(port));
  });
});

test('预览服务：LAN 面承载 /api/owner/* 与 /e/ 文件；签名面不承载老板接口，未签名文件请求被拒', async () => {
  const home = tempHome();
  mkdirSync(join(home, 'evidence', 'task1'), { recursive: true });
  writeFileSync(join(home, 'evidence', 'task1', 'a.txt'), 'hello');
  const [lanPort, signedPort] = [await freePort(), await freePort()];
  const host = startPreviewHost({ home, lanPort, signedPort, secret: 'fixture-secret', retryMs: 10, log: () => {},
    ownerFetch: async () => Response.json({ owner: true }) });
  try {
    for (let i = 0; i < 100 && !(host.listening.lan && host.listening.signed); i++) await wait(10);
    expect(host.listening).toEqual({ lan: true, signed: true });
    expect(await (await fetch(`http://127.0.0.1:${lanPort}/api/owner/status`, { method: 'POST', body: '{}' })).json()).toEqual({ owner: true });
    expect(await (await fetch(`http://127.0.0.1:${lanPort}/e/task1/a.txt`)).text()).toBe('hello');
    expect(await (await fetch(`http://127.0.0.1:${signedPort}/api/owner/status`, { method: 'POST', body: '{}' })).text()).not.toContain('"owner":true');
    expect((await fetch(`http://127.0.0.1:${signedPort}/e/task1/a.txt`)).status).not.toBe(200);
    const status = JSON.parse(readFileSync(join(home, 'preview-status.json'), 'utf8'));
    expect(status.lan).toEqual(expect.objectContaining({ running: true, port: lanPort }));
    expect(status.signed).toEqual(expect.objectContaining({ configured: true, running: true }));
  } finally {
    await host.stop();
  }
});

test('预览服务：端口被占用时不改写状态文件，占用方释放后接管', async () => {
  const home = tempHome();
  const port = await freePort();
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(port, '0.0.0.0', () => resolve()));
  writeFileSync(join(home, 'preview-status.json'), '{"owner":"plugin"}\n');
  const host = startPreviewHost({ home, lanPort: port, retryMs: 10, log: () => {} });
  try {
    await wait(60);
    expect(host.listening.lan).toBe(false);
    expect(readFileSync(join(home, 'preview-status.json'), 'utf8')).toBe('{"owner":"plugin"}\n');
    await new Promise<void>(resolve => blocker.close(() => resolve()));
    for (let i = 0; i < 100 && !host.listening.lan; i++) await wait(10);
    expect(host.listening.lan).toBe(true);
    expect(JSON.parse(readFileSync(join(home, 'preview-status.json'), 'utf8')).host).toBe('native');
  } finally {
    await host.stop();
  }
});
