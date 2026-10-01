// Ops capability broker. Employees never hold credentials: they ask for an operation by name,
// this trusted code (running inside the Paseo plugin, next to the sealed secrets and the
// Cloudflare token) performs it, and only a secret-free result goes back. Every call is gated
// on the caller's live task lease, role-checked against the project environment, and audited.
import type { CompanyCore, OpsScope } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import type { EnvBrokerRow, ProjectStore } from '../projects.ts';
import {
  accountEmail, accountUsername, aliasFromSecretName, canonicalAlias, ensureAccount, passwordSecretName,
  type EnsureAccountResult,
} from './accounts.ts';
import { egoBrowserInjector, type BrowserInjector } from './browser.ts';
import { controlPlaneEnv, parseBrokerConfig, type BrokerConfig, type ControlPlaneEnv } from './config.ts';
import { cloudflareD1, type D1Client } from './d1.ts';
import type { Fetcher } from './fetcher.ts';
import { surrealQueryAsUser, type QueryAsUser } from './data.ts';
import { jwtExpiry, LoginError, passwordLogin, type LoginTokens } from './idp.ts';
import { productRequest, ProductUnreachable, type ProductResult } from './product.ts';
import { clip, redactJson, redactText } from './redact.ts';
import { SessionStore, type OpsSession } from './sessions.ts';

export const OPS_TOOLS = [
  'ops_info', 'ops_health', 'ops_account_ensure', 'ops_login', 'ops_operator_login', 'ops_logout', 'ops_workspace_ensure',
  'ops_member_list', 'ops_member_add', 'ops_member_remove', 'ops_request', 'ops_query', 'ops_browser_login',
] as const;
export type OpsTool = typeof OPS_TOOLS[number];

type Args = Record<string, unknown>;

export interface OpsDeps {
  core: Pick<CompanyCore, 'opsScope' | 'auditOps' | 'opsCount'>;
  projects: Pick<ProjectStore, 'brokerEnvs' | 'readSealed' | 'setSecret' | 'sealedNames'>;
  /** Sealing key; `create` lets the first seal mint one. */
  secretKey: (create?: boolean) => Buffer;
  controlEnv?: () => ControlPlaneEnv;
  fetch?: Fetcher;
  now?: () => number;
  log?: (message: string) => void;
  /** Test seams; production wires Cloudflare D1, the SurrealDB SDK and ego-browser. */
  d1?: (config: BrokerConfig, env: ControlPlaneEnv) => D1Client;
  queryAsUser?: QueryAsUser;
  browser?: BrowserInjector;
}

interface Ctx {
  scope: OpsScope;
  /** Name of the project environment the broker config came from. */
  env: string;
  cfg: BrokerConfig;
  row: EnvBrokerRow;
}

/** `action` decides visibility: ops_call rows stay out of handover history, everything else is shown. */
interface Outcome { value: unknown; audit?: { action: string; evidence: string } }
type Handler = (ctx: Ctx, args: Args) => Promise<Outcome>;

interface WorkspaceItem { slug: string; name: string; dbName: string; role?: string }

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DAY_SECONDS = 86_400;
const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_MS = 15 * 60_000;
const MAX_RESULT_CHARS = 100_000;

const invalid = (message: string) => new CompanyError('invalid', message);

