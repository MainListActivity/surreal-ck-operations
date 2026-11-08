/** 老板令牌：<service home>/private/owner-token（0600）。启动/install 时不存在就生成；员工沙箱禁读 private/。 */
import { randomBytes } from 'node:crypto';
import { hostIO } from './host-io.ts';

export const OWNER_TOKEN_FILE = 'owner-token';
export const OWNER_TOKEN_HEADER = 'authorization';
export const OWNER_AGENT_HEADER = 'x-owner-agent';

export function ownerTokenPath(home: string): string { return hostIO().path.join(home, 'private', OWNER_TOKEN_FILE); }

export function ensureOwnerToken(home: string): string {
  const { fs, path } = hostIO();
  const dir = path.join(home, 'private');
  const file = ownerTokenPath(home);
  fs.mkdirp(dir, 0o700);
  try { fs.chmod(dir, 0o700); } catch { /* best effort */ }
  if (fs.exists(file)) {
    const value = fs.readText(file).trim();
    if (value.length >= 16) { try { fs.chmod(file, 0o600); } catch {} return value; }
  }
  const token = `sck_${randomBytes(32).toString('base64url')}`;
  fs.writeText(file, token + '\n', 0o600);
  try { fs.chmod(file, 0o600); } catch { /* best effort */ }
  return token;
}
