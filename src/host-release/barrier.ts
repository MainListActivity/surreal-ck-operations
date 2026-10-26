/**
 * AC03 activity barrier for managed host-release apply.
 *
 * A release must not switch while:
 * - company dispatch is globally paused (company_meta:config.paused), or
 * - an active QA observation scope is still open (sampling / observation window), or
 * - a host-release lock is already held.
 *
 * Pure file / JSON reads only — no DB client required for the employee-safe prepare path.
 * Apply (host) re-checks the same signals before side effects.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HostReleaseCheck } from './types.ts';
import { HOST_RELEASE_LOCK_FILE } from './types.ts';

export interface BarrierInput {
  serviceHome: string;
  /** ISO now; used to expire observation windows when expiresAt is present. */
  nowIso?: string;
}

export interface BarrierResult {
  ok: boolean;
  checks: HostReleaseCheck[];
}

const readJson = <T>(path: string): T | undefined => {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
};

/**
 * File-backed signals the host / prepare path can see without opening SurrealDB.
 * - maintenance/dispatch-paused.json { paused: true } — optional mirror written by owner tooling
 * - maintenance/qa-observation-active.json { active: true, expiresAt?: ISO } — optional mirror
 * - maintenance/host-release.lock — live apply lock
 *
 * When the mirror files are absent the check reports ok=true with detail "no file signal"
 * (DB-side paused/observation is re-checked by apply on the host, which can read the DB).
 */
export function checkActivityBarrier(input: BarrierInput): BarrierResult {
  const checks: HostReleaseCheck[] = [];
  const now = Date.parse(input.nowIso ?? new Date().toISOString());

  const lockPath = join(input.serviceHome, 'maintenance', HOST_RELEASE_LOCK_FILE);
  if (existsSync(lockPath)) {
    const prior = readJson<{ opId?: string; at?: string }>(lockPath);
    checks.push({
      name: 'host-release-lock',
      ok: false,
      detail: `lock held by ${prior?.opId ?? 'unknown'} since ${prior?.at ?? 'unknown'}`,
    });
  } else {
    checks.push({ name: 'host-release-lock', ok: true });
  }

  const pausedMirror = join(input.serviceHome, 'maintenance', 'dispatch-paused.json');
  if (existsSync(pausedMirror)) {
    const data = readJson<{ paused?: boolean }>(pausedMirror);
    const paused = data?.paused === true;
    checks.push({
      name: 'dispatch-paused',
      ok: !paused,
      detail: paused ? 'company dispatch is paused (maintenance/dispatch-paused.json)' : undefined,
    });
  } else {
    checks.push({ name: 'dispatch-paused', ok: true, detail: 'no file signal' });
  }

  const observationMirror = join(input.serviceHome, 'maintenance', 'qa-observation-active.json');
  if (existsSync(observationMirror)) {
    const data = readJson<{ active?: boolean; expiresAt?: string }>(observationMirror);
    let active = data?.active === true;
    if (active && data?.expiresAt) {
      const exp = Date.parse(data.expiresAt);
      if (Number.isFinite(exp) && exp <= now) active = false;
    }
    checks.push({
      name: 'qa-observation-window',
      ok: !active,
      detail: active ? 'active QA observation / sampling window is open' : undefined,
    });
  } else {
    checks.push({ name: 'qa-observation-window', ok: true, detail: 'no file signal' });
  }

  // Presence of other host-release envelopes in 'applying' state is a soft barrier.
  const root = join(input.serviceHome, 'maintenance', 'host-release');
  if (existsSync(root)) {
    let applying = 0;
    for (const name of readdirSync(root)) {
      const op = readJson<{ state?: string }>(join(root, name, 'operation.json'));
      if (op?.state === 'applying') applying += 1;
    }
    checks.push({
      name: 'concurrent-apply',
      ok: applying === 0,
      detail: applying > 0 ? `${applying} envelope(s) still in state=applying` : undefined,
    });
  } else {
    checks.push({ name: 'concurrent-apply', ok: true });
  }

  return { ok: checks.every(check => check.ok), checks };
}
