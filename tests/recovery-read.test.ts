import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OpsBroker } from '../src/ops/broker.ts';
import { CompanyError } from '../src/core-errors.ts';
import type { OpsScope, RecoveryReadSettleInput } from '../src/contracts.ts';
import {
  RECOVERY_READ_ALIAS, RECOVERY_READ_PATHS, classifyRecoveryRead, exactRecoveryPaths, parseRecoveryExpiry,
} from '../src/recovery-read.ts';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import { commDir, readJsonFile, reqDir, resDir } from '../src/comm.ts';
import { brokerConfig, FakeCompany, FakeWorld, OPS_CLIENT, OPS_REDIRECT, OPS_RESOURCE } from './support/ops-world.ts';
import type { EmployeeInst } from '../src/workforce.ts';

// ---------------------------------------------------------------------------
// Pure grant surface
// ---------------------------------------------------------------------------

describe('recovery read grant surface', () => {
  test('the allowlist is exactly the four paths, in order, with no substitutions', () => {
    expect(exactRecoveryPaths([...RECOVERY_READ_PATHS])).toEqual([...RECOVERY_READ_PATHS]);
    expect(() => exactRecoveryPaths(RECOVERY_READ_PATHS.slice(0, 3))).toThrow();
    expect(() => exactRecoveryPaths([...RECOVERY_READ_PATHS].reverse())).toThrow();
    expect(() => exactRecoveryPaths([...RECOVERY_READ_PATHS, '/api/ops/extra'])).toThrow();
    expect(() => exactRecoveryPaths(['/api/ops/runtime-version', ...RECOVERY_READ_PATHS.slice(1)])).toThrow();
  });

  test('TTL is 1–30 minutes and anything else is refused', () => {
    const now = Date.parse('2026-11-03T00:00:00Z');
    expect(parseRecoveryExpiry('2026-11-03T00:01:00Z', now).toISOString()).toBe('2026-11-03T00:01:00.000Z');
    expect(parseRecoveryExpiry('2026-11-03T00:30:00Z', now).toISOString()).toBe('2026-11-03T00:30:00.000Z');
    expect(() => parseRecoveryExpiry('2026-11-03T00:00:59Z', now)).toThrow();
    expect(() => parseRecoveryExpiry('2026-11-03T00:30:01Z', now)).toThrow();
    expect(() => parseRecoveryExpiry('not-an-instant', now)).toThrow();
    // A local-time instant without an offset is ambiguous and refused.
    expect(() => parseRecoveryExpiry('2026-11-03T00:10:00', now)).toThrow();
    expect(() => parseRecoveryExpiry('2026-11-03T08:10:00+08:00', now)).not.toThrow();
  });

  test('the first item is a 503 not-configured success, not a failure', () => {
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[0],
      503, { error: { code: 'endpoint-probe-temporary-grant-not-configured' } })).toEqual({ ok: true, outcome: 'not_configured_503' });
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[0], 200, {}).ok).toBe(false);
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[0], 503, { error: { code: 'other' } }).ok).toBe(false);
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[0], 403, { error: { code: 'endpoint-probe-temporary-grant-forbidden' } }).ok).toBe(false);
  });

  test('operators must be format_version 1 with an operators array', () => {
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[1], 200, { format_version: 1, operators: [] }).ok).toBe(true);
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[1], 200, { format_version: 2, operators: [] }).ok).toBe(false);
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[1], 200, { format_version: 1 }).ok).toBe(false);
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[1], 500, {}).ok).toBe(false);
  });

  test('runtime needs the fixed projection and a loopback endpoint', () => {
    const body = {
      provider: 'openai', model: 'group/work', endpointHost: '127.0.0.1',
      endpointBinding: { endpoint: 'http://127.0.0.1:3425/v1', host: '127.0.0.1' },
      jevModel: 'jev-latest', mastraVersion: '1.36.0', priceCertificates: [], defaultEnabled: false,
      balance: { status: 'unavailable' }, implicitRetries: 0,
    };
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[2], 200, body).ok).toBe(true);
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[2], 200, { ...body, endpointHost: 'api.example.com', endpointBinding: { host: 'api.example.com' } }).ok).toBe(false);
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[2], 200, { ...body, mastraVersion: undefined }).ok).toBe(false);
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[2], 200, { ...body, endpointBinding: { host: 'elsewhere' } }).ok).toBe(false);
  });

  test('runtime-version needs a known origin, 40-hex sha and a deployment id', () => {
    const ok = { origin: { state: 'known', sha: 'a'.repeat(40), deploymentId: '123-456' } };
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[3], 200, ok).ok).toBe(true);
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[3], 200, { origin: { ...ok.origin, state: 'unknown' } }).ok).toBe(false);
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[3], 200, { origin: { ...ok.origin, sha: 'abc' } }).ok).toBe(false);
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[3], 200, { origin: { ...ok.origin, deploymentId: 'release' } }).ok).toBe(false);
    expect(classifyRecoveryRead(RECOVERY_READ_PATHS[3], 200, {}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Broker enforcement against a scripted grant chain
// ---------------------------------------------------------------------------

interface ChainState {
  state: 'issued' | 'bound' | 'running' | 'completed' | 'stopped' | 'revoked';
  loginAttempts: number;
  perPath: number[];
  inFlight?: { callId: string; path: string };
  stopReason?: string;
}

const resetChain = (patch: Partial<ChainState> = {}): ChainState => ({
  state: 'bound', loginAttempts: 0, perPath: [0, 0, 0, 0], ...patch,
});

function recoveryRig(chain: ChainState, bodies: Partial<Record<string, [number, unknown]>> = {},
  options: { chargeLogin?: boolean } = {}) {
  const world = new FakeWorld();
  const company = new FakeCompany();
  company.env('demo', 'production', brokerConfig({ ops: { clientId: OPS_CLIENT, redirectUri: OPS_REDIRECT, resource: OPS_RESOURCE } }));
  const reserved: Array<{ taskId: string; phase: string; target: string }> = [];
  const settled: Array<{ taskId: string; phase: string; target: string }> = [];
  const refunded: Array<{ taskId: string; phase: string; target: string; refund: unknown }> = [];
  const faultState = { attempts: 2, totalAttempts: 5, deadline: 0, nextAllowedAt: 0, lastAttemptAt: 1, failed: true, stopped: false, incident: 'login|TimeoutError|none|-|product_token|production' };
  faultState.deadline = Date.now() + 120_000;
  const settledChain: RecoveryReadSettleInput[] = [];
  const scope: OpsScope = {
    actor: { employeeId: 'qa-1', role: 'qa', capabilities: ['execute'] }, taskId: 'task-done', project: 'demo',
    kind: 'recovery_read', recovery: { grantId: 'g1', grantFence: 1, alias: RECOVERY_READ_ALIAS, paths: [...RECOVERY_READ_PATHS] },
  };
  const leaseScope = company.core.opsScope;
  const core = {
    ...company.core,
    opsScope: async (credential: string, taskId: string, proof?: { grantId: string; grantFence: number }) => {
      if (!proof) return leaseScope(credential, taskId);
      if (proof.grantId !== 'g1' || proof.grantFence !== 1 || taskId !== 'task-done') throw new CompanyError('forbidden', 'forged recovery proof');
      return scope;
    },
    recoveryReadReserve: async (_credential: string, input: { kind: 'login' | 'get' | 'logout'; path?: string }) => {
      const callId = randomUUID();
      if (input.kind === 'logout') return { allowed: true, kind: 'logout', callId, message: 'logout allowed' };
      if (chain.inFlight) return { allowed: false, kind: input.kind, reason: 'busy', message: 'Recovery read is busy with another call' };
      if (input.kind === 'login') {
        if (chain.state !== 'bound') return { allowed: false, kind: 'login', reason: 'login_unavailable', message: 'login unavailable' };
        if (chain.loginAttempts >= 1) return { allowed: false, kind: 'login', reason: 'login_attempted', message: 'login already attempted' };
        chain.loginAttempts++;
        chain.inFlight = { callId, path: 'login' };
        return { allowed: true, kind: 'login', callId, message: 'login reserved' };
      }
      if (chain.state !== 'running') return { allowed: false, kind: 'get', reason: 'read_unavailable', message: 'GETs need a successful login' };
      const index = RECOVERY_READ_PATHS.indexOf(input.path as never);
      if (index < 0) return { allowed: false, kind: 'get', reason: 'path_not_allowlisted', message: 'Path is not in this grant' };
      if (chain.perPath[index] >= 1) return { allowed: false, kind: 'get', reason: 'path_attempted', message: 'This path was already called' };
      if (index > 0 && chain.perPath[index - 1] !== 1) return { allowed: false, kind: 'get', reason: 'path_order', message: 'Paths must be called in order' };
      chain.perPath[index]++;
      chain.inFlight = { callId, path: input.path! };
      return { allowed: true, kind: 'get', callId, path: input.path, message: 'read reserved' };
    },
    recoveryReadSettle: async (_credential: string, input: RecoveryReadSettleInput) => {
      settledChain.push(input);
      chain.inFlight = undefined;
      if (input.kind === 'logout') return;
      if (!input.ok) { chain.state = 'stopped'; chain.stopReason = input.outcome; return; }
      if (input.kind === 'login') { chain.state = 'running'; return; }
      const index = RECOVERY_READ_PATHS.indexOf(input.path as never);
      if (index === RECOVERY_READ_PATHS.length - 1) chain.state = 'completed';
    },
    reserveFault: async (s: { taskId: string }, input: { phase: string; target?: string }) => {
      if (company.faults.refuse) {
        const refusal = company.faults.refuse;
        company.faults.refuse = undefined;
        return { allowed: false, attempt: 0, charged: false, reason: refusal.reason, message: refusal.message, evidence: {} };
      }
      reserved.push({ taskId: s.taskId, phase: input.phase, target: input.target ?? 'none' });
      const target = input.target ?? 'none';
      if (!options.chargeLogin || input.phase !== 'login') {
        return { allowed: true, attempt: 0, charged: false, message: '', evidence: {} };
      }
      const prior = { attempts: faultState.attempts, totalAttempts: faultState.totalAttempts,
        deadline: faultState.deadline, nextAllowedAt: faultState.nextAllowedAt,
        lastAttemptAt: faultState.lastAttemptAt, failed: faultState.failed };
      faultState.attempts += 1;
      faultState.totalAttempts += 1;
      faultState.nextAllowedAt += 1_000;
      const refund = { key: `${s.taskId}|${target}|${input.phase}`, taskId: s.taskId, target, phase: input.phase,
        chargedAttempts: faultState.attempts, chargedTotalAttempts: faultState.totalAttempts,
        chargedDeadline: faultState.deadline, chargedNextAllowedAt: faultState.nextAllowedAt,
        chargedLastAttemptAt: faultState.lastAttemptAt, priorAttempts: prior.attempts,
        priorTotalAttempts: prior.totalAttempts, priorDeadline: prior.deadline,
        priorNextAllowedAt: prior.nextAllowedAt, priorLastAttemptAt: prior.lastAttemptAt, priorFailed: prior.failed };
      return { allowed: true, attempt: faultState.attempts, charged: true, message: '', evidence: {}, refund };
    },
    refundFault: async (s: { taskId: string }, input: { phase: string; target?: string;
      refund: { chargedAttempts: number; chargedTotalAttempts: number; priorAttempts: number; priorTotalAttempts: number;
        priorDeadline: number; priorNextAllowedAt: number; priorLastAttemptAt?: number; priorFailed: boolean } }) => {
      refunded.push({ taskId: s.taskId, phase: input.phase, target: input.target ?? 'none', refund: input.refund });
      const token = input.refund;
      if (token.chargedAttempts !== faultState.attempts || token.chargedTotalAttempts !== faultState.totalAttempts) {
        return { refunded: false };
      }
      faultState.attempts = token.priorAttempts;
      faultState.totalAttempts = token.priorTotalAttempts;
      faultState.deadline = token.priorDeadline;
      faultState.nextAllowedAt = token.priorNextAllowedAt;
      faultState.lastAttemptAt = token.priorLastAttemptAt ?? faultState.lastAttemptAt;
      faultState.failed = token.priorFailed;
      return { refunded: true };
    },
    settleFault: async (s: { taskId: string }, input: { phase: string; target?: string }) => {
      settled.push({ taskId: s.taskId, phase: input.phase, target: input.target ?? 'none' });
      if (options.chargeLogin && input.phase === 'login') {
        faultState.failed = false;
        faultState.attempts = 0;
        faultState.nextAllowedAt = 0;
      }
    },
  };
  const defaultBodies: Record<string, [number, unknown]> = {
    [RECOVERY_READ_PATHS[0]]: [503, { error: { code: 'endpoint-probe-temporary-grant-not-configured' } }],
    [RECOVERY_READ_PATHS[1]]: [200, { format_version: 1, operators: [] }],
    [RECOVERY_READ_PATHS[2]]: [200, { provider: 'openai', model: 'group/work', endpointHost: '127.0.0.1',
      endpointBinding: { endpoint: 'http://127.0.0.1:3425/v1', host: '127.0.0.1' }, jevModel: 'jev-latest',
      mastraVersion: '1.36.0', priceCertificates: [], defaultEnabled: false, balance: { status: 'unavailable' }, implicitRetries: 0 }],
    [RECOVERY_READ_PATHS[3]]: [200, { origin: { state: 'known', sha: 'a'.repeat(40), deploymentId: '7-1' } }],
  };
  const table = { ...defaultBodies, ...bodies };
  const throwPaths = new Set<string>();
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    if (throwPaths.has(parsed.pathname)) throw new TypeError('fetch failed: socket hang up');
    if (parsed.origin === 'https://app.test' && table[parsed.pathname]) {
      const [status, body] = table[parsed.pathname]!;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }
    return world.fetch(input as never, init as never);
  };
  const broker = new OpsBroker({
    core: core as never, projects: company.projects as never, secretKey: () => Buffer.alloc(32),
    controlEnv: () => ({ cloudflareToken: 'cf-token-value', cloudflareAccountId: 'acct' }),
    fetch: fetchImpl as never, now: world.now, monoNow: () => world.clock, d1: () => world.d1, queryAsUser: world.queryAsUser,
    browser: world.browser, sleep: async ms => { world.clock += ms; },
  });
  const qa = company.lease('qa-1', 'qa', 'task-done');
  return { world, company, core, broker, qa, chain, reserved, settled, refunded, faultState, settledChain, table, throwPaths };
}

async function failure<T>(promise: Promise<T>): Promise<Error & { code: string }> {
  try { await promise; } catch (error) { return error as Error & { code: string }; }
  throw new Error('expected the call to fail');
}

/** Account setup must happen outside the grant (recovery never ensures accounts); it uses the normal lease path. */
async function seedOperator(r: ReturnType<typeof recoveryRig>) {
  await r.broker.call(r.qa, 'task-done', 'ops_account_ensure', { alias: RECOVERY_READ_ALIAS });
  const user = r.world.user('sck-lca04-ops')!;
  r.world.operatorCaps.set(user.id, ['quota.read', 'subscription.manage']);
}

const recoveryProof = { grantId: 'g1', grantFence: 1 };

describe('broker recovery read enforcement', () => {
  test('any tool outside login/request/logout is refused before it runs', async () => {
    const r = recoveryRig(resetChain());
    for (const tool of ['ops_info', 'ops_health', 'ops_platform_operator_list', 'ops_logout_extra']) {
      const error = await failure(r.broker.call(r.qa, 'task-done', tool, {}, recoveryProof));
      expect(['forbidden', 'invalid']).toContain(error.code);
    }
    expect(r.world.requests).toHaveLength(0);
    expect(r.settledChain).toHaveLength(0);
  });

  test('forged proof, wrong task and wrong alias are refused', async () => {
    const r = recoveryRig(resetChain());
    expect((await failure(r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, { grantId: 'g1', grantFence: 2 }))).code).toBe('forbidden');
    expect((await failure(r.broker.call(r.qa, 'task-other', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof))).code).toBe('forbidden');
    await seedOperator(r);
    expect((await failure(r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: 'OTHER_OPS' }, recoveryProof))).code).toBe('forbidden');
    expect(r.world.requests.filter(x => x.url.includes('/t/ck/authorize'))).toHaveLength(0);
  });

  test('POST, an off-list path and a body are refused before any product call', async () => {
    const r = recoveryRig(resetChain({ state: 'running' }));
    const session = { session: 's_x' };
    expect((await failure(r.broker.call(r.qa, 'task-done', 'ops_request', { ...session, method: 'POST', path: RECOVERY_READ_PATHS[1] }, recoveryProof))).code).toBe('forbidden');
    expect((await failure(r.broker.call(r.qa, 'task-done', 'ops_request', { ...session, method: 'GET', path: '/api/ops/other' }, recoveryProof))).code).toBe('forbidden');
    expect((await failure(r.broker.call(r.qa, 'task-done', 'ops_request', { ...session, method: 'GET', path: RECOVERY_READ_PATHS[1], body: {} }, recoveryProof))).code).toBe('forbidden');
    expect(r.world.requests).toHaveLength(0);
  });

  test('one login then the four GETs in order: 503 first is success, all four settle ok, fault keys stay on the source task', async () => {
    const r = recoveryRig(resetChain());
    await seedOperator(r);
    const login = await r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof) as { session: string };
    expect(login.session).toBeTruthy();
    expect(r.chain.state).toBe('running');

    const statuses: number[] = [];
    for (const path of RECOVERY_READ_PATHS) {
      const res = await r.broker.call(r.qa, 'task-done', 'ops_request', { session: login.session, method: 'GET', path }, recoveryProof) as { status: number };
      statuses.push(res.status);
    }
    expect(statuses).toEqual([503, 200, 200, 200]);
    expect(r.chain.state).toBe('completed');
    expect(r.settledChain.filter(x => x.ok)).toHaveLength(5);
    // The first GET is a success even though it is a 503: it must not be recorded as a failed attempt.
    expect(r.settledChain.map(x => x.outcome)).toEqual(['login_ok', 'not_configured_503', 'operators_v1', 'runtime_projection', 'origin_known']);
    // Every fault reservation/settle used the source task id, never another task.
    expect(r.reserved.every(x => x.taskId === 'task-done')).toBe(true);
    expect(r.settled.every(x => x.taskId === 'task-done')).toBe(true);
    expect(r.reserved.filter(x => x.phase !== 'account_ensure').map(x => `${x.phase}/${x.target}`)).toEqual([
      'login/product_token', 'request/internal', 'request/internal', 'request/internal', 'request/internal',
    ]);
    // Bodies never enter the audit ledger: only digests and outcome names do.
    expect(JSON.stringify(r.company.audits)).not.toContain('endpoint-probe-temporary-grant-not-configured');
    expect(JSON.stringify(r.settledChain)).not.toContain('127.0.0.1');
  });

  test('a login failure stops the chain: no GET is reserved and only logout remains', async () => {
    const r = recoveryRig(resetChain());
    await seedOperator(r);
    // A wrong sealed password makes the IdP reject the operator login.
    r.company.sealed.set('demo/production/LCA04_OPS_PASSWORD', 'wrong');
    const error = await failure(r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof));
    expect(['login_failed', 'upstream_error']).toContain(error.code);
    expect(r.chain.state).toBe('stopped');
    expect(r.chain.stopReason).toBe('login_failed');
    const after = await failure(r.broker.call(r.qa, 'task-done', 'ops_request', { session: 's_x', method: 'GET', path: RECOVERY_READ_PATHS[0] }, recoveryProof));
    expect(after).toBeInstanceOf(Error);
    // Necessary cleanup is still allowed after the stop: it reaches the local session lookup, not a network login.
    const authorizesBefore = r.world.requests.filter(x => x.url.includes('/t/ck/authorize')).length;
    const logout = await failure(r.broker.call(r.qa, 'task-done', 'ops_logout', { session: 's_x' }, recoveryProof));
    expect(logout.code).toBe('not_found');
    expect(r.world.requests.filter(x => x.url.includes('/t/ck/authorize')).length).toBe(authorizesBefore);
  });

  test('an unexpected first-item result stops the chain and refuses the rest', async () => {
    const r = recoveryRig(resetChain(), { [RECOVERY_READ_PATHS[0]]: [200, {}] });
    await seedOperator(r);
    const login = await r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof) as { session: string };
    const res = await r.broker.call(r.qa, 'task-done', 'ops_request', { session: login.session, method: 'GET', path: RECOVERY_READ_PATHS[0] }, recoveryProof) as { status: number };
    expect(res.status).toBe(200); // the response still reaches the employee as evidence
    expect(r.chain.state).toBe('stopped');
    expect(r.chain.stopReason).toBe('unexpected_200');
    expect(r.chain.perPath).toEqual([1, 0, 0, 0]);
    const after = await failure(r.broker.call(r.qa, 'task-done', 'ops_request', { session: login.session, method: 'GET', path: RECOVERY_READ_PATHS[1] }, recoveryProof));
    expect(['forbidden', 'not_found']).toContain(after.code);
  });

  test('a skipped path or a repeated path is refused by the chain', async () => {
    const r = recoveryRig(resetChain());
    await seedOperator(r);
    const login = await r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof) as { session: string };
    r.chain.perPath = [1, 0, 0, 0];
    const session = { session: login.session };
    expect((await failure(r.broker.call(r.qa, 'task-done', 'ops_request', { ...session, method: 'GET', path: RECOVERY_READ_PATHS[2] }, recoveryProof))).code).toBe('forbidden');
    expect((await failure(r.broker.call(r.qa, 'task-done', 'ops_request', { ...session, method: 'GET', path: RECOVERY_READ_PATHS[0] }, recoveryProof))).code).toBe('forbidden');
    expect(r.chain.perPath).toEqual([1, 0, 0, 0]);
  });

  test('a chain refusal refunds the charged attempt and never settles the source fault healthy', async () => {
    const r = recoveryRig(resetChain(), {}, { chargeLogin: true });
    await seedOperator(r);
    const before = { attempts: r.faultState.attempts, totalAttempts: r.faultState.totalAttempts,
      deadline: r.faultState.deadline, nextAllowedAt: r.faultState.nextAllowedAt };
    r.chain.inFlight = { callId: 'c1', path: 'login' }; // the chain is busy before the login runs
    const error = await failure(r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof));
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('busy');
    expect(r.refunded).toHaveLength(1);
    expect(r.settled).toHaveLength(0);
    // The refund restored the pre-reservation counters; the source fault is still failed, never healthy.
    expect(r.faultState).toMatchObject({ ...before, failed: true });
  });

  test('a real login success settles the fault, while a free first call settles nothing', async () => {
    const charged = recoveryRig(resetChain(), {}, { chargeLogin: true });
    await seedOperator(charged);
    await charged.broker.call(charged.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof);
    expect(charged.refunded).toHaveLength(0);
    expect(charged.settled.filter(x => x.phase === 'login')).toHaveLength(1);
    expect(charged.faultState.failed).toBe(false);

    const free = recoveryRig(resetChain());
    await seedOperator(free);
    free.chain.inFlight = { callId: 'c2', path: 'login' };
    await failure(free.broker.call(free.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof));
    expect(free.refunded).toHaveLength(0);
    expect(free.settled).toHaveLength(0);
  });

  test('a concurrent call sees busy and no counter moves', async () => {
    const r = recoveryRig(resetChain());
    await seedOperator(r);
    const login = await r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof) as { session: string };
    r.chain.inFlight = { callId: 'c1', path: RECOVERY_READ_PATHS[0] };
    const before = [...r.chain.perPath];
    const error = await failure(r.broker.call(r.qa, 'task-done', 'ops_request',
      { session: login.session, method: 'GET', path: RECOVERY_READ_PATHS[0] }, recoveryProof));
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('busy');
    expect(r.chain.perPath).toEqual(before);
    expect(r.settledChain).toHaveLength(1); // only the login settle; the busy call never settled
  });

  test('a stopped grant still allows local logout but refuses the tools', async () => {
    const r = recoveryRig(resetChain({ state: 'stopped' }));
    expect((await failure(r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof))).code).toBe('forbidden');
    // The handler is reached for logout; an unknown handle is a local not_found, never a network login.
    const error = await failure(r.broker.call(r.qa, 'task-done', 'ops_logout', { session: 's_x' }, recoveryProof));
    expect(error.code).toBe('not_found');
    expect(r.world.requests).toHaveLength(0);
  });

  test('expired and revoked grants still allow the local logout at the broker layer', async () => {
    for (const state of ['revoked', 'expired'] as const) {
      const r = recoveryRig(resetChain({ state: state as never }));
      const error = await failure(r.broker.call(r.qa, 'task-done', 'ops_logout', { session: 's_x' }, recoveryProof));
      expect(error.code).toBe('not_found');
      expect(r.world.requests.filter(x => x.url.includes('/t/ck/authorize'))).toHaveLength(0);
    }
  });

  test('a fault-budget refusal never consumes the chain', async () => {
    const r = recoveryRig(resetChain());
    await seedOperator(r);
    r.company.faults.refuse = { reason: 'deadline_passed', message: 'the recovery deadline for this operation has passed.' };
    const error = await failure(r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('deadline');
    expect(r.chain.loginAttempts).toBe(0);
    expect(r.chain.inFlight).toBeUndefined();
    expect(r.chain.state).toBe('bound');
    expect(r.settledChain).toHaveLength(0);
    // A later manager lift makes the same grant usable: nothing was burned.
    const login = await r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof) as { session: string };
    expect(login.session).toBeTruthy();
    expect(r.chain.loginAttempts).toBe(1);
    expect(r.chain.state).toBe('running');
  });

  test('a transport failure stops the chain and is charged to the source task', async () => {
    const r = recoveryRig(resetChain());
    await seedOperator(r);
    const login = await r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }, recoveryProof) as { session: string };
    r.throwPaths.add(RECOVERY_READ_PATHS[0]);
    const error = await failure(r.broker.call(r.qa, 'task-done', 'ops_request',
      { session: login.session, method: 'GET', path: RECOVERY_READ_PATHS[0] }, recoveryProof));
    expect(error.code).toBe('upstream_error');
    expect(r.chain.state).toBe('stopped');
    expect(r.chain.stopReason).toBe('transport_upstream_error');
    // The real attempt is charged to the source task's request|... key, not to a new task or a grant-local key.
    expect(r.company.faults.reported.some(x => x.taskId === 'task-done' && x.phase === 'request')).toBe(true);
    expect(r.company.faults.reported.every(x => x.taskId === 'task-done')).toBe(true);
    r.throwPaths.delete(RECOVERY_READ_PATHS[0]);
    const next = await failure(r.broker.call(r.qa, 'task-done', 'ops_request',
      { session: login.session, method: 'GET', path: RECOVERY_READ_PATHS[1] }, recoveryProof));
    expect(['forbidden', 'not_found']).toContain(next.code);
  });

  test('recovery only accepts a session opened under this grant and alias', async () => {
    const r = recoveryRig(resetChain({ state: 'running' }));
    await seedOperator(r);
    // A normal lease-mode operator session exists for the same employee; it must not be usable under the grant.
    const leased = await r.broker.call(r.qa, 'task-done', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS }) as { session: string };
    const error = await failure(r.broker.call(r.qa, 'task-done', 'ops_request',
      { session: leased.session, method: 'GET', path: RECOVERY_READ_PATHS[0] }, recoveryProof));
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('grant');
    expect(r.chain.perPath).toEqual([0, 0, 0, 0]);
    expect(r.chain.inFlight).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sidecar channel: binding, overrides, mutual exclusion, expiry, reload
// ---------------------------------------------------------------------------

const grantRow = (patch: Record<string, unknown> = {}) => ({
  id: 'g1', taskId: 'task-done', employeeId: 'eng-x', alias: RECOVERY_READ_ALIAS, methods: ['GET'],
  paths: [...RECOVERY_READ_PATHS], expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  authorizationTask: 'task-auth', reason: 'evidence', state: 'issued', loginAttempts: 0, perPath: [0, 0, 0, 0],
  createdBy: 'gm-1', createdAt: new Date().toISOString(), fence: 1, ...patch,
});

const until = async (fn: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return; await Bun.sleep(20); }
  throw new Error('condition not met');
};

