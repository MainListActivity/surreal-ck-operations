import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyError, RepoLockError, isRepoLockError } from '../src/core-errors.ts';
import type { RepoLockTiming } from '../src/host-io.ts';
import {
  REPO_LOCK_SLOW_MS, WorktreeRegistry, repoLockLogLine, validateIntent, withRepoLock, type RepoLockEvent,
} from '../src/dispatcher/worktree-registry.ts';

test('kernel repo lock serializes independent allocations and releases on failed action', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sck-repo-lock-'));
  const order: string[] = [];
  let enter!: () => void; const entered = new Promise<void>(done => { enter = done; });
  let release!: () => void; const held = new Promise<void>(done => { release = done; });
  try {
    const a = withRepoLock(dir, async () => { order.push('a'); enter(); await held; throw new Error('synthetic allocation failure'); });
    const failed = a.catch((error: Error) => error);
    await entered;
    const b = withRepoLock(dir, async () => { order.push('b'); });
    await Bun.sleep(50); expect(order).toEqual(['a']); release(); expect((await failed as Error).message).toBe('synthetic allocation failure'); await b;
    expect(order).toEqual(['a', 'b']);
    await withRepoLock(dir, async () => { order.push('retry'); }); expect(order).toEqual(['a', 'b', 'retry']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('work authorization rejects opaque fields, unsafe paths and non-array scopes before persistence', () => {
  for (const intent of [null, { kind: 'assets', paths: 'assets' }, { kind: 'read', token: 'synthetic-denied' },
    { kind: 'assets', paths: ['.GIT'] }, { kind: 'assets', paths: ['assets/../code'] }, { kind: 'code', lane: 1 }]) {
    expect(() => validateIntent(intent as never)).toThrow();
  }
  expect(() => validateIntent({ kind: 'assets', paths: ['assets/角色', 'assets/music'] })).not.toThrow();
});

const lockDir = () => mkdtempSync(join(tmpdir(), 'sck-repo-lock-observe-'));

/** A repository with one commit: the registry lock needs a git common directory to take the lock in. */
function gitRepo(): string {
  const path = mkdtempSync(join(tmpdir(), 'sck-repo-lock-git-'));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', path, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode) throw new Error(result.stderr.toString());
  };
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', path]);
  writeFileSync(join(path, 'source.txt'), 'baseline');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline');
  return path;
}

test('a repository lock error names its state, stays retryable, and only a repository lock error is recognised as one', () => {
  const busy = new RepoLockError('busy', 'Repository allocation lock busy');
  expect(busy).toBeInstanceOf(CompanyError);
  expect(busy).toMatchObject({ code: 'conflict', retryable: true, lock: 'busy', name: 'RepoLockError' });
  expect(isRepoLockError(busy)).toBe(true);
  expect(isRepoLockError(new CompanyError('conflict', 'Repository allocation lock busy'))).toBe(false);
  // The plugin bundle loads its own copy of the module, so a lock error from that copy is recognised by its name.
  expect(isRepoLockError(Object.assign(new Error('Repository allocation lock lost'), { name: 'RepoLockError' }))).toBe(true);
  expect(isRepoLockError(new Error('Repository allocation lock busy'))).toBe(false);
});

test('lock timing counts the queue and the time the lock is held apart', async () => {
  const dir = lockDir();
  const timing: { holder?: RepoLockTiming; waiter?: RepoLockTiming } = {};
  try {
    const first = withRepoLock(dir, () => Bun.sleep(300), { observe: t => { timing.holder = t; } });
    await Bun.sleep(60);
    const second = withRepoLock(dir, async () => 'queued', { observe: t => { timing.waiter = t; } });
    await Promise.all([first, second]);
    expect(timing.holder).toMatchObject({ result: 'ok' });
    expect(timing.holder!.heldMs).toBeGreaterThanOrEqual(250);
    expect(timing.holder!.waitMs).toBeLessThan(timing.holder!.heldMs!);
    expect(timing.waiter).toMatchObject({ result: 'ok' });
    expect(timing.waiter!.waitMs).toBeGreaterThanOrEqual(150);
    expect(timing.waiter!.heldMs!).toBeLessThan(timing.waiter!.waitMs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an attempt that cannot take the lock in time fails as busy without running its action, and the lock is free afterwards', async () => {
  const dir = lockDir();
  let entered!: () => void; const inside = new Promise<void>(done => { entered = done; });
  let leave!: () => void; const release = new Promise<void>(done => { leave = done; });
  try {
    const holder = withRepoLock(dir, async () => { entered(); await release; });
    await inside;
    let ran = false;
    const timing: { value?: RepoLockTiming } = {};
    const failure = await withRepoLock(dir, async () => { ran = true; }, { acquireMs: 150, observe: t => { timing.value = t; } })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RepoLockError);
    expect(failure).toMatchObject({ lock: 'busy', retryable: true });
    expect(ran).toBe(false);
    expect(timing.value).toMatchObject({ result: 'busy' });
    expect(timing.value!.heldMs).toBeUndefined();
    expect(timing.value!.waitMs).toBeGreaterThanOrEqual(140);
    leave();
    await holder;
    await withRepoLock(dir, async () => { ran = true; }, { acquireMs: 5_000 });
    expect(ran).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failing action is observed as error with its hold time, and the lock is released', async () => {
  const dir = lockDir();
  const timing: { value?: RepoLockTiming } = {};
  try {
    await expect(withRepoLock(dir, async () => { await Bun.sleep(40); throw new Error('synthetic action failure'); },
      { observe: t => { timing.value = t; } })).rejects.toThrow('synthetic action failure');
    expect(timing.value).toMatchObject({ result: 'error' });
    expect(timing.value!.heldMs).toBeGreaterThanOrEqual(30);
    await withRepoLock(dir, async () => undefined, { acquireMs: 5_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lock holder that exits releases the lock at once, so a waiting attempt takes it', async () => {
  const dir = lockDir();
  // The helper program of host-node.ts, run as a separate process that is killed while it holds the lock.
  const holder = Bun.spawn(['/usr/bin/python3', '-c',
    'import fcntl,sys; f=open(sys.argv[1], "a"); fcntl.flock(f, fcntl.LOCK_EX); print("locked", flush=True); sys.stdin.buffer.read()',
    join(dir, 'sck-worktree-allocation.lock')], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  try {
    const reader = holder.stdout.getReader();
    let output = '';
    while (!output.includes('locked')) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    expect(output).toContain('locked');
    holder.kill('SIGKILL');
    await holder.exited;
    const timing: { value?: RepoLockTiming } = {};
    let ran = false;
    await withRepoLock(dir, async () => { ran = true; }, { acquireMs: 5_000, observe: t => { timing.value = t; } });
    expect(ran).toBe(true);
    expect(timing.value).toMatchObject({ result: 'ok' });
    expect(timing.value!.waitMs).toBeLessThan(4_000);
  } finally {
    holder.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repo lock log lines name the operation, an anonymous repo id and the timings, and only the attempts worth reading', () => {
  const quick: RepoLockEvent = { operation: 'claim', repo: 'a1b2c3d4', waitMs: 3, heldMs: 12, result: 'ok' };
  expect(repoLockLogLine(quick)).toBeUndefined();
  expect(repoLockLogLine({ ...quick, result: 'error' })).toBe('repo lock claim a1b2c3d4 error wait=3ms held=12ms');
  expect(repoLockLogLine({ ...quick, result: 'busy', waitMs: 35_000, heldMs: undefined })).toBe('repo lock claim a1b2c3d4 busy wait=35000ms');
  expect(repoLockLogLine({ ...quick, waitMs: REPO_LOCK_SLOW_MS })).toBe(`repo lock claim a1b2c3d4 ok wait=${REPO_LOCK_SLOW_MS}ms held=12ms`);
  expect(repoLockLogLine({ ...quick, heldMs: REPO_LOCK_SLOW_MS })).toBe(`repo lock claim a1b2c3d4 ok wait=3ms held=${REPO_LOCK_SLOW_MS}ms`);
});

test('registry lock events name the operation and an anonymous repo id, never the repository path', async () => {
  const repo = gitRepo();
  const events: RepoLockEvent[] = [];
  try {
    const registry = new WorktreeRegistry(undefined as never, { opsRepo: repo, onRepoLock: event => { events.push(event); } });
    expect(await registry.locked(repo, async () => 'value', 'claim')).toBe('value');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'claim', result: 'ok' });
    expect(events[0]!.repo).toMatch(/^[0-9a-f]{8}$/);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain('/');
    expect(logged).not.toContain(repo);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('a registry allocation whose repository lock stays busy past the limit fails as a retryable busy lock error', async () => {
  const repo = gitRepo();
  let entered!: () => void; const inside = new Promise<void>(done => { entered = done; });
  let leave!: () => void; const release = new Promise<void>(done => { leave = done; });
  try {
    const registry = new WorktreeRegistry(undefined as never, { opsRepo: repo, lockAcquireMs: 150 });
    const holder = registry.locked(repo, async () => { entered(); await release; });
    await inside;
    const failure = await registry.locked(repo, async () => 'never allocated').then(() => undefined, (error: unknown) => error);
    expect(isRepoLockError(failure)).toBe(true);
    expect(failure).toMatchObject({ lock: 'busy', retryable: true, code: 'conflict' });
    leave();
    await holder;
    expect(await registry.locked(repo, async () => 'allocated')).toBe('allocated');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
