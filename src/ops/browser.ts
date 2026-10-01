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
}

export type BrowserInjector = (input: BrowserLoginInput) => Promise<{ url: string; title: string }>;

const TIMEOUT_MS = 60_000;
const RESULT_PREFIX = 'SCK_RESULT ';

/**
 * Signs the agent's ego-browser page in as a test account without the agent ever holding the
 * token: the script, token included, goes to the CLI over stdin (never argv, which `ps` shows),
 * writes the keys the product's own auth client reads from sessionStorage, and lands on the app.
 */
export const egoBrowserInjector: BrowserInjector = input => {
  const bin = input.bin ?? process.env.SCK_EGO_BROWSER_BIN ?? join(homedir(), '.local/bin/ego-browser');
  const script = `
const task = await taskSpace(${JSON.stringify(input.spaceId)});
const page = task.page(${JSON.stringify(input.page)});
await page.goto(${JSON.stringify(input.probeUrl)});
await page.evaluate(({ token, exp }) => {
  sessionStorage.setItem('oidc.access_token', token);
  sessionStorage.setItem('oidc.exp', String(exp));
}, ${JSON.stringify({ token: input.token, exp: Math.floor(input.expiresAt / 1000) })});
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
