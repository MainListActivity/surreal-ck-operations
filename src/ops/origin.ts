// Read-only view of the origin host. The broker holds a key that sshd binds to one forced
// command (scripts/origin-agent/sck-origin-agent.py); the request travels as one JSON string
// and the agent answers one JSON object. No shell, no forwarding, no other command exists.
import { execFile } from 'node:child_process';
import { CompanyError } from '../core-errors.ts';
import type { OriginConfig } from './config.ts';

export type OriginRequest =
  | { op: 'status' }
  | { op: 'health' }
  | { op: 'logs'; service: string; since: string; lines: number; grep?: string; priority?: string };
export type OriginAgent = (origin: OriginConfig, request: OriginRequest) => Promise<Record<string, unknown>>;

/** Mirrors the agent's allowlist so a bad request is refused before any connection is made. */
export const ORIGIN_SERVICES = ['surreal-ck-hono', 'surrealdb', 'caddy'] as const;
const PRIORITIES = ['err', 'warning', 'info'];
const invalid = (message: string) => new CompanyError('invalid', message);

export function originLogsRequest(args: Record<string, unknown>): OriginRequest {
  const service = args.service;
  if (typeof service !== 'string' || !(ORIGIN_SERVICES as readonly string[]).includes(service)) throw invalid(`service must be one of ${ORIGIN_SERVICES.join(', ')}`);
  const since = args.since ?? '30m';
  const m = typeof since === 'string' ? /^(\d{1,4})([mh])$/.exec(since) : null;
  const minutes = m ? Number(m[1]) * (m[2] === 'h' ? 60 : 1) : 0;
  if (!m || minutes < 1 || minutes > 72 * 60) throw invalid('since must look like 30m or 6h, at most 72h');
  const lines = args.lines ?? 200;
  if (!Number.isInteger(lines) || (lines as number) < 1 || (lines as number) > 500) throw invalid('lines must be an integer from 1 to 500');
  const grep = args.grep;
  if (grep !== undefined && (typeof grep !== 'string' || !grep.length || grep.length > 100)) throw invalid('grep must be 1-100 characters (plain text, case-insensitive)');
  const priority = args.priority;
  if (priority !== undefined && (typeof priority !== 'string' || !PRIORITIES.includes(priority))) throw invalid('priority must be err, warning or info');
  return { op: 'logs', service, since: since as string, lines: lines as number, ...(grep ? { grep: grep as string } : {}), ...(priority ? { priority: priority as string } : {}) };
}

export const sshOriginAgent: OriginAgent = (origin, request) => new Promise((resolve, reject) => {
  const argv = [
    '-F', '/dev/null', '-i', origin.keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile="${origin.knownHosts}"`, '-o', 'ConnectTimeout=10',
    '-o', 'ClearAllForwardings=yes', '-T', `${origin.user}@${origin.host}`, JSON.stringify(request),
  ];
  execFile('/usr/bin/ssh', argv, { timeout: 45_000, maxBuffer: 1 << 20, env: { PATH: '/usr/bin:/bin' } }, (error, stdout, stderr) => {
    let reply: Record<string, unknown> | undefined;
    try { reply = JSON.parse(stdout); } catch { /* no answer from the agent */ }
    if (reply && typeof reply === 'object') {
      if (reply.ok === false) return reject(new CompanyError(reply.code === 'timeout' ? 'upstream_error' : 'invalid', String(reply.error ?? 'origin agent refused the request').slice(0, 200), reply.code === 'timeout'));
      return resolve(reply);
    }
    // ssh's own diagnostics name the failing step (host key, auth, connect); keep only the last line.
    const why = (error as NodeJS.ErrnoException & { killed?: boolean })?.killed ? 'timed out' : String(stderr).trim().split('\n').pop()?.slice(0, 200) || 'no answer';
    reject(new CompanyError('upstream_error', `origin host unreachable: ${why}`, true));
  });
});
