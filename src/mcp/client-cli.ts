import { randomBytes } from 'node:crypto';
import { fstatSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, reqDir, resDir, writeFileAtomic, type CommResponse } from '../comm.ts';
import { connectCompanyClient } from './client';
import { readPrivateCredential } from './credential-file';

/** Writes every byte to stdout before the process may exit: a pipe that is not drained yet must not cut the output. */
function writeStdout(text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset, bytes.length - offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      Bun.sleepSync(2);
    }
  }
}

/** Codes a repeat of the same call may clear. Every other refusal needs the caller to change something. */
const RETRYABLE = new Set(['temporarily_unavailable', 'comm_timeout', 'comm_unavailable', 'upstream_unavailable', 'upstream_error']);

/**
 * Every outcome is one line of JSON on stdout, so a caller can always JSON.parse it (SYS01 AC03). The reason also
 * goes to stderr, and the exit status is 1. `code` is the recoverable error class.
 */
function fail(code: string, message: string): never {
  // A sidecar refusal already reads "code: reason"; keep that text once rather than repeating the code.
  const error = message.startsWith(`${code}:`) ? message : `${code}: ${message}`;
  try {
    writeStdout(`${JSON.stringify({ ok: false, code, error, retryable: RETRYABLE.has(code) })}\n`);
  } catch {
    // The reader has gone away; the exit status still reports the failure.
  }
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** The error class a sidecar answer carries before its first colon (`invalid: …`, `response_too_large: …`). */
function codeOf(error: string | undefined): string {
  const match = /^([a-z][a-z0-9_]{1,63}):/.exec(error ?? '');
  return match?.[1] ?? 'comm_error';
}

/** Tool arguments are one JSON object, or nothing. Anything else is refused before a request is written or a connection opened. */
function argumentsOf(json: string | undefined): Record<string, unknown> {
  if (json === undefined || json.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    fail('invalid_arguments', `arguments are not valid JSON: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid_arguments', 'arguments must be one JSON object, for example {} or {"pageSize":25}');
  }
  return value as Record<string, unknown>;
}

/**
 * The one answer a direct call prints, in the shape comm mode prints (SYS01 AC03): the data on success, and on failure
 * the refusal line with exit 1. The MCP result carries the answer twice, as JSON text and in structuredContent (SYS01, D1), with the
 * same data in both. Printing the whole result would print the answer twice, so only the structured answer is printed.
 */
function printAnswer(result: unknown): void {
  const { structuredContent, isError } = result as { structuredContent?: unknown; isError?: boolean };
  const answer = structuredContent as { ok?: unknown; data?: unknown; code?: unknown; error?: unknown } | undefined;
  if (typeof answer !== 'object' || answer === null || typeof answer.ok !== 'boolean') {
    fail('internal_error', 'the company service answered without a structured result');
  }
  if (answer.ok === false || isError === true) {
    const code = typeof answer.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(answer.code) ? answer.code : 'internal_error';
    const reason = typeof answer.error === 'string' && answer.error !== code ? answer.error : 'the call was refused without a reason';
    fail(code, reason);
  }
  writeStdout(`${JSON.stringify(answer.data ?? null)}\n`);
}

/** zsh expands `jq … | sck call tool "$(cat)"` to an empty argument (its `$(cat)` never sees the pipe) and the JSON
 * waits on stdin instead. An explicit empty argument with piped stdin reads it, briefly, rather than calling with {}. */
async function pipedArguments(): Promise<string> {
  try {
    const stat = fstatSync(0);
    if (!stat.isFIFO() && !stat.isFile()) return '';
  } catch {
    return '';
  }
  const text = await Promise.race([Bun.stdin.text(), new Promise<string>(resolve => setTimeout(() => resolve(''), 3000))]);
  return text;
}

async function main(): Promise<void> {
  const [command, name, json] = Bun.argv.slice(2);
  if (!['list', 'call'].includes(command ?? '')) fail('invalid_arguments', 'usage: bun src/mcp/client-cli.ts list | call <tool> [json-arguments]');
  if (command === 'call' && !name) fail('invalid_arguments', 'tool name is required');
  const args = argumentsOf(json === '' ? await pipedArguments() : json);

  // Comm mode: the plugin sidecar owns the credential; the agent relays requests
  // through its private comm directory and never sees any auth material.
  const comm = process.env.SCK_COMM_DIR;
  if (comm) {
    const commKey = process.env.SCK_COMM_KEY;
    if (!commKey) fail('missing_comm_key', 'SCK_COMM_KEY is not set — comm requests cannot be authenticated; check the dispatch environment');
    const key = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    try {
      writeFileAtomic(join(reqDir(comm), `${key}.json`), JSON.stringify({
        key: commKey, tool: command === 'list' ? '__list__' : name!, args,
      }));
    } catch {
      fail('comm_unavailable', 'comm request directory is not writable; check SCK_COMM_DIR');
    }
    const resFile = join(resDir(comm), `${key}.json`);
    // Media generation runs upstream for minutes (music up to 300s); wait past the studio's own timeout.
    // Browser-lane jobs go through a real web UI: image ~60s, video gen plus capture ~120s.
    // Notebook chapter drafts are long grounded generations: allow up to the studio's 480s cap.
    const waitMs = name === 'media_music' || name === 'media_voice_design' || name === 'media_video' || name?.startsWith('sync_') ? 330_000
      : name === 'notebook_query' || name === 'notebook_write' ? 500_000
      : name === 'media_image' ? 300_000
      : name?.startsWith('media_') || name?.startsWith('notebook_') ? 150_000 : 120_000;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const res = readJsonFile<CommResponse>(resFile);
      if (res) {
        try { unlinkSync(resFile); } catch { /* consumed race */ }
        if (!res.ok) fail(codeOf(res.error), res.error ?? 'comm request failed');
        writeStdout(`${JSON.stringify(res.data ?? null)}\n`);
        process.exit(0);
      }
      if (Date.now() > deadline) fail('comm_timeout', 'comm request timed out; the sidecar did not answer in time');
      await Bun.sleep(200);
    }
  }

  const url = process.env.SCK_MCP_URL;
  if (!url) fail('missing_endpoint', 'SCK_MCP_URL is required');
  let credential = process.env.SCK_EMPLOYEE_CREDENTIAL ?? '';
  if (process.env.SCK_EMPLOYEE_CREDENTIAL_FILE) {
    try {
      credential = await readPrivateCredential(process.env.SCK_EMPLOYEE_CREDENTIAL_FILE);
    } catch {
      fail('missing_credential', 'credential file could not be read; check SCK_EMPLOYEE_CREDENTIAL_FILE and its permissions');
    }
  }
  if (!credential) fail('missing_credential', 'SCK_EMPLOYEE_CREDENTIAL_FILE or SCK_EMPLOYEE_CREDENTIAL is required');

  let connection: Awaited<ReturnType<typeof connectCompanyClient>>;
  try {
    connection = await connectCompanyClient({
      url: new URL(url), credential, clientName: 'sck-employee-cli',
      gateToken: process.env.SCK_MCP_TOKEN || undefined,
    });
  } catch (error) {
    fail('upstream_unavailable', `company service did not accept the connection: ${String((error as Error).message ?? error).slice(0, 300)}`);
  }
  let result: unknown;
  try {
    result = command === 'list'
      ? await connection.client.listTools()
      : await connection.client.callTool({ name: name!, arguments: args });
  } catch (error) {
    await connection.close().catch(() => undefined);
    fail('upstream_error', `tool call failed: ${String((error as Error).message ?? error).slice(0, 300)}`);
  }
  await connection.close().catch(() => undefined);
  if (command === 'list') {
    writeStdout(`${JSON.stringify(result)}\n`);
    return;
  }
  printAnswer(result);
}

main().catch((error: unknown) => fail('internal_error', error instanceof Error ? error.message : String(error)));
