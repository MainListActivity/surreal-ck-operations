import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyError } from '../src/core-errors.ts';
import { VaultClient } from '../src/media/vault.ts';

const ROOT = join(import.meta.dir, '..');
const TEST_BIN = join(ROOT, 'vault', 'build', 'sck-vault-test');
const SECRET = 'test-secret-7f3a-not-a-real-key';
const SYNC_SECRET = 'test-secret-sync-9e1b-not-a-real-key';
const OUT = 'output_format=mp3_44100_128';

interface Seen { method: string; path: string; key: string | null; type: string | null; body: string }
interface SyncSeen { method: string; path: string; key: string | null; xiKey: string | null; idem: string | null; body: string }
const upstream: { seen: Seen[]; other: number } = { seen: [], other: 0 };
const syncUpstream: { seen: SyncSeen[] } = { seen: [] };
let upstreamPort = 0;
let otherPort = 0;
let syncPort = 0;
let servers: Array<{ stop(force?: boolean): void }> = [];
let dir = '';

function runVault(args: string[], socket = join(dir, 'vault.sock')) {
  return Bun.spawnSync([TEST_BIN, ...args], { env: { ...process.env, SCK_VAULT_TEST_SOCKET: socket }, stdout: 'pipe', stderr: 'pipe' });
}

