// SYS-DISP first-switch maintenance window (843d4e75 R1/R2): the executable preflight over the SYS01 GM read-only views.
//
// It reads only what a gm can already read — get_admin_summary (full-company counts with integrity) and paged get_context
// (task projection) — and decides two separate things:
//   1. capability: the GM read path is complete and consistent with the summary. Paged task rows can hide the caller's own
//      submitted reviews (core.ts: `state = 'review' AND submitted_by = $me`), so a review-count mismatch is a hard refusal.
//   2. window: with complete data, no new candidate may exist. The silent window is a conditional best-effort, not a
//      transactional barrier: any external owner action, crash or state move invalidates it and the caller must re-sample.
//
// Every unknown, missing field, truncation or drift fails closed.

export interface AdminSummaryView {
  cutoffAt: string;
  since: string;
  tasks: Record<string, number>;
  audit?: Record<string, number>;
  outboxSequence: number;
  integrity: { complete: boolean };
}

/** The projection the preflight requests from paged get_context. */
export const PREFLIGHT_FIELDS = [
  'id', 'state', 'executorRole', 'reviewerRole', 'blockedTo', 'submittedBy', 'currentEmployee',
  'fence', 'version', 'leaseExpiresAt', 'dependencies',
] as const;

export interface PreflightTask {
  id: string;
  state: string;
  executorRole?: string;
  reviewerRole?: string;
  blockedTo?: string;
  submittedBy?: string;
  currentEmployee?: string;
  fence?: number;
  version?: number;
  leaseExpiresAt?: string;
  dependencies?: string[];
}

export interface PageView {
  rows: PreflightTask[];
  /** True when the page reports another page; a complete read ends with false. */
  hasMore: boolean;
  /** The page's own total when it states one; compared with the summary when present. */
  total?: number;
  /** The fixed snapshot the page was read from; every page of one walk must name the same snapshot. */
  snapshotAt?: string;
}

/** The one execute lease the first switch may keep alive: the deployment task, named by all its proof fields. */
export interface DeploymentLease {
  taskId: string;
  holder: string;
  fence: number;
  version: number;
  expiresAt: string;
}

/** Paths that create or wake sessions without a task lease; each must be known and zero. */
export interface WindowExtras {
  triageGoals: number | null;
  pendingEvals: number | null;
  gmAttention: number | null;
}

export interface PreflightInput {
  summary: AdminSummaryView;
  pages: PageView[];
  extras: WindowExtras;
  deployment?: DeploymentLease;
  now?: number;
  /** A named deployment lease must have at least this much life left. */
  nearExpirySeconds?: number;
}

export interface PreflightVerdict {
  capability: { complete: boolean; reasons: string[]; tasks: Record<string, number>; outboxSequence: number | null };
  window: { allowed: boolean; reasons: string[]; admittedLease?: DeploymentLease };
}

const STATES = new Set(['ready', 'doing', 'review', 'blocked', 'done', 'void', 'triage', 'archived']);
const DEFAULT_NEAR_EXPIRY_SECONDS = 300;

const missingProjection = (row: PreflightTask): string[] => {
  const missing: string[] = [];
  if (typeof row.id !== 'string' || row.id.length === 0) missing.push('id');
  if (typeof row.state !== 'string' || row.state.length === 0) missing.push('state');
  if (typeof row.fence !== 'number') missing.push('fence');
  if (typeof row.version !== 'number') missing.push('version');
  // Reviewer and executor roles are part of the admission basis; an absent role is a missing field, not "no role".
  if (typeof row.executorRole !== 'string') missing.push('executorRole');
  if (typeof row.reviewerRole !== 'string') missing.push('reviewerRole');
  if (row.dependencies !== undefined && !Array.isArray(row.dependencies)) missing.push('dependencies');
  return missing;
};

const countByState = (rows: readonly PreflightTask[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  return counts;
};

const sameCounts = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
  return true;
};

