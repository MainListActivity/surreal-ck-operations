/** The slice of `fetch` the broker uses; plain functions satisfy it (Bun's `typeof fetch` also demands `preconnect`). */
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Secret-free wording for a request that threw, naming the limit when a timeout was the cause. */
export function describeTransportFailure(error: unknown, timeoutMs: number): { timedOut: boolean; detail: string } {
  const name = (error as Error | undefined)?.name ?? 'Error';
  if (name !== 'TimeoutError') return { timedOut: false, detail: name };
  return { timedOut: true, detail: `timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}` };
}
