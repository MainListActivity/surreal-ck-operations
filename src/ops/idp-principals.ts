// IdP admin service principals (ma_hono `admin_service_principals`, migration 0014): revocable
// machine tokens for the invite/provision routes. The human admin session gate stays untouched —
// the broker reaches the same D1 it already writes for account provisioning, stores only the
// token hash there, and seals the token value in env_secret so no employee ever holds it.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CompanyError } from '../core-errors.ts';
import type { D1Client } from './d1.ts';
import { describeTransportFailure, type Fetcher } from './fetcher.ts';

const invalid = (message: string) => new CompanyError('invalid', message);

/** The only scopes a broker-minted principal may carry — matching the IdP's three scope-gated admin routes. */
export const SERVICE_PRINCIPAL_SCOPES = ['tenant.read', 'user.read', 'user.provision'] as const;

/** Same shape as ma_hono `mintServicePrincipalToken`: 32 random bytes, base64url, hash stored only. */
export const mintServicePrincipalToken = (): string => randomBytes(32).toString('base64url');

export const sha256Base64Url = async (value: string): Promise<string> =>
  createHash('sha256').update(value).digest('base64url');

const PRINCIPAL_ID = /^[A-Za-z0-9._-]{4,100}$/;

export function principalId(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!PRINCIPAL_ID.test(value)) throw invalid('principalId must be 4-100 chars of letters, digits, ., _ or -');
  return value;
}

/**
 * Where the token value is sealed: under the principal's own id, so `ops_idp_admin_request` can
 * resolve it from the only identifier an employee is allowed to name. Hyphens become underscores
 * to stay inside the env_secret naming alphabet; these names never parse as account aliases.
 */
export const principalTokenSecretName = (id: string) => `IDP_SP_${id.toUpperCase().replaceAll('-', '_')}`;

export const principalAliasSecretName = (sealAs: string) => `IDP_SP_${sealAs}`;

export interface ServicePrincipal {
  id: string;
  label: string;
  scopes: string[];
  status: string;
  createdAt: string;
  revokedAt: string | null;
  createdBy: string;
}

interface PrincipalRow {
  id: string;
  label: string;
  scopes: string;
  status: string;
  created_at: string;
  revoked_at: string | null;
  created_by: string;
}

const toPrincipal = (row: PrincipalRow): ServicePrincipal => ({
  id: row.id, label: row.label, scopes: JSON.parse(row.scopes) as string[],
  status: row.status, createdAt: row.created_at, revokedAt: row.revoked_at, createdBy: row.created_by,
});

export async function findServicePrincipal(d1: D1Client, id: string): Promise<ServicePrincipal | undefined> {
  const [row] = await d1.query<PrincipalRow>(
    'SELECT id, label, scopes, status, created_at, revoked_at, created_by FROM admin_service_principals WHERE id = ? LIMIT 1', [id]);
  return row ? toPrincipal(row) : undefined;
}

/**
 * Inserts the principal row exactly as the IdP's own mint would (`active`, JSON scope list,
 * `created_by` naming the ops caller). The IdP trusts the row itself; who wrote it is attributed
 * through the companion audit row, not the schema. The caller generates and seals the token first
 * (see the broker), so this only ever sees its hash.
 */
export async function insertServicePrincipal(input: {
  d1: D1Client;
  id?: string;
  label: string;
  tokenHash: string;
  createdBy: string;
  now?: () => Date;
}): Promise<ServicePrincipal> {
  const principal: ServicePrincipal = {
    id: input.id ?? randomUUID(), label: input.label, scopes: [...SERVICE_PRINCIPAL_SCOPES],
    status: 'active', createdAt: (input.now?.() ?? new Date()).toISOString(), revokedAt: null, createdBy: input.createdBy,
  };
  await input.d1.query(
    `INSERT INTO admin_service_principals (id, label, token_hash, scopes, status, created_at, revoked_at, created_by)
     VALUES (?, ?, ?, ?, 'active', ?, NULL, ?)`,
    [principal.id, principal.label, input.tokenHash, JSON.stringify(principal.scopes), principal.createdAt, principal.createdBy]);
  return principal;
}

