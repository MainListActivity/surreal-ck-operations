// Loopback test rig for the ops transport: a real TLS listener with a throwaway CA, a minimal
// OIDC login IdP (authorize -> password login -> PKCE token exchange) and a store-and-forward
// proxy that can hold, delay or reset connections. Runs under Bun and Node; nothing leaves 127.0.0.1
// and no key material is committed (the CA is generated per run in a temp directory).
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectTcp, createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';

export interface TestPki { ca: string; cert: string; key: string }

/** A CA and a 127.0.0.1 leaf for loopback TLS. Generated fresh per call; verification is never disabled. */
export function makeTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'sck-ops-tls-'));
  const openssl = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2',
    '-subj', '/CN=sck-ops-transport-test-ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=127.0.0.1']);
  writeFileSync(join(dir, 'leaf.ext'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'leaf.ext']);
  const pki = { ca: readFileSync(join(dir, 'ca.pem'), 'utf8'), cert: readFileSync(join(dir, 'leaf.pem'), 'utf8'), key: readFileSync(join(dir, 'leaf.key'), 'utf8') };
  // The key only has to live in memory: never leave throwaway key material behind in the temp directory.
  rmSync(dir, { recursive: true, force: true });
  return pki;
}

/** Milliseconds to hold the n-th accepted connection (1-based) before any byte reaches the IdP. */
export type HoldPolicy = (connection: number) => number;

export interface StallProxy { port: number; connections: () => number; close(): Promise<void> }

/** Store-and-forward TCP proxy: bytes that arrive during a hold are kept in user code, so the handshake is
 * held the same way under Node and Bun (a paused socket would lose them under Bun). */
export function startStallProxy(upstreamPort: number, holdFor: HoldPolicy = () => 0): Promise<StallProxy> {
  let count = 0;
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server: TcpServer = createTcpServer(client => {
    const id = ++count;
    sockets.add(client);
    const held: Buffer[] = [];
    let upstream: Socket | undefined;
    client.on('data', (chunk: Buffer) => { if (upstream) upstream.write(chunk); else held.push(chunk); });
    client.on('error', () => upstream?.destroy());
    client.on('close', () => { sockets.delete(client); upstream?.destroy(); });
    const release = () => {
      if (client.destroyed) return;
      upstream = connectTcp(upstreamPort, '127.0.0.1');
      for (const chunk of held.splice(0)) upstream.write(chunk);
      upstream.on('data', (chunk: Buffer) => client.write(chunk));
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => client.end());
    };
    const delay = holdFor(id);
    if (delay > 0) {
      const timer = setTimeout(() => { timers.delete(timer); release(); }, delay);
      timers.add(timer);
    } else release();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    resolve({
      port,
      connections: () => count,
      close: () => new Promise<void>(done => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
    });
  }));
}

export interface LoginIdpOptions {
  password: string;
  hold?: HoldPolicy;
  /**
   * Hold the n-th accepted connection of one hop before any byte reaches the IdP. Each hop gets its own listener and
   * port, like the three production origins (issuer / auth / product): a fresh TCP+TLS connect per hop is what makes a
   * connect stall on the last hop fatal in production, and this reproduces it per hop.
   */
  holdHop?: (hop: LoginHop, connection: number) => number;
  /** Consume the n-th password POST, then drop the socket so no answer reaches the client. */
  dropLogin?: (login: number) => boolean;
  /** HTTP status for a refused password; the reason stays `invalid_credentials`. */
  refuseStatus?: number;
  /** Milliseconds to delay the answer to the n-th password POST (1-based). */
  delayLogin?: (login: number) => number;
  /** The status the authorize route answers with instead of its redirect. */
  authorizeStatus?: number;
  /** Consume the n-th token exchange, then drop the socket so no answer reaches the client. */
  dropExchange?: (exchange: number) => boolean;
}

export type LoginHop = 'authorize' | 'login' | 'exchange';

export interface LoginIdp {
  /** Base URL the client uses for the issuer origin (authorize + login). */
  origin: string;
  /** Per-hop origins, so each hop's connection can be held independently. */
  origins: Record<LoginHop, string>;
  counts: { authorize: number; login: number; exchange: number; replays: number };
  /** The authorization codes the IdP issued. Every one of them is single use. */
  issuedCodes: string[];
  connections: () => number;
  close(): Promise<void>;
}

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A loopback OIDC login IdP behind per-hop stall proxies. The login route checks the password; the token route
 * checks the PKCE verifier and the single-use code, so a replayed or forged exchange fails. Each hop listens on its
 * own port, like production's issuer / auth / product origins, so every hop opens its own TCP+TLS connection. */
