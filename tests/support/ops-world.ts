// In-memory stand-ins for everything the ops broker talks to: the company core (leases, audit),
// sealed project secrets, the IdP's D1 database (real SQLite), the IdP login flow, the product API
// and the workspace data endpoint. They follow the real services' contracts (ma_hono login routes,
// surreal_ck session/workspace/member routes) so the broker is exercised end to end.
import { Database } from 'bun:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OpsScope, Role } from '../../src/contracts.ts';
import { CompanyError } from '../../src/core-errors.ts';
import type { BrowserInjector } from '../../src/ops/browser.ts';
import type { D1Client } from '../../src/ops/d1.ts';
import type { Fetcher } from '../../src/ops/fetcher.ts';
import type { QueryAsUser } from '../../src/ops/data.ts';
import { hashPassword, verifyPassword } from '../../src/ops/password.ts';
import type { EnvBrokerRow } from '../../src/projects.ts';

export const TENANT = 'tenant-ck-0001';
export const REDIRECT = 'https://app.test/auth/callback';
export const OPS_CLIENT = 'ops-client-0001';
export const OPS_REDIRECT = 'https://ops.test/auth/callback';
export const OPS_RESOURCE = 'https://app.test/api/ops/mcp';
/** The `idp.ops` public client redeemed straight at the IdP's own `/token` endpoint. */
export const OPS_DIRECT_CLIENT = 'ops-direct-0001';
export const OPS_DIRECT_REDIRECT = 'http://127.0.0.1:43124/auth/callback.html';

