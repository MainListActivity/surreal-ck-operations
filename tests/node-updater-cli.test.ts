import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitCodeOf, main, parsePluginRegistration, summarize } from '../scripts/node-updater.ts';

// 节点更新器 CLI 入口：没有云端配置时不回落到本机库，也不进入切换流程。
const KEYS = ['COMPANY_DB_URL', 'IDP_ISSUER', 'SURREAL_URL', 'SURREAL_ROOT_USER', 'SURREAL_ROOT_PASS', 'SCK_SERVICE_HOME'];
const SHA = 'a'.repeat(40);

let saved: Array<[string, string | undefined]>;
let home: string;

beforeEach(() => {
  saved = KEYS.map(key => [key, process.env[key]]);
  for (const key of KEYS) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), 'sck-node-cli-'));
  process.env.SCK_SERVICE_HOME = home;
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

test('生产没有 COMPANY_DB_URL：拒绝运行并说明原因，不回落到本机库，不进入切换流程', async () => {
  // 本机库配置齐全也不能用来执行升级；127.0.0.1 上没有服务，即使误连也会失败。
  process.env.SURREAL_URL = 'ws://127.0.0.1:9/rpc';
  process.env.SURREAL_ROOT_USER = 'root';
  process.env.SURREAL_ROOT_PASS = 'fixture';
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const lines: string[] = [];
    const code = await main(['run'], { log: line => lines.push(line), env: process.env, home });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('COMPANY_DB_URL');
    expect(lines.join('\n')).toContain('未切换');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('测试进程里没有云端配置：节点更新器仍只认云端，拒绝执行', async () => {
  process.env.SURREAL_URL = 'ws://127.0.0.1:9/rpc';
  process.env.SURREAL_ROOT_USER = 'root';
  process.env.SURREAL_ROOT_PASS = 'fixture';
  const lines: string[] = [];
  const code = await main(['run'], { log: line => lines.push(line), env: process.env, home });
  expect(code).toBe(1);
  expect(lines.join('\n')).toContain('只连接云端公司库');
});

test('退出码：拒绝、失败与回退返回 1，其余结果返回 0', () => {
  expect(exitCodeOf({ kind: 'refused', reason: 'x' })).toBe(1);
  expect(exitCodeOf({ kind: 'failed', reason: 'x' })).toBe(1);
  expect(exitCodeOf({ kind: 'rolled_back', reason: 'x', version: '0.6.0', sha: SHA })).toBe(1);
  expect(exitCodeOf({ kind: 'rollback_failed', reason: 'x', version: '0.6.0', sha: SHA })).toBe(1);
  expect(exitCodeOf({ kind: 'current', version: '0.6.0', sha: SHA })).toBe(0);
  expect(exitCodeOf({ kind: 'no_release' })).toBe(0);
  expect(exitCodeOf({ kind: 'deferred', reason: 'x' })).toBe(0);
  expect(exitCodeOf({ kind: 'ok', version: '0.6.0', sha: SHA })).toBe(0);
});

test('解析 paseo plugin ls 输出：无注册为 undefined，有注册取第一项', () => {
  expect(parsePluginRegistration('[]')).toBeUndefined();
  expect(parsePluginRegistration(JSON.stringify([{ path: '/srv/plugin', status: 'running', enabled: true }])))
    .toEqual({ path: '/srv/plugin', status: 'running', enabled: true });
  expect(() => parsePluginRegistration('{}')).toThrow('不是数组');
  expect(() => parsePluginRegistration('not json')).toThrow('不是合法 JSON');
});

test('结果摘要不输出地址与令牌', () => {
  const line = summarize({ kind: 'failed', reason: '连接 https://idp.example/token 失败 Bearer abc.def' });
  expect(line).toContain('结果: 失败');
  expect(line).not.toContain('idp.example');
  expect(line).not.toContain('abc.def');
});
