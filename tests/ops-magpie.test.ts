// ops_magpie_route_sample / ops_magpie_window_prepare: the controlled Magpie route snapshot and
// the execution-window proxy. The fake gateway serves only the loopback public surfaces
// (catalog, quota windows, historical usage) plus a providers.json whose unrelated secret field
// must never leave the sampler. No model is called and no provider credential is read as a value.
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import {
  PROOF_GOAL, MAGPIE_EXECUTION_HEADROOM_SECONDS, MAGPIE_SNAPSHOT_MAX_AGE_SECONDS,
  configurationDigest, evidenceSchema, magpieRouteDigest, manifestV1Schema, manifestV2Schema, sha256,
} from '../src/ops/proof-contract.ts';
import { loadProofFiles } from '../src/ops/proof-files.ts';
import { OpsBroker } from '../src/ops/broker.ts';
import { FakeCompany, FakeWorld, brokerConfig } from './support/ops-world.ts';

interface Rig { world: FakeWorld; company: FakeCompany; broker: OpsBroker; home: string; qa: string; outputs: unknown[] }

const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
const ALIAS = 'SNV_PROD';
const PURPOSE = 'internal-ai route evidence';

function rig(): Rig {
  const world = new FakeWorld();
  const company = new FakeCompany();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ops-magpie-')));
  homes.push(home);
  company.env('demo', 'production', brokerConfig(), { healthUrl: 'https://app.test/health' });
  const broker = new OpsBroker({
    core: company.core, projects: company.projects as never, secretKey: () => Buffer.alloc(32),
    fetch: world.fetch, now: world.now, d1: () => world.d1, queryAsUser: world.queryAsUser, browser: world.browser,
    serviceHome: home, sleep: async (ms) => { world.clock += ms; },
    magpie: { base: world.magpie.base, endpointSource: 'injected', readProviders: async () => JSON.stringify(world.magpie.providers) },
  });
  company.sealed.set(`demo/production/SUPPLIER_${ALIAS}_USERNAME`, world.magpie.accountUser);
  company.sealed.set(`demo/production/SUPPLIER_${ALIAS}_PASSWORD`, '{{SECRET_magpie_password}}');
  return { world, company, broker, home, qa: company.lease('qa-1', 'qa', 'task-1'), outputs: [] };
}
async function call(r: Rig, tool: string, args: Record<string, unknown> = {}) {
  const value = await r.broker.call(r.qa, 'task-1', tool, args);
  r.outputs.push(value);
  return value as Record<string, any>;
}
const sample = (r: Rig, args: Record<string, unknown> = {}) =>
  call(r, 'ops_magpie_route_sample', { alias: ALIAS, purpose: PURPOSE, ...args });

function v2Manifest(document: Record<string, any>, overrides: Partial<Record<string, unknown>> = {}) {
  const rest = {
    schemaVersion: 2 as const,
    goalId: PROOF_GOAL,
    project: 'surreal_ck' as const,
    env: 'production' as const,
    activityId: 'activity1',
    workspaceSlug: 'demo',
    documentHash: '0'.repeat(64),
    service: {
      kind: 'magpie-route' as const, accountRef: document.accountRef, endpoint: document.endpoint,
      routeId: 'group/work' as const, routeDigest: document.route.digest, priceRevision: document.priceRevision,
    },
    budget: { currency: 'USD' as const, totalNanoUsd: 1_000_000_000, perAttemptNanoUsd: 100_000_000, maxAttempts: 30, autoTopupDisabled: true as const },
    identities: [{ alias: 'LCA04_REMOVABLE' as const, workspaceRole: 'admin' as const, billingRole: 'owner' as const }, { alias: 'LCA04_MEMBER' as const, workspaceRole: 'participant' as const, billingRole: 'member' as const }],
    ...overrides,
  };
  return { ...rest, configurationDigest: configurationDigest(rest as never) };
}
function writeProof(r: Rig, manifest: Record<string, unknown>, document: Record<string, unknown>) {
  const dir = join(r.home, 'evidence', 'task-1');
  const docBytes = Buffer.from(JSON.stringify(document, null, 2) + '\n');
  const { configurationDigest: _digest, ...rest } = manifest;
  const bound = { ...rest, documentHash: sha256(docBytes) };
  const bytes = Buffer.from(JSON.stringify({ ...bound, configurationDigest: configurationDigest(bound as never) }, null, 2) + '\n');
  writeFileSync(join(dir, 'manifest.json'), bytes);
  writeFileSync(join(dir, 'evidence.json'), docBytes);
  return { manifestPath: join(dir, 'manifest.json'), documentPath: join(dir, 'evidence.json') };
}

