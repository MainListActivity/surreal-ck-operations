// ops_product_pulse: one fixed event on one UTC day from the product's aggregated funnel summary (CK #258).
// These cases pin the projection contract (only validated state, public aggregates and the unknown coverage
// marker), the distinct outcomes (empty / suppressed / coverage unknown / authorization failure), the
// operator-session requirement, the project/environment and role gates, and the no-write property.
import { expect, test } from 'bun:test';
import { OpsBroker } from '../src/ops/broker.ts';
import type { OpsDeps } from '../src/ops/broker.ts';
import { FakeCompany, FakeWorld, brokerConfig, OPS_CLIENT, OPS_REDIRECT, OPS_RESOURCE } from './support/ops-world.ts';

const OPS_PATCH = { ops: { clientId: OPS_CLIENT, redirectUri: OPS_REDIRECT, resource: OPS_RESOURCE } };
const EVENT = 'first_login';
const DAY = '2026-11-17';

function rig(opts: { deps?: Partial<OpsDeps>; patch?: Record<string, unknown>; withDemo?: boolean } = {}) {
  const world = new FakeWorld();
  const company = new FakeCompany();
  company.env('surreal_ck', 'production', brokerConfig({ ...OPS_PATCH, ...opts.patch }));
  if (opts.withDemo) company.env('demo', 'production', brokerConfig({ ...OPS_PATCH, ...opts.patch }));
  const broker = new OpsBroker({
    core: company.core, projects: company.projects as never, secretKey: () => Buffer.alloc(32),
    controlEnv: () => ({ cloudflareToken: 'cf-token-value', cloudflareAccountId: 'acct' }),
    fetch: world.fetch, now: world.now, sleep: async (ms) => { world.clock += ms; },
    d1: () => world.d1, queryAsUser: world.queryAsUser, browser: world.browser, ...opts.deps,
  } as OpsDeps);
  const call = async (tool: string, args: Record<string, unknown> = {}, as: { cred?: string; task?: string; project?: string } = {}) =>
    await broker.call(as.cred ?? company.lease('qa-1', 'qa', 'task-1', as.project ?? 'surreal_ck'), as.task ?? 'task-1', tool, args) as Record<string, any>;
  return { world, company, broker, call };
}

/** Creates an account, marks it an active operator with funnel.read, and returns an operator session. */
async function operatorSession(r: ReturnType<typeof rig>, alias = 'qa-ops', caps: string[] = ['funnel.read']) {
  await r.call('ops_account_ensure', { alias });
  r.world.operatorCaps.set(r.world.user(`sck-${alias.toLowerCase().replaceAll('_', '-')}`)!.id, caps);
  return await r.call('ops_operator_login', { alias });
}

const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code: string; retryable?: boolean }; }
  throw new Error('expected the call to fail');
};

const summary = (patch: Record<string, unknown> = {}) => ({
  event: EVENT, day: DAY, state: 'reported', totalCount: 41, workspaceCount: 7,
  thresholds: { minTotalCount: 5, minWorkspaceCount: 3 },
  coverage: { state: 'unknown', complete: false, reason: 'no_collection_coverage_signal', source: 'funnel_event_count' },
  ...patch,
});

test('a reported summary projects only the validated state, public aggregates, thresholds and coverage', async () => {
  const r = rig();
  r.world.funnelSummary.aggregate = { totalCount: 41, workspaceCount: 7 };
  const login = await operatorSession(r);
  const view = await r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY });
  expect(view).toEqual({
    event: EVENT, day: DAY, state: 'reported', totalCount: 41, workspaceCount: 7,
    thresholds: { minTotalCount: 5, minWorkspaceCount: 3 },
    coverage: { state: 'unknown', complete: false, reason: 'no_collection_coverage_signal', source: 'funnel_event_count' },
    limits: { readOnly: true, rowLevel: false, singleEvent: true, singleUtcDay: true },
  });
  // Fixed endpoint and exactly the two declared query parameters: no caller-supplied filter reaches the product.
  const sent = r.world.requests.filter(item => item.url.includes('/api/ops/funnel-summary'));
  expect(sent).toHaveLength(1);
  expect(new URL(sent[0]!.url).searchParams.toString()).toBe(`event=${EVENT}&day=${DAY}`);
  expect(r.world.funnelSummary.calls).toEqual([{ event: EVENT, day: DAY, keys: ['event', 'day'] }]);
  // No row-level endpoint, no session handle.
  expect(r.world.requests.some(item => item.url.includes('/api/ops/funnel-counts'))).toBe(false);
  expect(JSON.stringify(view)).not.toContain(login.session);
});

