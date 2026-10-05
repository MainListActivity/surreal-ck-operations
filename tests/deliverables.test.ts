import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewLanBase, publishDeliverables } from '../src/deliverables';

let home: string;
let src: string;
const TID = 'task-pub01';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pub-home-'));
  src = mkdtempSync(join(tmpdir(), 'pub-src-'));
  mkdirSync(join(home, 'deliverables'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
});

const LAN = () => previewLanBase(home);

describe('publishDeliverables', () => {
  test('文件与目录发布：递归保结构，返回逐文件 URL 与目录列表页 URL', () => {
    writeFileSync(join(src, 'cover.png'), 'png');
    mkdirSync(join(src, 'site', 'pages'), { recursive: true });
    writeFileSync(join(src, 'site', 'index.html'), '<a href="pages/two.html">2</a>');
    writeFileSync(join(src, 'site', 'pages', 'two.html'), '<html>2</html>');

    const r = publishDeliverables({ home, taskId: TID, files: [join(src, 'cover.png'), join(src, 'site')] });
    expect(r.taskId).toBe(TID);
    expect(r.dir).toBe(join(home, 'deliverables', TID));
    expect(r.conflictPolicy).toBe('overwrite');
    expect(r.baseUrl).toMatch(/^http:\/\/[\d.]+:\d+$/);
    // 落盘结构
    expect(readFileSync(join(r.dir, 'cover.png'), 'utf8')).toBe('png');
    expect(readFileSync(join(r.dir, 'site', 'pages', 'two.html'), 'utf8')).toBe('<html>2</html>');
    // URL：每文件一条 + 目录列表页
    expect(r.urls).toContain(`${r.baseUrl}/d/${TID}/cover.png`);
    expect(r.urls).toContain(`${r.baseUrl}/d/${TID}/site/`);
    expect(r.urls).toContain(`${r.baseUrl}/d/${TID}/site/index.html`);
    expect(r.urls).toContain(`${r.baseUrl}/d/${TID}/site/pages/`);
    expect(r.urls).toContain(`${r.baseUrl}/d/${TID}/site/pages/two.html`);
    // 特殊字符文件名按段编码
    mkdirSync(join(src, '名 称'), { recursive: true });
    writeFileSync(join(src, '名 称', '帧 1.png'), 'x');
    const r2 = publishDeliverables({ home, taskId: TID, files: [join(src, '名 称')] });
    expect(r2.urls).toContain(`${r2.baseUrl}/d/${TID}/${encodeURIComponent('名 称')}/${encodeURIComponent('帧 1.png')}`);
  });

  test('taskId 校验与路由层一致：拒绝穿越、斜杠、非法字符', () => {
    writeFileSync(join(src, 'a.txt'), 'a');
    for (const bad of ['../x', 'a/b', 'a.b', '', '任务']) {
      expect(() => publishDeliverables({ home, taskId: bad, files: [join(src, 'a.txt')] })).toThrow(/invalid taskId/);
    }
    expect(() => publishDeliverables({ home, taskId: 'ok_task-1', files: [join(src, 'a.txt')] })).not.toThrow();
  });

  test('任一输入不存在即整体报错，不产生半截交付包', () => {
    writeFileSync(join(src, 'a.txt'), 'a');
    expect(() => publishDeliverables({ home, taskId: TID, files: [join(src, 'a.txt'), join(src, 'missing.txt')] }))
      .toThrow(/未产生任何交付/);
    expect(existsSync(join(home, 'deliverables', TID))).toBe(false);
    expect(() => publishDeliverables({ home, taskId: TID, files: ['relative/path.txt'] })).toThrow();
    expect(() => publishDeliverables({ home, taskId: TID, files: [] })).toThrow(/files 为空/);
  });

  test('隐藏名跳过且进 skipped；同名冲突覆盖', () => {
    writeFileSync(join(src, '.hidden'), 'h');
    mkdirSync(join(src, 'pkg'), { recursive: true });
    writeFileSync(join(src, 'pkg', '.DS_Store'), 'x');
    writeFileSync(join(src, 'pkg', 'keep.md'), 'keep');
    const r = publishDeliverables({ home, taskId: TID, files: [join(src, '.hidden'), join(src, 'pkg')] });
    expect(r.skipped.map((s) => s.reason)).toEqual(['hidden', 'hidden']);
    expect(existsSync(join(r.dir, '.hidden'))).toBe(false);
    expect(existsSync(join(r.dir, 'pkg', '.DS_Store'))).toBe(false);
    expect(r.urls).toContain(`${r.baseUrl}/d/${TID}/pkg/keep.md`);
    // 覆盖语义：重发同名文件更新内容
    writeFileSync(join(src, 'keep.md'), 'v1');
    publishDeliverables({ home, taskId: TID, files: [join(src, 'keep.md')] });
    writeFileSync(join(src, 'keep.md'), 'v2');
    publishDeliverables({ home, taskId: TID, files: [join(src, 'keep.md')] });
    expect(readFileSync(join(r.dir, 'keep.md'), 'utf8')).toBe('v2');
  });

  test('符号链接拷目标内容（解引用），交付包不留悬空链接', () => {
    writeFileSync(join(src, 'real.txt'), 'real');
    symlinkSync(join(src, 'real.txt'), join(src, 'link.txt'));
    const r = publishDeliverables({ home, taskId: TID, files: [join(src, 'link.txt')] });
    expect(readFileSync(join(r.dir, 'link.txt'), 'utf8')).toBe('real');
  });

  test('previewLanBase：status 文件权威 → env 端口 → 缺省 18777', () => {
    expect(LAN()).toMatch(/^http:\/\/[\d.]+:18777$/);
    process.env.SCK_PREVIEW_PORT = '19999';
    try { expect(LAN()).toContain(':19999'); } finally { delete process.env.SCK_PREVIEW_PORT; }
    writeFileSync(join(home, 'preview-status.json'), JSON.stringify({ lan: { running: true, lanUrl: 'http://10.0.0.9:18888' } }));
    expect(LAN()).toBe('http://10.0.0.9:18888');
  });
});
