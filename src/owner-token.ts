/** 老板令牌：<service home>/private/owner-token（0600）。启动/install 时不存在就生成；员工沙箱禁读 private/。 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OWNER_TOKEN_FILE = 'owner-token';
export const OWNER_TOKEN_HEADER = 'authorization';
export const OWNER_AGENT_HEADER = 'x-owner-agent';

export function ownerTokenPath(home: string): string { return join(home, 'private', OWNER_TOKEN_FILE); }

export function ensureOwnerToken(home: string): string {
  const dir = join(home, 'private');
  const file = ownerTokenPath(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  if (existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim();
    if (value.length >= 16) { try { chmodSync(file, 0o600); } catch {} return value; }
  }
  const token = `sck_${randomBytes(32).toString('base64url')}`;
  writeFileSync(file, token + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
  return token;
}
