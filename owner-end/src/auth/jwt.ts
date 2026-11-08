/**
 * 访问令牌验签（ma_hono 的 JWKS，jose 远程密钥集缓存）。
 * 只接受非对称算法；声明不符（签发者、受众、ns/db）一律拒绝。错误信息不包含令牌内容。
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { CompanyError } from '../../../src/core-errors.ts';
import type { Config } from '../env.ts';

/** 网关用得到的已验签声明。token 只在服务端内存里使用，不写日志。 */
export interface VerifiedToken {
  token: string;
  /** 人类用户为用户 id；机器令牌为客户端 id。 */
  sub: string;
  /** SurrealDB 访问方式：owner、agent、viewer、gateway、runner、automation、migrator。 */
  ac: string;
  roles: string[];
  exp: number;
  /** 员工令牌绑定的任务（token exchange 产生）。 */
  task?: string;
  /** 员工令牌的调用方客户端（act.sub）。 */
  actClient?: string;
}

const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

const keySets = new Map<string, JWTVerifyGetKey>();

/** 按 JWKS 地址取远程密钥集；同一地址在同一 isolate 内复用缓存。 */
export function jwksFor(url: string): JWTVerifyGetKey {
  let keys = keySets.get(url);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
    keySets.set(url, keys);
  }
  return keys;
}

function rolesOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

/** 验证一个访问令牌，返回网关需要的声明。keys 可注入（测试用本地密钥集）。 */
export async function verifyAccessToken(
  token: string,
  cfg: Config,
  keys: JWTVerifyGetKey = jwksFor(cfg.idp.jwksUrl),
): Promise<VerifiedToken> {
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, keys, {
      issuer: cfg.idp.issuer,
      audience: cfg.idp.audience,
      algorithms: ALGORITHMS,
    });
    payload = verified.payload;
  } catch {
    throw new CompanyError('unauthorized', '令牌无效或已过期');
  }
  if (payload.ns !== cfg.db.namespace || payload.db !== cfg.db.database) {
    throw new CompanyError('forbidden', '令牌不属于本公司库');
  }
  if (typeof payload.ac !== 'string' || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') {
    throw new CompanyError('unauthorized', '令牌缺少必要声明');
  }
  const act = payload.act as { sub?: unknown } | undefined;
  return {
    token,
    sub: payload.sub,
    ac: payload.ac,
    roles: rolesOf(payload.rl),
    exp: payload.exp,
    task: typeof payload.task === 'string' ? payload.task : undefined,
    actClient: typeof act?.sub === 'string' ? act.sub : undefined,
  };
}
