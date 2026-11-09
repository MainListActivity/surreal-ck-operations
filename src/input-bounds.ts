import { CompanyError } from './core-errors.ts';

/** Task IDs are opaque strings at the core boundary; this is the same cap the task-reading inputs use. */
export const MAX_TASK_ID_CHARS = 200;
/** Existing asset-intent limits, kept in one place so MCP, sidecar and core cannot drift. */
export const MAX_ASSET_PATHS = 50;
export const MAX_ASSET_PATH_CHARS = 300;

/** Public project text limits. Bytes are UTF-8 bytes; character counts are not used for these fields. */
export const PROJECT_TEXT_LIMITS = {
  releaseBytes: 16 * 1024,
  rollbackBytes: 16 * 1024,
  notesBytes: 32 * 1024,
  runbooks: 50,
  runbookBytes: 2 * 1024,
  runbooksTotalBytes: 32 * 1024,
} as const;

const invalid = (message: string) => new CompanyError('invalid', message);
const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

export interface ProjectTextInput {
  release: string;
  rollback?: string;
  notes?: string;
  runbooks?: string[];
}

/** The stored shape needed to let an unchanged, pre-limit over-size field stay untouched. */
export interface ProjectTextExisting {
  release?: string;
  rollback?: string;
  notes?: string;
  runbooks?: string[];
}

export interface ProjectFieldLength {
  bytes: number;
  limit: number;
  over: boolean;
}

export interface ProjectRunbookLengths {
  count: number;
  limit: number;
  entries: number[];
  entryLimit: number;
  totalBytes: number;
  totalLimit: number;
  over: boolean;
}

export interface ProjectTextLengths {
  release: ProjectFieldLength;
  rollback: ProjectFieldLength;
  notes: ProjectFieldLength;
  runbooks: ProjectRunbookLengths;
}

const fieldLength = (value: unknown, limit: number): ProjectFieldLength => {
  const bytes = typeof value === 'string' ? utf8Bytes(value) : 0;
  return { bytes, limit, over: bytes > limit };
};

/** Read-only diagnostic: field names, counts and UTF-8 byte counts only, never the text itself. */
export function projectTextLengths(input: ProjectTextInput): ProjectTextLengths {
  const runbooks = Array.isArray(input.runbooks) ? input.runbooks : [];
  const entries = runbooks.map(value => typeof value === 'string' ? utf8Bytes(value) : 0);
  const totalBytes = Array.isArray(input.runbooks) ? utf8Bytes(JSON.stringify(input.runbooks)) : 0;
  return {
    release: fieldLength(input.release, PROJECT_TEXT_LIMITS.releaseBytes),
    rollback: fieldLength(input.rollback, PROJECT_TEXT_LIMITS.rollbackBytes),
    notes: fieldLength(input.notes, PROJECT_TEXT_LIMITS.notesBytes),
    runbooks: {
      count: runbooks.length,
      limit: PROJECT_TEXT_LIMITS.runbooks,
      entries,
      entryLimit: PROJECT_TEXT_LIMITS.runbookBytes,
      totalBytes,
      totalLimit: PROJECT_TEXT_LIMITS.runbooksTotalBytes,
      over: runbooks.length > PROJECT_TEXT_LIMITS.runbooks
        || entries.some(bytes => bytes > PROJECT_TEXT_LIMITS.runbookBytes)
        || totalBytes > PROJECT_TEXT_LIMITS.runbooksTotalBytes,
    },
  };
}

/**
 * Pure project text validation. Every write path (admin `project set`, `project check`, and any
 * other ProjectStore.upsert caller) passes the complete candidate through here before the project
 * or any environment row is written.
 *
 * Compatibility: a field identical to the stored field is allowed even when it is over the new
 * limit, so an old over-size project can be edited elsewhere without being rewritten. A changed
 * field must fit the new limit; this is the only way an unchanged old value survives.
 */
export function validateProjectTexts(input: ProjectTextInput, existing?: ProjectTextExisting): void {
  const check = (name: 'release' | 'rollback' | 'notes', value: unknown, limit: number, required: boolean): void => {
    if (value === undefined) {
      if (required) throw invalid(`${name} must be a string`);
      return;
    }
    if (typeof value !== 'string') throw invalid(`${name} must be a string`);
    const bytes = utf8Bytes(value);
    if (bytes > limit && value !== existing?.[name]) {
      throw invalid(`${name} bytes ${bytes} exceeds limit ${limit}`);
    }
  };
  check('release', input.release, PROJECT_TEXT_LIMITS.releaseBytes, true);
  check('rollback', input.rollback, PROJECT_TEXT_LIMITS.rollbackBytes, false);
  check('notes', input.notes, PROJECT_TEXT_LIMITS.notesBytes, false);
  if (input.runbooks !== undefined) {
    if (!Array.isArray(input.runbooks)) throw invalid('runbooks must be a list');
    for (let index = 0; index < input.runbooks.length; index++) {
      if (typeof input.runbooks[index] !== 'string') throw invalid(`runbooks[${index}] must be a string`);
    }
    const unchanged = existing?.runbooks !== undefined
      && JSON.stringify(existing.runbooks) === JSON.stringify(input.runbooks);
    if (!unchanged) {
      if (input.runbooks.length > PROJECT_TEXT_LIMITS.runbooks) {
        throw invalid(`runbooks count ${input.runbooks.length} exceeds limit ${PROJECT_TEXT_LIMITS.runbooks}`);
      }
      for (let index = 0; index < input.runbooks.length; index++) {
        const bytes = utf8Bytes(input.runbooks[index]!);
        if (bytes > PROJECT_TEXT_LIMITS.runbookBytes) {
          throw invalid(`runbooks[${index}] bytes ${bytes} exceeds limit ${PROJECT_TEXT_LIMITS.runbookBytes}`);
        }
      }
      const totalBytes = utf8Bytes(JSON.stringify(input.runbooks));
      if (totalBytes > PROJECT_TEXT_LIMITS.runbooksTotalBytes) {
        throw invalid(`runbooks serialized bytes ${totalBytes} exceeds limit ${PROJECT_TEXT_LIMITS.runbooksTotalBytes}`);
      }
    }
  }
}
