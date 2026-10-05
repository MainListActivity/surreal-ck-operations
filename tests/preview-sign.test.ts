import { describe, expect, test } from 'bun:test';
import { checkPreviewSig, previewSignedPath, signPreviewPath } from '../src/preview-sign';

const SECRET = 'test-secret';
const NOW = 1_760_000_000_000;

describe('preview-sign', () => {
  test('signed path verifies ok within ttl', () => {
    const { path, exp } = previewSignedPath(SECRET, 'e', 'task-1', 'demo.mp4', 60_000, NOW);
    const [pathname, query] = path.split('?');
    const params = new URLSearchParams(query);
    expect(pathname).toBe('/e/task-1/demo.mp4');
    expect(exp).toBe(NOW + 60_000);
    expect(checkPreviewSig(SECRET, pathname, params.get('exp'), params.get('sig'), NOW)).toBe('ok');
  });

  test('chinese and nested names sign and verify', () => {
    const { path } = previewSignedPath(SECRET, 'e', 't', '帧图/静帧 1.png', 60_000, NOW);
    const [pathname, query] = path.split('?');
    expect(pathname).toBe(`/e/t/${encodeURIComponent('帧图')}/${encodeURIComponent('静帧 1.png')}`);
    const params = new URLSearchParams(query);
    expect(checkPreviewSig(SECRET, pathname, params.get('exp'), params.get('sig'), NOW)).toBe('ok');
  });

  test('missing params', () => {
    expect(checkPreviewSig(SECRET, '/e/t/a.png', null, null, NOW)).toBe('missing');
    expect(checkPreviewSig(SECRET, '/e/t/a.png', String(NOW + 1), null, NOW)).toBe('missing');
    expect(checkPreviewSig(SECRET, '/e/t/a.png', 'notanumber', 'x')).toBe('bad');
  });

  test('tampered path or sig or secret rejected', () => {
    const exp = NOW + 60_000;
    const sig = signPreviewPath(SECRET, '/e/t/a.png', exp);
    expect(checkPreviewSig(SECRET, '/e/t/b.png', String(exp), sig, NOW)).toBe('bad');
    expect(checkPreviewSig(SECRET, '/e/t/a.png', String(exp), sig.slice(0, -2) + 'zz', NOW)).toBe('bad');
    expect(checkPreviewSig('other-secret', '/e/t/a.png', String(exp), sig, NOW)).toBe('bad');
    // 把 exp 改大再重用原签名同样无效
    expect(checkPreviewSig(SECRET, '/e/t/a.png', String(exp + 60_000), sig, NOW)).toBe('bad');
  });

  test('expired signature', () => {
    const exp = NOW - 1;
    const sig = signPreviewPath(SECRET, '/e/t/a.png', exp);
    expect(checkPreviewSig(SECRET, '/e/t/a.png', String(exp), sig, NOW)).toBe('expired');
  });

  test('directory listing path (empty rel) signs and verifies', () => {
    const { path } = previewSignedPath(SECRET, 'd', 'task-9', '', 60_000, NOW);
    const [pathname, query] = path.split('?');
    expect(pathname).toBe('/d/task-9/');
    const params = new URLSearchParams(query);
    expect(checkPreviewSig(SECRET, pathname, params.get('exp'), params.get('sig'), NOW)).toBe('ok');
  });
});
