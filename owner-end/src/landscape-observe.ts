/**
 * VPS 实机核对（owner-end 分钟任务）：只读采集 systemctl 单元、ss 监听地址与 Caddy 管理接口路由
 * （sck-owner 用户读不了 /etc/caddy/Caddyfile，改读 127.0.0.1:2019），与登记表（COMPANY_LANDSCAPE）
 * 比对后落 company_meta 并按需发老板提示。
 * exec 与 fetch 由调用方注入：生产由 server-cron.ts 给本机实现，测试用假实现；Worker 端不注入即跳过，
 * 不在这里写库，避免把云端免费 Worker 的空观测覆盖 VPS 的真实结果。
 */
import type { Surreal } from 'surrealdb';
import { COMPANY_LANDSCAPE, hostOfService, type Drift, type ExecFn, type HostObservation } from '../../src/landscape.ts';
export type { ExecFn, ExecResult } from '../../src/landscape.ts';
import { observationFreshUntil, recordObservation } from '../../src/landscape-report.ts';
import { clip, redactText } from '../../src/ops/redact.ts';

/** 同一台主机两次实机核对的最小间隔。 */
export const OBSERVE_INTERVAL_MS = 60 * 60 * 1000;
/** Caddy 路由摘要最多保留的行数。 */
export const CADDY_ROUTE_LINES = 100;
/** Caddy 管理接口地址与超时：读 servers 配置的 GET，不给它拖住分钟任务的时间。 */
export const CADDY_ADMIN_URL = 'http://127.0.0.1:2019/config/apps/http/servers';
const CADDY_ADMIN_TIMEOUT_MS = 5_000;

export interface VpsObserveDeps {
  exec: ExecFn;
  /** Caddy 管理接口的请求实现（server-cron 注入全局 fetch；缺省时退回全局 fetch）。 */
  fetch?: typeof fetch;
  now?: Date;
}

export type LandscapeRunSummary =
  | { skipped: 'recent'; host: string; at: string }
  | { host: string; drift: Drift };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

interface RouteMatch { hosts: Set<string>; paths: Set<string> }

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** 把 route.match 的 host/path 匹配并进 ctx（subroute 的路由继承外层匹配）。 */
const mergedMatch = (route: Record<string, unknown>, ctx: RouteMatch): RouteMatch => {
  const merged = { hosts: new Set(ctx.hosts), paths: new Set(ctx.paths) };
  for (const match of Array.isArray(route.match) ? route.match : []) {
    if (!isRecord(match)) continue;
    for (const host of strings(match.host)) merged.hosts.add(host);
    for (const path of strings(match.path)) merged.paths.add(path);
  }
  return merged;
};

const handlerTarget = (handler: Record<string, unknown>): string => {
  if (handler.handler === 'reverse_proxy') {
    const dials = Array.isArray(handler.upstreams)
      ? handler.upstreams.map(upstream => isRecord(upstream) && typeof upstream.dial === 'string' ? upstream.dial : '?')
      : [];
    return dials.join(',') || 'reverse_proxy';
  }
  return typeof handler.handler === 'string' ? handler.handler : '?';
};

const walkRoutes = (routes: unknown, ctx: RouteMatch, out: string[], maxLines: number): void => {
  if (!Array.isArray(routes)) return;
  for (const route of routes) {
    if (out.length >= maxLines) return;
    if (!isRecord(route)) continue;
    const match = mergedMatch(route, ctx);
    const handles = Array.isArray(route.handle) ? route.handle.filter(isRecord) : [];
    const subroutes = handles.filter(handler => handler.handler === 'subroute');
    if (subroutes.length) {
      for (const subroute of subroutes) walkRoutes(subroute.routes, match, out, maxLines);
      continue;
    }
    const targets = handles.map(handlerTarget);
    out.push(`${[...match.hosts].join(',') || '*'} ${[...match.paths].join(',') || '*'} -> ${targets.join(',') || '?'}`);
  }
};

/** 把 Caddy 管理接口 /config/apps/http/servers 的 JSON 摘要成路由行；畸形输入返回空数组，不抛错。 */
export function extractCaddyAdminRoutes(json: unknown, maxLines = CADDY_ROUTE_LINES): string[] {
  if (!isRecord(json)) return [];
  const out: string[] = [];
  for (const server of Object.values(json)) {
    if (out.length >= maxLines) break;
    if (!isRecord(server)) continue;
    // servers.*.listen 仅用于确认这是 http 服务器对象；路由行本身不输出监听口。
    if (server.listen !== undefined && !Array.isArray(server.listen)) continue;
    walkRoutes(server.routes, { hosts: new Set(), paths: new Set() }, out, maxLines);
  }
  return out;
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
  const execOk = async (command: string, args: string[]): Promise<string> => {
    const result = await deps.exec(command, args);
    if (result.code !== 0) throw new Error(`${command} 退出码 ${result.code}`);
    return result.stdout;
  };
  const units = await step('systemctl 单元采集', async () =>
    parseSystemctlUnits(await execOk('systemctl',
      ['list-units', '--type=service,timer', '--all', '--plain', '--no-legend', '--no-pager'])));
  const listen = await step('ss 监听采集', async () =>
    parseListenAddresses(await execOk('ss', ['-ltnH'])));
  const caddyRoutes = await step('Caddy 路由采集', async () => {
    const fetchFn = deps.fetch ?? fetch;
    const response = await fetchFn(CADDY_ADMIN_URL, { signal: AbortSignal.timeout(CADDY_ADMIN_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Caddy 管理接口 HTTP ${response.status}`);
    return extractCaddyAdminRoutes(await response.json());
  });
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
