// Byte budget for every employee-facing response (SYS01). Sizes are counted on the serialized UTF-8 bytes, never on
// JavaScript string length, because a consumer cut lands on bytes and splits multi-byte characters. Pure helpers only:
// no database, no transport.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ClaimResult, FieldCut, HistoryEntry, ListCut, ProjectView, TaskTextField, TaskTextSegment, TaskView, WorktreeRefsSegment } from './contracts.ts';
import { CompanyError } from './core-errors.ts';
import { MAX_CURSOR_CHARS } from './query-input.ts';

/**
 * Hard ceiling for one response, in UTF-8 bytes, as it is sent: on the MCP path the whole HTTP body (see RESPONSE_FRAME_BYTES),
 * on the sidecar path the relayed answer. Every bounded read, complete or paged, is measured by answerBytes. No response is cut to fit.
 */
export const RESPONSE_BUDGET_BYTES = 48 * 1024;
/**
 * The bytes the JSON-RPC message adds around one tool result on the wire, without the request id: the SSE lines `event: message`
 * and `data: ` with the blank line that ends the event (23 bytes), and `{"result":`, `,"jsonrpc":"2.0","id":` and the closing
 * brace (33 bytes). Measured on the real endpoint (SYS01, D2).
 */
export const SSE_RPC_FRAME_BYTES = 56;
/**
 * The largest request id the service accepts, as serialized JSON: a number, or a string whose quoted form (escapes counted as
 * written) is at most this many bytes. The id is echoed in every response, so this bound is what makes the frame reserve hold.
 * A request with a larger id is refused before any tool runs: nothing is written for it, and its refusal carries a null id.
 */
export const MAX_REQUEST_ID_BYTES = 128;
/**
 * Bytes reserved inside the budget for the frame around an answer: the SSE and JSON-RPC envelope (SSE_RPC_FRAME_BYTES) plus the
 * largest accepted request id (MAX_REQUEST_ID_BYTES), with 72 bytes to spare. So an answer that fits the budget as answerBytes
 * measures it is at most RESPONSE_BUDGET_BYTES - 72 bytes on the wire, whatever id an accepted request carries (SYS01, D2).
 */
export const RESPONSE_FRAME_BYTES = 256;
/**
 * Bytes of a page kept back for its envelope (principal, page information, cursor, and the answer's own wrapper). An item of
 * a page is cut only when it cannot fit the data budget less this reserve; an item between the reserve and the whole budget stays whole (C3).
 */
export const PAGE_ENVELOPE_BYTES = 2 * 1024;
/** Default and maximum size of one text segment returned by read_task_text, in raw UTF-8 bytes. */
export const SEGMENT_DEFAULT_BYTES = 16 * 1024;
export const SEGMENT_MAX_BYTES = 24 * 1024;

export const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
export const jsonBytes = (value: unknown): number => utf8Bytes(JSON.stringify(value));
/**
 * The bytes a value takes inside an answer, where it appears twice (SYS01, D1): once as JSON in structuredContent, and once as the
 * text copy, which is the same JSON escaped as a string. The two quotes that wrap the text copy belong to the wrapper, not to the value.
 * Both copies add up part by part (an object or array costs the sum of its entries and separators, in each copy), so the budget of a
 * composite answer can be split between its parts, and every cut below is sized in these bytes.
 */
export const dualBytes = (value: unknown): number => jsonBytes(value) + utf8Bytes(JSON.stringify(JSON.stringify(value))) - 2;

/**
 * The MCP tool result that carries one answer (SYS01, D1). content[0].text is the answer's JSON, the same text the service sent
 * before SYS01 (8d03d35), and structuredContent holds { ok: true, data } for clients that read it. Both carry the same data.
 */
export function answerResult(data: unknown): { content: { type: 'text'; text: string }[]; structuredContent: { ok: true; data: unknown } } {
  const value = data === undefined ? null : data;
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { ok: true, data: value } };
}

/**
 * The bytes one answer takes on the wire inside the budget: its MCP tool result, both copies included, plus the frame reserved
 * around it. Every answer budget is checked against this one measure, on MCP, on the sidecar relay, in pages, segments and echoes,
 * so one answer is admitted or refused the same way on every path.
 */
export function answerBytes(data: unknown): number {
  return jsonBytes(answerResult(data)) + RESPONSE_FRAME_BYTES;
}