function text(args: Args, key: string, max = 200): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${key} is required (text up to ${max} chars)`);
  return value.trim();
}

function slugOf(args: Args, key = 'slug'): string {
  const slug = text(args, key, 60).toLowerCase();
  if (!SLUG.test(slug)) throw invalid('slug must be 1-40 lowercase letters, digits or hyphens');
  return slug;
}

const plainId = (value: unknown): string => {
  const raw = value && typeof value === 'object' && 'id' in value ? (value as { id: unknown }).id : value;
  return String(raw).replace(/^user:/, '').replace(/^⟨|⟩$/g, '');
};

const jsonSafe = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)) ?? 'null');

/** The product answers `{ error: { code, message } }`, the IdP `{ error: '<code>' }`; only the short machine code is relayed. */
function errorCode(body: unknown): string {
  if (body && typeof body === 'object') {
    const { error, code } = body as { error?: unknown; code?: unknown };
    const nested = error && typeof error === 'object' ? (error as { code?: unknown }).code : error;
    const picked = typeof nested === 'string' ? nested : code;
    if (typeof picked === 'string') return picked.replace(/[^\w.-]/g, '').slice(0, 60) || 'error';
  }
  return 'error';
}

function productFailure(what: string, res: ProductResult, specific: Partial<Record<number, CompanyError['code']>> = {}): CompanyError {
  const code = specific[res.status] ?? (res.status === 401 ? 'login_failed' : res.status >= 500 ? 'upstream_error' : 'invalid');
  return new CompanyError(code, `${what} failed: HTTP ${res.status} ${errorCode(res.body)}`, res.status >= 500);
}

/**
 * The product provisions a workspace in many steps and resumes an interrupted one when the same
 * owner asks for the same slug again, so an unanswered or 5xx creation is settled by repeating it,
 * never by picking another slug (that leaves a half-built workspace behind and burns the daily limit).
 */
const unfinishedCreation = (slug: string, detail: string) => new CompanyError('upstream_error',
  `workspace ${slug} may not be fully created yet (${detail}); call ops_workspace_ensure again with the same slug and name to reuse or finish it, and do not switch to another slug`, true);

export class OpsBroker {
  readonly tools: readonly string[] = OPS_TOOLS;
  private readonly sessions: SessionStore;
  private readonly now: () => number;
  private readonly handlers: Record<OpsTool, Handler>;

  constructor(private readonly deps: OpsDeps) {
    this.now = deps.now ?? Date.now;
    this.sessions = new SessionStore(this.now);
    this.handlers = {
      ops_info: (ctx) => this.info(ctx),
      ops_health: (ctx) => this.health(ctx),
      ops_account_ensure: (ctx, args) => this.accountEnsure(ctx, args),
      ops_login: (ctx, args) => this.login(ctx, args),
      ops_operator_login: (ctx, args) => this.operatorLogin(ctx, args),
      ops_logout: (ctx, args) => this.logout(ctx, args),
      ops_workspace_ensure: (ctx, args) => this.workspaceEnsure(ctx, args),
      ops_member_list: (ctx, args) => this.memberList(ctx, args),
      ops_member_add: (ctx, args) => this.memberAdd(ctx, args),
      ops_member_remove: (ctx, args) => this.memberRemove(ctx, args),
      ops_request: (ctx, args) => this.request(ctx, args),
      ops_query: (ctx, args) => this.query(ctx, args),
      ops_browser_login: (ctx, args) => this.browserLogin(ctx, args),
    };
  }

  /** The sidecar injects `taskId` from the live lease; `opsScope` re-verifies that lease on every call. */
  async call(credential: string, taskId: string, tool: string, args: Args = {}): Promise<unknown> {
    const handler = (this.handlers as Record<string, Handler | undefined>)[tool];
    if (!handler) throw invalid(`unknown ops tool: ${tool}`);
    const scope = await this.deps.core.opsScope(credential, taskId);
    const ctx = await this.context(scope, args.env);
    try {
      const { value, audit } = await handler(ctx, args);
      if (audit) await this.audit(ctx, audit.action, audit.evidence);
      return value;
    } catch (error) {
      throw await this.failed(ctx, tool, error);
    }
  }

  /** An instance is gone: its sessions go with it. */
  release(employeeId: string): void { this.sessions.dropEmployee(employeeId); }

  private async context(scope: OpsScope, requested: unknown): Promise<Ctx> {
    const rows = (await this.deps.projects.brokerEnvs(scope.project)).filter(row => row.broker !== undefined && row.broker !== null);
    if (requested !== undefined && typeof requested !== 'string') throw invalid('env must be a string');
    const row = requested ? rows.find(r => r.name === requested)
      : rows.length === 1 ? rows[0] : rows.find(r => r.name === 'production');
    if (!row) throw new CompanyError('not_configured', `project ${scope.project} has no ops broker environment${requested ? ` named ${requested}` : ''}`);
    const cfg = parseBrokerConfig(row.broker);
    if (!cfg.roles.includes(scope.actor.role)) throw new CompanyError('forbidden', `role ${scope.actor.role} may not use ops tools on ${scope.project}/${row.name}`);
    return { scope, env: row.name, cfg, row };
  }

  private async audit(ctx: Ctx, action: string, evidence: string): Promise<void> {
    const known = this.sessions.secrets(ctx.scope.actor.employeeId);
    await this.deps.core.auditOps(ctx.scope, action, clip(redactText(evidence, known), 500));
  }

  private async failed(ctx: Ctx, tool: string, error: unknown): Promise<CompanyError> {
    const known = this.sessions.secrets(ctx.scope.actor.employeeId);
    const base = error instanceof CompanyError ? error
      : new CompanyError('upstream_error', `${(error as Error)?.name ?? 'Error'}: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    const safe = new CompanyError(base.code, redactText(base.message, known), base.retryable);
    const quiet = safe.code === 'invalid' || safe.code === 'not_found';
    await this.audit(ctx, quiet ? 'ops_call' : 'ops_error', `${tool} → ${safe.code}: ${safe.message}`).catch(() => undefined);
    return safe;
  }

  // ---------- reads without a session ----------

  private async info(ctx: Ctx): Promise<Outcome> {
    const names = await this.deps.projects.sealedNames(ctx.scope.project, ctx.env);
    const accounts = names.map(aliasFromSecretName).filter((alias): alias is string => !!alias)
      .map(alias => ({ alias, username: accountUsername(alias, ctx.cfg.accounts.prefix) }));
    return {
      value: {
        project: ctx.scope.project, env: ctx.env, productUrl: ctx.cfg.product.url, roles: ctx.cfg.roles,
        tools: OPS_TOOLS, accounts, workspacePrefix: ctx.cfg.accounts.workspacePrefix, limits: ctx.cfg.limits,
        can: { createAccounts: this.canEnsure(ctx), queryWorkspaceData: !!ctx.cfg.data, browserLogin: true, operatorLogin: !!ctx.cfg.ops, opsAudienceLogin: !!ctx.cfg.idp.ops },
      },
    };
  }

  private async health(ctx: Ctx): Promise<Outcome> {
    const url = ctx.row.healthUrl ?? `${ctx.cfg.product.url}/health`;
    const started = this.now();
    let response: Response;
    try {
      response = await (this.deps.fetch ?? fetch)(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      return { value: { url, reachable: false, error: (error as Error).name } };
    }
    const raw = (await response.text().catch(() => '')).slice(0, 4000);
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    return { value: { url, reachable: true, status: response.status, ok: response.ok, ms: this.now() - started, body: redactJson(body) } };
  }

  // ---------- accounts ----------

  private canEnsure(ctx: Ctx): boolean {
    const env = this.controlEnv();
    return !!(ctx.cfg.d1 && (this.deps.d1 || (env.cloudflareToken && env.cloudflareAccountId)));
  }

  private controlEnv(): ControlPlaneEnv { return (this.deps.controlEnv ?? controlPlaneEnv)(); }

  private d1(ctx: Ctx): D1Client {
    if (!ctx.cfg.d1) throw new CompanyError('not_configured', 'this environment has no IdP database configured for account management');
    const env = this.controlEnv();
    if (this.deps.d1) return this.deps.d1(ctx.cfg, env);
    if (!env.cloudflareToken || !env.cloudflareAccountId) throw new CompanyError('not_configured', 'the control plane has no Cloudflare credentials for account management');
    return cloudflareD1({ accountId: env.cloudflareAccountId, databaseId: ctx.cfg.d1.databaseId, token: env.cloudflareToken, baseUrl: env.cloudflareBaseUrl, fetch: this.deps.fetch });
  }

  private async sealedPassword(ctx: Ctx, alias: string): Promise<string | undefined> {
    return this.deps.projects.readSealed(ctx.scope.project, ctx.env, passwordSecretName(alias), this.deps.secretKey());
  }

  /** Creates or repairs the IdP account behind an alias; the password is sealed before the IdP sees it. */
  private async ensure(ctx: Ctx, alias: string): Promise<EnsureAccountResult & { username: string; email: string }> {
    const d1 = this.d1(ctx);
    const username = accountUsername(alias, ctx.cfg.accounts.prefix);
    const email = accountEmail(username, ctx.cfg.accounts.emailDomain);
    const outcome = await ensureAccount({
      d1, tenantId: ctx.cfg.d1!.tenantId, username, email,
      sealed: await this.sealedPassword(ctx, alias),
      now: () => new Date(this.now()),
      beforeCreate: async () => {
        const used = await this.deps.core.opsCount(ctx.scope.project, 'ops_account_create', DAY_SECONDS);
        if (used >= ctx.cfg.limits.accountsPerDay) throw new CompanyError('limit_reached', `account creation limit reached (${ctx.cfg.limits.accountsPerDay} per day)`);
      },
      seal: password => this.deps.projects.setSecret(
        { project: ctx.scope.project, env: ctx.env, name: passwordSecretName(alias), value: password, purpose: 'ops broker test account' },
        this.deps.secretKey(true)),
    });
    if (outcome.result === 'created') await this.audit(ctx, 'ops_account_create', `created IdP account ${username}`);
    else if (outcome.result === 'repaired') await this.audit(ctx, 'ops_account_repair', `reset drifted credential of IdP account ${username}`);
    return { ...outcome, username, email };
  }

  private async accountEnsure(ctx: Ctx, args: Args): Promise<Outcome> {
    const alias = canonicalAlias(args.alias);
    const { result, username, email } = await this.ensure(ctx, alias);
    return {
      value: { alias, username, email, result },
      audit: result === 'exists' ? { action: 'ops_call', evidence: `ops_account_ensure ${alias} → exists` } : undefined,
    };
  }

  // ---------- sessions ----------

  private async login(ctx: Ctx, args: Args): Promise<Outcome> {
    const alias = canonicalAlias(args.alias);
    const username = accountUsername(alias, ctx.cfg.accounts.prefix);
    if (args.audience !== undefined && args.audience !== 'ops') {
      throw invalid('audience must be "ops" when given; omit it for a customer login');
    }
    if (args.audience === 'ops') return this.opsLogin(ctx, args, alias, username);
    let password = await this.sealedPassword(ctx, alias);
    let ensured: EnsureAccountResult['result'] | undefined;
    if (!password) {
      ({ password, result: ensured } = await this.ensure(ctx, alias));
    }
    let tokens: LoginTokens;
    try {
      tokens = await passwordLogin(ctx.cfg, username, password, { fetch: this.deps.fetch, now: this.now, channel: 'customer' });
    } catch (error) {
      // A sealed password the IdP no longer accepts is drift (someone reset it out of band): repair once.
      if (!(error instanceof LoginError) || error.reason !== 'invalid_credentials' || ensured || !this.canEnsure(ctx)) throw error;
      ({ password, result: ensured } = await this.ensure(ctx, alias));
      tokens = await passwordLogin(ctx.cfg, username, password, { fetch: this.deps.fetch, now: this.now, channel: 'customer' });
    }
    const session = this.sessions.create({
      employeeId: ctx.scope.actor.employeeId, project: ctx.scope.project, env: ctx.env, alias, username,
      kind: 'customer', token: tokens.accessToken, expiresAt: tokens.expiresAt,
    });
    let listing: { workspaces: WorkspaceItem[]; canCreate: boolean };
    try {
      listing = await this.listWorkspaces(ctx, session);
      if (args.workspace !== undefined) {
        const wanted = slugOf(args, 'workspace');
        const item = listing.workspaces.find(w => w.slug === wanted);
        if (!item) throw new CompanyError('not_found', `${username} is not a member of workspace ${wanted}`);
        await this.switchTo(ctx, session, item);
      }
    } catch (error) {
      this.sessions.drop(session.id);
      throw error;
    }
    return {
      value: {
        session: session.id, kind: session.kind, alias, username, expiresAt: new Date(session.expiresAt).toISOString(),
        accountResult: ensured, workspace: session.workspace, canCreate: listing.canCreate,
        workspaces: listing.workspaces.map(({ slug, name, role }) => ({ slug, name, role })),
      },
      audit: { action: 'ops_login', evidence: `login as ${username}${ensured ? `（账号已${ensured === 'created' ? '创建' : '修复'}）` : ''}${session.workspace ? `，进入 workspace ${session.workspace.slug}` : ''}` },
    };
  }

  /**
   * `ops_login` with `audience:"ops"`: the alias logs in through the public client registered
   * at the IdP for the ops audience, redeeming the code at the IdP's own `/token` endpoint.
   * An ops session never lists or enters workspaces (the product's session routes do not
   * accept that audience) and never auto-creates an account: a fresh account is not an
   * operator, so a missing sealed password is a plain not_found.
   */
  private async opsLogin(ctx: Ctx, args: Args, alias: string, username: string): Promise<Outcome> {
    if (!ctx.cfg.idp.ops) {
      throw new CompanyError('not_configured', 'this environment has no ops login configured (broker idp.ops)');
    }
    if (args.workspace !== undefined) throw invalid('an ops session cannot enter a workspace');
    const password = await this.sealedPassword(ctx, alias);
    if (!password) {
      throw new CompanyError('not_found', `no sealed password for ${alias}; ops logins never auto-create accounts`);
    }
    const tokens = await passwordLogin(ctx.cfg, username, password, { fetch: this.deps.fetch, now: this.now, channel: 'ops' });
    const session = this.sessions.create({
      employeeId: ctx.scope.actor.employeeId, project: ctx.scope.project, env: ctx.env, alias, username,
      kind: 'ops', token: tokens.accessToken, expiresAt: tokens.expiresAt,
    });
    return {
      value: {
        session: session.id, kind: session.kind, alias, username, expiresAt: new Date(session.expiresAt).toISOString(),
        audience: 'ops',
      },
      audit: { action: 'ops_login', evidence: `login as ${username}（audience=ops）` },
    };
  }

  /**
   * Logs the alias in through the dedicated ops OIDC client so the session's token carries the
   * ops audience, then probes the product's operator middleware (`/api/ops/quota/context` needs
   * an active platform operator and no specific capability) so a wrong-audience token, an
   * account that is not an operator, or one whose ops client is misconfigured fails here with
   * a clear error instead of inside somebody's workflow.
   */
  private async operatorLogin(ctx: Ctx, args: Args): Promise<Outcome> {
    if (!ctx.cfg.ops) throw new CompanyError('not_configured', 'this environment has no operator channel; set broker.ops (clientId, redirectUri, resource) to enable it');
    const alias = canonicalAlias(args.alias);
    const username = accountUsername(alias, ctx.cfg.accounts.prefix);
    let password = await this.sealedPassword(ctx, alias);
    let ensured: EnsureAccountResult['result'] | undefined;
    if (!password) {
      ({ password, result: ensured } = await this.ensure(ctx, alias));
    }
    let tokens: LoginTokens;
    try {
      tokens = await passwordLogin(ctx.cfg, username, password, { fetch: this.deps.fetch, now: this.now, channel: 'operator' });
    } catch (error) {
      // A sealed password the IdP no longer accepts is drift (someone reset it out of band): repair once.
      if (!(error instanceof LoginError) || error.reason !== 'invalid_credentials' || ensured || !this.canEnsure(ctx)) throw error;
      ({ password, result: ensured } = await this.ensure(ctx, alias));
      tokens = await passwordLogin(ctx.cfg, username, password, { fetch: this.deps.fetch, now: this.now, channel: 'operator' });
    }
    const session = this.sessions.create({
      employeeId: ctx.scope.actor.employeeId, project: ctx.scope.project, env: ctx.env, alias, username,
      kind: 'operator', token: tokens.accessToken, expiresAt: tokens.expiresAt,
    });
    const probe = await productRequest(ctx.cfg, session.token, { method: 'GET', path: '/api/ops/quota/context' }, { fetch: this.deps.fetch });
    if (!probe.ok) {
      this.sessions.drop(session.id);
      throw productFailure('operator access check', probe, { 401: 'login_failed', 403: 'forbidden' });
    }
    const known = this.sessions.secrets(ctx.scope.actor.employeeId);
    return {
      value: {
        session: session.id, kind: session.kind, alias, username, expiresAt: new Date(session.expiresAt).toISOString(),
        accountResult: ensured, operator: clipJson(redactJson(probe.body, known)),
      },
      audit: { action: 'ops_operator_login', evidence: `operator login as ${username}${ensured ? `（账号已${ensured === 'created' ? '创建' : '修复'}）` : ''}` },
    };
  }

  private logout(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.session(ctx, args);
    this.sessions.drop(session.id);
    return Promise.resolve({ value: { closed: true }, audit: { action: 'ops_call', evidence: `ops_logout ${session.username}` } });
  }

  private session(ctx: Ctx, args: Args): OpsSession {
    return this.sessions.get(args.session, ctx.scope.actor.employeeId, ctx.scope.project, ctx.env);
  }

  /** Every session tool but `ops_request` only makes sense for a customer session. */
  private customerSession(ctx: Ctx, args: Args): OpsSession {
    const session = this.session(ctx, args);
    if (session.kind !== 'customer') {
      throw invalid(`this session is an ${session.kind} session; it can only be used with ops_request on /api/ops/* paths`);
    }
    return session;
  }

  private adopt(session: OpsSession, token: { accessToken: string; expiresIn?: number }): void {
    session.token = token.accessToken;
    session.expiresAt = token.expiresIn !== undefined ? this.now() + token.expiresIn * 1000
      : jwtExpiry(token.accessToken) ?? this.now() + DEFAULT_TOKEN_MS;
  }

  /** Logs the session's account in again (same sealed password) and restores its workspace scope. */
  private async reauth(ctx: Ctx, session: OpsSession): Promise<void> {
    const password = await this.sealedPassword(ctx, session.alias);
    if (!password) throw new CompanyError('not_found', `no sealed password for ${session.alias}; call ops_account_ensure`);
    const tokens = await passwordLogin(ctx.cfg, session.username, password, { fetch: this.deps.fetch, now: this.now, channel: session.kind });
    session.token = tokens.accessToken;
    session.expiresAt = tokens.expiresAt;
    const workspace = session.workspace;
    session.workspace = undefined;
    if (workspace) {
      const res = await productRequest(ctx.cfg, session.token, { method: 'POST', path: '/api/session/switch-workspace', body: { workspaceSlug: workspace.slug } }, { fetch: this.deps.fetch });
      if (!res.ok || !res.token) throw productFailure('re-entering workspace', res, { 403: 'forbidden' });
      this.adopt(session, res.token);
      session.workspace = workspace;
    }
  }

  private async product(ctx: Ctx, session: OpsSession, method: string, path: string, body?: unknown): Promise<ProductResult> {
    if (this.now() >= session.expiresAt - REFRESH_MARGIN_MS) await this.reauth(ctx, session);
    const send = () => productRequest(ctx.cfg, session.token, { method, path, body }, { fetch: this.deps.fetch });
    let res = await send();
    if (res.status === 401) {
      await this.reauth(ctx, session);
      res = await send();
    }
    if (res.token) {
      this.adopt(session, res.token);
      // A raw request may have moved the token to another scope; workspace-bound tools re-resolve it.
      if (session.workspace && !(method === 'POST' && path === '/api/session/switch-workspace')) session.workspace = undefined;
    }
    return res;
  }

  // ---------- workspaces ----------

  private async listWorkspaces(ctx: Ctx, session: OpsSession): Promise<{ workspaces: WorkspaceItem[]; canCreate: boolean }> {
    const res = await this.product(ctx, session, 'GET', '/api/session/workspaces');
    if (!res.ok) throw productFailure('listing workspaces', res);
    const body = (res.body ?? {}) as { workspaces?: Array<Record<string, unknown>>; canCreate?: boolean };
    const workspaces = (body.workspaces ?? []).filter(w => typeof w.slug === 'string' && typeof w.dbName === 'string').map(w => ({
      slug: w.slug as string, name: String(w.name ?? w.slug), dbName: w.dbName as string,
      role: typeof w.role === 'string' ? w.role : undefined,
    }));
    return { workspaces, canCreate: body.canCreate === true };
  }

  private async switchTo(ctx: Ctx, session: OpsSession, item: WorkspaceItem): Promise<void> {
    const res = await this.product(ctx, session, 'POST', '/api/session/switch-workspace', { workspaceSlug: item.slug });
    if (!res.ok) throw productFailure(`switching to workspace ${item.slug}`, res, { 403: 'forbidden', 409: 'conflict' });
    session.workspace = { slug: item.slug, dbName: item.dbName };
  }

  /** Puts the session's token in the scope of `slug`, switching only when it is not already there. */
  private async useWorkspace(ctx: Ctx, session: OpsSession, slug: string): Promise<{ slug: string; dbName: string }> {
    if (session.workspace?.slug === slug && this.now() < session.expiresAt - REFRESH_MARGIN_MS) return session.workspace;
    const item = (await this.listWorkspaces(ctx, session)).workspaces.find(w => w.slug === slug);
    if (!item) throw new CompanyError('not_found', `${session.username} is not a member of workspace ${slug}`);
    await this.switchTo(ctx, session, item);
    return session.workspace!;
  }

  private async workspaceEnsure(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.customerSession(ctx, args);
    const slug = slugOf(args);
    const listing = await this.listWorkspaces(ctx, session);
    const existing = listing.workspaces.find(w => w.slug === slug);
    if (existing) {
      await this.switchTo(ctx, session, existing);
      return {
        value: { slug, name: existing.name, dbName: existing.dbName, role: existing.role, created: false },
        audit: { action: 'ops_workspace_use', evidence: `${session.username} 进入已有 workspace ${slug}` },
      };
    }
    if (args.name === undefined) throw new CompanyError('not_found', `workspace ${slug} does not exist for ${session.username}; pass name to create it`);
    const name = text(args, 'name', 80);
    const { workspacePrefix } = ctx.cfg.accounts;
    if (!slug.startsWith(workspacePrefix)) throw invalid(`new workspace slugs must start with ${workspacePrefix}`);
    if (!listing.canCreate) throw new CompanyError('forbidden', `${session.username} may not create workspaces`);
    const used = await this.deps.core.opsCount(ctx.scope.project, 'ops_workspace_create', DAY_SECONDS);
    if (used >= ctx.cfg.limits.workspacesPerDay) throw new CompanyError('limit_reached', `workspace creation limit reached (${ctx.cfg.limits.workspacesPerDay} per day); reuse an existing one`);
    const res = await this.product(ctx, session, 'POST', '/api/workspaces', { name, slug }).catch((error: unknown) => {
      throw error instanceof ProductUnreachable ? unfinishedCreation(slug, error.message) : error;
    });
    if (res.status >= 500) throw unfinishedCreation(slug, `HTTP ${res.status} ${errorCode(res.body)}`);
    if (res.status === 409) {
      throw new CompanyError('conflict', `creating workspace ${slug} failed: HTTP 409 ${errorCode(res.body)}; the slug belongs to another account, or an earlier creation of it just finished: call ops_workspace_ensure again, and take a different slug only if it is still not listed for ${session.username}`);
    }
    if (!res.ok) throw productFailure(`creating workspace ${slug}`, res, { 403: 'forbidden', 400: 'invalid' });
    const created = (res.body ?? {}) as { slug?: string; dbName?: string };
    if (typeof created.dbName !== 'string') throw new CompanyError('upstream_error', 'workspace was created but the product returned no database name');
    session.workspace = { slug, dbName: created.dbName };
    return {
      value: { slug, name, dbName: created.dbName, role: 'admin', created: true },
      audit: { action: 'ops_workspace_create', evidence: `${session.username} 创建 workspace ${slug}（${name}）` },
    };
  }

  // ---------- members ----------

  private async members(ctx: Ctx, session: OpsSession, slug: string): Promise<Array<{ id: string; email?: string; displayName?: string; isAdmin: boolean; joined: boolean }>> {
    const { dbName } = await this.useWorkspace(ctx, session, slug);
    const [rows] = await this.runQuery(ctx, session, dbName,
      "SELECT id, display_name, email, is_admin, subject FROM user WHERE kind = 'human' AND disabled_at = NONE") as [Array<Record<string, unknown>>];
    return (rows ?? []).map(row => ({
      id: plainId(row.id), email: typeof row.email === 'string' ? row.email : undefined,
      displayName: typeof row.display_name === 'string' ? row.display_name : undefined,
      isAdmin: row.is_admin === true, joined: !!row.subject,
    }));
  }

  private async memberList(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.customerSession(ctx, args);
    const slug = slugOf(args);
    return {
      value: { slug, members: await this.members(ctx, session, slug) },
      audit: { action: 'ops_call', evidence: `ops_member_list ${slug}` },
    };
  }

  private async memberAdd(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.customerSession(ctx, args);
    const slug = slugOf(args);
    const alias = canonicalAlias(args.alias);
    const username = accountUsername(alias, ctx.cfg.accounts.prefix);
    const admin = args.admin === true;
    const res = await this.product(ctx, session, 'POST', `/api/workspaces/${slug}/members`, {
      email: accountEmail(username, ctx.cfg.accounts.emailDomain), displayName: username, isAdmin: admin,
    });
    if (!res.ok) throw productFailure(`adding ${username} to ${slug}`, res, { 403: 'forbidden', 404: 'not_found' });
    return {
      value: { slug, alias, username, admin, added: true },
      audit: { action: 'ops_member_add', evidence: `${session.username} 把 ${username} 加入 ${slug}（${admin ? '管理员' : '成员'}）` },
    };
  }

  private async memberRemove(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.customerSession(ctx, args);
    const slug = slugOf(args);
    const alias = canonicalAlias(args.alias);
    const username = accountUsername(alias, ctx.cfg.accounts.prefix);
    const email = accountEmail(username, ctx.cfg.accounts.emailDomain);
    const member = (await this.members(ctx, session, slug)).find(m => m.email?.toLowerCase() === email);
    if (!member) throw new CompanyError('not_found', `${username} is not a member of ${slug}`);
    const res = await this.product(ctx, session, 'DELETE', `/api/workspaces/${slug}/members/${encodeURIComponent(member.id)}`);
    if (!res.ok) throw productFailure(`removing ${username} from ${slug}`, res, { 403: 'forbidden', 404: 'not_found' });
    return {
      value: { slug, alias, username, removed: true },
      audit: { action: 'ops_member_remove', evidence: `${session.username} 把 ${username} 移出 ${slug}` },
    };
  }

  // ---------- generic, session-bound ----------

  private async request(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.session(ctx, args);
    const method = text(args, 'method', 10).toUpperCase();
    const path = text(args, 'path', 2000);
    // Sessions stay in their lane: an operator or ops token only serves the ops surface
    // (/api/ops/* plus /api/content/*, which the product gates on requirePlatformOperator), and a
    // customer token is never sent to ops endpoints at all (the product would answer 401 for the
    // wrong audience; /api/content/* needs no proxy-side block since the same gate covers it).
    const opsPath = /^\/api\/ops(\/|$|\?)/.test(path);
    const contentPath = /^\/api\/content(\/|$|\?)/.test(path);
    if (session.kind !== 'customer' && !opsPath && !contentPath) throw invalid(`an ${session.kind} session can only call /api/ops/* or /api/content/* paths`);
    if (session.kind === 'customer' && opsPath) throw invalid('a customer session cannot call /api/ops/*; call ops_operator_login, or ops_login with audience "ops", for an ops session');
    const res = await this.product(ctx, session, method, path, args.body);
    const known = this.sessions.secrets(ctx.scope.actor.employeeId);
    return {
      value: { status: res.status, ok: res.ok, body: clipJson(redactJson(res.body, known)) },
      audit: { action: 'ops_call', evidence: `${method} ${path.split('?')[0]} → ${res.status}（${session.kind !== 'customer' ? '运营 ' : ''}${session.username}）` },
    };
  }

  private async runQuery(ctx: Ctx, session: OpsSession, database: string, sql: string, vars?: Record<string, unknown>): Promise<unknown[]> {
    if (!ctx.cfg.data) throw new CompanyError('not_configured', 'this environment has no workspace data endpoint configured');
    if (this.now() >= session.expiresAt - REFRESH_MARGIN_MS) await this.reauth(ctx, session);
    return (this.deps.queryAsUser ?? surrealQueryAsUser)({ ...ctx.cfg.data, database, token: session.token, sql, vars });
  }

  private async query(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.customerSession(ctx, args);
    const sql = text(args, 'sql', 20_000);
    if (args.vars !== undefined && (typeof args.vars !== 'object' || args.vars === null || Array.isArray(args.vars))) throw invalid('vars must be an object');
    const workspace = args.slug !== undefined ? await this.useWorkspace(ctx, session, slugOf(args)) : session.workspace;
    if (!workspace) throw invalid('no workspace selected: pass slug, or call ops_workspace_ensure / ops_login with workspace first');
    const results = await this.runQuery(ctx, session, workspace.dbName, sql, args.vars as Record<string, unknown> | undefined);
    const known = this.sessions.secrets(ctx.scope.actor.employeeId);
    return {
      value: { slug: workspace.slug, results: clipJson(redactJson(jsonSafe(results), known)) },
      audit: { action: 'ops_call', evidence: `ops_query ${workspace.slug}（${session.username}）：${sql.replace(/\s+/g, ' ').slice(0, 160)}` },
    };
  }

  private async browserLogin(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.customerSession(ctx, args);
    const spaceId = Number(args.spaceId);
    if (!Number.isInteger(spaceId) || spaceId < 0) throw invalid('spaceId must be the numeric id of your ego-browser task space');
    const page = args.page === undefined ? 'p1' : text(args, 'page', 8);
    if (!/^p\d{1,3}$/.test(page)) throw invalid('page must be a page label such as p1');
    if (this.now() >= session.expiresAt - REFRESH_MARGIN_MS) await this.reauth(ctx, session);
    const product = new URL(ctx.cfg.product.url);
    const health = ctx.row.healthUrl ? new URL(ctx.row.healthUrl) : undefined;
    const probeUrl = health && health.origin === product.origin ? health.toString() : `${product.origin}/health`;
    const landed = await (this.deps.browser ?? egoBrowserInjector)({
      bin: ctx.cfg.browser?.bin, spaceId, page, probeUrl, landingUrl: `${product.origin}/`,
      token: session.token, expiresAt: session.expiresAt,
    });
    return {
      value: { signedInAs: session.username, url: landed.url, title: landed.title },
      audit: { action: 'ops_browser_login', evidence: `ego-browser 任务空间 ${spaceId}/${page} 以 ${session.username} 登录` },
    };
  }
}

function clipJson(value: unknown): unknown {
  const raw = JSON.stringify(value);
  return raw !== undefined && raw.length > MAX_RESULT_CHARS ? { truncated: true, preview: clip(raw, MAX_RESULT_CHARS) } : value;
}
