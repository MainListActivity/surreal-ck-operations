// The employee entry scripts/sck.sh talks to the plugin sidecar only through the comm directory (SCK_COMM_DIR and
// SCK_COMM_KEY). It runs the live plugin client <service>/current/server/vendor/src/sck-cli.ts from <service>/current,
// with the Bun runtime the services use (scripts/bun-runtime.sh, SYS01 AC-B): SCK_BUN from the environment, then the
// SCK_BUN line of private/service.env, then runtime-bun under the service home, then ~/.bun/bin/bun. PATH is never searched.
// A missing live plugin or runtime is refused as one JSON line on stdout with exit 1. The owner subcommand posts to the
// local owner API on SCK_PREVIEW_PORT (default 18777) with the token read from private/owner-token.
// Each case runs the real script against a fake service home; a fake Bun prints one JSON line with its label, working
// directory, arguments and the comm variables it was given.
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCK = join(import.meta.dir, '..', 'scripts', 'sck.sh');
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fake Bun: prints one JSON line with its label, its working directory, its arguments and the comm variables. */
function fakeBun(path: string, label: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const body = [
    '#!/bin/sh',
    `printf '{"label":"%s","cwd":"%s","argv":"%s","commDir":"%s","commKey":"%s"}\\n' "${label}" "$(pwd -P)" "$*" "\${SCK_COMM_DIR-}" "\${SCK_COMM_KEY-}"`,
  ].join('\n') + '\n';
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

interface World { root: string; service: string; user: string; client: string }

/**
 * A service home and a user home. The live plugin client is placed at current/server/vendor/src/sck-cli.ts unless
 * `noCurrent`; there is no active/ directory. `pinned` writes an SCK_BUN line to private/service.env and creates that Bun.
 */
function world(options: { pinned?: boolean; runtime?: boolean; userBun?: boolean; noCurrent?: boolean } = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'sck-entry-'));
  roots.push(root);
  const service = join(root, 'service');
  const user = join(root, 'user');
  const client = join(service, 'current', 'server', 'vendor', 'src', 'sck-cli.ts');
  mkdirSync(join(service, 'private'), { recursive: true });
  mkdirSync(user, { recursive: true });
  if (!options.noCurrent) {
    mkdirSync(join(client, '..'), { recursive: true });
    writeFileSync(client, '// placeholder: the live plugin client\n');
  }
  if (options.pinned) {
    fakeBun(join(root, 'pinned', 'bin', 'bun'), 'pinned');
    writeFileSync(join(service, 'private', 'service.env'), `SCK_BUN="${join(root, 'pinned', 'bin', 'bun')}"\n`);
  }
  if (options.runtime) fakeBun(join(service, 'runtime-bun', 'bin', 'bun'), 'runtime');
  if (options.userBun) fakeBun(join(user, '.bun', 'bin', 'bun'), 'user');
  return { root, service, user, client };
}

/** A clean environment, so no SCK_BUN, comm or owner variable leaks in from the test runner. */
function envFor(w: World, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: w.user, SCK_SERVICE_HOME: w.service, ...extra };
}

