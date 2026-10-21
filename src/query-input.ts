// Argument parsing for the bounded reads (SYS01). Arguments arrive untyped from the sidecar relay,
// so every field is checked here: an invalid value is refused, never widened into an unbounded query.
import { createHash } from 'node:crypto';
import { CompanyError } from './core-errors.ts';
import { ROLES, type Role, type TaskState } from './contracts.ts';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MAX_CURSOR_CHARS = 2048;

export const TASK_STATES: readonly TaskState[] = ['blocked', 'ready', 'doing', 'review', 'done', 'void'];
/** Top-level TaskView keys a caller may project. Anything else is refused. */
export const TASK_FIELDS: readonly string[] = [
  'id', 'title', 'context', 'state', 'executorRole', 'reviewerRole', 'discipline', 'kind', 'goalId', 'projectOverlay',
  'codeRepoPath', 'dependencies', 'version', 'submittedBy', 'currentEmployee', 'deliveryId', 'leaseExpiresAt', 'fence',
  'blockedTo', 'handover', 'previousEmployee', 'workIntent', 'worktree', 'revises', 'supersededBy', 'lineage', 'revisionNo',
  // The truncation flags: a caller that projects a list needs to know whether it got the whole list (SYS-DISP R4).
  'listsTruncated', 'contextTruncated',
];

const invalid = (message: string) => new CompanyError('invalid', message);

export function pageSizeOf(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_PAGE_SIZE;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw invalid(`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  return value;
}

export function cursorOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_CHARS) throw invalid('cursor must be a string issued by a previous page');
  return value;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw invalid(`${name} must be a non-empty string up to ${max} characters`);
  return value;
}

/**
 * A required task id (get_task_history). null is not an id: it is refused, as a missing one is. Every layer that reads
 * a task id from arguments (MCP schema, sidecar, core) takes the same rule, so null never becomes the string "null".
 */
export function taskIdOf(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw invalid('taskId is required: a non-empty string up to 200 characters');
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${name} must be true or false`);
  return value;
}

/**
 * A date (UTC midnight) or a date-time with a zone designator. A time without a zone reads as local time, which differs by
 * machine, so it is refused. Date.parse also accepts forms that the SurrealDB datetime cast refuses (F3): the value is
 * checked against the ISO shape first, and the query gets its canonical UTC form.
 */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** Date.parse rolls a day the month does not have into the next month (2026-02-29 reads as 2026-03-01), so the day must exist. */
function dayExists(text: string): boolean {
  const [year, month, day] = text.slice(0, 10).split('-').map(Number) as [number, number, number];
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function optionalIso(value: unknown, name: string): string | undefined {
  const text = optionalText(value, name, 40);
  if (text === undefined) return undefined;
  const ms = ISO_TIME.test(text) && dayExists(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms)) throw invalid(`${name} must be an ISO 8601 date, or a date-time with a zone such as 2026-10-19T00:00:00Z`);
  return new Date(ms).toISOString();
}

/**
 * A call that names pageSize or cursor is paged. Any other call is a legacy call: it keeps the pre-SYS01 keys and
 * asks for the complete answer, which is returned whole or refused as response_too_large.
 */
export const isPaged = (input: Record<string, unknown>): boolean =>
  (input.pageSize !== undefined && input.pageSize !== null) || (input.cursor !== undefined && input.cursor !== null);

/** get_context reads either the task working set (the default) or the company block (SYS01 AC-A). */
export const CONTEXT_SCOPES = ['tasks', 'company'] as const;
export type ContextScope = (typeof CONTEXT_SCOPES)[number];
/** Sections of the company block that scope company narrows to. The meta part (paused) is always read. */
export const COMPANY_SECTIONS = ['directions', 'goals', 'projects'] as const;
export type CompanySection = (typeof COMPANY_SECTIONS)[number];
/** Arguments that name a task filter. They are refused with scope company rather than ignored. */
const TASK_ONLY_CONTEXT_ARGUMENTS = ['taskId', 'state', 'goalId', 'role', 'since', 'fields', 'includeCompany'] as const;

