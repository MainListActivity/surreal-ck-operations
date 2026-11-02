import { describe, expect, test } from 'bun:test';
import type { BrokerConfig } from '../src/ops/config.ts';
import { CompanyError } from '../src/core-errors.ts';
import type { Fetcher } from '../src/ops/fetcher.ts';
import { LoginError, passwordLogin, type LoginOptions, type LoginTokens } from '../src/ops/idp.ts';
import { OpsBroker } from '../src/ops/broker.ts';
import { brokerConfig, FakeCompany, FakeWorld } from './support/ops-world.ts';

// Deterministic replay of the two recorded production failures (fc3d5cfc diagnosis, §2): the clock
// and the transport are stubs, so every hop's wall time is the script's own numbers and the budget
// arithmetic can be asserted exactly. No socket, no real timer: the scripted fetch advances the
// clock and then succeeds or throws, so `passwordLogin` sees the recorded shape without waiting.
const PASSWORD = 'PW-SECRET-1';
const CODE = 'CODE-SECRET-1';
const TOKEN = 'AT-SECRET-1';

const config: BrokerConfig = {
  roles: ['qa', 'engineering'],
  idp: { issuer: 'https://auth.test/t/ck', clientId: 'client-ck-1234', audience: 'https://auth.test', redirectUri: 'https://app.test/auth/callback', scope: 'openid' },
  product: { url: 'https://app.test' },
  accounts: { prefix: 'sck-', emailDomain: 'example.test', workspacePrefix: 'sck-' },
  limits: { workspacesPerDay: 2, accountsPerDay: 3 },
};

type Fail = 'connect-timeout' | 'timeout';

interface Hop {
  /** Scripted wall time of the hop; the stub advances the clock by it before answering. */
  ms: number;
  fail?: Fail;
  status?: number;
  /** 302 target; `@login-page` is the IdP's login page with a fresh challenge. */
  location?: string;
  body?: unknown;
}

class ScriptedIdp {
  clock = 0;
  readonly calls: Array<{ kind: 'authorize' | 'login' | 'exchange'; url: string }> = [];
  private hops: Hop[] = [];
  private state = '';

  get t(): number { return this.clock; }

  script(hops: Hop[]) {
    this.hops = [...hops];
    this.calls.length = 0;
    this.state = '';
  }

  private hop(kind: 'authorize' | 'login' | 'exchange'): Hop {
    const hop = this.hops.shift();
    if (!hop) throw new Error(`script ran dry at a ${kind} hop`);
    return hop;
  }

  readonly fetch: Fetcher = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    const kind = u.pathname.endsWith('/password') ? 'login' as const : u.pathname.endsWith('/token') ? 'exchange' as const : 'authorize' as const;
    this.calls.push({ kind, url });
    const hop = this.hop(kind);
    this.clock += hop.ms;
    if (hop.fail === 'connect-timeout') {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    }
    if (hop.fail === 'timeout') {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }
    if (kind === 'authorize' && u.searchParams.has('state')) this.state = u.searchParams.get('state') ?? '';
    const location = hop.location === '@login-page' ? 'https://auth.test/login/ck?login_challenge=CH-SECRET-1' : hop.location;
    // The login hop's callback placeholder carries the code and the state the authorize hop had.
    const body = (hop.body as { redirect_uri?: string } | undefined)?.redirect_uri === '@callback'
      ? { redirect_uri: `https://app.test/auth/callback?code=${CODE}&state=${this.state}` }
      : hop.body;
    return new Response(
      body === undefined ? undefined : JSON.stringify(body),
      { status: hop.status ?? (location ? 302 : 200), headers: { ...(location ? { location } : {}), 'content-type': 'application/json' } },
    );
  };

  /** The login hop's callback: the stub fills the code and the state the authorize hop carried. */
  callback(): { redirect_uri: string } {
    return { redirect_uri: `https://app.test/auth/callback?code=${CODE}&state=${this.state}` };
  }

  count(kind: 'authorize' | 'login' | 'exchange'): number {
    return this.calls.filter(c => c.kind === kind).length;
  }
}

const login = (idp: ScriptedIdp, options: Omit<LoginOptions, 'fetch' | 'clock'> = {}) =>
  passwordLogin(config, 'sck-lca04', PASSWORD, { fetch: idp.fetch, clock: () => idp.clock, ...options });

const failure = async (run: Promise<unknown>): Promise<CompanyError> => {
  try { await run; } catch (error) { return error as CompanyError; }
  throw new Error('expected the login to fail');
};

