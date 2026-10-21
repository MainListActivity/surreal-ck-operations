import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// sck-sync-attest end to end: a fake vault socket answers status only — the org binding now
// comes from the sync_project_prepare ledger fixture (private/sync/prepare/prepare-<keyFp>.json),
// and attest never probes /v2/projects by itself. The test binary then writes the single-use
// free-trial artifact it would land for the owner. Every evidence file must carry its
// owner-declared real capture instant; the artifact's capturedAt is the earliest of them while
// issuedAt stays the landing moment. Nothing here touches the real vault, keychain or upstream —
// fixtures only.

const ROOT = join(import.meta.dir, '..');
const BIN = join(ROOT, 'vault', 'build', 'sck-sync-attest-test');
const KEY_FP = 'fptest1234abcd56';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();

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
  // No call kinds are answered: since the prepare-ledger alignment, attest must not send any
  // upstream probe through the vault. An unexpected call surfaces as an unknown-op failure.
  return { ok: false, code: 'invalid', message: 'unknown op' };
};

/** (Re)writes the prepare ledger the attest binary reads; defaults to a ready record. */
const writePrepareLedger = (over: Record<string, unknown> = {}) => {
  mkdirSync(join(home, 'private', 'sync', 'prepare'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'private', 'sync', 'prepare', `prepare-${KEY_FP}.json`), JSON.stringify({
    schema: 'sync-prepare/1', accountRef: KEY_FP,
    clientUuid: '0e1c2a6e-1111-4222-8333-444455556666', state: 'ready',
    organizationId: 'org-bound', projectId: 'p-1', projectName: 'sck-controlled',
    reused: false, at: iso(Date.now() - 3_600_000), readbackAt: iso(Date.now() - 3_600_000),
    projectsSeen: 1, history: [],
    ...over,
  }), { mode: 0o600 });
};