function sidecarRig() {
  const runDir = mkdtempSync(join(tmpdir(), 'sck-recovery-sidecar-'));
  const calls: Array<{ tool: string; taskId: string; args: Record<string, unknown>; proof?: { grantId: string; grantFence: number } }> = [];
  const closes: Array<{ grantId: string; reason: string }> = [];
  let row = grantRow();
  let activeLeases: unknown[] = [];
  const claimed: string[] = [];
  const ops = {
    tools: ['ops_info', 'ops_operator_login', 'ops_request', 'ops_logout', 'ops_health'],
    call: async (credential: string, taskId: string, tool: string, args: Record<string, unknown>, proof?: { grantId: string; grantFence: number }) => {
      calls.push({ tool, taskId, args, proof });
      return { tool, taskId, credential };
    },
    release: () => ({ sessions: 0, browserSpaces: 0, pending: 0 }),
    releaseGrant: () => 0,
  };
  const core = {
    claim: async (_c: string, taskId: string) => {
      claimed.push(taskId);
      const task = { id: taskId, title: `t-${taskId}`, context: '', state: 'doing', executorRole: 'engineering',
        reviewerRole: 'qa', kind: 'task', dependencies: [], version: 1, fence: 1, deliveryId: `d-${taskId}` };
      return { task, deliveryId: `d-${taskId}`, fence: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), history: [] };
    },
    activeLeases: async () => activeLeases,
    getTask: async (_c: string, taskId: string) => ({ id: taskId, title: 't', context: '', state: 'done',
      executorRole: 'engineering', reviewerRole: 'qa', kind: 'task', dependencies: [], version: 1, fence: 1 }),
    recoveryGrantFor: async (_c: string, grantId: string) => {
      if (grantId !== row.id) throw new CompanyError('not_found', 'no grant');
      return { ...row };
    },
    recoveryGrantsFor: async () => [row],
    recoveryReadBind: async (_c: string, input: { grantId: string; fence: number }) => {
      if (input.grantId !== row.id || input.fence !== row.fence) throw new CompanyError('forbidden', 'proof mismatch');
      if (row.state === 'issued') row = { ...row, state: 'bound' };
      return { ...row };
    },
    recoveryReadClose: async (_c: string, input: { grantId: string; fence: number; reason: string }) => {
      closes.push({ grantId: input.grantId, reason: input.reason });
    },
    recoveryReadStatus: async () => [{ grant: { ...row }, calls: [] }],
    recoveryReadGrant: async (_c: string, input: Record<string, unknown>) => ({ grant: { ...row, id: String(input.idempotencyKey ?? 'g-new') }, calls: [] }),
  };
  const workforce = { rotate: async () => 'tok-rotated' };
  const logs: string[] = [];
  const pool = new SidecarPool({ core: core as never, workforce: workforce as never, ops, runDir, heartbeatMs: 60_000, sweepMs: 20,
    log: message => logs.push(message) });
  const inst: EmployeeInst = { id: 'eng-x', role: 'engineering', credential: 'cred-eng-x' } as EmployeeInst;
  const relay = async (dir: string, key: string, name: string, tool: string, args: Record<string, unknown>) => {
    writeFileSync(join(reqDir(dir), `${name}.json`), JSON.stringify({ key, tool, args }));
    await until(() => existsSync(join(resDir(dir), `${name}.json`)));
    return readJsonFile<{ ok: boolean; data?: unknown; error?: string }>(join(resDir(dir), `${name}.json`))!;
  };
  return {
    runDir, pool, inst, calls, closes, relay, ops, core,
    setRow: (patch: Record<string, unknown>) => { row = { ...row, ...patch }; },
    getRow: () => row,
    setActiveLeases: (rows: unknown[]) => { activeLeases = rows; },
    claimed,
  };
}

