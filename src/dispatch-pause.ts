// Global dispatch pause (ops maintenance). One transaction moves company_meta:config.paused, its pause_epoch, the shared
// company_meta:dispatch_gate record and the audit row together. claimLease (core.ts) reads the config inside its own
// transaction and writes the gate on every new lease, so a claim that read the config before a pause committed conflicts
// with that pause and retries into the paused branch. Dispatch passes keep one dispatch_pass row each, so a pause can wait
// until every pass that started under an older epoch has ended (drain). Nothing here opens the window: restore is the only
// way back to dispatching.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import process from 'node:process';
import { RecordId, type Surreal } from 'surrealdb';

/** Compare-and-set failure: the caller's epoch is no longer the current one. */
export const PAUSE_EPOCH_MOVED = 'dispatch pause epoch moved';
/** Thrown inside claimLease while the pause holds; core maps it to CompanyError code dispatch_paused. */
export const PAUSE_BLOCKS_LEASE = 'dispatch paused: no new lease while the manager pause holds';
/** Bounded drain wait for a pause. A design default, not a measured production bound. */
export const DRAIN_DEFAULT_SECONDS = 120;
export const DRAIN_MIN_SECONDS = 10;
export const DRAIN_MAX_SECONDS = 900;

const COMMIT_ATTEMPTS = 5;

/** One transaction: state, epoch, gate, audit and (for manager calls) the idempotency record. The RETURN row is the second-to-last response. */
export const PAUSE_TXN = `BEGIN;
  LET $cfg = SELECT paused, pause_epoch FROM ONLY company_meta:config;
  LET $prev_paused = $cfg.paused ?? false;
  LET $prev_epoch = $cfg.pause_epoch ?? 0;
  IF $expected != NULL AND $expected != $prev_epoch { THROW '${PAUSE_EPOCH_MOVED}' };
  LET $epoch = IF $prev_paused = $paused THEN $prev_epoch ELSE $prev_epoch + 1 END;
  LET $seq = UPDATE ONLY company_meta:outbox_counter SET value += 1 RETURN AFTER;
  UPSERT company_meta:config MERGE { paused: $paused, pause_epoch: $epoch };
  UPSERT company_meta:dispatch_gate CONTENT { paused: $paused, epoch: $epoch, sequence: $seq.value, changed_at: time::now() };
  CREATE ONLY $audit CONTENT { actor: $actor, actor_role: $actor_role, action: $action, evidence: $evidence, at: time::now(),
    sequence: $seq.value, paused: $paused, previous_paused: $prev_paused, epoch: $epoch, previous_epoch: $prev_epoch };
  LET $result = { operation: $action, operationId: type::string($audit), paused: $paused, epoch: $epoch,
    before: { paused: $prev_paused, epoch: $prev_epoch }, sequence: $seq.value };
  IF $idem != NULL { CREATE ONLY $idem CONTENT { payload_digest: $digest, result: $result } };
  RETURN $result;
COMMIT;`;

export interface PauseWrite {
  paused: boolean;
  /** Real actor for the audit row: the employee record for manager calls, the string 'owner' for the Paseo RPC and owner_command paths. */
  actor: RecordId | string;
  actorRole: string;
  /** Compare-and-set: null skips the check (owner paths only). */
  expectedEpoch: number | null;
  /** Audit evidence (secret-free JSON, already bounded by the caller). */
  evidence: string;
  /** Idempotency record created in the same transaction (manager calls). */
  idem?: RecordId;
  digest?: string;
}

export interface PauseResult {
  /** The maintenance operation's audit id as `type::string($audit)` renders it, e.g. audit:`<uuid>` (id part backticked);
   * dispatch_audit takes this exact string back. */
  operationId: string;
  operation: 'dispatch_pause' | 'dispatch_restore';
  paused: boolean;
  epoch: number;
  before: { paused: boolean; epoch: number };
  sequence: number;
}

interface StatementResponse { success: boolean; error?: { message?: string } }

/**
 * The failure a batch reports: the statement that failed, not the statements a cancelled transaction then refused to run
 * (their "not executed" messages come first in the list). Same selection as core's txTask.
 */
function causeOf(responses: StatementResponse[]): Error | undefined {
  const failures = responses.filter(response => !response.success).map(response => response.error?.message ?? 'unknown error');
  const cause = failures.find(message => !message.includes('not executed due to') && !message.startsWith('Cannot COMMIT')) ?? failures[0];
  return cause === undefined ? undefined : new Error(cause);
}

