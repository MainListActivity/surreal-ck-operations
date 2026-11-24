// 节点自更新核心：原生执行端自己检查、准备、切换 current，并在新版本启动后确认或回退。
// 一轮更新：检查 → 准备发行目录 → 空闲与租约门禁 → schema 核验 → 写待确认标记 → 原子切换 current。
// 切换后由执行端排空退出，服务管理器按新 current 拉起新版本；新版本健康后调用 confirmSwitch 收尾。
// 新版本起不来时，启动脚本（scripts/native-service.ts 生成）按待确认标记计数，连续失败后把 current 指回旧版本，
// 旧版本启动时由 settlePending 补记回退。坏版本的代码不参与自己的回退。
// 只依赖 node 内置模块与发行清单模块；云端、发行源与打包工具经依赖注入，生产适配在 src/node-update-sources.ts。
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
  type ReleaseAsset,
  type ReleaseManifest,
} from './release-manifest.ts';

/** 一轮更新的结果。switched 表示 current 已指向新版本，等待执行端重启后确认。 */
export type UpdateOutcome =
  | { kind: 'current'; version: string; sha: string }
  | { kind: 'no_release' }
  | { kind: 'deferred'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'switched'; version: string; sha: string };

export interface ReleaseRef { version: string; sha: string }

export interface ReleaseSource {
  /** 最新正式 Release 的 tag（非草稿、非预发布）；没有则 undefined。 */
  latestTag(): Promise<string | undefined>;
  download(tag: string, asset: string, dest: string): Promise<void>;
}

