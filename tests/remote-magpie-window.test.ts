// ops_product_magpie_candidate and ops_magpie_window_prepare {candidatePath}: the product remote-magpie
// candidate written to the task evidence root and read back by the window proxy. The fake remote
// gateway supplies only what a read-only remote would state. Price approval is injected through the
// trusted seam, because the marker reader is not built yet (review item 1).
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
import { OpsBroker } from '../src/ops/broker.ts';
import { FakeCompany, FakeWorld, brokerConfig } from './support/ops-world.ts';
import { remoteConfigurationDigest, remoteMagpieEvidenceSchema, type PriceApproval } from '../src/ops/remote-magpie-evidence.ts';
import { MAGPIE_EXECUTION_HEADROOM_SECONDS } from '../src/ops/proof-contract.ts';

const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

const provider = { id: 'remote-magpie', chat: 'https://remote.test/ofm/v1', key: 'secret-fixture-key' };
const APPROVAL_TASK = 'task-1';
const BUDGET = { currency: 'USD', totalNanoUsd: 5_000_000, perAttemptNanoUsd: 500_000, maxAttempts: 3 };

// A remote gateway that states models, quotas and one matching usage row. No revision, digest or expiry.
function remoteFetch(now: number, opts: { catalogPricing?: boolean } = {}) {
  const at = new Date(now).toISOString();
  const catalog = { data: [{ id: 'group/work' }, { id: 'sn/deepseek', ...(opts.catalogPricing === false ? {} : { pricing: { prompt: '0', completion: '0' } }) }] };
  const quotas = { data: [{ provider: 'sn', user: 'private-account-name', kind: 'subscription', windows: [{ name: 'daily', remaining: 50, resetsAt: '2026-10-30T00:00:00Z' }], readAt: at }] };
  const usage = { total: 1, rows: [{ req: 'group/work', served: 'deepseek', provider: 'sn', providerAccount: 'private-account-name', status: 200, stop: 'stop', ms: 2000, in: 500, out: 50, priced: false, cost: 0, route_id: 123, response_id: 'resp-1', t: at }] };
  return async (url: string | URL | Request) => {
    const text = String(url);
    if (text.endsWith('/models')) return Response.json(catalog);
    if (text.endsWith('/quotas')) return Response.json(quotas);
    return Response.json(usage);
  };
}

function rig(opts: { approvals?: PriceApproval[]; catalogPricing?: boolean } = {}) {
  const world = new FakeWorld();
  const company = new FakeCompany();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'remote-magpie-window-')));
  homes.push(home);
  company.env('surreal_ck', 'production', brokerConfig());
  const remote = remoteFetch(world.now());
  const broker = new OpsBroker({
    core: company.core, projects: company.projects as never, secretKey: () => Buffer.alloc(32),
    fetch: (url, init) => (String(url).startsWith(provider.chat) ? remote(url) : world.fetch(url, init)) as never,
    now: world.now, serviceHome: home,
    magpie: {
      readProductProvider: () => provider,
      remotePriceApprovals: () => opts.approvals ?? [],
    },
  });
  return { world, company, broker, home, token: company.lease('qa-1', 'qa', 'task-1', 'surreal_ck') };
}

async function candidate(r: ReturnType<typeof rig>, args: Record<string, unknown> = {}) {
  const value = await r.broker.call(r.token, 'task-1', 'ops_product_magpie_candidate', args) as Record<string, any>;
  return value;
}
async function window(r: ReturnType<typeof rig>, args: Record<string, unknown>) {
  return await r.broker.call(r.token, 'task-1', 'ops_magpie_window_prepare', { approvalTask: APPROVAL_TASK, ...args }) as Record<string, any>;
}

test('a candidate is written to the evidence root with null and gap facts, not invented ones', async () => {
  const r = rig();
  const out = await candidate(r, { budget: BUDGET });
  expect(out.candidateFile.startsWith(join(r.home, 'evidence', 'task-1') + '/')).toBe(true);
  const onDisk = JSON.parse(readFileSync(out.candidateFile, 'utf8'));
  expect(remoteMagpieEvidenceSchema.safeParse(onDisk).success).toBe(true);
  expect(onDisk.route).toMatchObject({ revision: null, digest: null, expiresAt: null });
  expect(onDisk.route.gaps.map((g: { field: string }) => g.field)).toEqual(['revision', 'digest', 'maxOutputTokens', 'expiresAt']);
  expect(onDisk.observation.routingConfigurationVerified).toBe(false);
  expect(JSON.stringify(out)).not.toContain('private-account-name');
  expect(JSON.stringify(out)).not.toContain(provider.key);
});

test('a candidate without a budget is written with the budget gap, and its window stays closed', async () => {
  const r = rig({ approvals: [] });
  const out = await candidate(r);
  expect(out.candidate.budget).toBeNull();
  const result = await window(r, { candidatePath: out.candidateFile });
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('budget-missing');
});

