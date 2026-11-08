import { CompanyError } from './core-errors.ts';
import { hostIO } from './host-io.ts';

/**
 * SYS-INT: controlled non-production two-face switch & rollback drill.
 *
 * The production installer (scripts/company-service.sh) cannot be reused for drills: its launchd label,
 * plist path, plugin id and ports are hard-bound to the production service. A drill therefore runs a
 * minimal isolated harness under `<serviceHome>/drills/<runId>/` — its own fork database, its own ports
 * from a dedicated range, its own `active` symlink — and never invokes launchctl, paseo, the production
 * MCP port, the production database or any credential path. Every target is constructed here from the
 * runId alone: the tool caller names only business facts (runId, base/candidate SHA, task), so a
 * production target cannot be expressed, let alone reached.
 */

export const DRILL_PORT_MIN = 39200;
export const DRILL_PORT_MAX = 39299;

const SHA40 = /^[0-9a-f]{40}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DrillPlanInput {
  runId: string;
  baseSha: string;
  candidateSha: string;
}

export interface DrillPlan extends DrillPlanInput {
  root: string;
  releasesRoot: string;
  logsRoot: string;
  stagesRoot: string;
  dbPath: string;
  mcpPort: string;
  dbPort: string;
  namespace: string;
}

export interface DrillHostContext {
  serviceHome: string;
  /** True when a drill with this runId already has state on disk. */
  existingRun: (runId: string) => { status: string } | undefined;
  /** Resolves only when the commit exists in the ops repository. */
  commitExists: (sha: string) => Promise<boolean>;
  /** True when `ancestor` is an ancestor of `descendant` (or equal). */
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
  /** Probes whether a TCP port is free to bind on 127.0.0.1. */
  portFree: (port: number) => Promise<boolean>;
}

export function drillRootFor(serviceHome: string, runId: string): string {
  return hostIO().path.join(serviceHome, 'drills', runId);
}

/**
 * Validates a drill request into a fully constructed plan. Refuses: malformed runId/SHA, identical
 * base and candidate, unknown commits, a candidate that is not a descendant of the base, a runId
 * that already has drill state (replay), and any port in the dedicated drill range that cannot be
 * bound. Paths are derived from the validated runId — the caller cannot name a path at all.
 */
export async function validateDrillPlan(input: DrillPlanInput, ctx: DrillHostContext): Promise<DrillPlan> {
  if (!RUN_ID.test(input.runId)) throw new CompanyError('invalid', 'drill runId must be a UUID');
  if (!SHA40.test(input.baseSha)) throw new CompanyError('invalid', 'baseSha must be a 40-character commit sha');
  if (!SHA40.test(input.candidateSha)) throw new CompanyError('invalid', 'candidateSha must be a 40-character commit sha');
  if (input.baseSha === input.candidateSha) throw new CompanyError('invalid', 'candidateSha must differ from baseSha');
  const existing = ctx.existingRun(input.runId);
  if (existing) throw new CompanyError('conflict', `drill ${input.runId} already exists (status ${existing.status}); use a new runId for a new drill`);
  for (const [name, sha] of [['baseSha', input.baseSha], ['candidateSha', input.candidateSha]] as const) {
    if (!(await ctx.commitExists(sha))) throw new CompanyError('invalid', `${name} ${sha} is not a commit of the ops repository`);
  }
  if (!(await ctx.isAncestor(input.baseSha, input.candidateSha))) {
    throw new CompanyError('invalid', 'candidateSha must be a descendant of baseSha (the drill switches forward, then rolls back)');
  }
  const [mcpPort, dbPort] = await Promise.all([freeDrillPort(ctx), freeDrillPort(ctx)]);
  if (mcpPort === dbPort) throw new CompanyError('conflict', 'drill ports must be distinct');
  const root = drillRootFor(ctx.serviceHome, input.runId);
  const namespace = `sck_drill_${input.runId.replaceAll('-', '').slice(0, 13)}`;
  const { join } = hostIO().path;
  return {
    ...input,
    root,
    releasesRoot: join(root, 'releases'),
    logsRoot: join(root, 'logs'),
    stagesRoot: join(root, 'stages'),
    dbPath: join(root, 'database'),
    mcpPort: String(mcpPort),
    dbPort: String(dbPort),
    namespace,
  };
}

async function freeDrillPort(ctx: DrillHostContext): Promise<number> {
  for (let port = DRILL_PORT_MIN; port <= DRILL_PORT_MAX; port++) {
    if (await ctx.portFree(port)) return port;
  }
  throw new CompanyError('temporarily_unavailable', `no free port in the drill range ${DRILL_PORT_MIN}-${DRILL_PORT_MAX}`);
}

/** The ordered phases one drill executes; each stage record names its phase for the evidence log. */
export const DRILL_PHASES = [
  'prepare', // canonical root, archived releases for base+candidate, guards, content binding
  'db-up', // company-fork server on the drill port, rocksdb under the drill root
  'base-up', // MCP face + plugin-side channel both running from the base release
  'repoint-failure', // plugin repoint to a corrupted candidate source fails and is recovered
  'switch', // both faces actually switch to the candidate release
  'oracle', // leftover wait/budget/policy states: zero misdispatch, zero write, positive control
  'rollback', // both faces roll back to the base release
  'cleanup', // processes stopped, heavy artifacts removed, records kept
] as const;
export type DrillPhase = (typeof DRILL_PHASES)[number];
