// remote-magpie-evidence/1: the product's remote-magpie evidence candidate. It is built only from
// what the read-only remote observation reports. A field the remote does not state stays null with
// a gap; nothing is filled from the local clock, local configuration or a constant. A candidate is
// not an approval. A window opens only when a different employee has approved the catalog price for
// the same configuration digest, and the evidence still has the execution headroom left.
import { z } from 'zod';
import { canonical, sha256, MAGPIE_EXECUTION_HEADROOM_SECONDS } from './proof-contract.ts';
import type { ProductMagpieObservation } from './product-magpie.ts';

export const REMOTE_MAGPIE_EVIDENCE = 'remote-magpie-evidence/1';
export const REMOTE_MAGPIE_MODEL = 'remote-magpie/group/work';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const isoTime = z.string().datetime();
const accountRef = z.string().regex(/^mgp[a-f0-9]{24}$/);
const gap = z.object({ field: z.string().max(40), reason: z.string().max(240) }).strict();

/** The owner-approved sampling envelope. It is an argument, never read from an earlier cycle. */
export const samplingBudgetSchema = z.object({
  currency: z.literal('USD'),
  totalNanoUsd: z.number().int().positive().max(1_000_000_000),
  perAttemptNanoUsd: z.number().int().positive().max(100_000_000),
  maxAttempts: z.number().int().positive().max(1_000),
}).strict();
export type SamplingBudget = z.infer<typeof samplingBudgetSchema>;

/** A reviewed price decision. It must come from an employee other than the candidate's author. */
export interface PriceApproval {
  approverEmployee: string;
  configurationDigest: string;
  priceRevision: string;
  approvedAt: string;
  /** Set on approvals the broker recorded. An approval past this instant no longer counts. */
  approvalTask?: string;
  expiresAt?: string;
}

const usageRow = z.object({
  requestId: z.string().max(200).nullable(),
  routeId: z.string().max(64).nullable(),
  at: z.string().max(240).nullable(),
  servedModel: z.string().max(160).nullable(),
  provider: z.string().max(128).nullable(),
  accountBinding: z.union([accountRef, z.literal('unknown')]),
  completed: z.boolean(),
  status: z.number().nullable(),
  stop: z.string().max(40).nullable(),
  durationMs: z.number().nullable(),
  usage: z.object({
    input: z.number().nullable(), output: z.number().nullable(), cacheRead: z.number().nullable(),
    cacheWrite: z.number().nullable(), reasoning: z.number().nullable(),
  }).strict(),
  cost: z.number().nullable(),
  costUnknown: z.boolean(),
}).strict();

const candidateBody = z.object({
  version: z.literal(REMOTE_MAGPIE_EVIDENCE),
  author: z.string().min(1).max(120),
  source: z.object({
    kind: z.literal('configured-remote-magpie'),
    endpoint: z.string().url(),
    model: z.literal(REMOTE_MAGPIE_MODEL),
    executionHost: z.literal('remote'),
  }).strict(),
  observation: z.object({
    capturedAt: isoTime,
    digest: hash,
    routingConfigurationVerified: z.literal(false),
  }).strict(),
  accountRef: accountRef.nullable(),
  accountBinding: z.union([accountRef, z.literal('unknown')]),
  route: z.object({
    present: z.boolean(),
    group: z.literal('group/work'),
    revision: z.string().max(128).nullable(),
    digest: z.string().max(128).nullable(),
    servedModel: z.string().max(160).nullable(),
    sampledAt: isoTime.nullable(),
    expiresAt: isoTime.nullable(),
    gaps: z.array(gap).max(32),
  }).strict(),
  usage: z.array(usageRow).max(10),
  coverage: z.object({
    complete: z.boolean(),
    truncated: z.boolean(),
    rowsRead: z.number().int().min(0),
    matchingRows: z.number().int().min(0),
    stoppedReason: z.string().max(40),
    scannedOffset: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  }).strict(),
  pricing: z.object({
    priceRevision: z.string().max(80).nullable(),
    rawPrompt: z.string().max(64).nullable(),
    rawCompletion: z.string().max(64).nullable(),
    free: z.boolean(),
    freeEvidence: z.enum(['remote-catalog-zero', 'none']),
    reviewed: z.literal(false),
  }).strict(),
  expiry: z.object({
    basis: z.literal('local-observation-freshness-policy'),
    localFreshnessExpiresAt: isoTime,
    sourceExpiresAt: z.array(isoTime).max(16),
    expiresAt: isoTime,
  }).strict(),
  budget: samplingBudgetSchema.nullable(),
  gaps: z.array(gap).max(64),
}).strict();

export const remoteMagpieEvidenceSchema = candidateBody.extend({ configurationDigest: hash }).strict();
export type RemoteMagpieEvidence = z.infer<typeof remoteMagpieEvidenceSchema>;
type CandidateBody = z.infer<typeof candidateBody>;

