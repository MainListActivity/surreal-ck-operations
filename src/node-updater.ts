// 节点更新器核心：一轮检查、准备、租约门禁、切换与回退，严格按序执行。
// 只依赖 node 内置模块与发行清单模块。云端、插件控制、发行源与打包工具全部经 UpdaterDeps 注入，
// 生产适配在 scripts/node-updater.ts。核心代码不使用 Bun 专有 API（打包目标为 node）。
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NodeUpgradeStatus } from './node-release.ts';
import {
  assertAssetIntegrity,
  compareVersions,
  MANIFEST_ASSET,
  parseReleaseManifest,
  sha256File,
  UPDATER_ASSET,
  type ReleaseAsset,
  type ReleaseManifest,
} from './release-manifest.ts';

/** 一轮更新的结果。refused / failed / deferred 都发生在切换之前（failed 的 rolled_back 等除外）。 */
export type UpdateOutcome =
  | { kind: 'current'; version: string; sha: string }
  | { kind: 'no_release' }
  | { kind: 'deferred'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'ok'; version: string; sha: string }
  | { kind: 'rolled_back'; reason: string; version: string; sha: string }
  | { kind: 'rollback_failed'; reason: string; version: string; sha: string };

export interface ReleaseRef { version: string; sha: string }

export interface ReleaseSource {
  /** 最新正式 Release 的 tag（非草稿、非预发布）；没有则 undefined。 */
  latestTag(): Promise<string | undefined>;
  download(tag: string, asset: string, dest: string): Promise<void>;
}

export interface PluginRegistration { path: string; status: string; enabled: boolean }

export interface PluginControl {
  /** 无注册返回 undefined。 */
  registration(): Promise<PluginRegistration | undefined>;
  remove(): Promise<void>;
  install(pluginDir: string): Promise<void>;
}

export interface PackageTools {
  extract(tgzFile: string, destDir: string): Promise<void>;
  /** pnpm install --prod --frozen-lockfile --ignore-scripts，cwd=pluginDir。 */
  installProd(pluginDir: string): Promise<void>;
}

export interface NodeCloud {
  activeLeaseCount(): Promise<number>;
  /** 库内 schema 不满足 version 要求时抛错。 */
  verifySchema(version: string): Promise<void>;
  /** 生产实现须保证行存在（ensureNodeRelease + touchNodeCheck）。 */
  touchCheck(at: Date): Promise<void>;
  recordUpgrade(r: { status: NodeUpgradeStatus; target?: ReleaseRef; at: Date; error?: string }): Promise<void>;
  recordRollback(r: { from: ReleaseRef; to: ReleaseRef; at: Date; reason: string; outcome: 'rolled_back' | 'rollback_failed' }): Promise<void>;
}

export interface UpdaterDeps {
  home: string;
  release: ReleaseSource;
  plugin: PluginControl;
  tools: PackageTools;
  cloud: NodeCloud;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** 切换后等待插件进入 running 的上限，默认 60000 毫秒。 */
  waitRunningMs?: number;
  /** 等待期间的轮询间隔，默认 2000 毫秒。 */
  pollMs?: number;
}

const SHA40 = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
/** 插件发行目录的根：<服务目录>/plugin-releases/<sha>，内含 release.json、plugin/ 与 scripts/（sck.sh、bun-runtime.sh）。 */
const PLUGIN_RELEASES = 'plugin-releases';
/** 现役插件目录的符号链接：<服务目录>/current -> plugin-releases/<sha>/plugin。sck 只从这里运行。 */
const CURRENT_LINK = 'current';
/** 发行包 scripts/ 里需要安装到 <服务目录>/bin/ 的 sck 工具脚本（源文件名 -> 安装名）。 */
const TOOL_SCRIPTS = [
  { from: 'sck.sh', to: 'sck' },
  { from: 'bun-runtime.sh', to: 'bun-runtime.sh' },
] as const;
const LOCK_STALE_MS = 60_000;
const DEFAULT_WAIT_RUNNING_MS = 60_000;
const DEFAULT_POLL_MS = 2_000;
/** 切换后回退过的同一版本，这段时间内不再切换到它，避免每轮都重启插件。 */
const RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** 切换前的中止（拒绝、失败、暂缓）：由顶层转换成对应的结果。 */
class StepError extends Error {
  readonly kind: 'refused' | 'failed' | 'deferred';
  constructor(kind: 'refused' | 'failed' | 'deferred', message: string) {
    super(message);
    this.kind = kind;
  }
}

