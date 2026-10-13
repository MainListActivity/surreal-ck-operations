import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewFetch } from '../src/preview-core';
import { previewSignedPath } from '../src/preview-sign';
import { startPreview } from '../plugin/server/preview';

const TASK = 'task-life1';
const SECRET = 'lifecycle-secret';

const mkHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'plugin-preview-'));
  mkdirSync(join(home, 'evidence', TASK), { recursive: true });
  writeFileSync(join(home, 'evidence', TASK, 'a.txt'), 'alpha');
  return home;
};

describe('plugin preview 生命周期（node:http 内嵌双面）', () => {
  test('start→LAN healthz/文件可达→stop 幂等且端口释放', async () => {
    const home = mkHome();
    const h = startPreview({ home, port: 0, secret: '', coreFactory: (o) => createPreviewFetch(o), log: () => {} });
    try {
      const port = await h.ready;
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(r.status).toBe(200);
      expect((await r.json()).ok).toBe(true);
      const f = await fetch(`http://127.0.0.1:${port}/e/${TASK}/a.txt`);
      expect(f.status).toBe(200);
      expect(await f.text()).toBe('alpha');
      // 状态文件写出双面结构
      const st = JSON.parse(readFileSync(join(home, 'preview-status.json'), 'utf8'));
      expect(st.lan.running).toBe(true);
      expect(st.lan.port).toBe(port);
      expect(st.signed.configured).toBe(false);
      expect(h.signedPort).toBeUndefined();
    } finally {
      await h.stop();
      await h.stop(); // 幂等
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('配置 secret 时签名面起在回环口：未签 401、签名 200', async () => {
    const home = mkHome();
    const h = startPreview({ home, port: 0, signedPort: 0, secret: SECRET, coreFactory: (o) => createPreviewFetch(o), log: () => {} });
    try {
      await h.ready;
      // 等签名面绑完（status 落盘为准，最多 ~1s）
      let sigPort = 0;
      for (let i = 0; i < 50; i++) {
        const st = JSON.parse(readFileSync(join(home, 'preview-status.json'), 'utf8'));
        if (st.signed.running && st.signed.port) { sigPort = st.signed.port; break; }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(sigPort).toBeGreaterThan(0);
      expect(h.signedPort).toBe(sigPort);
      expect((await fetch(`http://127.0.0.1:${sigPort}/e/${TASK}/a.txt`)).status).toBe(401);
      const signed = previewSignedPath(SECRET, 'e', TASK, 'a.txt', 60_000).path;
      const r = await fetch(`http://127.0.0.1:${sigPort}${signed}`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('alpha');
      const st = JSON.parse(readFileSync(join(home, 'preview-status.json'), 'utf8'));
      expect(st.signed.configured).toBe(true);
      expect(st.signed.running).toBe(true);
    } finally {
      await h.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('重复 start 复用同一实例（幂等）', async () => {
    const home = mkHome();
    const h1 = startPreview({ home, port: 0, coreFactory: (o) => createPreviewFetch(o), log: () => {} });
    const h2 = startPreview({ home, port: 0, log: () => {} });
    expect(h2).toBe(h1);
    await h1.ready;
    await h1.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test('handler 异常时 500 而非崩溃；handler 缺席时 503', async () => {
    const home = mkHome();
    const broken: (req: Request) => Promise<Response> = () => { throw new Error('core missing'); };
    const h = startPreview({ home, port: 0, coreFactory: () => broken, log: () => {} });
    try {
      const port = await h.ready;
      const r = await fetch(`http://127.0.0.1:${port}/e/${TASK}/a.txt`);
      expect(r.status).toBe(500);
    } finally {
      await h.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
