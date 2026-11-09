// 节点更新器核心的流程测试：临时 home、真实 tar 包、假的发行源 / 插件控制 / 打包工具 / 云端。
// 不读写真实服务目录，不调用 paseo / launchctl / systemctl。
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeUpgradeStatus } from '../src/node-release.ts';
import {
  runNodeUpdate,
  type NodeCloud,
  type PackageTools,
  type PluginControl,
  type PluginRegistration,
  type ReleaseRef,
  type ReleaseSource,
  type UpdateOutcome,
  type UpdaterDeps,
} from '../src/node-updater.ts';
import { MANIFEST_ASSET, packageAssetName, sha256File, UPDATER_ASSET } from '../src/release-manifest.ts';

const NOW = new Date('2026-05-01T00:00:00.000Z');
const SHA_OLD = 'c'.repeat(40);
const SHA_NEW = 'a'.repeat(40);
const SHA_EXTRA = 'd'.repeat(40);
const SHA_ACTIVE = 'e'.repeat(40);
const SHA_SNAPSHOT = 'b'.repeat(40);
const SCHEMA = 61;

let sourceRoot: string;
const trash: string[] = [];

beforeAll(() => {
  sourceRoot = mkdtempSync(join(tmpdir(), 'sck-node-updater-src-'));
});

afterEach(() => {
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(sourceRoot, { recursive: true, force: true });
});

interface Fixture {
  dir: string;
  version: string;
  sha: string;
  packageName: string;
  updaterText: string;
}

interface FixtureOptions {
  version?: string;
  sha?: string;
  /** 包内 release.json 的内容；缺省与清单一致。 */
  releaseJson?: Record<string, unknown>;
  /** 对清单对象做修改。 */
  patchManifest?: (manifest: Record<string, unknown>) => Record<string, unknown>;
  /** 原样写入清单文件（用于非法 JSON）。 */
  manifestText?: string;
  updaterText?: string;
}

