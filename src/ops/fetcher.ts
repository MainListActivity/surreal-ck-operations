/** The slice of `fetch` the broker uses; plain functions satisfy it (Bun's `typeof fetch` also demands `preconnect`). */
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