/** The bytes of an answer around its data (the wrapper of both copies), and so the dual bytes the data itself may take. */
export const ANSWER_WRAPPER_BYTES = jsonBytes(answerResult(null)) - dualBytes(null);
/** Dual bytes the data of one answer may take: answerBytes(data) fits RESPONSE_BUDGET_BYTES exactly when dualBytes(data) fits this. */
export const DATA_BUDGET_BYTES = RESPONSE_BUDGET_BYTES - RESPONSE_FRAME_BYTES - ANSWER_WRAPPER_BYTES;
/** Dual bytes one item of a page may take: a task in a listing, or one audit entry. */
export const ITEM_BUDGET_BYTES = DATA_BUDGET_BYTES - PAGE_ENVELOPE_BYTES;

/**
 * The serialized size of the first request id that is larger than MAX_REQUEST_ID_BYTES, in the body of a JSON-RPC request
 * (a single message or a batch), or undefined when every id is within the bound. A body that is not JSON is not judged here.
 */
export function oversizeRequestId(body: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    if (typeof message !== 'object' || message === null || !('id' in message) || message.id === undefined) continue;
    const bytes = jsonBytes(message.id);
    if (bytes > MAX_REQUEST_ID_BYTES) return bytes;
  }
  return undefined;
}

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

/** Longest prefix of `text` of at most `limit` UTF-8 bytes that ends on a character boundary. */
export function utf8Prefix(text: string, limit: number): { text: string; bytes: number; total: number } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return { text, bytes: buf.length, total: buf.length };
  let end = Math.max(0, Math.floor(limit));
  while (end > 0 && isContinuation(buf[end])) end--;
  return { text: buf.subarray(0, end).toString('utf8'), bytes: end, total: buf.length };
}

/** One segment of a text: where it starts, how many bytes it takes, and where the next one begins (null at the end). */
export interface Utf8Segment {
  text: string; offset: number; bytes: number; next: number | null; total: number;
}

/**
 * One segment of `text` starting at byte `offset` (moved forward to a character boundary when it lands inside a
 * character). It is at most `limit` bytes long, ends on a character boundary, and `fits` holds for it: a caller passes
 * the serialized size of the answer the segment goes into (see textSegment). Segments of one text concatenate back to
 * the original bytes exactly. `fits` is searched by bisection, so it must hold for every shorter segment too.
 */
export function utf8Segment(text: string, offset: number, limit: number, fits: (segment: Utf8Segment) => boolean = () => true): Utf8Segment {
  const buf = Buffer.from(text, 'utf8');
  let start = Math.min(Math.max(0, Math.floor(offset)), buf.length);
  while (start < buf.length && isContinuation(buf[start])) start++;
  const at = (end: number): Utf8Segment => ({
    text: buf.subarray(start, end).toString('utf8'), offset: start, bytes: end - start,
    next: end < buf.length ? end : null, total: buf.length,
  });
  if (start >= buf.length) return at(buf.length);
  // Each character boundary the raw limit allows, in order. The first one lies within 4 bytes, so one character always fits.
  const reach = Math.min(buf.length, start + Math.max(4, Math.floor(limit)));
  const ends: number[] = [];
  for (let end = start + 1; end <= reach; end++) {
    if (end === buf.length || !isContinuation(buf[end])) ends.push(end);
  }
  let lo = 0;
  let hi = ends.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(at(ends[mid]!))) lo = mid;
    else hi = mid - 1;
  }
  return at(ends[lo]!);
}

/** What names a read_task_text answer: the task and field read, the audit entry of evidence, and the digest of the whole text. */
export interface TaskTextHead {
  taskId: string;
  field: TaskTextField;
  auditId?: string;
  sha256: string;
}

/** The answer read_task_text gives for one segment. core builds every answer this way, so the budget checks measure the real shape. */
export function textSegmentAnswer(head: TaskTextHead, segment: Utf8Segment): TaskTextSegment {
  return {
    taskId: head.taskId, field: head.field, ...(head.auditId ? { auditId: head.auditId } : {}),
    totalBytes: segment.total, sha256: head.sha256, offset: segment.offset, bytes: segment.bytes,
    nextOffset: segment.next, text: segment.text,
  };
}

/**
 * One read_task_text segment, cut so that its whole answer fits the response budget as it is sent (answerBytes; SYS01, F2).
 * JSON writes a control character as six bytes and a quote as two, and the text copy escapes them again, so a byte count alone can
 * overflow the budget: the segment keeps the longest prefix whose serialized answer fits, and never more than `limit` raw bytes.
 */
