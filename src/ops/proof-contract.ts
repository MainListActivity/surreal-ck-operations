import { createHash } from 'node:crypto';
import { z } from 'zod';
export const PROOF_ISSUER = 'urn:surreal-ck:company:internal-ai:v1';
export const PROOF_AUDIENCE = 'urn:surreal-ck:surreal_ck:production:internal-ai:v1';
export const PROOF_GOAL = '2e2a6e41c1193595';
export const APPROVAL_MARKER = 'company-internal-ai-approve:v1:';
const ref = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const endpoint = z.string().url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && !u.port; });
export const manifestSchema = z.object({
  schemaVersion: z.literal(1), goalId: z.literal(PROOF_GOAL), project: z.literal('surreal_ck'), env: z.literal('production'),
  activityId: ref, workspaceSlug: z.string().regex(/^[a-z0-9-]{1,40}$/), documentHash: hash,
  service: z.object({ accountRef: ref, endpoint, model: ref, priceRevision: ref }).strict(),
  budget: z.object({ currency: z.literal('USD'), totalNanoUsd: z.number().int().positive().max(1_000_000_000), perAttemptNanoUsd: z.number().int().positive().max(100_000_000), maxAttempts: z.number().int().positive().max(30), autoTopupDisabled: z.literal(true) }).strict(),
  identities: z.tuple([
    z.object({ alias: z.literal('LCA04_REMOVABLE'), workspaceRole: z.literal('admin'), billingRole: z.literal('owner') }).strict(),
    z.object({ alias: z.literal('LCA04_MEMBER'), workspaceRole: z.literal('participant'), billingRole: z.literal('member') }).strict(),
  ]), configurationDigest: hash,
}).strict();
export type ProofManifest = z.infer<typeof manifestSchema>;
export const evidenceSchema = z.object({
  schemaVersion: z.literal(1), type: z.enum(['development-disabled', 'reviewed-service']), accountRef: ref,
  endpoint, model: ref, priceRevision: ref, currency: z.literal('USD'), balanceNanoUsd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sampledAt: z.string().datetime(), expiresAt: z.string().datetime(), autoTopupDisabled: z.literal(true), serviceApproved: z.boolean(),
}).strict();
export type ServiceEvidence = z.infer<typeof evidenceSchema>;
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
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
