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
