// remote-magpie-evidence/1: the product's remote-magpie candidate and its window check. The candidate is
// built from the read-only observation only. Facts the remote does not state stay null with a gap, the
// price needs an independent approval for the same configuration digest, the evidence keeps 5400s of
// headroom, and an expired candidate can only be replaced by a new observation.
import { expect, test } from 'bun:test';
import { buildRemoteMagpieCandidate, remoteMagpieEvidenceSchema, remoteMagpieWindow, remoteConfigurationDigest, type PriceApproval, type RemoteMagpieEvidence, type TrustedRecord } from '../src/ops/remote-magpie-evidence.ts';
import type { ProductMagpieObservation } from '../src/ops/product-magpie.ts';
import { MAGPIE_EXECUTION_HEADROOM_SECONDS } from '../src/ops/proof-contract.ts';

const NOW = Date.parse('2026-10-29T03:00:00Z');
const BUDGET = { currency: 'USD' as const, totalNanoUsd: 5_000_000, perAttemptNanoUsd: 500_000, maxAttempts: 3 };
const ACCOUNT = 'mgp' + 'a'.repeat(24);

// A bare observation as the remote reports it: no revision, digest or expiry on the route.
function observation(patch: Partial<ProductMagpieObservation> = {}, usagePatch: Record<string, unknown> = {}): ProductMagpieObservation {
  const capturedAt = new Date(NOW).toISOString();
  const usageRow = {
    requestId: 'req-1', routeId: '123', at: '2026-10-29T02:59:00Z', requestedModel: 'group/work', servedModel: 'deepseek', provider: 'sn',
    accountRef: ACCOUNT, accountBinding: ACCOUNT, completed: true, status: 200, stop: 'stop', durationMs: 2000,
    usage: { input: 500, output: 50, cacheRead: null, cacheWrite: null, reasoning: null },
    cost: null, costUnknown: true,
    pricing: { rawPrompt: '0', rawCompletion: '0', inputPerToken: 0, outputPerToken: 0, free: true, reviewed: false },
    ...usagePatch,
  };
  return {
    version: 'product-magpie-observation/1', status: 'observed',
    source: { kind: 'configured-remote-magpie', endpoint: 'https://remote.test/ofm/v1', model: 'remote-magpie/group/work', gatewayModel: 'group/work', executionHost: 'remote' },
    capturedAt,
    route: { present: true, configurationModified: false, revision: null, digest: null, servedModel: 'deepseek', maxOutputTokens: null, sampledAt: '2026-10-29T02:59:00Z', expiresAt: null,
      gaps: [{ field: 'revision', reason: 'unstated' }, { field: 'digest', reason: 'unstated' }, { field: 'maxOutputTokens', reason: 'unstated' }, { field: 'expiresAt', reason: 'unstated' }] },
    usage: [usageRow],
    accounts: [{ provider: 'sn', accountRef: ACCOUNT, kind: 'subscription', readAt: capturedAt, windows: [{ name: 'daily', remainingPct: 50, resetsAt: '2026-10-30T00:00:00Z' }] }],
    receipts: [],
    executionBounds: { modelMaxOutputTokens: null, windowContractMaxOutputTokens: 65536, proposedRequestMaxOutputTokens: null, requiresApprovedWindow: true, enforcement: 'x' },
    observationSnapshot: { capturedAt, digest: 'd'.repeat(64), maxAgeSeconds: 7200, freshnessExpiresAt: new Date(NOW + 7200_000).toISOString(), expiryBasis: 'local-observation-freshness-policy', routingConfigurationVerified: false },
    coverage: { period: '7d', filter: { field: 'q', value: 'group/work', exactRequestedModel: 'group/work' }, rowsRead: 1, matchingRows: 1, rowsReturned: 1, truncated: false, rowsTruncated: false, total: 1, complete: true, pages: 1, stoppedReason: 'end-of-window', scannedOffset: [0, 1], requestCount: 3, bounds: { pageSize: 200, maxPages: 5, maxRows: 1000, maxBytes: 4194304, budgetMs: 12000 }, routeFieldsComplete: false },
    authorization: { executable: false, newBudgetGranted: false, configurationChangeRequired: false },
    nextAction: 'x',
    ...patch,
  } as unknown as ProductMagpieObservation;
}

