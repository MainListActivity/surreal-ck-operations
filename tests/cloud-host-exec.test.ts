import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostExec, RUNNER_HOSTS, sshArgs } from '../src/cloud/host-exec.ts';

const HOST = 'arm-free-1';
const KEY = '/fake/test-identity-path';
const TARGET = 'sck-agent@129.146.179.37';
const PRINT_ARGS = 'for a in "$@"; do printf \'%s\\n\' "$a"; done\nexit 0';

let dir = '';
let counter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-exec-test-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 写一个伪造的 ssh 可执行脚本，返回其路径。 */
function fakeSsh(body: string): string {
  const path = join(dir, `ssh-${counter++}`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('白名单与 sshArgs', () => {
  test('白名单外主机被拒且不启动进程', async () => {
    const marker = join(dir, `marker-${counter}`);
    const sshBin = fakeSsh(`touch "${marker}"\nexit 0`);
    await expect(hostExec({ host: 'evil-host', command: 'id' }, { keyPath: KEY, sshBin })).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  test('白名单内主机地址与用户固定', () => {
    expect(RUNNER_HOSTS[HOST]).toEqual({ user: 'sck-agent', address: '129.146.179.37' });
  });

  test('sshArgs 含四个必需选项、-i 密钥、user@address，远端命令在 -- 之后', () => {
    const args = sshArgs(HOST, KEY, 'uptime; whoami');
    const joined = args.join(' ');
    expect(joined).toContain('-o ControlMaster=no');
    expect(joined).toContain('-o ControlPath=none');
    expect(joined).toContain('-o IdentitiesOnly=yes');
    expect(joined).toContain('-o BatchMode=yes');
    const keyIndex = args.indexOf('-i');
    expect(args[keyIndex + 1]).toBe(KEY);
    const separator = args.indexOf('--');
    expect(separator).toBeGreaterThan(keyIndex);
    expect(args.slice(separator + 1)).toEqual([TARGET, 'uptime; whoami']);
  });

  test('sshArgs 对未知主机抛错', () => {
    expect(() => sshArgs('nope', KEY, 'id')).toThrow();
  });
});

describe('hostExec 输入校验', () => {
  test('命令为空、含 NUL、超长，超时越界时不启动进程', async () => {
    const marker = join(dir, `marker-validate-${counter}`);
    const sshBin = fakeSsh(`touch "${marker}"\nexit 0`);
    const base = { keyPath: KEY, sshBin };
    await expect(hostExec({ host: HOST, command: '   ' }, base)).rejects.toThrow();
    await expect(hostExec({ host: HOST, command: 'a\0b' }, base)).rejects.toThrow();
    await expect(hostExec({ host: HOST, command: 'a'.repeat(8193) }, base)).rejects.toThrow();
    await expect(hostExec({ host: HOST, command: 'id', timeoutSec: 0 }, base)).rejects.toThrow();
    await expect(hostExec({ host: HOST, command: 'id', timeoutSec: 901 }, base)).rejects.toThrow();
    await expect(hostExec({ host: HOST, command: 'id', timeoutSec: 1.5 }, base)).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });
});

describe('hostExec 执行', () => {
  test('伪造 ssh 收到的参数与 sshArgs 一致', async () => {
    const sshBin = fakeSsh(PRINT_ARGS);
    const result = await hostExec({ host: HOST, command: 'echo hi; whoami' }, { keyPath: KEY, sshBin });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.host).toBe(HOST);
    expect(result.stdout.split('\n').slice(0, -1)).toEqual(sshArgs(HOST, KEY, 'echo hi; whoami'));
  });

  test('默认脱敏会遮住 JWT 形态的输出', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    const sshBin = fakeSsh(`printf 'token %s\\n' "${jwt}"\nexit 0`);
    const result = await hostExec({ host: HOST, command: 'x' }, { keyPath: KEY, sshBin });
    expect(result.stdout).not.toContain(jwt);
    expect(result.stdout).toContain('[redacted]');
  });

  test('输出超过 maxOutputBytes 时截断并标记', async () => {
    const sshBin = fakeSsh("head -c 300000 /dev/zero | tr '\\0' 'a'\nexit 0");
    const result = await hostExec({ host: HOST, command: 'x' }, { keyPath: KEY, sshBin, maxOutputBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1000);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  test('redact 注入后输出经过该函数处理', async () => {
    const sshBin = fakeSsh("printf 'value=SECRET-VALUE-XYZ\\n'\nprintf 'err=SECRET-VALUE-XYZ\\n' >&2\nexit 0");
    const result = await hostExec(
      { host: HOST, command: 'x' },
      { keyPath: KEY, sshBin, redact: text => text.split('SECRET-VALUE-XYZ').join('[X]') },
    );
    expect(result.stdout).toBe('value=[X]\n');
    expect(result.stderr).toBe('err=[X]\n');
  });

  test('超时后 kill 子进程，timedOut=true，exitCode=null', async () => {
    const sshBin = fakeSsh('exec sleep 30');
    const started = Date.now();
    const result = await hostExec({ host: HOST, command: 'x', timeoutSec: 1 }, { keyPath: KEY, sshBin });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  test('非零退出码原样返回，stderr 单独收集', async () => {
    const sshBin = fakeSsh('echo oops >&2\nexit 7');
    const result = await hostExec({ host: HOST, command: 'x' }, { keyPath: KEY, sshBin });
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe('oops\n');
    expect(result.stdout).toBe('');
  });
});
