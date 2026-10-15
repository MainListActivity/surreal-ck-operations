import { CompanyError } from '../core-errors.ts';
import type { D1Client } from './d1.ts';

const CLAIM_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const CLAIM_SOURCES = ['fixed', 'user_field', 'hook'] as const;
const MAX_QUALIFIER_CHARS = 500;
const LIST_LIMIT = 200;

const invalid = (message: string) => new CompanyError('invalid', message);

/** Claim names land inside JWT payloads, so the charset stays deliberately narrow. */
export function claimName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!CLAIM_NAME.test(name)) {
    throw invalid('claim_name must be 1-64 chars starting with a letter or _, then letters, digits, _, ., : or -');
  }
  return name;
}

/** Public view of a registered client row; the claims table keys on the internal `id`. */
export interface ClientRef {
  /** oidc_clients.id — the internal UUID `client_access_token_claims.client_id` points at. */
  id: string;
  /** oidc_clients.client_id — the public identifier callers pass around. */
  clientId: string;
  clientName: string;
}

interface ClientRefRow { id: string; client_id: string; client_name: string }

/** Resolves a caller-facing client_name/client_id to the internal row the claims table joins on. */
export async function resolveClient(
  d1: D1Client, tenantId: string, key: { clientName: string } | { clientId: string },
): Promise<ClientRef | undefined> {
  const rows = 'clientName' in key
    ? await d1.query<ClientRefRow>('SELECT id, client_id, client_name FROM oidc_clients WHERE tenant_id = ? AND client_name = ? LIMIT 1', [tenantId, key.clientName])
    : await d1.query<ClientRefRow>('SELECT id, client_id, client_name FROM oidc_clients WHERE tenant_id = ? AND client_id = ? LIMIT 1', [tenantId, key.clientId]);
  const row = rows[0];
  return row ? { id: row.id, clientId: row.client_id, clientName: row.client_name } : undefined;
}

/**
 * Optional equality qualifiers for narrowing a delete (or a pre-delete list) to exactly the
 * malformed rows: `fixed_value` is text verbatim, and an explicit null qualifier asks for the
 * SQL NULL column (`IS ?` binds both shapes). Keys are whitelisted column names, never raw SQL.
 */
export interface ClaimQualifiers {
  sourceType?: string | null;
  fixedValue?: string | null;
  userField?: string | null;
  hookField?: string | null;
}

export function claimQualifiers(args: Record<string, unknown>): ClaimQualifiers {
  const text = (key: string): string | null | undefined => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string' || value.length > MAX_QUALIFIER_CHARS) {
      throw invalid(`${key} must be a string up to ${MAX_QUALIFIER_CHARS} chars, or null`);
    }
    return value;
  };
  const sourceType = text('source_type');
  if (sourceType !== undefined && sourceType !== null && !(CLAIM_SOURCES as readonly string[]).includes(sourceType)) {
    throw invalid(`source_type must be one of ${CLAIM_SOURCES.join(', ')}, or null`);
  }
  return { sourceType, fixedValue: text('fixed_value'), userField: text('user_field'), hookField: text('hook_field') };
}

const QUALIFIER_COLUMNS: ReadonlyArray<[keyof ClaimQualifiers, string]> = [
  ['sourceType', 'source_type'], ['fixedValue', 'fixed_value'], ['userField', 'user_field'], ['hookField', 'hook_field'],
];

/** `col IS ?` reads as equality for values and as IS NULL for null qualifiers. */
function qualifierWhere(q: ClaimQualifiers, columnPrefix: string): { sql: string; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of QUALIFIER_COLUMNS) {
    if (q[key] !== undefined) { sql.push(` AND ${columnPrefix}${column} IS ?`); params.push(q[key]); }
  }
  return { sql: sql.join(''), params };
}

/** Renders qualifiers for the delete audit line, e.g. `source_type=fixed fixed_value=NULL`. */
export function describeQualifiers(q: ClaimQualifiers): string {
  return QUALIFIER_COLUMNS.filter(([key]) => q[key] !== undefined)
    .map(([key, column]) => `${column}=${q[key] === null ? 'NULL' : JSON.stringify(q[key])}`)
    .join(' ');
}

