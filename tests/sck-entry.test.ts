// The employee entry scripts/sck.sh resolves its Bun runtime the way the services do (scripts/bun-runtime.sh, SYS01 AC-B):
// SCK_BUN from the environment, then the SCK_BUN line of private/service.env, then runtime-bun under the service home, then
// ~/.bun/bin/bun. PATH is never searched. Each case runs the real script against a fake service home whose Bun prints its label.
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCK = join(import.meta.dir, '..', 'scripts', 'sck.sh');
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fake Bun that prints its label and the arguments it was run with. */
function fakeBun(path: string, label: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "${label} $*"\n`);
  chmodSync(path, 0o755);
}

interface World { root: string; service: string; user: string }

/** A service home and a user home. `pinned` writes an SCK_BUN line to private/service.env and creates that Bun. */
function world(options: { pinned?: boolean; runtime?: boolean; userBun?: boolean }): World {
  const root = mkdtempSync(join(tmpdir(), 'sck-entry-'));
  roots.push(root);
  const service = join(root, 'service');
  const user = join(root, 'user');
  mkdirSync(join(service, 'active'), { recursive: true });
  mkdirSync(join(service, 'private'), { recursive: true });
  mkdirSync(user, { recursive: true });
  if (options.pinned) {
    fakeBun(join(root, 'pinned', 'bin', 'bun'), 'pinned');
    writeFileSync(join(service, 'private', 'service.env'), `SCK_MCP_PORT=38473\nSCK_BUN="${join(root, 'pinned', 'bin', 'bun')}"\n`);
  }
  if (options.runtime) fakeBun(join(service, 'runtime-bun', 'bin', 'bun'), 'runtime');
  if (options.userBun) fakeBun(join(user, '.bun', 'bin', 'bun'), 'user');
  return { root, service, user };
}

/** Runs the entry with a clean environment, so no SCK_BUN or comm variable leaks in from the test runner. */
function run(args: string[], w: World, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: w.user,
    SCK_SERVICE_HOME: w.service,
    SCK_EMPLOYEE_CREDENTIAL_FILE: join(w.user, 'credential'),
    ...extra,
  };
  const result = Bun.spawnSync(['sh', SCK, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}

test('the service.env SCK_BUN runs ahead of runtime-bun and ~/.bun', () => {
  const w = world({ pinned: true, runtime: true, userBun: true });
  const r = run(['call', 'list'], w);
  expect(r.code).toBe(0);
  expect(r.out).toBe('pinned src/mcp/client-cli.ts call list');
});

test('an SCK_BUN in the environment runs ahead of service.env', () => {
  const w = world({ pinned: true, runtime: true });
  fakeBun(join(w.root, 'env', 'bin', 'bun'), 'env');
  const r = run(['call', 'list'], w, { SCK_BUN: join(w.root, 'env', 'bin', 'bun') });
  expect(r.out).toBe('env src/mcp/client-cli.ts call list');
});

test('without a pinned SCK_BUN, runtime-bun under the service home runs ahead of ~/.bun', () => {
  const w = world({ runtime: true, userBun: true });
  expect(run(['call', 'list'], w).out).toBe('runtime src/mcp/client-cli.ts call list');
});

test('without any pinned or service runtime, ~/.bun runs', () => {
  const w = world({ userBun: true });
  expect(run(['call', 'list'], w).out).toBe('user src/mcp/client-cli.ts call list');
});

test('a Bun on PATH is never used', () => {
  const w = world({});
  fakeBun(join(w.root, 'pathbin', 'bun'), 'path');
  const r = run(['call', 'list'], w, { PATH: `${join(w.root, 'pathbin')}:${process.env.PATH ?? '/usr/bin:/bin'}` });
  expect(r.code).not.toBe(0);
  expect(r.out).not.toContain('path ');
});

test('comm mode resolves the same runtime', () => {
  const w = world({ pinned: true, runtime: true });
  const r = run(['call', 'list'], w, { SCK_COMM_DIR: join(w.service, 'comm') });
  expect(r.out).toBe('pinned src/mcp/client-cli.ts call list');
});

test('sync-gate resolves the same runtime', () => {
  const w = world({ pinned: true, runtime: true });
  const r = run(['sync-gate'], w);
  expect(r.out).toBe('pinned src/mcp/sync-gate.ts');
});
