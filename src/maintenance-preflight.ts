// SYS-DISP first-switch maintenance window (843d4e75 R1/R2): the executable preflight over the SYS01 GM read-only views.
//
// It reads only what a gm can already read — get_admin_summary (full-company counts with integrity) and paged get_context
// (task projection over the working set) — and decides two separate things:
//   1. capability: the GM read path is complete and consistent. The two views count different scopes: the summary counts
//      every task state (done/void/triage included), while paged get_context lists only the working set (ready/doing/
//      review/blocked) and hides the caller's own submitted reviews. The comparison is therefore per working state; the
//      review difference is reported as hidden own reviews and never treated as a truncated read.
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

/** The projection the preflight requests from paged get_context. listsTruncated is echoed only when a row was cut. */
export const PREFLIGHT_FIELDS = [
  'id', 'state', 'executorRole', 'reviewerRole', 'blockedTo', 'submittedBy', 'currentEmployee',
  'fence', 'version', 'leaseExpiresAt', 'dependencies', 'listsTruncated',
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
  /** The echo's cut flags: a key is present when that list was cut to fit the item budget. */
  listsTruncated?: Record<string, unknown>;
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
  capability: { complete: boolean; reasons: string[]; tasks: Record<string, number>; hiddenReviews: number; outboxSequence: number | null };
  window: { allowed: boolean; reasons: string[]; admittedLease?: DeploymentLease };
}

/** The states paged get_context lists (it never lists done/void/triage rows). */
const WORKING_STATES = ['ready', 'doing', 'review', 'blocked'] as const;
const STATES = new Set([...WORKING_STATES, 'done', 'void', 'triage', 'archived']);
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

const workingCounts = (tasks: Record<string, number>): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const state of WORKING_STATES) counts[state] = Number(tasks[state] ?? 0);
  return counts;
};

/**
 * Capability: the paged working set is consistent with the summary, on the same scope. The summary counts every state;
 * only the working states are compared. Reviews the caller submitted are hidden from paged get_context, so a smaller
 * paged review count is expected and reported (the summary count still forbids the window); a larger one is a mismatch.
 */
function capability(input: PreflightInput): PreflightVerdict['capability'] {
  const reasons: string[] = [];
  const { summary, pages } = input;
  if (!summary.integrity?.complete) reasons.push('admin summary integrity.complete is not true');
  if (!Number.isSafeInteger(summary.outboxSequence) || summary.outboxSequence < 0) reasons.push('outbox sequence is missing or invalid');
  if (pages.length === 0) reasons.push('no pages were read');
  // A walk is complete when its LAST page reports hasMore=false; an earlier page with hasMore=true is the normal
  // "another page follows" marker, not a truncated read.
  if (pages.length > 0 && pages[pages.length - 1]!.hasMore) reasons.push('pagination did not reach hasMore=false (truncated read)');
  // A page that claims another page must also carry a cursor, and pages must not repeat a snapshot.
  if (pages.some((page, index) => page.hasMore && index === pages.length - 1)) reasons.push('the last page still reports more rows');
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
    // A cut row may carry only part of its dependency list; admission would then miss a blocked dependency.
    const cut = row.listsTruncated && typeof row.listsTruncated === 'object' ? Object.keys(row.listsTruncated) : [];
    if (cut.length) reasons.push(`task ${row.id} lists were truncated (${cut.join(', ')}); its dependencies cannot be read whole`);
  }
  const unknownStates = [...new Set(rows.map(row => row.state))].filter(state => !STATES.has(state));
  if (unknownStates.length) reasons.push(`unknown task states: ${unknownStates.join(',')}`);
  const nonWorking = [...new Set(rows.map(row => row.state))].filter(state => !(WORKING_STATES as readonly string[]).includes(state));
  if (nonWorking.length) reasons.push(`paged rows include non-working states: ${nonWorking.join(',')}`);
  const unknownSummaryStates = Object.keys(summary.tasks ?? {}).filter(state => !STATES.has(state));
  if (unknownSummaryStates.length) reasons.push(`summary has unknown task states: ${unknownSummaryStates.join(',')}`);
  const pageCounts = countByState(rows);
  const summaryWorking = workingCounts(summary.tasks ?? {});
  for (const state of ['ready', 'doing', 'blocked'] as const) {
    if ((pageCounts[state] ?? 0) !== summaryWorking[state]!) {
      reasons.push(`paged ${state} count ${pageCounts[state] ?? 0} does not match the summary ${summaryWorking[state]}`);
    }
  }
  const hiddenReviews = Math.max(0, (summaryWorking.review ?? 0) - (pageCounts.review ?? 0));
  if ((pageCounts.review ?? 0) > (summaryWorking.review ?? 0)) {
    reasons.push(`paged review count ${pageCounts.review} exceeds the summary ${summaryWorking.review}`);
  }
  const workingTotal = WORKING_STATES.reduce((sum, state) => sum + (summaryWorking[state] ?? 0), 0);
  if (rows.length + hiddenReviews !== workingTotal) {
    reasons.push(`working-set size ${workingTotal} is not the paged rows ${rows.length} plus hidden own reviews ${hiddenReviews}`);
  }
  const totals = [...new Set(pages.map(page => page.total).filter((value): value is number => typeof value === 'number'))];
  if (totals.length > 1) reasons.push(`pages report different totals: ${totals.join(', ')}`);
  if (totals.length === 1 && totals[0] !== rows.length) reasons.push(`page total ${totals[0]} does not match ${rows.length} paged rows`);
  return {
    complete: reasons.length === 0, reasons, tasks: { ...workingCounts(summary.tasks ?? {}), ...summary.tasks },
    hiddenReviews, outboxSequence: Number.isSafeInteger(summary.outboxSequence) ? summary.outboxSequence : null,
  };
}

