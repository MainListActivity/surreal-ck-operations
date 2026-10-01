import type { Role } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';

const ROLES: readonly Role[] = ['gm', 'product', 'engineering', 'ai-content', 'qa', 'cs', 'eval'];
/** Roles that may drive ops tools unless the environment narrows or widens the list. */
const DEFAULT_ROLES: Role[] = ['qa', 'engineering', 'product'];
const DEFAULT_SCOPE = 'openid profile email offline_access';

/**
 * Non-secret broker settings stored in `project_env.broker`. Credentials the broker needs
 * (Cloudflare token, sealed account passwords) never appear here: they live in the control
 * plane's environment and in sealed `env_secret` rows.
 */
export interface BrokerConfig {
  roles: Role[];
  idp: {
    issuer: string; clientId: string; audience?: string; redirectUri: string; scope: string;
    /**
     * Optional ops-audience login: a public OIDC client redeemed straight at the IdP's own
     * `/token` endpoint (`ops_login` with `audience:"ops"`). `audience` is the ops resource
     * URI the product's `/api/ops/*` routes demand; it travels on authorize as RFC 8707
     * `resource` (the only audience selector the IdP honours).
     */
    ops?: { clientId: string; audience: string; redirectUri: string };
  };
  /**
   * The operator channel: a separate public OIDC client whose tokens carry the ops audience
   * the product's `/api/ops/*` routes demand. Customer sessions can never reach them.
   */
  ops?: { clientId: string; redirectUri: string; resource?: string; scope: string };
  product: { url: string };
  accounts: { prefix: string; emailDomain: string; workspacePrefix: string };
  d1?: { tenantId: string; databaseId: string };
  data?: { url: string; namespace: string };
  browser?: { bin?: string };
  limits: { workspacesPerDay: number; accountsPerDay: number };
}

export interface ControlPlaneEnv {
  cloudflareToken?: string;
  cloudflareAccountId?: string;
  /** Test seam: points the D1 client at a fake Cloudflare API. */
  cloudflareBaseUrl?: string;
}

/** A dedicated `SCK_OPS_*` token wins so the broker can run on a narrower Cloudflare token than the developer's. */
export function controlPlaneEnv(env: Record<string, string | undefined> = process.env): ControlPlaneEnv {
  return {
    cloudflareToken: env.SCK_OPS_CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN || undefined,
    cloudflareAccountId: env.SCK_OPS_CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || undefined,
    cloudflareBaseUrl: env.SCK_OPS_CLOUDFLARE_BASE_URL || undefined,
  };
}

const invalid = (message: string) => new CompanyError('invalid', `broker config: ${message}`);

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function text(obj: Record<string, unknown>, key: string, path: string, pattern?: RegExp, fallback?: string): string {
  const value = obj[key] ?? fallback;
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) throw invalid(`${path}.${key} is missing or malformed`);
  return value;
}

/** https only; plain http is accepted for loopback so tests can run fake services. */
function url(obj: Record<string, unknown>, key: string, path: string, keepPath = false): string {
  const raw = text(obj, key, path);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw invalid(`${path}.${key} is not a URL`); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) throw invalid(`${path}.${key} must be https`);
  if (parsed.username || parsed.password) throw invalid(`${path}.${key} must not embed credentials`);
  return keepPath ? `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` : parsed.origin;
}

function limit(obj: Record<string, unknown>, key: string, fallback: number): number {
  const value = obj[key] ?? fallback;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1000) throw invalid(`limits.${key} must be an integer 0-1000`);
  return value as number;
}

export function parseBrokerConfig(raw: unknown): BrokerConfig {
  const root = record(raw, 'config');
  const roles = root.roles === undefined ? DEFAULT_ROLES : root.roles;
  if (!Array.isArray(roles) || !roles.length || roles.some(role => !ROLES.includes(role as Role))) throw invalid('roles must be a non-empty list of known roles');

  const idp = record(root.idp, 'idp');
  const product = record(root.product, 'product');
  const accounts = record(root.accounts ?? {}, 'accounts');

  const config: BrokerConfig = {
    roles: [...new Set(roles as Role[])],
    idp: {
      issuer: url(idp, 'issuer', 'idp', true),
      clientId: text(idp, 'clientId', 'idp', /^[A-Za-z0-9._-]{4,100}$/),
      audience: idp.audience === undefined ? undefined : text(idp, 'audience', 'idp'),
      redirectUri: text(idp, 'redirectUri', 'idp', /^https?:\/\/\S+$/),
      scope: text(idp, 'scope', 'idp', undefined, DEFAULT_SCOPE),
      ops: idp.ops === undefined ? undefined : (() => {
        const ops = record(idp.ops, 'idp.ops');
        return {
          clientId: text(ops, 'clientId', 'idp.ops', /^[A-Za-z0-9._-]{4,100}$/),
          audience: url(ops, 'audience', 'idp.ops', true),
          redirectUri: text(ops, 'redirectUri', 'idp.ops', /^https?:\/\/\S+$/),
        };
      })(),
    },
    product: { url: url(product, 'url', 'product') },
    accounts: {
      prefix: text(accounts, 'prefix', 'accounts', /^[a-z][a-z0-9]{1,9}-$/, 'sck-'),
      emailDomain: text(accounts, 'emailDomain', 'accounts', /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/, 'example.invalid'),
      workspacePrefix: text(accounts, 'workspacePrefix', 'accounts', /^[a-z0-9][a-z0-9-]{0,20}$/, 'sck-'),
    },
    limits: { workspacesPerDay: 6, accountsPerDay: 20 },
  };

  if (root.d1 !== undefined) {
    const d1 = record(root.d1, 'd1');
    config.d1 = {
      tenantId: text(d1, 'tenantId', 'd1', /^[A-Za-z0-9-]{8,64}$/),
      databaseId: text(d1, 'databaseId', 'd1', /^[A-Za-z0-9-]{8,64}$/),
    };
  }
  if (root.ops !== undefined) {
    const ops = record(root.ops, 'ops');
    config.ops = {
      clientId: text(ops, 'clientId', 'ops', /^[A-Za-z0-9._-]{4,100}$/),
      redirectUri: text(ops, 'redirectUri', 'ops', /^https?:\/\/\S+$/),
      resource: ops.resource === undefined ? undefined : url(ops, 'resource', 'ops', true),
      scope: text(ops, 'scope', 'ops', undefined, 'openid'),
    };
  }
  if (root.data !== undefined) {
    const data = record(root.data, 'data');
    config.data = { url: url(data, 'url', 'data'), namespace: text(data, 'namespace', 'data', /^[A-Za-z][A-Za-z0-9_]{0,62}$/) };
  }
  if (root.browser !== undefined) {
    const browser = record(root.browser, 'browser');
    config.browser = { bin: browser.bin === undefined ? undefined : text(browser, 'bin', 'browser', /^\/[^\0]+$/) };
  }
  if (root.limits !== undefined) {
    const limits = record(root.limits, 'limits');
    config.limits = { workspacesPerDay: limit(limits, 'workspacesPerDay', 6), accountsPerDay: limit(limits, 'accountsPerDay', 20) };
  }
  return config;
}
