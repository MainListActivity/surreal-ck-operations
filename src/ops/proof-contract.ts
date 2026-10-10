import { createHash } from 'node:crypto';
import { z } from 'zod';
export const PROOF_ISSUER = 'urn:surreal-ck:company:internal-ai:v1';
export const PROOF_AUDIENCE = 'urn:surreal-ck:surreal_ck:production:internal-ai:v1';
export const PROOF_GOAL = '2e2a6e41c1193595';
export const APPROVAL_MARKER = 'company-internal-ai-approve:v1:';
const ref = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
// 仅 model 允许非空版本片段；绝对末尾断言同时拒绝尾部换行。
const model = z.string().max(128).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?![\s\S])/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const endpoint = z.string().url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && !u.port; });
export const manifestSchema = z.object({
  schemaVersion: z.literal(1), goalId: z.literal(PROOF_GOAL), project: z.literal('surreal_ck'), env: z.literal('production'),
  activityId: ref, workspaceSlug: z.string().regex(/^[a-z0-9-]{1,40}$/), documentHash: hash,
  service: z.object({ accountRef: ref, endpoint, model, priceRevision: ref }).strict(),
  budget: z.object({ currency: z.literal('USD'), totalNanoUsd: z.number().int().positive().max(1_000_000_000), perAttemptNanoUsd: z.number().int().positive().max(100_000_000), maxAttempts: z.number().int().positive().max(30), autoTopupDisabled: z.literal(true) }).strict(),
  identities: z.tuple([
    z.object({ alias: z.literal('LCA04_REMOVABLE'), workspaceRole: z.literal('admin'), billingRole: z.literal('owner') }).strict(),
    z.object({ alias: z.literal('LCA04_MEMBER'), workspaceRole: z.literal('participant'), billingRole: z.literal('member') }).strict(),
  ]), configurationDigest: hash,
}).strict();
export type ProofManifest = z.infer<typeof manifestSchema>;
/** 非空短文本且不含控制字符：证据文档自由文本字段统一边界。 */
const controlFreeText = (max: number) => z.string().min(1).max(max).refine(v => ![...v].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) == 127));
/** 三种证据文档共用的服务标识与采样窗口字段；余额与配额字段按 type 判别，互不混入。 */
const evidenceBase = { schemaVersion: z.literal(1), accountRef: ref, endpoint, model, priceRevision: ref, sampledAt: z.string().datetime(), expiresAt: z.string().datetime(), autoTopupDisabled: z.literal(true), serviceApproved: z.boolean() };
const balanceEvidence = { currency: z.literal('USD'), balanceNanoUsd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) };
/**
 * 受审证据文档，按 type 判别的冻结联合，字段与产品侧 reviewedEvidenceSchema 逐字一致：
 * - development-disabled / reviewed-service：USD-only 余额契约；
 * - reviewed-token-plan：配额型供应商（无 USD 现金价目/余额），用官方计划出处与积分/次数配额表达可用性；
 *   绝不允许把配额换算成美元写余额字段，也不接受 FX/CNY/未知币种。
 */
export const evidenceSchema = z.discriminatedUnion('type', [
  z.object({ ...evidenceBase, type: z.literal('development-disabled'), ...balanceEvidence }).strict(),
  z.object({ ...evidenceBase, type: z.literal('reviewed-service'), ...balanceEvidence }).strict(),
  z.object({
    ...evidenceBase, type: z.literal('reviewed-token-plan'),
    /** 官方计划名（如 SenseNova Token Plan 公测档）：非空短文本，禁控制字符。 */
    planName: controlFreeText(200),
    /** 计划官方出处 URL：与 endpoint 同一规则，拒绝 userinfo/port/query/hash。 */
    planSourceUrl: endpoint,
    /** 配额单位：积分点或请求次数；无 USD 语义。 */
    quotaUnit: z.enum(['points', 'requests']),
    /** 滚动窗口内的配额总量，必须为正整数。 */
    quotaAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    /** 配额滚动窗口秒数（如 5 小时 = 18000）。 */
    quotaWindowSeconds: z.number().int().positive(),
    /** 采样时剩余配额；可空（官方只读接口未核定时不得臆造），存在时必须非负。 */
    quotaRemaining: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    /** 账户无任何支付方式绑定：字面 true，缺省/臆造即拒。 */
    noPaymentInstrument: z.literal(true),
  }).strict(),
]);
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
  ops_internal_ai_deliver: z.object({ ...base, proofHandle: z.string().regex(/^p_[a-f0-9]{64}$/), session: z.string().max(128) }).strict(),
  ops_internal_ai_revoke: z.object({ ...base, proofHandle: z.string().regex(/^p_[a-f0-9]{64}$/) }).strict(),
  ops_internal_ai_trust: z.object(base).strict(),
  ops_internal_ai_rotate_key: z.object({ ...base, approvalTask: ref, expectedKid: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
};
export type ProofTool = keyof typeof proofToolSchemas;
export const identitySchema = z.object({ subject: z.string().min(1).max(200), spaceId: z.string().min(1).max(200), database: z.string().regex(/^[a-z0-9_]{1,128}$/), workspaceRole: z.enum(['admin', 'participant']), billingRole: z.enum(['owner', 'member']), billingAccountRef: z.string().min(1).max(200) }).strict();
export type ProofIdentity = z.infer<typeof identitySchema> & { alias: 'LCA04_REMOVABLE' | 'LCA04_MEMBER' };

export const proofToolContracts = Object.fromEntries(Object.entries(proofToolSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]));
