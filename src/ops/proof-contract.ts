import { createHash } from 'node:crypto';
import { z } from 'zod';
export const PROOF_ISSUER = 'urn:surreal-ck:company:internal-ai:v1';
export const PROOF_AUDIENCE = 'urn:surreal-ck:surreal_ck:production:internal-ai:v1';
export const PROOF_GOAL = '2e2a6e41c1193595';
export const APPROVAL_MARKER = 'company-internal-ai-approve:v1:';
/** 供应商账户计划类型读回常量：reviewed-token-plan 文档只接受 FREE，非 FREE 值不过校验。 */
export const TOKEN_PLAN_PLAN_TYPE_FREE = "TOKEN_PLAN_PLAN_TYPE_FREE";
const boundedRef = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
/** 供应商/计划出处只接受无凭据、无查询的 https URL：与 endpoint 同一规则，拒绝 userinfo/port/query/hash。 */
const httpsSource = z.string().url().refine(v => {
  const u = new URL(v);
  return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && !u.port;
});
/** 公司侧 model 是有界安全标识：非空安全片段以单点号分隔，长度 1..128，拒绝空白/斜杠/URL/Unicode。 */
const model = z.string().max(128).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?![\s\S])/);
const ref = boundedRef;
const endpoint = httpsSource;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const manifestIdentities = z.tuple([
  z.object({ alias: z.literal('LCA04_REMOVABLE'), workspaceRole: z.literal('admin'), billingRole: z.literal('owner') }).strict(),
  z.object({ alias: z.literal('LCA04_MEMBER'), workspaceRole: z.literal('participant'), billingRole: z.literal('member') }).strict(),
]);
const manifestBudget = z.object({ currency: z.literal('USD'), totalNanoUsd: z.number().int().positive().max(1_000_000_000), perAttemptNanoUsd: z.number().int().positive().max(100_000_000), maxAttempts: z.number().int().positive().max(30), autoTopupDisabled: z.literal(true) }).strict();
/** The frozen v1 manifest: direct supplier service binding (https endpoint + model). */
export const manifestV1Schema = z.object({
  schemaVersion: z.literal(1), goalId: z.literal(PROOF_GOAL), project: z.literal('surreal_ck'), env: z.literal('production'),
  activityId: ref, workspaceSlug: z.string().regex(/^[a-z0-9-]{1,40}$/), documentHash: hash,
  service: z.object({ accountRef: ref, endpoint, model, priceRevision: ref }).strict(),
  budget: manifestBudget,
  identities: manifestIdentities,
  configurationDigest: hash,
}).strict();
/**
 * A loopback Magpie gateway endpoint: its full scheme/host/port/path must be present, and it
 * must be the local gateway — no remote host, userinfo, query or fragment. Magpie is http on
 * loopback, which the v1 https-only service binding deliberately cannot represent.
 */
export const magpieEndpoint = z.string().url().refine(v => {
  const u = new URL(v);
  return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && !u.search && !u.hash
    && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname) && !!u.port && u.pathname === '/v1';
});
export const magpieAccountRef = z.string().regex(/^mgp[a-f0-9]{24}$/);
const providerModel = z.string().max(160).regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/);
/**
 * v2 manifest: the Magpie route binding, kept in its own version instead of mutating v1 fields.
 * The USD/30-attempt budget envelope and the two identities are unchanged.
 */