// Each candidate is built from one observation; window checks receive that same observation as the trusted copy.
// Keyed by the observation snapshot digest, as the broker stores it. An edited candidate keeps that field,
// so it still resolves to the trusted observation and must be refused on the field that changed.
const trusted = new Map<string, TrustedRecord>();
const candidate = (patch: Partial<ProductMagpieObservation> = {}, budget: typeof BUDGET | null = BUDGET, usagePatch: Record<string, unknown> = {}, author = 'engineering-1') => {
  const o = observation(patch, usagePatch);
  const c = buildRemoteMagpieCandidate({ observation: o, author, budget });
  // The record stands for the broker's own copy: the observation and the employee who generated the candidate.
  trusted.set(o.observationSnapshot.digest, { observation: o, author });
  return c;
};
// The trusted observation is found through the digest an edited copy still carries. An edit that changes
// the body fails on candidate-digest-mismatch or on the rebuilt-from-observation check.
const windowOf = (c: RemoteMagpieEvidence, input: { approvalTask: string; now: number; approvals: PriceApproval[] }) =>
  remoteMagpieWindow(c, { ...input, trusted: trusted.get(c.observation.digest) });

const approvalFor = (c: { configurationDigest: string; pricing: { priceRevision: string | null } }, approver = 'qa-1'): PriceApproval =>
  ({ approverEmployee: approver, configurationDigest: c.configurationDigest, priceRevision: c.pricing.priceRevision!, approvedAt: '2026-10-29T02:50:00Z' });

test('null facts with gaps pass the candidate schema, and the digest covers the whole body', () => {
  const c = candidate();
  expect(remoteMagpieEvidenceSchema.safeParse(c).success).toBe(true);
  expect(c.route).toMatchObject({ revision: null, digest: null, expiresAt: null });
  expect(c.route.gaps.map(g => g.field)).toEqual(['revision', 'digest', 'maxOutputTokens', 'expiresAt']);
  expect(c.observation.routingConfigurationVerified).toBe(false);
  expect(c.expiry.basis).toBe('local-observation-freshness-policy');
  const { configurationDigest, ...body } = c;
  expect(remoteConfigurationDigest(body)).toBe(configurationDigest);
});

test('a candidate that asserts a revision, digest or expiry the remote never stated is rejected', () => {
  const c = candidate();
  for (const forged of [{ ...c, route: { ...c.route, revision: 'r-forged' } }, { ...c, route: { ...c.route, digest: 'a'.repeat(64) } }, { ...c, route: { ...c.route, expiresAt: '2030-01-01T00:00:00Z' } }]) {
    expect(remoteMagpieEvidenceSchema.safeParse(forged).success).toBe(true);
    const { configurationDigest, ...body } = forged;
    expect(remoteConfigurationDigest(body)).not.toBe(configurationDigest);
    expect(windowOf(forged, { approvalTask: 't', now: NOW, approvals: [approvalFor(c)] }).blockedReasons).toContain('candidate-digest-mismatch');
  }
});

test('an unreviewed price keeps the window closed until a different employee approves the same digest', () => {
  const c = candidate();
  expect(windowOf(c, { approvalTask: 't', now: NOW, approvals: [] }).blockedReasons).toEqual(['price-not-reviewed']);
  const selfApproved = approvalFor(c, c.author);
  expect(windowOf(c, { approvalTask: 't', now: NOW, approvals: [selfApproved] }).blockedReasons).toEqual(['price-not-reviewed']);
  const otherDigest = { ...approvalFor(c), configurationDigest: 'b'.repeat(64) };
  expect(windowOf(c, { approvalTask: 't', now: NOW, approvals: [otherDigest] }).blockedReasons).toEqual(['price-not-reviewed']);
  const window = windowOf(c, { approvalTask: 'approval-1', now: NOW, approvals: [approvalFor(c)] });
  expect(window.eligible).toBe(true);
  expect(window.window).toMatchObject({ approvalTask: 'approval-1', configurationDigest: c.configurationDigest, minRemainingSeconds: MAGPIE_EXECUTION_HEADROOM_SECONDS });
});

test('a missing price stays null and is never written as zero', () => {
  const c = candidate({}, BUDGET, { pricing: { rawPrompt: null, rawCompletion: null, inputPerToken: null, outputPerToken: null, free: false, reviewed: false } });
  expect(c.pricing).toMatchObject({ priceRevision: null, rawPrompt: null, rawCompletion: null, free: false, freeEvidence: 'none' });
  expect(c.gaps.some(g => g.field === 'pricing')).toBe(true);
  expect(windowOf(c, { approvalTask: 't', now: NOW, approvals: [] }).blockedReasons).toContain('price-missing');
});

