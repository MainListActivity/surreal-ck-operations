import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../src/config.ts';
import { renderCompanyAccess } from '../src/database.ts';

const JWKS = 'https://ma.example.test/.well-known/jwks.json';
const ISS = 'https://ma.example.test';
const schema055 = readFileSync(join(import.meta.dir, '..', 'schema', '055-access.surql'), 'utf8');

describe('055 公司库访问方式的渲染', () => {
  test('两个占位符全部替换，三种访问方式都用 JWKS 地址与签发方定义', () => {
    const sql = renderCompanyAccess(schema055, JWKS, ISS);
    expect(sql).not.toContain('{{');
    for (const name of ['owner', 'runner', 'automation']) {
      expect(sql).toContain(`DEFINE ACCESS OVERWRITE ${name} ON DATABASE TYPE JWT URL '${JWKS}'`);
    }
    expect(sql.match(/\$token\.iss != 'https:\/\/ma\.example\.test'/g)?.length).toBe(3);
    expect(sql.match(/DURATION FOR SESSION 15m;/g)?.length).toBe(3);
  });

  test('拒绝会改写语句的配置值，错误信息不回显配置值', () => {
    expect(() => renderCompanyAccess(schema055, "https://x.example/'; REMOVE DATABASE x; --", ISS)).toThrow('COMPANY_JWKS_URL');
    expect(() => renderCompanyAccess(schema055, 'ftp://x.example/jwks', ISS)).toThrow('COMPANY_JWKS_URL');
    expect(() => renderCompanyAccess(schema055, JWKS, "x' OR '1'='1")).toThrow('COMPANY_ISSUER');
    let message = '';
    try { renderCompanyAccess(schema055, "https://secret.example/'", ISS); } catch (error) { message = String(error); }
    expect(message).toContain('COMPANY_JWKS_URL');
    expect(message).not.toContain('secret.example');
  });

  test('替换值里的 $ 按字面写入，不当作替换模式', () => {
    const sql = renderCompanyAccess(schema055, 'https://ma.example.test/jwks$&x', ISS);
    expect(sql).toContain("URL 'https://ma.example.test/jwks$&x'");
  });
});

describe('公司库访问配置', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  test('两个配置项可选：未配置时为空，配置后经现有加载链读出', () => {
    Object.assign(process.env, { SCK_PRODUCT_ENV: '/dev/null', SURREAL_URL: 'ws://127.0.0.1:1/rpc', SURREAL_ROOT_USER: 'root', SURREAL_ROOT_PASS: 'x' });
    delete process.env.COMPANY_JWKS_URL;
    delete process.env.COMPANY_ISSUER;
    const plain = loadDatabaseConfig();
    expect(plain.companyJwksUrl).toBeUndefined();
    expect(plain.companyIssuer).toBeUndefined();
    process.env.COMPANY_JWKS_URL = JWKS;
    process.env.COMPANY_ISSUER = ISS;
    expect(loadDatabaseConfig()).toMatchObject({ companyJwksUrl: JWKS, companyIssuer: ISS });
  });
});
