import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { egoBrowserInjector } from '../src/ops/browser.ts';
import { controlPlaneEnv, parseBrokerConfig } from '../src/ops/config.ts';
import { cloudflareD1 } from '../src/ops/d1.ts';
import type { Fetcher } from '../src/ops/fetcher.ts';
import { LoginError, jwtExpiry, passwordLogin } from '../src/ops/idp.ts';
import { generatePassword, hashPassword, verifyPassword } from '../src/ops/password.ts';
import { assertProductPath } from '../src/ops/product.ts';
import { clip, redactJson, redactText } from '../src/ops/redact.ts';
import { SessionStore } from '../src/ops/sessions.ts';
import { brokerConfig, FakeWorld } from './support/ops-world.ts';

const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code?: string; reason?: string }; }
  throw new Error('expected failure');
};

describe('password hashes', () => {
  /** The IdP's own verifier (ma_hono src/domain/users/passwords.ts), WebCrypto based. */
  const idpVerify = async (password: string, stored: string) => {
    const [, iterations, salt, digest] = stored.split('$');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(salt!, 'base64url'), iterations: Number(iterations) }, key, 256);
    return Buffer.from(bits).toString('base64url') === digest;
  };

  test('hashes verify in the IdP and the IdP verifier format verifies here', async () => {
    const password = generatePassword();
    const stored = await hashPassword(password);
    expect(stored).toMatch(/^pbkdf2_sha256\$100000\$[\w-]+\$[\w-]+$/);
    expect(await idpVerify(password, stored)).toBe(true);
    expect(await verifyPassword(password, stored)).toBe(true);
    expect(await verifyPassword(`${password}x`, stored)).toBe(false);

    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('密码-ünï'), 'PBKDF2', false, ['deriveBits']);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
    const fromIdp = ['pbkdf2_sha256', '100000', Buffer.from(salt).toString('base64url'), Buffer.from(bits).toString('base64url')].join('$');
    expect(await verifyPassword('密码-ünï', fromIdp)).toBe(true);
  });

  test('malformed or hostile hashes never verify', async () => {
    for (const stored of ['', 'plain', 'pbkdf2_sha256$100000$salt', 'argon2$1$a$b', 'pbkdf2_sha256$0$a$b', 'pbkdf2_sha256$99999999999$a$b', 'pbkdf2_sha256$100000$a$b$c']) {
      expect(await verifyPassword('anything', stored)).toBe(false);
    }
  });

  test('generated passwords are long and unique', () => {
    const seen = new Set(Array.from({ length: 20 }, generatePassword));
    expect(seen.size).toBe(20);
    for (const password of seen) expect(password.length).toBeGreaterThanOrEqual(32);
  });
});

describe('redaction', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0abcd.c2lnbmF0dXJlLXZhbHVl';

  test('text loses JWT-shaped strings and known secrets', () => {
    expect(redactText(`Bearer ${jwt} then hunter2hunter2`, ['hunter2hunter2'])).toBe('Bearer [redacted] then [redacted]');
    expect(redactText('short ab', ['ab'])).toBe('short ab'); // too short to be a useful needle
  });

  test('json loses secret-named fields at any depth', () => {
    const out = redactJson({ ok: 1, access_token: 'x', nested: [{ password: 'p', note: `t=${jwt}`, fine: 'keep' }], refreshToken: 'r', authorization: 'a' }) as any;
    expect(out).toEqual({ ok: 1, access_token: '[redacted]', nested: [{ password: '[redacted]', note: 't=[redacted]', fine: 'keep' }], refreshToken: '[redacted]', authorization: '[redacted]' });
  });

  test('deeply nested input is cut off instead of recursing forever', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 30; i++) deep = { next: deep };
    expect(JSON.stringify(redactJson(deep))).toContain('[redacted]');
  });

  test('clip keeps surrogate pairs whole', () => {
    expect(clip('abcdef', 10)).toBe('abcdef');
    expect(clip('abcdef', 3)).toStartWith('abc…[truncated 3 chars]');
    const emoji = '😀😀😀';
    expect(clip(emoji, 3).startsWith('😀')).toBe(true);
    expect(clip(emoji, 3)).not.toContain('\ud83d…');
  });
});

