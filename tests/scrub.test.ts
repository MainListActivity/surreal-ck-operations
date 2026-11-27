import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockedPatterns, externalPatterns, installZdot, scrubEnv, userZshDir, zdotFiles } from '../src/runner/launch-env.ts';
import { externalPatterns as nativeExternalPatterns, installZdot as installNativeZdot, userZshDir as nativeUserZshDir } from '../src/runner/launch-env.ts';
import { nativeEmployeeEnv } from '../src/runner/native-env.ts';
import { NativeRuntime } from '../src/runner/native.ts';

const daemonEnv = {
  PATH: '/usr/bin', HOME: '/Users/x', SSH_AUTH_SOCK: '/tmp/agent.sock', OPENAI_API_KEY: 'provider-login',
  CLOUDFLARE_API_TOKEN: 'cf-secret', CLOUDFLARE_ACCOUNT_ID: 'acct', JEV_API_KEY: 'jev-secret',
  SURREAL_ROOT_PASS: 'root-pass', SCK_PRODUCT_ENV: '/p/.env', ELEVENLABS_API_KEY: 'el-secret', XI_API_KEY: 'xi-secret',
  SCK_PREVIEW_SECRET: 'synthetic-preview-secret',
};

const scratch = mkdtempSync(join(tmpdir(), 'sck-scrub-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (name: string) => {
  const dir = join(scratch, `${name}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('scrubEnv', () => {
  test('blanks inherited infrastructure credentials and leaves everything else alone', () => {
    const env = scrubEnv({ SCK_COMM_DIR: '/c', SCK_COMM_KEY: 'k' }, daemonEnv);
    expect(env).toEqual({
      CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', JEV_API_KEY: '', SURREAL_ROOT_PASS: '', SCK_PRODUCT_ENV: '', ELEVENLABS_API_KEY: '', XI_API_KEY: '', SCK_PREVIEW_SECRET: '',
      SCK_COMM_DIR: '/c', SCK_COMM_KEY: 'k',
    });
    expect(env.PATH).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined(); // the provider process shares this env; blanking it would break the agent
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  test('the ElevenLabs and OCI key names are blanked as well', () => {
    expect(blockedPatterns()).toEqual(expect.arrayContaining(['ELEVENLABS_', 'XI_API_KEY', 'OCI_']));
    expect(scrubEnv({}, { ELEVENLABS_API_KEY: 'el', XI_API_KEY: 'xi', OCI_CLI_KEY_FILE: '/k.pem', OCI_CONFIG_FILE: '/c', PATH: '/bin' }))
      .toEqual({ ELEVENLABS_API_KEY: '', XI_API_KEY: '', OCI_CLI_KEY_FILE: '', OCI_CONFIG_FILE: '' });
  });

  test('values the launch sets explicitly win over the blanking', () => {
    const env = scrubEnv({ SCK_COMM_DIR: '/comm/e1' }, { ...daemonEnv, SCK_COMM_DIR: '/stale' });
    expect(env.SCK_COMM_DIR).toBe('/comm/e1');
  });

  test('SCK_SCRUB_ENV adds names and prefixes', () => {
    const patterns = blockedPatterns('MY_VENDOR_, NPM_TOKEN');
    const env = scrubEnv({}, { MY_VENDOR_KEY: 'x', NPM_TOKEN: 'y', PATH: '/bin' }, patterns);
    expect(env).toEqual({ MY_VENDOR_KEY: '', NPM_TOKEN: '' });
  });

  test('the shell-startup patterns leave out the company\'s own plumbing variables but keep server secrets and the extras', () => {
    const external = externalPatterns('NPM_TOKEN');
    expect(external).toContain('CLOUDFLARE_');
    expect(external).toContain('NPM_TOKEN');
    // service.env is shell-shaped, so a startup file can re-export the preview signing secret; it is the
    // only SCK_ name the shim strips. Task channel variables (SCK_COMM_*) stay granted, never blocked.
    expect(external.filter(pattern => pattern.startsWith('SCK_'))).toEqual(['SCK_PREVIEW_SECRET']);
    expect(blockedPatterns('NPM_TOKEN')).toEqual(expect.arrayContaining([...external, 'SCK_OPS_', 'SCK_PRODUCT_ENV']));
  });
});

describe('zsh startup shim files', () => {
  test('every zsh startup file reads the user\'s own file from the directory ZDOTDIR points at, strips the names, then exports ZDOTDIR back to the shim', () => {
    expect(zdotFiles('/shim', '/Users/x', ['CLOUDFLARE_', 'JEV_'])['.zshenv']).toBe([
      "ZDOTDIR=${_sck_zdot:-'/Users/x'}",
      '[ -r "$ZDOTDIR/.zshenv" ] && . "$ZDOTDIR/.zshenv"',
      '_sck_zdot=${ZDOTDIR:-$HOME}',
      `[ "$_sck_zdot" = '/shim' ] && _sck_zdot='/Users/x'`,
      'for _sck_name in ${(k)parameters[(I)(CLOUDFLARE_|JEV_)*]}; do unset "$_sck_name" 2>/dev/null; done',
      'unset _sck_name',
      `export ZDOTDIR='/shim'`,
      '',
    ].join('\n'));
    const files = zdotFiles('/shim', '/Users/x', ['CLOUDFLARE_', 'JEV_']);
    expect(Object.keys(files).sort()).toEqual(['.zlogin', '.zprofile', '.zshenv', '.zshrc']);
    for (const [file, text] of Object.entries(files)) {
      expect(text).toContain(`[ -r "$ZDOTDIR/${file}" ] && . "$ZDOTDIR/${file}"`);
      expect(text).toContain('(CLOUDFLARE_|JEV_)*');
      expect(text.indexOf('. "$ZDOTDIR/')).toBeLessThan(text.indexOf('unset "$_sck_name"'));
      expect(text.indexOf('unset "$_sck_name"')).toBeLessThan(text.indexOf(`export ZDOTDIR='/shim'`));
    }
  });

  test('a user directory with quotes in its name stays one shell word', () => {
    const [line] = zdotFiles('/shim', `/Users/o'neil`, ['JEV_'])['.zshrc'].split('\n');
    expect(line).toBe(`ZDOTDIR=\${_sck_zdot:-'/Users/o'\\''neil'}`);
  });

  test('only plain names reach the shell; anything else is left to the launch env', () => {
    const text = zdotFiles('/shim', '/h', ['JEV_', 'bad name;', '$(x)', 'NPM_TOKEN'])['.zshrc'];
    expect(text).toContain('(JEV_|NPM_TOKEN)*');
    expect(text).not.toContain('bad name');
    expect(text).not.toContain('$(x)');
    expect(zdotFiles('/shim', '/h', [])['.zshrc']).not.toContain('unset');
  });

  test('installZdot writes private files and rewrites them on the next start', () => {
    const dir = join(fresh('install'), 'zdot');
    installZdot(dir, '/h', ['JEV_']);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, '.zshrc')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, '.zshrc'), 'utf8')).toContain('(JEV_)*');
    installZdot(dir, '/h2', ['JEV_', 'NPM_TOKEN']);
    expect(readFileSync(join(dir, '.zshrc'), 'utf8')).toContain("ZDOTDIR=${_sck_zdot:-'/h2'}");
    expect(readFileSync(join(dir, '.zshrc'), 'utf8')).toContain('(JEV_|NPM_TOKEN)*');
  });

  test('the user\'s zsh directory is ZDOTDIR if they set one, else HOME, and never the shim itself', () => {
    expect(userZshDir('/shim', { HOME: '/h' })).toBe('/h');
    expect(userZshDir('/shim', { HOME: '/h', ZDOTDIR: '/h/.config/zsh' })).toBe('/h/.config/zsh');
    expect(userZshDir('/shim', { HOME: '/h', ZDOTDIR: '/shim/' })).toBe('/h');
  });
});

