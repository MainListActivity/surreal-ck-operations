// ops_supplier_plan_sample: the controlled SenseNova plan/quota evidence sampler. The fake
// world answers as the real provider surfaces (chat /v1/models, console pool-usage and
// api-keys, public token-plan page) so success and every fail-closed path are exercised
// without touching a real account or spending provider quota.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { OPS_TOOLS, OpsBroker } from '../src/ops/broker.ts';
import { evidenceSchema } from '../src/ops/proof-contract.ts';
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

describe('ops_supplier_plan_sample', () => {
  test('tool is enumerated and surfaced with its fixed service binding in ops_info', async () => {
    expect(OPS_TOOLS).toContain('ops_supplier_plan_sample');
    const r = rig();
    seal(r);
    const info = await call(r, 'ops_info');
    expect(info.supplierPlanSampling).toMatchObject({
      provider: 'sensenova', adapter: 'sensenova-token-plan/1',
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

  test('a fully verified account produces a schema-valid document, sha256 and both files', async () => {
    const r = rig();
    seal(r);
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    expect(result.accountRef).toMatch(/^snv[a-f0-9]{24}$/);
    const doc = result.document;
    expect(evidenceSchema.safeParse(doc).success).toBe(true);
    expect(doc).toMatchObject({
      type: 'reviewed-token-plan', model: 'sensenova-6.8-flash-lite',
      priceRevision: 'sensenova-token-plan-2026-10-10', endpoint: 'https://token.sensenova.cn/v1',
      planSourceUrl: 'https://www.sensenova.cn/token-plan',
      quotaUnit: 'points', quotaAmount: 60_000, quotaWindowSeconds: 18_000,
      quotaRemaining: 59_400, // the dedicated Flash-Lite pool's 5h remainder
      noPaymentInstrument: true, autoTopupDisabled: true, serviceApproved: true,
    });
    expect(doc.planName).toContain('公测');
    // expiresAt is bounded by the governing pool's 5h window reset (earlier than +24h).
    const sampledMs = Date.parse(doc.sampledAt);
    expect(Date.parse(doc.expiresAt)).toBeGreaterThan(sampledMs);
    expect(Date.parse(doc.expiresAt)).toBeLessThanOrEqual(sampledMs + 24 * 3600_000);
    expect(Date.parse(doc.expiresAt)).toBe(r.world.supplier.pools[0]!.window_5h.reset_at * 1000);

    const dir = join(r.home, 'evidence', 'task-1');
    const docFile = join(dir, `supplier-plan-sensenova-${sampledMs}.json`);
    const receiptFile = join(dir, `supplier-plan-sensenova-${sampledMs}-receipt.json`);
    expect(result.documentFile).toBe(docFile);
    expect(result.receiptFile).toBe(receiptFile);
    const raw = readFileSync(docFile);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(result.documentSha256);
    expect(JSON.parse(raw.toString('utf8'))).toEqual(doc);
    expect(statSync(docFile).mode & 0o777).toBe(0o600);
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    expect(receipt).toMatchObject({ generated: true, alias: ALIAS, purpose: PURPOSE, taskId: 'task-1', documentSha256: result.documentSha256 });
    expect(receipt.pools).toHaveLength(2); // dual pools preserved as side evidence
    expect(receipt.sources.map((s: { name: string }) => s.name).sort()).toEqual(['apiKeys', 'models', 'planPage', 'poolUsage']);
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

  test('sealed console credentials auto-issue a session token → sampled with real facts', async () => {
    const r = rig();
    seal(r, { consoleToken: false, consoleCreds: true });
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    expect(result.document.type).toBe('reviewed-token-plan');
    expect(result.document.serviceApproved).toBe(true);
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

  test('a drifted pool-usage schema blocks rather than guessing quota', async () => {
    const r = rig();
    seal(r);
    (r.world.supplier as any).pools = undefined;
    const result = await sample(r);
    expect(result.status).toBe('blocked');
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'quota', source: 'poolUsage' })]));
    expectNoSupplierLeaks(r);
  });

  test('a missing remaining figure yields quotaRemaining null, not a fabricated number', async () => {
    const r = rig();
    seal(r);
    (r.world.supplier.pools[0]!.window_5h as { remaining: number | null }).remaining = null as never;
    const result = await sample(r);
    expect(result.status).toBe('sampled');
    expect(result.document.quotaRemaining).toBeNull();
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'quotaRemaining' })]));
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
