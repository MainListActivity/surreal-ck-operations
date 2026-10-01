import { CompanyError } from '../core-errors.ts';
import type { BrokerConfig } from './config.ts';
import type { Fetcher } from './fetcher.ts';

export const PRODUCT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ProductMethod = typeof PRODUCT_METHODS[number];

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
  options: { fetch?: Fetcher } = {},
): Promise<ProductResult> {
  const method = request.method.toUpperCase();
  if (!PRODUCT_METHODS.includes(method as ProductMethod)) throw new CompanyError('invalid', `method must be one of ${PRODUCT_METHODS.join(', ')}`);
  const path = assertProductPath(request.path);
  let body: string | undefined;
  if (request.body !== undefined && method !== 'GET') {
    body = JSON.stringify(request.body);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new CompanyError('invalid', 'request body too large');
  }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${config.product.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new CompanyError('upstream_error', `product request failed (${(error as Error).name})`, true);
  }
  const raw = (await response.text().catch(() => '')).slice(0, MAX_RESPONSE_CHARS);
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
