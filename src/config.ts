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
  const namespace = process.env.SCK_COMPANY_NS ?? 'sck_agent_company';
  const database = process.env.SCK_COMPANY_DB ?? 'control_plane';
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(namespace) || !/^[a-z][a-z0-9_]{2,62}$/.test(database)) {
    throw new Error('Invalid company namespace/database name');
  }
  const url = get('SURREAL_URL');
  // `bun test` loads the product .env by default, which points at the production SurrealDB server.
  // Tests must run on a local fork instead (bun scripts/test-worktrees.ts [files]).
  if (process.env.NODE_ENV === 'test' && !/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)) {
    throw new Error(`Refusing to run tests against a non-local database (${url.replace(/\/\/.*@/, '//')}); run them with: bun scripts/test-worktrees.ts <tests/file.test.ts>`);
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
