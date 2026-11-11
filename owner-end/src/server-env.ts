import { readConfig, type Env } from './env.ts';

export type ServerEnvironment = Env & { OWNER_RELEASE_VERSION?: string; OWNER_RELEASE_SHA?: string };

/** 仅取业务配置白名单；调用者负责通过 --no-env-file 或服务管理器提供环境。 */
export function readServerEnvironment(source: Record<string, string | undefined>): ServerEnvironment {
  if (source.DEV_DB_ROOT_USER || source.DEV_DB_ROOT_PASS)
    throw Error('云端入口不得设置 DEV_DB_ROOT_USER 或 DEV_DB_ROOT_PASS');
  const env: ServerEnvironment = {
    ASSETS: { fetch: async () => new Response('Not Found', { status: 404 }) },
    IDP_ISSUER: source.IDP_ISSUER ?? '',
    IDP_JWKS_URL: source.IDP_JWKS_URL ?? '',
    CONSOLE_CLIENT_ID: source.CONSOLE_CLIENT_ID ?? '',
    IDP_TENANT_ID: source.IDP_TENANT_ID,
    AGENT_EMAIL_DOMAIN: source.AGENT_EMAIL_DOMAIN,
    COMPANY_DB_URL: source.COMPANY_DB_URL ?? '',
    COMPANY_NS: source.COMPANY_NS ?? '',
    COMPANY_DB: source.COMPANY_DB ?? '',
    GATEWAY_CLIENT_ID: source.GATEWAY_CLIENT_ID,
    GATEWAY_CLIENT_SECRET: source.GATEWAY_CLIENT_SECRET,
    CRON_CLIENT_ID: source.CRON_CLIENT_ID,
    CRON_CLIENT_SECRET: source.CRON_CLIENT_SECRET,
    VIEWER_CLIENT_ID: source.VIEWER_CLIENT_ID,
    VIEWER_CLIENT_SECRET: source.VIEWER_CLIENT_SECRET,
    IDP_ADMIN_TOKEN: source.IDP_ADMIN_TOKEN,
    CF_ACCOUNT_ID: source.CF_ACCOUNT_ID,
    CF_API_TOKEN: source.CF_API_TOKEN,
    PROTECTED_CF_SCRIPTS: source.PROTECTED_CF_SCRIPTS,
    PROTECTED_D1_IDS: source.PROTECTED_D1_IDS,
    MAGPIE_BASE_URL: source.MAGPIE_BASE_URL,
    MAGPIE_MODEL: source.MAGPIE_MODEL,
    MAGPIE_API_KEY: source.MAGPIE_API_KEY,
    OWNER_RELEASE_VERSION: source.OWNER_RELEASE_VERSION,
    OWNER_RELEASE_SHA: source.OWNER_RELEASE_SHA,
  };
  readConfig(env);
  return env;
}
