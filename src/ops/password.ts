import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(pbkdf2);
const ALGORITHM = 'pbkdf2_sha256';
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_ITERATIONS = 1_000_000;

/**
 * The IdP's own password format (ma_hono src/domain/users/passwords.ts):
 * `pbkdf2_sha256$<iterations>$<base64url salt>$<base64url digest>`. Hashes written here must
 * verify in the IdP, and hashes the IdP wrote must verify here.
 */
export async function hashPassword(password: string, salt: Buffer = randomBytes(SALT_BYTES), iterations = ITERATIONS): Promise<string> {
  const digest = await derive(password, salt, iterations, KEY_BYTES, 'sha256');
  return [ALGORITHM, String(iterations), salt.toString('base64url'), digest.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, rawIterations, rawSalt, rawDigest, ...extra] = stored.split('$');
  if (algorithm !== ALGORITHM || !rawIterations || !rawSalt || !rawDigest || extra.length) return false;
  const iterations = Number(rawIterations);
  if (!Number.isInteger(iterations) || iterations <= 0 || iterations > MAX_ITERATIONS) return false;
  const expected = Buffer.from(rawDigest, 'base64url');
  if (!expected.length) return false;
  const actual = await derive(password, Buffer.from(rawSalt, 'base64url'), iterations, expected.length, 'sha256');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 32 URL-safe characters (192 bits); the IdP enforces no composition policy on hashes it never sees in clear. */
export const generatePassword = (): string => randomBytes(24).toString('base64url');
