// Byte budget for every employee-facing response (SYS01). Sizes are counted on the serialized UTF-8
// bytes, never on JavaScript string length, because a 64 KiB consumer cut lands on bytes and splits
// multi-byte characters. Pure helpers only: no database, no transport.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ClaimResult, ProjectView, TaskView } from './contracts.ts';
import { CompanyError } from './core-errors.ts';
import { MAX_CURSOR_CHARS } from './query-input.ts';

/**
 * Hard ceiling for one serialized relay response (the whole `{ok,data}` envelope), in UTF-8 bytes. Every
 * bounded read, complete or paged, is measured this way; no response is cut to fit.
 */
export const RESPONSE_BUDGET_BYTES = 48 * 1024;
/**
 * Bytes of a page kept back for its envelope (principal, page information, cursor). An item of a page is cut only when
 * it cannot fit the budget less this reserve; an item between the reserve and the whole budget stays whole (C3).
 */
export const PAGE_ENVELOPE_BYTES = 2 * 1024;
/** Most serialized bytes one item of a page may take: a task in a listing, or one audit entry. */
export const ITEM_BUDGET_BYTES = RESPONSE_BUDGET_BYTES - PAGE_ENVELOPE_BYTES;
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
 * Longest prefix of `text`, cut between two characters, for which `fits(prefix)` holds. `fits` must hold for every
 * shorter prefix too, as a serialized size does: it is searched by bisection. Used for an item that is over budget on
 * its own: it keeps as much of its text as fits, and the rest is read by segment.
 */
export function longestFittingPrefix(text: string, fits: (prefix: string) => boolean): string {
  const points = [...text];
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(points.slice(0, mid).join(''))) lo = mid;
    else hi = mid - 1;
  }
  return points.slice(0, lo).join('');
}

/**
 * Last line of defence on the relay path. A successful response over the budget is replaced by a
 * recoverable, JSON-legal error with its code, so an oversize value can never reach the caller as a cut byte stream.
 */
export function guardRelayResponse<T extends { ok: boolean; data?: unknown; error?: string }>(res: T):
  T | { ok: false; code: 'response_too_large'; retryable: false; error: string } {
  if (!res.ok) return res;
  const bytes = jsonBytes(res);
  if (bytes <= RESPONSE_BUDGET_BYTES) return res;
  return {
    ok: false, code: 'response_too_large', retryable: false,
    error: `response_too_large: ${bytes} bytes exceed the ${RESPONSE_BUDGET_BYTES}-byte budget; narrow the query with pageSize or a cursor`,
  };
}

// ---- Write echoes: a committed write answers with the task it changed, and that echo must fit the budget too (SYS01). ----

/** The fields of a task echo that describe its context; see echoTaskContext. */
export interface TaskEchoFields {
  context: string;
  /** Size of the whole context in UTF-8 bytes, whether or not `context` is cut. */
  contextBytes?: number;
  /** SHA-256 of the whole context: read_task_text verifies every segment against it. */
  contextSha256?: string;
  /** True when `context` holds only the leading part of the whole text. */
  contextTruncated?: boolean;
  /** Byte offset where read_task_text continues the context; present only when contextTruncated is true. */
  contextNextOffset?: number;
}

/**
 * The echo of a task that a write returns. The write is committed before its echo is built, so the echo must never
 * turn a committed write into an error: the context stays whole when the task fits `limit`, and is otherwise cut at the
 * longest prefix that fits and flagged. contextBytes and contextSha256 always describe the whole context. An echo of an
 * echo cuts the same way, which lets one response share its budget between several tasks.
 */
export function echoTaskContext<T extends TaskEchoFields>(task: T, limit: number = ITEM_BUDGET_BYTES): T {
  const bytes = task.contextBytes ?? utf8Bytes(task.context);
  const sha256 = task.contextSha256 ?? createHash('sha256').update(task.context).digest('hex');
  const echo = (context: string, truncated: boolean): T => ({
    ...task, context, contextBytes: bytes, contextSha256: sha256, contextTruncated: truncated,
    ...(truncated ? { contextNextOffset: utf8Bytes(context) } : {}),
  });
  // A context that is already cut stays cut: the rest of the text is not in this value.
  if (task.contextTruncated !== true && jsonBytes(echo(task.context, false)) <= limit) return echo(task.context, false);
  return echo(longestFittingPrefix(task.context, prefix => jsonBytes(echo(prefix, true)) <= limit), true);
}

// ---- Claim echo: the answer of claim_next. The claim has committed when its answer is built, so the answer is an echo, never an error. ----

/** A claim's project over this many bytes is echoed in part (see echoClaim); the whole project stays in claim.json and get_context. */
export const PROJECT_ECHO_BYTES = 8 * 1024;
/** The least context a task keeps in a claim echo beyond its own fields. Below it the handover history is left out, and historyComplete turns false. */
export const CLAIM_TASK_MIN_BYTES = 4 * 1024;
/** The most bytes one list of a claim echo keeps: the dependencies, and the intent paths of the task and of its worktree. */
export const CLAIM_LIST_ECHO_BYTES = 4 * 1024;
const PROJECT_IDENTITY = ['id', 'name', 'repoPath', 'defaultBranch', 'release', 'rollback', 'pipeline'] as const;

export type ClaimListName = 'dependencies' | 'workIntentPaths' | 'worktreePaths';
/** A list that a claim echo cut: its whole count, and the SHA-256 of its whole JSON. claim.json keeps the list whole. */
export interface ListCut { count: number; sha256: string }

