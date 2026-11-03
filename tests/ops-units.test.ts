import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { egoBrowserInjector, oidcUserEntry } from '../src/ops/browser.ts';
import { controlPlaneEnv, parseBrokerConfig } from '../src/ops/config.ts';
import { cloudflareD1 } from '../src/ops/d1.ts';
import { createOpsFetcher, opsConnectOptions, OPS_CONNECT_TIMEOUT_MS, wholeMs, type Fetcher } from '../src/ops/fetcher.ts';
import { LoginError, jwtExpiry, passwordLogin } from '../src/ops/idp.ts';
import { generatePassword, hashPassword, verifyPassword } from '../src/ops/password.ts';
import { ProductUnreachable, assertProductPath, productRequest, productTimeoutMs } from '../src/ops/product.ts';
import { clip, redactJson, redactText } from '../src/ops/redact.ts';
import { SessionStore } from '../src/ops/sessions.ts';
import { brokerConfig, FakeWorld } from './support/ops-world.ts';

const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code?: string; reason?: string }; }
  throw new Error('expected failure');
};

describe('ops transport connect options', () => {
  /** undici stores the Agent constructor options behind this well-known symbol. */
  const agentOptions = (agent: object): { connect: { timeout: number; ca?: string; family?: 4 | 6 } } => {
    const key = Object.getOwnPropertySymbols(agent).find(symbol => String(symbol) === 'Symbol(options)');
    if (!key) throw new Error('undici Agent is missing Symbol(options)');
    return (agent as Record<symbol, { connect: { timeout: number; ca?: string; family?: 4 | 6 } }>)[key];
  };

  const { Agent } = require('undici/index.js') as {
    Agent: new (options: { connect: object }) => { close(): Promise<void> };
  };

  test('defaults to IPv4 and keeps the standing timeout and ca for every Agent built from the shared connect', async () => {
    const ca = '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n';
    expect(opsConnectOptions()).toEqual({ timeout: OPS_CONNECT_TIMEOUT_MS, family: 4 });
    expect(opsConnectOptions({ connectTimeoutMs: 12_345, ca })).toEqual({ timeout: 12_345, family: 4, ca });
    // createOpsFetcher hands the same connect object to the standing pool and to every freshConnection Agent.
    const standing = new Agent({ connect: opsConnectOptions({ connectTimeoutMs: 12_345, ca }) });
    const fresh = new Agent({ connect: opsConnectOptions({ connectTimeoutMs: 12_345, ca }) });
    expect(agentOptions(standing).connect).toEqual({ timeout: 12_345, family: 4, ca });
    expect(agentOptions(fresh).connect).toEqual({ timeout: 12_345, family: 4, ca });
    await standing.close();
    await fresh.close();
    const fetcher = createOpsFetcher({ connectTimeoutMs: 12_345, ca });
    try {
      expect(typeof fetcher.freshConnection()).toBe('function');
    } finally {
      await fetcher.close();
    }
  });

  test('an explicit family 6 is passed through on both pools without changing timeout or ca', async () => {
    const ca = '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n';
    expect(opsConnectOptions({ family: 6, connectTimeoutMs: 9_000, ca })).toEqual({ timeout: 9_000, family: 6, ca });
    const standing = new Agent({ connect: opsConnectOptions({ family: 6, connectTimeoutMs: 9_000, ca }) });
    const fresh = new Agent({ connect: opsConnectOptions({ family: 6, connectTimeoutMs: 9_000, ca }) });
    expect(agentOptions(standing).connect).toEqual({ timeout: 9_000, family: 6, ca });
    expect(agentOptions(fresh).connect).toEqual({ timeout: 9_000, family: 6, ca });
    await standing.close();
    await fresh.close();
    const fetcher = createOpsFetcher({ family: 6, connectTimeoutMs: 9_000, ca });
    try {
      expect(typeof fetcher.freshConnection()).toBe('function');
    } finally {
      await fetcher.close();
    }
  });

  test('family 4 reaches a dual-stack listener over IPv4; family 6 reaches it over IPv6', async () => {
    // makeTestPki's leaf only covers 127.0.0.1; mint a dual-stack pair so family 6 can finish TLS on ::1.
    const dir = mkdtempSync(join(tmpdir(), 'sck-ops-fam-'));
    const { execFileSync } = await import('node:child_process');
    const openssl = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=sck-ops-fam-ca',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost']);
    writeFileSync(join(dir, 'leaf.ext'),
      'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', 'leaf.pem', '-days', '1', '-extfile', 'leaf.ext']);
    const ca = readFileSync(join(dir, 'ca.pem'), 'utf8');
    const cert = readFileSync(join(dir, 'leaf.pem'), 'utf8');
    const key = readFileSync(join(dir, 'leaf.key'), 'utf8');
    rmSync(dir, { recursive: true, force: true });

    const seen: string[] = [];
    const server = createHttpsServer({ cert, key }, (req, res) => {
      seen.push(req.socket.remoteAddress ?? '');
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '::', () => resolve()));
    const port = (server.address() as { port: number }).port;

    const hit = async (family: 4 | 6, via: 'standing' | 'fresh') => {
      const transport = createOpsFetcher({ family, ca, connectTimeoutMs: 5_000 });
      try {
        const fetch = via === 'fresh' ? transport.freshConnection() : transport;
        const response = await fetch(`https://localhost:${port}/`);
        expect(response.status).toBe(200);
        await response.text();
      } finally {
        await transport.close();
      }
    };

    await hit(4, 'standing');
    expect(seen.at(-1)).toMatch(/127\.0\.0\.1/);
    await hit(4, 'fresh');
    expect(seen.at(-1)).toMatch(/127\.0\.0\.1/);
    await hit(6, 'standing');
    expect(seen.at(-1)).toBe('::1');
    await hit(6, 'fresh');
    expect(seen.at(-1)).toBe('::1');

    await new Promise<void>(resolve => server.close(() => resolve()));
  });
});

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

  test('the ops block is optional and validated like the rest', () => {
    const base = brokerConfig();
    expect(parseBrokerConfig(base).ops).toBeUndefined();
    const cfg = parseBrokerConfig({ ...base, ops: { clientId: 'ops-client-1', redirectUri: 'https://ops.test/cb', resource: 'https://app.test/api/ops/mcp' } });
    expect(cfg.ops).toEqual({ clientId: 'ops-client-1', redirectUri: 'https://ops.test/cb', resource: 'https://app.test/api/ops/mcp', scope: 'openid' });
    expect(() => parseBrokerConfig({ ...base, ops: { clientId: 'x', redirectUri: 'https://ops.test/cb' } })).toThrow(/ops/);
    expect(() => parseBrokerConfig({ ...base, ops: { clientId: 'ops-1', redirectUri: 'https://ops.test/cb', resource: 'http://app.test/x' } })).toThrow(/https/);
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

describe('product request limits', () => {
  const config = parseBrokerConfig(brokerConfig());
  const hang: Fetcher = (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
  });

  test('only workspace creation may take longer than an ordinary call', () => {
    expect(productTimeoutMs('GET', '/api/session/workspaces')).toBe(30_000);
    expect(productTimeoutMs('POST', '/api/workspaces')).toBe(90_000);
    expect(productTimeoutMs('post', '/api/workspaces?x=1')).toBe(90_000);
    expect(productTimeoutMs('POST', '/api/ops/invitations')).toBe(105_000);
    expect(productTimeoutMs('GET', '/api/ops/invitations/k')).toBe(30_000);
    for (const [method, path] of [['GET', '/api/workspaces'], ['POST', '/api/workspaces/sck-x/members'], ['POST', '/api/workspaces-other'], ['POST', '/api/session/switch-workspace']]) {
      expect(productTimeoutMs(method!, path!), `${method} ${path}`).toBe(30_000);
    }
  });

  test('a request nobody answers fails as unreachable, naming the limit and warning about writes', async () => {
    const read = await failure(productRequest(config, 'tok', { method: 'GET', path: '/api/x' }, { fetch: hang, timeoutMs: 20 }));
    expect(read).toBeInstanceOf(ProductUnreachable);
    expect((read as ProductUnreachable).timedOut).toBe(true);
    expect(read.code).toBe('upstream_error');
    expect(read.message).toBe('product request timed out after 20ms');

    const write = await failure(productRequest(config, 'tok', { method: 'POST', path: '/api/x', body: {} }, { fetch: hang, timeoutMs: 20 }));
    expect(write.message).toBe('product request timed out after 20ms; it may still have taken effect, so check before repeating it');
  });

  test('other transport failures are unreachable but not timeouts, and carry no request details', async () => {
    const reset: Fetcher = async () => { throw new TypeError('connect ECONNRESET Bearer secret-token'); };
    const error = await failure(productRequest(config, 'secret-token', { method: 'GET', path: '/api/x' }, { fetch: reset }));
    expect(error).toBeInstanceOf(ProductUnreachable);
    expect((error as ProductUnreachable).timedOut).toBe(false);
    expect(error.message).toBe('product request failed (TypeError)');
  });

  test('the errno-style cause code is relayed while the possibly sensitive message stays hidden', async () => {
    const reset: Fetcher = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNRESET 10.0.0.1:443'), { code: 'ECONNRESET' }) }); };
    const error = await failure(productRequest(config, 'secret-token', { method: 'POST', path: '/api/x', body: {} }, { fetch: reset }));
    expect((error as ProductUnreachable).timedOut).toBe(false);
    expect(error.message).toBe('product request failed (TypeError ECONNRESET); it may still have taken effect, so check before repeating it');
  });

  test('a body that stalls after the headers is a timeout; an unreadable one just leaves the status', async () => {
    const stalled: Fetcher = async (_input, init) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason)); },
    }), { status: 200 });
    const error = await failure(productRequest(config, 'tok', { method: 'GET', path: '/api/x' }, { fetch: stalled, timeoutMs: 20 }));
    expect(error).toBeInstanceOf(ProductUnreachable);

    const broken: Fetcher = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('reset')); } }), { status: 502 });
    expect(await productRequest(config, 'tok', { method: 'GET', path: '/api/x' }, { fetch: broken }))
      .toMatchObject({ status: 502, ok: false, body: null });
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
    // A clean run records one attempt and a sanitized hop-by-hop trace for later diagnosis.
    expect(tokens.attempts).toBe(1);
    expect(tokens.trace).toContain('a1:authorize#0@idp.test:HTTP 302');
    expect(tokens.trace).toContain('a1:login@auth.test:HTTP 200');
    expect(tokens.trace).toContain('a1:exchange@app.test:HTTP 200');
    expect(tokens.trace).not.toContain('login_challenge');
    expect(tokens.trace).not.toContain('pw');
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
    expect((await failure(run(flow(() => json(429, { error: 'rate_limited' }))))).reason).toBe('rate_limited');
    expect((await failure(run(flow(() => json(200, 'not an object'))))).reason).toBe('http_200');
  });

  test('the operator channel approves the consent hop carrying the login session cookie', async () => {
    const config = parseBrokerConfig(brokerConfig({
      ops: { clientId: 'ops-client-x', redirectUri: 'https://ops.test/cb', resource: 'https://app.test/api/ops/mcp' },
    }));
    let state = '';
    let consentCookie: string | null = null;
    let consentBody = '';
    const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });
    const fetcher: Fetcher = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/authorize')) {
        state = url.searchParams.get('state')!;
        return redirectTo('https://auth.test/login/ck?login_challenge=abc');
      }
      if (url.pathname === '/api/login/ck/password') {
        return new Response(JSON.stringify({ redirect_uri: 'https://auth.test/api/consent/ck?consent_challenge=ch-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'set-cookie': 'user_session=s-1; Path=/; HttpOnly' },
        });
      }
      if (url.pathname === '/api/consent/ck') {
        consentCookie = new Headers(init?.headers).get('cookie');
        consentBody = String(init?.body);
        return redirectTo(`https://ops.test/cb?code=code-1&state=${state}`);
      }
      if (url.pathname === '/api/auth/ops/token') {
        return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 60 }), { status: 200 });
      }
      return new Response('', { status: 500 });
    };
    const tokens = await passwordLogin(config, 'u', 'p', { fetch: fetcher, channel: 'operator' });
    expect(tokens.accessToken).toBe('tok-1');
    expect(consentCookie ?? '').toContain('user_session=s-1');
    const consentForm = new URLSearchParams(consentBody);
    expect(consentForm.get('consent_challenge')).toBe('ch-1');
    expect(consentForm.get('decision')).toBe('approve');
  });

  test('a consent challenge for a non-operator client fails instead of approving', async () => {
    // Customer channel: no ops block configured, so no client may auto-approve at all.
    const config = parseBrokerConfig(brokerConfig());
    let consentPosts = 0;
    const fetcher: Fetcher = async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/authorize')) {
        return new Response(null, { status: 302, headers: { location: 'https://auth.test/login/ck?login_challenge=abc' } });
      }
      if (url.pathname === '/api/consent/ck') {
        consentPosts++;
        return new Response('', { status: 500 });
      }
      if (url.pathname === '/api/login/ck/password') {
        return new Response(JSON.stringify({ redirect_uri: 'https://auth.test/api/consent/ck?consent_challenge=ch-1' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 500 });
    };
    const error = await failure(passwordLogin(config, 'u', 'p', { fetch: fetcher }));
    expect(error).toMatchObject({ code: 'login_failed', reason: 'consent_required' });
    expect(consentPosts).toBe(0);
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

  describe('on a flaky network', () => {
    const authorizes = (world: FakeWorld) => world.requests.filter(q => q.url.includes('/authorize')).length;
    const logins = (world: FakeWorld) => world.requests.filter(q => q.url.includes('/api/login/')).length;
    const idp = (_method: string, url: URL) => url.origin === 'https://idp.test';
    const loginPage = (_method: string, url: URL) => url.pathname === '/api/login/ck/password';
    const exchange = (_method: string, url: URL) => url.pathname === '/api/auth/token';
    const hang: Fetcher = (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
    });

    const account = async () => {
      const world = new FakeWorld();
      await world.addAccount('sck-nobody', 'pw');
      return world;
    };
    const run = (world: FakeWorld, options: { budgetMs?: number } = {}) =>
      passwordLogin(parseBrokerConfig(brokerConfig()), 'sck-nobody', 'pw', { fetch: world.fetch, now: world.now, ...options });

    test('a lost request at any step earns one more attempt from a fresh challenge', async () => {
      const cases: Array<[string, (method: string, url: URL) => boolean, 'timeout' | 'reset' | number]> = [
        ['authorize timeout', idp, 'timeout'], ['login reset', loginPage, 'reset'],
        ['login 502', loginPage, 502], ['exchange 524', exchange, 524],
      ];
      for (const [label, match, how] of cases) {
        const world = await account();
        world.fault(match, how);
        const tokens = await run(world);
        expect(tokens.accessToken.split('.'), label).toHaveLength(3);
        expect(authorizes(world), label).toBe(2);
      }
    });

    test('a refusal is final: nothing is replayed', async () => {
      const unknown = new FakeWorld();
      expect((await failure(run(unknown))).reason).toBe('invalid_credentials');
      expect(authorizes(unknown)).toBe(1);
      expect(logins(unknown)).toBe(1);

      const world = await account();
      const rejected: Fetcher = async (input, init) => String(input).endsWith('/api/auth/token')
        ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
        : world.fetch(input, init);
      await failure(passwordLogin(parseBrokerConfig(brokerConfig()), 'sck-nobody', 'pw', { fetch: rejected }));
      expect(authorizes(world)).toBe(1);
    });

    test('a second failure is reported as upstream trouble that took three attempts, never as a refusal', async () => {
      const world = await account();
      world.fault(loginPage, 503, { times: 5 });
      const error = await failure(run(world));
      expect(error.code).toBe('upstream_error');
      expect(error).not.toBeInstanceOf(LoginError);
      expect(error.message).toMatch(/^IdP login failed \(HTTP 503\); gave up after 3 attempts; trace: /);
      // The sanitized hop trace names the failing phase and host, every attempt included.
      expect(error.message).toContain('a1:authorize#0@idp.test:HTTP 302');
      expect(error.message).toContain('a2:login@auth.test:HTTP 503');
      expect(error.message).toMatch(/; stage=login; runtime (bun|node)@/);
      expect(error.message).not.toContain('pw');
      expect(authorizes(world)).toBe(3);
    });

    test('a request nobody answers is cut off at the step limit, then retried', async () => {
      const started = Date.now();
      const error = await failure(passwordLogin(parseBrokerConfig(brokerConfig()), 'u', 'p', { fetch: hang, stepTimeoutMs: 20 }));
      expect(error.code).toBe('upstream_error');
      expect(error.message).toMatch(/^IdP authorize failed \(timed out after 20ms\); gave up after 3 attempts; trace: /);
      expect(error.message).toContain('a1:authorize#0@idp.test:timed out after 20ms');
      expect(error.message).toContain('a2:authorize#0@idp.test:timed out after 20ms');
      expect(error.message).toContain('a3:authorize#0@idp.test:timed out after 20ms');
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    test('a body that stalls after the headers counts as a timeout too', async () => {
      const stalled: Fetcher = async (_input, init) => new Response(new ReadableStream({
        start(controller) { init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason)); },
      }), { status: 200 });
      const error = await failure(passwordLogin(parseBrokerConfig(brokerConfig()), 'u', 'p', { fetch: async (input, init) => (
        String(input).includes('/authorize') ? new Response(null, { status: 302, headers: { location: 'https://auth.test/login/ck?login_challenge=abc' } }) : stalled(input, init)
      ), stepTimeoutMs: 20 }));
      expect(error.message).toMatch(/^IdP login failed \(timed out after 20ms\); gave up after 3 attempts; trace: /);
    });

    test('without room for a whole second flow the first failure is final', async () => {
      const world = await account();
      world.fault(idp, 'timeout');
      const error = await failure(run(world, { budgetMs: 10_000 }));
      expect(error.code).toBe('upstream_error');
      expect(error.message).not.toContain('gave up');
      expect(authorizes(world)).toBe(1);
    });
  });
});

