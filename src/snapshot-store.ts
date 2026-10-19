// Stored listings for the paged reads (SYS01 C4). A listing is materialized once, when its first page is asked for:
// its members and the fields it returns are fixed at that instant, and every later page reads the stored rows. A page
// never re-runs the query, so state moves, edits, new rows and registry changes cannot reshuffle a traversal. A
// listing that is gone, expired or over capacity is refused with a recoverable error.
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
  /** Listings held by the whole database. A new listing past this is refused as temporarily_unavailable. */
  maxListings: number;
  /** Bytes held by all listings together. */
  maxTotalBytes: number;
  /** A listing still being written after this long is abandoned and removed. */
  buildTimeoutMs: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  ttlMs: 6 * 60 * 60 * 1000,
  maxRows: 5000,
  maxBytes: 8 * 1024 * 1024,
  maxPerOwner: 4,
  maxListings: 64,
  maxTotalBytes: 64 * 1024 * 1024,
  buildTimeoutMs: 5 * 60 * 1000,
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

/** Rows are written in statements of at most this many bytes, well under the request body limit. */
const BATCH_BYTES = 512 * 1024;

const headerOf = (row: HeaderRow): SnapshotHeader => ({
  id: String(row.id.id), owner: row.owner, kind: row.kind, digest: row.digest, role: row.role,
  rows: row.row_count, bytes: row.byte_count, takenAt: row.taken_at, expiresMs: row.expires_ms,
});

/**
 * Writes run one at a time across every store in this process, so two admissions cannot both take the last free slot.
 * Admission is atomic only within one process: a second process could overshoot a cap by its own concurrent writers.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
/** Last creation stamp handed out in this process. Stamps rise strictly, so eviction order is exact within a process. */
let lastStamp = 0;

export class SnapshotStore {
  readonly limits: SnapshotLimits;

  constructor(private readonly db: Surreal, limits: Partial<SnapshotLimits> = {}) {
    this.limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...limits };
  }

  /**
   * Stores `bodies` as a new listing for `owner`. A listing over the row or byte limit is refused whole
   * (response_too_large) rather than stored partly.
   */
  async create(input: {
    owner: string; kind: SnapshotKind; digest: string; role: string; takenAt: string; bodies: readonly string[];
  }, now = Date.now()): Promise<SnapshotHeader> {
    const { limits } = this;
    const bytes = input.bodies.reduce((sum, body) => sum + utf8Bytes(body), 0);
    if (input.bodies.length > limits.maxRows || bytes > limits.maxBytes) {
      throw new CompanyError('response_too_large', `this listing has ${input.bodies.length} rows (${bytes} bytes), above the ${limits.maxRows}-row or ${limits.maxBytes}-byte listing limit; narrow it with state, goalId, role or since`);
    }
    return this.exclusive(() => this.store(input, bytes, now));
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

  /** Removes listings past their expiry and listings abandoned while still being written. */
  async sweep(now = Date.now()): Promise<number> {
    return this.exclusive(() => this.sweepNow(now));
  }

  /** Deletes one listing and all of its rows. */
  async remove(id: string): Promise<void> {
    return this.exclusive(() => this.removeNow(id));
  }

  /** Number of stored listings and their rows, for tests and the RB01 drill. */
  async census(): Promise<{ listings: number; rows: number }> {
    const [listings] = await this.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM query_snapshot GROUP ALL;');
    const [rows] = await this.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM query_snapshot_row GROUP ALL;');
    return { listings: listings?.[0]?.n ?? 0, rows: rows?.[0]?.n ?? 0 };
  }

  private async store(input: {
    owner: string; kind: SnapshotKind; digest: string; role: string; takenAt: string; bodies: readonly string[];
  }, bytes: number, now: number): Promise<SnapshotHeader> {
    await this.sweepNow(now);
    await this.admit(input.owner, bytes);
    const id = randomUUID();
    const record = new RecordId('query_snapshot', id);
    const expiresMs = now + this.limits.ttlMs;
    const stamp = Math.max(now, lastStamp + 1);
    lastStamp = stamp;
    await this.db.query('CREATE ONLY $record CONTENT $content;', {
      record,
      content: {
        owner: input.owner, kind: input.kind, digest: input.digest, role: input.role, state: 'building',
        row_count: input.bodies.length, byte_count: bytes, taken_at: input.takenAt, created_ms: stamp, expires_ms: expiresMs,
      },
    });
    try {
      await this.insertRows(id, input.bodies);
      await this.db.query('UPDATE ONLY $record SET state = "ready";', { record });
    } catch {
      await this.removeNow(id);
      throw new CompanyError('temporarily_unavailable', 'the listing could not be stored; retry the read', true);
    }
    return {
      id, owner: input.owner, kind: input.kind, digest: input.digest, role: input.role,
      rows: input.bodies.length, bytes, takenAt: input.takenAt, expiresMs,
    };
  }

  /**
   * Admission for one new listing. It first computes what would be evicted and what would remain; only when the
   * database still has room does it evict the identity's oldest listings. A refusal therefore evicts nothing.
   */
  private async admit(owner: string, bytes: number): Promise<void> {
    const [mine] = await this.db.query<[Array<{ id: RecordId; byte_count: number; created_ms: number }>]>(
      'SELECT id, byte_count, created_ms FROM query_snapshot WHERE owner = $owner ORDER BY created_ms ASC;', { owner });
    const held = mine ?? [];
    const evict = held.slice(0, Math.max(0, held.length - (this.limits.maxPerOwner - 1)));
    const [totals] = await this.db.query<[Array<{ n: number; bytes: number }>]>(
      'SELECT count() AS n, math::sum(byte_count) AS bytes FROM query_snapshot GROUP ALL;');
    const count = (totals?.[0]?.n ?? 0) - evict.length;
    const used = (totals?.[0]?.bytes ?? 0) - evict.reduce((sum, old) => sum + old.byte_count, 0);
    if (count >= this.limits.maxListings || used + bytes > this.limits.maxTotalBytes) {
      throw new CompanyError('temporarily_unavailable', 'listing capacity is full; retry shortly', true);
    }
    for (const old of evict) await this.removeNow(String(old.id.id));
  }

  private async sweepNow(now: number): Promise<number> {
    const [stale] = await this.db.query<[Array<{ id: RecordId }>]>(
      "SELECT id FROM query_snapshot WHERE expires_ms <= $now OR (state = 'building' AND created_ms <= $built) LIMIT 100;",
      { now, built: now - this.limits.buildTimeoutMs });
    for (const row of stale ?? []) await this.removeNow(String(row.id.id));
    return stale?.length ?? 0;
  }

  private async removeNow(id: string): Promise<void> {
    await this.db.query('DELETE query_snapshot_row WHERE snapshot = $snapshot; DELETE $record;', {
      snapshot: id, record: new RecordId('query_snapshot', id),
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = writeQueue.then(work, work);
    writeQueue = next.catch(() => undefined);
    return next;
  }

  private async insertRows(id: string, bodies: readonly string[]): Promise<void> {
    let batch: Array<{ snapshot: string; seq: number; body: string }> = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length) await this.db.query('INSERT INTO query_snapshot_row $rows;', { rows: batch });
      batch = [];
      batchBytes = 0;
    };
    for (const [index, body] of bodies.entries()) {
      const size = utf8Bytes(body);
      if (batch.length && batchBytes + size > BATCH_BYTES) await flush();
      batch.push({ snapshot: id, seq: index + 1, body });
      batchBytes += size;
    }
    await flush();
  }
}
