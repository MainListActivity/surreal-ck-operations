import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewFetch } from '../src/preview-server';
import { previewSignedPath, signPreviewPath } from '../src/preview-sign';

const SECRET = 'it-secret';
const TASK = 'task-abc123';
let home: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'preview-home-'));
  mkdirSync(join(home, 'evidence', TASK, 'sub'), { recursive: true });
  mkdirSync(join(home, 'deliverables', TASK), { recursive: true });
  writeFileSync(join(home, 'evidence', TASK, 'clip.mp4'), 'fake-mp4-bytes-0123456789');
  writeFileSync(join(home, 'evidence', TASK, 'report.html'), '<html>r</html>');
  writeFileSync(join(home, 'evidence', TASK, 'sub', 'nested.txt'), 'nested-content');
  writeFileSync(join(home, 'evidence', TASK, '.hidden'), 'secret');
  writeFileSync(join(home, 'outside.txt'), 'outside');
  symlinkSync(join(home, 'outside.txt'), join(home, 'evidence', TASK, 'escape.txt'));
  server = Bun.serve({ port: 0, fetch: previewFetch({ home, secret: SECRET }) });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => { server.stop(true); rmSync(home, { recursive: true, force: true }); });

const fileUrl = (rel: string) =>
  base + previewSignedPath(SECRET, 'e', TASK, rel, 60_000).path;

describe('preview-server 鉴权', () => {
  test('healthz 免签名', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  test('未签名 401，坏签名 401，过期 403', async () => {
    expect((await fetch(`${base}/e/${TASK}/clip.mp4`)).status).toBe(401);
    expect((await fetch(`${base}/e/${TASK}/clip.mp4?exp=${Date.now() + 60000}&sig=bogus`)).status).toBe(401);
    const expired = previewSignedPath(SECRET, 'e', TASK, 'clip.mp4', -60_000).path;
    expect((await fetch(`${base}${expired}`)).status).toBe(403);
    // 拿别的文件的签名来开 clip.mp4 无效
    const other = previewSignedPath(SECRET, 'e', TASK, 'report.html', 60_000).path;
    expect((await fetch(`${base}/e/${TASK}/clip.mp4?${other.split('?')[1]}`)).status).toBe(401);
  });

  test('签名文件 200 + 正确 MIME，Range 返 206', async () => {
    const r = await fetch(fileUrl('clip.mp4'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(await r.text()).toBe('fake-mp4-bytes-0123456789');
    const rr = await fetch(fileUrl('clip.mp4'), { headers: { Range: 'bytes=0-3' } });
    expect(rr.status).toBe(206);
    expect(rr.headers.get('content-range')).toMatch(/^bytes 0-3\/\d+$/);
    expect(await rr.text()).toBe('fake');
  });

  test('嵌套文件与 html', async () => {
    const r = await fetch(fileUrl('sub/nested.txt'));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('nested-content');
    const h = await fetch(fileUrl('report.html'));
    expect(h.headers.get('content-type')).toContain('text/html');
  });

  test('隐藏文件与符号链接逃逸不可达', async () => {
    expect((await fetch(fileUrl('.hidden'))).status).toBe(403);
    // 逃逸 symlink：resolveInsideChecked realpath 校验 → 403
    expect((await fetch(fileUrl('escape.txt'))).status).toBe(403);
    // 编码穿越：直接对原始编码路径签发，服务端解码出 .. 仍被拒 → 404/403
    const exp = Date.now() + 60_000;
    const rawPath = `/e/${TASK}/..%2F..%2Fetc%2Fpasswd`;
    const raw = `${rawPath}?exp=${exp}&sig=${signPreviewPath(SECRET, rawPath, exp)}`;
    expect([403, 404]).toContain((await fetch(`${base}${raw}`)).status);
  });

  test('未配置密钥时 503（fail closed）', async () => {
    const s2 = Bun.serve({ port: 0, fetch: previewFetch({ home, secret: '' }) });
    try {
      const r = await fetch(`http://127.0.0.1:${s2.port}/e/${TASK}/clip.mp4?exp=1&sig=x`);
      expect(r.status).toBe(503);
    } finally { s2.stop(true); }
  });

  test('目录列表页需签名且链接自带签名', async () => {
    const listPath = previewSignedPath(SECRET, 'e', TASK, '', 60_000).path;
    const r = await fetch(`${base}${listPath}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('clip.mp4');
    expect(html).toContain('sig=');
    expect(html).not.toContain('.hidden');
  });
});
