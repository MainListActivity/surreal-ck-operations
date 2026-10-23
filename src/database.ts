import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecordId, Surreal } from 'surrealdb';
import type { DatabaseConfig } from './config.ts';
import { CompanyError } from './core-errors.ts';
import type { SnapshotChannel, SnapshotLink } from './snapshot-store.ts';

const OWNER = 'surreal-ck-operations/issue-23/v1';

// Lazy: runtimes that only query (e.g. the Paseo plugin subprocess) may not have schema/ beside the bundle.
const loadSchema = (file: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', file), 'utf8');

/** Snapshot-build connections open at once across the process (SYS01 AC-D). A build that gets none within BUILD_QUEUE_MS is refused. */
export const MAX_BUILD_CONNECTIONS = 4;
const BUILD_QUEUE_MS = 2_000;
/**
 * How long a build connection may sit idle before it is closed instead of reused (SYS01 AC02, production return). A remote WSS
 * handshake costs seconds on the production link; reusing a warm socket for the next build removes that cost from the default
 * first-page path. The idle socket is probed with one cheap statement before reuse, so a socket the server closed in the meantime
 * is replaced rather than failing the build.
 */
const BUILD_IDLE_TTL_MS = 30_000;
/** Longest the reuse probe may take before the socket is treated as gone and a fresh one is opened. */
const BUILD_REUSE_PROBE_MS = 2_000;

export class CompanyDatabase {
  readonly db = new Surreal();
  constructor(readonly config: DatabaseConfig) {}

  async connect(): Promise<void> {
    // The WS engine resolves its open promise only on socket 'close'; a connect that
    // stalls without ever firing close would wedge startup/reconnect forever.
    await CompanyDatabase.withTimeout(
      this.db.connect(this.config.url, {
        authentication: { username: this.config.rootUser, password: this.config.rootPassword },
      }),
      15_000, 'db connect');
  }

  async bootstrap(): Promise<void> {
    const [rootInfo] = await this.db.query<[Record<string, unknown>]>('INFO FOR ROOT;');
    const namespaces = rootInfo.namespaces as Record<string, string> | undefined;
    let fresh = !namespaces?.[this.config.namespace];
    if (namespaces?.[this.config.namespace]) {
      await this.db.use({ namespace: this.config.namespace });
      const [nsInfo] = await this.db.query<[Record<string, unknown>]>('INFO FOR NS;');
      const databases = nsInfo.databases as Record<string, string> | undefined;
      if (!databases?.[this.config.database]) {
        const occupied = Object.values(nsInfo).some(value =>
          value !== null && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0
        );
        if (occupied) throw new Error('Target namespace has unrelated resources; refusing to alter it');
        await this.db.query(`DEFINE DATABASE ${this.config.database};`);
        fresh = true;
      }
      await this.db.use({ namespace: this.config.namespace, database: this.config.database });
      const [dbInfo] = await this.db.query<[Record<string, unknown>]>('INFO FOR DB;');
      const tables = dbInfo.tables as Record<string, string> | undefined;
      const tableNames = Object.keys(tables ?? {});
      if (tableNames.length === 0) {
        // 'quota' is server metadata reported by newer SurrealDB versions, not a user-defined resource.
        const otherDefinitions = Object.entries(dbInfo).filter(([kind, definitions]) =>
          kind !== 'tables' && kind !== 'quota' && definitions !== null && typeof definitions === 'object' &&
          Object.keys(definitions as Record<string, unknown>).length > 0
        );
        if (otherDefinitions.length > 0) {
          throw new Error('Target database has resources but no ownership marker; refusing to alter it');
        }
        fresh = true;
      } else if (!tableNames.includes('company_meta')) {
        throw new Error('Target database has tables but no ownership marker; refusing to alter it');
      } else {
        const [markers] = await this.db.query<[Array<{ owner: string }>]>(
          'SELECT owner FROM company_meta:installation;'
        );
        if (!markers?.[0] || markers[0].owner !== OWNER) {
          throw new Error('Target database ownership marker mismatch; refusing to alter it');
        }
      }
    } else {
      await this.db.query(`DEFINE NAMESPACE ${this.config.namespace};`);
      await this.db.use({ namespace: this.config.namespace });
      await this.db.query(`DEFINE DATABASE ${this.config.database};`);
      await this.db.use({ namespace: this.config.namespace, database: this.config.database });
    }
    await this.db.query(loadSchema('001-control.surql'));
    if (fresh) {
      await this.db.query('CREATE company_meta:installation CONTENT { owner: $owner, schema_version: 1 };', { owner: OWNER });
    }
    await this.ensureOutboxSequence();
    await this.db.query(loadSchema('002-outbox-sequence.surql'));
    await this.db.query(loadSchema('003-workforce.surql'));
    await this.db.query(loadSchema('004-eval.surql'));
    await this.db.query(loadSchema('005-jev.surql'));
    await this.db.query(loadSchema('006-flow.surql'));
    await this.db.query(loadSchema('007-gate.surql'));
    await this.db.query(loadSchema('008-content-roles.surql'));
    await this.db.query(loadSchema('009-discipline-tracks.surql'));
    await this.db.query(loadSchema('010-instruct.surql'));
    await this.db.query(loadSchema('010-internal-ai-proof.surql'));
    await this.db.query(loadSchema('011-worktrees.surql'));
    await this.db.query(loadSchema('012-worktree-lifecycle.surql'));
    await this.db.query(loadSchema('013-screenwriter-role.surql'));
    await this.db.query(loadSchema('014-task-project-overlay.surql'));
    await this.db.query(loadSchema('014-worktree-scene.surql'));
    await this.db.query(loadSchema('015-screenplay-revisions.surql'));
    await this.db.query(loadSchema('016-worktree-lane.surql'));
    await this.db.query(loadSchema('017-code-repo-binding.surql'));
    await this.db.query(loadSchema('018-pipeline.surql'));
    await this.db.query(loadSchema('019-story-author-role.surql'));
    await this.db.query(loadSchema('020-cinematography-role.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 20 WHERE schema_version < 20;');
    // The SYS01 snapshot schemas follow main's 021 (worktree audit events) and 022 (def quota limits).
    await this.db.query(loadSchema('021-worktree-audit-events.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 21 WHERE schema_version < 21;');
    await this.db.query(loadSchema('022-def-quota-limited.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 22 WHERE schema_version < 22;');
    await this.db.query(loadSchema('023-query-snapshot.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 23 WHERE schema_version < 23;');
    await this.db.query(loadSchema('024-snapshot-quota.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 24 WHERE schema_version < 24;');
    // QA 受限只读取证（SYS-DISP 7454fc89）：025/026 由在办 lane 预占，本 lane 取 027；仅新增表。
    await this.db.query(loadSchema('027-qa-observation.surql'));
    await this.db.query(loadSchema('032-model-routing.surql'));
    await this.db.query(loadSchema('033-four-tier-routing.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 27 WHERE schema_version < 27;');
  }

  private async ensureOutboxSequence(): Promise<void> {
    const counter = new RecordId('company_meta', 'outbox_counter');
    if (await this.db.select(counter)) {
      const marker = await this.db.select<{ schema_version: number }>(new RecordId('company_meta', 'installation'));
      if (marker && marker.schema_version < 2) {
        await this.db.query('UPDATE company_meta:installation SET schema_version = 2;');
      }
      return;
    }
    const [events] = await this.db.query<[Array<{ id: RecordId }>]>(
      'SELECT id, at FROM outbox ORDER BY at, id;'
    );
    for (const [index, event] of events.entries()) {
      await this.db.query('UPDATE $event SET sequence = $sequence;', {
        event: event.id, sequence: index + 1,
      });
    }
    await this.db.query('CREATE $counter CONTENT { value: $value };', {
      counter, value: events.length,
    });
    await this.db.query('UPDATE company_meta:installation SET schema_version = 2;');
  }

  /** Selects the configured namespace/database without touching schema (runtimes that only query). */
  async useDatabase(): Promise<void> {
    await this.db.use({ namespace: this.config.namespace, database: this.config.database });
  }

  private reconnecting: Promise<void> | undefined;
  private keepalive: ReturnType<typeof setInterval> | undefined;

  /** Remote WSS rots silently while idle (peer times out, local socket stays ESTABLISHED);
   *  probe periodically so a dead connection is rebuilt before a request walks into it. */
  private ensureKeepalive(): void {
    if (this.keepalive) return;
    this.keepalive = setInterval(() => { void this.ensureConnected().catch(() => {}); }, 25_000);
    this.keepalive.unref?.();
  }

  /** Half-open WSS (peer gone, local socket still ESTABLISHED) makes a query hang forever;
   *  bound every step so a dead connection fails fast and rebuilds instead of wedging callers. */
  private static withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      promise.then(v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); });
    });
  }

  /** Probes the connection; on failure rebuilds it. The SDK may silently re-establish the WS
   *  transport while dropping ns/db/auth session state, so the probe must require scope. */
  async ensureConnected(): Promise<void> {
    this.ensureKeepalive();
    this.reconnecting ??= (async () => {
      try {
        await CompanyDatabase.withTimeout(this.db.query('INFO FOR DB;'), 10_000, 'db probe');
      } catch (probeError) {
        try {
          await CompanyDatabase.withTimeout(this.db.close().catch(() => {}), 5_000, 'db close').catch(() => {});
          await CompanyDatabase.withTimeout(this.connect(), 15_000, 'db connect');
          await CompanyDatabase.withTimeout(this.useDatabase(), 10_000, 'db use');
          console.log(`database connection re-established (was: ${(probeError as Error).message.slice(0, 80)})`);
        } catch (error) {
          console.error(`database reconnect failed: ${(error as Error).message}`);
          throw error;
        }
      } finally {
        this.reconnecting = undefined;
      }
    })();
    return this.reconnecting;
  }

  private readonly buildSockets = new Set<Surreal>();
  /** Open build sockets that are not checked out, newest last. They count toward MAX_BUILD_CONNECTIONS with the active ones. */
  private readonly idleBuildSockets: Array<{ socket: Surreal; since: number }> = [];
  private buildSlotsInUse = 0;
  private readonly buildSlotWaiters: Array<() => void> = [];
  private closing = false;

  /**
   * The connections snapshot builds run on (SYS01 AC-D): a socket of their own for each read attempt, to the same namespace and
   * database. A large build then never queues ahead of control requests on the main socket, and an attempt that is abandoned or
   * cancelled closes only its own socket. At most MAX_BUILD_CONNECTIONS are open at once across the process: a socket keeps its
   * slot until it is closed, and a build that gets no slot within BUILD_QUEUE_MS is refused as temporarily_unavailable.
   */
  readonly buildChannel: SnapshotChannel = {
    open: async (): Promise<SnapshotLink> => {
      if (this.closing) throw new CompanyError('temporarily_unavailable', 'the database is closing; retry shortly', true);
      // Reuse a warm socket when one is idle: on the production WSS link a handshake costs seconds, and a build that pays it on
      // every first page cannot answer within its deadline (SYS01 AC02 production return).
      const warm = await this.takeIdleBuildSocket();
      if (warm) return this.linkFor(warm);
      await this.takeBuildSlot();
      if (this.closing) {
        this.freeBuildSlot();
        throw new CompanyError('temporarily_unavailable', 'the database is closing; retry shortly', true);
      }
      // A socket may have gone idle while this build waited for a slot: take it rather than opening another.
      const raced = await this.takeIdleBuildSocket(true);
      if (raced) return this.linkFor(raced);
      const socket = new Surreal();
      this.buildSockets.add(socket);
      const opening = this.openSocket(socket);
      try {
        await CompanyDatabase.withTimeout(opening, 15_000, 'build connect');
      } catch (error) {
        // The timeout does not cancel the connect. A socket that opens after its slot was freed is closed at once, so it cannot
        // outlive the build cap.
        void opening.then(() => this.closeLateSocket(socket), () => undefined);
        await this.closeBuildSocket(socket);
        throw error;
      }
      return this.linkFor(socket);
    },
  };

  /** The link a build holds: `close` drops the socket, `release` returns it warm for the next build. */
  private linkFor(socket: Surreal): SnapshotLink {
    return {
      db: socket,
      close: () => this.closeBuildSocket(socket),
      release: () => this.releaseBuildSocket(socket),
    };
  }

  /**
   * Pops one warm socket, closing the ones past BUILD_IDLE_TTL_MS. `holdsSlot` is true when the caller already owns an active slot
   * (the slot is handed over to this socket); otherwise the idle socket becomes active here. Returns undefined when none is usable.
   */
  private async takeIdleBuildSocket(holdsSlot = false): Promise<Surreal | undefined> {
    while (this.idleBuildSockets.length > 0) {
      const entry = this.idleBuildSockets.pop()!;
      if (this.closing || Date.now() - entry.since > BUILD_IDLE_TTL_MS) {
        await this.closeIdleBuildSocket(entry.socket);
        continue;
      }
      // One cheap statement proves the socket is still alive: a server that dropped the idle connection fails here, not in the build.
      const alive = await CompanyDatabase.withTimeout(
        entry.socket.query('RETURN true;').then(() => true, () => false), BUILD_REUSE_PROBE_MS, 'build reuse probe',
      ).catch(() => false);
      if (!alive) {
        await this.closeIdleBuildSocket(entry.socket);
        continue;
      }
      if (!holdsSlot) this.buildSlotsInUse++;
      return entry.socket;
    }
    return undefined;
  }

  /** Returns a build socket to the idle set; its slot is freed for the next waiter. A closing pool or a full idle set drops it. */
  private async releaseBuildSocket(socket: Surreal): Promise<void> {
    if (this.closing || !this.buildSockets.has(socket)) {
      await this.closeBuildSocket(socket);
      return;
    }
    this.idleBuildSockets.push({ socket, since: Date.now() });
    this.freeBuildSlot();
  }

  private async closeIdleBuildSocket(socket: Surreal): Promise<void> {
    if (!this.buildSockets.delete(socket)) return;
    await CompanyDatabase.withTimeout(socket.close().catch(() => {}), 5_000, 'idle build close').catch(() => undefined);
  }

  private readonly releaseSockets = new Set<Surreal>();

  /**
   * The connections releases and sweeps of listings run on, one for each, outside the build cap. A saturated build pool must not
   * hold back a release: a listing that is not released holds its quota until it expires.
   */
  readonly releaseChannel: SnapshotChannel = {
    open: async (): Promise<SnapshotLink> => {
      if (this.closing) throw new CompanyError('temporarily_unavailable', 'the database is closing; retry shortly', true);
      const socket = new Surreal();
      this.releaseSockets.add(socket);
      const opening = this.openSocket(socket);
      try {
        await CompanyDatabase.withTimeout(opening, 15_000, 'release connect');
      } catch (error) {
        void opening.then(() => this.closeLateSocket(socket), () => undefined);
        await this.closeReleaseSocket(socket);
        throw error;
      }
      return { db: socket, close: () => this.closeReleaseSocket(socket) };
    },
  };

  /**
   * Build connections open (active and idle), the slots checked out, the idle sockets kept warm, and the builds waiting for a slot
   * (for the tests and the measurements). `open` stays within MAX_BUILD_CONNECTIONS; after a build its slot returns to 0 while its
   * socket may stay warm until BUILD_IDLE_TTL_MS.
   */
  buildConnectionStats(): { open: number; slotsInUse: number; idle: number; queued: number } {
    return { open: this.buildSockets.size, slotsInUse: this.buildSlotsInUse, idle: this.idleBuildSockets.length, queued: this.buildSlotWaiters.length };
  }

  /** Takes a build slot now, or waits for one that a closing socket frees; a slot passes straight to the first waiter. */
  private takeBuildSlot(): Promise<void> {
    if (this.buildSlotsInUse + this.idleBuildSockets.length < MAX_BUILD_CONNECTIONS) {
      this.buildSlotsInUse++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.buildSlotWaiters.indexOf(waiter);
        if (index >= 0) this.buildSlotWaiters.splice(index, 1);
        reject(new CompanyError('temporarily_unavailable',
          `snapshot builds are busy: ${MAX_BUILD_CONNECTIONS} are running and none finished within ${BUILD_QUEUE_MS / 1000} seconds; narrow the query with state, goalId, role or since, then retry`, true));
      }, BUILD_QUEUE_MS);
      this.buildSlotWaiters.push(waiter);
    });
  }

  private freeBuildSlot(): void {
    const next = this.buildSlotWaiters.shift();
    if (next) next();
    else this.buildSlotsInUse--;
  }

  private async openSocket(socket: Surreal): Promise<void> {
    await socket.connect(this.config.url, {
      authentication: { username: this.config.rootUser, password: this.config.rootPassword },
    });
    await socket.use({ namespace: this.config.namespace, database: this.config.database });
  }

  private async closeBuildSocket(socket: Surreal): Promise<void> {
    // Only the call that finds the socket still open closes it and frees its slot, so a link closed twice frees its slot once.
    if (!this.buildSockets.delete(socket)) return;
    try {
      await CompanyDatabase.withTimeout(socket.close().catch(() => {}), 5_000, 'build close').catch(() => {});
    } finally {
      this.freeBuildSlot();
    }
  }

  private async closeReleaseSocket(socket: Surreal): Promise<void> {
    if (!this.releaseSockets.delete(socket)) return;
    await CompanyDatabase.withTimeout(socket.close().catch(() => {}), 5_000, 'release close').catch(() => {});
  }

  /** Closes a socket whose connect finished after its owner had given up on it. Best effort, and bounded like the other closes. */
  private async closeLateSocket(socket: Surreal): Promise<void> {
    await CompanyDatabase.withTimeout(socket.close().catch(() => {}), 5_000, 'late close').catch(() => {});
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.keepalive);
    this.keepalive = undefined;
    this.idleBuildSockets.length = 0;
    await Promise.all([...this.buildSockets].map(socket => this.closeBuildSocket(socket)));
    await Promise.all([...this.releaseSockets].map(socket => this.closeReleaseSocket(socket)));
    // engine.close() awaits a 'disconnected' event that never arrives when the peer
    // silently dropped (close frame sent, no reply) — bound it so shutdown can't wedge.
    await CompanyDatabase.withTimeout(this.db.close(), 5_000, 'db close').catch(() => {});
  }
}
