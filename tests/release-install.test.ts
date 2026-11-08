import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/release-install.sh 只在测试中跑非法 sha 与演练（SCK_RELEASE_INSTALL_DRY_RUN=1），不触碰真实服务目录。
const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'release-install.sh');
const SHA = 'a'.repeat(40);

function run(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'release-install-'));
  try {
    const result = Bun.spawnSync(['sh', SCRIPT, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, SCK_SERVICE_HOME: home, ...env },
    });
    return {
      code: result.exitCode,
      out: `${result.stdout.toString()}${result.stderr.toString()}`,
      stdout: result.stdout.toString(),
      entries: readdirSync(home),
      releasesExists: existsSync(join(home, 'releases')),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('illegal sha values exit non-zero with a Chinese reason and create nothing under the service home', () => {
  const cases = ['abc', 'A'.repeat(40), 'g'.repeat(40), '', 'a'.repeat(39), 'a'.repeat(41)];
  for (const sha of cases) {
    const result = run(sha === '' ? [''] : [sha], { SCK_RELEASE_INSTALL_DRY_RUN: '1' });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/拒绝|不合法/);
    expect(result.entries).toEqual([]);
  }
});

test('a missing sha argument is refused without touching the service home', () => {
  const result = run([], { SCK_RELEASE_INSTALL_DRY_RUN: '1' });
  expect(result.code).not.toBe(0);
  expect(result.out).toContain('拒绝');
  expect(result.entries).toEqual([]);
});

test('a valid sha in dry-run prints every install step, exits 0 and creates no releases directory', () => {
  const result = run([SHA], { SCK_RELEASE_INSTALL_DRY_RUN: '1' });
  expect(result.code).toBe(0);
  for (const step of ['校验版本', '生成固定快照', '安装依赖并类型检查', '本机发布门禁', '确认派工已暂停', '切换现役版本', '验证']) {
    expect(result.stdout).toContain(step);
  }
  expect(result.stdout.trimEnd().split('\n').at(-1)).toContain(`结果: 演练完成 sha=${SHA}`);
  expect(result.entries).toEqual([]);
  expect(result.releasesExists).toBe(false);
});

test('dry-run without COMPANY_DB_URL says the local mode skips the migration', () => {
  const result = run([SHA], { SCK_RELEASE_INSTALL_DRY_RUN: '1' });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('本机模式跳过迁移');
  expect(result.stdout).not.toContain('company-migrate');
});

test('dry-run with COMPANY_DB_URL names the company-migrate call and never echoes the URL', () => {
  const secret = 'postgres://user:not-a-real-secret@example.invalid/db';
  const result = run([SHA], { SCK_RELEASE_INSTALL_DRY_RUN: '1', COMPANY_DB_URL: secret });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('调用公司库迁移');
  expect(result.stdout).toContain('company-migrate.ts');
  expect(result.stdout).not.toContain('not-a-real-secret');
  expect(result.out).not.toContain(secret);
});
