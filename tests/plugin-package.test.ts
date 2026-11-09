import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildManifest,
  missingPluginImports,
  packTarball,
  stagePlugin,
  writeReleaseJson,
  writeReleaseStamp,
} from '../scripts/plugin-package.ts';
import { releaseManifestSchema, sha256File } from '../src/release-manifest.ts';

const SHA = 'a'.repeat(40);
const VERSION = '0.5.0';
let root: string;
let pluginDir: string;

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sck-plugin-package-test-'));
  pluginDir = join(root, 'plugin');
  write(join(pluginDir, 'package.json'), '{"name":"sck-company","version":"0.5.0"}\n');
  write(join(pluginDir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
  write(join(pluginDir, 'paseo-plugin.json'), '{}\n');
  write(join(pluginDir, 'index.client.tsx'), 'export {};\n');
  write(join(pluginDir, 'index.server.ts'), 'export {};\n');
  write(join(pluginDir, 'tsconfig.json'), '{}\n');
  write(join(pluginDir, 'node_modules', 'pkg', 'index.js'), 'x\n');
  write(join(pluginDir, 'client', 'view.tsx'), 'export {};\n');
  write(join(pluginDir, 'client', 'view.test.tsx'), 'export {};\n');
  write(join(pluginDir, 'client', '.ignored_draft.tsx'), 'export {};\n');
  write(join(pluginDir, 'client', '._view.tsx'), 'apple double\n');
  write(join(pluginDir, 'client', 'scratch.tmp'), 'tmp\n');
  write(join(pluginDir, 'shared', 'types.ts'), 'export {};\n');
  write(join(pluginDir, 'server', 'release-stamp.ts'), 'export const RELEASE = { version: "dev", sha: "dev" } as const;\n');
  write(join(pluginDir, 'server', 'vendor', 'src', 'mod.ts'), '// @ts-nocheck\n');
  write(join(pluginDir, 'server', 'vendor', 'schema', '001.surql'), 'DEFINE TABLE t;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('stagePlugin', () => {
  test('白名单复制，排除 node_modules、测试、临时与 .ignored_ 文件，保留 vendor 与锁文件', async () => {
    const stage = join(root, 'stage-a', 'plugin');
    await stagePlugin(pluginDir, stage);
    expect(readFileSync(join(stage, 'pnpm-lock.yaml'), 'utf8')).toContain('lockfileVersion');
    expect(readFileSync(join(stage, 'server', 'vendor', 'src', 'mod.ts'), 'utf8')).toContain('@ts-nocheck');
    expect(readFileSync(join(stage, 'server', 'vendor', 'schema', '001.surql'), 'utf8')).toContain('DEFINE TABLE');
    expect(() => readFileSync(join(stage, 'node_modules', 'pkg', 'index.js'))).toThrow();
    expect(() => readFileSync(join(stage, 'client', 'view.test.tsx'))).toThrow();
    expect(() => readFileSync(join(stage, 'client', '.ignored_draft.tsx'))).toThrow();
    expect(() => readFileSync(join(stage, 'client', '._view.tsx'))).toThrow();
    expect(() => readFileSync(join(stage, 'client', 'scratch.tmp'))).toThrow();
    expect(() => readFileSync(join(stage, 'tsconfig.json'))).toThrow();
    expect(readFileSync(join(stage, 'client', 'view.tsx'), 'utf8')).toContain('export');
  });

  test('缺少 vendor 时拒绝暂存', async () => {
    const bare = join(root, 'bare-plugin');
    write(join(bare, 'package.json'), '{}\n');
    write(join(bare, 'pnpm-lock.yaml'), 'x\n');
    write(join(bare, 'paseo-plugin.json'), '{}\n');
    write(join(bare, 'index.client.tsx'), '\n');
    write(join(bare, 'index.server.ts'), '\n');
    for (const dir of ['client', 'server', 'shared']) write(join(bare, dir, 'a.ts'), '\n');
    await expect(stagePlugin(bare, join(root, 'stage-bare', 'plugin'))).rejects.toThrow('server/vendor');
  });
});

describe('writeReleaseStamp', () => {
  test('写入版本与提交常量，导入结果与参数一致', async () => {
    const stage = join(root, 'stage-stamp', 'plugin');
    await stagePlugin(pluginDir, stage);
    await writeReleaseStamp(stage, { version: VERSION, sha: SHA });
    const text = readFileSync(join(stage, 'server', 'release-stamp.ts'), 'utf8');
    expect(text).toContain(`export const RELEASE = { version: "${VERSION}", sha: "${SHA}" } as const;`);
    const mod = (await import(join(stage, 'server', 'release-stamp.ts'))) as { RELEASE: { version: string; sha: string } };
    expect(mod.RELEASE).toEqual({ version: VERSION, sha: SHA });
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
  let updater: string;

  beforeAll(async () => {
    const stageDir = join(root, 'stage-pack');
    await stagePlugin(pluginDir, join(stageDir, 'plugin'));
    await writeReleaseStamp(join(stageDir, 'plugin'), { version: VERSION, sha: SHA });
    await writeReleaseJson(stageDir, { version: VERSION, sha: SHA, requiredSchema: 60 });
    tgz = join(root, 'out', `sck-company-${VERSION}.tgz`);
    mkdirSync(join(root, 'out'), { recursive: true });
    await packTarball(stageDir, tgz);
    updater = join(root, 'out', 'node-updater.js');
    writeFileSync(updater, '// stub updater\n');
  });

  test('tgz 只含 release.json 与 plugin/，不含 AppleDouble 文件', () => {
    const entries = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry === 'release.json' || entry === 'plugin/' || entry.startsWith('plugin/')).toBe(true);
      expect(entry.split('/').some(part => part.startsWith('._'))).toBe(false);
    }
    expect(entries).toContain('release.json');
    expect(entries).toContain('plugin/pnpm-lock.yaml');
  });

  test('manifest 通过 releaseManifestSchema，package.sha256 等于 tgz 的 sha256', async () => {
    const manifest = await buildManifest({
      version: VERSION,
      sha: SHA,
      requiredSchema: 60,
      createdAt: new Date().toISOString(),
      packageFile: tgz,
      updaterFile: updater,
    });
    expect(() => releaseManifestSchema.parse(manifest)).not.toThrow();
    const actual = await sha256File(tgz);
    expect(manifest.package).toEqual({
      name: `sck-company-${VERSION}.tgz`,
      sha256: actual.sha256,
      bytes: actual.bytes,
    });
    expect(manifest.updater.name).toBe('node-updater.js');
    expect(manifest.format).toBe(1);
    expect(manifest.product).toBe('sck-company');
  });
});

describe('missingPluginImports', () => {
  test('沿入口可达的源码里仅类型导入的包也要能在 node_modules 解析；宿主模块、内置模块与不可达文件不计', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-plugin-imports-'));
    try {
      write(join(dir, 'index.server.ts'), "import { run } from './server/main';\nexport default run;\n");
      write(join(dir, 'index.client.tsx'), "import React from 'react';\nimport { View } from 'react-native';\nexport {};\n");
      write(join(dir, 'server', 'main.ts'), [
        "import type { PaseoApi } from '@getpaseo/client';",
        "import { z } from 'zod';",
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'path';",
        "import { Surreal } from 'surrealdb';",
        "const s = 'a from \": weird, \"';",
        'export const run = 1;',
      ].join('\n'));
      write(join(dir, 'server', 'vendor', 'unused.ts'), "import { McpServer } from '@modelcontextprotocol/server';\n");
      write(join(dir, 'node_modules', 'surrealdb', 'package.json'), '{}');
      expect(await missingPluginImports(dir)).toEqual(['@getpaseo/client']);
      write(join(dir, 'node_modules', '@getpaseo', 'client', 'package.json'), '{}');
      expect(await missingPluginImports(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
