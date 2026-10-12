import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { OPS_TOOLS, OpsBroker, proofDeliverErrorCode } from '../src/ops/broker.ts';
import { verifyPassword } from '../src/ops/password.ts';
import { brokerConfig, FakeCompany, FakeWorld, OPS_CLIENT, OPS_DIRECT_CLIENT, OPS_DIRECT_REDIRECT, OPS_REDIRECT, OPS_RESOURCE, TENANT } from './support/ops-world.ts';

interface Rig { world: FakeWorld; company: FakeCompany; broker: OpsBroker; qa: string; outputs: unknown[] }

function rig(patch: Record<string, unknown> = {}, hasEnv = true): Rig {
  const world = new FakeWorld();
  const company = new FakeCompany();
  if (hasEnv) company.env('demo', 'production', brokerConfig(patch), { healthUrl: 'https://app.test/health' });
  const broker = new OpsBroker({
    core: company.core, projects: company.projects as never, secretKey: () => Buffer.alloc(32),
    controlEnv: () => ({ cloudflareToken: 'cf-token-value', cloudflareAccountId: 'acct' }),
    fetch: world.fetch, now: world.now, d1: () => world.d1, queryAsUser: world.queryAsUser, browser: world.browser,
    sleep: async (ms) => { world.clock += ms; },
  });
  return { world, company, broker, qa: company.lease('qa-1', 'qa', 'task-1'), outputs: [] };
}

/** Every value returned to the employee is collected so leak checks can scan them all. */
async function call(r: Rig, tool: string, args: Record<string, unknown> = {}, as: { cred?: string; task?: string } = {}) {
  const value = await r.broker.call(as.cred ?? r.qa, as.task ?? 'task-1', tool, args);
  r.outputs.push(value);
  return value as Record<string, any>;
}

const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code: string }; }
  throw new Error('expected the call to fail');
};

const sealedPassword = (r: Rig, alias: string) => r.company.sealed.get(`demo/production/${alias}_PASSWORD`)!;

function expectNoLeaks(r: Rig, extra: string[] = []) {
  const haystack = JSON.stringify([r.outputs, r.company.audits]);
  const secrets = [...r.world.tokens, ...r.company.sealed.values(), 'cf-token-value', ...extra];
  expect(secrets.length).toBeGreaterThan(0);
  for (const secret of secrets) expect(haystack).not.toContain(secret);
}

describe('ops gate', () => {
  test('ops tools are enumerated (proof tools exercised by independent fork suite)', () => {
    expect([...OPS_TOOLS].sort()).toEqual([
      'ops_account_ensure', 'ops_browser_login', 'ops_health', 'ops_idp_admin_request', 'ops_idp_client_info',
      'ops_idp_client_register', 'ops_idp_principal_list', 'ops_idp_principal_mint', 'ops_idp_principal_revoke',
      'ops_idp_provision_rotate',
      'ops_info', 'ops_internal_ai_approval_diagnose', 'ops_internal_ai_deliver', 'ops_internal_ai_prepare', 'ops_internal_ai_prove', 'ops_internal_ai_revoke', 'ops_internal_ai_rotate_key', 'ops_internal_ai_trust',
      'ops_invitation_issue', 'ops_login', 'ops_logout', 'ops_member_add', 'ops_member_list', 'ops_member_remove',
      'ops_operator_login', 'ops_query', 'ops_request', 'ops_supplier_plan_sample', 'ops_workspace_ensure',
    ]);
  });

  test('unknown tools are refused before anything else happens', async () => {
    const r = rig();
    const error = await failure(call(r, 'ops_drop_database'));
    expect(error.code).toBe('invalid');
    expect(r.world.requests).toHaveLength(0);
  });

  test('without the live task lease nothing runs and nothing reaches the services', async () => {
    const r = rig();
    r.company.endLease('qa-1');
    expect((await failure(call(r, 'ops_info'))).code).toBe('forbidden');
    expect((await failure(call(r, 'ops_login', { alias: 'a' }))).code).toBe('forbidden');
    expect(r.world.requests).toHaveLength(0);
    expect(r.company.audits).toHaveLength(0);
  });

  test('the lease is task-bound: another task id is refused', async () => {
    const r = rig();
    expect((await failure(call(r, 'ops_info', {}, { task: 'task-other' }))).code).toBe('forbidden');
  });

  test('a role outside the environment role list is refused', async () => {
    const r = rig();
    const cs = r.company.lease('cs-1', 'cs', 'task-9');
    const error = await failure(call(r, 'ops_info', {}, { cred: cs, task: 'task-9' }));
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('cs');
  });

  test('a project without a broker environment is not configured', async () => {
    const r = rig({}, false);
    expect((await failure(call(r, 'ops_info'))).code).toBe('not_configured');
  });

  test('environments are chosen by name; the default is the only one or production', async () => {
    const r = rig({}, false);
    r.company.env('demo', 'staging', brokerConfig());
    r.company.env('demo', 'preview', brokerConfig());
    expect((await failure(call(r, 'ops_info'))).code).toBe('not_configured');
    expect((await call(r, 'ops_info', { env: 'staging' })).env).toBe('staging');
    expect((await failure(call(r, 'ops_info', { env: 'nope' }))).code).toBe('not_configured');
    expect((await failure(call(r, 'ops_info', { env: 7 }))).code).toBe('invalid');
  });
});

describe('ops info and health', () => {
  test('info lists accounts by alias and never a secret', async () => {
    const r = rig();
    await call(r, 'ops_account_ensure', { alias: 'qa-one' });
    const info = await call(r, 'ops_info');
    expect(info.accounts).toEqual([{ alias: 'QA_ONE', username: 'sck-qa-one' }]);
    expect(info.tools).toEqual([...OPS_TOOLS]);
    expect(info.can).toEqual({ createAccounts: true, queryWorkspaceData: true, browserLogin: true, operatorLogin: false, opsAudienceLogin: false, idpPrincipals: true, idpProvisionRotate: false });
    // Public client metadata is listed for alignment checks; never secret material.
    expect(info.clients).toEqual({ customer: { clientId: 'client-ck-1234', redirectUri: 'https://app.test/auth/callback' } });
    expectNoLeaks(r);
  });

  test('health reports reachability without credentials', async () => {
    const r = rig();
    const health = await call(r, 'ops_health');
    expect(health).toMatchObject({ reachable: true, status: 200, ok: true, body: { ok: true } });
  });
});

describe('ops accounts', () => {
  test('ensure creates the IdP account with a sealed, verifiable password and says nothing secret', async () => {
    const r = rig();
    const result = await call(r, 'ops_account_ensure', { alias: 'qa-one' });
    expect(result).toEqual({ alias: 'QA_ONE', username: 'sck-qa-one', email: 'sck-qa-one@example.test', result: 'created' });
    const password = sealedPassword(r, 'QA_ONE');
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(await verifyPassword(password, r.world.credentialHash('sck-qa-one')!)).toBe(true);
    expect(r.world.user('sck-qa-one')).toMatchObject({ status: 'active', email: 'sck-qa-one@example.test' });
    expect(r.company.audits.map(a => a.action)).toEqual(['ops_account_create']);
    expect(r.company.audits[0]!.evidence).toContain('sck-qa-one');
    // Fixed statements with bound parameters: identity values never appear in the SQL text.
    for (const { sql } of r.world.sql) expect(sql).not.toContain('sck-qa-one');
    expectNoLeaks(r);
  });

  test('ensure is idempotent and quiet, and treats alias spellings as one account', async () => {
    const r = rig();
    await call(r, 'ops_account_ensure', { alias: 'qa-one' });
    const again = await call(r, 'ops_account_ensure', { alias: 'QA_ONE' });
    expect(again.result).toBe('exists');
    expect(r.company.audits.map(a => a.action)).toEqual(['ops_account_create', 'ops_call']);
    expect(r.company.sealed.size).toBe(1);
  });

  test('ensure repairs a credential that drifted out of band', async () => {
    const r = rig();
    await call(r, 'ops_account_ensure', { alias: 'qa-one' });
    const before = sealedPassword(r, 'QA_ONE');
    r.world.corruptCredential('sck-qa-one');
    expect((await call(r, 'ops_account_ensure', { alias: 'qa-one' })).result).toBe('repaired');
    const after = sealedPassword(r, 'QA_ONE');
    expect(after).not.toBe(before);
    expect(await verifyPassword(after, r.world.credentialHash('sck-qa-one')!)).toBe(true);
    expect(r.company.audits.at(-1)!.action).toBe('ops_account_repair');
  });

  test('an email held by another account, or a disabled account, is a conflict', async () => {
    const r = rig();
    r.world.insertUser('someone-else', 'sck-taken@example.test');
    expect((await failure(call(r, 'ops_account_ensure', { alias: 'taken' }))).code).toBe('conflict');
    await call(r, 'ops_account_ensure', { alias: 'frozen' });
    r.world.setStatus('sck-frozen', 'disabled');
    const error = await failure(call(r, 'ops_account_ensure', { alias: 'frozen' }));
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('disabled');
  });

  test('the daily account quota stops runaway creation', async () => {
    const r = rig();
    for (const alias of ['a1', 'a2', 'a3']) await call(r, 'ops_account_ensure', { alias });
    const error = await failure(call(r, 'ops_account_ensure', { alias: 'a4' }));
    expect(error.code).toBe('limit_reached');
    expect(r.world.user('sck-a4')).toBeUndefined();
    expect((await call(r, 'ops_account_ensure', { alias: 'a1' })).result).toBe('exists');
  });

  test('bad aliases are rejected', async () => {
    const r = rig();
    for (const alias of ['', 'bad alias!', '../x', 'a'.repeat(41), 5]) {
      expect((await failure(call(r, 'ops_account_ensure', { alias }))).code).toBe('invalid');
    }
    expect(r.world.sql).toHaveLength(0);
  });

  test('without an IdP database the broker cannot create accounts and says so', async () => {
    const r = rig({ d1: undefined });
    expect((await failure(call(r, 'ops_account_ensure', { alias: 'qa-one' }))).code).toBe('not_configured');
    expect((await call(r, 'ops_info')).can.createAccounts).toBe(false);
  });
});

