import { CompanyError } from '../core-errors.ts';
import { opsFetch, type Fetcher } from './fetcher.ts';

export interface D1Client {
  /** One parameterised statement; returns result rows (empty for writes). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface D1Options {
  accountId: string;
  databaseId: string;
  token: string;
  /** Overridden by tests; Cloudflare's v4 API root otherwise. */
  baseUrl?: string;
  fetch?: Fetcher;
  timeoutMs?: number;
}

/**
 * Cloudflare D1 REST. The token only ever lives in the control-plane process; callers build
 * fixed SQL with bound parameters, so employees cannot reach arbitrary statements.
 */
export function cloudflareD1(options: D1Options): D1Client {
  const fetcher = options.fetch ?? opsFetch;
  const url = `${(options.baseUrl ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '')}/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}/query`;
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      let response: Response;
      try {
        response = await fetcher(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ sql, params }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        });
      } catch (error) {
        throw new CompanyError('upstream_error', `D1 request failed: ${(error as Error).name}`, true);
      }
      const body = await response.json().catch(() => undefined) as
        { success?: boolean; errors?: Array<{ code?: number; message?: string }>; result?: Array<{ results?: T[] }> } | undefined;
      if (!response.ok || !body?.success) {
        const detail = body?.errors?.map(e => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') || `HTTP ${response.status}`;
        // Constraint violations carry the statement's own column names, never credentials.
        throw new CompanyError(/UNIQUE constraint/i.test(detail) ? 'conflict' : 'upstream_error', `D1 query failed: ${detail.slice(0, 200)}`, response.status >= 500);
      }
      return body.result?.[0]?.results ?? [];
    },
  };
}
