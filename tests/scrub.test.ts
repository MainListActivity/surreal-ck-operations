import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockedPatterns, externalPatterns, installZdot, registerScrub, sandboxGap, scrubEnv, userZshDir, zdotFiles } from '../plugin/server/scrub.ts';

const daemonEnv = {
  PATH: '/usr/bin', HOME: '/Users/x', SSH_AUTH_SOCK: '/tmp/agent.sock', OPENAI_API_KEY: 'provider-login',
  CLOUDFLARE_API_TOKEN: 'cf-secret', CLOUDFLARE_ACCOUNT_ID: 'acct', JEV_API_KEY: 'jev-secret',
  SURREAL_ROOT_PASS: 'root-pass', SCK_PRODUCT_ENV: '/p/.env', ELEVENLABS_API_KEY: 'el-secret', XI_API_KEY: 'xi-secret',
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
      CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', JEV_API_KEY: '', SURREAL_ROOT_PASS: '', SCK_PRODUCT_ENV: '', ELEVENLABS_API_KEY: '', XI_API_KEY: '',
      SCK_COMM_DIR: '/c', SCK_COMM_KEY: 'k',
    });
    expect(env.PATH).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined(); // the provider process shares this env; blanking it would break the agent
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  test('the ElevenLabs key names are blanked as well', () => {
    expect(blockedPatterns()).toEqual(expect.arrayContaining(['ELEVENLABS_', 'XI_API_KEY']));
    expect(scrubEnv({}, { ELEVENLABS_API_KEY: 'el', XI_API_KEY: 'xi', PATH: '/bin' })).toEqual({ ELEVENLABS_API_KEY: '', XI_API_KEY: '' });
  });

  test('values the launch sets explicitly win over the blanking', () => {
    const env = scrubEnv({ SCK_EMPLOYEE_CREDENTIAL_FILE: '/creds/e1.token' }, { ...daemonEnv, SCK_EMPLOYEE_CREDENTIAL_FILE: '/stale' });
    expect(env.SCK_EMPLOYEE_CREDENTIAL_FILE).toBe('/creds/e1.token');
  });

  test('SCK_SCRUB_ENV adds names and prefixes', () => {
    const patterns = blockedPatterns('MY_VENDOR_, NPM_TOKEN');
    const env = scrubEnv({}, { MY_VENDOR_KEY: 'x', NPM_TOKEN: 'y', PATH: '/bin' }, patterns);
    expect(env).toEqual({ MY_VENDOR_KEY: '', NPM_TOKEN: '' });
  });

  test('the shell-startup patterns leave out the company\'s own plumbing variables but keep the extras', () => {
    const external = externalPatterns('NPM_TOKEN');
    expect(external).toContain('CLOUDFLARE_');
    expect(external).toContain('NPM_TOKEN');
    expect(external.some(pattern => pattern.startsWith('SCK_'))).toBe(false);
    expect(blockedPatterns('NPM_TOKEN')).toEqual(expect.arrayContaining([...external, 'SCK_OPS_', 'SCK_PRODUCT_ENV']));
  });
});