describe('ops login and sessions', () => {
  test('login creates the account on demand and returns a handle, never a token', async () => {
    const r = rig();
    const login = await call(r, 'ops_login', { alias: 'qa-one' });
    expect(login).toMatchObject({ alias: 'QA_ONE', username: 'sck-qa-one', accountResult: 'created', canCreate: true, workspaces: [] });
    expect(login.session).toMatch(/^s_[0-9a-f]{16}$/);
    expect(r.world.requests.filter(q => q.url.endsWith('/api/auth/token'))).toHaveLength(1);
    expect(r.company.audits.map(a => a.action)).toEqual(['ops_account_create', 'ops_login']);
    expectNoLeaks(r);
  });

  test('a known account logs in without touching the IdP database', async () => {
    const r = rig();
    await call(r, 'ops_login', { alias: 'qa-one' });
    const statements = r.world.sql.length;
    const again = await call(r, 'ops_login', { alias: 'qa-one' });
    expect(again.accountResult).toBeUndefined();
    expect(r.world.sql).toHaveLength(statements);
  });

  test('a drifted password is repaired once and the login still succeeds', async () => {
    const r = rig();
    await call(r, 'ops_account_ensure', { alias: 'qa-one' });
    r.world.corruptCredential('sck-qa-one');
    const login = await call(r, 'ops_login', { alias: 'qa-one' });
    expect(login.accountResult).toBe('repaired');
    expect(login.session).toMatch(/^s_/);
    expectNoLeaks(r);
  });

  test('a rejected login surfaces the IdP reason only, not the password', async () => {
    const r = rig({ d1: undefined });
    r.company.sealed.set('demo/production/GHOST_PASSWORD', 'wrong-password-123');
    const error = await failure(call(r, 'ops_login', { alias: 'ghost' }));
    expect(error.code).toBe('login_failed');
    expect(error.message).toContain('invalid_credentials');
    expect(error.message).not.toContain('wrong-password-123');
    expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_error' });
    expect(r.company.audits.at(-1)!.evidence).not.toContain('wrong-password-123');
  });

  test('sessions belong to one employee; release and logout kill them', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    const other = r.company.lease('qa-2', 'qa', 'task-2');
    const stolen = await failure(call(r, 'ops_request', { session, method: 'GET', path: '/api/session/workspaces' }, { cred: other, task: 'task-2' }));
    expect(stolen.code).toBe('not_found');

    await call(r, 'ops_request', { session, method: 'GET', path: '/api/session/workspaces' });
    r.broker.release('qa-1');
    expect((await failure(call(r, 'ops_request', { session, method: 'GET', path: '/api/session/workspaces' }))).code).toBe('not_found');

    const second = await call(r, 'ops_login', { alias: 'qa-one' });
    expect(await call(r, 'ops_logout', { session: second.session })).toEqual({ closed: true });
    expect((await failure(call(r, 'ops_logout', { session: second.session }))).code).toBe('not_found');
  });

  test('login can enter a workspace the account belongs to, and refuses one it does not', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    await call(r, 'ops_workspace_ensure', { session, slug: 'sck-demo', name: 'Demo' });
    const again = await call(r, 'ops_login', { alias: 'qa-one', workspace: 'sck-demo' });
    expect(again.workspace).toEqual({ slug: 'sck-demo', dbName: 'ws_sck_demo' });
    expect(again.workspaces).toEqual([{ slug: 'sck-demo', name: 'Demo', role: 'admin' }]);
    expect((await failure(call(r, 'ops_login', { alias: 'qa-one', workspace: 'sck-nope' }))).code).toBe('not_found');
  });

  test('tokens are refreshed before expiry and after a 401, keeping the workspace scope', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    await call(r, 'ops_workspace_ensure', { session, slug: 'sck-demo', name: 'Demo' });
    const exchanges = () => r.world.requests.filter(q => q.url.endsWith('/api/auth/token')).length;
    const before = exchanges();

    r.world.advance(14.5 * 60_000); // inside the refresh margin: proactive login
    expect((await call(r, 'ops_query', { session, sql: 'SELECT 1' })).slug).toBe('sck-demo');
    expect(exchanges()).toBe(before + 1);

    r.world.expireTokens(); // token dies early: 401, re-login, retry
    expect((await call(r, 'ops_request', { session, method: 'GET', path: '/api/session/workspaces' })).status).toBe(200);
    expect(exchanges()).toBe(before + 2);
    expect((await call(r, 'ops_query', { session, sql: 'SELECT 1' })).slug).toBe('sck-demo');
    expectNoLeaks(r);
  });
});

describe('ops workspaces and members', () => {
  test('ensure creates once, reuses afterwards, and keeps to the naming convention', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    expect(await call(r, 'ops_workspace_ensure', { session, slug: 'sck-demo', name: 'Demo' }))
      .toEqual({ slug: 'sck-demo', name: 'Demo', dbName: 'ws_sck_demo', role: 'admin', created: true });
    expect(await call(r, 'ops_workspace_ensure', { session, slug: 'sck-demo' }))
      .toMatchObject({ slug: 'sck-demo', created: false, role: 'admin' });
    expect(r.company.audits.map(a => a.action)).toContain('ops_workspace_create');
    expect(r.company.audits.map(a => a.action)).toContain('ops_workspace_use');

    expect((await failure(call(r, 'ops_workspace_ensure', { session, slug: 'acme', name: 'Acme' }))).code).toBe('invalid');
    expect((await failure(call(r, 'ops_workspace_ensure', { session, slug: 'Bad_Slug', name: 'x' }))).code).toBe('invalid');
    expect((await failure(call(r, 'ops_workspace_ensure', { session, slug: 'sck-missing' }))).code).toBe('not_found');
  });

  test('the daily workspace quota and the product permission are both enforced', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    await call(r, 'ops_workspace_ensure', { session, slug: 'sck-one', name: 'One' });
    await call(r, 'ops_workspace_ensure', { session, slug: 'sck-two', name: 'Two' });
    const limited = await failure(call(r, 'ops_workspace_ensure', { session, slug: 'sck-three', name: 'Three' }));
    expect(limited.code).toBe('limit_reached');
    expect(r.world.workspaces.has('sck-three')).toBe(false);

    const denied = rig();
    denied.world.canCreate = false;
    const login = await call(denied, 'ops_login', { alias: 'qa-one' });
    expect((await failure(call(denied, 'ops_workspace_ensure', { session: login.session, slug: 'sck-one', name: 'One' }))).code).toBe('forbidden');
  });

  test('add, list and remove members by alias, with the join state visible', async () => {
    const r = rig();
    const admin = await call(r, 'ops_login', { alias: 'owner' });
    await call(r, 'ops_workspace_ensure', { session: admin.session, slug: 'sck-team', name: 'Team' });

    expect(await call(r, 'ops_member_add', { session: admin.session, slug: 'sck-team', alias: 'guest' }))
      .toEqual({ slug: 'sck-team', alias: 'GUEST', username: 'sck-guest', admin: false, added: true });
    const listed = await call(r, 'ops_member_list', { session: admin.session, slug: 'sck-team' });
    expect(listed.members).toEqual([
      expect.objectContaining({ email: 'sck-owner@example.test', isAdmin: true, joined: true }),
      expect.objectContaining({ email: 'sck-guest@example.test', isAdmin: false, joined: false }),
    ]);

    const guest = await call(r, 'ops_login', { alias: 'guest', workspace: 'sck-team' });
    expect(guest.workspace.slug).toBe('sck-team');
    const joined = await call(r, 'ops_member_list', { session: admin.session, slug: 'sck-team' });
    expect(joined.members.find((m: any) => m.email === 'sck-guest@example.test').joined).toBe(true);

    expect(await call(r, 'ops_member_remove', { session: admin.session, slug: 'sck-team', alias: 'guest' }))
      .toMatchObject({ removed: true, username: 'sck-guest' });
    expect((await call(r, 'ops_member_list', { session: admin.session, slug: 'sck-team' })).members).toHaveLength(1);
    expect((await failure(call(r, 'ops_member_remove', { session: admin.session, slug: 'sck-team', alias: 'guest' }))).code).toBe('not_found');
    expect((await failure(call(r, 'ops_login', { alias: 'guest', workspace: 'sck-team' }))).code).toBe('not_found');
    expect(r.company.audits.map(a => a.action)).toEqual(expect.arrayContaining(['ops_member_add', 'ops_member_remove']));
    expectNoLeaks(r);
  });

  test('a non-admin member cannot manage members', async () => {
    const r = rig();
    const admin = await call(r, 'ops_login', { alias: 'owner' });
    await call(r, 'ops_workspace_ensure', { session: admin.session, slug: 'sck-team', name: 'Team' });
    await call(r, 'ops_member_add', { session: admin.session, slug: 'sck-team', alias: 'guest' });
    const guest = await call(r, 'ops_login', { alias: 'guest', workspace: 'sck-team' });
    const error = await failure(call(r, 'ops_member_add', { session: guest.session, slug: 'sck-team', alias: 'third' }));
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('member-admin-forbidden');
    expect((await failure(call(r, 'ops_member_add', { session: admin.session, slug: 'sck-ghost', alias: 'third' }))).code).toBe('not_found');
  });
});

describe('ops request, query and browser', () => {
  test('request relays product API calls for the session account and hides tokens', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    const listing = await call(r, 'ops_request', { session, method: 'get', path: '/api/session/workspaces?x=1' });
    expect(listing).toMatchObject({ status: 200, ok: true, body: { canCreate: true, workspaces: [] } });

    const echoed = await call(r, 'ops_request', { session, method: 'GET', path: '/api/echo' });
    expect(echoed).toMatchObject({ status: 400, ok: false });
    const boom = await call(r, 'ops_request', { session, method: 'GET', path: '/api/boom' });
    expect(boom).toMatchObject({ status: 500, ok: false });
    expectNoLeaks(r);
    expect(r.company.audits.at(-1)!.evidence).toContain('/api/boom → 500');
  });

  test('request can only reach product API paths, and never the token proxy', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    const before = r.world.requests.length;
    for (const path of ['/api/auth/token', '/api/auth', 'https://evil.test/api/x', '/other', '/api/../admin', '//evil.test/api/x', '/api/a//b']) {
      expect((await failure(call(r, 'ops_request', { session, method: 'GET', path }))).code).toBe('invalid');
    }
    expect((await failure(call(r, 'ops_request', { session, method: 'TRACE', path: '/api/x' }))).code).toBe('invalid');
    expect(r.world.requests).toHaveLength(before);
  });

  test('a token the product mints is adopted by the session and stripped from the answer', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    await call(r, 'ops_workspace_ensure', { session, slug: 'sck-demo', name: 'Demo' });
    const switched = await call(r, 'ops_request', { session, method: 'POST', path: '/api/session/switch-workspace', body: { workspaceSlug: 'sck-demo' } });
    expect(switched.body).toEqual({ ok: true, expiresIn: 900 });
    expect((await call(r, 'ops_query', { session, sql: 'SELECT 1' })).slug).toBe('sck-demo');
    expectNoLeaks(r);
  });

  test('query runs as the session user inside one workspace and redacts what comes back', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    expect((await failure(call(r, 'ops_query', { session, sql: 'SELECT 1' }))).code).toBe('invalid');
    await call(r, 'ops_workspace_ensure', { session, slug: 'sck-demo', name: 'Demo' });
    const result = await call(r, 'ops_query', { session, sql: 'SELECT * FROM leak' });
    expect(result.slug).toBe('sck-demo');
    expect(JSON.stringify(result)).toContain('"ok":1');
    expect(JSON.stringify(result)).not.toContain('raw-secret-value');
    expectNoLeaks(r, ['raw-secret-value']);

    expect((await failure(call(r, 'ops_query', { session, slug: 'sck-other', sql: 'SELECT 1' }))).code).toBe('not_found');
    expect((await failure(call(r, 'ops_query', { session, sql: 'SELECT 1', vars: [1] }))).code).toBe('invalid');
  });

  test('browser login hands the token to the injector only, and validates the target page', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    const result = await call(r, 'ops_browser_login', { session, spaceId: 3 });
    expect(result).toEqual({ signedInAs: 'sck-qa-one', url: 'https://app.test/', title: 'Fixture App' });
    expect(r.world.browserLogins).toHaveLength(1);
    expect(r.world.browserLogins[0]).toMatchObject({ spaceId: 3, page: 'p1', probeUrl: 'https://app.test/health' });
    // Customer injection is unchanged: the flat oidc.access_token/oidc.exp keys, no User record.
    expect(r.world.browserLogins[0]!.oidcUser).toBeUndefined();
    expect(r.world.tokens).toContain(r.world.browserLogins[0]!.token);
    expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_browser_login' });
    expectNoLeaks(r);

    for (const args of [{ spaceId: -1 }, { spaceId: 'x' }, { spaceId: 1, page: 'main; rm -rf /' }, {}]) {
      expect((await failure(call(r, 'ops_browser_login', { session, ...args }))).code).toBe('invalid');
    }
    expect(r.world.browserLogins).toHaveLength(1);
  });
});

