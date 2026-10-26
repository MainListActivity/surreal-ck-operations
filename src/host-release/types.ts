/**
 * FV06/SYS04 managed host release seam: fixed prepare / status / apply / receipt contract.
 *
 * The employee channel may prepare and read status/receipt. Apply runs only in a trusted host
 * context outside the employee sandbox (it needs releases/, private/, paseo, launchctl). A receipt
 * is written by that host; an employee-uploaded JSON is never accepted as a pass fact.
 */

/** Fixed operation names. Callers may not invent others. */
export type HostReleaseOp = 'prepare' | 'status' | 'apply' | 'receipt';

/** Lifecycle of one release operation. */
export type HostReleaseState =
  | 'prepared'
  | 'applying'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'
  | 'refused';

/** Fixed roots the seam may touch. Arbitrary paths are refused. */
export interface HostReleaseRoots {
  /** Absolute service home (SurrealCKCompany). */
  serviceHome: string;
  /** Absolute ops checkout used for content binding and ancestry. */
  opsRepo: string;
  /** Absolute releases directory under serviceHome. */
  releasesDir: string;
}

/** Input shared by prepare / apply. Every field is required; free-form commands are refused. */
export interface HostReleaseRequest {
  /** Company task that owns this release. */
  taskId: string;
  /** Full 40-char main commit SHA to publish. */
  targetSha: string;
  /** Absolute path of the active symlink before apply; CAS target. */
  expectedActive: string;
  /** Manifest hash of the prepared snapshot (tracked-file inventory). */
  snapshotHash: string;
  /** Full 40-char SHA of the rollback candidate (must pass the same guards before use). */
  rollbackSha: string;
  /** Idempotency key for prepare / apply. */
  idempotencyKey: string;
}

/** Persisted operation row (also the on-disk envelope under maintenance/). */
export interface HostReleaseOperation {
  opId: string;
  taskId: string;
  targetSha: string;
  expectedActive: string;
  snapshotHash: string;
  rollbackSha: string;
  idempotencyKey: string;
  state: HostReleaseState;
  createdAt: string;
  updatedAt: string;
  /** Absolute path of the prepared snapshot (under maintenance/ or releases/). */
  snapshotPath?: string;
  /** Absolute path of the installed release directory, when apply succeeded. */
  releasePath?: string;
  /** Refusal or failure reason; secret-free. */
  reason?: string;
  /** Absolute path of the host-written receipt, when one exists. */
  receiptPath?: string;
}

/** One guard / gate check result. */
export interface HostReleaseCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Prepare result returned to the caller. */
export interface HostReleasePrepareResult {
  opId: string;
  state: HostReleaseState;
  targetSha: string;
  expectedActive: string;
  snapshotHash: string;
  rollbackSha: string;
  snapshotPath: string;
  checks: HostReleaseCheck[];
  /** Absolute path of the prepared envelope (status/receipt land beside it). */
  envelopePath: string;
}

/** Status view. */
export interface HostReleaseStatusResult {
  opId: string;
  state: HostReleaseState;
  targetSha: string;
  expectedActive: string;
  snapshotHash: string;
  rollbackSha: string;
  updatedAt: string;
  reason?: string;
  receiptPath?: string;
  activeNow?: string;
}

/** Dual-face receipt written by the trusted host after apply (or refused apply). */
export interface HostReleaseReceipt {
  /** Schema version of this receipt shape. */
  schema: 'host-release-receipt/1';
  opId: string;
  taskId: string;
  targetSha: string;
  previousActive: string;
  expectedActive: string;
  snapshotHash: string;
  rollbackSha: string;
  /** Host identity that ran apply (hostname + uid), never a credential. */
  executor: { host: string; uid: number; user: string };
  /**
   * Host provenance (F4 / AC04). HMAC-SHA256 over the canonical receipt fields, keyed by the
   * host-only secret at `$SCK_SERVICE_HOME/private/host-release.hmac` (mode 0600, outside the
   * employee sandbox). An employee-written JSON that merely copies operation fields and invents
   * an executor cannot produce a valid tag. Absent/invalid tag ⇒ reader refuses.
   */
  hostTag: string;
  startedAt: string;
  finishedAt: string;
  /** apply.sh's own exit status: 0 only when state=succeeded, 1 otherwise. */
  exitCode: number;
  /**
   * Exit status of the installer (company-service.sh install) alone. A plugin-repoint
   * warning leaves this 0 while apply still fails and rolls back, so `exitCode` and
   * `installerExitCode` must be read together, never as synonyms.
   */
  installerExitCode: number;
  state: HostReleaseState;
  checks: HostReleaseCheck[];
  /** Content / vendor / schema binding digests. */
  binding: {
    releasePath: string | null;
    contentMatchesCommit: boolean;
    vendorSchemaDiff: 'none' | 'differ' | 'unavailable';
    /** Inventory digest of the release's own schema directory (null when absent). */
    schemaHash: string | null;
    /** Inventory digest of the schema copy the plugin actually ships under plugin/server/vendor. */
    vendorSchemaHash: string | null;
    vendorSchemaDetail?: string;
  };
  /** MCP face: the process actually listening on the service port, and the code it runs. */
  mcp: {
    health: number | null;
    ready: number | null;
    cwd: string | null;
    pid: number | null;
    /** Inventory digest of `cwd` when it is a release dir; null otherwise. */
    sha: string | null;
  };
  /** Plugin face: SOURCE/DIRECTORY from paseo, or explicit unknown. */
  plugin: {
    status: string | null;
    enabled: boolean | null;
    source: string | null;
    directory: string | null;
    sourceKnown: boolean;
    /**
     * AC04: sha256 of the files the plugin loads from the bound SOURCE (manifest + sources,
     * node_modules excluded). Signed, so a tampered list fails verification. null when SOURCE
     * is unknown — the receipt then says so rather than inventing a binding.
     */
    modules: Array<{ path: string; sha256: string; bytes: number }> | null;
  };
  /** Live channel recovery note after plugin repoint. */
  channelRecovery: 'adopt-expected' | 'unchanged' | 'unknown';
  /** Rollback outcome when apply failed mid-way. */
  rollback?: { attempted: boolean; to: string | null; ok: boolean; detail?: string };
  /** Maintenance lock released? */
  lockReleased: boolean;
  reason?: string;
}

/** Absolute path under the service home for one operation's envelope. */
export const hostReleaseEnvelopeDir = (serviceHome: string, opId: string): string =>
  `${serviceHome}/maintenance/host-release/${opId}`;

/** Fixed filename of the host-written receipt. */
export const HOST_RELEASE_RECEIPT_FILE = 'receipt.json';
/** Fixed filename of the operation envelope. */
export const HOST_RELEASE_OPERATION_FILE = 'operation.json';
/** Fixed filename of the prepare result. */
export const HOST_RELEASE_PREPARE_FILE = 'prepare.json';
/** Global mutual-exclusion lock file (under maintenance/). */
export const HOST_RELEASE_LOCK_FILE = 'host-release.lock';

/** Validate a full 40-char lowercase hex SHA. */
export const isCommitSha = (value: string): boolean => /^[0-9a-f]{40}$/.test(value);

/** Validate an absolute path that does not contain `..` segments. */
export const isSafeAbsolutePath = (value: string): boolean => {
  if (!value.startsWith('/') || value.includes('\0')) return false;
  const parts = value.split('/');
  return !parts.includes('..');
};