export interface ClientClaim {
  clientId: string;
  clientName: string;
  claimName: string;
  sourceType: string;
  fixedValue: string | null;
  userField: string | null;
  hookField: string | null;
}

interface ClaimRow {
  claim_name: string; source_type: string;
  fixed_value: string | null; user_field: string | null; hook_field: string | null;
}

const CLAIM_COLUMN_NAMES = ['claim_name', 'source_type', 'fixed_value', 'user_field', 'hook_field'] as const;
const CLAIM_COLUMNS = CLAIM_COLUMN_NAMES.join(', ');

const toClaim = (client: { clientId: string; clientName: string }, row: ClaimRow): ClientClaim => ({
  clientId: client.clientId, clientName: client.clientName,
  claimName: row.claim_name, sourceType: row.source_type,
  fixedValue: row.fixed_value, userField: row.user_field, hookField: row.hook_field,
});

export interface ClaimList {
  claims: ClientClaim[];
  /** True when the tenant holds more rows than the returned page; narrow with qualifiers. */
  truncated: boolean;
}

/** Every claim row of one client, optionally narrowed to a single claim_name and qualifiers. */
export async function listClientClaims(
  d1: D1Client, tenantId: string, client: ClientRef, name: string | undefined, q: ClaimQualifiers,
): Promise<ClaimList> {
  const qualifier = qualifierWhere(q, '');
  const rows = await d1.query<ClaimRow>(
    `SELECT ${CLAIM_COLUMNS} FROM client_access_token_claims
     WHERE tenant_id = ? AND client_id = ?${name !== undefined ? ' AND claim_name = ?' : ''}${qualifier.sql}
     ORDER BY claim_name LIMIT ${LIST_LIMIT + 1}`,
    [tenantId, client.id, ...(name !== undefined ? [name] : []), ...qualifier.params]);
  return { claims: rows.slice(0, LIST_LIMIT).map(row => toClaim(client, row)), truncated: rows.length > LIST_LIMIT };
}

interface ScanRow extends ClaimRow { client_id: string; client_name: string }

/**
 * Tenant-wide scan for one claim_name across all clients — the way to locate every row of a
 * malformed claim (e.g. all RL claims stored as plain strings) before deleting them.
 */
export async function scanClaimsByName(
  d1: D1Client, tenantId: string, name: string, q: ClaimQualifiers,
): Promise<ClaimList> {
  const qualifier = qualifierWhere(q, 'c.');
  const rows = await d1.query<ScanRow>(
    `SELECT ${CLAIM_COLUMN_NAMES.map(c => `c.${c}`).join(', ')}, o.client_id, o.client_name
     FROM client_access_token_claims c JOIN oidc_clients o ON o.id = c.client_id AND o.tenant_id = c.tenant_id
     WHERE c.tenant_id = ? AND c.claim_name = ?${qualifier.sql}
     ORDER BY o.client_name, o.client_id LIMIT ${LIST_LIMIT + 1}`,
    [tenantId, name, ...qualifier.params]);
  return {
    claims: rows.slice(0, LIST_LIMIT).map(row => toClaim({ clientId: row.client_id, clientName: row.client_name }, row)),
    truncated: rows.length > LIST_LIMIT,
  };
}

/**
 * Deletes the claim rows under one client matching claim_name plus the equality qualifiers, in a
 * single `DELETE ... RETURNING` so the answer is exactly the rows that were removed. An empty
 * match deletes nothing and reports zero rows to the caller (which maps it to not_found).
 */
export async function deleteClientClaims(
  d1: D1Client, tenantId: string, client: ClientRef, name: string, q: ClaimQualifiers,
): Promise<ClientClaim[]> {
  const qualifier = qualifierWhere(q, '');
  const rows = await d1.query<ClaimRow>(
    `DELETE FROM client_access_token_claims
     WHERE tenant_id = ? AND client_id = ? AND claim_name = ?${qualifier.sql}
     RETURNING ${CLAIM_COLUMNS}`,
    [tenantId, client.id, name, ...qualifier.params]);
  return rows.map(row => toClaim(client, row));
}
