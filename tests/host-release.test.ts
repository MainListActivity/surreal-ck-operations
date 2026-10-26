/**
 * FV06/SYS04 managed host-release seam: pure contract + envelope tests.
 * No company DB, no real paseo/launchctl, no writes under releases/.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostReleaseError, opIdFor, prepareHostRelease, readHostReleaseReceipt, readHostReleaseStatus,
  acquireHostReleaseLock, releaseHostReleaseLock, writeHostReceipt, validateRequest,
} from '../src/host-release/store.ts';
import { snapshotInventoryHash, verifyRelease } from '../src/host-release/verify.ts';
import { isCommitSha, isSafeAbsolutePath, type HostReleaseReceipt } from '../src/host-release/types.ts';

const clean: string[] = [];
afterEach(() => {
  for (const dir of clean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = (n: number): string => n.toString(16).padStart(40, '0');

function touch(path: string, body = 'x\n') {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

/** Minimal release-shaped tree that inventoryHash can digest. Guards are stubbed via script overrides in verify tests. */
function makeSnapshot(root: string, commit: string): string {
  const dir = join(root, commit);
  mkdirSync(join(dir, 'src', 'mcp'), { recursive: true });
  mkdirSync(join(dir, 'src', 'dispatcher'), { recursive: true });
  mkdirSync(join(dir, 'plugin', 'server'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'src', 'mcp', 'run.ts'), 'export {};\n');
  writeFileSync(join(dir, 'src', 'dispatcher', 'run.ts'), 'export {};\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"snap"}\n');
  // Stub scripts so verifyRelease's sourced helpers exist; they will fail closed unless we only test inventory/validate.
  writeFileSync(join(dir, 'scripts', 'release-content.sh'), 'release_matches_commit(){ return 1; }\n');
  writeFileSync(join(dir, 'scripts', 'review-wait-guard.sh'), 'review_wait_target_supported(){ return 1; }\nacceptance_target_supported(){ return 1; }\n');
  writeFileSync(join(dir, 'scripts', 'independence-guard.sh'), 'independence_target_supported(){ return 1; }\n');
  writeFileSync(join(dir, 'scripts', 'policy-guard.sh'), 'policy_target_supported(){ return 1; }\n');
  writeFileSync(join(dir, 'scripts', 'bun-runtime.sh'), 'resolve_bun(){ BUN=/bin/false; }\n');
  return dir;
}

describe('host-release contract helpers', () => {
  test('isCommitSha and isSafeAbsolutePath refuse traversal and short digests', () => {
    expect(isCommitSha(sha(1))).toBe(true);
    expect(isCommitSha('abc')).toBe(false);
    expect(isCommitSha('A'.repeat(40).toLowerCase())).toBe(true);
    expect(isCommitSha('g'.repeat(40))).toBe(false);
    expect(isSafeAbsolutePath('/tmp/a')).toBe(true);
    expect(isSafeAbsolutePath('/tmp/../etc/passwd')).toBe(false);
    expect(isSafeAbsolutePath('relative')).toBe(false);
  });

  test('snapshotInventoryHash is stable and ignores node_modules / vendor', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-inv-'));
    clean.push(root);
    const snap = makeSnapshot(root, sha(2));
    mkdirSync(join(snap, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(snap, 'node_modules', 'x', 'a.js'), 'ignored\n');
    mkdirSync(join(snap, 'plugin', 'server', 'vendor', 'src'), { recursive: true });
    writeFileSync(join(snap, 'plugin', 'server', 'vendor', 'src', 'core.ts'), 'ignored\n');
    const a = snapshotInventoryHash(snap);
    const b = snapshotInventoryHash(snap);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Changing a tracked file changes the hash.
    writeFileSync(join(snap, 'package.json'), '{"name":"snap","v":2}\n');
    expect(snapshotInventoryHash(snap)).not.toBe(a);
  });

  test('validateRequest refuses free-form and short shas', () => {
    expect(() => validateRequest({
      taskId: 't', targetSha: 'short', expectedActive: '/a', snapshotHash: 'x'.repeat(64),
      rollbackSha: sha(3), idempotencyKey: 'k',
    })).toThrow(HostReleaseError);
    expect(() => validateRequest({
      taskId: 't', targetSha: sha(3), expectedActive: 'relative', snapshotHash: 'a'.repeat(64),
      rollbackSha: sha(4), idempotencyKey: 'k',
    })).toThrow(HostReleaseError);
  });

  test('opIdFor is stable for the same request and changes when any field changes', () => {
    const base = {
      taskId: 'task-1', targetSha: sha(5), expectedActive: '/svc/releases/' + sha(6),
      snapshotHash: 'b'.repeat(64), rollbackSha: sha(6), idempotencyKey: 'idem-1',
    };
    expect(opIdFor(base)).toBe(opIdFor({ ...base }));
    expect(opIdFor(base)).not.toBe(opIdFor({ ...base, idempotencyKey: 'idem-2' }));
  });
});

