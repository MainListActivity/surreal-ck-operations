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
//
// A build (SYS01 AC-D) runs on connections of its own, so a large build never queues ahead of control requests on the main
// connection. Each read attempt opens one, and a build closes only its own. Its reservation, quota and sweep statements run on
// those connections too, and so does its release when it fails. A release or sweep opens a connection through the release
// channel, which is outside the build cap, so a saturated build pool cannot hold it back. Pages (read) and the test helpers (begin, writeRows, commit, census, accounting) use the
// main connection. A build has a deadline (buildDeadlineMs). Past it no further statement is started, the statement in flight
// gets a short wait to finish, its connection is closed if it is still running, what was reserved is released, and the caller
// gets temporarily_unavailable. A release has a deadline of its own (RELEASE_DEADLINE_MS): past it the listing is marked for the
// sweep, the release is counted as pending, and the caller gets temporarily_unavailable.
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
  /** UTF-8 bytes written per transaction while a listing is stored. A smaller batch holds the channel for less time per statement. */
  batchBytes: number;
  /** Wall-clock time one listing build may take, from its first read to its commit. Past it the build is cancelled (see build). */
  buildDeadlineMs: number;
  /** A listing's read still unanswered after this long is abandoned, its connection closed, and the read run once more on a new one (see build). */
  loadHedgeMs: number;
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
  batchBytes: 64 * 1024,
  buildDeadlineMs: 10 * 1000,
  loadHedgeMs: 5 * 1000,
};

/** A connection a read attempt of a build runs on. It is closed when the attempt is abandoned, when a cancelled build's statement does not finish, or when the build ends. */
export interface SnapshotLink {
  readonly db: Surreal;
  /** Drops the connection with whatever it is still waiting for. Closing it again is harmless. */
  close(): Promise<void>;
}

/** Opens the connections builds run on: one for each read attempt, so an attempt that is abandoned takes no other build's connection with it. */
export interface SnapshotChannel {
  open(): Promise<SnapshotLink>;
}

export interface SnapshotStoreOptions {
  /** Where builds run. The default is the store's own connection, which a build never closes. */
  channel?: SnapshotChannel;
  /** Where releases and sweeps run. The default is `channel`. Keep it outside the build cap, so a saturated build pool cannot hold a release back. */
  releaseChannel?: SnapshotChannel;
  /** Told what every build cost, stored or not. Used by the measurements; a listing's contents are never passed on. */
  observe?: (stats: SnapshotBuildStats) => void;
}

/** What one build cost: client phase times, the server's time for its statements, and what it stored or why it stopped. */
export interface SnapshotBuildStats {
  outcome: 'stored' | 'timed_out' | 'refused' | 'failed';
  kind: SnapshotKind;
  rows: number;
  bytes: number;
  batches: number;
  loadMs: number;
  reserveMs: number;
  writeMs: number;
  commitMs: number;
  totalMs: number;
  /** Sum of the server's own durations for the statements of this build (query statistics), in milliseconds. */
  serverMs: number;
  /** Reads of the rows: 2 when the first read was abandoned for a new connection after loadHedgeMs. */
  loadAttempts: number;
  /** How the reservation of a failed build was released: 'none' when nothing was reserved, 'pending' when the release ran out of time and the listing waits for the sweep. */
  release: 'none' | 'released' | 'absent' | 'pending';
  /** Time the release of a failed build took, in milliseconds: 0 when nothing was reserved. */
  releaseMs: number;
}

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

/** Server-side time of the statements in one build, added up as they run. */
interface BuildAccount { serverMs: number; batches: number }
/** Set when a build is cancelled, so that no further batch is started. */
interface BuildSignal { cancelled: boolean }

const QUOTA = new RecordId('query_snapshot_quota', 'global');
/** How long one transaction keeps retrying after a concurrent write conflicts with it. */
const TRANSACTION_WAIT_MS = 10 * 1000;
/** A cancelled build gives the statement it has in flight this long to finish before that connection is closed. */
const CLEANUP_WAIT_MS = 2 * 1000;
/** Longest one release may take, from opening its connection to its last statement. Past it the listing is left for the sweep. */
const RELEASE_DEADLINE_MS = 3 * 1000;
/** Longest the marking of a timed-out release for the sweep may take. */
const MARK_WAIT_MS = 1 * 1000;

