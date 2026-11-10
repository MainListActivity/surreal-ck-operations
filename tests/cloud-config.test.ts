import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  test('测试环境未配置 COMPANY_DB_URL：用环境变量里的 root 连接（临时 fork），不带 cloud 段', () => {
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

describe('生产只连云端', () => {
  test('缺 COMPANY_DB_URL 拒绝启动并说明原因，即使 SURREAL_* 本机库配置齐全也不回落', () => {
    setEnv({
      ...cloudEnv,
      COMPANY_DB_URL: undefined,
      IDP_ISSUER: undefined,
      SURREAL_URL: 'ws://127.0.0.1:38480/rpc',
      SURREAL_ROOT_USER: 'root',
      SURREAL_ROOT_PASS: 'local-only',
    });
    process.env.NODE_ENV = 'production';
    expect(() => loadDatabaseConfig()).toThrow('未配置 COMPANY_DB_URL，拒绝启动');
    expect(() => loadDatabaseConfig()).toThrow(join(SERVICE_HOME, 'private/company-db.env'));
  });

  test('company-db.env 只读云端字段：文件里的 SURREAL_* 不生效，缺 COMPANY_DB_URL 仍拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-company-env-'));
    try {
      const file = join(dir, 'company-db.env');
      writeFileSync(file, 'SURREAL_URL=ws://127.0.0.1:38480/rpc\nSURREAL_ROOT_USER=root\nSURREAL_ROOT_PASS=local-only\n');
      setEnv({
        ...cloudEnv,
        COMPANY_DB_URL: undefined,
        IDP_ISSUER: undefined,
        SCK_COMPANY_DB_ENV: file,
        SURREAL_URL: undefined,
        SURREAL_ROOT_USER: undefined,
        SURREAL_ROOT_PASS: undefined,
      });
      process.env.NODE_ENV = 'production';
      expect(() => loadDatabaseConfig()).toThrow('未配置 COMPANY_DB_URL，拒绝启动');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('company-db.env 的云端字段照旧生效：COMPANY_DB_URL、IDP_ISSUER、RUNNER_CLIENT_ID 从文件读取，允许远端地址', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-company-env-'));
    try {
      const file = join(dir, 'company-db.env');
      writeFileSync(file, `COMPANY_DB_URL=wss://cloud.example.com/rpc\nIDP_ISSUER=https://o.maplayer.top/t/company\nRUNNER_CLIENT_ID=${RUNNER_ID}\n`);
      setEnv({ ...cloudEnv, COMPANY_DB_URL: undefined, IDP_ISSUER: undefined, RUNNER_CLIENT_ID: undefined, SCK_COMPANY_DB_ENV: file });
      process.env.NODE_ENV = 'production';
      const config = loadDatabaseConfig();
      expect(config).toMatchObject({ url: 'wss://cloud.example.com/rpc', rootUser: '', rootPassword: '' });
      expect(config.cloud).toMatchObject({ idpIssuer: 'https://o.maplayer.top/t/company', runnerClientId: RUNNER_ID });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
