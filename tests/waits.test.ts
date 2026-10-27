/**
 * SYS05 · The pure wait rules (AC01/AC02/AC04/AC05).
 *
 * These tests never touch a database: they pin the arithmetic and the trust rules that the store and the
 * dispatcher both rely on. The persistence and real core paths are covered by tests/wait-store.fork.test.ts and
 * tests/wait-dispatch.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { CompanyError } from '../src/core-errors.ts';
import {
  DEPENDENCY_KINDS, assertNonSensitive, decideRelease, displayInZone, handoffCard, handoffNoticeKey, migrationPreview,
  normalizeWait, parseInstant, signWaitWebhook, timeConditionDue, validateEvent, verifyWaitWebhook, waitEventKey,
  waitRisk, webhookPayload, type WaitEvent, type WaitInput, type WaitRecord,
} from '../src/waits.ts';

const NOW = Date.parse('2026-10-26T12:00:00+08:00');
const HOUR = 3_600_000;

const wait = (over: Partial<WaitRecord> = {}): WaitRecord => ({
  waitKey: 'task-1:abc', taskId: 'task-1', kind: 'time', state: 'waiting', source: { kind: 'time' },
  ownerRole: 'engineering', expiresSource: 'unknown', progress: { employee: 'e1', taskVersion: 3, at: NOW - HOUR },
  completed: [], reason: '等待上游确认', version: 1, enteredAt: NOW - HOUR, ...over,
});

const base: WaitInput = { kind: 'time', reason: '等到供应商窗口开放后再继续', notBefore: '2026-10-26T13:00:00+08:00' };
const normalize = (over: Partial<WaitInput>) => normalizeWait({ ...base, ...over }, { now: NOW, ownerRole: 'engineering' });

function refused(run: () => unknown, code: CompanyError['code'], pattern: RegExp) {
  const error = (() => { try { run(); return undefined; } catch (reason) { return reason; } })();
  expect(error).toBeInstanceOf(CompanyError);
  expect((error as CompanyError).code).toBe(code);
  expect((error as CompanyError).message).toMatch(pattern);
}

describe('absolute time (AC01)', () => {
  test('an instant without an explicit offset is refused instead of read in the host zone', () => {
    refused(() => parseInstant('2026-10-26T13:00:00', 'notBefore'), 'invalid', /时区偏移/);
    refused(() => parseInstant('2026-10-26 13:00', 'notBefore'), 'invalid', /时区偏移/);
  });

  test('Z and a numeric offset are absolute instants; a timezone is display only', () => {
    expect(parseInstant('2026-10-26T05:00:00Z', 'notBefore')).toBe(Date.parse('2026-10-26T05:00:00Z'));
    expect(parseInstant('2026-10-26T13:00:00+08:00', 'notBefore')).toBe(Date.parse('2026-10-26T05:00:00Z'));
    expect(displayInZone(Date.parse('2026-10-26T05:00:00Z'), 'Asia/Shanghai')).toContain('13:00');
  });

  test('a daylight-saving transition does not move the instant', () => {
    // US spring forward on 2026-03-08: 02:30 EST and 03:30 EDT are the same absolute instant. Both spellings must
    // produce one instant, so a tick on either side of the transition cannot fire an hour early or late.
    const est = parseInstant('2026-03-08T02:30:00-05:00', 'notBefore');
    const edt = parseInstant('2026-03-08T03:30:00-04:00', 'notBefore');
    expect(est).toBe(edt);
    expect(displayInZone(est, 'America/New_York')).toContain('03:30');
    // Fall back on 2026-11-01: the same wall clock appears twice; the explicit offset selects the instant.
    expect(parseInstant('2026-11-01T01:30:00-04:00', 'notBefore'))
      .toBe(parseInstant('2026-11-01T01:30:00-04:00', 'notBefore'));
    expect(parseInstant('2026-11-01T01:30:00-04:00', 'notBefore'))
      .not.toBe(parseInstant('2026-11-01T01:30:00-05:00', 'notBefore'));
  });

  test('notBefore is strict: one millisecond early is not due, the exact instant is', () => {
    const notBefore = NOW + 10 * 60_000;
    expect(timeConditionDue(notBefore, notBefore - 1)).toBe(false);
    expect(timeConditionDue(notBefore, notBefore)).toBe(true);
    expect(timeConditionDue(undefined, notBefore + 1)).toBe(false);
  });

  test('a time wait must be in the future and an expiry must be after notBefore', () => {
    refused(() => normalize({ notBefore: '2026-10-26T11:00:00+08:00' }), 'invalid', /不能早于现在/);
    refused(() => normalize({ expiresAt: '2026-10-26T12:30:00+08:00' }), 'invalid', /expiresAt 必须晚于 notBefore/);
  });

  test('a bad timezone is a refusal, not a silent UTC fallback', () => {
    refused(() => normalize({ timezone: '+08:00' }), 'invalid', /IANA/);
    expect(normalize({ timezone: 'Asia/Shanghai' }).timezone).toBe('Asia/Shanghai');
  });
});

describe('time releases time only (AC01/AC05)', () => {
  test('an early tick does not release', () => {
    const row = wait({ notBefore: NOW + 60_000 });
    const decision = decideRelease(row, NOW, { dependenciesSatisfied: true, ownerApproved: false, taskBlockedToOwner: false });
    expect(decision.release).toBe(false);
    expect(decision.code).toBe('early');
    expect(decision.nextAt).toBe(NOW + 60_000);
  });

  test('a due time still waits for an unfinished dependency', () => {
    const row = wait({ notBefore: NOW });
    const decision = decideRelease(row, NOW + 1, { dependenciesSatisfied: false, ownerApproved: false, taskBlockedToOwner: false });
    expect(decision.release).toBe(false);
    expect(decision.code).toBe('dependency');
  });

  test('a due time still waits for an owner gate', () => {
    const row = wait({ notBefore: NOW });
    const decision = decideRelease(row, NOW + 1, { dependenciesSatisfied: true, ownerApproved: false, taskBlockedToOwner: true });
    expect(decision.release).toBe(false);
    expect(decision.code).toBe('owner_gate');
  });

  test('a held wait is re-checked, not lost: it releases when its gates clear and stays held otherwise', () => {
    const row = wait({ state: 'held', notBefore: NOW });
    expect(decideRelease(row, NOW, { dependenciesSatisfied: true, ownerApproved: false, taskBlockedToOwner: false }))
      .toMatchObject({ release: true, code: 'released' });
    expect(decideRelease(row, NOW, { dependenciesSatisfied: false, ownerApproved: false, taskBlockedToOwner: false }))
      .toMatchObject({ release: false, code: 'dependency' });
  });

  test('a due time releases once the gates are clear, and the same facts answer the same way', () => {
    const row = wait({ notBefore: NOW });
    const gates = { dependenciesSatisfied: true, ownerApproved: false, taskBlockedToOwner: false };
    expect(decideRelease(row, NOW, gates)).toMatchObject({ release: true, code: 'released' });
    expect(decideRelease(row, NOW, gates)).toMatchObject({ release: true, code: 'released' });
  });
});

describe('external events (AC02)', () => {
  const activation = (over: Partial<WaitRecord> = {}) => wait({
    kind: 'customer_activation', source: { kind: 'webhook' }, ownerRole: 'gm',
    expiresAt: NOW + 24 * HOUR, expiresSource: 'exact', ...over,
  });
  const event = (over: Partial<WaitEvent> = {}): WaitEvent => ({
    source: 'webhook', provider: 'product', eventId: 'evt-1', at: NOW, verified: true,
    objectWaitId: 'task-1:abc', ...over,
  });

  test('without a typed event the wait stays parked', () => {
    const decision = decideRelease(activation(), NOW, { dependenciesSatisfied: true, ownerApproved: false, taskBlockedToOwner: false });
    expect(decision.release).toBe(false);
    expect(decision.code).toBe('awaiting_event');
  });

  test('a verified event releases; a duplicate event key is stable so the store can reject the replay', () => {
    const gates = { dependenciesSatisfied: true, ownerApproved: false, taskBlockedToOwner: false };
    const first = event();
    expect(decideRelease(activation(), NOW, gates, first)).toMatchObject({ release: true, code: 'released' });
    expect(waitEventKey('task-1:abc', first)).toBe(waitEventKey('task-1:abc', event()));
  });

  test('an event for another object is refused, not guessed at', () => {
    refused(() => validateEvent(activation(), { source: 'webhook', provider: 'product', eventId: 'x',
      objectTaskId: 'other-task', at: NOW }, NOW, { verified: true }), 'invalid', /不匹配/);
    refused(() => validateEvent(activation(), { source: 'webhook', provider: 'product', eventId: 'x', at: NOW },
      NOW, { verified: true }), 'invalid', /必须写明/);
  });

  test('an event after the precise expiry cannot release; an event on the exact expiry can', () => {
    const expired = activation({ expiresAt: NOW - 1 });
    const late = event({ at: NOW });
    expect(decideRelease(expired, NOW, { dependenciesSatisfied: true, ownerApproved: false, taskBlockedToOwner: false }, late))
      .toMatchObject({ release: false, code: 'expired' });
    refused(() => validateEvent(expired, { source: 'webhook', provider: 'product', eventId: 'x', at: NOW,
      objectWaitId: 'task-1:abc' }, NOW, { verified: true }), 'invalid', /到期之后/);
  });

  test('an unsigned webhook is refused', () => {
    refused(() => validateEvent(activation(), { source: 'webhook', provider: 'product', eventId: 'x', at: NOW,
      objectWaitId: 'task-1:abc' }, NOW, { verified: false }), 'invalid', /签名/);
    const payload = webhookPayload({ eventId: 'evt-1', provider: 'product', at: NOW, objectWaitId: 'task-1:abc' });
    const signature = signWaitWebhook('test-secret', payload);
    expect(verifyWaitWebhook('test-secret', payload, signature)).toBe(true);
    expect(verifyWaitWebhook('other-secret', payload, signature)).toBe(false);
    expect(verifyWaitWebhook(undefined, payload, signature)).toBe(false);
    expect(verifyWaitWebhook('test-secret', payload, 'not-hex')).toBe(false);
  });

  test('a time wait cannot be released by an event; cancel is the authorized path', () => {
    refused(() => validateEvent(wait(), { source: 'authorized_person', at: NOW, objectWaitId: 'task-1:abc' },
      NOW, { verified: true }), 'invalid', /时间等待/);
  });
});

describe('owner handoff (AC04)', () => {
  const handoff = (over: Partial<WaitRecord> = {}) => wait({
    kind: 'owner_handoff', source: { kind: 'owner' }, ownerRole: 'owner',
    completed: ['已生成邀请文件', '已核对域名'], pendingAction: '请老板把邀请链接转交客户', ...over,
  });

  test('the owner handoff is not released by a manager self-report, only by the owner relay', () => {
    const gates = { dependenciesSatisfied: true, ownerApproved: false, taskBlockedToOwner: false };
    expect(decideRelease(handoff(), NOW, gates)).toMatchObject({ release: false, code: 'owner_gate' });
    expect(decideRelease(handoff(), NOW, { ...gates, ownerApproved: true })).toMatchObject({ release: true });
  });

  test('a customer feedback event cannot resolve an owner handoff', () => {
    refused(() => validateEvent(handoff(), { source: 'webhook', provider: 'product', eventId: 'x', at: NOW,
      objectWaitId: 'task-1:abc' }, NOW, { verified: true }), 'invalid', /owner relay/);
    refused(() => validateEvent(handoff(), { source: 'authorized_person', at: NOW, objectWaitId: 'task-1:abc' },
      NOW, { verified: true }), 'invalid', /owner relay/);
  });

  test('the card presents who waits for whom and keeps an unknown expiry unknown', () => {
    const card = handoffCard(handoff(), '客户开通', 'cs', NOW);
    expect(card.expiresAt).toEqual({ source: 'unknown' });
    expect(card.completed).toEqual(['已生成邀请文件', '已核对域名']);
    expect(card.pendingAction).toContain('转交');
    expect(card.waitingOn).toBe('owner');
    expect(card.waitingBy).toBe('cs');
    expect(card.nextTrigger.join(' / ')).toContain('owner relay');
    expect(waitRisk(handoff(), NOW)).toBe('unknown');
  });

  test('the card never copies a secret-bearing link or the handoff file content', () => {
    const card = handoffCard(handoff({ handoffFile: '/secure/handoff/invite-abc.txt' }), '客户开通', 'cs', NOW);
    expect(card.handoffFileName).toBe('invite-abc.txt');
    expect(JSON.stringify(card)).not.toContain('/secure/handoff');
    expect(JSON.stringify(card)).not.toMatch(/https?:\/\//);
    refused(() => normalize({ kind: 'owner_handoff', completed: ['x'], pendingAction: '打开 https://x.test/activate?token=abc123def456ghi789' }),
      'invalid', /密钥|链接/);
  });

  test('an exact expiry drives the risk bucket; a reminder key is stable within one bucket', () => {
    const row = handoff({ expiresAt: NOW + 30 * 60_000, expiresSource: 'exact' });
    expect(waitRisk(row, NOW)).toBe('due_soon');
    expect(handoffNoticeKey(row, NOW)).toBe(handoffNoticeKey(row, NOW + 60_000));
    expect(waitRisk(row, NOW + HOUR)).toBe('overdue');
    expect(handoffNoticeKey(row, NOW + HOUR)).not.toBe(handoffNoticeKey(row, NOW));
  });
});

describe('dependencies and migration (AC02/AC05)', () => {
  test('a dependency wait releases only when its reference task is terminal', () => {
    const row = wait({ kind: 'dependency', source: { kind: 'dependency' }, referenceTaskId: 'repair-1' });
    const gates = { dependenciesSatisfied: true, ownerApproved: false, taskBlockedToOwner: false, referenceComplete: false };
    expect(decideRelease(row, NOW, gates)).toMatchObject({ release: false, code: 'dependency' });
    expect(decideRelease(row, NOW, { ...gates, referenceComplete: true })).toMatchObject({ release: true });
    expect(DEPENDENCY_KINDS.has('upstream_repair')).toBe(true);
  });

  test('a dependency wait needs a reference and refuses a self reference at normalization', () => {
    refused(() => normalizeWait({ kind: 'dependency', reason: '等待修复任务完成后再继续' }, { now: NOW, ownerRole: 'engineering' }),
      'invalid', /referenceTaskId/);
  });

  test('the migration preview never marks an owner gate eligible', () => {
    const rows = migrationPreview([
      { id: 'owner-gate', state: 'blocked', blocked_to: 'owner', quota_resets_at: NOW / 1000 + 3600 },
      { id: 'legacy-time', state: 'blocked', quota_resets_at: NOW / 1000 + 3600 },
      { id: 'waiting', state: 'blocked', wait_state: 'waiting' },
      { id: 'past', state: 'blocked', quota_resets_at: (NOW - HOUR) / 1000 },
    ], NOW);
    expect(rows.find(row => row.taskId === 'owner-gate')).toMatchObject({ eligible: false, reason: 'owner_gate' });
    expect(rows.find(row => row.taskId === 'legacy-time')).toMatchObject({ eligible: true });
    expect(rows.find(row => row.taskId === 'waiting')).toMatchObject({ eligible: false, reason: 'already_waiting' });
    expect(rows.find(row => row.taskId === 'past')).toMatchObject({ eligible: false, reason: 'not_time_bounded' });
  });
});

describe('non-sensitive storage (AC04)', () => {
  test('JWTs, provider tokens, signed links and high-entropy blobs are refused', () => {
    refused(() => assertNonSensitive('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlMTIzNDU2Nzg5MA', 'reference'),
      'invalid', /JWT|密钥/);
    refused(() => assertNonSensitive('ghp_abcdefghijklmnopqrstuvwxyz', 'reference'), 'invalid', /token|密钥/);
    refused(() => assertNonSensitive('https://app.test/invite?token=abc123def456ghi789', 'reference'), 'invalid', /密钥|链接/);
    expect(assertNonSensitive('ticket OPS-1234', 'reference')).toBe('ticket OPS-1234');
  });
});
