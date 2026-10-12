import { z } from "zod";

/**
 * 公司内部AI可信证明的冻结消费契约。
 *
 * 这一份是**产品侧**对公司运营程序（surreal-ck-operations 的 ops 内部AI证明桥接）所出具
 * EdDSA 证明的**验签与字段约束**。信任锚是公钥材料（不是 secret），按 kid/JWK pin 固定；
 * 公司侧轮换 key 时必须同步改这里并随发布上线，不存在运行期可替换的信任源。
 *
 * 与公司侧公开契约逐字对齐的常量：
 * - PROOF_ISSUER / PROOF_AUDIENCE（公司 `src/ops/proof-contract.ts`）
 * - header `typ` = `sck-internal-ai-proof+jwt`、`alg` = `EdDSA`（公司 `src/ops/proof-signer.ts`）
 * - 证明最长 300 秒、状态最长 60 秒
 */

export const COMPANY_PROOF_ISSUER = "urn:surreal-ck:company:internal-ai:v1";
export const COMPANY_PROOF_AUDIENCE = "urn:surreal-ck:surreal_ck:production:internal-ai:v1";
export const COMPANY_PROOF_TYP = "sck-internal-ai-proof+jwt";
export const COMPANY_PROOF_ALG = "EdDSA";
export const COMPANY_PROOF_MAX_AGE_SECONDS = 300;
export const COMPANY_PROOF_MAX_BYTES = 32_000;

/** 公司 goal 与项目标识：与内部AI预算门禁同一目标，不接受其它目标的活动证明。 */
export const COMPANY_PROOF_GOAL = "2e2a6e41c1193595";
export const COMPANY_PROOF_PROJECT = "surreal_ck";

/** 供应商账户计划类型读回常量：reviewed-token-plan 文档只接受 FREE，非 FREE 值不过校验。 */
export const TOKEN_PLAN_PLAN_TYPE_FREE = "TOKEN_PLAN_PLAN_TYPE_FREE";

/** 固定 kid 与公钥 JWK。轮换只能改代码并发布，不允许 env 覆盖。 */
export const COMPANY_PROOF_TRUST = {
  alg: COMPANY_PROOF_ALG,
  kid: "0719aac25150983bd6d3880ade42ddc1",
  jwk: { crv: "Ed25519", x: "t6pCNI7dk-wP10MJ-2o_WMSFGGUvApmbqmWjysJv9h8", kty: "OKP" },
} as const;

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const boundedRef = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
/** 供应商/计划出处只接受无凭据、无查询的 https URL：与 endpoint 同一规则，拒绝 userinfo/port/query/hash。 */
const httpsSource = z.string().url().refine(v => {
  const u = new URL(v);
  return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && !u.port;
});
/** 公司侧 model 是有界安全标识：非空安全片段以单点号分隔，长度 1..128，拒绝空白/斜杠/URL/Unicode。 */
const model = z.string().max(128).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?![\s\S])/);

/** manifest 与 evidence 的 model 必须一致，且端点/账户/价目引用跨文件相同。 */
export const companyProofManifestSchema = z.object({
  schemaVersion: z.literal(1),
  goalId: z.literal(COMPANY_PROOF_GOAL),
  project: z.literal(COMPANY_PROOF_PROJECT),
  env: z.literal("production"),
  activityId: boundedRef,
  workspaceSlug: z.string().regex(/^[a-z0-9-]{1,40}$/),
  documentHash: hex64,
  service: z.object({
    accountRef: boundedRef,
    endpoint: z.string().url().refine(v => {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && !u.port;
    }),
    model,
    priceRevision: boundedRef,
  }).strict(),
  budget: z.object({
    currency: z.literal("USD"),
    totalNanoUsd: z.number().int().positive().max(1_000_000_000),
    perAttemptNanoUsd: z.number().int().positive().max(100_000_000),
    maxAttempts: z.number().int().positive().max(30),
    autoTopupDisabled: z.literal(true),
  }).strict(),
  identities: z.tuple([
    z.object({ alias: z.literal("LCA04_REMOVABLE"), workspaceRole: z.literal("admin"), billingRole: z.literal("owner") }).strict(),
    z.object({ alias: z.literal("LCA04_MEMBER"), workspaceRole: z.literal("participant"), billingRole: z.literal("member") }).strict(),
  ]),
  configurationDigest: hex64,
}).strict();
export type CompanyProofManifest = z.infer<typeof companyProofManifestSchema>;

