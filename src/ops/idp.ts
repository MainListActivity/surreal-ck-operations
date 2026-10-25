import { createHash, randomBytes } from 'node:crypto';
import { CompanyError } from '../core-errors.ts';
import type { BrokerConfig } from './config.ts';
import { describeTransportFailure, isTlsTrustFailure, opsFetch, type Fetcher } from './fetcher.ts';

/** Raised when the IdP refuses the login; `reason` is the IdP's error code, never a credential. */
export class LoginError extends CompanyError {
  constructor(readonly reason: string, message: string) {
    super('login_failed', message);
  }
}

export interface LoginTokens {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** How many full authorize→exchange flows ran (transient failures burn one each). */
  attempts: number;
  /**
   * Sanitized per-hop trace (`a<attempt>:<phase>@<host>:<HTTP status|errno> <ms>`), bounded
   * to the tail of the flow. Hosts and outcomes only — never paths, challenges or tokens —
   * so a transport failure can be located without weakening the audit surface.
   */
  trace: string;
}

/**
 * `customer` rides the product web app's client, `operator` the dedicated ops public client
 * redeemed at the product's token proxy, and `ops` a public client redeemed straight at the
 * IdP's own `/token` endpoint (no product hop, no client secret).
 */
export type LoginChannel = 'customer' | 'operator' | 'ops';

export interface LoginOptions {
  fetch?: Fetcher;
  now?: () => number;
  /** Limit for one HTTP request; tests shrink it. */
  stepTimeoutMs?: number;
  /** Limit for all attempts together; tests shrink it. */
  budgetMs?: number;
  /** Time that must remain before a second attempt starts; tests shrink it with the budget. */
  retryMinLeftMs?: number;
  channel?: LoginChannel;
}

const MAX_HOPS = 8;
const MAX_ATTEMPTS = 3;
// The IdP and the product are reached over a WAN where a single request of 5-10s happens; a healthy login takes 8-17s in total.
// Every step's signal caps its connect too (the transport's connect limit, 20s, only ever cuts earlier), so a slow connect spends the step and the budget.
const STEP_TIMEOUT_MS = 25_000;
// All attempts together stay well inside the 120s an employee waits for one tool call, which also has to list workspaces afterwards.
const BUDGET_MS = 75_000;
// One full flow's budget envelope: what a retry needs to finish, including a worst-case connect stall on its last hop.
// Every attempt before the last reserves one envelope for the attempt after it, so a stall at the end of an earlier
// attempt cannot spend the budget the fresh flow needs. This is what makes a last-hop connect stall recoverable.
const RETRY_MIN_LEFT_MS = 30_000;
const MIN_STEP_MS = 2_000;

const fail = (what: string, detail: string | number) => new CompanyError('upstream_error', `${what} failed (${detail})`, true);

/** The network or the upstream's availability failed, not the login itself: a fresh attempt may well succeed. */
class Unavailable extends CompanyError {
  constructor(what: string, detail: string | number) {
    super('upstream_error', `${what} failed (${detail})`, true);
  }
}

interface Io {
  fetcher: Fetcher;
  /** A fresh limit for the next request: the per-step limit, cut down to what is left of the attempt and of the budget. */
  step: () => { signal: AbortSignal; ms: number };
  /** Milliseconds left of the whole-login budget, for the retry decision. */
  left: () => number;
  /** 1-based attempt currently in flight, stamped onto each trace row. */
  attempt: number;
  /** Sanitized hop records: phase, origin host, HTTP status or safe errno, wall time. */
  trace: Array<{ attempt: number; phase: string; host: string; ms: number; result: string }>;
}

/** `bun@1.2.x` or `node@22.x`, recorded once in diagnostics for runtime comparisons. */
const runtimeVersion = (): string => {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  return bun?.version ? `bun@${bun.version}` : `node@${process.version}`;
};

const TRACE_TAIL = 10;

function formatTrace(io: Io): string {
  return io.trace.slice(-TRACE_TAIL).map(t => `a${t.attempt}:${t.phase}@${t.host}:${t.result} ${t.ms}ms`).join(' | ');
}

/** Fixed phase names, so a batch of login failures can be located without another real login. */
type LoginStage = 'authorize' | 'login' | 'consent' | 'exchange';