export function textSegment(text: string, offset: number, limit: number, head: TaskTextHead): Utf8Segment {
  return utf8Segment(text, offset, limit, segment => answerBytes(textSegmentAnswer(head, segment)) <= RESPONSE_BUDGET_BYTES);
}

/** What names a read_worktree_refs answer: the worktree, the reference filter, and the digest of the whole references text. */
export interface WorktreeRefsHead {
  worktreePath: string;
  includeReleased: boolean;
  sha256: string;
}

/** The answer read_worktree_refs gives for one segment. core builds every answer this way, so the budget check measures the real shape. */
export function worktreeRefsSegmentAnswer(head: WorktreeRefsHead, segment: Utf8Segment): WorktreeRefsSegment {
  return {
    worktreePath: head.worktreePath, includeReleased: head.includeReleased, totalBytes: segment.total, sha256: head.sha256,
    offset: segment.offset, bytes: segment.bytes, nextOffset: segment.next, text: segment.text,
  };
}

/**
 * One read_worktree_refs segment, cut so that its whole answer fits the response budget as it is sent (answerBytes; SYS01 R1).
 * The text is JSON, so quotes and escapes are counted twice, exactly as read_task_text counts them.
 */
export function worktreeRefsSegment(text: string, offset: number, limit: number, head: WorktreeRefsHead): Utf8Segment {
  return utf8Segment(text, offset, limit, segment => answerBytes(worktreeRefsSegmentAnswer(head, segment)) <= RESPONSE_BUDGET_BYTES);
}

/**
 * Largest k such that `bytesOf(items.slice(0, k))` is within `limit` bytes. `bytesOf` must grow with k (it is searched by
 * bisection). Returns 0 when even the empty list does not fit. A page is sized as it is sent, for example
 * `fitCount(items, kept => answerBytes(build(kept)), RESPONSE_BUDGET_BYTES)`.
 */
export function fitCount<T>(items: readonly T[], bytesOf: (kept: readonly T[]) => number, limit: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytesOf(items.slice(0, mid)) <= limit) lo = mid;
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
 * Bytes one relay reply takes as the sidecar writes it: the single JSON line the caller reads, envelope included. The
 * data-only case keeps the shared MCP-measured value (answerBytes: the answer twice, plus the frame reserve), which is
 * stricter than this line and is what the relay has always admitted or refused — so nothing that fits today is newly
 * refused, and nothing that is refused today becomes admitted. A reply that also carries the unacked holder notices
 * attached to the call (SYS-INT) is measured as the line it becomes: the whole serialized reply, notices included (R3).
 * Measuring only `data` would let a large attachment pass a guard that reads as if it had been checked.
 */
export const relayReplyBytes = (res: { ok: boolean; data?: unknown; error?: string; notices?: unknown[] }): number =>
  res.notices === undefined
    ? answerBytes(res.data)
    : jsonBytes({ ok: true, data: res.data ?? null, notices: res.notices });

/**
 * The notices that fit the remaining budget of one reply, for a data answer that already fits on its own. The cut is a
 * prefix in delivery order: every notice left out stays unacked, so the next call attaches it again — a holder sees a
 * large backlog late, never never. Undefined when every notice fits, so the caller keeps its own list untouched.
 */
export interface NoticeCut extends ListCut { bytes: number }
export function fitAttachedNotices(data: unknown, notices: unknown[]): { notices: unknown[]; noticesTruncated: NoticeCut } | undefined {
  const kept: unknown[] = [];
  for (const notice of notices) {
    const candidate = [...kept, notice];
    if (relayReplyBytes({ ok: true, data, notices: candidate }) > RESPONSE_BUDGET_BYTES) break;
    kept.push(notice);
  }
  if (kept.length === notices.length) return undefined;
  return { notices: kept, noticesTruncated: {
    count: notices.length, bytes: jsonBytes(notices), sha256: createHash('sha256').update(JSON.stringify(notices)).digest('hex'),
  } };
}

/**
 * Last line of defence on the relay path. A successful answer over the budget, measured as the MCP path measures it
 * (answerBytes of its data, and the whole reply line when attached notices ride along with it), is replaced by a
 * recoverable, JSON-legal error with its code, so an oversize value can never reach the caller as a cut byte stream.
 */
