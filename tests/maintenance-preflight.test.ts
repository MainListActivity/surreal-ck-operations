import { expect, test } from 'bun:test';
import { evaluatePreflight, type AdminSummaryView, type DeploymentLease, type PreflightTask } from '../src/maintenance-preflight.ts';

// SYS-DISP 843d4e75 R1/R2: the executable preflight over the gm read-only views. Pure inputs, no database.
const NOW = Date.parse('2026-10-21T18:00:00.000Z');
const later = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

const summary = (tasks: Record<string, number>, overrides: Partial<AdminSummaryView> = {}): AdminSummaryView => ({
  cutoffAt: '2026-10-21T17:59:59.000Z', since: '2026-10-20T17:59:59.000Z', tasks, audit: {}, outboxSequence: 42,
  integrity: { complete: true }, ...overrides,
});
const task = (patch: Partial<PreflightTask> & Pick<PreflightTask, 'id' | 'state'>): PreflightTask => ({
  executorRole: 'engineering', reviewerRole: 'qa', fence: 1, version: 1, dependencies: [], ...patch,
});
const page = (rows: PreflightTask[], extra: { hasMore?: boolean; total?: number; snapshotAt?: string } = {}) => ({
  rows, hasMore: extra.hasMore ?? false, total: extra.total ?? rows.length, snapshotAt: extra.snapshotAt ?? 'snapshot-a',
});
const lease = (patch: Partial<DeploymentLease> = {}): DeploymentLease => ({
  taskId: 't-deploy', holder: 'e-deploy', fence: 3, version: 7, expiresAt: later(900), ...patch,
});
const extras = { triageGoals: 0, pendingEvals: 0, gmAttention: 0 };
const cleanRows = (): PreflightTask[] => [
  task({ id: 't-deploy', state: 'doing', currentEmployee: 'e-deploy', fence: 3, version: 7, leaseExpiresAt: later(900) }),
];

test('capability: complete summary and pages are accepted; every gap fails closed', () => {
  const ok = evaluatePreflight({ summary: summary({ doing: 1 }), pages: [page(cleanRows())], extras, deployment: lease(), now: NOW });
  expect(ok.capability).toMatchObject({ complete: true, reasons: [] });
  expect(ok.window).toMatchObject({ allowed: true, admittedLease: lease() });

  const gaps: Array<[string, Parameters<typeof evaluatePreflight>[0]]> = [
    ['summary integrity', { summary: summary({ doing: 1 }, { integrity: { complete: false } }), pages: [page(cleanRows())], extras, deployment: lease(), now: NOW }],
    ['hidden review rows', { summary: summary({ doing: 1, review: 1 }), pages: [page(cleanRows())], extras, deployment: lease(), now: NOW }],
    ['duplicate id', { summary: summary({ doing: 2 }), pages: [page([...cleanRows(), task({ id: 't-deploy', state: 'doing', currentEmployee: 'e-deploy', fence: 3, version: 7, leaseExpiresAt: later(900) })])], extras, deployment: lease(), now: NOW }],
    ['missing projection', { summary: summary({ done: 1 }), pages: [page([{ id: 't1', state: 'done' }])], extras, deployment: lease(), now: NOW }],
    ['truncated read', { summary: summary({ doing: 1 }), pages: [page(cleanRows(), { hasMore: true })], extras, deployment: lease(), now: NOW }],
    ['snapshot crossed', { summary: summary({ doing: 1 }), pages: [page(cleanRows(), { hasMore: true }), page([], { snapshotAt: 'snapshot-b' })], extras, deployment: lease(), now: NOW }],
    ['unknown state', { summary: summary({ mystery: 1 }), pages: [page([task({ id: 't1', state: 'mystery' })])], extras, deployment: lease(), now: NOW }],
    ['outbox missing', { summary: summary({ doing: 1 }, { outboxSequence: Number.NaN }), pages: [page(cleanRows())], extras, deployment: lease(), now: NOW }],
  ];
  for (const [reason, input] of gaps) {
    const verdict = evaluatePreflight(input);
    expect(verdict.capability.complete, reason).toBe(false);
    expect(verdict.capability.reasons.length, reason).toBeGreaterThan(0);
    expect(verdict.window.allowed, reason).toBe(false);
  }
});