describe('zsh startup shim files', () => {
  test('every zsh startup file sources the user\'s own file first, then unsets the credential names', () => {
    const files = zdotFiles('/Users/x', ['CLOUDFLARE_', 'JEV_']);
    expect(Object.keys(files).sort()).toEqual(['.zlogin', '.zprofile', '.zshenv', '.zshrc']);
    for (const [file, text] of Object.entries(files)) {
      const lines = text.split('\n');
      expect(lines[0]).toBe(`[ -r '/Users/x/${file}' ] && . '/Users/x/${file}'`);
      expect(text).toContain('(CLOUDFLARE_|JEV_)*');
      expect(text.indexOf('. \'/Users/x')).toBeLessThan(text.indexOf('unset "$_sck_name"'));
    }
  });

  test('a user directory with quotes in its name stays one shell word', () => {
    const [line] = zdotFiles(`/Users/o'neil`, ['JEV_'])['.zshrc'].split('\n');
    expect(line).toBe(`[ -r '/Users/o'\\''neil/.zshrc' ] && . '/Users/o'\\''neil/.zshrc'`);
  });

  test('only plain names reach the shell; anything else is left to the launch env', () => {
    const text = zdotFiles('/h', ['JEV_', 'bad name;', '$(x)', 'NPM_TOKEN'])['.zshrc'];
    expect(text).toContain('(JEV_|NPM_TOKEN)*');
    expect(text).not.toContain('bad name');
    expect(text).not.toContain('$(x)');
    expect(zdotFiles('/h', [])['.zshrc']).not.toContain('unset');
  });

  test('installZdot writes private files and rewrites them on the next start', () => {
    const dir = join(fresh('install'), 'zdot');
    installZdot(dir, '/h', ['JEV_']);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, '.zshrc')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, '.zshrc'), 'utf8')).toContain('(JEV_)*');
    installZdot(dir, '/h2', ['JEV_', 'NPM_TOKEN']);
    expect(readFileSync(join(dir, '.zshrc'), 'utf8')).toContain('/h2/.zshrc');
    expect(readFileSync(join(dir, '.zshrc'), 'utf8')).toContain('(JEV_|NPM_TOKEN)*');
  });

  test('the user\'s zsh directory is ZDOTDIR if they set one, else HOME, and never the shim itself', () => {
    expect(userZshDir('/shim', { HOME: '/h' })).toBe('/h');
    expect(userZshDir('/shim', { HOME: '/h', ZDOTDIR: '/h/.config/zsh' })).toBe('/h/.config/zsh');
    expect(userZshDir('/shim', { HOME: '/h', ZDOTDIR: '/shim/' })).toBe('/h');
  });
});

const zsh = Bun.which('zsh');
const FIELDS = ['CLOUDFLARE_API_TOKEN', 'CF_API_SHELLVAR', 'SURREAL_PASS', 'TYPESAFE_X', 'JEV_API_KEY', 'ELEVENLABS_API_KEY'] as const;
const KEPT = ['KEEP_RC', 'KEEP_ENV', 'KEEP_PROFILE'] as const;