export function guardRelayResponse<T extends { ok: boolean; data?: unknown; error?: string; notices?: unknown[] }>(res: T):
  T | { ok: false; code: 'response_too_large'; retryable: false; error: string } {
  if (!res.ok) return res;
  const bytes = relayReplyBytes(res);
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
 * turn a committed write into an error: the context stays whole when the task fits `limit` (dual bytes), and is otherwise cut at
 * the longest prefix that fits and flagged. contextBytes and contextSha256 always describe the whole context. An echo of an
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
  if (task.contextTruncated !== true && dualBytes(echo(task.context, false)) <= limit) return echo(task.context, false);
  return echo(longestFittingPrefix(task.context, prefix => dualBytes(echo(prefix, true)) <= limit), true);
}

/** A text field of a task echo other than the context may take this many dual bytes; a longer one is cut and named (fieldsTruncated). */
export const TASK_FIELD_ECHO_BYTES = 2 * 1024;

/**
 * Keeps each text field of a task within TASK_FIELD_ECHO_BYTES. A longer one keeps its longest prefix that fits, and fieldsTruncated
 * names it with the size and digest of its whole value. A claim or a write has committed, so no task, whatever its titles hold, may
 * turn its confirmation into an error. The context is left to echoTaskContext, which read_task_text completes.
 */
function boundTaskFields(task: TaskView): TaskView {
  const echo: Record<string, unknown> = { ...task };
  const cut: Record<string, FieldCut> = {};
  for (const [name, value] of Object.entries(task)) {
    if (name === 'context' || name === 'fieldsTruncated' || typeof value !== 'string') continue;
    if (dualBytes(value) <= TASK_FIELD_ECHO_BYTES) continue;
    echo[name] = longestFittingPrefix(value, prefix => dualBytes(prefix) <= TASK_FIELD_ECHO_BYTES);
    cut[name] = { bytes: utf8Bytes(value), sha256: createHash('sha256').update(value).digest('hex') };
  }
  // A copy either way: echoTask edits the result in place, and the caller's task must stay as it was.
  if (Object.keys(cut).length === 0) return { ...task };
  return { ...echo, fieldsTruncated: { ...task.fieldsTruncated, ...cut } } as TaskView;
}

/**
 * The echo of a task that a write returns (SYS01 R3). The write is committed before its echo is built, so the echo never turns it
 * into an error, whatever the task holds. Each text field is bounded (boundTaskFields). Each list of the task (dependencies, the
 * intent paths of the task and of its worktree) keeps its longest prefix within a share of the limit, and each cut is flagged in
 * listsTruncated with the whole count and digest. The context then takes the room that is left (echoTaskContext). read_task_text
 * returns any cut list or context whole.
 */
export function echoTask(task: TaskView, limit: number = ITEM_BUDGET_BYTES): TaskView {
  // A share of the limit per list: the three lists, the fixed fields and the context must fit together.
  const share = Math.min(CLAIM_LIST_ECHO_BYTES, Math.floor(limit / 8));
  // An echo of an echo keeps the cuts of the earlier echo, so their counts and digests still describe the whole lists.
  const cuts: Partial<Record<ClaimListName, ListCut>> = { ...task.listsTruncated };
  const echo: TaskView = boundTaskFields(task);
  if (task.dependencies) echo.dependencies = cutList(task.dependencies, 'dependencies', cuts, share);
  if (task.workIntent?.paths) echo.workIntent = { ...task.workIntent, paths: cutList(task.workIntent.paths, 'workIntentPaths', cuts, share) };
  if (task.worktree?.intent?.paths) {
    echo.worktree = { ...task.worktree, intent: { ...task.worktree.intent, paths: cutList(task.worktree.intent.paths, 'worktreePaths', cuts, share) } };
  }
  if (Object.keys(cuts).length > 0) echo.listsTruncated = cuts;
  return echoTaskContext(echo, limit);
}

// ---- Claim echo: the answer of claim_next. The claim has committed when its answer is built, so the answer is an echo, never an error. ----

/**
 * The shares of a claim echo, in dual bytes (see dualBytes). At most 28 KiB of the data budget is shared out: the project 8 KiB,
 * the three lists 4 KiB each, and the history floor 8 KiB. These are worst cases, not usual sizes. The fixed fields and the context
 * take what is left, about 19 KiB of dual bytes (roughly 9 KiB of plain text) in the worst case; a test holds the sum to this.
 */
/** A claim's project over this many dual bytes is echoed in part (see echoClaim); the whole project stays in claim.json and get_context. */
export const PROJECT_ECHO_BYTES = 8 * 1024;
/**
 * The least room the handover history keeps beside a long context (SYS01 R3). The context takes what the history leaves, so a
 * long context cannot empty the handover: the newest entries fill this floor first, and the boundary entry keeps what fits.
 */
