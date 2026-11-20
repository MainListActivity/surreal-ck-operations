import rawLandscape from '../landscape/company-landscape.json';
/**
 * 公司服务全景：landscape/company-landscape.json 是唯一登记处（不新增服务/端口/定时器，新能力放进已登记服务）。
 * 本模块只做纯解析与比对：实机观测结果（HostObservation）与登记表的差异（Drift）由
 * landscape-report.ts 存库并发老板通知；实机采集在 owner-end 与插件各自的周期循环里。
 */
import { CompanyError } from './core-errors.ts';

export type HostKind = 'vps' | 'mac' | 'cloudflare';
export type ServiceKind = 'systemd' | 'timer' | 'launchd' | 'paseo-plugin' | 'worker' | 'pages';
export type ServiceStatus = 'active' | 'review' | 'retire' | 'stale';

export interface LandscapeHost {
  id: string;
  kind: HostKind;
  address?: string;
  names?: string[];
  notes?: string;
  /** 不属于任何登记服务也不算未登记的主机自带单元；支持 * 通配。 */
  baselineUnits: string[];
}

export interface LandscapeRepo {
  id: string;
  github: string;
  localPath?: string;
  /** 关联的公司项目（project 表 id）；同一项目不能有两个仓库登记。 */
  project?: string;
  purpose: string;
  status: 'active' | 'unknown';
}

export interface LandscapeService {
  id: string;
  repo: string;
  host: string;
  kind: ServiceKind;
  /** systemd/launchd 的单元名或 label；worker/pages 的平台资源名；paseo-plugin 的插件 id。 */
  unit: string;
  listen?: string;
  route?: string;
  deploy: string;
  rollback: string;
  health?: string;
  /** active/review 视为应存在，retire/stale 视为应消失（见 rules）。 */
  status: ServiceStatus;
  verified: boolean;
  notes?: string;
}

export interface Landscape {
  version: 1;
  updatedAt: string;
  rules: string[];
  hosts: LandscapeHost[];
  repos: LandscapeRepo[];
  services: LandscapeService[];
}

const HOST_KINDS: readonly HostKind[] = ['vps', 'mac', 'cloudflare'];
const SERVICE_KINDS: readonly ServiceKind[] = ['systemd', 'timer', 'launchd', 'paseo-plugin', 'worker', 'pages'];
const SERVICE_STATUSES: readonly ServiceStatus[] = ['active', 'review', 'retire', 'stale'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new CompanyError('invalid', `landscape: ${field} 缺失或不是字符串`);
  return value;
};

const optionalText = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CompanyError('invalid', `landscape: ${field} 不是字符串`);
  return value;
};

const textArray = (value: unknown, field: string): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new CompanyError('invalid', `landscape: ${field} 不是字符串数组`);
  }
  return value as string[];
};

const oneOf = <T extends string>(value: unknown, options: readonly T[], field: string): T => {
  if (typeof value !== 'string' || !options.includes(value as T)) {
    throw new CompanyError('invalid', `landscape: ${field} 取值 ${JSON.stringify(value)} 不合法`);
  }
  return value as T;
};

