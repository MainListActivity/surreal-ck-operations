// v2 manifest + v4 Magpie evidence: parse/eligibility invariants, digest binding and the
// structural refusals that keep a tampered or drifting snapshot from becoming a candidate.
import { describe, expect, test } from 'bun:test';
import {
  PROOF_GOAL, MAGPIE_EXECUTION_HEADROOM_SECONDS, configurationDigest, evidenceSchema,
  magpieEvidenceEligible, magpieRouteDigest, manifestV2Schema, sha256, tokenPlanEvidenceV3Schema,
} from '../src/ops/proof-contract.ts';

const sampled = Date.parse('2026-10-28T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const routable = [{ model: 'sn-sensenova-6-8-flash', provider: 'sensenova' }];
const hash = (value: string) => sha256(value);
const source = (name: 'catalog' | 'quotas' | 'usage' | 'providers') => ({
  name, kind: name === 'providers' ? 'local-config' as const : 'http' as const,
  locator: name === 'providers' ? 'config:magpie/providers.json' : `http://127.0.0.1:3425/v1/${name}`,
  status: 200, capturedAt: iso(sampled), httpDate: name === 'providers' ? null : iso(sampled - (sampled % 1000)),
  clockSkewMs: name === 'providers' ? null : sampled % 1000, ageSeconds: null, cacheControl: null,
  rawSha256: hash(name), bodyBytes: 100, readAt: name === 'quotas' ? iso(sampled) : null,
});
function document(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4, type: 'magpie-controlled-route', evidenceClass: 'controlled-route-snapshot',
    accountRef: 'mgp' + 'a'.repeat(24), endpoint: 'http://127.0.0.1:3425/v1', priceRevision: 'magpie-catalog-abc123456789',
    sampledAt: iso(sampled), expiresAt: iso(sampled + 6_000_000), serviceApproved: true,
    account: { provider: 'sensenova', accountHash: hash('account'), identityHash: hash('identity'), binding: 'company-sealed-account', ownership: 'company-sealed-account', source: 'magpie-quotas' },
    endpointBinding: { source: 'injected', loopback: true },
    route: {
      group: 'group/work', revision: null, revisionSource: 'not-exposed', digest: magpieRouteDigest(routable),
      digestAlgorithm: 'canonical-json/1', routable, servedModel: 'sn-sensenova-6-8-flash',
      servedModelSource: 'magpie-usage-requests', association: 'served-model-in-approved-routable-set', observedAt: iso(sampled - 60_000),
    },
    snapshot: { id: 'magpie-controlled-snapshot/1', capturedAt: iso(sampled), maxAgeSeconds: 7_200, invalidatesOn: ['route-digest-change', 'account-change', 'price-revision-change', 'quota-reset'] },
    sources: [source('catalog'), source('quotas'), source('usage'), source('providers')],
    subscription: {
      provider: 'sensenova', kind: 'subscription', until: iso(sampled + 30 * 86_400_000), renew: 'monthly', readAt: iso(sampled),
      windows: [{ name: '5h', remainingPct: 42, resetsAt: iso(sampled + 3 * 3_600_000), limit: 100, amount: 100, unit: 'percent', unlimited: false }],
    },
    balance: { absoluteAmount: null, unit: null, source: 'magpie-percentage-windows', disclosure: 'percentages are not an absolute balance' },
    usage: {
      requestId: 'resp-1', runId: 'run-1', provider: 'sensenova', servedModel: 'sn-sensenova-6-8-flash', at: iso(sampled - 60_000),
      providerKeyIdHash: null,
      usage: { input: 50, output: 8, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 58 },
      cost: 0.000_012, costUnknown: false, priced: true,
    },
    pricing: {
      priceRevision: 'magpie-catalog-abc123456789', source: 'magpie-catalog', reviewed: true, free: false, freeEvidence: 'none',
      inputPerToken: 0.000_000_5, outputPerToken: 0.000_001_5, currency: 'USD',
      subscriptionCost: { disclosed: false }, marginalCost: { unitInput: 0.000_000_5, unitOutput: 0.000_001_5 },
    },
    approvalReadiness: { ready: true, blockedReasons: [] },
    ...overrides,
  };
}
function manifest(overrides: Record<string, unknown> = {}) {
  const rest = {
    schemaVersion: 2 as const, goalId: PROOF_GOAL, project: 'surreal_ck' as const, env: 'production' as const,
    activityId: 'activity1', workspaceSlug: 'demo', documentHash: hash('doc'),
    service: { kind: 'magpie-route' as const, accountRef: 'mgp' + 'a'.repeat(24), endpoint: 'http://127.0.0.1:3425/v1', routeId: 'group/work' as const, routeDigest: magpieRouteDigest(routable), priceRevision: 'magpie-catalog-abc123456789' },
    budget: { currency: 'USD' as const, totalNanoUsd: 1_000_000_000, perAttemptNanoUsd: 100_000_000, maxAttempts: 30, autoTopupDisabled: true as const },
    identities: [{ alias: 'LCA04_REMOVABLE' as const, workspaceRole: 'admin' as const, billingRole: 'owner' as const }, { alias: 'LCA04_MEMBER' as const, workspaceRole: 'participant' as const, billingRole: 'member' as const }],
    ...overrides,
  };
  return { ...rest, configurationDigest: configurationDigest(rest as never) };
}