const headerOf = (row: HeaderRow): SnapshotHeader => ({
  id: String(row.id.id), owner: row.owner, kind: row.kind, digest: row.digest, role: row.role,
  rows: row.row_count, bytes: row.byte_count, takenAt: row.taken_at, expiresMs: row.expires_ms,
});

const unavailable = (message: string) => new CompanyError('temporarily_unavailable', message, true);
const timedOut = (deadlineMs: number, guidance: string) => new CompanyError('temporarily_unavailable',
  `the listing was not built within ${Math.round(deadlineMs / 1000)} seconds, so it was cancelled and nothing was kept; ${guidance}, then retry`, true);
const pause = () => Bun.sleep(1 + Math.floor(Math.random() * 8));
/** `work` settles before `at` (epoch milliseconds) with its value or its error; otherwise the result is undefined and `work` is left running. */
const untilAt = <T>(work: Promise<T>, at: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), Math.max(0, at - Date.now())); })])
    .finally(() => clearTimeout(timer));
};
/** Milliseconds of server time in one statement's query statistics. */
const serverMsOf = (stats: { duration?: { nanoseconds?: bigint } } | undefined): number =>
  Number(stats?.duration?.nanoseconds ?? 0) / 1_000_000;

export class SnapshotStore {
  readonly limits: SnapshotLimits;
  private quotaReady?: Promise<void>;
  private readonly channel: SnapshotChannel;
  private readonly releaseChannel: SnapshotChannel;

