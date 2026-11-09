import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DatabaseConfig {
  url: string;
  rootUser: string;
  rootPassword: string;
  namespace: string;
  database: string;
  /** 公司库 JWT 访问（055）：签发令牌的 JWKS 地址。与 companyIssuer 同时配置才应用公司库访问方式。 */
  companyJwksUrl?: string;
  /** 公司库 JWT 访问（055）：令牌 iss 必须等于它。 */
  companyIssuer?: string;
  /** 云端执行端（COMPANY_DB_URL 配置时）：令牌模式登录；没有它就是本机 root 模式。 */
  cloud?: CloudConfig;
}

/**
 * 云端执行端的配置。secret 从不出现在配置里：这里只有凭证文件的路径，文件权限必须是 600（见 src/cloud/secret.ts）。
 * 凭证文件固定在服务目录的 private/cloud 下，不能由环境变量指向别处。
 */
export interface CloudConfig {
  /** 身份签发方，例如 https://o.maplayer.top/t/company；token 端点是 `${idpIssuer}/token`。 */
  idpIssuer: string;
  /** 执行端机密客户端的 id（RUNNER_CLIENT_ID）。 */
  runnerClientId?: string;
  /** 执行端 client secret 的凭证文件，固定为 <服务目录>/private/cloud/runner-client-secret。 */
  runnerClientSecretFile: string;
  /** 公司网关地址（GATEWAY_URL）。 */
  gatewayUrl?: string;
  /** 老板端地址（OWNER_END_URL），只用于面板里的“打开老板端”链接。 */
  ownerEndUrl?: string;
  /** 迁移专用的 migrator 客户端；只有 company-migrate 与首次开通使用。 */
  migratorClientId?: string;
  migratorClientSecretFile?: string;
}

function readProductEnv(): Record<string, string> {
  // `||` not `??`: the spawn env can inject SCK_PRODUCT_ENV set-but-empty, and '' must
  // still fall back to the default path (an explicit-but-empty value is meaningless).
  const explicit = process.env.SCK_PRODUCT_ENV;
  return readEnvFile(explicit || '/Users/y/IdeaProjects/surreal_ck/.env', !!explicit);
}

/**
 * The company's own database (`private/company-db.env`: SURREAL_URL / SURREAL_ROOT_USER / SURREAL_ROOT_PASS) once the
 * control plane runs on this Mac; it wins over the product .env, which keeps describing the product's server. Tests never
 * pick it up implicitly: its URL is local, so the non-local guard below would not stop a stray `bun test` from writing
 * into the live company database.
 */
function readCompanyEnv(): Record<string, string> {
  const explicit = process.env.SCK_COMPANY_DB_ENV;
  if (explicit) return readEnvFile(explicit, true);
  if (process.env.NODE_ENV === 'test') return {};
  const home = process.env.SCK_SERVICE_HOME || join(homedir(), 'Library/Application Support/SurrealCKCompany');
  const path = join(home, 'private/company-db.env');
  return existsSync(path) ? readEnvFile(path, true) : {};
}

function readEnvFile(path: string, required: boolean): Record<string, string> {
  // The default path is a Mac dev-machine convention; on servers everything comes
  // from the environment. Only an explicitly-set but missing file is an error.
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (required) throw error;
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function loadDatabaseConfig(): DatabaseConfig {
  const fromFile = readProductEnv();
  const company = readCompanyEnv();
  const lookup = (name: string): string | undefined => process.env[name] || company[name] || fromFile[name] || undefined;
  const get = (name: string): string => {
    const value = lookup(name);
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  // 云端执行端：COMPANY_DB_URL 存在即走令牌模式，命名空间与库来自 COMPANY_NS / COMPANY_DB（默认 company / main）。
  // 测试进程只认环境变量里显式给的云端地址：服务目录 company-db.env 里的 COMPANY_DB_URL 是生产执行端用的，
  // 测试运行器把 SURREAL_URL 指向临时 fork，不能被它盖过（否则 fork 测试全部被拒）。
  const cloudUrl = process.env.NODE_ENV === 'test' ? process.env.COMPANY_DB_URL || undefined : lookup('COMPANY_DB_URL');
  const cloud = !!cloudUrl;
  const namespace = cloud ? lookup('COMPANY_NS') ?? 'company' : process.env.SCK_COMPANY_NS ?? 'sck_agent_company';
  const database = cloud ? lookup('COMPANY_DB') ?? 'main' : process.env.SCK_COMPANY_DB ?? 'control_plane';
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(namespace) || !/^[a-z][a-z0-9_]{2,62}$/.test(database)) {
    throw new Error('Invalid company namespace/database name');
  }
  const url = cloud ? cloudUrl! : get('SURREAL_URL');
  // `bun test` loads the product .env by default, which points at the production SurrealDB server.
  // Tests must run on a local fork instead (bun scripts/test-worktrees.ts [files]).
  if (process.env.NODE_ENV === 'test' && !/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)) {
    throw new Error(`Refusing to run tests against a non-local database (${url.replace(/\/\/.*@/, '//')}); run them with: bun scripts/test-worktrees.ts <tests/file.test.ts>`);
  }
  if (cloud) {
    // 令牌模式不读 root 账号；身份与 secret 位置来自下面这些字段。secret 只在凭证文件里，配置里只有路径。
    const idpIssuer = get('IDP_ISSUER').replace(/\/+$/, '');
    const home = serviceHome();
    return {
      url,
      rootUser: '',
      rootPassword: '',
      namespace,
      database,
      companyJwksUrl: lookup('COMPANY_JWKS_URL') ?? `${idpIssuer}/jwks.json`,
      companyIssuer: lookup('COMPANY_ISSUER') ?? idpIssuer,
      cloud: {
        idpIssuer,
        runnerClientId: lookup('RUNNER_CLIENT_ID'),
        runnerClientSecretFile: join(home, 'private/cloud/runner-client-secret'),
        gatewayUrl: lookup('GATEWAY_URL'),
        ownerEndUrl: lookup('OWNER_END_URL'),
        migratorClientId: lookup('MIGRATOR_CLIENT_ID'),
        migratorClientSecretFile: join(home, 'private/cloud/migrator-client-secret'),
      },
    };
  }
  return {
    url,
    rootUser: get('SURREAL_ROOT_USER'),
    rootPassword: get('SURREAL_ROOT_PASS'),
    namespace,
    database,
    companyJwksUrl: lookup('COMPANY_JWKS_URL'),
    companyIssuer: lookup('COMPANY_ISSUER'),
  };
}

/** Service home; the same resolution the plugin and sck use. */
export const serviceHome = (): string => process.env.SCK_SERVICE_HOME || join(homedir(), 'Library/Application Support/SurrealCKCompany');