export const brokerConfig = (patch: Record<string, unknown> = {}) => ({
  roles: ['qa', 'engineering'],
  idp: { issuer: 'https://idp.test/t/ck', clientId: 'client-ck-1234', audience: 'https://auth.test', redirectUri: REDIRECT },
  product: { url: 'https://app.test' },
  accounts: { prefix: 'sck-', emailDomain: 'example.test', workspacePrefix: 'sck-' },
  d1: { tenantId: TENANT, databaseId: 'db-0000-0001' },
  data: { url: 'https://data.test', namespace: 'main' },
  limits: { workspacesPerDay: 2, accountsPerDay: 3 },
  ...patch,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string) => json(status, { error: { code, message: code } });

interface Member { id: string; email: string; displayName: string; isAdmin: boolean; subject?: string; disabled: boolean }
interface Workspace { slug: string; name: string; dbName: string; members: Member[] }
interface Grant { userId: string; db?: string; expiresAt: number; ops?: boolean }

/** `timeout` and `reset` throw like a flaky WAN; a number is an HTTP status the edge answers instead of the service. */
export type Fault = 'timeout' | 'reset' | number;
type RequestMatcher = (method: string, url: URL) => boolean;
interface FaultRule { match: RequestMatcher; how: Fault; times: number; afterEffect: boolean }

export class FakeWorld {
  clock = Date.UTC(2026, 0, 1);
  canCreate = true;
  readonly now = () => this.clock;
  readonly sqlite = new Database(':memory:');
  readonly sql: Array<{ sql: string; params: unknown[] }> = [];
  readonly requests: Array<{ method: string; url: string }> = [];
  readonly workspaces = new Map<string, Workspace>();
  /** Every access token the world ever minted, for leak assertions. */
  readonly minted: string[] = [];
  readonly browserLogins: Array<{ spaceId: number; page: string; token: string; probeUrl: string; landingUrl: string }> = [];
  /** IdP subject → active platform-operator capabilities, like the product's capability table. */
  readonly operatorCaps = new Map<string, string[]>();
  private readonly grants = new Map<string, Grant>();
  private readonly challenges = new Map<string, { state: string; codeChallenge: string; redirectUri: string; client: string }>();
  private readonly codes = new Map<string, { userId: string; codeChallenge: string; redirectUri: string; client: string }>();
  /** Third-party clients park the login on the consent screen; keyed by consent_challenge. */
  private readonly consents = new Map<string, { userId: string; state: string; codeChallenge: string; redirectUri: string; client: string }>();
  /**
   * Clients whose consent_policy is `require`, like the production DCR'd operator client:
   * the password route parks the flow on the consent URL instead of returning code+state.
   */
  readonly consentClients = new Set<string>([OPS_CLIENT]);
  /** Deny mode: the consent endpoint answers with an `access_denied` redirect back to the client. */
  denyConsents = false;
  /** Missing-cookie mode: the password route omits the `user_session` cookie the consent POST needs. */
  omitSessionCookie = false;

  constructor() {
    this.sqlite.run(`CREATE TABLE users (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0, username TEXT,
      display_name TEXT, status TEXT NOT NULL, created_at TEXT, updated_at TEXT,
      UNIQUE (tenant_id, email), UNIQUE (tenant_id, username))`);
    this.sqlite.run(`CREATE TABLE user_password_credentials (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      password_hash TEXT NOT NULL, created_at TEXT, updated_at TEXT)`);
    this.sqlite.run(`CREATE TABLE oidc_clients (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, client_id TEXT NOT NULL,
      client_secret_hash TEXT, client_name TEXT NOT NULL, application_type TEXT NOT NULL,
      trust_level TEXT NOT NULL, consent_policy TEXT NOT NULL, client_profile TEXT NOT NULL,
      access_token_audience TEXT, allowed_scopes TEXT, initiate_login_uri TEXT,
      claim_hook_url TEXT, claim_hook_auth_header_name TEXT, claim_hook_auth_header_value TEXT,
      token_endpoint_auth_method TEXT NOT NULL, redirect_uris TEXT NOT NULL,
      grant_types TEXT NOT NULL, response_types TEXT NOT NULL, created_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, client_id))`);
  }

  advance(ms: number) { this.clock += ms; }

  /** Ages every issued token past its lifetime so the next product call answers 401. */
  expireTokens() { for (const grant of this.grants.values()) grant.expiresAt = this.clock - 1; }

  get tokens(): string[] { return [...this.minted]; }

  readonly d1: D1Client = {
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      this.sql.push({ sql, params });
      try {
        return this.sqlite.query(sql).all(...(params as never[])) as T[];
      } catch (error) {
        if (/UNIQUE constraint/i.test((error as Error).message)) throw new CompanyError('conflict', `D1 query failed: ${(error as Error).message}`);
        throw error;
      }
    },
  };

  readonly browser: BrowserInjector = async input => {
    this.browserLogins.push({ spaceId: input.spaceId, page: input.page, token: input.token, probeUrl: input.probeUrl, landingUrl: input.landingUrl });
    return { url: input.landingUrl, title: 'Fixture App' };
  };

  readonly queryAsUser: QueryAsUser = async ({ database, token, sql }) => {
    const grant = this.grant(token);
    if (!grant || grant.db !== database) throw new CompanyError('upstream_error', 'workspace query failed (ResponseError): permission denied');
    const workspace = [...this.workspaces.values()].find(w => w.dbName === database);
    if (!workspace) throw new CompanyError('upstream_error', 'workspace query failed (ResponseError): unknown database');
    if (/FROM user WHERE kind = 'human'/.test(sql)) {
      return [workspace.members.filter(m => !m.disabled).map(m => ({
        id: `user:⟨${m.id}⟩`, display_name: m.displayName, email: m.email, is_admin: m.isAdmin, subject: m.subject ?? null,
      }))];
    }
    if (/FROM leak/.test(sql)) return [[{ access_token: 'raw-secret-value', note: `Bearer ${token}`, ok: 1 }]];
    return [[{ ok: 1 }]];
  };

  private readonly faults: FaultRule[] = [];

  /**
   * The next `times` requests matching `match` fail like a bad network day. With `afterEffect` the
   * service does its work first and only the answer is lost, as when a creation outlives its client.
   */
  fault(match: RequestMatcher, how: Fault, options: { times?: number; afterEffect?: boolean } = {}) {
    this.faults.push({ match, how, times: options.times ?? 1, afterEffect: options.afterEffect ?? false });
  }

  readonly fetch: Fetcher = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    this.requests.push({ method, url: url.toString() });
    const fault = this.faults.find(rule => rule.times > 0 && rule.match(method, url));
    if (!fault) return this.route(url, method, init);
    fault.times--;
    if (fault.afterEffect) await this.route(url, method, init);
    if (typeof fault.how === 'number') return new Response('', { status: fault.how });
    throw fault.how === 'timeout' ? new DOMException('The operation timed out.', 'TimeoutError') : new TypeError('fetch failed');
  };

  private route(url: URL, method: string, init?: RequestInit): Promise<Response> | Response {
    if (url.origin === 'https://idp.test' && url.pathname === '/t/ck/token') return this.idpToken(method, init);
    if (url.origin === 'https://idp.test') return this.idpAuthorize(url);
    if (url.origin === 'https://auth.test') return this.loginHost(url, method, init);
    if (url.origin === 'https://app.test') return this.product(url, method, init);
    return new Response('unreachable host', { status: 502 });
  }

  /** An active IdP account whose password is known to the test. */
  async addAccount(username: string, password: string) {
    this.insertUser(username, `${username}@example.test`);
    this.sqlite.run('INSERT INTO user_password_credentials (id, tenant_id, user_id, password_hash) VALUES (?, ?, (SELECT id FROM users WHERE username = ?), ?)',
      [randomUUID(), TENANT, username, await hashPassword(password)]);
  }

  /** Direct row access for assertions about what the IdP stored. */
  user(username: string): { id: string; status: string; email: string } | undefined {
    return (this.sqlite.query('SELECT id, status, email FROM users WHERE username = ?').get(username) ?? undefined) as never;
  }
  credentialHash(username: string): string | undefined {
    const row = this.sqlite.query('SELECT c.password_hash AS hash FROM user_password_credentials c JOIN users u ON u.id = c.user_id WHERE u.username = ?').get(username) as { hash: string } | null;
    return row?.hash;
  }
  setStatus(username: string, status: string) { this.sqlite.run('UPDATE users SET status = ? WHERE username = ?', [status, username]); }
  corruptCredential(username: string, hash = 'pbkdf2_sha256$100000$c2FsdA$ZGlnZXN0') {
    this.sqlite.run('UPDATE user_password_credentials SET password_hash = ? WHERE user_id = (SELECT id FROM users WHERE username = ?)', [hash, username]);
  }
  insertUser(username: string, email: string) {
    this.sqlite.run('INSERT INTO users (id, tenant_id, email, username, display_name, status) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), TENANT, email, username, username, 'active']);
  }

  /** Direct row access for assertions about a registered OIDC client. */
  oidcClient(clientName: string): Record<string, unknown> | undefined {
    return (this.sqlite.query('SELECT * FROM oidc_clients WHERE client_name = ?').get(clientName) ?? undefined) as never;
  }
  oidcClientCount(): number {
    return (this.sqlite.query('SELECT COUNT(*) AS n FROM oidc_clients').get() as { n: number }).n;
  }

  // ---------- IdP ----------

  private idpAuthorize(url: URL): Response {
    const q = url.searchParams;
    const client = q.get('client_id') ?? '';
    // The customer client asks for `audience`, the ops public clients for RFC 8707 `resource`.
    const validClient = client === 'client-ck-1234'
      ? q.get('redirect_uri') === REDIRECT && q.get('audience') === 'https://auth.test' && !q.get('resource')
      : client === OPS_CLIENT
        ? q.get('redirect_uri') === OPS_REDIRECT && q.get('resource') === OPS_RESOURCE && !q.get('audience')
        : client === OPS_DIRECT_CLIENT
          ? q.get('redirect_uri') === OPS_DIRECT_REDIRECT && q.get('resource') === OPS_RESOURCE && !q.get('audience')
          : false;
    if (url.pathname !== '/t/ck/authorize' || q.get('response_type') !== 'code' || !validClient
      || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) {
      return json(400, { error: 'invalid_request' });
    }
    const id = randomBytes(8).toString('hex');
    this.challenges.set(id, { state: q.get('state')!, codeChallenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')!, client });
    return new Response(null, { status: 302, headers: { location: `https://auth.test/step?c=${id}` } });
  }

  private async loginHost(url: URL, method: string, init?: RequestInit): Promise<Response> {
    if (url.pathname === '/step') {
      return new Response(null, { status: 302, headers: { location: `/login/ck?login_challenge=${url.searchParams.get('c')}` } });
    }
    if (method === 'POST' && url.pathname === '/api/consent/ck') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      const consent = this.consents.get(form.get('consent_challenge') ?? '');
      const cookie = new Headers(init?.headers).get('cookie') ?? '';
      if (!consent || !cookie.includes(`user_session=session-${consent.userId}`)) {
        return json(400, { error: 'invalid_consent_challenge' });
      }
      this.consents.delete(form.get('consent_challenge')!);
      const redirect = new URL(consent.redirectUri);
      redirect.searchParams.set('state', consent.state);
      if (this.denyConsents || form.get('decision') !== 'approve') {
        redirect.searchParams.set('error', 'access_denied');
        return new Response(null, { status: 302, headers: { location: redirect.toString() } });
      }
      const code = `code-${randomBytes(8).toString('hex')}`;
      this.codes.set(code, { userId: consent.userId, codeChallenge: consent.codeChallenge, redirectUri: consent.redirectUri, client: consent.client });
      redirect.searchParams.set('code', code);
      return new Response(null, { status: 302, headers: { location: redirect.toString() } });
    }
    if (method !== 'POST' || url.pathname !== '/api/login/ck/password') return json(404, { error: 'not_found' });
    const form = new URLSearchParams(String(init?.body ?? ''));
    const challenge = this.challenges.get(form.get('login_challenge') ?? '');
    if (!challenge) return json(400, { error: 'invalid_request' });
    const username = (form.get('username') ?? '').toLowerCase();
    const user = this.sqlite.query('SELECT id, status FROM users WHERE tenant_id = ? AND username = ?').get(TENANT, username) as { id: string; status: string } | null;
    const credential = user && this.sqlite.query('SELECT password_hash FROM user_password_credentials WHERE user_id = ?').get(user.id) as { password_hash: string } | null;
    if (!user || user.status !== 'active' || !credential || !(await verifyPassword(form.get('password') ?? '', credential.password_hash))) {
      return json(401, { error: 'invalid_credentials' });
    }
    // Clients with consent_policy `require` (the production DCR'd operator client) park the
    // flow on the consent URL and set the browser session cookie the consent POST needs.
    if (this.consentClients.has(challenge.client)) {
      const consentId = randomBytes(8).toString('hex');
      this.consents.set(consentId, { userId: user.id, ...challenge });
      return new Response(JSON.stringify({ redirect_uri: `https://auth.test/api/consent/ck?consent_challenge=${consentId}` }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          ...(this.omitSessionCookie ? {} : { 'set-cookie': `user_session=session-${user.id}; Path=/; HttpOnly` }),
        },
      });
    }
    const code = `code-${randomBytes(8).toString('hex')}`;
    this.codes.set(code, { userId: user.id, codeChallenge: challenge.codeChallenge, redirectUri: challenge.redirectUri, client: challenge.client });
    const redirect = new URL(challenge.redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', challenge.state);
    return json(200, { redirect_uri: redirect.toString() });
  }

  /**
   * The IdP's own token endpoint: only the public ops client may redeem here, naming itself
   * with `client_id` in the form body and proving the code with `code_verifier` (no secret).
   */
  private idpToken(method: string, init?: RequestInit): Response {
    if (method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const form = new URLSearchParams(String(init?.body ?? ''));
    const code = this.codes.get(form.get('code') ?? '');
    this.codes.delete(form.get('code') ?? '');
    const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
    if (!code || code.client !== OPS_DIRECT_CLIENT || form.get('client_id') !== OPS_DIRECT_CLIENT
      || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== code.redirectUri || challenge !== code.codeChallenge) {
      return json(400, { error: 'invalid_grant' });
    }
    return json(200, { access_token: this.mint(code.userId, undefined, true), token_type: 'Bearer', expires_in: 900 });
  }

  // ---------- product ----------

  private mint(userId: string, db?: string, ops = false): string {
    const payload = Buffer.from(JSON.stringify({ sub: userId, db, aud: ops ? OPS_RESOURCE : 'https://auth.test', jti: randomUUID(), exp: Math.floor((this.clock + 900_000) / 1000) })).toString('base64url');
    const token = `eyJhbGciOiJSUzI1NiJ9.${payload}.${randomBytes(12).toString('base64url')}`;
    this.grants.set(token, { userId, db, expiresAt: this.clock + 900_000, ops });
    this.minted.push(token);
    return token;
  }

  private grant(token: string): Grant | undefined {
    const grant = this.grants.get(token);
    return grant && grant.expiresAt > this.clock ? grant : undefined;
  }

  private emailOf(userId: string): string {
    return (this.sqlite.query('SELECT email FROM users WHERE id = ?').get(userId) as { email: string }).email;
  }

  private visible(userId: string): Array<{ workspace: Workspace; member: Member }> {
    const email = this.emailOf(userId);
    return [...this.workspaces.values()].flatMap(workspace => {
      const member = workspace.members.find(m => !m.disabled && (m.subject === userId || (!m.subject && m.email === email)));
      return member ? [{ workspace, member }] : [];
    });
  }

  private async product(url: URL, method: string, init?: RequestInit): Promise<Response> {
    if (url.pathname === '/health') return json(200, { ok: true });
    if (url.pathname === '/api/auth/token') return this.exchange(init, false);
    if (url.pathname === '/api/auth/ops/token') return this.exchange(init, true);
    const header = new Headers(init?.headers).get('authorization') ?? '';
    const grant = this.grant(header.replace(/^Bearer /, ''));
    if (!grant) return apiError(401, 'oidc-expired');
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};

    if (method === 'GET' && url.pathname === '/api/session/workspaces') {
      return json(200, {
        canCreate: this.canCreate,
        workspaces: this.visible(grant.userId).map(({ workspace, member }) => ({
          slug: workspace.slug, name: workspace.name, dbName: workspace.dbName, role: member.isAdmin ? 'admin' : 'participant', lastSelectedAt: null,
        })),
      });
    }
    if (method === 'POST' && url.pathname === '/api/session/switch-workspace') {
      const hit = this.visible(grant.userId).find(({ workspace }) => workspace.slug === body.workspaceSlug || workspace.dbName === body.dbName);
      if (!hit) return apiError(403, 'workspace-forbidden');
      hit.member.subject ??= grant.userId; // first login binds the pre-created member by email
      return json(200, { ok: true, accessToken: this.mint(grant.userId, hit.workspace.dbName), expiresIn: 900 });
    }
    if (method === 'POST' && url.pathname === '/api/workspaces') {
      const slug = String(body.slug ?? '');
      if (!this.canCreate) return apiError(403, 'workspace-create-forbidden');
      if (this.workspaces.has(slug)) return apiError(409, 'workspace-slug-conflict');
      const workspace: Workspace = {
        slug, name: String(body.name), dbName: `ws_${slug.replaceAll('-', '_')}`,
        members: [{ id: randomBytes(6).toString('hex'), email: this.emailOf(grant.userId), displayName: 'creator', isAdmin: true, subject: grant.userId, disabled: false }],
      };
      this.workspaces.set(slug, workspace);
      return json(200, { slug, dbName: workspace.dbName, accessToken: this.mint(grant.userId, workspace.dbName), expiresIn: 900 });
    }
    const members = /^\/api\/workspaces\/([^/]+)\/members(?:\/([^/]+))?$/.exec(url.pathname);
    if (members) {
      const workspace = this.workspaces.get(members[1]!);
      if (!workspace) return apiError(404, 'workspace-not-found');
      const caller = workspace.members.find(m => m.subject === grant.userId && !m.disabled);
      if (!caller?.isAdmin) return apiError(403, 'member-admin-forbidden');
      if (method === 'POST' && !members[2]) {
        const email = String(body.email).toLowerCase();
        const existing = workspace.members.find(m => m.email === email);
        if (existing) Object.assign(existing, { disabled: false, isAdmin: body.isAdmin === true });
        else workspace.members.push({ id: randomBytes(6).toString('hex'), email, displayName: String(body.displayName ?? email), isAdmin: body.isAdmin === true, disabled: false });
        return json(200, { ok: true });
      }
      if (method === 'DELETE' && members[2]) {
        const target = workspace.members.find(m => m.id === decodeURIComponent(members[2]!) && !m.disabled);
        if (!target) return apiError(404, 'member-not-found');
        target.disabled = true;
        return json(200, { ok: true });
      }
    }
    // Ops endpoints verify the ops audience and re-read the caller's capabilities per request,
    // mirroring the product's requirePlatformOperator middleware.
    if (url.pathname.startsWith('/api/ops/')) {
      if (!grant.ops) return apiError(401, 'oidc-ops-audience-invalid');
      const caps = this.operatorCaps.get(grant.userId) ?? [];
      if (!caps.length) return apiError(403, 'platform-operator-inactive');
      if (method === 'GET' && url.pathname === '/api/ops/quota/context') {
        return json(200, { subject: grant.userId, capabilities: caps });
      }
      const entitlement = /^\/api\/ops\/product-entitlements\/workspaces\/[^/]+$/.exec(url.pathname);
      if (method === 'GET' && entitlement) {
        if (!caps.includes('quota.read')) return apiError(403, 'platform-operator-capability-missing');
        return json(200, { slug: decodeURIComponent(url.pathname.split('/').pop()!), entitlement: { revision: 3 } });
      }
      return apiError(404, 'not-found');
    }
    // Platform content REST is operator-gated too (requirePlatformOperator + per-route capability),
    // so the same audience/capability model applies before any route answers.
    if (url.pathname.startsWith('/api/content/')) {
      if (!grant.ops) return apiError(401, 'oidc-ops-audience-invalid');
      const caps = this.operatorCaps.get(grant.userId) ?? [];
      if (!caps.length) return apiError(403, 'platform-operator-inactive');
      if (method === 'POST' && url.pathname === '/api/content/sources') {
        if (!caps.includes('content.source.manage')) return apiError(403, 'platform-operator-capability-missing');
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return json(201, { source: { publicId: `src-${randomBytes(4).toString('hex')}`, ...body } });
      }
      if (method === 'GET' && url.pathname === '/api/content/contract') {
        if (!caps.includes('content.read')) return apiError(403, 'platform-operator-capability-missing');
        return json(200, { contract: { version: 'v1' } });
      }
      return apiError(404, 'not-found');
    }
    if (url.pathname === '/api/echo') return json(400, { error: { code: 'echo', message: `you sent ${header}` }, token: header.replace(/^Bearer /, '') });
    if (url.pathname === '/api/boom') return json(500, { error: { code: 'internal', message: 'boom' } });
    return apiError(404, 'not-found');
  }

  private exchange(init: RequestInit | undefined, ops: boolean): Response {
    const form = new URLSearchParams(String(init?.body ?? ''));
    const code = this.codes.get(form.get('code') ?? '');
    this.codes.delete(form.get('code') ?? '');
    const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
    // The confidential customer proxy keeps its client to itself; the ops public client must name itself.
    const clientOk = ops ? form.get('client_id') === OPS_CLIENT : form.get('client_id') === null;
    if (!code || !clientOk || code.client !== (ops ? OPS_CLIENT : 'client-ck-1234')
      || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== code.redirectUri || challenge !== code.codeChallenge) {
      return json(400, { error: 'invalid_grant' });
    }
    return json(200, { access_token: this.mint(code.userId, undefined, ops), token_type: 'Bearer', expires_in: 900 });
  }
}

export interface Audit { employeeId: string; taskId: string; project: string; action: string; evidence: string }

/** Company core + project store surface the broker depends on. */
export class FakeCompany {
  readonly audits: Audit[] = [];
  readonly sealed = new Map<string, string>();
  envs: Record<string, EnvBrokerRow[]> = {};
  private readonly leases = new Map<string, { employeeId: string; role: Role; taskId: string; project: string; live: boolean }>();

  /** Registers a lease holder and returns the credential the sidecar would hold for it. */
  lease(employeeId: string, role: Role, taskId: string, project = 'demo'): string {
    const credential = `cred-${employeeId}`;
    this.leases.set(credential, { employeeId, role, taskId, project, live: true });
    return credential;
  }

  endLease(employeeId: string) {
    for (const lease of this.leases.values()) if (lease.employeeId === employeeId) lease.live = false;
  }

  env(project: string, name: string, broker: unknown, extra: Partial<EnvBrokerRow> = {}) {
    (this.envs[project] ??= []).push({ name, broker, ...extra });
  }

  readonly core = {
    opsScope: async (credential: string, taskId: string): Promise<OpsScope> => {
      const lease = this.leases.get(credential);
      if (!lease) throw new CompanyError('forbidden', 'unknown credential');
      if (!lease.live || lease.taskId !== taskId) throw new CompanyError('forbidden', 'ops tools need the live lease of the task');
      return { actor: { employeeId: lease.employeeId, role: lease.role, capabilities: ['execute'] }, taskId, project: lease.project };
    },
    auditOps: async (scope: OpsScope, action: string, evidence: string) => {
      this.audits.push({ employeeId: scope.actor.employeeId, taskId: scope.taskId, project: scope.project, action, evidence });
    },
    opsCount: async (project: string, action: string) => this.audits.filter(a => a.project === project && a.action === action).length,
  };

  readonly projects = {
    brokerEnvs: async (project: string) => this.envs[project] ?? [],
    readSealed: async (project: string, env: string, name: string) => this.sealed.get(`${project}/${env}/${name}`),
    setSecret: async (input: { project: string; env: string; name: string; value: string }) => {
      this.sealed.set(`${input.project}/${input.env}/${input.name}`, input.value);
    },
    sealedNames: async (project: string, env: string) =>
      [...this.sealed.keys()].filter(key => key.startsWith(`${project}/${env}/`)).map(key => key.split('/').slice(2).join('/')).sort(),
  };
}
