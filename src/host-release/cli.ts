#!/usr/bin/env bun
/**
 * CLI for the managed host-release seam: prepare / status / receipt.
 * Apply is scripts/host-release/apply.sh (trusted host only).
 *
 *   bun src/host-release/cli.ts prepare --service-home … --ops-repo … --snapshot … \
 *     --task-id … --expected-active … --rollback-sha … --idempotency-key …
 *   bun src/host-release/cli.ts status --service-home … --op-id …
 *   bun src/host-release/cli.ts receipt --service-home … --op-id …
 */

import { basename } from 'node:path';
import {
  HostReleaseError, prepareHostRelease, readHostReleaseReceipt, readHostReleaseStatus,
} from './store.ts';
import { isCommitSha, isSafeAbsolutePath } from './types.ts';
import { snapshotInventoryHash } from './verify.ts';

const args = process.argv.slice(2);
const op = args.shift();
const flags = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const value = args[i + 1];
  if (!key?.startsWith('--') || value === undefined) {
    console.error(`invalid args at ${key ?? 'eof'}`);
    process.exit(2);
  }
  flags.set(key.slice(2), value);
}
const need = (...keys: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = flags.get(key);
    if (!value) {
      console.error(`missing --${key}`);
      process.exit(2);
    }
    out[key] = value;
  }
  return out;
};

try {
  if (op === 'prepare') {
    const f = need('service-home', 'ops-repo', 'snapshot', 'task-id', 'expected-active', 'rollback-sha', 'idempotency-key');
    if (!isSafeAbsolutePath(f['service-home']!) || !isSafeAbsolutePath(f['ops-repo']!) || !isSafeAbsolutePath(f.snapshot!) || !isSafeAbsolutePath(f['expected-active']!)) {
      throw new HostReleaseError('invalid', 'service-home, ops-repo, snapshot and expected-active must be safe absolute paths');
    }
    const targetSha = basename(f.snapshot!);
    if (!isCommitSha(targetSha)) throw new HostReleaseError('invalid', 'snapshot directory name must be the 40-char commit sha');
    if (!isCommitSha(f['rollback-sha']!)) throw new HostReleaseError('invalid', 'rollback-sha must be a 40-char commit');
    const snapshotHash = snapshotInventoryHash(f.snapshot!);
    const result = prepareHostRelease({
      roots: {
        serviceHome: f['service-home']!,
        opsRepo: f['ops-repo']!,
        releasesDir: `${f['service-home']}/releases`,
      },
      request: {
        taskId: f['task-id']!,
        targetSha,
        expectedActive: f['expected-active']!,
        snapshotHash,
        rollbackSha: f['rollback-sha']!,
        idempotencyKey: f['idempotency-key']!,
      },
      snapshotPath: f.snapshot!,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  if (op === 'status') {
    const f = need('service-home', 'op-id');
    const result = readHostReleaseStatus(f['service-home']!, f['op-id']!);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  if (op === 'receipt') {
    const f = need('service-home', 'op-id');
    const result = readHostReleaseReceipt(f['service-home']!, f['op-id']!);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  console.error('usage: host-release/cli.ts <prepare|status|receipt> [flags]');
  process.exit(2);
} catch (error) {
  if (error instanceof HostReleaseError) {
    console.error(JSON.stringify({ ok: false, code: error.code, error: error.message }));
    process.exit(1);
  }
  throw error;
}
