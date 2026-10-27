/**
 * The browser injector's diagnostics and the lease-end space closer, exercised against a real child
 * process (a fake CLI), because the contract is about what crosses that boundary: the first error
 * line, the stage, the exit code and the elapsed time — and never the token.
 */
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browserCloseOutcome, browserCloseScript, browserInjectFailure, egoBrowserInjector, egoBrowserSpaceCloser,
} from '../src/ops/browser.ts';

// Built at runtime so the fixture value is not a credential-shaped literal in the source.
const TOKEN = ['test', 'credential', 'value', '42'].join('-');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sck-browser-'));
}

/** A fake ego-browser CLI: ignores argv, consumes the script on stdin, then runs the body. */
function fakeBin(body: string): string {
  const dir = tempDir();
  const file = join(dir, 'ego-browser');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

async function withBin<T>(bin: string, work: () => Promise<T>): Promise<T> {
  const prior = process.env.SCK_EGO_BROWSER_BIN;
  process.env.SCK_EGO_BROWSER_BIN = bin;
  try {
    return await work();
  } finally {
    if (prior === undefined) delete process.env.SCK_EGO_BROWSER_BIN;
    else process.env.SCK_EGO_BROWSER_BIN = prior;
  }
}

const injectInput = () => ({
  spaceId: 5, page: 'p1', probeUrl: 'https://app.test/health', landingUrl: 'https://app.test/',
  token: TOKEN, expiresAt: 1_700_000_000_000,
});

test('a missing space keeps the CLI first line, the stage, the exit code and the elapsed time', () => {
  const stderr = [
    'SCK_STAGE space',
    'SCK_ERROR {"stage":"space","name":"Error","message":"task space not found: 5"}',
    'Error: task space not found: 5',
    '    at resolveTaskSpace (file:////[eval1]:20251:19)',
    '[ego-browser:notice] Ego Lite update is available (current 0.6.1.9).',
  ].join('\n');
  const failure = browserInjectFailure({ stdout: '', stderr, exitCode: 1, elapsedMs: 48_213 });
  expect(failure).toMatchObject({ code: 'not_found', retryable: false, stage: 'space' });
  expect(failure.message).toContain('task space not found: 5');
  expect(failure.message).toContain('stage=space');
  expect(failure.message).toContain('exit 1');
  expect(failure.message).toContain('48213ms');
  expect(failure.message.length).toBeLessThanOrEqual(800);
});

test('only an explicit timeout or connection failure is retryable; a generic failure is not', () => {
  const timeout = browserInjectFailure({
    stdout: '', exitCode: 1, elapsedMs: 60_000, timedOut: true,
    stderr: 'SCK_STAGE probe\nError: waiting for navigation',
  });
  expect(timeout).toMatchObject({ code: 'upstream_error', retryable: true, stage: 'probe', errno: 'ETIMEDOUT' });

  const net = browserInjectFailure({
    stdout: '', exitCode: 1, elapsedMs: 100,
    stderr: 'SCK_STAGE landing\nError: page.goto: net::ERR_CONNECTION_RESET at https://app.test/',
  });
  expect(net).toMatchObject({ retryable: true, errno: 'ECONNRESET' });

  // An unknown failure is never assumed to be a network fault: no retry, and the injection scope stops.
  const unknown = browserInjectFailure({
    stdout: '', exitCode: 1, elapsedMs: 100,
    stderr: 'SCK_ERROR {"stage":"store","name":"Error","message":"EGO_SCRIPT_STATE_BROKEN"}',
  });
  expect(unknown).toMatchObject({ code: 'upstream_error', retryable: false, stage: 'store' });
  expect(unknown.errno).toBeUndefined();
});

test('the injector sends the token on stdin, never on argv, and reports the landed page', async () => {
  const dir = tempDir();
  const argvFile = join(dir, 'argv.txt');
  const stdinFile = join(dir, 'stdin.txt');
  const bin = fakeBin([
    `printf '%s' "$*" > '${argvFile}'`,
    `cat > '${stdinFile}'`,
    `printf '%s\\n' 'SCK_STAGE space' 'SCK_STAGE probe' 'SCK_STAGE store' 'SCK_STAGE landing' 'SCK_RESULT {"url":"https://app.test/","title":"Fixture App"}' >&2`,
    'exit 0',
  ].join('\n'));
  const result = await withBin(bin, () => egoBrowserInjector(injectInput()));
  expect(result).toEqual({ url: 'https://app.test/', title: 'Fixture App' });
  expect(readFileSync(argvFile, 'utf8')).toBe('nodejs');
  const script = readFileSync(stdinFile, 'utf8');
  expect(script).toContain(TOKEN);
  expect(script).toContain('SCK_STAGE probe');
  expect(script).toContain('SCK_STAGE landing');
});

test('a failed injector rejects with a sanitized diagnostic and never echoes the token', async () => {
  const bin = fakeBin([
    `printf '%s\\n' 'SCK_STAGE probe' 'SCK_ERROR {"stage":"probe","name":"TimeoutError","message":"page.goto: Timeout 60000ms exceeded"}' 'Error: page.goto: Timeout 60000ms exceeded' "leaked token ${TOKEN}" >&2`,
    'exit 1',
  ].join('\n'));
  let thrown: (Error & { code?: string; retryable?: boolean; facts?: { errno?: string } }) | undefined;
  try {
    await withBin(bin, () => egoBrowserInjector(injectInput()));
  } catch (error) {
    thrown = error as typeof thrown;
  }
  expect(thrown).toBeDefined();
  expect(thrown!.code).toBe('upstream_error');
  expect(thrown!.retryable).toBe(true);
  expect(thrown!.facts?.errno).toBe('TimeoutError');
  expect(thrown!.message).toContain('page.goto: Timeout 60000ms exceeded');
  expect(thrown!.message).toContain('stage=probe');
  expect(thrown!.message).toContain('exit 1');
  expect(thrown!.message).not.toContain(TOKEN);
});

test('the close script finishes only an agent-owned space and never takes over a user space', () => {
  const script = browserCloseScript(7);
  expect(script).toContain("entry.ownership !== 'agent'");
  expect(script).toContain('task.finish({ keep: [] })');
  expect(script).not.toContain('takeOverTaskSpace');
  expect(script).not.toContain('claimTaskSpace');
});

test('a close outcome is parsed from either stream', () => {
  expect(browserCloseOutcome('', 'SCK_CLOSE {"outcome":"closed"}')).toEqual({ outcome: 'closed' });
  expect(browserCloseOutcome('SCK_CLOSE {"outcome":"absent"}', '')).toEqual({ outcome: 'absent' });
  expect(browserCloseOutcome('', 'SCK_CLOSE {"outcome":"skipped","ownership":"user"}')).toEqual({ outcome: 'skipped', ownership: 'user' });
  expect(browserCloseOutcome('nothing', '')).toBeUndefined();
});

test('the closer resolves for closed, absent, and user-owned spaces', async () => {
  for (const line of [
    'SCK_CLOSE {"outcome":"closed"}',
    'SCK_CLOSE {"outcome":"absent"}',
    'SCK_CLOSE {"outcome":"skipped","ownership":"user"}',
  ]) {
    const bin = fakeBin(`printf '%s\\n' '${line}' >&2\nexit 0`);
    await withBin(bin, () => egoBrowserSpaceCloser({ employeeId: 'e1', spaceId: 7 }));
  }
});

test('a close that raced another finish is idempotent, not a pending space', async () => {
  const bin = fakeBin(`printf '%s\\n' 'Error: task space not found: 7' >&2\nexit 1`);
  await withBin(bin, () => egoBrowserSpaceCloser({ employeeId: 'e1', spaceId: 7 }));
});

test('a real close failure rejects with the stage and exit code so the broker keeps it pending', async () => {
  const bin = fakeBin(`printf '%s\\n' 'SCK_ERROR {"stage":"finish","name":"Error","message":"browser process crashed"}' 'Error: browser process crashed' >&2\nexit 1`);
  let thrown: Error | undefined;
  try {
    await withBin(bin, () => egoBrowserSpaceCloser({ employeeId: 'e1', spaceId: 7 }));
  } catch (error) {
    thrown = error as Error;
  }
  expect(thrown).toBeDefined();
  expect(thrown!.message).toContain('close failed');
  expect(thrown!.message).toContain('stage=finish');
  expect(thrown!.message).toContain('exit 1');
});
