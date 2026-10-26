/**
 * Host provenance for release receipts (F4 / AC04).
 *
 * The HMAC key lives at `$SCK_SERVICE_HOME/private/host-release.hmac` — the employee sandbox
 * denies read of `private/`, so only a trusted host can mint a valid `hostTag`. The tag covers
 * the binding fields (opId/taskId/targetSha/snapshotHash/rollbackSha/expectedActive/state/
 * exitCode/executor), so copying those fields from operation.json is not enough.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostReleaseReceipt } from './types.ts';

export const HOST_RELEASE_HMAC_FILE = 'host-release.hmac';

/** Absolute path of the host-only HMAC key. */
export const hostReleaseHmacPath = (serviceHome: string): string =>
  join(serviceHome, 'private', HOST_RELEASE_HMAC_FILE);

/** Canonical bytes covered by hostTag (stable key order, no whitespace variance). */
export function receiptTagPayload(receipt: Pick<HostReleaseReceipt,
  'opId' | 'taskId' | 'targetSha' | 'snapshotHash' | 'rollbackSha' | 'expectedActive' |
  'state' | 'exitCode' | 'executor' | 'startedAt' | 'finishedAt'
>): string {
  return JSON.stringify({
    opId: receipt.opId,
    taskId: receipt.taskId,
    targetSha: receipt.targetSha,
    snapshotHash: receipt.snapshotHash,
    rollbackSha: receipt.rollbackSha,
    expectedActive: receipt.expectedActive,
    state: receipt.state,
    exitCode: receipt.exitCode,
    executor: {
      host: receipt.executor.host,
      uid: receipt.executor.uid,
      user: receipt.executor.user,
    },
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
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

export function mintHostTag(serviceHome: string, receipt: Parameters<typeof receiptTagPayload>[0]): string {
  const key = readHostHmacKey(serviceHome);
  return createHmac('sha256', key).update(receiptTagPayload(receipt)).digest('hex');
}

export function verifyHostTag(serviceHome: string, receipt: HostReleaseReceipt): boolean {
  if (typeof receipt.hostTag !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.hostTag)) return false;
  let key: Buffer;
  try { key = readHostHmacKey(serviceHome); } catch { return false; }
  const expected = createHmac('sha256', key).update(receiptTagPayload(receipt)).digest();
  const actual = Buffer.from(receipt.hostTag, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