/** Idempotent: an already-revoked principal reports its first revocation time, not a new row. */
export async function revokeServicePrincipal(input: {
  d1: D1Client;
  principalId: string;
  now?: () => Date;
}): Promise<{ principal: ServicePrincipal; alreadyRevoked: boolean }> {
  const principal = await findServicePrincipal(input.d1, input.principalId);
  if (!principal) throw new CompanyError('not_found', `no IdP service principal ${input.principalId}`);
  if (principal.status === 'revoked') return { principal, alreadyRevoked: true };
  const revokedAt = (input.now?.() ?? new Date()).toISOString();
  await input.d1.query(
    `UPDATE admin_service_principals SET status = 'revoked', revoked_at = ? WHERE id = ?`, [revokedAt, principal.id]);
  return { principal: { ...principal, status: 'revoked', revokedAt }, alreadyRevoked: false };
}

/**
 * The IdP-side audit row that the mint/revoke routes would have written, so `audit_events` keeps a
 * complete trail (`admin.service_principal.*` vocabulary, `management_token` actor = a machine
 * credential acting, `via` naming the ops broker as the writer). Best effort — a missing audit
 * table on an older IdP must not kill a working mint.
 */
export async function recordIdpAuditBestEffort(d1: D1Client, event: {
  actorType: string;
  actorId: string;
  tenantId?: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: string;
}): Promise<void> {
  try {
    await d1.query(
      `INSERT INTO audit_events (id, actor_type, actor_id, tenant_id, event_type, target_type, target_id, payload, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), event.actorType, event.actorId, event.tenantId ?? null, event.eventType,
        event.targetType, event.targetId, JSON.stringify(event.payload ?? null), event.occurredAt ?? new Date().toISOString()]);
  } catch { /* audit is compensating evidence, never the point of failure */ }
}

// ---------- /admin/* calls through a sealed principal token ----------

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 200_000;
const MAX_BODY_BYTES = 64 * 1024;

export class IdpAdminUnreachable extends CompanyError {
  constructor(message: string, readonly timedOut: boolean) {
    super('upstream_error', message, true);
  }
}

export interface IdpAdminResult { status: number; ok: boolean; body: unknown }

const TENANT_SEGMENT = /^[A-Za-z0-9._~-]{1,100}$/;

/**
 * The three service-principal-scoped routes and nothing else: `GET /admin/tenants`,
 * `GET /admin/tenants/<id>/users`, `POST /admin/tenants/<id>/users`. Everything else under
 * `/admin/*` — including `GET /admin/tenants/<id>` itself — is gated on a human admin session at
 * the IdP, so letting it through would only produce a confusing 403; refusing here keeps the
 * proxy surface exactly as wide as the credentials it carries.
 */
export function adminRequestTarget(rawMethod: unknown, rawPath: unknown): { method: 'GET' | 'POST'; path: string } {
  const method = typeof rawMethod === 'string' ? rawMethod.trim().toUpperCase() : '';
  if (method !== 'GET' && method !== 'POST') throw invalid('method must be GET or POST');
  const path = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (path.length > 200 || /[?#]/.test(path) || path.includes('//') || path.split('/').some(s => s === '.' || s === '..')) {
    throw invalid('path must be a plain IdP admin path without query or traversal');
  }
  if (path === '/admin/tenants') {
    if (method !== 'GET') throw invalid('GET is the only method allowed on /admin/tenants');
    return { method, path };
  }
  const users = /^\/admin\/tenants\/([^/]+)\/users$/.exec(path);
  if (users && TENANT_SEGMENT.test(users[1]!)) return { method, path };
  throw invalid('path must be GET /admin/tenants or /admin/tenants/<tenantId>/users (GET or POST); other /admin/* routes are human-admin only');
}

/** Sends the sealed token as the bearer and returns the upstream verdict; the token never leaves this call. */
export async function idpAdminRequest(
  idpOrigin: string, token: string,
  request: { method: string; path: string; body?: unknown },
  options: { fetch?: Fetcher; timeoutMs?: number } = {},
): Promise<IdpAdminResult> {
  let body: string | undefined;
  if (request.body !== undefined && request.method !== 'GET') {
    body = JSON.stringify(request.body);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw invalid('request body too large');
  }
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let response: Response;
  let raw: string;
  try {
    response = await (options.fetch ?? fetch)(`${idpOrigin}${request.path}`, {
      method: request.method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    raw = (await response.text().catch((error: Error) => { if (error.name === 'TimeoutError') throw error; return ''; })).slice(0, MAX_RESPONSE_CHARS);
  } catch (error) {
    const { timedOut, detail } = describeTransportFailure(error, timeoutMs);
    throw new IdpAdminUnreachable(`IdP admin request ${timedOut ? detail : `failed (${detail})`}`, timedOut);
  }
  let parsed: unknown = raw;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { /* plain text or truncated JSON */ }
  return { status: response.status, ok: response.ok, body: parsed };
}