/** Writes the pause state, bumping the epoch only when the paused value changes. Retries write-write conflicts. */
export async function writePause(db: Surreal, write: PauseWrite): Promise<PauseResult> {
  const action = write.paused ? 'dispatch_pause' : 'dispatch_restore';
  const vars = { paused: write.paused, expected: write.expectedEpoch, actor: write.actor, actor_role: write.actorRole,
    evidence: write.evidence, action, audit: new RecordId('audit', randomUUID()), idem: write.idem ?? null, digest: write.digest ?? null };
  let lastError: unknown;
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    try {
      const responses = await db.query<unknown[]>(PAUSE_TXN, vars).responses();
      const cause = causeOf(responses);
      if (cause) throw cause;
      const row = responses.at(-2);
      const result = row && row.success ? row.result as PauseResult | undefined : undefined;
      if (!result || result.operation !== action) throw new Error('dispatch pause returned no result');
      return result;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(PAUSE_EPOCH_MOVED) || !/conflict/i.test(message)) throw error;
      await Bun.sleep(10 * (attempt + 1));
    }
  }
  throw lastError;
}

/** Runs one or more statements and throws on the first failed statement, so ledger and status reads never fail silently. */
async function run(db: Surreal, query: string, vars: Record<string, unknown>): Promise<unknown[]> {
  const responses = await db.query<unknown[]>(query, vars).responses();
  const cause = causeOf(responses);
  if (cause) throw cause;
  return responses.map(response => (response.success ? response.result : undefined));
}

export interface DrainStatus { drained: boolean; blocking: number | null; waitedMs: number }

/**
 * Running passes that may still claim or wake under an older epoch: state running, and started before the epoch
 * under drain (or not yet recorded an epoch, which counts as old).
 */
const OLD_RUNNING_PASSES = `SELECT VALUE count() FROM dispatch_pass WHERE state = 'running' AND (epoch = NONE OR epoch < $epoch) GROUP ALL;`;

/**
 * A process probe for the startup reaper: signal 0 never delivers, it only asks the kernel whether the pid exists.
 * ESRCH is the one answer that proves death; EPERM means a process is there under another owner, and anything else
 * is unknown. All non-ESRCH outcomes are returned as "not provably dead", so the row stays running (fail closed).
 */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export interface ReapSummary { scanned: number; reaped: number; keptUnknown: number; reapedIds: string[] }

/**
 * Startup reaper (runbook §7 ★1, SYS-DISP 876e36e2 H1). A killed process never runs the pass finally block, so its
 * dispatch_pass row stays running forever and every later dispatch_pause drains to false. Each dispatcher process runs
 * this once, before creating its own first pass: running rows of this host whose pid is provably dead become abandoned
 * — a new state value, chosen over a flag because every drain query already filters state='running' and abandoned rows
 * then fall out of drain and into the existing 1-day ledger prune, with no row deleted. Rows from other hosts, missing
 * or malformed instances, pids that still answer, and any failed read are left running: death must be provable, never
 * guessed. A pass that ends between the read and the write fails the row check and aborts that transaction instead of leaving a false audit.
 */
export async function reapStaleRunningPasses(db: Surreal, host = hostname(), alive: (pid: number) => boolean = processAlive,
  selfPid: number = process.pid): Promise<ReapSummary> {
  const summary: ReapSummary = { scanned: 0, reaped: 0, keptUnknown: 0, reapedIds: [] };
  let rows: Array<{ id: RecordId; instance?: string }>;
  try {
    const [found] = await run(db, "SELECT id, instance FROM dispatch_pass WHERE state = 'running';", {}) as [Array<{ id: RecordId; instance?: string }> | undefined];
    rows = found ?? [];
  } catch {
    // Ledger unreadable: keep every row running and let the dispatcher start anyway. Drain stays fail closed.
    return { ...summary, scanned: -1 };
  }
  for (const row of rows) {
    summary.scanned++;
    const parts = (row.instance ?? '').split(':');
    const pid = Number(parts[1]);
    if (parts[0] !== host || !Number.isSafeInteger(pid) || pid <= 0 || pid === selfPid || !parts[2] || parts.length !== 3) { summary.keptUnknown++; continue; }
    if (alive(pid)) { summary.keptUnknown++; continue; }
    try {
      // Same transaction updates the row and writes the audit (conventions as in PAUSE_TXN): the reaping is auditable.
      // RETURN AFTER gives nothing when the pass ended between the read and this write; the THROW aborts the whole
      // transaction, so no audit row can claim a pass that finished on its own terms.
      await run(db, `BEGIN;
        LET $u = (UPDATE ONLY $pass SET state = 'abandoned', finished_at = time::now() WHERE state = 'running' RETURN AFTER);
        IF $u = NONE { THROW 'stale reap: pass no longer running' };
        CREATE ONLY $audit CONTENT { actor: 'system:dispatcher', action: 'dispatch_pass_reaped', instance: $instance,
          evidence: $evidence, at: time::now() };
        COMMIT;`, { pass: row.id, audit: new RecordId('audit', randomUUID()), instance: row.instance,
          evidence: JSON.stringify({ source: 'dispatcher startup reap', host, pid, reason: 'running row of a process provably dead (ESRCH)' }) });
      summary.reaped++; summary.reapedIds.push(String(row.id));
    } catch {
      summary.keptUnknown++; // write failed: the row stays running, never a guess in the other direction
    }
  }
  return summary;
}

