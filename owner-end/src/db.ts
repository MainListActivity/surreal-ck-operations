/**
 * 网关的 SurrealDB 会话。每个请求开一个连接，用调用方或网关自己的访问令牌登录，
 * 权限由数据库的 DEFINE ACCESS 与 EVENT 执行，网关不使用 root 账号。
 * 仅本地开发（.dev.vars 中配置了 DEV_DB_ROOT_*）时所有会话都以 root 连接，生产配置里没有这一项。
 */
import { Surreal } from 'surrealdb';
import { CompanyError } from '../../src/core-errors.ts';
import { openDb, type DbAuth } from '../../src/db-connection.ts';
import type { ClientCredential, Config } from './env.ts';
import { createMachineTokenCache, fetchMachineToken } from './idp/index.ts';

/** 每个调用方身份对应的一种会话。 */
export interface Sessions {
  /** 老板自己的令牌（ac=owner）：数据库按 owner 判断。 */
  owner(token: string): Promise<Surreal>;
  /** 网关机器令牌（ac=gateway）：员工命令经命令守卫后以此身份执行。 */
  gateway(): Promise<Surreal>;
  /** 查看者机器令牌（ac=viewer）：只读查询。 */
  viewer(): Promise<Surreal>;
  /** 定时任务机器令牌（ac=automation）。 */
  automation(): Promise<Surreal>;
}

async function open(cfg: Config, auth: DbAuth): Promise<Surreal> {
  const db = new Surreal();
  try {
    await openDb(db, { url: cfg.db.url, namespace: cfg.db.namespace, database: cfg.db.database, auth });
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  return db;
}

const machineTokens = new Map<string, () => Promise<string>>();

/** 机器客户端的令牌缓存，同一 isolate 内复用。 */
export function machineTokenFor(cfg: Config, client: ClientCredential): () => Promise<string> {
  const key = `${cfg.idp.tokenUrl} ${client.clientId}`;
  let get = machineTokens.get(key);
  if (!get) {
    get = createMachineTokenCache(() => fetchMachineToken({
      tokenUrl: cfg.idp.tokenUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
    }));
    machineTokens.set(key, get);
  }
  return get;
}

function requireClient(client: ClientCredential | undefined, name: string): ClientCredential {
  if (!client) throw new CompanyError('not_configured', `${name} 客户端未配置`);
  return client;
}

/** 生产会话的鉴权方式：令牌由调用方给出或由机器客户端取得。 */
function tokenAuth(token: string): DbAuth {
  return { kind: 'token', getToken: async () => token };
}

/** 按配置构造各身份的会话工厂。 */
export function sessionsOf(cfg: Config): Sessions {
  const dev: DbAuth | undefined = cfg.devRoot
    ? { kind: 'root', username: cfg.devRoot.username, password: cfg.devRoot.password }
    : undefined;
  const machine = (client: ClientCredential | undefined, name: string) => async (): Promise<Surreal> => {
    if (dev) return open(cfg, dev);
    const credential = requireClient(client, name);
    return open(cfg, tokenAuth(await machineTokenFor(cfg, credential)()));
  };
  return {
    owner: (token) => open(cfg, dev ?? tokenAuth(token)),
    gateway: machine(cfg.gateway, 'IDP_GATEWAY_CLIENT（GATEWAY_CLIENT_ID、GATEWAY_CLIENT_SECRET）'),
    viewer: machine(cfg.viewer, 'IDP_VIEWER_CLIENT（VIEWER_CLIENT_ID、VIEWER_CLIENT_SECRET）'),
    automation: machine(cfg.cron, '定时任务客户端（CRON_CLIENT_ID、CRON_CLIENT_SECRET）'),
  };
}

/** 用完即关；关闭失败不影响结果。 */
export async function withSession<T>(db: Surreal, run: (db: Surreal) => Promise<T>): Promise<T> {
  try {
    return await run(db);
  } finally {
    await db.close().catch(() => undefined);
  }
}