export interface ContextParams {
  scope: ContextScope;
  section?: CompanySection;
  taskId?: string;
  state?: TaskState;
  goalId?: string;
  role?: Role;
  since?: string;
  pageSize: number;
  cursor?: string;
  /** Tasks scope only. Default false (SYS01 AC-A): the company block is read with scope company, or asked for here. */
  includeCompany: boolean;
  fields?: string[];
  /** True when the call names pageSize or cursor. Any other call asks for the complete answer (legacy). */
  paged: boolean;
}

export function parseContextInput(input: Record<string, unknown>): ContextParams {
  const scope = input.scope === undefined || input.scope === null ? 'tasks' : input.scope;
  if (scope !== 'tasks' && scope !== 'company') throw invalid(`scope must be one of ${CONTEXT_SCOPES.join(', ')}`);
  const pageSize = pageSizeOf(input.pageSize);
  const cursor = cursorOf(input.cursor);
  const paged = isPaged(input);
  if (scope === 'company') {
    for (const name of TASK_ONLY_CONTEXT_ARGUMENTS) {
      if (input[name] !== undefined && input[name] !== null) {
        throw invalid(`${name} filters tasks; with scope company only section, pageSize and cursor are read`);
      }
    }
    const section = input.section === undefined || input.section === null ? undefined : input.section;
    if (section !== undefined && !(COMPANY_SECTIONS as readonly unknown[]).includes(section)) {
      throw invalid(`section must be one of ${COMPANY_SECTIONS.join(', ')}`);
    }
    return { scope, section: section as CompanySection | undefined, pageSize, cursor, includeCompany: true, paged };
  }
  if (input.section !== undefined && input.section !== null) throw invalid('section is read with scope company');
  const state = input.state === undefined || input.state === null ? undefined : input.state;
  if (state !== undefined && (typeof state !== 'string' || !TASK_STATES.includes(state as TaskState))) {
    throw invalid(`state must be one of ${TASK_STATES.join(', ')}`);
  }
  const role = input.role === undefined || input.role === null ? undefined : input.role;
  if (role !== undefined && (typeof role !== 'string' || !ROLES.includes(role as Role))) throw invalid('role is not a known role');
  let fields: string[] | undefined;
  if (input.fields !== undefined && input.fields !== null) {
    if (!Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > TASK_FIELDS.length) {
      throw invalid('fields must be a non-empty list of task field names');
    }
    for (const field of input.fields) {
      if (typeof field !== 'string' || !TASK_FIELDS.includes(field)) throw invalid(`unknown task field: ${String(field).slice(0, 40)}`);
    }
    fields = [...new Set(input.fields as string[])];
  }
  return {
    scope,
    taskId: optionalText(input.taskId, 'taskId', 200),
    state: state as TaskState | undefined,
    goalId: optionalText(input.goalId, 'goalId', 100),
    role: role as Role | undefined,
    since: optionalIso(input.since, 'since'),
    pageSize,
    cursor,
    includeCompany: optionalBoolean(input.includeCompany, 'includeCompany') ?? false,
    fields,
    paged,
  };
}

export function parseHistoryInput(input: Record<string, unknown>): { paged: boolean; pageSize: number; cursor?: string } {
  return { paged: isPaged(input), pageSize: pageSizeOf(input.pageSize), cursor: cursorOf(input.cursor) };
}

export function parseWorktreeInput(input: Record<string, unknown>): {
  paged: boolean; taskId?: string; pageSize: number; cursor?: string; includeReleased: boolean;
} {
  return {
    paged: isPaged(input),
    taskId: optionalText(input.taskId, 'taskId', 200),
    pageSize: pageSizeOf(input.pageSize),
    cursor: cursorOf(input.cursor),
    includeReleased: optionalBoolean(input.includeReleased, 'includeReleased') ?? false,
  };
}

/** A repository path a reclaim may name: a non-empty string no longer than a filesystem path can be. */
const isRepoPath = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;

/**
 * Arguments of reclaim_worktrees (SYS01, D3). One rule on every layer (MCP, sidecar, core): an omitted dryRun is a reclaim, and
 * dryRun, when given, must be true or false, so null, "true", 1 and 0 are refused. repos, when given, is a list of paths, and
 * anything else (a string, a null, a number inside the list) is refused. A refused call touches no tree: the value is never read
 * as a default, so a bad value cannot widen into a reclaim of every repository.
 */
