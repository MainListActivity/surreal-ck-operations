import { readFileSync } from 'node:fs';

export interface DatabaseConfig {
  url: string;
  rootUser: string;
  rootPassword: string;
  namespace: string;
  database: string;
}

function readProductEnv(): Record<string, string> {
  // `||` not `??`: the spawn env can inject SCK_PRODUCT_ENV set-but-empty, and '' must
  // still fall back to the default path (an explicit-but-empty value is meaningless).
  const explicit = process.env.SCK_PRODUCT_ENV;
  const path = explicit || '/Users/y/IdeaProjects/surreal_ck/.env';
  // The default path is a Mac dev-machine convention; on servers everything comes
  // from the environment. Only an explicitly-set but missing file is an error.
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (explicit) throw error;
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
  const get = (name: string): string => {
    const value = process.env[name] || fromFile[name];
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
  };
}
