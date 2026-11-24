import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAYLOAD_DIR,
  RUNTIME_ENTRIES,
  TOOL_SCRIPTS,
  buildManifest,
  packTarball,
  stageRuntime,
  stageToolScripts,
  writeReleaseJson,
} from '../scripts/release-package.ts';
import { PAYLOAD_DIRS } from '../src/node-updater.ts';
import { releaseManifestSchema, sha256File } from '../src/release-manifest.ts';

const SHA = 'a'.repeat(40);
const VERSION = '0.5.0';
const REPO_SCRIPTS = join(import.meta.dir, '..', 'scripts');
let root: string;
let repo: string;

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sck-release-package-test-'));
  repo = join(root, 'repo');
  write(join(repo, 'package.json'), '{"name":"x","version":"0.5.0"}\n');
  write(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
  write(join(repo, 'tsconfig.json'), '{}\n');
  write(join(repo, 'node_modules', 'pkg', 'index.js'), 'x\n');
  write(join(repo, 'src', 'runner', 'run.ts'), 'export {};\n');
  write(join(repo, 'src', 'sck-cli.ts'), 'export {};\n');
  write(join(repo, 'src', 'mod.test.ts'), 'export {};\n');
  write(join(repo, 'src', '.ignored_draft.ts'), 'export {};\n');
  write(join(repo, 'src', '._mod.ts'), 'apple double\n');
  write(join(repo, 'src', 'scratch.tmp'), 'tmp\n');
  write(join(repo, 'schema', '001.surql'), 'DEFINE TABLE t;\n');
  write(join(repo, 'landscape', 'company-landscape.json'), '{}\n');
  write(join(repo, 'tests', 'a.test.ts'), 'export {};\n');
  write(join(repo, 'docs', 'a.md'), '# a\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('stageRuntime', () => {
  test('只复制运行所需条目，排除测试、临时、.ignored_ 与 AppleDouble 文件', async () => {
    const stage = join(root, 'stage-a', PAYLOAD_DIR);
    await stageRuntime(repo, stage);
    expect(readFileSync(join(stage, 'pnpm-lock.yaml'), 'utf8')).toContain('lockfileVersion');
    expect(readFileSync(join(stage, 'schema', '001.surql'), 'utf8')).toContain('DEFINE TABLE');
    expect(readFileSync(join(stage, 'src', 'runner', 'run.ts'), 'utf8')).toContain('export');
    expect(readFileSync(join(stage, 'landscape', 'company-landscape.json'), 'utf8')).toBe('{}\n');
    for (const absent of ['node_modules', 'tsconfig.json', 'tests', 'docs', 'src/mod.test.ts', 'src/.ignored_draft.ts', 'src/._mod.ts', 'src/scratch.tmp']) {
      expect(() => readFileSync(join(stage, absent))).toThrow();
    }
  });

  test('缺少白名单条目或执行端入口时拒绝暂存', async () => {
    const bare = join(root, 'bare');
    for (const entry of RUNTIME_ENTRIES.filter(entry => entry !== 'landscape')) write(join(bare, entry === 'src' || entry === 'schema' ? `${entry}/x.ts` : entry), '\n');
    await expect(stageRuntime(bare, join(root, 'stage-bare', PAYLOAD_DIR))).rejects.toThrow('landscape');
    write(join(bare, 'landscape', 'a.json'), '{}');
    await expect(stageRuntime(bare, join(root, 'stage-bare', PAYLOAD_DIR))).rejects.toThrow('src/runner/run.ts');
  });

  test('运行目录名是节点自更新认得的布局，并且优先于历史的 plugin/', () => {
    expect(PAYLOAD_DIRS[0]).toBe(PAYLOAD_DIR);
  });
});

describe('stageToolScripts', () => {
  test('TOOL_SCRIPTS 为 sck.sh 与 bun-runtime.sh，并按原文复制到发行副本的 scripts/', async () => {
    expect([...TOOL_SCRIPTS]).toEqual(['sck.sh', 'bun-runtime.sh']);
    const stageScripts = join(root, 'stage-tools', 'scripts');
    await stageToolScripts(REPO_SCRIPTS, stageScripts);
    for (const name of TOOL_SCRIPTS) {
      expect(readFileSync(join(stageScripts, name), 'utf8')).toBe(readFileSync(join(REPO_SCRIPTS, name), 'utf8'));
    }
  });

  test('scripts/ 缺少任一工具脚本时拒绝暂存，发行包不会缺工具', async () => {
    const partial = join(root, 'partial-scripts');
    write(join(partial, 'sck.sh'), '#!/bin/sh\n');
    await expect(stageToolScripts(partial, join(root, 'stage-partial', 'scripts'))).rejects.toThrow('scripts/bun-runtime.sh');
  });
});

describe('writeReleaseJson', () => {
  test('字段齐全且正确', async () => {
    const stage = join(root, 'stage-json');
    mkdirSync(stage, { recursive: true });
    await writeReleaseJson(stage, { version: VERSION, sha: SHA, requiredSchema: 60 });
    expect(JSON.parse(readFileSync(join(stage, 'release.json'), 'utf8'))).toEqual({
      product: 'sck-company',
      version: VERSION,
      sha: SHA,
      requiredSchema: 60,
    });
  });
});

describe('packTarball 与 buildManifest', () => {
  let tgz: string;

  beforeAll(async () => {
    const stageDir = join(root, 'stage-pack');
    await stageRuntime(repo, join(stageDir, PAYLOAD_DIR));
    await stageToolScripts(REPO_SCRIPTS, join(stageDir, 'scripts'));
    await writeReleaseJson(stageDir, { version: VERSION, sha: SHA, requiredSchema: 60 });
    tgz = join(root, 'out', `sck-company-${VERSION}.tgz`);
    mkdirSync(join(root, 'out'), { recursive: true });
    await packTarball(stageDir, tgz);
  });

  test('tgz 只含 release.json、runtime/ 与 scripts/（含 sck.sh、bun-runtime.sh），不含 AppleDouble 文件', () => {
    const entries = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const allowed = entry === 'release.json' || [`${PAYLOAD_DIR}/`, 'scripts/'].some(dir => entry === dir || entry.startsWith(dir));
      expect(allowed).toBe(true);
      expect(entry.split('/').some(part => part.startsWith('._'))).toBe(false);
    }
    expect(entries).toContain('release.json');
    expect(entries).toContain(`${PAYLOAD_DIR}/pnpm-lock.yaml`);
    expect(entries).toContain(`${PAYLOAD_DIR}/src/runner/run.ts`);
    expect(entries).toContain('scripts/sck.sh');
    expect(entries).toContain('scripts/bun-runtime.sh');
  });

  test('manifest 通过 releaseManifestSchema，package.sha256 等于 tgz 的 sha256，不再带旧更新器资产', async () => {
    const manifest = await buildManifest({ version: VERSION, sha: SHA, requiredSchema: 60, createdAt: new Date().toISOString(), packageFile: tgz });
    expect(() => releaseManifestSchema.parse(manifest)).not.toThrow();
    const actual = await sha256File(tgz);
    expect(manifest.package).toEqual({ name: `sck-company-${VERSION}.tgz`, sha256: actual.sha256, bytes: actual.bytes });
    expect(manifest.updater).toBeUndefined();
    expect(manifest.format).toBe(1);
    expect(manifest.product).toBe('sck-company');
  });
});
