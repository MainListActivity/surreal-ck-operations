/**
 * Pre-apply verification reused by prepare (employee-safe) and apply (host-only).
 *
 * Mirrors company-service.sh install's refusal order without performing any side effect:
 * main ancestry → content bind → RW06 / SYS02 / IR06 / SYS06 → dual gates → bun match → paseo preflight.
 * A plugin-repoint warning is not success: post-apply verification must fail the operation.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { HostReleaseCheck, HostReleaseRoots } from './types.ts';
import { isCommitSha, isSafeAbsolutePath } from './types.ts';
import { checkActivityBarrier } from './barrier.ts';

export interface VerifyInput {
  roots: HostReleaseRoots;
  targetSha: string;
  /** Absolute path of the snapshot / release directory to verify. */
  releasePath: string;
  /** When set, active must currently equal this path (CAS). */
  expectedActive?: string;
  /** Scope passed to the shell guards (`full` for local install). */
  guardScope?: 'full' | 'core';
}

export interface VerifyResult {
  ok: boolean;
  checks: HostReleaseCheck[];
}

const run = (cmd: string, args: string[], cwd?: string): { code: number; out: string; err: string } => {
  const child = spawnSync(cmd, args, { encoding: 'utf8', cwd, timeout: 60_000 });
  return { code: child.status ?? 1, out: child.stdout ?? '', err: child.stderr ?? '' };
};

/** Source the guard helpers and ask one `*_target_supported` function. */
const guardSupported = (scriptDir: string, fn: string, release: string, scope: string): boolean => {
  const child = spawnSync('sh', ['-c',
    `. "${scriptDir}/review-wait-guard.sh"; . "${scriptDir}/independence-guard.sh"; . "${scriptDir}/policy-guard.sh"; ${fn} "$1" "$2"`,
    'guard', release, scope,
  ], { encoding: 'utf8', timeout: 30_000 });
  return (child.status ?? 1) === 0;
};

/** Read a gate record and require pass for this sha + bun on darwin. */
const gatePass = (serviceHome: string, gate: string, sha: string, bun: string): HostReleaseCheck => {
  const path = join(serviceHome, 'gates', gate, `${sha}.json`);
  if (!existsSync(path)) return { name: gate, ok: false, detail: `missing gate record ${path}` };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      gate?: string; sha?: string; bun?: string; platform?: string; result?: string;
    };
    const ok = data.gate === gate && data.sha === sha && data.bun === bun
      && data.platform === 'darwin' && data.result === 'pass';
    return { name: gate, ok, detail: ok ? undefined : `gate record does not pass for sha=${sha} bun=${bun}` };
  } catch (error) {
    return { name: gate, ok: false, detail: `unreadable gate record: ${(error as Error).message}` };
  }
};

/** Resolve the service Bun version the same way install does (no PATH search). */
export const resolveServiceBunVersion = (serviceHome: string, scriptDir: string): string => {
  const child = spawnSync('sh', ['-c',
    `. "${scriptDir}/bun-runtime.sh"; resolve_bun "$1"; "$BUN" --version`,
    'bun', serviceHome,
  ], { encoding: 'utf8', timeout: 10_000 });
  const version = (child.stdout ?? '').trim();
  return child.status === 0 && version ? version : 'unknown';
};

/**
 * Inventory hash of tracked files in a release directory (same idea as the handoff package):
 * sorted `path\\0sha256\\n` lines, then sha256 of that text. Skips node_modules / vendor / .runtime / .git / vault/build.
 */
export const snapshotInventoryHash = (releasePath: string): string => {
  const skip = (rel: string): boolean =>
    rel.startsWith('node_modules/') || rel.includes('/node_modules/')
    || rel.startsWith('plugin/server/vendor/')
    || rel.startsWith('.runtime/') || rel.startsWith('.git/')
    || rel.startsWith('vault/build/');
  const files: string[] = [];
  const walk = (abs: string, rel: string) => {
    let entries: string[];
    try { entries = readdirSync(abs); } catch { return; }
    for (const name of entries) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (skip(childRel)) continue;
      const childAbs = join(abs, name);
      let st;
      try { st = statSync(childAbs); } catch { continue; }
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) files.push(childRel);
    }
  };
  walk(releasePath, '');
  files.sort();
  const lines: string[] = [];
  for (const rel of files) {
    const digest = createHash('sha256').update(readFileSync(join(releasePath, rel))).digest('hex');
    lines.push(`${rel}\0${digest}\n`);
  }
  return createHash('sha256').update(lines.join('')).digest('hex');
};

