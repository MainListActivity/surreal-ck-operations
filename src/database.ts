import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RecordId, Surreal } from 'surrealdb';
import type { DatabaseConfig } from './config.ts';

const OWNER = 'surreal-ck-operations/issue-23/v1';
const SCHEMA = readFileSync(fileURLToPath(new URL('../schema/001-control.surql', import.meta.url)), 'utf8');
const OUTBOX_INDEX = readFileSync(fileURLToPath(new URL('../schema/002-outbox-sequence.surql', import.meta.url)), 'utf8');
const WORKFORCE = readFileSync(fileURLToPath(new URL('../schema/003-workforce.surql', import.meta.url)), 'utf8');
const EVAL = readFileSync(fileURLToPath(new URL('../schema/004-eval.surql', import.meta.url)), 'utf8');

export class CompanyDatabase {
  readonly db = new Surreal();
  constructor(readonly config: DatabaseConfig) {}

  async connect(): Promise<void> {
    await this.db.connect(this.config.url, {
      authentication: { username: this.config.rootUser, password: this.config.rootPassword },
    });
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
    await this.db.query(SCHEMA);
    if (fresh) {
      await this.db.query('CREATE company_meta:installation CONTENT { owner: $owner, schema_version: 1 };', { owner: OWNER });
    }
    await this.ensureOutboxSequence();
    await this.db.query(OUTBOX_INDEX);
    await this.db.query(WORKFORCE);
    await this.db.query(EVAL);
    await this.db.query('UPDATE company_meta:installation SET schema_version = 4 WHERE schema_version < 4;');
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

  async close(): Promise<void> { await this.db.close(); }
}
