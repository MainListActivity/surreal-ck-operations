// ops_platform_operator_list: the company-side read-only view of the product's platform operators. These
// cases pin the contract (format_version 1, subject hashes only), the session requirement (operator only),
// the role gate, and the no-write property.
import { expect, test } from 'bun:test';
import { OpsBroker } from '../src/ops/broker.ts';
import type { OpsDeps } from '../src/ops/broker.ts';
import { FakeCompany, FakeWorld, brokerConfig, OPS_CLIENT, OPS_REDIRECT, OPS_RESOURCE } from './support/ops-world.ts';

const OPS_PATCH = { ops: { clientId: OPS_CLIENT, redirectUri: OPS_REDIRECT, resource: OPS_RESOURCE } };

function rig(opts: { deps?: Partial<OpsDeps>; patch?: Record<string, unknown>; intercept?: (input: any, init: any, fallback: (i: any, n?: any) => Promise<Response>) => Promise<Response> } = {}) {
  const world = new FakeWorld();
  const company = new FakeCompany();
  company.env('surreal_ck', 'production', brokerConfig({ ...OPS_PATCH, ...opts.patch }));
  const fetchImpl = opts.intercept
    ? (input: any, init: any) => opts.intercept!(input, init, world.fetch as never)
    : world.fetch;
  const broker = new OpsBroker({
    core: company.core, projects: company.projects as never, secretKey: () => Buffer.alloc(32),
    controlEnv: () => ({ cloudflareToken: '{{SECRET_lp1a2b3c}}', cloudflareAccountId: 'acct' }),
    fetch: fetchImpl as never, now: world.now, sleep: async (ms) => { world.clock += ms; },
    d1: () => world.d1, queryAsUser: world.queryAsUser, browser: world.browser, ...opts.deps,
  });
  const call = async (tool: string, args: Record<string, unknown> = {}, as: { cred?: string; task?: string } = {}) =>
    await broker.call(as.cred ?? company.lease('qa-1', 'qa', 'task-1', 'surreal_ck'), as.task ?? 'task-1', tool, args) as Record<string, any>;
  return { world, company, broker, call };
}

/** Creates an account, marks it an active operator with a read capability, and returns an operator session. */
async function operatorSession(r: ReturnType<typeof rig>, alias = 'qa-ops', caps: string[] = ['quota.read']) {
  await r.call('ops_account_ensure', { alias });
  r.world.operatorCaps.set(r.world.user(`sck-${alias.toLowerCase().replaceAll('_', '-')}`)!.id, caps);
  return await r.call('ops_operator_login', { alias });
}

const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code: string }; }
  throw new Error('expected the call to fail');
};

test('an operator session lists the product operators with hashed subjects and one current row', async () => {
  const r = rig();
  const login = await operatorSession(r);
  const view = await r.call('ops_platform_operator_list', { session: login.session });
  expect(view.format_version).toBe(1);
  expect(view.operators).toHaveLength(3);
  for (const operator of view.operators) {
    expect(Object.keys(operator).sort()).toEqual(['capabilities', 'isCurrent', 'kind', 'status', 'subject_hash']);
    expect(operator.subject_hash).toMatch(/^sha256:[a-f0-9]{12}$/);
  }
  expect(view.operators.filter((o: { isCurrent: boolean }) => o.isCurrent)).toHaveLength(1);
  expect(view.operators.map((o: { status: string }) => o.status).sort()).toEqual(['active', 'active', 'disabled']);
});

test('the response never carries the caller subject or any email', async () => {
  const r = rig();
  const login = await operatorSession(r);
  const subject = r.world.user('sck-qa-ops')!.id;
  const view = await r.call('ops_platform_operator_list', { session: login.session });
  const text = JSON.stringify(view);
  expect(text).not.toContain(subject);
  expect(text).not.toContain('synthetic-second-operator');
  expect(text).not.toContain('@');
});

test('a customer session is refused: the list needs an operator session', async () => {
  const r = rig();
  await r.call('ops_account_ensure', { alias: 'owner' });
  const login = await r.call('ops_login', { alias: 'owner' });
  const error = await failure(r.call('ops_platform_operator_list', { session: login.session }));
  expect(error.code).toBe('invalid');
});

test('a role outside gm/engineering/product/qa is refused', async () => {
  const r = rig({ patch: { roles: ['qa', 'engineering', 'owner', 'product', 'ai-content'] } });
  const login = await operatorSession(r, 'ai-ops');
  const credential = r.company.lease('ai-1', 'ai-content', 'task-1', 'surreal_ck');
  const error = await failure(r.call('ops_platform_operator_list', { session: login.session }, { cred: credential }));
  expect(error.code).toBe('forbidden');
});

test('unknown arguments are refused and no request is made', async () => {
  const r = rig();
  const login = await operatorSession(r);
  const before = r.world.requests.length;
  const error = await failure(r.call('ops_platform_operator_list', { session: login.session, alias: 'x' }));
  expect(error.code).toBe('invalid');
  expect(r.world.requests.length).toBe(before);
});

test('a product response with extra PII fields is refused instead of passed through', async () => {
  const r = rig({
    intercept: async (input, init, fallback) => {
      if (String(input).endsWith('/api/ops/platform-operators')) {
        return Response.json({
          format_version: 1,
          operators: [{ subject_hash: `sha256:${'a'.repeat(12)}`, kind: 'human', status: 'active', capabilities: ['quota.read'], isCurrent: true, subject: 'person@example.test' }],
        });
      }
      return fallback(input, init);
    },
  });
  const login = await operatorSession(r);
  const error = await failure(r.call('ops_platform_operator_list', { session: login.session }));
  expect(error.code).toBe('upstream_error');
});

test('an upstream failure is surfaced, not guessed', async () => {
  const r = rig({ intercept: async (input, init, fallback) =>
    String(input).endsWith('/api/ops/platform-operators') ? Response.json({ error: 'nope' }, { status: 503 }) : fallback(input, init) });
  const login = await operatorSession(r);
  const error = await failure(r.call('ops_platform_operator_list', { session: login.session }));
  expect(error.code).toBe('upstream_error');
});

test('the call writes nothing', async () => {
  const r = rig();
  const login = await operatorSession(r);
  const writes = () => r.world.sql.filter(row => /^\s*(INSERT|UPDATE|DELETE|CREATE|DEFINE|REMOVE)\b/i.test(row.sql)).length;
  const before = writes();
  await r.call('ops_platform_operator_list', { session: login.session });
  expect(writes()).toBe(before);
});