export interface PackageTools {
  extract(tgzFile: string, destDir: string): Promise<void>;
  /** pnpm install --prod --frozen-lockfile --ignore-scripts，cwd=发行目录里的运行目录。 */
  installProd(payloadDir: string): Promise<void>;
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

/** 收尾与补记只需要服务目录、云端、时钟与日志。 */
export interface SettleDeps {
  home: string;
  cloud: NodeCloud;
  now(): Date;
  log(line: string): void;
}

export interface UpdaterDeps extends SettleDeps {
  release: ReleaseSource;
  tools: PackageTools;
  /** 本执行端没有运行中的会话时为 true；切换只在空闲时发生。 */
  idle(): Promise<boolean>;
}

const SHA40 = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
/** 发行目录的根：<服务目录>/plugin-releases/<sha>，内含 release.json、运行目录与 scripts/（sck.sh、bun-runtime.sh）。 */
const RELEASES = 'plugin-releases';
/** 发行包内的运行目录名，按顺序取第一个存在的（plugin 是历史名称）。 */
export const PAYLOAD_DIRS = ['runtime', 'plugin'] as const;
/** 现役运行目录的符号链接：<服务目录>/current -> plugin-releases/<sha>/<运行目录>。执行端与 sck 只从这里运行。 */
const CURRENT_LINK = 'current';
/** 发行包 scripts/ 里需要安装到 <服务目录>/bin/ 的 sck 工具脚本（源文件名 -> 安装名）。 */
const TOOL_SCRIPTS = [
  { from: 'sck.sh', to: 'sck' },
  { from: 'bun-runtime.sh', to: 'bun-runtime.sh' },
] as const;
const LOCK_STALE_MS = 60_000;
/** 切换后回退过的同一版本，这段时间内不再切换到它，避免每轮都重启执行端。 */
const RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** 待确认标记：第 1 行新运行目录，第 2 行旧运行目录（可空），第 3 行 JSON 元数据。启动脚本只读前两行。 */
export const PENDING_FILE = join('updater', 'pending');

/** 切换前的中止（拒绝、失败、暂缓）：由顶层转换成对应的结果。 */
class StepError extends Error {
  readonly kind: 'refused' | 'failed' | 'deferred';
  constructor(kind: 'refused' | 'failed' | 'deferred', message: string) {
    super(message);
    this.kind = kind;
  }
}

/** 现役版本：path 为 current 解析后的运行目录；版本取自其中的 package.json，sha 取自所在发行目录名。 */
interface Current { path?: string; version?: string; sha?: string }

export async function runNodeUpdate(deps: UpdaterDeps): Promise<UpdateOutcome> {
  let acquired: (() => void) | undefined;
  try {
    acquired = acquireLock(deps.home, deps.now());
  } catch (error) {
    return { kind: 'failed', reason: `无法获取更新锁：${errorText(error)}` };
  }
  if (!acquired) return { kind: 'deferred', reason: '另一轮更新正在进行' };
  const unlock = acquired;
  const staging = join(deps.home, RELEASES, `.staging-${randomUUID()}`);
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
  const { home, release, cloud, log } = deps;

  // 1. 记录本轮检查时间；写入失败只记日志。
  await checkTime(deps);

  // 上一次切换还没确认（新版本尚未健康启动或回退尚未补记）时不再切换。
  if (existsSync(join(home, PENDING_FILE))) throw new StepError('deferred', '上一次切换尚未确认');

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

  // 4. 现役版本：current 必须在服务目录之内。
  const cur = currentOf(home);
  if (cur.sha === manifest.sha) return { kind: 'current', version: cur.version ?? manifest.version, sha: manifest.sha };
  if (cur.version !== undefined && compareVersions(manifest.version, cur.version) <= 0) {
    throw new StepError('refused', '清单版本不高于现役版本，不降级');
  }
  const rolledBack = readRolledBack(home);
  if (rolledBack?.sha === manifest.sha && deps.now().getTime() - rolledBack.at < RETRY_COOLDOWN_MS) {
    throw new StepError('deferred', `版本 ${manifest.version} 上次切换后已回退，24 小时内暂缓重试`);
  }

  // 5. 准备发行目录（幂等）。目标目录已齐全时直接复用，不重复下载发行包。
  const target = join(home, RELEASES, manifest.sha);
  if (isReusable(target, manifest)) log(`复用已准备好的发行目录：${manifest.version}`);
  else await prepareRelease(deps, tag, manifest, staging, target);
  const targetPayload = payloadOf(target)!;

  // 6. 空闲与租约门禁：切换前最后一步。
  let idle: boolean;
  try {
    idle = await deps.idle();
  } catch (error) {
    throw new StepError('deferred', `无法确认执行端是否空闲：${errorText(error)}`);
  }
  if (!idle) throw new StepError('deferred', '执行端有运行中的会话，下一轮再切换');
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

  // 8. 先写待确认标记再切换：启动脚本凭它判断新版本是否起得来。
  const to: ReleaseRef = { version: manifest.version, sha: manifest.sha };
  const from = cur.path !== undefined && cur.version !== undefined && cur.sha !== undefined
    ? { version: cur.version, sha: cur.sha } : undefined;
  writePending(home, { toPath: targetPayload, fromPath: from ? cur.path : undefined, to, from, at: deps.now().getTime() });
  try {
    pointCurrent(home, targetPayload);
  } catch (error) {
    clearPending(home, log);
    throw new StepError('failed', `切换 current 失败：${errorText(error)}`);
  }
  log(`已切换到 ${manifest.version}，等待执行端重启后确认`);
  return { kind: 'switched', version: manifest.version, sha: manifest.sha };
}

// ---------------------------------------------------------------------------
// 切换后的收尾：新版本启动时 settlePending，健康后 confirmSwitch。

interface Pending { toPath: string; fromPath?: string; to: ReleaseRef; from?: ReleaseRef; at: number }

export type SettleState =
  | { kind: 'none' }
  /** current 指向新版本：等健康后调用 confirmSwitch。 */
  | { kind: 'confirming'; to: ReleaseRef; from?: ReleaseRef }
  /** 启动脚本已回退到旧版本，本次补记了回退。 */
  | { kind: 'rolled_back'; to: ReleaseRef; from: ReleaseRef }
  /** 标记与 current 对不上（人工改过 current），已清理。 */
  | { kind: 'stale' };

/** 同步只读：current 是否指向待确认的新版本。执行端启动最早一刻据此装确认看门狗，不连云端。 */
export function awaitingConfirmation(home: string): boolean {
  const pending = readPending(home);
  return pending !== undefined && sameDir(join(home, CURRENT_LINK), pending.toPath);
}

/** 执行端连上云端后调用一次：识别启动脚本的回退并补记，或报告待确认。 */
export async function settlePending(deps: SettleDeps): Promise<SettleState> {
  const { home, cloud, log } = deps;
  if (!existsSync(join(home, PENDING_FILE))) return { kind: 'none' };
  const pending = readPending(home);
  if (pending === undefined) {
    log('待确认标记损坏，已清理');
    clearPending(home, log);
    return { kind: 'stale' };
  }
  const link = join(home, CURRENT_LINK);
  if (sameDir(link, pending.toPath)) return { kind: 'confirming', to: pending.to, from: pending.from };
  if (pending.fromPath !== undefined && pending.from !== undefined && sameDir(link, pending.fromPath)) {
    const attempts = readCount(join(home, `${PENDING_FILE}.rolled-back`)) ?? readCount(join(home, `${PENDING_FILE}.attempts`));
    const reason = `新版本 ${pending.to.version} 未能健康启动${attempts ? `（启动 ${attempts} 次）` : ''}，启动脚本已回退`;
    await recordRolledBack(deps, pending.to, pending.from, reason);
    clearPending(home, log);
    return { kind: 'rolled_back', to: pending.to, from: pending.from };
  }
  log('待确认标记与 current 不一致（current 被人工改动），已清理');
  clearPending(home, log);
  return { kind: 'stale' };
}

/**
 * 新版本健康（已连上云端、派工已启动、首个心跳到达）后调用：核验 schema，安装 sck 工具脚本，
 * 回收旧发行目录，记录升级成功并清除标记。schema 不满足时自己把 current 指回旧版本，返回 rolled_back，
 * 调用方随后排空退出。
 */
export async function confirmSwitch(deps: SettleDeps): Promise<'confirmed' | 'rolled_back' | 'none'> {
  const { home, cloud, log } = deps;
  const pending = readPending(home);
  if (pending === undefined || !sameDir(join(home, CURRENT_LINK), pending.toPath)) return 'none';
  try {
    await cloud.verifySchema(pending.to.version);
  } catch (error) {
    const reason = `新版本 ${pending.to.version} 启动后 schema 核验失败：${errorText(error)}`;
    if (pending.fromPath === undefined || pending.from === undefined) {
      log(`${reason}；没有可回退的旧版本`);
      await recordSafe(log, '升级结果', () => cloud.recordUpgrade({ status: 'failed', target: pending.to, at: deps.now(), error: reason }));
      clearPending(home, log);
      return 'none';
    }
    try {
      pointCurrent(home, pending.fromPath);
    } catch (pointError) {
      const failed = `${reason}；回退也失败：${errorText(pointError)}`;
      log(failed);
      await recordSafe(log, '回退记录', () => cloud.recordRollback({ from: pending.to, to: pending.from!, at: deps.now(), reason: failed, outcome: 'rollback_failed' }));
      await recordSafe(log, '升级结果', () => cloud.recordUpgrade({ status: 'rollback_failed', target: pending.to, at: deps.now(), error: failed }));
      clearPending(home, log);
      return 'none';
    }
    await recordRolledBack(deps, pending.to, pending.from, reason);
    clearPending(home, log);
    return 'rolled_back';
  }
  try {
    installToolScripts(home, dirname(pending.toPath), log);
  } catch (error) {
    log(`sck 工具脚本安装失败（保留旧文件）：${errorText(error)}`);
  }
  clearRolledBack(home, log);
  recycle(home, [pending.to.sha, pending.from?.sha], log);
  await recordSafe(log, '升级结果', () => cloud.recordUpgrade({ status: 'ok', target: pending.to, at: deps.now() }));
  clearPending(home, log);
  log(`升级成功：${pending.to.version}`);
  return 'confirmed';
}

async function recordRolledBack(deps: SettleDeps, target: ReleaseRef, back: ReleaseRef, reason: string): Promise<void> {
  const at = deps.now();
  deps.log(`${reason}；现役 ${back.version}`);
  await recordSafe(deps.log, '回退记录', () => deps.cloud.recordRollback({ from: target, to: back, at, reason, outcome: 'rolled_back' }));
  await recordSafe(deps.log, '升级结果', () => deps.cloud.recordUpgrade({ status: 'rolled_back', target, at, error: reason }));
  writeRolledBack(deps.home, deps.log, { ...target, at: at.getTime() });
}

function writePending(home: string, pending: Pending): void {
  const dir = join(home, 'updater');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const path of [pending.toPath, pending.fromPath]) {
    if (path !== undefined && /[\r\n]/.test(path)) throw new StepError('refused', '运行目录路径含换行，拒绝切换');
  }
  rmSync(join(home, `${PENDING_FILE}.attempts`), { force: true });
  rmSync(join(home, `${PENDING_FILE}.rolled-back`), { force: true });
  const meta = JSON.stringify({ to: pending.to, from: pending.from ?? null, at: pending.at });
  const tmp = join(dir, `.pending.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${pending.toPath}\n${pending.fromPath ?? ''}\n${meta}\n`, { mode: 0o600 });
    renameSync(tmp, join(home, PENDING_FILE));
  } finally {
    rmSync(tmp, { force: true });
  }
}