describe('broker config', () => {
  test('a minimal config gets safe defaults', () => {
    const cfg = parseBrokerConfig({
      idp: { issuer: 'https://o.example.test/t/ck/', clientId: 'client-1234', redirectUri: 'https://app.example.test/cb' },
      product: { url: 'https://app.example.test/' },
    });
    expect(cfg.roles).toEqual(['qa', 'engineering', 'product']);
    expect(cfg.idp).toMatchObject({ issuer: 'https://o.example.test/t/ck', scope: 'openid profile email offline_access' });
    expect(cfg.product.url).toBe('https://app.example.test');
    expect(cfg.accounts).toEqual({ prefix: 'sck-', emailDomain: 'example.invalid', workspacePrefix: 'sck-' });
    expect(cfg.limits).toEqual({ workspacesPerDay: 6, accountsPerDay: 20 });
    expect(cfg.d1).toBeUndefined();
  });

  test('loopback http is allowed for fakes; other plain http and embedded credentials are not', () => {
    const base = brokerConfig();
    expect(() => parseBrokerConfig({ ...base, product: { url: 'http://127.0.0.1:9000' } })).not.toThrow();
    expect(() => parseBrokerConfig({ ...base, product: { url: 'http://app.test' } })).toThrow(/https/);
    expect(() => parseBrokerConfig({ ...base, product: { url: 'https://user:pw@app.test' } })).toThrow(/credentials/);
    expect(() => parseBrokerConfig({ ...base, idp: { ...base.idp, issuer: 'not a url' } })).toThrow(/URL/);
  });

  test('roles, ids and limits are validated', () => {
    const base = brokerConfig();
    expect(() => parseBrokerConfig({ ...base, roles: ['root'] })).toThrow(/roles/);
    expect(() => parseBrokerConfig({ ...base, roles: [] })).toThrow(/roles/);
    expect(() => parseBrokerConfig({ ...base, accounts: { prefix: 'Bad_', emailDomain: 'example.test' } })).toThrow(/prefix/);
    expect(() => parseBrokerConfig({ ...base, d1: { tenantId: 'x', databaseId: 'y' } })).toThrow(/d1/);
    expect(() => parseBrokerConfig({ ...base, limits: { workspacesPerDay: -1 } })).toThrow(/limits/);
    expect(() => parseBrokerConfig({ ...base, browser: { bin: 'relative/path' } })).toThrow(/browser/);
    expect(() => parseBrokerConfig(null)).toThrow(/object/);
    expect(parseBrokerConfig({ ...base, roles: ['qa', 'qa'] }).roles).toEqual(['qa']);
  });

  test('control-plane credentials: a dedicated ops token wins over the developer token', () => {
    expect(controlPlaneEnv({ CLOUDFLARE_API_TOKEN: 'dev', CLOUDFLARE_ACCOUNT_ID: 'a1' }))
      .toMatchObject({ cloudflareToken: 'dev', cloudflareAccountId: 'a1' });
    expect(controlPlaneEnv({ CLOUDFLARE_API_TOKEN: 'dev', SCK_OPS_CLOUDFLARE_API_TOKEN: 'ops', SCK_OPS_CLOUDFLARE_ACCOUNT_ID: 'a2' }))
      .toMatchObject({ cloudflareToken: 'ops', cloudflareAccountId: 'a2' });
    expect(controlPlaneEnv({}).cloudflareToken).toBeUndefined();
  });
});

describe('product paths', () => {
  test('only /api/ paths pass, and never the token proxy', () => {
    expect(assertProductPath('/api/session/workspaces')).toBe('/api/session/workspaces');
    expect(assertProductPath('/api/workspaces/sck-x/members?limit=5')).toContain('members');
    for (const path of ['/api/auth/token', '/api/auth', '/api/auth/', '/admin', 'api/x', '/api/../x', '/api/./x', '/api//x', 'https://x.test/api/a', '/api/x\n', '/api/' + 'a'.repeat(2100), 5]) {
      expect(() => assertProductPath(path)).toThrow();
    }
  });
});

