// 只解码 JWT payload 读取 exp，不验签；调用方不能把它当作信任依据，只用于估算过期时间。
const B64URL = /^[A-Za-z0-9_-]+$/;

/** 返回令牌的过期时间（epoch 毫秒）；无 exp 或格式不对返回 undefined。 */
export function jwtExpiryMs(token: string): number | undefined {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || !B64URL.test(parts[1] ?? '')) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;
  return exp * 1000;
}
