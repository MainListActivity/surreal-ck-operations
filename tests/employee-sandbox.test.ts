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

  test.skipIf(process.platform !== 'darwin')('only company Claude loads explicit private settings, even from a project cwd', () => {
    const root = service();
    const binary=join(root,'claude'), settings=join(root,'employee-settings.json');
    writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n');chmodSync(binary,0o755);
    writeFileSync(settings, '{}');
    expect(run(root,{SCK_SANDBOX:'employee',SCK_CLAUDE_SETTINGS:settings},binary,'--model','claude-haiku-5-5')).toMatchObject({code:0,out:`--model\nclaude-haiku-5-5\n--settings\n${settings}\n`});
    expect(run(root,{SCK_CLAUDE_SETTINGS:settings},binary,'owner')).toMatchObject({code:0,out:'owner\n'});
    expect(run(root,{SCK_SANDBOX:'employee',SCK_CLAUDE_SETTINGS:'/missing'},binary).code).toBe(78);
  });

  test.skipIf(process.platform !== 'darwin')('inside the sandbox credentials are unreadable, the sandbox cannot be edited, work files still are', () => {
    const root = service();
    const env = { SCK_SANDBOX: 'employee' };
    expect(run(root, env, '/bin/cat', join(root, 'private', 'service.env')).code).not.toBe(0);
    expect(run(root, env, '/usr/bin/touch', join(root, 'sandbox', 'employee.sb')).code).not.toBe(0);
    expect(run(root, env, '/usr/bin/touch', join(root, 'private', 'employee-agents.json')).code).not.toBe(0);
    expect(run(root, env, '/bin/launchctl', 'list').code).not.toBe(0);
    expect(run(root, env, '/usr/bin/touch', join(root, 'evidence', 'ok')).code).toBe(0);
    expect(run(root, { SCK_COMM_DIR: '/c' }, '/bin/sh', '-c', 'echo $SCK_SANDBOX')).toMatchObject({ code: 0, out: 'employee\n' });
  });

  // Factory's Execute supervisor runs `ps -o ppid= -p $$` every two seconds and kills the command when it fails;
  // /bin/ps is setuid and refused inside the sandbox, so without the shim every foreground command was SIGKILLed.
  test.skipIf(process.platform !== 'darwin')('company sessions get a working ps first on PATH; the setuid one stays refused', () => {
    const root = service();
    const build = Bun.spawnSync(['sh', join(SRC, 'build-ps.sh'), join(root, 'sandbox')], { stdout: 'pipe', stderr: 'pipe' });
    expect(build.exitCode).toBe(0);
    const env = { SCK_SANDBOX: 'employee' };
    expect(run(root, env, '/bin/sh', '-c', '/bin/ps -o ppid= -p $$').code).not.toBe(0);
    expect(run(root, env, '/bin/sh', '-c', 'command -v ps').out.trim()).toBe(join(root, 'sandbox', 'shim', 'ps'));
    const ppid = run(root, env, '/bin/sh', '-c', 'ps -o ppid= -p $$; echo "real=$PPID"');
    expect(ppid.code).toBe(0);
    const [got, real] = ppid.out.trim().split('\n');
    expect(`real=${got!.trim()}`).toBe(real!);
    expect(run(root, env, '/bin/sh', '-c', 'ps -o pid= -p 999999').code).toBe(1);
    const cols = run(root, env, '/bin/sh', '-c', 'ps -o pid,pgid,command -p $$').out.split('\n');
    expect(cols[0]).toBe('PID PGID COMMAND');
    expect(cols[1]).toContain('ps -o pid,pgid,command -p');
    // The owner's own sessions keep the system ps.
    expect(run(root, {}, '/bin/sh', '-c', 'command -v ps').out.trim()).toBe('/bin/ps');
  });
});