test('a low-sample window is suppressed and carries no precise count', async () => {
  const r = rig();
  r.world.funnelSummary.aggregate = { totalCount: 2, workspaceCount: 2 };
  const login = await operatorSession(r);
  const view = await r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY });
  expect(view.state).toBe('suppressed');
  expect(view.totalCount).toBeNull();
  expect(view.workspaceCount).toBeNull();
  expect(JSON.stringify(view)).not.toContain('"totalCount":2');
  expect(JSON.stringify(view)).not.toContain('"workspaceCount":2');
});

test('an empty window is distinct from a suppressed one', async () => {
  const r = rig();
  r.world.funnelSummary.aggregate = { totalCount: 0, workspaceCount: 0 };
  const login = await operatorSession(r);
  const view = await r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY });
  expect(view.state).toBe('empty');
  expect(view.totalCount).toBe(0);
  expect(view.workspaceCount).toBe(0);
  expect(view.coverage.state).toBe('unknown');
});

test('missing funnel.read is an authorization failure, not an empty window', async () => {
  const r = rig();
  const login = await operatorSession(r, 'qa-ops', ['quota.read']);
  const error = await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }));
  expect(error.code).toBe('forbidden');
  expect(error.message).toContain('funnel.read');
  // The product's body is never relayed.
  expect(error.message).not.toContain('platform-operator-capability-missing');
});

test('a rejected operator session is login_failed, distinct from missing capability', async () => {
  const r = rig();
  r.world.funnelSummary.status = 401;
  const login = await operatorSession(r);
  const error = await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }));
  expect(error.code).toBe('login_failed');
  expect(error.retryable).toBe(false);
});

test('a customer session is refused: the pulse needs an operator session', async () => {
  const r = rig();
  await r.call('ops_account_ensure', { alias: 'owner' });
  const login = await r.call('ops_login', { alias: 'owner' });
  const error = await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }));
  expect(error.code).toBe('invalid');
});

test('without the live task lease nothing runs and no request reaches the product', async () => {
  const r = rig();
  const login = await operatorSession(r);
  const credential = r.company.lease('qa-1', 'qa', 'task-1', 'surreal_ck');
  r.company.endLease('qa-1');
  expect((await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }, { cred: credential }))).code).toBe('forbidden');
  expect(r.world.requests.some(item => item.url.includes('/api/ops/funnel-summary'))).toBe(false);
});

test('another project is refused before any product request', async () => {
  const r = rig({ withDemo: true });
  const demo = await operatorSession(r);
  const credential = r.company.lease('qa-2', 'qa', 'task-2', 'demo');
  const error = await failure(r.call('ops_product_pulse', { session: demo.session, event: EVENT, day: DAY }, { cred: credential, task: 'task-2', project: 'demo' }));
  expect(error.code).toBe('forbidden');
  expect(r.world.requests.some(item => item.url.includes('/api/ops/funnel-summary'))).toBe(false);
});

test('a role outside engineering/product/qa is refused', async () => {
  const r = rig({ patch: { roles: ['qa', 'engineering', 'owner', 'product', 'ai-content'] } });
  const login = await operatorSession(r, 'ai-ops');
  const credential = r.company.lease('ai-1', 'ai-content', 'task-1', 'surreal_ck');
  const error = await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }, { cred: credential }));
  expect(error.code).toBe('forbidden');
});

test('unknown arguments, unknown events and invalid days are refused before any request', async () => {
  const r = rig();
  const login = await operatorSession(r);
  const before = r.world.requests.length;
  const extra = await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY, limit: 500 }));
  expect(extra.code).toBe('invalid');
  const event = await failure(r.call('ops_product_pulse', { session: login.session, event: 'page_view', day: DAY }));
  expect(event.code).toBe('invalid');
  const day = await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: '2026-02-30' }));
  expect(day.code).toBe('invalid');
  expect(r.world.requests.length).toBe(before);
});

