import { describe, expect, test } from 'bun:test';
import { OPS_TOOLS, OpsBroker } from '../src/ops/broker.ts';
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
  test('every ops tool is exercised by this suite', () => {
    expect([...OPS_TOOLS].sort()).toEqual([
      'ops_account_ensure', 'ops_browser_login', 'ops_health', 'ops_idp_client_register', 'ops_info', 'ops_login',
      'ops_logout', 'ops_member_add', 'ops_member_list', 'ops_member_remove', 'ops_operator_login', 'ops_query',
      'ops_request', 'ops_workspace_ensure',
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
    expect(info.can).toEqual({ createAccounts: true, queryWorkspaceData: true, browserLogin: true, operatorLogin: false, opsAudienceLogin: false });
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

  test('operator browser injection targets the SPA client and retains workspace isolation after renewal', async () => {
    const r = rig(opsPatch);
    await opsUser(r, 'qa-ops');
    const op = await call(r, 'ops_operator_login', { alias: 'qa-ops' });
    const customer = await call(r, 'ops_login', { alias: 'qa-one' });
    await call(r, 'ops_browser_login', { session: customer.session, spaceId: 3 });
    r.world.advance(15 * 60_000);
    await call(r, 'ops_browser_login', { session: op.session, spaceId: 3 });
    expect(r.world.browserLogins.at(-1)).toMatchObject({
      landingUrl: 'https://app.test/ops/', probeUrl: 'https://app.test/health',
      auth: { kind: 'operator', authority: 'https://idp.test/t/ck', clientId: OPS_CLIENT },
    });
    expect(r.world.browserLogins.at(-1)!.token).not.toBe(r.world.browserLogins[0]!.token);
    expect(r.world.requests.filter(x => x.url.endsWith('/api/auth/ops/token'))).toHaveLength(2);
    expect((await failure(call(r, 'ops_workspace_ensure', { session: op.session, slug: 'sck-forbidden' }))).code).toBe('invalid');
    expect((await failure(call(r, 'ops_query', { session: op.session, sql: 'SELECT 1' }))).code).toBe('invalid');
    expect((await failure(call(r, 'ops_request', { session: op.session, method: 'GET', path: '/api/session/workspaces' }))).code).toBe('invalid');
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

  test('an account that is not a platform operator fails the login probe and keeps no session', async () => {
    const r = rig(opsPatch);
    await call(r, 'ops_account_ensure', { alias: 'qa-ops' }); // never registered as an operator
    const error = await failure(call(r, 'ops_operator_login', { alias: 'qa-ops' }));
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('platform-operator-inactive');
    expect(r.company.audits.at(-1)).toMatchObject({ action: 'ops_error' });
    expectNoLeaks(r);
  });

  test('a customer session is refused on ops paths; an operator session off customer paths and workspace tools', async () => {
    const r = rig(opsPatch);
    const customer = await call(r, 'ops_login', { alias: 'qa-one' });
    expect(customer.kind).toBe('customer');
    const wrong = await failure(call(r, 'ops_request', { session: customer.session, method: 'GET', path: '/api/ops/quota/context' }));
    expect(wrong.code).toBe('invalid');
    expect(wrong.message).toContain('ops_operator_login');

    await opsUser(r, 'qa-ops');
    const op = await call(r, 'ops_operator_login', { alias: 'qa-ops' });
    expect((await failure(call(r, 'ops_request', { session: op.session, method: 'GET', path: '/api/session/workspaces' }))).code).toBe('invalid');
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

  test('ops audience sessions are refused browser injection (operator-only policy); the not_configured guard protects the operator lane', async () => {
    const r = rig({ ...idpOps, ops: { clientId: OPS_CLIENT, redirectUri: OPS_REDIRECT, resource: OPS_RESOURCE } });
    await opsUser(r, 'qa-ops');
    const login = await call(r, 'ops_login', { alias: 'qa-ops', audience: 'ops' });
    const err = await failure(call(r, 'ops_browser_login', { session: login.session, spaceId: 4, page: 'p2' }));
    expect(err.code).toBe('invalid');
    expect(err.message).toContain('operator-only');
    expect(r.world.browserLogins).toHaveLength(0);
    expectNoLeaks(r);
    // broker.ops can vanish between calls (admin project broker rewrite): the operator
    // lane then refuses with not_configured instead of injecting a mis-keyed identity.
    const operator = await call(r, 'ops_operator_login', { alias: 'qa-ops' });
    r.company.envs['demo']![0].broker = brokerConfig(idpOps);
    const missing = await failure(call(r, 'ops_browser_login', { session: operator.session, spaceId: 4 }));
    expect(missing.code).toBe('not_configured');
    expect(r.world.browserLogins).toHaveLength(0);
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
