// Stored listings for the paged reads (SYS01 C4, R4). A listing is materialized once, when its first page is asked for:
// its members and the fields it returns are fixed at that instant, and every later page reads the stored rows. A page
// never re-runs the query, so state moves, edits, new rows and registry changes cannot reshuffle a traversal. A
// listing that is gone, expired or over capacity is refused with a recoverable error.
//
// Capacity lives in the database, not in memory: one record, query_snapshot_quota:global (schema 022), is shared by every
// process that reads through this store (the MCP server and the plugin sidecar are separate processes). A reservation,
// commit, eviction or release changes that record in the same transaction as the listing rows, and bumps its version.
// A reservation reads the record and then writes new totals only if the version is still the one it read; a concurrent
// change makes it read again. A reservation counts toward the caps from the moment it is made, so a listing still being
// written holds its room. A release deletes a listing and subtracts it in one transaction, and subtracts only when that
// delete found the listing, so every listing is released exactly once.
import { randomUUID } from 'node:crypto';
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { utf8Bytes } from './response-budget.ts';

export type SnapshotKind = 'context' | 'history' | 'worktrees';

export interface SnapshotLimits {
  /** Lifetime of a listing; its cursors expire with it. */
  ttlMs: number;
  /** Most rows one listing may hold. */
  maxRows: number;
  /** Most UTF-8 bytes one listing may hold. */
  maxBytes: number;
  /** Listings one identity may hold; its oldest is evicted to make room, and its cursors then fail as snapshot_gone. */
  maxPerOwner: number;
  /** Listings held by the whole database, reserved or stored. A new listing past this is refused as temporarily_unavailable. */
  maxListings: number;
  /** Bytes held by all listings together, reserved or stored. */
  maxTotalBytes: number;
  /** A listing still being written after this long is abandoned and removed. */
  buildTimeoutMs: number;
  /** A reservation whose owner holds only listings still being written waits this long for one to commit. */
  reserveWaitMs: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  ttlMs: 6 * 60 * 60 * 1000,
  maxRows: 5000,
  maxBytes: 8 * 1024 * 1024,
  maxPerOwner: 4,
  maxListings: 64,
  maxTotalBytes: 64 * 1024 * 1024,
  buildTimeoutMs: 5 * 60 * 1000,
  reserveWaitMs: 5 * 1000,
};

export interface SnapshotHeader {
  id: string;
  owner: string;
  kind: SnapshotKind;
  digest: string;
  role: string;
  /** Rows in the listing: the traversal's total. */
  rows: number;
  bytes: number;
  /** Database time the listing was read at. */
  takenAt: string;
  /** Epoch milliseconds after which the listing is gone. */
  expiresMs: number;
}

export interface SnapshotRow { seq: number; body: string }

/** A listing that has room reserved and is being written. The room is held until commit, release or the build timeout. */
export interface SnapshotReservation {
  id: string;
  owner: string;
  kind: SnapshotKind;
  digest: string;
  role: string;
  takenAt: string;
  /** Rows and UTF-8 bytes reserved. The database refuses any write that goes past either. */
  rows: number;
  bytes: number;
  expiresMs: number;
}

/** The quota record beside what the stored listings add up to. Equal when the accounting holds. */
export interface SnapshotAccounting {
  quota: { listings: number; bytes: number; version: number; seq: number };
  listings: number;
  bytes: number;
  rows: number;
}

interface HeaderRow {
  id: RecordId;
  owner: string;
  kind: SnapshotKind;
  digest: string;
  role: string;
  state: 'building' | 'ready';
  row_count: number;
  byte_count: number;
  taken_at: string;
  created_ms: number;
  expires_ms: number;
}

interface QuotaRow { listings: number; bytes: number; version: number; seq: number }