// The login-page hop every flow starts with.
const challenge = (ms: number): Hop => ({ ms, location: '@login-page' });
// A healthy login POST and token exchange for a flow that reaches the tokens.
const passwordOk = (ms: number): Hop => ({ ms, body: { redirect_uri: '@callback' } });
const exchangeOk = (ms: number): Hop => ({ ms, body: { access_token: TOKEN, expires_in: 900 } });

describe('recorded failure replay (deterministic clock and transport)', () => {
  // Failure #1 (17:29:52Z): a1 rides two 20.5s connect stalls to its 44s cap; the old shape then
  // handed a2 a 2s floor (max(32.5-31, 2)), which died and left the last attempt 30.5s. The fix
  // skips that floor-budget middle attempt: the last attempt keeps the whole 32.5s remainder.
  test('failure #1: the 2s middle attempt is skipped, the last attempt keeps its 32.5s', async () => {
    const idp = new ScriptedIdp();
    idp.script([
      { ms: 1400, location: 'https://auth.test/interstitial' }, // a1 H1: slow but healthy 302
      { ms: 20500, fail: 'connect-timeout' }, // a1 H2: connect stall #1
      { ms: 20500, fail: 'connect-timeout' }, // a1 H2 retry: connect stall #2 → a1 dies at 42.4s of its 44s cap
      { ms: 12400, location: 'https://auth.test/interstitial' }, // a2 (the last flow): slow but healthy 302
      { ms: 20200, fail: 'timeout' }, // a2 H2: the budget line cuts it at 75s
    ]);
    const error = await failure(login(idp));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('gave up after 2 attempts');
    // The floor-budget middle attempt never ran: no flow row beyond the two real ones, and no 2s
    // step anywhere. (The skipped attempt burns no challenge: only 2 authorize chains ran.)
    expect(error.message).not.toContain('a3:');
    expect(error.message).not.toContain('timed out after 2s');
    expect(idp.count('authorize')).toBe(5);
    expect(idp.count('login')).toBe(0);
    // The budget is the same 75s it always was; the whole call ends on the budget line.
    expect(idp.t).toBe(75_000);
    // The first attempt's same-hop retry is still there, and the trace stays secret-free.
    expect(error.message).toContain('connect retry');
    expect(error.message).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).not.toContain('CH-SECRET');
  });

  // Failure #2 (17:47:19Z): a1 dies at its 44s cap, leaving exactly 31s — the old shape spent a 2s
  // floor middle attempt and then the 30s gate refused the last attempt outright. The fix skips the
  // floor attempt, so the last attempt gets the whole 31s (whether it can finish is not promised).
  test('failure #2, exhausted: the middle attempt is skipped and the last attempt runs on the full 31s', async () => {
    const idp = new ScriptedIdp();
    idp.script([
      { ms: 20400, fail: 'connect-timeout' }, // a1 H1: connect stall
      { ms: 6900, location: 'https://auth.test/interstitial' }, // a1 H1 retry: 302 to the next hop
      { ms: 16700, fail: 'timeout' }, // a1 H2: cut at the 44s attempt cap
      { ms: 31000, fail: 'timeout' }, // a2 (the last flow): the budget line
    ]);
    const error = await failure(login(idp));
    expect(error.message).toContain('gave up after 2 attempts');
    expect(error.message).not.toContain('a3:');
    expect(error.message).not.toContain('timed out after 2s');
    expect(idp.t).toBe(75_000);
    expect(idp.count('authorize')).toBe(4);
    expect(idp.count('login')).toBe(0);
  });

  test('failure #2, last attempt succeeds: the preserved 31s can carry a full flow', async () => {
    const idp = new ScriptedIdp();
    idp.script([
      { ms: 20400, fail: 'connect-timeout' },
      { ms: 6900, location: 'https://auth.test/interstitial' },
      { ms: 16700, fail: 'timeout' },
      challenge(3000),
      passwordOk(4000),
      exchangeOk(6000),
    ]);
    const tokens: LoginTokens = await login(idp);
    expect(tokens.attempts).toBe(2);
    expect(tokens.elapsedMs).toBe(57_000);
    expect(idp.count('authorize')).toBe(4);
    expect(idp.count('login')).toBe(1);
    expect(idp.count('exchange')).toBe(1);
  });
});

