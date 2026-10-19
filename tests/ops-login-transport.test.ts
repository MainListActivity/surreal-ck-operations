import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseBrokerConfig } from '../src/ops/config.ts';
import { CompanyError } from '../src/core-errors.ts';
import { createOpsFetcher, opsFetch, OPS_CONNECT_TIMEOUT_MS } from '../src/ops/fetcher.ts';
import { LoginError, passwordLogin, type LoginOptions, type LoginTokens } from '../src/ops/idp.ts';
import { loginBrokerConfig, makeTestPki, startLoginIdp, type LoginIdp, type TestPki } from './support/ops-login-transport.ts';

// Real sockets and real TLS against a loopback IdP. Only the stall, delay and drop points are scripted.
const PASSWORD = 'correct-pw';
const SLOW = 30_000;
let pki: TestPki;
const idps: LoginIdp[] = [];
const transports: Array<{ close(): Promise<void> }> = [];

beforeAll(() => { pki = makeTestPki(); });
afterAll(async () => {
  for (const transport of transports) await transport.close();
  for (const idp of idps) await idp.close();
});

async function idp(options: { hold?: (connection: number) => number; delayLogin?: (login: number) => number; dropLogin?: (login: number) => boolean; refuseStatus?: number } = {}): Promise<LoginIdp> {
  const started = await startLoginIdp(pki, { password: PASSWORD, ...options });
  idps.push(started);
  return started;
}

/** A transport with a private dispatcher; it trusts only the scratch CA unless told otherwise. */
function transport(connectTimeoutMs?: number, trusted = true) {
  const created = createOpsFetcher({
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    ...(trusted ? { ca: pki.ca } : {}),
  });
  transports.push(created);
  return created;
}

const login = (target: LoginIdp, options: LoginOptions, password = PASSWORD) =>
  passwordLogin(parseBrokerConfig(loginBrokerConfig(target.origin)), 'sck-nobody', password, options);

async function success(run: Promise<LoginTokens>): Promise<{ tokens: LoginTokens; ms: number }> {
  const started = performance.now();
  const tokens = await run;
  return { tokens, ms: performance.now() - started };
}

async function failure(run: Promise<unknown>): Promise<{ error: CompanyError; ms: number }> {
  const started = performance.now();
  const error = await run.then(() => { throw new Error('expected the login to fail'); }, (reason: unknown) => reason);
  if (!(error instanceof CompanyError)) throw new Error(`expected a CompanyError, got ${String(error)}`);
  return { error, ms: performance.now() - started };
}

describe('explicit connect limit', () => {
  test('a stalled connect is cut at the transport limit, not at the request signal', async () => {
    const target = await idp({ hold: () => 1_500 });
    const { error, ms } = await failure(login(target, { fetch: transport(400), stepTimeoutMs: 10_000, budgetMs: 1_000, retryMinLeftMs: 60_000 }));
    expect(error.message).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(ms).toBeGreaterThanOrEqual(350);
    expect(ms).toBeLessThan(1_200);
    expect(target.counts.authorize).toBe(0);
  }, SLOW);

  test('a handshake that completes inside the limit succeeds', async () => {
    const target = await idp({ hold: () => 600 });
    const { tokens, ms } = await success(login(target, { fetch: transport(2_000) }));
    expect(tokens.attempts).toBe(1);
    expect(tokens.accessToken.startsWith('at-')).toBe(true);
    expect(tokens.trace).toContain('HTTP 200');
    expect(ms).toBeGreaterThanOrEqual(550);
  }, SLOW);
});

describe('login over real TLS', () => {
  test('authorize, password and PKCE exchange succeed; the trace keeps hosts and outcomes only', async () => {
    const target = await idp();
    const { tokens } = await success(login(target, { fetch: transport() }));
    expect(tokens.attempts).toBe(1);
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1 });
    for (const secret of [PASSWORD, 'login_challenge', 'code-', 'code_verifier', '/api/', '/t/ck']) expect(tokens.trace).not.toContain(secret);
  }, SLOW);

  test('a certificate the client does not trust is refused before any request, and is not retried', async () => {
    const target = await idp();
    const { error } = await failure(login(target, { fetch: transport(undefined, false) }));
    expect(error.message).toContain('certificate');
    expect(target.counts.authorize).toBe(0);
    expect(target.connections()).toBe(1);
  }, SLOW);

  test('a wrong password is refused at once: one login request, no retry, no password in the error', async () => {
    const target = await idp();
    const { error } = await failure(login(target, { fetch: transport() }, 'not-the-password'));
    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).reason).toBe('invalid_credentials');
    expect(target.counts.login).toBe(1);
    expect(error.message).not.toContain('not-the-password');
  }, SLOW);

  test('a 403 refusal is final as well', async () => {
    const target = await idp({ refuseStatus: 403 });
    const { error } = await failure(login(target, { fetch: transport() }, 'not-the-password'));
    expect((error as LoginError).reason).toBe('invalid_credentials');
    expect(target.counts.login).toBe(1);
  }, SLOW);
});

describe('bounded recovery', () => {
  test('a transient connect stall is retried from a fresh challenge and then succeeds', async () => {
    const target = await idp({ hold: connection => (connection === 1 ? 1_500 : 0) });
    const { tokens } = await success(login(target, { fetch: transport(400) }));
    expect(tokens.attempts).toBe(2);
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1 });
  }, SLOW);

  test('a login dropped after the IdP consumed it is retried with a new flow, never replayed', async () => {
    const target = await idp({ dropLogin: login => login === 1 });
    const { tokens } = await success(login(target, { fetch: transport() }));
    expect(tokens.attempts).toBe(2);
    expect(target.counts).toEqual({ authorize: 2, login: 2, exchange: 1 });
  }, SLOW);

  test('a response that outlasts the step limit is a transient failure, and the budget bounds the total', async () => {
    const target = await idp({ delayLogin: () => 5_000 });
    const { error, ms } = await failure(login(target, { fetch: transport(), stepTimeoutMs: 300, budgetMs: 1_500, retryMinLeftMs: 100 }));
    expect(error.message).toContain('timed out');
    expect(target.counts.login).toBeLessThanOrEqual(2);
    expect(ms).toBeLessThan(4_500);
  }, SLOW);

  test('a budget that runs out stops the flow with a bounded, secret-free error', async () => {
    const target = await idp({ hold: () => 5_000 });
    const { error, ms } = await failure(login(target, { fetch: transport(400), budgetMs: 600, retryMinLeftMs: 300 }));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(error.message).not.toContain(PASSWORD);
    expect(ms).toBeLessThan(3_100);
  }, SLOW);
});

describe('production connect limit', () => {
  test('a 12 s handshake, longer than the 10 s connector limit of plain global fetch, succeeds', async () => {
    expect(typeof opsFetch).toBe('function');
    expect(OPS_CONNECT_TIMEOUT_MS).toBeGreaterThan(12_000);
    expect(OPS_CONNECT_TIMEOUT_MS).toBeLessThan(25_000);
    const target = await idp({ hold: () => 12_000 });
    const { tokens, ms } = await success(login(target, { fetch: transport() }));
    expect(tokens.attempts).toBe(1);
    expect(ms).toBeGreaterThanOrEqual(11_500);
  }, 60_000);
});
