import { afterEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../src/config.ts';

// 只检查配置的读取规则，不连库；URL 用本机地址，避开非本地数据库的测试守卫。
const saved = { ...process.env };
const SERVICE_HOME = join(tmpdir(), 'sck-cloud-config-home');
const RUNNER_ID = '35693f72-02de-4c01-bace-607e68c9d751';

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const cloudEnv = {
  SCK_PRODUCT_ENV: '/dev/null',
  SCK_SERVICE_HOME: SERVICE_HOME,
  COMPANY_DB_URL: 'ws://127.0.0.1:8000/rpc',
  COMPANY_NS: undefined,
  COMPANY_DB: undefined,
  IDP_ISSUER: 'https://o.maplayer.top/t/company/',
  RUNNER_CLIENT_ID: RUNNER_ID,
  GATEWAY_URL: 'https://gateway.example.test',
  OWNER_END_URL: 'https://owner.example.test',
  SURREAL_ROOT_USER: undefined,
  SURREAL_ROOT_PASS: undefined,
};

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe('云端执行端配置', () => {
  test('配置 COMPANY_DB_URL 即走令牌模式：命名空间与库默认 company / main，不读 root 账号', () => {
    setEnv(cloudEnv);
    const config = loadDatabaseConfig();
    expect(config).toMatchObject({ url: 'ws://127.0.0.1:8000/rpc', rootUser: '', rootPassword: '', namespace: 'company', database: 'main' });
    expect(config.cloud).toMatchObject({
      idpIssuer: 'https://o.maplayer.top/t/company',
      runnerClientId: RUNNER_ID,
      gatewayUrl: 'https://gateway.example.test',
      ownerEndUrl: 'https://owner.example.test',
    });
  });

  test('凭证路径固定在服务目录的 private/cloud 下，环境变量不能把它指向别处', () => {
    setEnv({ ...cloudEnv, RUNNER_CLIENT_SECRET_FILE: '/etc/hosts', MIGRATOR_CLIENT_SECRET_FILE: '/etc/hosts' });
    const { cloud } = loadDatabaseConfig();
    expect(cloud?.runnerClientSecretFile).toBe(join(SERVICE_HOME, 'private/cloud/runner-client-secret'));
    expect(cloud?.migratorClientSecretFile).toBe(join(SERVICE_HOME, 'private/cloud/migrator-client-secret'));
  });

  test('配置了 COMPANY_DB_URL 却缺 IDP_ISSUER：报缺项，不退回 root 模式', () => {
    setEnv({ ...cloudEnv, IDP_ISSUER: undefined });
    expect(() => loadDatabaseConfig()).toThrow('Missing IDP_ISSUER');
  });

  test('未配置 COMPANY_DB_URL：仍是本机 root 模式，不带 cloud 段', () => {
    setEnv({
      ...cloudEnv,
      COMPANY_DB_URL: undefined,
      IDP_ISSUER: undefined,
      SURREAL_URL: 'ws://127.0.0.1:1/rpc',
      SURREAL_ROOT_USER: 'root',
      SURREAL_ROOT_PASS: 'local-only',
    });
    const config = loadDatabaseConfig();
    expect(config).toMatchObject({ url: 'ws://127.0.0.1:1/rpc', rootUser: 'root', rootPassword: 'local-only' });
    expect(config.cloud).toBeUndefined();
  });
});