describe('floor-skip boundaries', () => {
  test('an early first failure leaves room: the middle attempt runs with its full envelope', async () => {
    // a1 dies at 5s; left ≈ 70s, so the middle attempt's envelope (70-31 = 39s) is above the step
    // limit and the skip must not fire: two real flows, no behavior change from the fix.
    const idp = new ScriptedIdp();
    idp.script([
      { ms: 5000, fail: 'timeout' },
      challenge(1400),
      passwordOk(1500),
      exchangeOk(1000),
    ]);
    const tokens = await login(idp);
    expect(tokens.attempts).toBe(2);
    expect(tokens.elapsedMs).toBe(8900);
    expect(idp.count('authorize')).toBe(2);
  });

  test('at the threshold the middle attempt still runs (25s funds one full step); one millisecond less and it is skipped', async () => {
    // left - 31s == 25s exactly: the middle attempt's envelope funds one full step, so it runs.
    const atThreshold = new ScriptedIdp();
    atThreshold.script([
      { ms: 19_000, fail: 'timeout' }, // left 56s → envelope exactly 25s
      challenge(1000),
      passwordOk(800),
      exchangeOk(700),
    ]);
    const kept = await login(atThreshold);
    expect(kept.attempts).toBe(2);
    // The middle attempt really ran: it consumed a challenge.
    expect(atThreshold.count('authorize')).toBe(2);
    expect(atThreshold.count('login')).toBe(1);

    // One millisecond less: the envelope is 24.999s, below one full step — skipped.
    const below = new ScriptedIdp();
    below.script([
      { ms: 19_001, fail: 'timeout' },
      challenge(1000),
      { ms: 25_000, fail: 'timeout' }, // the last flow's login POST times out past the gate
    ]);
    const skipped = await failure(login(below));
    expect(skipped.message).toContain('gave up after 2 attempts');
    // Only two authorize chains ran: the middle attempt never touched the IdP. The last flow's
    // own login POST is the one that timed out past the gate.
    expect(below.count('authorize')).toBe(2);
    expect(below.count('login')).toBe(1);
  });

  test('a remainder above the 30s gate skips the floor attempt and hands everything to the last one', async () => {
    const idp = new ScriptedIdp();
    idp.script([
      { ms: 44_500, fail: 'timeout' }, // a1 dies with 30.5s left
      challenge(1000),
      passwordOk(900),
      exchangeOk(800),
    ]);
    const tokens = await login(idp);
    // The old shape would have given the middle attempt max(30.5-31, 2s) — the floor. The last
    // attempt now runs on the whole 30.5s and carries the flow.
    expect(tokens.attempts).toBe(2);
    expect(tokens.elapsedMs).toBe(47_200);
  });

  test('a remainder under the 30s gate still gives up: the skip never bypasses the gate', async () => {
    const idp = new ScriptedIdp();
    idp.script([
      { ms: 45_100, fail: 'timeout' }, // a1 dies with 29.9s left — under the retry gate
    ]);
    const error = await failure(login(idp));
    // One flow ran and the gate refused the next: the message names the failure without a retry count
    // (the count suffix only appears once more than one flow ran), and no further request went out.
    expect(error.message).toContain('IdP authorize failed');
    expect(error.message).not.toContain('gave up after');
    // Nothing ran after the failed attempt: the gate refused before any request went out.
    expect(idp.count('authorize')).toBe(1);
    expect(idp.t).toBe(45_100);
  });
});

describe('unchanged edges', () => {
  test('a healthy first attempt is untouched: one flow, the skip never fires', async () => {
    const idp = new ScriptedIdp();
    idp.script([challenge(1400), passwordOk(1500), exchangeOk(1000)]);
    const tokens = await login(idp);
    expect(tokens.attempts).toBe(1);
    expect(tokens.elapsedMs).toBe(3900);
    expect(idp.count('authorize')).toBe(1);
  });

  test('a login refusal is final even with the whole budget left', async () => {
    const idp = new ScriptedIdp();
    idp.script([
      challenge(1000),
      { ms: 800, status: 401, body: { error: 'invalid_credentials' } },
    ]);
    const error = await failure(login(idp));
    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).reason).toBe('invalid_credentials');
    expect(idp.count('login')).toBe(1);
    expect(idp.count('authorize')).toBe(1);
    expect(idp.t).toBe(1800);
  });

  test('a consent demand on the customer channel is refused and never retried', async () => {
    const idp = new ScriptedIdp();
    idp.script([
      challenge(1000),
      { ms: 800, body: { redirect_uri: 'https://app.test/auth/callback?consent_challenge=CC-SECRET-1' } },
    ]);
    const error = await failure(login(idp));
    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).reason).toBe('consent_required');
    expect(idp.count('login')).toBe(1);
    expect(idp.t).toBe(1800);
  });

  test('the failure message never carries a credential, challenge, code or token', async () => {
    const idp = new ScriptedIdp();
    idp.script([
      challenge(1000),
      passwordOk(500),
      { ms: 500, fail: 'connect-timeout' },
      { ms: 500, fail: 'connect-timeout' },
      challenge(500),
      passwordOk(500),
      { ms: 500, fail: 'timeout' },
    ]);
    const error = await failure(login(idp));
    const text = `${error.message}`;
    for (const secret of [PASSWORD, 'CH-SECRET', CODE, TOKEN, 'user_session', 'code_verifier']) {
      expect(text).not.toContain(secret);
    }
  });
});