/** The last phase the flow reached, mapped onto the fixed stage vocabulary. */
function lastStage(io: Io): LoginStage | undefined {
  const phase = io.trace.at(-1)?.phase;
  if (!phase) return undefined;
  if (phase.startsWith('authorize')) return 'authorize';
  if (phase === 'login') return 'login';
  if (phase === 'consent') return 'consent';
  if (phase === 'exchange') return 'exchange';
  return undefined;
}

/** One request, optionally with its JSON body; a timeout while the body is read counts as a timeout of the request. */
async function request(what: string, io: Io, url: string, init: RequestInit, parseBody = false, phase?: string): Promise<{ response: Response; body?: unknown }> {
  const { signal, ms } = io.step();
  const started = Date.now();
  let host = 'unknown';
  try { host = new URL(url).host; } catch { /* unreachable host is still recorded */ }
  try {
    const response = await io.fetcher(url, { ...init, signal });
    const body = parseBody
      ? await response.json().catch((error: Error) => { if (error.name === 'TimeoutError') throw error; return undefined; })
      : undefined;
    io.trace.push({ attempt: io.attempt, phase: phase ?? what, host, ms: Date.now() - started, result: `HTTP ${response.status}` });
    return { response, body };
  } catch (error) {
    const { detail } = describeTransportFailure(error, ms);
    io.trace.push({ attempt: io.attempt, phase: phase ?? what, host, ms: Date.now() - started, result: detail });
    // An untrusted certificate fails the same way on every attempt, so it is final and never retried.
    if (isTlsTrustFailure(error)) throw fail(what, `TLS certificate not trusted: ${detail}`);
    throw new Unavailable(what, detail);
  }
}

/** The `user_session` cookie the IdP's password route just set, bound to the consent POST. */
function browserSessionCookie(headers: Headers): string | undefined {
  const getAll = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  const entries = typeof getAll === 'function' ? getAll.call(headers) : [headers.get('set-cookie')].filter((v): v is string => v !== null);
  return entries.map(entry => entry.split(';', 1)[0].trim()).find(entry => entry.startsWith('user_session='));
}

/**
 * DCR-registered public clients carry consent_policy `require`, so the password route answers
 * with the IdP's consent page URL (`?consent_challenge=`) instead of the client callback. The
 * broker approves on behalf of the held credential (the IdP records
 * `oidc.authorization.consent.granted`) and follows the 302 to the real code-bearing callback.
 */
async function settleConsent(consentUrl: URL, loginHeaders: Headers, io: Io): Promise<URL> {
  const challenge = consentUrl.searchParams.get('consent_challenge');
  if (!challenge) throw new LoginError('bad_callback', 'IdP callback lacked a matching code/state');
  const cookie = browserSessionCookie(loginHeaders);
  const { response, body } = await request('IdP consent', io, consentUrl.toString(), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({ consent_challenge: challenge, decision: 'approve' }).toString(),
  }, true, 'consent');
  if (response.status >= 500) throw new Unavailable('IdP consent', `HTTP ${response.status}`);
  const location = response.headers.get('location');
  if (location) return new URL(location, consentUrl.toString());
  const reason = typeof (body as { error?: unknown } | undefined)?.error === 'string'
    ? ((body as { error: string }).error).replace(/[^\w.-]/g, '').slice(0, 60)
    : `http_${response.status}`;
  throw new LoginError(reason, `IdP consent was refused (${reason})`);
}