describe('ops on a flaky network', () => {
  const creation = (method: string, url: URL) => method === 'POST' && url.pathname === '/api/workspaces';
  const exchange = (_method: string, url: URL) => url.pathname === '/api/auth/token';
  const loginPage = (_method: string, url: URL) => url.pathname === '/api/login/ck/password';
  const listing = (_method: string, url: URL) => url.pathname === '/api/session/workspaces';
  const creations = (r: Rig) => r.world.requests.filter(q => q.method === 'POST' && q.url.endsWith('/api/workspaces')).length;

  test('a login survives one lost request without leaving an error behind', async () => {
    const r = rig();
    await call(r, 'ops_account_ensure', { alias: 'qa-one' });
    r.world.fault(exchange, 524);
    const login = await call(r, 'ops_login', { alias: 'qa-one' });
    expect(login.session).toMatch(/^s_/);
    expect(r.world.requests.filter(q => q.url.endsWith('/api/auth/token'))).toHaveLength(2);
    expect(r.company.audits.filter(a => a.action === 'ops_error')).toHaveLength(0);
    expectNoLeaks(r);
  });

  test('an IdP outage is upstream trouble and never mistaken for a drifted password', async () => {
    const r = rig();
    await call(r, 'ops_account_ensure', { alias: 'qa-one' });
    const statements = r.world.sql.length;
    r.world.fault(loginPage, 503, { times: 5 });
    const error = await failure(call(r, 'ops_login', { alias: 'qa-one' }));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('gave up after 2 attempts');
    expect(r.world.sql).toHaveLength(statements);
    expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_error' });
  });

  test('an ordinary product call that stalls names its limit and leaves the session usable', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    r.world.fault(listing, 'timeout');
    const error = await failure(call(r, 'ops_request', { session, method: 'GET', path: '/api/session/workspaces' }));
    expect(error).toMatchObject({ code: 'upstream_error', retryable: true });
    expect(error.message).toBe('product request timed out after 30s');
    expect((await call(r, 'ops_request', { session, method: 'GET', path: '/api/session/workspaces' })).status).toBe(200);
  });

  test('a creation the product never answers is settled by repeating it with the same slug', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    r.world.fault(creation, 'timeout', { afterEffect: true }); // the product finishes the job; only the answer is lost
    const error = await failure(call(r, 'ops_workspace_ensure', { session, slug: 'sck-slow', name: 'Slow' }));
    expect(error).toMatchObject({ code: 'upstream_error', retryable: true });
    expect(error.message).toContain('product request timed out after 90s');
    expect(error.message).toContain('same slug');
    expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_error' });
    expect(r.company.audits.map(a => a.action)).not.toContain('ops_workspace_create');

    expect(await call(r, 'ops_workspace_ensure', { session, slug: 'sck-slow', name: 'Slow' }))
      .toMatchObject({ slug: 'sck-slow', created: false, role: 'admin' });
    expect(creations(r)).toBe(1);
    expectNoLeaks(r);
  });

  test('a 5xx or an edge timeout on creation reads the same way, and repeating it finishes the job', async () => {
    for (const status of [502, 503, 524]) {
      const r = rig();
      const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
      r.world.fault(creation, status);
      const error = await failure(call(r, 'ops_workspace_ensure', { session, slug: 'sck-edge', name: 'Edge' }));
      expect(error.code, String(status)).toBe('upstream_error');
      expect(error.message).toContain(`HTTP ${status}`);
      expect(error.message).toContain('same slug');
      expect(await call(r, 'ops_workspace_ensure', { session, slug: 'sck-edge', name: 'Edge' })).toMatchObject({ created: true });
      expect(creations(r)).toBe(2);
    }
  });

  test('a slug conflict names its two possible causes', async () => {
    const r = rig();
    const owner = await call(r, 'ops_login', { alias: 'owner' });
    await call(r, 'ops_workspace_ensure', { session: owner.session, slug: 'sck-taken', name: 'Taken' });
    const other = await call(r, 'ops_login', { alias: 'other' });
    const error = await failure(call(r, 'ops_workspace_ensure', { session: other.session, slug: 'sck-taken', name: 'Mine' }));
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('HTTP 409 workspace-slug-conflict');
    expect(error.message).toContain('another account');
    expect(error.message).toContain('sck-other');
  });
});

describe('ops audit trail', () => {
  test('failures are audited without secrets; plain input mistakes stay quiet', async () => {
    const r = rig();
    const { session } = await call(r, 'ops_login', { alias: 'qa-one' });
    await call(r, 'ops_request', { session, method: 'GET', path: '/api/boom' }); // value, not an error
    await failure(call(r, 'ops_workspace_ensure', { session, slug: 'acme', name: 'x' })); // invalid → quiet
    expect(r.company.audits.filter(a => a.action === 'ops_error')).toHaveLength(0);
    expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_call' });

    const r2 = rig({ d1: undefined });
    r2.company.sealed.set('demo/production/QA_ONE_PASSWORD', 'stale-sealed-pass');
    await failure(call(r2, 'ops_login', { alias: 'qa-one' }));
    expect(r2.company.audits.at(-1)).toMatchObject({ action: 'ops_error' });
    expect(JSON.stringify(r2.company.audits)).not.toContain('stale-sealed-pass');
  });

  test('a whole scenario leaves no token, password or control-plane credential in outputs or audit', async () => {
    const r = rig();
    const owner = await call(r, 'ops_login', { alias: 'owner' });
    await call(r, 'ops_workspace_ensure', { session: owner.session, slug: 'sck-all', name: 'All' });
    await call(r, 'ops_member_add', { session: owner.session, slug: 'sck-all', alias: 'guest' });
    await call(r, 'ops_login', { alias: 'guest', workspace: 'sck-all' });
    await call(r, 'ops_member_list', { session: owner.session, slug: 'sck-all' });
    await call(r, 'ops_query', { session: owner.session, sql: 'SELECT * FROM leak' });
    await call(r, 'ops_request', { session: owner.session, method: 'GET', path: '/api/echo' });
    await call(r, 'ops_browser_login', { session: owner.session, spaceId: 1 });
    await call(r, 'ops_info');
    expect(r.world.tokens.length).toBeGreaterThanOrEqual(4);
    expectNoLeaks(r, ['raw-secret-value']);
  });
});

