/**
 * SYS04 · The fault classifier and the recovery budget arithmetic.
 *
 * These are pure rules, so they are tested without a database: the same input must always produce the same
 * classification, the same fingerprint and the same budget decision. The persistence side is covered by
 * tests/fault-budget.fork.test.ts and the real transport by tests/fault-transport.fork.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FAULT_BUDGET, backoffWaitMs, budgetKey, canonicalAlias, classifyFault, decideAttempt, decideBudget,
  diagnosticFor, faultEvidence, faultFactsOf, faultFingerprint, httpClassOf, incidentKey, jitterFactorOf, spendBudget,
  type FaultBudgetLimits, type FaultRecord,
} from '../src/faults.ts';

const limits: FaultBudgetLimits = { maxAttempts: 3, totalDeadlineMs: 120_000, minIntervalMs: 2_000, backoffMs: 5_000, jitter: 0.2 };

describe('classification', () => {
  test('a connect timeout is retryable and lands on the connect hop', () => {
    const fault = classifyFault({ phase: 'login', errno: 'UND_ERR_CONNECT_TIMEOUT', name: 'TypeError', elapsedMs: 20_000, identityAlias: 'LCA04_MEMBER' });
    expect(fault.hop).toBe('connect');
    expect(fault.retryability).toBe('retryable');
    expect(fault.httpClass).toBe('none');
    expect(fault.errno).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(fault.elapsedMs).toBe(20_000);
  });

  test('a 403 is permanent and never becomes a network recovery', () => {
    const fault = classifyFault({ phase: 'login', status: 403, elapsedMs: 120 });
    expect(fault.retryability).toBe('permanent');
    expect(fault.httpClass).toBe('client_error');
    expect(fault.hop).toBe('response');
  });

  test('a rejected password is a permanent client error, not a retryable 5xx', () => {
    const fault = classifyFault({ phase: 'login', status: 401, elapsedMs: 90 });
    expect(fault.httpClass).toBe('auth');
    expect(fault.retryability).toBe('permanent');
  });

  test('a retryable 5xx recovers, a non-retryable 5xx does not', () => {
    expect(classifyFault({ phase: 'request', status: 503 }).retryability).toBe('retryable');
    expect(classifyFault({ phase: 'request', status: 502 }).retryability).toBe('retryable');
    expect(classifyFault({ phase: 'request', status: 501 }).retryability).toBe('permanent');
  });

  test('a rate limit is not retried blindly', () => {
    expect(classifyFault({ phase: 'request', status: 429 }).retryability).toBe('permanent');
    expect(classifyFault({ phase: 'request', status: 429 }).httpClass).toBe('rate_limited');
  });

  test('a connection reset whose request may have been sent is not replayed', () => {
    const fault = classifyFault({ phase: 'exchange', errno: 'ECONNRESET', requestSent: true, idempotent: false });
    expect(fault.retryability).toBe('unknown_outcome');
  });

  test('a connection reset before the request was written may be repeated', () => {
    expect(classifyFault({ phase: 'exchange', errno: 'ECONNRESET', requestSent: false }).retryability).toBe('retryable');
  });

  test('a non-idempotent write is never replayed, whatever the transport said', () => {
    const fault = classifyFault({ phase: 'member_add', errno: 'ECONNRESET', idempotent: false });
    expect(fault.retryability).toBe('unknown_outcome');
  });

  test('a connection that never came up proves that nothing was written: even a write may be repeated', () => {
    const fault = classifyFault({ phase: 'member_add', errno: 'UND_ERR_CONNECT_TIMEOUT', idempotent: false });
    expect(fault.retryability).toBe('retryable');
    expect(fault.hop).toBe('connect');
  });

  test('an untrusted certificate is final and TLS is never downgraded', () => {
    const fault = classifyFault({ phase: 'login', errno: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    expect(fault.hop).toBe('tls');
    expect(fault.retryability).toBe('permanent');
  });

  test('an unknown error stops conservatively instead of guessing a network cause', () => {
    const fault = classifyFault({ phase: 'request', name: 'WeirdError' });
    expect(fault.retryability).toBe('unclassified');
    expect(fault.hop).toBe('none');
  });

  test('the HTTP class buckets the statuses that mean the same thing', () => {
    expect(httpClassOf(401)).toBe('auth');
    expect(httpClassOf(403)).toBe('client_error');
    expect(httpClassOf(404)).toBe('not_found');
    expect(httpClassOf(409)).toBe('conflict');
    expect(httpClassOf(500)).toBe('server_error');
    expect(httpClassOf(429)).toBe('rate_limited');
    expect(httpClassOf(undefined)).toBe('none');
  });
});

describe('identity alias canonicalization', () => {
  test('spelling variants fold onto one alias', () => {
    expect(canonicalAlias('LCA04_MEMBER')).toBe('lca04-member');
    expect(canonicalAlias('  lca04 member  ')).toBe('lca04-member');
    expect(canonicalAlias('LCA04.Member')).toBe('lca04-member');
    expect(canonicalAlias('lca04__member')).toBe('lca04-member');
  });

  test('an empty alias is no alias', () => {
    expect(canonicalAlias('')).toBeUndefined();
    expect(canonicalAlias('   ')).toBeUndefined();
    expect(canonicalAlias(undefined)).toBeUndefined();
  });
});

describe('grouping', () => {
  const base = classifyFault({ phase: 'login', errno: 'UND_ERR_CONNECT_TIMEOUT', elapsedMs: 20_000, identityAlias: 'LCA04_MEMBER', target: 'idp_login', environment: 'production' });

  test('the elapsed time does not change the fingerprint', () => {
    const slower = classifyFault({ phase: 'login', errno: 'UND_ERR_CONNECT_TIMEOUT', elapsedMs: 5_000, identityAlias: 'LCA04_MEMBER', target: 'idp_login', environment: 'production' });
    expect(faultFingerprint(slower)).toBe(faultFingerprint(base));
  });

  test('the identity alias does not key the fingerprint: a swapped alias is the same cause', () => {
    const other = classifyFault({ phase: 'login', errno: 'UND_ERR_CONNECT_TIMEOUT', elapsedMs: 20_000, identityAlias: 'LCA04_REMOVABLE', target: 'idp_login', environment: 'production' });
    expect(faultFingerprint(other)).toBe(faultFingerprint(base));
    expect(incidentKey(other)).toBe(incidentKey(base));
    // The alias is still recorded, in its canonical form, for the audit.
    expect(other.identityAlias).toBe('lca04-removable');
  });

  test('a different environment is a different fingerprint and a different incident', () => {
    const staging = classifyFault({ phase: 'login', errno: 'UND_ERR_CONNECT_TIMEOUT', elapsedMs: 20_000, identityAlias: 'LCA04_MEMBER', target: 'idp_login', environment: 'staging' });
    expect(faultFingerprint(staging)).not.toBe(faultFingerprint(base));
    expect(incidentKey(staging)).not.toBe(incidentKey(base));
  });

  test('a different permission context is a different incident', () => {
    const other = classifyFault({ phase: 'login', errno: 'UND_ERR_CONNECT_TIMEOUT', elapsedMs: 20_000, identityAlias: 'LCA04_MEMBER', target: 'idp_login', environment: 'production', status: 403 });
    expect(incidentKey(other)).not.toBe(incidentKey(base));
  });

  test('the incident groups the hops of one outage: the same cause from another hop is one incident', () => {
    const beforeWrite = classifyFault({ phase: 'login', errno: 'TimeoutError', requestSent: false, elapsedMs: 20_000, target: 'idp_login', environment: 'production' });
    const afterWrite = classifyFault({ phase: 'login', errno: 'TimeoutError', requestSent: true, elapsedMs: 20_000, target: 'idp_login', environment: 'production' });
    expect(beforeWrite.hop).toBe('connect');
    expect(afterWrite.hop).toBe('response');
    expect(faultFingerprint(afterWrite)).not.toBe(faultFingerprint(beforeWrite));
    expect(incidentKey(afterWrite)).toBe(incidentKey(beforeWrite));
  });

  test('the budget key binds the task, the controlled target and the phase', () => {
    const first = budgetKey('task-a', 'idp_login', 'login');
    expect(budgetKey('task-b', 'idp_login', 'login')).not.toBe(first);
    expect(budgetKey('task-a', 'idp_token', 'login')).not.toBe(first);
    expect(budgetKey('task-a', 'idp_login', 'exchange')).not.toBe(first);
    // The holder is not part of the key: changing the holder must not clear the budget.
    expect(budgetKey('task-a', 'idp_login', 'login')).toBe(first);
  });

  test('the flow stage is part of the fingerprint but not of the incident', () => {
    const authorize = classifyFault({ phase: 'login', stage: 'authorize', errno: 'UND_ERR_CONNECT_TIMEOUT', target: 'idp_login' });
    const exchange = classifyFault({ phase: 'login', stage: 'exchange', errno: 'UND_ERR_CONNECT_TIMEOUT', target: 'idp_login' });
    // Two stages of one outage are two causes: they get their own episode and their own diagnosis.
    expect(faultFingerprint(authorize)).not.toBe(faultFingerprint(exchange));
    // But it is one incident, so there is one repair chain for it.
    expect(incidentKey(authorize)).toBe(incidentKey(exchange));
  });
});

describe('budget arithmetic', () => {
  const fault = classifyFault({ phase: 'login', errno: 'UND_ERR_CONNECT_TIMEOUT' });

  test('the first attempt is allowed when nothing was spent', () => {
    expect(decideAttempt(undefined, limits, 1_000).allowed).toBe(true);
  });

  test('the reservation does not judge the cause: it only knows the counters', () => {
    // The reservation runs before the failure is known, so an unclassified cause must not refuse it.
    const unknown = classifyFault({ phase: 'login', name: 'WeirdError' });
    expect(unknown.retryability).toBe('unclassified');
    expect(decideAttempt(undefined, limits, 1_000).allowed).toBe(true);
    expect(decideBudget(undefined, limits, 1_000, unknown).allowed).toBe(false);
    expect(decideBudget(undefined, limits, 1_000, unknown).reason).toBe('not_retryable');
  });

  test('a permanent fault stops the recovery before any budget is spent', () => {
    const denied = classifyFault({ phase: 'login', status: 403 });
    const decision = decideBudget(undefined, limits, 1_000, denied);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('not_retryable');
  });

  test('the budget stops after the attempt limit', () => {
    const state = spendBudget(undefined, limits, 1_000, fault, 0);
    const second = spendBudget(state, limits, 60_000, fault, 0);
    const third = spendBudget(second, limits, 120_000, fault, 0);
    const decision = decideAttempt(third, limits, 180_000);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('attempts_exhausted');
  });

  test('the minimum interval holds the next attempt back', () => {
    const state = spendBudget(undefined, limits, 1_000, fault, 0);
    const decision = decideAttempt(state, limits, 1_500);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('min_interval');
    expect(decision.nextAllowedAt).toBeGreaterThan(1_500);
  });

  test('the deadline stops the recovery even with attempts left', () => {
    const state = spendBudget(undefined, limits, 1_000, fault, 0);
    const decision = decideAttempt(state, limits, 200_000);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('deadline_passed');
  });

  test('the lease window caps the recovery deadline: an attempt may not outlive its lock', () => {
    const state = spendBudget(undefined, limits, 1_000, fault, 0);
    expect(decideAttempt(state, limits, 10_000).allowed).toBe(true);
    const capped = decideAttempt(state, limits, 10_000, 5_000);
    expect(capped.allowed).toBe(false);
    expect(capped.reason).toBe('lease_expired');
    expect(capped.nextAllowedAt).toBe(5_000);
  });

  test('the backoff grows with the attempt number and carries the jitter', () => {
    expect(backoffWaitMs(limits, 1, 0)).toBe(0);
    expect(backoffWaitMs(limits, 2, 0)).toBe(5_000);
    expect(backoffWaitMs(limits, 3, 0)).toBe(10_000);
    expect(backoffWaitMs(limits, 3, 1)).toBe(12_000);
    expect(backoffWaitMs(limits, 3, -1)).toBe(8_000);
  });

  test('the spent budget records the attempt, the deadline and the next allowed time', () => {
    const state = spendBudget(undefined, limits, 1_000, fault, 0);
    expect(state.attempts).toBe(1);
    expect(state.deadline).toBe(1_000 + limits.totalDeadlineMs);
    expect(state.lastAttemptAt).toBe(1_000);
    expect(state.nextAllowedAt).toBe(1_000 + limits.minIntervalMs);
    expect(state.failed).toBe(true);
    expect(state.fingerprint).toBe(faultFingerprint(fault));
  });

  test('the budget survives a change of holder: the same key keeps the same state', () => {
    const first = spendBudget(undefined, limits, 1_000, fault, 0);
    const second = spendBudget(first, limits, 60_000, fault, 0);
    expect(second.attempts).toBe(2);
    expect(second.deadline).toBe(first.deadline);
  });

  test('the jitter is a function of the budget scope alone, so the audit can be recomputed', () => {
    const key = budgetKey('task-a', 'idp_login', 'login');
    const factor = jitterFactorOf(key);
    expect(factor).toBeGreaterThanOrEqual(0);
    expect(factor).toBeLessThan(1);
    expect(jitterFactorOf(key)).toBe(factor);
    expect(jitterFactorOf(budgetKey('task-b', 'idp_login', 'login'))).not.toBe(factor);
  });
});

describe('the diagnostic', () => {
  test('a spent budget produces one structured diagnostic with a fixed guidance', () => {
    const fault = classifyFault({ phase: 'login', errno: 'UND_ERR_CONNECT_TIMEOUT', elapsedMs: 20_000 });
    const state = spendBudget(undefined, limits, 1_000, fault, 0);
    const diagnostic = diagnosticFor(fault, state, limits);
    expect(diagnostic.attempts).toBe(1);
    expect(diagnostic.maxAttempts).toBe(limits.maxAttempts);
    expect(diagnostic.fingerprint).toBe(faultFingerprint(fault));
    expect(diagnostic.guidance).toContain('recovery budget');
  });

  test('a refused request gets a diagnostic about the cause, not about the network', () => {
    const fault = classifyFault({ phase: 'login', status: 403 });
    const state = spendBudget(undefined, limits, 1_000, fault, 0);
    const diagnostic = diagnosticFor(fault, state, limits);
    expect(diagnostic.guidance).toContain('cannot help');
    expect(diagnostic.guidance).not.toContain('recovery budget');
  });

  test('an untrusted certificate is never answered with a suggestion to relax TLS', () => {
    const fault = classifyFault({ phase: 'login', errno: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    const state = spendBudget(undefined, limits, 1_000, fault, 0);
    const diagnostic = diagnosticFor(fault, state, limits);
    expect(diagnostic.guidance).toContain('must not be weakened');
  });
});

describe('the facts of a thrown error', () => {
  test('the facts of the failed hop are read from the error, never from its message', () => {
    const error = Object.assign(new Error('IdP authorize failed (timed out after 20s)'), {
      facts: { stage: 'authorize' as const, errno: 'UND_ERR_CONNECT_TIMEOUT', name: 'TypeError' },
    });
    expect(faultFactsOf(error)).toEqual({ stage: 'authorize', errno: 'UND_ERR_CONNECT_TIMEOUT', name: 'TypeError' });
  });

  test('the errno of a transport failure and the HTTP status of a refusal are both found', () => {
    const transport = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(faultFactsOf(transport).errno).toBe('ECONNRESET');
    expect(faultFactsOf({ status: 503 }).status).toBe(503);
    expect(faultFactsOf({ response: { status: 403 } }).status).toBe(403);
  });
});

describe('the evidence', () => {
  test('the evidence carries the machine facts and no secret', () => {
    const fault = classifyFault({ phase: 'login', errno: 'UND_ERR_CONNECT_TIMEOUT', elapsedMs: 20_000, identityAlias: 'LCA04_MEMBER', target: 'idp_login', environment: 'production' });
    const evidence = faultEvidence(fault);
    expect(evidence.phase).toBe('login');
    expect(evidence.hop).toBe('connect');
    expect(evidence.errno).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(evidence.identityAlias).toBe('lca04-member');
    expect(evidence.retryability).toBe('retryable');
    expect(JSON.stringify(evidence)).not.toContain('LCA04_MEMBER');
  });

  test('the default limits are bounded', () => {
    expect(DEFAULT_FAULT_BUDGET.maxAttempts).toBeGreaterThan(0);
    expect(DEFAULT_FAULT_BUDGET.totalDeadlineMs).toBeLessThanOrEqual(180_000);
  });
});

describe('operation isolation', () => {
  test('browser injection, logout and an ordinary request are three budget objects', () => {
    const browser = budgetKey('task-1', 'browser', 'request');
    const logout = budgetKey('task-1', 'logout', 'request');
    const request = budgetKey('task-1', 'internal', 'request');
    expect(new Set([browser, logout, request]).size).toBe(3);
    // The same cause seen on different controlled targets is not one incident either, so a stopped
    // browser scope cannot close the incident a request or a logout belongs to.
    expect(incidentKey(classifyFault({ phase: 'request', target: 'browser' })))
      .not.toBe(incidentKey(classifyFault({ phase: 'request', target: 'internal' })));
  });

  test('an unclassified failure stops its own recovery and is not treated as retryable', () => {
    const fault = classifyFault({ phase: 'request', target: 'browser', elapsedMs: 5 });
    expect(fault.retryability).toBe('unclassified');
    expect(decideBudget(undefined, DEFAULT_FAULT_BUDGET, 0, fault)).toMatchObject({ allowed: false, reason: 'not_retryable' });
  });
});
