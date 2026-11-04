import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatcherLogSink } from '../src/dispatcher/log-sink.ts';

// FV06: the plugin host's dispatcher log used to be console-only, so recovery wake/skip/fail lines were only
// visible in Paseo. The sink appends the same lines to <serviceHome>/logs/dispatcher.log.
describe('the dispatcher log sink', () => {
  test('creates logs/dispatcher.log and appends ISO-timestamped lines in order', () => {
    const home = mkdtempSync(join(tmpdir(), 'sck-dispatcher-log-'));
    try {
      const log = dispatcherLogSink(home);
      log('recovery wake skip grant g1 employee e1 reason=no_instance');
      log('recovery wake skip grant g1 inst i1 reason=state=busy');
      const file = join(home, 'logs', 'dispatcher.log');
      expect(existsSync(file)).toBe(true);
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      // ISO timestamp, then the message verbatim.
      for (const line of lines) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
      expect(lines[0]!.endsWith('recovery wake skip grant g1 employee e1 reason=no_instance')).toBe(true);
      expect(lines[1]!.endsWith('recovery wake skip grant g1 inst i1 reason=state=busy')).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('appends to an existing log instead of truncating it', () => {
    const home = mkdtempSync(join(tmpdir(), 'sck-dispatcher-log-'));
    try {
      const log = dispatcherLogSink(home);
      log('first pass');
      log('second pass');
      const text = readFileSync(join(home, 'logs', 'dispatcher.log'), 'utf8');
      expect(text).toContain('first pass');
      expect(text).toContain('second pass');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a sink that cannot write never throws: the console line is the primary record', () => {
    const home = mkdtempSync(join(tmpdir(), 'sck-dispatcher-log-'));
    try {
      // A regular file where the directory should be makes the append fail for real.
      writeFileSync(join(home, 'logs'), 'not a directory');
      const log = dispatcherLogSink(home);
      expect(() => log('recovery wake skip grant g1 inst i1 reason=no_agent')).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