const QUOTA = new RecordId('query_snapshot_quota', 'global');
/** Rows are written in statements of at most this many bytes, well under the request body limit. */
const BATCH_BYTES = 512 * 1024;
/** Reservations, and releases, tried before the caller is told to retry. Each try reads the quota again. */
const RESERVE_ATTEMPTS = 50;
/** How long one transaction keeps retrying after a concurrent write conflicts with it. */
const TRANSACTION_WAIT_MS = 10 * 1000;

const headerOf = (row: HeaderRow): SnapshotHeader => ({
  id: String(row.id.id), owner: row.owner, kind: row.kind, digest: row.digest, role: row.role,
  rows: row.row_count, bytes: row.byte_count, takenAt: row.taken_at, expiresMs: row.expires_ms,
});

const unavailable = (message: string) => new CompanyError('temporarily_unavailable', message, true);
const pause = () => Bun.sleep(1 + Math.floor(Math.random() * 8));

export class SnapshotStore {
  readonly limits: SnapshotLimits;
  private quotaReady?: Promise<void>;

  constructor(private readonly db: Surreal, limits: Partial<SnapshotLimits> = {}) {
    this.limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...limits };
  }

  /**
   * Stores `bodies` as a new listing for `owner`. A listing over the row or byte limit is refused whole
   * (response_too_large) rather than stored partly. A write that fails part-way releases what it reserved.
   */
  async create(input: {
    owner: string; kind: SnapshotKind; digest: string; role: string; takenAt: string; bodies: readonly string[];
  }, now = Date.now()): Promise<SnapshotHeader> {
    const bytes = input.bodies.reduce((sum, body) => sum + utf8Bytes(body), 0);
    const reservation = await this.begin({
      owner: input.owner, kind: input.kind, digest: input.digest, role: input.role, takenAt: input.takenAt,
      rows: input.bodies.length, bytes,
    }, now);
    try {
      await this.writeRows(reservation, input.bodies);
      await this.commit(reservation);
    } catch (error) {
      await this.release(reservation.id);
      throw error instanceof CompanyError ? error : unavailable('the listing could not be stored; retry the read');
    }
    return {
      id: reservation.id, owner: reservation.owner, kind: reservation.kind, digest: reservation.digest, role: reservation.role,
      rows: reservation.rows, bytes: reservation.bytes, takenAt: reservation.takenAt, expiresMs: reservation.expiresMs,
    };
  }

  /**
   * Rows of a listing after position `after` (at most `limit`). Checks, in order: the listing exists, is ready and is
   * unexpired; the caller, kind and query are the ones it was taken for; the caller's role is unchanged; and every row
   * that should be there is there, so a listing removed under the read is reported and never read as a gap.
   */
  async read(input: {
    id: string; owner: string; kind: SnapshotKind; digest: string; role: string; after: number; limit: number;
  }, now = Date.now()): Promise<{ header: SnapshotHeader; rows: SnapshotRow[] }> {
    const row = await this.db.select<HeaderRow>(new RecordId('query_snapshot', input.id));
    if (!row || row.state !== 'ready' || row.expires_ms <= now) {
      throw new CompanyError('snapshot_gone', 'this listing has expired or was evicted; start the listing again without cursor', false);
    }
    if (row.owner !== input.owner || row.kind !== input.kind || row.digest !== input.digest) {
      throw new CompanyError('forbidden', 'cursor belongs to another caller or another query');
    }
    if (row.role !== input.role) {
      throw new CompanyError('forbidden', 'this listing was taken under another role; start the listing again without cursor');
    }
    const [rows] = await this.db.query<[SnapshotRow[]]>(
      'SELECT seq, body FROM query_snapshot_row WHERE snapshot = $snapshot AND seq > $after ORDER BY seq ASC LIMIT $limit;',
      { snapshot: input.id, after: input.after, limit: input.limit });
    const got = rows ?? [];
    // Rows are numbered contiguously from 1, so a short read means the listing was removed under this read.
    if (got.length !== Math.min(input.limit, Math.max(0, row.row_count - input.after))) {
      throw new CompanyError('snapshot_gone', 'this listing was removed while it was being read; start the listing again without cursor', false);
    }
    return { header: headerOf(row), rows: got };
  }

  /**
   * Reserves room for one listing of `rows` rows and `bytes` bytes. The owner's oldest listings are evicted to keep
   * the owner within its cap, but only when the reservation is admitted: a refusal evicts nothing. Pair with
   * writeRows and commit, or with release.
   */
  async begin(input: {
    owner: string; kind: SnapshotKind; digest: string; role: string; takenAt: string; rows: number; bytes: number;
  }, now = Date.now()): Promise<SnapshotReservation> {
    const { limits } = this;
    if (input.rows > limits.maxRows || input.bytes > limits.maxBytes) {
      throw new CompanyError('response_too_large', `this listing has ${input.rows} rows (${input.bytes} bytes), above the ${limits.maxRows}-row or ${limits.maxBytes}-byte listing limit; narrow it with state, goalId, role or since`);
    }
    await this.sweepNow(now);
    const id = randomUUID();
    const record = new RecordId('query_snapshot', id);
    const expiresMs = now + limits.ttlMs;
    const deadline = Date.now() + limits.reserveWaitMs;
    while (Date.now() < deadline) {
      await this.ensureQuota();
      // The quota is read before the owner's listings. Any change after this read moves the version, and the swap below then fails.
      const quota = await this.db.select<QuotaRow>(QUOTA);
      if (!quota) throw unavailable('listing capacity is unavailable; retry shortly');
      const [mine] = await this.db.query<[Array<{ id: RecordId; state: string; byte_count: number; created_seq?: number }>]>(
        'SELECT id, state, byte_count, created_seq FROM query_snapshot WHERE owner = $owner ORDER BY created_seq ASC;', { owner: input.owner });
      const held = mine ?? [];
      // Only committed listings are evicted, oldest first. A listing still being written belongs to a request that is
      // waiting for it, so it keeps its room; when every listing the owner holds is still being written, this
      // reservation waits for one of them to commit.
      const excess = Math.max(0, held.length + 1 - limits.maxPerOwner);
      const evict = held.filter(old => old.state === 'ready').slice(0, excess);
      if (evict.length < excess) {
        await pause();
        continue;
      }
      const listings = quota.listings - evict.length + 1;
      const totalBytes = quota.bytes - evict.reduce((sum, old) => sum + old.byte_count, 0) + input.bytes;
      if (listings > limits.maxListings || totalBytes > limits.maxTotalBytes) {
        throw unavailable('listing capacity is full; retry shortly');
      }
      const { outcome } = await this.transact(`BEGIN;
        LET $moved = UPDATE ONLY $quota SET version += 1, seq += 1, listings = $listings, bytes = $totalBytes
          WHERE version = $version RETURN AFTER;
        IF $moved = NONE { THROW 'snapshot quota moved' };
        FOR $old IN $evict {
          DELETE query_snapshot_row WHERE snapshot = $old.key;
          DELETE $old.record;
        };
        CREATE ONLY $record CONTENT {
          owner: $owner, kind: $kind, digest: $digest, role: $role, state: 'building', row_count: $rows, byte_count: $bytes,
          taken_at: $takenAt, created_ms: $now, expires_ms: $expires, created_seq: $moved.seq, written_rows: 0, written_bytes: 0
        };
        COMMIT;`, {
        quota: QUOTA, version: quota.version, listings, totalBytes,
        evict: evict.map(old => ({ key: String(old.id.id), record: old.id })),
        record, owner: input.owner, kind: input.kind, digest: input.digest, role: input.role, rows: input.rows,
        bytes: input.bytes, takenAt: input.takenAt, now, expires: expiresMs,
      });
      if (outcome === 'done') {
        return {
          id, owner: input.owner, kind: input.kind, digest: input.digest, role: input.role, takenAt: input.takenAt,
          rows: input.rows, bytes: input.bytes, expiresMs,
        };
      }
      await pause();
    }
    throw unavailable('listing capacity is busy; retry shortly');
  }

  /**
   * Writes the rows of a reserved listing, in batches. Each batch is one transaction that first takes its size off the
   * reservation: a batch past the reserved rows or bytes, or into a listing no longer being built, is refused.
   */
  async writeRows(reservation: SnapshotReservation, bodies: readonly string[]): Promise<void> {
    const record = new RecordId('query_snapshot', reservation.id);
    let batch: Array<{ snapshot: string; seq: number; body: string }> = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const { outcome } = await this.transact(`BEGIN;
        LET $held = UPDATE ONLY $record SET written_rows = (written_rows ?? 0) + $count, written_bytes = (written_bytes ?? 0) + $size
          WHERE state = 'building' AND (written_rows ?? 0) + $count <= row_count AND (written_bytes ?? 0) + $size <= byte_count
          RETURN AFTER;
        IF $held = NONE { THROW 'snapshot write refused' };
        INSERT INTO query_snapshot_row $rows;
        COMMIT;`, { record, count: batch.length, size: batchBytes, rows: batch });
      if (outcome !== 'done') throw unavailable('the listing could not be stored; retry the read');
      batch = [];
      batchBytes = 0;
    };
    for (const [index, body] of bodies.entries()) {
      const size = utf8Bytes(body);
      if (batch.length > 0 && batchBytes + size > BATCH_BYTES) await flush();
      batch.push({ snapshot: reservation.id, seq: index + 1, body });
      batchBytes += size;
    }
    await flush();
  }

  /** Makes a reserved listing readable, once every reserved row and byte is written. */
  async commit(reservation: SnapshotReservation): Promise<void> {
    const { outcome } = await this.transact(`BEGIN;
      LET $ready = UPDATE ONLY $record SET state = 'ready'
        WHERE state = 'building' AND (written_rows ?? 0) = $rows AND (written_bytes ?? 0) = $bytes RETURN AFTER;
      IF $ready = NONE { THROW 'snapshot commit refused' };
      COMMIT;`, { record: new RecordId('query_snapshot', reservation.id), rows: reservation.rows, bytes: reservation.bytes });
    if (outcome !== 'done') throw unavailable('the listing could not be stored; retry the read');
  }

  /** Releases one listing: its header, its rows and its room go together. A listing already gone frees nothing. */
  async release(id: string): Promise<'released' | 'absent'> {
    return this.drop(id, '', {});
  }

  /** Removes listings past their expiry and listings abandoned while still being written. */
  async sweep(now = Date.now()): Promise<number> {
    return this.sweepNow(now);
  }

  /** Deletes one listing and all of its rows. */
  async remove(id: string): Promise<void> {
    await this.release(id);
  }

  /** Number of stored listings and their rows, for tests and the RB01 drill. */
  async census(): Promise<{ listings: number; rows: number }> {
    const [listings] = await this.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM query_snapshot GROUP ALL;');
    const [rows] = await this.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM query_snapshot_row GROUP ALL;');
    return { listings: listings?.[0]?.n ?? 0, rows: rows?.[0]?.n ?? 0 };
  }

  /** The quota record beside what the stored listings add up to, for tests and the RB01 drill. */
  async accounting(): Promise<SnapshotAccounting> {
    await this.ensureQuota();
    const quota = (await this.db.select<QuotaRow>(QUOTA)) ?? { listings: 0, bytes: 0, version: 0, seq: 0 };
    const [totals] = await this.db.query<[Array<{ n: number; bytes: number }>]>(
      'SELECT count() AS n, math::sum(byte_count) AS bytes FROM query_snapshot GROUP ALL;');
    const [rows] = await this.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM query_snapshot_row GROUP ALL;');
    return { quota, listings: totals?.[0]?.n ?? 0, bytes: totals?.[0]?.bytes ?? 0, rows: rows?.[0]?.n ?? 0 };
  }

  private async sweepNow(now: number): Promise<number> {
    const built = now - this.limits.buildTimeoutMs;
    const [stale] = await this.db.query<[Array<{ id: RecordId }>]>(
      "SELECT id FROM query_snapshot WHERE expires_ms <= $now OR (state = 'building' AND created_ms <= $built) LIMIT 100;",
      { now, built });
    let released = 0;
    for (const row of stale ?? []) {
      // The stale test is repeated inside the release transaction, so a listing committed in the meantime stays.
      const outcome = await this.drop(String(row.id.id),
        "AND (expires_ms <= $now OR (state = 'building' AND created_ms <= $built))", { now, built });
      if (outcome === 'released') released++;
    }
    return released;
  }

  /**
   * Deletes one listing, its rows and its room in one transaction. The room is subtracted only when the delete found the
   * listing, so concurrent releases of one listing subtract it once: the loser finds nothing and frees nothing.
   */
  private async drop(key: string, where: string, vars: Record<string, unknown>): Promise<'released' | 'absent'> {
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
      await this.ensureQuota();
      // A delete that finds nothing throws, which rolls the whole transaction back: nothing is subtracted twice.
      const { outcome } = await this.transact(`BEGIN;
        LET $gone = (DELETE query_snapshot WHERE id = $record ${where} RETURN BEFORE);
        IF array::len($gone) = 0 { THROW 'snapshot absent' };
        UPDATE ONLY $quota SET version += 1, listings -= 1, bytes -= $gone[0].byte_count;
        DELETE query_snapshot_row WHERE snapshot = $key;
        COMMIT;`, { ...vars, record: new RecordId('query_snapshot', key), key, quota: QUOTA });
      if (outcome === 'done') return 'released';
      if (outcome === 'refused') return 'absent';
      await pause();
    }
    throw unavailable('a listing could not be released yet; the next sweep will retry');
  }

  /**
   * Runs one transaction: a batch of statements that commits or does nothing. A conflict with a concurrent write is tried
   * again here. A refusal comes back to the caller, which decides what it means.
   */
  private async transact(query: string, vars: Record<string, unknown>): Promise<{ outcome: 'done' | 'moved' | 'refused' | 'conflict' }> {
    const deadline = Date.now() + TRANSACTION_WAIT_MS;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      const responses = await this.db.query<unknown[]>(query, vars).responses();
      const failures = responses.filter(response => !response.success);
      if (failures.length === 0) return { outcome: 'done' };
      const cause = failures.map(response => response.error.message)
        .find(message => !message.includes('not executed due to') && !message.startsWith('Cannot COMMIT')) ?? '';
      if (/snapshot quota moved/.test(cause)) return { outcome: 'moved' };
      if (/snapshot write refused|snapshot commit refused|snapshot absent/.test(cause)) return { outcome: 'refused' };
      if (!/conflict/i.test(cause)) throw unavailable('the listing store refused the statement; retry the read');
      // A conflicting transaction rolled back as a whole, so it is run again after a random pause that grows with each try.
      await Bun.sleep(1 + Math.floor(Math.random() * Math.min(64, 2 ** attempt)));
    }
    return { outcome: 'conflict' };
  }

  /** Creates the quota record on first use. INSERT IGNORE leaves an existing record, and its totals, as they are. */
  private ensureQuota(): Promise<void> {
    this.quotaReady ??= (async () => {
      try {
        await this.db.query('INSERT IGNORE INTO query_snapshot_quota $rows;', {
          rows: [{ id: QUOTA, listings: 0, bytes: 0, version: 0, seq: 0 }],
        });
      } catch (error) {
        this.quotaReady = undefined;
        throw error;
      }
    })();
    return this.quotaReady;
  }
}
