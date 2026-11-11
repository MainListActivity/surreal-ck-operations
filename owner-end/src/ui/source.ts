/**
 * 页面的数据来源：用老板自己的令牌直连公司库。
 * - 权限由库里的 DEFINE ACCESS（JWKS 校验 ma_hono 令牌）与表权限执行，和原后端用老板令牌连库完全一样。
 * - LIVE 只订阅记录 id，用作“哪张表变了”的失效通知；页面收到后重新计算。
 * - 大盘与看板用共享核心在浏览器里计算，结果过一次 JSON 序列化，和原 HTTP 接口的形状逐字段一致。
 * 本地设计模式（demo/server.ts）把本模块替换为 demo/source.ts，不连接任何数据库。
 */
import { Surreal, Table } from 'surrealdb';
import { readBoard } from '../../../src/board.ts';
import { readRuntimeDashboard, type RuntimeDashboard } from '../../../src/runtime-dashboard.ts';
import { LIVE_TABLES } from '../live-tables.ts';
import { accessToken, currentSession, loadConfig, refreshSession } from './auth.ts';
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

let connection: Promise<Surreal> | undefined;
let rejected = false;

async function token(): Promise<string | null> {
  const session = currentSession();
  if (session && session.expiresAt - Date.now() < RENEW_WITHIN_MS) await refreshSession();
  const value = await accessToken();
  if (!value) rejected = true;
  return value ?? null;
}

function isAuthFailure(error: unknown): boolean {
  if (rejected) return true;
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /auth|token|expired|permission|not allowed|unauthori/i.test(text);
}

async function open(): Promise<Surreal> {
  const cfg = await loadConfig();
  if (!cfg.db) throw new SourceError('unavailable', '登录配置缺少公司库地址');
  const db = new Surreal();
  rejected = false;
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
  return db;
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
    return plain(await readRuntimeDashboard(await database()));
  } catch (error) {
    throw classify(error);
  }
}

export async function readBoardData(): Promise<OwnerBoard> {
  try {
    return plain(await readBoard(await database())) as unknown as OwnerBoard;
  } catch (error) {
    throw classify(error);
  }
}

/**
 * 订阅全部老板端表的变更。连上（含断线重连成功）时通知 ['*'] 让页面全量重读；
 * 断线重连后 SDK 会自动重建托管的 LIVE 订阅（ManagedLiveSubscription 在 connected 时重新注册）。
 * 返回的函数关闭订阅（连接保留给数据读取复用）。
 */
export function openLive(handlers: LiveHandlers): () => void {
  let closed = false;
  const offs: Array<() => void> = [];
  const kills: Array<() => Promise<void>> = [];
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

  void (async () => {
    handlers.state('connecting');
    let db: Surreal;
    try {
      db = await database();
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
      for (const table of LIVE_TABLES) {
        const sub = await db.live(new Table(table)).fields('id');
        if (closed) {
          await sub.kill().catch(() => undefined);
          return;
        }
        kills.push(() => sub.kill());
        offs.push(sub.subscribe(() => changed(table)));
      }
      handlers.state('live');
      handlers.change(['*']);
    } catch (error) {
      if (closed) return;
      handlers.state('offline');
      if (classify(error).code === 'unauthorized') handlers.unauthorized();
      else handlers.failed();
    }
  })();

  return () => {
    closed = true;
    clearTimeout(flush);
    for (const off of offs.splice(0)) off();
    for (const kill of kills.splice(0)) void kill().catch(() => undefined);
  };
}
