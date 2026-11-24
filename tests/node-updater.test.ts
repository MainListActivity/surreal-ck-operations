// 节点自更新核心的流程测试：临时 home、真实 tar 包、假的发行源 / 打包工具 / 云端。
// 不读写真实服务目录，不调用 launchctl / systemctl。
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeUpgradeStatus } from '../src/node-release.ts';
import {
  awaitingConfirmation,
  confirmSwitch,
  runNodeUpdate,
  settlePending,
  type NodeCloud,
  type PackageTools,
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
const SHA_THIRD = '9'.repeat(40);
const SCHEMA = 61;
const SCK_V1 = '# sck v1\n';
const SCK_V2 = '# sck v2\n';
const BUN_V1 = '# bun-runtime v1\n';
const BUN_V2 = '# bun-runtime v2\n';
const SCK_PREVIOUS = '# sck previous\n';

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
  /** 发行包内 scripts/ 下的工具脚本（文件名 -> 内容）；缺省则包内不含 scripts/。 */
  scripts?: Record<string, string>;
  /** 发行包内运行目录名，缺省 plugin。 */
  payload?: 'plugin' | 'runtime';
  /** 清单不带旧定时更新器资产。 */
  omitUpdater?: boolean;
}

/** 生成一套发行资产：真实 tar.gz 包、更新器文件与清单，sha256 与大小都按实际内容计算。 */
async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const version = options.version ?? '0.6.0';
  const sha = options.sha ?? SHA_NEW;
  const dir = mkdtempSync(join(sourceRoot, 'rel-'));
  const stage = join(dir, 'stage');
  const payload = options.payload ?? 'plugin';
  mkdirSync(join(stage, payload), { recursive: true });
  writeFileSync(join(stage, payload, 'package.json'), JSON.stringify({ name: 'sck-company', version }));
  writeFileSync(join(stage, payload, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(stage, 'release.json'), JSON.stringify(
    options.releaseJson ?? { product: 'sck-company', version, sha, requiredSchema: SCHEMA }, null, 2));
  const packageName = packageAssetName(version);
  const tarArgs = ['-czf', join(dir, packageName), '-C', stage, 'release.json', payload];
  if (options.scripts) {
    mkdirSync(join(stage, 'scripts'), { recursive: true });
    for (const [name, text] of Object.entries(options.scripts)) writeFileSync(join(stage, 'scripts', name), text);
    tarArgs.push('scripts');
  }
  execFileSync('tar', tarArgs, {
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
  if (options.omitUpdater) delete manifest.updater;
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
  tools: FakeTools;
  busy: boolean;
  cloud: FakeCloud;
  logs: string[];
  deps: UpdaterDeps;
  clock: number;
}

function harness(): Harness {
  const home = mkdtempSync(join(tmpdir(), 'sck-node-updater-home-'));
  trash.push(home);
  const release = new FakeRelease();
  const tools = new FakeTools();
  const cloud = new FakeCloud();
  const logs: string[] = [];
  const h = { home, release, tools, cloud, logs, busy: false, clock: NOW.getTime() } as Harness & { clock: number };
  h.deps = {
    home,
    release,
    tools,
    cloud,
    idle: async () => !h.busy,
    now: () => new Date(h.clock),
    log: line => logs.push(line),
  };
  return h;
}

/** 写入一个带 release.json 的发行目录（只含插件的 package.json），返回插件目录。 */
function makeReleaseDir(home: string, sha: string, version: string): string {
  const dir = join(home, 'plugin-releases', sha);
  mkdirSync(join(dir, 'plugin'), { recursive: true });
  writeFileSync(join(dir, 'release.json'), JSON.stringify({ product: 'sck-company', version, sha, requiredSchema: SCHEMA }));
  writeFileSync(join(dir, 'plugin', 'package.json'), JSON.stringify({ name: 'sck-company', version }));
  return join(dir, 'plugin');
}

/** 把现役版本设为 current（符号链接），返回其运行目录。 */
function installCurrent(h: Harness, version: string, sha: string): string {
  const plugin = makeReleaseDir(h.home, sha, version);
  rmSync(join(h.home, 'current'), { force: true });
  symlinkSync(plugin, join(h.home, 'current'));
  return plugin;
}

function currentReal(h: Harness): string {
  return realpathSync(join(h.home, 'current'));
}

function reasonOf(outcome: UpdateOutcome): string {
  return 'reason' in outcome ? outcome.reason : '';
}

function pluginReleasesDir(h: Harness): string {
  return join(h.home, 'plugin-releases');
}

/** 在发行目录下写入 scripts/ 里的工具脚本。 */
function writeScripts(releaseDir: string, scripts: Record<string, string>): void {
  mkdirSync(join(releaseDir, 'scripts'), { recursive: true });
  for (const [name, text] of Object.entries(scripts)) writeFileSync(join(releaseDir, 'scripts', name), text);
}

function binFile(h: Harness, name: string): string {
  return join(h.home, 'bin', name);
}

function pendingLines(h: Harness): string[] {
  return readFileSync(join(h.home, 'updater', 'pending'), 'utf8').split('\n');
}

function settleDeps(h: Harness) {
  return { home: h.home, cloud: h.cloud, now: () => new Date(h.clock), log: (line: string) => h.logs.push(line) };
}

/** 发布并跑一轮，期望切换成功。 */
async function switchTo(h: Harness, fixture: Fixture): Promise<void> {
  h.release.publish(fixture);
  expect(await runNodeUpdate(h.deps)).toEqual({ kind: 'switched', version: fixture.version, sha: fixture.sha });
}

describe('清单与包校验', () => {
  test('清单 sha256 与包不符：拒绝，不切换，不建发行目录', async () => {
    const h = harness();
    const old = installCurrent(h, '0.5.0', SHA_OLD);
    const f = await buildFixture({ patchManifest: m => ({ ...m, package: { ...(m.package as object), sha256: 'f'.repeat(64) } }) });
    h.release.publish(f);
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('refused');
    expect(reasonOf(out)).toContain('sha256');
    expect(h.cloud.upgrades).toEqual([expect.objectContaining({ status: 'refused' })]);
    expect(currentReal(h)).toBe(realpathSync(old));
    expect(existsSync(join(pluginReleasesDir(h), SHA_NEW))).toBe(false);
  });

  test('包内 release.json 与清单不一致：拒绝，未切换', async () => {
    const h = harness();
    const old = installCurrent(h, '0.5.0', SHA_OLD);
    h.release.publish(await buildFixture({ releaseJson: { product: 'sck-company', version: '0.6.0', sha: SHA_EXTRA, requiredSchema: SCHEMA } }));
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('refused');
    expect(reasonOf(out)).toContain('release.json');
    expect(currentReal(h)).toBe(realpathSync(old));
    expect(existsSync(join(pluginReleasesDir(h), SHA_NEW))).toBe(false);
  });

  test('清单不是合法 JSON 或含多余字段：拒绝', async () => {
    for (const options of [{ manifestText: '{not json' }, { patchManifest: (m: Record<string, unknown>) => ({ ...m, extra: 1 }) }]) {
      const h = harness();
      installCurrent(h, '0.5.0', SHA_OLD);
      h.release.publish(await buildFixture(options));
      const out = await runNodeUpdate(h.deps);
      expect(out.kind).toBe('refused');
      expect(reasonOf(out)).toContain('发行清单解析失败');
    }
  });

  test('标签与清单版本不一致：拒绝', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    h.release.publish(await buildFixture());
    h.release.tag = 'v9.9.9';
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('refused');
    expect(reasonOf(out)).toContain('v9.9.9');
  });

  test('清单不带旧定时更新器资产、运行目录名为 runtime：照常切换', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    const f = await buildFixture({ omitUpdater: true, payload: 'runtime' });
    await switchTo(h, f);
    expect(currentReal(h)).toBe(realpathSync(join(pluginReleasesDir(h), SHA_NEW, 'runtime')));
    expect(h.release.count(UPDATER_ASSET)).toBe(0);
    expect(h.tools.installs).toEqual([join(pluginReleasesDir(h), SHA_NEW, 'runtime')]);
  });
});