export const manifestV2Schema = z.object({
  schemaVersion: z.literal(2), goalId: z.literal(PROOF_GOAL), project: z.literal('surreal_ck'), env: z.literal('production'),
  activityId: ref, workspaceSlug: z.string().regex(/^[a-z0-9-]{1,40}$/), documentHash: hash,
  service: z.object({
    kind: z.literal('magpie-route'),
    accountRef: magpieAccountRef,
    endpoint: magpieEndpoint,
    routeId: z.literal('group/work'),
    routeDigest: hash,
    priceRevision: ref,
  }).strict(),
  budget: manifestBudget,
  identities: manifestIdentities,
  configurationDigest: hash,
}).strict();
export const manifestSchema = z.union([manifestV1Schema, manifestV2Schema]);
export type ProofManifest = z.infer<typeof manifestSchema>;
/** 三种证据文档共用的服务标识与采样窗口字段；余额与配额字段按 type 判别，互不混入。 */
const evidenceBase = {
  schemaVersion: z.literal(1),
  accountRef: boundedRef,
  endpoint: httpsSource,
  model,
  priceRevision: boundedRef,
  sampledAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  serviceApproved: z.boolean(),
};
const controlFreeText = (max: number) => z.string().min(1).max(max).refine(v => ![...v].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) == 127));
/**
 * 受审证据文档（公司侧 evidenceSchema 的等价物），按 type 判别的冻结联合：
 * - development-disabled / reviewed-service：USD-only 余额契约，字段与历史逐字一致；
 * - reviewed-token-plan（schemaVersion 2）：配额型供应商（无 USD 现金价目/余额），用官方 Token Plan
 *   出处、积分/次数配额与账户计划类型读回表达可用性；绝不允许把配额换算成美元写余额字段，
 *   也不接受 FX/CNY/未知币种。v1 的账户级断言（noPaymentInstrument/autoTopupDisabled）在供应商侧
 *   无可核定来源已移除；账户是否零扣费改由 accountPlanType=FREE 读回 + 官方付费功能未上线
 *   + 配额硬顶 + 零费率证书（worstCost=0）表达；auto_topup_disabled 由我方计量配置断言。
 */