/** 生成一套发行资产：真实 tar.gz 包、更新器文件与清单，sha256 与大小都按实际内容计算。 */
async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const version = options.version ?? '0.6.0';
  const sha = options.sha ?? SHA_NEW;
  const dir = mkdtempSync(join(sourceRoot, 'rel-'));
  const stage = join(dir, 'stage');
  mkdirSync(join(stage, 'plugin'), { recursive: true });
  writeFileSync(join(stage, 'plugin', 'package.json'), JSON.stringify({ name: 'sck-company', version }));
  writeFileSync(join(stage, 'plugin', 'paseo-plugin.json'), JSON.stringify({ id: 'sck-company' }));
  writeFileSync(join(stage, 'plugin', 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(stage, 'release.json'), JSON.stringify(
    options.releaseJson ?? { product: 'sck-company', version, sha, requiredSchema: SCHEMA }, null, 2));
  const packageName = packageAssetName(version);
  execFileSync('tar', ['-czf', join(dir, packageName), '-C', stage, 'release.json', 'plugin'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const updaterText = options.updaterText ?? `// node updater ${version} ${sha}\n`;
  writeFileSync(join(dir, UPDATER_ASSET), updaterText);
  const pkg = await sha256File(join(dir, packageName));
  const upd = await sha256File(join(dir, UPDATER_ASSET));
  const manifest: Record<string, unknown> = {
    format: 1,
    product: 'sck-company',
    version,
    sha,
    requiredSchema: SCHEMA,
    createdAt: '2026-05-01T00:00:00Z',
    package: { name: packageName, sha256: pkg.sha256, bytes: pkg.bytes },
    updater: { name: UPDATER_ASSET, sha256: upd.sha256, bytes: upd.bytes },
  };
  const patched = options.patchManifest ? options.patchManifest(manifest) : manifest;
  writeFileSync(join(dir, MANIFEST_ASSET), options.manifestText ?? JSON.stringify(patched));
  return { dir, version, sha, packageName, updaterText };
}

/** 假发行源：publish 之后 latestTag 返回 v<version>，download 从 fixture 目录复制，并记录每次下载。 */
class FakeRelease implements ReleaseSource {
  tag: string | undefined;
  dir = '';
  downloads: string[] = [];

  publish(fixture: Fixture): void {
    this.dir = fixture.dir;
    this.tag = `v${fixture.version}`;
  }

  async latestTag(): Promise<string | undefined> {
    return this.tag;
  }

  async download(tag: string, asset: string, dest: string): Promise<void> {
    if (tag !== this.tag) throw new Error(`找不到发行标签 ${tag}`);
    this.downloads.push(asset);
    copyFileSync(join(this.dir, asset), dest);
  }

  count(asset: string): number {
    return this.downloads.filter(name => name === asset).length;
  }
}

/** 假插件控制：维护注册；install 之后的状态由 statusFor 决定，默认 running。 */
class FakePlugin implements PluginControl {
  reg: PluginRegistration | undefined;
  calls: string[] = [];
  statusFor: (dir: string) => string = () => 'running';

  async registration(): Promise<PluginRegistration | undefined> {
    return this.reg === undefined ? undefined : { ...this.reg };
  }

  async remove(): Promise<void> {
    this.calls.push('remove');
    this.reg = undefined;
  }

  async install(dir: string): Promise<void> {
    this.calls.push(`install:${dir}`);
    this.reg = { path: dir, status: this.statusFor(dir), enabled: true };
  }
}

/** 假打包工具：extract 用真实 tar；installProd 只写一个标记文件。 */
class FakeTools implements PackageTools {
  installs: string[] = [];
  /** 为 true 时模拟安装中途失败：留下半装的 node_modules 后抛错。 */
  failInstall = false;

  async extract(tgzFile: string, destDir: string): Promise<void> {
    execFileSync('tar', ['-xzf', tgzFile, '-C', destDir]);
  }

  async installProd(pluginDir: string): Promise<void> {
    this.installs.push(pluginDir);
    mkdirSync(join(pluginDir, 'node_modules'), { recursive: true });
    if (this.failInstall) throw new Error('pnpm 安装失败');
    writeFileSync(join(pluginDir, 'node_modules', '.fake'), 'installed\n');
  }
}

interface UpgradeCall { status: NodeUpgradeStatus; target?: ReleaseRef; at: Date; error?: string }
interface RollbackCall { from: ReleaseRef; to: ReleaseRef; at: Date; reason: string; outcome: 'rolled_back' | 'rollback_failed' }

/** 假云端：记录所有调用；schemaFailAt 为第 n 次 verifySchema（从 1 计）抛错。 */
class FakeCloud implements NodeCloud {
  leases = 0;
  leaseThrows = false;
  touchThrows = false;
  schemaCalls: string[] = [];
  schemaFailAt = new Set<number>();
  touches: Date[] = [];
  upgrades: UpgradeCall[] = [];
  rollbacks: RollbackCall[] = [];

  async activeLeaseCount(): Promise<number> {
    if (this.leaseThrows) throw new Error('租约查询超时');
    return this.leases;
  }

  async verifySchema(version: string): Promise<void> {
    this.schemaCalls.push(version);
    if (this.schemaFailAt.has(this.schemaCalls.length)) throw new Error('库内 schema 版本低于要求');
  }

  async touchCheck(at: Date): Promise<void> {
    if (this.touchThrows) throw new Error('检查时间写入失败');
    this.touches.push(at);
  }

  async recordUpgrade(r: UpgradeCall): Promise<void> {
    this.upgrades.push(r);
  }

  async recordRollback(r: RollbackCall): Promise<void> {
    this.rollbacks.push(r);
  }
}

interface Harness {
  home: string;
  release: FakeRelease;
  plugin: FakePlugin;
  tools: FakeTools;
  cloud: FakeCloud;
  logs: string[];
  deps: UpdaterDeps;
}

function harness(): Harness {
  const home = mkdtempSync(join(tmpdir(), 'sck-node-updater-home-'));
  trash.push(home);
  const release = new FakeRelease();
  const plugin = new FakePlugin();
  const tools = new FakeTools();
  const cloud = new FakeCloud();
  const logs: string[] = [];
  const deps: UpdaterDeps = {
    home,
    release,
    plugin,
    tools,
    cloud,
    now: () => new Date(NOW),
    sleep: async () => {},
    log: line => logs.push(line),
    waitRunningMs: 20,
    pollMs: 5,
  };
  return { home, release, plugin, tools, cloud, logs, deps };
}

/** 写入一个带 release.json 的发行目录（只含插件的 package.json），返回插件目录。 */
function makeReleaseDir(home: string, sha: string, version: string): string {
  const dir = join(home, 'plugin-releases', sha);
  mkdirSync(join(dir, 'plugin'), { recursive: true });
  writeFileSync(join(dir, 'release.json'), JSON.stringify({ product: 'sck-company', version, sha, requiredSchema: SCHEMA }));
  writeFileSync(join(dir, 'plugin', 'package.json'), JSON.stringify({ name: 'sck-company', version }));
  return join(dir, 'plugin');
}

/** 把现役版本登记为插件（status running），返回其插件目录。 */
function installCurrent(h: Harness, version: string, sha: string): string {
  const plugin = makeReleaseDir(h.home, sha, version);
  h.plugin.reg = { path: plugin, status: 'running', enabled: true };
  return plugin;
}

function reasonOf(outcome: UpdateOutcome): string {
  return 'reason' in outcome ? outcome.reason : '';
}

function pluginReleasesDir(h: Harness): string {
  return join(h.home, 'plugin-releases');
}

describe('清单与包校验', () => {
  test('1) 清单 sha256 与包不符：拒绝，不切换，不建发行目录', async () => {
    const h = harness();
    const f = await buildFixture({
      patchManifest: m => ({ ...m, package: { ...(m.package as object), sha256: '0'.repeat(64) } }),
    });
    h.release.publish(f);
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('refused');
    expect(reasonOf(out)).toContain('sha256');
    expect(h.cloud.upgrades).toEqual([expect.objectContaining({ status: 'refused' })]);
    expect(h.plugin.calls).toEqual([]);
    expect(existsSync(join(pluginReleasesDir(h), SHA_NEW))).toBe(false);
  });

  test('11) 包内 release.json 与清单不一致：拒绝，未切换', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    const f = await buildFixture({
      releaseJson: { product: 'sck-company', version: '0.6.0', sha: 'f'.repeat(40), requiredSchema: SCHEMA },
    });
    h.release.publish(f);
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('refused');
    expect(reasonOf(out)).toContain('release.json');
    expect(h.plugin.calls).toEqual([]);
    expect(existsSync(join(pluginReleasesDir(h), SHA_NEW))).toBe(false);
  });

  test('13a) 清单不是合法 JSON：拒绝', async () => {
    const h = harness();
    const f = await buildFixture({ manifestText: '{not json' });
    h.release.publish(f);
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('refused');
    expect(reasonOf(out)).toContain('发行清单解析失败');
    expect(h.plugin.calls).toEqual([]);
  });

  test('13b) 清单含多余字段：拒绝', async () => {
    const h = harness();
    const f = await buildFixture({ patchManifest: m => ({ ...m, extra: 1 }) });
    h.release.publish(f);
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('refused');
    expect(reasonOf(out)).toContain('发行清单解析失败');
    expect(h.plugin.calls).toEqual([]);
  });

  test('标签与清单版本不一致：拒绝', async () => {
    const h = harness();
    const f = await buildFixture();
    h.release.publish(f);
    h.release.tag = 'v9.9.9';
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('refused');
    expect(reasonOf(out)).toContain('v9.9.9');
  });
});

describe('租约与锁', () => {
  test('2) 有租约：暂缓，保留发行目录；下一轮无租约时切换，包不被重复下载', async () => {
    const h = harness();
    const oldPlugin = installCurrent(h, '0.5.0', SHA_OLD);
    const f = await buildFixture();
    h.release.publish(f);

    h.cloud.leases = 1;
    const first = await runNodeUpdate(h.deps);
    expect(first.kind).toBe('deferred');
    expect(h.cloud.upgrades).toEqual([]);
    expect(h.plugin.calls).toEqual([]);
    expect(existsSync(join(pluginReleasesDir(h), SHA_NEW, 'release.json'))).toBe(true);
    expect(readdirSync(pluginReleasesDir(h)).filter(name => name.startsWith('.staging-'))).toEqual([]);
    expect(h.release.count(f.packageName)).toBe(1);

    h.cloud.leases = 0;
    const second = await runNodeUpdate(h.deps);
    expect(second).toEqual({ kind: 'ok', version: '0.6.0', sha: SHA_NEW });
    expect(h.release.count(f.packageName)).toBe(1);
    expect(h.plugin.calls).toEqual(['remove', `install:${join(pluginReleasesDir(h), SHA_NEW, 'plugin')}`]);
    expect(oldPlugin).toBe(join(pluginReleasesDir(h), SHA_OLD, 'plugin'));
  });

  test('租约查询抛错：暂缓，未切换', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    h.release.publish(await buildFixture());
    h.cloud.leaseThrows = true;
    const out = await runNodeUpdate(h.deps);
    expect(out).toEqual({ kind: 'deferred', reason: '无法确认本节点租约，未切换' });
    expect(h.plugin.calls).toEqual([]);
  });

  test('12) 锁被存活进程占用：暂缓，且不删除别人的锁', async () => {
    const h = harness();
    h.release.publish(await buildFixture());
    mkdirSync(join(h.home, 'updater'), { recursive: true });
    const lock = join(h.home, 'updater', 'lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: NOW.toISOString() }));
    const out = await runNodeUpdate(h.deps);
    expect(out).toEqual({ kind: 'deferred', reason: '另一轮更新正在进行' });
    expect(existsSync(lock)).toBe(true);
    expect(h.release.downloads).toEqual([]);
    expect(h.plugin.calls).toEqual([]);
  });

  test('持有者已不存在的陈旧锁被接管，并在结束后删除', async () => {
    const h = harness();
    mkdirSync(join(h.home, 'updater'), { recursive: true });
    const lock = join(h.home, 'updater', 'lock');
    writeFileSync(lock, JSON.stringify({ pid: 2_147_483_646, at: NOW.toISOString() }));
    h.release.tag = undefined;
    const out = await runNodeUpdate(h.deps);
    expect(out).toEqual({ kind: 'no_release' });
    expect(existsSync(lock)).toBe(false);
  });
});

describe('切换与回退', () => {
  test('3) 切换后核验失败：回退到旧注册路径，记录 rolled_back 的回退与升级各一次', async () => {
    const h = harness();
    const oldPlugin = installCurrent(h, '0.5.0', SHA_OLD);
    h.release.publish(await buildFixture());
    h.cloud.schemaFailAt = new Set([2]);
    const newPlugin = join(pluginReleasesDir(h), SHA_NEW, 'plugin');

    const out = await runNodeUpdate(h.deps);
    expect(out).toEqual({
      kind: 'rolled_back', reason: '库内 schema 版本低于要求', version: '0.6.0', sha: SHA_NEW,
    });
    expect(h.plugin.calls).toEqual(['remove', `install:${newPlugin}`, 'remove', `install:${oldPlugin}`]);
    expect(h.plugin.reg?.path).toBe(oldPlugin);
    expect(h.cloud.rollbacks).toHaveLength(1);
    expect(h.cloud.rollbacks[0]).toMatchObject({
      outcome: 'rolled_back',
      from: { version: '0.6.0', sha: SHA_NEW },
      to: { version: '0.5.0', sha: SHA_OLD },
    });
    expect(h.cloud.upgrades).toHaveLength(1);
    expect(h.cloud.upgrades[0]).toMatchObject({ status: 'rolled_back', target: { version: '0.6.0', sha: SHA_NEW } });
  });

  test('4) 回退也失败（旧路径启动后不是 running）：rollback_failed，记录 rollback_failed', async () => {
    const h = harness();
    const oldPlugin = installCurrent(h, '0.5.0', SHA_OLD);
    h.plugin.statusFor = dir => (dir === oldPlugin ? 'error' : 'running');
    h.release.publish(await buildFixture());
    h.cloud.schemaFailAt = new Set([2]);

    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('rollback_failed');
    expect(reasonOf(out)).toContain('库内 schema 版本低于要求');
    expect(reasonOf(out)).toContain('回退也失败');
    expect(h.cloud.rollbacks).toHaveLength(1);
    expect(h.cloud.rollbacks[0]!.outcome).toBe('rollback_failed');
    expect(h.cloud.upgrades).toHaveLength(1);
    expect(h.cloud.upgrades[0]!.status).toBe('rollback_failed');
  });

  test('6) 首次安装（无注册）切换后失败：停掉新插件，failed，记录 failed', async () => {
    const h = harness();
    h.release.publish(await buildFixture());
    h.cloud.schemaFailAt = new Set([2]);
    const newPlugin = join(pluginReleasesDir(h), SHA_NEW, 'plugin');

    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('failed');
    expect(h.plugin.calls).toEqual([`install:${newPlugin}`, 'remove']);
    expect(h.plugin.reg).toBeUndefined();
    expect(h.cloud.rollbacks).toEqual([]);
    expect(h.cloud.upgrades).toHaveLength(1);
    expect(h.cloud.upgrades[0]).toMatchObject({ status: 'failed', target: { version: '0.6.0', sha: SHA_NEW } });
  });

  test('切换后插件未进入 running：回退到旧注册路径，记录 rolled_back', async () => {
    const h = harness();
    const oldPlugin = installCurrent(h, '0.5.0', SHA_OLD);
    const newPlugin = join(pluginReleasesDir(h), SHA_NEW, 'plugin');
    h.plugin.statusFor = dir => (dir === newPlugin ? 'error' : 'running');
    h.release.publish(await buildFixture());

    const out = await runNodeUpdate(h.deps);
    expect(out).toMatchObject({ kind: 'rolled_back', version: '0.6.0', sha: SHA_NEW });
    expect(reasonOf(out)).toContain('插件未在');
    expect(h.plugin.calls).toEqual(['remove', `install:${newPlugin}`, 'remove', `install:${oldPlugin}`]);
    expect(h.plugin.reg?.path).toBe(oldPlugin);
    expect(h.cloud.upgrades[0]).toMatchObject({ status: 'rolled_back' });
  });

  test('安装依赖失败：删除半装的发行目录，记录 failed；下一轮重新准备并成功', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    h.release.publish(await buildFixture());
    h.tools.failInstall = true;

    const first = await runNodeUpdate(h.deps);
    expect(first.kind).toBe('failed');
    expect(reasonOf(first)).toContain('安装插件依赖失败');
    expect(existsSync(join(pluginReleasesDir(h), SHA_NEW))).toBe(false);
    expect(h.plugin.calls).toEqual([]);
    expect(h.cloud.upgrades).toEqual([expect.objectContaining({ status: 'failed' })]);

    h.tools.failInstall = false;
    expect(await runNodeUpdate(h.deps)).toEqual({ kind: 'ok', version: '0.6.0', sha: SHA_NEW });
  });

  test('回退后同一版本 24 小时内暂缓，超过后再次尝试', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    h.release.publish(await buildFixture());
    h.cloud.schemaFailAt = new Set([2]);
    expect((await runNodeUpdate(h.deps)).kind).toBe('rolled_back');
    const callsAfterRollback = h.plugin.calls.length;

    const soon = await runNodeUpdate(h.deps);
    expect(soon.kind).toBe('deferred');
    expect(reasonOf(soon)).toContain('24 小时内暂缓');
    expect(h.plugin.calls).toHaveLength(callsAfterRollback);

    h.deps.now = () => new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    h.cloud.schemaFailAt = new Set();
    expect(await runNodeUpdate(h.deps)).toEqual({ kind: 'ok', version: '0.6.0', sha: SHA_NEW });
    expect(h.plugin.reg?.path).toBe(join(pluginReleasesDir(h), SHA_NEW, 'plugin'));
    expect(existsSync(join(h.home, 'updater', 'rolled-back.json'))).toBe(false);
  });

  test('成功：ok，记录带 target 的升级，更新器替换，回收旧目录但保留回退目标、快照与 active 目录', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    makeReleaseDir(h.home, SHA_EXTRA, '0.4.0');
    const snapshot = join(h.home, 'releases', SHA_SNAPSHOT);
    mkdirSync(join(snapshot, 'plugin'), { recursive: true });
    const activeDir = makeReleaseDir(h.home, SHA_ACTIVE, '0.3.0');
    symlinkSync(activeDir, join(h.home, 'active'));
    const f = await buildFixture({ updaterText: '// node updater 0.6.0 new\n' });
    h.release.publish(f);

    const out = await runNodeUpdate(h.deps);
    expect(out).toEqual({ kind: 'ok', version: '0.6.0', sha: SHA_NEW });
    expect(h.cloud.upgrades).toHaveLength(1);
    expect(h.cloud.upgrades[0]).toMatchObject({ status: 'ok', target: { version: '0.6.0', sha: SHA_NEW } });
    expect(h.cloud.upgrades[0]!.at.getTime()).toBe(NOW.getTime());

    expect(readFileSync(join(h.home, 'updater', UPDATER_ASSET), 'utf8')).toBe(f.updaterText);
    expect(statSync(join(h.home, 'updater', UPDATER_ASSET)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(pluginReleasesDir(h), SHA_EXTRA))).toBe(false);
    expect(existsSync(join(pluginReleasesDir(h), SHA_OLD, 'release.json'))).toBe(true);
    expect(existsSync(join(pluginReleasesDir(h), SHA_NEW, 'release.json'))).toBe(true);
    expect(existsSync(snapshot)).toBe(true);
    expect(existsSync(activeDir)).toBe(true);
    expect(existsSync(join(h.home, 'updater', 'lock'))).toBe(false);
    expect(readdirSync(pluginReleasesDir(h)).filter(name => name.startsWith('.staging-'))).toEqual([]);
  });

  test('MCP 快照与插件发行包来自同一提交：快照原样保留，插件装进 plugin-releases', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    // 手动切换 MCP 时快照目录是 releases/<提交>，内容是整棵源码树，没有 release.json。
    const snapshot = join(h.home, 'releases', SHA_NEW);
    mkdirSync(join(snapshot, 'src', 'mcp'), { recursive: true });
    writeFileSync(join(snapshot, 'src', 'mcp', 'run.ts'), '// mcp snapshot\n');
    h.release.publish(await buildFixture());
    expect(await runNodeUpdate(h.deps)).toEqual({ kind: 'ok', version: '0.6.0', sha: SHA_NEW });
    expect(readFileSync(join(snapshot, 'src', 'mcp', 'run.ts'), 'utf8')).toBe('// mcp snapshot\n');
    expect(existsSync(join(snapshot, 'release.json'))).toBe(false);
    expect(h.plugin.reg?.path).toBe(join(pluginReleasesDir(h), SHA_NEW, 'plugin'));
    expect(existsSync(join(pluginReleasesDir(h), SHA_NEW, 'release.json'))).toBe(true);
  });

  test('已安装依赖的发行目录被复用时，更新器仍按清单校验后替换', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    const f = await buildFixture({ updaterText: '// node updater reuse\n' });
    h.release.publish(f);
    h.cloud.leases = 1;
    expect((await runNodeUpdate(h.deps)).kind).toBe('deferred');
    h.cloud.leases = 0;
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('ok');
    expect(readFileSync(join(h.home, 'updater', UPDATER_ASSET), 'utf8')).toBe('// node updater reuse\n');
  });
});