/** 已核定的身份投影：subject 只以哈希形式落库，绝不原文外泄。 */
export const companyProofIdentitySchema = z.object({
  alias: z.enum(["LCA04_REMOVABLE", "LCA04_MEMBER"]),
  subject: z.string().min(1).max(200),
  spaceId: z.string().min(1).max(200),
  database: z.string().regex(/^[a-z0-9_]{1,128}$/),
  workspaceRole: z.enum(["admin", "participant"]),
  billingRole: z.enum(["owner", "member"]),
  billingAccountRef: z.string().min(1).max(200),
}).strict();
export type CompanyProofIdentity = z.infer<typeof companyProofIdentitySchema>;

const leaseSchema = z.object({
  goal: z.literal(COMPANY_PROOF_GOAL),
  project: z.literal(COMPANY_PROOF_PROJECT),
  role: z.enum(["engineering", "product", "qa"]),
  employee: z.string().min(1).max(200),
  taskId: boundedRef,
  delivery: z.string().min(1).max(200),
  fence: z.number().int().nonnegative(),
}).strict();

const approvalSchema = z.object({
  taskId: boundedRef,
  version: z.number().int().positive(),
  action: z.enum(["accept", "owner_approve"]),
  auditId: z.string().min(1).max(200),
  reviewer: z.string().min(1).max(200),
  digest: hex64,
}).strict();

/** 公司 proof JWT 的 claims：与公司 proof-bridge 的 sign('proof', …) 载荷一一对应。 */
export const companyProofClaimsSchema = z.object({
  contractVersion: z.literal(1),
  /** development-disabled 只允许登记，不允许启用；approved-service 才可走 enable。 */
  type: z.enum(["development-disabled", "approved-service"]),
  paidCallsAllowed: z.union([z.literal(0), z.literal(1)]),
  scope: z.enum(["register-disabled", "enable"]),
  project: z.literal(COMPANY_PROOF_PROJECT),
  env: z.literal("production"),
  goal: z.literal(COMPANY_PROOF_GOAL),
  requestTask: boundedRef,
  lease: leaseSchema,
  approval: approvalSchema.nullable(),
  documentHash: hex64,
  manifest: companyProofManifestSchema,
  configurationDigest: hex64,
  identities: z.tuple([companyProofIdentitySchema, companyProofIdentitySchema]),
  identitiesDigest: hex64,
  jti: z.string().min(1).max(200),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  iat: z.number().int(),
  exp: z.number().int(),
  status: z.object({ path: z.literal("/internal-ai/status"), bearer: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  iss: z.literal(COMPANY_PROOF_ISSUER),
  aud: z.literal(COMPANY_PROOF_AUDIENCE),
}).strict();
export type CompanyProofClaims = z.infer<typeof companyProofClaimsSchema>;

/** 公司 `ops_internal_ai_deliver` 投递到 `/api/ops/internal-ai/company-proof` 的请求体。 */
export const companyProofEnvelopeSchema = z.object({ proof: z.string().min(1).max(COMPANY_PROOF_MAX_BYTES) }).strict();

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

/** 提交证据文档的请求体上限：与公司侧读取边界一致（256KiB），且正文绝不落库。 */
export const REVIEWED_DOCUMENT_MAX_BYTES = 256 * 1024;

export const reviewedDocumentEnvelopeSchema = z.object({
  revision: z.number().int().positive(),
  document: z.string().min(1).max(REVIEWED_DOCUMENT_MAX_BYTES),
  reason: z.string().min(1).max(500),
}).strict();

/** enable 前置校验失败时返回的缺口清单：调用方按字段名补证据，不允许猜。 */
export const companyProofGapSchema = z.array(z.enum([
  "approved-service-evidence",
  "balance-evidence",
  "balance-currency",
  "balance-positive",
  "balance-sampled-at",
  "evidence-not-expired",
  "auto-topup-disabled",
  "service-approved",
  "price-certificate",
  "identity-binding",
  "identity-revoked",
  "budget-bounds",
  // 配额型证据（reviewed-token-plan）专用缺口：替代 USD 余额三项检查，语义不互换。
  "quota-evidence",
  "quota-positive",
  "account-plan-free",
]));
export type CompanyProofGap = z.infer<typeof companyProofGapSchema>[number];