export const reviewedEvidenceSchema = z.discriminatedUnion("type", [
  z.object({ ...evidenceBase, type: z.literal("development-disabled"), autoTopupDisabled: z.literal(true), currency: z.literal("USD"), balanceNanoUsd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ ...evidenceBase, type: z.literal("reviewed-service"), autoTopupDisabled: z.literal(true), currency: z.literal("USD"), balanceNanoUsd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({
    ...evidenceBase,
    schemaVersion: z.literal(2),
    type: z.literal("reviewed-token-plan"),
    /** 官方计划名（如 SenseNova Token Plan 公测档）：非空短文本，禁控制字符。 */
    planName: controlFreeText(200),
    /** 计划官方出处 URL（https、无 userinfo/port/query/hash）。 */
    planSourceUrl: httpsSource,
    /** 供应商账户计划类型读回值：仅接受 FREE 常量，非 FREE 即拒绝，不放宽为任意字符串。 */
    accountPlanType: z.literal(TOKEN_PLAN_PLAN_TYPE_FREE),
    /** 配额单位：积分点或请求次数；无 USD 语义。 */
    quotaUnit: z.enum(["points", "requests"]),
    /** 滚动窗口内的配额总量，必须为正整数。 */
    quotaAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    /** 配额滚动窗口秒数（如 5 小时 = 18000）。 */
    quotaWindowSeconds: z.number().int().positive(),
    /** 采样时剩余配额；可空（官方只读接口未核定时不得臆造），存在时必须非负。 */
    quotaRemaining: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  }).strict(),
]);
export type ReviewedEvidence = z.infer<typeof reviewedEvidenceSchema>;
/**
 * FV06 v3：限时账号绑定 FREE 公测观测。官方页只写「公测免费、限时放量」，不再给配额数字；
 * 配额数字仅来自已认证 console 的 account-bound 池观测，且只作为本次证据上界，不成为官方规则。
 * v2 的冻结 schema 保持逐字不变（见 proof-mirror 测试），v3 在其外独立定义。
 */
export const TOKEN_PLAN_EVIDENCE_CLASS = 'promotional-account-bound';
export const PLAN_HTML_FLAT_ALGORITHM = 'html-text-flat/1';
export const REVIEWED_QUOTA_AMOUNT = 60_000;
export const REVIEWED_QUOTA_WINDOW_SECONDS = 18_000;
const v3PoolWindow = z.object({
  limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  used: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  remaining: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  resetAt: z.string().datetime(),
}).strict().refine(w => w.used + w.remaining === w.limit, { message: 'used + remaining must equal limit' });
const v3Pool = z.object({
  poolType: z.string().min(1).max(40),
  name: controlFreeText(80),
  accountBound: z.literal(true),
  window5h: v3PoolWindow,
  window7d: v3PoolWindow,
  /** Whether `used` came from the provider payload or was derived as limit-remaining. */
  usedSource5h: z.enum(['reported', 'derived']),
  usedSource7d: z.enum(['reported', 'derived']),
}).strict();
export const tokenPlanEvidenceV3Schema = z.object({
  ...evidenceBase,
  schemaVersion: z.literal(3),
  type: z.literal("reviewed-token-plan"),
  evidenceClass: z.literal(TOKEN_PLAN_EVIDENCE_CLASS),
  planName: controlFreeText(200),
  planSourceUrl: httpsSource,
  planSource: z.object({
    url: httpsSource,
    /** Local UTC instant the official page response was received. */
    fetchedAt: z.string().datetime(),
    /** The origin's own Date header; required so freshness is not only our clock. */
    httpDate: z.string().datetime(),
    /** fetchedAt - httpDate in ms; bounded to ±5 minutes. */
    clockSkewMs: z.number().int().min(-300_000).max(300_000),
    status: z.number().int().min(200).max(299),
    etag: z.string().min(1).max(200).nullable(),
    rawSha256: hash,
  }).strict(),
  normalization: z.object({
    algorithm: z.literal(PLAN_HTML_FLAT_ALGORITHM),
    flatSha256: hash,
    flatChars: z.number().int().positive().max(1_000_000),
  }).strict(),
  accountPlanType: z.literal(TOKEN_PLAN_PLAN_TYPE_FREE),
  accountBound: z.literal(true),
  accountBoundSource: z.literal('console-pool-usage-cross-bound-to-sealed-api-key'),
  quotaUnit: z.enum(["points", "requests"]),
  /** The allowed upper bound for this evidence: <= the reviewed 60k/5h cap and <= every applicable pool's remaining. */
  quotaAmount: z.number().int().positive().max(REVIEWED_QUOTA_AMOUNT),
  quotaWindowSeconds: z.number().int().positive().max(REVIEWED_QUOTA_WINDOW_SECONDS),
  quotaRemaining: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  quotaSource: z.literal('account-bound-observation'),
  governingPool: z.object({
    poolType: z.string().min(1).max(40),
    basis: z.enum(['dedicated-pool-for-bound-model', 'default-pool', 'single-pool']),
  }).strict(),
  pools: z.array(v3Pool).min(1).max(8),
  /** Our measurement configuration asserts auto-recharge is disabled; not a provider read-back. */
  autoTopupDisabled: z.literal(true),
  /** Explicitly a limited-time promotional, account-bound observation — never a permanent official rule. */
  promotional: z.literal(true),
  revalidateBeforeUse: z.literal(true),
  terminationRisk: z.enum(['unknown-promotional-end', 'promotional-end-recorded']),
  promotionalEndsAt: z.string().datetime().nullable(),
  serviceApproved: z.boolean(),
}).strict().superRefine((v, ctx) => {
  const sampled = Date.parse(v.sampledAt), expires = Date.parse(v.expiresAt);
  const fail = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: path.split('.'), message });
  if (expires - sampled > 86_400_000) fail('expiresAt', 'evidence validity may not exceed 24 hours');
  if (v.planSource.url !== v.planSourceUrl) fail('planSource.url', 'planSource.url must equal planSourceUrl');
  const fetched = Date.parse(v.planSource.fetchedAt), httpDate = Date.parse(v.planSource.httpDate);
  const observedSkew = fetched - httpDate;
  if (!Number.isFinite(observedSkew) || v.planSource.clockSkewMs !== observedSkew) fail('planSource.clockSkewMs', 'clockSkewMs must equal fetchedAt - httpDate');
  if (!Number.isFinite(observedSkew) || Math.abs(observedSkew) > 300_000) fail('planSource.httpDate', 'source HTTP Date is more than five minutes from local fetch time');
  const poolRemainings = v.pools.flatMap(pool => [pool.window5h.remaining, pool.window7d.remaining]);
  const trustedRemaining = Math.min(...poolRemainings);
  if (v.quotaRemaining !== trustedRemaining) fail('quotaRemaining', 'quotaRemaining must equal the smallest pool window remaining');
  if (v.quotaAmount > trustedRemaining) fail('quotaAmount', 'allowed quota exceeds the smallest pool window remaining');
  const resets = v.pools.flatMap(pool => [Date.parse(pool.window5h.resetAt), Date.parse(pool.window7d.resetAt)]);
  if (resets.some(reset => !Number.isFinite(reset) || reset <= sampled)) fail('pools', 'a pool window already reset at sampling time');
  if (resets.length && expires > Math.min(...resets)) fail('expiresAt', 'evidence outlives the earliest pool window reset');
  if (!v.pools.some(pool => pool.poolType === v.governingPool.poolType)) fail('governingPool.poolType', 'governing pool is not listed');
  if (new Set(v.pools.map(pool => pool.poolType)).size !== v.pools.length) fail('pools', 'duplicate pool types are ambiguous');
  if (v.governingPool.basis === 'single-pool' && v.pools.length !== 1) fail('governingPool.basis', 'single-pool basis requires exactly one pool');
  if (v.governingPool.basis === 'dedicated-pool-for-bound-model' && v.governingPool.poolType !== 'dedicated') fail('governingPool.basis', 'dedicated basis requires the dedicated pool');
  if (v.governingPool.basis === 'default-pool' && v.governingPool.poolType !== 'default') fail('governingPool.basis', 'default basis requires the default pool');
  if (v.terminationRisk === 'promotional-end-recorded' && v.promotionalEndsAt === null) fail('terminationRisk', 'recorded promotional end requires promotionalEndsAt');
  if (v.terminationRisk === 'unknown-promotional-end' && v.promotionalEndsAt !== null) fail('terminationRisk', 'an unknown end cannot carry promotionalEndsAt');
  if (v.promotionalEndsAt !== null) {
    const end = Date.parse(v.promotionalEndsAt);
    if (end <= sampled) fail('promotionalEndsAt', 'promotional activity already ended at sampling time');
    if (expires > end) fail('expiresAt', 'evidence outlives the recorded promotional deadline');
  }
});
export type TokenPlanEvidenceV3 = z.infer<typeof tokenPlanEvidenceV3Schema>;
/**
 * The v3 eligibility gate reused by prepare/prove/deliver/diagnose. It re-derives the bounds from the
 * document itself, so a hand-written or tampered document cannot pass by claiming a larger cap.
 */