/** 解析并校验登记表；结构不合法抛 CompanyError('invalid')。 */
export function parseLandscape(raw: unknown): Landscape {
  if (!isRecord(raw)) throw new CompanyError('invalid', 'landscape: 根必须是对象');
  if (raw.version !== 1) throw new CompanyError('invalid', 'landscape: version 必须为 1');
  const updatedAt = requireText(raw.updatedAt, 'updatedAt');
  const rules = textArray(raw.rules, 'rules');
  if (!Array.isArray(raw.hosts) || !Array.isArray(raw.repos) || !Array.isArray(raw.services)) {
    throw new CompanyError('invalid', 'landscape: hosts/repos/services 必须是数组');
  }
  const unique = (ids: string[], what: string) => {
    if (new Set(ids).size !== ids.length) throw new CompanyError('invalid', `landscape: ${what} id 重复`);
  };
  const hosts: LandscapeHost[] = raw.hosts.map((row, index) => {
    if (!isRecord(row)) throw new CompanyError('invalid', `landscape: hosts[${index}] 不是对象`);
    return {
      id: requireText(row.id, `hosts[${index}].id`),
      kind: oneOf(row.kind, HOST_KINDS, `hosts[${index}].kind`),
      address: optionalText(row.address, `hosts[${index}].address`),
      names: row.names === undefined ? undefined : textArray(row.names, `hosts[${index}].names`),
      notes: optionalText(row.notes, `hosts[${index}].notes`),
      baselineUnits: textArray(row.baselineUnits, `hosts[${index}].baselineUnits`),
    };
  });
  const repos: LandscapeRepo[] = raw.repos.map((row, index) => {
    if (!isRecord(row)) throw new CompanyError('invalid', `landscape: repos[${index}] 不是对象`);
    return {
      id: requireText(row.id, `repos[${index}].id`),
      github: requireText(row.github, `repos[${index}].github`),
      localPath: optionalText(row.localPath, `repos[${index}].localPath`),
      project: optionalText(row.project, `repos[${index}].project`),
      purpose: requireText(row.purpose, `repos[${index}].purpose`),
      status: oneOf(row.status, ['active', 'unknown'] as const, `repos[${index}].status`),
    };
  });
  unique(hosts.map(host => host.id), 'hosts');
  unique(repos.map(repo => repo.id), 'repos');
  const projects = repos.map(repo => repo.project).filter((project): project is string => project !== undefined);
  unique(projects, 'repo.project');
  const hostIds = new Set(hosts.map(host => host.id));
  const repoIds = new Set(repos.map(repo => repo.id));
  const services: LandscapeService[] = raw.services.map((row, index) => {
    if (!isRecord(row)) throw new CompanyError('invalid', `landscape: services[${index}] 不是对象`);
    const service = {
      id: requireText(row.id, `services[${index}].id`),
      repo: requireText(row.repo, `services[${index}].repo`),
      host: requireText(row.host, `services[${index}].host`),
      kind: oneOf(row.kind, SERVICE_KINDS, `services[${index}].kind`),
      unit: requireText(row.unit, `services[${index}].unit`),
      listen: optionalText(row.listen, `services[${index}].listen`),
      route: optionalText(row.route, `services[${index}].route`),
      deploy: requireText(row.deploy, `services[${index}].deploy`),
      rollback: requireText(row.rollback, `services[${index}].rollback`),
      health: optionalText(row.health, `services[${index}].health`),
      status: oneOf(row.status, SERVICE_STATUSES, `services[${index}].status`),
      verified: row.verified === true,
      notes: optionalText(row.notes, `services[${index}].notes`),
    };
    if (!repoIds.has(service.repo)) throw new CompanyError('invalid', `landscape: ${service.id} 的 repo ${service.repo} 未登记`);
    if (!hostIds.has(service.host)) throw new CompanyError('invalid', `landscape: ${service.id} 的 host ${service.host} 未登记`);
    return service;
  });
  unique(services.map(service => service.id), 'services');
  return { version: 1, updatedAt, rules, hosts, repos, services };
}

/** 编译后的登记表：启动时校验，不合法直接失败，不把脏登记带进运行时。 */
export const COMPANY_LANDSCAPE: Landscape = parseLandscape(rawLandscape);

/** 采集器注入的外部命令执行器：本机 execFile 的简化契约，测试用假实现。 */
export interface ExecResult { code: number; stdout: string; stderr: string }
export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

/** 一次实机核对的结果；某项采集失败记 null 并在 errors 里写一条已脱敏的原因。 */
export interface HostObservation {
  host: string;
  at: string;
  source: 'owner-cron' | 'plugin';
  units: string[] | null;
  listen: string[] | null;
  caddyRoutes: string[] | null;
  errors: string[];
}