describe('sessions', () => {
  test('capped per employee, private to project and environment, and short-lived', () => {
    let clock = 1_000;
    const store = new SessionStore(() => clock);
    const make = (employeeId: string) => store.create({ employeeId, project: 'demo', env: 'production', alias: 'A', username: 'sck-a', kind: 'customer', token: `tok-${employeeId}-${clock}-${Math.random()}`, expiresAt: clock + 900_000 });
    const first = make('e1');
    for (let i = 0; i < 8; i++) { clock += 1; make('e1'); }
    expect(() => store.get(first.id, 'e1', 'demo', 'production')).toThrow(/unknown session/); // oldest evicted
    const mine = make('e1');
    expect(() => store.get(mine.id, 'e2', 'demo', 'production')).toThrow(/unknown session/);
    expect(() => store.get(mine.id, 'e1', 'other', 'production')).toThrow(/unknown session/);
    expect(() => store.get(mine.id, 'e1', 'demo', 'staging')).toThrow(/unknown session/);
    expect(store.get(mine.id, 'e1', 'demo', 'production').id).toBe(mine.id);
    // No handle at all is the caller's mistake (an empty argument list), reported as such.
    expect(() => store.get(undefined, 'e1', 'demo', 'production')).toThrow(/session is required/);
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
    expect(stdin).toContain('"oidc.exp","value":"1800000000"');
    expect(stdin).toContain('taskSpace(4)');
    expect(readFileSync(join(dir!, 'argv.txt'), 'utf8').trim()).toBe('nodejs');
  });

  test('an oidcUser entry writes the User record under its key instead of the customer keys', async () => {
    const bin = fakeCli(`cat > "${'$'}(dirname "${'$'}0")/stdin.txt"; echo 'SCK_RESULT {"url":"https://app.test/ops/","title":"Ops"}'`);
    const user = oidcUserEntry({
      authority: 'https://idp.test/t/ck', clientId: 'ops-client-0001',
      token: 'eyJtoken.payload-part.signature', expiresAt: 1_800_000_000_000,
      scope: 'openid', profile: { sub: 'sub-1', email: 'ops@example.test' },
    });
    const landed = await egoBrowserInjector({ ...input(bin), landingUrl: 'https://app.test/ops/', oidcUser: user });
    expect(landed.url).toBe('https://app.test/ops/');
    const stdin = readFileSync(join(dir!, 'stdin.txt'), 'utf8');
    expect(stdin).toContain('"oidc.user:https://idp.test/t/ck:ops-client-0001"');
    // The serialized User record travels as one JSON-encoded sessionStorage value.
    expect(stdin).toContain('eyJtoken.payload-part.signature');
    expect(stdin).toContain('expires_at');
    expect(stdin).toContain('1800000000');
    expect(stdin).toContain('sub-1');
    // The customer keys never appear in an operator injection.
    expect(stdin).not.toContain('oidc.access_token');
    expect(stdin).not.toContain('"oidc.exp"');
  });

  test('the real CLI writes the result line to stderr, mixed with notices; stdout stays empty', async () => {
    // The exact output observed from ego-browser 0.5.0.x in production: console.log from the
    // script goes to stderr behind its own notices, and parsing stdout alone lost the result.
    const bin = fakeCli(`cat >/dev/null; echo '[ego-browser:notice] Ego Lite update is available (current 0.5.0.32). Finish the current browser task, then ask the user before running \`ego-browser upgrade\`; re-read the ego-browser Skill afterward.' >&2; echo 'SCK_RESULT {"url":"https://app.test/","title":"Fixture App"}' >&2`);
    const landed = await egoBrowserInjector(input(bin));
    expect(landed).toEqual({ url: 'https://app.test/', title: 'Fixture App' });
  });

  test('a malformed result line is an upstream error with the CLI output attached', async () => {
    const bin = fakeCli(`cat >/dev/null; echo 'SCK_RESULT {"url":"https://app.test/"}' >&2; exit 0`);
    const error = await failure(egoBrowserInjector(input(bin)));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('exit 0');
    expect(error.message).toContain('SCK_RESULT');
  });

  test('a non-zero exit with a result line still reports failure', async () => {
    const bin = fakeCli(`cat >/dev/null; echo 'SCK_RESULT {"url":"https://app.test/","title":"Late"}' >&2; exit 1`);
    const error = await failure(egoBrowserInjector(input(bin)));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('exit 1');
  });

  test('failures are reported with the token scrubbed from the CLI output', async () => {
    const bin = fakeCli(`cat >/dev/null; echo 'boom eyJtoken.payload-part.signature leaked' >&2; exit 3`);
    const error = await failure(egoBrowserInjector(input(bin)));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('exit 3');
    expect(error.message).not.toContain('eyJtoken.payload-part.signature');
  });

  test('failures scrub the token even when it arrived inside an oidcUser record', async () => {
    const bin = fakeCli(`cat >/dev/null; echo 'boom eyJtoken.payload-part.signature leaked' >&2; exit 3`);
    const user = oidcUserEntry({
      authority: 'https://idp.test/t/ck', clientId: 'ops-client-0001',
      token: 'eyJtoken.payload-part.signature', expiresAt: 1_800_000_000_000,
      scope: 'openid', profile: { sub: 'sub-1' },
    });
    const error = await failure(egoBrowserInjector({ ...input(bin), oidcUser: user }));
    expect(error.code).toBe('upstream_error');
    expect(error.message).not.toContain('eyJtoken.payload-part.signature');
    expect(error.message).not.toContain('sub-1');
  });

  test('a missing CLI is a configuration problem, not a crash', async () => {
    const error = await failure(egoBrowserInjector({ ...input('/nonexistent/ego-browser') }));
    expect(error.code).toBe('not_configured');
  });
});