test('production with no price approval keeps the window closed on price-not-reviewed', async () => {
  const r = rig({ approvals: [] });
  const out = await candidate(r, { budget: BUDGET });
  const result = await window(r, { candidatePath: out.candidateFile });
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toEqual(['price-not-reviewed']);
});

test('an independent approval for the same digest opens a window with the exact executionWindow fields', async () => {
  const seed = rig({ approvals: [] });
  const first = await candidate(seed, { budget: BUDGET });
  const approval: PriceApproval = { approverEmployee: 'engineering-2', configurationDigest: first.candidate.configurationDigest, priceRevision: first.candidate.pricing.priceRevision, approvedAt: '2026-10-29T02:50:00Z' };
  const r = rig({ approvals: [approval] });
  const out = await candidate(r, { budget: BUDGET });
  const result = await window(r, { candidatePath: out.candidateFile });
  expect(result.eligible).toBe(true);
  expect(result.window).toMatchObject({ approvalTask: APPROVAL_TASK, minRemainingSeconds: MAGPIE_EXECUTION_HEADROOM_SECONDS });
  expect(result.window.configurationDigest).toBe(out.candidate.configurationDigest);
  expect(result.window.notAfter).toBe(new Date(Date.parse(out.candidate.expiry.expiresAt) - MAGPIE_EXECUTION_HEADROOM_SECONDS * 1000).toISOString());
});

test('an approval from the candidate author does not open the window', async () => {
  const seed = rig({ approvals: [] });
  const first = await candidate(seed, { budget: BUDGET });
  const selfApproval: PriceApproval = { approverEmployee: first.candidate.author, configurationDigest: first.candidate.configurationDigest, priceRevision: first.candidate.pricing.priceRevision, approvedAt: '2026-10-29T02:50:00Z' };
  const r = rig({ approvals: [selfApproval] });
  const out = await candidate(r, { budget: BUDGET });
  const result = await window(r, { candidatePath: out.candidateFile });
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toEqual(['price-not-reviewed']);
});

test('a candidate edited after generation is refused, not accepted', async () => {
  const r = rig({ approvals: [] });
  const out = await candidate(r, { budget: BUDGET });
  const tampered = JSON.parse(readFileSync(out.candidateFile, 'utf8'));
  tampered.route.revision = 'r-forged';
  writeFileSync(out.candidateFile, JSON.stringify(tampered));
  const result = await window(r, { candidatePath: out.candidateFile });
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('candidate-digest-mismatch');
  expect(result.window).toBeUndefined();
});

test('candidatePath and manifestPath/documentPath are mutually exclusive', async () => {
  const r = rig({ approvals: [] });
  const out = await candidate(r, { budget: BUDGET });
  const result = await window(r, { candidatePath: out.candidateFile, manifestPath: out.candidateFile, documentPath: out.candidateFile }).catch(error => error);
  expect(result.code).toBe('invalid');
  expect(result.message).toContain('二选一');
});

test('a candidate outside the approval task evidence root is refused', async () => {
  const r = rig({ approvals: [] });
  const out = await candidate(r, { budget: BUDGET });
  const result = await window(r, { approvalTask: 'other-task', candidatePath: out.candidateFile }).catch(error => error);
  expect(result.code).toBe('forbidden');
});

test('the candidate digest recomputes from the body it was written with', async () => {
  const r = rig({ approvals: [] });
  const out = await candidate(r, { budget: BUDGET });
  const onDisk = JSON.parse(readFileSync(out.candidateFile, 'utf8'));
  const { configurationDigest, ...body } = onDisk;
  expect(remoteConfigurationDigest(body)).toBe(configurationDigest);
  expect(readdirSync(join(r.home, 'evidence', 'task-1')).some(f => f.startsWith('remote-magpie-candidate-'))).toBe(true);
});

test('an incomplete usage scan keeps the window closed even with an approved price', async () => {
  const seed = rig({ approvals: [] });
  const first = await candidate(seed, { budget: BUDGET });
  const approval: PriceApproval = { approverEmployee: 'engineering-2', configurationDigest: first.candidate.configurationDigest, priceRevision: first.candidate.pricing.priceRevision, approvedAt: '2026-10-29T02:50:00Z' };
  const r = rig({ approvals: [approval] });
  const out = await candidate(r, { budget: BUDGET });
  expect(out.candidate.coverage.complete).toBe(true);
  const incomplete = JSON.parse(readFileSync(out.candidateFile, 'utf8'));
  incomplete.coverage.complete = false;
  incomplete.coverage.truncated = true;
  const { configurationDigest: _digest, ...body } = incomplete;
  incomplete.configurationDigest = remoteConfigurationDigest(body);
  writeFileSync(out.candidateFile, JSON.stringify(incomplete));
  const result = await window(r, { candidatePath: out.candidateFile });
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('coverage-incomplete');
});