/**
 * A claim as an MCP caller receives it. task.worktree is left out: the worktree is the top-level field. projectTruncated marks a
 * partial project, and listsTruncated names each list that was cut (absent when every list is whole).
 */
export interface ClaimEcho extends Omit<ClaimResult, 'project'> {
  project?: Partial<ProjectView>;
  projectTruncated?: boolean;
  projectBytes?: number;
  projectSha256?: string;
  listsTruncated?: Partial<Record<ClaimListName, ListCut>>;
}

/** A list within CLAIM_LIST_ECHO_BYTES is kept whole. A longer one keeps its longest prefix, and `cuts` records its count and digest. */
function cutList<T>(items: readonly T[], name: ClaimListName, cuts: Partial<Record<ClaimListName, ListCut>>): T[] {
  if (jsonBytes(items) <= CLAIM_LIST_ECHO_BYTES) return [...items];
  cuts[name] = { count: items.length, sha256: createHash('sha256').update(JSON.stringify(items)).digest('hex') };
  return items.slice(0, fitCount(items, kept => kept, CLAIM_LIST_ECHO_BYTES));
}

/**
 * The echo of a claim (SYS01, return of 04195c93). The claim has committed, so the echo never fails: deliveryId, fence and
 * leaseExpiresAt always come back, and each variable part is bounded and says so. The handover window (16 KiB, see core) is left
 * out when the task could not keep CLAIM_TASK_MIN_BYTES of context beside it; predecessors are at most six. Each list is cut to
 * CLAIM_LIST_ECHO_BYTES: the dependencies, the task's intent paths and the worktree's intent paths. The project is echoed whole up
 * to PROJECT_ECHO_BYTES, else by identity, else not at all. The task keeps what the other fields leave: a long context is cut and
 * flagged (contextTruncated, contextNextOffset), and read_task_text returns the rest. The remaining fixed fields are bounded at
 * create time (title 200 characters, goal 100, context 20,000) or are identifiers and paths. core.claim keeps the whole claim for
 * claim.json.
 */
export function echoClaim(claim: ClaimResult): ClaimEcho & { task: TaskView } {
  const { task: whole, project, ...fields } = claim;
  const cuts: Partial<Record<ClaimListName, ListCut>> = {};
  // task.worktree is the same assignment as the top-level worktree, so the echo carries it once.
  const task: TaskView = { ...whole, dependencies: cutList(whole.dependencies, 'dependencies', cuts) };
  delete task.worktree;
  if (whole.workIntent?.paths) task.workIntent = { ...whole.workIntent, paths: cutList(whole.workIntent.paths, 'workIntentPaths', cuts) };
  let head: Omit<ClaimEcho, 'task'> = { ...fields };
  if (fields.worktree?.intent.paths) {
    head.worktree = { ...fields.worktree, intent: { ...fields.worktree.intent, paths: cutList(fields.worktree.intent.paths, 'worktreePaths', cuts) } };
  }
  if (project !== undefined) {
    const bytes = jsonBytes(project);
    if (bytes <= PROJECT_ECHO_BYTES) {
      head = { ...head, project };
    } else {
      const identity = Object.fromEntries(PROJECT_IDENTITY.filter(key => key in project).map(key => [key, project[key]])) as Partial<ProjectView>;
      head = {
        ...head,
        ...(jsonBytes(identity) <= PROJECT_ECHO_BYTES ? { project: identity } : {}),
        projectTruncated: true, projectBytes: bytes,
        projectSha256: createHash('sha256').update(JSON.stringify(project)).digest('hex'),
      };
    }
  }
  if (Object.keys(cuts).length > 0) head = { ...head, listsTruncated: cuts };
  // Room for the task: the budget less the other fields, measured with the task as null (4 bytes) and then swapped for the echo.
  const room = (value: Omit<ClaimEcho, 'task'>) => RESPONSE_BUDGET_BYTES - (jsonBytes({ ok: true, data: { ...value, task: null } }) - 4);
  // The task's own fields (title, intent, dependencies) are never cut. The history leaves first when the task could not keep
  // CLAIM_TASK_MIN_BYTES of context beside its own fields.
  const floor = jsonBytes(echoTaskContext(task, 0));
  if (room(head) < floor + CLAIM_TASK_MIN_BYTES && head.history.length > 0) head = { ...head, history: [], historyComplete: false };
  return { ...head, task: echoTaskContext(task, room(head)) };
}

// ---- Cursors: opaque, sealed with an HMAC, bound to a caller, a query and a stored listing, and time-limited. ----

export interface CursorBody {
  /** Format version. */
  v: 1;
  /** Which listing the cursor continues (context, history or worktrees). */
  k: 'context' | 'history' | 'worktrees';
  /** Employee the cursor was issued to. */
  c: string;
  /** Digest of the query the cursor belongs to (filters only, not the page size or projection). */
  q: string;
  /** Stored listing (query_snapshot id) the traversal reads from. */
  sid: string;
  /** Position of the last row already delivered; the next page starts after it. */
  seq: number;
  /** Expiry, epoch milliseconds: the listing's own expiry, so both end together. */
  exp: number;
}

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
  if (body.v !== 1 || typeof body.exp !== 'number' || typeof body.c !== 'string' || typeof body.q !== 'string'
    || typeof body.sid !== 'string' || typeof body.seq !== 'number' || !Number.isInteger(body.seq) || body.seq < 0) {
    throw new CompanyError('invalid', 'cursor is malformed');
  }
  // The cursor expires with its listing: an expired cursor names a listing that is gone, so the caller starts again.
  if (body.exp <= now) throw new CompanyError('snapshot_gone', 'cursor expired: its listing is gone; start the listing again without cursor', false);
  return body;
}