function run(args: string[], w: World, extra: Record<string, string> = {}) {
  const result = Bun.spawnSync(['sh', SCK, ...args], { env: envFor(w, extra), stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}

interface FakeAnswer { label: string; cwd: string; argv: string; commDir: string; commKey: string }

/** The fake Bun's one JSON line. */
function answerOf(r: { code: number | null; out: string }): FakeAnswer {
  expect(r.code).toBe(0);
  expect(r.out.split('\n')).toHaveLength(1);
  return JSON.parse(r.out) as FakeAnswer;
}

/** A refusal: exactly one JSON line on stdout with the code, the reason on stderr, exit 1. */
function refusedWith(r: { code: number | null; out: string; err: string }, code: string): void {
  expect(r.code).toBe(1);
  expect(r.out.split('\n')).toHaveLength(1);
  expect(JSON.parse(r.out)).toMatchObject({ ok: false, code, retryable: false });
  expect(r.err.length).toBeGreaterThan(0);
}

test('the service.env SCK_BUN runs ahead of runtime-bun and ~/.bun, and the client runs from current', () => {
  const w = world({ pinned: true, runtime: true, userBun: true });
  const r = run(['call', 'list'], w);
  expect(answerOf(r)).toMatchObject({
    label: 'pinned',
    cwd: realpathSync(join(w.service, 'current')),
    argv: `${w.client} call list`,
  });
});

test('an SCK_BUN in the environment runs ahead of service.env', () => {
  const w = world({ pinned: true, runtime: true });
  fakeBun(join(w.root, 'env', 'bin', 'bun'), 'env');
  const r = run(['call', 'list'], w, { SCK_BUN: join(w.root, 'env', 'bin', 'bun') });
  expect(answerOf(r).label).toBe('env');
});

test('without a pinned SCK_BUN, runtime-bun under the service home runs ahead of ~/.bun', () => {
  const w = world({ runtime: true, userBun: true });
  expect(answerOf(run(['call', 'list'], w)).label).toBe('runtime');
});

test('without any pinned or service runtime, ~/.bun runs', () => {
  const w = world({ userBun: true });
  expect(answerOf(run(['call', 'list'], w)).label).toBe('user');
});

test('a Bun on PATH is never used: with no runtime the entry refuses missing_runtime', () => {
  const w = world({});
  fakeBun(join(w.root, 'pathbin', 'bun'), 'path');
  const r = run(['call', 'list'], w, { PATH: `${join(w.root, 'pathbin')}:${process.env.PATH ?? '/usr/bin:/bin'}` });
  refusedWith(r, 'missing_runtime');
  expect(r.out).not.toContain('"label"');
});

test('an SCK_BUN pin that does not exist is refused as missing_runtime, never replaced by another Bun', () => {
  const w = world({ userBun: true });
  const r = run(['call', 'list'], w, { SCK_BUN: join(w.root, 'absent', 'bun') });
  refusedWith(r, 'missing_runtime');
  expect(r.err).toContain('SCK_BUN');
});

test('no live plugin under current is refused as missing_plugin before any runtime runs', () => {
  const w = world({ runtime: true, noCurrent: true });
  const r = run(['call', 'list'], w);
  refusedWith(r, 'missing_plugin');
  expect(r.out).not.toContain('"label"');
  expect(r.err).toContain('current');
});

test('no Bun runtime at all is refused as missing_runtime with the reason on stderr', () => {
  const w = world({});
  const r = run(['call', 'list'], w);
  refusedWith(r, 'missing_runtime');
  expect(r.err).toContain('Bun runtime not found');
});

test('only current, no active directory: the call completes through comm, with the comm variables passed through', () => {
  const w = world({ pinned: true, runtime: true });
  expect(existsSync(join(w.service, 'active'))).toBe(false);
  const r = run(['call', 'get_context'], w, { SCK_COMM_DIR: join(w.service, 'comm'), SCK_COMM_KEY: 'key-from-env' });
  expect(answerOf(r)).toEqual({
    label: 'pinned',
    cwd: realpathSync(join(w.service, 'current')),
    argv: `${w.client} call get_context`,
    commDir: join(w.service, 'comm'),
    commKey: 'key-from-env',
  });
});

test('a comm-agents pointer file for PASEO_AGENT_ID overrides the spawn environment, line 1 the directory and line 2 the key', () => {
  const w = world({ pinned: true });
  mkdirSync(join(w.service, 'comm-agents'), { recursive: true });
  writeFileSync(join(w.service, 'comm-agents', 'agent-1'), 'file-comm-dir\nfile-comm-key\n');
  const r = run(['call', 'list'], w, { PASEO_AGENT_ID: 'agent-1', SCK_COMM_DIR: 'env-comm-dir', SCK_COMM_KEY: 'env-comm-key' });
  expect(answerOf(r)).toMatchObject({ commDir: 'file-comm-dir', commKey: 'file-comm-key' });
});

test('owner without a subcommand prints usage and exits 2', () => {
  const w = world({});
  const r = run(['owner'], w);
  expect(r.code).toBe(2);
  expect(r.err).toContain('usage');
});

test('owner without a readable private/owner-token is refused with exit 1 and the token is never printed', () => {
  const w = world({});
  const r = run(['owner', 'ping', '{}'], w);
  expect(r.code).toBe(1);
  expect(r.err).toContain('owner token missing');
});

test.skipIf(!existsSync('/usr/bin/python3'))('owner posts the command to SCK_PREVIEW_PORT with the file token, and never prints the token', async () => {
  const seen: Array<{ method: string; path: string; auth: string | null; agent: string | null; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        auth: request.headers.get('authorization'),
        agent: request.headers.get('x-owner-agent'),
        body: await request.json(),
      });
      return Response.json({ ok: true, answer: 42 });
    },
  });
  try {
    const w = world({});
    writeFileSync(join(w.service, 'private', 'owner-token'), 'owner-secret-token\n');
    writeFileSync(join(w.service, 'private', 'service.env'), `SCK_PREVIEW_PORT=${server.port}\n`);
    const child = Bun.spawn(['sh', SCK, 'owner', 'ping', '{"x":1}'], {
      env: envFor(w, { SCK_OWNER_AGENT: 'test-agent' }), stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(0);
    expect(JSON.parse(out)).toEqual({ ok: true, answer: 42 });
    expect(`${out}${err}`).not.toContain('owner-secret-token');
    expect(seen).toEqual([{
      method: 'POST',
      path: '/api/owner/ping',
      auth: 'Bearer owner-secret-token',
      agent: 'test-agent',
      body: { x: 1, command: 'ping' },
    }]);
  } finally {
    server.stop(true);
  }
});
