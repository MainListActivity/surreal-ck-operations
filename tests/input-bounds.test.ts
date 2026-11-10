import { expect, test } from 'bun:test';
import {
  MAX_ASSET_PATHS, MAX_ASSET_PATH_CHARS, MAX_TASK_ID_CHARS,
  PROJECT_TEXT_LIMITS, projectTextLengths, validateProjectTexts,
} from '../src/input-bounds.ts';
import { validateIntent } from '../src/dispatcher/worktree-registry.ts';

const ascii = (bytes: number): string => 'a'.repeat(bytes);
const errorOf = (action: () => void): Error & { code?: string } => {
  try { action(); } catch (error) { return error as Error & { code?: string }; }
  throw new Error('expected a refusal');
};
const noThrow = (action: () => void): void => { expect(action).not.toThrow(); };

test('asset intent keeps the existing 50-entry and 300-character rules, and non-assets never carry paths', () => {
  const paths = (count: number, length = 280): string[] => Array.from({ length: count }, (_, index) => `assets/${index}/${ascii(length)}`);
  noThrow(() => validateIntent({ kind: 'assets', paths: paths(MAX_ASSET_PATHS) }));
  expect(() => validateIntent({ kind: 'assets', paths: paths(MAX_ASSET_PATHS + 1) })).toThrow(/authorized relative directories/);
  noThrow(() => validateIntent({ kind: 'assets', paths: [`assets/${ascii(MAX_ASSET_PATH_CHARS - 'assets/'.length)}`] }));
  expect(() => validateIntent({ kind: 'assets', paths: [`assets/${ascii(MAX_ASSET_PATH_CHARS + 1 - 'assets/'.length)}`] })).toThrow(/Unsafe asset write directory/);
  expect(() => validateIntent({ kind: 'code', paths: ['assets/a'] })).toThrow(/Only assets use directory write scopes/);
});

test('project release/rollback are 16 KiB UTF-8 and notes is 32 KiB, with exact boundaries and real emoji bytes', () => {
  noThrow(() => validateProjectTexts({ release: ascii(PROJECT_TEXT_LIMITS.releaseBytes) }));
  expect(() => validateProjectTexts({ release: ascii(PROJECT_TEXT_LIMITS.releaseBytes + 1) })).toThrow(/release bytes 16385 exceeds limit 16384/);
  noThrow(() => validateProjectTexts({ release: 'ok', rollback: ascii(PROJECT_TEXT_LIMITS.rollbackBytes) }));
  expect(() => validateProjectTexts({ release: 'ok', rollback: ascii(PROJECT_TEXT_LIMITS.rollbackBytes + 1) })).toThrow(/rollback bytes 16385 exceeds limit 16384/);
  noThrow(() => validateProjectTexts({ release: 'ok', notes: ascii(PROJECT_TEXT_LIMITS.notesBytes) }));
  expect(() => validateProjectTexts({ release: 'ok', notes: ascii(PROJECT_TEXT_LIMITS.notesBytes + 1) })).toThrow(/notes bytes 32769 exceeds limit 32768/);
  // Each emoji is four UTF-8 bytes: 4096 emoji are exactly 16384 bytes, 4097 are 16388.
  noThrow(() => validateProjectTexts({ release: '🙂'.repeat(4096) }));
  expect(() => validateProjectTexts({ release: '🙂'.repeat(4097) })).toThrow(/release bytes 16388 exceeds limit 16384/);
  // Chinese is three bytes per character.
  noThrow(() => validateProjectTexts({ release: '甲'.repeat(5461) + 'a' }));
  expect(() => validateProjectTexts({ release: '甲'.repeat(5462) })).toThrow(/release bytes 16386 exceeds limit 16384/);
  expect(errorOf(() => validateProjectTexts({ release: 1 as never })).message).toContain('release must be a string');
});