export const CLAIM_HISTORY_FLOOR_BYTES = 8 * 1024;
/** Most dual bytes of each identity text of a partial project echo. The red lines keep the room that is left. */
export const PROJECT_FIELD_ECHO_BYTES = 512;
/** Most dual bytes of one red line in a partial project echo. */
export const RED_LINE_ECHO_BYTES = 1024;
/** The most dual bytes one list of a claim echo keeps: the dependencies, and the intent paths of the task and of its worktree. */
export const CLAIM_LIST_ECHO_BYTES = 4 * 1024;
const PROJECT_IDENTITY = ['id', 'name', 'repoPath', 'defaultBranch', 'release', 'rollback', 'pipeline'] as const;

export type ClaimListName = 'dependencies' | 'workIntentPaths' | 'worktreePaths';

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

/**
 * A list within `budget` dual bytes (CLAIM_LIST_ECHO_BYTES unless a write echo gives it a share) is kept whole. A longer one keeps its
 * longest prefix, and `cuts` records its count and digest. A list that `cuts` already names was cut by an earlier echo: it stays
 * partial, and keeps that echo's count and digest, which describe the whole list. claim.json and read_task_text keep the list whole.
 */
function cutList<T>(items: readonly T[], name: ClaimListName, cuts: Partial<Record<ClaimListName, ListCut>>, budget: number = CLAIM_LIST_ECHO_BYTES): T[] {
  if (!cuts[name] && dualBytes(items) <= budget) return [...items];
  if (!cuts[name]) cuts[name] = { count: items.length, sha256: createHash('sha256').update(JSON.stringify(items)).digest('hex') };
  return items.slice(0, fitCount(items, kept => dualBytes(kept), budget));
}

/**
 * Keeps the newest entries that fit `budget` dual bytes, oldest first. The entry at the boundary keeps the longest prefix of its
 * evidence that fits; older entries are left out after it. `cut` is true when that prefix is partial. The array's brackets cost 4
 * dual bytes, and each comma after the first entry costs 2 (one in each copy).
 */
function fillHistory(entries: readonly HistoryEntry[], budget: number): { kept: HistoryEntry[]; cut: boolean } {
  const kept: HistoryEntry[] = [];
  let used = dualBytes([]);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    const comma = kept.length > 0 ? 2 : 0;
    const size = dualBytes(entry);
    if (used + comma + size <= budget) {
      kept.unshift(entry);
      used += comma + size;
      continue;
    }
    // Only whole evidence can be cut here: the size and digest of the whole text travel with the prefix.
    if (entry.evidence === undefined || entry.evidenceTruncated === true) break;
    const whole = entry.evidence;
    const bytes = entry.evidenceBytes ?? utf8Bytes(whole);
    const digest = entry.evidenceSha256 ?? createHash('sha256').update(whole).digest('hex');
    const cutEntry = (text: string): HistoryEntry => ({
      ...entry, evidence: text, evidenceBytes: bytes, evidenceSha256: digest, evidenceTruncated: true, evidenceNextOffset: utf8Bytes(text),
    });
    const room = budget - used - comma;
    const prefix = longestFittingPrefix(whole, text => dualBytes(cutEntry(text)) <= room);
    if (prefix.length === 0) break;
    kept.unshift(cutEntry(prefix));
    return { kept, cut: true };
  }
  return { kept, cut: false };
}

/**
 * The partial echo of a project over PROJECT_ECHO_BYTES: identity texts capped, then as many red lines as fit beside them.
 * The red lines are never dropped for the identity. The project's size and digest describe the whole project.
 */
function partialProject(project: ProjectView): Partial<ProjectView> {
  const identity: Record<string, unknown> = {};
  for (const key of PROJECT_IDENTITY) {
    if (!(key in project)) continue;
    const value = project[key];
    identity[key] = typeof value === 'string'
      ? longestFittingPrefix(value, prefix => dualBytes(prefix) <= PROJECT_FIELD_ECHO_BYTES)
      : value;
  }
  const lines = (project.redLines ?? []).map(line => longestFittingPrefix(line, prefix => dualBytes(prefix) <= RED_LINE_ECHO_BYTES));
  const kept = lines.slice(0, fitCount(lines, subset => dualBytes({ ...identity, redLines: subset }), PROJECT_ECHO_BYTES));
  return { ...identity, redLines: kept } as Partial<ProjectView>;
}

