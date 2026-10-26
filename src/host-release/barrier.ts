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
  /**
   * `prepare` (default): missing mirrors report ok with detail "no file signal".
   * `apply`: missing mirrors are refused (fail closed) — host must publish an explicit clear signal.
   */
  mode?: 'prepare' | 'apply';
  /** When set, a lock held by this opId is ignored (self-lock exemption for apply). */
  selfOpId?: string;
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
  const mode = input.mode ?? 'prepare';
  const failClosed = mode === 'apply';

  const lockPath = join(input.serviceHome, 'maintenance', HOST_RELEASE_LOCK_FILE);
  if (existsSync(lockPath)) {
    const prior = readJson<{ opId?: string; at?: string }>(lockPath);
    const self = input.selfOpId !== undefined && prior?.opId === input.selfOpId;
    checks.push(self
      ? { name: 'host-release-lock', ok: true, detail: `self-lock ${input.selfOpId}` }
      : {
          name: 'host-release-lock',
          ok: false,
          detail: `lock held by ${prior?.opId ?? 'unknown'} since ${prior?.at ?? 'unknown'}`,
        });
  } else {
    checks.push({ name: 'host-release-lock', ok: true });
  }

  const readStrictBool = (
    path: string, field: 'paused' | 'active', label: string,
  ): { ok: boolean; detail?: string; value?: boolean } => {
    if (!existsSync(path)) {
      return failClosed
        ? { ok: false, detail: 'missing authoritative mirror (apply fail-closed)' }
        : { ok: true, detail: 'no file signal' };
    }
    const data = readJson<Record<string, unknown>>(path);
    if (data === undefined) {
      return { ok: false, detail: `${label}: unreadable or invalid JSON` };
    }
    if (typeof data !== 'object' || data === null || !(field in data)) {
      return { ok: false, detail: `${label}: missing boolean field ${field}` };
    }
    const value = data[field];
    if (value !== true && value !== false) {
      return { ok: false, detail: `${label}: ${field} must be JSON boolean true|false, got ${JSON.stringify(value)}` };
    }
    return { ok: true, value };
  };

  const pausedMirror = join(input.serviceHome, 'maintenance', 'dispatch-paused.json');
  const paused = readStrictBool(pausedMirror, 'paused', 'dispatch-paused');
  if (!paused.ok) {
    checks.push({ name: 'dispatch-paused', ok: false, detail: paused.detail });
  } else if (paused.value === true) {
    checks.push({ name: 'dispatch-paused', ok: false, detail: 'company dispatch is paused (maintenance/dispatch-paused.json)' });
  } else {
    checks.push({ name: 'dispatch-paused', ok: true, detail: paused.detail });
  }

  const observationMirror = join(input.serviceHome, 'maintenance', 'qa-observation-active.json');
  const observation = readStrictBool(observationMirror, 'active', 'qa-observation-window');
  if (!observation.ok) {
    checks.push({ name: 'qa-observation-window', ok: false, detail: observation.detail });
  } else if (observation.value === true) {
    const data = readJson<{ expiresAt?: string }>(observationMirror);
    if (data?.expiresAt) {
      const exp = Date.parse(data.expiresAt);
      if (!Number.isFinite(exp)) {
        checks.push({ name: 'qa-observation-window', ok: false, detail: 'expiresAt unparsable while active=true' });
      } else if (exp <= now) {
        checks.push({ name: 'qa-observation-window', ok: true, detail: 'observation window expired' });
      } else {
        checks.push({ name: 'qa-observation-window', ok: false, detail: 'active QA observation / sampling window is open' });
      }
    } else {
      checks.push({ name: 'qa-observation-window', ok: false, detail: 'active QA observation / sampling window is open' });
    }
  } else {
    checks.push({ name: 'qa-observation-window', ok: true, detail: observation.detail });
  }

  // Presence of OTHER host-release envelopes in 'applying' state (ignore self).
  const root = join(input.serviceHome, 'maintenance', 'host-release');
  if (existsSync(root)) {
    let applying = 0;
    for (const name of readdirSync(root)) {
      if (input.selfOpId && name === input.selfOpId) continue;
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