describe('timer delays from a fractional clock', () => {
  /** Capture exactly what reaches AbortSignal.timeout: the timer rejects a fractional delay with RangeError. */
  async function captureTimeouts<T>(run: () => Promise<T>): Promise<{ value?: T; error?: unknown; delays: number[] }> {
    const original = AbortSignal.timeout;
    const delays: number[] = [];
    (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
      delays.push(ms);
      return original.call(AbortSignal, ms);
    };
    try {
      return { value: await run(), delays };
    } catch (error) {
      return { error, delays };
    } finally {
      (AbortSignal as unknown as { timeout: typeof original }).timeout = original;
    }
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

  /**
   * A scripted IdP/product transport on a fractional clock. The authorize hop costs [authorizeMs] so the next step's
   * budget remainder is a fraction smaller than the step limit — the production shape (`performance.now()`
   * differences) that used to reach `AbortSignal.timeout` unrounded.
   */
  function scriptedFlow(clock: { now: number }, options: { authorizeMs: number; loginReply: (state: string) => Response }) {
    let state = '';
    return async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/authorize')) {
        state = url.searchParams.get('state') ?? state;
        clock.now += options.authorizeMs;
        input; // the URL is only read for routing; no request detail is returned
        return redirect('https://auth.test/login/ck?login_challenge=CH-1');
      }
      if (url.pathname.endsWith('/password')) {
        clock.now += 300;
        if ((options.loginReply(state).status ?? 0) === 200) clock.now += 200.5; // body time is a fraction too
        return options.loginReply(state);
      }
      // Token exchange: product proxy (customer/operator) or the IdP's own /token (ops).
      clock.now += 200;
      return json(200, { access_token: 'at-1', expires_in: 900 });
    };
  }

  const broker = {
    roles: ['qa', 'engineering'],
    idp: {
      issuer: 'https://auth.test/t/ck', clientId: 'client-ck-1234', audience: 'https://auth.test',
      redirectUri: 'https://app.test/auth/callback', scope: 'openid',
      ops: { clientId: 'ops-idp-client', audience: 'https://app.test/api/ops/mcp', redirectUri: 'https://idp.test/auth/cb' },
    },
    ops: { clientId: 'ops-client-1', redirectUri: 'https://app.test/auth/ops/callback', resource: 'https://app.test/api/ops/mcp', scope: 'openid' },
    product: { url: 'https://app.test' },
    accounts: { prefix: 'sck-', emailDomain: 'example.test', workspacePrefix: 'sck-' },
    limits: { workspacesPerDay: 2, accountsPerDay: 3 },
  } as const;

  const options = (clock: { now: number }, fetcher: Fetcher, channel?: 'operator' | 'ops') => ({
    fetch: fetcher, clock: () => clock.now, budgetMs: 12_000, stepTimeoutMs: 6_000, retryMinLeftMs: 100,
    ...(channel ? { channel } : {}),
  });

  test('a fractional budget remainder still logs in: every timer delay is an integer at or above the 2 s floor', async () => {
    const clock = { now: 0 };
    const run = captureTimeouts(() => passwordLogin(broker as never, 'u', 'pw', options(clock,
      scriptedFlow(clock, {
        authorizeMs: 7_000.5,
        loginReply: state => json(200, { redirect_uri: `https://app.test/auth/callback?code=c1&state=${state}` }),
      }))));
    const { value, error, delays } = await run;
    expect(error).toBeUndefined();
    expect(value?.accessToken).toBe('at-1');
    // Step 1 at t=0 gets the whole 6 s step limit; steps 2 and 3 see the fractional remainder (3899.5 / 3399.5).
    expect(delays).toEqual([6_000, 3_899, 3_399]);
    for (const delay of delays) {
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(2_000); // MIN_STEP_MS
    }
  });

  test('the operator and ops channels share the same integer step guard', async () => {
    for (const channel of ['operator', 'ops'] as const) {
      const clock = { now: 0 };
      // A 403 at the login hop ends the flow right after the fractional step; the point is that the step itself ran.
      const { error, delays } = await captureTimeouts(() => passwordLogin(broker as never, 'u', 'pw', options(clock,
        scriptedFlow(clock, { authorizeMs: 7_000.5, loginReply: () => json(403, {}) }), channel)));
      expect(error).toBeInstanceOf(LoginError);
      expect(String((error as Error).name)).not.toBe('RangeError');
      expect(delays).toEqual([6_000, 3_899]);
      for (const delay of delays) expect(Number.isInteger(delay)).toBe(true);
    }
  });

  test('wholeMs floors clock-derived delays, keeps integers and holds the 1 ms timer minimum', () => {
    expect(wholeMs(24_356.63)).toBe(24_356);
    expect(wholeMs(23_725.19)).toBe(23_725);
    expect(wholeMs(2_000)).toBe(2_000);
    expect(wholeMs(0.4)).toBe(1);
    expect(wholeMs(-5)).toBe(1);
    // Non-finite input is a broken clock, not a licence for a hidden 1 ms wait.
    expect(Number.isNaN(wholeMs(Number.NaN))).toBe(true);
  });
});