describe('空闲、租约与锁', () => {
  test('有租约：暂缓，保留发行目录；下一轮无租约时切换，包不被重复下载', async () => {
    const h = harness();
    const old = installCurrent(h, '0.5.0', SHA_OLD);
    const f = await buildFixture();
    h.release.publish(f);
    h.cloud.leases = 1;
    const first = await runNodeUpdate(h.deps);
    expect(first.kind).toBe('deferred');
    expect(h.cloud.upgrades).toEqual([]);
    expect(currentReal(h)).toBe(realpathSync(old));
    expect(existsSync(join(pluginReleasesDir(h), SHA_NEW, 'release.json'))).toBe(true);
    expect(readdirSync(pluginReleasesDir(h)).filter(name => name.startsWith('.staging-'))).toEqual([]);
    h.cloud.leases = 0;
    expect((await runNodeUpdate(h.deps)).kind).toBe('switched');
    expect(h.release.count(f.packageName)).toBe(1);
    expect(h.release.count(UPDATER_ASSET)).toBe(0);
  });

  test('执行端有运行中的会话：暂缓，不查租约也不切换', async () => {
    const h = harness();
    const old = installCurrent(h, '0.5.0', SHA_OLD);
    h.release.publish(await buildFixture());
    h.busy = true;
    expect(await runNodeUpdate(h.deps)).toEqual({ kind: 'deferred', reason: '执行端有运行中的会话，下一轮再切换' });
    expect(currentReal(h)).toBe(realpathSync(old));
    expect(h.cloud.schemaCalls).toEqual([]);
  });

  test('租约查询抛错：暂缓，未切换', async () => {
    const h = harness();
    const old = installCurrent(h, '0.5.0', SHA_OLD);
    h.release.publish(await buildFixture());
    h.cloud.leaseThrows = true;
    expect(await runNodeUpdate(h.deps)).toEqual({ kind: 'deferred', reason: '无法确认本节点租约，未切换' });
    expect(currentReal(h)).toBe(realpathSync(old));
  });

  test('锁被存活进程占用：暂缓，且不删除别人的锁', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    h.release.publish(await buildFixture());
    const lock = join(h.home, 'updater', 'lock');
    mkdirSync(join(h.home, 'updater'), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: NOW.toISOString() }));
    expect(await runNodeUpdate(h.deps)).toEqual({ kind: 'deferred', reason: '另一轮更新正在进行' });
    expect(existsSync(lock)).toBe(true);
    expect(h.release.downloads).toEqual([]);
  });

  test('持有者已不存在的陈旧锁被接管，并在结束后删除', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    h.release.publish(await buildFixture());
    const lock = join(h.home, 'updater', 'lock');
    mkdirSync(join(h.home, 'updater'), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: NOW.toISOString() }));
    expect((await runNodeUpdate(h.deps)).kind).toBe('switched');
    expect(existsSync(lock)).toBe(false);
  });
});

