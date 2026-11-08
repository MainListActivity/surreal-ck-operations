/**
 * 网关层的老板专属锁，在命令守卫（src/command-guard.ts）之外，只对员工路径生效（老板始终放行）：
 * - hardTargetOwnerOnly：按目标判定。命中即写死仅老板，员工调用被拒并写审计。覆盖：
 *   公司租户（IDP_TENANT_ID）的写操作；ma_hono 管理接口的服务主体、登录与其它管理路径的写入；
 *   老板端与 ma_hono 的 Cloudflare 资源（Worker 脚本、D1、API 令牌、自定义域名），以及请求内容里提到的公司域名。
 * - OWNER_ONLY_FOR_AGENTS：员工调用即拒绝的老板观测命令（作业与审计记录其它员工与老板的操作）。
 * 规则只看命令与输入里的目标，不看调用方身份。纯函数，不访问网络与数据库。
 */

type Input = Record<string, unknown>;

/** 锁定的目标。scripts、d1Ids 为小写；companyTenantId 为小写，空串表示未配置。 */
export interface LockTargets {
  /** 公司租户 id（IDP_TENANT_ID）。未配置时无法识别公司租户，管理接口的租户路径写入一律锁定。 */
  companyTenantId: string;
  /** 受保护的 Worker 脚本名：老板端与 ma_hono。 */
  scripts: readonly string[];
  /** 受保护的 D1 数据库 id：ma_hono 的库。 */
  d1Ids: readonly string[];
}

/** 公司租户的 slug（ma_hono 中的租户标识）。 */
export const COMPANY_SLUG = 'company';
/** 老板端的公开域名。请求内容里出现它（自定义域名等）即锁定。 */
export const COMPANY_HOST = 'company.maplayer.top';
/**
 * 认证与数据入口的域名：o.maplayer.top 提供 company 租户的 JWKS，data.maplayer.top 是 SurrealDB 入口。
 * 改它们的 DNS 或路由就能冒充签发方伪造老板令牌，所以请求内容提到它们即锁定。
 */
export const PROTECTED_HOSTS: readonly string[] = [COMPANY_HOST, 'o.maplayer.top', 'data.maplayer.top'];
/** 承载上述域名的 Cloudflare zone（maplayer.top）。该 zone 下的任何写操作（DNS、路由、证书、设置）都锁定。 */
export const DEFAULT_PROTECTED_ZONE_IDS: readonly string[] = ['6ace211d0a7ac7c16b52177a37c77f88'];
/**
 * 默认受保护的 Worker 脚本：老板端自己，以及 ma_hono（它的 wrangler 名是 ma-auth，D1 名才是 ma-hono）。
 * 配置只能追加，不能移除默认项。
 */
export const DEFAULT_PROTECTED_SCRIPTS: readonly string[] = ['company-owner-end', 'ma-auth'];
/** 默认受保护的 D1 数据库：ma_hono 的 ma-hono 库（wrangler 中的 database_id）。 */
export const DEFAULT_PROTECTED_D1_IDS: readonly string[] = ['621dbcf7-ddcc-4099-8df2-3ec076830857'];

const normalized = (values: readonly string[]): string[] =>
  values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0);

/** 合并默认项与配置项（去重、小写）。 */
export function lockTargetsOf(companyTenantId: string, scripts: readonly string[] = [], d1Ids: readonly string[] = []): LockTargets {
  return {
    companyTenantId: companyTenantId.trim().toLowerCase(),
    scripts: [...new Set(normalized([...DEFAULT_PROTECTED_SCRIPTS, ...scripts]))],
    d1Ids: [...new Set(normalized([...DEFAULT_PROTECTED_D1_IDS, ...d1Ids]))],
  };
}

/** 员工与权限页展示的按目标锁定规则（只读，与 hardTargetOwnerOnly 的判定一致）。 */
export const TARGET_LOCKS: ReadonlyArray<{ command: string; target: string }> = [
  {
    command: 'idp.*',
    target: '公司租户的写操作（公司租户的开户，客户端的创建、重置与声明）；ma_hono 的服务主体、登录与其它管理路径的写入。读取与其它租户不受限',
  },
  {
    command: 'cf.api',
    target: '老板端与 ma_hono 的 Worker（脚本及其机密、设置等子资源）与 D1 数据库，读写都锁定；API 令牌的管理；自定义域名的写入；maplayer.top 域名下的写操作（DNS、路由、证书与设置）；请求内容提到公司域名、o/data.maplayer.top 或这些资源的调用。其它账号资源不受限',
  },
];

/** 员工调用即拒绝的老板命令（网关规则，不属于 HARD_OWNER_ONLY）：作业与审计记录其它员工与老板的操作，只给老板看。 */
export const OWNER_ONLY_FOR_AGENTS: readonly string[] = ['ops.job.list', 'audit.list'];