const zsh = Bun.which('zsh');
// CI installs zsh (quality-gate.yml). A skipped zsh regression would read as green, so CI treats a missing zsh as a failure.
if (!zsh && process.env.CI) throw new Error('CI 缺少 zsh：真实 zsh 启动文件回归不能跳过');
const FIELDS = ['CLOUDFLARE_API_TOKEN', 'CF_API_SHELLVAR', 'SURREAL_PASS', 'TYPESAFE_X', 'JEV_API_KEY', 'ELEVENLABS_API_KEY', 'SCK_PREVIEW_SECRET'] as const;
const KEPT = ['KEEP_RC', 'KEEP_ENV', 'KEEP_PROFILE', 'KEEP_LOGIN', 'KEEP_ZDOT_PROFILE'] as const;
/** Launch values the shim must leave alone: the task channel and the provider login. */
const LAUNCH = { SCK_COMM_KEY: 'channel-key', OPENAI_API_KEY: 'provider-login' } as const;
/** The service secret as private/service.env holds it. The moved-ZDOTDIR files re-export this exact value, as the incident did. */
const PREVIEW = 'synthetic-preview-secret';
const PRINTED = ['ZDOTDIR', 'SCK_SANDBOX', ...FIELDS, ...KEPT, ...Object.keys(LAUNCH)];

