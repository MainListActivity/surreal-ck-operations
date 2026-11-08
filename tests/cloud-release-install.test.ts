import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseInstall } from '../src/cloud/release-install.ts';

// 用假脚本替代 scripts/release-install.sh：只验证执行端这一层的校验、环境变量、结论、截断、脱敏与超时。
const SHA = 'a'.repeat(40);

let root: string;
let repo: string;
let serviceHome: string;
let base: { repo: string; serviceHome: string; dispatchPaused: boolean };

function fakeScript(body: string): void {
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'release-install.sh'), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sck-release-install-'));
  repo = join(root, 'repo');
  serviceHome = join(root, 'service-home');
  mkdirSync(serviceHome);
  base = { repo, serviceHome, dispatchPaused: true };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('输入校验与暂停确认', () => {
  test('sha 不是 40 位小写十六进制：invalid，且不启动脚本', async () => {
    const marker = join(root, 'ran');
    fakeScript(`touch ${marker}\n`);
    for (const bad of ['', 'A'.repeat(40), 'a'.repeat(39), 'g'.repeat(40), `${'a'.repeat(40)};rm -rf x`]) {
      await expect(releaseInstall({ sha: bad }, base)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(existsSync(marker)).toBe(false);
  });

  test('派工尚未暂停：conflict，且不启动脚本', async () => {
    const marker = join(root, 'ran');
    fakeScript(`touch ${marker}\n`);
    await expect(releaseInstall({ sha: SHA }, { ...base, dispatchPaused: false })).rejects.toMatchObject({ code: 'conflict' });
    expect(existsSync(marker)).toBe(false);
  });
});

describe('脚本执行', () => {
  test('传入 sha 参数、服务目录与库内确认的暂停标志，成功时返回脚本结论', async () => {
    fakeScript('echo "sha=$1"\necho "home=$SCK_SERVICE_HOME"\necho "paused=$SCK_RELEASE_DISPATCH_PAUSED"\necho "结果: 已装 $1"\n');
    const result = await releaseInstall({ sha: SHA }, base);
    expect(result.sha).toBe(SHA);
    expect(result.output).toContain(`sha=${SHA}`);
    expect(result.output).toContain(`home=${serviceHome}`);
    expect(result.output).toContain('paused=1');
    expect(result.conclusion).toBe(`结果: 已装 ${SHA}`);
    expect(result.truncated).toBe(false);
  });

  test('脚本非零退出：upstream_error，原因取脚本的结论行', async () => {
    fakeScript('echo "出错了"\necho "结果: 失败，已回滚到上一版本"\nexit 3\n');
    await expect(releaseInstall({ sha: SHA }, base)).rejects.toMatchObject({
      code: 'upstream_error',
      message: '装 release 失败：结果: 失败，已回滚到上一版本',
    });
  });

  test('脚本非零退出且没有结论行：原因为退出码', async () => {
    fakeScript('exit 4\n');
    await expect(releaseInstall({ sha: SHA }, base)).rejects.toMatchObject({
      code: 'upstream_error',
      message: '装 release 失败：脚本退出码 4',
    });
  });

  test('输出只保留尾部：超过 maxOutputBytes 时截断并标记，结论行仍在', async () => {
    fakeScript('i=0; while [ $i -lt 2000 ]; do echo "line $i padding padding padding"; i=$((i+1)); done\necho "结果: 完成"\n');
    const result = await releaseInstall({ sha: SHA }, { ...base, maxOutputBytes: 1024 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(1024);
    expect(result.output).toContain('结果: 完成');
    expect(result.output).not.toContain('line 0 ');
  });

  test('输出经过脱敏：JWT 形态的内容不出现在返回结果里', async () => {
    const jwt = 'eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlMTIzNDU2';
    fakeScript(`echo "token=${jwt}"\necho "结果: 完成"\n`);
    const result = await releaseInstall({ sha: SHA }, base);
    expect(result.output).not.toContain(jwt);
    expect(result.output).toContain('[redacted]');
    expect(result.conclusion).toBe('结果: 完成');
  });

  test('超时：连脚本派生的子进程一起终止，以 upstream_error 报告', async () => {
    fakeScript('sleep 30\n');
    const started = Date.now();
    await expect(releaseInstall({ sha: SHA }, { ...base, timeoutMs: 200 })).rejects.toMatchObject({ code: 'upstream_error' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