/** 现役版本：版本取自插件目录的 package.json，sha 取自所在发行目录名。 */
interface Current { version?: string; sha?: string }

export async function runNodeUpdate(deps: UpdaterDeps): Promise<UpdateOutcome> {
  let acquired: (() => void) | undefined;
  try {
    acquired = acquireLock(deps.home, deps.now());
  } catch (error) {
    return { kind: 'failed', reason: `无法获取更新锁：${errorText(error)}` };
  }
  if (!acquired) return { kind: 'deferred', reason: '另一轮更新正在进行' };
  const unlock = acquired;
  const staging = join(deps.home, PLUGIN_RELEASES, `.staging-${randomUUID()}`);
  try {
    return await runLocked(deps, staging);
  } catch (error) {
    // 切换前的拒绝与失败写入云端，运维才看得到；暂缓是正常等待，只更新检查时间。
    const kind = error instanceof StepError ? error.kind : 'failed';
    const reason = error instanceof StepError ? error.message : errorText(error);
    deps.log(`节点更新${LABEL[kind]}：${reason}`);
    if (kind !== 'deferred') {
      await recordSafe(deps.log, '升级结果', () => deps.cloud.recordUpgrade({ status: kind, at: deps.now(), error: reason }));
    }
    return { kind, reason } as UpdateOutcome;
  } finally {
    removeQuietly(staging, deps.log);
    try {
      unlock();
    } catch (error) {
      deps.log(`释放更新锁失败：${errorText(error)}`);
    }
  }
}

const LABEL = { refused: '拒绝', failed: '失败', deferred: '暂缓' } as const;