describe('operator sessions', () => {
  const opsPatch = { ops: { clientId: OPS_CLIENT, redirectUri: OPS_REDIRECT, resource: OPS_RESOURCE } };
  const entitlementPath = '/api/ops/product-entitlements/workspaces/qa-ws';

  /** Creates the account and registers it as an active platform operator (like an IdP subject row + capability rows). */
  const opsUser = async (r: Rig, alias: string, caps: string[] = ['quota.read']): Promise<string> => {
    await call(r, 'ops_account_ensure', { alias });
    const user = r.world.user(`sck-${alias.toLowerCase().replaceAll('_', '-')}`)!;
    r.world.operatorCaps.set(user.id, caps);
    return user.id;
  };

  test('an operator login rides the ops OIDC client and the session serves ops endpoints', async () => {
    const r = rig(opsPatch);
    const subject = await opsUser(r, 'qa-ops');
    const login = await call(r, 'ops_operator_login', { alias: 'qa-ops' });
    expect(login).toMatchObject({ kind: 'operator', alias: 'QA_OPS', username: 'sck-qa-ops', operator: { subject, capabilities: ['quota.read'] } });

    // The authorize hit the ops client with RFC 8707 resource, never the customer audience.
    const authorize = r.world.requests.map(x => new URL(x.url)).find(u => u.pathname === '/t/ck/authorize')!;
    expect(authorize.searchParams.get('client_id')).toBe(OPS_CLIENT);
    expect(authorize.searchParams.get('resource')).toBe(OPS_RESOURCE);
    expect(authorize.searchParams.get('redirect_uri')).toBe(OPS_REDIRECT);
    expect(authorize.searchParams.get('audience')).toBeNull();
    // The DCR'd operator client carries consent_policy `require`: the login parked on the consent
    // page and the broker approved it with the password response's `user_session` cookie.
    expect(r.world.requests.filter(x => x.method === 'POST' && x.url.startsWith('https://auth.test/api/consent/'))).toHaveLength(1);
    // The code was redeemed at the public ops token endpoint; the confidential proxy was not used.
    expect(r.world.requests.filter(x => x.url.endsWith('/api/auth/ops/token'))).toHaveLength(1);
    expect(r.world.requests.filter(x => x.url.endsWith('/api/auth/token'))).toHaveLength(0);
    // And the login finished with a live operator check.
    expect(r.world.requests.filter(x => x.url.includes('/api/ops/quota/context'))).toHaveLength(1);

    const res = await call(r, 'ops_request', { session: login.session, method: 'GET', path: entitlementPath });
    expect(res).toMatchObject({ status: 200, ok: true, body: { slug: 'qa-ws', entitlement: { revision: 3 } } });
    expect(r.company.audits.map(a => a.action)).toEqual(['ops_account_create', 'ops_operator_login', 'ops_call']);
    expect(r.company.audits.at(-1)!.evidence).toContain('运营 sck-qa-ops');
    expectNoLeaks(r);
  });

  test('an IdP consent denial fails the operator login as access_denied', async () => {
    const r = rig(opsPatch);
    await opsUser(r, 'qa-ops');
    r.world.denyConsents = true;
    const error = await failure(call(r, 'ops_operator_login', { alias: 'qa-ops' }));
    expect(error.code).toBe('login_failed');
    expect(error.message).toContain('access_denied');
    // The broker did POST the approval; the IdP's deny redirect carried the error, and no token was minted.
    expect(r.world.requests.filter(x => x.url.includes('/api/consent/'))).toHaveLength(1);
    expect(r.world.requests.filter(x => x.url.includes('/api/auth/ops/token'))).toHaveLength(0);
    expectNoLeaks(r);
  });

  test('a consent hop without the login session cookie is refused and leaks nothing', async () => {
    const r = rig(opsPatch);
    await opsUser(r, 'qa-ops');
    r.world.omitSessionCookie = true;
    const error = await failure(call(r, 'ops_operator_login', { alias: 'qa-ops' }));
    expect(error.code).toBe('login_failed');
    expect(error.message).toContain('invalid_consent_challenge');
    expect(error.message).not.toContain('session-');
    expect(r.world.requests.filter(x => x.url.includes('/api/consent/'))).toHaveLength(1);
    expect(r.world.requests.filter(x => x.url.includes('/api/auth/ops/token'))).toHaveLength(0);
    expectNoLeaks(r);
  });

  test('a consent challenge on the customer client is refused outright, never approved', async () => {
    const r = rig();
    await call(r, 'ops_account_ensure', { alias: 'qa-one' });
    r.world.consentClients.add('client-ck-1234');
    const error = await failure(call(r, 'ops_login', { alias: 'qa-one' }));
    expect(error.code).toBe('login_failed');
    expect(error.message).toContain('consent');
    expect(r.world.requests.filter(x => x.url.includes('/api/consent/'))).toHaveLength(0);
    expectNoLeaks(r);
  });

  test('a missing ops config fails closed before any network call', async () => {
    const r = rig();
    const error = await failure(call(r, 'ops_operator_login', { alias: 'qa-ops' }));
    expect(error.code).toBe('not_configured');
    expect(r.world.requests).toHaveLength(0);
    expect((await call(rig(opsPatch), 'ops_info')).can).toMatchObject({ operatorLogin: true });
  });

  test('a broker client id that is not the registered console client fails at authorize', async () => {
    // The production failure shape: the authorize URL carried a client the IdP never registered
    // (or the proxy hard-binding would override). No retry, no consent hop, no token minted.
    const r = rig({ ops: { clientId: 'ops-client-WRONG', redirectUri: OPS_REDIRECT, resource: OPS_RESOURCE } });
    await opsUser(r, 'qa-ops');
    const error = await failure(call(r, 'ops_operator_login', { alias: 'qa-ops' }));
    expect(error.code).toBe('login_failed');
    expect(error.message).toContain('HTTP 400');
    expect(r.world.requests.filter(x => x.url.includes('/api/auth/ops/token'))).toHaveLength(0);
    expect(r.world.requests.filter(x => x.url.includes('/api/consent/'))).toHaveLength(0);
    expectNoLeaks(r);
  });

  test('the operator client id travels on authorize and token exchange exactly as configured', async () => {
    const r = rig(opsPatch);
    await opsUser(r, 'qa-ops');
    const authorize = () => r.world.requests.map(x => new URL(x.url)).find(u => u.pathname === '/t/ck/authorize')!;
    await call(r, 'ops_operator_login', { alias: 'qa-ops' });
    expect(authorize().searchParams.get('client_id')).toBe(OPS_CLIENT);
    const exchange = r.world.requests.find(x => x.url.endsWith('/api/auth/ops/token'))!;
    expect(exchange.method).toBe('POST');
    // PKCE S256 was offered on authorize and proven at exchange (the fake rejects otherwise).
    expect(authorize().searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize().searchParams.get('code_challenge')).toBeTruthy();
  });

  test('an account that is not a platform operator fails the login probe and keeps no session', async () => {
    const r = rig(opsPatch);
    await call(r, 'ops_account_ensure', { alias: 'qa-ops' }); // never registered as an operator
    const error = await failure(call(r, 'ops_operator_login', { alias: 'qa-ops' }));
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('platform-operator-inactive');
    expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_error' });
    expectNoLeaks(r);
  });

  test('a customer session is refused on ops paths; an operator session off them and off every other tool', async () => {
    const r = rig(opsPatch);
    const customer = await call(r, 'ops_login', { alias: 'qa-one' });
    expect(customer.kind).toBe('customer');
    const wrong = await failure(call(r, 'ops_request', { session: customer.session, method: 'GET', path: '/api/ops/quota/context' }));
    expect(wrong.code).toBe('invalid');
    expect(wrong.message).toContain('ops_operator_login');

    await opsUser(r, 'qa-ops');
    const op = await call(r, 'ops_operator_login', { alias: 'qa-ops' });
    expect((await failure(call(r, 'ops_request', { session: op.session, method: 'GET', path: '/api/session/workspaces' }))).code).toBe('invalid');
    // ops_browser_login is intentionally absent: an operator session may inject into /ops/.
    for (const [tool, extra] of [
      ['ops_workspace_ensure', { slug: 'sck-x' }],
      ['ops_member_list', { slug: 'sck-x' }],
      ['ops_member_add', { slug: 'sck-x', alias: 'qa-one' }],
      ['ops_member_remove', { slug: 'sck-x', alias: 'qa-one' }],
      ['ops_query', { sql: 'SELECT 1' }],
    ] as const) {
      const err = await failure(call(r, tool, { session: op.session, ...extra }));
      expect(err.code, tool).toBe('invalid');
      expect(err.message).toContain('operator session');
    }
    // The only /api/ops traffic so far is the login probe; the refusals never reached the product.
    expect(r.world.requests.filter(x => x.url.includes('/api/ops/'))).toHaveLength(1);
    expect(await call(r, 'ops_logout', { session: op.session })).toEqual({ closed: true });
    expectNoLeaks(r);
  });

  test('an operator session reaches /api/content/* but stays off every other path', async () => {
    const r = rig(opsPatch);
    await opsUser(r, 'qa-ops', ['quota.read', 'content.source.manage']);
    const op = await call(r, 'ops_operator_login', { alias: 'qa-ops' });

    const created = await call(r, 'ops_request', {
      session: op.session, method: 'POST', path: '/api/content/sources',
      body: { name: 'qa-synth', license: { url: 'https://example.invalid/lic' } },
    });
    // The fake source endpoint echoes the parsed body back, proving method, path and payload all arrived.
    expect(created).toMatchObject({ status: 201, ok: true, body: { source: { name: 'qa-synth', license: { url: 'https://example.invalid/lic' } } } });
    const posted = r.world.requests.find(x => x.url.endsWith('/api/content/sources'))!;
    expect(posted.method).toBe('POST');

    // The product's own capability gate still applies: without content.source.manage it is a 403.
    const uid = r.world.user('sck-qa-ops')!.id;
    r.world.operatorCaps.set(uid, ['quota.read']);
    const denied = await call(r, 'ops_request', { session: op.session, method: 'POST', path: '/api/content/sources', body: {} });
    expect(denied).toMatchObject({ status: 403, body: { error: { code: 'platform-operator-capability-missing' } } });

    // Anything off /api/ops/* + /api/content/* is still refused at the proxy.
    for (const path of ['/api/chat', '/api/session/workspaces', '/api/contentx/sources', '/api/contentious']) {
      const error = await failure(call(r, 'ops_request', { session: op.session, method: 'GET', path }));
      expect(error.code, path).toBe('invalid');
    }
    expect(r.world.requests.filter(x => x.url.includes('/api/chat') || x.url.includes('/api/session/'))).toHaveLength(0);
    expectNoLeaks(r);
  });

  test('an ops audience session reaches /api/content/*; a customer session is still refused on /api/ops/*', async () => {
    const r = rig({ idp: { issuer: 'https://idp.test/t/ck', clientId: 'client-ck-1234', audience: 'https://auth.test', redirectUri: 'https://app.test/auth/callback', ops: { clientId: OPS_DIRECT_CLIENT, audience: OPS_RESOURCE, redirectUri: OPS_DIRECT_REDIRECT } } });
    await opsUser(r, 'qa-ops', ['content.read']);
    const ops = await call(r, 'ops_login', { alias: 'qa-ops', audience: 'ops' });
    expect(ops.kind).toBe('ops');
    const contract = await call(r, 'ops_request', { session: ops.session, method: 'GET', path: '/api/content/contract' });
    expect(contract).toMatchObject({ status: 200, ok: true });

    const customer = await call(r, 'ops_login', { alias: 'qa-one' });
    const wrong = await failure(call(r, 'ops_request', { session: customer.session, method: 'GET', path: '/api/ops/quota/context' }));
    expect(wrong.code).toBe('invalid');
    expect(wrong.message).toContain('ops_operator_login');
    expectNoLeaks(r);
  });

  test('reauth keeps an operator session on the ops channel', async () => {
    const r = rig(opsPatch);
    await opsUser(r, 'qa-ops');
    const op = await call(r, 'ops_operator_login', { alias: 'qa-ops' });
    r.world.advance(15 * 60_000); // token lifetime elapsed
    const res = await call(r, 'ops_request', { session: op.session, method: 'GET', path: entitlementPath });
    expect(res).toMatchObject({ status: 200, ok: true });
    expect(r.world.requests.filter(x => x.url.endsWith('/api/auth/ops/token'))).toHaveLength(2);
    expect(r.world.requests.filter(x => x.url.endsWith('/api/auth/token'))).toHaveLength(0);
    expectNoLeaks(r);
  });

  test('capabilities are re-read on every call: revoking the operator takes effect immediately', async () => {
    const r = rig(opsPatch);
    const subject = await opsUser(r, 'qa-ops');
    const op = await call(r, 'ops_operator_login', { alias: 'qa-ops' });
    r.world.operatorCaps.set(subject, []);
    const res = await call(r, 'ops_request', { session: op.session, method: 'GET', path: entitlementPath });
    expect(res).toMatchObject({ status: 403, ok: false, body: { error: { code: 'platform-operator-inactive' } } });
    r.world.operatorCaps.set(subject, ['content.read']);
    const denied = await call(r, 'ops_request', { session: op.session, method: 'GET', path: entitlementPath });
    expect(denied).toMatchObject({ status: 403, body: { error: { code: 'platform-operator-capability-missing' } } });
  });

  test('an operator session injects into /ops/ as the console\'s oidc-client-ts User record', async () => {
    const r = rig(opsPatch);
    const subject = await opsUser(r, 'qa-ops');
    const op = await call(r, 'ops_operator_login', { alias: 'qa-ops' });
    const result = await call(r, 'ops_browser_login', { session: op.session, spaceId: 7, page: 'p3' });
    expect(result).toEqual({ signedInAs: 'sck-qa-ops', url: 'https://app.test/ops/', title: 'Fixture App' });

    const login = r.world.browserLogins[0]!;
    expect(login).toMatchObject({ spaceId: 7, page: 'p3', probeUrl: 'https://app.test/health', landingUrl: 'https://app.test/ops/' });
    // The UserManager userStore key is `oidc.user:<authority>:<client_id>` with the issuer's
    // trailing slash stripped — never the customer app's flat oidc.access_token/oidc.exp keys.
    expect(login.oidcUser?.key).toBe(`oidc.user:https://idp.test/t/ck:${OPS_CLIENT}`);
    const record = JSON.parse(login.oidcUser!.value) as Record<string, unknown>;
    expect(record).toMatchObject({
      access_token: login.token, token_type: 'Bearer', scope: 'openid',
      profile: { sub: subject, email: 'sck-qa-ops@example.test' },
    });
    expect(record.expires_at).toBe(Math.floor((r.world.clock + 900_000) / 1000));
    // The operator gate was re-probed before the token was handed to the browser.
    expect(r.world.requests.filter(x => x.url.includes('/api/ops/quota/context'))).toHaveLength(2);
    expect(r.company.audits.at(-1)!.evidence).toContain('/ops/');
    expectNoLeaks(r);
  });

  test('an operator browser login re-probes the gate: revocation refuses and drops the session', async () => {
    const r = rig(opsPatch);
    const subject = await opsUser(r, 'qa-ops');
    const op = await call(r, 'ops_operator_login', { alias: 'qa-ops' });
    r.world.operatorCaps.set(subject, []);
    const error = await failure(call(r, 'ops_browser_login', { session: op.session, spaceId: 1 }));
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('platform-operator-inactive');
    expect(r.world.browserLogins).toHaveLength(0);
    // The dead session is dropped, so a stray retry cannot smuggle a revoked token anywhere.
    expect((await failure(call(r, 'ops_request', { session: op.session, method: 'GET', path: '/api/ops/quota/context' }))).code).toBe('not_found');
    expectNoLeaks(r);
  });

  test('an operator browser login whose token died re-auths on the ops channel first', async () => {
    const r = rig(opsPatch);
    await opsUser(r, 'qa-ops');
    const op = await call(r, 'ops_operator_login', { alias: 'qa-ops' });
    r.world.expireTokens(); // the stored token dies: reauth mints a fresh ops-audience one
    const result = await call(r, 'ops_browser_login', { session: op.session, spaceId: 1 });
    expect(result.signedInAs).toBe('sck-qa-ops');
    // Reauth stayed on the operator channel — a second /api/auth/ops/token, no customer exchange.
    expect(r.world.requests.filter(x => x.url.endsWith('/api/auth/ops/token'))).toHaveLength(2);
    expect(r.world.requests.filter(x => x.url.endsWith('/api/auth/token'))).toHaveLength(0);
    // And the injected record carries the fresh ops-audience token, not the stale one.
    const record = JSON.parse(r.world.browserLogins[0]!.oidcUser!.value) as Record<string, unknown>;
    expect(record.access_token).toBe(r.world.tokens.at(-1));
    expectNoLeaks(r);
  });

  test('a browser login with bad page args never reaches the injector for an operator either', async () => {
    const r = rig(opsPatch);
    await opsUser(r, 'qa-ops');
    const op = await call(r, 'ops_operator_login', { alias: 'qa-ops' });
    for (const args of [{ spaceId: -1 }, { spaceId: 1, page: 'x;rm' }]) {
      expect((await failure(call(r, 'ops_browser_login', { session: op.session, ...args }))).code).toBe('invalid');
    }
    expect(r.world.browserLogins).toHaveLength(0);
    // No re-probe ran for invalid args: validation precedes the operator gate check.
    expect(r.world.requests.filter(x => x.url.includes('/api/ops/quota/context'))).toHaveLength(1);
  });
});