describe('切换与确认', () => {
  test('切换：current 原子指向新运行目录，写待确认标记，不提前记录升级成功', async () => {
    const h = harness();
    const old = installCurrent(h, '0.5.0', SHA_OLD);
    await switchTo(h, await buildFixture());
    const target = join(pluginReleasesDir(h), SHA_NEW, 'plugin');
    expect(currentReal(h)).toBe(realpathSync(target));
    expect(lstatSync(join(h.home, 'current')).isSymbolicLink()).toBe(true);
    const [to, from, meta] = pendingLines(h);
    expect(to).toBe(target);
    expect(from).toBe(realpathSync(old));
    expect(JSON.parse(meta!)).toEqual({ to: { version: '0.6.0', sha: SHA_NEW }, from: { version: '0.5.0', sha: SHA_OLD }, at: NOW.getTime() });
    expect(h.cloud.schemaCalls).toEqual(['0.6.0']);
    expect(h.cloud.upgrades).toEqual([]);
    expect(awaitingConfirmation(h.home)).toBe(true);
    // 未确认前不再切换。
    expect(await runNodeUpdate(h.deps)).toEqual({ kind: 'deferred', reason: '上一次切换尚未确认' });
  });

  test('首次安装（没有 current）：切换，待确认标记没有旧版本', async () => {
    const h = harness();
    await switchTo(h, await buildFixture());
    const [, from, meta] = pendingLines(h);
    expect(from).toBe('');
    expect(JSON.parse(meta!).from).toBeNull();
  });

  test('确认：安装 sck 工具脚本、回收旧目录但保留回退目标，记录 ok 并清除标记', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    makeReleaseDir(h.home, SHA_EXTRA, '0.4.0');
    mkdirSync(join(pluginReleasesDir(h), 'not-a-release'), { recursive: true });
    mkdirSync(join(h.home, 'bin'), { recursive: true });
    writeFileSync(binFile(h, 'sck'), SCK_PREVIOUS);
    await switchTo(h, await buildFixture({ scripts: { 'sck.sh': SCK_V2, 'bun-runtime.sh': BUN_V2 } }));
    expect(await settlePending(settleDeps(h))).toEqual({ kind: 'confirming', to: { version: '0.6.0', sha: SHA_NEW }, from: { version: '0.5.0', sha: SHA_OLD } });
    expect(await confirmSwitch(settleDeps(h))).toBe('confirmed');
    expect(readFileSync(binFile(h, 'sck'), 'utf8')).toBe(SCK_V2);
    expect(readFileSync(binFile(h, 'bun-runtime.sh'), 'utf8')).toBe(BUN_V2);
    expect(statSync(binFile(h, 'sck')).mode & 0o777).toBe(0o700);
    expect(readdirSync(pluginReleasesDir(h)).sort()).toEqual([SHA_NEW, SHA_OLD, 'not-a-release'].sort());
    expect(h.cloud.upgrades).toEqual([expect.objectContaining({ status: 'ok', target: { version: '0.6.0', sha: SHA_NEW } })]);
    expect(existsSync(join(h.home, 'updater', 'pending'))).toBe(false);
    expect(awaitingConfirmation(h.home)).toBe(false);
    expect(await confirmSwitch(settleDeps(h))).toBe('none');
  });

  test('确认时 schema 核验失败：current 指回旧版本，记录回退并进入 24 小时冷却，过后再试', async () => {
    const h = harness();
    const old = installCurrent(h, '0.5.0', SHA_OLD);
    const f = await buildFixture();
    await switchTo(h, f);
    h.cloud.schemaFailAt.add(2);
    expect(await confirmSwitch(settleDeps(h))).toBe('rolled_back');
    expect(currentReal(h)).toBe(realpathSync(old));
    expect(h.cloud.rollbacks).toEqual([expect.objectContaining({ from: { version: '0.6.0', sha: SHA_NEW }, to: { version: '0.5.0', sha: SHA_OLD }, outcome: 'rolled_back' })]);
    expect(h.cloud.upgrades).toEqual([expect.objectContaining({ status: 'rolled_back' })]);
    expect(existsSync(join(h.home, 'updater', 'pending'))).toBe(false);
    const again = await runNodeUpdate(h.deps);
    expect(again.kind).toBe('deferred');
    expect(reasonOf(again)).toContain('24 小时内暂缓');
    h.clock += 24 * 60 * 60 * 1000 + 1;
    expect((await runNodeUpdate(h.deps)).kind).toBe('switched');
  });

  test('启动脚本已回退：旧版本启动时补记回退与冷却，清除标记', async () => {
    const h = harness();
    const old = installCurrent(h, '0.5.0', SHA_OLD);
    await switchTo(h, await buildFixture());
    // 模拟启动脚本：current 指回旧版本，留下回退计数。
    rmSync(join(h.home, 'current'));
    symlinkSync(old, join(h.home, 'current'));
    writeFileSync(join(h.home, 'updater', 'pending.rolled-back'), '3\n');
    expect(awaitingConfirmation(h.home)).toBe(false);
    const state = await settlePending(settleDeps(h));
    expect(state).toEqual({ kind: 'rolled_back', to: { version: '0.6.0', sha: SHA_NEW }, from: { version: '0.5.0', sha: SHA_OLD } });
    expect(h.cloud.rollbacks).toEqual([expect.objectContaining({ outcome: 'rolled_back', reason: expect.stringContaining('启动 3 次') })]);
    expect(h.cloud.upgrades).toEqual([expect.objectContaining({ status: 'rolled_back' })]);
    for (const name of ['pending', 'pending.rolled-back', 'pending.attempts']) expect(existsSync(join(h.home, 'updater', name))).toBe(false);
    expect(reasonOf(await runNodeUpdate(h.deps))).toContain('24 小时内暂缓');
  });

  test('标记与 current 都对不上（人工改过 current）：清理标记，不记录', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    await switchTo(h, await buildFixture());
    const other = makeReleaseDir(h.home, SHA_THIRD, '0.7.0');
    rmSync(join(h.home, 'current'));
    symlinkSync(other, join(h.home, 'current'));
    expect(await settlePending(settleDeps(h))).toEqual({ kind: 'stale' });
    expect(h.cloud.rollbacks).toEqual([]);
    expect(existsSync(join(h.home, 'updater', 'pending'))).toBe(false);
  });

  test('安装依赖失败：删除半装的发行目录，记录 failed；下一轮重新准备并切换', async () => {
    const h = harness();
    installCurrent(h, '0.5.0', SHA_OLD);
    const f = await buildFixture();
    h.release.publish(f);
    h.tools.failInstall = true;
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('failed');
    expect(existsSync(join(pluginReleasesDir(h), SHA_NEW))).toBe(false);
    expect(h.cloud.upgrades).toEqual([expect.objectContaining({ status: 'failed' })]);
    h.tools.failInstall = false;
    expect((await runNodeUpdate(h.deps)).kind).toBe('switched');
    expect(h.release.count(f.packageName)).toBe(2);
  });
});