export function tokenPlanV3Eligible(e: TokenPlanEvidenceV3, now: number): boolean {
  if (e.evidenceClass !== TOKEN_PLAN_EVIDENCE_CLASS || !e.serviceApproved || e.accountPlanType !== TOKEN_PLAN_PLAN_TYPE_FREE) return false;
  if (!e.accountBound || !e.promotional || !e.revalidateBeforeUse || !e.autoTopupDisabled) return false;
  if (e.quotaUnit !== 'points' && e.quotaUnit !== 'requests') return false;
  if (e.quotaAmount <= 0 || e.quotaAmount > REVIEWED_QUOTA_AMOUNT || e.quotaWindowSeconds > REVIEWED_QUOTA_WINDOW_SECONDS) return false;
  if (e.planSource.url !== e.planSourceUrl) return false;
  const fetched = Date.parse(e.planSource.fetchedAt), httpDate = Date.parse(e.planSource.httpDate), observedSkew = fetched - httpDate;
  if (!Number.isFinite(observedSkew) || e.planSource.clockSkewMs !== observedSkew || Math.abs(observedSkew) > 300_000) return false;
  const sampled = Date.parse(e.sampledAt), expires = Date.parse(e.expiresAt);
  if (!Number.isFinite(sampled) || !Number.isFinite(expires)) return false;
  if (now - sampled > 86_400_000 || expires <= now || expires - sampled > 86_400_000) return false;
  const resets = e.pools.flatMap(pool => [Date.parse(pool.window5h.resetAt), Date.parse(pool.window7d.resetAt)]);
  if (!resets.length || resets.some(reset => !Number.isFinite(reset) || reset <= now || expires > reset)) return false;
  if (!e.pools.some(pool => pool.poolType === e.governingPool.poolType)) return false;
  if (e.governingPool.basis === 'single-pool' && e.pools.length !== 1) return false;
  if (e.governingPool.basis === 'dedicated-pool-for-bound-model' && e.governingPool.poolType !== 'dedicated') return false;
  if (e.governingPool.basis === 'default-pool' && e.governingPool.poolType !== 'default') return false;
  if (e.terminationRisk === 'promotional-end-recorded' && e.promotionalEndsAt === null) return false;
  if (e.terminationRisk === 'unknown-promotional-end' && e.promotionalEndsAt !== null) return false;
  const poolWindows = e.pools.flatMap(pool => [pool.window5h, pool.window7d]);
  if (poolWindows.some(window => window.used + window.remaining !== window.limit)) return false;
  // A derived `used` (limit − remaining) would make the consistency equation circular; only
  // provider-reported values may establish the pool facts (schema shape unchanged).
  if (e.pools.some(pool => pool.usedSource5h !== 'reported' || pool.usedSource7d !== 'reported')) return false;
  const trustedRemaining = Math.min(...poolWindows.map(window => window.remaining));
  if (e.quotaRemaining !== trustedRemaining || e.quotaAmount > trustedRemaining) return false;
  if (e.pools.some(pool => pool.accountBound !== true)) return false;
  if (e.promotionalEndsAt !== null && (Date.parse(e.promotionalEndsAt) <= now || expires > Date.parse(e.promotionalEndsAt))) return false;
  return true;
}
export const MAGPIE_SNAPSHOT_ID = 'magpie-controlled-snapshot/1';
/** Local snapshot freshness; explicitly not a provider promise. */
export const MAGPIE_SNAPSHOT_MAX_AGE_SECONDS = 7_200;
/** Minimum execution headroom before an approved window may use this evidence (90 minutes). */
export const MAGPIE_EXECUTION_HEADROOM_SECONDS = 5_400;
/** Source timestamp tolerance for a usage row relative to the local capture instant. */
export const MAGPIE_SOURCE_CLOCK_SKEW_MS = 300_000;
export const MAGPIE_EVIDENCE_CLASS = 'controlled-route-snapshot';
/** Canonical digest over the approved routable set; a route change alters it, invalidating the candidate. */
export function magpieRouteDigest(routable: Array<{ model: string; provider: string }>): string {
  return sha256(canonical([...routable].sort((a, b) => a.model === b.model ? (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) : a.model < b.model ? -1 : 1)));
}
const magpieSource = z.object({
  name: z.enum(['catalog', 'quotas', 'usage', 'providers']),
  kind: z.enum(['http', 'local-config']),
  locator: z.string().min(1).max(200),
  status: z.number().int().min(200).max(299).nullable(),
  capturedAt: z.string().datetime(),
  httpDate: z.string().datetime().nullable(),
  clockSkewMs: z.number().int().min(-300_000).max(300_000).nullable(),
  ageSeconds: z.number().int().min(0).nullable(),
  cacheControl: z.string().max(200).nullable(),
  rawSha256: hash.nullable(),
  bodyBytes: z.number().int().min(0).nullable(),
  /** The source's own read time when it reports one (Magpie quotas' readAt). */
  readAt: z.string().datetime().nullable(),
}).strict();
/**
 * v4: controlled Magpie route snapshot. It records what the local gateway actually served and
 * which approved route set it came from; unknown provider facts stay explicit (null/unknown)
 * instead of being inferred from the host clock or a zero price. The document is evidence, not
 * an approval: `serviceApproved` and `approvalReadiness` keep the two separate.
 */
