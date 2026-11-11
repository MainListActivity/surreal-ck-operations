/**
 * 页面的数据来源：用老板自己的令牌直连公司库。
 * - 权限由库里的 DEFINE ACCESS（JWKS 校验 ma_hono 令牌）与表权限执行，和原后端用老板令牌连库完全一样。
 * - LIVE 只订阅记录 id，用作“哪张表变了”的失效通知；页面收到后重新计算。
 * - 大盘与看板用共享核心在浏览器里计算，结果过一次 JSON 序列化，和原 HTTP 接口的形状逐字段一致。
 * 本地设计模式（demo/server.ts）把本模块替换为 demo/source.ts，不连接任何数据库。
 */
import { AuthenticationError, InvalidSessionError, NotAllowedError, Surreal, Table } from 'surrealdb';
import { readBoard } from '../../../src/board.ts';
import { readRuntimeDashboard, type RuntimeDashboard } from '../../../src/runtime-dashboard.ts';
import { LIVE_TABLES } from '../live-tables.ts';
import { accessToken, currentSession, loadConfig, refreshSession } from './auth.ts';
import { SessionKeeper } from './session-keeper.ts';
import type { OwnerBoard } from './types.ts';

export type LiveState = 'connecting' | 'live' | 'offline';

export interface LiveHandlers {
  change(tables: string[]): void;
  state(state: LiveState): void;
  unauthorized(): void;
  /** 首次建立失败（不含 SDK 自动重连期间）；调用方关闭后按退避重新打开。 */
  failed(): void;
}

/** 数据读取失败的分类：unauthorized 走重新登录，network 显示连接问题，其余显示原因。 */
export class SourceError extends Error {
  constructor(readonly code: 'unauthorized' | 'network' | 'unavailable', message = '') {
    super(message);
  }
}

/** 令牌在这之内到期就先续期再交给库，避免把将过期的令牌用于新会话。 */
const RENEW_WITHIN_MS = 5 * 60_000;
/** 同一批变更合并成一次通知，避免一次写入多表时页面连续重算。 */
const FLUSH_MS = 150;
/** 会话保活的检查间隔（按真实时钟判断，休眠唤醒后第一次检查就会补上）。 */
const SESSION_TICK_MS = 30_000;

let connection: Promise<Surreal> | undefined;
let keeper: SessionKeeper | undefined;
let rejected = false;
/** 保活时发现令牌已无法续期：通知打开中的 LIVE 回登录页。 */
const sessionLost = new Set<() => void>();

async function token(): Promise<string | null> {
  const session = currentSession();
  if (session && session.expiresAt - Date.now() < RENEW_WITHIN_MS) await refreshSession();
  const value = await accessToken();
  if (!value) rejected = true;
  return value ?? null;
}

/**
 * 只有鉴权本身失败才算未登录（会清会话、回登录页）。表权限拒绝、库里事件抛出的业务错误等按普通错误处理，
 * 不能因为消息里带 token / permission / expired 之类的词就退出登录。
 */
export function isAuthFailure(error: unknown): boolean {
  if (rejected) return true;
  if (error instanceof SourceError) return error.code === 'unauthorized';
  if (error instanceof AuthenticationError || error instanceof InvalidSessionError) return true;
  return error instanceof NotAllowedError && (error.isTokenExpired || error.isInvalidAuth);
}

