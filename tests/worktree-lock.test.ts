import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateIntent, withRepoLock } from '../src/dispatcher/worktree-registry.ts';

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
