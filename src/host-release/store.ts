/**
 * On-disk envelope for one host-release operation under maintenance/host-release/<opId>/.
 * Writable inside the employee sandbox (maintenance/ is not denied). Apply still needs a host.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  HostReleaseOperation, HostReleasePrepareResult, HostReleaseReceipt, HostReleaseRequest, HostReleaseRoots,
  HostReleaseStatusResult,
} from './types.ts';
import {
  HOST_RELEASE_LOCK_FILE, HOST_RELEASE_OPERATION_FILE, HOST_RELEASE_PREPARE_FILE, HOST_RELEASE_RECEIPT_FILE,
  hostReleaseEnvelopeDir, isCommitSha, isSafeAbsolutePath,
} from './types.ts';
import { snapshotInventoryHash, verifyRelease, type VerifyResult } from './verify.ts';

export class HostReleaseError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'not_found' | 'forbidden' | 'refused', message: string) {
    super(message);
    this.name = 'HostReleaseError';
  }
}

const nowIso = (): string => new Date().toISOString();

const writeJsonAtomic = (path: string, value: unknown): void => {
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
};

const readJson = <T>(path: string): T | undefined => {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
};

/** Derive a stable op id from the request so retries of the same prepare converge. */
export const opIdFor = (request: HostReleaseRequest): string =>
  createHash('sha256')
    .update([request.taskId, request.targetSha, request.expectedActive, request.snapshotHash, request.rollbackSha, request.idempotencyKey].join('|'))
    .digest('hex')
    .slice(0, 32);

export const validateRequest = (request: HostReleaseRequest): void => {
  if (!request.taskId || request.taskId.length > 200) throw new HostReleaseError('invalid', 'taskId is required');
  if (!isCommitSha(request.targetSha)) throw new HostReleaseError('invalid', 'targetSha must be a 40-char lowercase hex commit');
  if (!isCommitSha(request.rollbackSha)) throw new HostReleaseError('invalid', 'rollbackSha must be a 40-char lowercase hex commit');
  if (!isSafeAbsolutePath(request.expectedActive)) throw new HostReleaseError('invalid', 'expectedActive must be a safe absolute path');
  if (!/^[0-9a-f]{64}$/.test(request.snapshotHash)) throw new HostReleaseError('invalid', 'snapshotHash must be a sha256 hex digest');
  if (!request.idempotencyKey || request.idempotencyKey.length > 200) throw new HostReleaseError('invalid', 'idempotencyKey is required');
};

export interface PrepareInput {
  roots: HostReleaseRoots;
  request: HostReleaseRequest;
  /** Absolute path of an already-built snapshot (git archive + vendor + deps). */
  snapshotPath: string;
}

/**
 * Prepare: validate inputs, verify the snapshot against the fixed refusal order, write the envelope.
 * Does not switch active, does not call paseo/launchctl, does not read private/.
 */