describe('版本与状态门禁', () => {
  test('7) 注册在服务目录之外：拒绝，未切换', async () => {
    const h = harness();
    const outside = mkdtempSync(join(tmpdir(), 'sck-node-updater-outside-'));
    trash.push(outside);
    const plugin = join(outside, 'plugin');
    mkdirSync(plugin, { recursive: true });
    h.plugin.reg = { path: plugin, status: 'running', enabled: true };
    h.release.publish(await buildFixture());
    const out = await runNodeUpdate(h.deps);
    expect(out).toEqual({ kind: 'refused', reason: '插件注册在服务目录之外，未切换' });
    expect(h.plugin.calls).toEqual([]);
    expect(existsSync(join(pluginReleasesDir(h), SHA_NEW))).toBe(false);
  });

  test('8a) 同版本不同 sha：拒绝（不降级）', async () => {
    const h = harness();
    installCurrent(h, '0.6.0', SHA_OLD);
    h.release.publish(await buildFixture({ version: '0.6.0', sha: SHA_NEW }));
    const out = await runNodeUpdate(h.deps);
    expect(out).toEqual({ kind: 'refused', reason: '清单版本不高于现役版本，不降级' });
    expect(h.plugin.calls).toEqual([]);
  });

  test('8b) 清单版本低于现役版本：拒绝（不降级）', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    h.release.publish(await buildFixture({ version: '0.4.0', sha: SHA_NEW }));
    const out = await runNodeUpdate(h.deps);
    expect(out).toEqual({ kind: 'refused', reason: '清单版本不高于现役版本，不降级' });
    expect(h.plugin.calls).toEqual([]);
  });

  test('9) 已是最新（sha 相同）：current，并写入检查时间', async () => {
    const h = harness();
    installCurrent(h, '0.6.0', SHA_NEW);
    h.release.publish(await buildFixture());
    const out = await runNodeUpdate(h.deps);
    expect(out).toEqual({ kind: 'current', version: '0.6.0', sha: SHA_NEW });
    expect(h.cloud.touches.length).toBeGreaterThan(0);
    expect(h.plugin.calls).toEqual([]);
  });

  test('已是最新版本但节点更新器文件过旧：只替换更新器，不切换插件', async () => {
    const h = harness();
    installCurrent(h, '0.6.0', SHA_NEW);
    const f = await buildFixture({ updaterText: '// node updater 0.6.0 aligned\n' });
    h.release.publish(f);
    mkdirSync(join(h.home, 'updater'), { recursive: true });
    writeFileSync(join(h.home, 'updater', UPDATER_ASSET), '// stale\n');

    const out = await runNodeUpdate(h.deps);
    expect(out).toEqual({ kind: 'current', version: '0.6.0', sha: SHA_NEW });
    expect(h.plugin.calls).toEqual([]);
    expect(readFileSync(join(h.home, 'updater', UPDATER_ASSET), 'utf8')).toBe(f.updaterText);
  });

  test('10) 没有正式 Release：no_release，不下载', async () => {
    const h = harness();
    h.release.tag = undefined;
    const out = await runNodeUpdate(h.deps);
    expect(out).toEqual({ kind: 'no_release' });
    expect(h.release.downloads).toEqual([]);
  });
});

describe('检查时间与时间戳', () => {
  test('14) 每轮开始都写检查时间，且升级记录的时间取自 now()', async () => {
    const h = harness();
    h.release.tag = undefined;
    await runNodeUpdate(h.deps);
    expect(h.cloud.touches).toHaveLength(1);
    expect(h.cloud.touches[0]!.getTime()).toBe(NOW.getTime());

    h.release.publish(await buildFixture());
    h.release.tag = 'v9.9.9';
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('refused');
    expect(h.cloud.touches).toHaveLength(2);
  });

  test('检查时间写入失败只记日志，不影响结果', async () => {
    const h = harness();
    h.cloud.touchThrows = true;
    h.release.tag = undefined;
    const out = await runNodeUpdate(h.deps);
    expect(out).toEqual({ kind: 'no_release' });
    expect(h.logs.some(line => line.includes('检查时间写入失败'))).toBe(true);
  });
});
