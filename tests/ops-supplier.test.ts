// ops_supplier_plan_sample: the controlled SenseNova plan/quota evidence sampler. The fake
// world answers as the real provider surfaces (chat /v1/models, console pool-usage and
// api-keys, public token-plan page) so success and every fail-closed path are exercised
// without touching a real account or spending provider quota.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { sha256, evidenceSchema } from '../src/ops/proof-contract.ts';
import { OPS_TOOLS, OpsBroker } from '../src/ops/broker.ts';
import { ACCOUNT_PAYMENT_SOURCES, flattenPlanHtml, planPageMarkersV2, planPageMarkersV3, promotionalDeadline } from '../src/ops/supplier.ts';
import { FakeCompany, FakeWorld, brokerConfig } from './support/ops-world.ts';

interface Rig { world: FakeWorld; company: FakeCompany; broker: OpsBroker; home: string; qa: string; outputs: unknown[] }

const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

function rig(): Rig {
  const world = new FakeWorld();
  const company = new FakeCompany();
  const home = mkdtempSync(join(tmpdir(), 'ops-supplier-'));
  homes.push(home);
  company.env('demo', 'production', brokerConfig(), { healthUrl: 'https://app.test/health' });
  const broker = new OpsBroker({
    core: company.core, projects: company.projects as never, secretKey: () => Buffer.alloc(32),
    fetch: world.fetch, now: world.now, d1: () => world.d1, queryAsUser: world.queryAsUser, browser: world.browser,
    serviceHome: home, sleep: async (ms) => { world.clock += ms; },
  });
  return { world, company, broker, home, qa: company.lease('qa-1', 'qa', 'task-1'), outputs: [] };
}

async function call(r: Rig, tool: string, args: Record<string, unknown> = {}, as: { cred?: string; task?: string } = {}) {
  const value = await r.broker.call(as.cred ?? r.qa, as.task ?? 'task-1', tool, args);
  r.outputs.push(value);
  return value as Record<string, any>;
}

const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code: string }; }
  throw new Error('expected the call to fail');
};

const ALIAS = 'SNV_PROD';
const PURPOSE = 'internal-ai plan evidence';
const sample = (r: Rig, args: Record<string, unknown> = {}) =>
  call(r, 'ops_supplier_plan_sample', { alias: ALIAS, purpose: PURPOSE, ...args });

function seal(r: Rig, { apiKey = true, consoleToken = true, consoleCreds = false } = {}) {
  if (apiKey) r.company.sealed.set(`demo/production/SUPPLIER_${ALIAS}_API_KEY`, r.world.supplier.apiKey);
  if (consoleToken) r.company.sealed.set(`demo/production/SUPPLIER_${ALIAS}_CONSOLE_TOKEN`, r.world.supplier.consoleToken);
  if (consoleCreds) {
    r.company.sealed.set(`demo/production/SUPPLIER_${ALIAS}_USERNAME`, r.world.supplier.consoleUser);
    r.company.sealed.set(`demo/production/SUPPLIER_${ALIAS}_PASSWORD`, r.world.supplier.consolePassword);
  }
}

