import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Surreal } from 'surrealdb';
import { connectDb, openDb, queryDb, useDb, type DbTarget } from '../src/db-connection.ts';

setDefaultTimeout(60000);

// ---- Recording stand-in for the SDK client: every call, in order ----
type Call = { method: string; args: unknown[] };
function fakeClient(rows: unknown[] = []) {
  const calls: Call[] = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return Promise.resolve();
  };
  const client = {
    connect: record('connect'),
    authenticate: record('authenticate'),
    use: record('use'),
    query: (sql: string, vars?: unknown) => {
      calls.push({ method: 'query', args: [sql, vars] });
      return Promise.resolve(rows);
    },
  };
  return { client: client as unknown as Surreal, calls };
}

const target = (auth: DbTarget['auth']): DbTarget => ({
  url: 'ws://127.0.0.1:1/rpc', namespace: 'company_ns', database: 'control_plane', auth,
});

test('root login passes the account to connect, then selects the namespace and database', async () => {
  const { client, calls } = fakeClient();
  await openDb(client, target({ kind: 'root', username: 'root', password: 'fixture-root' }));
  expect(calls).toEqual([
    { method: 'connect', args: ['ws://127.0.0.1:1/rpc', { authentication: { username: 'root', password: 'fixture-root' } }] },
    { method: 'use', args: [{ namespace: 'company_ns', database: 'control_plane' }] },
  ]);
});

test('token login connects without credentials, authenticates with the token from getToken, then selects the database', async () => {
  const { client, calls } = fakeClient();
  let issued = 0;
  await openDb(client, target({ kind: 'token', getToken: async () => { issued++; return 'fixture-token'; } }));
  expect(issued).toBe(1);
  expect(calls).toEqual([
    { method: 'connect', args: ['ws://127.0.0.1:1/rpc'] },
    { method: 'authenticate', args: ['fixture-token'] },
    { method: 'use', args: [{ namespace: 'company_ns', database: 'control_plane' }] },
  ]);
});

test('a token that cannot be fetched stops the login before anything is authenticated or selected', async () => {
  const { client, calls } = fakeClient();
  await expect(openDb(client, target({ kind: 'token', getToken: async () => { throw new Error('token service down'); } })))
    .rejects.toThrow('token service down');
  expect(calls.map(call => call.method)).toEqual(['connect']);
});

test('connectDb only logs in; useDb selects the namespace and database on the connected client', async () => {
  const { client, calls } = fakeClient();
  const auth = { kind: 'root' as const, username: 'root', password: 'fixture-root' };
  await connectDb(client, target(auth));
  expect(calls.map(call => call.method)).toEqual(['connect']);
  await useDb(client, target(auth));
  expect(calls.at(-1)).toEqual({ method: 'use', args: [{ namespace: 'company_ns', database: 'control_plane' }] });
});

test('queryDb runs the SQL with its bindings and resolves to the per-statement results', async () => {
  const { client, calls } = fakeClient([[{ id: 1 }], []]);
  const result = await queryDb<[Array<{ id: number }>, unknown[]]>(client, 'SELECT id FROM item WHERE kind = $kind;', { kind: 'x' });
  expect(calls).toEqual([{ method: 'query', args: ['SELECT id FROM item WHERE kind = $kind;', { kind: 'x' }] }]);
  expect(result).toEqual([[{ id: 1 }], []]);
});

// ---- Real server: an isolated fork on a private RocksDB store, like the other fork tests ----
const run = process.env.RUN_SCK_DB_CONNECTION_TESTS === '1' ? test : test.skip;
const ROOT_PASSWORD = 'fixture-only';
const NAMESPACE = 'db_connection_fixture';
const DATABASE = 'control_plane';
const USER = 'connection_fixture';
const USER_PASSWORD = 'fixture-user-only';
let dir: string, server: ReturnType<typeof Bun.spawn>, url: string;
const serverTarget = (auth: DbTarget['auth']): DbTarget => ({ url, namespace: NAMESPACE, database: DATABASE, auth });

beforeAll(async () => {
  if (process.env.RUN_SCK_DB_CONNECTION_TESTS !== '1') return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sck-db-connection-')));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = listener.port!; listener.stop(true);
  url = `ws://127.0.0.1:${port}/rpc`;
  server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD, '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
  // Define the namespace, the database and one database user as root, then drop the root session.
  const admin = new Surreal();
  await connectDb(admin, serverTarget({ kind: 'root', username: 'root', password: ROOT_PASSWORD }));
  await admin.query(`DEFINE NAMESPACE ${NAMESPACE};`);
  await admin.use({ namespace: NAMESPACE });
  await admin.query(`DEFINE DATABASE ${DATABASE};`);
  await admin.use({ namespace: NAMESPACE, database: DATABASE });
  await admin.query(`DEFINE USER ${USER} ON DATABASE PASSWORD '${USER_PASSWORD}' ROLES EDITOR;`);
  await admin.close();
});

afterAll(async () => {
  if (!dir) return;
  server.kill(); await server.exited;
  rmSync(dir, { recursive: true, force: true });
});

run('root login reaches the namespace and database and reads and writes there', async () => {
  const db = new Surreal();
  try {
    await openDb(db, serverTarget({ kind: 'root', username: 'root', password: ROOT_PASSWORD }));
    await queryDb(db, "UPSERT connection_probe:root CONTENT { via: 'root' };");
    const [rows] = await queryDb<[Array<{ via: string }>]>(db, 'SELECT via FROM connection_probe:root;');
    expect(rows).toEqual([{ via: 'root' }]);
  } finally {
    await db.close();
  }
});

run('token login authenticates with a token the database user was issued, then reads the database', async () => {
  const issuer = new Surreal();
  let token: string;
  try {
    await connectDb(issuer, { url, namespace: NAMESPACE, database: DATABASE, auth: { kind: 'root', username: 'root', password: ROOT_PASSWORD } });
    token = (await issuer.signin({ namespace: NAMESPACE, database: DATABASE, username: USER, password: USER_PASSWORD })).access;
  } finally {
    await issuer.close();
  }
  const db = new Surreal();
  try {
    await openDb(db, serverTarget({ kind: 'token', getToken: async () => token }));
    await queryDb(db, "UPSERT connection_probe:token CONTENT { via: 'token' };");
    const [rows] = await queryDb<[Array<{ via: string }>]>(db, 'SELECT via FROM connection_probe:token;');
    expect(rows).toEqual([{ via: 'token' }]);
  } finally {
    await db.close();
  }
});

run('wrong root password and a rejected token both fail the login', async () => {
  const wrongRoot = new Surreal();
  try {
    await expect(connectDb(wrongRoot, serverTarget({ kind: 'root', username: 'root', password: 'not-the-password' }))).rejects.toThrow();
  } finally {
    await wrongRoot.close();
  }
  const badToken = new Surreal();
  try {
    await expect(connectDb(badToken, serverTarget({ kind: 'token', getToken: async () => 'not-a-token' }))).rejects.toThrow();
  } finally {
    await badToken.close();
  }
});
