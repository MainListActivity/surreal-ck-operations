// Byte budget for every employee-facing response (SYS01). Sizes are counted on the serialized UTF-8
// bytes, never on JavaScript string length, because a 64 KiB consumer cut lands on bytes and splits
// multi-byte characters. Pure helpers only: no database, no transport.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CompanyError } from './core-errors.ts';

/** Hard ceiling for one serialized relay response (the whole `{ok,data}` envelope), in UTF-8 bytes. */
export const RESPONSE_BUDGET_BYTES = 48 * 1024;
/** What a paged data block may use: the rest is headroom for the envelope and the transport. */
export const PAGE_BUDGET_BYTES = RESPONSE_BUDGET_BYTES - 1024;
/** Preview of a long text field inside a list page; the full text is read through read_task_text. */
export const PREVIEW_BYTES = 512;
/** Preview of a long text field in a single-task detail; longer text is segmented. */
export const DETAIL_TEXT_BYTES = 16 * 1024;
/** Default and maximum size of one text segment returned by read_task_text. */
export const SEGMENT_DEFAULT_BYTES = 16 * 1024;
export const SEGMENT_MAX_BYTES = 24 * 1024;

export const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
export const jsonBytes = (value: unknown): number => utf8Bytes(JSON.stringify(value));

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

/** Longest prefix of `text` of at most `limit` UTF-8 bytes that ends on a character boundary. */
export function utf8Prefix(text: string, limit: number): { text: string; bytes: number; total: number } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return { text, bytes: buf.length, total: buf.length };
  let end = Math.max(0, Math.floor(limit));
  while (end > 0 && isContinuation(buf[end])) end--;
  return { text: buf.subarray(0, end).toString('utf8'), bytes: end, total: buf.length };
}

/**
 * One segment of `text` starting at byte `offset` (moved forward to a character boundary when it lands
 * inside a character) and at most `limit` bytes long. `next` is the offset of the following segment, or
 * null at the end. Segments of one text concatenate back to the original bytes exactly.
 */
export function utf8Segment(text: string, offset: number, limit: number): {
  text: string; offset: number; bytes: number; next: number | null; total: number;
} {
  const buf = Buffer.from(text, 'utf8');
  let start = Math.min(Math.max(0, Math.floor(offset)), buf.length);
  while (start < buf.length && isContinuation(buf[start])) start++;
  let end = Math.min(buf.length, start + Math.max(4, Math.floor(limit)));
  if (end < buf.length) while (end > start && isContinuation(buf[end])) end--;
  return {
    text: buf.subarray(start, end).toString('utf8'), offset: start, bytes: end - start,
    next: end < buf.length ? end : null, total: buf.length,
  };
}

/**
 * Largest k such that `build(items.slice(0, k))` serializes within `limit` bytes. `build` must grow
 * with k (it is searched by bisection). Returns 0 when even the empty page does not fit.
 */
export function fitCount<T>(items: readonly T[], build: (kept: readonly T[]) => unknown, limit: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonBytes(build(items.slice(0, mid))) <= limit) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Last line of defence on the relay path. A successful response over the budget is replaced by a
 * recoverable, JSON-legal error, so an oversize value can never reach the caller as a cut byte stream.
 */
export function guardRelayResponse<T extends { ok: boolean; data?: unknown; error?: string }>(res: T): T | { ok: false; error: string } {
  if (!res.ok) return res;
  const bytes = jsonBytes(res);
  if (bytes <= RESPONSE_BUDGET_BYTES) return res;
  return { ok: false, error: `response_too_large: ${bytes} bytes exceed the ${RESPONSE_BUDGET_BYTES}-byte budget; narrow the query with pageSize or a cursor` };
}

// ---- Cursors: opaque, sealed with an HMAC, bound to a caller and a query, and time-limited. ----

export interface CursorBody {
  /** Format version. */
  v: 1;
  /** Which read produced the cursor (context, history or worktrees). */
  k: 'context' | 'history' | 'worktrees';
  /** Employee the cursor was issued to. */
  c: string;
  /** Digest of the query the cursor belongs to (filters only, not the page size). */
  q: string;
  /** Snapshot instant: rows created after it are outside the traversal. */
  snap?: string;
  /** Sort position: the last row already delivered (the next page starts after it). */
  at?: string;
  id?: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

const MAX_CURSOR_CHARS = 2048;

export function sealCursor(body: CursorBody, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const mac = createHmac('sha256', key).update(payload).digest('base64url');
  return `v1.${payload}.${mac}`;
}

/** Verifies the seal and expiry only; the caller checks the binding (caller, query, kind). */
export function openCursor(token: string, key: Buffer, now: number): CursorBody {
  if (typeof token !== 'string' || token.length > MAX_CURSOR_CHARS) throw new CompanyError('invalid', 'cursor is malformed');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new CompanyError('invalid', 'cursor is malformed');
  const payload = parts[1]!;
  const expected = createHmac('sha256', key).update(payload).digest();
  const given = Buffer.from(parts[2]!, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new CompanyError('invalid', 'cursor failed verification; it was altered or issued by another service');
  }
  let body: CursorBody;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CursorBody;
  } catch {
    throw new CompanyError('invalid', 'cursor is malformed');
  }
  if (body.v !== 1 || typeof body.exp !== 'number' || typeof body.c !== 'string' || typeof body.q !== 'string') {
    throw new CompanyError('invalid', 'cursor is malformed');
  }
  if (body.exp <= now) throw new CompanyError('invalid', 'cursor expired; start the listing again');
  return body;
}