describe('cloudflare d1 client', () => {
  const options = (fetcher: Fetcher) => ({ accountId: 'acct 1', databaseId: 'db/1', token: 'cf-secret', baseUrl: 'https://cf.test/v4/', fetch: fetcher });

  test('sends one parameterised statement with the bearer token and returns rows', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const client = cloudflareD1(options(async (url, init) => {
      seen = { url: String(url), init: init! };
      return new Response(JSON.stringify({ success: true, result: [{ results: [{ n: 1 }] }] }), { status: 200 });
    }));
    expect(await client.query('SELECT ? AS n', [1])).toEqual([{ n: 1 }]);
    expect(seen!.url).toBe('https://cf.test/v4/accounts/acct%201/d1/database/db%2F1/query');
    expect(new Headers(seen!.init.headers).get('authorization')).toBe('Bearer cf-secret');
    expect(JSON.parse(String(seen!.init.body))).toEqual({ sql: 'SELECT ? AS n', params: [1] });
  });

  test('failures map to conflict or upstream_error without leaking the token', async () => {
    const reply = (status: number, body: unknown) => cloudflareD1(options(async () => new Response(JSON.stringify(body), { status })));
    const unique = await failure(reply(400, { success: false, errors: [{ code: 7500, message: 'UNIQUE constraint failed: users.email' }] }).query('INSERT'));
    expect(unique.code).toBe('conflict');
    const down = await failure(reply(503, { success: false }).query('SELECT 1'));
    expect(down.code).toBe('upstream_error');
    const network = await failure(cloudflareD1(options(async () => { throw new TypeError('connect ECONNREFUSED cf-secret'); })).query('SELECT 1'));
    expect(network.code).toBe('upstream_error');
    expect(network.message).not.toContain('cf-secret');
  });
});

describe('idp password login', () => {
  const login = (world: FakeWorld, config = brokerConfig(), password = 'pw') =>
    passwordLogin(parseBrokerConfig(config), 'sck-nobody', password, { fetch: world.fetch, now: world.now });

  test('returns the token and its expiry on success; PKCE and state are enforced by the fake IdP', async () => {
    const world = new FakeWorld();
    world.insertUser('sck-nobody', 'sck-nobody@example.test');
    world.sqlite.run('INSERT INTO user_password_credentials (id, tenant_id, user_id, password_hash) VALUES (?, ?, (SELECT id FROM users WHERE username = ?), ?)',
      ['c1', 'tenant-ck-0001', 'sck-nobody', await hashPassword('pw')]);
    const tokens = await login(world);
    expect(tokens.accessToken.split('.')).toHaveLength(3);
    expect(tokens.expiresAt).toBe(world.clock + 900_000);
    expect(jwtExpiry(tokens.accessToken)).toBe(world.clock + 900_000);
    expect(jwtExpiry('not-a-jwt')).toBeUndefined();
  });

  test('wrong credentials and unknown users read as invalid_credentials', async () => {
    const world = new FakeWorld();
    const error = await failure(login(world));
    expect(error).toBeInstanceOf(LoginError);
    expect(error.reason).toBe('invalid_credentials');
    expect(error.code).toBe('login_failed');
  });

  test('odd IdP behaviour becomes a clear login error', async () => {
    const config = parseBrokerConfig(brokerConfig());
    const run = (fetcher: Fetcher) => passwordLogin(config, 'u', 'p', { fetch: fetcher });
    const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

    expect((await failure(run(async () => json(400, {})))).reason).toBe('authorize_rejected');
    expect((await failure(run(async () => redirectTo('https://auth.test/again')))).reason).toBe('authorize_loop');
    expect((await failure(run(async () => { throw new TypeError('offline'); }))).code).toBe('upstream_error');

    const flow = (login: (url: string) => Response | Promise<Response>, exchange?: Response) => async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/authorize')) return redirectTo('https://auth.test/login/ck?login_challenge=abc');
      if (url.includes('/api/login/')) return login(url);
      return exchange ?? json(500, {});
    };
    expect((await failure(run(flow(() => json(200, { mfa_state: 'pending_totp' }))))).reason).toBe('mfa_required');
    expect((await failure(run(flow(() => json(200, { redirect_uri: `${config.idp.redirectUri}?error=access_denied` }))))).reason).toBe('access_denied');
    expect((await failure(run(flow(() => json(200, { redirect_uri: `${config.idp.redirectUri}?code=c&state=wrong` }))))).reason).toBe('bad_callback');
    expect((await failure(run(flow(() => json(403, { error: 'password_login_disabled' }))))).reason).toBe('password_login_disabled');
    expect((await failure(run(flow(() => json(500, 'oops'))))).reason).toBe('http_500');
  });

  test('a rejected token exchange is an upstream error without any token material', async () => {
    const world = new FakeWorld();
    world.insertUser('sck-nobody', 'sck-nobody@example.test');
    world.sqlite.run('INSERT INTO user_password_credentials (id, tenant_id, user_id, password_hash) VALUES (?, ?, (SELECT id FROM users WHERE username = ?), ?)',
      ['c1', 'tenant-ck-0001', 'sck-nobody', await hashPassword('pw')]);
    const broken: Fetcher = async (input, init) => String(input).endsWith('/api/auth/token')
      ? new Response(JSON.stringify({ error: 'invalid_grant', detail: 'code abc' }), { status: 400 })
      : world.fetch(input, init);
    const error = await failure(passwordLogin(parseBrokerConfig(brokerConfig()), 'sck-nobody', 'pw', { fetch: broken }));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('HTTP 400');
  });
});