/** Capability: the paged rows are the complete company task set the summary counted. Any gap is a refusal. */
function capability(input: PreflightInput): PreflightVerdict['capability'] {
  const reasons: string[] = [];
  const { summary, pages } = input;
  if (!summary.integrity?.complete) reasons.push('admin summary integrity.complete is not true');
  if (!Number.isSafeInteger(summary.outboxSequence) || summary.outboxSequence < 0) reasons.push('outbox sequence is missing or invalid');
  if (pages.length === 0) reasons.push('no pages were read');
  if (pages.some(page => page.hasMore)) reasons.push('pagination did not reach hasMore=false (truncated read)');
  // One walk must read one fixed snapshot; pages from different snapshots are a drift, not a complete read.
  const snapshots = [...new Set(pages.map(page => page.snapshotAt).filter((value): value is string => typeof value === 'string'))];
  if (snapshots.length > 1) reasons.push(`pagination crossed snapshots: ${snapshots.join(', ')}`);
  const rows = pages.flatMap(page => page.rows);
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) reasons.push(`duplicate task id in pages: ${row.id}`);
    seen.add(row.id);
    const missing = missingProjection(row);
    if (missing.length) reasons.push(`task ${row.id} is missing projection fields: ${missing.join(',')}`);
  }
  const unknownStates = [...new Set(rows.map(row => row.state))].filter(state => !STATES.has(state));
  if (unknownStates.length) reasons.push(`unknown task states: ${unknownStates.join(',')}`);
  const summaryStates = Object.keys(summary.tasks ?? {});
  const unknownSummaryStates = summaryStates.filter(state => !STATES.has(state));
  if (unknownSummaryStates.length) reasons.push(`summary has unknown task states: ${unknownSummaryStates.join(',')}`);
  const summaryCounts: Record<string, number> = {};
  for (const [state, n] of Object.entries(summary.tasks ?? {})) summaryCounts[state] = Number(n);
  const pageCounts = countByState(rows);
  if (!sameCounts(pageCounts, summaryCounts)) {
    reasons.push(`paged task counts do not match the summary (pages: ${JSON.stringify(pageCounts)}, summary: ${JSON.stringify(summaryCounts)})`);
  }
  // The caller's own submitted reviews are hidden from paged get_context; the summary still counts them. The mismatch
  // above catches it, but state it explicitly so an operator sees why a "clean" page list can still be refused.
  if ((pageCounts.review ?? 0) !== (summaryCounts.review ?? 0)) reasons.push('review rows are hidden or the summary moved (own submitted reviews are not paged)');
  for (const page of pages) {
    if (page.total !== undefined && page.total !== rows.length && pages.length === 1) reasons.push(`page total ${page.total} does not match ${rows.length} rows`);
  }
  return { complete: reasons.length === 0, reasons, tasks: summaryCounts, outboxSequence: Number.isSafeInteger(summary.outboxSequence) ? summary.outboxSequence : null };
}

/** Admission: with complete data, every source that could claim, wake or unlock during the switch must be empty. */
function admission(input: PreflightInput, capabilityVerdict: PreflightVerdict['capability']): PreflightVerdict['window'] {
  const reasons: string[] = [];
  if (!capabilityVerdict.complete) return { allowed: false, reasons: [...capabilityVerdict.reasons] };
  const rows = input.pages.flatMap(page => page.rows);
  const now = input.now ?? Date.now();
  const margin = (input.nearExpirySeconds ?? DEFAULT_NEAR_EXPIRY_SECONDS) * 1000;
  const leaseTime = (row: PreflightTask): number | undefined => {
    if (!row.leaseExpiresAt) return undefined;
    const parsed = Date.parse(row.leaseExpiresAt);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const lease = input.deployment;
  if (lease) {
    const parsed = Date.parse(lease.expiresAt);
    if (!Number.isFinite(parsed)) reasons.push('the named deployment lease has no valid expiry');
    else if (parsed <= now + margin) reasons.push('the named deployment lease is expired or inside the near-expiry window');
  }
  for (const row of rows) {
    switch (row.state) {
      case 'ready':
        // A ready task is a claim candidate; a ready task that still names a holder is abnormal and also refused.
        reasons.push(`ready task ${row.id} (a claim candidate${row.currentEmployee ? ', with an abnormal holder' : ''})`);
        break;
      case 'review':
        // Every review is refused: unclaimed reviews get claimed, live ones can accept/return (which may unlock
        // dependencies or return work to ready), and owner reviews can unlock dependents.
        reasons.push(`review task ${row.id} (unclaimed or live review; accept/return creates new work)`);
        break;
      case 'doing': {
        const matchesNamed = Boolean(lease) && row.id === lease!.taskId;
        if (!row.currentEmployee) {
          reasons.push(`doing task ${row.id} has no holder`);
          break;
        }
        if (!matchesNamed) {
          reasons.push(`doing task ${row.id} holds a live lease (${row.currentEmployee}); only the named deployment task may stay`);
          break;
        }
        if (row.currentEmployee !== lease!.holder || row.fence !== lease!.fence || row.version !== lease!.version) {
          reasons.push(`the named deployment lease does not match the server row (holder/fence/version)`);
          break;
        }
        const expiry = leaseTime(row);
        if (expiry === undefined) reasons.push(`the named deployment lease has no server expiry`);
        else if (expiry <= now + margin) reasons.push(`the named deployment lease is expired or near expiry`);
        break;
      }
      case 'blocked':
        if (row.blockedTo === 'gm' || row.blockedTo === 'owner') reasons.push(`blocked task ${row.id} is waiting for ${row.blockedTo}`);
        break;
      default:
        break;
    }
    // Any other row that still carries lease evidence (a moved state, a stale holder) is drift, not a safe window.
    if (row.state !== 'doing' && row.currentEmployee) reasons.push(`task ${row.id} is ${row.state} but still names a holder`);
  }
  const extras = input.extras;
  for (const [name, value] of Object.entries(extras)) {
    if (value === null || value === undefined) reasons.push(`${name} is unknown (a read failed); the window cannot be admitted`);
    else if (value !== 0) reasons.push(`${name} is ${value}; sessions that wake without a task lease must be empty`);
  }
  return { allowed: reasons.length === 0, reasons, ...(reasons.length === 0 && lease ? { admittedLease: lease } : {}) };
}

/** Runs both stages; capability is always reported, the window only when the data is complete. */
export function evaluatePreflight(input: PreflightInput): PreflightVerdict {
  const cap = capability(input);
  return { capability: cap, window: admission(input, cap) };
}
