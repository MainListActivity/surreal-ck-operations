import { CompanyError } from '../core-errors.ts';
import type { BrokerConfig } from './config.ts';
import { describeTransportFailure, type Fetcher } from './fetcher.ts';

export const PRODUCT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ProductMethod = typeof PRODUCT_METHODS[number];

const REQUEST_TIMEOUT_MS = 30_000;
// Creating a workspace is a provisioning saga on the product (database, templates, owner, IdP scope) that can run for a
// minute or more. Cloudflare drops a silent origin at 120s and the employee's relay gives up at 120s, so this ends first.
const CREATE_WORKSPACE_TIMEOUT_MS = 90_000;
const CREATE_WORKSPACE_PATH = /^\/api\/workspaces\/?(\?|$)/;

/** How long one product request may take; only workspace creation gets more than the default. */
export function productTimeoutMs(method: string, path: string): number {
  return method.toUpperCase() === 'POST' && CREATE_WORKSPACE_PATH.test(path) ? CREATE_WORKSPACE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

/** The product could not be reached or did not answer in time, so the request may or may not have taken effect. */
export class ProductUnreachable extends CompanyError {
  constructor(message: string, readonly timedOut: boolean) {
    super('upstream_error', message, true);
  }
}

export interface ProductResult {
  status: number;
  ok: boolean;
  /** Parsed JSON when the upstream sent JSON, else text. Token fields are already stripped. */
  body: unknown;
  /** A scoped token the product minted (create/switch workspace); the caller swaps it into the session. */
  token?: { accessToken: string; expiresIn?: number };
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_CHARS = 200_000;
const PATH = /^\/api\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/;

/** Product API paths only: no other host, no traversal, never the token-exchange proxy. */
export function assertProductPath(path: unknown): string {
  if (typeof path !== 'string' || path.length > 2000 || !PATH.test(path)) throw new CompanyError('invalid', 'path must be a product API path starting with /api/');
  const pathname = path.split('?')[0]!;
  if (pathname.split('/').some(segment => segment === '..' || segment === '.') || pathname.includes('//') || /^\/api\/auth(\/|$)/.test(pathname)) {
    throw new CompanyError('invalid', 'path is not allowed');
  }
  return path;
}

export async function productRequest(
  config: BrokerConfig, accessToken: string,
  request: { method: string; path: string; body?: unknown },
  options: { fetch?: Fetcher; timeoutMs?: number } = {},
): Promise<ProductResult> {
  const method = request.method.toUpperCase();
  if (!PRODUCT_METHODS.includes(method as ProductMethod)) throw new CompanyError('invalid', `method must be one of ${PRODUCT_METHODS.join(', ')}`);
  const path = assertProductPath(request.path);
  let body: string | undefined;
  if (request.body !== undefined && method !== 'GET') {
    body = JSON.stringify(request.body);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new CompanyError('invalid', 'request body too large');
  }
  const timeoutMs = options.timeoutMs ?? productTimeoutMs(method, path);
  let response: Response;
  let raw: string;
  try {
    response = await (options.fetch ?? fetch)(`${config.product.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The limit covers the body too; any other body failure just leaves the status to speak.
    raw = (await response.text().catch((error: Error) => { if (error.name === 'TimeoutError') throw error; return ''; })).slice(0, MAX_RESPONSE_CHARS);
  } catch (error) {
    const { timedOut, detail } = describeTransportFailure(error, timeoutMs);
    const caveat = method === 'GET' ? '' : '; it may still have taken effect, so check before repeating it';
    throw new ProductUnreachable(`product request ${timedOut ? detail : `failed (${detail})`}${caveat}`, timedOut);
  }
  let parsed: unknown = raw;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { /* plain text or truncated JSON */ }

  let token: ProductResult['token'];
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const { accessToken: minted, expiresIn, ...rest } = parsed as Record<string, unknown>;
    if (typeof minted === 'string' && response.ok) {
      token = { accessToken: minted, expiresIn: typeof expiresIn === 'number' ? expiresIn : undefined };
      parsed = { ...rest, ...(expiresIn === undefined ? {} : { expiresIn }) };
    }
  }
  return { status: response.status, ok: response.ok, body: parsed, token };
}
