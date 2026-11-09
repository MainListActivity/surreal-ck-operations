// 节点更新器 CLI 与生产适配：node <bundle> run（默认）与 node <bundle> status。
//
// run：读取本机节点 ID、连接云端公司库（runner 角色），然后执行一轮 runNodeUpdate（见 src/node-updater.ts）。
// status：不连云端，只打印节点 ID 与插件在 paseo 中的注册情况。
// 打包：bun build scripts/node-updater.ts --target node --outfile <file>（plugin-package.ts 调用）。
//
// 环境变量：
//   SCK_RELEASE_REPO  发行仓库，缺省 MainListActivity/surreal-ck-operations
//   SCK_PASEO_BIN     paseo 可执行文件；缺省时 macOS 上存在 Paseo.app 则用它，否则 paseo
//   SCK_PNPM_BIN      pnpm 可执行文件，缺省 pnpm
//   SCK_SERVICE_HOME  服务目录（由 src/config.ts 的 serviceHome 解析）
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { loadDatabaseConfig, serviceHome } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { ensureNodeId } from '../src/node-identity.ts';
import { activeLeaseCount, ensureNodeRelease, recordNodeRollback, recordNodeUpgrade, touchNodeCheck } from '../src/node-release.ts';
import {
  runNodeUpdate,
  type NodeCloud,
  type PackageTools,
  type PluginControl,
  type PluginRegistration,
  type ReleaseSource,
  type UpdateOutcome,
} from '../src/node-updater.ts';
import { PRODUCT_ID } from '../src/release-manifest.ts';
import { verifyReleaseSchema } from '../src/release-schema.ts';
import { redactText } from '../src/ops/redact.ts';

const execFileAsync = promisify(execFile);
const DEFAULT_REPO = 'MainListActivity/surreal-ck-operations';
const MAC_PASEO_BIN = '/Applications/Paseo.app/Contents/Resources/bin/paseo';
const REASON_LIMIT = 300;

export interface CliIo {
  log(line: string): void;
  env: NodeJS.ProcessEnv;
  /** 测试注入服务目录；缺省时用 serviceHome()。 */
  home?: string;
}

/** 入口：返回退出码。argv 不含 node 与脚本路径。 */
export async function main(argv: string[], io: CliIo = { log: line => console.log(line), env: process.env }): Promise<number> {
  const command = argv[0] ?? 'run';
  if (command === 'run') return runCommand(io);
  if (command === 'status') return statusCommand(io);
  io.log('用法：node <节点更新器> [run|status]');
  return 1;
}

async function runCommand(io: CliIo): Promise<number> {
  const home = io.home ?? serviceHome();
  let node: string;
  try {
    node = ensureNodeId(home);
  } catch (error) {
    io.log(`节点 ID 读取失败：${reasonOf(error)}，未切换`);
    return 1;
  }
  let cdb: CompanyDatabase;
  try {
    cdb = await connectRunner();
  } catch (error) {
    io.log(`连接公司库失败：${reasonOf(error)}，未切换`);
    return 1;
  }
  try {
    const outcome = await runNodeUpdate({
      home,
      release: githubReleaseSource(io.env.SCK_RELEASE_REPO || DEFAULT_REPO),
      plugin: paseoPluginControl(paseoBinOf(io.env)),
      tools: packageTools(io.env.SCK_PNPM_BIN || 'pnpm'),
      cloud: nodeCloud(cdb, node),
      now: () => new Date(),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      log: io.log,
    });
    io.log(summarize(outcome));
    return exitCodeOf(outcome);
  } finally {
    await cdb.close().catch(() => undefined);
  }
}

