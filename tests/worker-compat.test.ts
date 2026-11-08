import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkWorkerCompat, REPO_ROOT, WORKER_ENTRIES } from '../scripts/worker-compat-check.ts';

const CHECKER = join(REPO_ROOT, 'scripts/worker-compat-check.ts');

test('every Worker entry reaches its modules through relative imports with zero violations', () => {
  const report = checkWorkerCompat();
  expect(report.violations).toEqual([]);
  expect(report.files).toEqual(expect.arrayContaining(WORKER_ENTRIES));
  expect(report.packages).toEqual(expect.arrayContaining(['surrealdb', 'zod']));
});

// ---- Fixtures: a throwaway tree outside the repository ----
let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'sck-worker-compat-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function write(rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}

test('a node built-in reached through relative imports is reported with its file, module and chain', () => {
  write('src/entry.ts', "import { helper } from './helper.ts';\nexport const entry = helper;\n");
  write('src/helper.ts', "import { readFileSync } from 'node:fs';\nexport const helper = () => readFileSync('x', 'utf8');\n");
  const report = checkWorkerCompat(['src/entry.ts'], root);
  expect(report.violations).toEqual([{
    file: 'src/helper.ts',
    module: 'node:fs',
    line: 1,
    chain: ['src/entry.ts', 'src/helper.ts'],
    reason: expect.any(String),
  }]);
});

test('bare built-in names, bun modules and non-literal requires are violations too', () => {
  write('src/bare.ts', "import path from 'path';\nimport { s } from 'bun:sqlite';\nconst m = require(name);\nexport const x = [path, s, m];\n");
  const report = checkWorkerCompat(['src/bare.ts'], root);
  expect(report.violations.map(v => [v.module, v.line])).toEqual([['path', 1], ['bun:sqlite', 2], ['<非字面量>', 3]]);
});

test('type-only imports and node:crypto pass, and third-party packages are recorded', () => {
  write('src/allowed.ts', "import type { Stats } from 'node:fs';\nimport { randomUUID } from 'node:crypto';\nimport { z } from 'zod';\nexport type { Stats as S } from 'node:fs';\nexport const id = randomUUID;\nexport const schema = z;\n");
  const report = checkWorkerCompat(['src/allowed.ts'], root);
  expect(report.violations).toEqual([]);
  expect(report.packages).toEqual(['zod']);
});

test('a missing entry and an unresolvable relative import are violations', () => {
  write('src/broken.ts', "import { gone } from './gone.ts';\nexport const g = gone;\n");
  const report = checkWorkerCompat(['src/missing.ts', 'src/broken.ts'], root);
  expect(report.violations.map(v => [v.file, v.module, v.line, v.reason])).toEqual([
    ['src/missing.ts', '<入口>', 0, '入口文件不存在'],
    ['src/broken.ts', './gone.ts', 1, '相对路径无法解析，依赖图不完整'],
  ]);
});

test('the command prints each violation with its chain and exits non-zero', async () => {
  const entry = write('src/cli-entry.ts', "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n");
  const child = Bun.spawn([process.execPath, CHECKER, entry], { stdout: 'pipe', stderr: 'pipe' });
  const [out, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exit).toBe(1);
  expect(out).toContain('node:fs');
  expect(out).toContain('引入链');
});

test('the command exits zero for the Worker entries', async () => {
  const child = Bun.spawn([process.execPath, CHECKER], { stdout: 'pipe', stderr: 'pipe' });
  const [out, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exit).toBe(0);
  expect(out).toContain('零违规');
});
