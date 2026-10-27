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
  readonly browserLogins: Array<{ spaceId: number; page: string; token: string; probeUrl: string; landingUrl: string; oidcUser?: { key: string; value: string } }> = [];
  /** IdP subject → active platform-operator capabilities, like the product's capability table. */
  readonly operatorCaps = new Map<string, string[]>();
  /** The provision token hash the fake product sealed at the last rotate call (null = env fallback). */
  liveProvisionToken: { hash: string; principalId: string } | null = null;
readonly issuedInvites = new Map<string, Record<string, unknown>>();
  /** 行级暂存的一次性激活链接——GET/POST 读路径永不回显，仅 collect-delivery 一次性下发。 */
  readonly inviteUrls = new Map<string, string>();
  readonly inviteDeliveredAt = new Map<string, string>();
  /** 异步模式：POST 返回 202 processing，GET 轮询该次数后翻 completed。 */
  inviteAsyncPolls: number | null = null;
  /** 僵死模拟：GET 永不推进，直到同键重发 POST 续跑（inviteResumeCalls++）。 */
  inviteNeedsResume = false;
  inviteResumeCalls = 0;
  /** 异步完成时翻为 failed（带 errorCode/errorMessage）而非 completed。 */
  inviteFailOnComplete = false;
  /** resend 铸链计数（断言「重放不重复发」用）。 */
  inviteResendCalls = 0;
  /** key → 最近一次重签发时刻（24h 内重放去重）。 */
  readonly inviteResentAt = new Map<string, number>();
  /** resend 时 IdP 侧用户已激活 → 409。 */
  readonly inviteActivatedUsers = new Set<string>();
  private readonly invitePendingPolls = new Map<string, number>();
  private inviteResumed = new Set<string>();
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
  /**
   * SenseNova supplier fixture for ops_supplier_plan_sample: the chat API key (Bearer on
   * token.sensenova.cn) and the console session token (Bearer on platform.sensenova.cn).
   * `apiKeyListed=false` drops the sealed key from the console key list → binding fails.
   * Each `*Status` swaps the endpoint's healthy 200 for a failure code.
   */
  supplier = {
    apiKey: 'sk-test-7f3a9c1e5b8d4f2a6e0c9b1d3f5a7e9c',
    consoleToken: 'console-session-4d8f2b6a1c3e5f7a9b0d2e4f',
    apiKeyListed: true,
    extraApiKeys: [] as string[],
    modelsStatus: 200,
    keysStatus: 200,
    poolStatus: 200,
    planStatus: 200,
    // console-session auto-issuance fixture (Ory Hydra chain on the two allowlisted hosts)
    consoleUser: 'snv-console-operator',
    consolePassword: 'console-pw-9e8f7a6b5c4d3e2f1a0b',
    authChallenge: 'fake-login-challenge-0123456789abcdef',
    lastAuthState: '',
    authChallengeValid: true,
    authLoginStatus: 200,
    authTokenStatus: 200,
    authRedirectHost: 'platform.sensenova.cn',
    authConsentStall: false,
    issuedTokenTtlSec: 10_800,
    issuedToken: '',
    // account-bound plan record returned inside pool-usage (FREE by default)
    planType: 'TOKEN_PLAN_PLAN_TYPE_FREE',
    /** v3 source-freshness fixtures: drop the HTTP Date / ETag header to exercise the strict gates. */
    planDate: true,
    planEtag: true,
    // when true, one fixed billing path answers 200 instead of the absent-surface 404
    billingPathLive: false,
    pools: [
      {
        id: 'pool-dedicated', pool: 'flash-lite', name: 'Flash-Lite', pool_type: 'dedicated',
        window_5h: { limit: 120_000, used: 600, remaining: 119_400, reset_at: Math.floor(this.clock / 1000) + 5 * 3600 },
        window_7d: { limit: 1_200_000, used: 2_000, remaining: 1_198_000, reset_at: Math.floor(this.clock / 1000) + 6 * 86_400 },
        nearest_grant_expiry: Math.floor(this.clock / 1000) + 30 * 86_400,
      },
      {
        id: 'pool-general', pool: 'general', name: '通用', pool_type: 'default',
        window_5h: { limit: 120_000, used: 1_500, remaining: 118_500, reset_at: Math.floor(this.clock / 1000) + 4 * 3600 },
        window_7d: { limit: 1_200_000, used: 10_000, remaining: 1_190_000, reset_at: Math.floor(this.clock / 1000) + 5 * 86_400 },
        nearest_grant_expiry: Math.floor(this.clock / 1000) + 30 * 86_400,
      },
    ],
    // Reviewed 2026-10-27 copy: public beta free, paid tiers only announced, limited-time release,
    // and no quota number. The account-bound pool figures are the only quota source.
    planHtml: '<html><body>SenseNova Token Plan 订阅方案 公测期完全免费开放，付费档位即将上线 Free · 公测 限时放量 ¥ 0 /月</body></html>',
  };

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
    this.sqlite.run(`CREATE TABLE client_access_token_claims (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oidc_clients(id),
      tenant_id TEXT NOT NULL, claim_name TEXT NOT NULL, source_type TEXT NOT NULL,
      fixed_value TEXT, user_field TEXT, hook_field TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (client_id, claim_name))`);
    this.sqlite.run(`CREATE TABLE admin_service_principals (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL, scopes TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, created_by TEXT NOT NULL)`);
    this.sqlite.run(`CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT, tenant_id TEXT,
      event_type TEXT NOT NULL, target_type TEXT, target_id TEXT, payload TEXT, occurred_at TEXT NOT NULL)`);
    this.sqlite.run(`CREATE TABLE tenants (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, display_name TEXT NOT NULL, issuer TEXT NOT NULL)`);
    this.insertTenant({ id: TENANT, slug: 'ck' });
  }

  /** Seeds a tenants row like the production `ck` tenant the IdP admin routes resolve by slug. */
  insertTenant(row: { id: string; slug: string; displayName?: string }) {
    this.sqlite.run('INSERT INTO tenants (id, slug, display_name, issuer) VALUES (?, ?, ?, ?)',
      [row.id, row.slug, row.displayName ?? row.slug, `https://idp.test/t/${row.slug}`]);
  }

  /** Direct row access for assertions about what the broker stored on a principal. */
  principal(id: string): Record<string, unknown> | undefined {
    return (this.sqlite.query('SELECT * FROM admin_service_principals WHERE id = ?').get(id) ?? undefined) as never;
  }
  auditRows(eventType?: string): Array<Record<string, unknown>> {
    const rows = eventType
      ? this.sqlite.query('SELECT * FROM audit_events WHERE event_type = ?').all(eventType)
      : this.sqlite.query('SELECT * FROM audit_events').all();
    return rows as Array<Record<string, unknown>>;
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
    this.browserLogins.push({ spaceId: input.spaceId, page: input.page, token: input.token, probeUrl: input.probeUrl, landingUrl: input.landingUrl, oidcUser: input.oidcUser });
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
    if (url.origin === 'https://idp.test' && url.pathname.startsWith('/admin/')) return this.idpAdmin(url, method, init);
    if (url.origin === 'https://idp.test') return this.idpAuthorize(url);
    if (url.origin === 'https://auth.test') return this.loginHost(url, method, init);
    if (url.origin === 'https://app.test') return this.product(url, method, init);
    if (['token.sensenova.cn', 'platform.sensenova.cn', 'www.sensenova.cn', 'iam.sensecoreapi.cn'].includes(url.host)) return this.supplierHost(url, method, init);
    return new Response('unreachable host', { status: 502 });
  }

  /**
   * The IdP's three service-principal-scoped admin routes, mirroring ma_hono app.ts: a bearer is
   * looked up by token hash, 401 when unknown, 403 when revoked or the route is outside its scopes
   * (every other /admin/* route, including GET /admin/tenants/<id>, is human-admin-only for a
   * principal). Provision writes `user.provisioned`/`user.provision.failed` audit rows with
   * actorType `service_principal` and the principal id, like the real route.
   */
  private idpAdmin(url: URL, method: string, init?: RequestInit): Response {
    const header = new Headers(init?.headers).get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const hash = token ? createHash('sha256').update(token).digest('base64url') : '';
    const principal = this.sqlite.query('SELECT * FROM admin_service_principals WHERE token_hash = ?').get(hash) as Record<string, unknown> | null;
    if (!principal) return json(401, { error: 'unauthorized' });
    if (principal.status === 'revoked') return json(403, { error: 'forbidden' });
    const scopes = JSON.parse(String(principal.scopes)) as string[];
    const usersPath = /^\/admin\/tenants\/([^/]+)\/users$/.exec(url.pathname);
    const need = method === 'GET' && url.pathname === '/admin/tenants' ? 'tenant.read'
      : method === 'GET' && usersPath ? 'user.read'
        : method === 'POST' && usersPath ? 'user.provision' : null;
    if (!need || !scopes.includes(need)) return json(403, { error: 'forbidden' });

    const audit = (eventType: string, payload: Record<string, unknown>, targetId: string | null = null, tenantId: string | null = null) => {
      this.sqlite.run(`INSERT INTO audit_events (id, actor_type, actor_id, tenant_id, event_type, target_type, target_id, payload, occurred_at)
        VALUES (?, 'service_principal', ?, ?, ?, 'user', ?, ?, ?)`,
        [randomUUID(), String(principal.id), tenantId, eventType, targetId, JSON.stringify(payload), new Date(this.clock).toISOString()]);
    };

    if (need === 'tenant.read') {
      const tenants = this.sqlite.query('SELECT id, slug, display_name, issuer FROM tenants').all() as Array<Record<string, unknown>>;
      return json(200, { tenants: tenants.map(t => ({ id: t.id, slug: t.slug, display_name: t.display_name, issuer: t.issuer })) });
    }
    const tenantId = usersPath![1]!;
    const tenant = this.sqlite.query('SELECT id FROM tenants WHERE id = ?').get(tenantId) as { id: string } | null;
    if (!tenant) return json(404, { error: 'tenant_not_found' });
    if (need === 'user.read') {
      const users = this.sqlite.query('SELECT id, email, display_name, status FROM users WHERE tenant_id = ?').all(tenantId) as Array<Record<string, unknown>>;
      return json(200, { users });
    }
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const email = String(body.email ?? '').trim();
    const displayName = String(body.display_name ?? '').trim();
    if (!email || !displayName) return json(400, { error: 'invalid_request' });
    const existing = this.sqlite.query('SELECT id FROM users WHERE tenant_id = ? AND email = ?').get(tenantId, email);
    if (existing) {
      audit('user.provision.failed', { error: 'conflict', email }, null, tenantId);
      return json(409, { error: 'conflict' });
    }
    const userId = randomUUID();
    this.sqlite.run(`INSERT INTO users (id, tenant_id, email, email_verified, username, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 0, NULL, ?, 'active', ?, ?)`,
      [userId, tenantId, email, displayName, new Date(this.clock).toISOString(), new Date(this.clock).toISOString()]);
    const invitationToken = `inv-${randomBytes(16).toString('hex')}`;
    audit('user.provisioned', { email }, userId, tenantId);
    return json(201, {
      user: { id: userId, tenant_id: tenantId, email, username: null, display_name: displayName, status: 'active', email_verified: false },
      invitation_token: invitationToken,
      activation_url: `https://idp.test/activate-account?token=${invitationToken}`,
    });
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

  /**
   * Seeds an oidc_clients row like the production DCR'd `sck-ops-console` public client
   * (`consent_policy require`, no secret hash), for client-alignment assertions.
   */
  seedOidcClient(row: {
    clientId: string; clientName?: string; redirectUris?: string[]; audience?: string;
    consentPolicy?: string; authMethod?: string; secretHash?: string;
  }) {
    const stamp = new Date(this.clock).toISOString();
    this.sqlite.run(`INSERT INTO oidc_clients (
      id, tenant_id, client_id, client_secret_hash, client_name, application_type,
      trust_level, consent_policy, client_profile, access_token_audience, allowed_scopes,
      initiate_login_uri, claim_hook_url, claim_hook_auth_header_name, claim_hook_auth_header_value,
      token_endpoint_auth_method, redirect_uris, grant_types, response_types, created_by,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'web', 'first_party_trusted', ?, 'spa', ?, NULL,
      NULL, NULL, NULL, NULL, ?, ?, '["authorization_code"]', '["code"]', 'ops_broker', ?, ?)`,
      [
        randomUUID(), TENANT, row.clientId, row.secretHash ?? null, row.clientName ?? 'sck-ops-console',
        row.consentPolicy ?? 'require', row.audience ?? OPS_RESOURCE,
        row.authMethod ?? 'none', JSON.stringify(row.redirectUris ?? [OPS_REDIRECT]), stamp, stamp,
      ]);
  }

  /** Direct row access for assertions about a registered OIDC client. */
  oidcClient(clientName: string): Record<string, unknown> | undefined {
    return (this.sqlite.query('SELECT * FROM oidc_clients WHERE client_name = ?').get(clientName) ?? undefined) as never;
  }
  oidcClientCount(): number {
    return (this.sqlite.query('SELECT COUNT(*) AS n FROM oidc_clients').get() as { n: number }).n;
  }

  /**
   * Seeds a client_access_token_claims row under an already-registered client; `clientId` is the
   * public oidc_clients.client_id, the row stores the internal id like production does.
   */
  seedClientClaim(row: {
    clientId: string; claimName: string; sourceType?: string;
    fixedValue?: string | null; userField?: string | null; hookField?: string | null;
  }) {
    const client = this.sqlite.query('SELECT id FROM oidc_clients WHERE client_id = ?').get(row.clientId) as { id: string } | null;
    if (!client) throw new Error(`seedClientClaim needs an oidc_clients row for ${row.clientId}`);
    const stamp = new Date(this.clock).toISOString();
    this.sqlite.run(`INSERT INTO client_access_token_claims
      (id, client_id, tenant_id, claim_name, source_type, fixed_value, user_field, hook_field, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), client.id, TENANT, row.claimName, row.sourceType ?? 'fixed',
        row.fixedValue ?? null, row.userField ?? null, row.hookField ?? null, stamp, stamp]);
  }

  /** Direct row access for assertions about which claim rows survive a delete. */
  clientClaims(): Array<Record<string, unknown>> {
    return this.sqlite.query('SELECT * FROM client_access_token_claims').all() as Array<Record<string, unknown>>;
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

  /**
   * SenseNova surfaces the supplier sampler reads: the chat `/v1/models` list takes the API
   * key as Bearer; `/lite/console/v1/*` takes the console session token; the public plan
   * page needs no auth. Wrong credentials answer 401 like the real endpoints.
   */
  private supplierHost(url: URL, method: string, init?: RequestInit): Response {
    const s = this.supplier;
    const token = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
    // OAuth issuance chain (POST-bearing endpoints precede the GET-only guard).
    if (url.host === 'platform.sensenova.cn' && url.pathname === '/oauth2/auth') {
      if (url.searchParams.get('login_verifier') === 'ver-1') {
        if (s.authConsentStall) return new Response('<html>consent required</html>', { status: 200 });
        return new Response('', { status: 302, headers: { location: `https://platform.sensenova.cn/?code=code-1&state=${s.lastAuthState}` } });
      }
      s.lastAuthState = url.searchParams.get('state') ?? '';
      return new Response('', { status: 302, headers: { location: `https://iam.sensecoreapi.cn/iam/authn/v1/auth/login?login_challenge=${s.authChallenge}`, 'set-cookie': 'oauth2_authentication_csrf=csrf1; Path=/; HttpOnly' } });
    }
    if (url.host === 'platform.sensenova.cn' && url.pathname === '/oauth2/token' && method === 'POST') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (s.authTokenStatus !== 200 || form.get('code') !== 'code-1')
        return json(400, { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid' });
      const exp = Math.floor(this.clock / 1000) + s.issuedTokenTtlSec;
      const payload = Buffer.from(JSON.stringify({ sub: s.consoleUser, exp })).toString('base64url');
      s.issuedToken = `eyJhbGciOiJURVNUIn0.${payload}.${randomBytes(8).toString('base64url')}`;
      return json(200, { access_token: s.issuedToken, token_type: 'bearer', expires_in: s.issuedTokenTtlSec, scope: 'openid offline offline_access', id_token: `eyJhbGciOiJURVNUIn0.${Buffer.from(JSON.stringify({ sub: s.consoleUser })).toString('base64url')}.sig` });
    }
    if (url.host === 'iam.sensecoreapi.cn') {
      if (url.pathname === '/iam/authn/v1/auth/checkChallenge')
        return json(200, { is_valid: s.authChallengeValid && url.searchParams.get('challenge') === s.authChallenge, redirect: '', platform: 'uconsole' });
      if (url.pathname === '/iam/authn/v1/auth/login')
        return new Response('', { status: 302, headers: { location: 'https://platform.sensenova.cn/login?login_challenge=' + s.authChallenge } });
      if (url.pathname === '/iam/authn/v1/auth/nova/login' && method === 'POST') {
        if (s.authLoginStatus !== 200) return new Response('', { status: s.authLoginStatus });
        const body = JSON.parse(String(init?.body ?? '{}')) as { username?: string; password?: string; challenge?: string };
        if (body.username !== s.consoleUser || body.password !== s.consolePassword || body.challenge !== s.authChallenge)
          return json(401, { code: 16, message: 'Unauthenticated' });
        return json(200, { redirect: `https://${s.authRedirectHost}/oauth2/auth?login_verifier=ver-1` });
      }
      return new Response('404 Not Found', { status: 404 });
    }
    if (method !== 'GET') return json(405, { code: 12, message: 'Method Not Allowed' });
    if (url.host === 'token.sensenova.cn') {
      if (url.pathname !== '/v1/models') return json(404, { error: { code: 5, message: 'NOT_FOUND' } });
      if (token !== s.apiKey) return json(401, { error: { code: 16, message: 'Forbidden' } });
      if (s.modelsStatus !== 200) return new Response('', { status: s.modelsStatus });
      return json(200, { object: 'list', data: [{ id: 'sensenova-6.8-flash-lite', object: 'model' }, { id: 'deepseek-v4-flash', object: 'model' }] });
    }
    if (url.host === 'platform.sensenova.cn') {
      const unauth = (reason: string) => json(401, { code: 16, details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', domain: 'global', reason }], message: 'Unauthenticated' });
      if (url.pathname === '/lite/console/v1/tokenplan/pool-usage') {
        if (!token) return unauth('Authorization header is required');
        if (token !== s.consoleToken && token !== s.issuedToken) return unauth("Authentication type 'apikey' is not enabled");
        if (s.poolStatus !== 200) return new Response('', { status: s.poolStatus });
        return json(200, { plan: { id: 'free', name: 'Free Plan', type: s.planType }, pools: s.pools });
      }
      if (url.pathname === '/lite/console/v1/billing' && s.billingPathLive) {
        if (!token || (token !== s.consoleToken && token !== s.issuedToken)) return unauth('Authorization header is required');
        return json(200, { accounts: [] });
      }
      if (url.pathname === '/lite/console/v1/metered/api-keys') {
        if (!token) return unauth('Authorization header is required');
        if (token !== s.consoleToken && token !== s.issuedToken) return unauth("Authentication type 'apikey' is not enabled");
        if (s.keysStatus !== 200) return new Response('', { status: s.keysStatus });
        const keys = [s.apiKey, ...s.extraApiKeys].map((key, i) => ({ id: `key-${i}`, api_key: key, displayname: `key ${i}`, status: 'Active' }));
        return json(200, { api_keys: s.apiKeyListed ? keys : keys.filter(k => k.api_key !== s.apiKey), total_count: keys.length, next_page_token: '' });
      }
      return new Response('404 Not Found', { status: 404 });
    }
    if (url.host === 'www.sensenova.cn') {
      if (url.pathname !== '/token-plan') return new Response('404', { status: 404 });
      if (s.planStatus !== 200) return new Response('', { status: s.planStatus });
      return new Response(s.planHtml, { status: 200, headers: {
        'content-type': 'text/html; charset=utf-8',
        ...(s.planDate ? { date: new Date(this.clock).toUTCString() } : {}),
        ...(s.planEtag ? { etag: '"plan-fixture-v3"' } : {}),
      } });
    }
    return new Response('unreachable host', { status: 502 });
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
      // Mirrors POST /api/ops/idp-provision-token/rotate: subscription.manage capability, the
      // candidate token is probed against the IdP (here: the D1 principal rows themselves), then
      // sealed into the product's store — modelled as the live hash for later status reads.
      if (method === 'POST' && url.pathname === '/api/ops/idp-provision-token/rotate') {
        if (!caps.includes('subscription.manage')) return apiError(403, 'platform-operator-capability-missing');
        const token = String(body.token ?? '');
        if (!token) return apiError(400, 'idp-provision-token-invalid-request');
        const hash = createHash('sha256').update(token).digest('base64url');
        const principal = this.sqlite.query(`SELECT * FROM admin_service_principals WHERE token_hash = ?`).get(hash) as Record<string, unknown> | null;
        if (!principal || principal.status !== 'active') return apiError(400, 'idp-provision-token-invalid');
        this.liveProvisionToken = { hash, principalId: String(principal.id) };
        return json(200, { rotated: true, source: 'store', updatedAt: new Date(this.clock).toISOString(), updatedBy: grant.userId });
      }
      if (method === 'GET' && url.pathname === '/api/ops/idp-provision-token/status') {
        if (!caps.includes('quota.read')) return apiError(403, 'platform-operator-capability-missing');
        const live = this.liveProvisionToken;
        return json(200, {
          configured: true,
          source: live ? 'store' : 'env',
          env: { configured: true },
          store: {
            sealKeyConfigured: true,
            entry: live ? { updatedAt: new Date(this.clock).toISOString(), updatedBy: 'ops:test', purpose: 'provision token' } : null,
            unsealError: null,
          },
          idp: { reachable: true, status: null, error: null },
        });
      }
      // Mirrors POST /api/ops/invitations: subscription.manage capability; async contract —
      // fast path 201+URL（同步窗内完成即记为已收取），inviteAsyncPolls 模式回 202 processing
      // 供 GET 轮询；僵死（inviteNeedsResume）行须同键重发续跑。
      if (method === 'POST' && url.pathname === '/api/ops/invitations') {
        if (!caps.includes('subscription.manage')) return apiError(403, 'platform-operator-capability-missing');
        const key = String(body.idempotencyKey ?? '');
        const existing = this.issuedInvites.get(key);
        if (existing) {
          if (existing.status === 'processing') {
            this.inviteResumeCalls += 1;
            if (this.inviteNeedsResume && !this.inviteResumed.has(key)) {
              this.inviteResumed.add(key); // 续跑成功：恢复推进
            }
          }
          const delivery = { ...(existing.delivery as Record<string, unknown>), activationUrl: null };
          return json(existing.status === 'processing' ? 200 : 200, { ...existing, replayed: true, delivery });
        }
        const url = `https://idp.test/activate-account?token=onetime-${randomUUID()}`;
        this.inviteUrls.set(key, url);
        const base = {
          idempotencyKey: key, replayed: false,
          user: { id: `uid-${key.slice(0, 8)}`, email: String(body.email ?? ''), status: 'provisioned', outcome: 'created' },
          workspace: { slug: String(body.workspaceSlug ?? ''), dbName: 'ws_fake', outcome: 'created' },
          entitlement: { planKey: String(body.planKey ?? 'pro'), productPlanRevisionId: 'product_plan_revision:x', billingAccountKey: 'personal:x' },
          aiAllowance: { kind: 'compensation', amount: (body.aiAllowance as Record<string, unknown> | undefined)?.amount ?? 0, periodKey: `invite:${key}`, expiresAt: '2026-12-31T23:59:59.000Z', bucket: 'ai_allowance_bucket:fake' },
        };
        const asyncPolls = this.inviteAsyncPolls ?? 0;
        if (asyncPolls > 0) {
          const processing = { ...base, status: 'processing',
            delivery: { channel: 'none', activationUrl: null, pendingCollect: false, note: '开通仍在进行' } };
          this.issuedInvites.set(key, processing);
          this.invitePendingPolls.set(key, asyncPolls);
          return json(202, processing);
        }
        const completed = { ...base, status: 'completed',
          delivery: { channel: 'activation_url', activationUrl: url, pendingCollect: false, note: 'invite note' } };
        this.issuedInvites.set(key, completed);
        this.inviteDeliveredAt.set(key, new Date(this.clock).toISOString()); // 同步窗内下发即收取
        return json(201, completed);
      }
      // GET /api/ops/invitations/:key — quota.read，读路径永不含 URL 本体。
      const inviteGet = /^\/api\/ops\/invitations\/([^/]+)$/.exec(url.pathname);
      if (method === 'GET' && inviteGet) {
        if (!caps.includes('quota.read')) return apiError(403, 'platform-operator-capability-missing');
        const key = decodeURIComponent(inviteGet[1]!);
        const row = this.issuedInvites.get(key);
        if (!row) return apiError(404, 'invite-not-found');
        if (row.status === 'processing' && (!this.inviteNeedsResume || this.inviteResumed.has(key))) {
          const left = this.invitePendingPolls.get(key) ?? 0;
          if (left <= 1) {
            this.invitePendingPolls.delete(key);
            if (this.inviteFailOnComplete) {
              row.status = 'failed';
              row.errorCode = 'invite-slug-taken';
              row.errorMessage = 'workspace slug 已被占用';
            } else {
              row.status = 'completed';
              row.delivery = { channel: 'activation_url', activationUrl: null, pendingCollect: this.inviteUrls.has(key), note: '完成后经 collect-delivery 收取' };
            }
          } else {
            this.invitePendingPolls.set(key, left - 1);
          }
        }
        return json(200, { ...row, replayed: true });
      }
      // POST /api/ops/invitations/:key/resend — subscription.manage，镜像产品语义：
      // completed 行铸新链暂存回行（pendingCollect）；processing/failed 409；
      // 未收取或上次重签发仍在 24h 有效期内的重放不重复铸链。
      const resend = /^\/api\/ops\/invitations\/([^/]+)\/resend$/.exec(url.pathname);
      if (method === 'POST' && resend) {
        if (!caps.includes('subscription.manage')) return apiError(403, 'platform-operator-capability-missing');
        const key = decodeURIComponent(resend[1]!);
        const row = this.issuedInvites.get(key);
        if (!row) return apiError(404, 'invite-not-found');
        if (row.status === 'processing') return apiError(409, 'invite-resend-while-processing');
        if (row.status !== 'completed') return apiError(409, 'invite-resend-invalid-state');
        const pendingCollect = this.inviteUrls.has(key) && !this.inviteDeliveredAt.has(key);
        const resentAt = this.inviteResentAt.get(key);
        const withinTtl = resentAt !== undefined && this.clock - resentAt < 24 * 60 * 60 * 1000;
        if (!pendingCollect && !withinTtl) {
          const u = row.user as Record<string, unknown> | null;
          if (u && this.inviteActivatedUsers.has(String(u.id))) return apiError(409, 'invite-already-activated');
          this.inviteResendCalls += 1;
          this.inviteUrls.set(key, `https://idp.test/activate-account?token=resent-${randomUUID()}`);
          this.inviteDeliveredAt.delete(key);
          this.inviteResentAt.set(key, this.clock);
        }
        const nowPending = this.inviteUrls.has(key) && !this.inviteDeliveredAt.has(key);
        row.delivery = { channel: 'activation_url', activationUrl: null, pendingCollect: nowPending, note: 'collect-delivery 一次性收取' };
        return json(200, { ...row, replayed: true, delivery: row.delivery });
      }
      // POST /api/ops/invitations/:key/collect-delivery — subscription.manage，一次性收取。
      const collect = /^\/api\/ops\/invitations\/([^/]+)\/collect-delivery$/.exec(url.pathname);
      if (method === 'POST' && collect) {
        if (!caps.includes('subscription.manage')) return apiError(403, 'platform-operator-capability-missing');
        const key = decodeURIComponent(collect[1]!);
        const row = this.issuedInvites.get(key);
        if (!row) return apiError(404, 'invite-not-found');
        const deliveredAt = this.inviteDeliveredAt.get(key) ?? null;
        if (row.status !== 'completed' || deliveredAt || !this.inviteUrls.has(key)) {
          return json(200, { idempotencyKey: key, status: row.status, activationUrl: null, deliveredAt });
        }
        const now = new Date(this.clock).toISOString();
        this.inviteDeliveredAt.set(key, now);
        row.delivery = { ...(row.delivery as Record<string, unknown>), pendingCollect: false };
        return json(200, { idempotencyKey: key, status: 'completed', activationUrl: this.inviteUrls.get(key), deliveredAt: now });
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

  /**
   * SYS04: the fault ledger the broker talks to. The fake keeps the calls so a test can assert what was reserved,
   * charged and reported, and it can be told to refuse a reservation (the spent budget).
   */
  readonly faults = {
    reserved: [] as Array<{ taskId: string; phase: string; target: string }>,
    reported: [] as Array<{ taskId: string; phase: string; target?: string; errno?: string; status?: number; stage?: string; idempotent?: boolean }>,
    settled: [] as Array<{ taskId: string; phase: string; target: string }>,
    /** When set, the next reservation is refused with this reason. */
    refuse: undefined as { reason: string; message: string } | undefined,
    /** When set, only a reservation for this controlled target is refused (the isolated scope is stopped). */
    refuseTarget: undefined as string | undefined,
    /** When set, the next report is refused with this message. */
    refuseReport: undefined as string | undefined,
  };

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
    reserveFault: async (scope: { taskId: string }, input: { phase: string; target?: string }) => {
      if (this.faults.refuse) {
        const refusal = this.faults.refuse;
        this.faults.refuse = undefined;
        return { allowed: false, attempt: 0, charged: false, reason: refusal.reason, message: refusal.message, evidence: {} };
      }
      if (this.faults.refuseTarget !== undefined && (input.target ?? 'none') === this.faults.refuseTarget) {
        return {
          allowed: false, attempt: 0, charged: false, reason: 'not_retryable',
          message: `operation refused (${input.phase}): this failure is not retryable.`, evidence: {},
        };
      }
      this.faults.reserved.push({ taskId: scope.taskId, phase: input.phase, target: input.target ?? 'none' });
      return { allowed: true, attempt: 0, charged: false, message: '', evidence: {} };
    },
    reportFault: async (scope: { taskId: string }, input: { phase: string; target?: string; errno?: string; status?: number; stage?: string; idempotent?: boolean }) => {
      this.faults.reported.push({ taskId: scope.taskId, phase: input.phase, target: input.target ?? 'none', errno: input.errno, status: input.status, stage: input.stage, idempotent: input.idempotent });
      if (this.faults.refuseReport) {
        const message = this.faults.refuseReport;
        this.faults.refuseReport = undefined;
        return { allowed: false, message, evidence: { decision: 'not_retryable' } };
      }
      return { allowed: true, message: '', evidence: {} };
    },
    settleFault: async (scope: { taskId: string }, input: { phase: string; target?: string }) => {
      this.faults.settled.push({ taskId: scope.taskId, phase: input.phase, target: input.target ?? 'none' });
    },
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
