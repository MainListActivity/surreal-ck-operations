/**
 * Worker 绑定与配置。非机密变量写在 wrangler.jsonc；密钥只用 `wrangler secret put` 设置（清单见 README）。
 * 本文件不读取 process.env，也不含任何密钥。缺少必需配置时抛 CompanyError('not_configured')。
 */
import { CompanyError } from '../../src/core-errors.ts';
import { CLIENT_TOKEN_AUDIENCE } from './idp/claims.ts';
import { lockTargetsOf, type LockTargets } from './owner-locks.ts';

/** Worker 绑定。 */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  IDP_ISSUER: string;
  IDP_JWKS_URL: string;
  CONSOLE_CLIENT_ID: string;
  IDP_TENANT_ID?: string;
  AGENT_EMAIL_DOMAIN?: string;
  COMPANY_DB_URL: string;
  COMPANY_NS: string;
  COMPANY_DB: string;
  GATEWAY_CLIENT_ID?: string;
  GATEWAY_CLIENT_SECRET?: string;
  CRON_CLIENT_ID?: string;
  CRON_CLIENT_SECRET?: string;
  VIEWER_CLIENT_ID?: string;
  VIEWER_CLIENT_SECRET?: string;
  IDP_ADMIN_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  /** 追加到默认受保护 Worker 脚本的脚本名（逗号分隔）。默认已含老板端与 ma_hono，只能追加。 */
  PROTECTED_CF_SCRIPTS?: string;
  /** 追加到默认受保护 D1 的数据库 id（逗号分隔）。默认已含 ma_hono 的库，只能追加。 */
  PROTECTED_D1_IDS?: string;
  MAGPIE_BASE_URL?: string;
  MAGPIE_MODEL?: string;
  MAGPIE_API_KEY?: string;
  /** 仅本地开发（.dev.vars）：用 root 连本机 SurrealDB；readConfig 只在库地址为本机时接受。生产配置里不存在这两项。 */
  DEV_DB_ROOT_USER?: string;
  DEV_DB_ROOT_PASS?: string;
}

export interface IdpConfig {
  /** 身份服务根地址（协议与主机），例如 https://o.maplayer.top。 */
  origin: string;
  issuer: string;
  jwksUrl: string;
  tokenUrl: string;
  authorizeUrl: string;
  audience: string;
  consoleClientId: string;
  /** 公司租户 id，用于管理 API 路径；在 wrangler.jsonc 中配置。 */
  tenantId: string;
  agentEmailDomain: string;
}

export interface DbConfig {
  url: string;
  namespace: string;
  database: string;
}

export interface ClientCredential {
  clientId: string;
  clientSecret: string;
}