// Fix B: the fault ledger's elapsedMs is the call's own monotone wall time, so the ledger can tell
// slow from broken. The two recorded failures both showed elapsedMs = 0.
describe('fault ledger elapsedMs', () => {
  interface Reported { phase?: string; elapsedMs?: number; errno?: string; target?: string }
  function rig(reported: Reported[]) {
    const world = new FakeWorld();
    const company = new FakeCompany();
    company.env('demo', 'production', brokerConfig(), { healthUrl: 'https://app.test/health' });
    // A deterministic monotone clock: the fixtures set what one stalled authorize costs, so the
    // recorded elapsedMs is exact rather than real (sub-millisecond) time.
    let mono = 0;
    let faultCostMs = 0;
    const countingFetch: Fetcher = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const u = new URL(url);
      if (u.host === 'idp.test' && u.pathname.endsWith('/authorize')) mono += faultCostMs;
      return world.fetch(input, init);
    };
    const broker = new OpsBroker({
      core: {
        ...company.core,
        reportFault: async (scope: unknown, input: Reported) => { reported.push(input); return { allowed: true, message: '', evidence: {} }; },
      } as never,
      projects: company.projects as never, secretKey: () => Buffer.alloc(32),
      fetch: countingFetch, now: world.now, d1: () => world.d1, queryAsUser: world.queryAsUser, browser: world.browser,
      sleep: async (ms) => { world.clock += ms; },
      monoNow: () => mono,
    });
    return { world, company, broker, qa: company.lease('qa-1', 'qa', 'task-1'), setFaultCostMs: (ms: number) => { faultCostMs = ms; } };
  }

  const fail = async (promise: Promise<unknown>) => {
    try { await promise; } catch (error) { return error as CompanyError; }
    throw new Error('expected the call to fail');
  };

  test('an early login failure records its real wall time, not zero', async () => {
    const reported: Reported[] = [];
    const r = rig(reported);
    await r.broker.call(r.qa, 'task-1', 'ops_account_ensure', { alias: 'qa-one' });
    // Every connection to the IdP breaks at once: the flow burns its attempts within the scripted clock.
    r.setFaultCostMs(500);
    r.world.fault((_method, url) => url.host === 'idp.test' && url.pathname.endsWith('/authorize'), 'reset', { times: 20 });
    const error = await fail(r.broker.call(r.qa, 'task-1', 'ops_login', { alias: 'qa-one' }));
    expect(error.code).toBe('upstream_error');
    expect(reported).toHaveLength(1);
    expect(reported[0].phase).toBe('login');
    // No longer the constant 0: the ledger now carries the call's real wall time. (The exact
    // arithmetic is the deterministic replay suite's job; here every flow burns scripted connect
    // stalls, so the recorded value is whatever those hops added up to — strictly positive.)
    expect(reported[0].elapsedMs ?? 0).toBeGreaterThan(0);
  });

  test('a budget-exhausted login records the whole call, and a successful one records nothing', async () => {
    const reported: Reported[] = [];
    const r = rig(reported);
    await r.broker.call(r.qa, 'task-1', 'ops_account_ensure', { alias: 'qa-one' });
    // Every authorize request hangs past its step; exactly three failures exhaust the scripted
    // fault so the login after it can succeed through the same world.
    r.setFaultCostMs(20_000);
    r.world.fault((_method, url) => url.host === 'idp.test' && url.pathname.endsWith('/authorize'), 'timeout', { times: 3 });
    const error = await fail(r.broker.call(r.qa, 'task-1', 'ops_login', { alias: 'qa-one' }));
    expect(error.message).toContain('gave up after');
    expect(reported).toHaveLength(1);
    // The exhausted login records the whole call — every flow's stalls included — instead of 0.
    // The scripted transport costs 20s per authorize hop; the clock here is the broker's monotone
    // one, so the ledger row is exact: three flows, one authorize hop each, 20s apiece.
    expect(reported[0].elapsedMs).toBe(60_000);
    // A call that works settles its fault object and never writes a failure row.
    const okReported = reported.length;
    await r.broker.call(r.qa, 'task-1', 'ops_login', { alias: 'qa-one' });
    expect(reported).toHaveLength(okReported);
  });
});
