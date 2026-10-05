import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewFetch } from '../src/preview-core';
import { previewSignedPath } from '../src/preview-sign';

const TASK = 'task-pv01';
let home: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'preview-core-'));
  mkdirSync(join(home, 'evidence', TASK, 'sub'), { recursive: true });
  mkdirSync(join(home, 'deliverables', TASK), { recursive: true });
  writeFileSync(join(home, 'evidence', TASK, 'clip.mp4'), 'fake-mp4-bytes-0123456789');
  writeFileSync(join(home, 'evidence', TASK, 'report.html'), '<html>r</html>');
  writeFileSync(join(home, 'evidence', TASK, 'sub', 'nested.txt'), 'nested-content');
  writeFileSync(join(home, 'evidence', TASK, '.hidden'), 'secret');
  writeFileSync(join(home, 'deliverables', TASK, 'pack.md'), '# pack');
  writeFileSync(join(home, 'outside.txt'), 'outside');
  symlinkSync(join(home, 'outside.txt'), join(home, 'evidence', TASK, 'escape.txt'));
  symlinkSync(join(home), join(home, 'evidence', TASK, 'escape-dir'));
  server = Bun.serve({ port: 0, fetch: createPreviewFetch({ home, port: 18777 }) });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => { server.stop(true); rmSync(home, { recursive: true, force: true }); });

describe('preview-core 路由与呈现', () => {
  test('healthz：ok/port/uptime', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; port: number; uptime: number };
    expect(body).toMatchObject({ ok: true, port: 18777 });
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  test('e/d 两根文件 + MIME + Range/206', async () => {
    const r = await fetch(`${base}/e/${TASK}/clip.mp4`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(await r.text()).toBe('fake-mp4-bytes-0123456789');
    const rr = await fetch(`${base}/e/${TASK}/clip.mp4`, { headers: { Range: 'bytes=2-5' } });
    expect(rr.status).toBe(206);
    expect(rr.headers.get('content-range')).toBe('bytes 2-5/25');
    expect(await rr.text()).toBe('ke-m');
    const d = await fetch(`${base}/d/${TASK}/pack.md`);
    expect(d.status).toBe(200);
    expect(d.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    const h = await fetch(`${base}/e/${TASK}/report.html`);
    expect(h.headers.get('content-type')).toContain('text/html');
  });

  test('嵌套文件与目录列表页可点击导航', async () => {
    const r = await fetch(`${base}/e/${TASK}/sub/nested.txt`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('nested-content');
    const list = await fetch(`${base}/e/${TASK}/`);
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain('clip.mp4');
    expect(html).toContain('href="sub/"');
    expect(html).not.toContain('.hidden');
    const sub = await fetch(`${base}/e/${TASK}/sub/`);
    const subHtml = await sub.text();
    expect(subHtml).toContain('nested.txt');
    expect(subHtml).toContain('href="../"');
  });

  test('越界一律拒绝：隐藏段、符号链接逃逸、编码穿越；非法 taskId 回落索引页', async () => {
    expect((await fetch(`${base}/e/${TASK}/.hidden`)).status).toBe(403);
    expect((await fetch(`${base}/e/${TASK}/escape.txt`)).status).toBe(403);
    expect((await fetch(`${base}/e/${TASK}/escape-dir/outside.txt`)).status).toBe(403);
    // .. 裸段在 URL 解析层被折叠；编码形态 %2F 解码后含 .. 由服务端拒绝
    expect((await fetch(`${base}/e/${TASK}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(403);
    expect((await fetch(`${base}/e/${TASK}/missing.txt`)).status).toBe(404);
    // taskId 含 '.' 等非法字符 → 不匹配路由 → 索引页，绝不服务文件
    const bad = await fetch(`${base}/e/not.there/x`);
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain('交付预览服务');
  });
});

describe('preview-core auth 模式（签名面）', () => {
  test('未签 401、坏签 401、过期 403、签名 200，列表页链接自带签名', async () => {
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: createPreviewFetch({ home, port: 0, auth: { secret: 's1' } }) });
    const b = `http://127.0.0.1:${s.port}`;
    try {
      expect((await fetch(`${b}/e/${TASK}/clip.mp4`)).status).toBe(401);
      expect((await fetch(`${b}/e/${TASK}/clip.mp4?exp=${Date.now() + 60000}&sig=bad`)).status).toBe(401);
      const expired = previewSignedPath('s1', 'e', TASK, 'clip.mp4', -60_000).path;
      expect((await fetch(`${b}${expired}`)).status).toBe(403);
      const ok = previewSignedPath('s1', 'e', TASK, 'clip.mp4', 60_000).path;
      const r = await fetch(`${b}${ok}`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('fake-mp4-bytes-0123456789');
      // 签名面列表页：链接均为签名 URL
      const list = await fetch(`${b}${previewSignedPath('s1', 'e', TASK, '', 60_000).path}`);
      const html = await list.text();
      expect(list.status).toBe(200);
      expect(html).toContain('sig=');
      // healthz 免签
      expect((await fetch(`${b}/healthz`)).status).toBe(200);
      // 逃逸在签名有效时仍被 confinement 拒
      const esc = previewSignedPath('s1', 'e', TASK, 'escape.txt', 60_000).path;
      expect((await fetch(`${b}${esc}`)).status).toBe(403);
    } finally {
      s.stop(true);
    }
  });
});
