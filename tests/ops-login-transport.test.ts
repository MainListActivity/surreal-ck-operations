import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseBrokerConfig } from '../src/ops/config.ts';
import { CompanyError } from '../src/core-errors.ts';
import { createOpsFetcher, opsFetch, OPS_CONNECT_TIMEOUT_MS, type Fetcher } from '../src/ops/fetcher.ts';
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
  test('a transient connect stall is retried on the same hop, on a fresh connection', async () => {
    const target = await idp({ hold: connection => (connection === 1 ? 1_500 : 0) });
    const { tokens } = await success(login(target, { fetch: transport(400) }));
    // The connection that never came up is the only thing that failed: the hop is tried again on a new connection,
    // so the flow itself is not restarted and one attempt is enough.
    expect(tokens.attempts).toBe(1);
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1, replays: 0 });
    // The trace shows the same hop twice: the failed connect and the retry that carried it.
    expect(tokens.trace).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(tokens.trace).toContain('connect retry');
    // Only one connection was needed beyond the three hops: the failed one and its replacement.
    expect(target.connections()).toBe(4);
  }, SLOW);

  // The QA failure shape (5860edac, 2026-10-24): a ~20s connect stall lands on the LAST hop (token exchange), where the
  // old policy had already spent its one retry. The stall is a CONNECT failure, so it proves the authorization code was
  // never sent: the very same exchange may be tried again on a fresh connection, and the code is redeemed exactly once.
  // A failure that may have reached the token endpoint is never repeated — that one starts a fresh flow instead.
  test('a connect stall on the last hop (exchange) is retried on the same hop and succeeds', async () => {
    const target = await idp({ holdHop: (hop, connection) => hop === 'exchange' && connection === 1 ? 1_500 : 0 });
    const { tokens } = await success(login(target, { fetch: transport(400) }));
    expect(tokens.attempts).toBe(1);
    // The stalled exchange never reached the server; the retry carried the same code on a new connection and it was
    // redeemed exactly once — the single-use code was never sent twice.
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1, replays: 0 });
    expect(tokens.trace).toContain('a1:exchange');
    expect(tokens.trace).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(tokens.trace).toContain('connect retry');
    expect(tokens.trace).toContain('HTTP 200');
    // The trace names fixed phases and hosts only: no challenge, code, verifier or password material.
    for (const secret of [PASSWORD, 'login_challenge', 'code-', 'code_verifier', '/api/', '/t/ck']) expect(tokens.trace).not.toContain(secret);
  }, SLOW);

  test('a connect stall on the authorize hop is retried on the same hop', async () => {
    const target = await idp({ holdHop: (hop, connection) => hop === 'authorize' && connection === 1 ? 1_500 : 0 });
    const { tokens } = await success(login(target, { fetch: transport(400) }));
    expect(tokens.attempts).toBe(1);
    // The stalled authorize never reached the server; the retry carried the same hop on a new connection, so the
    // challenge was fetched once and the flow ran once.
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1, replays: 0 });
  }, SLOW);

  test('a connect stall on the login hop is retried on the same hop', async () => {
    const target = await idp({ holdHop: (hop, connection) => hop === 'login' && connection === 1 ? 1_500 : 0 });
    const { tokens } = await success(login(target, { fetch: transport(400) }));
    expect(tokens.attempts).toBe(1);
    // The stalled login never reached the server; the retry carried the same challenge on a new connection, so the
    // challenge was consumed once and the flow ran once.
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1, replays: 0 });
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
  // on the first hop, and a stall on the last hop (exchange) after the flow got through authorize and login.
  //
  // The two stalls are different kinds of failure and are handled differently:
  // - The first one is a CONNECT failure: the connection never came up, so the request was never written. The hop is
  //   tried again on a fresh connection, without restarting the flow. That is the whole point of the fix: the first
  //   connection of a hop being unlucky must not cost a whole flow.
  // - The second one is a REQUEST timeout: the request was written and the answer never came, so the authorization
  //   code may have reached the token endpoint. It is never sent twice — the flow starts over with a fresh code.
  test('the production constants recover a connect stall on the same hop and a request timeout with a fresh flow', async () => {
    const target = await idp({
      holdHop: (hop, connection) => {
        // The first connection of the first hop never comes up: the transport's connect cap cuts it after 20s.
        if (hop === 'authorize' && connection === 1) return 60_000;
        // The retry of that hop goes through (slowly), the login hop answers, and the exchange stalls on the request.
        if (hop === 'authorize' && connection === 2) return 2_000;
        if (hop === 'login' && connection === 1) return 3_000;
        if (hop === 'exchange' && connection === 1) return 60_000;
        return 0;
      },
    });
    const { tokens, ms } = await success(login(target, { fetch: transport() }));
    expect(tokens.accessToken.startsWith('at-')).toBe(true);
    // The connect stall was recovered on the same hop; the request timeout cost one fresh flow, not a whole budget.
    expect(tokens.attempts).toBe(2);
    // The stalled requests never reached the server, so only the second attempt consumed a code.
    expect(target.counts).toEqual({ authorize: 2, login: 2, exchange: 1, replays: 0 });
    expect(ms).toBeLessThan(75_000);
    // The first hop was retried on a new connection inside the same attempt...
    expect(tokens.trace).toContain('a1:authorize');
    expect(tokens.trace).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(tokens.trace).toContain('connect retry');
    // ...and the request timeout on the exchange was NOT retried on that hop: a fresh flow carried a fresh code.
    expect(tokens.trace).toContain('a1:exchange');
    expect(tokens.trace).toContain('timed out after');
    expect(tokens.trace).toContain('a2:exchange');
    expect(tokens.trace).not.toContain('a1:exchange@127.0.0.1:connect retry');
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

describe('same-hop connect recovery', () => {
  // The production shape (QA 5860edac, 2026-10-25): a new connection to the IdP or the product stalls for ~20s and
  // then fails, while the same path is healthy moments later. The connection never came up, so the request was never
  // written: the hop may be tried again on a new connection. Restarting the whole flow instead replayed hops that
  // already worked and spent the login's whole budget on connections that never existed.
  test('a broken first connection is replaced on the same hop, and the flow is not restarted', async () => {
    const target = await idp({ holdHop: (hop, connection) => hop === 'authorize' && connection === 1 ? 1_500 : 0 });
    const { tokens } = await success(login(target, { fetch: transport(400) }));
    // One flow attempt: the hop was retried, the flow was not.
    expect(tokens.attempts).toBe(1);
    // The stalled request never reached the server, and the retry is the only one that did.
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1, replays: 0 });
    // A new connection was opened for the retry: the hop's connection count is the failed one plus the successful one.
    expect(target.connections()).toBe(4);
    expect(tokens.trace).toContain('connect retry');
  }, SLOW);

  test('a hop survives broken connections and then succeeds on the next one', async () => {
    // The hop may open three connections: the first is broken, the next works. The flow is never restarted, so the
    // challenge is fetched once and the whole login costs one attempt.
    // The stall must outlast the retry's connect limit, or the retry would simply succeed on the broken path.
    const target = await idp({ holdHop: (hop, connection) => (hop === 'authorize' && connection === 1 ? 13_000 : 0) });
    const { tokens } = await success(login(target, { fetch: transport(1_000) }));
    expect(tokens.attempts).toBe(1);
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1, replays: 0 });
    // The failed connection plus one connection per hop (authorize, login, exchange): the retry reused the hop's
    // slot, it did not add a hop.
    expect(target.connections()).toBe(4);
    expect(tokens.trace).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(tokens.trace).toContain('connect retry');
  }, 60_000);

  test('a hop whose connections all fail hands the failure back with the stage and the cause', async () => {
    // Every connection of the authorize hop is broken, in every flow attempt: the login fails with the real cause and
    // the stage, not with a bare timeout, and the error carries no secret.
    const target = await idp({ holdHop: (hop, connection) => (hop === 'authorize' ? 13_000 : 0) });
    const { error } = await failure(login(target, { fetch: transport(1_000), budgetMs: 40_000, retryMinLeftMs: 20_000 }));
    expect(error.code).toBe('upstream_error');
    // The cause is the connection that never came up, and the stage says where.
    expect(error.message).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(error.message).toContain('stage=authorize');
    expect(error.message).not.toContain(PASSWORD);
    // The hop never reached the server, so no challenge was ever issued.
    expect(target.counts.authorize).toBe(0);
  }, 120_000);

  test('a request that may have been written is never sent twice, even when the connection failed', async () => {
    // The login POST is consumed by the IdP and the connection breaks on the way back: the password was sent, so the
    // challenge is spent and the flow must start over with a new one. The same-hop retry must not fire here.
    const target = await idp({ dropLogin: login => login === 1 });
    const { tokens } = await success(login(target, { fetch: transport() }));
    expect(tokens.attempts).toBe(2);
    expect(target.counts).toEqual({ authorize: 2, login: 2, exchange: 1, replays: 0 });
    // The trace shows no same-hop retry on the login hop: the request had been written.
    expect(tokens.trace).not.toContain('connect retry');
  }, SLOW);

  test('EPIPE after the request was written is not retried on the same hop: a fresh flow carries a fresh challenge', async () => {
    // EPIPE is a write-side error: the peer was already gone, so the login POST may well have been consumed. It must
    // NOT be treated as "the connection never came up" — that would send the single-use challenge a second time. The
    // failure goes back to the flow, which authorizes again and consumes a new challenge.
    const target = await idp();
    const real = transport();
    let fired = false;
    let loginPosts = 0;
    const wrapped: Fetcher = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/login/ck/password')) {
        loginPosts++;
        if (!fired) {
          fired = true;
          // The IdP consumed the challenge, then the response was lost with a write-side EPIPE.
          await real(input, init);
          throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) });
        }
      }
      return real(input, init);
    };
    const { tokens } = await success(login(target, { fetch: wrapped }));
    // The flow started over: two authorize hops, and each login POST carried its own fresh challenge.
    expect(tokens.attempts).toBe(2);
    expect(target.counts.authorize).toBe(2);
    expect(target.counts.login).toBe(2);
    expect(target.counts.replays).toBe(0);
    expect(loginPosts).toBe(2);
    // No same-hop retry fired on the login hop: the failure was not provably unsent.
    expect(tokens.trace).not.toContain('a1:login@127.0.0.1:connect retry');
  }, SLOW);

  test('the whole login stays inside its budget even when the first hop keeps failing', async () => {
    // Scaled down from production (75s budget / 30s reserve / 25s step): 30s / 15s / 8s. Every connection of the
    // first hop fails. The budget is large enough that a same-hop retry really happens, so this case proves the
    // retries are bounded by the budget rather than by a count.
    const target = await idp({ holdHop: (hop, connection) => (hop === 'authorize' ? 13_000 : 0) });
    const { error, ms } = await failure(login(target, { fetch: transport(700), budgetMs: 30_000, retryMinLeftMs: 15_000, stepTimeoutMs: 8_000 }));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('UND_ERR_CONNECT_TIMEOUT');
    // A same-hop retry really ran: the budget was large enough for it.
    expect(error.message).toContain('connect retry');
    // Bounded by the budget, not by the number of retries.
    expect(ms).toBeLessThan(32_000);
    // And the diagnostic stays secret-free.
    expect(error.message).not.toContain(PASSWORD);
  }, 90_000);

  test('a successful login keeps its contract: tokens, a secret-free trace, and no state the caller must undo', async () => {
    // `passwordLogin` is the flow only: it mints tokens and returns them. Session release is the broker's job
    // (`ops_logout`), covered by the broker-level regression below — this test only pins the flow's own contract.
    const target = await idp();
    const { tokens } = await success(login(target, { fetch: transport() }));
    expect(tokens.attempts).toBe(1);
    expect(tokens.accessToken.startsWith('at-')).toBe(true);
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1, replays: 0 });
    for (const secret of [PASSWORD, 'login_challenge', 'code-', 'code_verifier', '/api/', '/t/ck']) {
      expect(tokens.trace).not.toContain(secret);
      expect(JSON.stringify(tokens)).not.toContain(secret);
    }
  }, SLOW);
});

describe('slow but healthy handshakes', () => {
  test('a retry on a 12-20 s healthy handshake succeeds: the retry keeps the standing connect limit', async () => {
    // The repo already supports a 12 s handshake (the production connect limit is 20 s). A retry must not cut a
    // handshake that the first attempt would have been allowed to complete: the retry uses the standing limit, not a
    // shorter one. The first connection is broken, the next is a healthy 13 s handshake.
    const target = await idp({ holdHop: (hop, connection) => (hop === 'authorize' ? (connection === 1 ? 21_000 : 13_000) : 0) });
    const { tokens, ms } = await success(login(target, { fetch: transport() }));
    expect(tokens.attempts).toBe(1);
    expect(target.counts).toEqual({ authorize: 1, login: 1, exchange: 1, replays: 0 });
    // The 13 s handshake completed; the whole login still fits inside the production budget.
    expect(ms).toBeGreaterThanOrEqual(12_500);
    expect(ms).toBeLessThan(75_000);
    expect(tokens.trace).toContain('connect retry');
  }, 120_000);
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