/** The sampler's output, audit rows and on-disk files must never contain sealed material. */
function expectNoSupplierLeaks(r: Rig) {
  const dir = join(r.home, 'evidence', 'task-1');
  const haystack = JSON.stringify([
    r.outputs, r.company.audits,
    ...(existsSync(dir) ? readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')) : []),
  ]);
  expect(haystack).not.toContain(r.world.supplier.apiKey);
  expect(haystack).not.toContain(r.world.supplier.consoleToken);
  expect(haystack).not.toContain(r.world.supplier.consoleUser);
  expect(haystack).not.toContain(r.world.supplier.consolePassword);
  if (r.world.supplier.issuedToken) expect(haystack).not.toContain(r.world.supplier.issuedToken);
}

const onlyAllowedRequests = (r: Rig) => r.world.requests.filter(q =>
  !q.url.startsWith('https://token.sensenova.cn/v1/models')
  && !q.url.startsWith('https://platform.sensenova.cn/lite/console/v1/')
  && !q.url.startsWith('https://platform.sensenova.cn/oauth2/')
  && !q.url.startsWith('https://iam.sensecoreapi.cn/iam/authn/v1/')
  && !q.url.startsWith('https://www.sensenova.cn/token-plan'));

test('v2 official-copy markers and semantics are preserved; v3 adds limited-time and records the number as observation', () => {
  const v2Page = '<html><body>公测期完全免费开放 付费档位即将上线 Free · 公测 60,000 积分 / 5 小时</body></html>';
  expect(planPageMarkersV2(v2Page)).toEqual({ freeBetaOpen: true, paidTiersUpcoming: true, quota5h: true, freeTierNamed: true });
  const v3Page = '<html><body>公测期完全免费开放 付费档位即将上线 Free · 公测 限时放量 ¥0/月</body></html>';
  expect(planPageMarkersV3(flattenPlanHtml(v3Page))).toMatchObject({ limitedTimePromotion: true, officialQuotaNumberObserved: false });
  expect(promotionalDeadline('活动截止 2026-11-30')).toMatchObject({ at: '2026-11-30T15:59:59.999Z' });
  expect(promotionalDeadline('活动截止 另行通知')).toBeNull();
});

describe('ops_supplier_plan_sample', () => {
  test('tool is enumerated and surfaced with its fixed service binding in ops_info', async () => {
    expect(OPS_TOOLS).toContain('ops_supplier_plan_sample');
    const r = rig();
    seal(r);
    const info = await call(r, 'ops_info');
    expect(info.supplierPlanSampling).toMatchObject({
      provider: 'sensenova', adapter: 'sensenova-token-plan/3',
      service: {
        endpoint: 'https://token.sensenova.cn/v1',
        model: 'sensenova-6.8-flash-lite',
        priceRevision: 'sensenova-token-plan-2026-10-10',
        planSourceUrl: 'https://www.sensenova.cn/token-plan',
      },
      aliases: [{ alias: ALIAS, credentials: ['apiKey', 'consoleToken'] }],
    });
    expectNoSupplierLeaks(r);
  });

  test('FREE console plan + bound API key + official limited-time copy → v3 promotional/account-bound document', async () => {
    const r = rig();
    seal(r);
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    expect(result.document).toMatchObject({
      schemaVersion: 3, type: 'reviewed-token-plan', evidenceClass: 'promotional-account-bound',
      accountPlanType: 'TOKEN_PLAN_PLAN_TYPE_FREE', accountBound: true, promotional: true,
      revalidateBeforeUse: true, autoTopupDisabled: true, terminationRisk: 'unknown-promotional-end',
      // The pool observes 120000/5h, but the allowed cap stays the reviewed 60000.
      quotaAmount: 60000, quotaWindowSeconds: 18000, quotaRemaining: 118500,
      quotaSource: 'account-bound-observation',
      governingPool: { poolType: 'dedicated', basis: 'dedicated-pool-for-bound-model' },
    });
    const doc = result.document as Record<string, any>;
    expect(doc.planSource).toMatchObject({
      url: 'https://www.sensenova.cn/token-plan', status: 200, etag: '"plan-fixture-v3"', clockSkewMs: 0,
    });
    expect(doc.planSource.httpDate).toBe(new Date(r.world.clock).toISOString());
    expect(doc.planSource.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(doc.normalization).toMatchObject({ algorithm: 'html-text-flat/1' });
    expect(doc.normalization.flatSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(doc.normalization.flatChars).toBeGreaterThan(0);
    expect(doc.pools).toHaveLength(2);
    expect(doc.pools[0]).toMatchObject({
      poolType: 'dedicated', accountBound: true,
      window5h: { limit: 120000, used: 600, remaining: 119400 }, window7d: { limit: 1200000, used: 2000, remaining: 1198000 },
      usedSource5h: 'reported', usedSource7d: 'reported',
    });
    // The observed 120k pool limit is recorded but never raises the allowed cap.
    expect(doc.quotaAmount).toBeLessThan(doc.pools[0].window5h.limit);
    expect(doc.quotaAmount).toBeLessThanOrEqual(doc.quotaRemaining);
    expect(result.document).not.toHaveProperty('noPaymentInstrument');
    expect(result.document).not.toHaveProperty('balanceNanoUsd');
    expect(result.documentSha256).toMatch(/^[a-f0-9]{64}$/);
    const bytes = readFileSync(result.documentFile);
    expect(sha256(bytes)).toBe(result.documentSha256);
    expect(evidenceSchema.safeParse(JSON.parse(bytes.toString('utf8'))).success).toBe(true);
    expect(Date.parse(result.expiresAt) - Date.parse(result.sampledAt)).toBeLessThanOrEqual(86400000);
    // The earliest applicable reset is the default pool's 5h window (4h), which caps expiry first.
    expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(r.world.clock + 4 * 3600 * 1000);
    expect(result.accountRef).toMatch(/^snv[a-f0-9]{24}$/);
    expect(result.receipt.derivations).toMatchObject({
      accountBound: true,
      applicabilityOk: true,
      accountPlan: { id: 'free', name: 'Free Plan', type: 'TOKEN_PLAN_PLAN_TYPE_FREE' },
      accountPlanFree: true,
      officialQuotaNumberObserved: false,
      consolePaymentSurfaceAbsent: true,
      paymentStateSources: 0,
      removedAccountAssertions: ['noPaymentInstrument'],
      quotaAllowedAmount: 60000,
      quotaRemaining: 118500,
      poolsOk: true,
      governingPool: { poolType: 'dedicated', basis: 'dedicated-pool-for-bound-model' },
    });
    expect(result.gaps).toEqual([]);
    // The receipt is still written: sources, observations and gaps are the evidence.
    const receiptFile = result.receiptFile as string;
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    expect(receipt).toMatchObject({ generated: true, alias: ALIAS, purpose: PURPOSE, taskId: 'task-1', documentSha256: result.documentSha256 });
    expect(receipt.pools).toHaveLength(2); // dual pools preserved as side evidence
    const names = receipt.sources.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['apiKeys', 'models', 'planPage', 'planPageConditional', ...Array(11).fill('paymentSurface'), 'poolUsage'].sort());
    const planSource = receipt.sources.find((s: { name: string }) => s.name === 'planPage');
    expect(planSource).toMatchObject({ fetchedAt: result.sampledAt, httpDate: new Date(r.world.clock).toUTCString(), etag: '"plan-fixture-v3"' });
    expect(planSource.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(receiptFile).mode & 0o777).toBe(0o600);
    const dir = join(r.home, 'evidence', 'task-1');
    expect(readdirSync(dir).some(f => /supplier-plan-sensenova-\d+\.json$/.test(f))).toBe(true);
    expect(r.company.audits.map(a => a.action)).toEqual(['ops_supplier_sample']);
    // Read-only: only allowlisted GETs, no chat/model invocation anywhere.
    expect(onlyAllowedRequests(r)).toEqual([]);
    expect(r.world.requests.every(q => q.method === 'GET')).toBe(true);
    expectNoSupplierLeaks(r);
  });

  test('without a sealed console token account-bound facts are unverifiable → blocked, no document', async () => {
    const r = rig();
    seal(r, { consoleToken: false });
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(result.gaps.map((g: { field: string }) => g.field)).toContain('consoleToken');
    expect(readdirSync(join(r.home, 'evidence', 'task-1')).some(f => f.endsWith('-receipt.json'))).toBe(true);
    expect(readdirSync(join(r.home, 'evidence', 'task-1')).some(f => /supplier-plan-sensenova-\d+\.json$/.test(f))).toBe(false);
    expectNoSupplierLeaks(r);
  });

  test('sealed console credentials auto-issue a session token → account facts established, v2 sampled', async () => {
    const r = rig();
    seal(r, { consoleToken: false, consoleCreds: true });
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    expect(result.document.schemaVersion).toBe(3);
    const receipt = JSON.parse(readFileSync(String(result.receiptFile), 'utf8'));
    expect(receipt.derivations.consoleSession.tokenSource).toBe('issued');
    expect(receipt.derivations.consoleSession.sessionExpiresAt).toMatch(/^\d{4}-/);
    expect(receipt.derivations.consoleSession.hops.map((h: { phase: string }) => h.phase))
      .toEqual(expect.arrayContaining(['oauth2/auth', 'checkChallenge', 'nova/login', 'oauth2/token']));
    expectNoSupplierLeaks(r);
  });

  test('auto-issuance is preferred over a pasted console token when both exist', async () => {
    const r = rig();
    seal(r, { consoleCreds: true });
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    expect(result.receipt.derivations.consoleSession.tokenSource).toBe('issued');
    expectNoSupplierLeaks(r);
  });

  test('failed issuance falls back to a sealed console token and says so', async () => {
    const r = rig();
    seal(r, { consoleCreds: true });
    r.world.supplier.authLoginStatus = 401;
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    expect(result.receipt.derivations.consoleSession.tokenSource).toBe('sealed');
    expect(result.receipt.notes.some((n: string) => n.includes('fallback'))).toBe(true);
    expect(result.gaps.some((g: { source: string }) => g.source === 'auto-issuance')).toBe(true);
    expectNoSupplierLeaks(r);
  });

  test('failed issuance with no pasted token stays blocked', async () => {
    const r = rig();
    seal(r, { consoleToken: false, consoleCreds: true });
    r.world.supplier.authLoginStatus = 401;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(result.gaps.filter((g: { field: string }) => g.field === 'consoleToken').length).toBeGreaterThanOrEqual(1);
    expectNoSupplierLeaks(r);
  });

  test('a login redirect escaping the allowlisted hosts fails the chain closed', async () => {
    const r = rig();
    seal(r, { consoleToken: false, consoleCreds: true });
    r.world.supplier.authRedirectHost = 'evil.example';
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.gaps.some((g: { detail?: string }) => g.detail?.includes('allowlisted hosts'))).toBe(true);
    expect(r.world.requests.some(q => q.url.includes('evil.example'))).toBe(false);
    expectNoSupplierLeaks(r);
  });

  test('a wrong console password fails issuance closed, nothing is minted', async () => {
    const r = rig();
    seal(r, { consoleToken: false, consoleCreds: true });
    r.company.sealed.set(`demo/production/SUPPLIER_${ALIAS}_PASSWORD`, 'wrong-password-00000000');
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(r.world.supplier.issuedToken).toBe('');
    expectNoSupplierLeaks(r);
  });

  test('a consent/risk wall instead of a code stalls the chain closed', async () => {
    const r = rig();
    seal(r, { consoleToken: false, consoleCreds: true });
    r.world.supplier.authConsentStall = true;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.gaps.some((g: { detail?: string }) => g.detail?.includes('redirect chain'))).toBe(true);
    expectNoSupplierLeaks(r);
  });

  test('an invalid login challenge fails issuance before credentials are posted', async () => {
    const r = rig();
    seal(r, { consoleToken: false, consoleCreds: true });
    r.world.supplier.authChallengeValid = false;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.gaps.some((g: { detail?: string }) => g.detail?.includes('challenge'))).toBe(true);
    expect(r.world.requests.some(q => q.url.includes('/nova/login'))).toBe(false);
    expectNoSupplierLeaks(r);
  });

  test('without any sealed credential the capability gap is reported, nothing is fetched', async () => {
    const r = rig();
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.accountRef).toBeNull();
    expect(result.gaps.map((g: { field: string }) => g.field)).toEqual(expect.arrayContaining(['accountRef', 'consoleToken']));
    expect(r.world.requests.every(q => q.url === 'https://www.sensenova.cn/token-plan')).toBe(true);
    expectNoSupplierLeaks(r);
  });

  test('a chat credential rejected by the provider blocks the document', async () => {
    const r = rig();
    seal(r);
    // The sealed chat key no longer matches the provider account (rotated out of band).
    r.company.sealed.set(`demo/production/SUPPLIER_${ALIAS}_API_KEY`, 'sk-test-WRONG-0000000000000000000000000000');
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'apiKey', source: 'models' })]));
    expectNoSupplierLeaks(r);
  });

  test('a console session that cannot list the sealed key fails the account binding', async () => {
    const r = rig();
    seal(r);
    r.world.supplier.apiKeyListed = false;
    r.world.supplier.extraApiKeys = ['sk-test-other-1111111111111111111111111'];
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'binding', source: 'apiKeys' })]));
    expectNoSupplierLeaks(r);
  });

  test('401 on the console surface fails closed as an authentication gap', async () => {
    const r = rig();
    seal(r);
    r.world.supplier.poolStatus = 401;
    r.world.supplier.keysStatus = 401;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.gaps.filter((g: { field: string }) => g.field === 'consoleToken')).toHaveLength(2);
    expectNoSupplierLeaks(r);
  });

  test('when the official page stops saying paid tiers are upcoming, applicability blocks', async () => {
    const r = rig();
    seal(r);
    r.world.supplier.planHtml = '<html><body>Token Plan 付费档 Pro ¥199/月 60,000 积分 / 5 小时 公测期完全免费开放 Free · 公测</body></html>';
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'planApplicability' })]));
    expectNoSupplierLeaks(r);
  });

  test('a live console billing surface is receipt observation only and never gates the document', async () => {
    const r = rig();
    seal(r);
    r.world.supplier.billingPathLive = true;
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    expect(result.document).toMatchObject({ schemaVersion: 3, accountPlanType: 'TOKEN_PLAN_PLAN_TYPE_FREE', evidenceClass: 'promotional-account-bound' });
    expect(result.receipt.derivations.consolePaymentSurfaceAbsent).toBe(false);
    expect(result.receipt.derivations.paymentSurface).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/billing', status: 200 })]),
    );
    expect(result.receipt.notes.some((n: string) => n.includes('payment surface'))).toBe(true);
    expect(result.gaps.some((g: { source?: string }) => g.source === 'paymentSurface')).toBe(false);
    expectNoSupplierLeaks(r);
  });

  test('ACCOUNT_PAYMENT_SOURCES stays an empty reserved registry under the revised contract', async () => {
    expect(ACCOUNT_PAYMENT_SOURCES).toEqual([]);
  });

  test('an account plan type other than the certified free type fails accountPlanType', async () => {
    const r = rig();
    seal(r);
    r.world.supplier.planType = 'TOKEN_PLAN_PLAN_TYPE_PRO';
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'accountPlanType', source: 'poolUsage' })]));
    expect(result.receipt.derivations.accountPlanFree).toBe(false);
    expectNoSupplierLeaks(r);
  });

  test('missing console plan cannot borrow FREE from public page, models or payment 404s', async () => {
    const r = rig(); seal(r);
    r.world.supplier.planType = undefined as never;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'accountPlanType', source: 'poolUsage' })]));
    expectNoSupplierLeaks(r);
  });

  test('inconsistent pool facts fail closed instead of guessing the allowed cap', async () => {
    for (const mutate of [
      (pool: any) => { pool.window_5h.limit = 0; },
      (pool: any) => { pool.window_5h.remaining = pool.window_5h.limit + 1; },
      (pool: any) => { pool.window_5h.used = pool.window_5h.limit + 1; },
      (pool: any) => { pool.window_5h.used = 1; /* used + remaining no longer equals limit */ },
    ]) {
      const r = rig(); seal(r);
      mutate(r.world.supplier.pools[0]!);
      const result = await sample(r);
      expect(result.status).toBe('blocked');
      expect(result.document).toBeUndefined();
      expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'poolConsistency', source: 'poolUsage' })]));
      expectNoSupplierLeaks(r);
    }
  });

  test('missing 5h/7d facts and resets block; a missing window is never treated as unlimited', async () => {
    const mutations = [
      (pool: any) => { delete pool.window_7d; },
      (pool: any) => { pool.window_7d.remaining = null; },
      (pool: any) => { pool.window_7d.reset_at = null; },
      (pool: any) => { delete pool.window_5h; },
      (pool: any) => { pool.window_5h.reset_at = null; },
    ];
    for (const mutate of mutations) {
      const r = rig(); seal(r);
      mutate(r.world.supplier.pools[0]!);
      const result = await sample(r);
      expect(result.status).toBe('blocked');
      expect(result.document).toBeUndefined();
      expect(result.gaps.some((g: { field: string }) => g.field === 'quota5h' || g.field === 'quota7d')).toBe(true);
      expectNoSupplierLeaks(r);
    }
  });

  test('the allowed cap is the smaller of 60000 and every applicable pool remaining', async () => {
    const r = rig(); seal(r);
    // Make the dedicated 5h window the trusted minimum (50000), with consistent used facts.
    r.world.supplier.pools[0]!.window_5h.used = 70_000;
    r.world.supplier.pools[0]!.window_5h.remaining = 50_000;
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    expect(result.document).toMatchObject({ quotaAmount: 50_000, quotaRemaining: 50_000 });
    expect(result.receipt.derivations.quotaAllowedAmount).toBe(50_000);
    expectNoSupplierLeaks(r);
  });

  test('an exhausted applicable pool blocks rather than producing a zero-cap document', async () => {
    const r = rig(); seal(r);
    r.world.supplier.pools[0]!.window_5h.used = 120_000;
    r.world.supplier.pools[0]!.window_5h.remaining = 0;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'quota', source: 'poolUsage' })]));
    expectNoSupplierLeaks(r);
  });

  test('a missing remaining figure blocks: a null remaining is not a fabricated number', async () => {
    const r = rig();
    seal(r);
    // Null remaining with used still present also breaks used+remaining=limit, so consistency or
    // the missing-window gap must fire; either way no document is produced.
    (r.world.supplier.pools[0]!.window_5h as { remaining: number | null }).remaining = null as never;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(result.gaps.some((g: { field: string }) => ['quota5h', 'quota7d', 'poolConsistency'].includes(g.field))).toBe(true);
    expectNoSupplierLeaks(r);
  });

  test('a drifted pool-usage schema blocks rather than guessing quota', async () => {
    const r = rig();
    seal(r);
    (r.world.supplier as any).pools = undefined;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'quota', source: 'poolUsage' })]));
    expectNoSupplierLeaks(r);
  });

  test('a pool window already reset makes the sample born-expired → blocked', async () => {
    const r = rig();
    seal(r);
    const past = Math.floor(r.world.clock / 1000) - 60;
    r.world.supplier.pools[0]!.window_5h.reset_at = past;
    r.world.supplier.pools[0]!.window_7d.reset_at = past;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'expiresAt' })]));
    expectNoSupplierLeaks(r);
  });

  test('v3 requires the official HTTP Date; a missing source date blocks', async () => {
    const r = rig(); seal(r);
    r.world.supplier.planDate = false;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'sourceDate', source: 'planPage' })]));
    expectNoSupplierLeaks(r);
  });

  test('the official copy must still say paid tiers are upcoming and the release is limited-time', async () => {
    for (const html of [
      '<html><body>公测期完全免费开放 Free · 公测 ¥0/月</body></html>', // paid tiers / limited-time missing
      '<html><body>公测期完全免费开放，付费档位即将上线 Free · 公测 ¥0/月</body></html>', // limited-time missing
      '<html><body>公测期完全免费开放，付费档位即将上线 限时放量 ¥0/月</body></html>', // Free tier missing
    ]) {
      const r = rig(); seal(r);
      r.world.supplier.planHtml = html;
      const result = await sample(r);
      expect(result.status).toBe('blocked');
      expect(result.document).toBeUndefined();
      expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'planApplicability', source: 'planPage' })]));
      expectNoSupplierLeaks(r);
    }
  });

  test('an explicit promotional deadline caps expiry and is recorded; unknown risk is explicit otherwise', async () => {
    const r = rig(); seal(r);
    const deadline = new Date(r.world.clock + 2 * 3600 * 1000);
    const y = deadline.getUTCFullYear(), m = deadline.getUTCMonth() + 1, d = deadline.getUTCDate();
    r.world.supplier.planHtml = `<html><body>公测期完全免费开放，付费档位即将上线 Free · 公测 限时放量 活动截止 ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}</body></html>`;
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    const doc = result.document as Record<string, any>;
    expect(doc.terminationRisk).toBe('promotional-end-recorded');
    expect(doc.promotionalEndsAt).toBe(new Date(Date.UTC(y, m - 1, d, 15, 59, 59, 999)).toISOString());
    expect(Date.parse(doc.expiresAt)).toBeLessThanOrEqual(Date.parse(doc.promotionalEndsAt));
    expectNoSupplierLeaks(r);
  });

  test('a promotional page that mentions a deadline we cannot parse blocks instead of assuming permanence', async () => {
    const r = rig(); seal(r);
    r.world.supplier.planHtml = '<html><body>公测期完全免费开放，付费档位即将上线 Free · 公测 限时放量 活动截止 另行通知</body></html>';
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'promotionalEnd', source: 'planPage' })]));
    expectNoSupplierLeaks(r);
  });

  test('upstream 5xx is a single bounded request and ends blocked, never retried or paid', async () => {
    const r = rig();
    seal(r);
    r.world.supplier.modelsStatus = 503;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(r.world.requests.filter(q => q.url.includes('token.sensenova.cn'))).toHaveLength(1);
    expect(onlyAllowedRequests(r)).toEqual([]);
    expectNoSupplierLeaks(r);
  });

  test('a redirect from any source is refused by policy', async () => {
    const r = rig();
    seal(r);
    r.world.supplier.planStatus = 302;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'planApplicability' })]));
    expectNoSupplierLeaks(r);
  });

  test('caller arguments are closed: urls, paths, creds and surprise fields are rejected', async () => {
    const r = rig();
    seal(r);
    for (const args of [
      { url: 'https://evil.example' }, { path: '/tmp/x' }, { noPaymentInstrument: true },
      { accountRef: 'abc' }, { autoTopupDisabled: true }, { token: 'x' },
    ]) {
      expect((await failure(sample(r, args))).code).toBe('invalid');
    }
    for (const purpose of ['see https://x.example', 'read /etc/passwd', 'Bearer abc', `id ${'a'.repeat(40)}`]) {
      expect((await failure(sample(r, { purpose }))).code).toBe('invalid');
    }
    expect(r.world.requests).toHaveLength(0);
    expectNoSupplierLeaks(r);
  });

  test('a dead lease cannot reach the sealed store or the provider at all', async () => {
    const r = rig();
    seal(r);
    r.company.endLease('qa-1');
    expect((await failure(sample(r))).code).toBe('forbidden');
    expect(r.world.requests).toHaveLength(0);
  });

  test('another task id on the same lease is refused before sampling', async () => {
    const r = rig();
    seal(r);
    const error = await failure(call(r, 'ops_supplier_plan_sample', { alias: ALIAS, purpose: PURPOSE }, { task: 'task-9' }));
    expect(error.code).toBe('forbidden');
    expect(r.world.requests).toHaveLength(0);
  });
});

