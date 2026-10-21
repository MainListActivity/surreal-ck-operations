import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecordId, Surreal } from 'surrealdb';
import type { DatabaseConfig } from './config.ts';

const OWNER = 'surreal-ck-operations/issue-23/v1';

// Lazy: runtimes that only query (e.g. the Paseo plugin subprocess) may not have schema/ beside the bundle.
const loadSchema = (file: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', file), 'utf8');

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
    await this.db.query(loadSchema('021-worktree-audit-events.surql'));
    await this.db.query(loadSchema('022-def-quota-limited.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 22 WHERE schema_version < 22;');
    // SYS-DISP afdb562c: the dispatch pause ledger and gate. Renumbered to 023 when main took 022 for the quota-limited
    // defs; both migrations are additive, so the order only decides which runs first.
    await this.db.query(loadSchema('023-dispatch-pause.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 23 WHERE schema_version < 23;');
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

  async close(): Promise<void> {
    clearInterval(this.keepalive);
    this.keepalive = undefined;
    // engine.close() awaits a 'disconnected' event that never arrives when the peer
    // silently dropped (close frame sent, no reply) — bound it so shutdown can't wedge.
    await CompanyDatabase.withTimeout(this.db.close(), 5_000, 'db close').catch(() => {});
  }
}
