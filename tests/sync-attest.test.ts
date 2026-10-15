import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// sck-sync-attest end to end: a fake vault socket answers status + sync_projects; the test
// binary then writes the single-use free-trial artifact it would land for the owner. Nothing
// here touches the real vault, keychain or upstream — fixtures only.

const ROOT = join(import.meta.dir, '..');
const BIN = join(ROOT, 'vault', 'build', 'sck-sync-attest-test');
const KEY_FP = 'fptest1234abcd56';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

let dir = '';
let socket = '';
let home = '';
let server: net.Server | undefined;
let calls: Array<Record<string, unknown>> = [];

const replyFor = (req: Record<string, unknown>): Record<string, unknown> => {
  calls.push(req);
  if (req.op === 'status') {
    return { ok: true, configured: true, providers: { elevenlabs: { configured: true }, sync: { configured: true, keyFp: KEY_FP } } };
  }
  if (req.op === 'call' && req.kind === 'sync_projects') {
    return {
      ok: true, status: 200, contentType: 'application/json',
      bodyBase64: Buffer.from(JSON.stringify({ items: [{ id: 'p-1', organizationId: 'org-bound' }] })).toString('base64'),
    };
  }
  return { ok: false, code: 'invalid', message: 'unknown op' };
};

// The mock vault lives in this process, so the attest binary must be spawned async:
// a synchronous spawn would deadlock the event loop the server answers on.
const run = async (args: string[], stdin = 'yes\nyes\n') => {
  const proc = Bun.spawn([BIN, ...args], {
    env: { ...process.env, SCK_VAULT_TEST_SOCKET: socket, SCK_ATTEST_TEST_HOME: home, SCK_VAULT_TEST_AUTO_APPROVE: '1' },
    stdin: Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
};

const baseArgs = (extra: string[] = []) => [
  '--project', 'maplayer-content', '--task', '02186d39-94fa-4582-be50-7a66278b7fad',
  '--video-sha256', sha('d01-video'), '--audio-sha256', sha('d01-audio'), '--remaining', '1',
  '--evidence', join(dir, 'billing.png'), '--evidence', join(dir, 'projects.png'), ...extra,
];

const swiftAvailable = Bun.which('swiftc') !== null;

describe.skipIf(!swiftAvailable)('sck-sync-attest', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sck-attest-'));
    home = join(dir, 'home');
    socket = join(dir, 'vault.sock');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, 'billing.png'), 'fake billing screenshot bytes');
    writeFileSync(join(dir, 'projects.png'), 'fake projects screenshot bytes');
    const build = Bun.spawnSync(['sh', join(ROOT, 'vault', 'build.sh'), '--test'], { stdout: 'pipe', stderr: 'pipe' });
    expect(build.exitCode).toBe(0);
    server = net.createServer(conn => {
      conn.on('data', data => {
        try {
          const req = JSON.parse(data.toString().split('\n')[0]);
          conn.end(`${JSON.stringify(replyFor(req))}\n`);
        } catch { conn.end('{"ok":false,"code":"invalid"}\n'); }
      });
    });
    server.listen(socket);
    await new Promise(resolve => server!.once('listening', resolve));
  });

  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  test('a confirmed attestation lands a fully-bound single-use free-trial artifact', async () => {
    calls = [];
    const result = await run(baseArgs());
    expect(result.exitCode).toBe(0);
    const target = [...result.stdout.split('\n')].reverse().find(line => line.trim().endsWith('.json'))!.trim();
    expect(existsSync(target)).toBe(true);
    const artifact = JSON.parse(readFileSync(target, 'utf8'));
    expect(artifact).toMatchObject({
      schema: 'sync-spend-approval/1', issuer: 'owner', project: 'maplayer-content',
      taskId: '02186d39-94fa-4582-be50-7a66278b7fad', accountRef: KEY_FP,
      kind: 'free-trial', models: ['sync-3'], maxGenerations: 1, maxUsdPerJob: 0, maxUsdTotal: 0,
      maxJobSeconds: 8, plan: 'free', paymentMethod: 'none', sync3Remaining: 1, accountOrg: 'org-bound',
      inputSha256Allowlist: [sha('d01-video'), sha('d01-audio')],
    });
    expect(artifact.approvalId).toMatch(/^ft-[0-9a-f]{8}$/);
    expect(target.endsWith(`${artifact.approvalId}.json`)).toBe(true); // filename = approvalId, as the loader requires
    expect(artifact.consumedAt).toBeUndefined();
    expect(Number.isFinite(Date.parse(artifact.capturedAt))).toBe(true);
    expect(Math.abs(Date.parse(artifact.capturedAt) - Date.now())).toBeLessThan(60_000);
    expect(Date.parse(artifact.expiresAt)).toBeGreaterThan(Date.now());
    expect(artifact.evidenceHashes).toEqual({ 'billing.png': sha('fake billing screenshot bytes'), 'projects.png': sha('fake projects screenshot bytes') });
    // The org binding came through the sealed key's own project list, not an argument.
    expect(calls.some(c => c.op === 'call' && c.kind === 'sync_projects')).toBe(true);
    const log = JSON.parse(readFileSync(join(home, 'private', 'sync', 'attest-log.jsonl'), 'utf8').trim().split('\n').at(-1)!);
    expect(log).toMatchObject({ event: 'attest', approvalId: artifact.approvalId, accountOrg: 'org-bound', by: 'deviceOwnerAuthentication' });
  });

  test('an unanswered or refused attestation writes nothing', async () => {
    const before = existsSync(join(home, 'private', 'sync', 'approvals'))
      ? readdirSync(join(home, 'private', 'sync', 'approvals')) : [];
    expect((await run(baseArgs(), 'yes\nno\n')).exitCode).toBe(1);
    expect((await run(baseArgs(), 'no\nyes\n')).exitCode).toBe(1);
    const after = existsSync(join(home, 'private', 'sync', 'approvals'))
      ? readdirSync(join(home, 'private', 'sync', 'approvals')) : [];
    expect(after.length).toBe(before.length);
  });

  test('argument and evidence validation fail before any vault call', async () => {
    calls = [];
    expect((await run(['--project', 'x'] as string[])).exitCode).toBe(1);
    const badSha = baseArgs().map(a => a === sha('d01-video') ? 'zz' : a);
    expect((await run(badSha)).exitCode).toBe(1);
    const sameSha = baseArgs().map(a => a === sha('d01-audio') ? sha('d01-video') : a);
    expect((await run(sameSha)).exitCode).toBe(1);
    // Single evidence file is not enough for the billing+projects checklist.
    const oneShot = baseArgs().slice(0, baseArgs().indexOf('--evidence') + 2);
    expect((await run(oneShot)).exitCode).toBe(1);
    expect(calls).toEqual([]);
  });
});