describe('sidecar recovery binding', () => {
  let r: ReturnType<typeof sidecarRig>;
  beforeEach(() => { r = sidecarRig(); });
  afterEach(() => { r.pool.close(); rmSync(r.runDir, { recursive: true, force: true }); });

  test('the grant tools are dispatched without a lease; core owns their authorization', async () => {
    const env = r.pool.env(r.inst);
    const status = await r.relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'grant-status', 'recovery_read_status', { taskId: 'task-done' });
    expect(status.ok).toBe(true);
    expect(r.calls).toHaveLength(0);
    const issued = await r.relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'grant-issue', 'recovery_read_grant',
      { taskId: 'task-done', employeeId: 'eng-x', alias: RECOVERY_READ_ALIAS, paths: [...RECOVERY_READ_PATHS],
        expiresAt: new Date(Date.now() + 60_000).toISOString(), authorizationTask: 'task-auth', reason: 'fixture', idempotencyKey: 'fixture-1' });
    expect(issued.ok).toBe(true);
  });

  test('binding writes a recovery section, not a lease proof, and ops calls carry the channel proof', async () => {
    const env = r.pool.env(r.inst);
    const claim = await r.pool.adoptRecovery(r.inst, 'g1');
    expect(claim?.grantId).toBe('g1');
    const staged = JSON.parse(readFileSync(join(r.runDir, 'eng-x', 'claim.json'), 'utf8'));
    expect(staged.recovery).toMatchObject({ grantId: 'g1', taskId: 'task-done', alias: RECOVERY_READ_ALIAS });
    expect(staged.deliveryId).toBeUndefined();
    const res = await r.relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'r1', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS });
    expect(res.ok).toBe(true);
    expect(r.calls.at(-1)).toMatchObject({ tool: 'ops_operator_login', taskId: 'task-done', proof: { grantId: 'g1', grantFence: 1 } });
  });

  test('user-supplied taskId/sourceTaskId/grantId are refused, not silently dropped', async () => {
    const env = r.pool.env(r.inst);
    await r.pool.adoptRecovery(r.inst, 'g1');
    for (const key of ['taskId', 'sourceTaskId', 'grantId', 'grantFence', 'fence']) {
      const res = await r.relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, `bad-${key}`, 'ops_info', { [key]: 'x' });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('invalid');
    }
    expect(r.calls).toHaveLength(0);
  });

  test('non-allowlisted ops tools and every write tool are refused under a recovery binding', async () => {
    const env = r.pool.env(r.inst);
    await r.pool.adoptRecovery(r.inst, 'g1');
    const info = await r.relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'info', 'ops_info', {});
    expect(info.ok).toBe(false);
    expect(info.error).toContain('forbidden');
    const write = await r.relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'cp', 'checkpoint', { text: 'not allowed' });
    expect(write.ok).toBe(false);
    expect(write.error).toContain('no_lease');
    expect(r.calls).toHaveLength(0);
  });

  test('an execution claim refuses a recovery binding and claiming closes an existing binding', async () => {
    await r.pool.env(r.inst);
    await r.pool.claim(r.inst, { id: 'task-live', title: 't', state: 'ready', executorRole: 'engineering', row: {} } as never);
    await expect(r.pool.adoptRecovery(r.inst, 'g1')).rejects.toThrow();
    expect(r.getRow().state).toBe('issued');
    // End the execution claim, bind, then claim again: the binding is closed, never kept alongside a lease.
    r.claimed.length = 0;
    await r.pool.dropLease(r.inst.id, 'task-live');
    await r.pool.adoptRecovery(r.inst, 'g1');
    await r.pool.claim(r.inst, { id: 'task-next', title: 't', state: 'ready', executorRole: 'engineering', row: {} } as never);
    expect(r.closes.at(-1)).toMatchObject({ grantId: 'g1', reason: 'execution_claim' });
    expect(existsSync(join(r.runDir, 'eng-x', 'claim.json'))).toBe(true); // the new lease snapshot, no recovery section
    const staged = JSON.parse(readFileSync(join(r.runDir, 'eng-x', 'claim.json'), 'utf8'));
    expect(staged.recovery).toBeUndefined();
  });

  test('expiry closes the binding on the next sweep and the relay answers no_lease', async () => {
    r.setRow({ expiresAt: new Date(Date.now() + 500).toISOString() });
    const env = r.pool.env(r.inst);
    await r.pool.adoptRecovery(r.inst, 'g1');
    await until(() => r.closes.some(c => c.reason === 'expired'), 3000);
    const res = await r.relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'late', 'ops_operator_login', { alias: RECOVERY_READ_ALIAS });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no_lease');
    expect(r.calls).toHaveLength(0);
  });

  test('a reload rebuilds an active grant from the credential-scoped server read', async () => {
    const fresh = new SidecarPool({ core: r.core as never, workforce: { rotate: async () => 't' } as never, ops: r.ops, runDir: r.runDir,
      heartbeatMs: 60_000, sweepMs: 20 });
    const inst: EmployeeInst = { id: 'eng-x', role: 'engineering', credential: 'cred-eng-x' } as EmployeeInst;
    const env = fresh.env(inst);
    await fresh.adopt([inst]);
    const res = await r.relay(env.SCK_COMM_DIR, env.SCK_COMM_KEY!, 'after-reload', 'ops_request',
      { session: 's_x', method: 'GET', path: RECOVERY_READ_PATHS[0] });
    expect(res.ok).toBe(true);
    expect(r.calls.at(-1)).toMatchObject({ taskId: 'task-done', proof: { grantId: 'g1' } });
    fresh.close();
  });
});

describe('session grants', () => {
  test('the store drops only the handles a grant opened', async () => {
    const { SessionStore } = await import('../src/ops/sessions.ts');
    const store = new SessionStore(() => 1_000);
    const base = { employeeId: 'e1', project: 'p', env: 'production', alias: 'A', username: 'u', kind: 'operator' as const,
      token: 'tok', expiresAt: 10_000 };
    store.create({ ...base, grantId: 'g1' });
    store.create({ ...base, grantId: 'g2' });
    store.create({ ...base });
    expect(store.dropGrant('g1')).toBe(1);
    expect(store.countOf('e1')).toBe(2);
  });
});