test('verified zero prices are recorded as remote-catalog-zero, distinct from unknown', () => {
  const c = candidate();
  expect(c.pricing).toMatchObject({ rawPrompt: '0', rawCompletion: '0', free: true, freeEvidence: 'remote-catalog-zero' });
});

test('evidence expiry is the earliest of the freshness policy and a source expiry, and never later than the freshness window', () => {
  const c = candidate({
    route: { present: true, configurationModified: false, revision: null, digest: null, servedModel: 'deepseek', maxOutputTokens: null, sampledAt: '2026-10-29T02:59:00Z', expiresAt: '2026-10-29T03:30:00Z', gaps: [] },
  } as Partial<ProductMagpieObservation>);
  expect(c.expiry.expiresAt).toBe('2026-10-29T03:30:00Z');
  expect(c.expiry.localFreshnessExpiresAt).toBe(new Date(NOW + 7200_000).toISOString());
  expect(c.expiry.sourceExpiresAt).toContain('2026-10-29T03:30:00Z');
  expect(c.expiry.expiresAt).not.toBe(new Date(NOW + 7200_000).toISOString());
});

test('execution headroom: evidence with less than 5400s left is closed, not extended', () => {
  const c = candidate();
  const tight = windowOf({ ...c, expiry: { ...c.expiry, expiresAt: new Date(NOW + (MAGPIE_EXECUTION_HEADROOM_SECONDS - 1) * 1000).toISOString() } }, { approvalTask: 't', now: NOW, approvals: [approvalFor(c)] });
  expect(tight.eligible).toBe(false);
  expect(tight.blockedReasons).toContain('insufficient-headroom');
});

test('an expired candidate is refused, and a window never extends it', () => {
  const c = candidate();
  const expired = windowOf(c, { approvalTask: 't', now: Date.parse(c.expiry.expiresAt) + 1, approvals: [approvalFor(c)] });
  expect(expired.eligible).toBe(false);
  expect(expired.blockedReasons).toContain('evidence-expired');
});

test('a window notAfter is exactly expiresAt minus the execution headroom', () => {
  const c = candidate();
  const window = windowOf(c, { approvalTask: 't', now: NOW, approvals: [approvalFor(c)] }).window!;
  expect(Date.parse(window.notAfter)).toBe(Date.parse(c.expiry.expiresAt) - MAGPIE_EXECUTION_HEADROOM_SECONDS * 1000);
});

test('a missing sampling budget keeps the window closed', () => {
  const c = candidate({}, null);
  expect(c.gaps.some(g => g.field === 'budget')).toBe(true);
  expect(windowOf(c, { approvalTask: 't', now: NOW, approvals: [approvalFor(c)] }).blockedReasons).toContain('budget-missing');
});

test('the budget envelope is recorded as supplied, never read from an earlier cycle', () => {
  const c = candidate({}, { ...BUDGET, maxAttempts: 2 });
  expect(c.budget).toEqual({ ...BUDGET, maxAttempts: 2 });
  expect(c.budget?.maxAttempts).not.toBe(30);
});

test('an unbound account (several accounts or no identity) is recorded as unknown, not borrowed', () => {
  const other = 'mgp' + 'b'.repeat(24);
  const obs = observation({ usage: [
    { ...observation().usage[0], accountRef: ACCOUNT, accountBinding: ACCOUNT },
    { ...observation().usage[0], accountRef: other, accountBinding: other },
  ] } as Partial<ProductMagpieObservation>);
  const two = buildRemoteMagpieCandidate({ observation: obs, author: 'engineering-1', budget: BUDGET });
  expect(two.accountRef).toBeNull();
  expect(two.accountBinding).toBe('unknown');
  expect(windowOf(two, { approvalTask: 't', now: NOW, approvals: [approvalFor(two)] }).blockedReasons).toContain('account-unbound');
});

test('a candidate never becomes eligible from the 30-attempt cycle or an old approval', () => {
  const c = candidate();
  const legacyApproval = { ...approvalFor(c), approvedAt: '2026-10-01T00:00:00Z', configurationDigest: 'c'.repeat(64) };
  expect(windowOf(c, { approvalTask: 't', now: NOW, approvals: [legacyApproval] }).blockedReasons).toEqual(['price-not-reviewed']);
});