function readPending(home: string): Pending | undefined {
  let text: string;
  try {
    text = readFileSync(join(home, PENDING_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const [toPath, fromPath, metaLine] = text.split('\n');
  if (!toPath || !isAbsolute(toPath) || metaLine === undefined) return undefined;
  let meta: { to?: unknown; from?: unknown; at?: unknown };
  try {
    meta = JSON.parse(metaLine) as typeof meta;
  } catch {
    return undefined;
  }
  const to = refOf(meta.to);
  if (to === undefined || typeof meta.at !== 'number') return undefined;
  const from = refOf(meta.from);
  return { toPath, fromPath: fromPath && isAbsolute(fromPath) && from ? fromPath : undefined, to, from: fromPath ? from : undefined, at: meta.at };
}

function refOf(value: unknown): ReleaseRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const ref = value as Record<string, unknown>;
  return typeof ref.version === 'string' && typeof ref.sha === 'string' ? { version: ref.version, sha: ref.sha } : undefined;
}

function clearPending(home: string, log: (line: string) => void): void {
  for (const name of [PENDING_FILE, `${PENDING_FILE}.attempts`, `${PENDING_FILE}.rolled-back`]) {
    try {
      rmSync(join(home, name), { force: true });
    } catch (error) {
      log(`清除待确认标记失败：${errorText(error)}`);
    }
  }
}

function readCount(path: string): number | undefined {
  try {
    const n = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 准备发行目录

async function prepareRelease(
  deps: UpdaterDeps,
  tag: string,
  manifest: ReleaseManifest,
  staging: string,
  target: string,
): Promise<void> {
  const packageFile = await fetchVerified(deps, tag, manifest.package, staging);
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
  if (payloadOf(extractDir) === undefined) {
    throw new StepError('refused', `发行包缺少运行目录（${PAYLOAD_DIRS.join(' 或 ')}），拒绝使用`);
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(extractDir, target);
  try {
    await deps.tools.installProd(payloadOf(target)!);
  } catch (error) {
    // 半装的 node_modules 会被下一轮当作可复用目录，所以整目录删除。
    rmSync(target, { recursive: true, force: true });
    throw new StepError('failed', `安装运行依赖失败：${errorText(error)}`);
  }
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

/** 发行目录里的运行目录：按 PAYLOAD_DIRS 顺序取第一个存在的目录。 */
function payloadOf(releaseDir: string): string | undefined {
  for (const name of PAYLOAD_DIRS) {
    if (isDirectory(join(releaseDir, name))) return join(releaseDir, name);
  }
  return undefined;
}

/** 目标目录已有与清单一致的 release.json 且依赖已安装，可以直接复用。 */
function isReusable(target: string, manifest: ReleaseManifest): boolean {
  const payload = payloadOf(target);
  return payload !== undefined
    && existsSync(join(target, 'release.json'))
    && matchesManifest(readJson(join(target, 'release.json')), manifest)
    && isDirectory(join(payload, 'node_modules'));
}

function matchesManifest(value: unknown, manifest: ReleaseManifest): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const rel = value as Record<string, unknown>;
  return rel.product === manifest.product
    && rel.version === manifest.version
    && rel.sha === manifest.sha
    && rel.requiredSchema === manifest.requiredSchema;
}

/** current 解析出的现役版本；current 缺失时为空，指向服务目录之外时拒绝。 */
function currentOf(home: string): Current {
  const link = join(home, CURRENT_LINK);
  const path = realOrUndefined(link);
  if (path === undefined) return {};
  const homeReal = realOrUndefined(home);
  if (homeReal === undefined || !isInside(path, homeReal)) throw new StepError('refused', 'current 指向服务目录之外，未切换');
  const name = basename(dirname(path));
  const version = (readJson(join(path, 'package.json')) as { version?: unknown } | null | undefined)?.version;
  return {
    path,
    version: typeof version === 'string' && SEMVER.test(version) ? version : undefined,
    sha: SHA40.test(name) ? name : undefined,
  };
}

/** current 是符号链接：先在同目录建临时链接，再 rename 覆盖，替换是原子的。 */
function pointCurrent(home: string, payloadDir: string): void {
  const link = join(home, CURRENT_LINK);
  const tmp = join(home, `.current.${randomUUID()}.tmp`);
  try {
    symlinkSync(resolve(payloadDir), tmp);
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
 * 回收 plugin-releases 下的旧发行目录：名称为 40 位 hex、含 release.json，且不是新版本或回退目标。
 * 绝不删除 current 指向的目录（及其包含关系上的目录），不删除不含 release.json 的目录。
 */
function recycle(home: string, keep: Array<string | undefined>, log: (line: string) => void): void {
  const root = join(home, RELEASES);
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

/** 更新锁是否被存活进程持有（供退役旧定时更新器时避开它正在进行的一轮）。 */
export function updateLockHeld(home: string): boolean {
  return lockHeld(join(home, 'updater', 'lock'));
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

function sameDir(a: string, b: string): boolean {
  const ra = realOrUndefined(a);
  return ra !== undefined && ra === realOrUndefined(b);
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
