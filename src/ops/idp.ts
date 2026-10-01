import { createHash, randomBytes } from 'node:crypto';
import { CompanyError } from '../core-errors.ts';
import type { BrokerConfig } from './config.ts';
import type { Fetcher } from './fetcher.ts';

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

const MAX_HOPS = 8;
const TIMEOUT_MS = 20_000;

const fail = (what: string, detail: string | number) => new CompanyError('upstream_error', `${what} failed (${detail})`, true);

/** Follows authorize redirects by hand until one carries the IdP's login challenge. */
async function findLoginChallenge(authorizeUrl: string, fetcher: Fetcher): Promise<{ challenge: string; loginApi: string }> {
  let current = authorizeUrl;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let response: Response;
    try {
      response = await fetcher(current, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw fail('IdP authorize', (error as Error).name);
    }
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

/**
 * The same authorization-code + PKCE dance the product's web app performs, driven by the
 * password route of the IdP login page; the code is redeemed at the product's own
 * confidential proxy, which holds the client secret. Failure messages carry status codes and
 * IdP error codes only, so they are safe to relay to employees.
 */
export async function passwordLogin(
  config: BrokerConfig, username: string, password: string,
  options: { fetch?: Fetcher; now?: () => number } = {},
): Promise<LoginTokens> {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(12).toString('base64url');
  const authorize = new URL(`${config.idp.issuer}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: config.idp.clientId, redirect_uri: config.idp.redirectUri,
    scope: config.idp.scope, state, nonce: randomBytes(12).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    ...(config.idp.audience ? { audience: config.idp.audience } : {}),
  })) authorize.searchParams.set(key, value);

  const { challenge, loginApi } = await findLoginChallenge(authorize.toString(), fetcher);

  let login: Response;
  try {
    login = await fetcher(loginApi, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ login_challenge: challenge, username, password }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw fail('IdP login', (error as Error).name);
  }
  const loginBody = await login.json().catch(() => undefined) as
    { redirect_uri?: string; error?: string; mfa_state?: string } | undefined;
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

  let exchange: Response;
  try {
    exchange = await fetcher(`${config.product.url}/api/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: config.idp.redirectUri, code_verifier: verifier,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw fail('token exchange', (error as Error).name);
  }
  const tokens = await exchange.json().catch(() => undefined) as { access_token?: string; expires_in?: number } | undefined;
  if (!exchange.ok || !tokens?.access_token) throw fail('token exchange', `HTTP ${exchange.status}`);
  const expiresAt = typeof tokens.expires_in === 'number' ? now() + tokens.expires_in * 1000 : jwtExpiry(tokens.access_token) ?? now() + 15 * 60_000;
  return { accessToken: tokens.access_token, expiresAt };
}
