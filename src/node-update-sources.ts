// 节点自更新的生产适配：GitHub Release 发行源（gh CLI）、tar/pnpm 打包工具与云端公司库记录。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { CompanyDatabase } from './database.ts';
import { activeLeaseCount, ensureNodeRelease, recordNodeRollback, recordNodeUpgrade, touchNodeCheck } from './node-release.ts';
import type { NodeCloud, PackageTools, ReleaseSource } from './node-updater.ts';
import { verifyReleaseSchema } from './release-schema.ts';

const execFileAsync = promisify(execFile);
export const DEFAULT_RELEASE_REPO = 'MainListActivity/surreal-ck-operations';

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
      await recordNodeUpgrade(cdb, { node, status: r.status, target: r.target?.version, at: unixSeconds(r.at), error: r.error });
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
export function githubReleaseSource(repo: string, gh = 'gh'): ReleaseSource {
  return {
    async latestTag() {
      try {
        const { stdout } = await execFileAsync(gh, ['release', 'view', '--repo', repo, '--json', 'tagName'], { timeout: 120_000, maxBuffer: 1 << 20 });
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
      await execFileAsync(gh, ['release', 'download', tag, '--repo', repo, '--pattern', asset, '--dir', dir, '--clobber'], {
        timeout: 15 * 60_000,
        maxBuffer: 1 << 20,
      });
      const produced = join(dir, asset);
      if (!existsSync(produced)) throw new Error(`发行资产未下载到：${asset}`);
      if (produced !== dest) renameSync(produced, dest);
    },
  };
}

/** 打包工具：tar 解压（不经 shell）；pnpm 锁定安装生产依赖。 */
export function packageTools(pnpm: string): PackageTools {
  return {
    async extract(tgzFile, destDir) {
      mkdirSync(destDir, { recursive: true });
      await execFileAsync('tar', ['-xzf', tgzFile, '-C', destDir], { timeout: 10 * 60_000, maxBuffer: 1 << 20 });
    },
    async installProd(payloadDir) {
      await execFileAsync(pnpm, ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'], {
        cwd: payloadDir,
        env: { ...process.env, CI: '1' },
        timeout: 20 * 60_000,
        maxBuffer: 16 << 20,
      });
    },
  };
}

function unixSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

function stderrOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === 'string' ? stderr : '';
}