test('window: ready, review, foreign doing, holderless doing and pending GM all refuse', () => {
  const cases: Array<[string, PreflightTask[], Record<string, number>]> = [
    ['ready', [task({ id: 't-ready', state: 'ready' })], { ready: 1 }],
    ['ready with holder', [task({ id: 't-ready', state: 'ready', currentEmployee: 'e-x' })], { ready: 1 }],
    ['unclaimed review', [task({ id: 't-review', state: 'review', submittedBy: 'e-a' })], { review: 1 }],
    ['live review', [task({ id: 't-review', state: 'review', currentEmployee: 'e-r', leaseExpiresAt: later(300) })], { review: 1 }],
    ['foreign doing', [task({ id: 't-deploy', state: 'doing', currentEmployee: 'e-deploy', fence: 3, version: 7, leaseExpiresAt: later(900) }), task({ id: 't-other', state: 'doing', currentEmployee: 'e-x', leaseExpiresAt: later(600) })], { doing: 2 }],
    ['holderless doing', [task({ id: 't-deploy', state: 'doing', currentEmployee: 'e-deploy', fence: 3, version: 7, leaseExpiresAt: later(900) }), task({ id: 't-orphan', state: 'doing' })], { doing: 2 }],
    ['pending GM', [task({ id: 't-deploy', state: 'doing', currentEmployee: 'e-deploy', fence: 3, version: 7, leaseExpiresAt: later(900) }), task({ id: 't-gm', state: 'blocked', blockedTo: 'gm' })], { doing: 1, blocked: 1 }],
    ['pending owner', [task({ id: 't-deploy', state: 'doing', currentEmployee: 'e-deploy', fence: 3, version: 7, leaseExpiresAt: later(900) }), task({ id: 't-owner', state: 'blocked', blockedTo: 'owner' })], { doing: 1, blocked: 1 }],
  ];
  for (const [reason, rows, tasks] of cases) {
    const verdict = evaluatePreflight({ summary: summary(tasks), pages: [page(rows)], extras, deployment: lease(), now: NOW });
    expect(verdict.capability.complete, reason).toBe(true);
    expect(verdict.window.allowed, reason).toBe(false);
    expect(verdict.window.reasons.join(' '), reason).toMatch(/ready|review|doing|blocked/);
  }
});

test('window: the one named deployment lease is the only holder allowed, and only while alive and matching', () => {
  const allowed = evaluatePreflight({ summary: summary({ doing: 1 }), pages: [page(cleanRows())], extras, deployment: lease(), now: NOW });
  expect(allowed.window).toMatchObject({ allowed: true, admittedLease: lease() });

  const mismatches: Array<[string, DeploymentLease]> = [
    ['wrong holder', lease({ holder: 'e-other' })],
    ['wrong fence', lease({ fence: 99 })],
    ['wrong version', lease({ version: 99 })],
    ['expired', lease({ expiresAt: later(-10) })],
    ['near expiry', lease({ expiresAt: later(60) })],
  ];
  for (const [reason, named] of mismatches) {
    const verdict = evaluatePreflight({ summary: summary({ doing: 1 }), pages: [page(cleanRows())], extras, deployment: named, now: NOW });
    expect(verdict.window.allowed, reason).toBe(false);
  }
  // Without the named lease, the doing holder is refused.
  const unnamed = evaluatePreflight({ summary: summary({ doing: 1 }), pages: [page(cleanRows())], extras, now: NOW });
  expect(unnamed.window.allowed).toBe(false);
});

test('window: session-creating paths without a task lease must be known and zero', () => {
  const unknown = evaluatePreflight({ summary: summary({ doing: 1 }), pages: [page(cleanRows())], extras: { triageGoals: null, pendingEvals: 0, gmAttention: 0 }, deployment: lease(), now: NOW });
  expect(unknown.window.allowed).toBe(false);
  expect(unknown.window.reasons.join(' ')).toMatch(/triageGoals is unknown/);
  for (const key of ['triageGoals', 'pendingEvals', 'gmAttention'] as const) {
    const verdict = evaluatePreflight({ summary: summary({ doing: 1 }), pages: [page(cleanRows())], extras: { ...extras, [key]: 1 }, deployment: lease(), now: NOW });
    expect(verdict.window.allowed, key).toBe(false);
    expect(verdict.window.reasons.join(' ')).toContain(key);
  }
});
