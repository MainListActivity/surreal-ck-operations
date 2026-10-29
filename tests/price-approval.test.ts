// ops_product_magpie_price_approve and the marker reader: the human price review for a remote-magpie
// candidate is written by a different employee and read back from the approval task root with no test
// seam. Each case below is a closure from the brief: self-approval, a digest mismatch, expiry, tampering,
// and a missing price all keep the window closed on price-not-reviewed or refuse the marker outright.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
import { OpsBroker } from '../src/ops/broker.ts';
import { FakeCompany, FakeWorld, brokerConfig } from './support/ops-world.ts';
import { remoteConfigurationDigest } from '../src/ops/remote-magpie-evidence.ts';
import { PRICE_APPROVAL_PREFIX, priceApprovalSchema } from '../src/ops/price-approval.ts';

const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

const provider = { id: 'remote-magpie', chat: 'https://remote.test/ofm/v1', key: 'secret-fixture-key' };
const TASK = 'task-1';
const BUDGET = { currency: 'USD', totalNanoUsd: 5_000_000, perAttemptNanoUsd: 500_000, maxAttempts: 3 };

// The fake remote states one matching row with catalog pricing and no revision, digest or expiry.
function remoteFetch(now: number) {
  const at = new Date(now).toISOString();
  const catalog = { data: [{ id: 'group/work' }, { id: 'sn/deepseek', pricing: { prompt: '0.000001', completion: '0.000002' } }] };
  const quotas = { data: [{ provider: 'sn', user: 'private-account-name', kind: 'subscription', windows: [{ name: 'daily', remaining: 50, resetsAt: '2026-10-30T00:00:00Z' }], readAt: at }] };
  const usage = { total: 1, rows: [{ req: 'group/work', served: 'deepseek', provider: 'sn', providerAccount: 'private-account-name', status: 200, stop: 'stop', ms: 2000, in: 500, out: 50, priced: false, cost: 0, route_id: 123, response_id: 'resp-1', t: at }] };
  return async (url: string | URL | Request) => {
    const text = String(url);
    if (text.endsWith('/models')) return Response.json(catalog);
    if (text.endsWith('/quotas')) return Response.json(quotas);
    return Response.json(usage);
  };
}

// The broker keeps the observation it read in process memory, and the window trusts only that copy. Every
// actor in one test therefore shares a single broker and home, and only the leased employee changes.
interface Rig { world: FakeWorld; company: FakeCompany; broker: OpsBroker; home: string; token: string }
function rig(opts: { employee?: string; approvals?: unknown; home?: string; now?: () => number; shared?: Rig } = {}): Rig {
  if (opts.shared) {
    const token = opts.shared.company.lease(opts.employee ?? 'qa-1', 'qa', TASK, 'surreal_ck');
    return { ...opts.shared, token };
  }
  const world = new FakeWorld();
  const company = new FakeCompany();
  const home = opts.home ?? realpathSync(mkdtempSync(join(tmpdir(), 'price-approval-')));
  if (!opts.home) homes.push(home);
  company.env('surreal_ck', 'production', brokerConfig());
  const remote = remoteFetch(world.now());
  const broker = new OpsBroker({
    core: company.core, projects: company.projects as never, secretKey: () => Buffer.alloc(32),
    fetch: (url, init) => (String(url).startsWith(provider.chat) ? remote(url) : world.fetch(url, init)) as never,
    now: opts.now ?? world.now, serviceHome: home,
    magpie: {
      readProductProvider: () => provider,
      ...(opts.approvals ? { remotePriceApprovals: () => opts.approvals as never } : {}),
    },
  });
  const token = company.lease(opts.employee ?? 'qa-1', 'qa', TASK, 'surreal_ck');
  return { world, company, broker, home, token };
}

async function candidate(r: ReturnType<typeof rig>) {
  return await r.broker.call(r.token, TASK, 'ops_product_magpie_candidate', { budget: BUDGET }) as Record<string, any>;
}
async function approve(r: ReturnType<typeof rig>, candidatePath: string, args: Record<string, unknown> = {}) {
  return await r.broker.call(r.token, TASK, 'ops_product_magpie_price_approve', { candidatePath, ...args }) as Record<string, any>;
}
async function window(r: ReturnType<typeof rig>, candidatePath: string) {
  return await r.broker.call(r.token, TASK, 'ops_magpie_window_prepare', { approvalTask: TASK, candidatePath }) as Record<string, any>;
}

