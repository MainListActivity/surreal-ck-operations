/**
 * 请求方身份，只认 Authorization: Bearer 令牌（页面在浏览器里用 PKCE 取得，见 src/ui/auth.ts）。
 * 访问方式决定能做什么：owner 老板（全部老板命令）；agent 员工（带任务绑定，经命令守卫）；
 * gateway、runner、automation、migrator、viewer 是系统身份，不能调用网关接口。
 */
import type { JWTVerifyGetKey } from 'jose';
import { CompanyError } from '../../../src/core-errors.ts';
import type { Config } from '../env.ts';
import { verifyAccessToken, type VerifiedToken } from './jwt.ts';

export type Caller =
  | { kind: 'owner'; sub: string; token: VerifiedToken }
  | { kind: 'agent'; sub: string; task: string; token: VerifiedToken }
  | { kind: 'system'; ac: string; sub: string; token: VerifiedToken };

const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SYSTEM_ACCESS = new Set(['gateway', 'runner', 'automation', 'migrator', 'viewer']);
const BEARER = /^Bearer\s+(\S+)$/i;

/** 把已验签的令牌归入身份类别。 */
export function callerOf(token: VerifiedToken): Caller {
  if (token.ac === 'owner') {
    if (!token.roles.includes('Owner')) throw new CompanyError('forbidden', '令牌缺少老板角色');
    return { kind: 'owner', sub: token.sub, token };
  }
  if (token.ac === 'agent') {
    if (!token.task || !TASK_ID.test(token.task)) throw new CompanyError('forbidden', '员工令牌缺少任务绑定');
    return { kind: 'agent', sub: token.sub, task: token.task, token };
  }
  if (SYSTEM_ACCESS.has(token.ac)) return { kind: 'system', ac: token.ac, sub: token.sub, token };
  throw new CompanyError('forbidden', '令牌的访问方式不被识别');
}

/** 识别请求方。没有 Bearer 令牌即未登录；令牌格式、签名、签发者、受众或过期任一不符都视为未授权。 */
export async function authenticate(request: Request, cfg: Config, keys?: JWTVerifyGetKey): Promise<Caller> {
  const header = request.headers.get('authorization');
  if (header === null) throw new CompanyError('unauthorized', '请先登录');
  const match = BEARER.exec(header.trim());
  if (!match) throw new CompanyError('unauthorized', '认证头格式不正确');
  return callerOf(await verifyAccessToken(match[1]!, cfg, keys));
}