async function open(): Promise<Surreal> {
  const cfg = await loadConfig();
  if (!cfg.db) throw new SourceError('unavailable', '登录配置缺少公司库地址');
  const db = new Surreal();
  rejected = false;
  const session = new SessionKeeper(async () => {
    const value = await token();
    if (!value) throw new SourceError('unauthorized');
    await db.authenticate(value);
  });
  db.subscribe('connected', () => session.authenticated());
  try {
    await db.connect(cfg.db.url, {
      namespace: cfg.db.namespace,
      database: cfg.db.database,
      // 每次建会话、续期、断线重连都会重新取令牌；auth.ts 负责用 refresh_token 续期。
      authentication: token,
      expiryMargin: 30,
      reconnect: { enabled: true, attempts: -1, retryDelay: 1000, retryDelayMax: 30_000 },
    });
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  session.authenticated();
  keeper = session;
  setInterval(() => {
    session.ensure().catch((error: unknown) => {
      // 网络问题交给 SDK 重连与下一次检查；令牌续不上才回登录页。
      if (isAuthFailure(error)) for (const fn of [...sessionLost]) fn();
    });
  }, SESSION_TICK_MS);
  return db;
}

/** 库回复会话过期（details: Auth / SessionExpired）。SDK 没有对应的判断属性。 */
export function isSessionExpired(error: unknown): boolean {
  const details = (error as { details?: { kind?: string; details?: { kind?: string } } } | null)?.details;
  return error instanceof NotAllowedError && details?.kind === 'Auth' && details.details?.kind === 'SessionExpired';
}

/**
 * 读数据前确保会话未过期（休眠唤醒后计时器可能还没来得及续期）；
 * 仍收到会话过期就立即重新鉴权（同时触发 LIVE 重建）并重试一次。
 */
async function withSession<T>(read: (db: Surreal) => Promise<T>): Promise<T> {
  const db = await database();
  await keeper?.ensure();
  try {
    return await read(db);
  } catch (error) {
    if (!keeper || !isSessionExpired(error)) throw error;
    await keeper.ensure(true);
    return read(db);
  }
}

/** 全页面共用一个连接；连接失败后下次调用重新建立。 */
function database(): Promise<Surreal> {
  if (!connection) {
    connection = open().catch((error) => {
      connection = undefined;
      throw error;
    });
  }
  return connection;
}

function classify(error: unknown): SourceError {
  if (error instanceof SourceError) return error;
  if (isAuthFailure(error)) return new SourceError('unauthorized');
  return new SourceError('network');
}

/** 与 HTTP 接口相同的序列化：RecordId、DateTime 等转为字符串。 */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function readDashboardData(): Promise<RuntimeDashboard> {
  try {
    return plain(await withSession(readRuntimeDashboard));
  } catch (error) {
    throw classify(error);
  }
}

export async function readBoardData(): Promise<OwnerBoard> {
  try {
    return plain(await withSession(readBoard)) as unknown as OwnerBoard;
  } catch (error) {
    throw classify(error);
  }
}

/**
 * 订阅全部老板端表的变更。连上（含断线重连成功）时通知 ['*'] 让页面全量重读；
 * 断线重连后 SDK 会自动重建托管的 LIVE 订阅（ManagedLiveSubscription 在 connected 时重新注册）。
 * LIVE 绑定注册时的会话，会话 15 分钟到期后不再推送：每次定期重新鉴权后（见 session-keeper.ts）在新会话下重建全部订阅；
 * 会话可能已失效过（休眠、节流）时再全量重读补上空档。
 * 返回的函数关闭订阅（连接保留给数据读取复用）。
 */
export function openLive(handlers: LiveHandlers): () => void {
  let closed = false;
  const offs: Array<() => void> = [];
  const subs: Array<{ off(): void; kill(): Promise<void> }> = [];
  const pending = new Set<string>();
  let flush: ReturnType<typeof setTimeout> | undefined;
  const changed = (table: string) => {
    if (closed) return;
    pending.add(table);
    flush ??= setTimeout(() => {
      flush = undefined;
      const tables = [...pending];
      pending.clear();
      if (!closed && tables.length) handlers.change(tables);
    }, FLUSH_MS);
  };
  const drop = (list: typeof subs) => {
    for (const sub of list) {
      sub.off();
      void sub.kill().catch(() => undefined);
    }
  };
  const release = () => drop(subs.splice(0));
  /** 先在当前会话下注册全部新订阅，再撤掉旧的，替换期间不漏推送。 */
  const subscribeAll = async (db: Surreal) => {
    const fresh: typeof subs = [];
    try {
      for (const table of LIVE_TABLES) {
        if (closed) break;
        const live = await db.live(new Table(table)).fields('id');
        fresh.push({ off: live.subscribe(() => changed(table)), kill: () => live.kill() });
      }
    } catch (error) {
      drop(fresh);
      throw error;
    }
    if (closed) drop(fresh);
    else drop(subs.splice(0, subs.length, ...fresh));
  };
  const fail = (error: unknown) => {
    if (closed) return;
    handlers.state('offline');
    if (isAuthFailure(error)) handlers.unauthorized();
    else handlers.failed();
  };

  void (async () => {
    handlers.state('connecting');
    try {
      const db = await database();
      if (closed) return;
      offs.push(
        db.subscribe('connected', () => {
          if (closed) return;
          handlers.state('live');
          handlers.change(['*']);
        }),
        db.subscribe('reconnecting', () => { if (!closed) handlers.state('offline'); }),
        db.subscribe('disconnected', () => {
          if (closed) return;
          handlers.state('offline');
          if (rejected) handlers.unauthorized();
        }),
      );
      const lost = () => { if (!closed) { handlers.state('offline'); handlers.unauthorized(); } };
      sessionLost.add(lost);
      offs.push(() => sessionLost.delete(lost));
      if (keeper) {
        offs.push(keeper.onRenewed((lapsed) => {
          if (closed) return;
          subscribeAll(db).then(() => {
            if (closed || !lapsed) return;
            handlers.state('live');
            handlers.change(['*']);
          }, fail);
        }));
      }
      await subscribeAll(db);
      if (closed) return;
      handlers.state('live');
      handlers.change(['*']);
    } catch (error) {
      fail(error);
    }
  })();

  return () => {
    closed = true;
    clearTimeout(flush);
    for (const off of offs.splice(0)) off();
    release();
  };
}
