import { describe, expect, test } from 'bun:test';

import { CompanyError } from '../../src/core-errors.ts';
import { readConfig } from '../src/env.ts';
import { testEnv } from './_support.ts';

const LOCAL_DB = 'ws://127.0.0.1:55151/rpc';
const DEV_ROOT = { DEV_DB_ROOT_USER: 'root', DEV_DB_ROOT_PASS: 'local-only' };

describe('readConfig：本地 root 口令只许用于本机库', () => {
  test('没有 DEV_DB_ROOT_* 时不设置 devRoot（生产默认）', () => {
    expect(readConfig(testEnv()).devRoot).toBeUndefined();
  });

  test('库地址是本机时接受 DEV_DB_ROOT_*', () => {
    const cfg = readConfig(testEnv({ COMPANY_DB_URL: LOCAL_DB, ...DEV_ROOT }));
    expect(cfg.devRoot).toEqual({ username: 'root', password: 'local-only' });
  });

  test('库地址是生产库时拒绝配置（fail closed），不会让所有会话都以 root 连接', () => {
    let caught: unknown;
    try {
      readConfig(testEnv(DEV_ROOT));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CompanyError);
    expect((caught as CompanyError).code).toBe('not_configured');
    expect((caught as CompanyError).message).toContain('DEV_DB_ROOT_*');
  });
});

describe('readConfig：按目标的老板专属锁', () => {
  test('默认值：公司租户来自 IDP_TENANT_ID；受保护的脚本与 D1 为默认项', () => {
    const cfg = readConfig(testEnv({ IDP_TENANT_ID: '46aa29a6-9ee8-4052-bccd-7923f98220d7' }));
    expect(cfg.locks.companyTenantId).toBe('46aa29a6-9ee8-4052-bccd-7923f98220d7');
    expect(cfg.locks.scripts).toEqual(['company-owner-end', 'ma-auth']);
    expect(cfg.locks.d1Ids).toEqual(['621dbcf7-ddcc-4099-8df2-3ec076830857']);
  });

  test('PROTECTED_CF_SCRIPTS 与 PROTECTED_D1_IDS 只能追加：逗号分隔、忽略空项、小写去重，默认项不会被移除', () => {
    const cfg = readConfig(testEnv({
      PROTECTED_CF_SCRIPTS: ' Extra-Worker, ,company-owner-end',
      PROTECTED_D1_IDS: 'AAAA-1111',
    }));
    expect(cfg.locks.scripts).toEqual(['company-owner-end', 'ma-auth', 'extra-worker']);
    expect(cfg.locks.d1Ids).toEqual(['621dbcf7-ddcc-4099-8df2-3ec076830857', 'aaaa-1111']);
  });
});