/** Number of passes that started under an epoch older than `epoch`, or have not recorded one yet, and are still running. */
export async function oldRunningPasses(db: Surreal, epoch: number): Promise<number> {
  const [count] = await run(db, OLD_RUNNING_PASSES, { epoch }) as [number[] | undefined];
  return count?.[0] ?? 0;
}

/** Polls the ledger until no pass started under an older epoch is running, or the deadline passes. Unknown or failed reads keep polling and fail closed. */
export async function waitForDrain(db: Surreal, epoch: number, timeoutMs: number, pollMs = 250): Promise<DrainStatus> {
  const started = Date.now();
  let blocking: number | null = null;
  for (;;) {
    try {
      blocking = await oldRunningPasses(db, epoch);
      if (blocking === 0) return { drained: true, blocking, waitedMs: Date.now() - started };
    } catch {
      blocking = null;
    }
    const waited = Date.now() - started;
    if (waited >= timeoutMs) return { drained: false, blocking, waitedMs: waited };
    await Bun.sleep(Math.min(pollMs, Math.max(1, timeoutMs - waited)));
  }
}

export interface PauseState { paused: boolean; epoch: number; changedAt?: string }

export async function readPauseState(db: Surreal): Promise<PauseState> {
  const [config, gate] = await run(db, `SELECT paused, pause_epoch FROM ONLY company_meta:config;
    SELECT changed_at FROM ONLY company_meta:dispatch_gate;`, {}) as [
    { paused?: boolean; pause_epoch?: number } | undefined, { changed_at?: unknown } | undefined];
  return { paused: config?.paused === true, epoch: typeof config?.pause_epoch === 'number' ? config.pause_epoch : 0,
    changedAt: gate?.changed_at === undefined ? undefined : String(gate.changed_at) };
}

export interface RunningPass { id: string; instance: string; epoch: number | null; startedAt?: string }

export async function runningPasses(db: Surreal, limit = 50): Promise<RunningPass[]> {
  const [rows] = await run(db, `SELECT id, instance, epoch, started_at FROM dispatch_pass WHERE state = 'running'
    ORDER BY started_at LIMIT $limit;`, { limit }) as [Array<{ id: RecordId; instance: string; epoch?: number | null; started_at?: unknown }> | undefined];
  return (rows ?? []).map(row => ({ id: String(row.id), instance: row.instance, epoch: typeof row.epoch === 'number' ? row.epoch : null,
    startedAt: row.started_at === undefined ? undefined : String(row.started_at) }));
}

/** One dispatch pass in the ledger. The epoch is recorded right after the pass reads the pause config. */
export interface PassHandle {
  setEpoch(epoch: number): Promise<void>;
  end(state: 'done' | 'failed'): Promise<void>;
}

export interface PassLedger {
  begin(): Promise<PassHandle>;
}

export function defaultPassInstance(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/** Ledger over the company database: one dispatch_pass row per pass, identified by the dispatcher instance that ran it. */
export function passLedger(db: Surreal, instance = defaultPassInstance()): PassLedger {
  return {
    async begin() {
      // Finished passes older than a day are pruned here (no timer); a running row is never pruned, so drain stays fail-closed.
      const [, rows] = await run(db, `DELETE dispatch_pass WHERE state != 'running' AND finished_at < time::now() - 1d;
        CREATE dispatch_pass CONTENT { instance: $instance, state: 'running', epoch: NONE, started_at: time::now() } RETURN id;`,
        { instance }) as [unknown, Array<{ id: RecordId }> | undefined];
      const pass = rows?.[0]?.id;
      if (!pass) throw new Error('dispatch pass ledger write returned no id');
      return {
        async setEpoch(epoch: number) {
          await run(db, 'UPDATE $pass SET epoch = $epoch;', { pass, epoch });
        },
        async end(state: 'done' | 'failed') {
          await run(db, 'UPDATE $pass SET state = $state, finished_at = time::now();', { pass, state });
        },
      };
    },
  };
}
