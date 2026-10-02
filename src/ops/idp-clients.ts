import { randomUUID } from 'node:crypto';
import { CompanyError } from '../core-errors.ts';
import type { D1Client } from './d1.ts';

const CLIENT_NAME = /^[a-z][a-z0-9-]{1,62}$/;
const MAX_REDIRECT_URIS = 10;

const invalid = (message: string) => new CompanyError('invalid', message);

/**
 * Public client names double as the idempotency key (`tenant_id` + `client_name`),
 * so they are kept to a conservative slug shape.
 */
export function spaClientName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!CLIENT_NAME.test(name)) throw invalid('client_name must be 2-63 chars of lowercase letters, digits or hyphens');
  return name;
}

/**
 * An absolute https URL on the product host: public clients this tool creates only ever serve
 * the company's own surfaces, so off-domain or non-https callbacks/audiences are refused.
 */
function urlOnHost(raw: unknown, allowedHost: string, what: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw invalid(`${what} is required`);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalid(`${what} must be an absolute URL`);
  }
  if (url.protocol !== 'https:') throw invalid(`${what} must be https`);
  if (url.username || url.password) throw invalid(`${what} must not embed credentials`);
  if (url.hostname !== allowedHost) throw invalid(`${what} must be on ${allowedHost}`);
  return url.toString();
}

export function redirectUriList(raw: unknown, allowedHost: string): string[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_REDIRECT_URIS) {
    throw invalid(`redirect_uris must be a list of 1-${MAX_REDIRECT_URIS} URLs`);
  }
  return raw.map((entry, index) => urlOnHost(entry, allowedHost, `redirect_uris[${index}]`));
}

export function audienceUrl(raw: unknown, allowedHost: string): string {
  return urlOnHost(raw, allowedHost, 'access_token_audience');
}

export interface RegisterSpaClientInput {
  d1: D1Client;
  tenantId: string;
  clientName: string;
  redirectUris: string[];
  accessTokenAudience: string;
  now?: () => Date;
}

export type RegisterSpaClientResult = { clientId: string; result: 'created' | 'exists' };

interface ClientRow { client_id: string }

/**
 * Registers an OIDC public SPA client row the IdP's dynamic-registration endpoint cannot
 * express (`client_profile='spa'` + `token_endpoint_auth_method='none'`): the ma_hono
 * `oidc_clients` columns are written verbatim from `src/adapters/db/drizzle/schema.ts`,
 * with no client secret (public clients have none). Idempotent on (tenant, client_name):
 * a replayed call returns the existing row's client_id instead of inserting a second row.
 */
export async function registerSpaClient(input: RegisterSpaClientInput): Promise<RegisterSpaClientResult> {
  const { d1, tenantId } = input;
  const [existing] = await d1.query<ClientRow>(
    'SELECT client_id FROM oidc_clients WHERE tenant_id = ? AND client_name = ? LIMIT 1', [tenantId, input.clientName]);
  if (existing) return { clientId: existing.client_id, result: 'exists' };

  const stamp = () => (input.now?.() ?? new Date()).toISOString();
  const clientId = randomUUID();
  await d1.query(
    `INSERT INTO oidc_clients (
      id, tenant_id, client_id, client_secret_hash, client_name, application_type,
      trust_level, consent_policy, client_profile, access_token_audience, allowed_scopes,
      initiate_login_uri, claim_hook_url, claim_hook_auth_header_name, claim_hook_auth_header_value,
      token_endpoint_auth_method, redirect_uris, grant_types, response_types, created_by,
      created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, 'web', 'first_party_trusted', 'skip', 'spa', ?, NULL,
      NULL, NULL, NULL, NULL, 'none', ?, '["authorization_code"]', '["code"]', 'ops_broker', ?, ?)`,
    [
      randomUUID(), tenantId, clientId, input.clientName, input.accessTokenAudience,
      JSON.stringify(input.redirectUris), stamp(), stamp(),
    ]);
  return { clientId, result: 'created' };
}