async function statusCommand(io: CliIo): Promise<number> {
  const home = io.home ?? serviceHome();
  let node: string;
  try {
    node = ensureNodeId(home);
  } catch (error) {
    io.log(`节点 ID 读取失败：${reasonOf(error)}`);
    return 1;
  }
  io.log(`节点 ID：${node}`);
  try {
    const reg = await paseoPluginControl(paseoBinOf(io.env)).registration();
    io.log(reg === undefined
      ? `插件注册：${PRODUCT_ID} 未注册`
      : `插件注册：路径 ${reg.path}，状态 ${reg.status}，启用 ${reg.enabled ? '是' : '否'}`);
    return 0;
  } catch (error) {
    io.log(`插件注册读取失败：${reasonOf(error)}`);
    return 1;
  }
}

/**
 * 照 plugin/server/company.ts 的 runner 连接方式：连接并选定 ns/db；失败时关闭已创建的客户端。
 * 节点更新器只连接云端公司库：没有 COMPANY_DB_URL 时直接拒绝，不回落到本机 root 配置。
 */
async function connectRunner(): Promise<CompanyDatabase> {
  const config = loadDatabaseConfig();
  if (!config.cloud) throw new Error('节点更新器只连接云端公司库，请设置 COMPANY_DB_URL');
  const db = new CompanyDatabase(config, { role: 'runner' });
  try {
    await db.connect();
    await db.useDatabase();
    return db;
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
}

/** 云端适配：节点行与升级记录写入公司库，时间统一换算为 unix 秒。 */
export function nodeCloud(cdb: CompanyDatabase, node: string): NodeCloud {
  return {
    activeLeaseCount: () => activeLeaseCount(cdb, node),
    async verifySchema(version) {
      await verifyReleaseSchema(cdb.db, version);
    },
    async touchCheck(at) {
      const sec = unixSeconds(at);
      await ensureNodeRelease(cdb, { node, host: hostname(), platform: process.platform, at: sec });
      await touchNodeCheck(cdb, node, sec);
    },
    async recordUpgrade(r) {
      await recordNodeUpgrade(cdb, {
        node,
        status: r.status,
        target: r.target?.version,
        at: unixSeconds(r.at),
        error: r.error,
      });
    },
    async recordRollback(r) {
      await recordNodeRollback(cdb, {
        node,
        at: unixSeconds(r.at),
        fromVersion: r.from.version,
        fromSha: r.from.sha,
        toVersion: r.to.version,
        toSha: r.to.sha,
        reason: r.reason,
        outcome: r.outcome,
      });
    },
  };
}

/** 发行源：gh 命令行。latestTag 取 gh 的「最新」Release（不含草稿与预发布）。 */
export function githubReleaseSource(repo: string): ReleaseSource {
  return {
    async latestTag() {
      try {
        const { stdout } = await execFileAsync('gh', ['release', 'view', '--repo', repo, '--json', 'tagName'], { timeout: 120_000, maxBuffer: 1 << 20 });
        const tag = (JSON.parse(stdout) as { tagName?: unknown }).tagName;
        if (typeof tag !== 'string' || tag === '') throw new Error('gh release view 没有返回 tagName');
        return tag;
      } catch (error) {
        if (/release not found|no releases found/i.test(stderrOf(error))) return undefined;
        throw error;
      }
    },
    async download(tag, asset, dest) {
      const dir = dirname(dest);
      mkdirSync(dir, { recursive: true });
      await execFileAsync('gh', ['release', 'download', tag, '--repo', repo, '--pattern', asset, '--dir', dir, '--clobber'], {
        timeout: 15 * 60_000,
        maxBuffer: 1 << 20,
      });
      const produced = join(dir, asset);
      if (!existsSync(produced)) throw new Error(`发行资产未下载到：${asset}`);
      if (produced !== dest) renameSync(produced, dest);
    },
  };
}

/** 插件控制：paseo CLI。切换 = remove + install（reload 不改来源）；不重启 daemon。 */
export function paseoPluginControl(bin: string): PluginControl {
  const paseo = (args: string[], timeout: number) => execFileAsync(bin, args, { timeout, maxBuffer: 16 << 20 });
  return {
    async registration() {
      const { stdout } = await paseo(['plugin', 'ls', PRODUCT_ID, '--json'], 60_000);
      return parsePluginRegistration(stdout);
    },
    async remove() {
      await paseo(['plugin', 'remove', PRODUCT_ID], 120_000);
    },
    async install(pluginDir) {
      await paseo(['plugin', 'install', pluginDir, '--id', PRODUCT_ID], 300_000);
    },
  };
}

/** 解析 `paseo plugin ls <id> --json`：取第一项的 path、status、enabled；没有项即未注册。 */
export function parsePluginRegistration(text: string): PluginRegistration | undefined {
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error('paseo plugin ls 输出不是合法 JSON');
  }
  if (!Array.isArray(rows)) throw new Error('paseo plugin ls 输出不是数组');
  const first = rows[0] as { path?: unknown; status?: unknown; enabled?: unknown } | undefined;
  if (first === undefined) return undefined;
  if (typeof first !== 'object' || first === null) throw new Error('paseo plugin ls 的记录格式无效');
  return {
    path: typeof first.path === 'string' ? first.path : '',
    status: typeof first.status === 'string' ? first.status : '',
    enabled: first.enabled === true,
  };
}