describe('magpie controlled route snapshot', () => {
  test('a complete snapshot binds account, route digest, served model, usage request/run and leaves price unreviewed', async () => {
    const r = rig();
    const out = await sample(r);
    expect(out.status).toBe('sampled');
    expect(out.accountRef).toMatch(/^mgp[a-f0-9]{24}$/);
    const doc = out.document;
    expect(evidenceSchema.safeParse(doc).success).toBe(true);
    expect(doc.account.binding).toBe('company-sealed-account');
    expect(doc.account.ownership).toBe('company-sealed-account');
    expect(doc.route.group).toBe('group/work');
    expect(doc.route.servedModel).toBe('sn-sensenova-6-8-flash');
    expect(doc.route.routable).toEqual([{ model: 'sn-sensenova-6-8-flash', provider: 'sensenova' }]);
    expect(doc.route.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(doc.route.revisionSource).toBe('magpie-config-digest');
    expect(doc.usage.requestId).toBe('resp-magpie-1');
    expect(doc.usage.runId).toBe('run-magpie-1');
    expect(doc.usage.cost).toBe(0.000_012);
    expect(doc.usage.costUnknown).toBe(false);
    expect(doc.pricing.reviewed).toBe(false);
    expect(doc.pricing.inputPerToken).toBe(0.000_000_5);
    expect(doc.pricing.subscriptionCost.disclosed).toBe(false);
    expect(doc.approvalReadiness).toEqual({ ready: false, blockedReasons: ['price-not-reviewed'] });
    expect(out.receipt.route.digest).toBe(doc.route.digest);
    expect(existsSync(out.documentFile)).toBe(true);
    expect(readFileSync(out.documentFile, 'utf8')).toBe(JSON.stringify(doc, null, 2) + '\n');
    // Read-only: exactly the three gateway GETs, never a chat/completions call.
    expect(r.world.requests.filter(q => q.url.startsWith(r.world.magpie.base)).map(q => new URL(q.url).pathname).sort())
      .toEqual(['/v1/magpie/quotas', '/v1/magpie/usage/requests', '/v1/models']);
    expect(r.world.requests.some(q => /chat\/completions/.test(q.url))).toBe(false);
    expectNoMagpieLeaks(r);
  });

  test('unknown cost stays null and is never zero-filled', async () => {
    const r = rig();
    r.world.magpie.usagePriced = false;
    r.world.magpie.usageCost = null;
    const out = await sample(r);
    expect(out.status).toBe('sampled');
    expect(out.document.usage.cost).toBeNull();
    expect(out.document.usage.costUnknown).toBe(true);
    expect(out.receipt.pricing.costUnknown).toBe(true);
  });

  test('a free catalog needs zero-price evidence; vague free claims block', async () => {
    const r = rig();
    r.world.magpie.pricing = { input: 0, output: 0, currency: 'USD' };
    r.world.magpie.catalogFree = true;
    const out = await sample(r);
    expect(out.document.pricing.free).toBe(true);
    expect(out.document.pricing.freeEvidence).toBe('magpie-catalog-zero');
    const absent = rig();
    absent.world.magpie.pricing = null;
    const blocked = await sample(absent);
    expect(blocked.status).toBe('blocked');
    expect(blocked.gaps.map((g: any) => g.field)).toContain('price');
    expect(blocked.document).toBeUndefined();
  });

  test('wrong sealed account, route drift, missing usage, unclear price and expired/insufficient quota all block', async () => {
    const wrong = rig();
    wrong.company.sealed.set(`demo/production/SUPPLIER_${ALIAS}_USERNAME`, 'someone-else');
    expect((await sample(wrong)).gaps.map((g: any) => g.field)).toContain('accountBinding');

    const drift = rig();
    drift.world.magpie.usageModel = 'unapproved-model';
    const driftOut = await sample(drift);
    expect(driftOut.status).toBe('blocked');
    expect(driftOut.gaps.map((g: any) => g.field)).toContain('usage');

    const missing = rig();
    missing.world.magpie.usageStatus = 500;
    expect((await sample(missing)).gaps.map((g: any) => g.field)).toContain('usage');

    const freehand = rig();
    freehand.world.magpie.pricing = null;
    expect((await sample(freehand)).gaps.map((g: any) => g.field)).toContain('price');

    const expired = rig();
    expired.world.magpie.windows = [{ name: '5h', remaining: 20, resetsInMs: -1_000 }];
    expect((await sample(expired)).gaps.map((g: any) => g.field)).toContain('quotaExpired');

    const empty = rig();
    empty.world.magpie.windows = [{ name: '5h', remaining: 0, resetsInMs: 3_600_000 }];
    expect((await sample(empty)).gaps.map((g: any) => g.field)).toContain('quotaInsufficient');

    const stale = rig();
    stale.world.magpie.quotaReadAtSkewMs = (MAGPIE_SNAPSHOT_MAX_AGE_SECONDS + 1) * 1000;
    expect((await sample(stale)).gaps.map((g: any) => g.field)).toContain('staleBalance');

    const short = rig();
    short.world.magpie.quotaUntilInMs = 30 * 60_000;
    const shortOut = await sample(short);
    expect(shortOut.gaps.map((g: any) => g.field)).toContain('headroom');
    expect(shortOut.document).toBeUndefined();
  });
});

describe('magpie execution-window proxy', () => {
  const prepare = (r: Rig, paths: Record<string, string>) =>
    call(r, 'ops_magpie_window_prepare', { ...paths, approvalTask: 'approval-1' });

  test('unreviewed pricing keeps the window closed with the specific field', async () => {
    const r = rig();
    const out = await sample(r);
    const paths = writeProof(r, v2Manifest(out.document), out.document);
    const window = await prepare(r, paths);
    expect(window.eligible).toBe(false);
    expect(window.blockedReasons).toEqual(['price-not-reviewed']);
    expect(window.window).toBeUndefined();
  });

  test('a reviewed snapshot yields the exact executionWindow and is deterministic across calls', async () => {
    const r = rig();
    const out = await sample(r);
    const reviewed = { ...out.document, pricing: { ...out.document.pricing, reviewed: true }, approvalReadiness: { ready: true, blockedReasons: [] } };
    expect(evidenceSchema.safeParse(reviewed).success).toBe(true);
    const paths = writeProof(r, v2Manifest(reviewed), reviewed);
    const before = readdirSync(join(r.home, 'evidence', 'task-1')).sort();
    const first = await prepare(r, paths);
    const second = await prepare(r, paths);
    expect(first.eligible).toBe(true);
    expect(first.window.minRemainingSeconds).toBe(MAGPIE_EXECUTION_HEADROOM_SECONDS);
    expect(first.window.approvalTask).toBe('approval-1');
    expect(first.window.configurationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.window.notAfter).toBe(new Date(Date.parse(reviewed.expiresAt) - MAGPIE_EXECUTION_HEADROOM_SECONDS * 1000).toISOString());
    expect(second).toEqual(first);
    expect(first.documentHash).toBe(sha256(readFileSync(paths.documentPath)));
    // Duplicate calls are read-only: no second candidate, manifest or document is created.
    expect(readdirSync(join(r.home, 'evidence', 'task-1')).sort()).toEqual(before);
  });

  test('a schema-valid but ineligible route snapshot cannot obtain a window', async () => {
    const r = rig();
    const out = await sample(r);
    const drifted = {
      ...out.document,
      pricing: { ...out.document.pricing, reviewed: true },
      approvalReadiness: { ready: true, blockedReasons: [] },
      route: { ...out.document.route, routable: [{ model: 'sn-sensenova-6-8-flash', provider: 'other' }] },
    };
    drifted.route.digest = magpieRouteDigest(drifted.route.routable);
    expect(evidenceSchema.safeParse(drifted).success).toBe(true);
    const paths = writeProof(r, v2Manifest(drifted), drifted);
    const window = await prepare(r, paths);
    expect(window.eligible).toBe(false);
    expect(window.blockedReasons).toEqual(['evidence-not-eligible']);
  });

  test('an expired snapshot and an old contract are refused before a window exists', async () => {
    const r = rig();
    const out = await sample(r);
    const reviewed = { ...out.document, pricing: { ...out.document.pricing, reviewed: true }, approvalReadiness: { ready: true, blockedReasons: [] } };
    const paths = writeProof(r, v2Manifest(reviewed), reviewed);
    r.world.clock += (MAGPIE_EXECUTION_HEADROOM_SECONDS + 1) * 1000;
    const window = await prepare(r, paths);
    expect(window.eligible).toBe(false);
    expect(window.blockedReasons).toContain('insufficient-headroom');

    const fresh = rig();
    const magpie = await sample(fresh);
    const oldDoc = {
      schemaVersion: 1, type: 'reviewed-service', accountRef: 'ref', endpoint: 'https://api.test/v1', model: 'm',
      priceRevision: 'p', sampledAt: new Date(fresh.world.clock).toISOString(), expiresAt: new Date(fresh.world.clock + 3_600_000).toISOString(),
      serviceApproved: true, autoTopupDisabled: true, currency: 'USD', balanceNanoUsd: 1_000_000_000,
    };
    expect(manifestV2Schema.safeParse(v2Manifest(magpie.document)).success).toBe(true);
    const oldPaths = writeProof(fresh, v2Manifest(magpie.document), oldDoc);
    expect(loadProofFiles(fresh.home, 'task-1', oldPaths.manifestPath, oldPaths.documentPath)).rejects.toThrow();
    const rejected = await prepare(fresh, oldPaths).catch(error => error as Error & { code?: string });
    expect(rejected.code).toBe('invalid');
  });

  test('a v1 manifest cannot carry a Magpie document or ask for a window', async () => {
    const r = rig();
    const out = await sample(r);
    const v1 = {
      schemaVersion: 1, goalId: PROOF_GOAL, project: 'surreal_ck', env: 'production', activityId: 'activity1',
      workspaceSlug: 'demo', documentHash: '0'.repeat(64), service: { accountRef: 'a', endpoint: 'https://api.test/v1', model: 'm', priceRevision: 'p' },
      budget: { currency: 'USD', totalNanoUsd: 1_000_000_000, perAttemptNanoUsd: 100_000_000, maxAttempts: 30, autoTopupDisabled: true },
      identities: [{ alias: 'LCA04_REMOVABLE', workspaceRole: 'admin', billingRole: 'owner' }, { alias: 'LCA04_MEMBER', workspaceRole: 'participant', billingRole: 'member' }],
    };
    expect(manifestV1Schema.safeParse({ ...v1, configurationDigest: configurationDigest(v1 as never) }).success).toBe(true);
    const paths = writeProof(r, { ...v1, configurationDigest: configurationDigest(v1 as never) }, out.document);
    const error = await prepare(r, paths).catch(e => e as Error & { code?: string });
    expect(error.code).toBe('invalid');
  });
});

function expectNoMagpieLeaks(r: Rig) {
  const dir = join(r.home, 'evidence', 'task-1');
  const haystack = JSON.stringify([
    r.outputs, r.company.audits,
    ...(existsSync(dir) ? readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')) : []),
  ]);
  expect(haystack).not.toContain(r.world.magpie.accountUser);
  expect(haystack).not.toContain('{{SECRET_magpie_password}}');
  expect(haystack).not.toContain('{{SECRET_magpie_config}}');
  expect(haystack).not.toContain('internal-value-that-must-not-leave');
}