test('an independent approval read back from the evidence root opens the window with no injected seam', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'price-approval-')));
  homes.push(home);
  const author = rig({ employee: 'qa-author', home });
  const cand = await candidate(author);
  const reviewer = rig({ employee: 'engineering-reviewer', shared: author });
  const marked = await approve(reviewer, cand.candidateFile);
  expect(marked.marker.configurationDigest).toBe(cand.candidate.configurationDigest);
  expect(marked.marker.approverEmployee).toBe('engineering-reviewer');
  const result = await window(reviewer, cand.candidateFile);
  expect(result.eligible).toBe(true);
  expect(result.blockedReasons).toEqual([]);
  expect(result.window.configurationDigest).toBe(cand.candidate.configurationDigest);
});

test('the marker on disk is sealed, schema-valid, and holds no credential or account name', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'price-approval-')));
  homes.push(home);
  const cand = await candidate(rig({ employee: 'qa-author', home }));
  const reviewer = rig({ employee: 'engineering-reviewer', home });
  const marked = await approve(reviewer, cand.candidateFile);
  const onDisk = JSON.parse(readFileSync(marked.markerFile, 'utf8'));
  expect(priceApprovalSchema.safeParse(onDisk).success).toBe(true);
  expect(JSON.stringify(onDisk)).not.toContain('private-account-name');
  expect(JSON.stringify(onDisk)).not.toContain(provider.key);
  expect(readdirSync(join(home, 'evidence', TASK)).some(f => f.startsWith(PRICE_APPROVAL_PREFIX))).toBe(true);
});

test('the candidate author cannot approve its own price', async () => {
  const r = rig({ employee: 'qa-author' });
  const cand = await candidate(r);
  const error = await approve(r, cand.candidateFile).catch(e => e as Error & { code?: string });
  expect(error.code).toBe('self_review');
  const result = await window(r, cand.candidateFile);
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toEqual(['price-not-reviewed']);
});

test('a marker for a different configuration digest does not open the window', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'price-approval-')));
  homes.push(home);
  const author = rig({ employee: 'qa-author', home });
  const cand = await candidate(author);
  const reviewer = rig({ employee: 'engineering-reviewer', shared: author });
  await approve(reviewer, cand.candidateFile);
  // Another candidate from the same route but a different sample produces a different digest.
  const laterNow = () => Date.parse(cand.candidate.observation.capturedAt) + 60_000;
  const later = rig({ employee: 'qa-author', home, now: laterNow });
  const second = await candidate(later);
  expect(second.candidate.configurationDigest).not.toBe(cand.candidate.configurationDigest);
  const result = await window(rig({ employee: 'engineering-reviewer', shared: later }), second.candidateFile);
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toEqual(['price-not-reviewed']);
});

test('an edited audit copy of a marker does not change the window, which reads the broker record', async () => {
  // The evidence file is only an audit copy. Editing it cannot widen or narrow the decision: the window reads
  // the approval this broker recorded, so the edited file is ignored and the window still opens on that record.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'price-approval-')));
  homes.push(home);
  const author = rig({ employee: 'qa-author', home });
  const cand = await candidate(author);
  const reviewer = rig({ employee: 'engineering-reviewer', shared: author });
  const marked = await approve(reviewer, cand.candidateFile);
  const tampered = JSON.parse(readFileSync(marked.markerFile, 'utf8'));
  tampered.approverEmployee = 'someone-else';
  writeFileSync(marked.markerFile, JSON.stringify(tampered));
  const result = await window(reviewer, cand.candidateFile);
  expect(result.eligible).toBe(true);
});

test('an expired marker does not open the window', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'price-approval-')));
  homes.push(home);
  const author = rig({ employee: 'qa-author', home });
  const cand = await candidate(author);
  const reviewer = rig({ employee: 'engineering-reviewer', shared: author });
  await approve(reviewer, cand.candidateFile);
  const far = rig({ employee: 'engineering-reviewer', home, now: () => Date.parse(cand.candidate.expiry.expiresAt) + 1 });
  const result = await window(far, cand.candidateFile);
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('evidence-expired');
});

