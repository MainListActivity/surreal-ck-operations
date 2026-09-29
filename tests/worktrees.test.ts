import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitCli, sweepWorktrees, type GitGateway, type GitWorktree } from '../src/dispatcher/worktrees.ts';

test('sweep removes only finished task worktrees and keeps the ones git refuses', async () => {
  const removed: string[] = [];
  const deleted: string[] = [];
  const list: GitWorktree[] = [
    { path: '/r', branch: 'main', isMain: true },
    { path: '/r-task-aaaaaaaa', branch: 'task/aaaaaaaa', isMain: false },
    { path: '/r-task-bbbbbbbb', branch: 'task/bbbbbbbb', isMain: false },
    { path: '/r-task-cccccccc', branch: 'task/cccccccc', isMain: false },
    { path: '/r-feature', branch: 'eng/issue-24-core', isMain: false },
  ];
  const git: GitGateway = {
    worktrees: async () => list,
    removeWorktree: async (_r, path) => path.endsWith('cccccccc') ? { ok: false, reason: 'contains modified or untracked files' } : (removed.push(path), { ok: true }),
    deleteMergedBranch: async (_r, branch) => (deleted.push(branch), branch.endsWith('aaaaaaaa')),
    prune: async () => undefined,
  };
  const result = await sweepWorktrees(git, ['/r', '/r'], ['aaaaaaaa-1111', 'cccccccc-2222']);
  expect(removed).toEqual(['/r-task-aaaaaaaa']);
  expect(result.kept).toEqual([{ path: '/r-task-cccccccc', reason: 'contains modified or untracked files' }]);
  expect(result.branchesDeleted).toEqual(['task/aaaaaaaa']);
  expect(deleted).toEqual(['task/aaaaaaaa']);
});

test('real git: clean finished worktree is removed, a dirty one survives, unmerged branch is kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sck-wt-'));
  const sh = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  try {
    const repo = join(dir, 'repo');
    Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
    sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init');
    const clean = join(dir, 'repo-task-11111111'), dirty = join(dir, 'repo-task-22222222');
    sh(repo, 'worktree', 'add', '-q', '-b', 'task/11111111', clean);
    sh(repo, 'worktree', 'add', '-q', '-b', 'task/22222222', dirty);
    writeFileSync(join(dirty, 'wip.txt'), 'unsaved work');
    sh(clean, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'work');
    const result = await sweepWorktrees(createGitCli(), [repo], ['11111111', '22222222']);
    expect(result.removed.map(p => p.split('/').pop())).toEqual(['repo-task-11111111']);
    expect(result.kept.map(k => k.path.split('/').pop())).toEqual(['repo-task-22222222']);
    expect(result.branchesDeleted).toEqual([]);
    expect(sh(repo, 'rev-parse', '--verify', 'task/11111111').exitCode).toBe(0);
    expect(sh(dirty, 'status', '--short').stdout.toString()).toContain('wip.txt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