describe('sessions', () => {
  test('capped per employee, private to project and environment, and short-lived', () => {
    let clock = 1_000;
    const store = new SessionStore(() => clock);
    const make = (employeeId: string) => store.create({ employeeId, project: 'demo', env: 'production', alias: 'A', username: 'sck-a', token: `tok-${employeeId}-${clock}-${Math.random()}`, expiresAt: clock + 900_000 });
    const first = make('e1');
    for (let i = 0; i < 8; i++) { clock += 1; make('e1'); }
    expect(() => store.get(first.id, 'e1', 'demo', 'production')).toThrow(/unknown session/); // oldest evicted
    const mine = make('e1');
    expect(() => store.get(mine.id, 'e2', 'demo', 'production')).toThrow(/unknown session/);
    expect(() => store.get(mine.id, 'e1', 'other', 'production')).toThrow(/unknown session/);
    expect(() => store.get(mine.id, 'e1', 'demo', 'staging')).toThrow(/unknown session/);
    expect(store.get(mine.id, 'e1', 'demo', 'production').id).toBe(mine.id);
    expect(store.secrets('e1').length).toBe(8);
    clock += 6 * 60 * 60_000 + 1;
    expect(() => store.get(mine.id, 'e1', 'demo', 'production')).toThrow(/expired/);
    store.dropEmployee('e1');
    expect(store.secrets('e1')).toEqual([]);
  });
});

describe('ego-browser injector', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  const fakeCli = (body: string) => {
    dir = mkdtempSync(join(tmpdir(), 'sck-ego-'));
    const bin = join(dir, 'ego-browser');
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return bin;
  };
  const input = (bin: string) => ({ bin, spaceId: 4, page: 'p2', probeUrl: 'https://app.test/health', landingUrl: 'https://app.test/', token: 'eyJtoken.payload-part.signature', expiresAt: 1_800_000_000_000 });

  test('the script, token included, travels over stdin and argv carries only the subcommand', async () => {
    const bin = fakeCli(`cat > "${'$'}(dirname "${'$'}0")/stdin.txt"; echo "${'$'}*" > "${'$'}(dirname "${'$'}0")/argv.txt"; echo 'SCK_RESULT {"url":"https://app.test/","title":"Fixture"}'`);
    const landed = await egoBrowserInjector(input(bin));
    expect(landed).toEqual({ url: 'https://app.test/', title: 'Fixture' });
    const stdin = readFileSync(join(dir!, 'stdin.txt'), 'utf8');
    expect(stdin).toContain('"eyJtoken.payload-part.signature"');
    expect(stdin).toContain('oidc.access_token');
    expect(stdin).toContain('"exp":1800000000');
    expect(stdin).toContain('taskSpace(4)');
    expect(readFileSync(join(dir!, 'argv.txt'), 'utf8').trim()).toBe('nodejs');
  });

  test('failures are reported with the token scrubbed from the CLI output', async () => {
    const bin = fakeCli(`cat >/dev/null; echo 'boom eyJtoken.payload-part.signature leaked' >&2; exit 3`);
    const error = await failure(egoBrowserInjector(input(bin)));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('exit 3');
    expect(error.message).not.toContain('eyJtoken.payload-part.signature');
  });

  test('a missing CLI is a configuration problem, not a crash', async () => {
    const error = await failure(egoBrowserInjector({ ...input('/nonexistent/ego-browser') }));
    expect(error.code).toBe('not_configured');
  });
});
