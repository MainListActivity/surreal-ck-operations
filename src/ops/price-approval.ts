// remote-price-approval/1: the human price review marker for one remote-magpie candidate. The writer
// is ops_product_magpie_price_approve. It writes the marker into the approver's own task evidence root as
// an audit copy, and records the approval in the broker process. The window trusts only that in-process
// record. The evidence file is never read back, because markerDigest is an unkeyed hash that anyone who
// can write the file could recompute.
import { z } from 'zod';
import { CompanyError } from '../core-errors.ts';
import { canonical, sha256 } from './proof-contract.ts';
import { remoteConfigurationDigest, type RemoteMagpieEvidence } from './remote-magpie-evidence.ts';

export const PRICE_APPROVAL = 'remote-price-approval/1';
export const PRICE_APPROVAL_PREFIX = 'price-approval-';
const taskId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

const markerBody = z.object({
  version: z.literal(PRICE_APPROVAL),
  approverEmployee: z.string().min(1).max(120),
  approvalTask: taskId,
  configurationDigest: hash,
  priceRevision: z.string().min(1).max(80),
  pricing: z.object({
    free: z.boolean(),
    freeEvidence: z.enum(['remote-catalog-zero', 'none']),
  }).strict(),
  approvedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();
export const priceApprovalSchema = markerBody.extend({ markerDigest: hash }).strict();
export type PriceApprovalMarker = z.infer<typeof priceApprovalSchema>;

function markerDigestOf(body: z.infer<typeof markerBody>): string {
  return sha256(canonical(body));
}

/** One file per approver and digest, so a repeated approval replaces nothing and adds nothing. */
export function priceApprovalFileName(marker: Pick<PriceApprovalMarker, 'approverEmployee' | 'configurationDigest'>): string {
  return `${PRICE_APPROVAL_PREFIX}${sha256(marker.approverEmployee).slice(0, 12)}-${marker.configurationDigest.slice(0, 16)}.json`;
}

/**
 * Builds the sealed marker for a candidate. Refuses a candidate whose digest no longer matches its body,
 * a candidate with no catalog price (a missing price stays null and is never approved), and an approver
 * who wrote the candidate. The marker expires with the evidence, so an approval never outlives the sample.
 */
export function priceApprovalFor(input: {
  candidate: RemoteMagpieEvidence;
  approverEmployee: string;
  approvalTask: string;
  now: number;
}): PriceApprovalMarker {
  const { configurationDigest, ...body } = input.candidate;
  if (remoteConfigurationDigest(body) !== configurationDigest) throw new CompanyError('invalid', 'remote-magpie candidate was edited after it was generated');
  if (input.candidate.pricing.priceRevision === null) throw new CompanyError('invalid', 'candidate has no catalog price to approve (price-missing)');
  if (input.approverEmployee === input.candidate.author) throw new CompanyError('self_review', 'the candidate author may not approve its own price');
  const unsealed = {
    version: PRICE_APPROVAL,
    approverEmployee: input.approverEmployee,
    approvalTask: input.approvalTask,
    configurationDigest,
    priceRevision: input.candidate.pricing.priceRevision,
    pricing: { free: input.candidate.pricing.free, freeEvidence: input.candidate.pricing.freeEvidence },
    approvedAt: new Date(input.now).toISOString(),
    expiresAt: input.candidate.expiry.expiresAt,
  } as const;
  return { ...unsealed, markerDigest: markerDigestOf(unsealed) };
}
