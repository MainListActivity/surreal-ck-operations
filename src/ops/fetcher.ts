/** The undici surface used here. Loaded with require, not import: a typed import would pull undici's own typings
 * into every program, where their globals clash with the plugin's lib set. The subpath keeps Bun on the real
 * package; the bare 'undici' name resolves to Bun's built-in shim, whose Agent has no close() and ignores connect options. */
interface UndiciModule {
  Agent: new (options: { connect: { timeout: number; ca?: string } }) => { close(): Promise<void> };
  fetch(input: string | URL | Request, init?: RequestInit & { dispatcher?: unknown }): Promise<Response>;
}
const { Agent, fetch: undiciFetch } = require('undici/index.js') as UndiciModule;

/** The slice of `fetch` the broker uses; plain functions satisfy it (Bun's `typeof fetch` also demands `preconnect`). */
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * A fetcher that can also be asked for a shorter connect limit.
 *
 * The production login path needs two connect limits at once: the standing one (20 s) for a normal hop, and a
 * short one for the first attempts of a hop whose connection never came up. A connect that has not been established
 * carries no request, so cutting it early costs nothing — while waiting the full 20 s per attempt burns the flow's
 * whole budget on connections that never existed.
 */
export interface ConnectAwareFetcher extends Fetcher {
  /** A fetcher on the same trust anchors, with the connect limit given here. */
  withConnectTimeout: (connectTimeoutMs: number) => Fetcher;
}

/** Secret-free wording for a request that threw, naming the limit when a timeout was the cause. */
export function describeTransportFailure(error: unknown, timeoutMs: number): { timedOut: boolean; detail: string } {
  const err = error as (Error & { cause?: unknown }) | undefined;
  const name = err?.name ?? 'Error';
  if (name === 'TimeoutError') {
    return { timedOut: true, detail: `timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}` };
  }
  // Node fetch reports network failures as TypeError('fetch failed') with the real reason on
  // `cause` (ECONNRESET, UND_ERR_SOCKET, ENOTFOUND, ...). Only the errno-style code is safe to
  // relay: the messages themselves can quote request details such as the Authorization header.
  const causeCode = typeof (err?.cause as { code?: unknown } | undefined)?.code === 'string'
    ? (err!.cause as { code: string }).code
    : '';
  return { timedOut: false, detail: causeCode ? `${name} ${causeCode}` : name };
}

/** The errno-style code of a transport failure, when the runtime reported one. */
export function transportErrno(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

/**
 * Node's global fetch keeps undici's default connect limit of 10 s for DNS, TCP and TLS together, so a slow
 * but healthy handshake is cut before any step budget applies (reproduced on Node 24: 10.5 s, while the
 * request signal allowed 25 s). Ops traffic gets an explicit, longer limit on its own dispatcher instead.
 * It stays below the 25 s per-request limit, and every request still carries its own signal.
 */
export const OPS_CONNECT_TIMEOUT_MS = 20_000;

export interface OpsFetchOptions {
  /** Upper bound for DNS, TCP and TLS setup of one connection. */
  connectTimeoutMs?: number;
  /** Extra trust anchors (PEM). Tests only: production uses the system store and verification stays on. */
  ca?: string;
}

/** A Fetcher on a private undici dispatcher. `close` releases that dispatcher's sockets. */
export function createOpsFetcher(options: OpsFetchOptions = {}): ConnectAwareFetcher & { close(): Promise<void> } {
  const connectTimeoutMs = options.connectTimeoutMs ?? OPS_CONNECT_TIMEOUT_MS;
  const make = (timeoutMs: number) => new Agent({
    connect: { timeout: timeoutMs, ...(options.ca ? { ca: options.ca } : {}) },
  });
  const dispatcher = make(connectTimeoutMs);
  // One dispatcher per connect limit: the short-limit attempts must not wait behind the standing one, and each
  // dispatcher keeps its own connection pool, so a short attempt really opens a fresh connection.
  const shortLimit = new Map<number, ReturnType<typeof make>>();
  const fetcher = (input: string | URL | Request, init?: RequestInit) => undiciFetch(input, { ...init, dispatcher });
  const withConnectTimeout = (ms: number): Fetcher => {
    if (ms === connectTimeoutMs) return fetcher;
    let agent = shortLimit.get(ms);
    if (!agent) { agent = make(ms); shortLimit.set(ms, agent); }
    const short = (input: string | URL | Request, init?: RequestInit) => undiciFetch(input, { ...init, dispatcher: agent });
    return short;
  };
  return Object.assign(fetcher, {
    withConnectTimeout,
    close: async () => {
      await dispatcher.close();
      for (const agent of shortLimit.values()) await agent.close().catch(() => undefined);
    },
  });
}

let shared: (ConnectAwareFetcher & { close(): Promise<void> }) | undefined;
/**
 * The transport every ops HTTP call uses unless a caller injects one. Created on first use, so importing an ops module
 * opens no socket.
 */
export const opsFetch: ConnectAwareFetcher = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => (shared ??= createOpsFetcher())(input, init),
  {
    withConnectTimeout: (connectTimeoutMs: number): Fetcher => (shared ??= createOpsFetcher()).withConnectTimeout(connectTimeoutMs),
  },
);

const TLS_TRUST_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED',
]);

/**
 * A certificate that does not chain to a trusted root fails the same way on every attempt, so it is final
 * rather than transient. Matched on runtime codes and messages; the messages are never relayed.
 */
export function isTlsTrustFailure(error: unknown): boolean {
  const failure = error as { message?: unknown; cause?: { code?: unknown; message?: unknown } } | undefined;
  if (typeof failure?.cause?.code === 'string' && TLS_TRUST_CODES.has(failure.cause.code)) return true;
  return [failure?.message, failure?.cause?.message].some(text => typeof text === 'string' && /certificate|self[- ]signed/i.test(text));
}
