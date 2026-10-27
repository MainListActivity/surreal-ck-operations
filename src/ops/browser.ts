import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CompanyError } from '../core-errors.ts';
import type { FaultFacts } from '../faults.ts';
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

/**
 * SYS05: bounded close of one ego-browser task space when a lease ends. The closer resolves when the
 * space was closed, was already gone, or is owned by the user (it is never taken over); it rejects
 * only when the close actually failed, so the broker can keep the space pending instead of claiming
 * a cleanup that did not happen.
 */
export type BrowserSpaceCloser = (input: { employeeId: string; spaceId: number }) => Promise<void>;

const TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 30_000;
const RESULT_PREFIX = 'SCK_RESULT ';
const ERROR_PREFIX = 'SCK_ERROR ';
const STAGE_PREFIX = 'SCK_STAGE ';
const CLOSE_PREFIX = 'SCK_CLOSE ';
/** The tail kept besides the first line; bounded so a CLI dump cannot flood the audit. */
const FAILURE_TAIL_LINES = 4;
const FAILURE_MAX_CHARS = 800;

/** The stages of one injection. Fixed names, part of the diagnostic, never free text. */
export type BrowserStage = 'space' | 'probe' | 'store' | 'landing' | 'result';
export type BrowserCloseStage = 'list' | 'open' | 'finish';

const firstLine = (text: string): string => text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';

/**
 * The structured failure of one injection: machine facts (code, errno, retryability, stage) and a
 * bounded, sanitized message that keeps the CLI's own first line. The message never carries the
 * token or a session handle.
 */
export interface BrowserInjectFailure {
  code: 'not_found' | 'invalid' | 'upstream_error';
  retryable: boolean;
  stage: BrowserStage | BrowserCloseStage | 'unknown';
  errno?: string;
  message: string;
}

/** The errno-shaped tokens the CLI and Chromium print that mean the transport may be tried again. */
const TRANSIENT_TOKEN = /UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|net::ERR_(?:TIMED_OUT|CONNECTION_TIMED_OUT|CONNECTION_RESET|CONNECTION_REFUSED|CONNECTION_CLOSED|CONNECTION_ABORTED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|NETWORK_CHANGED|ADDRESS_UNREACHABLE)/i;
/** Chromium network errors land on the connect-phase errnos the fault classifier already knows. */
const NET_ERRNO: Array<[RegExp, string]> = [
  [/net::ERR_(?:TIMED_OUT|CONNECTION_TIMED_OUT)/i, 'ETIMEDOUT'],
  [/net::ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_ABORTED)/i, 'ECONNRESET'],
  [/net::ERR_CONNECTION_REFUSED/i, 'ECONNREFUSED'],
  [/net::ERR_(?:NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED)/i, 'ENOTFOUND'],
  [/net::ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|ADDRESS_UNREACHABLE)/i, 'ENETUNREACH'],
];
const TIMEOUT_TOKEN = /(?:timed?\s*out|timeout|TimeoutError)/i;
/** Deterministic refusals: the same call cannot succeed by repeating it. */
const SPACE_NOT_FOUND = /task space not found|no such (?:task )?space|space .*not found/i;
/** The fixed stages of both CLI operations; an unknown value is never echoed, only reported as `unknown`. */
const KNOWN_STAGES = ['space', 'probe', 'store', 'landing', 'result', 'list', 'open', 'finish'];

/**
 * Classify the CLI failure from machine facts and the (already redacted) output. Only an explicit
 * timeout/connection failure is retryable; an unknown failure stays `unclassified` semantics and is
 * never retried here. A missing space is a deterministic `not_found`, not a transport fault.
 */