export async function startLoginIdp(pki: TestPki, options: LoginIdpOptions): Promise<LoginIdp> {
  const counts = { authorize: 0, login: 0, exchange: 0, replays: 0 };
  const issuedCodes: string[] = [];
  const usedCodes = new Set<string>();
  const challenges = new Map<string, { state: string; redirectUri: string; codeChallenge: string }>();
  const codes = new Map<string, { redirectUri: string; codeChallenge: string }>();
  // One listener per hop, each with its own connection counter: production reaches the issuer, the auth host and the
  // product over three separate origins, so every hop is a cold TCP+TLS connect that can stall on its own. The legacy
  // whole-proxy `hold` keeps one counter across all hops, so its connection numbers mean the same as before.
  const shared = { count: 0 };
  const holdFor = (hop: LoginHop): HoldPolicy => {
    if (options.holdHop) return connection => options.holdHop!(hop, connection);
    if (!options.hold) return () => 0;
    return () => options.hold!(++shared.count);
  };
  // The app listens first so the proxies have an upstream port; the login origin is fixed once its proxy exists.
  let loginOrigin = '';
  const app: HttpsServer = createHttpsServer({ key: pki.key, cert: pki.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'https://127.0.0.1');
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (req.method === 'GET' && url.pathname === '/t/ck/authorize') {
        counts.authorize++;
        if (options.authorizeStatus !== undefined) {
          json(res, options.authorizeStatus, { error: 'server_error' });
          return;
        }
        const challenge = `lc-${randomBytes(12).toString('base64url')}`;
        challenges.set(challenge, {
          state: url.searchParams.get('state') ?? '',
          redirectUri: url.searchParams.get('redirect_uri') ?? '',
          codeChallenge: url.searchParams.get('code_challenge') ?? '',
        });
        // Absolute URL to the login origin: production redirects from the issuer to auth.maplayer.top, and the client
        // builds the password API URL from this hop's origin, so the login hop gets its own connection.
        res.writeHead(302, { location: `${loginOrigin}/login/ck?login_challenge=${challenge}` });
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/login/ck/password') {
        const login = ++counts.login;
        const answer = () => {
          if (res.destroyed) return;
          const pending = challenges.get(form.get('login_challenge') ?? '');
          if (!pending) return json(res, 400, { error: 'login_challenge_unknown' });
          if (form.get('password') !== options.password) return json(res, options.refuseStatus ?? 401, { error: 'invalid_credentials' });
          challenges.delete(form.get('login_challenge') ?? '');
          if (options.dropLogin?.(login)) { req.socket.destroy(); return; }
          const code = `code-${randomBytes(16).toString('base64url')}`;
          codes.set(code, { redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge });
          issuedCodes.push(code);
          json(res, 200, { redirect_uri: `${pending.redirectUri}?code=${code}&state=${pending.state}` });
        };
        const delay = options.delayLogin?.(login) ?? 0;
        if (delay > 0) setTimeout(answer, delay); else answer();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/token') {
        const exchange = ++counts.exchange;
        const code = form.get('code') ?? '';
        const grant = codes.get(code);
        const verified = !!grant && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === grant.codeChallenge;
        codes.delete(code);
        if (grant) usedCodes.add(code);
        // A code that was already redeemed is a replay: it is refused, and counted.
        if (!grant && usedCodes.has(code)) counts.replays++;
        if (options.dropExchange?.(exchange)) { req.socket.destroy(); return; }
        if (!verified) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, { access_token: `at-${randomBytes(12).toString('base64url')}`, expires_in: 900, token_type: 'Bearer' });
      }
      json(res, 404, { error: 'not_found' });
    });
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', () => resolve()));
  const upstreamPort = (app.address() as { port: number }).port;
  const hops: Record<LoginHop, StallProxy> = {
    authorize: await startStallProxy(upstreamPort, holdFor('authorize')),
    login: await startStallProxy(upstreamPort, holdFor('login')),
    exchange: await startStallProxy(upstreamPort, holdFor('exchange')),
  };
  loginOrigin = `https://127.0.0.1:${hops.login.port}`;
  const total = () => hops.authorize.connections() + hops.login.connections() + hops.exchange.connections();
  return {
    // The issuer origin serves authorize; the auth origin serves the login route; the product origin serves exchange.
    origin: `https://127.0.0.1:${hops.authorize.port}`,
    origins: { authorize: `https://127.0.0.1:${hops.authorize.port}`, login: `https://127.0.0.1:${hops.login.port}`, exchange: `https://127.0.0.1:${hops.exchange.port}` },
    counts,
    issuedCodes,
    connections: total,
    close: async () => {
      await Promise.all(Object.values(hops).map(hop => hop.close()));
      app.closeAllConnections?.();
      await new Promise<void>(done => app.close(() => done()));
    },
  };
}

/** The broker config shape the login path reads, pointed at a loopback IdP with a separate origin per hop. */
export function loginBrokerConfig(origins: { authorize: string; login: string; exchange: string }): Record<string, unknown> {
  return {
    roles: ['qa', 'engineering'],
    idp: { issuer: `${origins.authorize}/t/ck`, clientId: 'client-ck-1234', audience: 'https://auth.test', redirectUri: 'https://app.test/auth/callback' },
    product: { url: origins.exchange },
    accounts: { prefix: 'sck-', emailDomain: 'example.test', workspacePrefix: 'sck-' },
    d1: { tenantId: 'tenant-ck-0001', databaseId: 'db-0000-0001' },
    data: { url: 'https://data.test', namespace: 'main' },
    limits: { workspacesPerDay: 2, accountsPerDay: 3 },
  };
}