export const magpieEvidenceV4Schema = z.object({
  schemaVersion: z.literal(4),
  type: z.literal('magpie-controlled-route'),
  evidenceClass: z.literal(MAGPIE_EVIDENCE_CLASS),
  accountRef: magpieAccountRef,
  endpoint: magpieEndpoint,
  priceRevision: ref,
  sampledAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  serviceApproved: z.boolean(),
  account: z.object({
    provider: ref,
    accountHash: hash,
    identityHash: hash,
    binding: z.enum(['company-sealed-account', 'unverified', 'mismatch']),
    ownership: z.enum(['company-sealed-account', 'unknown']),
    source: z.literal('magpie-quotas'),
  }).strict(),
  endpointBinding: z.object({
    source: z.enum(['env', 'stash', 'default', 'injected']),
    loopback: z.literal(true),
  }).strict(),
  route: z.object({
    group: z.literal('group/work'),
    revision: z.string().max(128).nullable(),
    revisionSource: z.enum(['magpie-config-digest', 'not-exposed']),
    digest: hash,
    digestAlgorithm: z.literal('canonical-json/1'),
    routable: z.array(z.object({ model: providerModel, provider: ref }).strict()).min(1).max(64),
    servedModel: providerModel,
    servedModelSource: z.literal('magpie-usage-requests'),
    association: z.literal('served-model-in-approved-routable-set'),
    observedAt: z.string().datetime(),
  }).strict(),
  snapshot: z.object({
    id: z.literal(MAGPIE_SNAPSHOT_ID),
    capturedAt: z.string().datetime(),
    maxAgeSeconds: z.number().int().min(60).max(21_600),
    invalidatesOn: z.array(z.enum(['route-digest-change', 'account-change', 'price-revision-change', 'quota-reset'])).min(1).max(8),
  }).strict(),
  sources: z.array(magpieSource).min(3).max(8),
  subscription: z.object({
    provider: ref,
    kind: z.enum(['subscription', 'plan', 'api', 'unknown']),
    until: z.string().datetime().nullable(),
    renew: z.string().max(40).nullable(),
    readAt: z.string().datetime().nullable(),
    windows: z.array(z.object({
      name: z.string().min(1).max(80),
      remainingPct: z.number().min(0).max(100),
      resetsAt: z.string().datetime().nullable(),
      limit: z.number().nonnegative().nullable(),
      amount: z.number().nonnegative().nullable(),
      unit: z.string().max(40).nullable(),
      unlimited: z.boolean(),
    }).strict()).min(1).max(30),
  }).strict(),
  balance: z.object({
    absoluteAmount: z.number().nonnegative().nullable(),
    unit: z.string().max(40).nullable(),
    source: z.literal('magpie-percentage-windows'),
    disclosure: z.literal('percentages are not an absolute balance'),
  }).strict(),
  usage: z.object({
    requestId: z.string().min(1).max(200),
    runId: z.string().min(1).max(64),
    provider: ref,
    servedModel: providerModel,
    at: z.string().datetime(),
    /** Hash of the gateway key id when it reports one; null records that absence instead of inventing one. */
    providerKeyIdHash: hash.nullable(),
    usage: z.object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cacheRead: z.number().int().nonnegative().nullable(),
      cacheWrite: z.number().int().nonnegative().nullable(),
      reasoning: z.number().int().nonnegative().nullable(),
      total: z.number().int().nonnegative().nullable(),
    }).strict(),
    /** null means unknown, never zero. */
    cost: z.number().nonnegative().nullable(),
    costUnknown: z.boolean(),
    priced: z.boolean(),
  }).strict(),
  pricing: z.object({
    priceRevision: ref,
    source: z.literal('magpie-catalog'),
    reviewed: z.boolean(),
    free: z.boolean(),
    freeEvidence: z.enum(['magpie-catalog-zero', 'none']),
    inputPerToken: z.number().nonnegative().nullable(),
    outputPerToken: z.number().nonnegative().nullable(),
    currency: z.string().max(8).nullable(),
    subscriptionCost: z.object({ disclosed: z.literal(false) }).strict(),
    marginalCost: z.object({ unitInput: z.number().nonnegative().nullable(), unitOutput: z.number().nonnegative().nullable() }).strict(),
  }).strict(),
  approvalReadiness: z.object({
    ready: z.boolean(),
    blockedReasons: z.array(z.enum(['account-ownership', 'price-not-reviewed'])).max(8),
  }).strict(),
}).strict().superRefine((v, ctx) => {
  const fail = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: path.split('.'), message });
  const sampled = Date.parse(v.sampledAt), expires = Date.parse(v.expiresAt);
  if (expires > sampled + v.snapshot.maxAgeSeconds * 1000) fail('expiresAt', 'evidence outlives the controlled snapshot maxAge');
  if (v.snapshot.capturedAt !== v.sampledAt) fail('snapshot.capturedAt', 'snapshot capture time must equal sampledAt');
  for (const source of v.sources) {
    const at = Date.parse(source.capturedAt);
    if (!Number.isFinite(at) || at < sampled - 1_000 || at > expires) fail('sources', 'a source capture time lies outside this snapshot');
    if (source.kind === 'local-config' && source.rawSha256 === null) fail('sources', 'a local-config source must be hashed');
    if (source.kind === 'http' && (source.status === null || source.rawSha256 === null)) fail('sources', 'an http source must be a 2xx read with a body hash');
    if (source.httpDate !== null) {
      const http = Date.parse(source.httpDate);
      if (!Number.isFinite(http) || source.clockSkewMs !== at - http || Math.abs(at - http) > 300_000) fail('sources', 'source clock skew must be the exact Date difference and within five minutes');
    } else if (source.clockSkewMs !== null) fail('sources', 'a source without HTTP Date cannot claim a clock skew');
  }
  if (v.route.revision === null && v.route.revisionSource !== 'not-exposed') fail('route.revision', 'a null revision must say the gateway does not expose one');
  if (v.route.revision !== null && v.route.revisionSource !== 'magpie-config-digest') fail('route.revision', 'a recorded revision needs a controlled source');
  if (new Set(v.route.routable.map(row => row.model)).size !== v.route.routable.length) fail('route.routable', 'duplicate routable models are ambiguous');
  if (v.route.digest !== magpieRouteDigest(v.route.routable)) fail('route.digest', 'route digest must cover the approved routable set');
  if (!v.route.routable.some(row => row.model === v.route.servedModel)) fail('route.servedModel', 'served model is outside the approved routable set');
  if (v.usage.servedModel !== v.route.servedModel) fail('usage.servedModel', 'usage served model must equal the route observation');
  if (v.route.observedAt !== v.usage.at) fail('route.observedAt', 'route observation must be the same usage event');
  const usageAt = Date.parse(v.usage.at);
  if (!Number.isFinite(usageAt) || usageAt > sampled + MAGPIE_SOURCE_CLOCK_SKEW_MS) fail('usage.at', 'a usage event cannot postdate the local capture');
  if (v.usage.provider !== v.account.provider) fail('usage.provider', 'usage provider must equal the bound account provider');
  if (v.subscription.provider !== v.account.provider) fail('subscription.provider', 'subscription provider must equal the bound account provider');
  if (v.priceRevision !== v.pricing.priceRevision) fail('priceRevision', 'top-level priceRevision must equal the pricing revision');
  if (v.pricing.free !== (v.pricing.freeEvidence === 'magpie-catalog-zero')) fail('pricing.freeEvidence', 'free must be backed by a zero-price catalog entry');
  if (v.usage.priced !== (v.usage.cost !== null)) fail('usage.cost', 'a priced usage must carry a number; an unpriced usage must stay null');
  if (v.usage.costUnknown === (v.usage.cost !== null)) fail('usage.costUnknown', 'unknown cost must be explicit and never zero-filled');
  for (const window of v.subscription.windows) {
    if (window.resetsAt !== null && Date.parse(window.resetsAt) <= sampled) fail('subscription.windows', 'a quota window already reset at sampling time');
    if (window.resetsAt !== null && Number.isFinite(expires) && expires > Date.parse(window.resetsAt)) fail('expiresAt', 'evidence outlives a known quota reset');
  }
  if (v.subscription.until !== null && Number.isFinite(expires) && expires > Date.parse(v.subscription.until)) fail('expiresAt', 'evidence outlives the subscription until');
  const bindingProven = v.account.binding === 'company-sealed-account' && v.account.ownership === 'company-sealed-account';
  if (!bindingProven && !v.approvalReadiness.blockedReasons.includes('account-ownership')) fail('approvalReadiness', 'unproven account ownership must block approval');
  if (!v.pricing.reviewed && !v.approvalReadiness.blockedReasons.includes('price-not-reviewed')) fail('approvalReadiness', 'an unreviewed price must block approval');
  if (v.approvalReadiness.ready !== (v.approvalReadiness.blockedReasons.length === 0)) fail('approvalReadiness.ready', 'ready must be the absence of blocked reasons');
});
export type MagpieEvidenceV4 = z.infer<typeof magpieEvidenceV4Schema>;
/**
 * The v4 eligibility gate. It re-derives the route digest, the approved set membership, the
 * account binding and the snapshot/headroom bounds from the document itself. A snapshot with
 * unreviewed pricing (the normal production state until GM decides) is valid evidence but is
 * not eligible for an enable proof or an execution window.
 */