/** Content bind via release-content.sh (sourced). */
const contentMatches = (scriptDir: string, releasePath: string, sha: string, opsRepo: string): boolean => {
  const child = spawnSync('sh', ['-c',
    `. "${scriptDir}/release-content.sh"; release_matches_commit "$1" "$2" "$3"`,
    'content', releasePath, sha, opsRepo,
  ], { encoding: 'utf8', timeout: 120_000 });
  return (child.status ?? 1) === 0;
};

/** Pre-apply verification. Never writes, never switches, never calls paseo/launchctl with side effects. */
export function verifyRelease(input: VerifyInput): VerifyResult {
  const checks: HostReleaseCheck[] = [];
  const push = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  };

  if (!isCommitSha(input.targetSha)) {
    push('targetSha', false, 'targetSha must be a 40-char lowercase hex commit');
    return { ok: false, checks };
  }
  if (!isSafeAbsolutePath(input.releasePath) || !existsSync(input.releasePath)) {
    push('releasePath', false, 'releasePath must be an existing absolute path');
    return { ok: false, checks };
  }
  if (!isSafeAbsolutePath(input.roots.serviceHome) || !isSafeAbsolutePath(input.roots.opsRepo)) {
    push('roots', false, 'serviceHome and opsRepo must be safe absolute paths');
    return { ok: false, checks };
  }

  const scriptDir = join(input.releasePath, 'scripts');
  // Prefer the target's own scripts (content-bound); fall back to opsRepo scripts for a bare archive.
  const scripts = existsSync(join(scriptDir, 'company-service.sh')) ? scriptDir : join(input.roots.opsRepo, 'scripts');

  // 1) main ancestry
  const ancestor = run('git', ['-C', input.roots.opsRepo, 'merge-base', '--is-ancestor', input.targetSha, 'origin/main']);
  push('main-ancestor', ancestor.code === 0, ancestor.code === 0 ? undefined : `${input.targetSha} is not an ancestor of origin/main`);

  // 2) content bind
  push('content-bind', contentMatches(scripts, input.releasePath, input.targetSha, input.roots.opsRepo));

  // 3) four compatibility guards
  const scope = input.guardScope ?? 'full';
  push('rw06-review-wait', guardSupported(scripts, 'review_wait_target_supported', input.releasePath, scope));
  push('sys02-acceptance', guardSupported(scripts, 'acceptance_target_supported', input.releasePath, scope));
  push('ir06-independence', guardSupported(scripts, 'independence_target_supported', input.releasePath, scope));
  push('sys06-policy', guardSupported(scripts, 'policy_target_supported', input.releasePath, scope));

  // 4) dual gates + bun match
  const bun = resolveServiceBunVersion(input.roots.serviceHome, scripts);
  push('bun-runtime', bun !== 'unknown', bun === 'unknown' ? 'service Bun runtime unavailable' : `bun ${bun}`);
  if (bun !== 'unknown') {
    checks.push(gatePass(input.roots.serviceHome, 'comm-slow-pipe', input.targetSha, bun));
    checks.push(gatePass(input.roots.serviceHome, 'sidecar-review', input.targetSha, bun));
  } else {
    push('comm-slow-pipe', false, 'skipped: bun unknown');
    push('sidecar-review', false, 'skipped: bun unknown');
  }

  // 5) expectedActive CAS (read-only)
  if (input.expectedActive !== undefined) {
    const activeLink = join(input.roots.serviceHome, 'active');
    let current: string | null = null;
    try {
      current = spawnSync('readlink', [activeLink], { encoding: 'utf8' }).stdout?.trim() || null;
    } catch { current = null; }
    const ok = current === input.expectedActive;
    push('expected-active', ok, ok ? undefined : `active is ${current ?? 'missing'}, expected ${input.expectedActive}`);
  }

  // 6) release shape (mcp + dispatcher + plugin)
  const shaped = existsSync(join(input.releasePath, 'src/mcp/run.ts'))
    && existsSync(join(input.releasePath, 'src/dispatcher/run.ts'))
    && existsSync(join(input.releasePath, 'plugin'));
  push('release-shape', shaped, shaped ? undefined : 'release missing src/mcp/run.ts, src/dispatcher/run.ts or plugin/');

  // 7) AC03 activity barrier (file-backed signals; host re-checks before side effects)
  const barrier = checkActivityBarrier({ serviceHome: input.roots.serviceHome });
  for (const check of barrier.checks) checks.push(check);

  return { ok: checks.every(check => check.ok), checks };
}