/** 解析后的配置。可选分组缺失时为 undefined，使用处再报 not_configured。 */
export interface Config {
  idp: IdpConfig;
  db: DbConfig;
  /** 按目标的老板专属锁（owner-locks.ts）：公司租户、受保护的 Worker 脚本与 D1，默认值加上配置的追加项。 */
  locks: LockTargets;
  gateway?: ClientCredential;
  cron?: ClientCredential;
  viewer?: ClientCredential;
  /** ma_hono 管理 API（服务主体令牌）。tenantId 为空时只能访问不依赖租户的接口。 */
  admin?: { adminBase: string; adminToken: string; tenantId: string };
  cf?: { accountId: string; token: string };
  /** 译文服务（magpie，OpenAI 兼容 chat completions）。 */
  magpie?: { baseUrl: string; model: string; apiKey: string };
  /** 仅本地开发。 */
  devRoot?: { username: string; password: string };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

function text(value: string | undefined): string {
  return (value ?? '').trim();
}

/** 逗号分隔的列表：去首尾空白，忽略空项。 */
function listOf(value: string | undefined): string[] {
  return text(value).split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

function need(value: string | undefined, name: string): string {
  const v = text(value);
  if (!v) throw new CompanyError('not_configured', `缺少配置 ${name}`);
  return v;
}

/** https 地址；只有本机回环地址允许 http/ws（本地开发用的模拟身份服务与数据库）。 */
function endpoint(value: string, name: string, schemes: string[] = ['https:']): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CompanyError('not_configured', `${name} 不是有效地址`);
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  const allowed = schemes.includes(url.protocol) || (local && (url.protocol === 'http:' || url.protocol === 'ws:'));
  if (!allowed) throw new CompanyError('not_configured', `${name} 协议不被允许`);
  return url.href.replace(/\/$/, '');
}

/** 解析并校验配置。只读 env 对象，不做网络访问。 */
export function readConfig(env: Env): Config {
  const issuer = endpoint(need(env.IDP_ISSUER, 'IDP_ISSUER'), 'IDP_ISSUER');
  const issuerUrl = new URL(issuer);
  const idp: IdpConfig = {
    origin: issuerUrl.origin,
    issuer,
    jwksUrl: endpoint(need(env.IDP_JWKS_URL, 'IDP_JWKS_URL'), 'IDP_JWKS_URL'),
    // ma_hono 的令牌与授权端点挂在租户路径下：<issuer>/token、<issuer>/authorize。
    tokenUrl: `${issuer}/token`,
    authorizeUrl: `${issuer}/authorize`,
    audience: CLIENT_TOKEN_AUDIENCE,
    consoleClientId: need(env.CONSOLE_CLIENT_ID, 'CONSOLE_CLIENT_ID'),
    tenantId: text(env.IDP_TENANT_ID),
    agentEmailDomain: text(env.AGENT_EMAIL_DOMAIN),
  };
  const db: DbConfig = {
    url: endpoint(need(env.COMPANY_DB_URL, 'COMPANY_DB_URL'), 'COMPANY_DB_URL', ['wss:']),
    namespace: need(env.COMPANY_NS, 'COMPANY_NS'),
    database: need(env.COMPANY_DB, 'COMPANY_DB'),
  };
  const locks = lockTargetsOf(idp.tenantId, listOf(env.PROTECTED_CF_SCRIPTS), listOf(env.PROTECTED_D1_IDS));
  const config: Config = { idp, db, locks };
  if (text(env.GATEWAY_CLIENT_ID) && text(env.GATEWAY_CLIENT_SECRET)) {
    config.gateway = { clientId: text(env.GATEWAY_CLIENT_ID), clientSecret: text(env.GATEWAY_CLIENT_SECRET) };
  }
  if (text(env.CRON_CLIENT_ID) && text(env.CRON_CLIENT_SECRET)) {
    config.cron = { clientId: text(env.CRON_CLIENT_ID), clientSecret: text(env.CRON_CLIENT_SECRET) };
  }
  if (text(env.VIEWER_CLIENT_ID) && text(env.VIEWER_CLIENT_SECRET)) {
    config.viewer = { clientId: text(env.VIEWER_CLIENT_ID), clientSecret: text(env.VIEWER_CLIENT_SECRET) };
  }
  if (text(env.IDP_ADMIN_TOKEN)) {
    config.admin = { adminBase: idp.origin, adminToken: text(env.IDP_ADMIN_TOKEN), tenantId: idp.tenantId };
  }
  if (text(env.CF_ACCOUNT_ID) && text(env.CF_API_TOKEN)) {
    config.cf = { accountId: text(env.CF_ACCOUNT_ID), token: text(env.CF_API_TOKEN) };
  }
  if (text(env.MAGPIE_BASE_URL) && text(env.MAGPIE_MODEL) && text(env.MAGPIE_API_KEY)) {
    config.magpie = {
      baseUrl: endpoint(text(env.MAGPIE_BASE_URL), 'MAGPIE_BASE_URL'),
      model: text(env.MAGPIE_MODEL),
      apiKey: text(env.MAGPIE_API_KEY),
    };
  }
  if (text(env.DEV_DB_ROOT_USER) && text(env.DEV_DB_ROOT_PASS)) {
    // root 口令会让每个会话都以 root 连接（见 db.ts），只许指向本机库；误配到生产库时直接拒绝，不悄悄放开权限。
    if (!LOCAL_HOSTS.has(new URL(db.url).hostname)) {
      throw new CompanyError('not_configured', 'DEV_DB_ROOT_* 只能用于本机数据库，生产配置不得设置');
    }
    config.devRoot = { username: text(env.DEV_DB_ROOT_USER), password: text(env.DEV_DB_ROOT_PASS) };
  }
  return config;
}