/** Digest over every field except the digest itself. Any hand edit changes it, so a window refuses the file. */
export function remoteConfigurationDigest(body: CandidateBody): string {
  return sha256(canonical(body));
}

export function buildRemoteMagpieCandidate(input: {
  observation: ProductMagpieObservation;
  author: string;
  budget: SamplingBudget | null;
}): RemoteMagpieEvidence {
  const o = input.observation;
  const gaps: CandidateBody['gaps'] = [];
  const note = (field: string, reason: string) => gaps.push({ field, reason });

  // One bound account per candidate. Rows that name two accounts leave the binding unknown.
  const refs = new Set(o.usage.map(row => row.accountRef).filter((v): v is string => v !== null));
  const accountRef = refs.size === 1 ? [...refs][0]! : null;
  if (accountRef === null) note('accountBinding', refs.size > 1 ? '扫描到的用量行属于多个账号，不能绑定为单一账号' : '扫描范围内没有可派生身份的用量行，账号未绑定');

  // Pricing comes from the served model of the first matching row. Rows that disagree stay unpriced.
  const first = o.usage[0];
  const servedModels = new Set(o.usage.map(row => row.servedModel));
  let priceRevision: string | null = null;
  if (!first) note('pricing', '扫描范围内没有匹配的用量行，无法取得 catalog 价目');
  else if (servedModels.size > 1) note('pricing', '匹配行的 served model 不一致，不取价目');
  else if (first.pricing.rawPrompt === null || first.pricing.rawCompletion === null) note('pricing', 'catalog 未给出价目原文，保持未知（不写 0）');
  else priceRevision = `remote-magpie-catalog-${sha256(canonical({ model: first.servedModel, prompt: first.pricing.rawPrompt, completion: first.pricing.rawCompletion })).slice(0, 12)}`;
  const free = !!first && first.pricing.inputPerToken === 0 && first.pricing.outputPerToken === 0;

  // Expiry is the earlier of the local observation freshness policy and any source expiry the remote
  // states. It is not a supplier promise.
  const sourceExpiresAt: string[] = [];
  if (o.route.expiresAt !== null) sourceExpiresAt.push(o.route.expiresAt);
  for (const account of o.accounts) {
    if (accountRef === null || account.accountRef !== accountRef) continue;
    for (const window of account.windows) if (window.resetsAt !== null) sourceExpiresAt.push(window.resetsAt);
  }
  const localFreshnessExpiresAt = o.observationSnapshot.freshnessExpiresAt;
  const expiresAt = [localFreshnessExpiresAt, ...sourceExpiresAt].reduce((min, value) => (Date.parse(value) < Date.parse(min) ? value : min));

  for (const routeGap of o.route.gaps) note(`route.${routeGap.field}`, routeGap.reason);
  if (!o.route.present) note('route', '远端目录中没有 group/work 路由');
  if (!input.budget) note('budget', '未提供采样包络（次数/USD 上限/证据期），窗口闭锁');
  // A truncated scan may have missed another served model, so the first matching price is not the route's price.
  if (!o.coverage.complete) note('coverage', `扫描未完成（${o.coverage.stoppedReason}），匹配范围之外的 served model 与价目未知，窗口闭锁`);

  const body: CandidateBody = {
    version: REMOTE_MAGPIE_EVIDENCE,
    author: input.author,
    source: { kind: 'configured-remote-magpie', endpoint: o.source.endpoint, model: REMOTE_MAGPIE_MODEL, executionHost: 'remote' },
    observation: { capturedAt: o.capturedAt, digest: o.observationSnapshot.digest, routingConfigurationVerified: false },
    accountRef,
    accountBinding: accountRef ?? 'unknown',
    route: {
      present: o.route.present,
      group: 'group/work',
      revision: o.route.revision,
      digest: o.route.digest,
      servedModel: o.route.servedModel,
      sampledAt: o.route.sampledAt,
      expiresAt: o.route.expiresAt,
      gaps: o.route.gaps,
    },
    usage: o.usage.slice(0, 10).map(row => ({
      requestId: row.requestId, routeId: row.routeId, at: row.at, servedModel: row.servedModel, provider: row.provider,
      accountBinding: row.accountBinding, completed: row.completed, status: row.status, stop: row.stop, durationMs: row.durationMs,
      usage: row.usage, cost: row.cost, costUnknown: row.costUnknown,
    })),
    coverage: {
      complete: o.coverage.complete, truncated: o.coverage.truncated, rowsRead: o.coverage.rowsRead,
      matchingRows: o.coverage.matchingRows, stoppedReason: o.coverage.stoppedReason, scannedOffset: o.coverage.scannedOffset,
    },
    pricing: {
      priceRevision,
      rawPrompt: first?.pricing.rawPrompt ?? null,
      rawCompletion: first?.pricing.rawCompletion ?? null,
      free,
      freeEvidence: free ? 'remote-catalog-zero' : 'none',
      reviewed: false,
    },
    expiry: { basis: 'local-observation-freshness-policy', localFreshnessExpiresAt, sourceExpiresAt, expiresAt },
    budget: input.budget,
    gaps,
  };
  return { ...body, configurationDigest: remoteConfigurationDigest(body) };
}