async function startVault(socket: string) {
  const proc = Bun.spawn([TEST_BIN, 'serve'], {
    env: {
      ...process.env,
      SCK_VAULT_TEST_SOCKET: socket,
      SCK_VAULT_TEST_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      SCK_VAULT_SYNC_TEST_BASE_URL: `http://127.0.0.1:${syncPort}`,
      SCK_VAULT_TEST_SECRET: SECRET,
      SCK_VAULT_SYNC_TEST_SECRET: SYNC_SECRET,
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
    const sup = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === 'GET' ? '' : await req.text();
        syncUpstream.seen.push({
          method: req.method, path: url.pathname + url.search, body,
          key: req.headers.get('x-api-key'), xiKey: req.headers.get('xi-api-key'),
          idem: req.headers.get('idempotency-key'),
        });
        if (url.pathname === '/v2/models') return Response.json({ models: [{ id: 'sync-3' }] });
        if (url.pathname === '/v2/errors') return Response.json([{ code: 'invalid_asset_id_format' }]);
        if (url.pathname === '/v2/projects' && req.method === 'POST') {
          return Response.json({ id: 'p-created', name: JSON.parse(body || '{}').name, organizationId: 'org-1' }, { status: 201, headers: { 'idempotency-replayed': 'false' } });
        }
        if (url.pathname === '/v2/projects') return Response.json({ items: [{ id: 'p-1', organizationId: 'org-1' }] });
        if (url.pathname === '/v2/generations') return Response.json([{ id: 'gen-1', model: 'sync-3', status: 'COMPLETED' }]);
        if (url.pathname === '/v2/generations/estimate') return Response.json({ estimatedGenerationCost: 0.5 });
        if (url.pathname === '/v2/generate' && req.method === 'POST') {
          return Response.json({ id: 'gen-1', status: 'PENDING' }, { status: 201, headers: { 'idempotency-replayed': 'false' } });
        }
        if (url.pathname.startsWith('/v2/generate/gen-leak')) {
          return new Response(`upstream echoed ${SYNC_SECRET} at https://signed.example/x?sig=abc`, { status: 500 });
        }
        if (url.pathname.startsWith('/v2/generate/')) return Response.json({ id: 'gen-1', status: 'COMPLETED' });
        if (url.pathname === '/v2/generations/gen-1/download') return new Response('https://cdn.test/out.mp4?sig=x', { headers: { 'content-type': 'text/plain' } });
        return new Response('not found', { status: 404 });
      },
    });
    syncPort = sup.port ?? 0;
    servers = [up, other, sup];
    const build = Bun.spawnSync(['sh', join(ROOT, 'vault', 'build.sh'), '--test'], { stdout: 'pipe', stderr: 'pipe' });
    expect(build.exitCode).toBe(0);
    vault = await startVault(socket);
    client = new VaultClient(socket);
  });

  afterAll(() => {
    vault?.kill();
    for (const server of servers) server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('status reports per-provider configuration with non-secret fingerprints', async () => {
    const status = await client.status();
    expect(status).toMatchObject({ configured: true });
    const fp = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
    expect(status.providers).toEqual({
      elevenlabs: { configured: true, keyFp: fp(SECRET) },
      sync: { configured: true, keyFp: fp(SYNC_SECRET) },
    });
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(JSON.stringify(status)).not.toContain(SYNC_SECRET);
  });

  test('a call reaches the upstream with the key, on the fixed endpoint', async () => {
    const reply = await client.call('tts', { voiceId: 'voice1', text: 'hello', model_id: 'eleven_v3' });
    expect(reply.status).toBe(200);
    expect(reply.contentType).toBe('audio/mpeg');
    expect(reply.body.toString()).toBe('FAKEMP3');
    const seen = upstream.seen.at(-1);
    expect(seen).toMatchObject({ method: 'POST', path: `/v1/text-to-speech/voice1?${OUT}`, key: SECRET, type: 'application/json' });
    expect(JSON.parse(seen?.body ?? '{}')).toEqual({ text: 'hello', model_id: 'eleven_v3' });
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
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.every(line => typeof line.hash === 'string' && typeof line.prev === 'string')).toBe(true);
    expect(lines.every(line => line.event === 'call')).toBe(true);
    expect(readFileSync(audit, 'utf8')).not.toContain(SECRET);
    expect(readdirSync(dir)).toContain('audit.log');
  });

  test('the grant command no longer exists: permission is code, not approval', () => {
    const result = runVault(['grant', '--kinds', 'tts', '--calls', '5'], socket);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString() + result.stdout.toString()).toContain('用法');
  });

  test('sync kinds reach the sync upstream with the sync key and the x-api-key header', async () => {
    const before = syncUpstream.seen.length;
    const reply = await client.call('sync_models', {});
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toContain('sync-3');
    const seen = syncUpstream.seen.at(-1)!;
    expect(syncUpstream.seen.length).toBe(before + 1);
    expect(seen).toMatchObject({ method: 'GET', path: '/v2/models', key: SYNC_SECRET, xiKey: null });
  });

  test('sync_generate carries the Idempotency-Key header out-of-body, and relays the replay flag', async () => {
    const reply = await client.call('sync_generate', {
      model: 'sync-3',
      input: [{ type: 'video', assetId: 'ast-1' }, { type: 'audio', assetId: 'ast-2' }],
      options: { sync_mode: 'silence' },
      idempotencyKey: 'sck-test-key-01',
    });
    expect(reply.status).toBe(201);
    expect(reply.headers?.['idempotency-replayed']).toBe('false');
    const seen = syncUpstream.seen.at(-1)!;
    expect(seen).toMatchObject({ method: 'POST', path: '/v2/generate', key: SYNC_SECRET, idem: 'sck-test-key-01' });
    expect(JSON.parse(seen.body)).toEqual({
      model: 'sync-3',
      input: [{ type: 'video', assetId: 'ast-1' }, { type: 'audio', assetId: 'ast-2' }],
      options: { sync_mode: 'silence' },
    });
  });

  test('sync_project_create is the one controlled write: pinned body and out-of-band Idempotency-Key', async () => {
    const reply = await client.call('sync_project_create', { name: 'sck-controlled', idempotencyKey: '0e1c2a6e-1111-4222-8333-444455556666' });
    expect(reply.status).toBe(201);
    expect(reply.headers?.['idempotency-replayed']).toBe('false');
    const seen = syncUpstream.seen.at(-1)!;
    expect(seen).toMatchObject({ method: 'POST', path: '/v2/projects', key: SYNC_SECRET, xiKey: null, idem: '0e1c2a6e-1111-4222-8333-444455556666' });
    expect(JSON.parse(seen.body)).toEqual({ name: 'sck-controlled' });
    // Bad name or a missing key is refused before any request leaves the vault.
    const before = syncUpstream.seen.length;
    expect((await client.call('sync_project_create', { name: '../evil', idempotencyKey: 'k' }).catch((e: unknown) => e) as CompanyError).code).toBe('invalid');
    expect((await client.call('sync_project_create', { name: 'x' }).catch((e: unknown) => e) as CompanyError).code).toBe('invalid');
    expect(syncUpstream.seen.length).toBe(before);
  });

  test('sync_get builds the mutually exclusive wait/progress queries and pins the model contract', async () => {
    await client.call('sync_get', { id: 'gen-1', wait: true, timeout: 3 });
    const waited = syncUpstream.seen.at(-1)!.path;
    expect(waited.startsWith('/v2/generate/gen-1?')).toBe(true);
    expect(waited).toContain('wait=true');
    expect(waited).toContain('timeout=3');
    await client.call('sync_get', { id: 'gen-1', include: 'progress' });
    const progressed = syncUpstream.seen.at(-1)!.path;
    expect(progressed.startsWith('/v2/generate/gen-1?')).toBe(true);
    expect(progressed).toContain('include=progress');
    const denied = await client.call('sync_get', { id: 'gen-1', wait: true, include: 'progress' }).catch((e: unknown) => e);
    expect((denied as CompanyError).code).toBe('invalid');
    const badModel = await client.call('sync_estimate', { model: 'sync-2', duration: 8 }).catch((e: unknown) => e);
    expect((badModel as CompanyError).code).toBe('invalid');
  });

  test('sync_projects and sync_generations are fixed GETs that only forward limit/cursor', async () => {
    const projects = await client.call('sync_projects', { limit: 50, cursor: 'cur-1' });
    expect(projects.status).toBe(200);
    let seen = syncUpstream.seen.at(-1)!;
    expect(seen).toMatchObject({ method: 'GET', key: SYNC_SECRET, xiKey: null });
    expect(seen.path.startsWith('/v2/projects?')).toBe(true);
    expect(seen.path).toContain('limit=50');
    expect(seen.path).toContain('cursor=cur-1');
    const generations = await client.call('sync_generations', {});
    expect(generations.status).toBe(200);
    seen = syncUpstream.seen.at(-1)!;
    expect(seen).toMatchObject({ method: 'GET', path: '/v2/generations', key: SYNC_SECRET });
    // Bad params are refused before any request.
    const before = syncUpstream.seen.length;
    expect((await client.call('sync_projects', { limit: 0 }).catch((e: unknown) => e) as CompanyError).code).toBe('invalid');
    expect((await client.call('sync_projects', { limit: 101 }).catch((e: unknown) => e) as CompanyError).code).toBe('invalid');
    expect((await client.call('sync_generations', { cursor: '../evil' }).catch((e: unknown) => e) as CompanyError).code).toBe('invalid');
    expect(syncUpstream.seen.length).toBe(before);
  });

  test('sync_download_url hits the fixed download endpoint and returns the signed URL body verbatim', async () => {
    const reply = await client.call('sync_download_url', { id: 'gen-1' });
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toBe('https://cdn.test/out.mp4?sig=x');
    expect(syncUpstream.seen.at(-1)).toMatchObject({ method: 'GET', path: '/v2/generations/gen-1/download', key: SYNC_SECRET });
    const bad = await client.call('sync_download_url', { id: '../../etc' }).catch((e: unknown) => e);
    expect((bad as CompanyError).code).toBe('invalid');
  });

  test('the sync key is scrubbed out of an upstream body just like the elevenlabs key', async () => {
    const reply = await client.call('sync_get', { id: 'gen-leak' });
    expect(reply.status).toBe(500);
    const text = reply.body.toString();
    expect(text).toContain('[已遮盖]');
    expect(text).not.toContain(SYNC_SECRET);
    const audit = readFileSync(join(dir, 'audit.log'), 'utf8');
    expect(audit).not.toContain(SYNC_SECRET);
    expect(audit).toContain('"provider":"sync"');
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