export interface Drift {
  host: string;
  /** units 采集失败（null）时为 true：这次比对不出结论，三个列表为空。 */
  unknown: boolean;
  /** 实机出现但既未登记也不属于主机基线的单元。 */
  undeclared: string[];
  /** 登记为应存在（active/review）但实机没有的单元。 */
  missing: string[];
  /** 登记为应消失（retire/stale）但实机仍在的单元。 */
  retireStillPresent: string[];
}

/** 参与实机比对的单元类服务；worker/pages 不在这类系统观测范围里。 */
const OBSERVED_KINDS: ReadonlySet<ServiceKind> = new Set(['systemd', 'timer', 'launchd', 'paseo-plugin']);

/** 声明了的单元全集；x.timer 同时声明 x.service（timer 一定拉起配套 service）。 */
export function declaredUnits(landscape: Landscape, host: string): Set<string> {
  const units = new Set<string>();
  for (const service of landscape.services) {
    if (service.host !== host || !OBSERVED_KINDS.has(service.kind)) continue;
    units.add(service.unit);
    if (service.unit.endsWith('.timer')) units.add(`${service.unit.slice(0, -'.timer'.length)}.service`);
  }
  return units;
}

/** baselineUnits 的 * 通配（只有 * 一个元字符，其余字面匹配）。 */
export function baselineMatch(patterns: readonly string[], unit: string): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return regex.test(unit);
  });
}

const sorted = (items: Iterable<string>): string[] => [...new Set(items)].sort();

/** 把一次实机观测与登记表比对；只覆盖该 host 上单元类服务。 */
export function compareObservation(landscape: Landscape, obs: HostObservation): Drift {
  const base: Drift = { host: obs.host, unknown: false, undeclared: [], missing: [], retireStillPresent: [] };
  if (obs.units === null) return { ...base, unknown: true };
  const observed = new Set(obs.units);
  const declared = declaredUnits(landscape, obs.host);
  const baseline = landscape.hosts.find(host => host.id === obs.host)?.baselineUnits ?? [];
  const expected: string[] = [];
  const gone: string[] = [];
  for (const service of landscape.services) {
    if (service.host !== obs.host || !OBSERVED_KINDS.has(service.kind)) continue;
    const implied = service.unit.endsWith('.timer') ? `${service.unit.slice(0, -'.timer'.length)}.service` : undefined;
    if (service.status === 'active' || service.status === 'review') {
      expected.push(service.unit);
      if (implied) expected.push(implied);
    } else {
      gone.push(service.unit);
      if (implied) gone.push(implied);
    }
  }
  return {
    host: obs.host,
    unknown: false,
    undeclared: sorted([...observed].filter(unit => !declared.has(unit) && !baselineMatch(baseline, unit))),
    missing: sorted(expected.filter(unit => !observed.has(unit))),
    retireStillPresent: sorted(gone.filter(unit => observed.has(unit))),
  };
}

/** 项目（project 表 id）经 repo.project 关联到的服务清单；无关联仓库返回空。 */
export function servicesForProject(landscape: Landscape, projectId: string):
  Array<Pick<LandscapeService, 'id' | 'host' | 'kind' | 'unit' | 'listen' | 'route' | 'deploy' | 'rollback' | 'status'>> {
  const repoIds = new Set(landscape.repos.filter(repo => repo.project === projectId).map(repo => repo.id));
  return landscape.services
    .filter(service => repoIds.has(service.repo))
    .map(({ id, host, kind, unit, listen, route, deploy, rollback, status }) =>
      ({ id, host, kind, unit, listen, route, deploy, rollback, status }));
}

/** 服务登记的主机 id；未登记返回 undefined。 */
export function hostOfService(landscape: Landscape, serviceId: string): string | undefined {
  return landscape.services.find(service => service.id === serviceId)?.host;
}