export function browserInjectFailure(input: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  elapsedMs: number;
  timedOut?: boolean;
  /** Which CLI operation failed; only used in the sanitized message. */
  operation?: 'login' | 'close';
}): BrowserInjectFailure {
  const text = `${input.stderr}\n${input.stdout}`;
  const structured = /^SCK_ERROR (\{.*\})$/m.exec(text);
  let stage: BrowserInjectFailure['stage'] = 'unknown';
  let ownLine = '';
  if (structured) {
    try {
      const parsed = JSON.parse(structured[1]!) as { stage?: unknown; message?: unknown; name?: unknown };
      if (typeof parsed.stage === 'string' && KNOWN_STAGES.includes(parsed.stage)) {
        stage = parsed.stage as BrowserInjectFailure['stage'];
      }
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      ownLine = message ? (name && !message.startsWith(name) ? `${name}: ${message}` : message) : '';
    } catch { /* the CLI line is untrusted; fall through to the text scan */ }
  }
  if (stage === 'unknown') {
    const stages = [...text.matchAll(/^SCK_STAGE (\w+)$/gm)];
    const last = stages.at(-1)?.[1];
    if (last && KNOWN_STAGES.includes(last)) stage = last as BrowserInjectFailure['stage'];
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  const errorLine = ownLine
    || lines.find(line => /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|DOMException|EGO_[A-Z_]+)\b/.test(line))
    || firstLine(text);
  // Notices are not evidence: an update banner must not turn a deterministic refusal into a retry.
  const salient = lines.filter(line => !line.startsWith('[ego-browser:notice]')).join('\n');
  const combined = `${errorLine}\n${salient}`;
  const elapsedMs = Math.max(0, Math.round(input.elapsedMs));
  const exit = input.exitCode === null ? 'signal' : String(input.exitCode);

  let code: BrowserInjectFailure['code'] = 'upstream_error';
  let retryable = false;
  let errno: string | undefined;
  if (input.timedOut) {
    // Our own deadline fired: nothing proves the page request was delivered, but a navigation is a
    // repeatable read, so a bounded retry is safe.
    retryable = true;
    errno = 'ETIMEDOUT';
  } else if (SPACE_NOT_FOUND.test(combined)) {
    code = 'not_found';
  } else if (TIMEOUT_TOKEN.test(combined)) {
    retryable = true;
    errno = /TimeoutError/.test(combined) ? 'TimeoutError' : 'ETIMEDOUT';
  } else if (TRANSIENT_TOKEN.test(combined)) {
    retryable = true;
    const token = TRANSIENT_TOKEN.exec(combined)?.[0] ?? '';
    errno = NET_ERRNO.find(([pattern]) => pattern.test(token))?.[1] ?? (token.replace(/^net::/, '') || 'ECONNRESET');
  }
  // An unknown failure is not a network fault: no retry, and the anomaly keeps stopping the
  // injection scope (the caller's classifier sees no errno).

  const tail = lines.slice(-FAILURE_TAIL_LINES).join(' | ');
  const head = `${errorLine || 'no output'}`;
  const detail = tail && !tail.includes(head) ? `${head} | ${tail}` : head;
  const label = input.operation === 'close' ? 'browser space close failed' : 'browser login failed';
  const message = `${label} (exit ${exit}, stage=${stage}, ${elapsedMs}ms): ${detail}`
    .slice(0, FAILURE_MAX_CHARS);
  return { code, retryable, stage, ...(errno === undefined ? {} : { errno }), message };
}

/** Attach the machine facts the fault classifier reads, without ever putting them in the message. */
function withFacts(error: CompanyError, facts: FaultFacts): CompanyError {
  (error as CompanyError & { facts?: FaultFacts }).facts = facts;
  return error;
}

/**
 * Signs the agent's ego-browser page in as a test account without the agent ever holding the
 * token: the script, token included, goes to the CLI over stdin (never argv, which `ps` shows),
 * writes what the target app reads from sessionStorage (the customer app's flat keys, or the ops
 * console's serialized `User` record when `oidcUser` is set), and lands on the app.
 *
 * Every step is preceded by a fixed stage marker, so a failure keeps the stage it died in even when
 * the CLI's own message is generic. The first error line, the stage, the elapsed time and the exit
 * code are returned; the token is redacted from anything the CLI prints.
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
let stage = 'space';
try {
  console.log(${JSON.stringify(`${STAGE_PREFIX}space`)});
  const task = await taskSpace(${JSON.stringify(input.spaceId)});
  const page = task.page(${JSON.stringify(input.page)});
  stage = 'probe';
  console.log(${JSON.stringify(`${STAGE_PREFIX}probe`)});
  await page.goto(${JSON.stringify(input.probeUrl)});
  stage = 'store';
  console.log(${JSON.stringify(`${STAGE_PREFIX}store`)});
  await page.evaluate((entries) => {
    for (const { key, value } of entries) sessionStorage.setItem(key, value);
  }, ${JSON.stringify(entries)});
  stage = 'landing';
  console.log(${JSON.stringify(`${STAGE_PREFIX}landing`)});
  await page.goto(${JSON.stringify(input.landingUrl)});
  stage = 'result';
  console.log(${JSON.stringify(`${STAGE_PREFIX}result`)});
  console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ url: await page.url(), title: await page.title() }));
} catch (error) {
  const message = String((error && error.message) || error).split(/\\r?\\n/)[0];
  console.log(${JSON.stringify(ERROR_PREFIX)} + JSON.stringify({ stage, name: (error && error.name) || 'Error', message }));
  throw error;
}
`;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      clearTimeout(timer);
      reject(new CompanyError('not_configured', `ego-browser CLI is not runnable (${(error as NodeJS.ErrnoException).code ?? error.name})`));
    });
    child.once('close', code => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - started;
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
      // Everything the CLI printed is untrusted output that may echo session material.
      const safeOut = redactText(stdout, [input.token]);
      const safeErr = redactText(stderr, [input.token]);
      const failure = browserInjectFailure({ stdout: safeOut, stderr: safeErr, exitCode: code, elapsedMs, timedOut });
      reject(withFacts(
        new CompanyError(failure.code, failure.message, failure.retryable),
        failure.errno === undefined ? {} : { errno: failure.errno },
      ));
    });
    child.stdin.on('error', () => { /* CLI exited before reading; close handler reports it */ });
    child.stdin.end(script);
  });
};

