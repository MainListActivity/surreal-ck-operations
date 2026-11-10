import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'node-updater.sh');
const BUNDLE_TEXT = "console.log('fixture node-updater');\n";

type Ctx = {
  tmp: string;
  home: string;
  serviceHome: string;
  fixture: string;
  fakeNode: string;
  fakePnpm: string;
};

let ctx: Ctx;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function writeManifest(dir: string, overrides: Record<string, unknown> = {}, drop: string[] = []): void {
  const bundle = readFileSync(join(dir, 'node-updater.js'));
  const base: Record<string, unknown> = {
    format: 1,
    product: 'sck-company',
    version: '0.0.0-test',
    sha: 'a'.repeat(40),
    requiredSchema: 1,
    createdAt: '2026-01-01T00:00:00Z',
    package: { name: 'sck-company.tgz', sha256: 'b'.repeat(64), bytes: 1 },
    updater: { name: 'node-updater.js', sha256: sha256(bundle.toString('utf8')), bytes: bundle.length },
  };
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const key of drop) delete merged[key];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(merged, null, 2));
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: ctx.home,
    TMPDIR: ctx.tmp,
    SCK_SERVICE_HOME: ctx.serviceHome,
    SCK_NODE_BIN: process.execPath,
    SCK_PNPM_BIN: ctx.fakePnpm,
    ...extraEnv,
  };
  const result = spawnSync('sh', [SCRIPT, ...args], { env, encoding: 'utf8', cwd: ROOT });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function installArgs(): string[] {
  return ['install', '--from', ctx.fixture, '--no-load'];
}

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'node-updater-test-'));
  const home = join(tmp, 'home');
  const serviceHome = join(tmp, 'service');
  const fixture = join(tmp, 'fixture');
  mkdirSync(home, { recursive: true });
  mkdirSync(fixture, { recursive: true });

  const fakeNode = join(tmp, 'fake-node');
  writeFileSync(fakeNode, '#!/bin/sh\necho v20.0.0\n');
  chmodSync(fakeNode, 0o755);

  const fakePnpm = join(tmp, 'fake-pnpm');
  writeFileSync(fakePnpm, '#!/bin/sh\necho 10.0.0\n');
  chmodSync(fakePnpm, 0o755);

  writeFileSync(join(fixture, 'node-updater.js'), BUNDLE_TEXT);
  writeManifest(fixture);

  ctx = { tmp, home, serviceHome, fixture, fakeNode, fakePnpm };
});

afterEach(() => {
  rmSync(ctx.tmp, { recursive: true, force: true });
});

test('install --no-load --from 安装 bundle 与 run.sh，且不写 plist', () => {
  const res = run(installArgs());
  expect(res.status).toBe(0);

  const installed = join(ctx.serviceHome, 'updater', 'node-updater.js');
  expect(readFileSync(installed, 'utf8')).toBe(BUNDLE_TEXT);
  expect(statSync(installed).mode & 0o777).toBe(0o600);

  const runSh = join(ctx.serviceHome, 'updater', 'run.sh');
  const mode = statSync(runSh).mode & 0o777;
  expect(mode & 0o100).toBe(0o100);
  expect(mode).toBe(0o700);
  const script = readFileSync(runSh, 'utf8');
  expect(script.startsWith('#!/bin/sh\n')).toBe(true);
  expect(script).toContain('SCK_SERVICE_HOME=');
  expect(script).toContain(ctx.serviceHome);
  expect(script).toContain(process.execPath);
  expect(script).toContain(installed);

  expect(existsSync(join(ctx.home, 'Library', 'LaunchAgents', 'org.surrealck.node-updater.plist'))).toBe(false);
});

test('run.sh 非终端运行时把输出追加到 logs/node-updater.log（systemd 没有自己的日志文件）', () => {
  expect(run(installArgs()).status).toBe(0);
  const runSh = join(ctx.serviceHome, 'updater', 'run.sh');
  const piped = spawnSync('sh', [runSh], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: ctx.home, TMPDIR: ctx.tmp },
  });
  expect(piped.status).toBe(0);
  expect(readFileSync(join(ctx.serviceHome, 'logs', 'node-updater.log'), 'utf8')).toContain('fixture node-updater');
});