/**
 * 按目标的硬锁。命中时返回拒绝理由（调用方据此拒绝并写审计），否则返回 undefined。
 * 只对员工路径调用；老板不经过这里。
 */
export function hardTargetOwnerOnly(command: string, input: Input, targets: LockTargets): string | undefined {
  if (command.startsWith('idp.')) return identityLock(command, input, targets);
  if (command === 'cf.api') return cloudflareLock(input, targets);
  return undefined;
}

const reason = (what: string): string => `按目标锁定：${what}，只有老板可以调用`;

/**
 * 路径切段：去掉查询串与片段、转小写、去掉空段。调用方据此判断目标，不对原始字符串做子串匹配。
 * 接口层（idp-commands.ts、cf.ts）已拒绝 . 段、空段与百分号编码，所以这里的切段与服务端归一化的结果一致。
 */
export function pathSegments(path: unknown): string[] {
  return String(path ?? '').replace(/[?#].*$/, '').toLowerCase().split('/').filter((segment) => segment.length > 0);
}

/** 身份命令里的只读项：不受按目标锁约束，命令目录也不为它们标注锁定。 */
export const IDP_READS: ReadonlySet<string> = new Set(['idp.status', 'idp.user.list_agents']);

function identityLock(command: string, input: Input, targets: LockTargets): string | undefined {
  if (IDP_READS.has(command)) return undefined;
  if (command === 'idp.tenant.create') return isCompanySlug(input) ? reason('公司租户的开户') : undefined;
  if (command === 'idp.request') return adminRequestLock(input, targets);
  // 其余 idp.* 命令（客户端的创建、重置与声明）都作用于 IDP_TENANT_ID 指向的公司租户：一律锁定。新增的写命令默认也锁。
  return reason('公司租户的客户端与密钥');
}

/** 管理接口（idp.request）：读取不受限；写入只放行其它租户的路径与其它租户的开户。 */
function adminRequestLock(input: Input, targets: LockTargets): string | undefined {
  const [root, area, ...rest] = pathSegments(input.path);
  if (root !== 'admin') return reason('非管理接口的路径');
  if (area === 'login') return reason('老板登录方式');
  if (String(input.method ?? '').toUpperCase() === 'GET') return undefined;
  if (area === 'tenants') {
    if (isCompanySlug(input.body)) return reason('公司租户的写操作');
    if (rest.length === 0) return undefined; // POST /admin/tenants：开其它租户
    // 未配置公司租户 id 时无法判断这条路径是不是公司租户：失败即锁。
    if (!targets.companyTenantId) return reason('租户的写操作（IDP_TENANT_ID 未配置，无法识别公司租户）');
    return rest.includes(targets.companyTenantId) || rest.includes(COMPANY_SLUG) ? reason('公司租户的写操作') : undefined;
  }
  // 服务主体（/admin/service-principals）与其它管理路径的写入：一律老板专属。
  return reason('服务主体与其它管理接口的写入');
}

function isCompanySlug(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const slug = (value as { slug?: unknown }).slug;
  return typeof slug === 'string' && slug.trim().toLowerCase() === COMPANY_SLUG;
}

function cloudflareLock(input: Input, targets: LockTargets): string | undefined {
  const method = String(input.method ?? '').toUpperCase();
  const [root, ...rest] = pathSegments(input.path);
  // 账号路径 /accounts/<账号>/...：账号之后的段里出现受保护的脚本或数据库，不论子路径与方法都锁定。
  if (root === 'accounts') {
    const resource = rest.slice(1);
    if (resource.some((segment) => targets.scripts.includes(segment))) return reason('老板端与 ma_hono 的 Worker');
    if (resource.some((segment) => targets.d1Ids.includes(segment))) return reason('ma_hono 的数据库');
    if (resource[0] === 'tokens') return reason('API 令牌的管理');
    if (resource[0] === 'workers' && resource[1] === 'domains' && method !== 'GET') return reason('自定义域名的写入');
  }
  if (root === 'user' && rest[0] === 'tokens') return reason('API 令牌的管理');
  if (root === 'zones' && method !== 'GET' && rest[0] !== undefined && DEFAULT_PROTECTED_ZONE_IDS.includes(rest[0])) {
    return reason('maplayer.top 域名下的写操作（DNS、路由、证书与设置）');
  }
  // 请求内容（D1 绑定、域名的服务名、DNS 记录名等）指向受保护资源时同样锁定，防止借道其它资源。
  const text = `${String(input.path ?? '')} ${input.body === undefined ? '' : JSON.stringify(input.body)}`.toLowerCase();
  if (mentionsProtected(text, targets)) return reason('请求内容指向老板端或 ma_hono 的资源（脚本、数据库或公司域名）');
  return undefined;
}

function mentionsProtected(text: string, targets: LockTargets): boolean {
  return PROTECTED_HOSTS.some((host) => text.includes(host))
    || targets.scripts.some((name) => text.includes(name))
    || targets.d1Ids.some((id) => text.includes(id));
}
