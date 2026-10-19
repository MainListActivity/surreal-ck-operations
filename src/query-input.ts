// Argument parsing for the bounded reads (SYS01). Arguments arrive untyped from the sidecar relay,
// so every field is checked here: an invalid value is refused, never widened into an unbounded query.
import { createHash } from 'node:crypto';
import { CompanyError } from './core-errors.ts';
import { ROLES, type Role, type TaskState } from './contracts.ts';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MAX_CURSOR_CHARS = 2048;

const TASK_STATES: readonly TaskState[] = ['blocked', 'ready', 'doing', 'review', 'done', 'void'];
/** Top-level TaskView keys a caller may project. Anything else is refused. */
export const TASK_FIELDS: readonly string[] = [
  'id', 'title', 'context', 'state', 'executorRole', 'reviewerRole', 'discipline', 'kind', 'goalId', 'projectOverlay',
  'codeRepoPath', 'dependencies', 'version', 'submittedBy', 'currentEmployee', 'deliveryId', 'leaseExpiresAt', 'fence',
  'blockedTo', 'handover', 'previousEmployee', 'workIntent', 'worktree', 'revises', 'supersededBy', 'lineage', 'revisionNo',
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

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${name} must be true or false`);
  return value;
}

function optionalIso(value: unknown, name: string): string | undefined {
  const text = optionalText(value, name, 40);
  if (text !== undefined && Number.isNaN(Date.parse(text))) throw invalid(`${name} must be an ISO 8601 time`);
  return text;
}

export interface ContextParams {
  taskId?: string;
  state?: TaskState;
  goalId?: string;
  role?: Role;
  since?: string;
  pageSize: number;
  cursor?: string;
  includeCompany: boolean;
  fields?: string[];
  /** True for a call that names neither pageSize nor cursor: the pre-SYS01 shape stays available. */
  legacyShape: boolean;
}

export function parseContextInput(input: Record<string, unknown>): ContextParams {
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
  const pageSize = pageSizeOf(input.pageSize);
  const cursor = cursorOf(input.cursor);
  return {
    taskId: optionalText(input.taskId, 'taskId', 200),
    state: state as TaskState | undefined,
    goalId: optionalText(input.goalId, 'goalId', 100),
    role: role as Role | undefined,
    since: optionalIso(input.since, 'since'),
    pageSize,
    cursor,
    includeCompany: optionalBoolean(input.includeCompany, 'includeCompany') ?? (input.pageSize === undefined && input.cursor === undefined),
    fields,
    legacyShape: input.pageSize === undefined && input.cursor === undefined,
  };
}

export function parseHistoryInput(input: Record<string, unknown>): { pageSize: number; cursor?: string } {
  return { pageSize: pageSizeOf(input.pageSize), cursor: cursorOf(input.cursor) };
}

export function parseWorktreeInput(input: Record<string, unknown>): {
  taskId?: string; pageSize: number; cursor?: string; includeReleased: boolean;
} {
  return {
    taskId: optionalText(input.taskId, 'taskId', 200),
    pageSize: pageSizeOf(input.pageSize),
    cursor: cursorOf(input.cursor),
    includeReleased: optionalBoolean(input.includeReleased, 'includeReleased') ?? false,
  };
}

export const TEXT_FIELDS = ['context', 'evidence'] as const;
export function parseTextInput(input: Record<string, unknown>): {
  taskId: string; field: (typeof TEXT_FIELDS)[number]; auditId?: string; offset: number; limit: number;
} {
  const taskId = optionalText(input.taskId, 'taskId', 200);
  if (!taskId) throw invalid('taskId is required');
  const field = input.field;
  if (typeof field !== 'string' || !(TEXT_FIELDS as readonly string[]).includes(field)) throw invalid('field must be context or evidence');
  const offset = input.offset === undefined || input.offset === null ? 0 : input.offset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 1e9) throw invalid('offset must be a non-negative integer');
  const limit = input.limit === undefined || input.limit === null ? undefined : input.limit;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 4 || limit > 24 * 1024)) {
    throw invalid('limit must be an integer from 4 to 24576 bytes');
  }
  return {
    taskId, field: field as (typeof TEXT_FIELDS)[number], auditId: optionalText(input.auditId, 'auditId', 200),
    offset, limit: (limit as number | undefined) ?? 16 * 1024,
  };
}

export function parseSummaryInput(input: Record<string, unknown>): { since?: string; goalId?: string } {
  return { since: optionalIso(input.since, 'since'), goalId: optionalText(input.goalId, 'goalId', 100) };
}

/** Digest of the filters a cursor is bound to. Page size and projection are not part of the binding. */
export function queryDigest(kind: string, filters: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.keys(filters).sort().map(key => [key, filters[key] ?? null]));
  return createHash('sha256').update(`${kind}\0${canonical}`).digest('hex');
}