function userHome(name: string) {
  const home = fresh(name);
  writeFileSync(join(home, '.zshenv'), 'export TYPESAFE_X=leak-env KEEP_ENV=env\n');
  writeFileSync(join(home, '.zprofile'), 'export SURREAL_PASS=leak-profile KEEP_PROFILE=profile\n');
  writeFileSync(join(home, '.zshrc'), 'export CLOUDFLARE_API_TOKEN=leak-rc JEV_API_KEY=leak-rc ELEVENLABS_API_KEY=leak-rc SCK_PREVIEW_SECRET=leak-rc KEEP_RC=rc\nCF_API_SHELLVAR=leak-unexported\n');
  return home;
}

/**
 * A user whose own .zshenv moves ZDOTDIR away from HOME: exported to a directory of their own, or unset so zsh
 * falls back to HOME. Each startup file leaks the service secret and a Cloudflare token under its own value.
 */
function movedHome(name: string, move: 'export' | 'unset') {
  const home = fresh(name);
  const dir = move === 'export' ? join(home, 'zsh-user') : home;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, '.zshenv'), [
    move === 'export' ? `export ZDOTDIR='${dir}'` : 'unset ZDOTDIR',
    `export TYPESAFE_X=leak-zshenv KEEP_ENV=env CLOUDFLARE_API_TOKEN=leak-zshenv SCK_PREVIEW_SECRET=${PREVIEW}`,
  ].join('\n') + '\n');
  writeFileSync(join(dir, '.zprofile'), [
    `export SURREAL_PASS=leak-zprofile KEEP_PROFILE=profile CLOUDFLARE_API_TOKEN=leak-zprofile SCK_PREVIEW_SECRET=${PREVIEW}`,
    ...(move === 'export' ? ['export KEEP_ZDOT_PROFILE="$ZDOTDIR"'] : []),
  ].join('\n') + '\n');
  writeFileSync(join(dir, '.zshrc'), `export JEV_API_KEY=leak-zshrc ELEVENLABS_API_KEY=leak-zshrc CLOUDFLARE_API_TOKEN=leak-zshrc SCK_PREVIEW_SECRET=${PREVIEW} KEEP_RC=rc\nCF_API_SHELLVAR=leak-unexported\n`);
  writeFileSync(join(dir, '.zlogin'), `export CLOUDFLARE_API_TOKEN=leak-zlogin SCK_PREVIEW_SECRET=${PREVIEW} KEEP_LOGIN=login\n`);
  return home;
}

/**
 * Prints every compared name, then starts a nested non-interactive zsh from the same shell. Whatever a child of
 * the employee shell inherits is what that nested zsh reports as CHILD.
 */
function probe(): string {
  return `print -r -- "RESULT:${PRINTED.map(name => `${name}=[$${name}]`).join(' ')}"\n` +
    `${zsh!} -c 'print -r -- "CHILD:[$SCK_PREVIEW_SECRET]|[$CLOUDFLARE_API_TOKEN]"'\n`;
}

function parseProbe(stdout: string, stderr: string): Record<string, string> {
  const lines = stdout.split('\n');
  const result = [...lines].reverse().find(item => item.startsWith('RESULT:'));
  const child = [...lines].reverse().find(item => item.startsWith('CHILD:'));
  expect(result, stderr).toBeDefined();
  expect(child, stderr).toBeDefined();
  return { ...Object.fromEntries([...result!.slice('RESULT:'.length).matchAll(/(\w+)=\[([^\]]*)\]/g)].map(match => [match[1], match[2]])), CHILD: child!.slice('CHILD:'.length) };
}

function run(flag: string, env: Record<string, string>): Record<string, string> {
  const proc = Bun.spawnSync([zsh!, flag, probe()], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, stdout: 'pipe', stderr: 'pipe' });
  return parseProbe(proc.stdout.toString(), proc.stderr.toString());
}