/** The bounded-close script: it only ever finishes an agent-owned space, never a user-owned one. */
export function browserCloseScript(spaceId: number): string {
  return `
let stage = 'list';
try {
  const spaces = await listTaskSpaces();
  const entry = spaces.find((space) => space.id === ${JSON.stringify(spaceId)});
  if (!entry) {
    console.log(${JSON.stringify(CLOSE_PREFIX)} + JSON.stringify({ outcome: 'absent' }));
  } else if (entry.ownership !== 'agent') {
    console.log(${JSON.stringify(CLOSE_PREFIX)} + JSON.stringify({ outcome: 'skipped', ownership: String(entry.ownership || 'unknown') }));
  } else {
    stage = 'open';
    const task = await taskSpace(${JSON.stringify(spaceId)});
    if (task.ownership !== 'agent') {
      console.log(${JSON.stringify(CLOSE_PREFIX)} + JSON.stringify({ outcome: 'skipped', ownership: String(task.ownership || 'unknown') }));
    } else {
      stage = 'finish';
      await task.finish({ keep: [] });
      console.log(${JSON.stringify(CLOSE_PREFIX)} + JSON.stringify({ outcome: 'closed' }));
    }
  }
} catch (error) {
  const message = String((error && error.message) || error).split(/\\r?\\n/)[0];
  console.log(${JSON.stringify(ERROR_PREFIX)} + JSON.stringify({ stage, name: (error && error.name) || 'Error', message }));
  throw error;
}
`;
}

export interface BrowserCloseOutcome {
  outcome: 'closed' | 'absent' | 'skipped';
  ownership?: string;
}

/** The structured outcome of a close, when the CLI reported one. Absent means the close did not report. */
export function browserCloseOutcome(stdout: string, stderr: string): BrowserCloseOutcome | undefined {
  for (const stream of [stderr, stdout]) {
    const line = stream.split(/\r?\n/).find(text => text.startsWith(CLOSE_PREFIX));
    if (!line) continue;
    try {
      const parsed = JSON.parse(line.slice(CLOSE_PREFIX.length)) as { outcome?: unknown; ownership?: unknown };
      if (parsed.outcome === 'closed' || parsed.outcome === 'absent' || parsed.outcome === 'skipped') {
        return {
          outcome: parsed.outcome,
          ...(typeof parsed.ownership === 'string' ? { ownership: parsed.ownership.slice(0, 40) } : {}),
        };
      }
    } catch { /* untrusted output */ }
  }
  return undefined;
}

/**
 * SYS05 production closer. It lists the task spaces first and only finishes one whose ownership is
 * `agent`; a space the user owns is skipped, never taken over. A space that is already gone is a
 * successful, idempotent close. Only a real failure rejects, so `release` keeps it pending.
 */
export const egoBrowserSpaceCloser: BrowserSpaceCloser = ({ spaceId }) => {
  const bin = process.env.SCK_EGO_BROWSER_BIN ?? join(homedir(), '.local/bin/ego-browser');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CLOSE_TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      clearTimeout(timer);
      reject(new Error(`ego-browser CLI is not runnable (${(error as NodeJS.ErrnoException).code ?? error.name})`));
    });
    child.once('close', code => {
      clearTimeout(timer);
      const result = browserCloseOutcome(stdout, stderr);
      if (code === 0 && result) { resolve(); return; }
      const failure = browserInjectFailure({
        stdout: redactText(stdout), stderr: redactText(stderr), exitCode: code, elapsedMs: Date.now() - started,
        timedOut, operation: 'close',
      });
      // The finish raced another close: the space is gone, which is the outcome this closer wants.
      if (!timedOut && /not found|no such (?:task )?space|already (?:closed|finished)|not running/i.test(failure.message)) {
        resolve();
        return;
      }
      reject(new Error(`${failure.message} (space ${spaceId})`.slice(0, FAILURE_MAX_CHARS)));
    });
    child.stdin.on('error', () => { /* CLI exited before reading; close handler reports it */ });
    child.stdin.end(browserCloseScript(spaceId));
  });
};
