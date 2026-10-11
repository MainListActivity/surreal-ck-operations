import { afterEach, expect, test } from 'bun:test';
import { loadDatabaseConfig } from '../src/config.ts';

const saved = { ...process.env };
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
const withEnv = (url: string) => Object.assign(process.env, { SCK_PRODUCT_ENV: '/dev/null', SURREAL_URL: url, SURREAL_ROOT_USER: 'root', SURREAL_ROOT_PASS: 'x' });

test('tests may only load a local database config', () => {
  for (const url of ['ws://127.0.0.1:55139/rpc', 'ws://localhost:8000/rpc', 'wss://127.0.0.1/rpc', 'ws://[::1]:8000/rpc']) {
    withEnv(url); expect(loadDatabaseConfig().url).toBe(url);
  }
});

test('a remote database is refused under test, without echoing credentials', () => {
  withEnv('wss://root:secret@data.example.com/rpc');
  expect(() => loadDatabaseConfig()).toThrow(/Refusing to run tests against a non-local database/);
  expect(() => loadDatabaseConfig()).toThrow(/bun scripts\/test-worktrees\.ts/);
  try { loadDatabaseConfig(); } catch (error) { expect(String(error)).not.toContain('secret'); }
});

test('a look-alike host is not local', () => {
  withEnv('ws://127.0.0.1.evil.example/rpc');
  expect(() => loadDatabaseConfig()).toThrow(/Refusing/);
  withEnv('wss://localhost.example.com/rpc');
  expect(() => loadDatabaseConfig()).toThrow(/Refusing/);
});

test('outside tests the configured server is used as is', () => {
  withEnv('wss://data.example.com/rpc'); process.env.NODE_ENV = 'production';
  expect(loadDatabaseConfig().url).toBe('wss://data.example.com/rpc');
});
