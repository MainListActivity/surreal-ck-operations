import {assertLocalMagpieScope,observeProductMagpie,PRODUCT_MAGPIE_MODEL,ProductGatewaySourceMismatch,type ProductMagpieObservation} from './product-magpie.ts';
import {buildRemoteMagpieCandidate,remoteMagpieEvidenceSchema,remoteMagpieWindow,samplingBudgetSchema,type PriceApproval,type TrustedRecord} from './remote-magpie-evidence.ts';
import {priceApprovalFileName,priceApprovalFor} from './price-approval.ts';
import {parsePlatformOperatorsView} from './platform-operators.ts';
// Ops capability broker. Employees never hold credentials: they ask for an operation by name,
// this trusted code (running inside the Paseo plugin, next to the sealed secrets and the
// Cloudflare token) performs it, and only a secret-free result goes back. Every call is gated
// on the caller's live task lease, role-checked against the project environment, and audited.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CompanyCore, OpsScope, RecoveryReadScope } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import {
  RECOVERY_READ_ALIAS, RECOVERY_READ_PATHS, RECOVERY_READ_TOOLS, classifyRecoveryRead, recoveryBodyDigest,
  type RecoveryReadTool,
} from '../recovery-read.ts';
import { faultFactsOf, type FaultPhase, type FaultRefund, type FaultTargetKind } from '../faults.ts';
import { lanIPv4 } from '../preview-core.ts';
import type { EnvBrokerRow, ProjectStore } from '../projects.ts';
import {
  accountEmail, accountUsername, aliasFromSecretName, canonicalAlias, ensureAccount, passwordSecretName,
  type EnsureAccountResult,
} from './accounts.ts';
import { egoBrowserInjector, oidcUserEntry, type BrowserInjector } from './browser.ts';
import { controlPlaneEnv, parseBrokerConfig, type BrokerConfig, type ControlPlaneEnv } from './config.ts';
import { cloudflareD1, type D1Client } from './d1.ts';
import { opsFetch, type Fetcher } from './fetcher.ts';
import { originLogsRequest, sshOriginAgent, type OriginAgent, type OriginRequest } from './origin.ts';
import { surrealQueryAsUser, type QueryAsUser } from './data.ts';
import { jwtExpiry, jwtSubject, LoginError, passwordLogin, type LoginTokens } from './idp.ts';
import { audienceUrl, clientId, describeSpaClient, redirectUriList, registerSpaClient, spaClientName } from './idp-clients.ts';
import {
  claimName, claimQualifiers, deleteClientClaims, describeQualifiers,
  listClientClaims, resolveClient, scanClaimsByName,
} from './idp-claims.ts';
import {
  adminRequestTarget, findServicePrincipal, idpAdminRequest, insertServicePrincipal,
  listServicePrincipals, mintServicePrincipalToken,
  principalAliasSecretName, principalId, principalTokenSecretName, recordIdpAuditBestEffort,
  revokeServicePrincipal, sha256Base64Url, type ServicePrincipal,
} from './idp-principals.ts';
import { productRequest, ProductUnreachable, type ProductResult } from './product.ts';
import { SUPPLIER_ADAPTER, SUPPLIER_PROVIDER, SUPPLIER_SERVICE, sampleSupplierPlan, supplierAliasFromSecretName } from './supplier.ts';
import { MAGPIE_ADAPTER, MAGPIE_PROVIDER, magpieWindowFromEvidence, sampleMagpieRoute } from './magpie.ts';
import { MAGPIE_RESTORE_ALIAS, planMagpieRouteRestore } from './magpie-restore.ts';
import { loadProofFiles, readProofFile } from './proof-files.ts';
import { MAGPIE_EXECUTION_HEADROOM_SECONDS, MAGPIE_SNAPSHOT_MAX_AGE_SECONDS } from './proof-contract.ts';
import { clip, redactJson, redactText } from './redact.ts';
import { SessionStore, type OpsSession } from './sessions.ts';
import { InternalAiProofBridge } from './proof-bridge.ts';
import type { CompanyProofStore } from './proof-store.ts';
import { ProofSigner } from './proof-signer.ts';
import { identitySchema, sha256, proofToolContracts, proofToolSchemas, type ProofIdentity, type ProofTool } from './proof-contract.ts';
import type { ProofFiles } from './proof-files.ts';

type ProofDependencyStage = 'identity-login' | 'identity-workspaces' | 'identity-scope' | 'identity-billing' | 'identity-data' | 'product-delivery';
/** Only fixed stage names, elapsed milliseconds and a typed error code cross the proof boundary. */
class ProofDependencyError extends CompanyError {
  constructor(stage: ProofDependencyStage, error: unknown, elapsedMs: number) {
    const source = error instanceof CompanyError ? error : undefined;
    super(source?.code ?? 'upstream_error', `internal AI proof failed at ${stage} (${source?.code ?? 'upstream_error'}; ${elapsedMs}ms)`, source?.retryable ?? true);
  }
}
async function proofDependency<T>(stage: ProofDependencyStage, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await work(); }
  catch (error) { throw new ProofDependencyError(stage, error, Math.round(performance.now() - started)); }
}

export const OPS_TOOLS = [
  'ops_info', 'ops_health', 'ops_account_ensure', 'ops_login', 'ops_operator_login', 'ops_logout', 'ops_workspace_ensure',
  'ops_member_list', 'ops_member_add', 'ops_member_remove', 'ops_request', 'ops_query', 'ops_browser_login',
  'ops_idp_client_claims', 'ops_idp_client_info', 'ops_idp_client_register',
  'ops_idp_principal_mint', 'ops_idp_principal_revoke', 'ops_idp_principal_list', 'ops_idp_admin_request',
  'ops_idp_provision_rotate', 'ops_invitation_issue',
  'ops_internal_ai_prepare', 'ops_internal_ai_prove', 'ops_internal_ai_approval_diagnose', 'ops_internal_ai_deliver', 'ops_internal_ai_revoke', 'ops_internal_ai_trust', 'ops_internal_ai_rotate_key',
  'ops_supplier_plan_sample', 'ops_product_magpie_observe', 'ops_product_magpie_candidate', 'ops_magpie_route_sample', 'ops_magpie_route_restore', 'ops_magpie_window_prepare', 'ops_product_magpie_price_approve', 'ops_platform_operator_list', 'ops_origin_status', 'ops_origin_health', 'ops_origin_logs',
] as const;
export type OpsTool = typeof OPS_TOOLS[number];

type Args = Record<string, unknown>;

export interface OpsDeps {
  core: Pick<CompanyCore, 'opsScope' | 'auditOps' | 'opsCount'> & Partial<Pick<CompanyCore, 'policyToolScope' | 'reportFault' | 'reserveFault' | 'settleFault' | 'refundFault' | 'recoveryReadReserve' | 'recoveryReadSettle'>>;
  projects: Pick<ProjectStore, 'brokerEnvs' | 'readSealed' | 'setSecret' | 'sealedNames'> & Partial<Pick<ProjectStore, 'ensureSealed' | 'rotateSealed'>>;
  proofStore?: CompanyProofStore;
  serviceHome?: string;
  /** Sealing key; `create` lets the first seal mint one. */
  secretKey: (create?: boolean) => Buffer;
  controlEnv?: () => ControlPlaneEnv;
  fetch?: Fetcher;
  now?: () => number;
  /** Monotone clock for the fault ledger's elapsedMs; tests advance their fake clock instead of real time. */
  monoNow?: () => number;
  /** Test seam: defaults to real timers; tests advance the fake clock instead of waiting. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** Test seams; production wires Cloudflare D1, the SurrealDB SDK and ego-browser. */
  d1?: (config: BrokerConfig, env: ControlPlaneEnv) => D1Client;
  queryAsUser?: QueryAsUser;
  browser?: BrowserInjector;
  originAgent?: OriginAgent;
  /**
   * Trusted Magpie wiring. Production leaves this unset and the sampler resolves the owner's
   * loopback gateway (MAGPIE_ADDR / stash / default); tests inject the fake gateway and config.
   */
  magpie?: {
    readProductProvider?: () => unknown;
    base?: string;
    endpointSource?: 'env' | 'stash' | 'default' | 'injected';
    readProviders?: () => Promise<string>;
    /**
     * Trusted price approvals for remote-magpie candidates, from a source other than the caller. Production
     * has none, so every remote window stays closed on price-not-reviewed until the approval reader exists.
     */
    remotePriceApprovals?: () => PriceApproval[];
    /** Test seam: the gateway config the restore tool may append one group to. */
    configPath?: string;
    /** Test seam: where plan/idempotency state is kept. */
    journalPath?: string;
  };
  /**
   * SYS05: bounded close of one browser task space when the lease ends. Absent means the space is reported as
   * pending cleanup — never claimed as closed. The closer must not expose a token.
   */
  closeBrowserSpace?: (input: { employeeId: string; spaceId: number }) => Promise<void>;
}

/** What a lease-end cleanup actually did. Counts only, never a token or a URL. */
export interface OpsCleanupReport {
  sessions: number;
  browserSpaces: number;
  /** Browser spaces left for a later sweep: no closer configured, or a close failed. */
  pending: number;
}

interface Ctx {
  scope: OpsScope;
  /** The employee credential that authorized this call; used by the recovery chain's own core calls. */
  credential?: string;
  /** Name of the project environment the broker config came from. */
  env: string;
  cfg: BrokerConfig;
  row: EnvBrokerRow;
  /**
   * SYS04 AC02: the attempt this call reserved against the recovery budget of the fault object. The number is
   * what the failure report carries, so an attempt is charged exactly once: by the reservation when there was one,
   * by the report of its failure otherwise.
   */
  fault?: { attempt: number; charged: boolean; phase: FaultPhase; target: FaultTargetKind; refund?: FaultRefund };
  /**
   * FV06: the grant this call runs under. Set only from the channel-injected proof (never from tool args), so a
   * call in recovery mode cannot escape the grant allowlist or re-login on its own.
   */
  recovery?: RecoveryReadScope;
  /** Chain reservation handle for the call in flight (recovery mode only). */
  recoveryCall?: { callId: string; kind: 'login' | 'get' | 'logout'; path?: string };
}

/** `action` decides visibility: ops_call rows stay out of handover history, everything else is shown. */
interface Outcome { value: unknown; audit?: { action: string; evidence: string } }
type Handler = (ctx: Ctx, args: Args) => Promise<Outcome>;

/**
 * The phase of an ops tool, in the fixed vocabulary of the fault classifier. It names the stage of the operation,
 * not the message: the same tool always fails in the same phase, whatever the upstream says.
 */
const opsPhaseOf = (tool: string): FaultPhase => {
  switch (tool) {
    case 'ops_login': return 'login';
    case 'ops_operator_login': return 'login';
    case 'ops_account_ensure': return 'account_ensure';
    case 'ops_workspace_ensure': return 'workspace_ensure';
    case 'ops_member_list': return 'member_list';
    case 'ops_member_add': return 'member_add';
    case 'ops_member_remove': return 'member_remove';
    case 'ops_logout': return 'request';
    case 'ops_browser_login': return 'request';
    default: return 'request';
  }
};

/** The controlled target of an ops tool. Only the kind is recorded; a raw address never is. */
const opsTargetOf = (tool: string, args: Args = {}): FaultTargetKind => {
  switch (tool) {
    case 'ops_login': return args.audience === 'ops' ? 'idp_token' : 'idp_login';
    case 'ops_operator_login': return 'product_token';
    case 'ops_account_ensure': return 'account';
    case 'ops_workspace_ensure': return 'workspace';
    case 'ops_member_list': case 'ops_member_add': case 'ops_member_remove': return 'member';
    // SYS04/SYS05 isolation: a browser injection failure stops only the injection scope, and a
    // logout/cleanup is never refused because an injection failed. Sharing the `internal` target
    // with ops_request is what made one unclassified injection block both.
    case 'ops_browser_login': return 'browser';
    case 'ops_logout': return 'logout';
    default: return 'internal';
  }
};

/**
 * Whether repeating the operation of a tool is safe.
 *
 * The question is about the whole operation, not about one request inside it. A login is a sequence of one-time
 * challenges and codes: repeating the *operation* starts a fresh flow with a fresh code — the client never replays
 * a code — so it is safe to repeat. A write that creates or changes something durable is not repeated when the
 * outcome of the failed attempt is unknown.
 */
const opsIdempotentOf = (tool: string, args: Args = {}): boolean => {
  switch (tool) {
    case 'ops_member_add': case 'ops_member_remove': case 'ops_invitation_issue':
    case 'ops_idp_provision_rotate': case 'ops_idp_admin_request': case 'ops_idp_principal_mint':
    case 'ops_idp_principal_revoke': case 'ops_idp_client_register':
      return false;
    case 'ops_request': {
      const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
      return method === 'GET' || method === 'HEAD';
    }
    // The route restore only publishes the read-only plan; apply refuses in every role before any
    // write. Keeping the conservative non-idempotent classification means an apply refusal is not
    // retried automatically.
    case 'ops_magpie_route_restore':
      return args.mode !== 'apply';
    default:
      return true;
  }
};

interface WorkspaceItem { slug: string; name: string; dbName: string; role?: string }

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DAY_SECONDS = 86_400;
const REFRESH_MARGIN_MS = 60_000;
/**
 * One bounded retry inside a single tool call, only for a transient injection failure (a navigation
 * timeout or a connection reset). It never applies to a deterministic refusal and never grows into
 * an unbounded loop: the fault budget still caps the operation at its configured maxAttempts.
 */
const BROWSER_INJECT_ATTEMPTS = 2;
const BROWSER_RETRY_BACKOFF_MS = 1_000;
const DEFAULT_TOKEN_MS = 15 * 60_000;
const MAX_RESULT_CHARS = 100_000;

// Invitation issuance is asynchronous on the product: POST answers 202 within ~60s when
// the saga overruns; the broker then polls GET and re-POSTs once past the product's stale
// threshold (CAS-resumable) until the row settles as completed/failed.
const INVITE_POLL_MS = 10_000;
const INVITE_RESUME_AFTER_MS = 290_000; // product stale threshold is 240s; wait past it
const INVITE_WAIT_MS = 480_000;         // total budget per tool call; a same-key retry continues

const invalid = (message: string) => new CompanyError('invalid', message);

/** Last few sanitized login hops for audit lines: enough to locate a flow, small enough to stay readable. */
const tailHops = (trace: string, n = 4): string => trace.split(' | ').slice(-n).join(' | ');

/**
 * Fixed stage name for a login audit line, so a batch of failures can be located without another real login. Derived
 * from the sanitized trace's last hop (`a<attempt>:<phase>@<host>:...`); only the four fixed names are ever returned.
 */
const loginStageOf = (trace: string): 'authorize' | 'login' | 'consent' | 'exchange' | 'unknown' => {
  const last = trace.split(' | ').at(-1) ?? '';
  const phase = last.slice(last.indexOf(':') + 1, last.indexOf('@'));
  if (phase.startsWith('authorize')) return 'authorize';
  if (phase === 'login') return 'login';
  if (phase === 'consent') return 'consent';
  if (phase === 'exchange') return 'exchange';
  return 'unknown';
};