/** 打包工具：tar 解压（不经 shell）；pnpm 锁定安装生产依赖。 */
export function packageTools(pnpm: string): PackageTools {
  return {
    async extract(tgzFile, destDir) {
      mkdirSync(destDir, { recursive: true });
      await execFileAsync('tar', ['-xzf', tgzFile, '-C', destDir], { timeout: 10 * 60_000, maxBuffer: 1 << 20 });
    },
    async installProd(pluginDir) {
      await execFileAsync(pnpm, ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'], {
        cwd: pluginDir,
        env: { ...process.env, CI: '1' },
        timeout: 20 * 60_000,
        maxBuffer: 16 << 20,
      });
    },
  };
}

export function paseoBinOf(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): string {
  if (env.SCK_PASEO_BIN) return env.SCK_PASEO_BIN;
  if (process.platform === 'darwin' && exists(MAC_PASEO_BIN)) return MAC_PASEO_BIN;
  return 'paseo';
}

/** 一行中文摘要。 */
export function summarize(outcome: UpdateOutcome): string {
  switch (outcome.kind) {
    case 'current': return `结果: 已是最新 版本=${outcome.version} sha=${outcome.sha}`;
    case 'no_release': return '结果: 没有正式发行版本';
    case 'deferred': return `结果: 暂缓 原因=${sanitize(outcome.reason)}`;
    case 'refused': return `结果: 拒绝 原因=${sanitize(outcome.reason)}`;
    case 'failed': return `结果: 失败 原因=${sanitize(outcome.reason)}`;
    case 'ok': return `结果: 升级成功 版本=${outcome.version} sha=${outcome.sha}`;
    case 'rolled_back': return `结果: 已回退 版本=${outcome.version} 原因=${sanitize(outcome.reason)}`;
    case 'rollback_failed': return `结果: 回退失败 版本=${outcome.version} 原因=${sanitize(outcome.reason)}`;
  }
}

/** refused / failed / rolled_back / rollback_failed 为 1，其余为 0。 */
export function exitCodeOf(outcome: UpdateOutcome): number {
  return outcome.kind === 'refused' || outcome.kind === 'failed' || outcome.kind === 'rolled_back' || outcome.kind === 'rollback_failed' ? 1 : 0;
}

function unixSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

function stderrOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === 'string' ? stderr : '';
}

/** 原因文本：去掉地址与 Bearer 令牌，屏蔽 JWT，压缩空白并限制长度。 */
function sanitize(text: string): string {
  return redactText(text)
    .replace(/\b(?:wss?|https?):\/\/\S+/gi, '<地址已隐藏>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <已隐藏>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REASON_LIMIT) || '未知错误';
}

function reasonOf(error: unknown): string {
  return sanitize(error instanceof Error ? error.message : String(error));
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