describe('ops audience sessions (ops_login audience:"ops")', () => {
  const idpOps = {
    idp: {
      issuer: 'https://idp.test/t/ck', clientId: 'client-ck-1234', audience: 'https://auth.test', redirectUri: 'https://app.test/auth/callback',
      ops: { clientId: OPS_DIRECT_CLIENT, audience: OPS_RESOURCE, redirectUri: OPS_DIRECT_REDIRECT },
    },
  };
  const idpTokenCalls = (r: Rig) => r.world.requests.filter(q => q.url === 'https://idp.test/t/ck/token');

  /** Ensures + seals the alias through the customer path, then marks its IdP subject an operator. */
  const opsUser = async (r: Rig, alias: string, caps: string[] = ['quota.read']): Promise<string> => {
    await call(r, 'ops_account_ensure', { alias });
    const user = r.world.user(`sck-${alias.toLowerCase().replaceAll('_', '-')}`)!;
    r.world.operatorCaps.set(user.id, caps);
    return user.id;
  };

  test('an ops login redeems the code at the IdP token endpoint and serves ops endpoints', async () => {
    const r = rig(idpOps);
    await opsUser(r, 'qa-ops');
    const login = await call(r, 'ops_login', { alias: 'qa-ops', audience: 'ops' });
    expect(login).toMatchObject({ kind: 'ops', alias: 'QA_OPS', username: 'sck-qa-ops', audience: 'ops' });

    // Authorize ran under the public ops client with RFC 8707 resource, never the customer audience.
    const authorize = r.world.requests.map(x => new URL(x.url)).find(u => u.pathname === '/t/ck/authorize')!;
    expect(authorize.searchParams.get('client_id')).toBe(OPS_DIRECT_CLIENT);
    expect(authorize.searchParams.get('resource')).toBe(OPS_RESOURCE);
    expect(authorize.searchParams.get('redirect_uri')).toBe(OPS_DIRECT_REDIRECT);
    expect(authorize.searchParams.get('audience')).toBeNull();
    // The code went to the IdP's own /token; neither product proxy was touched.
    expect(idpTokenCalls(r)).toHaveLength(1);
    expect(r.world.requests.filter(x => x.url.includes('/api/auth/token') || x.url.includes('/api/auth/ops/token'))).toHaveLength(0);
    // This client is not consent-gated, so no consent hop happens; gated clients are covered below.
    expect(r.world.requests.filter(x => x.method === 'POST' && x.url.startsWith('https://auth.test/api/consent/'))).toHaveLength(0);
    // No workspace listing happens for an ops session.
    expect(r.world.requests.filter(x => x.url.includes('/api/session/'))).toHaveLength(0);
    expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_login' });
    expect(r.company.audits.at(-1)!.evidence).toContain('audience=ops');

    const res = await call(r, 'ops_request', { session: login.session, method: 'GET', path: '/api/ops/quota/context' });
    expect(res).toMatchObject({ status: 200, ok: true });
    expect(r.company.audits.at(-1)!.evidence).toContain('运营 sck-qa-ops');
    expectNoLeaks(r);
  });

  test('a consent challenge on the ops audience client is refused, not approved', async () => {
    const r = rig(idpOps);
    await opsUser(r, 'qa-ops');
    r.world.consentClients.add(OPS_DIRECT_CLIENT);
    const error = await failure(call(r, 'ops_login', { alias: 'qa-ops', audience: 'ops' }));
    expect(error.code).toBe('login_failed');
    expect(error.message).toContain('consent');
    // The refusal happens before any consent POST or token exchange: never auto-approve others' clients.
    expect(r.world.requests.filter(x => x.url.includes('/api/consent/'))).toHaveLength(0);
    expect(idpTokenCalls(r)).toHaveLength(0);
    expectNoLeaks(r);
  });

  test('without idp.ops the login fails closed before any network call', async () => {
    const r = rig();
    const error = await failure(call(r, 'ops_login', { alias: 'qa-ops', audience: 'ops' }));
    expect(error.code).toBe('not_configured');
    expect(r.world.requests).toHaveLength(0);
    expect((await call(rig(idpOps), 'ops_info')).can).toMatchObject({ opsAudienceLogin: true });
  });

  test('an ops login never auto-creates the account: a missing sealed password is not_found', async () => {
    const r = rig(idpOps);
    const error = await failure(call(r, 'ops_login', { alias: 'ghost', audience: 'ops' }));
    expect(error.code).toBe('not_found');
    expect(r.world.user('sck-ghost')).toBeUndefined();
    expect(r.world.requests).toHaveLength(0);
    expect(r.company.audits.map(a => a.action)).not.toContain('ops_account_create');
  });

  test('bad audience values and a workspace target are rejected before any network call', async () => {
    const r = rig(idpOps);
    for (const audience of ['customer', 'bogus', 5]) {
      expect((await failure(call(r, 'ops_login', { alias: 'qa-ops', audience }))).code).toBe('invalid');
    }
    expect((await failure(call(r, 'ops_login', { alias: 'qa-ops', audience: 'ops', workspace: 'sck-x' }))).code).toBe('invalid');
    expect(r.world.requests).toHaveLength(0);
  });

  test('an ops session is refused by workspace, member, query and browser tools and off-ops paths', async () => {
    const r = rig(idpOps);
    await opsUser(r, 'qa-ops');
    const { session } = await call(r, 'ops_login', { alias: 'qa-ops', audience: 'ops' });
    for (const [tool, extra] of [
      ['ops_workspace_ensure', { slug: 'sck-x' }],
      ['ops_member_list', { slug: 'sck-x' }],
      ['ops_member_add', { slug: 'sck-x', alias: 'qa-one' }],
      ['ops_member_remove', { slug: 'sck-x', alias: 'qa-one' }],
      ['ops_query', { sql: 'SELECT 1' }],
      ['ops_browser_login', { spaceId: 1 }],
    ] as const) {
      const err = await failure(call(r, tool, { session, ...extra }));
      expect(err.code, tool).toBe('invalid');
      expect(err.message).toContain('ops session');
    }
    expect((await failure(call(r, 'ops_request', { session, method: 'GET', path: '/api/session/workspaces' }))).code).toBe('invalid');
    // Only the login happened: the refusals never reached the product.
    expect(r.world.requests.filter(x => new URL(x.url).origin === 'https://app.test')).toHaveLength(0);
    expectNoLeaks(r);
  });

  test('reauth keeps an ops session on the direct IdP channel', async () => {
    const r = rig(idpOps);
    await opsUser(r, 'qa-ops');
    const { session } = await call(r, 'ops_login', { alias: 'qa-ops', audience: 'ops' });
    r.world.advance(15 * 60_000); // token lifetime elapsed
    const res = await call(r, 'ops_request', { session, method: 'GET', path: '/api/ops/quota/context' });
    expect(res).toMatchObject({ status: 200, ok: true });
    expect(idpTokenCalls(r)).toHaveLength(2);
    expect(r.world.requests.filter(x => x.url.includes('/api/auth/token') || x.url.includes('/api/auth/ops/token'))).toHaveLength(0);
    expectNoLeaks(r);
  });

  test('a non-operator account can log in but the product still gates every ops call', async () => {
    const r = rig(idpOps);
    await call(r, 'ops_account_ensure', { alias: 'qa-ops' }); // never registered as an operator
    const { session } = await call(r, 'ops_login', { alias: 'qa-ops', audience: 'ops' });
    const res = await call(r, 'ops_request', { session, method: 'GET', path: '/api/ops/quota/context' });
    expect(res).toMatchObject({ status: 403, ok: false, body: { error: { code: 'platform-operator-inactive' } } });
    expectNoLeaks(r);
  });
});

describe('ops_idp_client_register', () => {
  const REDIRECTS = ['https://app.test/ops/auth/callback.html'];

  test('registers a public SPA client row in the IdP database', async () => {
    const r = rig();
    const res = await call(r, 'ops_idp_client_register', {
      client_name: 'sck-ops-console', redirect_uris: REDIRECTS,
      access_token_audience: 'https://app.test/api/ops/mcp',
    });
    expect(res.result).toBe('created');
    expect(res.clientId).toMatch(/^[0-9a-f-]{36}$/);
    const row = r.world.oidcClient('sck-ops-console')!;
    expect(row).toMatchObject({
      tenant_id: TENANT, client_id: res.clientId, client_name: 'sck-ops-console',
      application_type: 'web', client_profile: 'spa', token_endpoint_auth_method: 'none',
      client_secret_hash: null, trust_level: 'first_party_trusted', consent_policy: 'skip',
      access_token_audience: 'https://app.test/api/ops/mcp',
      grant_types: '["authorization_code"]', response_types: '["code"]',
    });
    expect(JSON.parse(String(row.redirect_uris))).toEqual(REDIRECTS);
    expectNoLeaks(r);
  });

  test('a replayed registration returns the existing client_id instead of a second row', async () => {
    const r = rig();
    const args = {
      client_name: 'sck-ops-console', redirect_uris: REDIRECTS,
      access_token_audience: 'https://app.test/api/ops/mcp',
    };
    const first = await call(r, 'ops_idp_client_register', args);
    const again = await call(r, 'ops_idp_client_register', args);
    expect(again).toMatchObject({ clientId: first.clientId, result: 'exists' });
    expect(r.world.oidcClientCount()).toBe(1);
  });

  test('redirect_uris off the product host or off https are refused before any write', async () => {
    const r = rig();
    for (const redirect_uris of [
      ['https://evil.example/callback'],
      ['http://app.test/ops/auth/callback.html'],
      ['app.test/ops/callback.html'],
      ['https://sub.app.test.evil.example/callback'],
    ]) {
      const error = await failure(call(r, 'ops_idp_client_register', {
        client_name: 'sck-ops-console', redirect_uris,
        access_token_audience: 'https://app.test/api/ops/mcp',
      }));
      expect(error.code).toBe('invalid');
    }
    expect(r.world.oidcClientCount()).toBe(0);
  });

  test('an audience off the product host is refused before any write', async () => {
    const r = rig();
    const error = await failure(call(r, 'ops_idp_client_register', {
      client_name: 'sck-ops-console', redirect_uris: REDIRECTS,
      access_token_audience: 'https://attacker.example/api/ops/mcp',
    }));
    expect(error.code).toBe('invalid');
    expect(r.world.oidcClientCount()).toBe(0);
  });
});