describe('supplier time-source diagnostics and raw quota precision (15d775ea spec)', () => {
  const planPageGap = (result: Record<string, any>) =>
    result.gaps.find((g: { field: string; source: string }) => g.field === 'sourceDate' && g.source === 'planPage') as { detail: string } | undefined;
  const poolGap = (result: Record<string, any>) =>
    result.gaps.find((g: { field: string; source: string }) => g.field === 'poolWindow' && g.source === 'poolUsage') as { detail: string } | undefined;

  test('every probe records wall-clock triples, monotonic duration, raw cache/redirect metadata and body hash', async () => {
    const r = rig(); seal(r);
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    const planPage = result.receipt.sources.find((s: { name: string }) => s.name === 'planPage');
    expect(planPage).toMatchObject({ responseHost: 'www.sensenova.cn', redirectRejected: false });
    for (const key of ['requestStartedAt', 'headersAt', 'bodyCompletedAt', 'fetchedAt', 'httpDate']) {
      expect(typeof planPage[key]).toBe('string');
    }
    expect(planPage.httpDateEpochMs).toBe(r.world.clock);
    expect(planPage.monotonicMs).toBeGreaterThanOrEqual(0);
    expect(planPage.monotonicBodyMs).toBeGreaterThanOrEqual(planPage.monotonicMs);
    expect(planPage.bodyBytes).toBe(Buffer.byteLength(r.world.supplier.planHtml, 'utf8'));
    expect(planPage.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    // Every source, not just the plan page, carries the metadata.
    for (const record of result.receipt.sources) {
      expect(typeof record.requestStartedAt).toBe('string');
      expect(typeof record.responseHost).toBe('string');
    }
    expectNoSupplierLeaks(r);
  });

  test('source +779s on www while the API and host clocks agree → source-clock-skew, blocked, no document', async () => {
    const r = rig(); seal(r);
    r.world.supplier.planDateSkewMs = 779_000;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(result.documentSha256).toBeUndefined();
    expect(result).not.toHaveProperty('expiresAt');
    expect(planPageGap(result)?.detail).toContain('source-clock-skew');
    expect(planPageGap(result)?.detail).toContain('can never substitute for the web/console clock');
    expect(result.receipt.derivations.planPageClockSkewMs).toBeLessThan(0);
    expect(result.receipt.derivations.clockDomains.planPage.class).toBe('source-clock-skew');
    expect(result.receipt.derivations.clockDomains.api.class).toBe('ok');
    expectNoSupplierLeaks(r);
  });

  test('host +779s while the provider clocks agree → host-clock-skew, blocked', async () => {
    const r = rig(); seal(r);
    r.world.hostSkewMs = 779_000;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(planPageGap(result)?.detail).toContain('host-clock-skew');
    expect(result.receipt.derivations.clockDomains.api.class).toBe('host-clock-skew');
    expect(result.receipt.derivations.clockDomains.planPage.class).toBe('host-clock-skew');
    expectNoSupplierLeaks(r);
  });

  test('missing, invalid and redirect Dates block with their own classification', async () => {
    const missing = rig(); seal(missing);
    missing.world.supplier.planDate = false;
    expect(planPageGap(await sample(missing))?.detail).toContain('missing-date');

    const invalid = rig(); seal(invalid);
    invalid.world.supplier.planDateInvalid = true;
    expect(planPageGap(await sample(invalid))?.detail).toContain('invalid-date');

    const redirected = rig(); seal(redirected);
    redirected.world.supplier.planStatus = 302;
    const result = await sample(redirected);
    expect(result.status).toBe('blocked');
    expect(planPageGap(result)?.detail).toContain('redirect-date');
    const page = result.receipt.sources.find((s: { name: string }) => s.name === 'planPage');
    expect(page).toMatchObject({ redirectRejected: true, status: 302 });
    expect(page.location).toBe(redirected.world.supplier.planRedirectLocation);
    expectNoSupplierLeaks(redirected);
  });

  test('a stale cached body (Age > 5min) blocks as stale-cache-date even when the clock difference cancels', async () => {
    const r = rig(); seal(r);
    r.world.supplier.planCacheControl = 's-maxage=31536000';
    r.world.supplier.planAgeSeconds = 900;
    r.world.supplier.planDateSkewMs = 900_000;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(planPageGap(result)?.detail).toContain('stale-cache-date');
    expectNoSupplierLeaks(r);
  });

  test('a shared-cacheable page without Age blocks as cacheAgeUnknown', async () => {
    const r = rig(); seal(r);
    r.world.supplier.planCacheControl = 's-maxage=31536000';
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(planPageGap(result)?.detail).toContain('cacheAgeUnknown');
    expect(result.receipt.sources.find((s: { name: string }) => s.name === 'planPage')).toMatchObject({ cacheAgeUnknown: true, ageSeconds: null });
    expectNoSupplierLeaks(r);
  });

  test('the observed real-world shape (cacheable without Age and +779s source clock) reports both facts', async () => {
    const r = rig(); seal(r);
    r.world.supplier.planCacheControl = 's-maxage=31536000';
    r.world.supplier.planDateSkewMs = 779_000;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    const details = result.gaps.filter((g: { field: string; source: string }) => g.field === 'sourceDate' && g.source === 'planPage').map((g: { detail: string }) => g.detail);
    expect(details.some((d: string) => d.includes('cacheAgeUnknown'))).toBe(true);
    expect(details.some((d: string) => d.includes('source-clock-skew'))).toBe(true);
    expect(result.receipt.derivations.clockDomains.planPage).toMatchObject({ class: 'cacheAgeUnknown', skewClass: 'source-clock-skew' });
    expect(result.receipt.derivations.clockDomains.planPage.skewMs).toBeLessThan(0);
    expectNoSupplierLeaks(r);
  });

  test('conditional GET records 304 / same ETag as body identity only and never bypasses the clock gate', async () => {
    for (const mode of ['304', '200-same'] as const) {
      const r = rig(); seal(r);
      r.world.supplier.planDateSkewMs = 779_000;
      r.world.supplier.planConditional = mode;
      const result = await sample(r);
      expect(result.status).toBe('blocked');
      const conditional = result.receipt.derivations.planPageConditional;
      expect(conditional.status).toBe(mode === '304' ? 304 : 200);
      expect(conditional.sameEtag).toBe(true);
      expect(conditional.proves).toContain('never origin revalidation or content freshness');
      expect(planPageGap(result)?.detail).toContain('source-clock-skew');
      expectNoSupplierLeaks(r);
    }
    const diff = rig(); seal(diff);
    diff.world.supplier.planConditional = '200-diff';
    const changed = await sample(diff);
    expect(changed.receipt.derivations.planPageConditional).toMatchObject({ status: 200, sameEtag: false, sameBodySha256: false });
    expectNoSupplierLeaks(diff);
  });

  test('the pool snapshot records its Date/request id/hash and relative resets do not use the host clock', async () => {
    const r = rig(); seal(r);
    for (const pool of r.world.supplier.pools as Array<any>) {
      for (const window of [pool.window_5h, pool.window_7d]) window.reset_at = Math.floor(r.world.clock / 1000) + 1_800;
    }
    const normal = await sample(r);
    expect(normal.status).toBe('sampled');
    expect(normal.receipt.derivations.poolUsageSnapshot).toMatchObject({
      requestId: 'req-fixture-0001', clockClass: 'ok', sourceNowMs: r.world.clock,
    });
    expect(normal.receipt.derivations.poolUsageSnapshot.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(normal.receipt.derivations.poolUsageSnapshot.bodyBytes).toBeGreaterThan(0);
    // reset_in = 1800s, minus the full sampling duration and the explicit margin.
    expect(Date.parse(normal.expiresAt)).toBeLessThanOrEqual(r.world.clock + 1_800_000 - 60_000);
    expect(normal.receipt.derivations.expiryDerivation).toMatchObject({ minResetInMs: 1_800_000, marginMs: 60_000 });

    // Same reset distances, console clock +120s (inside the 5 minute bound): reset_at shifts
    // with the clock and the bias cancels, so expiry does not move.
    const fast = rig(); seal(fast);
    fast.world.supplier.poolDateSkewMs = 120_000;
    for (const pool of fast.world.supplier.pools as Array<any>) {
      for (const window of [pool.window_5h, pool.window_7d]) window.reset_at = Math.floor((fast.world.clock + 120_000) / 1000) + 1_800;
    }
    const skewed = await sample(fast);
    expect(skewed.status).toBe('sampled');
    expect(Math.abs(Date.parse(skewed.expiresAt) - Date.parse(normal.expiresAt))).toBeLessThanOrEqual(2_000);
    expect(Date.parse(skewed.expiresAt)).toBeLessThanOrEqual(fast.world.clock + 1_800_000 - 60_000);
    expectNoSupplierLeaks(fast);
  });

  test('console clock beyond 5 minutes blocks instead of publishing a source-domain absolute resetAt', async () => {
    const r = rig(); seal(r);
    r.world.supplier.poolDateSkewMs = 779_000;
    for (const pool of r.world.supplier.pools as Array<any>) {
      for (const window of [pool.window_5h, pool.window_7d]) window.reset_at = Math.floor((r.world.clock + 779_000) / 1000) + 1_800;
    }
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(result.documentSha256).toBeUndefined();
    expect(result).not.toHaveProperty('expiresAt');
    expect(poolGap(result)?.detail).toContain('source-clock-skew');
    expect(poolGap(result)?.detail).toContain('cannot be converted into a trusted domain');
    expect(result.receipt.derivations.poolUsageSnapshot.clockClass).toBe('source-clock-skew');
    expectNoSupplierLeaks(r);
  });

  test('plan page Date must be corroborated by the provider API Date across domains', async () => {
    // The API clock alone deviates: page/local agree, but the two provider domains contradict.
    const apiSkew = rig(); seal(apiSkew);
    apiSkew.world.supplier.modelsDateSkewMs = 779_000;
    const contradiction = await sample(apiSkew);
    expect(contradiction.status).toBe('blocked');
    expect(contradiction.document).toBeUndefined();
    expect(planPageGap(contradiction)?.detail).toContain('cross-domain clock contradiction');
    expect(contradiction.receipt.derivations.clockDomains.crossDomain).toMatchObject({ ok: false, deltaMs: -779_000 });
    expect(contradiction.receipt.derivations.clockDomains.api.class).toBe('host-clock-skew');
    expectNoSupplierLeaks(apiSkew);

    // No API Date at all: cross-domain corroboration is unavailable, so the page cannot pass.
    const noApiDate = rig(); seal(noApiDate);
    noApiDate.world.supplier.modelsDate = false;
    const unavailable = await sample(noApiDate);
    expect(unavailable.status).toBe('blocked');
    expect(unavailable.document).toBeUndefined();
    expect(planPageGap(unavailable)?.detail).toContain('cross-domain corroboration unavailable');
    expect(unavailable.receipt.derivations.clockDomains.crossDomain.ok).toBe(false);
    expectNoSupplierLeaks(noApiDate);
  });

  test('receipt skew formula matches the stored value and separates the Age-adjusted view', async () => {
    const r = rig(); seal(r);
    r.world.supplier.planAgeSeconds = 200;
    r.world.supplier.planCacheControl = 'public, max-age=600';
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    const pageClock = result.receipt.derivations.clockDomains.planPage;
    expect(pageClock).toMatchObject({ class: 'ok', skewMs: 0, ageSeconds: 200, ageAdjustedSkewMs: -200_000, probed: true });
    expect(pageClock.fieldSource).toContain('skewMs = headersAt − Date');
    expect(pageClock.fieldSource).toContain('ageAdjustedSkewMs = headersAt − (Date + Age)');
    expect(result.receipt.derivations.planPageClockSkewMs).toBe(pageClock.skewMs);
    expectNoSupplierLeaks(r);
  });

  test('an unusable console clock (missing Date / stale / cacheable without Age) blocks reset-based expiry', async () => {
    const missing = rig(); seal(missing);
    missing.world.supplier.poolDate = false;
    const missingResult = await sample(missing);
    expect(missingResult.status).toBe('blocked');
    expect(missingResult.document).toBeUndefined();
    expect(poolGap(missingResult)?.detail).toContain('missing-date');

    const stale = rig(); seal(stale);
    stale.world.supplier.poolAgeSeconds = 900;
    stale.world.supplier.poolDateSkewMs = 900_000;
    expect(poolGap(await sample(stale))?.detail).toContain('stale-cache-date');

    const unknown = rig(); seal(unknown);
    unknown.world.supplier.poolCacheControl = 'public, max-age=60';
    expect(poolGap(await sample(unknown))?.detail).toContain('cacheAgeUnknown');

    const invalid = rig(); seal(invalid);
    invalid.world.supplier.poolDate = false;
    expect(poolGap(await sample(invalid))?.detail).toContain('missing-date');
    for (const r of [missing, stale, unknown, invalid]) expectNoSupplierLeaks(r);
  });

  test('a missing used is never derived from limit − remaining and blocks', async () => {
    const r = rig(); seal(r);
    delete (r.world.supplier.pools[1] as any).window_7d.used;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.document).toBeUndefined();
    expect(result.gaps.some((g: { field: string }) => g.field === 'quota7d')).toBe(true);
    expect(result.receipt.pools[1]).toMatchObject({ used7d: null, used7dDerived: true });
    expect(result.receipt.pools[1].rawUsed7d).toEqual({ type: 'null', value: 'null' });
    expect(JSON.stringify(result.receipt.pools[1])).not.toContain('1199082');
    expectNoSupplierLeaks(r);
  });

  test('decimal raw quota values keep their exact type/value and block without a written rounding rule', async () => {
    for (const [used, remaining] of [[918.5, 1_199_081.5], ['918.5', '1199081.5']] as const) {
      const r = rig(); seal(r);
      const pool = r.world.supplier.pools[1] as any;
      pool.window_7d.used = used;
      pool.window_7d.remaining = remaining;
      const result = await sample(r);
      expect(result.status).toBe('blocked');
      expect(result.document).toBeUndefined();
      expect(result.gaps.some((g: { field: string }) => g.field === 'poolPrecision')).toBe(true);
      const raw = result.receipt.pools[1];
      expect(raw.rawUsed7d).toMatchObject({ type: typeof used === 'string' ? 'string' : 'number', value: String(used) });
      expect(raw.rawRemaining7d).toMatchObject({ value: String(remaining) });
      expectNoSupplierLeaks(r);
    }
  });

  test('an exact integer string is accepted without precision loss', async () => {
    const r = rig(); seal(r);
    (r.world.supplier.pools[0] as any).window_7d.used = '2000';
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    expect(result.document).toMatchObject({ schemaVersion: 3 });
    expect((result.document as any).pools[0].window7d.used).toBe(2_000);
    expect(result.receipt.pools[0].rawUsed7d).toEqual({ type: 'string', value: '2000' });
    expectNoSupplierLeaks(r);
  });

  test('off-by-one and off-by-two pool sums are still blocked, including the observed default 7d case', async () => {
    for (const remaining of [1_199_081, 1_199_080]) {
      const r = rig(); seal(r);
      const pool = r.world.supplier.pools[1] as any;
      pool.window_7d = { ...pool.window_7d, used: 918, remaining };
      const result = await sample(r);
      expect(result.status).toBe('blocked');
      expect(result.document).toBeUndefined();
      expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'poolConsistency', source: 'poolUsage' })]));
      expectNoSupplierLeaks(r);
    }
  });

  test('the 60k/18,000s cap and reported-used eligibility stay enforced after the precision work', async () => {
    const r = rig(); seal(r);
    (r.world.supplier.pools[0] as any).window_5h.used = 70_000;
    (r.world.supplier.pools[0] as any).window_5h.remaining = 50_000;
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    expect(result.document).toMatchObject({ quotaAmount: 50_000, quotaWindowSeconds: 18_000, quotaRemaining: 50_000 });
    expect((result.document as any).pools.every((p: any) => p.usedSource5h === 'reported' && p.usedSource7d === 'reported')).toBe(true);
    expectNoSupplierLeaks(r);
  });
});