/** 16 entries: 15 full 2048-byte entries plus one sized so JSON.stringify has exactly `total` UTF-8 bytes. */
function runbooksAtTotal(total: number): string[] {
  const count = 16;
  const sum = total - (3 * count + 1);
  const entries = Array.from({ length: count - 1 }, () => ascii(PROJECT_TEXT_LIMITS.runbookBytes));
  return [...entries, ascii(sum - (count - 1) * PROJECT_TEXT_LIMITS.runbookBytes)];
}

test('runbooks enforce 50 entries, 2 KiB per entry and 32 KiB serialized UTF-8 total', () => {
  const entries = (count: number, length = 1): string[] => Array.from({ length: count }, () => ascii(length));
  noThrow(() => validateProjectTexts({ release: 'ok', runbooks: entries(PROJECT_TEXT_LIMITS.runbooks) }));
  expect(() => validateProjectTexts({ release: 'ok', runbooks: entries(PROJECT_TEXT_LIMITS.runbooks + 1) })).toThrow(/runbooks count 51 exceeds limit 50/);
  noThrow(() => validateProjectTexts({ release: 'ok', runbooks: [ascii(PROJECT_TEXT_LIMITS.runbookBytes)] }));
  expect(() => validateProjectTexts({ release: 'ok', runbooks: [ascii(PROJECT_TEXT_LIMITS.runbookBytes + 1)] })).toThrow(/runbooks\[0\] bytes 2049 exceeds limit 2048/);
  const exact = runbooksAtTotal(PROJECT_TEXT_LIMITS.runbooksTotalBytes);
  expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(PROJECT_TEXT_LIMITS.runbooksTotalBytes);
  noThrow(() => validateProjectTexts({ release: 'ok', runbooks: exact }));
  const over = runbooksAtTotal(PROJECT_TEXT_LIMITS.runbooksTotalBytes + 1);
  expect(() => validateProjectTexts({ release: 'ok', runbooks: over })).toThrow(/runbooks serialized bytes 32769 exceeds limit 32768/);
  expect(() => validateProjectTexts({ release: 'ok', runbooks: ['ok', 1 as never] })).toThrow(/runbooks\[1\] must be a string/);
});

test('an unchanged stored over-size field is preserved; a changed field must fit the new limit', () => {
  const existing = { release: ascii(16385), notes: ascii(32769), runbooks: [ascii(2049)] };
  noThrow(() => validateProjectTexts({
    release: existing.release, notes: existing.notes, runbooks: existing.runbooks,
  }, existing));
  expect(() => validateProjectTexts({ release: ascii(16386), notes: existing.notes, runbooks: existing.runbooks }, existing)).toThrow(/release bytes 16386/);
  expect(() => validateProjectTexts({ release: existing.release, notes: ascii(32770), runbooks: existing.runbooks }, existing)).toThrow(/notes bytes 32770/);
  expect(() => validateProjectTexts({ release: existing.release, notes: existing.notes, runbooks: [ascii(2050)] }, existing)).toThrow(/runbooks\[0\] bytes 2050/);
  // An unchanged old field may survive while another field is changed to a legal value.
  noThrow(() => validateProjectTexts({ release: 'legal', notes: existing.notes, runbooks: existing.runbooks }, existing));
});

test('length diagnostics expose field names, counts and bytes only, never the text', () => {
  const lengths = projectTextLengths({
    release: ascii(16385), rollback: '🙂', notes: '甲', runbooks: ['short', ascii(2049)],
  });
  expect(lengths.release).toEqual({ bytes: 16385, limit: 16384, over: true });
  expect(lengths.rollback).toEqual({ bytes: 4, limit: 16384, over: false });
  expect(lengths.notes).toEqual({ bytes: 3, limit: 32768, over: false });
  expect(lengths.runbooks.count).toBe(2);
  expect(lengths.runbooks.entries).toEqual([5, 2049]);
  expect(lengths.runbooks.over).toBe(true);
  expect(JSON.stringify(lengths)).not.toContain(ascii(100));
  expect(JSON.stringify(lengths)).not.toContain('short');
});