describe.skipIf(!zsh)('zsh startup shim in a real zsh', () => {
  function userHome(name: string) {
    const home = fresh(name);
    writeFileSync(join(home, '.zshenv'), 'export TYPESAFE_X=leak-env KEEP_ENV=env\n');
    writeFileSync(join(home, '.zprofile'), 'export SURREAL_PASS=leak-profile KEEP_PROFILE=profile\n');
    writeFileSync(join(home, '.zshrc'), 'export CLOUDFLARE_API_TOKEN=leak-rc JEV_API_KEY=leak-rc ELEVENLABS_API_KEY=leak-rc KEEP_RC=rc\nCF_API_SHELLVAR=leak-unexported\n');
    return home;
  }

  function run(flag: string, env: Record<string, string>): Record<string, string> {
    const names = [...FIELDS, ...KEPT];
    const script = `print -r -- "RESULT:${names.map(name => `${name}=[$${name}]`).join(' ')}"`;
    const proc = Bun.spawnSync([zsh!, flag, script], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, stdout: 'pipe', stderr: 'pipe' });
    const line = proc.stdout.toString().split('\n').reverse().find(item => item.startsWith('RESULT:'));
    expect(line, `zsh ${flag}: ${proc.stderr.toString()}`).toBeDefined();
    return Object.fromEntries([...line!.slice('RESULT:'.length).matchAll(/(\w+)=\[([^\]]*)\]/g)].map(match => [match[1], match[2]]));
  }

  for (const flag of ['-c', '-lc', '-ic', '-lic']) {
    test(`zsh ${flag}: credentials the user's startup files export are gone, the rest of the setup survives`, () => {
      const home = userHome('user');
      const shim = fresh('shim');
      installZdot(shim, home, externalPatterns());

      const baseline = run(flag, { HOME: home, ZDOTDIR: home });
      const shimmed = run(flag, { HOME: home, ZDOTDIR: shim });

      for (const name of FIELDS) expect(shimmed[name], `${name} under ${flag}`).toBe('');
      for (const name of KEPT) expect(shimmed[name], `${name} under ${flag}`).toBe(baseline[name]);
      if (flag.includes('i')) expect(baseline.CLOUDFLARE_API_TOKEN).toBe('leak-rc'); // the control: without the shim this really leaks
      if (flag === '-c') expect(baseline.TYPESAFE_X).toBe('leak-env');
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
});

type Handler = (input: { request: Record<string, unknown> }, ctx: { paseo: unknown; signal: AbortSignal }) => Promise<unknown>;

function hook(labels: Record<string, string> | 'fails' | 'hangs' = {}, options: Parameters<typeof registerScrub>[2] = {}, inherited: Record<string, string> = daemonEnv) {
  let handler!: Handler;
  const server = { before: (_name: string, fn: Handler) => { handler = fn; return () => {}; } };
  let lookups = 0;
  registerScrub(server as never, inherited, { employee: async () => {
    lookups++;
    if (labels === 'fails') throw Error('registry unavailable');
    if (labels === 'hangs') return new Promise<boolean>(() => {});
    return labels.company === 'surreal-ck';
  }, ...options });
  const paseo = {
    agents: {
      ref: () => ({
        refresh: () => {
          lookups++;
          if (labels === 'fails') return Promise.reject(new Error('gone'));
          if (labels === 'hangs') return new Promise(() => {});
          return Promise.resolve({ agent: { labels } });
        },
      }),
    },
  };
  const open = (request: Record<string, unknown>) => handler({ request }, { paseo, signal: new AbortController().signal }) as Promise<{ env: Record<string, string> } | undefined>;
  return { open, lookups: () => lookups };
}

const base = { agentId: 'a1', workspaceId: 'w', provider: 'codex', cwd: '/x', purpose: 'interactive' };

describe('agent.session_open hook', () => {
  test('a marked company launch is scrubbed without asking the daemon anything', async () => {
    const h = hook();
    const out = await h.open({ ...base, reason: 'create', env: { SCK_COMM_DIR: '/c', SCK_COMM_KEY: 'k' } });
    expect(out?.env).toMatchObject({ SCK_COMM_DIR: '/c', SCK_COMM_KEY: 'k', CLOUDFLARE_API_TOKEN: '', JEV_API_KEY: '', SCK_SANDBOX: 'employee' });
    expect(h.lookups()).toBe(0);
  });

  test('somebody else\'s new agent is left untouched', async () => {
    const h = hook({ company: 'surreal-ck' });
    expect(await h.open({ ...base, reason: 'create', env: {} })).toBeUndefined();
    expect(h.lookups()).toBe(0);
  });

  test('a resumed company agent has lost its marker but is recognised by its durable registry, once', async () => {
    const h = hook({ company: 'surreal-ck' });
    const first = await h.open({ ...base, reason: 'resume', env: {} });
    expect(first?.env.CLOUDFLARE_API_TOKEN).toBe('');
    // The resumed session carries no channel variable, so the sandbox marker is what keeps it sandboxed.
    expect(first?.env.SCK_SANDBOX).toBe('employee');
    await h.open({ ...base, reason: 'refresh', env: {} });
    expect(h.lookups()).toBe(1);
  });

  test('an agent remembered from its marked launch is scrubbed again on resume', async () => {
    const h = hook('fails');
    await h.open({ ...base, reason: 'create', env: { SCK_COMM_DIR: '/c' } });
    const resumed = await h.open({ ...base, reason: 'resume', env: {} });
    expect(resumed?.env.CLOUDFLARE_API_TOKEN).toBe('');
    expect(h.lookups()).toBe(0);
  });

  test('an authoritative non-employee is left alone; a registry failure is refused', async () => {
    expect(await hook({}).open({ ...base, reason: 'resume', env: {} })).toBeUndefined();
    await expect(hook('fails').open({ ...base, reason: 'resume', env: {} })).rejects.toThrow('身份登记');
  });

  test('an unavailable registry is bounded and never silently bypasses routing', async () => {
    const started = Date.now();
    await expect(hook('hangs').open({ ...base, reason: 'import', env: {} })).rejects.toThrow('身份登记');
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 6_000);
});

describe('agent.session_open hook with the zsh startup shim', () => {
  const launch = { SCK_COMM_DIR: '/c', SCK_COMM_KEY: 'k' };

  test('company sessions start zsh from the shim directory, which the hook writes', async () => {
    const zdotdir = join(fresh('hook'), 'zdot');
    const out = await hook({}, { zdotdir }).open({ ...base, reason: 'create', env: launch });
    expect(out?.env.ZDOTDIR).toBe(zdotdir);
    expect(readFileSync(join(zdotdir, '.zshrc'), 'utf8')).toContain(`'/Users/x/.zshrc'`);
    expect(readFileSync(join(zdotdir, '.zshrc'), 'utf8')).toContain('(CLOUDFLARE_|CF_API_|SURREAL|JEV_|TYPESAFE_|ELEVENLABS_|XI_API_KEY)*');
  });

  test('the shim sources the user\'s ZDOTDIR when they have one, and never itself', async () => {
    const zdotdir = join(fresh('hook'), 'zdot');
    hook({}, { zdotdir }, { ...daemonEnv, ZDOTDIR: '/Users/x/.config/zsh' });
    expect(readFileSync(join(zdotdir, '.zshrc'), 'utf8')).toContain(`'/Users/x/.config/zsh/.zshrc'`);
    hook({}, { zdotdir }, { ...daemonEnv, ZDOTDIR: zdotdir });
    expect(readFileSync(join(zdotdir, '.zshrc'), 'utf8')).toContain(`'/Users/x/.zshrc'`);
  });

  test('a ZDOTDIR the launch sets itself wins, and other people\'s agents get none', async () => {
    const zdotdir = join(fresh('hook'), 'zdot');
    const h = hook({}, { zdotdir });
    expect((await h.open({ ...base, reason: 'create', env: { ...launch, ZDOTDIR: '/mine' } }))?.env.ZDOTDIR).toBe('/mine');
    expect(await h.open({ ...base, agentId: 'a2', reason: 'create', env: {} })).toBeUndefined();
  });

  test('without a shim directory nothing is added to the environment', async () => {
    const out = await hook().open({ ...base, reason: 'create', env: launch });
    expect(out?.env.ZDOTDIR).toBeUndefined();
  });

  test('a shim directory that cannot be written is logged and the environment scrub still applies', async () => {
    const blocker = join(fresh('blocked'), 'file');
    writeFileSync(blocker, '');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await hook({}, { zdotdir: join(blocker, 'zdot') }).open({ ...base, reason: 'create', env: launch });
      expect(out?.env.ZDOTDIR).toBeUndefined();
      expect(out?.env.CLOUDFLARE_API_TOKEN).toBe('');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('employee sandbox gate', () => {
  const wrappers = '/svc/sandbox/bin';
  const config = (providers: Record<string, unknown>) => {
    const file = join(fresh('paseo'), 'config.json');
    writeFileSync(file, JSON.stringify({ agents: { providers } }));
    return file;
  };

  test('a provider launched through its wrapper passes; codex, a bare binary or a missing config does not', () => {
    const file = config({ claude: { command: ['/svc/sandbox/bin/claude'] }, 'factory-droid': { command: ['/Users/x/.local/bin/droid', 'exec'] } });
    expect(sandboxGap('claude', file, wrappers)).toBeUndefined();
    expect(sandboxGap('factory-droid', file, wrappers)).toContain('install.sh');
    expect(sandboxGap('antigravity', file, wrappers)).toContain('install.sh');
    expect(sandboxGap('codex', file, wrappers)).toContain('codex');
    expect(sandboxGap('claude', '/nope/config.json', wrappers)).toContain('Paseo');
  });

  test('an interactive company session the sandbox does not cover is refused; history and other agents are not', async () => {
    const h = hook({}, { sandbox: provider => provider === 'claude' ? undefined : 'not covered' });
    await expect(h.open({ ...base, provider: 'codex', reason: 'create', env: { SCK_COMM_DIR: '/c' } })).rejects.toThrow('员工沙箱');
    expect((await h.open({ ...base, provider: 'claude', reason: 'create', env: { SCK_COMM_DIR: '/c' } }))?.env.SCK_SANDBOX).toBe('employee');
    expect(await h.open({ ...base, provider: 'codex', purpose: 'history', reason: 'create', env: { SCK_COMM_DIR: '/c' } })).toBeDefined();
    expect(await h.open({ ...base, agentId: 'other', provider: 'codex', reason: 'create', env: {} })).toBeUndefined();
  });
});