describe.skipIf(!zsh)('zsh startup shim in a real zsh', () => {
  for (const flag of ['-c', '-lc', '-ic', '-lic']) {
    test(`zsh ${flag}: credentials the user's startup files export are gone, the rest of the setup survives`, () => {
      const home = userHome('user');
      const shim = fresh('shim');
      installZdot(shim, home, externalPatterns());

      const baseline = run(flag, { HOME: home, ZDOTDIR: home, ...LAUNCH });
      const shimmed = run(flag, { HOME: home, ZDOTDIR: shim, ...LAUNCH });

      for (const name of FIELDS) expect(shimmed[name], `${name} under ${flag}`).toBe('');
      expect(shimmed.CHILD, `nested zsh -c under ${flag}`).toBe('[]|[]');
      for (const name of KEPT) expect(shimmed[name], `${name} under ${flag}`).toBe(baseline[name]);
      expect(shimmed.SCK_COMM_KEY).toBe(LAUNCH.SCK_COMM_KEY);
      expect(shimmed.OPENAI_API_KEY).toBe(LAUNCH.OPENAI_API_KEY);
      if (flag.includes('i')) expect(baseline.CLOUDFLARE_API_TOKEN).toBe('leak-rc'); // the control: without the shim this really leaks
      if (flag === '-c') expect(baseline.TYPESAFE_X).toBe('leak-env');
    });
  }

  for (const move of ['export', 'unset'] as const) for (const flag of ['-c', '-lc', '-ic', '-lic']) {
    test(`zsh ${flag}: a user .zshenv that ${move === 'export' ? 'exports ZDOTDIR elsewhere' : 'unsets ZDOTDIR'} cannot bring the preview secret or the Cloudflare token back`, () => {
      const home = movedHome(`${move}-${flag.slice(1)}`, move);
      const shim = fresh('shim');
      installZdot(shim, home, externalPatterns());

      const baseline = run(flag, { HOME: home, ZDOTDIR: home, ...LAUNCH });
      const shimmed = run(flag, { HOME: home, ZDOTDIR: shim, ...LAUNCH });

      // the control: without the shim these same files really leak both values under this flag
      expect(baseline.SCK_PREVIEW_SECRET).toBe(PREVIEW);
      expect(baseline.CLOUDFLARE_API_TOKEN).toMatch(/^leak-/);
      expect(shimmed.SCK_PREVIEW_SECRET).toBe('');
      expect(shimmed.CLOUDFLARE_API_TOKEN).toBe('');
      for (const name of FIELDS) expect(shimmed[name], `${name} under ${flag}`).toBe('');
      expect(shimmed.CHILD, `nested zsh -c under ${flag}`).toBe('[]|[]');
      for (const name of KEPT) expect(shimmed[name], `${name} under ${flag}`).toBe(baseline[name]);
      expect(shimmed.SCK_COMM_KEY).toBe(LAUNCH.SCK_COMM_KEY);
      expect(shimmed.OPENAI_API_KEY).toBe(LAUNCH.OPENAI_API_KEY);
      // ZDOTDIR stays on the shim after startup, so nested shells keep going through it
      expect(shimmed.ZDOTDIR).toBe(shim);
      // a user file that runs while ZDOTDIR is the user's own sees that directory, as it would without the shim
      if (move === 'export' && flag.includes('l')) expect(shimmed.KEEP_ZDOT_PROFILE).toBe(join(home, 'zsh-user'));
    });
  }

  test('a user who keeps their zsh files under their own ZDOTDIR is covered too', () => {
    const home = fresh('home');
    const userDir = userHome('userdir');
    const shim = fresh('shim');
    installZdot(shim, userZshDir(shim, { HOME: home, ZDOTDIR: userDir }), externalPatterns());
    const shimmed = run('-ic', { HOME: home, ZDOTDIR: shim });
    expect(shimmed.CLOUDFLARE_API_TOKEN).toBe('');
    expect(shimmed.KEEP_RC).toBe('rc');
  });

  test('names added through SCK_SCRUB_ENV are stripped from startup files as well', () => {
    const home = fresh('extra');
    writeFileSync(join(home, '.zshrc'), 'export NPM_TOKEN=leak MY_VENDOR_KEY=leak KEEP_RC=rc\n');
    const shim = fresh('shim');
    installZdot(shim, home, externalPatterns('NPM_TOKEN,MY_VENDOR_'));
    const proc = Bun.spawnSync([zsh!, '-ic', 'print -r -- "RESULT:[$NPM_TOKEN][$MY_VENDOR_KEY][$KEEP_RC]"'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ZDOTDIR: shim }, stdout: 'pipe', stderr: 'pipe' });
    expect(proc.stdout.toString()).toContain('RESULT:[][][rc]');
  });

  test('a native employee shell, started with the environment the runtime builds, keeps the preview secret out when the user\'s .zshenv moves ZDOTDIR', async () => {
    // The same nativeEmployeeEnv that run.ts hands to NativeRuntime; the shell is spawned by the runtime itself.
    const root = fresh('native');
    const home = movedHome('native-moved', 'export');
    const zdotdir = join(root, 'zdot');
    installNativeZdot(zdotdir, nativeUserZshDir(zdotdir, { HOME: home }), nativeExternalPatterns());
    const inherited = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, OPENAI_API_KEY: 'provider-login', CLOUDFLARE_API_TOKEN: 'cf-secret', SCK_PREVIEW_SECRET: PREVIEW, SCK_COMM_KEY: 'stale' };
    const probeFile = join(root, 'probe.txt');
    const ended: unknown[] = [];
    const runtime = new NativeRuntime({
      root: join(root, 'runtime'), host: 'test',
      command: () => [zsh!, '-lic', `exec > '${probeFile}'\n${probe()}`],
      environment: async () => nativeEmployeeEnv({ inherited, channel: { SCK_COMM_DIR: join(root, 'comm'), SCK_COMM_KEY: LAUNCH.SCK_COMM_KEY }, modelEnv: {}, lane: {}, zdotdir }),
      onEnded: async event => { ended.push(event); },
    });
    try {
      const id = await runtime.spawn({ title: 'SCK · fixture', provider: 'factory-droid', model: 'fixture-model', cwd: root, workspaceTitle: 'fixture', labels: { employee_id: 'fixture' }, env: {}, prompt: 'fixture only' });
      await runtime.activate(id);
      for (let i = 0; ended.length === 0 && i < 500; i++) await Bun.sleep(10);
      expect(ended).toHaveLength(1);
      const seen = parseProbe(readFileSync(probeFile, 'utf8'), '');
      for (const name of FIELDS) expect(seen[name], `${name} in the native shell`).toBe('');
      expect(seen.CHILD, 'nested zsh -c in the native shell').toBe('[]|[]');
      expect(seen.SCK_COMM_KEY).toBe(LAUNCH.SCK_COMM_KEY);
      expect(seen.OPENAI_API_KEY).toBe(LAUNCH.OPENAI_API_KEY);
      expect(seen.SCK_SANDBOX).toBe('employee');
      expect(seen.ZDOTDIR).toBe(zdotdir);
      // the user's own files still run, each one from the directory that belongs to it
      expect(seen.KEEP_ENV).toBe('env');
      expect(seen.KEEP_PROFILE).toBe('profile');
      expect(seen.KEEP_LOGIN).toBe('login');
      expect(seen.KEEP_RC).toBe('rc');
      expect(seen.KEEP_ZDOT_PROFILE).toBe(join(home, 'zsh-user'));
    } finally { await runtime.close(); }
  });
});