  constructor(private readonly db: Surreal, limits: Partial<SnapshotLimits> = {}, private readonly options: SnapshotStoreOptions = {}) {
    this.limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...limits };
    this.channel = options.channel ?? { open: async () => ({ db, close: async () => undefined }) };
    this.releaseChannel = options.releaseChannel ?? this.channel;
  }

  /**
   * Stores `bodies` as a new listing for `owner`. A listing over the row or byte limit is refused whole
   * (response_too_large) rather than stored partly. A write that fails part-way releases what it reserved.
   */
  async create(input: {
    owner: string; kind: SnapshotKind; digest: string; role: string; takenAt: string; bodies: readonly string[]; guidance?: string;
  }, now = Date.now()): Promise<SnapshotHeader> {
    return this.build({
      owner: input.owner, kind: input.kind, digest: input.digest, role: input.role, guidance: input.guidance ?? 'narrow the query',
      load: async () => ({ takenAt: input.takenAt, bodies: input.bodies }),
    }, now);
  }

  /**
   * Builds a listing. `load` reads its rows on a connection the build opens and returns them with the time they were read at.
   * The whole build (the connection, the read, the reservation, every batch and the commit) must finish within buildDeadlineMs.
   * Past that deadline no further statement is started; the one in flight gets CLEANUP_WAIT_MS to finish, and its connection is
   * closed if it has not; what was reserved is released; and the caller gets temporarily_unavailable, with `guidance` on how to
   * narrow the query. Errors from `load` (for example response_too_large) pass through unchanged. A read still unanswered after
   * loadHedgeMs is abandoned, its connection closed, and the read run once more on a new connection; only the read that answers
   * is used, so the listing is still one consistent read. A second stall is not retried.
   */
  async build(input: {
    owner: string; kind: SnapshotKind; digest: string; role: string; guidance: string;
    load: (db: Surreal) => Promise<{ takenAt: string; bodies: readonly string[] }>;
  }, now = Date.now()): Promise<SnapshotHeader> {
    const started = performance.now();
    const id = randomUUID();
    const account: BuildAccount = { serverMs: 0, batches: 0 };
    const stats: SnapshotBuildStats = {
      outcome: 'failed', kind: input.kind, rows: 0, bytes: 0, batches: 0, loadMs: 0, reserveMs: 0, writeMs: 0, commitMs: 0, totalMs: 0, serverMs: 0,
      loadAttempts: 1, release: 'none', releaseMs: 0,
    };
    const signal: BuildSignal = { cancelled: false };
    const state = { expired: false, reserved: false, ended: false };
    // The step in flight: `done` turns true when it settles, whatever its outcome. Steps are numbered, so a step abandoned by
    // a hedge may still settle later without changing the state of the step that is in flight.
    const flight = { done: true, settled: Promise.resolve(), current: 0 };
    // The connections this build has open. A read attempt adds its connection once it is open. A connection is closed when its
    // attempt is abandoned, when a cancelled build's statement does not finish, or when the build ends.
    const links = new Set<SnapshotLink>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        state.expired = true;
        signal.cancelled = true;
        reject(timedOut(this.limits.buildDeadlineMs, input.guidance));
      }, this.limits.buildDeadlineMs);
    });
    expired.catch(() => undefined);
    const within = <T>(work: Promise<T>): Promise<T> => {
      const step = ++flight.current;
      flight.done = false;
      flight.settled = work.then(() => undefined, () => undefined).then(() => { if (flight.current === step) flight.done = true; });
      return Promise.race([work, expired]);
    };
    // No new step starts once the deadline has passed, even when the deadline passed between two awaits.
    const live = () => {
      if (signal.cancelled) throw timedOut(this.limits.buildDeadlineMs, input.guidance);
    };
    const closeLinks = (): Promise<void> => Promise.all([...links].map(link => {
      links.delete(link);
      return link.close().catch(() => undefined);
    })).then(() => undefined);
    try {
      // Each read attempt runs on a connection of its own. An attempt still unanswered after loadHedgeMs is abandoned without
      // waiting for it: its connection is closed, and the read runs once more on a new one. Only the read that answers is
      // used, so the listing is still one consistent read.
      const loadStarted = performance.now();
      const attempt = async (token: { now: boolean }): Promise<{ db: Surreal; loaded: { takenAt: string; bodies: readonly string[] } }> => {
        // A connection is registered as soon as it opens, even when the deadline has already passed, so that it is always closed.
        const link = await within(this.channel.open().then(opened => {
          if (token.now || state.ended) {
            void opened.close().catch(() => undefined);
            throw new Error('read abandoned');
          }
          links.add(opened);
          return opened;
        }));
        live();
        return { db: link.db, loaded: await within(input.load(link.db)) };
      };
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
      const hedge = new Promise<'hedge'>(resolve => { hedgeTimer = setTimeout(() => resolve('hedge'), this.limits.loadHedgeMs); });
      const abandon = { now: false };
      const first = attempt(abandon);
      const answered = await Promise.race([first, hedge]).finally(() => clearTimeout(hedgeTimer));
      let read: { db: Surreal; loaded: { takenAt: string; bodies: readonly string[] } };
      if (answered === 'hedge') {
        first.catch(() => undefined);
        abandon.now = true;
        stats.loadAttempts = 2;
        void closeLinks();
        read = await attempt({ now: false });
      } else {
        read = answered;
      }
      const { db, loaded } = read;
      stats.loadMs = performance.now() - loadStarted;
      stats.rows = loaded.bodies.length;
      stats.bytes = loaded.bodies.reduce((sum, body) => sum + utf8Bytes(body), 0);
      live();
      // From here a reservation may exist even if its statement is cut short, so the release below always runs.
      state.reserved = true;
      const reserveStarted = performance.now();
      const reservation = await within(this.beginOn(db, {
        id, owner: input.owner, kind: input.kind, digest: input.digest, role: input.role, takenAt: loaded.takenAt,
        rows: stats.rows, bytes: stats.bytes,
      }, now, account));
      stats.reserveMs = performance.now() - reserveStarted;
      const writeStarted = performance.now();
      await within(this.writeRowsOn(db, reservation, loaded.bodies, account, signal));
      stats.writeMs = performance.now() - writeStarted;
      live();
      const commitStarted = performance.now();
      await within(this.commitOn(db, reservation, account));
      stats.commitMs = performance.now() - commitStarted;
      stats.outcome = 'stored';
      return {
        id, owner: input.owner, kind: input.kind, digest: input.digest, role: input.role, rows: reservation.rows,
        bytes: reservation.bytes, takenAt: reservation.takenAt, expiresMs: reservation.expiresMs,
      };
    } catch (error) {
      signal.cancelled = true;
      if (!flight.done) {
        let patience: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([flight.settled, new Promise<void>(resolve => { patience = setTimeout(resolve, CLEANUP_WAIT_MS); })]);
        clearTimeout(patience);
      }
      // The build's connections close before its release opens one of its own, so a release never waits on this build's slot.
      await closeLinks();
      if (state.reserved) {
        const releaseStarted = performance.now();
        stats.release = await this.releaseOn(id);
        stats.releaseMs = performance.now() - releaseStarted;
      }
      stats.outcome = state.expired ? 'timed_out' : error instanceof CompanyError ? 'refused' : 'failed';
      throw error instanceof CompanyError ? error : unavailable('the listing could not be stored; retry the read');
    } finally {
      state.ended = true;
      clearTimeout(timer);
      await closeLinks();
      stats.batches = account.batches;
      stats.serverMs = account.serverMs;
      stats.totalMs = performance.now() - started;
      this.options.observe?.(stats);
    }
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
    return this.beginOn(this.db, input, now);
  }

  /**
   * Writes the rows of a reserved listing, in batches. Each batch is one transaction that first takes its size off the
   * reservation: a batch past the reserved rows or bytes, or into a listing no longer being built, is refused. A later call
   * continues the numbering where the earlier one stopped. Each batch names the rows and bytes written before it, and is
   * refused unless the record still says so, so two writers of one listing cannot number the same row.
   */
  async writeRows(reservation: SnapshotReservation, bodies: readonly string[]): Promise<void> {
    await this.writeRowsOn(this.db, reservation, bodies, { serverMs: 0, batches: 0 });
  }

  /** Makes a reserved listing readable, once every reserved row and byte is written. */
  async commit(reservation: SnapshotReservation): Promise<void> {
    await this.commitOn(this.db, reservation);
  }

  /**
   * Releases one listing: its header, its rows and its room go together. A listing already gone frees nothing. The release runs
   * on a connection of its own from the release channel, within RELEASE_DEADLINE_MS. Past that the listing is marked for the
   * sweep and the call throws temporarily_unavailable.
   */
  async release(id: string): Promise<'released' | 'absent'> {
    const outcome = await this.releaseOn(id);
    if (outcome === 'pending') throw unavailable('the listing could not be released within the deadline; it is left for the sweep, retry shortly');
    return outcome;
  }

  /** Removes listings past their expiry and listings abandoned while still being written. Runs on a release-channel connection. */
  async sweep(now = Date.now()): Promise<number> {
    const link = await this.releaseChannel.open();
    try {
      return await this.sweepOn(link.db, now);
    } finally {
      await link.close().catch(() => undefined);
    }
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
    await this.ensureQuotaOn(this.db);
    const quota = (await this.db.select<QuotaRow>(QUOTA)) ?? { listings: 0, bytes: 0, version: 0, seq: 0 };
    const [totals] = await this.db.query<[Array<{ n: number; bytes: number }>]>(
      'SELECT count() AS n, math::sum(byte_count) AS bytes FROM query_snapshot GROUP ALL;');
    const [rows] = await this.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM query_snapshot_row GROUP ALL;');
    return { quota, listings: totals?.[0]?.n ?? 0, bytes: totals?.[0]?.bytes ?? 0, rows: rows?.[0]?.n ?? 0 };
  }

  private async beginOn(db: Surreal, input: {
    id?: string; owner: string; kind: SnapshotKind; digest: string; role: string; takenAt: string; rows: number; bytes: number;
  }, now: number, account?: BuildAccount): Promise<SnapshotReservation> {
    const { limits } = this;
    if (input.rows > limits.maxRows || input.bytes > limits.maxBytes) {
      throw new CompanyError('response_too_large', `this listing has ${input.rows} rows (${input.bytes} bytes), above the ${limits.maxRows}-row or ${limits.maxBytes}-byte listing limit; narrow it with state, goalId, role or since`);
    }
    await this.sweepOn(db, now);
    const id = input.id ?? randomUUID();
    const record = new RecordId('query_snapshot', id);
    const expiresMs = now + limits.ttlMs;
    const deadline = Date.now() + limits.reserveWaitMs;
    while (Date.now() < deadline) {
      await this.ensureQuotaOn(db);
      // The quota is read before the owner's listings. Any change after this read moves the version, and the swap below then fails.
      const quota = await db.select<QuotaRow>(QUOTA);
      if (!quota) throw unavailable('listing capacity is unavailable; retry shortly');
      const [mine] = await db.query<[Array<{ id: RecordId; state: string; byte_count: number; created_seq?: number }>]>(
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
      const { outcome } = await this.transact(db, `BEGIN;
        LET $moved = UPDATE ONLY $quota SET version += 1, seq += 1, listings = $listings, bytes = $totalBytes
          WHERE version = $version RETURN AFTER;
        IF $moved = NONE { THROW 'snapshot quota moved' };
        FOR $old IN $evict {
          DELETE query_snapshot_row WHERE snapshot = $old.key RETURN NONE;
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
      }, account);
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

  private async writeRowsOn(db: Surreal, reservation: SnapshotReservation, bodies: readonly string[], account: BuildAccount,
    signal?: BuildSignal): Promise<void> {
    const record = new RecordId('query_snapshot', reservation.id);
    const written = await db.select<{ written_rows?: number; written_bytes?: number }>(record);
    let doneRows = written?.written_rows ?? 0;
    let doneBytes = written?.written_bytes ?? 0;
    let batch: Array<{ snapshot: string; seq: number; body: string }> = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      if (signal?.cancelled) throw new Error('listing build cancelled');
      const { outcome } = await this.transact(db, `BEGIN;
        LET $held = UPDATE ONLY $record SET written_rows = (written_rows ?? 0) + $count, written_bytes = (written_bytes ?? 0) + $size
          WHERE state = 'building' AND (written_rows ?? 0) = $fromRows AND (written_bytes ?? 0) = $fromBytes
            AND (written_rows ?? 0) + $count <= row_count AND (written_bytes ?? 0) + $size <= byte_count
          RETURN AFTER;
        IF $held = NONE { THROW 'snapshot write refused' };
        INSERT INTO query_snapshot_row $rows RETURN NONE;
        COMMIT;`, { record, count: batch.length, size: batchBytes, fromRows: doneRows, fromBytes: doneBytes, rows: batch }, account);
      if (outcome !== 'done') throw unavailable('the listing could not be stored; retry the read');
      account.batches++;
      doneRows += batch.length;
      doneBytes += batchBytes;
      batch = [];
      batchBytes = 0;
    };
    for (const body of bodies) {
      const size = utf8Bytes(body);
      if (batch.length > 0 && batchBytes + size > this.limits.batchBytes) await flush();
      batch.push({ snapshot: reservation.id, seq: doneRows + batch.length + 1, body });
      batchBytes += size;
    }
    await flush();
  }

  private async commitOn(db: Surreal, reservation: SnapshotReservation, account?: BuildAccount): Promise<void> {
    const { outcome } = await this.transact(db, `BEGIN;
      LET $ready = UPDATE ONLY $record SET state = 'ready'
        WHERE state = 'building' AND (written_rows ?? 0) = $rows AND (written_bytes ?? 0) = $bytes RETURN AFTER;
      IF $ready = NONE { THROW 'snapshot commit refused' };
      COMMIT;`, { record: new RecordId('query_snapshot', reservation.id), rows: reservation.rows, bytes: reservation.bytes }, account);
    if (outcome !== 'done') throw unavailable('the listing could not be stored; retry the read');
  }

  private async sweepOn(db: Surreal, now: number): Promise<number> {
    const built = now - this.limits.buildTimeoutMs;
    const [stale] = await db.query<[Array<{ id: RecordId }>]>(
      "SELECT id FROM query_snapshot WHERE expires_ms <= $now OR (state = 'building' AND created_ms <= $built) LIMIT 100;",
      { now, built });
    let released = 0;
    for (const row of stale ?? []) {
      // The stale test is repeated inside the release transaction, so a listing committed in the meantime stays.
      const outcome = await this.dropOn(db, String(row.id.id),
        "AND (expires_ms <= $now OR (state = 'building' AND created_ms <= $built))", { now, built }, Date.now() + RELEASE_DEADLINE_MS);
      if (outcome === 'released') released++;
    }
    return released;
  }

  /**
   * Deletes one listing, its rows and its room in one transaction. The room is subtracted only when the delete found the
   * listing, so concurrent releases of one listing subtract it once: the loser finds nothing and frees nothing. Runs on `db`
   * until `deadline`. Out of time, the listing is marked for the sweep (due at once) and the result is 'pending'.
   */
  private async dropOn(db: Surreal, key: string, where: string, vars: Record<string, unknown>, deadline: number):
    Promise<'released' | 'absent' | 'pending'> {
    while (Date.now() < deadline) {
      // A delete that finds nothing throws, which rolls the whole transaction back: nothing is subtracted twice.
      const { outcome } = await this.transact(db, `BEGIN;
        LET $gone = (DELETE query_snapshot WHERE id = $record ${where} RETURN BEFORE);
        IF array::len($gone) = 0 { THROW 'snapshot absent' };
        UPDATE ONLY $quota SET version += 1, listings -= 1, bytes -= $gone[0].byte_count;
        DELETE query_snapshot_row WHERE snapshot = $key RETURN NONE;
        COMMIT;`, { ...vars, record: new RecordId('query_snapshot', key), key, quota: QUOTA }, undefined, deadline);
      if (outcome === 'done') return 'released';
      if (outcome === 'refused') return 'absent';
      await pause();
    }
    console.error(`snapshot listing ${key} was not released within ${RELEASE_DEADLINE_MS} ms; it is left for the sweep`);
    await this.markForSweep(db, key);
    return 'pending';
  }

  /** Marks a listing for the sweep: expired and abandoned at once. Waits at most MARK_WAIT_MS, and logs a mark that does not complete. */
  private async markForSweep(db: Surreal, id: string): Promise<void> {
    const marked = await untilAt(db.query('UPDATE $record SET created_ms = 0, expires_ms = 0 RETURN NONE;',
      { record: new RecordId('query_snapshot', id) }).then(() => true, () => false), Date.now() + MARK_WAIT_MS);
    if (marked !== true) console.error(`snapshot listing ${id} could not be marked for the sweep; it stays until it expires`);
  }

  /**
   * Releases one listing on a connection of its own from the release channel, within RELEASE_DEADLINE_MS, counting the time it
   * takes to open that connection. Any failure is counted as pending: the listing is marked for the sweep and nothing is thrown.
   * A connection that opens only after the deadline still marks it, and is then closed.
   */
  private async releaseOn(id: string): Promise<'released' | 'absent' | 'pending'> {
    const deadline = Date.now() + RELEASE_DEADLINE_MS;
    const opening = this.releaseChannel.open();
    const link = await untilAt(opening.catch(() => undefined), deadline);
    if (!link) {
      void opening.then(async late => {
        await this.markForSweep(late.db, id);
        await late.close().catch(() => undefined);
      }, () => undefined);
      console.error(`snapshot listing ${id} was not released: no connection opened within ${RELEASE_DEADLINE_MS} ms; it is left for the sweep`);
      return 'pending';
    }
    try {
      return await this.dropOn(link.db, id, '', {}, deadline);
    } catch (error) {
      console.error(`snapshot listing ${id} was not released (${(error as Error).message}); it is left for the sweep`);
      await this.markForSweep(link.db, id);
      return 'pending';
    } finally {
      await link.close().catch(() => undefined);
    }
  }

  /**
   * Runs one transaction: a batch of statements that commits or does nothing. A conflict with a concurrent write is tried
   * again here. A refusal comes back to the caller, which decides what it means. Server time is added to `account`. Attempts
   * end at `until`: a statement still unanswered then is left to its connection, and the result is 'conflict'.
   */
  private async transact(db: Surreal, query: string, vars: Record<string, unknown>, account?: BuildAccount,
    until = Date.now() + TRANSACTION_WAIT_MS): Promise<{ outcome: 'done' | 'moved' | 'refused' | 'conflict' }> {
    for (let attempt = 0; Date.now() < until; attempt++) {
      const responses = await untilAt(db.query<unknown[]>(query, vars).responses(), until);
      if (!responses) return { outcome: 'conflict' };
      if (account) account.serverMs += responses.reduce((sum, response) => sum + serverMsOf(response.stats), 0);
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

  /**
   * Creates the quota record on first use, on the connection of the caller that first needs it. INSERT IGNORE leaves an
   * existing record, and its totals, as they are.
   */
  private ensureQuotaOn(db: Surreal): Promise<void> {
    this.quotaReady ??= (async () => {
      try {
        await db.query('INSERT IGNORE INTO query_snapshot_quota $rows;', {
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
