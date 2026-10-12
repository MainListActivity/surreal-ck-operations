import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyError } from '../src/core-errors.ts';
import { VaultClient } from '../src/media/vault.ts';

const ROOT = join(import.meta.dir, '..');
const TEST_BIN = join(ROOT, 'vault', 'build', 'sck-vault-test');
const SECRET = 'test-secret-7f3a-not-a-real-key';
const OUT = 'output_format=mp3_44100_128';

interface Seen { method: string; path: string; key: string | null; type: string | null; body: string }
const upstream: { seen: Seen[]; other: number } = { seen: [], other: 0 };
let upstreamPort = 0;
let otherPort = 0;
let servers: Array<{ stop(force?: boolean): void }> = [];
let dir = '';

function runVault(args: string[], socket = join(dir, 'vault.sock')) {
  return Bun.spawnSync([TEST_BIN, ...args], { env: { ...process.env, SCK_VAULT_TEST_SOCKET: socket }, stdout: 'pipe', stderr: 'pipe' });
}

async function startVault(socket: string, autoApprove: '1' | '0') {
  const proc = Bun.spawn([TEST_BIN, 'serve'], {
    env: {
      ...process.env,
      SCK_VAULT_TEST_SOCKET: socket,
      SCK_VAULT_TEST_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      SCK_VAULT_TEST_SECRET: SECRET,
      SCK_VAULT_TEST_AUTO_APPROVE: autoApprove,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  for (let i = 0; i < 200 && !existsSync(socket); i += 1) await Bun.sleep(25);
  return proc;
}

const swiftAvailable = Bun.which('swiftc') !== null;

describe('VaultClient without a running vault', () => {
  test('a missing socket is reported as not configured, never as a crash', async () => {
    const client = new VaultClient(join(tmpdir(), `sck-no-vault-${process.pid}.sock`));
    const error = await client.status().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompanyError);
    expect((error as CompanyError).code).toBe('not_configured');
  });
});

describe.skipIf(!swiftAvailable)('sck-vault end to end (test build, fake upstream)', () => {
  let vault: Awaited<ReturnType<typeof startVault>> | undefined;
  let socket = '';
  let client: VaultClient;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sck-vault-test-'));
    socket = join(dir, 'vault.sock');
    const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => { upstream.other += 1; return new Response('other host'); } });
    const up = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === 'GET' ? '' : await req.text();
        upstream.seen.push({ method: req.method, path: url.pathname + url.search, key: req.headers.get('xi-api-key'), type: req.headers.get('content-type'), body });
        if (url.pathname.startsWith('/v1/text-to-speech/')) return new Response('FAKEMP3', { headers: { 'content-type': 'audio/mpeg' } });
        if (url.pathname === '/v2/voices') return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${otherPort}/capture` } });
        if (url.pathname === '/v1/text-to-voice/design') {
          return new Response(JSON.stringify({ detail: { status: 'invalid_text', message: `rejected key ${SECRET}` } }), { status: 422, headers: { 'content-type': 'application/json' } });
        }
        if (url.pathname === '/v1/user/subscription') return Response.json({ tier: 'test' });
        return new Response('not found', { status: 404 });
      },
    });
    upstreamPort = up.port ?? 0;
    otherPort = other.port ?? 0;
    servers = [up, other];
    const build = Bun.spawnSync(['sh', join(ROOT, 'vault', 'build.sh'), '--test'], { stdout: 'pipe', stderr: 'pipe' });
    expect(build.exitCode).toBe(0);
    vault = await startVault(socket, '1');
    client = new VaultClient(socket);
  });

  afterAll(() => {
    vault?.kill();
    for (const server of servers) server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('status reports a configured vault with no grants yet', async () => {
    expect(await client.status()).toEqual({ configured: true, grants: [] });
  });

  test('a call without any grant is refused before the upstream is touched', async () => {
    const before = upstream.seen.length;
    const error = await client.call('tts', { voiceId: 'voice1', text: 'hi' }).catch((e: unknown) => e);
    expect((error as CompanyError).code).toBe('forbidden');
    expect(upstream.seen.length).toBe(before);
  });

  test('the boss grants a budget from the terminal; the grant shows up without any id a caller could reuse', () => {
    const granted = runVault(['grant', '--kinds', 'tts,voices,voice_design', '--calls', '2', '--minutes', '5'], socket);
    expect(granted.exitCode).toBe(0);
    expect(JSON.parse(granted.stdout.toString()).ok).toBe(true);
  });

  test('a granted tts call reaches the upstream with the key, on the fixed endpoint, and returns the audio bytes', async () => {
    const reply = await client.call('tts', { voiceId: 'voice1', text: 'hello', model_id: 'eleven_v3' });
    expect(reply.status).toBe(200);
    expect(reply.contentType).toBe('audio/mpeg');
    expect(reply.body.toString()).toBe('FAKEMP3');
    const seen = upstream.seen.at(-1);
    expect(seen).toMatchObject({ method: 'POST', path: `/v1/text-to-speech/voice1?${OUT}`, key: SECRET, type: 'application/json' });
    expect(JSON.parse(seen?.body ?? '{}')).toEqual({ text: 'hello', model_id: 'eleven_v3' });
  });

  test('a kind the boss did not grant is refused', async () => {
    const error = await client.call('sfx', { text: 'door' }).catch((e: unknown) => e);
    expect((error as CompanyError).code).toBe('forbidden');
  });

  test('a voice id that could change the path is refused before any request', async () => {
    const before = upstream.seen.length;
    const error = await client.call('tts', { voiceId: '../x', text: 'hi' }).catch((e: unknown) => e);
    expect((error as CompanyError).code).toBe('invalid');
    expect(upstream.seen.length).toBe(before);
  });

  test('an upstream redirect is returned, not followed, so the key never reaches another host', async () => {
    const reply = await client.call('voices', { search: 'narrator' });
    expect(reply.status).toBe(302);
    expect(upstream.other).toBe(0);
    const status = await client.status();
    expect(status.grants[0]?.callsLeft.voices).toBe(2);
  });

  test('the budget is enforced by the vault: two tts calls in total, then refused', async () => {
    const second = await client.call('tts', { voiceId: 'voice1', text: 'again' });
    expect(second.status).toBe(200);
    const third = await client.call('tts', { voiceId: 'voice1', text: 'too many' }).catch((e: unknown) => e);
    expect((third as CompanyError).code).toBe('forbidden');
  });

  test('upstream errors come back with their status and the key scrubbed out of the text', async () => {
    const reply = await client.call('voice_design', { voice_description: 'x'.repeat(30) });
    expect(reply.status).toBe(422);
    const text = reply.body.toString();
    expect(text).toContain('[已遮盖]');
    expect(text).not.toContain(SECRET);
  });

  test('the key is in neither the vault log, the audit trail, nor any reply', () => {
    const audit = join(dir, 'audit.log');
    const lines = readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every(line => typeof line.hash === 'string' && typeof line.prev === 'string')).toBe(true);
    expect(readFileSync(audit, 'utf8')).not.toContain(SECRET);
    expect(readdirSync(dir)).toContain('audit.log');
  });

  test('revoking the grant from the terminal stops every call at once', async () => {
    const status = await client.status();
    const id = status.grants[0]?.id ?? '';
    expect(id.length).toBeGreaterThan(0);
    expect(JSON.parse(runVault(['revoke', id], socket).stdout.toString()).ok).toBe(true);
    const error = await client.call('tts', { voiceId: 'voice1', text: 'after revoke' }).catch((e: unknown) => e);
    expect((error as CompanyError).code).toBe('forbidden');
  });

  test('a boss who does not approve the request leaves the vault with no grant', async () => {
    const denied = join(dir, 'denied.sock');
    const second = await startVault(denied, '0');
    try {
      const result = runVault(['grant', '--kinds', 'tts', '--calls', '5', '--minutes', '5'], denied);
      expect(JSON.parse(result.stdout.toString()).code).toBe('forbidden');
      const status = await new VaultClient(denied).status();
      expect(status.grants).toEqual([]);
      const again = runVault(['grant', '--kinds', 'tts', '--calls', '5', '--minutes', '5'], denied);
      expect(JSON.parse(again.stdout.toString()).code).toBe('busy');
    } finally {
      second.kill();
    }
  });

  test('a second vault cannot take over the socket of a running one', async () => {
    const result = Bun.spawnSync([TEST_BIN, 'serve'], {
      env: { ...process.env, SCK_VAULT_TEST_SOCKET: socket, SCK_VAULT_TEST_BASE_URL: `http://127.0.0.1:${upstreamPort}`, SCK_VAULT_TEST_SECRET: SECRET },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('已在运行');
    expect((await client.status()).configured).toBe(true);
  });
});

describe('production build', () => {
  test('the installed binary refuses to read the Keychain when it runs from anywhere but its install path', () => {
    if (!swiftAvailable) return;
    const home = mkdtempSync(join(tmpdir(), 'sck-home-'));
    const elsewhere = join(home, 'copy');
    mkdirSync(elsewhere, { recursive: true });
    try {
      const build = Bun.spawnSync(['sh', join(ROOT, 'vault', 'build.sh')], { env: { ...process.env, SCK_SERVICE_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
      expect(build.exitCode).toBe(0);
      const copy = join(elsewhere, 'sck-vault');
      copyFileSync(join(home, 'bin', 'sck-vault'), copy);
      chmodSync(copy, 0o700);
      const run = Bun.spawnSync([copy, 'serve'], { stdout: 'pipe', stderr: 'pipe' });
      expect(run.exitCode).toBe(1);
      expect(run.stderr.toString()).toContain('安装路径');
      expect(existsSync(join(home, 'vault', 'vault.sock'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
});