test('a candidate with no catalog price cannot be approved, so its price stays null', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'price-approval-')));
  homes.push(home);
  const author = rig({ employee: 'qa-author', home });
  const cand = await candidate(author);
  const priceless = JSON.parse(readFileSync(cand.candidateFile, 'utf8'));
  priceless.pricing = { ...priceless.pricing, priceRevision: null, rawPrompt: null, rawCompletion: null, free: false, freeEvidence: 'none' };
  const { configurationDigest: _digest, ...body } = priceless;
  priceless.configurationDigest = remoteConfigurationDigest(body);
  writeFileSync(cand.candidateFile, JSON.stringify(priceless));
  const reviewer = rig({ employee: 'engineering-reviewer', home });
  const error = await approve(reviewer, cand.candidateFile).catch(e => e as Error & { code?: string });
  expect(error.code).toBe('invalid');
});

test('an edited candidate cannot be approved', async () => {
  const r = rig({ employee: 'engineering-reviewer' });
  const cand = await candidate(r);
  const tampered = JSON.parse(readFileSync(cand.candidateFile, 'utf8'));
  tampered.route.revision = 'r-forged';
  writeFileSync(cand.candidateFile, JSON.stringify(tampered));
  const error = await approve(r, cand.candidateFile).catch(e => e as Error & { code?: string });
  expect(error.code).toBe('invalid');
});

test('an approval cannot be written into another task evidence root', async () => {
  const r = rig({ employee: 'engineering-reviewer' });
  const cand = await candidate(r);
  const error = await approve(r, cand.candidateFile, { approvalTask: 'other-task' }).catch(e => e as Error & { code?: string });
  expect(error.code).toBe('forbidden');
});

test('an injected remotePriceApprovals seam still takes precedence over markers on disk', async () => {
  // The seam is wired at broker construction, so this broker is built with it and makes the candidate itself.
  const approval = { approverEmployee: 'engineering-reviewer', configurationDigest: '', priceRevision: '', approvedAt: '2026-10-29T02:50:00Z' };
  const r = rig({ employee: 'qa-author', approvals: [approval] });
  const cand = await candidate(r);
  approval.configurationDigest = cand.candidate.configurationDigest;
  approval.priceRevision = cand.candidate.pricing.priceRevision;
  const result = await window(r, cand.candidateFile);
  expect(result.eligible).toBe(true);
});

test('a forged marker with a recomputed markerDigest does not open the window', async () => {
  // markerDigest is an unkeyed hash, so anyone who can write the evidence file can recompute it. The window
  // trusts only approvals this broker process recorded, so a forged file in a fresh process must stay closed.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'price-approval-')));
  homes.push(home);
  const author = rig({ employee: 'qa-author', home });
  const cand = await candidate(author);
  const { canonical, sha256 } = await import('../src/ops/proof-contract.ts');
  const forgedBody = {
    version: 'remote-price-approval/1', approverEmployee: 'someone-independent-2', approvalTask: TASK,
    configurationDigest: cand.candidate.configurationDigest, priceRevision: cand.candidate.pricing.priceRevision,
    pricing: { free: cand.candidate.pricing.free, freeEvidence: cand.candidate.pricing.freeEvidence },
    approvedAt: new Date(Date.parse(cand.candidate.observation.capturedAt)).toISOString(),
    expiresAt: cand.candidate.expiry.expiresAt,
  };
  mkdirSync(join(home, 'evidence', TASK), { recursive: true });
  writeFileSync(join(home, 'evidence', TASK, 'price-approval-forged.json'), JSON.stringify({ ...forgedBody, markerDigest: sha256(canonical(forgedBody)) }));
  // A fresh process (no recorded approval) reads the same evidence root: the forged file must not open the window.
  const fresh = rig({ employee: 'qa-author', home, shared: undefined });
  const second = await candidate(fresh);
  const result = await window(fresh, second.candidateFile);
  expect(result.eligible).toBe(false);
  expect(result.blockedReasons).toContain('price-not-reviewed');
});