describe('版本与状态门禁', () => {
  test('current 指向服务目录之外：拒绝，未切换', async () => {
    const h = harness();
    const outside = mkdtempSync(join(tmpdir(), 'sck-outside-'));
    trash.push(outside);
    symlinkSync(outside, join(h.home, 'current'));
    h.release.publish(await buildFixture());
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('refused');
    expect(reasonOf(out)).toContain('服务目录之外');
  });

  test('同版本不同 sha、或清单版本低于现役：拒绝（不降级）', async () => {
    for (const version of ['0.6.0', '0.5.9']) {
      const h = harness();
      installCurrent(h, '0.6.0', SHA_OLD);
      h.release.publish(await buildFixture({ version }));
      const out = await runNodeUpdate(h.deps);
      expect(out.kind).toBe('refused');
      expect(reasonOf(out)).toContain('不降级');
    }
  });

  test('已是最新（sha 相同）：current，并写入检查时间', async () => {
    const h = harness();
    installCurrent(h, '0.6.0', SHA_NEW);
    h.release.publish(await buildFixture());
    expect(await runNodeUpdate(h.deps)).toEqual({ kind: 'current', version: '0.6.0', sha: SHA_NEW });
    expect(h.cloud.touches).toHaveLength(1);
    expect(h.cloud.upgrades).toEqual([]);
  });

  test('没有正式发行：no_release', async () => {
    const h = harness();
    expect(await runNodeUpdate(h.deps)).toEqual({ kind: 'no_release' });
  });

  test('切换前 schema 不满足：拒绝，未写待确认标记', async () => {
    const h = harness();
    const old = installCurrent(h, '0.5.0', SHA_OLD);
    h.release.publish(await buildFixture());
    h.cloud.schemaFailAt.add(1);
    const out = await runNodeUpdate(h.deps);
    expect(out.kind).toBe('refused');
    expect(currentReal(h)).toBe(realpathSync(old));
    expect(existsSync(join(h.home, 'updater', 'pending'))).toBe(false);
  });
});