export function magpieEvidenceEligible(e: MagpieEvidenceV4, now: number): boolean {
  if (e.type !== 'magpie-controlled-route' || e.evidenceClass !== MAGPIE_EVIDENCE_CLASS || !e.serviceApproved) return false;
  if (!e.approvalReadiness.ready || e.approvalReadiness.blockedReasons.length > 0) return false;
  if (e.account.binding !== 'company-sealed-account' || e.account.ownership !== 'company-sealed-account') return false;
  if (!e.pricing.reviewed) return false;
  const sampled = Date.parse(e.sampledAt), expires = Date.parse(e.expiresAt), usageAt = Date.parse(e.usage.at);
  if (![sampled, expires, usageAt].every(Number.isFinite)) return false;
  // The capture instant itself must already have happened; a hand-written future snapshot cannot open a window.
  if (sampled > now) return false;
  if (expires <= now || now - sampled > e.snapshot.maxAgeSeconds * 1000 || expires > sampled + e.snapshot.maxAgeSeconds * 1000) return false;
  // 90 minutes of execution headroom, measured against the evidence's own expiry.
  if (expires - now < MAGPIE_EXECUTION_HEADROOM_SECONDS * 1000) return false;
  if (usageAt > sampled + MAGPIE_SOURCE_CLOCK_SKEW_MS) return false;
  if (e.route.observedAt !== e.usage.at) return false;
  if (sampled - usageAt > e.snapshot.maxAgeSeconds * 1000) return false;
  if (e.route.group !== 'group/work' || e.route.digest !== magpieRouteDigest(e.route.routable)) return false;
  if (e.route.routable.some(row => row.provider !== e.account.provider)) return false;
  if (!e.route.routable.some(row => row.model === e.route.servedModel && row.provider === e.usage.provider)) return false;
  if (e.usage.servedModel !== e.route.servedModel || e.usage.provider !== e.account.provider) return false;
  if (e.usage.usage.input < 0 || e.usage.usage.output < 0) return false;
  if (e.subscription.readAt === null) return false;
  const readAt = Date.parse(e.subscription.readAt);
  if (!Number.isFinite(readAt) || sampled - readAt > e.snapshot.maxAgeSeconds * 1000 || readAt > sampled + 1_000) return false;
  // Match the v3 minimum-remaining rule: every non-unlimited window must still have quota. One exhausted
  // window is enough to make the route unusable even when a longer window is healthy.
  if (!e.subscription.windows.some(window => window.unlimited || window.remainingPct > 0)) return false;
  if (e.subscription.windows.some(window => !window.unlimited && window.remainingPct <= 0)) return false;
  if (e.subscription.windows.some(window => window.resetsAt !== null && Date.parse(window.resetsAt) <= now)) return false;
  if (e.subscription.until !== null && (Date.parse(e.subscription.until) <= now || expires > Date.parse(e.subscription.until))) return false;
  if (e.subscription.windows.some(window => window.resetsAt !== null && expires > Date.parse(window.resetsAt))) return false;
  if (e.priceRevision !== e.pricing.priceRevision) return false;
  return true;
}
export const evidenceSchema = z.union([...reviewedEvidenceSchema.options, tokenPlanEvidenceV3Schema, magpieEvidenceV4Schema]);
export type ServiceEvidence = z.infer<typeof evidenceSchema>;
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function configurationDigest(manifest: Omit<ProofManifest, 'configurationDigest'>): string { return sha256(canonical(manifest)); }
const base = { env: z.literal('production').optional() };
const files = { manifestPath: z.string().max(1024), documentPath: z.string().max(1024) };
export const proofToolSchemas = {
  ops_internal_ai_prepare: z.object({ ...base, ...files }).strict(),
  ops_internal_ai_prove: z.object({ ...base, ...files, mode: z.enum(['register-disabled', 'enable']), approvalTask: ref.optional(), activityId: ref, nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict(),
  ops_internal_ai_approval_diagnose: z.object({ ...base, ...files, approvalTask: ref, activityId: ref }).strict(),
  ops_internal_ai_deliver: z.object({ ...base, proofHandle: z.string().regex(/^p_[a-f0-9]{64}$/), session: z.string().max(128) }).strict(),
  ops_internal_ai_revoke: z.object({ ...base, proofHandle: z.string().regex(/^p_[a-f0-9]{64}$/) }).strict(),
  ops_internal_ai_trust: z.object(base).strict(),
  ops_internal_ai_rotate_key: z.object({ ...base, approvalTask: ref, expectedKid: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
};
export type ProofTool = keyof typeof proofToolSchemas;
export const identitySchema = z.object({ subject: z.string().min(1).max(200), spaceId: z.string().min(1).max(200), database: z.string().regex(/^[a-z0-9_]{1,128}$/), workspaceRole: z.enum(['admin', 'participant']), billingRole: z.enum(['owner', 'member']), billingAccountRef: z.string().min(1).max(200) }).strict();
export type ProofIdentity = z.infer<typeof identitySchema> & { alias: 'LCA04_REMOVABLE' | 'LCA04_MEMBER' };

export const proofToolContracts = Object.fromEntries(Object.entries(proofToolSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]));
