import { Surreal } from 'surrealdb';
import { CompanyError } from '../core-errors.ts';

/** Runs SurrealQL as the session's user against one workspace database; the user's token decides what is visible. */
export type QueryAsUser = (input: {
  url: string;
  namespace: string;
  database: string;
  token: string;
  sql: string;
  vars?: Record<string, unknown>;
}) => Promise<unknown[]>;

const TIMEOUT_MS = 30_000;

/** The SDK speaks the same websocket protocol as the product's own web client. */
export const surrealQueryAsUser: QueryAsUser = async ({ url, namespace, database, token, sql, vars }) => {
  const db = new Surreal();
  const work = (async () => {
    await db.connect(`${url.replace(/^http/, 'ws')}/rpc`);
    await db.use({ namespace, database });
    await db.authenticate(token);
    return await db.query(sql, vars) as unknown[];
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CompanyError('upstream_error', 'workspace query timed out', true)), TIMEOUT_MS); }),
    ]);
  } catch (error) {
    if (error instanceof CompanyError) throw error;
    // SDK errors can quote the statement or token; relay only the error class.
    throw new CompanyError('upstream_error', `workspace query failed (${(error as Error).name}): ${String((error as Error).message).replace(/eyJ[\w.-]+/g, '[redacted]').slice(0, 300)}`);
  } finally {
    if (timer) clearTimeout(timer);
    await db.close().catch(() => undefined);
  }
};
