import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseBrokerConfig } from '../src/ops/config.ts';
import { CompanyError } from '../src/core-errors.ts';
import { createOpsFetcher, opsFetch, OPS_CONNECT_TIMEOUT_MS } from '../src/ops/fetcher.ts';
import { LoginError, passwordLogin, type LoginOptions, type LoginTokens } from '../src/ops/idp.ts';
import { loginBrokerConfig, makeTestPki, startLoginIdp, type LoginIdp, type LoginIdpOptions, type TestPki } from './support/ops-login-transport.ts';

// Real sockets and real TLS against a loopback IdP. Only the stall, delay and drop points are scripted.
const PASSWORD = 'correct-pw';
const SLOW = 30_000;
// The production-constant case spends two connect stalls (20s each) plus the flows around them.
const PRODUCTION_SHAPE = 120_000;
let pki: TestPki;
const idps: LoginIdp[] = [];
const transports: Array<{ close(): Promise<void> }> = [];

beforeAll(() => { pki = makeTestPki(); });
afterAll(async () => {
  for (const transport of transports) await transport.close();
  for (const idp of idps) await idp.close();
});

async function idp(options: Omit<LoginIdpOptions, 'password'> = {}): Promise<LoginIdp> {
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
  passwordLogin(parseBrokerConfig(loginBrokerConfig(target.origins)), 'sck-nobody', password, options);

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
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1, replays: 0 });
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
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1, replays: 0 });
  }, SLOW);

  // The QA failure shape (5860edac, 2026-10-24): a ~20s connect stall lands on the LAST hop (token exchange), where the
  // old policy had already spent its one retry. A retry must be a complete fresh flow — new authorize, new challenge,
  // new code — and the single-use code must never be replayed. A connect that never completes sends no request, so the
  // server-side counts show only the requests that actually arrived.
  test('a connect stall on the last hop (exchange) is retried from a fresh flow and succeeds', async () => {
    const target = await idp({ holdHop: (hop, connection) => hop === 'exchange' && connection === 1 ? 1_500 : 0 });
    const { tokens } = await success(login(target, { fetch: transport(400) }));
    expect(tokens.attempts).toBe(2);
    // The stalled exchange never reached the server; the retry ran a whole new flow and exchanged exactly once.
    expect(target.counts).toEqual({ authorize: 2, login: 2, exchange: 1, replays: 0 });
    expect(tokens.trace).toContain('a1:exchange');
    expect(tokens.trace).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(tokens.trace).toContain('a2:exchange');
    expect(tokens.trace).toContain('HTTP 200');
    // The trace names fixed phases and hosts only: no challenge, code, verifier or password material.
    for (const secret of [PASSWORD, 'login_challenge', 'code-', 'code_verifier', '/api/', '/t/ck']) expect(tokens.trace).not.toContain(secret);
  }, SLOW);

  test('a connect stall on the authorize hop is retried from a fresh flow', async () => {
    const target = await idp({ holdHop: (hop, connection) => hop === 'authorize' && connection === 1 ? 1_500 : 0 });
    const { tokens } = await success(login(target, { fetch: transport(400) }));
    expect(tokens.attempts).toBe(2);
    // The stalled authorize never reached the server; the retry ran one full flow.
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1, replays: 0 });
  }, SLOW);

  test('a connect stall on the login hop is retried from a fresh flow', async () => {
    const target = await idp({ holdHop: (hop, connection) => hop === 'login' && connection === 1 ? 1_500 : 0 });
    const { tokens } = await success(login(target, { fetch: transport(400) }));
    expect(tokens.attempts).toBe(2);
    // The stalled login never reached the server; the retry re-authorized (new challenge) and logged in once.
    expect(target.counts).toEqual({ authorize: 2, login: 1, exchange: 1, replays: 0 });
  }, SLOW);

  test('a login dropped after the IdP consumed it is retried with a new flow, never replayed', async () => {
    const target = await idp({ dropLogin: login => login === 1 });
    const { tokens } = await success(login(target, { fetch: transport() }));
    expect(tokens.attempts).toBe(2);
    expect(target.counts).toEqual({ authorize: 2, login: 2, exchange: 1, replays: 0 });
  }, SLOW);

  test('a response that outlasts the step limit is a transient failure, and the budget bounds the total', async () => {
    const target = await idp({ delayLogin: () => 5_000 });
    const { error, ms } = await failure(login(target, { fetch: transport(), stepTimeoutMs: 300, budgetMs: 1_500, retryMinLeftMs: 100 }));
    expect(error.message).toContain('timed out');
    // Bounded by the budget, not by a fixed attempt count: the whole call stays well under the 5s step that never ends.
    expect(target.counts.login).toBeLessThanOrEqual(3);
    expect(ms).toBeLessThan(4_500);
  }, SLOW);

  // The core of the fix: an attempt that may still be followed cannot spend the whole budget. Its own deadline leaves
  // one full-flow envelope (retryMinLeftMs) for the next attempt, so a stall on its last hop ends it with budget left.
  test('a non-final attempt is capped so the retry keeps a whole-flow envelope', async () => {
    // Scaled down from production (75s budget / 30s reserve / 25s step): 9s / 4s / 3s. The exchange hop stalls past any
    // step limit, so attempt 1 is cut at 4s (9-4-1), leaving the retry its own envelope. Without the reserve the first
    // attempt would consume the whole 9s and the retry would never start.
    const target = await idp({ holdHop: (hop) => hop === 'exchange' ? 30_000 : 0 });
    const { error, ms } = await failure(login(target, { fetch: transport(10_000), budgetMs: 9_000, retryMinLeftMs: 4_000, stepTimeoutMs: 3_000 }));
    expect(error.message).toContain('timed out');
    // Each attempt ran its own authorize+login: the retry is a fresh flow, never a replayed code.
    expect(target.counts.authorize).toBeGreaterThanOrEqual(2);
    expect(ms).toBeLessThan(14_000);
  }, SLOW);

  // The QA shape with the production constants (75s budget / 25s step / 30s reserve / 20s connect cap): a connect stall
  // on an early hop of attempt 1, and another on the last hop (exchange) of attempt 2. The reserve and the retry guard
  // meet at 30s of budget, so an attempt cut by its own deadline used to leave the retry a hair under the guard's
  // threshold (left ≈ 29996ms) and the third attempt was rejected with "gave up after 2 attempts".
  test('the production constants recover a stall on an early hop and on the last hop of the second attempt', async () => {
    const target = await idp({
      holdHop: (hop, connection) => {
        // Attempt 1 stalls on the first hop: the transport's connect cap cuts it after 20s.
        if (hop === 'authorize' && connection === 1) return 60_000;
        // Attempt 2 gets through authorize and login, then stalls on the last hop: the attempt's own deadline cuts it.
        if (hop === 'authorize' && connection === 2) return 2_000;
        if (hop === 'login' && connection === 1) return 3_000;
        if (hop === 'exchange' && connection === 1) return 60_000;
        return 0;
      },
    });
    const { tokens, ms } = await success(login(target, { fetch: transport() }));
    expect(tokens.attempts).toBe(3);
    expect(tokens.accessToken.startsWith('at-')).toBe(true);
    // The stalled requests never reached the server, so only the third attempt consumed a code.
    expect(target.counts).toEqual({ authorize: 2, login: 2, exchange: 1, replays: 0 });
    expect(ms).toBeLessThan(75_000);
    expect(tokens.trace).toContain('a1:authorize');
    expect(tokens.trace).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(tokens.trace).toContain('a2:exchange');
    expect(tokens.trace).toContain('a3:exchange');
    for (const secret of [PASSWORD, 'login_challenge', 'code-', 'code_verifier', '/api/', '/t/ck']) expect(tokens.trace).not.toContain(secret);
  }, PRODUCTION_SHAPE);

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
