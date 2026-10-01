import { randomUUID } from 'node:crypto';
import { CompanyError } from '../core-errors.ts';
import type { D1Client } from './d1.ts';
import { generatePassword, hashPassword, verifyPassword } from './password.ts';

const ALIAS = /^[A-Z0-9][A-Z0-9_]{0,39}$/;

/** `qa-ops-lca11` and `QA_OPS_LCA11` are one alias; it names the account and its sealed password. */
export function canonicalAlias(raw: unknown): string {
  const alias = typeof raw === 'string' ? raw.trim().toUpperCase().replaceAll('-', '_') : '';
  if (!ALIAS.test(alias)) throw new CompanyError('invalid', 'alias must be 1-40 letters, digits, - or _');
  return alias;
}

export const passwordSecretName = (alias: string) => `${alias}_PASSWORD`;
export const aliasFromSecretName = (name: string): string | undefined => /^([A-Z0-9][A-Z0-9_]*)_PASSWORD$/.exec(name)?.[1];
export const accountUsername = (alias: string, prefix: string) => `${prefix}${alias.toLowerCase().replaceAll('_', '-')}`;
export const accountEmail = (username: string, emailDomain: string) => `${username}@${emailDomain}`;

export interface EnsureAccountInput {
  d1: D1Client;
  tenantId: string;
  username: string;
  email: string;
  /** Password the company already sealed for this alias, if any. */
  sealed?: string;
  /** Called with a new password BEFORE the IdP row is written, so a crash never loses the only copy. */
  seal: (password: string) => Promise<void>;
  /** Quota gate, run only when a brand-new IdP user is about to be inserted. */
  beforeCreate?: () => Promise<void>;
  now?: () => Date;
}

export type EnsureAccountResult = { result: 'created' | 'repaired' | 'exists'; password: string };

interface UserRow { id: string; status: string; email: string }
interface CredentialRow { id: string; password_hash: string }

/**
 * Makes the IdP hold exactly one active password account whose sealed password matches:
 * creates it, or resets a credential that drifted (for example after an employee reset it
 * out of band). Only the caller-supplied, prefix-checked username is ever touched.
 */
export async function ensureAccount(input: EnsureAccountInput): Promise<EnsureAccountResult> {
  const { d1, tenantId, username, email } = input;
  const stamp = () => (input.now?.() ?? new Date()).toISOString();
  const [user] = await d1.query<UserRow>(
    'SELECT id, status, email FROM users WHERE tenant_id = ? AND username = ? LIMIT 1', [tenantId, username]);

  if (!user) {
    const [taken] = await d1.query<{ username: string | null }>(
      'SELECT username FROM users WHERE tenant_id = ? AND email = ? LIMIT 1', [tenantId, email]);
    if (taken) throw new CompanyError('conflict', `email ${email} already belongs to another account`);
    await input.beforeCreate?.();
    const password = input.sealed ?? generatePassword();
    if (!input.sealed) await input.seal(password);
    const userId = randomUUID();
    await d1.query(
      'INSERT INTO users (id, tenant_id, email, email_verified, username, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)',
      [userId, tenantId, email, username, username, 'active', stamp(), stamp()]);
    await d1.query(
      'INSERT INTO user_password_credentials (id, tenant_id, user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), tenantId, userId, await hashPassword(password), stamp(), stamp()]);
    return { result: 'created', password };
  }

  if (user.status !== 'active') throw new CompanyError('conflict', `account ${username} exists but is ${user.status}; ask the owner to re-enable it`);
  const [credential] = await d1.query<CredentialRow>(
    'SELECT id, password_hash FROM user_password_credentials WHERE tenant_id = ? AND user_id = ? LIMIT 1', [tenantId, user.id]);
  if (credential && input.sealed && await verifyPassword(input.sealed, credential.password_hash)) {
    return { result: 'exists', password: input.sealed };
  }

  const password = generatePassword();
  await input.seal(password);
  const hash = await hashPassword(password);
  if (credential) {
    await d1.query('UPDATE user_password_credentials SET password_hash = ?, updated_at = ? WHERE id = ?', [hash, stamp(), credential.id]);
  } else {
    await d1.query(
      'INSERT INTO user_password_credentials (id, tenant_id, user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), tenantId, user.id, hash, stamp(), stamp()]);
  }
  return { result: 'repaired', password };
}