/** Follows authorize redirects by hand until one carries the IdP's login challenge. */
async function findLoginChallenge(authorizeUrl: string, io: Io): Promise<{ challenge: string; loginApi: string }> {
  let current = authorizeUrl;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const { response } = await request('IdP authorize', io, current, { redirect: 'manual' }, false, `authorize#${hop}`);
    if (response.status >= 500) throw new Unavailable('IdP authorize', `HTTP ${response.status}`);
    const location = response.headers.get('location');
    if (response.status < 300 || response.status > 399 || !location) {
      throw new LoginError('authorize_rejected', `IdP authorize did not lead to a login page (HTTP ${response.status})`);
    }
    const next = new URL(location, current);
    const challenge = next.searchParams.get('login_challenge');
    if (challenge) {
      // Login page /login/<tenant> is served next to its API /api/login/<tenant>/password.
      const tenantPath = next.pathname.replace(/^\/+/, '').replace(/^login\//, '');
      return { challenge, loginApi: `${next.origin}/api/login/${tenantPath}/password` };
    }
    current = next.toString();
  }
  throw new LoginError('authorize_loop', 'IdP authorize redirected too many times');
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function jwtExpiry(token: string): number | undefined {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : undefined;
}

/** The `sub` claim, for the ops console's stored user profile when a session is browser-injected. */
export function jwtSubject(token: string): string | undefined {
  const sub = jwtPayload(token)?.sub;
  return typeof sub === 'string' && sub ? sub : undefined;
}

interface Channel {
  clientId: string;
  redirectUri: string;
  scope: string;
  /** Extra authorize params: the customer client sends `audience`, the ops clients RFC 8707 `resource`. */
  authorize: Record<string, string>;
  /** Where the authorization code is redeemed: the product's token proxy, or the IdP directly. */
  tokenUrl: string;
  /** Public clients name themselves with `client_id` in the token request's form body. */
  sendsClientId: boolean;
}

/** Resolves the OIDC client profile for a channel; missing config fails before any network call. */
function channelFor(config: BrokerConfig, kind: LoginChannel = 'customer'): Channel {
  if (kind === 'customer') {
    return {
      clientId: config.idp.clientId, redirectUri: config.idp.redirectUri, scope: config.idp.scope,
      authorize: config.idp.audience ? { audience: config.idp.audience } : {},
      tokenUrl: `${config.product.url}/api/auth/token`, sendsClientId: false,
    };
  }
  if (kind === 'ops') {
    const ops = config.idp.ops;
    if (!ops) {
      throw new CompanyError('not_configured', 'this environment has no ops login configured (broker idp.ops)');
    }
    // The IdP picks the token audience off RFC 8707 `resource`; it never reads `audience`.
    return {
      clientId: ops.clientId, redirectUri: ops.redirectUri, scope: 'openid',
      authorize: { resource: ops.audience },
      tokenUrl: `${config.idp.issuer}/token`, sendsClientId: true,
    };
  }
  const ops = config.ops;
  if (!ops) {
    throw new CompanyError('not_configured', 'this environment has no operator OIDC client configured (broker.ops)');
  }
  return {
    clientId: ops.clientId, redirectUri: ops.redirectUri, scope: ops.scope,
    authorize: ops.resource ? { resource: ops.resource } : {},
    tokenUrl: `${config.product.url}/api/auth/ops/token`, sendsClientId: true,
  };
}

/**
 * The same authorization-code + PKCE dance the product's web app performs, driven by the
 * password route of the IdP login page; the code is redeemed at the channel's token endpoint
 * (the customer or ops proxy on the product, or the IdP's own `/token` for `ops`). Failure messages carry
 * status codes and IdP error codes only, so they are safe to relay to employees.
 *
 * A timeout, a dropped connection or a 5xx anywhere in the flow earns another attempt from a
 * fresh challenge: the challenge and the code are single-use, so single steps are never replayed.
 * A refusal (wrong password, MFA, bad callback) is final and never retried.
 */
export async function passwordLogin(
  config: BrokerConfig, username: string, password: string, options: LoginOptions = {},
): Promise<LoginTokens> {
  const channel = channelFor(config, options.channel);
  const started = Date.now();
  const budgetMs = options.budgetMs ?? BUDGET_MS;
  const stepMs = options.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  const retryMinLeftMs = options.retryMinLeftMs ?? RETRY_MIN_LEFT_MS;
  const left = () => budgetMs - (Date.now() - started);
  // Each attempt but the last gets a deadline that leaves one whole-flow envelope for the attempt after it: a connect
  // stall on its last hop then ends that attempt early instead of spending the budget the next fresh flow needs.
  let attemptDeadline = started + budgetMs;
  const attemptLeft = () => attemptDeadline - Date.now();
  const io: Io = {
    fetcher: options.fetch ?? opsFetch,
    step: () => {
      const ms = Math.min(stepMs, Math.max(Math.min(left(), attemptLeft()), MIN_STEP_MS));
      return { signal: AbortSignal.timeout(ms), ms };
    },
    left,
    attempt: 0,
    trace: [],
  };
  const giveUp = (failure: Unavailable, attempts: number): CompanyError => {
    const trace = formatTrace(io);
    const stage = lastStage(io);
    const suffix = attempts > 1 ? `; gave up after ${attempts} attempts` : '';
    return new CompanyError('upstream_error',
      `${failure.message}${suffix}${trace ? `; trace: ${trace}` : ''}${stage ? `; stage=${stage}` : ''}; runtime ${runtimeVersion()}`, true);
  };
  for (let attempt = 1; ; attempt++) {
    io.attempt = attempt;
    // The last attempt runs on the whole remaining budget; every earlier one is capped at (left - one full envelope),
    // so a connect stall on its last hop ends it with the retry's budget intact. That cap is the fix: the observed
    // fatality was the one remaining attempt stalling on its final hop with nothing left to run a fresh flow.
    attemptDeadline = attempt < MAX_ATTEMPTS ? Date.now() + Math.max(left() - retryMinLeftMs, MIN_STEP_MS) : started + budgetMs;
    try {
      return await signIn(config, username, password, channel, io, options.now ?? Date.now);
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error;
      if (attempt >= MAX_ATTEMPTS || left() < retryMinLeftMs) throw giveUp(error, attempt);
    }
  }
}

async function signIn(config: BrokerConfig, username: string, password: string, channel: Channel, io: Io, now: () => number): Promise<LoginTokens> {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(12).toString('base64url');
  const authorize = new URL(`${config.idp.issuer}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: channel.clientId, redirect_uri: channel.redirectUri,
    scope: channel.scope, state, nonce: randomBytes(12).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    ...channel.authorize,
  })) authorize.searchParams.set(key, value);

  const { challenge, loginApi } = await findLoginChallenge(authorize.toString(), io);

  const { response: login, body: loginRaw } = await request('IdP login', io, loginApi, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login_challenge: challenge, username, password }).toString(),
  }, true, 'login');
  if (login.status >= 500) throw new Unavailable('IdP login', `HTTP ${login.status}`);
  const loginBody = loginRaw as { redirect_uri?: string; error?: string; mfa_state?: string } | undefined;
  if (loginBody?.mfa_state) throw new LoginError('mfa_required', 'IdP asked for a second factor; the broker only supports password-only test accounts');
  if (!login.ok || !loginBody?.redirect_uri) {
    const reason = typeof loginBody?.error === 'string' ? loginBody.error.replace(/[^\w.-]/g, '').slice(0, 60) : `http_${login.status}`;
    throw new LoginError(reason, `IdP rejected the login (${reason})`);
  }

  const callback = new URL(loginBody.redirect_uri);
  // Auto-approving consent is reserved for the company's own operator client (cfg.ops.clientId);
  // any other client or the customer channel asking for consent fails loudly instead.
  if (callback.searchParams.has('consent_challenge') && channel.clientId !== config.ops?.clientId) {
    throw new LoginError('consent_required', 'IdP requires a consent decision for this client; refusing to approve automatically');
  }
  const settled = callback.searchParams.has('consent_challenge')
    ? await settleConsent(callback, login.headers, io)
    : callback;
  const oauthError = settled.searchParams.get('error');
  if (oauthError) throw new LoginError(oauthError, `IdP returned an authorization error (${oauthError})`);
  const code = settled.searchParams.get('code');
  if (!code || settled.searchParams.get('state') !== state) throw new LoginError('bad_callback', 'IdP callback lacked a matching code/state');

  const { response: exchange, body: tokenRaw } = await request('token exchange', io, channel.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: channel.redirectUri, code_verifier: verifier,
      ...(channel.sendsClientId ? { client_id: channel.clientId } : {}),
    }).toString(),
  }, true, 'exchange');
  if (exchange.status >= 500) throw new Unavailable('token exchange', `HTTP ${exchange.status}`);
  const tokens = tokenRaw as { access_token?: string; expires_in?: number } | undefined;
  if (!exchange.ok || !tokens?.access_token) throw fail('token exchange', `HTTP ${exchange.status}`);
  const expiresAt = typeof tokens.expires_in === 'number' ? now() + tokens.expires_in * 1000 : jwtExpiry(tokens.access_token) ?? now() + 15 * 60_000;
  return { accessToken: tokens.access_token, expiresAt, attempts: io.attempt, trace: formatTrace(io) };
}
