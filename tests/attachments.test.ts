import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTACHMENT_LIMIT, attachmentKind, attachmentMime, evidenceDirFor, isOpenBlocked,
  listTaskAttachments, resolveTaskAttachment,
} from '../src/attachments.ts';

const roots: string[] = [];
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sck-attach-'));
  roots.push(dir);
  return dir;
};
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const seed = (taskId = 't1') => {
  const dir = join(home(), 'evidence', taskId);
  mkdirSync(join(dir, 'sub'), { recursive: true });
  return dir;
};

describe('listTaskAttachments', () => {
  test('classifies by extension and recurses subdirs', async () => {
    const home1 = home(); const dir = join(home1, 'evidence', 't1');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'frame.PNG'), 'x');
    writeFileSync(join(dir, 'clip.mp4'), 'x'.repeat(10));
    writeFileSync(join(dir, 'page.html'), '<html/>');
    writeFileSync(join(dir, 'voice.M4A'), 'x');
    writeFileSync(join(dir, 'notes.md'), 'x');
    writeFileSync(join(dir, 'sub', 'extra.webp'), 'x');
    const list = await listTaskAttachments(home1, 't1');
    const byName = Object.fromEntries(list.map(a => [a.relPath, a]));
    expect(list.length).toBe(6);
    expect(byName['frame.PNG'].kind).toBe('image');
    expect(byName['clip.mp4']).toMatchObject({ kind: 'video', sizeBytes: 10 });
    expect(byName['page.html'].kind).toBe('html');
    expect(byName['voice.M4A'].kind).toBe('audio');
    expect(byName['notes.md'].kind).toBe('other');
    expect(byName['sub/extra.webp'].kind).toBe('image');
  });

  test('missing dir or bad taskId → empty list', async () => {
    const home1 = home();
    expect(await listTaskAttachments(home1, 'nope')).toEqual([]);
    expect(await listTaskAttachments(home1, '../etc')).toEqual([]);
    expect(await listTaskAttachments(home1, 'a/b')).toEqual([]);
    expect(await listTaskAttachments(home1, '')).toEqual([]);
  });

  test('skips hidden files and caps at the limit', async () => {
    const home1 = home(); const dir = join(home1, 'evidence', 't1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.hidden.png'), 'x');
    for (let i = 0; i < ATTACHMENT_LIMIT + 5; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x');
    const list = await listTaskAttachments(home1, 't1');
    expect(list.length).toBe(ATTACHMENT_LIMIT);
    expect(list.some(a => a.name === '.hidden.png')).toBe(false);
  });

  test('in-dir symlink listed, escaping symlink skipped', async () => {
    const home1 = home(); const dir = join(home1, 'evidence', 't1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'real.png'), 'x');
    symlinkSync(join(dir, 'real.png'), join(dir, 'alias.png'));
    const outside = join(home1, 'secret.png');
    writeFileSync(outside, 'x');
    symlinkSync(outside, join(dir, 'escape.png'));
    const list = await listTaskAttachments(home1, 't1');
    expect(list.map(a => a.relPath).sort()).toEqual(['alias.png', 'real.png']);
  });
});

describe('resolveTaskAttachment', () => {
  test('resolves regular files and nested paths', async () => {
    const home1 = home(); const dir = join(home1, 'evidence', 't1');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'a.png'), 'x');
    const p = await resolveTaskAttachment(home1, 't1', 'sub/a.png');
    expect(p).toBeDefined();
    expect(p!.endsWith('sub/a.png')).toBe(true);
  });

  test('rejects traversal, absolute, missing, non-file', async () => {
    const home1 = home(); const dir = join(home1, 'evidence', 't1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.png'), 'x');
    writeFileSync(join(home1, 'outside.txt'), 'x');
    expect(await resolveTaskAttachment(home1, 't1', '../outside.txt')).toBeUndefined();
    expect(await resolveTaskAttachment(home1, 't1', '../../etc/passwd')).toBeUndefined();
    expect(await resolveTaskAttachment(home1, 't1', '/etc/passwd')).toBeUndefined();
    expect(await resolveTaskAttachment(home1, 't1', 'missing.png')).toBeUndefined();
    expect(await resolveTaskAttachment(home1, 't1', '')).toBeUndefined();
    expect(await resolveTaskAttachment(home1, 't1', '.')).toBeUndefined();
    expect(await resolveTaskAttachment(home1, 'nope', 'a.png')).toBeUndefined();
    expect(await resolveTaskAttachment(home1, '../x', 'a.png')).toBeUndefined();
  });

  test('rejects symlink escape even when target exists', async () => {
    const home1 = home(); const dir = join(home1, 'evidence', 't1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(home1, 'secret.png'), 'x');
    symlinkSync(join(home1, 'secret.png'), join(dir, 'link.png'));
    expect(await resolveTaskAttachment(home1, 't1', 'link.png')).toBeUndefined();
    // symlinked evidence dir resolves consistently (realpath on both sides)
    const home2 = home();
    const realDir = join(home2, 'real-evidence', 't1');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'ok.png'), 'x');
    symlinkSync(join(home2, 'real-evidence'), join(home2, 'evidence'));
    expect(await resolveTaskAttachment(home2, 't1', 'ok.png')).toBeDefined();
  });
});

describe('classification helpers', () => {
  test('kind/mime maps and open blocklist', () => {
    expect(attachmentKind('a.PNG')).toBe('image');
    expect(attachmentKind('a.mov')).toBe('video');
    expect(attachmentKind('noext')).toBe('other');
    expect(attachmentMime('a.png')).toBe('image/png');
    expect(attachmentMime('a.bin')).toBe('application/octet-stream');
    for (const bad of ['x.sh', 'x.command', 'x.app', 'x.workflow', 'x.py', 'x.pkg', 'x.dmg']) {
      expect(isOpenBlocked(bad)).toBe(true);
    }
    for (const ok of ['x.png', 'x.mp4', 'x.html', 'x.md', 'x.txt', 'x.json']) {
      expect(isOpenBlocked(ok)).toBe(false);
    }
    expect(evidenceDirFor('/h', 't1')).toBe('/h/evidence/t1');
    expect(evidenceDirFor('/h', 'a b')).toBeUndefined();
  });
});
