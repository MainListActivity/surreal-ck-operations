/**
 * 网关单测的共用替身：本地 RSA 密钥与令牌、测试配置、脚本化的假数据库。
 * 不访问网络，不读 process.env；只被 *.test.ts 引用（bun test 不会把本文件当成测试）。
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import type { Surreal } from 'surrealdb';
import { readConfig, type Config, type Env } from '../src/env.ts';

export const ISSUER = 'https://o.test.invalid/t/company';
export const JWKS_URL = `${ISSUER}/jwks.json`;
export const DB_URL = 'wss://db.test.invalid/rpc';

/** 与 wrangler.jsonc 同形的环境变量（不含任何密钥）。 */
export function testEnv(extra: Partial<Record<keyof Env, string>> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    IDP_ISSUER: ISSUER,
    IDP_JWKS_URL: JWKS_URL,
    CONSOLE_CLIENT_ID: 'console-client-id',
    COMPANY_DB_URL: DB_URL,
    COMPANY_NS: 'company',
    COMPANY_DB: 'main',
    ...extra,
  } as Env;
}

export function testConfig(extra: Partial<Record<keyof Env, string>> = {}): Config {
  return readConfig(testEnv(extra));
}

export interface KeyFixture {
  keys: JWTVerifyGetKey;
  privateKey: CryptoKey;
  kid: string;
}

/** 生成一对 RS256 密钥，返回本地密钥集（代替 ma_hono 的 JWKS）与私钥（用于签发测试令牌）。 */
export async function keyFixture(kid = 'test-kid'): Promise<KeyFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { keys: createLocalJWKSet({ keys: [jwk] }), privateKey, kid };
}

export interface TokenOptions {
  issuer?: string;
  audience?: string;
  /** 相对时长（如 '15m'）或绝对的 Unix 秒。缺省 15 分钟后过期。 */
  expiresIn?: string | number;
}

/** 签发测试令牌。缺省是老板令牌（ac=owner、rl=Owner、ns=company、db=main）；claims 可覆盖任意声明。 */
export async function signToken(
  key: KeyFixture,
  claims: Record<string, unknown> = {},
  options: TokenOptions = {},
): Promise<string> {
  const payload: Record<string, unknown> = {
    sub: 'owner-user',
    ac: 'owner',
    rl: ['Owner'],
    ns: 'company',
    db: 'main',
    ...claims,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? 'company')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '15m')
    .sign(key.privateKey);
}

export interface FakeCall {
  sql: string;
  vars: Record<string, unknown>;
}

/**
 * 脚本化的假数据库。respond 按语句文本返回该语句的结果行；每次 query 返回 [rows]，与 SurrealDB 的结果形状一致。
 * calls 记录每一条语句与变量，供断言（例如审计是否写入、哪些语句被执行）。
 */
export function fakeDb(respond: (sql: string, vars: Record<string, unknown>) => unknown[] = () => []) {
  const calls: FakeCall[] = [];
  const db = {
    async query(sql: string, vars: Record<string, unknown> = {}) {
      calls.push({ sql, vars });
      return [respond(sql, vars)];
    },
    async close() {
      return undefined;
    },
  };
  return { db: db as unknown as Surreal, calls };
}

/** 四种会话都返回同一个假数据库。 */
export function fakeSessions(db: Surreal) {
  return {
    owner: async () => db,
    gateway: async () => db,
    viewer: async () => db,
    automation: async () => db,
  };
}

/** 把一组脚本化的 fetch 响应串起来；每次调用取下一个，并记录请求。 */
export function scriptedFetch(responses: Array<(request: Request) => Response>) {
  const requests: Request[] = [];
  let index = 0;
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request);
    const next = responses[index++];
    if (!next) throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    return next(request);
  };
  return { fetch: fetchFn as typeof fetch, requests };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