test('清单 sha256 或 bytes 与文件不符时失败且不安装 bundle', () => {
  writeManifest(ctx.fixture, { updater: { name: 'node-updater.js', sha256: 'c'.repeat(64), bytes: BUNDLE_TEXT.length } });
  const badSha = run(installArgs());
  expect(badSha.status).not.toBe(0);
  expect(existsSync(join(ctx.serviceHome, 'updater', 'node-updater.js'))).toBe(false);

  writeManifest(ctx.fixture, {
    updater: { name: 'node-updater.js', sha256: sha256(BUNDLE_TEXT), bytes: BUNDLE_TEXT.length + 1 },
  });
  const badBytes = run(installArgs());
  expect(badBytes.status).not.toBe(0);
  expect(existsSync(join(ctx.serviceHome, 'updater', 'node-updater.js'))).toBe(false);
});

test('清单缺字段或 product 不是 sck-company 时失败', () => {
  writeManifest(ctx.fixture, {}, ['sha']);
  const missing = run(installArgs());
  expect(missing.status).not.toBe(0);
  expect(existsSync(join(ctx.serviceHome, 'updater', 'node-updater.js'))).toBe(false);

  writeManifest(ctx.fixture, { product: 'other-product' });
  const wrongProduct = run(installArgs());
  expect(wrongProduct.status).not.toBe(0);
  expect(existsSync(join(ctx.serviceHome, 'updater', 'node-updater.js'))).toBe(false);

  writeManifest(ctx.fixture, { format: 2 });
  const wrongFormat = run(installArgs());
  expect(wrongFormat.status).not.toBe(0);
});

test.skipIf(process.platform !== 'darwin')('darwin 下 --no-load 不写入 LaunchAgents', () => {
  const res = run(installArgs());
  expect(res.status).toBe(0);
  expect(existsSync(join(ctx.home, 'Library', 'LaunchAgents', 'org.surrealck.node-updater.plist'))).toBe(false);
});

test('无参数或未知参数打印用法并以非 0 退出', () => {
  const none = run([]);
  expect(none.status).not.toBe(0);
  expect(none.output).toContain('用法');

  const unknown = run(['bogus']);
  expect(unknown.status).not.toBe(0);
  expect(unknown.output).toContain('用法');

  const badFlag = run(['install', '--bogus']);
  expect(badFlag.status).not.toBe(0);
  expect(badFlag.output).toContain('用法');
});

test('node 版本低于 22 时 install 失败', () => {
  const oldNode = join(ctx.tmp, 'old-node');
  writeFileSync(oldNode, '#!/bin/sh\necho v20.0.0\n');
  chmodSync(oldNode, 0o755);
  const res = run(installArgs(), { SCK_NODE_BIN: oldNode });
  expect(res.status).not.toBe(0);
  expect(res.output).toContain('版本过低');
  expect(existsSync(join(ctx.serviceHome, 'updater', 'node-updater.js'))).toBe(false);
});

test('脚本里紧跟非 ASCII 字符的变量都用花括号（macOS 的 bash 3.2 在 UTF-8 locale 下会把多字节首字节并入变量名）', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  const offenders = text.split('\n')
    .map((line, i) => ({ line: i + 1, text: line }))
    .filter(({ text: line }) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line));
  expect(offenders).toEqual([]);
});

test('UTF-8 locale 下 /bin/sh 对加花括号的变量正常展开（未加花括号时 macOS bash 3.2 报 unbound variable）', () => {
  const env = { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' };
  delete (env as Record<string, string | undefined>).LC_ALL;
  const run = spawnSync('/bin/sh', ['-c', 'set -u; release_repo=o/r; echo "从（${release_repo}）"'], { env, encoding: 'utf8' });
  expect(run.status).toBe(0);
  expect(run.stdout.trim()).toBe('从（o/r）');
});
