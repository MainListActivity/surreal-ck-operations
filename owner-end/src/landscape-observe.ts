/**
 * VPS 实机核对（owner-end 分钟任务）：只读采集 systemctl 单元、ss 监听地址与 /etc/caddy/Caddyfile 路由，
 * 与登记表（COMPANY_LANDSCAPE）比对后落 company_meta 并按需发老板提示。
 * exec 与读文件由调用方注入：生产由 server-cron.ts 给本机实现，测试用假实现；Worker 端不注入即跳过，
 * 不在这里写库，避免把云端免费 Worker 的空观测覆盖 VPS 的真实结果。
 */
import type { Surreal } from 'surrealdb';
import { COMPANY_LANDSCAPE, hostOfService, type Drift, type ExecFn, type HostObservation } from '../../src/landscape.ts';
export type { ExecFn, ExecResult } from '../../src/landscape.ts';
import { observationFreshUntil, recordObservation } from '../../src/landscape-report.ts';
import { clip, redactText } from '../../src/ops/redact.ts';

/** 同一台主机两次实机核对的最小间隔。 */
export const OBSERVE_INTERVAL_MS = 60 * 60 * 1000;
/** Caddyfile 摘要最多保留的行数（站点地址行 + handle/reverse_proxy 行）。 */
export const CADDY_ROUTE_LINES = 100;

export type ReadFileFn = (path: string) => Promise<string>;

export interface VpsObserveDeps {
  exec: ExecFn;
  readFile: ReadFileFn;
  now?: Date;
}

export type LandscapeRunSummary =
  | { skipped: 'recent'; host: string; at: string }
  | { host: string; drift: Drift };

const failure = (step: string, error: unknown): string =>
  clip(redactText(`${step} 失败：${error instanceof Error ? error.message : String(error)}`), 200);

/** 解析 `systemctl list-units --plain --no-legend`：每行第一列是单元名，第二列 LOAD 为 not-found 的只是被依赖引用、并不存在，跳过。 */
export function parseSystemctlUnits(stdout: string): string[] {
  return stdout.split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(([unit, load]) => Boolean(unit) && load !== 'not-found')
    .map(([unit]) => unit!);
}

/** 解析 `ss -ltnH`：第四列是本地监听地址。 */
export function parseListenAddresses(stdout: string): string[] {
  return stdout.split('\n').map(line => line.trim().split(/\s+/)[3]).filter((addr): addr is string => Boolean(addr));
}

const TOP_LEVEL = /^\S/;

/** 摘取 Caddyfile 的站点地址行与 handle / handle_path / reverse_proxy 行，最多 maxLines 行。 */
export function extractCaddyRoutes(content: string, maxLines = CADDY_ROUTE_LINES): string[] {
  const routes: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // 顶格非注释行是站点地址或全局块；（ 开头的 import 片段与 } 收尾都不是地址。
    const isSiteAddress = TOP_LEVEL.test(raw) && !line.startsWith('(') && !line.startsWith('}') && !line.startsWith('import');
    const isRouteDirective = /^(handle|handle_path|reverse_proxy)\b/.test(line);
    if (isSiteAddress || isRouteDirective) {
      routes.push(line);
      if (routes.length >= maxLines) break;
    }
  }
  return routes;
}

/** 采集本机观测；任一采集项失败记 null 并加一条脱敏后的原因（不输出原始 stderr）。 */
export async function collectVpsObservation(deps: VpsObserveDeps): Promise<HostObservation> {
  const host = hostOfService(COMPANY_LANDSCAPE, 'sck-owner-backend') ?? 'vps-data';
  const errors: string[] = [];
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      errors.push(failure(name, error));
      return null;
    }
  };
  const execOk = async (name: string, command: string, args: string[]): Promise<string> => {
    const result = await deps.exec(command, args);
    if (result.code !== 0) throw new Error(`${command} 退出码 ${result.code}`);
    return result.stdout;
  };
  const units = await step('systemctl 单元采集', async () =>
    parseSystemctlUnits(await execOk('systemctl 单元采集', 'systemctl',
      ['list-units', '--type=service,timer', '--all', '--plain', '--no-legend', '--no-pager'])));
  const listen = await step('ss 监听采集', async () =>
    parseListenAddresses(await execOk('ss 监听采集', 'ss', ['-ltnH'])));
  const caddyRoutes = await step('Caddyfile 路由采集', async () => extractCaddyRoutes(await deps.readFile('/etc/caddy/Caddyfile')));
  return {
    host,
    at: (deps.now ?? new Date()).toISOString(),
    source: 'owner-cron',
    units,
    listen,
    caddyRoutes,
    errors,
  };
}

/** 距上次观测不足 OBSERVE_INTERVAL_MS 直接跳过；否则采集、比对、落库并按差异发提示。 */
export async function runVpsLandscapeCheck(db: Surreal, deps: VpsObserveDeps): Promise<LandscapeRunSummary> {
  const host = hostOfService(COMPANY_LANDSCAPE, 'sck-owner-backend') ?? 'vps-data';
  const now = deps.now ?? new Date();
  const fresh = await observationFreshUntil(db, host, now, OBSERVE_INTERVAL_MS);
  if (fresh) return { skipped: 'recent', host, at: fresh };
  const obs = await collectVpsObservation({ ...deps, now });
  const drift = await recordObservation(db, obs);
  return { host, drift };
}
