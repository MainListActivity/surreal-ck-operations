// The connection to one SurrealDB namespace and database: connect, log in, select the namespace and database, run queries.
// It takes its settings as arguments and reads no configuration, environment variable or path (database.ts does that), so the
// same code runs in a Worker and on the local machine.
import type { Surreal } from 'surrealdb';

/** How a connection logs in: a system account, or a token that `getToken` supplies at each login. */
export type DbAuth =
  | { kind: 'root'; username: string; password: string }
  | { kind: 'token'; getToken: () => Promise<string> };

/** Where a connection goes: the server, the namespace and database to select, and how it logs in. */
export interface DbTarget {
  url: string;
  namespace: string;
  database: string;
  auth: DbAuth;
}

/**
 * Connects a client and logs it in. A root login passes its account to the connect call. A token login connects first and then
 * authenticates with the token from `getToken`. Selects no namespace or database.
 */
export async function connectDb(db: Surreal, target: DbTarget): Promise<void> {
  const { auth } = target;
  if (auth.kind === 'root') {
    await db.connect(target.url, { authentication: { username: auth.username, password: auth.password } });
    return;
  }
  await db.connect(target.url);
  await db.authenticate(await auth.getToken());
}

/** Selects the target's namespace and database on a connected client. */
export async function useDb(db: Surreal, target: DbTarget): Promise<void> {
  await db.use({ namespace: target.namespace, database: target.database });
}

/** Connects and logs in a client, then selects the target's namespace and database. */
export async function openDb(db: Surreal, target: DbTarget): Promise<void> {
  await connectDb(db, target);
  await useDb(db, target);
}

/** Runs SurrealQL on a connected client; awaited, it yields one result per statement, typed by `T`. */
export function queryDb<T extends unknown[]>(db: Surreal, sql: string, vars?: Record<string, unknown>) {
  return db.query<T>(sql, vars);
}