export function prepareHostRelease(input: PrepareInput): HostReleasePrepareResult {
  validateRequest(input.request);
  if (!isSafeAbsolutePath(input.snapshotPath) || !existsSync(input.snapshotPath)) {
    throw new HostReleaseError('invalid', 'snapshotPath must be an existing absolute path');
  }
  // F3′: store-level basename == targetSha (CLI already checks; MCP must too).
  if (basename(input.snapshotPath) !== input.request.targetSha) {
    throw new HostReleaseError('invalid', `snapshotPath basename must equal targetSha (${input.request.targetSha})`);
  }
  const inventory = snapshotInventoryHash(input.snapshotPath);
  if (inventory !== input.request.snapshotHash) {
    throw new HostReleaseError('refused', `snapshotHash mismatch: request ${input.request.snapshotHash} inventory ${inventory}`);
  }

  const verified: VerifyResult = verifyRelease({
    roots: input.roots,
    targetSha: input.request.targetSha,
    releasePath: input.snapshotPath,
    expectedActive: input.request.expectedActive,
  });

  const opId = opIdFor(input.request);
  const envelopePath = hostReleaseEnvelopeDir(input.roots.serviceHome, opId);
  mkdirSync(envelopePath, { recursive: true, mode: 0o700 });

  const existing = readJson<HostReleaseOperation>(join(envelopePath, HOST_RELEASE_OPERATION_FILE));
  if (existing && existing.idempotencyKey === input.request.idempotencyKey && existing.state === 'succeeded') {
    throw new HostReleaseError('conflict', `operation ${opId} already succeeded; refuse to re-prepare a finished release`);
  }

  const state = verified.ok ? 'prepared' : 'refused';
  const at = nowIso();
  const operation: HostReleaseOperation = {
    opId,
    taskId: input.request.taskId,
    targetSha: input.request.targetSha,
    expectedActive: input.request.expectedActive,
    snapshotHash: input.request.snapshotHash,
    rollbackSha: input.request.rollbackSha,
    idempotencyKey: input.request.idempotencyKey,
    state,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    snapshotPath: input.snapshotPath,
    ...(verified.ok ? {} : { reason: verified.checks.filter(check => !check.ok).map(check => `${check.name}: ${check.detail ?? 'failed'}`).join('; ') }),
  };
  writeJsonAtomic(join(envelopePath, HOST_RELEASE_OPERATION_FILE), operation);

  const prepare: HostReleasePrepareResult = {
    opId,
    state: operation.state,
    targetSha: operation.targetSha,
    expectedActive: operation.expectedActive,
    snapshotHash: operation.snapshotHash,
    rollbackSha: operation.rollbackSha,
    snapshotPath: input.snapshotPath,
    checks: verified.checks,
    envelopePath,
  };
  writeJsonAtomic(join(envelopePath, HOST_RELEASE_PREPARE_FILE), prepare);
  if (!verified.ok) throw new HostReleaseError('refused', operation.reason ?? 'prepare verification failed');
  return prepare;
}

export function readHostReleaseStatus(serviceHome: string, opId: string): HostReleaseStatusResult {
  if (!/^[0-9a-f]{16,64}$/.test(opId)) throw new HostReleaseError('invalid', 'opId malformed');
  const envelopePath = hostReleaseEnvelopeDir(serviceHome, opId);
  const operation = readJson<HostReleaseOperation>(join(envelopePath, HOST_RELEASE_OPERATION_FILE));
  if (!operation) throw new HostReleaseError('not_found', `operation ${opId} not found`);
  let activeNow: string | undefined;
  try {
    activeNow = spawnSync('readlink', [join(serviceHome, 'active')], { encoding: 'utf8' }).stdout?.trim() || undefined;
  } catch { /* leave undefined */ }
  return {
    opId: operation.opId,
    state: operation.state,
    targetSha: operation.targetSha,
    expectedActive: operation.expectedActive,
    snapshotHash: operation.snapshotHash,
    rollbackSha: operation.rollbackSha,
    updatedAt: operation.updatedAt,
    ...(operation.reason ? { reason: operation.reason } : {}),
    ...(operation.receiptPath ? { receiptPath: operation.receiptPath } : {}),
    ...(activeNow ? { activeNow } : {}),
  };
}

/**
 * Read a host-written receipt. Refuses employee-shaped forgeries (F4′):
 * - schema + executor identity required
 * - file must live under the operation envelope
 * - receipt.taskId / targetSha / snapshotHash / rollbackSha / expectedActive must match operation.json
 * Presence of an executor field alone is never enough.
 */