function text(args: Args, key: string, max = 200): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${key} is required (text up to ${max} chars)`);
  return value.trim();
}

function slugOf(args: Args, key = 'slug'): string {
  const slug = text(args, key, 60).toLowerCase();
  if (!SLUG.test(slug)) throw invalid('slug must be 1-40 lowercase letters, digits or hyphens');
  return slug;
}

const plainId = (value: unknown): string => {
  const raw = value && typeof value === 'object' && 'id' in value ? (value as { id: unknown }).id : value;
  return String(raw).replace(/^user:/, '').replace(/^⟨|⟩$/g, '');
};

const jsonSafe = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)) ?? 'null');

/** The product answers `{ error: { code, message } }`, the IdP `{ error: '<code>' }`; only the short machine code is relayed. */
function errorCode(body: unknown): string {
  if (body && typeof body === 'object') {
    const { error, code } = body as { error?: unknown; code?: unknown };
    const nested = error && typeof error === 'object' ? (error as { code?: unknown }).code : error;
    const picked = typeof nested === 'string' ? nested : code;
    if (typeof picked === 'string') return picked.replace(/[^\w.-]/g, '').slice(0, 60) || 'error';
  }
  return 'error';
}

/** Proof delivery relays the product's `{error:{code}}` machine code on non-2xx only, strictly shaped; the field stays absent otherwise. */
export function proofDeliverErrorCode(result: ProductResult): string | undefined {
  if (result.ok || !result.body || typeof result.body !== 'object') return undefined;
  const error = (result.body as { error?: unknown }).error;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9-]{2,60}$/.test(code) ? code : undefined;
}

function productFailure(what: string, res: ProductResult, specific: Partial<Record<number, CompanyError['code']>> = {}): CompanyError {
  const code = specific[res.status] ?? (res.status === 401 ? 'login_failed' : res.status >= 500 ? 'upstream_error' : 'invalid');
  // The status travels with the error: the classifier needs the machine fact, not the wording.
  const failure = new CompanyError(code, `${what} failed: HTTP ${res.status} ${errorCode(res.body)}`, res.status >= 500);
  (failure as CompanyError & { status?: number }).status = res.status;
  return failure;
}

/**
 * The product provisions a workspace in many steps and resumes an interrupted one when the same
 * owner asks for the same slug again, so an unanswered or 5xx creation is settled by repeating it,
 * never by picking another slug (that leaves a half-built workspace behind and burns the daily limit).
 */
const unfinishedCreation = (slug: string, detail: string) => new CompanyError('upstream_error',
  `workspace ${slug} may not be fully created yet (${detail}); call ops_workspace_ensure again with the same slug and name to reuse or finish it, and do not switch to another slug`, true);

/**
 * A call the recovery budget refused before it ran. Nothing was charged: the refusal is the budget's answer, not a
 * new failure of the upstream, so it is never reported as a fault.
 */
class BudgetRefusal extends CompanyError {
  constructor(message: string, retryable: boolean) {
    super('upstream_error', message, retryable);
  }
}

/** Remote observations the broker keeps for window checks. A candidate older than this many reads is refused as observation-untrusted. */
export const REMOTE_OBSERVATION_LIMIT = 64;

export class OpsBroker {
  readonly tools: readonly string[] = OPS_TOOLS;
  private readonly sessions: SessionStore;
  private readonly now: () => number;
  /** Monotone clock for the fault ledger's elapsedMs (a wall-clock step cannot shrink a measured failure). */
  private readonly monoNow: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly handlers: Record<OpsTool, Handler>;
  private readonly proofBridge?: InternalAiProofBridge;
  /** SYS05: the ego-browser task spaces this broker injected under each employee's current lease. */
  private readonly browserSpaces = new Map<string, Set<number>>();
  /** SYS05: the last scope a cleanup audit can name; it never contains a token. */
  private readonly lastScope = new Map<string, OpsScope>();
  // Observations this process read from the remote, keyed by their snapshot digest. Window checks trust these copies only.
  private readonly remoteObservations = new Map<string, TrustedRecord>();
  /** Price approvals this broker process recorded. The window trusts only these, never the evidence files. */
  private readonly remotePriceApprovalRecords: PriceApproval[] = [];

  constructor(private readonly deps: OpsDeps) {
    this.now = deps.now ?? Date.now;
    this.monoNow = deps.monoNow ?? (() => performance.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.sessions = new SessionStore(this.now);
    if (deps.proofStore) this.proofBridge = new InternalAiProofBridge({
      store: deps.proofStore, home: deps.serviceHome ?? process.env.SCK_SERVICE_HOME ?? join(homedir(), 'Library/Application Support/SurrealCKCompany'), key: () => deps.secretKey(), now: this.now,
      signer: async (project, env) => {
        if (!deps.projects.ensureSealed) throw new CompanyError('not_configured', 'proof sealed storage unavailable');
        const pem = await deps.projects.ensureSealed(project, env, 'INTERNAL_AI_PROOF_ED25519', ProofSigner.generate, deps.secretKey(true));
        return new ProofSigner(pem);
      },
      rotate: async (project, env, kid) => {
        if (!deps.projects.rotateSealed) throw new CompanyError('not_configured', 'issuer rotation unavailable');
        const prior = await deps.projects.readSealed(project, env, 'INTERNAL_AI_PROOF_ED25519', deps.secretKey());
        if (!prior || new ProofSigner(prior).kid !== kid) throw new CompanyError('conflict', 'issuer key changed');
        const next = ProofSigner.generate();
        await deps.projects.rotateSealed(project, env, 'INTERNAL_AI_PROOF_ED25519', prior, next, deps.secretKey());
        return new ProofSigner(next);
      },
      identities: (scope, env, files) => this.proofIdentities(scope, env, files),
      deliver: async (jwt, scope, env, handle) => {
        const ctx = await this.context(scope, env); const session = this.session(ctx, { session: handle });
        if (session.kind === 'customer') throw new CompanyError('forbidden', 'proof delivery requires ops audience');
        const result = await proofDependency('product-delivery', () => this.product(ctx, session, 'POST', '/api/ops/internal-ai/company-proof', { proof: jwt }));
        const errorCode = proofDeliverErrorCode(result);
        return { status: result.status, ok: result.ok, ...(errorCode ? { errorCode } : {}) };
      },
    });
    this.handlers = {
      ops_info: (ctx) => this.info(ctx),
      ops_health: (ctx) => this.health(ctx),
      ops_account_ensure: (ctx, args) => this.accountEnsure(ctx, args),
      ops_login: (ctx, args) => this.login(ctx, args),
      ops_operator_login: (ctx, args) => this.operatorLogin(ctx, args),
      ops_logout: (ctx, args) => this.logout(ctx, args),
      ops_workspace_ensure: (ctx, args) => this.workspaceEnsure(ctx, args),
      ops_member_list: (ctx, args) => this.memberList(ctx, args),
      ops_member_add: (ctx, args) => this.memberAdd(ctx, args),
      ops_member_remove: (ctx, args) => this.memberRemove(ctx, args),
      ops_request: (ctx, args) => this.request(ctx, args),
      ops_query: (ctx, args) => this.query(ctx, args),
      ops_browser_login: (ctx, args) => this.browserLogin(ctx, args),
      ops_idp_client_claims: (ctx, args) => this.idpClientClaims(ctx, args),
      ops_idp_client_info: (ctx, args) => this.idpClientInfo(ctx, args),
      ops_idp_client_register: (ctx, args) => this.idpClientRegister(ctx, args),
      ops_idp_principal_mint: (ctx, args) => this.idpPrincipalMint(ctx, args),
      ops_idp_principal_revoke: (ctx, args) => this.idpPrincipalRevoke(ctx, args),
      ops_idp_principal_list: (ctx, args) => this.idpPrincipalList(ctx, args),
      ops_idp_admin_request: (ctx, args) => this.idpAdminRequest(ctx, args),
      ops_idp_provision_rotate: (ctx, args) => this.idpProvisionRotate(ctx, args),
      ops_invitation_issue: (ctx, args) => this.invitationIssue(ctx, args),
      ops_supplier_plan_sample: (ctx, args) => this.supplierPlanSample(ctx, args),
      ops_product_magpie_observe: (ctx,args) => this.productMagpieObserve(ctx,args),
      ops_product_magpie_candidate: (ctx,args) => this.productMagpieCandidate(ctx,args),
      ops_magpie_route_sample: (ctx, args) => this.magpieRouteSample(ctx, args),
      ops_magpie_route_restore: (ctx, args) => this.magpieRouteRestore(ctx, args),
      ops_magpie_window_prepare: (ctx, args) => this.magpieWindowPrepare(ctx, args),
      ops_product_magpie_price_approve: (ctx, args) => this.productMagpiePriceApprove(ctx, args),
      ops_platform_operator_list: (ctx, args) => this.platformOperatorList(ctx, args),
      ops_origin_status: (ctx) => this.origin(ctx, { op: 'status' }),
      ops_origin_health: (ctx) => this.origin(ctx, { op: 'health' }),
      ops_origin_logs: (ctx, args) => this.origin(ctx, originLogsRequest(args)),
      ...Object.fromEntries(Object.keys(proofToolSchemas).map(tool => [tool, (ctx: Ctx, args: Args) => this.internalProof(ctx, tool as ProofTool, args)])) as Record<ProofTool, Handler>,
    };
  }

  /** The sidecar injects `taskId` from the live lease; `opsScope` re-verifies that lease on every call. */
  async call(credential: string, taskId: string, tool: string, args: Args = {}, proof?: { grantId: string; grantFence: number }): Promise<unknown> {
    const handler = (this.handlers as Record<string, Handler | undefined>)[tool];
    if (!handler) throw invalid(`unknown ops tool: ${tool}`);
    const scope = await this.deps.core.opsScope(credential, taskId, proof);
    this.lastScope.set(scope.actor.employeeId, scope);
    const ctx = { ...(await this.context(scope, args.env)), credential };
    if (scope.kind === 'recovery_read') {
      // fail-closed：任何不在 grant 允许面里的工具都在这里被拒，连 reserve 都不进入。
      if (!scope.recovery) throw new CompanyError('forbidden', 'Recovery read scope is incomplete');
      ctx.recovery = scope.recovery;
      this.enforceRecoveryTool(ctx, tool, args, scope.recovery);
    }
    // The fault ledger's elapsedMs is the call's own monotone wall time, from here to the failure —
    // early failures and budget-exhausted logins included, never a trace sum (the trace caps its tail).
    const startedMs = this.monoNow();
    try {
      // SYS06 AC02 ③：范围内生效的 tool_scope 决定这次调用能不能过。判定在 core（与任务侧同一份 policy.ts），
      // 这里只把工具名与别名递进去；提示词、任务描述写什么都不改变这条结论。
      const boundary = this.deps.core.policyToolScope
        ? await this.deps.core.policyToolScope(scope.project, {
            tool, toolNames: OPS_TOOLS, ...(typeof args.alias === 'string' ? { alias: args.alias } : {}),
          })
        : undefined;
      if (boundary && !boundary.verdict.ok) {
        throw new CompanyError(boundary.verdict.code, `有效策略拒绝：${boundary.verdict.reason}`);
      }
      // SYS04 AC02: the attempt is reserved before it runs. A refused reservation never reaches the tool.
      // 恢复通道的必要 logout 是清理动作，永不被故障预算拦住。
      const recoveryLogout = ctx.recovery !== undefined && tool === 'ops_logout';
      if (!recoveryLogout) await this.reserveAttempt(ctx, tool, args);
      // FV06: 链级 reserve 在 fault reserve 之后。预算拒绝（例如源任务 login 键已 deadline_passed）时链还没有
      // 递增任何计数，grant 不会被永久烧死；链级拒绝时把刚预留的故障尝试**退款**，因为调用没有发生。
      // 退款不是成功结算：它只撤销本次预留，保留此前 failed/attempts/deadline/nextAllowedAt/stopped/incident，
      // 且用 CAS 防止覆盖并发新失败或重复退款。
      if (ctx.recovery) {
        try {
          await this.reserveRecoveryChain(ctx, tool, args);
        } catch (error) {
          await this.refundAttempt(ctx, tool).catch(() => undefined);
          throw error;
        }
      }
      let outcome: Outcome;
      try {
        outcome = await handler(ctx, args);
      } catch (error) {
        // 链级 settle 必须看到真实结果：失败也要清 inFlight 并停止余项。
        await this.settleRecoveryChain(ctx, tool, args, undefined, error).catch(() => undefined);
        throw error;
      }
      await this.settleRecoveryChain(ctx, tool, args, outcome.value, undefined).catch(() => undefined);
      if (outcome.audit) await this.audit(ctx, outcome.audit.action, outcome.audit.evidence);
      // The call worked: the fault object is healthy again, so the recovery is over.
      await this.settleAttempt(ctx);
      return outcome.value;
    } catch (error) {
      throw await this.failed(ctx, tool, error, args, Math.max(0, Math.round(this.monoNow() - startedMs)));
    }
  }

  private async internalProof(ctx: Ctx, tool: ProofTool, args: Args): Promise<Outcome> {
    if (!this.proofBridge) throw new CompanyError('not_configured', 'internal AI proof bridge unavailable');
    // Bridge upstream errors must never echo subjects, file bodies, signed capabilities or passwords.
    try {
      const value = await this.proofBridge.call(ctx.scope, ctx.env, tool, args);
      if (tool === 'ops_internal_ai_approval_diagnose') {
        const result = value as { outcome: string; failure: string };
        return { value, audit: { action: 'ops_proof', evidence: `${tool} outcome=${result.outcome} failure=${result.failure}` } };
      }
      const keyId = value && typeof value === 'object' && 'kid' in value ? String(value.kid) : value && typeof value === 'object' && 'keyId' in value ? String(value.keyId) : 'unchanged';
      const digest = value && typeof value === 'object' && 'configurationDigest' in value ? String(value.configurationDigest) : value && typeof value === 'object' && 'digest' in value ? String(value.digest) : 'none';
      const handleRef = typeof args.proofHandle === 'string' ? sha256(args.proofHandle) : value && typeof value === 'object' && 'proofHandle' in value ? sha256(String(value.proofHandle)) : 'none';
      return { value, audit: { action: 'ops_proof', evidence: `${tool} keyId=${keyId} digest=${digest} proofRef=${handleRef}` } };
    } catch (error) {
      throw new CompanyError(error instanceof CompanyError ? error.code : 'upstream_error', error instanceof ProofDependencyError ? error.message : 'internal AI proof request denied or unavailable', error instanceof CompanyError && error.retryable);
    }
  }

  async proofStatus(request: Request): Promise<Response> {
    return this.proofBridge ? this.proofBridge.status(request) : new Response('status unavailable', { status: 503 });
  }

  /** Credentials originate in the sealed alias mapping; this path never ensures/repairs accounts or members. */
  private async proofIdentities(scope: OpsScope, env: string, files: ProofFiles): Promise<ProofIdentity[]> {
    const ctx = await this.context(scope, env);
    // Both aliases must be read live, but independent IdP flows must not spend two 75s
    // login budgets serially inside a tool call whose caller waits about 120s.
    // Settle both flows before returning errors. Membership checks then use one temporary
    // session at a time so they cannot evict an employee's existing operator session.
    const resolutions = await Promise.allSettled(files.manifest.identities.map(async expected => {
      const password = await this.sealedPassword(ctx, expected.alias);
      if (!password) throw new CompanyError('not_found', 'approved alias is not registered');
      const username = accountUsername(expected.alias, ctx.cfg.accounts.prefix);
      const login = await proofDependency('identity-login', () => passwordLogin(ctx.cfg, username, password, { fetch: this.deps.fetch, now: this.now, channel: 'customer' }));
      return { expected, username, login };
    }));
    for (const resolution of resolutions) if (resolution.status === 'rejected') throw resolution.reason;
    const result: ProofIdentity[] = [];
    for (const resolution of resolutions) {
      if (resolution.status !== 'fulfilled') throw new CompanyError('upstream_error', 'identity login unavailable', true);
      const { expected, username, login } = resolution.value;
      const session = this.sessions.create({ employeeId: scope.actor.employeeId, project: scope.project, env, alias: expected.alias, username, kind: 'customer', token: login.accessToken, expiresAt: login.expiresAt });
      try {
        const slug = files.manifest.workspaceSlug;
        const item = (await proofDependency('identity-workspaces', () => this.listWorkspaces(ctx, session))).workspaces.find(w => w.slug === slug);
        if (!item || item.role !== expected.workspaceRole) throw new CompanyError('forbidden', 'approved workspace membership unavailable');
        await proofDependency('identity-scope', () => this.switchTo(ctx, session, item));
        const response = await proofDependency('identity-billing', () => this.product(ctx, session, 'GET', '/api/internal-ai/identity?workspaceSlug=' + encodeURIComponent(slug)));
        if (!response.ok) throw new CompanyError('not_configured', 'trusted billing identity capability unavailable');
        const parsed = identitySchema.safeParse(response.body);
        if (!parsed.success) throw new CompanyError('upstream_error', 'trusted identity response unavailable');
        const identity = parsed.data;
        const tokenPayload: unknown = JSON.parse(Buffer.from(session.token.split('.')[1] ?? '', 'base64url').toString());
        const subject = tokenPayload && typeof tokenPayload === 'object' && 'sub' in tokenPayload ? tokenPayload.sub : undefined;
        const [users] = await proofDependency('identity-data', () => this.runQuery(ctx, session, item.dbName, "SELECT subject, is_admin FROM user WHERE kind = 'human' AND disabled_at = NONE AND subject = $subject", { subject: identity.subject })) as [Array<{ subject: string; is_admin: boolean }>];
        if (identity.subject !== subject || identity.database !== item.dbName || identity.workspaceRole !== expected.workspaceRole || identity.billingRole !== expected.billingRole || users?.length !== 1 || users[0]?.subject !== identity.subject || users[0]?.is_admin !== (expected.workspaceRole === 'admin')) throw new CompanyError('forbidden', 'trusted identity membership mismatch');
        result.push({ ...identity, alias: expected.alias });
      } finally { this.sessions.drop(session.id); }
    }
    if (result[0]?.spaceId !== result[1]?.spaceId || result[0]?.database !== result[1]?.database || result[0]?.billingAccountRef !== result[1]?.billingAccountRef || result[0]?.subject === result[1]?.subject) throw new CompanyError('forbidden', 'approved identities do not share the current workspace/account');
    return result;
  }

  /**
   * An instance is gone: its local session handles are dropped and its browser task spaces are bounded-closed.
   *
   * The local drop is not a remote logout: no upstream call is made to invalidate the token, and the audit says so
   * instead of claiming the remote session ended. A browser space without a configured closer, or one whose close
   * throws, is counted as pending cleanup — it is never reported as closed.
   */
  release(employeeId: string): OpsCleanupReport {
    const sessions = this.sessions.dropEmployee(employeeId);
    const spaces = [...(this.browserSpaces.get(employeeId) ?? [])];
    this.browserSpaces.delete(employeeId);
    const scope = this.lastScope.get(employeeId);
    this.lastScope.delete(employeeId);
    const closer = this.deps.closeBrowserSpace;
    let pending = 0;
    if (scope) {
      for (const spaceId of spaces) {
        if (!closer) { pending++; continue; }
        void closer({ employeeId, spaceId }).catch(error => {
          void this.deps.core.auditOps(scope, 'ops_cleanup',
            `ego-browser 任务空间 ${spaceId} 关闭失败，待清理（不冒称远端已注销）：${((error as Error)?.message ?? 'unknown').slice(0, 120)}`)
            .catch(() => undefined);
        });
      }
      void this.deps.core.auditOps(scope, 'ops_cleanup',
        `租约结束：本地会话句柄 ${sessions} 个已丢弃（未调用远端注销）；ego-browser 空间 ${spaces.length} 个，` +
        `${pending} 个待清理（${closer ? '已交给受控 closer' : 'closer 未配置'}）；不暴露任何 token`)
        .catch(() => undefined);
    }
    return { sessions, browserSpaces: spaces.length, pending };
  }

  /** FV06: the channel closed a recovery binding — discard the handles this grant opened, count only. */
  releaseGrant(grantId: string): number {
    return this.sessions.dropGrant(grantId);
  }

  private async context(scope: OpsScope, requested: unknown): Promise<Ctx> {
    const rows = (await this.deps.projects.brokerEnvs(scope.project)).filter(row => row.broker !== undefined && row.broker !== null);
    if (requested !== undefined && typeof requested !== 'string') throw invalid('env must be a string');
    const row = requested ? rows.find(r => r.name === requested)
      : rows.length === 1 ? rows[0] : rows.find(r => r.name === 'production');
    if (!row) throw new CompanyError('not_configured', `project ${scope.project} has no ops broker environment${requested ? ` named ${requested}` : ''}`);
    const cfg = parseBrokerConfig(row.broker);
    if (!cfg.roles.includes(scope.actor.role)) throw new CompanyError('forbidden', `role ${scope.actor.role} may not use ops tools on ${scope.project}/${row.name}`);
    return { scope, env: row.name, cfg, row };
  }

  private async audit(ctx: Ctx, action: string, evidence: string): Promise<void> {
    const known = this.sessions.secrets(ctx.scope.actor.employeeId);
    await this.deps.core.auditOps(ctx.scope, action, clip(redactText(evidence, known), 500));
  }

  /**
   * FV06 恢复通道的 fail-closed 允许面：只放行一次登录、四条的固定顺序 GET 和必要的本地 logout。
   * 证明（grantId/fence）只来自通道，参数里带这些键一律拒绝。
   */
  private enforceRecoveryTool(ctx: Ctx, tool: string, args: Args, grant: RecoveryReadScope): void {
    if (!(RECOVERY_READ_TOOLS as readonly string[]).includes(tool)) {
      throw new CompanyError('forbidden', `Recovery read allows only ${RECOVERY_READ_TOOLS.join(', ')}; ${tool} is refused`);
    }
    for (const key of ['taskId', 'sourceTaskId', 'grantId', 'grantFence', 'fence']) {
      if (args[key] !== undefined) throw new CompanyError('forbidden', `Recovery read proof comes from the channel; ${key} must not be supplied`);
    }
    // H5：session 绑定在 reserve 之前校验，被拒的调用不消耗链级计数。方法/路径先判，才能给出精确的拒绝原因。
    if (tool === 'ops_operator_login') {
      const alias = typeof args.alias === 'string' ? canonicalAlias(args.alias) : '';
      if (alias !== grant.alias) throw new CompanyError('forbidden', `Recovery read login must use the grant alias ${grant.alias}`);
      return;
    }
    if (tool === 'ops_request') {
      if (String(args.method ?? '').toUpperCase() !== 'GET') throw new CompanyError('forbidden', 'Recovery read allows GET only');
      const path = args.path;
      if (typeof path !== 'string' || !(RECOVERY_READ_PATHS as readonly string[]).includes(path) || !grant.paths.includes(path)) {
        throw new CompanyError('forbidden', 'Path is not in this recovery read grant');
      }
      if (args.body !== undefined) throw new CompanyError('forbidden', 'Recovery read GET takes no body');
    }
    let session: OpsSession | undefined;
    try {
      session = this.sessions.get(args.session, ctx.scope.actor.employeeId, ctx.scope.project, ctx.env);
    } catch (error) {
      // logout 在进程重启后可能已经没有本地句柄：仍然允许走到本地 not_found（不重登、不声称远端注销）。
      if (tool === 'ops_request') throw error;
    }
    if (session && (session.grantId !== grant.grantId || session.alias !== grant.alias)) {
      throw new CompanyError('forbidden', 'Recovery read can only use a session opened under this grant and alias');
    }
  }

  /** 链级 reserve：登录/GET 的原子计数与 inFlight；logout 不计数、永远放行。 */
  private async reserveRecoveryChain(ctx: Ctx, tool: string, args: Args): Promise<void> {
    const grant = ctx.recovery;
    if (!grant) return;
    if (!ctx.credential) throw new CompanyError('forbidden', 'Recovery read chain needs the caller credential');
    if (!this.deps.core.recoveryReadReserve) throw new CompanyError('temporarily_unavailable', 'Recovery read chain is not available on this core');
    const kind = tool === 'ops_operator_login' ? 'login' : tool === 'ops_logout' ? 'logout' : 'get';
    const path = kind === 'get' ? String(args.path) : undefined;
    const result = await this.deps.core.recoveryReadReserve(ctx.credential, {
      grantId: grant.grantId, grantFence: grant.grantFence, kind, ...(path === undefined ? {} : { path }),
    });
    if (!result.allowed) {
      throw new CompanyError(result.reason === 'busy' ? 'conflict' : 'forbidden', `Recovery read refused: ${result.message}`);
    }
    if (result.callId) ctx.recoveryCall = { callId: result.callId, kind, ...(path === undefined ? {} : { path }) };
  }

  /**
   * 链级 settle：把真实结果写回 grant（成功推进、失败停止），失败时只丢弃本 grant 的本地会话。
   * 503 是第 1 项的预期成功；其余非 200 或视图不完整都会停链。
   */
  private async settleRecoveryChain(ctx: Ctx, tool: string, args: Args, value: unknown, error: unknown): Promise<void> {
    const grant = ctx.recovery;
    const call = ctx.recoveryCall;
    if (!grant || !call || !ctx.credential) return;
    if (!this.deps.core.recoveryReadSettle) return;
    let status: number | undefined;
    let ok: boolean;
    let outcome: string;
    let bodyDigest: string | undefined;
    if (error !== undefined) {
      ok = false;
      const code = error instanceof CompanyError ? error.code : 'upstream_error';
      outcome = call.kind === 'login' ? 'login_failed' : call.kind === 'logout' ? 'logout_failed' : `transport_${code}`;
      const facts = faultFactsOf(error);
      if (typeof facts.status === 'number') status = facts.status;
    } else if (call.kind === 'login') {
      ok = true;
      outcome = 'login_ok';
    } else if (call.kind === 'logout') {
      ok = true;
      outcome = 'logout_local';
    } else {
      const result = value as { status?: unknown; body?: unknown } | undefined;
      status = typeof result?.status === 'number' ? result.status : undefined;
      const verdict = classifyRecoveryRead(call.path ?? '', status, result?.body);
      ok = verdict.ok;
      outcome = verdict.outcome;
      bodyDigest = recoveryBodyDigest(result?.body);
    }
    await this.deps.core.recoveryReadSettle(ctx.credential, {
      grantId: grant.grantId, grantFence: grant.grantFence, callId: call.callId, kind: call.kind,
      ...(call.path === undefined ? {} : { path: call.path }), ...(status === undefined ? {} : { status }),
      ok, outcome, ...(bodyDigest === undefined ? {} : { bodyDigest }),
    });
    if (!ok && call.kind !== 'logout') {
      // 停止/失败只丢弃本地句柄，不重登、不声称远端注销。
      this.sessions.dropGrant(grant.grantId);
      await this.audit(ctx, 'ops_recovery_stop', `grant ${grant.grantId} stopped: ${outcome}`).catch(() => undefined);
    }
  }

  /**
   * Turn a failed ops call into a structured fault and charge it against the recovery budget of the fault object.
   *
   * SYS04 AC01/AC02/AC03: the fault facts come from the machine, not from the error text an employee would write.
   * The phase is the tool's own stage, the identity alias is the one the call ran for, and the errno/HTTP class
   * come from the transport. The budget is spent here, before the employee is told anything, so looping the same
   * call — in one session or in a new one — runs out of budget instead of out of patience. A fault that is not
   * retryable (a 403, a rejected password, a revoked permission, an invalid input) stops the recovery at once and
   * says what to fix; it is never retried for the employee.
   */
  private async failed(ctx: Ctx, tool: string, error: unknown, args: Args = {}, elapsedMs?: number): Promise<CompanyError> {
    const known = this.sessions.secrets(ctx.scope.actor.employeeId);
    const base = error instanceof CompanyError ? error
      : new CompanyError('upstream_error', `${(error as Error)?.name ?? 'Error'}: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    const safe = new CompanyError(base.code, redactText(base.message, known), base.retryable, base instanceof ProductGatewaySourceMismatch?base.details:undefined);
    // A call the budget refused never ran: it is the budget's answer, not a new failure of the upstream, and it
    // costs no budget.
    if (error instanceof BudgetRefusal) return safe;
    const quiet = safe.code === 'invalid' || safe.code === 'not_found';
    await this.audit(ctx, quiet ? 'ops_call' : 'ops_error', `${tool} → ${safe.code}: ${safe.message}`).catch(() => undefined);
    // The budget applies to the failures a recovery could plausibly fix: a transport failure of the upstream, a
    // refused login, and anything the upstream answered with a status. A local refusal (invalid input, not found)
    // has no status, is not a fault to retry, and costs no budget.
    const facts = faultFactsOf(error);
    const upstream = safe.code === 'upstream_error' || safe.code === 'login_failed' || facts.status !== undefined;
    if (upstream) {
      const charged = await this.chargeFault(ctx, tool, error, safe, args, facts, elapsedMs).catch(() => undefined);
      if (charged) return charged;
    }
    return safe;
  }

  /**
   * Reserve the attempt of a fault object, before the attempt runs (AC02).
   *
   * The reservation is what makes the budget real: a caller that loops the same operation — in this session, in a
   * new one, or after a restart — runs out of budget instead of out of patience, and the server is the one that
   * says no. The first attempt of an operation costs nothing: nothing was known to be broken yet, and a call that
   * works must not eat the recovery budget.
   */
  private async reserveAttempt(ctx: Ctx, tool: string, args: Args): Promise<void> {
    if (!this.deps.core.reserveFault) return;
    const phase = opsPhaseOf(tool);
    const target = opsTargetOf(tool, args);
    let result: Awaited<ReturnType<NonNullable<typeof this.deps.core.reserveFault>>>;
    try {
      // Called as a method, never pulled off `core` first: reserveFault reads this.faultClock and this.faults, so a
      // detached reference throws `Cannot read properties of undefined` and the reservation is silently lost — the
      // budget stops being enforced while the ops tool keeps running. See the `reserve failed` audit line.
      result = await this.deps.core.reserveFault({ taskId: ctx.scope.taskId, employeeId: ctx.scope.actor.employeeId }, { phase, target });
    } catch (error) {
      // The ledger is unavailable: the call still runs. A broken ledger must not take the ops tools down.
      await this.audit(ctx, 'ops_fault', `reserve failed: ${(error as Error).message}`).catch(() => undefined);
      return;
    }
    if (!result) return;
    if (!result.allowed) {
      await this.audit(ctx, 'ops_fault', `${tool} refused (${phase}): ${result.reason ?? 'not_retryable'}`).catch(() => undefined);
      // The refusal is not a fault: nothing ran, so nothing is charged. Only the minimum interval is worth waiting
      // for; a spent budget or an unrecoverable cause is final.
      throw new BudgetRefusal(result.message, result.reason === 'min_interval');
    }
    ctx.fault = { attempt: result.attempt, charged: result.charged, phase, target,
      ...(result.refund === undefined ? {} : { refund: result.refund }) };
  }

  /**
   * Settle **a real upstream success**: the fault object works again, so the recovery is over.
   *
   * This must never be used for a call that did not run. A chain refusal happens before the handler, and settling
   * there would clear the source task's earlier failure facts (failed/attempts/deadline/nextAllowedAt/incident) and
   * could erase a concurrent new failure. The pre-call path uses `refundAttempt` instead.
   */
  private async settleAttempt(ctx: Ctx): Promise<void> {
    if (!ctx.fault?.charged) return;
    await this.deps.core.settleFault?.({ taskId: ctx.scope.taskId, employeeId: ctx.scope.actor.employeeId },
      { phase: ctx.fault.phase, target: ctx.fault.target }).catch(() => undefined);
  }

  /**
   * Refund the attempt this call reserved but never ran (a chain/budget refusal before the handler).
   *
   * The core restores only the pre-reservation counters through a CAS token; a newer failure, stop, lift or real
   * success makes the refund a superseded no-op. The audit names the attempt, never an alias or a credential.
   */
  private async refundAttempt(ctx: Ctx, tool: string): Promise<void> {
    if (!ctx.fault?.charged || !ctx.fault.refund) return;
    const refund = ctx.fault.refund;
    const result = await this.deps.core.refundFault?.(
      { taskId: ctx.scope.taskId, employeeId: ctx.scope.actor.employeeId },
      { phase: ctx.fault.phase, target: ctx.fault.target, refund },
    ).catch(() => undefined);
    if (result !== undefined) {
      await this.audit(ctx, 'ops_fault',
        `refund ${tool} attempt=${ctx.fault.attempt} ${result.refunded ? 'refunded' : 'superseded'}`).catch(() => undefined);
    }
  }

  /**
   * Charge one failure against the fault object's budget and report the decision. The refusal is returned to the
   * caller as an error that says why the retry is not allowed, so the employee reads the reason instead of looping.
   */
  private async chargeFault(ctx: Ctx, tool: string, error: unknown, safe: CompanyError, args: Args,
    facts: ReturnType<typeof faultFactsOf> = faultFactsOf(error), elapsedMs?: number): Promise<CompanyError | undefined> {
    const report = await this.deps.core.reportFault?.(ctx.scope, {
      tool,
      phase: opsPhaseOf(tool),
      ...(facts.stage === undefined ? {} : { stage: facts.stage }),
      ...(facts.errno === undefined ? {} : { errno: facts.errno }),
      ...(facts.status === undefined ? {} : { status: facts.status }),
      ...(facts.name === undefined ? {} : { name: facts.name }),
      alias: typeof args.alias === 'string' ? args.alias : undefined,
      target: opsTargetOf(tool, args),
      environment: ctx.env,
      // The call's own monotone wall time (call start to this failure): what the ledger records instead of
      // the constant 0, so slow and broken are distinguishable without summing the trace.
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      // A write whose outcome is unknown is never replayed blindly.
      idempotent: opsIdempotentOf(tool, args),
      ...(ctx.fault?.charged === true ? { attempt: ctx.fault.attempt } : {}),
    });
    if (!report) return undefined;
    await this.audit(ctx, 'ops_fault', JSON.stringify(report.evidence)).catch(() => undefined);
    if (report.allowed) return undefined;
    const decision = typeof report.evidence.decision === 'string' ? report.evidence.decision : 'not_retryable';
    // The refusal keeps the upstream's own reason and adds what to do about it: the diagnosis never quotes a
    // credential, and the upstream's message was redacted before it got here.
    const code = decision === 'not_retryable' ? safe.code : 'upstream_error';
    return new CompanyError(code, `${safe.message}; ${report.message}`, decision === 'min_interval');
  }

  // ---------- reads without a session ----------

  private async info(ctx: Ctx): Promise<Outcome> {
    const names = await this.deps.projects.sealedNames(ctx.scope.project, ctx.env);
    // 读出范围内生效的 tool_scope：列出的工具与账号别名只保留被授权的那些，读的人看到的边界就是真的边界。
    const boundary = this.deps.core.policyToolScope ? await this.deps.core.policyToolScope(ctx.scope.project) : undefined;
    const tools = boundary?.allowedTools ? OPS_TOOLS.filter(tool => boundary.allowedTools!.includes(tool)) : OPS_TOOLS;
    const accounts = names.map(aliasFromSecretName).filter((alias): alias is string => !!alias)
      .filter(alias => boundary?.allowedAliases === undefined || boundary.allowedAliases.includes(alias))
      .map(alias => ({ alias, username: accountUsername(alias, ctx.cfg.accounts.prefix) }));
    const supplierKinds = new Map<string, Set<string>>();
    for (const name of names) {
      const hit = supplierAliasFromSecretName(name);
      if (hit) (supplierKinds.get(hit.alias) ?? supplierKinds.set(hit.alias, new Set()).get(hit.alias)!).add(hit.kind);
    }
    return {
      value: {
        project: ctx.scope.project, env: ctx.env, productUrl: ctx.cfg.product.url, roles: ctx.cfg.roles,
        tools, toolScope: boundary ? { version: boundary.version, hash: boundary.hash,
          allowedTools: boundary.allowedTools ?? null, allowedAliases: boundary.allowedAliases ?? null, newSpend: false } : null,
        internalAiProof: { configured: !!this.proofBridge, contracts: proofToolContracts, issuer: 'urn:surreal-ck:company:internal-ai:v1', statusPath: '/internal-ai/status', identityReadPath: '/api/internal-ai/identity', paidCallsAllowed: 0 }, accounts, workspacePrefix: ctx.cfg.accounts.workspacePrefix, limits: ctx.cfg.limits,
        supplierPlanSampling: {
          provider: SUPPLIER_PROVIDER, adapter: SUPPLIER_ADAPTER, service: SUPPLIER_SERVICE,
          aliases: [...supplierKinds.entries()].map(([alias, kinds]) => ({ alias, credentials: [...kinds].sort() })),
        },
        productMagpieObservation:{tool:'ops_product_magpie_observe',model:PRODUCT_MAGPIE_MODEL,source:'configured-remote-magpie',readOnly:true,executable:false,configurationChangeRequired:false,disclosure:'产品在VPS的loopback与Mac的loopback不同；禁止将个人订阅或本机组作为产品恢复前置。'},
        magpieRouteSampling: {
          applicable:ctx.scope.project!=='surreal_ck'||ctx.env!=='production',source:'mac-local-subscription',
          provider: MAGPIE_PROVIDER, adapter: MAGPIE_ADAPTER, group: 'group/work',
          snapshotMaxAgeSeconds: MAGPIE_SNAPSHOT_MAX_AGE_SECONDS, executionHeadroomSeconds: MAGPIE_EXECUTION_HEADROOM_SECONDS,
          aliases: [...supplierKinds.entries()]
            .filter(([, kinds]) => kinds.has('USERNAME') && kinds.has('PASSWORD'))
            .map(([alias]) => alias),
          disclosures: [
            'quota windows are percentages plus resetsAt, never an absolute balance',
            'pricing is observed from the gateway catalog and stays unreviewed until a price decision exists',
            'unknown cost stays null; the document is local evidence, not a provider commitment',
          ],
        },
        magpieRouteRestore: {
          provider: MAGPIE_PROVIDER, adapter: MAGPIE_ADAPTER, group: 'group/work',
          applicable:ctx.scope.project!=='surreal_ck'||ctx.env!=='production',source:'mac-local-subscription',
          modes: ['plan'], writeAvailable: false, gatewayReload: 'unknown', recovery: 'unavailable',
          disclosures: [
            'only the read-only plan is published; apply is refused in every role with zero writes',
            'the write channel, real group schema and gateway reload semantics are unproven; the account/route recovery is not complete',
          ],
        },
        // Public client identifiers only (never secrets), so employees can align the channels
        // with what the IdP has registered (ops_idp_client_info) and the product hard-binds.
        clients: {
          customer: { clientId: ctx.cfg.idp.clientId, redirectUri: ctx.cfg.idp.redirectUri },
          ...(ctx.cfg.ops ? { operator: { clientId: ctx.cfg.ops.clientId, redirectUri: ctx.cfg.ops.redirectUri, resource: ctx.cfg.ops.resource ?? null } } : {}),
          ...(ctx.cfg.idp.ops ? { opsAudience: { clientId: ctx.cfg.idp.ops.clientId, audience: ctx.cfg.idp.ops.audience, redirectUri: ctx.cfg.idp.ops.redirectUri } } : {}),
        },
        can: { createAccounts: this.canEnsure(ctx), queryWorkspaceData: !!ctx.cfg.data, browserLogin: true, operatorLogin: !!ctx.cfg.ops, opsAudienceLogin: !!ctx.cfg.idp.ops, idpPrincipals: this.canEnsure(ctx), idpProvisionRotate: this.canEnsure(ctx) && !!ctx.cfg.ops, originHost: !!ctx.cfg.origin },
        preview: await this.previewStatus(),
      },
    };
  }

  private serviceHome(): string {
    return this.deps.serviceHome ?? process.env.SCK_SERVICE_HOME ?? join(homedir(), 'Library/Application Support/SurrealCKCompany');
  }

  /**
   * 插件内嵌交付预览的运行状态：loopback 探测 127.0.0.1:<port>/healthz 为准（权威存活），
   * 失败时回读插件写的 <serviceHome>/preview-status.json 取 lastError（如 EADDRINUSE）。
   * 双面结构：lan 面（0.0.0.0:18777 无鉴权）+ signed 面（127.0.0.1:18778 签名门控，
   * 供 VPS→隧道公网访问）。不 import plugin/server/*（vendor 边界），通道只靠 loopback + 状态文件。
   */
  private async previewStatus(): Promise<Record<string, unknown>> {
    const home = process.env.SCK_SERVICE_HOME ?? join(homedir(), 'Library/Application Support/SurrealCKCompany');
    const lanPort = Number(process.env.SCK_PREVIEW_PORT ?? 18777);
    const sigPort = Number(process.env.SCK_PREVIEW_SIGNED_PORT ?? 18778);
    const doFetch = this.deps.fetch ?? opsFetch;
    const probe = async (port: number): Promise<{ running: boolean; uptime?: number; error?: string }> => {
      try {
        const res = await doFetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) });
        if (!res.ok) return { running: false, error: `healthz HTTP ${res.status}` };
        const body = await res.json().catch(() => ({})) as { uptime?: number };
        return { running: true, uptime: body.uptime };
      } catch (error) {
        return { running: false, error: (error as Error).message };
      }
    };
    let statusFile: { lastError?: string; signed?: { configured?: boolean } } = {};
    try {
      statusFile = JSON.parse(readFileSync(join(home, 'preview-status.json'), 'utf8'));
    } catch { /* 状态文件缺席正常 */ }
    const [lan, signed] = await Promise.all([probe(lanPort), probe(sigPort)]);
    return {
      lan: { running: lan.running, port: lanPort, lanUrl: `http://${lanIPv4()}:${lanPort}`, uptime: lan.uptime, lastError: lan.error },
      signed: {
        configured: statusFile.signed?.configured ?? Boolean(process.env.SCK_PREVIEW_SECRET),
        running: signed.running, port: sigPort, uptime: signed.uptime, lastError: signed.error,
      },
      roots: { e: join(home, 'evidence'), d: join(home, 'deliverables') },
      lastError: statusFile.lastError,
    };
  }

  private async health(ctx: Ctx): Promise<Outcome> {
    const url = ctx.row.healthUrl ?? `${ctx.cfg.product.url}/health`;
    const started = this.now();
    let response: Response;
    try {
      response = await (this.deps.fetch ?? opsFetch)(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      return { value: { url, reachable: false, error: (error as Error).name } };
    }
    const raw = (await response.text().catch(() => '')).slice(0, 4000);
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    return { value: { url, reachable: true, status: response.status, ok: response.ok, ms: this.now() - started, body: redactJson(body) } };
  }

  /** Status, health probes and journal tails of the origin host; the agent there redacts first, this redacts again. */
  private async origin(ctx: Ctx, request: OriginRequest): Promise<Outcome> {
    if (!ctx.cfg.origin) throw new CompanyError('not_configured', `${ctx.scope.project}/${ctx.env} has no origin host configured`);
    const { ok: _ok, ...reply } = await (this.deps.originAgent ?? sshOriginAgent)(ctx.cfg.origin, request);
    const value = redactJson(reply, this.sessions.secrets(ctx.scope.actor.employeeId));
    const detail = request.op === 'logs' ? ` service=${request.service} since=${request.since} matched=${String(reply.matched)}${request.grep ? ` grep=${request.grep}` : ''}` : '';
    return { value, audit: { action: 'ops_call', evidence: `ops_origin_${request.op} host=${ctx.cfg.origin.host}${detail}` } };
  }

  // ---------- accounts ----------

  private canEnsure(ctx: Ctx): boolean {
    const env = this.controlEnv();
    return !!(ctx.cfg.d1 && (this.deps.d1 || (env.cloudflareToken && env.cloudflareAccountId)));
  }

  private controlEnv(): ControlPlaneEnv { return (this.deps.controlEnv ?? controlPlaneEnv)(); }

  private d1(ctx: Ctx): D1Client {
    if (!ctx.cfg.d1) throw new CompanyError('not_configured', 'this environment has no IdP database configured for account management');
    const env = this.controlEnv();
    if (this.deps.d1) return this.deps.d1(ctx.cfg, env);
    if (!env.cloudflareToken || !env.cloudflareAccountId) throw new CompanyError('not_configured', 'the control plane has no Cloudflare credentials for account management');
    return cloudflareD1({ accountId: env.cloudflareAccountId, databaseId: ctx.cfg.d1.databaseId, token: env.cloudflareToken, baseUrl: env.cloudflareBaseUrl, fetch: this.deps.fetch });
  }

  private async sealedPassword(ctx: Ctx, alias: string): Promise<string | undefined> {
    return this.deps.projects.readSealed(ctx.scope.project, ctx.env, passwordSecretName(alias), this.deps.secretKey());
  }

  /** Creates or repairs the IdP account behind an alias; the password is sealed before the IdP sees it. */
  private async ensure(ctx: Ctx, alias: string): Promise<EnsureAccountResult & { username: string; email: string }> {
    const d1 = this.d1(ctx);
    const username = accountUsername(alias, ctx.cfg.accounts.prefix);
    const email = accountEmail(username, ctx.cfg.accounts.emailDomain);
    const outcome = await ensureAccount({
      d1, tenantId: ctx.cfg.d1!.tenantId, username, email,
      sealed: await this.sealedPassword(ctx, alias),
      now: () => new Date(this.now()),
      beforeCreate: async () => {
        const used = await this.deps.core.opsCount(ctx.scope.project, 'ops_account_create', DAY_SECONDS);
        if (used >= ctx.cfg.limits.accountsPerDay) throw new CompanyError('limit_reached', `account creation limit reached (${ctx.cfg.limits.accountsPerDay} per day)`);
      },
      seal: password => this.deps.projects.setSecret(
        { project: ctx.scope.project, env: ctx.env, name: passwordSecretName(alias), value: password, purpose: 'ops broker test account' },
        this.deps.secretKey(true)),
    });
    if (outcome.result === 'created') await this.audit(ctx, 'ops_account_create', `created IdP account ${username}`);
    else if (outcome.result === 'repaired') await this.audit(ctx, 'ops_account_repair', `reset drifted credential of IdP account ${username}`);
    return { ...outcome, username, email };
  }

  private async accountEnsure(ctx: Ctx, args: Args): Promise<Outcome> {
    const alias = canonicalAlias(args.alias);
    const { result, username, email } = await this.ensure(ctx, alias);
    return {
      value: { alias, username, email, result },
      audit: result === 'exists' ? { action: 'ops_call', evidence: `ops_account_ensure ${alias} → exists` } : undefined,
    };
  }

  /**
   * Read-only view of a registered IdP client plus how it lines up with this environment's
   * configured channels — the diagnosis half of a client-id mismatch. Only public registration
   * metadata leaves; `describeSpaClient` never selects the secret hash itself.
   */
  private async idpClientInfo(ctx: Ctx, args: Args): Promise<Outcome> {
    const byName = args.client_name !== undefined;
    const byId = args.client_id !== undefined;
    if (byName === byId) throw invalid('pass exactly one of client_name or client_id');
    const key = byName ? { clientName: spaClientName(args.client_name) } : { clientId: clientId(args.client_id) };
    const info = await describeSpaClient(this.d1(ctx), ctx.cfg.d1!.tenantId, key);
    if (!info) throw new CompanyError('not_found', `no IdP client registered for ${byName ? `client_name ${key.clientName}` : `client_id ${key.clientId}`}`);
    const ops = ctx.cfg.ops;
    return {
      value: {
        ...info,
        alignment: {
          customerClient: info.clientId === ctx.cfg.idp.clientId,
          operatorClient: ops !== undefined && info.clientId === ops.clientId,
          opsAudienceClient: ctx.cfg.idp.ops !== undefined && info.clientId === ctx.cfg.idp.ops.clientId,
          ...(ops ? {
            operatorRedirectRegistered: info.redirectUris.includes(ops.redirectUri),
            operatorAudienceMatch: ops.resource === undefined || info.accessTokenAudience === ops.resource,
          } : {}),
        },
      },
      audit: { action: 'ops_call', evidence: `ops_idp_client_info ${info.clientName} → ${info.clientId}` },
    };
  }

  /**
   * Registers an IdP public SPA client (a shape the dynamic-registration endpoint cannot
   * express). Redirect URIs and the token audience are confined to the product host, the
   * row carries no secret, and the answer is only the public `client_id`.
   */
  private async idpClientRegister(ctx: Ctx, args: Args): Promise<Outcome> {
    const clientName = spaClientName(args.client_name);
    const allowedHost = new URL(ctx.cfg.product.url).hostname;
    const redirectUris = redirectUriList(args.redirect_uris, allowedHost);
    const { clientId, result } = await registerSpaClient({
      d1: this.d1(ctx), tenantId: ctx.cfg.d1!.tenantId,
      clientName, redirectUris,
      accessTokenAudience: audienceUrl(args.access_token_audience, allowedHost),
      now: () => new Date(this.now()),
    });
    return {
      value: { clientName, clientId, result },
      audit: {
        action: result === 'created' ? 'ops_idp_client_create' : 'ops_call',
        evidence: `ops_idp_client_register ${clientName} → ${result} ${clientId}`,
      },
    };
  }

  /**
   * Reads and surgically deletes IdP client access-token claim rows — the compliant path for
   * locating and removing malformed claims (e.g. an array-semantic claim stored as a bare string,
   * which breaks token deserialization for the whole client). `list` resolves the internal
   * oidc_clients.id the claims table keys on, or scans one claim_name tenant-wide; `delete` is
   * scoped to one public client_id + claim_name plus optional equality qualifiers, answers the
   * exact rows it removed, and refuses to report success on an empty match.
   */
  private async idpClientClaims(ctx: Ctx, args: Args): Promise<Outcome> {
    const action = args.action;
    if (action !== 'list' && action !== 'delete') throw invalid('action must be "list" or "delete"');
    const d1 = this.d1(ctx);
    const tenantId = ctx.cfg.d1!.tenantId;
    const byName = args.client_name !== undefined;
    const byId = args.client_id !== undefined;
    if (byName && byId) throw invalid('pass at most one of client_name or client_id');
    const name = args.claim_name === undefined ? undefined : claimName(args.claim_name);
    const qualifiers = claimQualifiers(args);

    if (action === 'list') {
      if (!byName && !byId && name === undefined) {
        throw invalid('list needs a client (client_id or client_name), a claim_name to scan for, or both');
      }
      if (!byName && !byId) {
        const result = await scanClaimsByName(d1, tenantId, name!, qualifiers);
        return {
          value: result,
          audit: { action: 'ops_call', evidence: `ops_idp_client_claims list claim_name=${name} → ${result.claims.length} 行` },
        };
      }
      const key = byName ? { clientName: spaClientName(args.client_name) } : { clientId: clientId(args.client_id) };
      const client = await resolveClient(d1, tenantId, key);
      if (!client) {
        throw new CompanyError('not_found', `no IdP client registered for ${'clientName' in key ? `client_name ${key.clientName}` : `client_id ${key.clientId}`}`);
      }
      const result = await listClientClaims(d1, tenantId, client, name, qualifiers);
      return {
        value: { clientId: client.clientId, clientName: client.clientName, ...result },
        audit: { action: 'ops_call', evidence: `ops_idp_client_claims list ${client.clientName} → ${result.claims.length} 行` },
      };
    }

    if (!byId) throw invalid('delete requires the public client_id (resolve it with a list call first)');
    if (name === undefined) throw invalid('delete requires claim_name');
    const publicId = clientId(args.client_id);
    const client = await resolveClient(d1, tenantId, { clientId: publicId });
    if (!client) throw new CompanyError('not_found', `no IdP client registered for client_id ${publicId}`);
    const rows = await deleteClientClaims(d1, tenantId, client, name, qualifiers);
    if (!rows.length) {
      throw new CompanyError('not_found', `no claim rows matched client ${publicId} claim_name ${name}`);
    }
    const qualifierText = describeQualifiers(qualifiers);
    return {
      value: { deleted: rows.length, rows },
      audit: {
        action: 'ops_idp_claims_delete',
        evidence: `ops_idp_client_claims delete ${client.clientName}(${client.clientId})/${name}${qualifierText ? ` where ${qualifierText}` : ''} → ${rows.length} 行`,
      },
    };
  }

  // ---------- IdP service principals ----------
  //
  // The IdP gates mint/revoke on a human admin session, so the broker performs the same writes
  // its D1 access already makes for account provisioning: the row carries only the token hash,
  // the value is sealed in env_secret before the insert, and a compensating audit_events row keeps
  // the IdP-side trail intact. The human bootstrap password is never touched.

  /** Reads a minted token back from its sealed name; only trusted broker code may do this. */
  private async sealedPrincipalToken(ctx: Ctx, id: string): Promise<string | undefined> {
    return this.deps.projects.readSealed(ctx.scope.project, ctx.env, principalTokenSecretName(id), this.deps.secretKey());
  }

  private async idpPrincipalMint(ctx: Ctx, args: Args): Promise<Outcome> {
    const label = text(args, 'label', 80);
    const sealAs = args.sealAs === undefined ? undefined : canonicalAlias(args.sealAs);
    const d1 = this.d1(ctx);
    // The token is sealed before the D1 write so a failed insert can never strand a live
    // credential the broker cannot reach (the leftover seal belongs to no existing row).
    const id = randomUUID();
    const token = mintServicePrincipalToken();
    const tokenHash = await sha256Base64Url(token);
    await this.deps.projects.setSecret(
      { project: ctx.scope.project, env: ctx.env, name: principalTokenSecretName(id), value: token, purpose: 'IdP admin service principal token (sealed for ops_idp_admin_request)' },
      this.deps.secretKey(true));
    const minted = await insertServicePrincipal({
      d1, id, label, tokenHash, createdBy: `ops:${ctx.scope.actor.employeeId}`, now: () => new Date(this.now()),
    });
    let sealedAlias: string | undefined;
    if (sealAs !== undefined) {
      sealedAlias = principalAliasSecretName(sealAs);
      await this.deps.projects.setSecret(
        { project: ctx.scope.project, env: ctx.env, name: sealedAlias, value: token, purpose: 'IdP admin service principal token (sealed for ops_idp_admin_request)' },
        this.deps.secretKey(true));
    }
    await recordIdpAuditBestEffort(d1, {
      actorType: 'management_token', actorId: `ops:${ctx.scope.actor.employeeId}`,
      eventType: 'admin.service_principal.minted', targetType: 'service_principal', targetId: minted.id,
      payload: { label, scopes: minted.scopes, via: 'ops_broker' }, occurredAt: minted.createdAt,
    });
    // The token never leaves the broker (manager ruling v41 on credential output): both branches answer with sealed
    // references only, so omitting sealAs cannot echo the raw value. `sealed` is the name ops_idp_admin_request resolves
    // from the principal id; `sealedAs` is the caller's extra alias when one was asked for.
    return {
      value: {
        id: minted.id, label, scopes: minted.scopes, status: minted.status, createdAt: minted.createdAt,
        sealed: principalTokenSecretName(id),
        ...(sealedAlias ? { sealedAs: sealedAlias } : {}),
      },
      // The audit line is readable by the task's participants, so it names the sealed secret only as sealed: the alias is credential metadata.
      audit: { action: 'ops_idp_principal_mint', evidence: `ops_idp_principal_mint ${label} → ${minted.id}（已密封）` },
    };
  }

  private async idpPrincipalRevoke(ctx: Ctx, args: Args): Promise<Outcome> {
    const id = principalId(args.principalId);
    const d1 = this.d1(ctx);
    const { principal, alreadyRevoked } = await revokeServicePrincipal({ d1, principalId: id, now: () => new Date(this.now()) });
    if (!alreadyRevoked) {
      await recordIdpAuditBestEffort(d1, {
        actorType: 'management_token', actorId: `ops:${ctx.scope.actor.employeeId}`,
        eventType: 'admin.service_principal.revoked', targetType: 'service_principal', targetId: id,
        payload: { label: principal.label, via: 'ops_broker' }, occurredAt: principal.revokedAt ?? new Date(this.now()).toISOString(),
      });
    }
    return {
      value: { id, status: 'revoked', revokedAt: principal.revokedAt, alreadyRevoked },
      audit: alreadyRevoked
        ? { action: 'ops_call', evidence: `ops_idp_principal_revoke ${id} → 已吊销` }
        : { action: 'ops_idp_principal_revoke', evidence: `ops_idp_principal_revoke ${id}` },
    };
  }

  /**
   * Relays one request to the IdP's service-principal-scoped admin routes with the principal's
   * sealed token as the bearer — the token is read, sent and redacted inside the broker only.
   * Revoked principals still reach the IdP on purpose: a 403 there is exactly what a revocation
   * check needs to observe.
   */
  private async idpAdminRequest(ctx: Ctx, args: Args): Promise<Outcome> {
    const id = principalId(args.principalId);
    const { method, path } = adminRequestTarget(args.method, args.path);
    const token = await this.sealedPrincipalToken(ctx, id);
    if (!token) throw new CompanyError('not_found', `no sealed token for principal ${id}; only broker-minted principals can be called through ops_idp_admin_request`);
    const origin = new URL(ctx.cfg.idp.issuer).origin;
    const res = await idpAdminRequest(origin, token, { method, path, body: args.body }, { fetch: this.deps.fetch });
    const known = [token, ...this.sessions.secrets(ctx.scope.actor.employeeId)];
    return {
      value: { status: res.status, ok: res.ok, body: clipJson(redactJson(res.body, known)) },
      audit: { action: 'ops_call', evidence: `ops_idp_admin_request ${method} ${path} → ${res.status}（principal ${id}）` },
    };
  }

  /** Read-only principal inventory (ids, labels, status) so callers can name a revokePrincipalId without SQL access. */
  private async idpPrincipalList(ctx: Ctx, args: Args): Promise<Outcome> {
    const status = args.status === undefined ? undefined
      : args.status === 'active' || args.status === 'revoked' ? args.status
        : undefined;
    if (args.status !== undefined && status === undefined) throw invalid('status must be "active" or "revoked"');
    const principals = await listServicePrincipals(this.d1(ctx), status);
    return {
      value: {
        principals: principals.map(p => ({
          id: p.id, label: p.label, scopes: p.scopes, status: p.status,
          createdAt: p.createdAt, revokedAt: p.revokedAt, createdBy: p.createdBy,
        })),
      },
      audit: { action: 'ops_call', evidence: `ops_idp_principal_list → ${principals.length} 个` },
    };
  }

  /**
   * 一键轮换 provision token：吊销旧 principal → mint 新 principal（token 密封留在 broker）→
   * 经运营会话调产品 rotate 端点把新 token 封进 _system 密封仓 → 双探针验证（新 token 活、
   * 旧 token 403）。token 明文全程不出 broker 进程；产品侧懒解析使下一次调用即生效，无需
   * 重部署、不碰 GitHub secrets、不登任何 console。
   *
   * 顺序语义：先吊销后注入——旧凭证先死，新凭证后生，永远不存在两枚同时在线的 provision
   * token；注入失败时补偿吊销新 principal，避免留下 broker 之外的悬空活凭证。
   */
  private async idpProvisionRotate(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.session(ctx, args);
    if (session.kind === 'customer') {
      throw invalid('a customer session cannot rotate the provision token; call ops_operator_login for an operator session');
    }
    const label = args.label === undefined ? 'sck-provisioner' : text(args, 'label', 80);
    const d1 = this.d1(ctx);
    const origin = new URL(ctx.cfg.idp.issuer).origin;

    // 1. 解析要吊销的旧 principal：显式指定，或恰好一个 active 时自动认领。
    let oldPrincipal: ServicePrincipal | undefined;
    if (args.revokePrincipalId !== undefined) {
      const id = principalId(args.revokePrincipalId);
      oldPrincipal = await findServicePrincipal(d1, id);
      if (!oldPrincipal) throw new CompanyError('not_found', `no IdP service principal ${id}`);
    } else {
      const actives = await listServicePrincipals(d1, 'active');
      if (actives.length > 1) {
        throw invalid(`多个 active principal（${actives.map(p => p.id).join(', ')}）；请显式传 revokePrincipalId`);
      }
      oldPrincipal = actives[0];
    }
    // 旧 token 的 broker 密封副本只用于吊销后的 403 探针；非 broker mint 的旧凭证跳过探针。
    const oldToken = oldPrincipal ? await this.sealedPrincipalToken(ctx, oldPrincipal.id) : undefined;

    // 2. 吊销旧（spec 顺序：旧先死）
    let revoked: { id: string; alreadyRevoked: boolean } | null = null;
    if (oldPrincipal && oldPrincipal.status === 'active') {
      const { alreadyRevoked } = await revokeServicePrincipal({ d1, principalId: oldPrincipal.id, now: () => new Date(this.now()) });
      revoked = { id: oldPrincipal.id, alreadyRevoked };
      if (!alreadyRevoked) {
        await recordIdpAuditBestEffort(d1, {
          actorType: 'management_token', actorId: `ops:${ctx.scope.actor.employeeId}`,
          eventType: 'admin.service_principal.revoked', targetType: 'service_principal', targetId: oldPrincipal.id,
          payload: { label: oldPrincipal.label, via: 'ops_broker', reason: 'provision token rotation' },
          occurredAt: new Date(this.now()).toISOString(),
        });
      }
    } else if (oldPrincipal) {
      revoked = { id: oldPrincipal.id, alreadyRevoked: true };
    }

    // 3. 签新：密封先于建行，token 不出 broker
    const newId = randomUUID();
    const token = mintServicePrincipalToken();
    const tokenHash = await sha256Base64Url(token);
    await this.deps.projects.setSecret(
      { project: ctx.scope.project, env: ctx.env, name: principalTokenSecretName(newId), value: token, purpose: 'IdP admin service principal token (sealed for ops_idp_admin_request)' },
      this.deps.secretKey(true));
    const minted = await insertServicePrincipal({
      d1, id: newId, label, tokenHash, createdBy: `ops:${ctx.scope.actor.employeeId}`, now: () => new Date(this.now()),
    });
    await recordIdpAuditBestEffort(d1, {
      actorType: 'management_token', actorId: `ops:${ctx.scope.actor.employeeId}`,
      eventType: 'admin.service_principal.minted', targetType: 'service_principal', targetId: minted.id,
      payload: { label, scopes: minted.scopes, via: 'ops_broker', rotation: true }, occurredAt: minted.createdAt,
    });

    // 4. 注入消费侧：经运营会话调产品 rotate 端点（subscription.manage 由产品侧强制）。
    //    失败则补偿吊销新 principal——旧已吊销，不留悬空活凭证。
    const rotate = await this.product(ctx, session, 'POST', '/api/ops/idp-provision-token/rotate', { token });
    if (!rotate.ok) {
      await revokeServicePrincipal({ d1, principalId: minted.id, now: () => new Date(this.now()) }).catch(() => undefined);
      await recordIdpAuditBestEffort(d1, {
        actorType: 'management_token', actorId: `ops:${ctx.scope.actor.employeeId}`,
        eventType: 'admin.service_principal.revoked', targetType: 'service_principal', targetId: minted.id,
        payload: { label, via: 'ops_broker', reason: 'rotation aborted: product rotate failed' },
        occurredAt: new Date(this.now()).toISOString(),
      });
      throw productFailure('rotating the provision token into the sealed store', rotate, { 400: 'invalid', 403: 'forbidden' });
    }

    // 5. 验证：产品 status 应为 store 源；新 token IdP 探针 200；旧 token（若 broker 持有密封副本）403。
    //    探针是证据不是闸门：注入成功后探针失败只降级为报告字段，不把已生效的轮换报成失败。
    const status = await this.product(ctx, session, 'GET', '/api/ops/idp-provision-token/status');
    const statusBody = (status.body ?? {}) as Record<string, unknown>;
    const probe = async (probeToken: string) => {
      try {
        const res = await idpAdminRequest(origin, probeToken, { method: 'GET', path: '/admin/tenants' }, { fetch: this.deps.fetch });
        return { status: res.status, ok: res.ok };
      } catch (error) {
        return { status: null, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };
    const newProbe = await probe(token);
    const oldProbe = oldToken === undefined ? undefined : await probe(oldToken);

    return {
      value: {
        rotated: true,
        newPrincipal: { id: minted.id, label, scopes: minted.scopes, createdAt: minted.createdAt },
        revoked,
        product: {
          rotate: rotate.status,
          statusOk: status.ok,
          source: typeof statusBody.source === 'string' ? statusBody.source : null,
          storeEntry: (statusBody.store as Record<string, unknown> | undefined)?.entry != null,
        },
        probes: {
          newToken: newProbe,
          oldToken: oldProbe ?? 'skipped（旧 token 非 broker mint，无密封副本可探测）',
        },
      },
      audit: {
        action: 'ops_idp_provision_rotate',
        evidence: `ops_idp_provision_rotate ${revoked ? `吊销 ${revoked.id} → ` : ''}签发 ${minted.id} → 注入密封仓（rotate ${rotate.status}）→ 新探针 ${newProbe.status}${oldProbe ? `、旧探针 ${oldProbe.status}` : ''}`,
      },
    };
  }

  /**
   * G2 邀请签发（运营代办开通）：转发产品 POST /api/ops/invitations。
   * 产品侧为异步契约：POST 在同步窗内完成 → 201/200 直接带结果；超时回 202
   * processing（任务不脱管继续跑）→ 本工具轮询 GET，僵死则同键重发触发续跑，
   * 完成后经 collect-delivery 一次性收取激活链接。
   * resend:true = 断链/24h 过期补救：调产品 resend 端点重铸链接（其余参数
   * 沿用行内已存值，只需 idempotencyKey），收取与交接走同一凭证卫生路径。
   * 一次性 activation_url 不回给员工——broker 落盘到
   * <serviceHome>/handoff/invite-<key>.txt（0600，不进 evidence/deliverables
   * 这两个 LAN 预览面），由老板本机取阅转交。重放/复用路径无新链接、不写文件。
   * 纪律：邀请签发与重发一律走本工具；禁止 ops_request 裸调
   * /api/ops/invitations*（裸调拿到的一次性链接不经 handoff 落盘，断链即丢）。
   */
  private async invitationIssue(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.session(ctx, args);
    if (session.kind === 'customer') {
      throw invalid('a customer session cannot issue invitations; call ops_operator_login for an operator session');
    }
    const idempotencyKey = text(args, 'idempotencyKey', 200);
    const resend = args.resend === true;

    let res: ProductResult;
    let resBody: Record<string, unknown>;
    let email: string;
    let workspaceSlug: string;

    if (resend) {
      res = await this.product(ctx, session, 'POST', `/api/ops/invitations/${encodeURIComponent(idempotencyKey)}/resend`);
      if (!res.ok) {
        throw productFailure('resending the invitation activation link', res, { 400: 'invalid', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 503: 'upstream_error' });
      }
      resBody = (res.body ?? {}) as Record<string, unknown>;
      const u = resBody.user as Record<string, unknown> | null;
      const w = resBody.workspace as Record<string, unknown> | null;
      email = typeof u?.email === 'string' ? u.email : '';
      workspaceSlug = typeof w?.slug === 'string' ? w.slug : '';
    } else {
      email = text(args, 'email', 200);
      const body: Record<string, unknown> = {
        email,
        displayName: text(args, 'displayName', 80),
        workspaceSlug: text(args, 'workspaceSlug', 40),
        reason: text(args, 'reason', 500),
        idempotencyKey,
      };
      if (args.aiAllowance === undefined || args.aiAllowance === null || typeof args.aiAllowance !== 'object' || Array.isArray(args.aiAllowance)) {
        throw invalid('aiAllowance {amount,expiresAt,label?} is required');
      }
      body.aiAllowance = args.aiAllowance;
      if (args.workspaceName !== undefined) body.workspaceName = text(args, 'workspaceName', 80);
      if (args.planKey !== undefined) body.planKey = text(args, 'planKey', 64);
      if (args.productPlanRevisionId !== undefined) body.productPlanRevisionId = text(args, 'productPlanRevisionId', 80);

      res = await this.product(ctx, session, 'POST', '/api/ops/invitations', body);
      if (!res.ok) {
        throw productFailure('issuing the invitation', res, { 400: 'invalid', 403: 'forbidden', 409: 'conflict', 503: 'upstream_error' });
      }

      resBody = (res.body ?? {}) as Record<string, unknown>;
      if (resBody.status === 'processing') {
        resBody = await this.awaitInvitation(ctx, session, idempotencyKey, body);
      }
      workspaceSlug = String(body.workspaceSlug);
    }

    if (resBody.status === 'failed') {
      const code = typeof resBody.errorCode === 'string' ? resBody.errorCode : 'invite-failed';
      const detail = typeof resBody.errorMessage === 'string' ? resBody.errorMessage : '';
      throw new CompanyError('upstream_error', `invitation ${idempotencyKey} failed on the product: ${code} ${detail}`.trim(), false);
    }

    let delivery = (resBody.delivery ?? {}) as Record<string, unknown>;
    let activationUrl = typeof delivery.activationUrl === 'string' && delivery.activationUrl.length > 0
      ? delivery.activationUrl : undefined;

    // 后台完成/续跑路径：行已 completed 但响应不携带链接 → 一次性收取（已收则回空）。
    if (resBody.status === 'completed' && !activationUrl && delivery.pendingCollect === true) {
      const col = await this.product(ctx, session, 'POST', `/api/ops/invitations/${encodeURIComponent(idempotencyKey)}/collect-delivery`);
      if (col.ok) {
        const collected = (col.body ?? {}) as Record<string, unknown>;
        if (typeof collected.activationUrl === 'string' && collected.activationUrl.length > 0) {
          activationUrl = collected.activationUrl;
          delivery = { ...delivery, channel: 'activation_url' };
          resBody = { ...resBody, delivery };
        }
      }
    }

    let handoff: { file: string; note: string } | undefined;
    if (activationUrl) {
      let file: string;
      try {
        file = this.writeOwnerHandoff(idempotencyKey, activationUrl, email, workspaceSlug);
      } catch (error) {
        // 链接一次性、不可重取；写失败即丢链——如实报出恢复路径，不回显 URL。
        const detail = error instanceof Error ? error.message : String(error);
        throw new CompanyError('upstream_error',
          `邀请${resend ? '重签发' : '已签发'}（idempotencyKey=${idempotencyKey}），但交接文件写入失败：${detail}。activation_url 不可重取——恢复路径：换环境修复后重发同键 resend，或 IdP 侧补重签发`, true);
      }
      delivery.activationUrl = null;
      delivery.note = 'activation_url 已写老板本机交接文件，员工侧不回显';
      handoff = { file, note: '请老板在本机打开该文件，把激活链接转交收件人' };
    }

    const known = this.sessions.secrets(ctx.scope.actor.employeeId);
    const resStatus = resBody.status ?? res.status;
    return {
      value: { status: res.status, ok: res.ok, body: clipJson(redactJson(resBody, known)), ...(handoff ? { handoff } : {}) },
      audit: {
        action: 'ops_invitation_issue',
        evidence: `ops_invitation_issue ${resend ? 'resend ' : ''}${email} ws=${workspaceSlug} → ${resStatus}${handoff ? '（激活链接→handoff 文件）' : ''}（${session.username}）`,
      },
    };
  }

  /**
   * 邀请任务轮询：GET 到 completed/failed 为止。产品在 processing 超 240s 后允许
   * 同参重发续跑（CAS 幂等，仅一个执行者）；这里越过阈值即发一次重发。
   * 超时上限只约束本次工具调用——行不脱管，以同幂等键重发本工具可继续等。
   */
  private async awaitInvitation(ctx: Ctx, session: OpsSession, key: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const deadline = this.now() + INVITE_WAIT_MS;
    const resumeAfter = this.now() + INVITE_RESUME_AFTER_MS;
    let resumed = false;
    for (;;) {
      if (this.now() >= deadline) {
        throw new CompanyError('upstream_error',
          `invitation ${key} is still processing after ${Math.round(INVITE_WAIT_MS / 60000)}min; the task is not lost — call ops_invitation_issue again with the same idempotencyKey to keep waiting/resume it`, true);
      }
      await this.sleep(INVITE_POLL_MS);
      const res = await this.product(ctx, session, 'GET', `/api/ops/invitations/${encodeURIComponent(key)}`);
      if (res.ok) {
        const polled = (res.body ?? {}) as Record<string, unknown>;
        if (polled.status === 'completed' || polled.status === 'failed') return polled;
      } else if (res.status >= 400 && res.status < 500) {
        throw productFailure('polling the invitation', res, { 403: 'forbidden', 404: 'not_found' });
      }
      // 5xx 轮询失败当瞬断继续等。
      if (!resumed && this.now() >= resumeAfter) {
        resumed = true;
        const re = await this.product(ctx, session, 'POST', '/api/ops/invitations', body);
        if (re.ok) {
          const rb = (re.body ?? {}) as Record<string, unknown>;
          if (rb.status === 'completed' || rb.status === 'failed') return rb;
        }
      }
    }
  }

  /** 一次性凭证的落地处：老板本机目录（0600），刻意不进 LAN 预览面。 */
  private writeOwnerHandoff(key: string, activationUrl: string, email: string, workspace: string): string {
    const home = process.env.SCK_SERVICE_HOME ?? join(homedir(), 'Library/Application Support/SurrealCKCompany');
    const dir = join(home, 'handoff');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `invite-${key.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120)}.txt`;
    const file = join(dir, name);
    writeFileSync(file, [
      'G2 邀请激活链接 —— 一次性凭证，仅供老板转交收件人，勿再分发。',
      `收件邮箱: ${email}`,
      `workspace: ${workspace}`,
      `幂等键: ${key}`,
      `签发时间: ${new Date(this.now()).toISOString()}`,
      '有效期: 签发后 24 小时，激活成功即失效。',
      '',
      '激活链接（整行复制转交收件人）:',
      activationUrl,
      '',
    ].join('\n'), { mode: 0o600 });
    return file;
  }

  // ---------- sessions ----------

  private async login(ctx: Ctx, args: Args): Promise<Outcome> {
    const alias = canonicalAlias(args.alias);
    const username = accountUsername(alias, ctx.cfg.accounts.prefix);
    if (args.audience !== undefined && args.audience !== 'ops') {
      throw invalid('audience must be "ops" when given; omit it for a customer login');
    }
    if (args.audience === 'ops') return this.opsLogin(ctx, args, alias, username);
    let password = await this.sealedPassword(ctx, alias);
    let ensured: EnsureAccountResult['result'] | undefined;
    if (!password) {
      ({ password, result: ensured } = await this.ensure(ctx, alias));
    }
    let tokens: LoginTokens;
    try {
      tokens = await passwordLogin(ctx.cfg, username, password, { fetch: this.deps.fetch, now: this.now, channel: 'customer' });
    } catch (error) {
      // A sealed password the IdP no longer accepts is drift (someone reset it out of band): repair once.
      if (!(error instanceof LoginError) || error.reason !== 'invalid_credentials' || ensured || !this.canEnsure(ctx)) throw error;
      ({ password, result: ensured } = await this.ensure(ctx, alias));
      tokens = await passwordLogin(ctx.cfg, username, password, { fetch: this.deps.fetch, now: this.now, channel: 'customer' });
    }
    const session = this.sessions.create({
      employeeId: ctx.scope.actor.employeeId, project: ctx.scope.project, env: ctx.env, alias, username,
      kind: 'customer', token: tokens.accessToken, expiresAt: tokens.expiresAt,
    });
    let listing: { workspaces: WorkspaceItem[]; canCreate: boolean };
    try {
      listing = await this.listWorkspaces(ctx, session);
      if (args.workspace !== undefined) {
        const wanted = slugOf(args, 'workspace');
        const item = listing.workspaces.find(w => w.slug === wanted);
        if (!item) throw new CompanyError('not_found', `${username} is not a member of workspace ${wanted}`);
        await this.switchTo(ctx, session, item);
      }
    } catch (error) {
      this.sessions.drop(session.id);
      throw error;
    }
    return {
      value: {
        session: session.id, kind: session.kind, alias, username, expiresAt: new Date(session.expiresAt).toISOString(),
        accountResult: ensured, workspace: session.workspace, canCreate: listing.canCreate,
        workspaces: listing.workspaces.map(({ slug, name, role }) => ({ slug, name, role })),
      },
      audit: { action: 'ops_login', evidence: `login as ${username}${ensured ? `（账号已${ensured === 'created' ? '创建' : '修复'}）` : ''}${session.workspace ? `，进入 workspace ${session.workspace.slug}` : ''}（attempts ${tokens.attempts} lastStage ${loginStageOf(tokens.trace)} hops ${tailHops(tokens.trace)}）` },
    };
  }

  /**
   * `ops_login` with `audience:"ops"`: the alias logs in through the public client registered
   * at the IdP for the ops audience, redeeming the code at the IdP's own `/token` endpoint.
   * An ops session never lists or enters workspaces (the product's session routes do not
   * accept that audience) and never auto-creates an account: a fresh account is not an
   * operator, so a missing sealed password is a plain not_found.
   */
  private async opsLogin(ctx: Ctx, args: Args, alias: string, username: string): Promise<Outcome> {
    if (!ctx.cfg.idp.ops) {
      throw new CompanyError('not_configured', 'this environment has no ops login configured (broker idp.ops)');
    }
    if (args.workspace !== undefined) throw invalid('an ops session cannot enter a workspace');
    const password = await this.sealedPassword(ctx, alias);
    if (!password) {
      throw new CompanyError('not_found', `no sealed password for ${alias}; ops logins never auto-create accounts`);
    }
    const tokens = await passwordLogin(ctx.cfg, username, password, { fetch: this.deps.fetch, now: this.now, channel: 'ops' });
    const session = this.sessions.create({
      employeeId: ctx.scope.actor.employeeId, project: ctx.scope.project, env: ctx.env, alias, username,
      kind: 'ops', token: tokens.accessToken, expiresAt: tokens.expiresAt,
    });
    return {
      value: {
        session: session.id, kind: session.kind, alias, username, expiresAt: new Date(session.expiresAt).toISOString(),
        audience: 'ops',
      },
      audit: { action: 'ops_login', evidence: `login as ${username}（audience=ops，attempts ${tokens.attempts} lastStage ${loginStageOf(tokens.trace)} hops ${tailHops(tokens.trace)}）` },
    };
  }

  /**
   * Logs the alias in through the dedicated ops OIDC client so the session's token carries the
   * ops audience, then probes the product's operator middleware (`/api/ops/quota/context` needs
   * an active platform operator and no specific capability) so a wrong-audience token, an
   * account that is not an operator, or one whose ops client is misconfigured fails here with
   * a clear error instead of inside somebody's workflow.
   */
  private async operatorLogin(ctx: Ctx, args: Args): Promise<Outcome> {
    if (!ctx.cfg.ops) throw new CompanyError('not_configured', 'this environment has no operator channel; set broker.ops (clientId, redirectUri, resource) to enable it');
    const alias = canonicalAlias(args.alias);
    const username = accountUsername(alias, ctx.cfg.accounts.prefix);
    let password = await this.sealedPassword(ctx, alias);
    let ensured: EnsureAccountResult['result'] | undefined;
    if (!password) {
      // 恢复通道只登录既有账号：ensure 会创建/修复账号，是产品写入，grant 不允许。
      if (ctx.recovery) throw new CompanyError('not_found', 'Recovery read never ensures accounts; the grant alias has no sealed password');
      ({ password, result: ensured } = await this.ensure(ctx, alias));
    }
    let tokens: LoginTokens;
    try {
      tokens = await passwordLogin(ctx.cfg, username, password, { fetch: this.deps.fetch, now: this.now, channel: 'operator' });
    } catch (error) {
      // A sealed password the IdP no longer accepts is drift (someone reset it out of band): repair once.
      if (!(error instanceof LoginError) || error.reason !== 'invalid_credentials' || ensured || !this.canEnsure(ctx) || ctx.recovery) throw error;
      ({ password, result: ensured } = await this.ensure(ctx, alias));
      tokens = await passwordLogin(ctx.cfg, username, password, { fetch: this.deps.fetch, now: this.now, channel: 'operator' });
    }
    const session = this.sessions.create({
      employeeId: ctx.scope.actor.employeeId, project: ctx.scope.project, env: ctx.env, alias, username,
      kind: 'operator', token: tokens.accessToken, expiresAt: tokens.expiresAt,
      ...(ctx.recovery ? { grantId: ctx.recovery.grantId } : {}),
    });
    const probe = await productRequest(ctx.cfg, session.token, { method: 'GET', path: '/api/ops/quota/context' }, { fetch: this.deps.fetch });
    if (!probe.ok) {
      this.sessions.drop(session.id);
      throw productFailure('operator access check', probe, { 401: 'login_failed', 403: 'forbidden' });
    }
    const known = this.sessions.secrets(ctx.scope.actor.employeeId);
    return {
      value: {
        session: session.id, kind: session.kind, alias, username, expiresAt: new Date(session.expiresAt).toISOString(),
        accountResult: ensured, operator: clipJson(redactJson(probe.body, known)),
      },
      audit: { action: 'ops_operator_login', evidence: `operator login as ${username}${ensured ? `（账号已${ensured === 'created' ? '创建' : '修复'}）` : ''}（attempts ${tokens.attempts} lastStage ${loginStageOf(tokens.trace)} hops ${tailHops(tokens.trace)}）` },
    };
  }

  private logout(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.session(ctx, args);
    this.sessions.drop(session.id);
    return Promise.resolve({ value: { closed: true }, audit: { action: 'ops_call', evidence: `ops_logout ${session.username}` } });
  }

  private session(ctx: Ctx, args: Args): OpsSession {
    const session = this.sessions.get(args.session, ctx.scope.actor.employeeId, ctx.scope.project, ctx.env);
    // H5：恢复通道只认“本 grant 已取得的会话”。同一员工的旧会话、别的 grant 的会话或别的别名都不能借用。
    if (ctx.recovery && (session.grantId !== ctx.recovery.grantId || session.alias !== ctx.recovery.alias)) {
      throw new CompanyError('forbidden', 'Recovery read can only use a session opened under this grant and alias');
    }
    return session;
  }

  /** Every session tool but `ops_request` only makes sense for a customer session. */
  private customerSession(ctx: Ctx, args: Args): OpsSession {
    const session = this.session(ctx, args);
    if (session.kind !== 'customer') {
      throw invalid(`this session is an ${session.kind} session; it can only be used with ops_request on /api/ops/* paths`);
    }
    return session;
  }

  private adopt(session: OpsSession, token: { accessToken: string; expiresIn?: number }): void {
    session.token = token.accessToken;
    session.expiresAt = token.expiresIn !== undefined ? this.now() + token.expiresIn * 1000
      : jwtExpiry(token.accessToken) ?? this.now() + DEFAULT_TOKEN_MS;
  }

  /** Logs the session's account in again (same sealed password) and restores its workspace scope. */
  private async reauth(ctx: Ctx, session: OpsSession): Promise<void> {
    const password = await this.sealedPassword(ctx, session.alias);
    if (!password) throw new CompanyError('not_found', `no sealed password for ${session.alias}; call ops_account_ensure`);
    const tokens = await passwordLogin(ctx.cfg, session.username, password, { fetch: this.deps.fetch, now: this.now, channel: session.kind });
    session.token = tokens.accessToken;
    session.expiresAt = tokens.expiresAt;
    const workspace = session.workspace;
    session.workspace = undefined;
    if (workspace) {
      const res = await productRequest(ctx.cfg, session.token, { method: 'POST', path: '/api/session/switch-workspace', body: { workspaceSlug: workspace.slug } }, { fetch: this.deps.fetch });
      if (!res.ok || !res.token) throw productFailure('re-entering workspace', res, { 403: 'forbidden' });
      this.adopt(session, res.token);
      session.workspace = workspace;
    }
  }

  private async product(ctx: Ctx, session: OpsSession, method: string, path: string, body?: unknown): Promise<ProductResult> {
    if (ctx.recovery && this.now() >= session.expiresAt - REFRESH_MARGIN_MS) {
      throw new CompanyError('login_failed', 'Recovery read session expired; no re-login is allowed under the grant');
    }
    if (!ctx.recovery && this.now() >= session.expiresAt - REFRESH_MARGIN_MS) await this.reauth(ctx, session);
    const send = () => productRequest(ctx.cfg, session.token, { method, path, body }, { fetch: this.deps.fetch });
    let res = await send();
    if (res.status === 401) {
      // 恢复通道的一次登录只换一个会话：401 不能触发再登录，直接停链。
      if (ctx.recovery) throw new CompanyError('login_failed', 'Recovery read session was rejected (401); no re-login is allowed under the grant');
      await this.reauth(ctx, session);
      res = await send();
    }
    if (res.token) {
      this.adopt(session, res.token);
      // A raw request may have moved the token to another scope; workspace-bound tools re-resolve it.
      if (session.workspace && !(method === 'POST' && path === '/api/session/switch-workspace')) session.workspace = undefined;
    }
    return res;
  }

  // ---------- workspaces ----------

  private async listWorkspaces(ctx: Ctx, session: OpsSession): Promise<{ workspaces: WorkspaceItem[]; canCreate: boolean }> {
    const res = await this.product(ctx, session, 'GET', '/api/session/workspaces');
    if (!res.ok) throw productFailure('listing workspaces', res);
    const body = (res.body ?? {}) as { workspaces?: Array<Record<string, unknown>>; canCreate?: boolean };
    const workspaces = (body.workspaces ?? []).filter(w => typeof w.slug === 'string' && typeof w.dbName === 'string').map(w => ({
      slug: w.slug as string, name: String(w.name ?? w.slug), dbName: w.dbName as string,
      role: typeof w.role === 'string' ? w.role : undefined,
    }));
    return { workspaces, canCreate: body.canCreate === true };
  }

  private async switchTo(ctx: Ctx, session: OpsSession, item: WorkspaceItem): Promise<void> {
    const res = await this.product(ctx, session, 'POST', '/api/session/switch-workspace', { workspaceSlug: item.slug });
    if (!res.ok) throw productFailure(`switching to workspace ${item.slug}`, res, { 403: 'forbidden', 409: 'conflict' });
    session.workspace = { slug: item.slug, dbName: item.dbName };
  }

  /** Puts the session's token in the scope of `slug`, switching only when it is not already there. */
  private async useWorkspace(ctx: Ctx, session: OpsSession, slug: string): Promise<{ slug: string; dbName: string }> {
    if (session.workspace?.slug === slug && this.now() < session.expiresAt - REFRESH_MARGIN_MS) return session.workspace;
    const item = (await this.listWorkspaces(ctx, session)).workspaces.find(w => w.slug === slug);
    if (!item) throw new CompanyError('not_found', `${session.username} is not a member of workspace ${slug}`);
    await this.switchTo(ctx, session, item);
    return session.workspace!;
  }

  private async workspaceEnsure(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.customerSession(ctx, args);
    const slug = slugOf(args);
    const listing = await this.listWorkspaces(ctx, session);
    const existing = listing.workspaces.find(w => w.slug === slug);
    if (existing) {
      await this.switchTo(ctx, session, existing);
      return {
        value: { slug, name: existing.name, dbName: existing.dbName, role: existing.role, created: false },
        audit: { action: 'ops_workspace_use', evidence: `${session.username} 进入已有 workspace ${slug}` },
      };
    }
    if (args.name === undefined) throw new CompanyError('not_found', `workspace ${slug} does not exist for ${session.username}; pass name to create it`);
    const name = text(args, 'name', 80);
    const { workspacePrefix } = ctx.cfg.accounts;
    if (!slug.startsWith(workspacePrefix)) throw invalid(`new workspace slugs must start with ${workspacePrefix}`);
    if (!listing.canCreate) throw new CompanyError('forbidden', `${session.username} may not create workspaces`);
    const used = await this.deps.core.opsCount(ctx.scope.project, 'ops_workspace_create', DAY_SECONDS);
    if (used >= ctx.cfg.limits.workspacesPerDay) throw new CompanyError('limit_reached', `workspace creation limit reached (${ctx.cfg.limits.workspacesPerDay} per day); reuse an existing one`);
    const res = await this.product(ctx, session, 'POST', '/api/workspaces', { name, slug }).catch((error: unknown) => {
      throw error instanceof ProductUnreachable ? unfinishedCreation(slug, error.message) : error;
    });
    if (res.status >= 500) throw unfinishedCreation(slug, `HTTP ${res.status} ${errorCode(res.body)}`);
    if (res.status === 409) {
      throw new CompanyError('conflict', `creating workspace ${slug} failed: HTTP 409 ${errorCode(res.body)}; the slug belongs to another account, or an earlier creation of it just finished: call ops_workspace_ensure again, and take a different slug only if it is still not listed for ${session.username}`);
    }
    if (!res.ok) throw productFailure(`creating workspace ${slug}`, res, { 403: 'forbidden', 400: 'invalid' });
    const created = (res.body ?? {}) as { slug?: string; dbName?: string };
    if (typeof created.dbName !== 'string') throw new CompanyError('upstream_error', 'workspace was created but the product returned no database name');
    session.workspace = { slug, dbName: created.dbName };
    return {
      value: { slug, name, dbName: created.dbName, role: 'admin', created: true },
      audit: { action: 'ops_workspace_create', evidence: `${session.username} 创建 workspace ${slug}（${name}）` },
    };
  }

  // ---------- members ----------

  private async members(ctx: Ctx, session: OpsSession, slug: string): Promise<Array<{ id: string; email?: string; displayName?: string; isAdmin: boolean; joined: boolean }>> {
    const { dbName } = await this.useWorkspace(ctx, session, slug);
    const [rows] = await this.runQuery(ctx, session, dbName,
      "SELECT id, display_name, email, is_admin, subject FROM user WHERE kind = 'human' AND disabled_at = NONE") as [Array<Record<string, unknown>>];
    return (rows ?? []).map(row => ({
      id: plainId(row.id), email: typeof row.email === 'string' ? row.email : undefined,
      displayName: typeof row.display_name === 'string' ? row.display_name : undefined,
      isAdmin: row.is_admin === true, joined: !!row.subject,
    }));
  }

  private async memberList(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.customerSession(ctx, args);
    const slug = slugOf(args);
    return {
      value: { slug, members: await this.members(ctx, session, slug) },
      audit: { action: 'ops_call', evidence: `ops_member_list ${slug}` },
    };
  }

  private async memberAdd(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.customerSession(ctx, args);
    const slug = slugOf(args);
    const alias = canonicalAlias(args.alias);
    const username = accountUsername(alias, ctx.cfg.accounts.prefix);
    const admin = args.admin === true;
    const res = await this.product(ctx, session, 'POST', `/api/workspaces/${slug}/members`, {
      email: accountEmail(username, ctx.cfg.accounts.emailDomain), displayName: username, isAdmin: admin,
    });
    if (!res.ok) throw productFailure(`adding ${username} to ${slug}`, res, { 403: 'forbidden', 404: 'not_found' });
    return {
      value: { slug, alias, username, admin, added: true },
      audit: { action: 'ops_member_add', evidence: `${session.username} 把 ${username} 加入 ${slug}（${admin ? '管理员' : '成员'}）` },
    };
  }

  private async memberRemove(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.customerSession(ctx, args);
    const slug = slugOf(args);
    const alias = canonicalAlias(args.alias);
    const username = accountUsername(alias, ctx.cfg.accounts.prefix);
    const email = accountEmail(username, ctx.cfg.accounts.emailDomain);
    const member = (await this.members(ctx, session, slug)).find(m => m.email?.toLowerCase() === email);
    if (!member) throw new CompanyError('not_found', `${username} is not a member of ${slug}`);
    const res = await this.product(ctx, session, 'DELETE', `/api/workspaces/${slug}/members/${encodeURIComponent(member.id)}`);
    if (!res.ok) throw productFailure(`removing ${username} from ${slug}`, res, { 403: 'forbidden', 404: 'not_found' });
    return {
      value: { slug, alias, username, removed: true },
      audit: { action: 'ops_member_remove', evidence: `${session.username} 把 ${username} 移出 ${slug}` },
    };
  }

  // ---------- supplier plan/quota evidence sampling ----------

  /**
   * `ops_supplier_plan_sample {env?, alias, purpose}`: samples the sealed supplier account's
   * plan/quota facts through the fixed SenseNova adapter and writes a reviewed-token-plan
   * evidence document plus a sanitized receipt under the task evidence root. The argument
   * surface is deliberately closed — only an alias and a bounded purpose text; no URLs,
   * paths, credentials, tokens, cookies or caller-supplied financial/account facts ever
   * reach the provider. Every missing or unverifiable fact answers `blocked` with gaps.
   */
  private async supplierPlanSample(ctx: Ctx, args: Args): Promise<Outcome> {
    const allowed = new Set(['env', 'alias', 'purpose']);
    const extra = Object.keys(args).filter(key => !allowed.has(key));
    if (extra.length) throw invalid(`ops_supplier_plan_sample accepts only alias and purpose (rejected: ${extra.join(', ')})`);
    const alias = canonicalAlias(args.alias);
    const purpose = text(args, 'purpose', 200);
    if (/[:\\/@]|\b(?:bearer|token|cookie|secret|password|api[-_ ]?key)\b|[A-Za-z0-9_-]{32,}/i.test(purpose)) {
      throw invalid('purpose must be a short plain-text evidence purpose, not a URL, path or credential');
    }
    const result = await sampleSupplierPlan({
      project: ctx.scope.project, env: ctx.env, taskId: ctx.scope.taskId, alias, purpose,
      readSealed: name => this.deps.projects.readSealed(ctx.scope.project, ctx.env, name, this.deps.secretKey()),
      fetch: this.deps.fetch, now: this.now,
      evidenceDir: join(this.serviceHome(), 'evidence', ctx.scope.taskId),
    });
    return {
      value: result,
      audit: {
        action: 'ops_supplier_sample',
        evidence: `ops_supplier_plan_sample ${alias}（${purpose}）→ ${result.status} accountRef=${result.accountRef ?? 'none'} doc=${result.documentSha256 ? result.documentSha256.slice(0, 16) : 'none'} gaps=${result.gaps.length}`,
      },
    };
  }

  /**
   * `ops_product_magpie_candidate {env?, budget?}`: runs the same read-only observation, then writes a
   * remote-magpie-evidence/1 candidate to the task evidence directory. Unstated remote facts stay null
   * with gaps. The budget envelope is only recorded when the caller supplies it; without it the window
   * stays closed. Nothing is authorized or executed by this tool.
   */
  /** Keeps the broker's own record of a generated observation. Bounded: the oldest record is evicted first. */
  private rememberRemoteObservation(digest:string,record:TrustedRecord):void{
    this.remoteObservations.delete(digest);
    this.remoteObservations.set(digest,record);
    while(this.remoteObservations.size>REMOTE_OBSERVATION_LIMIT){
      const oldest=this.remoteObservations.keys().next().value;
      if(oldest===undefined)break;
      this.remoteObservations.delete(oldest);
    }
  }

  private async productMagpieCandidate(ctx:Ctx,args:Args):Promise<Outcome>{
    if(ctx.scope.project!=='surreal_ck'||ctx.env!=='production')throw new CompanyError('forbidden','此入口只观测 surreal_ck 现役产品的 remote-magpie 连接');
    const extra=Object.keys(args).filter(key=>key!=='env'&&key!=='budget');
    if(extra.length)throw invalid(`ops_product_magpie_candidate 只接受 budget，不接受地址、账号、模型或凭证覆盖（rejected: ${extra.join(', ')}）`);
    const budget=args.budget===undefined?null:samplingBudgetSchema.safeParse(args.budget);
    if(budget&&!budget.success)throw invalid('budget 必须是 {currency:"USD",totalNanoUsd,perAttemptNanoUsd,maxAttempts}，不接受其他字段');
    const observation=await observeProductMagpie({readProvider:this.deps.magpie?.readProductProvider,fetch:this.deps.fetch,now:this.now});
    // The window check rebuilds the candidate from this broker-held copy, never from the candidate file.
    const author=ctx.scope.actor.employeeId;
    this.rememberRemoteObservation(observation.observationSnapshot.digest,{observation,author});
    const candidate=buildRemoteMagpieCandidate({observation,author,budget:budget?budget.data:null});
    const evidenceDir=join(this.serviceHome(),'evidence',ctx.scope.taskId);
    mkdirSync(evidenceDir,{recursive:true,mode:0o700});
    const file=join(evidenceDir,`remote-magpie-candidate-${this.now()}.json`);
    writeFileSync(file,JSON.stringify(candidate,null,2)+'\n',{mode:0o600});
    return {value:{candidateFile:file,candidate},audit:{action:'ops_call',evidence:`ops_product_magpie_candidate ${candidate.configurationDigest.slice(0,16)} routePresent=${candidate.route.present} gaps=${candidate.gaps.length} budget=${budget?'provided':'absent'}`}};
  }

  /**
   * `ops_platform_operator_list {session}`: read-only listing of the platform operators behind the product's
   * operator channel (GET /api/ops/platform-operators, format_version 1). It needs an operator session carrying
   * the product's read capability, and the response is validated strictly so only subject hashes — never raw
   * subjects or emails — reach the employee. It writes nothing, calls no model and grants nothing.
   */
  private async platformOperatorList(ctx: Ctx, args: Args): Promise<Outcome> {
    if (ctx.scope.project !== 'surreal_ck' || ctx.env !== 'production') throw new CompanyError('forbidden', '平台运营主体清单只对 surreal_ck 生产环境开放');
    if (!['gm', 'engineering', 'product', 'qa'].includes(ctx.scope.actor.role)) throw new CompanyError('forbidden', `role ${ctx.scope.actor.role} may not list platform operators`);
    const extra = Object.keys(args).filter(key => key !== 'session' && key !== 'env');
    if (extra.length) throw invalid(`ops_platform_operator_list 只接受 session（rejected: ${extra.join(', ')}）`);
    const session = this.session(ctx, args);
    if (session.kind !== 'operator') throw invalid('平台运营主体清单需要运营会话；请先用 ops_operator_login');
    const res = await this.product(ctx, session, 'GET', '/api/ops/platform-operators');
    if (!res.ok) throw new CompanyError('upstream_error', `产品运营主体清单返回 HTTP ${res.status}；不据此推断主体状态`, true);
    const view = parsePlatformOperatorsView(res.body);
    return {
      value: view,
      audit: { action: 'ops_call', evidence: `ops_platform_operator_list → ${res.status} operators=${view.operators.length} current=${view.operators.filter(o => o.isCurrent).length}` },
    };
  }

  /**
   * `ops_product_magpie_price_approve {candidatePath, approvalTask?}`: an independent employee records a
   * price review for one remote-magpie candidate. The caller approves; the author cannot. The marker goes
   * into the caller's own task evidence root with the candidate digest, the catalog price revision and the
   * candidate expiry, and it is read back only from the approval task root by the window. Nothing is
   * executed, bound or released by this tool.
   */
  private async productMagpiePriceApprove(ctx:Ctx,args:Args):Promise<Outcome>{
    if(ctx.scope.project!=='surreal_ck'||ctx.env!=='production')throw new CompanyError('forbidden','此入口只记录 surreal_ck 现役产品的 remote-magpie 价目审核');
    const allowed=new Set(['env','candidatePath','approvalTask']);
    const extra=Object.keys(args).filter(key=>!allowed.has(key));
    if(extra.length)throw invalid(`ops_product_magpie_price_approve 只接受 candidatePath 与 approvalTask（rejected: ${extra.join(', ')})`);
    const approvalTask=args.approvalTask===undefined?ctx.scope.taskId:text(args,'approvalTask',128);
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(approvalTask))throw invalid('approvalTask must be a task id');
    if(approvalTask!==ctx.scope.taskId)throw new CompanyError('forbidden','approval marker must be written into the approver\'s own task evidence root');
    const raw=await readProofFile(this.serviceHome(),approvalTask,text(args,'candidatePath',1024));
    const parsed=remoteMagpieEvidenceSchema.safeParse(JSON.parse(raw.toString('utf8')));
    if(!parsed.success)throw new CompanyError('invalid','remote-magpie candidate is malformed or was edited after it was generated');
    const marker=priceApprovalFor({candidate:parsed.data,approverEmployee:ctx.scope.actor.employeeId,approvalTask,now:this.now()});
    const evidenceDir=join(this.serviceHome(),'evidence',approvalTask);
    mkdirSync(evidenceDir,{recursive:true,mode:0o700});
    const file=join(evidenceDir,priceApprovalFileName(marker));
    writeFileSync(file,JSON.stringify(marker,null,2)+'\n',{mode:0o600});
    this.remotePriceApprovalRecords.push({approverEmployee:marker.approverEmployee,configurationDigest:marker.configurationDigest,priceRevision:marker.priceRevision,approvedAt:marker.approvedAt,approvalTask,expiresAt:marker.expiresAt});
    return {value:{markerFile:file,marker},audit:{action:'ops_call',evidence:`ops_product_magpie_price_approve ${marker.configurationDigest.slice(0,16)} priceRevision=${marker.priceRevision} approver=${ctx.scope.actor.employeeId}`}};
  }

  /**
   * `ops_product_magpie_observe {env?}`: read-only observation of the configured remote-magpie
   * connection. It fetches models, quotas and bounded usage, never calls a model, and accepts no
   * address, model, account or credential override.
   */
  private async productMagpieObserve(ctx:Ctx,args:Args):Promise<Outcome>{
    if(ctx.scope.project!=='surreal_ck'||ctx.env!=='production')throw new CompanyError('forbidden','此入口只观测 surreal_ck 现役产品的 remote-magpie 连接');
    if(Object.keys(args).some(key=>key!=='env'))throw invalid('ops_product_magpie_observe 只接受 env，不接受地址、账号、模型或凭证覆盖');
    const value=await observeProductMagpie({readProvider:this.deps.magpie?.readProductProvider,fetch:this.deps.fetch,now:this.now});
    return {value,audit:{action:'ops_call',evidence:`ops_product_magpie_observe source=configured-remote-magpie model=${PRODUCT_MAGPIE_MODEL} routePresent=${value.route.present} rows=${value.coverage.matchingRows} executable=false`}};
  }

  /**
   * `ops_magpie_route_sample {env?, alias, purpose}`: the controlled, read-only Magpie route
   * snapshot. It reads only the loopback gateway's public surfaces plus providers.json, binds the
   * sealed supplier identity to the serving gateway account, and writes a v4 evidence document and
   * receipt. It never calls a model, never reads a credential value out of this process, never
   * writes to Magpie, and answers `blocked` with structured gaps for every missing fact.
   */
  private async magpieRouteSample(ctx: Ctx, args: Args): Promise<Outcome> {
    assertLocalMagpieScope(ctx.scope.project,ctx.env);
    const allowed = new Set(['env', 'alias', 'purpose']);
    const extra = Object.keys(args).filter(key => !allowed.has(key));
    if (extra.length) throw invalid(`ops_magpie_route_sample accepts only alias and purpose (rejected: ${extra.join(', ')})`);
    const alias = canonicalAlias(args.alias);
    const purpose = text(args, 'purpose', 200);
    if (/[:\\/@]|\b(?:bearer|token|cookie|secret|password|api[-_ ]?key)\b|[A-Za-z0-9_-]{32,}/i.test(purpose)) {
      throw invalid('purpose must be a short plain-text evidence purpose, not a URL, path or credential');
    }
    const result = await sampleMagpieRoute({
      project: ctx.scope.project, env: ctx.env, taskId: ctx.scope.taskId, alias, purpose,
      readSealed: name => this.deps.projects.readSealed(ctx.scope.project, ctx.env, name, this.deps.secretKey()),
      fetch: this.deps.fetch, now: this.now,
      evidenceDir: join(this.serviceHome(), 'evidence', ctx.scope.taskId),
      ...(this.deps.magpie?.base ? { base: this.deps.magpie.base, endpointSource: this.deps.magpie.endpointSource ?? 'injected' } : {}),
      ...(this.deps.magpie?.readProviders ? { readProviders: this.deps.magpie.readProviders } : {}),
    });
    return {
      value: result,
      audit: {
        action: 'ops_magpie_sample',
        evidence: `ops_magpie_route_sample ${alias}（${purpose}）→ ${result.status} accountRef=${result.accountRef ?? 'none'} route=${result.receipt.route.digest?.slice(0, 12) ?? 'none'} doc=${result.documentSha256 ? result.documentSha256.slice(0, 16) : 'none'} gaps=${result.gaps.length}`,
      },
    };
  }

  /**
   * `ops_magpie_route_restore {mode: plan|apply, alias: MAGPIE, purpose, …}`: the controlled
   * read-only inspection for the two 2026-10-28 FV06 gaps — a missing `group/work` and an unsealed
   * supplier username. Only `plan` is published: it answers safe ids, hashes and a bounded plan
   * digest, and marks `writeAvailable:false` with `gatewayReload:"unknown"`. `apply` is refused for
   * every role before any config, seal or journal access (the write channel, real group schema and
   * gateway reload semantics are unproven). Nothing here restarts the gateway, returns a username or
   * secret, or falls back to a local model call.
   */
  private async magpieRouteRestore(ctx: Ctx, args: Args): Promise<Outcome> {
    assertLocalMagpieScope(ctx.scope.project,ctx.env);
    const mode = text(args, 'mode', 10);
    const planOnly = new Set(['mode', 'env', 'alias', 'purpose']);
    // The apply parameters stay allowlisted so a malformed apply request is still answered with a
    // precise invalid error, even though apply itself is refused below.
    const applyKeys = ['mode', 'env', 'alias', 'purpose', 'planDigest', 'planIssuedAt', 'expectedConfigSha256', 'accountHash', 'members', 'idempotencyKey'];
    const allowed = new Set(mode === 'apply' ? applyKeys : planOnly);
    if (mode !== 'plan' && mode !== 'apply') throw invalid('mode must be plan or apply');
    const extra = Object.keys(args).filter(key => !allowed.has(key));
    if (extra.length) throw invalid(`ops_magpie_route_restore ${mode} accepts only ${[...allowed].filter(key => key !== 'mode').join(', ')} (rejected: ${extra.join(', ')})`);
    const alias = canonicalAlias(args.alias);
    if (alias !== MAGPIE_RESTORE_ALIAS) throw invalid(`the controlled Magpie restore only serves alias ${MAGPIE_RESTORE_ALIAS}`);
    const purpose = text(args, 'purpose', 200);
    if (/[:\\/@]|\b(?:bearer|token|cookie|secret|password|api[-_ ]?key)\b|[A-Za-z0-9_-]{32,}/i.test(purpose)) {
      throw invalid('purpose must be a short plain-text evidence purpose, not a URL, path or credential');
    }
    if (mode === 'apply') {
      // Refused before any config read, seal or journal access, for qa, engineering, product and gm
      // alike. The underlying entry refuses the same way, so a direct import cannot bypass this.
      throw new CompanyError('not_configured',
        'the Magpie route restore write capability is unavailable in this release: ops_magpie_route_restore publishes the read-only plan only (writeAvailable=false, gatewayReload=unknown) and the account/route recovery is not complete',
        false, { capability: 'magpie_route_restore_apply', writeAvailable: false, gatewayReload: 'unknown' });
    }
    const io = {
      project: ctx.scope.project, env: ctx.env, taskId: ctx.scope.taskId, purpose,
      readSealed: (name: string) => this.deps.projects.readSealed(ctx.scope.project, ctx.env, name, this.deps.secretKey()),
      fetch: this.deps.fetch, now: this.now,
      evidenceDir: join(this.serviceHome(), 'evidence', ctx.scope.taskId),
      journalPath: this.deps.magpie?.journalPath ?? join(this.serviceHome(), 'magpie-restore', 'journal.json'),
      ...(this.deps.magpie?.base ? { base: this.deps.magpie.base, endpointSource: this.deps.magpie.endpointSource ?? 'injected' } : {}),
      ...(this.deps.magpie?.readProviders ? { readProviders: this.deps.magpie.readProviders } : {}),
      ...(this.deps.magpie?.configPath ? { configPath: this.deps.magpie.configPath } : {}),
    };
    const result = await planMagpieRouteRestore(io);
    return {
      value: result,
      audit: {
        action: 'ops_magpie_restore',
        evidence: `ops_magpie_route_restore plan（${purpose}）→ group=${result.config.groupPresent ? 'present' : 'missing'} binding=${result.binding.status} accounts=${result.accounts.length} plan=${result.planDigest.slice(0, 12)} config=${result.config.sha256.slice(0, 12)} writeAvailable=false`,
      },
    };
  }

  /**
   * `ops_magpie_window_prepare {env?, manifestPath, documentPath, approvalTask}`: the missing
   * window-adapter capability, proxied in this chain. It only reads the immutable v2 manifest and
   * v4 document, re-checks eligibility, and returns the exact executionWindow a manager could bind
   * — or the specific blocked fields. It binds nothing itself and never resumes or retries.
   */
  private async magpieWindowPrepare(ctx: Ctx, args: Args): Promise<Outcome> {
    const allowed = new Set(['env', 'manifestPath', 'documentPath', 'approvalTask', 'candidatePath']);
    const extra = Object.keys(args).filter(key => !allowed.has(key));
    if (extra.length) throw invalid(`ops_magpie_window_prepare accepts only manifestPath, documentPath, candidatePath and approvalTask (rejected: ${extra.join(', ')})`);
    const approvalTask = text(args, 'approvalTask', 128);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(approvalTask)) throw invalid('approvalTask must be a task id');
    // The evidence root follows the approval task, exactly like ops_internal_ai_prove/deliver, so a
    // manager can prepare a window for another task's approval; the caller's own task is only the
    // root when no approval task is named.
    const proofRoot = approvalTask || ctx.scope.taskId;
    if (args.candidatePath !== undefined) {
      if (args.manifestPath !== undefined || args.documentPath !== undefined) throw invalid('candidatePath 与 manifestPath/documentPath 只能二选一');
      const raw = await readProofFile(this.serviceHome(), proofRoot, text(args, 'candidatePath', 1024));
      const parsed = remoteMagpieEvidenceSchema.safeParse(JSON.parse(raw.toString('utf8')));
      if (!parsed.success) throw new CompanyError('invalid', 'remote-magpie candidate is malformed or was edited after it was generated');
      const approvals = this.deps.magpie?.remotePriceApprovals?.() ?? this.remotePriceApprovalRecords.filter(a => a.approvalTask === approvalTask);
      const result = remoteMagpieWindow(parsed.data, {approvalTask, now: this.now(), approvals, trusted: this.remoteObservations.get(parsed.data.observation.digest)});
      const candidateHash = sha256(raw);
      // Only an eligible candidate becomes the approval candidate the manager can bind. The row mirrors what
      // the broker itself verified (digest, expiry, trusted author); this tool never decides the resume.
      let registration: { status: 'registered' | 'unchanged' | 'replaced'; digest: string; replacedDigest?: string } | undefined;
      if (result.eligible && this.deps.proofStore) {
        // The registration lease allows the phase-1 and phase-2 goals; the internal AI proof chain still uses lease().
        const lease = await this.deps.proofStore.remoteLease(ctx.scope);
        const stored = await this.deps.proofStore.registerRemoteCandidate(lease, {
          taskId: approvalTask, digest: parsed.data.configurationDigest, evidenceExpiresAt: parsed.data.expiry.expiresAt,
          author: parsed.data.author, env: ctx.env, sourcePath: resolve(text(args, 'candidatePath', 1024)), candidateHash,
        });
        registration = { status: stored.replacedDigest ? 'replaced' : stored.created ? 'registered' : 'unchanged', digest: parsed.data.configurationDigest, ...(stored.replacedDigest ? { replacedDigest: stored.replacedDigest } : {}) };
      }
      const registeredNote = registration ? ` candidate=${registration.status}:${registration.digest.slice(0, 16)}${registration.replacedDigest ? ` replaced=${registration.replacedDigest.slice(0, 16)}` : ''}` : '';
      return {
        value: { ...result, candidateHash, evidenceExpiresAt: parsed.data.expiry.expiresAt, ...(registration ? { candidateRegistration: registration } : {}) },
        audit: {
          action: 'ops_magpie_window',
          evidence: `ops_magpie_window_prepare(remote) → ${result.eligible ? 'window-ready' : `blocked(${result.blockedReasons.join(',')})`}${registeredNote}`,
        },
      };
    }
    const files = await loadProofFiles(this.serviceHome(), proofRoot, text(args, 'manifestPath', 1024), text(args, 'documentPath', 1024));
    if (files.manifest.schemaVersion !== 2) throw new CompanyError('invalid', 'the execution-window proxy only accepts a v2 Magpie manifest');
    const result = magpieWindowFromEvidence(files, approvalTask, this.now());
    return {
      value: { ...result, manifestHash: files.manifestHash, documentHash: files.documentHash },
      audit: {
        action: 'ops_magpie_window',
        evidence: `ops_magpie_window_prepare → ${result.eligible ? 'window-ready' : `blocked(${result.blockedReasons.join(',')})`} headroom=${result.headroomSeconds}s`,
      },
    };
  }

  // ---------- generic, session-bound ----------
  private async request(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.session(ctx, args);
    const method = text(args, 'method', 10).toUpperCase();
    const path = text(args, 'path', 2000);
    // Sessions stay in their lane: an operator or ops token only serves the ops surface
    // (/api/ops/* plus /api/content/*, which the product gates on requirePlatformOperator), and a
    // customer token is never sent to ops endpoints at all (the product would answer 401 for the
    // wrong audience; /api/content/* needs no proxy-side block since the same gate covers it).
    const opsPath = /^\/api\/ops(\/|$|\?)/.test(path);
    const contentPath = /^\/api\/content(\/|$|\?)/.test(path);
    if (session.kind !== 'customer' && !opsPath && !contentPath) throw invalid(`an ${session.kind} session can only call /api/ops/* or /api/content/* paths`);
    if (session.kind === 'customer' && opsPath) throw invalid('a customer session cannot call /api/ops/*; call ops_operator_login, or ops_login with audience "ops", for an ops session');
    const res = await this.product(ctx, session, method, path, args.body);
    const known = this.sessions.secrets(ctx.scope.actor.employeeId);
    return {
      value: { status: res.status, ok: res.ok, body: clipJson(redactJson(res.body, known)) },
      audit: { action: 'ops_call', evidence: `${method} ${path.split('?')[0]} → ${res.status}（${session.kind !== 'customer' ? '运营 ' : ''}${session.username}）` },
    };
  }

  private async runQuery(ctx: Ctx, session: OpsSession, database: string, sql: string, vars?: Record<string, unknown>): Promise<unknown[]> {
    if (!ctx.cfg.data) throw new CompanyError('not_configured', 'this environment has no workspace data endpoint configured');
    if (this.now() >= session.expiresAt - REFRESH_MARGIN_MS) {
      if (ctx.recovery) throw new CompanyError('login_failed', 'Recovery read session expired; no re-login is allowed under the grant');
      await this.reauth(ctx, session);
    }
    return (this.deps.queryAsUser ?? surrealQueryAsUser)({ ...ctx.cfg.data, database, token: session.token, sql, vars });
  }

  private async query(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.customerSession(ctx, args);
    const sql = text(args, 'sql', 20_000);
    if (args.vars !== undefined && (typeof args.vars !== 'object' || args.vars === null || Array.isArray(args.vars))) throw invalid('vars must be an object');
    const workspace = args.slug !== undefined ? await this.useWorkspace(ctx, session, slugOf(args)) : session.workspace;
    if (!workspace) throw invalid('no workspace selected: pass slug, or call ops_workspace_ensure / ops_login with workspace first');
    const results = await this.runQuery(ctx, session, workspace.dbName, sql, args.vars as Record<string, unknown> | undefined);
    const known = this.sessions.secrets(ctx.scope.actor.employeeId);
    return {
      value: { slug: workspace.slug, results: clipJson(redactJson(jsonSafe(results), known)) },
      audit: { action: 'ops_call', evidence: `ops_query ${workspace.slug}（${session.username}）：${sql.replace(/\s+/g, ' ').slice(0, 160)}` },
    };
  }

  /**
   * Injects the session's token into the employee's ego-browser page. Customer sessions keep the
   * app's flat sessionStorage keys and land on `/`; operator sessions land on `/ops/` and are
   * written as the serialized `oidc-client-ts` `User` record the ops console's `UserManager`
   * reads. An `ops` audience session is API-only and is refused before anything else.
   */
  private async browserLogin(ctx: Ctx, args: Args): Promise<Outcome> {
    const session = this.session(ctx, args);
    if (session.kind === 'ops') {
      throw invalid('an ops session is API-only and cannot be injected into a browser; use a customer or operator session');
    }
    const spaceId = Number(args.spaceId);
    if (!Number.isInteger(spaceId) || spaceId < 0) throw invalid('spaceId must be the numeric id of your ego-browser task space');
    const page = args.page === undefined ? 'p1' : text(args, 'page', 8);
    if (!/^p\d{1,3}$/.test(page)) throw invalid('page must be a page label such as p1');
    // An expiring session re-logs through its own channel: the operator keeps riding the ops
    // client, never the customer login.
    if (this.now() >= session.expiresAt - REFRESH_MARGIN_MS) await this.reauth(ctx, session);
    const product = new URL(ctx.cfg.product.url);
    const health = ctx.row.healthUrl ? new URL(ctx.row.healthUrl) : undefined;
    const probeUrl = health && health.origin === product.origin ? health.toString() : `${product.origin}/health`;

    let landingUrl = `${product.origin}/`;
    let oidcUser: { key: string; value: string } | undefined;
    if (session.kind === 'operator') {
      const ops = ctx.cfg.ops;
      if (!ops) throw new CompanyError('not_configured', 'this environment no longer has an operator channel configured');
      // Re-probe the operator gate right before the token leaves the broker: a revoked or
      // demoted operator fails here instead of inside the injected page.
      const probe = await this.product(ctx, session, 'GET', '/api/ops/quota/context');
      if (!probe.ok) {
        this.sessions.drop(session.id);
        throw productFailure('operator access check', probe, { 401: 'login_failed', 403: 'forbidden' });
      }
      landingUrl = `${product.origin}/ops/`;
      oidcUser = oidcUserEntry({
        authority: ctx.cfg.idp.issuer, clientId: ops.clientId,
        token: session.token, expiresAt: session.expiresAt, scope: ops.scope,
        profile: {
          sub: jwtSubject(session.token) ?? session.username,
          email: accountEmail(session.username, ctx.cfg.accounts.emailDomain),
        },
      });
    }

    const inject = this.deps.browser ?? egoBrowserInjector;
    const injection = {
      bin: ctx.cfg.browser?.bin, spaceId, page, probeUrl, landingUrl,
      token: session.token, expiresAt: session.expiresAt, oidcUser,
    };
    // SYS04: only a genuinely transient failure is retried, and only once. A deterministic
    // refusal (a missing space, a bad page, a revoked operator) is reported on the first attempt.
    let landed: { url: string; title: string } | undefined;
    for (let attempt = 1; attempt <= BROWSER_INJECT_ATTEMPTS; attempt++) {
      try {
        landed = await inject(injection);
        break;
      } catch (error) {
        const transient = error instanceof CompanyError && error.retryable
          && (error.code === 'upstream_error' || error.code === 'login_failed');
        if (!transient || attempt === BROWSER_INJECT_ATTEMPTS) throw error;
        await this.sleep(BROWSER_RETRY_BACKOFF_MS);
      }
    }
    if (!landed) throw new CompanyError('upstream_error', 'browser login produced no result', true);
    // SYS05: remember the space so the lease-end cleanup can bound it. The space id is not a secret.
    const employee = ctx.scope.actor.employeeId;
    const spaces = this.browserSpaces.get(employee) ?? new Set<number>();
    if (spaces.size < 16) spaces.add(spaceId);
    this.browserSpaces.set(employee, spaces);
    return {
      value: { signedInAs: session.username, url: landed.url, title: landed.title },
      audit: { action: 'ops_browser_login', evidence: `ego-browser 任务空间 ${spaceId}/${page} 以 ${session.username} 登录${session.kind === 'operator' ? '（运营控制台 /ops/）' : ''}` },
    };
  }
}

function clipJson(value: unknown): unknown {
  const raw = JSON.stringify(value);
  return raw !== undefined && raw.length > MAX_RESULT_CHARS ? { truncated: true, preview: clip(raw, MAX_RESULT_CHARS) } : value;
}