async function runLocked(deps: UpdaterDeps, staging: string): Promise<UpdateOutcome> {
  const { home, release, plugin, tools, cloud, log } = deps;

  // 1. 记录本轮检查时间；写入失败只记日志。
  await checkTime(deps);

  // 2. 最新正式 Release。
  const tag = await release.latestTag();
  if (tag === undefined) {
    log('没有正式发行版本，本轮不更新');
    return { kind: 'no_release' };
  }

  // 3. 下载并解析清单，tag 必须与清单版本一致。
  mkdirSync(staging, { recursive: true });
  const manifestFile = join(staging, MANIFEST_ASSET);
  await release.download(tag, MANIFEST_ASSET, manifestFile);
  let manifest: ReleaseManifest;
  try {
    manifest = parseReleaseManifest(readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    throw new StepError('refused', `发行清单解析失败：${errorText(error)}`);
  }
  if (tag !== `v${manifest.version}`) {
    throw new StepError('refused', `发行标签 ${tag} 与清单版本 ${manifest.version} 不一致`);
  }
  if (manifest.package.name === manifest.updater.name) {
    throw new StepError('refused', '发行清单中发行包与更新器的资产名相同，拒绝使用');
  }

  // 4. 当前注册与现役版本。
  const homeReal = realpathSync(home);
  let reg: PluginRegistration | undefined;
  try {
    reg = await plugin.registration();
  } catch (error) {
    throw new StepError('failed', `读取插件注册失败：${errorText(error)}`);
  }
  if (reg) {
    const regReal = realOrUndefined(reg.path);
    if (regReal === undefined) throw new StepError('refused', '插件注册路径不存在或无法解析，未切换');
    if (!isInside(regReal, homeReal)) throw new StepError('refused', '插件注册在服务目录之外，未切换');
  }
  const cur: Current = reg ? currentOf(reg) : {};
  if (cur.sha === manifest.sha) {
    if (reg && realOrUndefined(join(home, CURRENT_LINK)) !== realOrUndefined(reg.path)) serveCurrent(home, reg.path, log);
    await refreshUpdater(deps, tag, manifest, staging);
    return { kind: 'current', version: cur.version ?? manifest.version, sha: manifest.sha };
  }
  if (cur.version !== undefined && compareVersions(manifest.version, cur.version) <= 0) {
    throw new StepError('refused', '清单版本不高于现役版本，不降级');
  }
  const rolledBack = readRolledBack(home);
  if (rolledBack?.sha === manifest.sha && deps.now().getTime() - rolledBack.at < RETRY_COOLDOWN_MS) {
    throw new StepError('deferred', `版本 ${manifest.version} 上次切换后已回退，24 小时内暂缓重试`);
  }

  // 5. 准备发行目录（幂等）。目标目录已齐全时只重新下载并校验更新器，不重复下载发行包。
  const target = join(home, PLUGIN_RELEASES, manifest.sha);
  const targetPlugin = join(target, 'plugin');
  let updaterFile: string;
  if (isReusable(target, manifest)) {
    log(`复用已准备好的发行目录：${manifest.version}`);
    updaterFile = await fetchVerified(deps, tag, manifest.updater, staging);
  } else {
    updaterFile = await prepareRelease(deps, tag, manifest, staging, target);
  }

  // 6. 租约门禁：切换前最后一步。
  let leases: number;
  try {
    leases = await cloud.activeLeaseCount();
  } catch (error) {
    log(`租约查询失败：${errorText(error)}`);
    throw new StepError('deferred', '无法确认本节点租约，未切换');
  }
  if (leases > 0) throw new StepError('deferred', '本节点有进行中的租约，下一轮再切换');

  // 7. 切换前核验云端 schema。
  try {
    await cloud.verifySchema(manifest.version);
  } catch (error) {
    throw new StepError('refused', `云端 schema 不满足 ${manifest.version}，未切换：${errorText(error)}`);
  }

  // 8. 切换。任何一步失败都进入回退。
  const newRef: ReleaseRef = { version: manifest.version, sha: manifest.sha };
  try {
    if (reg) await plugin.remove();
    await plugin.install(targetPlugin);
    await waitRunning(deps, targetPlugin);
    await cloud.verifySchema(manifest.version);
  } catch (error) {
    return rollback(deps, { reg, cur, target: newRef, reason: errorText(error) });
  }

  serveCurrent(home, targetPlugin, log);
  try {
    installUpdater(home, updaterFile);
  } catch (error) {
    log(`节点更新器替换失败，保留旧文件（插件已切换）：${errorText(error)}`);
  }
  clearRolledBack(home, log);
  // 10. 回收：只删除旧的发行目录，保留目标与现役旧版本（回退目标）。
  recycle(home, [manifest.sha, cur.sha], log);
  await recordSafe(log, '升级结果', () => cloud.recordUpgrade({ status: 'ok', target: newRef, at: deps.now() }));
  log(`升级成功：${manifest.version}`);
  return { kind: 'ok', version: manifest.version, sha: manifest.sha };
}

/** 切换后失败：回退到原注册路径；无原注册时只尽力停掉新插件。 */
async function rollback(
  deps: UpdaterDeps,
  ctx: { reg?: PluginRegistration; cur: Current; target: ReleaseRef; reason: string },
): Promise<UpdateOutcome> {
  const { plugin, cloud, log } = deps;
  const at = deps.now();
  log(`切换后失败，开始回退：${ctx.reason}`);
  if (!ctx.reg) {
    try {
      await plugin.remove();
    } catch {
      // 忽略：新插件可能本就没有注册成功。
    }
    await recordSafe(log, '升级结果', () => cloud.recordUpgrade({ status: 'failed', target: ctx.target, at, error: ctx.reason }));
    return { kind: 'failed', reason: ctx.reason };
  }

  const reg = ctx.reg;
  let rollbackError: string | undefined;
  try {
    try {
      await plugin.remove();
    } catch {
      // 忽略：旧注册可能已经不在。
    }
    await plugin.install(reg.path);
    await waitRunning(deps, reg.path);
  } catch (error) {
    rollbackError = errorText(error);
  }
  serveCurrent(deps.home, reg.path, log);

  const to: ReleaseRef = { version: ctx.cur.version ?? 'unknown', sha: ctx.cur.sha ?? 'unknown' };
  if (rollbackError === undefined) {
    await recordSafe(log, '回退记录', () => cloud.recordRollback({ from: ctx.target, to, at, reason: ctx.reason, outcome: 'rolled_back' }));
    await recordSafe(log, '升级结果', () => cloud.recordUpgrade({ status: 'rolled_back', target: ctx.target, at, error: ctx.reason }));
    writeRolledBack(deps.home, log, { ...ctx.target, at: at.getTime() });
    log(`已回退到 ${to.version}`);
    return { kind: 'rolled_back', reason: ctx.reason, version: ctx.target.version, sha: ctx.target.sha };
  }

  const reason = `${ctx.reason}；回退也失败：${rollbackError}`;
  await recordSafe(log, '回退记录', () => cloud.recordRollback({ from: ctx.target, to, at, reason, outcome: 'rollback_failed' }));
  await recordSafe(log, '升级结果', () => cloud.recordUpgrade({ status: 'rollback_failed', target: ctx.target, at, error: reason }));
  log(`回退失败，插件可能未运行：${rollbackError}`);
  return { kind: 'rollback_failed', reason, version: ctx.target.version, sha: ctx.target.sha };
}

/** 下载发行包与更新器，校验后解压、安装依赖，并把发行目录放到 plugin-releases/<sha>。 */
async function prepareRelease(
  deps: UpdaterDeps,
  tag: string,
  manifest: ReleaseManifest,
  staging: string,
  target: string,
): Promise<string> {
  const packageFile = await fetchVerified(deps, tag, manifest.package, staging);
  const updaterFile = await fetchVerified(deps, tag, manifest.updater, staging);
  const extractDir = join(staging, 'extract');
  mkdirSync(extractDir, { recursive: true });
  try {
    await deps.tools.extract(packageFile, extractDir);
  } catch (error) {
    throw new StepError('failed', `解压发行包失败：${errorText(error)}`);
  }
  if (!matchesManifest(readJson(join(extractDir, 'release.json')), manifest)) {
    throw new StepError('refused', '发行包内 release.json 与清单不一致（产品、版本、sha 或 schema 要求），拒绝使用');
  }
  if (!isDirectory(join(extractDir, 'plugin'))) {
    throw new StepError('refused', '发行包缺少 plugin/ 目录，拒绝使用');
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(extractDir, target);
  try {
    await deps.tools.installProd(join(target, 'plugin'));
  } catch (error) {
    // 半装的 node_modules 会被下一轮当作可复用目录，所以整目录删除。
    rmSync(target, { recursive: true, force: true });
    throw new StepError('failed', `安装插件依赖失败：${errorText(error)}`);
  }
  return updaterFile;
}

/** 下载单个资产到暂存目录并校验 sha256 与大小；不符则拒绝。 */
async function fetchVerified(deps: UpdaterDeps, tag: string, asset: ReleaseAsset, staging: string): Promise<string> {
  const name = plainAssetName(asset.name);
  const file = join(staging, name);
  await deps.release.download(tag, name, file);
  try {
    assertAssetIntegrity(await sha256File(file), asset);
  } catch (error) {
    throw new StepError('refused', `发行资产校验未通过，拒绝使用，未解压：${errorText(error)}`);
  }
  return file;
}

/** 资产名必须是纯文件名，不能借它写到暂存目录之外。 */
function plainAssetName(name: string): string {
  if (name !== basename(name) || name === '.' || name === '..') {
    throw new StepError('refused', `发行清单资产名无效：${name}`);
  }
  return name;
}

/** 目标目录已有与清单一致的 release.json 且依赖已安装，可以直接复用。 */
function isReusable(target: string, manifest: ReleaseManifest): boolean {
  return existsSync(join(target, 'release.json'))
    && matchesManifest(readJson(join(target, 'release.json')), manifest)
    && isDirectory(join(target, 'plugin', 'node_modules'));
}

function matchesManifest(value: unknown, manifest: ReleaseManifest): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const rel = value as Record<string, unknown>;
  return rel.product === manifest.product
    && rel.version === manifest.version
    && rel.sha === manifest.sha
    && rel.requiredSchema === manifest.requiredSchema;
}

function currentOf(reg: PluginRegistration): Current {
  const name = basename(dirname(reg.path));
  const version = (readJson(join(reg.path, 'package.json')) as { version?: unknown } | null | undefined)?.version;
  return {
    version: typeof version === 'string' && SEMVER.test(version) ? version : undefined,
    sha: SHA40.test(name) ? name : undefined,
  };
}

/** 轮询直到插件处于 running、启用，并且注册路径就是 dir。超时抛错，错误文本含最后看到的状态。 */
async function waitRunning(deps: UpdaterDeps, dir: string): Promise<void> {
  const limit = deps.waitRunningMs ?? DEFAULT_WAIT_RUNNING_MS;
  const poll = Math.max(1, deps.pollMs ?? DEFAULT_POLL_MS);
  const want = realOrUndefined(dir);
  let waited = 0;
  let last = '未注册';
  for (;;) {
    try {
      const reg = await deps.plugin.registration();
      if (reg && reg.status === 'running' && reg.enabled && want !== undefined && realOrUndefined(reg.path) === want) return;
      last = reg ? `状态 ${reg.status}，启用 ${reg.enabled ? '是' : '否'}，路径 ${reg.path}` : '未注册';
    } catch (error) {
      last = `读取失败：${errorText(error)}`;
    }
    if (waited >= limit) throw new Error(`插件未在 ${limit} 毫秒内进入运行状态（最后看到：${last}）`);
    await deps.sleep(poll);
    waited += poll;
  }
}

/** 替换节点更新器单文件：先写同目录临时文件，再原子 rename。 */
function installUpdater(home: string, source: string): void {
  const dir = join(home, 'updater');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${UPDATER_ASSET}.${randomUUID()}.tmp`);
  try {
    copyFileSync(source, tmp);
    chmodSync(tmp, 0o600);
    renameSync(tmp, join(dir, UPDATER_ASSET));
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * 把 current 指向 pluginDir，并把 pluginDir 所在发行目录里的 sck 工具脚本装到 bin/。
 * 插件已处于目标状态，这两步失败只记日志，不回退插件；发行目录缺脚本时保留 bin/ 里原有的文件。
 */
function serveCurrent(home: string, pluginDir: string, log: (line: string) => void): void {
  try {
    pointCurrent(home, pluginDir);
  } catch (error) {
    log(`current 指向更新失败（sck 仍指向旧版本）：${errorText(error)}`);
  }
  try {
    installToolScripts(home, dirname(pluginDir), log);
  } catch (error) {
    log(`sck 工具脚本安装失败（保留旧文件）：${errorText(error)}`);
  }
}

/** current 是符号链接：先在同目录建临时链接，再 rename 覆盖，替换是原子的。 */
function pointCurrent(home: string, pluginDir: string): void {
  const link = join(home, CURRENT_LINK);
  const tmp = join(home, `.current.${randomUUID()}.tmp`);
  try {
    symlinkSync(resolve(pluginDir), tmp);
    renameSync(tmp, link);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** 把发行目录 scripts/ 里的 sck 工具脚本复制到 bin/（权限 700，临时文件 + rename）；缺任一源文件则整体不替换。 */
function installToolScripts(home: string, releaseDir: string, log: (line: string) => void): void {
  const tools = TOOL_SCRIPTS.map(tool => ({ ...tool, source: join(releaseDir, 'scripts', tool.from) }));
  const missing = tools.filter(tool => !existsSync(tool.source)).map(tool => tool.from);
  if (missing.length > 0) {
    log(`发行目录缺少 ${missing.join('、')}，保留 bin/ 里原有的 sck 工具脚本`);
    return;
  }
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const tool of tools) {
    const tmp = join(bin, `.${tool.to}.${randomUUID()}.tmp`);
    try {
      copyFileSync(tool.source, tmp);
      chmodSync(tmp, 0o700);
      renameSync(tmp, join(bin, tool.to));
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

/** 现役版本已是清单版本时，只把节点更新器文件对齐到清单；失败只记日志，不影响插件。 */
async function refreshUpdater(deps: UpdaterDeps, tag: string, manifest: ReleaseManifest, staging: string): Promise<void> {
  const bundle = join(deps.home, 'updater', UPDATER_ASSET);
  try {
    if (existsSync(bundle) && (await sha256File(bundle)).sha256 === manifest.updater.sha256.toLowerCase()) return;
    installUpdater(deps.home, await fetchVerified(deps, tag, manifest.updater, staging));
    deps.log('节点更新器已对齐到发行版本');
  } catch (error) {
    deps.log(`节点更新器对齐失败（插件不受影响）：${errorText(error)}`);
  }
}

/** 最近一次切换后回退的版本与时间（unix 毫秒），位于 updater/rolled-back.json。 */
interface RolledBack { sha: string; version: string; at: number }

function rolledBackPath(home: string): string {
  return join(home, 'updater', 'rolled-back.json');
}

function readRolledBack(home: string): RolledBack | undefined {
  const body = readJson(rolledBackPath(home)) as Partial<RolledBack> | null | undefined;
  if (typeof body !== 'object' || body === null) return undefined;
  if (typeof body.sha !== 'string' || typeof body.version !== 'string' || typeof body.at !== 'number') return undefined;
  return { sha: body.sha, version: body.version, at: body.at };
}

function writeRolledBack(home: string, log: (line: string) => void, record: RolledBack): void {
  const dir = join(home, 'updater');
  const tmp = join(dir, `.rolled-back.${randomUUID()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(tmp, rolledBackPath(home));
  } catch (error) {
    log(`记录回退冷却失败（下一轮可能立即重试）：${errorText(error)}`);
    removeQuietly(tmp, log);
  }
}

function clearRolledBack(home: string, log: (line: string) => void): void {
  try {
    rmSync(rolledBackPath(home), { force: true });
  } catch (error) {
    log(`清除回退记录失败：${errorText(error)}`);
  }
}

/**
 * 回收 plugin-releases 下的旧发行目录：名称为 40 位 hex、含 release.json，且不是目标或现役旧版本。
 * 绝不删除 current 指向的目录（及其包含关系上的目录），不删除不含 release.json 的目录。
 */
function recycle(home: string, keep: Array<string | undefined>, log: (line: string) => void): void {
  const root = join(home, PLUGIN_RELEASES);
  const kept = new Set(keep.filter((sha): sha is string => sha !== undefined));
  const currentReal = realOrUndefined(join(home, CURRENT_LINK));
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SHA40.test(entry.name) || kept.has(entry.name)) continue;
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, 'release.json'))) continue;
    const dirReal = realOrUndefined(dir);
    if (dirReal === undefined) continue;
    if (currentReal !== undefined && (currentReal === dirReal || isInside(currentReal, dirReal) || isInside(dirReal, currentReal))) {
      log(`保留 current 指向的目录：${entry.name}`);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      log(`回收旧发行目录：${entry.name}`);
    } catch (error) {
      log(`回收旧发行目录失败：${entry.name}：${errorText(error)}`);
    }
  }
}