export function readHostReleaseReceipt(serviceHome: string, opId: string): HostReleaseReceipt {
  if (!/^[0-9a-f]{16,64}$/.test(opId)) throw new HostReleaseError('invalid', 'opId malformed');
  const envelopePath = hostReleaseEnvelopeDir(serviceHome, opId);
  const operation = readJson<HostReleaseOperation>(join(envelopePath, HOST_RELEASE_OPERATION_FILE));
  if (!operation) throw new HostReleaseError('not_found', `operation ${opId} not found`);
  const receiptPath = join(envelopePath, HOST_RELEASE_RECEIPT_FILE);
  const receipt = readJson<HostReleaseReceipt>(receiptPath);
  if (!receipt) throw new HostReleaseError('not_found', `receipt for ${opId} not found`);
  if (receipt.schema !== 'host-release-receipt/1') throw new HostReleaseError('invalid', 'receipt schema is not host-release-receipt/1');
  if (!receipt.executor || typeof receipt.executor.host !== 'string' || typeof receipt.executor.uid !== 'number') {
    throw new HostReleaseError('invalid', 'receipt missing trusted executor identity');
  }
  if (receipt.opId !== opId) throw new HostReleaseError('invalid', 'receipt opId mismatch');
  if (receipt.taskId !== operation.taskId) throw new HostReleaseError('invalid', 'receipt.taskId does not match operation');
  if (receipt.targetSha !== operation.targetSha) throw new HostReleaseError('invalid', 'receipt.targetSha does not match operation');
  if (receipt.snapshotHash !== operation.snapshotHash) throw new HostReleaseError('invalid', 'receipt.snapshotHash does not match operation');
  if (receipt.rollbackSha !== operation.rollbackSha) throw new HostReleaseError('invalid', 'receipt.rollbackSha does not match operation');
  if (receipt.expectedActive !== operation.expectedActive) throw new HostReleaseError('invalid', 'receipt.expectedActive does not match operation');
  return receipt;
}

/**
 * Acquire the global host-release lock (F5). Uses O_EXCL so two concurrent creators cannot both win
 * the existsSync→write race. Host-only; employees can see it but cannot run apply.
 */
export function acquireHostReleaseLock(serviceHome: string, opId: string): string {
  const lockPath = join(serviceHome, 'maintenance', HOST_RELEASE_LOCK_FILE);
  mkdirSync(join(serviceHome, 'maintenance'), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    const prior = readJson<{ opId?: string; at?: string }>(lockPath);
    throw new HostReleaseError('conflict', `host-release lock held by ${prior?.opId ?? 'unknown'} since ${prior?.at ?? 'unknown'}: ${(error as Error).message}`);
  }
  try {
    writeFileSync(fd, `${JSON.stringify({ opId, at: nowIso() }, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  return lockPath;
}

export function releaseHostReleaseLock(serviceHome: string, opId: string): void {
  const lockPath = join(serviceHome, 'maintenance', HOST_RELEASE_LOCK_FILE);
  const prior = readJson<{ opId?: string }>(lockPath);
  if (!prior) return;
  if (prior.opId !== opId) throw new HostReleaseError('conflict', `lock held by ${prior.opId}, not ${opId}`);
  unlinkSync(lockPath);
}

export function writeHostReceipt(serviceHome: string, receipt: HostReleaseReceipt): string {
  const envelopePath = hostReleaseEnvelopeDir(serviceHome, receipt.opId);
  mkdirSync(envelopePath, { recursive: true, mode: 0o700 });
  const receiptPath = join(envelopePath, HOST_RELEASE_RECEIPT_FILE);
  writeJsonAtomic(receiptPath, receipt);
  const operationPath = join(envelopePath, HOST_RELEASE_OPERATION_FILE);
  const operation = readJson<HostReleaseOperation>(operationPath);
  if (operation) {
    writeJsonAtomic(operationPath, {
      ...operation,
      state: receipt.state,
      updatedAt: receipt.finishedAt,
      receiptPath,
      ...(receipt.reason ? { reason: receipt.reason } : {}),
      ...(receipt.binding.releasePath ? { releasePath: receipt.binding.releasePath } : {}),
    } satisfies HostReleaseOperation);
  }
  return receiptPath;
}
