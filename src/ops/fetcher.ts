/** The slice of `fetch` the broker uses; plain functions satisfy it (Bun's `typeof fetch` also demands `preconnect`). */
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