/** 检查时间写入；失败只记日志。 */
async function checkTime(deps: UpdaterDeps): Promise<void> {
  try {
    await deps.cloud.touchCheck(deps.now());
  } catch (error) {
    deps.log(`检查时间写入失败，继续本轮：${errorText(error)}`);
  }
}

/** 记录类写入失败只记日志，不改变结果。 */
async function recordSafe(log: (line: string) => void, label: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    log(`${label}写入失败（不影响结果）：${errorText(error)}`);
  }
}

/**
 * 锁文件 <home>/updater/lock（内容 {pid, at}）。已有锁且持有者存活则返回 undefined（忙）；
 * 持有者已不存在则接管。返回的函数释放本进程持有的锁。
 */
function acquireLock(home: string, at: Date): (() => void) | undefined {
  const path = join(home, 'updater', 'lock');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify({ pid: process.pid, at: at.toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { flag: 'wx', mode: 0o600 });
      return () => releaseLock(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (lockHeld(path)) return undefined;
    rmSync(path, { force: true });
  }
  return undefined;
}

function releaseLock(path: string): void {
  const body = readJson(path) as { pid?: unknown } | null | undefined;
  if (typeof body === 'object' && body !== null && body.pid === process.pid) rmSync(path, { force: true });
}

/** 锁是否仍被存活进程持有。内容损坏（如写入中途崩溃）时，一分钟内按仍被占用处理，之后视为陈旧。 */
function lockHeld(path: string): boolean {
  if (!existsSync(path)) return false;
  const body = readJson(path) as { pid?: unknown } | null | undefined;
  if (typeof body !== 'object' || body === null) {
    try {
      return Date.now() - statSync(path).mtimeMs < LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
  return pidAlive(body.pid);
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isInside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function removeQuietly(path: string, log: (line: string) => void): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    log(`删除暂存目录失败：${errorText(error)}`);
  }
}

function errorText(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return text.slice(0, 300) || '未知错误';
}