export function parseReclaimInput(input: unknown): { dryRun: boolean; repos?: string[] } {
  if (input === undefined) return { dryRun: false };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid('reclaim arguments must be one object');
  const { dryRun, repos } = input as Record<string, unknown>;
  if (dryRun !== undefined && typeof dryRun !== 'boolean') throw invalid('dryRun must be true or false; leave it out to reclaim');
  if (repos !== undefined && (!Array.isArray(repos) || !repos.every(isRepoPath))) {
    throw invalid('repos must be a list of repository paths, each a non-empty string');
  }
  return { dryRun: dryRun === true, ...(repos !== undefined ? { repos: [...repos] } : {}) };
}

/** Texts read_task_text returns. The list fields are the task's lists that a claim echo may cut (SYS01 R3). */
export const TEXT_FIELDS = ['context', 'evidence', 'project', 'dependencies', 'workIntentPaths', 'worktreePaths'] as const;
export function parseTextInput(input: Record<string, unknown>): {
  taskId: string; field: (typeof TEXT_FIELDS)[number]; auditId?: string; offset: number; limit: number; expectSha256?: string;
} {
  const taskId = optionalText(input.taskId, 'taskId', 200);
  if (!taskId) throw invalid('taskId is required');
  const field = input.field;
  if (typeof field !== 'string' || !(TEXT_FIELDS as readonly string[]).includes(field)) {
    throw invalid(`field must be one of ${TEXT_FIELDS.join(', ')}`);
  }
  return {
    taskId, field: field as (typeof TEXT_FIELDS)[number], auditId: optionalText(input.auditId, 'auditId', 200),
    ...parseSegmentWindow(input),
  };
}

/**
 * The byte window a segment read takes: offset, limit and the digest a continuation pins. read_task_text and
 * read_worktree_refs share it, so both refuse a continuation that does not pin the digest it started with (C3, SYS01 R1).
 */
function parseSegmentWindow(input: Record<string, unknown>): { offset: number; limit: number; expectSha256?: string } {
  const offset = input.offset === undefined || input.offset === null ? 0 : input.offset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 1e9) throw invalid('offset must be a non-negative integer');
  const limit = input.limit === undefined || input.limit === null ? undefined : input.limit;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 4 || limit > 24 * 1024)) {
    throw invalid('limit must be an integer from 4 to 24576 bytes');
  }
  const expectSha256 = optionalText(input.expectSha256, 'expectSha256', 64);
  if (expectSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectSha256)) throw invalid('expectSha256 must be a lowercase hex SHA-256 digest');
  // A segment past offset 0 must pin the digest the reassembly started with, so a text changed in between is refused (C3).
  if (offset > 0 && expectSha256 === undefined) {
    throw invalid('expectSha256 is required past offset 0: pass the sha256 returned by the first segment of this text');
  }
  return { offset, limit: limit ?? 16 * 1024, expectSha256 };
}

/**
 * Arguments of read_worktree_refs (SYS01 R1): the worktree a paged listing item named, the same includeReleased the listing
 * used, and the byte window a reader continues with. A global read (no taskId) is gm only, as on list_worktrees.
 */
export function parseWorktreeRefsInput(input: Record<string, unknown>): {
  taskId?: string; worktreePath: string; includeReleased: boolean; offset: number; limit: number; expectSha256?: string;
} {
  const taskId = optionalText(input.taskId, 'taskId', 200);
  const worktreePath = input.worktreePath;
  if (typeof worktreePath !== 'string' || worktreePath.trim().length === 0 || worktreePath.length > 4096) {
    throw invalid('worktreePath is required: the canonical path a worktree listing returned, up to 4096 characters');
  }
  return {
    ...(taskId !== undefined ? { taskId } : {}),
    worktreePath,
    includeReleased: optionalBoolean(input.includeReleased, 'includeReleased') ?? false,
    ...parseSegmentWindow(input),
  };
}

export function parseSummaryInput(input: Record<string, unknown>): { since?: string; goalId?: string } {
  return { since: optionalIso(input.since, 'since'), goalId: optionalText(input.goalId, 'goalId', 100) };
}

/** Digest of the query a cursor is bound to: its filters and its projection (fields). The page size is not part of it. */
export function queryDigest(kind: string, filters: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.keys(filters).sort().map(key => [key, filters[key] ?? null]));
  return createHash('sha256').update(`${kind}\0${canonical}`).digest('hex');
}
