import { describe, expect, test } from 'bun:test';
import { blockedPatterns, registerScrub, scrubEnv } from '../plugin/server/scrub.ts';

const daemonEnv = {
  PATH: '/usr/bin', HOME: '/Users/x', SSH_AUTH_SOCK: '/tmp/agent.sock', OPENAI_API_KEY: 'provider-login',
  CLOUDFLARE_API_TOKEN: 'cf-secret', CLOUDFLARE_ACCOUNT_ID: 'acct', JEV_API_KEY: 'jev-secret',
  SURREAL_ROOT_PASS: 'root-pass', SCK_PRODUCT_ENV: '/p/.env',
};

describe('scrubEnv', () => {
  test('blanks inherited infrastructure credentials and leaves everything else alone', () => {
    const env = scrubEnv({ SCK_COMM_DIR: '/c', SCK_COMM_KEY: 'k' }, daemonEnv);
    expect(env).toEqual({
      CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', JEV_API_KEY: '', SURREAL_ROOT_PASS: '', SCK_PRODUCT_ENV: '',
      SCK_COMM_DIR: '/c', SCK_COMM_KEY: 'k',
    });
    expect(env.PATH).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined(); // the provider process shares this env; blanking it would break the agent
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
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
});

type Handler = (input: { request: Record<string, unknown> }, ctx: { paseo: unknown; signal: AbortSignal }) => Promise<unknown>;

function hook(labels: Record<string, string> | 'fails' | 'hangs' = {}) {
  let handler!: Handler;
  const server = { before: (_name: string, fn: Handler) => { handler = fn; return () => {}; } };
  registerScrub(server as never, daemonEnv);
  let lookups = 0;
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
    expect(out?.env).toMatchObject({ SCK_COMM_DIR: '/c', SCK_COMM_KEY: 'k', CLOUDFLARE_API_TOKEN: '', JEV_API_KEY: '' });
    expect(h.lookups()).toBe(0);
  });

  test('somebody else\'s new agent is left untouched', async () => {
    const h = hook({ company: 'surreal-ck' });
    expect(await h.open({ ...base, reason: 'create', env: {} })).toBeUndefined();
    expect(h.lookups()).toBe(0);
  });

  test('a resumed company agent has lost its marker but is recognised by its labels, once', async () => {
    const h = hook({ company: 'surreal-ck' });
    const first = await h.open({ ...base, reason: 'resume', env: {} });
    expect(first?.env.CLOUDFLARE_API_TOKEN).toBe('');
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

  test('a resumed agent that is not a company agent, or cannot be looked up, is left alone', async () => {
    expect(await hook({}).open({ ...base, reason: 'resume', env: {} })).toBeUndefined();
    expect(await hook('fails').open({ ...base, reason: 'resume', env: {} })).toBeUndefined();
  });

  test('a lookup that never answers does not hold the agent open', async () => {
    const started = Date.now();
    expect(await hook('hangs').open({ ...base, reason: 'import', env: {} })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 6_000);
});