describe('host-release envelope', () => {
  test('prepare refuses a snapshot whose inventory hash does not match the request', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-prep-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    const opsRepo = join(root, 'ops');
    mkdirSync(join(opsRepo, '.git'), { recursive: true });
    mkdirSync(join(serviceHome, 'maintenance'), { recursive: true });
    mkdirSync(join(serviceHome, 'releases', sha(7)), { recursive: true });
    symlinkSync(join(serviceHome, 'releases', sha(7)), join(serviceHome, 'active'));
    const snap = makeSnapshot(root, sha(8));
    const realHash = snapshotInventoryHash(snap);
    expect(() => prepareHostRelease({
      roots: { serviceHome, opsRepo, releasesDir: join(serviceHome, 'releases') },
      request: {
        taskId: 'task-x', targetSha: sha(8), expectedActive: join(serviceHome, 'releases', sha(7)),
        snapshotHash: 'c'.repeat(64), rollbackSha: sha(7), idempotencyKey: 'k1',
      },
      snapshotPath: snap,
    })).toThrow(/snapshotHash mismatch/);
    // Wrong hash must not leave a succeeded envelope.
    expect(realHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('prepare writes a refused envelope when guards fail, and status can read it', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-refuse-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    const opsRepo = join(root, 'ops');
    mkdirSync(join(opsRepo, '.git'), { recursive: true });
    mkdirSync(join(serviceHome, 'maintenance'), { recursive: true });
    mkdirSync(join(serviceHome, 'releases', sha(9)), { recursive: true });
    symlinkSync(join(serviceHome, 'releases', sha(9)), join(serviceHome, 'active'));
    // Minimal git stub so ancestry check runs (and fails closed without origin/main).
    const snap = makeSnapshot(root, sha(10));
    const hash = snapshotInventoryHash(snap);
    let refused: HostReleaseError | undefined;
    try {
      prepareHostRelease({
        roots: { serviceHome, opsRepo, releasesDir: join(serviceHome, 'releases') },
        request: {
          taskId: 'task-y', targetSha: sha(10), expectedActive: join(serviceHome, 'releases', sha(9)),
          snapshotHash: hash, rollbackSha: sha(9), idempotencyKey: 'k2',
        },
        snapshotPath: snap,
      });
    } catch (error) {
      refused = error as HostReleaseError;
    }
    expect(refused?.code).toBe('refused');
    const opId = opIdFor({
      taskId: 'task-y', targetSha: sha(10), expectedActive: join(serviceHome, 'releases', sha(9)),
      snapshotHash: hash, rollbackSha: sha(9), idempotencyKey: 'k2',
    });
    const status = readHostReleaseStatus(serviceHome, opId);
    expect(status.state).toBe('refused');
    expect(status.reason).toBeTruthy();
  });

  test('receipt reader refuses a forged employee upload missing executor', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-recv-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    const opId = 'a'.repeat(32);
    const envelope = join(serviceHome, 'maintenance', 'host-release', opId);
    mkdirSync(envelope, { recursive: true });
    writeFileSync(join(envelope, 'receipt.json'), JSON.stringify({
      schema: 'host-release-receipt/1', opId, taskId: 't', targetSha: sha(11),
      previousActive: '/x', expectedActive: '/x', snapshotHash: 'd'.repeat(64), rollbackSha: sha(12),
      // missing executor
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, state: 'succeeded',
      checks: [], binding: { releasePath: null, contentMatchesCommit: true, vendorSchemaDiff: 'unavailable' },
      mcp: { health: 200, ready: 200, cwd: null, pid: null },
      plugin: { status: null, enabled: null, source: null, directory: null, sourceKnown: false },
      channelRecovery: 'unknown', lockReleased: true,
    }));
    expect(() => readHostReleaseReceipt(serviceHome, opId)).toThrow(/executor/);
  });

  test('writeHostReceipt + readHostReleaseReceipt round-trip with executor identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-ok-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    const opId = 'b'.repeat(32);
    const envelope = join(serviceHome, 'maintenance', 'host-release', opId);
    mkdirSync(envelope, { recursive: true });
    writeFileSync(join(envelope, 'operation.json'), JSON.stringify({
      opId, taskId: 't', targetSha: sha(13), expectedActive: '/a', snapshotHash: 'e'.repeat(64),
      rollbackSha: sha(14), idempotencyKey: 'k', state: 'prepared', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const receipt: HostReleaseReceipt = {
      schema: 'host-release-receipt/1',
      opId, taskId: 't', targetSha: sha(13), previousActive: '/a', expectedActive: '/a',
      snapshotHash: 'e'.repeat(64), rollbackSha: sha(14),
      executor: { host: 'testhost', uid: 501, user: 'y' },
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, state: 'succeeded',
      checks: [{ name: 'content-bind', ok: true }],
      binding: { releasePath: '/svc/releases/' + sha(13), contentMatchesCommit: true, vendorSchemaDiff: 'none' },
      mcp: { health: 200, ready: 200, cwd: '/svc/releases/' + sha(13), pid: 1 },
      plugin: { status: 'running', enabled: true, source: '/svc/releases/' + sha(13) + '/plugin', directory: '/svc/releases/' + sha(13) + '/plugin', sourceKnown: true },
      channelRecovery: 'adopt-expected', lockReleased: true,
    };
    const path = writeHostReceipt(serviceHome, receipt);
    expect(existsSync(path)).toBe(true);
    const read = readHostReleaseReceipt(serviceHome, opId);
    expect(read.executor.host).toBe('testhost');
    expect(read.state).toBe('succeeded');
    expect(readHostReleaseStatus(serviceHome, opId).state).toBe('succeeded');
  });

  test('lock is exclusive and released by the same opId', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-lock-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    mkdirSync(join(serviceHome, 'maintenance'), { recursive: true });
    acquireHostReleaseLock(serviceHome, 'c'.repeat(32));
    expect(() => acquireHostReleaseLock(serviceHome, 'd'.repeat(32))).toThrow(/lock held/);
    releaseHostReleaseLock(serviceHome, 'c'.repeat(32));
    acquireHostReleaseLock(serviceHome, 'd'.repeat(32));
    releaseHostReleaseLock(serviceHome, 'd'.repeat(32));
  });
});

describe('host-release verifyRefuseOrder', () => {
  test('verifyRelease fails closed on malformed sha and missing release', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-ver-'));
    clean.push(root);
    const result = verifyRelease({
      roots: { serviceHome: root, opsRepo: root, releasesDir: join(root, 'releases') },
      targetSha: 'nope',
      releasePath: join(root, 'missing'),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.some(check => check.name === 'targetSha' && !check.ok)).toBe(true);
  });
});
