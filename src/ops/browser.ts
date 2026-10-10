import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CompanyError } from '../core-errors.ts';
import { redactText } from './redact.ts';

export interface BrowserLoginInput {
  /** Path of the ego-browser CLI; defaults to the user-level install. */
  bin?: string;
  spaceId: number;
  page: string;
  /** A same-origin, non-SPA URL where sessionStorage can be written without starting an OIDC redirect. */
  probeUrl: string;
  landingUrl: string;
  token: string;
  /** Epoch ms; the product stores epoch seconds. */
  expiresAt: number;
  /**
   * Operator console sessions are `oidc-client-ts` `UserManager` users: when set, the injector
   * writes this serialized `User` record (see `oidcUserEntry`) under the sessionStorage key the
   * SPA derives, instead of the customer app's two flat keys.
   */
  oidcUser?: { key: string; value: string };
}

/**
 * The sessionStorage entry the ops console's `UserManager` reads back in `_loadUser`:
 * `WebStorageStateStore` prefixes `oidc.` onto `user:<authority>:<client_id>`, and the value is
 * `User.toStorageString()`'s JSON shape. `expires_at` is epoch seconds; `User.expired` drops the
 * session once the token dies, so an injected session never outlives its access token.
 */
export function oidcUserEntry(input: {
  authority: string;
  clientId: string;
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
  profile: Record<string, unknown>;
}): { key: string; value: string } {
  return {
    key: `oidc.user:${input.authority}:${input.clientId}`,
    value: JSON.stringify({
      access_token: input.token,
      token_type: 'Bearer',
      scope: input.scope,
      profile: input.profile,
      expires_at: Math.floor(input.expiresAt / 1000),
    }),
  };
}

export type BrowserInjector = (input: BrowserLoginInput) => Promise<{ url: string; title: string }>;

const TIMEOUT_MS = 60_000;
const RESULT_PREFIX = 'SCK_RESULT ';

/**
 * Signs the agent's ego-browser page in as a test account without the agent ever holding the
 * token: the script, token included, goes to the CLI over stdin (never argv, which `ps` shows),
 * writes what the target app reads from sessionStorage (the customer app's flat keys, or the ops
 * console's serialized `User` record when `oidcUser` is set), and lands on the app.
 */
export const egoBrowserInjector: BrowserInjector = input => {
  const bin = input.bin ?? process.env.SCK_EGO_BROWSER_BIN ?? join(homedir(), '.local/bin/ego-browser');
  // The host picks which keys the page writes: the ops console's serialized `User` record, or
  // the customer app's flat token keys — the page script itself never branches on the kind.
  const entries = input.oidcUser
    ? [{ key: input.oidcUser.key, value: input.oidcUser.value }]
    : [
        { key: 'oidc.access_token', value: input.token },
        { key: 'oidc.exp', value: String(Math.floor(input.expiresAt / 1000)) },
      ];
  const script = `
const task = await taskSpace(${JSON.stringify(input.spaceId)});
const page = task.page(${JSON.stringify(input.page)});
await page.goto(${JSON.stringify(input.probeUrl)});
await page.evaluate((entries) => {
  for (const { key, value } of entries) sessionStorage.setItem(key, value);
}, ${JSON.stringify(entries)});
await page.goto(${JSON.stringify(input.landingUrl)});
console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ url: await page.url(), title: await page.title() }));
`;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new CompanyError('upstream_error', 'browser login timed out', true)); }, TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      clearTimeout(timer);
      reject(new CompanyError('not_configured', `ego-browser CLI is not runnable (${(error as NodeJS.ErrnoException).code ?? error.name})`));
    });
    child.once('close', code => {
      clearTimeout(timer);
      // The CLI reports script output (console.log) on stderr, not stdout, and notices can
      // land on either stream: scan both for the result line instead of one fixed stream.
      const line = [stdout, stderr].map(text => text.split(/\r?\n/).find(l => l.startsWith(RESULT_PREFIX))).find(Boolean);
      if (code === 0 && line) {
        try {
          const parsed: unknown = JSON.parse(line.slice(RESULT_PREFIX.length));
          if (parsed && typeof parsed === 'object'
            && typeof (parsed as { url?: unknown }).url === 'string'
            && typeof (parsed as { title?: unknown }).title === 'string') {
            resolve(parsed as { url: string; title: string });
            return;
          }
        } catch { /* fall through */ }
      }
      const detail = redactText(`${stderr}\n${stdout}`, [input.token]).trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 300);
      reject(new CompanyError('upstream_error', `browser login failed (exit ${code}): ${detail}`));
    });
    child.stdin.on('error', () => { /* CLI exited before reading; close handler reports it */ });
    child.stdin.end(script);
  });
};