test('a response that contradicts the request is refused, and the raw body never leaks', async () => {
  const r = rig({ deps: {} });
  const login = await operatorSession(r);
  r.world.funnelSummary.body = summary({ day: '2026-11-16', leak: 'RAW-BODY-MARKER' });
  const error = await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }));
  expect(error.code).toBe('upstream_error');
  expect(error.message).toContain('日期与请求不一致');
  expect(error.message).not.toContain('RAW-BODY-MARKER');
});

test('counts that contradict the state or thresholds are refused instead of guessed', async () => {
  const r = rig();
  const login = await operatorSession(r);
  r.world.funnelSummary.body = summary({ state: 'suppressed', totalCount: 2, workspaceCount: 2 });
  expect((await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }))).message)
    .toContain('抑制态返回了精确计数');
  r.world.funnelSummary.body = summary({ state: 'reported', totalCount: 4, workspaceCount: 7 });
  expect((await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }))).message)
    .toContain('低于上游抑制阈值');
  r.world.funnelSummary.body = summary({ state: 'empty', totalCount: 1, workspaceCount: 0 });
  expect((await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }))).message)
    .toContain('空窗计数不为零');
});

test('an unknown or confident coverage marker is refused: coverage may only be unknown', async () => {
  const r = rig();
  const login = await operatorSession(r);
  r.world.funnelSummary.body = summary({ coverage: { state: 'known', complete: true, reason: 'all_sources', source: 'funnel_event_count' } });
  expect((await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }))).message)
    .toContain('覆盖标记不是 unknown');
  const withoutCoverage = summary() as Record<string, unknown>;
  delete withoutCoverage.coverage;
  r.world.funnelSummary.body = withoutCoverage;
  expect((await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }))).message)
    .toContain('缺少覆盖标记');
});

test('a malformed or failing upstream is surfaced without its code, message or body', async () => {
  const r = rig();
  const login = await operatorSession(r);
  r.world.funnelSummary.body = { event: EVENT, day: DAY, state: 'weird', marker: 'RAW-BODY-MARKER' };
  const malformed = await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }));
  expect(malformed.code).toBe('upstream_error');
  expect(malformed.message).not.toContain('RAW-BODY-MARKER');
  r.world.funnelSummary.body = null;
  r.world.funnelSummary.status = 503;
  const failed = await failure(r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY }));
  expect(failed.code).toBe('upstream_error');
  expect(failed.message).toContain('HTTP 503');
  expect(failed.message).not.toContain('funnel-summary-upstream-unavailable');
  expect(failed.message).not.toContain('汇总源暂不可用');
});

test('unknown response fields are ignored, and no workspace key reaches the caller', async () => {
  const r = rig();
  const login = await operatorSession(r);
  r.world.funnelSummary.body = summary({
    extra: 'ignored',
    rows: [{ workspaceKey: 'hmac-workspace-key', count: 9 }],
    totalCount: 41,
    workspaceCount: 7,
  });
  const view = await r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY });
  expect(Object.keys(view).sort()).toEqual([
    'coverage', 'day', 'event', 'limits', 'state', 'thresholds', 'totalCount', 'workspaceCount',
  ]);
  expect(JSON.stringify(view)).not.toContain('hmac-workspace-key');
  expect(JSON.stringify(view)).not.toContain('workspaceKey');
});

test('the call writes nothing', async () => {
  const r = rig();
  const login = await operatorSession(r);
  const writes = () => r.world.sql.filter(row => /^\s*(INSERT|UPDATE|DELETE|CREATE|DEFINE|REMOVE)\b/i.test(row.sql)).length;
  const before = writes();
  r.world.funnelSummary.aggregate = { totalCount: 41, workspaceCount: 7 };
  await r.call('ops_product_pulse', { session: login.session, event: EVENT, day: DAY });
  expect(writes()).toBe(before);
});