import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'scripts', 'sandbox');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A service home laid out like the installed one: <service>/sandbox/{launch.sh,employee.sb}, <service>/private. */
function service(withProfile = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sck-sandbox-')));
  dirs.push(root);
  mkdirSync(join(root, 'sandbox'));
  mkdirSync(join(root, 'private'));
  mkdirSync(join(root, 'evidence'));
  copyFileSync(join(SRC, 'launch.sh'), join(root, 'sandbox', 'launch.sh'));
  chmodSync(join(root, 'sandbox', 'launch.sh'), 0o755);
  if (withProfile) copyFileSync(join(SRC, 'employee.sb'), join(root, 'sandbox', 'employee.sb'));
  writeFileSync(join(root, 'private', 'service.env'), 'SECRET=1\n');
  return root;
}
const run = (root: string, env: Record<string, string>, ...argv: string[]) => {
  const p = Bun.spawnSync([join(root, 'sandbox', 'launch.sh'), ...argv], { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...env }, stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

describe('employee sandbox launcher', () => {
  test('unmarked sessions (the owner, Paseo probes) run the binary unchanged', () => {
    const root = service(false);
    expect(run(root, {}, '/bin/cat', join(root, 'private', 'service.env'))).toMatchObject({ code: 0, out: 'SECRET=1\n' });
  });

  test('a company session never starts unsandboxed when the profile is missing', () => {
    const root = service(false);
    for (const env of [{ SCK_SANDBOX: 'employee' }, { SCK_COMM_DIR: '/c' }] as Record<string, string>[]) {
      const r = run(root, env, '/bin/echo', 'started');
      expect(r.code).toBe(78);
      expect(r.out).toBe('');
    }
  });

  test.skipIf(process.platform !== 'darwin')('inside the sandbox credentials are unreadable, the sandbox cannot be edited, work files still are', () => {
    const root = service();
    const env = { SCK_SANDBOX: 'employee' };
    expect(run(root, env, '/bin/cat', join(root, 'private', 'service.env')).code).not.toBe(0);
    expect(run(root, env, '/usr/bin/touch', join(root, 'sandbox', 'employee.sb')).code).not.toBe(0);
    expect(run(root, env, '/bin/launchctl', 'list').code).not.toBe(0);
    expect(run(root, env, '/usr/bin/touch', join(root, 'evidence', 'ok')).code).toBe(0);
    expect(run(root, { SCK_COMM_DIR: '/c' }, '/bin/sh', '-c', 'echo $SCK_SANDBOX')).toMatchObject({ code: 0, out: 'employee\n' });
  });
});
