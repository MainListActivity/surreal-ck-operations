/**
 * Mac 节点实机核对（执行端侧）：采集 launchctl 已加载的 org.surrealck.* label，加上
 * ~/Library/LaunchAgents 里已安装但未加载的 org.surrealck.*.plist（.plist.bak-* 备份不算），
 * 作为 units 与登记表比对（执行端自身就是其中的 org.surrealck.native.*）。只读；采集失败只记原因，不影响调度。
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Surreal } from 'surrealdb';
import { clip, redactText } from './ops/redact.ts';
import type { Drift, ExecFn, HostObservation } from './landscape.ts';
import { observationFreshUntil, recordObservation } from './landscape-report.ts';

export const MAC_HOST = 'mac-node';
const LABEL_PREFIX = 'org.surrealck.';

export interface MacObserveDeps {
  exec?: ExecFn;
  home?: string;
  listDir?: (dir: string) => Promise<string[]>;
  now?: Date;
}

const defaultExec: ExecFn = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (error && typeof code !== 'number') reject(error);
    else resolve({ code: typeof code === 'number' ? code : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});

/** 解析 `launchctl list`：三列 PID、Status、Label，label 取每行第三列。 */
export function parseLaunchctlLabels(stdout: string): string[] {
  return stdout.split('\n')
    .map(line => line.trim().split(/\s+/)[2])
    .filter((label): label is string => Boolean(label) && label!.startsWith(LABEL_PREFIX));
}

/** LaunchAgents 里 org.surrealck.*.plist 的 label（文件名去 .plist；.bak-* 备份不算）。 */
export function plistLabels(entries: readonly string[]): string[] {
  return entries
    .filter(name => name.startsWith(LABEL_PREFIX) && name.endsWith('.plist'))
    .map(name => name.slice(0, -'.plist'.length));
}

/** 采集 Mac 观测：units 是已加载与已安装 label 的并集；listen/caddyRoutes 不适用记 null。 */
export async function collectMacObservation(deps: MacObserveDeps = {}): Promise<HostObservation> {
  const exec = deps.exec ?? defaultExec;
  const listDir = deps.listDir ?? ((dir: string) => readdir(dir));
  const home = deps.home ?? homedir();
  const errors: string[] = [];
  const loaded = await exec('launchctl', ['list'])
    .then(result => result.code === 0 ? parseLaunchctlLabels(result.stdout) : Promise.reject(new Error(`launchctl 退出码 ${result.code}`)))
    .catch((error: unknown) => {
      errors.push(clip(redactText(`launchctl 采集失败：${error instanceof Error ? error.message : String(error)}`), 200));
      return null;
    });
  const installed = await listDir(join(home, 'Library', 'LaunchAgents'))
    .then(plistLabels)
    .catch((error: unknown) => {
      errors.push(clip(redactText(`LaunchAgents 采集失败：${error instanceof Error ? error.message : String(error)}`), 200));
      return null;
    });
  const units = loaded === null || installed === null
    ? null
    : [...new Set([...loaded, ...installed])].sort();
  return {
    host: MAC_HOST,
    at: (deps.now ?? new Date()).toISOString(),
    source: 'plugin',
    units,
    listen: null,
    caddyRoutes: null,
    errors,
  };
}

export type MacCheckResult = { skipped: 'recent'; at: string } | { drift: Drift };

/** 距上次观测不足 intervalMs（默认 60 分钟）跳过；否则采集、比对、落库并按差异发提示。 */
export async function checkMacLandscape(db: Surreal, deps: MacObserveDeps & { intervalMs?: number } = {}): Promise<MacCheckResult> {
  const now = deps.now ?? new Date();
  const fresh = await observationFreshUntil(db, MAC_HOST, now, deps.intervalMs ?? 60 * 60_000);
  if (fresh) return { skipped: 'recent', at: fresh };
  const obs = await collectMacObservation({ ...deps, now });
  return { drift: await recordObservation(db, obs) };
}