// The mock vault lives in this process, so the attest binary must be spawned async:
// a synchronous spawn would deadlock the event loop the server answers on. `fixedNowMs`
// engages the test-build-only clock seam (SCK_ATTEST_TEST_NOW); the production binary has no
// such switch, and it is what makes ±1s boundary assertions deterministic instead of flaky.
const run = async (args: string[], stdin = 'yes\nyes\nyes\n', fixedNowMs?: number) => {
  const proc = Bun.spawn([BIN, ...args], {
    env: {
      ...process.env, SCK_VAULT_TEST_SOCKET: socket, SCK_ATTEST_TEST_HOME: home, SCK_VAULT_TEST_AUTO_APPROVE: '1',
      ...(fixedNowMs !== undefined ? { SCK_ATTEST_TEST_NOW: String(fixedNowMs) } : {}),
    },
    stdin: Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
};

const T1 = () => iso(Date.now() - 30 * 60_000);   // 30min ago — fresh
const T2 = () => iso(Date.now() - 10 * 60_000);   // 10min ago — fresh
const STALE = () => iso(Date.now() - 3 * 3_600_000); // 3h ago — outside the 2h JIT window
const FUTURE = () => iso(Date.now() + 60 * 60_000);  // 1h ahead — refused

const baseArgs = (t1 = T1(), t2 = T2(), extra: string[] = []) => [
  '--project', 'maplayer-content', '--task', '02186d39-94fa-4582-be50-7a66278b7fad',
  '--video-sha256', sha('d01-video'), '--audio-sha256', sha('d01-audio'), '--remaining', '1',
  '--evidence', join(dir, 'billing.png'), t1, '--evidence', join(dir, 'projects.png'), t2, ...extra,
];

const artifactFiles = () =>
  existsSync(join(home, 'private', 'sync', 'approvals'))
    ? readdirSync(join(home, 'private', 'sync', 'approvals')).filter(f => f.endsWith('.json')) : [];

const swiftAvailable = Bun.which('swiftc') !== null;

describe.skipIf(!swiftAvailable)('sck-sync-attest', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sck-attest-'));
    home = join(dir, 'home');
    socket = join(dir, 'vault.sock');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, 'billing.png'), 'fake billing screenshot bytes');
    writeFileSync(join(dir, 'projects.png'), 'fake projects screenshot bytes');
    writePrepareLedger();
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
    // The hook compiles two Swift binaries with `swiftc -O` before it can listen. Measured on the review machine: about 3 s with a
    // warm cache, and well over the default 5 s hook timeout on a loaded or cold one, so the hook gets its own generous budget.
  }, 120_000);

  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  test('a confirmed attestation binds each evidence file to its declared capture instant', async () => {
    calls = [];
    const t1 = T1(), t2 = T2(); // t1 < t2
    const result = await run(baseArgs(t1, t2));
    expect(result.exitCode).toBe(0);
    const target = [...result.stdout.split('\n')].reverse().find(line => line.trim().endsWith('.json'))!.trim();
    expect(existsSync(target)).toBe(true);
    const artifact = JSON.parse(readFileSync(target, 'utf8'));
    expect(artifact).toMatchObject({
      schema: 'sync-spend-approval/1', issuer: 'owner', project: 'maplayer-content',
      taskId: '02186d39-94fa-4582-be50-7a66278b7fad', accountRef: KEY_FP,
      kind: 'free-trial', models: ['sync-3'], maxGenerations: 1, maxUsdPerJob: 0, maxUsdTotal: 0,
      maxJobSeconds: 8, plan: 'free', paymentMethod: 'none', sync3Remaining: 1, accountOrg: 'org-bound',
      preparedProject: 'p-1',
      inputSha256Allowlist: [sha('d01-video'), sha('d01-audio')],
    });
    expect(artifact.approvalId).toMatch(/^ft-[0-9a-f]{8}$/);
    expect(target.endsWith(`${artifact.approvalId}.json`)).toBe(true); // filename = approvalId, as the loader requires
    expect(artifact.consumedAt).toBeUndefined();
    // R1: capturedAt is the earliest DECLARED evidence instant, independent of issuedAt.
    expect(artifact.capturedAt).toBe(t1.slice(0, 19) + 'Z'); // ISO8601DateFormatter drops millis
    expect(artifact.evidenceCapturedAt).toEqual({
      'billing.png': artifact.capturedAt,
      'projects.png': t2.slice(0, 19) + 'Z',
    });
    expect(artifact.evidenceHashes).toEqual({ 'billing.png': sha('fake billing screenshot bytes'), 'projects.png': sha('fake projects screenshot bytes') });
    expect(Date.parse(artifact.issuedAt)).toBeGreaterThan(Date.parse(artifact.capturedAt));
    expect(Math.abs(Date.parse(artifact.issuedAt) - Date.now())).toBeLessThan(60_000);
    expect(Date.parse(artifact.expiresAt)).toBeGreaterThan(Date.now());
    // The org binding comes from the prepare ledger: attest never probes upstream itself.
    expect(calls.every(c => c.op === 'status')).toBe(true);
    const log = JSON.parse(readFileSync(join(home, 'private', 'sync', 'attest-log.jsonl'), 'utf8').trim().split('\n').at(-1)!);
    expect(log).toMatchObject({ event: 'attest', approvalId: artifact.approvalId, accountOrg: 'org-bound', preparedProject: 'p-1', capturedAt: artifact.capturedAt, by: 'deviceOwnerAuthentication' });
  });

  test('evidence order never changes the earliest-instant rule', async () => {
    const t1 = T1(), t2 = T2(); // t1 (30min) earlier than t2 (10min)
    const reversed = await run(baseArgs(t2, t1)); // billing.png=t2, projects.png=t1
    expect(reversed.exitCode).toBe(0);
    const target = [...reversed.stdout.split('\n')].reverse().find(line => line.trim().endsWith('.json'))!.trim();
    const artifact = JSON.parse(readFileSync(target, 'utf8'));
    expect(artifact.capturedAt).toBe(t1.slice(0, 19) + 'Z'); // earliest wins regardless of flag order
    expect(artifact.evidenceCapturedAt['projects.png']).toBe(artifact.capturedAt);
  });

  test('the 2h boundary is exact under a fixed clock: inside lands, past it refuses', async () => {
    const fixedNow = Date.parse('2026-10-15T12:00:00.000Z');
    // exactly 2h ago lands; 1s beyond refuses — no tolerance slack anywhere.
    const inside = await run(baseArgs(iso(fixedNow - 2 * 3_600_000), iso(fixedNow - 60_000)), 'yes\nyes\nyes\n', fixedNow);
    expect(inside.exitCode).toBe(0);
    const target = [...inside.stdout.split('\n')].reverse().find(line => line.trim().endsWith('.json'))!.trim();
    const artifact = JSON.parse(readFileSync(target, 'utf8'));
    expect(artifact.capturedAt).toBe('2026-10-15T10:00:00Z');
    expect((await run(baseArgs(iso(fixedNow - 2 * 3_600_000 - 1_000), iso(fixedNow - 60_000)), 'yes\nyes\nyes\n', fixedNow)).exitCode).toBe(1);
  });

  test('any future capture instant refuses before vault calls or artifacts — zero tolerance', async () => {
    const fixedNow = Date.parse('2026-10-15T12:00:00.000Z');
    const past = iso(fixedNow - 30 * 60_000);
    calls = [];
    const before = artifactFiles().length;
    // +1/+30/+59/+61s into the future, each paired with a legitimately fresh file.
    for (const ahead of [1_000, 30_000, 59_000, 61_000]) {
      const res = await run(baseArgs(past, iso(fixedNow + ahead)), 'yes\nyes\nyes\n', fixedNow);
      expect([ahead / 1000, res.exitCode]).toEqual([ahead / 1000, 1]);
    }
    // Sub-second future must refuse too — truncation may not launder it into "now".
    const sub = await run(baseArgs(past, '2026-10-15T12:00:00.500Z'), 'yes\nyes\nyes\n', fixedNow);
    expect(sub.exitCode).toBe(1);
    // An instant exactly at the reference now is not future — it lands.
    expect((await run(baseArgs('2026-10-15T12:00:00.000Z', past), 'yes\nyes\nyes\n', fixedNow)).exitCode).toBe(0);
    expect(artifactFiles().length).toBe(before + 1); // only the exact-now run landed
    expect(calls.some(c => c.op === 'call')).toBe(false); // refusals never probed; the landing run needs no probe either
  });

  test('stale, mixed, future, missing or malformed capture times all refuse without an artifact', async () => {
    calls = [];
    const before = artifactFiles().length;
    // Single stale evidence
    expect((await run(baseArgs(STALE(), T2()))).exitCode).toBe(1);
    // Mixed: one fresh + one stale — the window belongs to the oldest, so refuse.
    expect((await run(baseArgs(T1(), STALE()))).exitCode).toBe(1);
    // Future capture instant
    expect((await run(baseArgs(FUTURE(), T2()))).exitCode).toBe(1);
    // Unparseable instant
    expect((await run(baseArgs('昨天中午', T2()))).exitCode).toBe(1);
    // Missing timezone is ambiguous — refuse.
    expect((await run(baseArgs('2026-10-15T10:30:00', T2()))).exitCode).toBe(1);
    // Missing the time argument entirely: the next flag is consumed as the time and fails.
    const missing = baseArgs().slice(0, baseArgs().indexOf('--evidence') + 2);
    expect((await run(missing)).exitCode).toBe(1);
    // Just past the 2h JIT boundary refuses; exactly at the boundary still lands.
    expect((await run(baseArgs(iso(Date.now() - 2 * 3_600_000 - 60_000), T2()))).exitCode).toBe(1);
    expect(artifactFiles().length).toBe(before);
    // None of the refusals ever reached the vault.
    expect(calls.filter(c => c.op === 'call')).toEqual([]);
  });

  test('an unanswered or refused attestation writes nothing', async () => {
    const before = artifactFiles();
    expect((await run(baseArgs(), 'yes\nyes\nno\n')).exitCode).toBe(1);
    expect((await run(baseArgs(), 'no\nyes\nyes\n')).exitCode).toBe(1);
    // Refusing the capture-time attestation specifically lands nothing either.
    expect((await run(baseArgs(), 'yes\nyes\nno\n')).exitCode).toBe(1);
    expect(artifactFiles().length).toBe(before.length);
  });

  test('argument and evidence validation fail before any vault call', async () => {
    calls = [];
    expect((await run(['--project', 'x'] as string[])).exitCode).toBe(1);
    const badSha = baseArgs().map(a => a === sha('d01-video') ? 'zz' : a);
    expect((await run(badSha)).exitCode).toBe(1);
    const sameSha = baseArgs().map(a => a === sha('d01-audio') ? sha('d01-video') : a);
    expect((await run(sameSha)).exitCode).toBe(1);
    // A single evidence file is not enough for the billing+projects checklist.
    const oneShot = baseArgs().slice(0, baseArgs().indexOf('--evidence') + 3);
    expect((await run(oneShot)).exitCode).toBe(1);
    expect(calls).toEqual([]);
  });

  test('attest refuses without a ready prepare ledger: missing, failed, foreign-key or incomplete', async () => {
    const ledgerPath = join(home, 'private', 'sync', 'prepare', `prepare-${KEY_FP}.json`);
    const before = artifactFiles().length;
    // Missing ledger entirely: project preparation never ran for this key.
    rmSync(ledgerPath);
    expect((await run(baseArgs())).exitCode).toBe(1);
    expect((await run(baseArgs())).stderr).toContain('sync_project_prepare');
    // A failed prepare (empty org / multi-org / refused create) is never a ready record.
    writePrepareLedger({ state: 'failed', lastError: 'multi_org count=2' });
    expect((await run(baseArgs())).exitCode).toBe(1);
    expect((await run(baseArgs())).stderr).toContain('未就绪');
    // The ledger binds THIS key; a record minted under another fingerprint is a binding mismatch.
    writePrepareLedger({ accountRef: 'fedcba0987654321' });
    expect((await run(baseArgs())).exitCode).toBe(1);
    expect((await run(baseArgs())).stderr).toContain('绑定不符');
    // An incomplete record (no organizationId/projectId) cannot establish the binding either.
    writePrepareLedger({ organizationId: '', projectId: '' });
    expect((await run(baseArgs())).exitCode).toBe(1);
    expect((await run(baseArgs())).stderr).toContain('回读记录不完整');
    // Restored ready record: landing works again, all negatives above left no artifact.
    writePrepareLedger();
    expect((await run(baseArgs())).exitCode).toBe(0);
    expect(artifactFiles().length).toBe(before + 1);
  });
});
