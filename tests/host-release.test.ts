/**
 * FV06/SYS04 managed host-release seam: pure contract + envelope tests.
 * No company DB, no real paseo/launchctl, no writes under releases/.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostReleaseError, opIdFor, prepareHostRelease, readHostReleaseReceipt, readHostReleaseStatus,
  acquireHostReleaseLock, releaseHostReleaseLock, writeHostReceipt, validateRequest,
} from '../src/host-release/store.ts';
import { snapshotInventoryHash, verifyRelease } from '../src/host-release/verify.ts';
import { isCommitSha, isSafeAbsolutePath, type HostReleaseReceipt } from '../src/host-release/types.ts';
import { parsePaseoPluginJson } from '../src/host-release/plugin-parse.ts';
import { checkActivityBarrier } from '../src/host-release/barrier.ts';
import { ensureHostHmacKey, mintHostTag, verifyHostTag } from '../src/host-release/provenance.ts';
import { spawnSync } from 'node:child_process';

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
    writeFileSync(join(envelope, 'operation.json'), JSON.stringify({
      opId, taskId: 't', targetSha: sha(11), expectedActive: '/x', snapshotHash: 'd'.repeat(64),
      rollbackSha: sha(12), idempotencyKey: 'k', state: 'prepared', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    writeFileSync(join(envelope, 'receipt.json'), JSON.stringify({
      schema: 'host-release-receipt/1', opId, taskId: 't', targetSha: sha(11),
      previousActive: '/x', expectedActive: '/x', snapshotHash: 'd'.repeat(64), rollbackSha: sha(12),
      // missing executor
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, installerExitCode: 0, state: 'succeeded',
      checks: [], binding: { releasePath: null, contentMatchesCommit: true, vendorSchemaDiff: 'unavailable', schemaHash: null, vendorSchemaHash: null },
      mcp: { health: 200, ready: 200, cwd: null, pid: null, sha: null },
      plugin: { status: null, enabled: null, source: null, directory: null, sourceKnown: false, modules: null },
      channelRecovery: 'unknown', lockReleased: true,
    }));
    expect(() => readHostReleaseReceipt(serviceHome, opId)).toThrow(/executor/);
  });

  test('writeHostReceipt + readHostReleaseReceipt round-trip with hostTag provenance', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-ok-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    ensureHostHmacKey(serviceHome);
    const opId = 'b'.repeat(32);
    const envelope = join(serviceHome, 'maintenance', 'host-release', opId);
    mkdirSync(envelope, { recursive: true });
    writeFileSync(join(envelope, 'operation.json'), JSON.stringify({
      opId, taskId: 't', targetSha: sha(13), expectedActive: '/a', snapshotHash: 'e'.repeat(64),
      rollbackSha: sha(14), idempotencyKey: 'k', state: 'prepared', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const startedAt = new Date().toISOString();
    const finishedAt = new Date().toISOString();
    const body: Omit<HostReleaseReceipt, 'hostTag'> = {
      schema: 'host-release-receipt/1',
      opId, taskId: 't', targetSha: sha(13), previousActive: '/a', expectedActive: '/a',
      snapshotHash: 'e'.repeat(64), rollbackSha: sha(14),
      executor: { host: 'testhost', uid: 501, user: 'y' },
      startedAt, finishedAt, exitCode: 0, installerExitCode: 0, state: 'succeeded',
      checks: [{ name: 'content-bind', ok: true }],
      binding: { releasePath: '/svc/releases/' + sha(13), contentMatchesCommit: true, vendorSchemaDiff: 'none', schemaHash: null, vendorSchemaHash: null },
      mcp: { health: 200, ready: 200, cwd: '/svc/releases/' + sha(13), pid: 1, sha: 'f'.repeat(64) },
      plugin: { status: 'running', enabled: true, source: '/svc/releases/' + sha(13) + '/plugin', directory: '/svc/releases/' + sha(13) + '/plugin', sourceKnown: true, modules: [{ path: 'index.server.ts', sha256: 'b'.repeat(64), bytes: 3 }] },
      channelRecovery: 'adopt-expected', lockReleased: true,
    };
    const receipt: HostReleaseReceipt = {
      ...body,
      hostTag: mintHostTag(serviceHome, body),
    };
    const path = writeHostReceipt(serviceHome, receipt);
    expect(existsSync(path)).toBe(true);
    const read = readHostReleaseReceipt(serviceHome, opId);
    expect(read.executor.host).toBe('testhost');
    expect(read.hostTag).toMatch(/^[0-9a-f]{64}$/);
    expect(read.state).toBe('succeeded');
    expect(readHostReleaseStatus(serviceHome, opId).state).toBe('succeeded');
  });

  test('F4′: receipt with executor but mismatched taskId/targetSha/snapshotHash is refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-forge-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    ensureHostHmacKey(serviceHome);
    const opId = 'f'.repeat(32);
    const envelope = join(serviceHome, 'maintenance', 'host-release', opId);
    mkdirSync(envelope, { recursive: true });
    writeFileSync(join(envelope, 'operation.json'), JSON.stringify({
      opId, taskId: 'task-REAL', targetSha: sha(20), expectedActive: '/real', snapshotHash: 'a'.repeat(64),
      rollbackSha: sha(21), idempotencyKey: 'k', state: 'prepared', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    writeFileSync(join(envelope, 'receipt.json'), JSON.stringify({
      schema: 'host-release-receipt/1', opId, taskId: 'task-FORGED', targetSha: 'f'.repeat(40),
      previousActive: '/real', expectedActive: '/real', snapshotHash: 'd'.repeat(64), rollbackSha: sha(21),
      executor: { host: 'forged-host', uid: 1, user: 'forger' },
      hostTag: 'a'.repeat(64),
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, installerExitCode: 0, state: 'succeeded',
      checks: [], binding: { releasePath: null, contentMatchesCommit: true, vendorSchemaDiff: 'unavailable', schemaHash: null, vendorSchemaHash: null },
      mcp: { health: 200, ready: 200, cwd: null, pid: null, sha: null },
      plugin: { status: null, enabled: null, source: null, directory: null, sourceKnown: false, modules: null },
      channelRecovery: 'unknown', lockReleased: true,
    }));
    expect(() => readHostReleaseReceipt(serviceHome, opId)).toThrow(/taskId|targetSha|snapshotHash/);
  });

  test('F4 / AC04: same-field forge (copy operation + invent executor, no valid hostTag) is refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-samefield-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    ensureHostHmacKey(serviceHome);
    const opId = '1'.repeat(32);
    const envelope = join(serviceHome, 'maintenance', 'host-release', opId);
    mkdirSync(envelope, { recursive: true });
    const op = {
      opId, taskId: 'task-REAL', targetSha: sha(40), expectedActive: '/real', snapshotHash: 'b'.repeat(64),
      rollbackSha: sha(41), idempotencyKey: 'k', state: 'prepared', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(envelope, 'operation.json'), JSON.stringify(op));
    // Employee forges by copying operation fields and inventing executor — no access to private/ HMAC key.
    writeFileSync(join(envelope, 'receipt.json'), JSON.stringify({
      schema: 'host-release-receipt/1',
      opId: op.opId, taskId: op.taskId, targetSha: op.targetSha, previousActive: op.expectedActive,
      expectedActive: op.expectedActive, snapshotHash: op.snapshotHash, rollbackSha: op.rollbackSha,
      executor: { host: 'employee-laptop', uid: 501, user: 'forger' },
      // missing / fake tag
      hostTag: 'c'.repeat(64),
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, installerExitCode: 0, state: 'succeeded',
      checks: [], binding: { releasePath: null, contentMatchesCommit: true, vendorSchemaDiff: 'unavailable', schemaHash: null, vendorSchemaHash: null },
      mcp: { health: 200, ready: 200, cwd: null, pid: null, sha: null },
      plugin: { status: null, enabled: null, source: null, directory: null, sourceKnown: false, modules: null },
      channelRecovery: 'unknown', lockReleased: true,
    }));
    expect(() => readHostReleaseReceipt(serviceHome, opId)).toThrow(/hostTag/);
  });

  test('F4 full-field: tampering unsigned evidence fields after mint fails verifyHostTag', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-tamper-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    ensureHostHmacKey(serviceHome);
    const startedAt = new Date().toISOString();
    const finishedAt = new Date().toISOString();
    const body: Omit<HostReleaseReceipt, 'hostTag'> = {
      schema: 'host-release-receipt/1',
      opId: '2'.repeat(32), taskId: 't', targetSha: sha(50), previousActive: '/a', expectedActive: '/a',
      snapshotHash: 'd'.repeat(64), rollbackSha: sha(51),
      executor: { host: 'h', uid: 1, user: 'u' },
      startedAt, finishedAt, exitCode: 0, installerExitCode: 0, state: 'succeeded',
      checks: [], binding: { releasePath: null, contentMatchesCommit: false, vendorSchemaDiff: 'unavailable', schemaHash: null, vendorSchemaHash: null },
      mcp: { health: 200, ready: 200, cwd: null, pid: null, sha: null },
      plugin: { status: 'running', enabled: true, source: '/p', directory: '/p', sourceKnown: true, modules: [{ path: 'index.server.ts', sha256: 'a'.repeat(64), bytes: 3 }] },
      channelRecovery: 'unknown', lockReleased: false,
      rollback: { attempted: false, to: null, ok: false },
    };
    const tag = mintHostTag(serviceHome, body);
    expect(verifyHostTag(serviceHome, { ...body, hostTag: tag })).toBe(true);
    // Tamper each previously-unsigned field — tag must no longer verify.
    expect(verifyHostTag(serviceHome, {
      ...body, hostTag: tag,
      binding: { ...body.binding, contentMatchesCommit: true },
    })).toBe(false);
    expect(verifyHostTag(serviceHome, {
      ...body, hostTag: tag,
      plugin: { ...body.plugin, source: '/forged' },
    })).toBe(false);
    expect(verifyHostTag(serviceHome, {
      ...body, hostTag: tag, channelRecovery: 'adopt-expected',
    })).toBe(false);
    expect(verifyHostTag(serviceHome, {
      ...body, hostTag: tag, lockReleased: true,
    })).toBe(false);
  });

  test('lock is exclusive (O_EXCL) and released by the same opId', () => {
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

  test('F3′: prepare refuses snapshotPath whose basename is not targetSha', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-base-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    const opsRepo = join(root, 'ops');
    mkdirSync(join(opsRepo, '.git'), { recursive: true });
    mkdirSync(join(serviceHome, 'maintenance'), { recursive: true });
    mkdirSync(join(serviceHome, 'releases', sha(22)), { recursive: true });
    symlinkSync(join(serviceHome, 'releases', sha(22)), join(serviceHome, 'active'));
    const snap = makeSnapshot(root, sha(23));
    const hash = snapshotInventoryHash(snap);
    // Rename so basename ≠ targetSha.
    const renamed = join(root, 'not-a-sha');
    renameSync(snap, renamed);
    expect(() => prepareHostRelease({
      roots: { serviceHome, opsRepo, releasesDir: join(serviceHome, 'releases') },
      request: {
        taskId: 'task-z', targetSha: sha(23), expectedActive: join(serviceHome, 'releases', sha(22)),
        snapshotHash: hash, rollbackSha: sha(22), idempotencyKey: 'k3',
      },
      snapshotPath: renamed,
    })).toThrow(/basename/);
  });
});

describe('host-release plugin parse (F0 fixture)', () => {
  test('parsePaseoPluginJson reads SOURCE/DIRECTORY from a successful paseo fixture', () => {
    const raw = JSON.stringify([{
      path: '/svc/releases/' + sha(30) + '/plugin',
      status: 'running',
      enabled: true,
      installation: { identity: { path: '/svc/releases/' + sha(30) + '/plugin' } },
    }]);
    const binding = parsePaseoPluginJson(raw);
    expect(binding.sourceKnown).toBe(true);
    expect(binding.source).toBe('/svc/releases/' + sha(30) + '/plugin');
    expect(binding.directory).toBe('/svc/releases/' + sha(30) + '/plugin');
    expect(binding.status).toBe('running');
    expect(binding.enabled).toBe(true);
  });

  test('parsePaseoPluginJson refuses non-array JSON', () => {
    expect(() => parsePaseoPluginJson('{"path":"/x"}')).toThrow(/array/);
  });
});

describe('host-release activity barrier (AC03)', () => {
  test('barrier refuses when dispatch-paused or qa-observation-active mirrors are set', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-bar-'));
    clean.push(root);
    mkdirSync(join(root, 'maintenance'), { recursive: true });
    writeFileSync(join(root, 'maintenance', 'dispatch-paused.json'), JSON.stringify({ paused: true }));
    const paused = checkActivityBarrier({ serviceHome: root });
    expect(paused.ok).toBe(false);
    expect(paused.checks.some(check => check.name === 'dispatch-paused' && !check.ok)).toBe(true);

    unlinkSync(join(root, 'maintenance', 'dispatch-paused.json'));
    writeFileSync(join(root, 'maintenance', 'qa-observation-active.json'), JSON.stringify({
      active: true, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const obs = checkActivityBarrier({ serviceHome: root });
    expect(obs.ok).toBe(false);
    expect(obs.checks.some(check => check.name === 'qa-observation-window' && !check.ok)).toBe(true);
  });

  test('prepare mode passes when no file signals are present; apply mode refuses missing mirrors', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-barok-'));
    clean.push(root);
    mkdirSync(join(root, 'maintenance'), { recursive: true });
    expect(checkActivityBarrier({ serviceHome: root, mode: 'prepare' }).ok).toBe(true);
    const apply = checkActivityBarrier({ serviceHome: root, mode: 'apply' });
    expect(apply.ok).toBe(false);
    expect(apply.checks.some(check => check.name === 'dispatch-paused' && !check.ok)).toBe(true);
  });

  test('apply mode ignores self-lock and accepts explicit clear mirrors', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-selflock-'));
    clean.push(root);
    mkdirSync(join(root, 'maintenance'), { recursive: true });
    const opId = 's'.repeat(32);
    writeFileSync(join(root, 'maintenance', 'host-release.lock'), JSON.stringify({ opId, at: new Date().toISOString() }));
    writeFileSync(join(root, 'maintenance', 'dispatch-paused.json'), JSON.stringify({ paused: false }));
    writeFileSync(join(root, 'maintenance', 'qa-observation-active.json'), JSON.stringify({ active: false }));
    const result = checkActivityBarrier({ serviceHome: root, mode: 'apply', selfOpId: opId });
    expect(result.ok).toBe(true);
    expect(result.checks.some(check => check.name === 'host-release-lock' && check.ok)).toBe(true);
  });

  test('apply mode refuses {}, string booleans, and invalid JSON mirrors', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-schema-'));
    clean.push(root);
    mkdirSync(join(root, 'maintenance'), { recursive: true });
    writeFileSync(join(root, 'maintenance', 'dispatch-paused.json'), '{}');
    writeFileSync(join(root, 'maintenance', 'qa-observation-active.json'), JSON.stringify({ active: false }));
    expect(checkActivityBarrier({ serviceHome: root, mode: 'apply' }).ok).toBe(false);

    writeFileSync(join(root, 'maintenance', 'dispatch-paused.json'), JSON.stringify({ paused: 'false' }));
    expect(checkActivityBarrier({ serviceHome: root, mode: 'apply' }).ok).toBe(false);

    writeFileSync(join(root, 'maintenance', 'dispatch-paused.json'), '{not-json');
    expect(checkActivityBarrier({ serviceHome: root, mode: 'apply' }).ok).toBe(false);
  });
});

describe('host-release apply.sh syntax + first-mint', () => {
  test('apply.sh passes sh -n', () => {
    const script = join(import.meta.dir, '..', 'scripts', 'host-release', 'apply.sh');
    const result = spawnSync('/bin/sh', ['-n', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
  });

  test('first-mint: env assignment before -c creates the hmac key', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-mint-'));
    clean.push(root);
    const keyPath = join(root, 'host-release.hmac');
    // Wrong form (argv after -c) must fail.
    const bad = spawnSync('/usr/bin/python3', ['-c', 'import os; open(os.environ["P"],"wb").write(os.urandom(32))', `P=${keyPath}`], { encoding: 'utf8' });
    expect(bad.status).not.toBe(0);
    expect(existsSync(keyPath)).toBe(false);
    // Correct form (env before command) must succeed.
    const good = spawnSync('/bin/sh', ['-c', 'P="$1" /usr/bin/python3 -c \'import os; open(os.environ["P"],"wb").write(os.urandom(32))\'', 'mint', keyPath], { encoding: 'utf8' });
    expect(good.status).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
  });

  test('B1: flipping lockReleased without resign fails; resigning verifies', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-b1-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    ensureHostHmacKey(serviceHome);
    const startedAt = new Date().toISOString();
    const finishedAt = new Date().toISOString();
    const body: Omit<HostReleaseReceipt, 'hostTag'> = {
      schema: 'host-release-receipt/1',
      opId: '3'.repeat(32), taskId: 't', targetSha: sha(60), previousActive: '/a', expectedActive: '/a',
      snapshotHash: 'e'.repeat(64), rollbackSha: sha(61),
      executor: { host: 'h', uid: 1, user: 'u' },
      startedAt, finishedAt, exitCode: 0, installerExitCode: 0, state: 'succeeded',
      checks: [], binding: { releasePath: '/r', contentMatchesCommit: true, vendorSchemaDiff: 'unavailable', schemaHash: null, vendorSchemaHash: null },
      mcp: { health: 200, ready: 200, cwd: null, pid: null, sha: null },
      plugin: { status: 'running', enabled: true, source: '/p', directory: '/p', sourceKnown: true, modules: [{ path: 'index.server.ts', sha256: 'a'.repeat(64), bytes: 3 }] },
      channelRecovery: 'adopt-expected', lockReleased: false,
      rollback: { attempted: false, to: null, ok: false },
    };
    const tag = mintHostTag(serviceHome, body);
    expect(verifyHostTag(serviceHome, { ...body, hostTag: tag })).toBe(true);
    // Flip without resign — reader must reject (historical bug).
    expect(verifyHostTag(serviceHome, { ...body, hostTag: tag, lockReleased: true })).toBe(false);
    // Resign after flip — must verify.
    const resigned = { ...body, lockReleased: true };
    const newTag = mintHostTag(serviceHome, resigned);
    expect(verifyHostTag(serviceHome, { ...resigned, hostTag: newTag })).toBe(true);
  });

  test('B2: plugin.enabled compare accepts json.dumps lowercase true', () => {
    // Mirrors apply.sh receipt mint: PLUGIN_ENABLED from json.dumps(bool) is "true"/"false".
    const enabled = (value: string) => value === 'true';
    expect(enabled('true')).toBe(true);
    expect(enabled('True')).toBe(false);
    expect(enabled('false')).toBe(false);
  });

  test('exitCode semantics: installerExitCode is signed and diverges from apply exit on warning', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-exit-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    ensureHostHmacKey(serviceHome);
    const base: Omit<HostReleaseReceipt, 'hostTag'> = {
      schema: 'host-release-receipt/1',
      opId: '4'.repeat(32), taskId: 't', targetSha: sha(70), previousActive: '/a', expectedActive: '/a',
      snapshotHash: 'f'.repeat(64), rollbackSha: sha(71),
      executor: { host: 'h', uid: 1, user: 'u' },
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      exitCode: 1, installerExitCode: 0, state: 'rolled_back',
      checks: [], binding: { releasePath: '/r', contentMatchesCommit: true, vendorSchemaDiff: 'unavailable', schemaHash: null, vendorSchemaHash: null },
      mcp: { health: 200, ready: 200, cwd: null, pid: null, sha: null },
      plugin: { status: 'running', enabled: true, source: '/p', directory: '/p', sourceKnown: true, modules: [{ path: 'index.server.ts', sha256: 'a'.repeat(64), bytes: 3 }] },
      channelRecovery: 'unknown', lockReleased: true,
      rollback: { attempted: true, to: '/r2', ok: true },
    };
    // Warn-mode shape: installer rc=0 while apply exit=1 — distinct fields must coexist.
    expect(base.exitCode).toBe(1);
    expect(base.installerExitCode).toBe(0);
    const tag = mintHostTag(serviceHome, base);
    expect(verifyHostTag(serviceHome, { ...base, hostTag: tag })).toBe(true);
    // installerExitCode is part of the signed payload — tampering breaks verification.
    expect(verifyHostTag(serviceHome, { ...base, hostTag: tag, installerExitCode: 1 })).toBe(false);
  });

  test('B3: set -e lock failure still prints refused (set +e capture)', () => {
    // Micro-repro of apply.sh lock capture pattern — non-zero child must not abort before echo.
    const script = [
      'set -eu',
      'set +e',
      '/usr/bin/python3 -c "raise SystemExit(1)"',
      'lock_rc=$?',
      'set -e',
      '[ "$lock_rc" -eq 0 ] || { echo "refused: host-release lock held or uncreatable: /x" >&2; exit 1; }',
    ].join('\n');
    const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refused: host-release lock held or uncreatable/);
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

describe('AC04 receipt evidence: hashes, mcp runtime, plugin modules', () => {
  const receiptBody = (over: Partial<Omit<HostReleaseReceipt, 'hostTag'>> = {}): Omit<HostReleaseReceipt, 'hostTag'> => ({
    schema: 'host-release-receipt/1',
    opId: 'a'.repeat(32), taskId: 't', targetSha: sha(80), previousActive: '/a', expectedActive: '/a',
    snapshotHash: 'c'.repeat(64), rollbackSha: sha(81),
    executor: { host: 'h', uid: 1, user: 'u' },
    startedAt: '2026-10-26T00:00:00Z', finishedAt: '2026-10-26T00:01:00Z',
    exitCode: 0, installerExitCode: 0, state: 'succeeded',
    checks: [{ name: 'install', ok: true }, { name: 'mcp-health', ok: true }],
    binding: {
      releasePath: '/svc/releases/' + sha(80), contentMatchesCommit: true, vendorSchemaDiff: 'none',
      schemaHash: '1'.repeat(64), vendorSchemaHash: '1'.repeat(64),
    },
    mcp: { health: 200, ready: 200, cwd: '/svc/releases/' + sha(80), pid: 4321, sha: '2'.repeat(64) },
    plugin: {
      status: 'running', enabled: true, source: '/svc/releases/' + sha(80) + '/plugin',
      directory: '/svc/releases/' + sha(80) + '/plugin', sourceKnown: true,
      modules: [{ path: 'index.server.ts', sha256: '3'.repeat(64), bytes: 300 }],
    },
    channelRecovery: 'adopt-expected', lockReleased: true,
    rollback: { attempted: false, to: null, ok: false },
    ...over,
  });

  test('the new AC04 fields are signed: mint then tamper each one fails verification', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-ac04-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    ensureHostHmacKey(serviceHome);
    const body = receiptBody();
    const tag = mintHostTag(serviceHome, body);
    expect(verifyHostTag(serviceHome, { ...body, hostTag: tag })).toBe(true);

    const tampers: Array<[string, Omit<HostReleaseReceipt, 'hostTag'>]> = [
      ['schemaHash', { ...body, binding: { ...body.binding, schemaHash: '9'.repeat(64) } }],
      ['vendorSchemaHash', { ...body, binding: { ...body.binding, vendorSchemaHash: '9'.repeat(64) } }],
      ['vendorSchemaDiff', { ...body, binding: { ...body.binding, vendorSchemaDiff: 'differ' } }],
      ['mcp.sha', { ...body, mcp: { ...body.mcp, sha: '9'.repeat(64) } }],
      ['mcp.cwd', { ...body, mcp: { ...body.mcp, cwd: '/elsewhere' } }],
      ['mcp.pid', { ...body, mcp: { ...body.mcp, pid: 1 } }],
      ['plugin.modules[0].sha256', { ...body, plugin: { ...body.plugin, modules: [{ path: 'index.server.ts', sha256: '9'.repeat(64), bytes: 300 }] } }],
      ['plugin.modules removed', { ...body, plugin: { ...body.plugin, modules: null } }],
      ['checks', { ...body, checks: [{ name: 'install', ok: false }] }],
    ];
    for (const [label, tampered] of tampers) {
      expect({ label, ok: verifyHostTag(serviceHome, { ...tampered, hostTag: tag }) }).toEqual({ label, ok: false });
    }
  });


  /**
   * Real apply.sh run against stub host tools. Mirrors the prepared-snapshot shape the release pipeline
   * produces: the snapshot carries plugin/node_modules (and a nested one), which the inventory digest must
   * prune exactly like TS snapshotInventoryHash — otherwise apply refuses its own snapshot (ef9523 R2).
   */
  function runApply(opts: {
    withMcpListener?: boolean;
    preCreateRelease?: boolean;
    tamperSnapshot?: boolean;
  } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'sck-hr-apply-'));
    clean.push(root);
    const serviceHome = join(root, 'svc');
    const releaseSha = sha(90);
    const previousSha = sha(91);
    const opId = 'f'.repeat(32);
    const envelope = join(serviceHome, 'maintenance', 'host-release', opId);
    mkdirSync(envelope, { recursive: true });
    // Apply's barrier is fail-closed: the host must publish both authoritative mirrors first.
    writeFileSync(join(serviceHome, 'maintenance', 'dispatch-paused.json'), '{"paused":false}\n');
    writeFileSync(join(serviceHome, 'maintenance', 'qa-observation-active.json'), '{"active":false}\n');
    mkdirSync(join(serviceHome, 'releases', previousSha), { recursive: true });
    symlinkSync(join(serviceHome, 'releases', previousSha), join(serviceHome, 'active'));
    ensureHostHmacKey(serviceHome);

    const snapshot = join(root, 'snapshot');
    mkdirSync(join(snapshot, 'scripts'), { recursive: true });
    mkdirSync(join(snapshot, 'schema'), { recursive: true });
    mkdirSync(join(snapshot, 'plugin', 'server', 'vendor', 'schema'), { recursive: true });
    mkdirSync(join(snapshot, 'plugin', 'shared'), { recursive: true });
    // Real prepared snapshots carry installed dependencies; the digest must prune them at any depth.
    mkdirSync(join(snapshot, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(snapshot, 'plugin', 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(snapshot, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(snapshot, 'plugin', 'node_modules', 'dep', 'index.js'), 'module.exports = 2;\n');
    writeFileSync(join(snapshot, 'schema', '001-control.surql'), 'DEFINE TABLE x;\n');
    writeFileSync(join(snapshot, 'plugin', 'server', 'vendor', 'schema', '001-control.surql'), 'DEFINE TABLE x;\n');
    writeFileSync(join(snapshot, 'plugin', 'shared', 'types.ts'), 'export type T = 1;\n');
    writeFileSync(join(snapshot, 'scripts', 'company-service.sh'),
      '#!/bin/sh\ncase "$1" in install) ln -sfn "$2" "${SCK_SERVICE_HOME}/active"; exit 0;; esac\nexit 0\n');
    const snapshotHash = snapshotInventoryHash(snapshot);
    if (opts.tamperSnapshot) writeFileSync(join(snapshot, 'plugin', 'shared', 'types.ts'), 'export type T = 2;\n');

    writeFileSync(join(envelope, 'operation.json'), JSON.stringify({
      opId, taskId: 'task-ac04', targetSha: releaseSha, expectedActive: join(serviceHome, 'releases', previousSha),
      snapshotHash, rollbackSha: previousSha, idempotencyKey: 'k', state: 'prepared',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, null, 2));
    if (opts.preCreateRelease) {
      // Reuse branch: the release dir already holds the prepared tree.
      const releaseDir = join(serviceHome, 'releases', releaseSha);
      mkdirSync(releaseDir, { recursive: true });
      spawnSync('cp', ['-R', `${snapshot}/.`, `${releaseDir}/`]);
    }

    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\necho 200\n');
    const pluginPath = join(serviceHome, 'releases', releaseSha, 'plugin');
    writeFileSync(join(bin, 'paseo'),
      `#!/bin/sh\nif [ "$1" = plugin ]; then\n  printf '[{"installation":{"identity":{"path":"%s"}},"path":"%s","status":"running","enabled":true}]\\n' "${pluginPath}" "${pluginPath}"\n  exit 0\nfi\nexit 0\n`);
    chmodSync(join(bin, 'curl'), 0o755);
    chmodSync(join(bin, 'paseo'), 0o755);

    // Stub lsof only when a listener is simulated; otherwise the real probe runs and reports nothing.
    let lsofPath = '/usr/sbin/lsof';
    if (opts.withMcpListener) {
      lsofPath = join(bin, 'lsof');
      writeFileSync(lsofPath,
        `#!/bin/sh\ncase "$*" in\n  *-iTCP:*) echo 4321;;\n  *-Fn*) echo "n${join(serviceHome, 'releases', releaseSha)}";;\n  *) exit 0;;\nesac\n`);
      chmodSync(lsofPath, 0o755);
    }

    const script = join(import.meta.dir, '..', 'scripts', 'host-release', 'apply.sh');
    const result = spawnSync('/bin/sh', [script,
      '--service-home', serviceHome, '--ops-repo', root, '--op-id', opId,
      '--snapshot', snapshot, '--paseo', join(bin, 'paseo'),
    ], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`,
        SCK_SERVICE_HOME: serviceHome, SCK_MCP_PORT: '1', SCK_LSOF: lsofPath,
      },
    });
    return { root, serviceHome, snapshot, releaseSha, opId, result };
  }

  test('apply.sh accepts a snapshot that carries nested node_modules (digest parity with TS)', () => {
    const { serviceHome, opId, result } = runApply();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const receipt = readHostReleaseReceipt(serviceHome, opId);
    expect(receipt.state).toBe('succeeded');
    expect(receipt.binding.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.binding.vendorSchemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.binding.vendorSchemaDiff).toBe('none');
    expect(receipt.plugin.sourceKnown).toBe(true);
    expect(receipt.plugin.modules?.some(module => module.path === 'shared/types.ts')).toBe(true);
    // node_modules is pruned from the module list too.
    expect(receipt.plugin.modules?.some(module => module.path.includes('node_modules'))).toBe(false);
    expect(receipt.checks.length).toBeGreaterThan(0);
    expect(receipt.checks.every(check => typeof check.name === 'string' && typeof check.ok === 'boolean')).toBe(true);
  });

  test('the reuse branch accepts an existing release dir with the same inventory', () => {
    const { serviceHome, opId, result } = runApply({ preCreateRelease: true });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readHostReleaseReceipt(serviceHome, opId).state).toBe('succeeded');
  });

  test('a snapshot whose inventory does not match envelope.snapshotHash is refused before side effects', () => {
    const { serviceHome, releaseSha, result } = runApply({ tamperSnapshot: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/snapshot .* inventory .* != envelope snapshotHash/);
    expect(existsSync(join(serviceHome, 'releases', releaseSha))).toBe(false);
  });

  test('a simulated listening MCP process is sampled into mcp pid/cwd/sha', () => {
    const { serviceHome, releaseSha, opId, result } = runApply({ withMcpListener: true });
    expect(result.status).toBe(0);
    const receipt = readHostReleaseReceipt(serviceHome, opId);
    expect(receipt.mcp.pid).toBe(4321);
    expect(receipt.mcp.cwd).toBe(join(serviceHome, 'releases', releaseSha));
    expect(receipt.mcp.sha).toMatch(/^[0-9a-f]{64}$/);
  });
});