// Recomputing the digest after an edit is public (remoteConfigurationDigest is exported), so the digest alone
// proves nothing. These cases edit a field, recompute the digest, and add a second employee's approval. The
// window must still refuse, and it must name the field that no longer matches the trusted observation.
const recomputed = <T extends RemoteMagpieEvidence>(edited: T): T => {
  const { configurationDigest: _old, ...body } = edited;
  return { ...edited, configurationDigest: remoteConfigurationDigest(body) };
};

test('an expiry moved to the next day with a recomputed digest and a synthetic second approval stays closed', () => {
  const c = candidate();
  const forgedExpiry = recomputed({ ...c, expiry: { ...c.expiry, expiresAt: '2026-10-30T03:00:00.000Z', sourceExpiresAt: [...c.expiry.sourceExpiresAt, '2026-10-30T03:00:00.000Z'] } });
  expect(remoteMagpieEvidenceSchema.safeParse(forgedExpiry).success).toBe(true);
  const approval = { ...approvalFor(c, 'qa-2') };
  const result = windowOf(forgedExpiry, { approvalTask: 't', now: NOW, approvals: [approval] });
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('expiry-not-from-observation');
  expect(result.blockedReasons).not.toContain('candidate-digest-mismatch');
  expect(result.window).toBeUndefined();
});

test('a null route with a forged revision, digest and expiry, recomputed, and a second approval stays closed', () => {
  const c = candidate();
  const forgedRoute = recomputed({ ...c, route: { ...c.route, revision: 'r-forged', digest: 'a'.repeat(64), expiresAt: '2030-01-01T00:00:00.000Z', gaps: [] } });
  expect(remoteMagpieEvidenceSchema.safeParse(forgedRoute).success).toBe(true);
  const result = windowOf(forgedRoute, { approvalTask: 't', now: NOW, approvals: [approvalFor(c, 'qa-2')] });
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('route-not-from-observation');
  expect(result.blockedReasons).not.toContain('candidate-digest-mismatch');
});

test('a candidate with no trusted observation behind it is refused, even when its digest is valid', () => {
  const c = candidate();
  const result = remoteMagpieWindow(c, { approvalTask: 't', now: NOW, approvals: [approvalFor(c)], trusted: undefined });
  expect(result.eligible).toBe(false);
  // Without a trusted author no approval can count as independent, so the price gate also stays closed.
  expect(result.blockedReasons).toContain('observation-untrusted');
  expect(result.blockedReasons).toContain('price-not-reviewed');
});

test('price approval never authorises a changed observation field', () => {
  const c = candidate();
  const forged = recomputed({ ...c, pricing: { ...c.pricing, rawPrompt: '0.000001', priceRevision: 'remote-magpie-catalog-forged' } });
  const result = windowOf(forged, { approvalTask: 't', now: NOW, approvals: [approvalFor(forged, 'qa-2')] });
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('candidate-not-from-observation');
});

test('a legitimate null+gap candidate with a real observation still passes', () => {
  const c = candidate();
  const result = windowOf(c, { approvalTask: 'approval-1', now: NOW, approvals: [approvalFor(c)] });
  expect(result.eligible).toBe(true);
});

// The author is part of the trusted record, not of the candidate file. Editing it and recomputing the public
// digest must not let the original author approve their own price under another name.
test('an author edited to another employee and re-digested is refused, and the original author cannot self-approve it', () => {
  const c = candidate({}, BUDGET, {}, 'engineering-1');
  const edited = recomputed({ ...c, author: 'engineering-2' });
  // An approval from the edited author would look independent of the file, but the trusted author is engineering-1.
  const forgedApproval = approvalFor(edited, 'engineering-1');
  const result = windowOf(edited, { approvalTask: 't', now: NOW, approvals: [forgedApproval] });
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('candidate-author-mismatch');
  expect(result.blockedReasons).not.toContain('candidate-digest-mismatch');
  expect(result.window).toBeUndefined();
});

test('the original author cannot approve their own unedited candidate, and the window stays price-not-reviewed', () => {
  const c = candidate({}, BUDGET, {}, 'engineering-1');
  const result = windowOf(c, { approvalTask: 't', now: NOW, approvals: [approvalFor(c, 'engineering-1')] });
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toEqual(['price-not-reviewed']);
});

test('a second employee approval still opens the window for an unedited candidate', () => {
  const c = candidate({}, BUDGET, {}, 'engineering-1');
  const result = windowOf(c, { approvalTask: 't', now: NOW, approvals: [approvalFor(c, 'qa-1')] });
  expect(result.eligible).toBe(true);
});
