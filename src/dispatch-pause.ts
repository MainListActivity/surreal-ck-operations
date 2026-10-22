// Global dispatch pause (ops maintenance). One transaction moves company_meta:config.paused, its pause_epoch, the shared
// company_meta:dispatch_gate record and the audit row together. claimLease (core.ts) reads the config inside its own
// transaction and writes the gate on every new lease, so a claim that read the config before a pause committed conflicts
// with that pause and retries into the paused branch. Dispatch passes keep one dispatch_pass row each, so a pause can wait
// until every pass that started under an older epoch has ended (drain). Nothing here opens the window: restore is the only
// way back to dispatching.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
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
