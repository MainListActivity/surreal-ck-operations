/**
 * Host provenance for release receipts (F4 / AC04).
 *
 * The HMAC key lives at `$SCK_SERVICE_HOME/private/host-release.hmac` — the employee sandbox
 * denies read of `private/`, so only a trusted host can mint a valid `hostTag`. The tag covers
 * EVERY evidence field on the receipt (binding/mcp/plugin/channelRecovery/lockReleased/rollback/
 * checks/reason included), so copying operation.json fields and inventing an executor is not enough,
 * and tampering with any unsigned evidence field after mint also fails verification.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostReleaseReceipt } from './types.ts';

export const HOST_RELEASE_HMAC_FILE = 'host-release.hmac';

/** Absolute path of the host-only HMAC key. */
export const hostReleaseHmacPath = (serviceHome: string): string =>
  join(serviceHome, 'private', HOST_RELEASE_HMAC_FILE);

/**
 * Canonical bytes covered by hostTag. Stable key order; JSON.stringify default (no spaces).
 * `hostTag` itself is excluded. Every other receipt evidence field is included.
 */
export function receiptTagPayload(receipt: Omit<HostReleaseReceipt, 'hostTag'>): string {
  return JSON.stringify({
    opId: receipt.opId,
    taskId: receipt.taskId,
    targetSha: receipt.targetSha,
    previousActive: receipt.previousActive,
    expectedActive: receipt.expectedActive,
    snapshotHash: receipt.snapshotHash,
    rollbackSha: receipt.rollbackSha,
    executor: {
      host: receipt.executor.host,
      uid: receipt.executor.uid,
      user: receipt.executor.user,
    },
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    exitCode: receipt.exitCode,
    installerExitCode: receipt.installerExitCode,
    state: receipt.state,
    checks: receipt.checks.map(check => ({
      name: check.name,
      ok: check.ok,
      ...(check.detail !== undefined ? { detail: check.detail } : {}),
    })),
    binding: {
      releasePath: receipt.binding.releasePath,
      contentMatchesCommit: receipt.binding.contentMatchesCommit,
      vendorSchemaDiff: receipt.binding.vendorSchemaDiff,
      schemaHash: receipt.binding.schemaHash,
      vendorSchemaHash: receipt.binding.vendorSchemaHash,
      ...(receipt.binding.vendorSchemaDetail !== undefined
        ? { vendorSchemaDetail: receipt.binding.vendorSchemaDetail }
        : {}),
    },
    mcp: {
      health: receipt.mcp.health,
      ready: receipt.mcp.ready,
      cwd: receipt.mcp.cwd,
      pid: receipt.mcp.pid,
      sha: receipt.mcp.sha,
    },
    plugin: {
      status: receipt.plugin.status,
      enabled: receipt.plugin.enabled,
      source: receipt.plugin.source,
      directory: receipt.plugin.directory,
      sourceKnown: receipt.plugin.sourceKnown,
      // AC04: the modules the plugin actually loads are signed, so a tampered module list fails verify.
      modules: receipt.plugin.modules
        ? receipt.plugin.modules.map(module => ({ path: module.path, sha256: module.sha256, bytes: module.bytes }))
        : null,
    },
    channelRecovery: receipt.channelRecovery,
    ...(receipt.rollback
      ? {
          rollback: {
            attempted: receipt.rollback.attempted,
            to: receipt.rollback.to,
            ok: receipt.rollback.ok,
            ...(receipt.rollback.detail !== undefined ? { detail: receipt.rollback.detail } : {}),
          },
        }
      : {}),
    lockReleased: receipt.lockReleased,
    ...(receipt.reason !== undefined ? { reason: receipt.reason } : {}),
  });
}

/** Read the host HMAC key; throws if missing (apply must mint one first). */
export function readHostHmacKey(serviceHome: string): Buffer {
  const path = hostReleaseHmacPath(serviceHome);
  if (!existsSync(path)) {
    throw new Error(`host-release HMAC key missing at ${path}; trusted host must mint it under private/ (mode 0600)`);
  }
  return readFileSync(path);
}

/** Mint a new host HMAC key if absent. Host-only (needs write to private/). */
export function ensureHostHmacKey(serviceHome: string): string {
  const path = hostReleaseHmacPath(serviceHome);
  mkdirSync(join(serviceHome, 'private'), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32), { mode: 0o600 });
  }
  return path;
}

export function mintHostTag(serviceHome: string, receipt: Omit<HostReleaseReceipt, 'hostTag'>): string {
  const key = readHostHmacKey(serviceHome);
  return createHmac('sha256', key).update(receiptTagPayload(receipt)).digest('hex');
}

export function verifyHostTag(serviceHome: string, receipt: HostReleaseReceipt): boolean {
  if (typeof receipt.hostTag !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.hostTag)) return false;
  let key: Buffer;
  try { key = readHostHmacKey(serviceHome); } catch { return false; }
  const { hostTag: _tag, ...rest } = receipt;
  const expected = createHmac('sha256', key).update(receiptTagPayload(rest)).digest();
  const actual = Buffer.from(receipt.hostTag, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