/** Admission: with complete data, every source that could claim, wake or unlock during the switch must be empty. */
function admission(input: PreflightInput, capabilityVerdict: PreflightVerdict['capability']): PreflightVerdict['window'] {
  const reasons: string[] = [];
  if (!capabilityVerdict.complete) return { allowed: false, reasons: [...capabilityVerdict.reasons] };
  const rows = input.pages.flatMap(page => page.rows);
  const pageCounts = countByState(rows);
  const summaryWorking = workingCounts(input.summary.tasks ?? {});
  const now = input.now ?? Date.now();
  const margin = (input.nearExpirySeconds ?? DEFAULT_NEAR_EXPIRY_SECONDS) * 1000;
  // The summary is the authority for "does any candidate exist"; hidden own reviews exist only here.
  if ((summaryWorking.ready ?? 0) > 0) reasons.push(`the summary counts ${summaryWorking.ready} ready task(s); every ready task is a claim candidate`);
  if ((summaryWorking.review ?? 0) > 0) reasons.push(`the summary counts ${summaryWorking.review} review task(s), including any the caller submitted (hidden from pages)`);
  if ((summaryWorking.blocked ?? 0) !== (pageCounts.blocked ?? 0)) reasons.push(`blocked rows cannot be read whole (summary ${summaryWorking.blocked}, pages ${pageCounts.blocked ?? 0})`);
  if ((summaryWorking.doing ?? 0) !== (pageCounts.doing ?? 0)) reasons.push(`doing rows cannot be read whole (summary ${summaryWorking.doing}, pages ${pageCounts.doing ?? 0})`);
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

/** One read of the two GM views: `call` is backed by sck in production and by the real core in the fork tests. */
export type PreflightCall = (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface CollectOptions {
  pageSize?: number;
  maxPages?: number;
}

/** Reads the summary and walks the paged working set to hasMore=false. Throws when the read shape is not the paged one. */
export async function collectPreflightInput(call: PreflightCall, options: CollectOptions = {}): Promise<{ summary: AdminSummaryView; pages: PageView[] }> {
  const summary = await call('get_admin_summary', {}) as unknown as AdminSummaryView;
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 500;
  const pages: PageView[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < maxPages; index++) {
    const answer = await call('get_context', { pageSize, fields: [...PREFLIGHT_FIELDS], ...(cursor === undefined ? {} : { cursor }) });
    const rows = Array.isArray(answer.tasks) ? answer.tasks as PreflightTask[] : undefined;
    const page = answer.page as { hasMore?: unknown; nextCursor?: unknown; total?: unknown; snapshotAt?: unknown } | undefined;
    if (!rows || !page || typeof page.hasMore !== 'boolean') throw new Error('get_context did not return the paged task shape');
    pages.push({
      rows, hasMore: page.hasMore,
      total: typeof page.total === 'number' ? page.total : undefined,
      snapshotAt: typeof page.snapshotAt === 'string' ? page.snapshotAt : undefined,
    });
    if (!page.hasMore) break;
    if (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0) throw new Error('page.hasMore is true but no nextCursor was issued');
    cursor = page.nextCursor;
  }
  return { summary, pages };
}
