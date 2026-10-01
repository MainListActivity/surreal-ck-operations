import { createHash, randomBytes } from 'node:crypto';
import { CompanyError } from '../core-errors.ts';
import type { BrokerConfig } from './config.ts';
import { describeTransportFailure, type Fetcher } from './fetcher.ts';

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
}

/** `customer` rides the product web app's client; `operator` the dedicated ops public client. */
export type LoginChannel = 'customer' | 'operator';

export interface LoginOptions {
  fetch?: Fetcher;
  now?: () => number;
  /** Limit for one HTTP request; tests shrink it. */
  stepTimeoutMs?: number;
  /** Limit for all attempts together; tests shrink it. */
  budgetMs?: number;
  channel?: LoginChannel;
}

const MAX_HOPS = 8;
const MAX_ATTEMPTS = 2;
// The IdP and the product are reached over a WAN where a single request of 5-10s happens; a healthy login takes 8-17s in total.
const STEP_TIMEOUT_MS = 25_000;
// All attempts together stay well inside the 120s an employee waits for one tool call, which also has to list workspaces afterwards.
const BUDGET_MS = 75_000;
// A second attempt starts only with room for a whole flow, so the budget never cuts it short.
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
  /** A fresh limit for the next request: the per-step limit, cut down to what is left of the budget. */
  step: () => { signal: AbortSignal; ms: number };
}

/** One request, optionally with its JSON body; a timeout while the body is read counts as a timeout of the request. */
async function request(what: string, io: Io, url: string, init: RequestInit, parseBody = false): Promise<{ response: Response; body?: unknown }> {
  const { signal, ms } = io.step();
  try {
    const response = await io.fetcher(url, { ...init, signal });
    const body = parseBody
      ? await response.json().catch((error: Error) => { if (error.name === 'TimeoutError') throw error; return undefined; })
      : undefined;
    return { response, body };
  } catch (error) {
    throw new Unavailable(what, describeTransportFailure(error, ms).detail);
  }
}

/** Follows authorize redirects by hand until one carries the IdP's login challenge. */
async function findLoginChallenge(authorizeUrl: string, io: Io): Promise<{ challenge: string; loginApi: string }> {
  let current = authorizeUrl;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const { response } = await request('IdP authorize', io, current, { redirect: 'manual' });
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

export function jwtExpiry(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch { return undefined; }
}

interface Channel {
  clientId: string;
  redirectUri: string;
  scope: string;
  /** Extra authorize params: the customer client sends `audience`, the ops client RFC 8707 `resource`. */
  authorize: Record<string, string>;
  /** Where on the product the authorization code is redeemed. */
  tokenPath: string;
  /** Public clients authenticate to the product's token proxy with `client_id` in the form body. */
  sendsClientId: boolean;
}

/** Resolves the OIDC client profile for a channel; missing config fails before any network call. */
function channelFor(config: BrokerConfig, kind: LoginChannel = 'customer'): Channel {
  if (kind === 'customer') {
    return {
      clientId: config.idp.clientId, redirectUri: config.idp.redirectUri, scope: config.idp.scope,
      authorize: config.idp.audience ? { audience: config.idp.audience } : {},
      tokenPath: '/api/auth/token', sendsClientId: false,
    };
  }
  const ops = config.ops;
  if (!ops) {
    throw new CompanyError('not_configured', 'this environment has no operator OIDC client configured (broker.ops)');
  }
  return {
    clientId: ops.clientId, redirectUri: ops.redirectUri, scope: ops.scope,
    authorize: ops.resource ? { resource: ops.resource } : {},
    tokenPath: '/api/auth/ops/token', sendsClientId: true,
  };
}

/**
 * The same authorization-code + PKCE dance the product's web app performs, driven by the
 * password route of the IdP login page; the code is redeemed at the product's token proxy
 * (`channel` picks the customer proxy or the ops public-client one). Failure messages carry
 * status codes and IdP error codes only, so they are safe to relay to employees.
 *
 * A timeout, a dropped connection or a 5xx anywhere in the flow earns one more attempt from a
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
  const left = () => budgetMs - (Date.now() - started);
  const io: Io = {
    fetcher: options.fetch ?? fetch,
    step: () => {
      const ms = Math.min(stepMs, Math.max(left(), MIN_STEP_MS));
      return { signal: AbortSignal.timeout(ms), ms };
    },
  };
  for (let attempt = 1; ; attempt++) {
    try {
      return await signIn(config, username, password, channel, io, options.now ?? Date.now);
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error;
      if (attempt >= MAX_ATTEMPTS || left() < RETRY_MIN_LEFT_MS) {
        throw attempt === 1 ? error : new CompanyError('upstream_error', `${error.message}; gave up after ${attempt} attempts`, true);
      }
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
  }, true);
  if (login.status >= 500) throw new Unavailable('IdP login', `HTTP ${login.status}`);
  const loginBody = loginRaw as { redirect_uri?: string; error?: string; mfa_state?: string } | undefined;
  if (loginBody?.mfa_state) throw new LoginError('mfa_required', 'IdP asked for a second factor; the broker only supports password-only test accounts');
  if (!login.ok || !loginBody?.redirect_uri) {
    const reason = typeof loginBody?.error === 'string' ? loginBody.error.replace(/[^\w.-]/g, '').slice(0, 60) : `http_${login.status}`;
    throw new LoginError(reason, `IdP rejected the login (${reason})`);
  }

  const callback = new URL(loginBody.redirect_uri);
  const oauthError = callback.searchParams.get('error');
  if (oauthError) throw new LoginError(oauthError, `IdP returned an authorization error (${oauthError})`);
  const code = callback.searchParams.get('code');
  if (!code || callback.searchParams.get('state') !== state) throw new LoginError('bad_callback', 'IdP callback lacked a matching code/state');

  const { response: exchange, body: tokenRaw } = await request('token exchange', io, `${config.product.url}${channel.tokenPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: channel.redirectUri, code_verifier: verifier,
      ...(channel.sendsClientId ? { client_id: channel.clientId } : {}),
    }).toString(),
  }, true);
  if (exchange.status >= 500) throw new Unavailable('token exchange', `HTTP ${exchange.status}`);
  const tokens = tokenRaw as { access_token?: string; expires_in?: number } | undefined;
  if (!exchange.ok || !tokens?.access_token) throw fail('token exchange', `HTTP ${exchange.status}`);
  const expiresAt = typeof tokens.expires_in === 'number' ? now() + tokens.expires_in * 1000 : jwtExpiry(tokens.access_token) ?? now() + 15 * 60_000;
  return { accessToken: tokens.access_token, expiresAt };
}