describe('magpie manifest v2', () => {
  test('accepts a loopback route binding and rejects remote, portless, query or foreign-route endpoints', () => {
    expect(manifestV2Schema.safeParse(manifest()).success).toBe(true);
    for (const endpoint of ['https://api.example.com/v1', 'http://127.0.0.1/v1', 'http://127.0.0.1:3425/v1?x=1', 'http://user:pass@127.0.0.1:3425/v1', 'http://127.0.0.1:3425/other']) {
      expect(manifestV2Schema.safeParse(manifest({ service: { ...manifest().service, endpoint } })).success).toBe(false);
    }
    expect(manifestV2Schema.safeParse(manifest({ service: { ...manifest().service, routeId: 'group/fast' } })).success).toBe(false);
    expect(manifestV2Schema.safeParse(manifest({ budget: { ...manifest().budget, maxAttempts: 31 } })).success).toBe(false);
    expect(manifestV2Schema.safeParse(manifest({ extra: true })).success).toBe(false);
  });

  test('the configuration digest covers the route digest, so a route change invalidates the candidate', () => {
    const base = manifest();
    const changed = manifest({ service: { ...base.service, routeDigest: magpieRouteDigest([{ model: 'other-model', provider: 'sensenova' }]) } });
    expect(changed.configurationDigest).not.toBe(base.configurationDigest);
  });
});

describe('magpie evidence v4', () => {
  test('a complete, reviewed, bound snapshot parses and is eligible', () => {
    const parse = evidenceSchema.safeParse(document());
    expect(parse.success).toBe(true);
    if (!parse.success) return;
    expect(magpieEvidenceEligible(parse.data as never, sampled + 1_000)).toBe(true);
  });

  test('unreviewed pricing and partial account evidence parse but are not eligible', () => {
    const unreviewed = evidenceSchema.safeParse(document({ pricing: { ...document().pricing, reviewed: false }, approvalReadiness: { ready: false, blockedReasons: ['price-not-reviewed'] } }));
    expect(unreviewed.success).toBe(true);
    if (unreviewed.success) expect(magpieEvidenceEligible(unreviewed.data as never, sampled + 1_000)).toBe(false);

    const unbound = evidenceSchema.safeParse(document({
      account: { ...document().account, binding: 'unverified', ownership: 'unknown' },
      approvalReadiness: { ready: false, blockedReasons: ['account-ownership'] },
    }));
    expect(unbound.success).toBe(true);
    if (unbound.success) expect(magpieEvidenceEligible(unbound.data as never, sampled + 1_000)).toBe(false);
  });

  test('unknown cost stays null/costUnknown and unpriced evidence is still parseable', () => {
    const parse = evidenceSchema.safeParse(document({ usage: { ...document().usage, cost: null, costUnknown: true, priced: false } }));
    expect(parse.success).toBe(true);
    if (parse.success) expect(magpieEvidenceEligible(parse.data as never, sampled + 1_000)).toBe(true);
    expect(evidenceSchema.safeParse(document({ usage: { ...document().usage, cost: null, costUnknown: false, priced: false } })).success).toBe(false);
  });

  test('route tampering, duplicate routable models and a stale or mismatched price revision fail the schema', () => {
    const digest = document();
    digest.route.digest = hash('tampered');
    expect(evidenceSchema.safeParse(digest).success).toBe(false);

    const duplicate = document();
    duplicate.route.routable = [...routable, ...routable];
    expect(evidenceSchema.safeParse(duplicate).success).toBe(false);

    const foreign = document();
    foreign.route.servedModel = 'outside-the-set';
    expect(evidenceSchema.safeParse(foreign).success).toBe(false);

    const price = document();
    price.priceRevision = 'some-other-revision';
    expect(evidenceSchema.safeParse(price).success).toBe(false);

    const freeClaim = document({ pricing: { ...document().pricing, free: true } });
    expect(evidenceSchema.safeParse(freeClaim).success).toBe(false);
  });

  test('eligibility rejects provider drift, short headroom, stale usage and a passed reset window', () => {
    const drift = document();
    drift.route.routable = [{ model: 'sn-sensenova-6-8-flash', provider: 'other' }];
    drift.route.digest = magpieRouteDigest(drift.route.routable);
    const drifted = evidenceSchema.safeParse(drift);
    expect(drifted.success).toBe(true);
    if (drifted.success) expect(magpieEvidenceEligible(drifted.data as never, sampled + 1_000)).toBe(false);

    const short = evidenceSchema.safeParse(document({ expiresAt: iso(sampled + (MAGPIE_EXECUTION_HEADROOM_SECONDS - 60) * 1000) }));
    expect(short.success).toBe(true);
    if (short.success) expect(magpieEvidenceEligible(short.data as never, sampled + 1_000)).toBe(false);

    const stale = evidenceSchema.safeParse(document({ usage: { ...document().usage, at: iso(sampled - 7_201_000) } }));
    expect(stale.success).toBe(true);
    if (stale.success) expect(magpieEvidenceEligible(stale.data as never, sampled + 1_000)).toBe(false);

    // Evidence may not outlive a known quota reset or the subscription until.
    const outlives = document({ subscription: { ...document().subscription, windows: [{ ...document().subscription.windows[0], resetsAt: iso(sampled + 1_500_000) }] } });
    expect(evidenceSchema.safeParse(outlives).success).toBe(false);
  });

  test('v4 and v3 are distinct contract versions; a v3 document cannot pose as a route snapshot', () => {
    expect(tokenPlanEvidenceV3Schema.safeParse(document()).success).toBe(false);
    const v4 = document({ type: 'reviewed-token-plan', evidenceClass: 'promotional-account-bound' });
    expect(evidenceSchema.safeParse(v4).success).toBe(false);
  });
});