test('原生执行端不向员工继承云端公司连接、执行端凭证与服务端预览签名密钥环境', () => {
  const inherited = { COMPANY_DB_TOKEN: 'fixture', RUNNER_CLIENT_SECRET: 'fixture', IDP_SECRET: 'fixture', GATEWAY_TOKEN: 'fixture', SCK_PREVIEW_SECRET: 'fixture', OPENAI_API_KEY: 'provider-login' };
  const env = nativeEmployeeEnv({ inherited, channel: { SCK_COMM_DIR: '/c', SCK_COMM_KEY: 'channel-key' }, modelEnv: {}, lane: {}, zdotdir: '/shim' });
  expect(env.COMPANY_DB_TOKEN).toBe(''); expect(env.RUNNER_CLIENT_SECRET).toBe('');
  expect(env.IDP_SECRET).toBe(''); expect(env.GATEWAY_TOKEN).toBe('');
  expect(env.SCK_PREVIEW_SECRET).toBe('');
  expect(env.SCK_COMM_KEY).toBe('channel-key');
  expect(env.OPENAI_API_KEY).toBe('provider-login');
  expect(env.SCK_SANDBOX).toBe('employee');
});

test('run.ts launches with nativeEmployeeEnv and no merge of its own, so the merge tested above is the one that runs', () => {
  const source = readFileSync(join(import.meta.dir, '../src/runner/run.ts'), 'utf8');
  expect(source).toContain('return nativeEmployeeEnv({ inherited: process.env, channel, modelEnv, lane, zdotdir });');
  expect(source).not.toContain('PASEO_AGENT_ID');
});

test('原生执行端的 ZDOTDIR 最后设置：继承、通道或模型路由都不能把它改离垫片', () => {
  const inherited = { ZDOTDIR: '/user-zsh', CLOUDFLARE_API_TOKEN: 'fixture', PATH: '/usr/bin' };
  const env = nativeEmployeeEnv({ inherited, channel: { ZDOTDIR: '/channel-zsh', SCK_COMM_DIR: '/c' }, modelEnv: { ZDOTDIR: '/model-zsh' }, lane: { ZDOTDIR: '/lane-zsh' }, zdotdir: '/shim' });
  expect(env.ZDOTDIR).toBe('/shim');
  expect(env.CLOUDFLARE_API_TOKEN).toBe('');
  expect(env.PATH).toBe('/usr/bin');
});