describe('ops_idp_client_info', () => {
  const opsPatch = { ops: { clientId: OPS_CLIENT, redirectUri: OPS_REDIRECT, resource: OPS_RESOURCE } };

  test('reports the registered client and its alignment with the broker config', async () => {
    const r = rig(opsPatch);
    r.world.seedOidcClient({ clientId: OPS_CLIENT });
    const info = await call(r, 'ops_idp_client_info', { client_name: 'sck-ops-console' });
    expect(info).toMatchObject({
      clientName: 'sck-ops-console', clientId: OPS_CLIENT, redirectUris: [OPS_REDIRECT],
      accessTokenAudience: OPS_RESOURCE, consentPolicy: 'require', clientProfile: 'spa',
      tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code'], responseTypes: ['code'],
      hasSecret: false,
      alignment: {
        customerClient: false, operatorClient: true, opsAudienceClient: false,
        operatorRedirectRegistered: true, operatorAudienceMatch: true,
      },
    });
    expectNoLeaks(r);
  });

  test('looks up by client_id and flags a drifted redirect or audience', async () => {
    const r = rig(opsPatch);
    r.world.seedOidcClient({ clientId: OPS_CLIENT, redirectUris: ['https://app.test/old/cb'], audience: 'https://app.test/api/ops/old' });
    const info = await call(r, 'ops_idp_client_info', { client_id: OPS_CLIENT });
    expect(info.clientName).toBe('sck-ops-console');
    expect(info.alignment).toMatchObject({ operatorClient: true, operatorRedirectRegistered: false, operatorAudienceMatch: false });
  });

  test('a client other than the configured operator client is flagged as mismatched', async () => {
    const r = rig(opsPatch);
    r.world.seedOidcClient({ clientId: 'ops-client-9999' });
    const info = await call(r, 'ops_idp_client_info', { client_name: 'sck-ops-console' });
    expect(info.alignment).toMatchObject({ operatorClient: false, customerClient: false });
  });

  test('the secret hash is reported as a boolean and never leaves the broker', async () => {
    const r = rig(opsPatch);
    r.world.seedOidcClient({ clientId: OPS_CLIENT, secretHash: 'deadbeef-secret-hash' });
    const info = await call(r, 'ops_idp_client_info', { client_name: 'sck-ops-console' });
    expect(info.hasSecret).toBe(true);
    expect(JSON.stringify(info)).not.toContain('deadbeef-secret-hash');
    expectNoLeaks(r, ['deadbeef-secret-hash']);
  });

  test('unknown clients are not_found; bad args are invalid; nothing reaches the database', async () => {
    const r = rig(opsPatch);
    expect((await failure(call(r, 'ops_idp_client_info', { client_name: 'ghost-client' }))).code).toBe('not_found');
    const sqlCalls = r.world.sql.length;
    for (const args of [{}, { client_name: 'a', client_id: 'b' }, { client_name: 'Bad Name!' }, { client_id: 'x;drop' }]) {
      expect((await failure(call(r, 'ops_idp_client_info', args))).code).toBe('invalid');
    }
    expect(r.world.sql).toHaveLength(sqlCalls);
  });

  test('without an IdP database configured the tool reports not_configured', async () => {
    const r = rig({ ...opsPatch, d1: undefined });
    expect((await failure(call(r, 'ops_idp_client_info', { client_name: 'sck-ops-console' }))).code).toBe('not_configured');
  });
});

describe('ops_idp_principal_mint', () => {
  test('mints a revocable principal row, seals the token, and audits the mint in the IdP', async () => {
    const r = rig();
    const res = await call(r, 'ops_idp_principal_mint', { label: 'qa-verify' });
    expect(res).toMatchObject({ label: 'qa-verify', scopes: ['tenant.read', 'user.read', 'user.provision'], status: 'active' });
    const token = res.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The D1 row mirrors the IdP's own mint: hash only, fixed scopes, ops caller attributed.
    const row = r.world.principal(res.id)!;
    expect(row).toMatchObject({ label: 'qa-verify', status: 'active', revoked_at: null, created_by: 'ops:qa-1' });
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('base64url'));
    expect(JSON.parse(String(row.scopes))).toEqual(['tenant.read', 'user.read', 'user.provision']);

    // The IdP-side compensating audit attributes the mint to the calling employee's machine channel.
    const minted = r.world.auditRows('admin.service_principal.minted');
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ actor_type: 'management_token', actor_id: 'ops:qa-1', target_type: 'service_principal', target_id: res.id });
    expect(JSON.parse(String(minted[0]!.payload))).toMatchObject({ label: 'qa-verify', via: 'ops_broker' });

    // The token is sealed under the principal id so ops_idp_admin_request can resolve it later.
    const sealName = `IDP_SP_${res.id.toUpperCase().replaceAll('-', '_')}`;
    expect(r.company.sealed.get(`demo/production/${sealName}`)).toBe(token);
    expect(JSON.stringify(r.company.sealed.keys())).not.toContain('_PASSWORD');

    // The broker audit names the principal id, never the token; SQL carried the hash only.
    expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_idp_principal_mint' });
    expect(JSON.stringify(r.company.audits)).not.toContain(token);
    for (const { sql } of r.world.sql) expect(sql).not.toContain(token);
  });

  test('sealAs returns the alias seal name and never the token value', async () => {
    const r = rig();
    const res = await call(r, 'ops_idp_principal_mint', { label: 'qa-verify', sealAs: 'qa-verify' });
    expect(res).toMatchObject({ label: 'qa-verify', sealed: 'IDP_SP_QA_VERIFY', status: 'active' });
    expect(res.token).toBeUndefined();
    const token = r.company.sealed.get('demo/production/IDP_SP_QA_VERIFY')!;
    expect(token).toBeTruthy();
    const sealName = `IDP_SP_${res.id.toUpperCase().replaceAll('-', '_')}`;
    expect(r.company.sealed.get(`demo/production/${sealName}`)).toBe(token);
    expect(r.world.principal(res.id)!.token_hash).toBe(createHash('sha256').update(token).digest('base64url'));
    expectNoLeaks(r);
  });

  test('bad arguments are refused before any write', async () => {
    const r = rig();
    for (const args of [{}, { label: '' }, { label: 'x'.repeat(90) }, { label: 'ok', sealAs: 'bad seal!' }]) {
      expect((await failure(call(r, 'ops_idp_principal_mint', args))).code).toBe('invalid');
    }
    expect(r.world.sql).toHaveLength(0);
    expect(r.company.sealed.size).toBe(0);
  });

  test('without an IdP database configured the tool reports not_configured', async () => {
    const r = rig({ d1: undefined });
    expect((await failure(call(r, 'ops_idp_principal_mint', { label: 'x' }))).code).toBe('not_configured');
  });
});