/** What the broker itself recorded when it read the remote: the observation and the employee who generated the candidate. */
export interface TrustedRecord {
  observation: ProductMagpieObservation;
  author: string;
}

export interface RemoteWindowResult {
  eligible: boolean;
  blockedReasons: string[];
  window?: { approvalTask: string; configurationDigest: string; evidenceExpiresAt: string; minRemainingSeconds: number; notAfter: string };
}

/**
 * Rebuilds the candidate from the trusted observation the broker stored when it read the remote, then
 * compares every body field. The candidate file is only a copy: its own digest can be recomputed by
 * anyone, so the rebuilt values are the reference. Expiry and route are named separately because they
 * are the fields a candidate would extend or invent.
 */
function observationReasons(c: RemoteMagpieEvidence, trusted: TrustedRecord | undefined): string[] {
  if (!trusted || trusted.observation.observationSnapshot.digest !== c.observation.digest) return ['observation-untrusted'];
  // The author comes from the broker's own record of who generated the candidate, never from the file.
  if (c.author !== trusted.author) return ['candidate-author-mismatch'];
  const { configurationDigest: _digest, ...rebuilt } = buildRemoteMagpieCandidate({ observation: trusted.observation, author: trusted.author, budget: c.budget });
  const { configurationDigest: _claimed, ...claimed } = c;
  const reasons: string[] = [];
  for (const key of Object.keys(rebuilt) as Array<keyof typeof rebuilt>) {
    if (canonical(rebuilt[key]) === canonical(claimed[key])) continue;
    reasons.push(key === 'route' ? 'route-not-from-observation' : key === 'expiry' ? 'expiry-not-from-observation' : 'candidate-not-from-observation');
  }
  return reasons;
}

/**
 * The window check for a remote candidate. It writes nothing and binds nothing. A window needs the
 * candidate to match the trusted observation, an independent price approval for this digest and price
 * revision, the owner's budget envelope, and the execution headroom. Expired evidence is refused, never
 * extended. Approvals only decide the price gate: they never make a changed field acceptable.
 */
export function remoteMagpieWindow(c: RemoteMagpieEvidence, input: { approvalTask: string; now: number; approvals: PriceApproval[]; trusted: TrustedRecord | undefined }): RemoteWindowResult {
  const reasons = new Set<string>();
  const { configurationDigest, ...body } = c;
  if (remoteConfigurationDigest(body) !== configurationDigest) reasons.add('candidate-digest-mismatch');
  for (const reason of observationReasons(c, input.trusted)) reasons.add(reason);
  // Self-approval is judged against the trusted author. A file that names another author cannot change who may approve.
  const trustedAuthor = input.trusted?.author;
  if (Date.parse(c.observation.capturedAt) > input.now) reasons.add('sample-in-future');
  if (c.accountRef === null) reasons.add('account-unbound');
  if (!c.route.present) reasons.add('route-absent');
  if (c.route.servedModel === null) reasons.add('served-model-missing');
  if (c.pricing.priceRevision === null) reasons.add('price-missing');
  else if (!input.approvals.some(a => trustedAuthor !== undefined && a.approverEmployee !== trustedAuthor && a.configurationDigest === configurationDigest && a.priceRevision === c.pricing.priceRevision && (a.expiresAt === undefined || Date.parse(a.expiresAt) > input.now))) reasons.add('price-not-reviewed');
  if (!c.budget) reasons.add('budget-missing');
  if (c.coverage.complete !== true) reasons.add('coverage-incomplete');
  const expiresMs = Date.parse(c.expiry.expiresAt);
  if (input.now >= expiresMs) reasons.add('evidence-expired');
  else if (expiresMs - input.now < MAGPIE_EXECUTION_HEADROOM_SECONDS * 1000) reasons.add('insufficient-headroom');
  if (reasons.size) return { eligible: false, blockedReasons: [...reasons] };
  return {
    eligible: true,
    blockedReasons: [],
    window: {
      approvalTask: input.approvalTask,
      configurationDigest,
      evidenceExpiresAt: c.expiry.expiresAt,
      minRemainingSeconds: MAGPIE_EXECUTION_HEADROOM_SECONDS,
      notAfter: new Date(expiresMs - MAGPIE_EXECUTION_HEADROOM_SECONDS * 1000).toISOString(),
    },
  };
}