/**
 * The echo of a claim (SYS01, return of 04195c93, R3). The claim has committed, so the echo never fails: deliveryId, fence and
 * leaseExpiresAt always come back, and each variable part is bounded and says so. Predecessors are at most six. Each list is cut to
 * CLAIM_LIST_ECHO_BYTES: the dependencies, the task's intent paths and the worktree's intent paths. The project is echoed whole up
 * to PROJECT_ECHO_BYTES, else in part (identity, red lines; projectTruncated). The history fills what the other fields leave: the
 * newest entries that fit are kept whole, the boundary entry keeps its longest prefix, and historyCount says how many entries the
 * task holds. historyComplete is true only when every entry is kept whole and the count agrees. The context takes the room that is
 * left: a cut context is flagged (contextTruncated, contextNextOffset), and read_task_text returns the rest. core.claim keeps the
 * whole claim for claim.json. Every size is dual (see dualBytes), so the echo is exactly what answerBytes measures.
 */
export function echoClaim(claim: ClaimResult): ClaimEcho & { task: TaskView } {
  const { task: whole, project, history, historyComplete, historyCount, ...fields } = claim;
  const cuts: Partial<Record<ClaimListName, ListCut>> = {};
  // task.worktree is the same assignment as the top-level worktree, so the echo carries it once.
  const bare: TaskView = { ...whole, dependencies: cutList(whole.dependencies, 'dependencies', cuts) };
  delete bare.worktree;
  if (whole.workIntent?.paths) bare.workIntent = { ...whole.workIntent, paths: cutList(whole.workIntent.paths, 'workIntentPaths', cuts) };
  const task = boundTaskFields(bare);
  let head: Omit<ClaimEcho, 'task' | 'history'> = { ...fields };
  if (fields.worktree?.intent.paths) {
    head.worktree = { ...fields.worktree, intent: { ...fields.worktree.intent, paths: cutList(fields.worktree.intent.paths, 'worktreePaths', cuts) } };
  }
  if (project !== undefined) {
    head = dualBytes(project) <= PROJECT_ECHO_BYTES
      ? { ...head, project }
      : {
        ...head, project: partialProject(project), projectTruncated: true, projectBytes: jsonBytes(project),
        projectSha256: createHash('sha256').update(JSON.stringify(project)).digest('hex'),
      };
  }
  if (Object.keys(cuts).length > 0) head = { ...head, listsTruncated: cuts };
  // Only a claim that read the history carries the history flags; a heartbeat reads none and carries neither.
  const read = historyComplete !== undefined;
  const flags: Partial<Pick<ClaimEcho, 'historyCount' | 'historyComplete'>> = {
    ...(historyCount !== undefined ? { historyCount } : {}),
    ...(read ? { historyComplete: false } : {}),
  };
  // The room left for history and task, in dual bytes. The placeholders [] and null hold their places in the shell, and the
  // placeholder false is wider than the true that may replace it, so the measure never undershoots the final answer.
  const shell = { ...head, ...flags, history: [], task: null };
  const room = DATA_BUDGET_BYTES - dualBytes(shell) + dualBytes([]) + dualBytes(null);
  // The history takes what the whole context would leave, but never less than its floor. A long context is cut to what remains.
  const budget = Math.min(room, Math.max(CLAIM_HISTORY_FLOOR_BYTES, room - dualBytes(echoTaskContext(task, Number.POSITIVE_INFINITY))));
  const { kept, cut } = fillHistory(history, budget);
  // The task's own fields (title, intent, dependencies) are never cut here; only its context is.
  const echoed = echoTaskContext(task, room - dualBytes(kept));
  const count = historyCount ?? history.length;
  const complete = read ? historyComplete === true && !cut && kept.length === count : undefined;
  const answer = { ...head, ...flags, ...(complete !== undefined ? { historyComplete: complete } : {}), history: kept, task: echoed };
  if (answerBytes(answer) <= RESPONSE_BUDGET_BYTES) return answer;
  // Not reachable: every part above is bounded. The claim has committed, so its confirmation is kept whatever happens: the
  // history and the context are left out, and historyComplete says so.
  return { ...head, ...flags, ...(read ? { historyComplete: false } : {}), history: [], task: echoTaskContext(task, 0) };
}

// ---- Cursors: opaque, sealed with an HMAC, bound to a caller, a query and a stored listing, and time-limited. ----

export interface CursorBody {
  /** Format version. */
  v: 1;
  /** Which listing the cursor continues (context, history, worktrees or a policy plan). */
  k: 'context' | 'history' | 'worktrees' | 'policy-plan';
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