describe('ops_idp_principal_revoke', () => {
  test('revokes once, writes the IdP-side audit row, and stays idempotent', async () => {
    const r = rig();
    const mint = await call(r, 'ops_idp_principal_mint', { label: 'qa-verify', sealAs: 'qa-verify' });
    const res = await call(r, 'ops_idp_principal_revoke', { principalId: mint.id });
    expect(res).toMatchObject({ id: mint.id, status: 'revoked', alreadyRevoked: false });
    expect(res.revokedAt).toBeTruthy();
    expect(r.world.principal(mint.id)).toMatchObject({ status: 'revoked', revoked_at: res.revokedAt });
    const revoked = r.world.auditRows('admin.service_principal.revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ actor_type: 'management_token', actor_id: 'ops:qa-1', target_id: mint.id });
    expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_idp_principal_revoke' });

    const again = await call(r, 'ops_idp_principal_revoke', { principalId: mint.id });
    expect(again).toMatchObject({ alreadyRevoked: true, revokedAt: res.revokedAt });
    expect(r.world.auditRows('admin.service_principal.revoked')).toHaveLength(1);
    expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_call' });
    expectNoLeaks(r);
  });

  test('unknown and malformed ids fail before any write', async () => {
    const r = rig();
    expect((await failure(call(r, 'ops_idp_principal_revoke', { principalId: randomUUID() }))).code).toBe('not_found');
    for (const args of [{}, { principalId: 'x;drop' }]) {
      expect((await failure(call(r, 'ops_idp_principal_revoke', args))).code).toBe('invalid');
    }
  });
});

describe('ops_idp_admin_request', () => {
  const mintSealed = async (r: Rig) =>
    (await call(r, 'ops_idp_principal_mint', { label: 'qa-verify', sealAs: 'qa-verify' })) as { id: string };
  const usersPath = `/admin/tenants/${TENANT}/users`;

  test('relays the sealed token to the scoped routes and resolves the tenant', async () => {
    const r = rig();
    const { id } = await mintSealed(r);
    const tenants = await call(r, 'ops_idp_admin_request', { principalId: id, method: 'GET', path: '/admin/tenants' });
    expect(tenants).toMatchObject({ status: 200, ok: true });
    expect(tenants.body.tenants[0]).toMatchObject({ id: TENANT, slug: 'ck' });
    const sent = r.world.requests.find(q => q.url === 'https://idp.test/admin/tenants')!;
    expect(sent.method).toBe('GET');
    expectNoLeaks(r);
  });

  test('provisions a user, masks the one-time credentials, and attributes the audit to the principal', async () => {
    const r = rig();
    const { id } = await mintSealed(r);
    const created = await call(r, 'ops_idp_admin_request', {
      principalId: id, method: 'POST', path: usersPath,
      body: { email: 'invite-1@example.test', display_name: 'Invite One' },
    });
    expect(created).toMatchObject({ status: 201, ok: true });
    expect(created.body.user).toMatchObject({ email: 'invite-1@example.test', display_name: 'Invite One', status: 'active' });
    // invitation_token and activation_url are usable credentials: masked in the relayed body.
    const text = JSON.stringify(created.body);
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('inv-');
    const provisioned = r.world.auditRows('user.provisioned');
    expect(provisioned.at(-1)).toMatchObject({ actor_type: 'service_principal', actor_id: id, tenant_id: TENANT });

    const again = await call(r, 'ops_idp_admin_request', {
      principalId: id, method: 'POST', path: usersPath,
      body: { email: 'invite-1@example.test', display_name: 'Invite One' },
    });
    expect(again.status).toBe(409);
    expect(r.world.auditRows('user.provision.failed').at(-1)).toMatchObject({ actor_type: 'service_principal', actor_id: id });
    expectNoLeaks(r);
  });

  test('a revoked principal reaches the IdP and is answered 403 without creating users', async () => {
    const r = rig();
    const { id } = await mintSealed(r);
    const before = await call(r, 'ops_idp_admin_request', {
      principalId: id, method: 'POST', path: usersPath,
      body: { email: 'invite-1@example.test', display_name: 'Invite One' },
    });
    expect(before.status).toBe(201);
    await call(r, 'ops_idp_principal_revoke', { principalId: id });
    const after = await call(r, 'ops_idp_admin_request', {
      principalId: id, method: 'POST', path: usersPath,
      body: { email: 'invite-2@example.test', display_name: 'Invite Two' },
    });
    expect(after).toMatchObject({ status: 403, ok: false });
    expect(r.world.sqlite.query('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('invite-2@example.test')).toMatchObject({ n: 0 });
    expect(r.world.auditRows('user.provisioned')).toHaveLength(1);
    expectNoLeaks(r);
  });

  test('only the three scoped routes pass the proxy gate; nothing else reaches the IdP', async () => {
    const r = rig();
    const { id } = await mintSealed(r);
    const before = r.world.requests.length;
    for (const [method, path] of [
      ['GET', `/admin/tenants/${TENANT}`],
      ['GET', '/admin/service-principals'],
      ['POST', '/admin/service-principals'],
      ['GET', '/admin/login'],
      ['POST', '/admin/tenants'],
      ['DELETE', usersPath],
      ['GET', `${usersPath}?email=x`],
      ['GET', '/admin/tenants/../users'],
      ['GET', '/api/tenants'],
      ['GET', '/admin/tenants//users'],
    ] as const) {
      expect((await failure(call(r, 'ops_idp_admin_request', { principalId: id, method, path }))).code, `${method} ${path}`).toBe('invalid');
    }
    expect(r.world.requests).toHaveLength(before);
  });

  test('a principal without a broker-sealed token is not_found', async () => {
    const r = rig();
    r.world.sqlite.run(
      `INSERT INTO admin_service_principals (id, label, token_hash, scopes, status, created_at, revoked_at, created_by)
       VALUES (?, 'foreign', 'hash-of-unknown-token', '["tenant.read"]', 'active', ?, NULL, 'admin_user:owner')`,
      ['11111111-2222-3333-4444-555555555555', new Date().toISOString()]);
    const error = await failure(call(r, 'ops_idp_admin_request', {
      principalId: '11111111-2222-3333-4444-555555555555', method: 'GET', path: '/admin/tenants',
    }));
    expect(error.code).toBe('not_found');
    expect(r.world.requests.filter(q => q.url.includes('/admin/'))).toHaveLength(0);
  });

  test('the IdP verdict for an unsealed-hash principal is surfaced, not hidden', async () => {
    const r = rig();
    // Row exists (so minting side worked) but a different token is sealed — the IdP answers 401.
    const id = randomUUID();
    r.world.sqlite.run(
      `INSERT INTO admin_service_principals (id, label, token_hash, scopes, status, created_at, revoked_at, created_by)
       VALUES (?, 'drifted', 'different-hash', '["tenant.read"]', 'active', ?, NULL, 'ops:other')`,
      [id, new Date().toISOString()]);
    const sealName = `IDP_SP_${id.toUpperCase().replaceAll('-', '_')}`;
    r.company.sealed.set(`demo/production/${sealName}`, 'sealed-but-stale-token');
    const res = await call(r, 'ops_idp_admin_request', { principalId: id, method: 'GET', path: '/admin/tenants' });
    expect(res).toMatchObject({ status: 401, ok: false });
    expectNoLeaks(r, ['sealed-but-stale-token']);
  });
});

describe('ops_idp_principal_list', () => {
  test('列出 principal 元数据（id/label/status），可按 status 过滤，不含 token', async () => {
    const r = rig();
    const a = await call(r, 'ops_idp_principal_mint', { label: 'qa-a', sealAs: 'qa-a' });
    const b = await call(r, 'ops_idp_principal_mint', { label: 'qa-b', sealAs: 'qa-b' });
    await call(r, 'ops_idp_principal_revoke', { principalId: a.id });

    const all = await call(r, 'ops_idp_principal_list', {});
    expect(all.principals).toHaveLength(2);
    expect(all.principals.map((p: { id: string }) => p.id).sort()).toEqual([a.id, b.id].sort());
    const active = await call(r, 'ops_idp_principal_list', { status: 'active' });
    expect(active.principals).toHaveLength(1);
    expect(active.principals[0]).toMatchObject({ id: b.id, label: 'qa-b', status: 'active', createdBy: 'ops:qa-1' });
    expect(JSON.stringify(active)).not.toContain('token_hash');
    expect((await failure(call(r, 'ops_idp_principal_list', { status: 'weird' }))).code).toBe('invalid');
    expectNoLeaks(r);
  });
});

describe('ops_idp_provision_rotate（一键轮换）', () => {
  const opsPatch = { ops: { clientId: OPS_CLIENT, redirectUri: OPS_REDIRECT, resource: OPS_RESOURCE } };
  const opsUser = async (r: Rig, alias: string, caps: string[]) => {
    await call(r, 'ops_account_ensure', { alias });
    const user = r.world.user(`sck-${alias.toLowerCase().replaceAll('_', '-')}`)!;
    r.world.operatorCaps.set(user.id, caps);
    return user.id;
  };
  const opsSession = async (r: Rig, caps = ['quota.read', 'subscription.manage']) => {
    await opsUser(r, 'qa-ops', caps);
    return String((await call(r, 'ops_operator_login', { alias: 'qa-ops' })).session);
  };

  test('一条命令跑完「吊销旧 → 签新 → 注入密封仓 → 双探针验证」，明文不出 broker', async () => {
    const r = rig(opsPatch);
    const old = await call(r, 'ops_idp_principal_mint', { label: 'qa-old', sealAs: 'qa-old' }) as { id: string };
    const session = await opsSession(r);

    const res = await call(r, 'ops_idp_provision_rotate', { session, label: 'sck-provisioner' }) as {
      rotated: boolean; newPrincipal: { id: string; label: string; scopes: string[] };
      revoked: { id: string; alreadyRevoked: boolean };
      product: { rotate: number; statusOk: boolean; source: string; storeEntry: boolean };
      probes: { newToken: { status: number; ok: boolean }; oldToken: { status: number; ok: boolean } };
    };

    // 结果：旧吊销、新签、密封仓生效、双探针符合预期
    expect(res.rotated).toBe(true);
    expect(res.revoked).toMatchObject({ id: old.id, alreadyRevoked: false });
    expect(res.newPrincipal).toMatchObject({ label: 'sck-provisioner', scopes: ['tenant.read', 'user.read', 'user.provision'] });
    expect(res.newPrincipal.id).not.toBe(old.id);
    expect(res.product).toMatchObject({ rotate: 200, statusOk: true, source: 'store', storeEntry: true });
    expect(res.probes.newToken).toMatchObject({ status: 200, ok: true });
    expect(res.probes.oldToken).toMatchObject({ status: 403, ok: false });

    // IdP 侧行状态：旧 revoked + revoked_at；新 active、hash-only
    expect(r.world.principal(old.id)).toMatchObject({ status: 'revoked' });
    expect(String(r.world.principal(old.id)!.revoked_at)).toBeTruthy();
    const newRow = r.world.principal(res.newPrincipal.id)!;
    expect(newRow).toMatchObject({ label: 'sck-provisioner', status: 'active', created_by: 'ops:qa-1' });
    const sealedNew = `demo/production/IDP_SP_${res.newPrincipal.id.toUpperCase().replaceAll('-', '_')}`;
    expect(newRow.token_hash).toBe(createHash('sha256').update(String(r.company.sealed.get(sealedNew))).digest('base64url'));

    // 产品确实收到了 rotate 调用（携带新 token 进密封仓模型）
    const rotateCall = r.world.requests.find(q => q.method === 'POST' && q.url.endsWith('/api/ops/idp-provision-token/rotate'));
    expect(rotateCall).toBeTruthy();
    expect(r.world.liveProvisionToken?.principalId).toBe(res.newPrincipal.id);

    // IdP 审计归因：revoked + minted 均记 management_token/ops:qa-1 且带轮换标记
    const revokedAudit = r.world.auditRows('admin.service_principal.revoked').find(x => x.target_id === old.id);
    expect(revokedAudit).toMatchObject({ actor_type: 'management_token', actor_id: 'ops:qa-1' });
    const mintedAudit = r.world.auditRows('admin.service_principal.minted').find(x => x.target_id === res.newPrincipal.id);
    expect(JSON.parse(String(mintedAudit!.payload))).toMatchObject({ via: 'ops_broker', rotation: true });
    expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_idp_provision_rotate' });

    // 明文泄漏检查：新/旧 token 不出现在返回值、审计、SQL 之外（SQL 只含 hash）
    const newToken = r.company.sealed.get(`demo/production/IDP_SP_${res.newPrincipal.id.toUpperCase().replaceAll('-', '_')}`)!;
    expect(JSON.stringify(r.outputs)).not.toContain(newToken);
    expect(JSON.stringify(r.company.audits)).not.toContain(newToken);
    for (const { sql } of r.world.sql) expect(sql).not.toContain(newToken);
    expectNoLeaks(r);
  });

  test('省略 revokePrincipalId 时恰好一个 active 自动认领；多个则 invalid 并要求显式指定', async () => {
    const r = rig(opsPatch);
    const only = await call(r, 'ops_idp_principal_mint', { label: 'qa-only', sealAs: 'qa-only' }) as { id: string };
    const session = await opsSession(r);
    const res = await call(r, 'ops_idp_provision_rotate', { session }) as { revoked: { id: string } };
    expect(res.revoked.id).toBe(only.id);

    const r2 = rig(opsPatch);
    await call(r2, 'ops_idp_principal_mint', { label: 'a', sealAs: 'a' });
    const second = await call(r2, 'ops_idp_principal_mint', { label: 'b', sealAs: 'b' }) as { id: string };
    const session2 = await opsSession(r2);
    const error = await failure(call(r2, 'ops_idp_provision_rotate', { session: session2 }));
    expect(error.code).toBe('invalid');
    expect(error.message).toContain(second.id);
    // 歧义失败发生在任何写之前
    expect(r2.world.principal(second.id)).toMatchObject({ status: 'active' });
    expect(r2.world.liveProvisionToken).toBeNull();
  });

  test('无 active principal 时等同首次激活（revoked=null）；显式指定已吊销 id 报 alreadyRevoked', async () => {
    const r = rig(opsPatch);
    const session = await opsSession(r);
    const res = await call(r, 'ops_idp_provision_rotate', { session }) as { revoked: null; product: { source: string } };
    expect(res.revoked).toBeNull();
    expect(res.product.source).toBe('store');

    const r2 = rig(opsPatch);
    const dead = await call(r2, 'ops_idp_principal_mint', { label: 'dead', sealAs: 'dead' }) as { id: string };
    await call(r2, 'ops_idp_principal_revoke', { principalId: dead.id });
    const session2 = await opsSession(r2);
    const res2 = await call(r2, 'ops_idp_provision_rotate', { session: session2, revokePrincipalId: dead.id }) as { revoked: { alreadyRevoked: boolean } };
    expect(res2.revoked.alreadyRevoked).toBe(true);
    expect(r2.world.liveProvisionToken?.principalId).not.toBe(dead.id);
  });

  test('revokePrincipalId 指向不存在的 principal → not_found，不产生任何写', async () => {
    const r = rig(opsPatch);
    const session = await opsSession(r);
    const error = await failure(call(r, 'ops_idp_provision_rotate', { session, revokePrincipalId: 'ghost-id' }));
    expect(error.code).toBe('not_found');
    expect(r.world.liveProvisionToken).toBeNull();
  });

  test('客户会话不可用（需运营会话）；rotate 端点失败则补偿吊销新 principal', async () => {
    const r = rig(opsPatch);
    await call(r, 'ops_account_ensure', { alias: 'qa-user' });
    const customer = String((await call(r, 'ops_login', { alias: 'qa-user' })).session);
    const error = await failure(call(r, 'ops_idp_provision_rotate', { session: customer }));
    expect(error.code).toBe('invalid');
    expect(error.message).toContain('ops_operator_login');

    // rotate 返回 400（IdP 探测拒绝）时：新 principal 被补偿吊销，密封仓保持 env 兜底
    const r2 = rig(opsPatch);
    const old2 = await call(r2, 'ops_idp_principal_mint', { label: 'qa-old2', sealAs: 'qa-old2' }) as { id: string };
    const session2 = await opsSession(r2);
    r2.world.fault(
      (method, url) => method === 'POST' && url.pathname === '/api/ops/idp-provision-token/rotate',
      400,
    );
    const error2 = await failure(call(r2, 'ops_idp_provision_rotate', { session: session2 }));
    expect(error2.code).toBe('invalid');
    // 旧已吊销（spec 顺序），新也被补偿吊销——不留任何 active principal
    expect(r2.world.principal(old2.id)).toMatchObject({ status: 'revoked' });
    const actives = r2.world.sqlite.query(`SELECT id FROM admin_service_principals WHERE status = 'active'`).all();
    expect(actives).toHaveLength(0);
    expect(r2.world.liveProvisionToken).toBeNull();
    expectNoLeaks(r2);
  });

  test('产品侧缺 subscription.manage 时 rotate 403 → invalid/forbidden 且补偿吊销', async () => {
    const r = rig(opsPatch);
    const session = await opsSession(r, ['quota.read']); // 没有 subscription.manage
    const error = await failure(call(r, 'ops_idp_provision_rotate', { session }));
    expect(error.code).toBe('forbidden');
    const actives = r.world.sqlite.query(`SELECT id FROM admin_service_principals WHERE status = 'active'`).all();
    expect(actives).toHaveLength(0);
  });
});

describe('ops_invitation_issue（G2 邀请签发 + 老板交接文件）', () => {
  const opsPatch = { ops: { clientId: OPS_CLIENT, redirectUri: OPS_REDIRECT, resource: OPS_RESOURCE } };
  const opsUser = async (r: Rig, alias: string, caps: string[]) => {
    await call(r, 'ops_account_ensure', { alias });
    const user = r.world.user(`sck-${alias.toLowerCase().replaceAll('_', '-')}`)!;
    r.world.operatorCaps.set(user.id, caps);
    return user.id;
  };
  const opsSession = async (r: Rig, caps = ['quota.read', 'subscription.manage']) => {
    await opsUser(r, 'qa-ops', caps);
    return String((await call(r, 'ops_operator_login', { alias: 'qa-ops' })).session);
  };
  const inviteArgs = {
    email: 'lawyer@firm.test', displayName: '张律师', workspaceSlug: 'firm-alpha',
    aiAllowance: { amount: 200, expiresAt: '2026-12-31T23:59:59.000Z' },
    reason: 'G2 试点开通', idempotencyKey: 'invite-key-001',
  };

  test('签发邀请：activation_url 落 handoff 文件（0600）不回显，员工只见指针', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-handoff-'));
    const prev = process.env.SCK_SERVICE_HOME;
    process.env.SCK_SERVICE_HOME = dir;
    try {
      const r = rig(opsPatch);
      const session = await opsSession(r);
      const res = await call(r, 'ops_invitation_issue', { session, ...inviteArgs });

      expect(res).toMatchObject({ status: 201, ok: true });
      const body = res.body as Record<string, any>;
      expect(body.delivery.activationUrl).toBeNull();
      expect(body.user).toMatchObject({ email: 'lawyer@firm.test', outcome: 'created' });
      const handoff = res.handoff as { file: string };
      expect(handoff.file).toContain('/handoff/invite-invite-key-001.txt');

      // 交接文件在本机含完整链接与收件上下文，0600。
      const file = readFileSync(handoff.file, 'utf8');
      const issued = r.world.issuedInvites.get('invite-key-001')!;
      const url = (issued.delivery as Record<string, unknown>).activationUrl as string;
      expect(file).toContain(url);
      expect(file).toContain('lawyer@firm.test');
      expect(file).toContain('firm-alpha');
      expect(statSync(handoff.file).mode & 0o777).toBe(0o600);

      // 员工侧输出与审计不含 URL 明文。
      expectNoLeaks(r, [url]);
      expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_invitation_issue' });
      expect(r.company.audits.at(-1)!.evidence).not.toContain(url);
    } finally {
      if (prev === undefined) delete process.env.SCK_SERVICE_HOME; else process.env.SCK_SERVICE_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('同幂等键重放：无新链接、不写新文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-handoff-'));
    const prev = process.env.SCK_SERVICE_HOME;
    process.env.SCK_SERVICE_HOME = dir;
    try {
      const r = rig(opsPatch);
      const session = await opsSession(r);
      await call(r, 'ops_invitation_issue', { session, ...inviteArgs });
      const replay = await call(r, 'ops_invitation_issue', { session, ...inviteArgs });
      expect(replay).toMatchObject({ status: 200, ok: true });
      expect((replay.body as Record<string, any>).replayed).toBe(true);
      expect(replay.handoff).toBeUndefined();
      expect(readdirSync(join(dir, 'handoff'))).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.SCK_SERVICE_HOME; else process.env.SCK_SERVICE_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('缺 subscription.manage 的运营身份被产品侧 403', async () => {
    const r = rig(opsPatch);
    const session = await opsSession(r, ['quota.read']);
    const error = await failure(call(r, 'ops_invitation_issue', { session, ...inviteArgs }));
    expect(error.code).toBe('forbidden');
  });

  test('异步路径：POST 202 → 轮询 GET 完成 → collect-delivery 一次性收取 → handoff 落盘', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-handoff-'));
    const prev = process.env.SCK_SERVICE_HOME;
    process.env.SCK_SERVICE_HOME = dir;
    try {
      const r = rig(opsPatch);
      r.world.inviteAsyncPolls = 3; // POST 回 202，三次 GET 后 completed
      const session = await opsSession(r);
      const res = await call(r, 'ops_invitation_issue', { session, ...inviteArgs });

      // GET 轮询 + collect-delivery 确实走过
      const inviteCalls = r.world.requests.filter((q) => q.url.includes('/api/ops/invitations'));
      expect(inviteCalls.filter((q) => q.method === 'GET').length).toBeGreaterThanOrEqual(3);
      expect(inviteCalls.some((q) => q.method === 'POST' && q.url.endsWith('/collect-delivery'))).toBe(true);

      const handoff = res.handoff as { file: string };
      const url = r.world.inviteUrls.get('invite-key-001')!;
      const file = readFileSync(handoff.file, 'utf8');
      expect(file).toContain(url);
      // 员工侧响应/审计不回显 URL
      expect(JSON.stringify(res)).not.toContain(url);
      expectNoLeaks(r, [url]);
      // 收取后产品侧不再二次下发
      const row = r.world.issuedInvites.get('invite-key-001')!;
      expect((row.delivery as Record<string, unknown>).pendingCollect).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SCK_SERVICE_HOME; else process.env.SCK_SERVICE_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('僵死续跑：轮询超阈值后同键重发 POST 触发产品侧续跑', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-handoff-'));
    const prev = process.env.SCK_SERVICE_HOME;
    process.env.SCK_SERVICE_HOME = dir;
    try {
      const r = rig(opsPatch);
      r.world.inviteAsyncPolls = 1;
      r.world.inviteNeedsResume = true; // GET 永不推进，须同键重发
      const session = await opsSession(r);
      const res = await call(r, 'ops_invitation_issue', { session, ...inviteArgs });
      expect(r.world.inviteResumeCalls).toBe(1);
      expect(res.handoff).toBeDefined();
      const url = r.world.inviteUrls.get('invite-key-001')!;
      expect(readFileSync((res.handoff as { file: string }).file, 'utf8')).toContain(url);
      expectNoLeaks(r, [url]);
    } finally {
      if (prev === undefined) delete process.env.SCK_SERVICE_HOME; else process.env.SCK_SERVICE_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('产品侧翻 failed：如实报出错误码与原因', async () => {
    const r = rig(opsPatch);
    r.world.inviteAsyncPolls = 1;
    r.world.inviteFailOnComplete = true;
    const session = await opsSession(r);
    const error = await failure(call(r, 'ops_invitation_issue', { session, ...inviteArgs }));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('invite-slug-taken');
    expect(error.message).toContain('invite-key-001');
  });

  test('久不完成：抛带恢复指引的 upstream_error（同键重发继续等）', async () => {
    const r = rig(opsPatch);
    r.world.inviteAsyncPolls = 999; // 单次调用预算内跑不完
    const session = await opsSession(r);
    const error = await failure(call(r, 'ops_invitation_issue', { session, ...inviteArgs }));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('still processing');
    expect(error.message).toContain('invite-key-001');
    // 行仍在 processing——任务未丢
    expect(r.world.issuedInvites.get('invite-key-001')!.status).toBe('processing');
  });

  test('resend:true：断链重签发 → collect 新链接 → 覆写同一 handoff 文件，员工不回显', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-handoff-'));
    const prev = process.env.SCK_SERVICE_HOME;
    process.env.SCK_SERVICE_HOME = dir;
    try {
      const r = rig(opsPatch);
      const session = await opsSession(r);
      await call(r, 'ops_invitation_issue', { session, ...inviteArgs });
      const oldUrl = r.world.inviteUrls.get('invite-key-001')!;

      const res = await call(r, 'ops_invitation_issue', {
        session, idempotencyKey: 'invite-key-001', resend: true,
      });
      expect(res).toMatchObject({ status: 200, ok: true });
      const body = res.body as Record<string, any>;
      expect(body.delivery.activationUrl).toBeNull();
      const handoff = res.handoff as { file: string };
      expect(handoff.file).toContain('/handoff/invite-invite-key-001.txt');
      const file = readFileSync(handoff.file, 'utf8');
      const newUrl = r.world.inviteUrls.get('invite-key-001')!;
      expect(newUrl).not.toBe(oldUrl);
      expect(file).toContain(newUrl);
      expect(file).not.toContain(oldUrl);
      expect(file).toContain('lawyer@firm.test');
      expect(statSync(handoff.file).mode & 0o777).toBe(0o600);
      expect(r.world.inviteResendCalls).toBe(1);
      expect(readdirSync(join(dir, 'handoff'))).toHaveLength(1);
      expectNoLeaks(r, [oldUrl, newUrl]);
      expect(r.company.audits.at(-1)!.evidence).toContain('resend');
    } finally {
      if (prev === undefined) delete process.env.SCK_SERVICE_HOME; else process.env.SCK_SERVICE_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resend 重放：24h 有效期内不重复铸链、不产第二文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-handoff-'));
    const prev = process.env.SCK_SERVICE_HOME;
    process.env.SCK_SERVICE_HOME = dir;
    try {
      const r = rig(opsPatch);
      const session = await opsSession(r);
      await call(r, 'ops_invitation_issue', { session, ...inviteArgs });
      await call(r, 'ops_invitation_issue', { session, idempotencyKey: 'invite-key-001', resend: true });
      const first = readFileSync(join(dir, 'handoff', 'invite-invite-key-001.txt'), 'utf8');

      const replay = await call(r, 'ops_invitation_issue', {
        session, idempotencyKey: 'invite-key-001', resend: true,
      });
      expect(replay).toMatchObject({ status: 200, ok: true });
      expect(replay.handoff).toBeUndefined();
      expect(r.world.inviteResendCalls).toBe(1); // 未再铸链
      expect(readdirSync(join(dir, 'handoff'))).toHaveLength(1);
      expect(readFileSync(join(dir, 'handoff', 'invite-invite-key-001.txt'), 'utf8')).toBe(first);
    } finally {
      if (prev === undefined) delete process.env.SCK_SERVICE_HOME; else process.env.SCK_SERVICE_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resend 错误面：不存在 → not_found；行在 processing → conflict；IdP 已激活 → conflict', async () => {
    const r = rig(opsPatch);
    const session = await opsSession(r);

    const missing = await failure(call(r, 'ops_invitation_issue', {
      session, idempotencyKey: 'no-such-key', resend: true,
    }));
    expect(missing.code).toBe('not_found');

    await call(r, 'ops_invitation_issue', { session, ...inviteArgs });
    r.world.issuedInvites.get('invite-key-001')!.status = 'processing';
    const processing = await failure(call(r, 'ops_invitation_issue', {
      session, idempotencyKey: 'invite-key-001', resend: true,
    }));
    expect(processing.code).toBe('conflict');
    expect(processing.message).toContain('invite-resend-while-processing');

    r.world.issuedInvites.get('invite-key-001')!.status = 'completed';
    r.world.inviteActivatedUsers.add('uid-invite-k'); // uid = `uid-${key.slice(0,8)}`
    const activated = await failure(call(r, 'ops_invitation_issue', {
      session, idempotencyKey: 'invite-key-001', resend: true,
    }));
    expect(activated.code).toBe('conflict');
    expect(activated.message).toContain('invite-already-activated');
  });
});

describe('ops_internal_ai_deliver 产品错误码透传', () => {
  test('仅非 2xx 且严格 {error:{code}} 形态才随结果返回 code', () => {
    const code = (body: unknown, ok = false, status = 422) => proofDeliverErrorCode({ status, ok, body });
    expect(code({ error: { code: 'company-status-unavailable' } })).toBe('company-status-unavailable');
    expect(code({ error: { code: 'company-proof-expired' } })).toBe('company-proof-expired');
    for (const body of [
      { error: { code: 'ab' } }, { error: { code: 'UPPER-CASE' } }, { error: { code: 'has space' } },
      { error: { code: 'a'.repeat(62) } }, { error: { code: 422 } }, { error: { message: 'm' } },
      { error: 'company-status-unavailable' }, { code: 'company-status-unavailable' },
      'unauthorized', null, undefined, 42,
    ]) expect(code(body)).toBeUndefined();
    expect(code({ error: { code: 'company-status-unavailable' } }, true, 200)).toBeUndefined();
  });
});
