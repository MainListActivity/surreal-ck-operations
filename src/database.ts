import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Surreal } from 'surrealdb';
import type { DatabaseConfig } from './config.ts';
import { connectDb, openDb, useDb, type DbTarget } from './db-connection.ts';
import { CompanyError } from './core-errors.ts';
import type { SnapshotChannel, SnapshotLink } from './snapshot-store.ts';
import { IdpClient, type IssuedToken } from './cloud/idp.ts';
import { readSecretFile } from './cloud/secret.ts';

const OWNER = 'surreal-ck-operations/issue-23/v1';

// Lazy: runtimes that only query (e.g. the Paseo plugin subprocess) may not have schema/ beside the bundle.
const loadSchema = (file: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', file), 'utf8');

/**
 * 把 055 的占位符换成公司库的 JWKS 地址与签发方。两个值都不许含引号、反斜杠或空白（JWKS 必须是 http(s)），
 * 免得配置值拼进 SurrealQL 后改写语句；错误信息不回显配置值。
 */
export function renderCompanyAccess(schema: string, jwksUrl: string, issuer: string): string {
  if (!/^https?:\/\/[^'"\\\s]+$/.test(jwksUrl)) throw new Error('COMPANY_JWKS_URL 必须是 http(s) 地址，且不含引号、反斜杠或空白');
  if (!/^[^'"\\\s]+$/.test(issuer)) throw new Error('COMPANY_ISSUER 不能含引号、反斜杠或空白');
  return schema.replaceAll('{{COMPANY_JWKS_URL}}', () => jwksUrl).replaceAll('{{COMPANY_ISSUER}}', () => issuer);
}

/** Snapshot-build connections open at once across the process (SYS01 AC-D). A build that gets none within BUILD_QUEUE_MS is refused. */
export const MAX_BUILD_CONNECTIONS = 4;
const BUILD_QUEUE_MS = 2_000;
/**
 * How long a build connection may sit idle before it is closed instead of reused (SYS01 AC02, production return). A remote WSS
 * handshake costs seconds on the production link; reusing a warm socket for the next build removes that cost from the default
 * first-page path. The idle socket is probed with one cheap statement before reuse, so a socket the server closed in the meantime
 * is replaced rather than failing the build.
 */
const BUILD_IDLE_TTL_MS = 30_000;
/** Longest the reuse probe may take before the socket is treated as gone and a fresh one is opened. */
const BUILD_REUSE_PROBE_MS = 2_000;

/** 云端会话的令牌到期前多久换新会话（续期即重连）。 */
const RENEW_BEFORE_MS = 60_000;
/** 续期定时器的最短延迟，防止令牌寿命过短时空转。 */
const MIN_RENEW_MS = 1_000;
/** 断线重连的指数退避起点与上限。 */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
/** 退役的会话在关闭前保留的时间，让在途请求先结束。 */
const RETIRE_GRACE_MS = 5_000;
/** 绑定（建立 LIVE 订阅等）的时限；超时即视为新会话不可用。 */
const BIND_TIMEOUT_MS = 15_000;

/**
 * 会话绑定：每次建立新会话（首次连接、续期、断线重连）时在新客户端上调用，例如建立 LIVE 订阅并请求一次全量 tick。
 * 返回拆除函数，旧会话关闭前调用它。
 */
export type SessionBinder = (client: Surreal) => Promise<() => Promise<void>>;

/** 云端身份：runner 为执行端（默认）；migrator 只供 company-migrate 应用结构。 */
export type CloudRole = 'runner' | 'migrator';

export interface CompanyDatabaseOptions {
  role?: CloudRole;
  /** 令牌到期前多久换新会话，默认 60 秒（测试可调小）。 */
  renewBeforeMs?: number;
  /** 断线重连退避的起点与上限，默认 1 秒与 60 秒。 */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

/** 云端的一条会话：客户端、本会话所用令牌的到期时间、在它上面绑定的订阅，以及断线监听的取消函数。 */
interface CloudSession {
  client: Surreal;
  expiresAt: number | undefined;
  /** 断线后置位：绑定期间或采用前断开，这个会话就不能用。 */
  broken: boolean;
  bound: Map<SessionBinder, () => Promise<void>>;
  unwatch: () => void;
}

/**
 * 转发到当前会话的客户端代理。调用方在构造时就拿走了 db.db，所以不能替换对象，只能把调用转到当前会话上：
 * 方法在调用时绑定到当前会话，续期后自动指向新会话。
 */
function forwardTo(current: () => Surreal): Surreal {
  return new Proxy(Object.create(Surreal.prototype) as Surreal, {
    get: (_target, property) => {
      const client = current();
      const value: unknown = Reflect.get(client, property, client);
      return typeof value === 'function' ? value.bind(client) : value;
    },
    set: (_target, property, value) => Reflect.set(current(), property, value, current()),
    has: (_target, property) => Reflect.has(current(), property),
  });
}

const pause = (ms: number): Promise<void> => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/** 本版本 applySchema 的最后一个结构版本；云端 bootstrap 只核对库内版本不低于它。 */
export const CLOUD_SCHEMA_VERSION = 64;

export class CompanyDatabase {
  /** 当前会话的客户端；云端续期或重连时整体替换（见 rebuildNow）。 */
  private session = new Surreal();
  /** 调用方持有的客户端：转发到当前会话，续期后自动指向新会话。 */
  readonly db: Surreal = forwardTo(() => this.session);
  /** 云端当前采用的会话；本机模式不用。 */
  private current: CloudSession | undefined;
  /** 已换下、等在途请求结束再关闭的会话客户端。 */
  private readonly retiring = new Set<Surreal>();
  private readonly role: CloudRole;
  private readonly idp: IdpClient | undefined;
  private readonly binders = new Set<SessionBinder>();
  private cachedToken: IssuedToken | undefined;
  private issuing: Promise<IssuedToken> | undefined;
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  /** 单飞：同一时间只有一次重建在跑。 */
  private rebuilding: Promise<void> | undefined;
  /** 单飞：后台重建（续期与断线共用），失败按退避反复尝试。 */
  private refreshing: Promise<void> | undefined;
  private readonly renewBeforeMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;

  constructor(readonly config: DatabaseConfig, options: CompanyDatabaseOptions = {}) {
    this.role = options.role ?? 'runner';
    this.renewBeforeMs = options.renewBeforeMs ?? RENEW_BEFORE_MS;
    this.reconnectMinMs = options.reconnectMinMs ?? RECONNECT_MIN_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? RECONNECT_MAX_MS;
    const cloud = config.cloud;
    if (!cloud) return;
    const clientId = this.role === 'runner' ? cloud.runnerClientId : cloud.migratorClientId;
    const secretFile = this.role === 'runner' ? cloud.runnerClientSecretFile : cloud.migratorClientSecretFile;
    if (!clientId) throw new Error(this.role === 'runner' ? '云端执行端缺少 RUNNER_CLIENT_ID' : '缺少 MIGRATOR_CLIENT_ID');
    if (!secretFile) throw new Error('缺少云端凭证文件路径');
    this.idp = new IdpClient({ issuer: cloud.idpIssuer, clientId, clientSecret: () => readSecretFile(secretFile) });
  }

  /** 本机模式用 root 账号；云端模式每次登录向身份服务取令牌。 */
  private target(): DbTarget {
    if (this.config.cloud) return this.cloudTarget();
    const { url, namespace, database, rootUser, rootPassword } = this.config;
    return { url, namespace, database, auth: { kind: 'root', username: rootUser, password: rootPassword } };
  }

  /** 云端目标：record 收到本次登录用的令牌，用来知道会话何时到期。 */
  private cloudTarget(record?: (issued: IssuedToken) => void): DbTarget {
    const { url, namespace, database } = this.config;
    return {
      url, namespace, database,
      auth: {
        kind: 'token',
        getToken: async () => {
          const issued = await this.issueToken();
          record?.(issued);
          return issued.token;
        },
      },
    };
  }

  /** 取本进程的客户端令牌：离到期还有 renewBeforeMs 以上才复用缓存，否则重新换发（同一时间只换发一次）。 */
  private async issueToken(): Promise<IssuedToken> {
    if (!this.idp) throw new Error('未配置云端身份');
    const cached = this.cachedToken;
    if (cached && cached.expiresAt - Date.now() > this.renewBeforeMs) return cached;
    this.issuing ??= this.idp.clientToken().then(
      issued => {
        this.cachedToken = issued;
        return issued;
      },
      error => {
        this.cachedToken = undefined;
        throw error;
      },
    ).finally(() => {
      this.issuing = undefined;
    });
    return this.issuing;
  }

  async connect(): Promise<void> {
    if (this.config.cloud) {
      await this.rebuild();
      return;
    }
    // The WS engine resolves its open promise only on socket 'close'; a connect that
    // stalls without ever firing close would wedge startup/reconnect forever.
    await CompanyDatabase.withTimeout(connectDb(this.db, this.target()), 15_000, 'db connect');
  }

  /**
   * 云端连接状态（供 runner.status 读取）：当前会话是否可用，以及它所用令牌的到期时刻（毫秒）。
   * 本机模式不跟踪连接，只返回 connected: false 与空到期时间，由调用方按心跳判断。
   */
  connectionStatus(): { connected: boolean; tokenExpiresAt?: number } {
    if (!this.config.cloud) return { connected: false };
    const session = this.current;
    return { connected: !!session && !session.broken && !this.closing, tokenExpiresAt: session?.expiresAt };
  }

  /**
   * 登记一个会话绑定（仅云端）：当前已有会话就立即在它上面绑定；之后每次建立新会话（续期、断线重连）都会再绑定一次。
   * 返回的函数取消登记，并拆除当前会话上的绑定。
   */
  async bindSession(binder: SessionBinder): Promise<() => Promise<void>> {
    this.binders.add(binder);
    const session = this.current;
    if (session && !this.closing) {
      try {
        const teardown = await CompanyDatabase.withTimeout(binder(session.client), BIND_TIMEOUT_MS, 'session bind');
        if (this.current === session && this.binders.has(binder)) session.bound.set(binder, teardown);
        else await CompanyDatabase.runTeardown(teardown);
      } catch (error) {
        this.binders.delete(binder);
        throw error;
      }
    }
    return async () => {
      this.binders.delete(binder);
      const teardown = this.current?.bound.get(binder);
      this.current?.bound.delete(binder);
      if (teardown) await CompanyDatabase.runTeardown(teardown);
    };
  }

  /** 建立新会话并换上：先在新会话上完成全部绑定，成功后才替换旧会话，旧会话延后关闭。同一时间只有一次重建在跑。 */
  private rebuild(): Promise<void> {
    this.rebuilding ??= this.rebuildNow().finally(() => {
      this.rebuilding = undefined;
    });
    return this.rebuilding;
  }

  private async rebuildNow(): Promise<void> {
    if (this.closing) throw new Error('数据库连接已关闭');
    const client = new Surreal();
    let expiresAt: number | undefined;
    // 关闭 SDK 自动重连：断线立即发出 'disconnected'，由 onDisconnected 的退避重建接管（SDK 重连不会恢复 ns/db/登录）。
    const opening = openDb(client, this.cloudTarget(issued => {
      expiresAt = issued.expiresAt;
    }), { reconnect: false });
    try {
      await CompanyDatabase.withTimeout(opening, 15_000, 'db connect');
    } catch (error) {
      // 超时不取消登录：之后才建成的连接立即关闭，免得超出上限仍占着连接。
      void opening.catch(() => undefined).then(() => CompanyDatabase.closeClient(client));
      throw error;
    }
    const session: CloudSession = { client, expiresAt, broken: false, bound: new Map(), unwatch: () => undefined };
    // SDK 断线后不替我们恢复 ns/db/登录状态，所以断线即作废这个会话（见 onDisconnected）。
    session.unwatch = client.subscribe('disconnected', () => this.onDisconnected(session));
    try {
      // 逐个绑定，直到没有遗漏：绑定期间新登记的绑定也在这里补上。
      for (let next = this.unbound(session); next; next = this.unbound(session)) {
        const teardown = await CompanyDatabase.withTimeout(next(client), BIND_TIMEOUT_MS, 'session bind');
        // 绑定进行中若已被取消，立即拆除，不能留下取消之后仍会触发的订阅。
        if (this.binders.has(next)) session.bound.set(next, teardown);
        else await CompanyDatabase.runTeardown(teardown);
      }
      if (this.closing || session.broken) throw new Error(this.closing ? '数据库连接已关闭' : '新会话在绑定期间断开');
    } catch (error) {
      session.unwatch();
      await CompanyDatabase.unbindAll(session.bound);
      await CompanyDatabase.closeClient(client);
      throw error;
    }
    // 以下同步完成换上：中间没有 await，绑定集合不会再变。
    const previous = this.current;
    this.current = session;
    this.session = client;
    this.scheduleRenew(session);
    if (previous) void this.retire(previous);
  }

  /** 当前会话断线：标记作废；若它仍是当前会话，就后台重连（与续期共用同一退避流程）。 */
  private onDisconnected(session: CloudSession): void {
    session.broken = true;
    if (this.closing || this.current !== session) return;
    console.error('公司库连接已断开，正在重连');
    void this.refresh();
  }

  /** 后台重建（续期与断线共用）：失败按指数退避反复尝试，直到成功或数据库关闭。同一时间只有一个在跑。 */
  private refresh(): Promise<void> {
    this.refreshing ??= this.refreshWithBackoff().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshWithBackoff(): Promise<void> {
    let delay = this.reconnectMinMs;
    while (!this.closing) {
      try {
        await this.rebuild();
        return;
      } catch (error) {
        console.error(`公司库会话重建失败，${delay} 毫秒后重试：${(error as Error).message.slice(0, 200)}`);
        await pause(delay);
        delay = Math.min(delay * 2, this.reconnectMaxMs);
      }
    }
  }

  /** 令牌到期前 renewBeforeMs 触发续期，即换新会话。 */
  private scheduleRenew(session: CloudSession): void {
    clearTimeout(this.renewTimer);
    this.renewTimer = undefined;
    if (session.expiresAt === undefined || this.closing) return;
    const delay = Math.max(MIN_RENEW_MS, session.expiresAt - Date.now() - this.renewBeforeMs);
    this.renewTimer = setTimeout(() => {
      this.renewTimer = undefined;
      void this.refresh();
    }, delay);
    this.renewTimer.unref?.();
  }

  /** 退役旧会话：先拆除它的绑定（杀掉 LIVE 订阅），等在途请求结束后再关闭连接。 */
  private async retire(session: CloudSession): Promise<void> {
    session.unwatch();
    await CompanyDatabase.unbindAll(session.bound);
    this.retiring.add(session.client);
    await pause(RETIRE_GRACE_MS);
    this.retiring.delete(session.client);
    await CompanyDatabase.closeClient(session.client);
  }

  /** 第一个还没绑定到该会话上的登记项。 */
  private unbound(session: CloudSession): SessionBinder | undefined {
    for (const binder of this.binders) if (!session.bound.has(binder)) return binder;
    return undefined;
  }

  /** 依次拆除绑定，每个都有时限；失败吞掉，清理不能拖住重建或关闭。 */
  private static async unbindAll(bound: Map<SessionBinder, () => Promise<void>>): Promise<void> {
    const teardowns = [...bound.values()];
    bound.clear();
    for (const teardown of teardowns) await CompanyDatabase.runTeardown(teardown);
  }

  private static async runTeardown(teardown: () => Promise<void>): Promise<void> {
    await CompanyDatabase.withTimeout(Promise.resolve().then(teardown), 5_000, 'session unbind').catch(() => undefined);
  }

  /** 关闭一个会话客户端：错误与超时都吞掉。 */
  private static async closeClient(client: Surreal): Promise<void> {
    await CompanyDatabase.withTimeout(Promise.resolve().then(() => client.close()), 5_000, 'db close').catch(() => undefined);
  }

  private requireMigrator(action: string): void {
    if (this.config.cloud && this.role !== 'migrator') throw new Error(`云端只有 migrator 可以${action}`);
  }

  /**
   * 本机 bootstrap：认领库，再应用全部结构。
   * 云端不应用结构（由 scripts/company-migrate.ts 用 migrator 应用），只选定库并核对结构版本已到本版本要求，
   * 这样各入口（插件 sidecar、调度器、老板 CLI 等）照旧调用 bootstrap 即可；版本不够时拒绝启动并指明要先跑迁移。
   */
  async bootstrap(): Promise<void> {
    if (this.config.cloud) {
      await this.useDatabase();
      const [rows] = await this.db.query<[Array<{ schema_version?: number }>]>('SELECT schema_version FROM company_meta:installation;');
      const version = Number(rows?.[0]?.schema_version ?? 0);
      if (version < CLOUD_SCHEMA_VERSION) {
        throw new Error(`云端公司库结构版本 ${version} 低于本版本要求 ${CLOUD_SCHEMA_VERSION}：先用 migrator 运行 scripts/company-migrate.ts`);
      }
      return;
    }
    await this.applySchema(await this.claimDatabase());
  }

  /**
   * 认领命名空间与库：本机缺则建，并核对归属标记。返回 true 表示库是空的，需要整套应用结构。
   * 云端不建命名空间与库（由运维开通），只核对库内标记，且只有 migrator 能做。
   */
  async claimDatabase(): Promise<boolean> {
    if (this.config.cloud) {
      this.requireMigrator('认领公司库');
      return this.checkDatabaseMarker();
    }
    const [rootInfo] = await this.db.query<[Record<string, unknown>]>('INFO FOR ROOT;');
    const namespaces = rootInfo.namespaces as Record<string, string> | undefined;
    let fresh = !namespaces?.[this.config.namespace];
    if (namespaces?.[this.config.namespace]) {
      await this.db.use({ namespace: this.config.namespace });
      const [nsInfo] = await this.db.query<[Record<string, unknown>]>('INFO FOR NS;');
      const databases = nsInfo.databases as Record<string, string> | undefined;
      if (!databases?.[this.config.database]) {
        const occupied = Object.values(nsInfo).some(value =>
          value !== null && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0
        );
        if (occupied) throw new Error('Target namespace has unrelated resources; refusing to alter it');
        await this.db.query(`DEFINE DATABASE ${this.config.database};`);
        fresh = true;
      }
      await this.db.use({ namespace: this.config.namespace, database: this.config.database });
      if (await this.checkDatabaseMarker()) fresh = true;
    } else {
      await this.db.query(`DEFINE NAMESPACE ${this.config.namespace};`);
      await this.db.use({ namespace: this.config.namespace });
      await this.db.query(`DEFINE DATABASE ${this.config.database};`);
      await this.db.use({ namespace: this.config.namespace, database: this.config.database });
    }
    return fresh;
  }

  /** 核对库内归属标记。库为空返回 true（需要整套应用结构）；有结构但标记不符则拒绝改写。 */
  private async checkDatabaseMarker(): Promise<boolean> {
    const [dbInfo] = await this.db.query<[Record<string, unknown>]>('INFO FOR DB;');
    const tables = dbInfo.tables as Record<string, string> | undefined;
    const tableNames = Object.keys(tables ?? {});
    if (tableNames.length === 0) {
      // 'quota' is server metadata reported by newer SurrealDB versions, not a user-defined resource.
      // 云端的访问方式（accesses）可能由 055 或运维预先定义，空库也会有，不算已有资源。
      const ignored = this.config.cloud ? ['tables', 'quota', 'accesses'] : ['tables', 'quota'];
      const otherDefinitions = Object.entries(dbInfo).filter(([kind, definitions]) =>
        !ignored.includes(kind) && definitions !== null && typeof definitions === 'object' &&
        Object.keys(definitions as Record<string, unknown>).length > 0
      );
      if (otherDefinitions.length > 0) {
        throw new Error('Target database has resources but no ownership marker; refusing to alter it');
      }
      return true;
    }
    if (!tableNames.includes('company_meta')) {
      throw new Error('Target database has tables but no ownership marker; refusing to alter it');
    }
    const [markers] = await this.db.query<[Array<{ owner: string }>]>(
      'SELECT owner FROM company_meta:installation;'
    );
    if (!markers?.[0] || markers[0].owner !== OWNER) {
      throw new Error('Target database ownership marker mismatch; refusing to alter it');
    }
    return false;
  }

  /**
   * 按序应用全部 schema（001 至 063；055 按配置渲染）。fresh 时写入归属标记。本机 bootstrap 与云端 company-migrate 共用；
   * 云端只有 migrator 能应用。
   */
  async applySchema(fresh: boolean): Promise<void> {
    this.requireMigrator('应用公司库结构');
    await this.db.query(loadSchema('001-control.surql'));
    if (fresh) {
      await this.db.query('CREATE company_meta:installation CONTENT { owner: $owner, schema_version: 1 };', { owner: OWNER });
    }
    await this.db.query(loadSchema('003-workforce.surql'));
    await this.db.query(loadSchema('004-eval.surql'));
    await this.db.query(loadSchema('005-jev.surql'));
    await this.db.query(loadSchema('006-flow.surql'));
    await this.db.query(loadSchema('007-gate.surql'));
    await this.db.query(loadSchema('008-content-roles.surql'));
    await this.db.query(loadSchema('009-discipline-tracks.surql'));
    await this.db.query(loadSchema('010-instruct.surql'));
    await this.db.query(loadSchema('010-internal-ai-proof.surql'));
    await this.db.query(loadSchema('011-worktrees.surql'));
    await this.db.query(loadSchema('012-worktree-lifecycle.surql'));
    await this.db.query(loadSchema('013-screenwriter-role.surql'));
    await this.db.query(loadSchema('014-task-project-overlay.surql'));
    await this.db.query(loadSchema('014-worktree-scene.surql'));
    await this.db.query(loadSchema('015-screenplay-revisions.surql'));
    await this.db.query(loadSchema('016-worktree-lane.surql'));
    await this.db.query(loadSchema('017-code-repo-binding.surql'));
    await this.db.query(loadSchema('018-pipeline.surql'));
    await this.db.query(loadSchema('019-story-author-role.surql'));
    await this.db.query(loadSchema('020-cinematography-role.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 20 WHERE schema_version < 20;');
    // The SYS01 snapshot schemas follow main's 021 (worktree audit events) and 022 (def quota limits).
    await this.db.query(loadSchema('021-worktree-audit-events.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 21 WHERE schema_version < 21;');
    await this.db.query(loadSchema('022-def-quota-limited.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 22 WHERE schema_version < 22;');
    await this.db.query(loadSchema('023-query-snapshot.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 23 WHERE schema_version < 23;');
    await this.db.query(loadSchema('024-snapshot-quota.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 24 WHERE schema_version < 24;');
// SYS02 验收（本 lane，编号 026）：只新增表与 gate 记录。
    await this.db.query(loadSchema('026-acceptance.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 26 WHERE schema_version < 26;');
    // SYS02 gate record: additive and disabled on install. The release application enables the scope it lists (AC06).
    await this.db.query(`IF (SELECT * FROM ONLY company_meta:acceptance_gate) = NONE {
      CREATE ONLY company_meta:acceptance_gate CONTENT { version: 1, enabled: false, scope: 'code-deliveries', criteria_version: 1 };
    };`);
    // QA 受限只读取证（SYS-DISP 7454fc89）：025/026 由在办 lane 预占，本 lane 取 027；仅新增表。
    await this.db.query(loadSchema('027-qa-observation.surql'));
    await this.db.query(loadSchema('032-model-routing.surql'));
    await this.db.query(loadSchema('033-four-tier-routing.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 27 WHERE schema_version < 27;');
    // 独立性策略（SYS-DISP 8c732ae6 IR01）：028 由本线取用（025/026 为在办 lane 预占，027 已被 QA 取证占用）；只新增字段，旧行不动。
    await this.db.query(loadSchema('028-independence-policy.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 28 WHERE schema_version < 28;');
    // 登记身份（SYS-DISP IR02/Q3）：029 由本线取用；只新增表与字段，不改任何已有员工行。
    await this.db.query(loadSchema('029-identity-principal.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 29 WHERE schema_version < 29;');
    // SYS03 经理处置账本（编号 034，随主干合入；030/031 为在办 lane 预占）：只新增表与唯一索引，
    // 不改写 task/audit/outbox/dispatch 的任何既有字段或行，回滚旧版即忽略这些新状态（RB01）。
    await this.db.query(loadSchema('034-disposition.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 34 WHERE schema_version < 34;');
    // 有效策略层（SYS06 P1）：主干已取用 034（SYS03 处置账本），本线模块合线时重排为 035；只新增表与字段，旧行不动。
    await this.db.query(loadSchema('035-effective-policy.surql'));
    await this.db.query(`IF (SELECT * FROM ONLY company_meta:policy_epoch) = NONE {
      CREATE ONLY company_meta:policy_epoch CONTENT { value: 0 };
    };`);
    await this.db.query('UPDATE company_meta:installation SET schema_version = 35 WHERE schema_version < 35;');
    // SYS03 第三轮（QA v23 退回，编号 036）：重放围栏与出口占位两个新字段。只新增字段，旧版 release 读到多出来的
    // 字段会忽略、新版对旧行按 NONE 兜底，所以新旧两版能同时对着同一批行工作（RB01）。
    await this.db.query(loadSchema('036-disposition-replay-fence.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 36 WHERE schema_version < 36;');
    // SYS04 P0：故障归组、持久恢复预算与修复链（编号 037）。只新增表与索引，不改写任何既有表、字段或行：
    // 旧版 release 读不到这四张表（忽略），也不认识 fault 状态，所以回滚后照旧派工；真正的隔离靠原任务
    // 进入既有依赖等待语义（defer/waits），那由新版写入 task 的既有字段，不改旧字段（RB01）。
    await this.db.query(loadSchema('037-fault-budget.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 37 WHERE schema_version < 37;');
    await this.db.query(loadSchema('038-goal-workspaces.surql'));
    await this.db.query(loadSchema('039-task-recovery.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 39 WHERE schema_version < 39;');
    // SYS05 P1：时间与外部事件等待状态机（编号 040；039 已由 main 的 task-recovery 占用）。只新增 task_wait /
    // wait_event 两张表与索引；任务上的 wait_* 是 schemaless 新字段。进入等待时任务置为 blocked（旧版派工
    // 队列不收），旧版读不到新表即忽略，因此回滚后不会认领或拉起等待中的任务（RB01）。
    await this.db.query(loadSchema('040-waits.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 40 WHERE schema_version < 40;');
    // SYS07 P2：目标成果契约、证据、终验缺口与指标。只新增 goal_outcome / goal_evidence 两张表与 goal 的可选
    // 新字段；旧版忽略这些字段和表，历史任务、验收与老板决定不被改写（RB01）。
    await this.db.query(loadSchema('042-goal-governance.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 42 WHERE schema_version < 42;');
    // SYS-INT：版本化验收映射的导入标记。只新增 task 可选字段；旧版读不到即按 legacy 处理，不误派不误关（RB01）。
    await this.db.query(loadSchema('043-acceptance-mapping.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 43 WHERE schema_version < 43;');
    // SYS-INT：QA 评审协同的持久事件唤醒（编号 044）。只新增 qa_review_watch / qa_review_signal / qa_review_wake
    // 三张表与索引；协同任务仍用 040 的 task_wait，事件只解除等待并把任务放回 ready。旧版读不到新表即忽略，
    // 行为退回固定时间等待（RB01：不误派、不误关）。
    await this.db.query(loadSchema('044-review-events.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 44 WHERE schema_version < 44;');
    // 任务成本（编号 045）：Magpie 逐请求用量按任务汇总的 task_cost 表。只新增表；旧版忽略（RB01）。
    await this.db.query(loadSchema('045-task-cost.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 45 WHERE schema_version < 45;');
    // FV06 窗口绑定（编号 046）：internal_ai_candidate 增加 type/source_path 两个可选字段，标明远端候选来源。
    // 只新增字段，不改既有行；旧版读不到新字段即按 v2 候选处理（RB01）。
    await this.db.query(loadSchema('046-remote-candidate.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 46 WHERE schema_version < 46;');
    // SYS04 故障修复凭据消耗（编号 047）：一条真实修复完成凭据最多自动解除一次恢复预算。只新增一张表与 fault_repair 的
    // 两个可选字段；旧版读不到即忽略（RB01）。首次升到 047 时记下凭据起点：之后的 accept / owner_approve 审计才是凭据，
    // 升级前已完成的修复不是凭据，所以升级本身不解除任何预算。
    await this.db.query(loadSchema('047-fault-repair-credential.surql'));
    await this.db.query(`UPDATE company_meta:installation SET fault_credential_since = time::now()
      WHERE schema_version < 47 AND fault_credential_since = NONE;`);
    await this.db.query('UPDATE company_meta:installation SET schema_version = 47 WHERE schema_version < 47;');
    // 经理验收要求修订（编号 048；047 已由故障修复凭据占用）：holder_notice.kind 白名单新增 acceptance_amended。修订正文
    // 追加在既有 task.context，不新增任务字段、不改任何既有行；旧版 release 读到未知 kind 按既有通用文本投递一次（RB01）。
    await this.db.query(loadSchema('048-acceptance-amend.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 48 WHERE schema_version < 48;');
    // FV06 恢复取证子租约（编号 049）：只新增 recovery_read_grant / recovery_read_chain / recovery_read_call 三张表。grant 不改变源任务、
    // 不建预算、不 lift；旧 release 读不到这三张表即忽略（RB01）。
    await this.db.query(loadSchema('049-recovery-read-grant.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 49 WHERE schema_version < 49;');
    // FV06 恢复唤醒可观测性（编号 050）：只给 recovery_read_grant 增补两个可选字段 last_wake_at / last_skip_reason，
    // 记录 dispatcher 最近一次唤醒尝试与最近一次跳过原因；不改 state 机、限额、既有路径或任何既有行（RB01）。
    await this.db.query(loadSchema('050-recovery-read-wake.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 50 WHERE schema_version < 50;');
    // 051：派工体系重构（待发消息表、任务需求/验收标准字段、owner 岗位撤销迁移）。只新增表与字段，
    // 迁移是幂等 UPDATE：旧版 release 读不到新表即忽略（RB01）。
    await this.db.query(loadSchema('051-role-message-flow.surql'));
    await this.db.query(loadSchema('052-task-routes.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 52 WHERE schema_version < 52;');
    // 053：线的笔记。只新增 lane_note 表，不改既有行；旧 release 读不到新表即忽略（RB01）。
    await this.db.query(loadSchema('053-lane-notes.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 53 WHERE schema_version < 53;');
    // 054：线的笔记整理（合并、清理与可撤销的整理记录）。只新增 note_consolidation 表与 lane_note 的两个可选字段；
    // 旧 release 读不到即忽略（RB01）。
    await this.db.query(loadSchema('054-note-consolidation.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 54 WHERE schema_version < 54;');
    // 公司库访问方式（编号 055）：只在 COMPANY_JWKS_URL 与 COMPANY_ISSUER 都配置时应用，否则跳过并留一行日志（本机模式）。
    // 055 只新增访问方式与事件、不新增表，所以不推进 schema_version。
    const { companyJwksUrl, companyIssuer } = this.config;
    if (companyJwksUrl && companyIssuer) {
      await this.db.query(renderCompanyAccess(loadSchema('055-access.surql'), companyJwksUrl, companyIssuer));
    } else {
      console.log('跳过公司库访问方式（055）：未同时配置 COMPANY_JWKS_URL 与 COMPANY_ISSUER，保持本机访问');
    }
    // 老板保护与员工策略（编号 056）：protected_command / agent_policy / ops_audit 三张新表与写入事件，本机与公司库都应用。
    await this.db.query(loadSchema('056-command-guard.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 56 WHERE schema_version < 56;');
    // 057：老板看板的执行端心跳（编号 057，054-056 未用）。只新增 runner_heartbeat 表；旧 release 读不到即忽略（RB01）。
    await this.db.query(loadSchema('057-runner-heartbeat.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 57 WHERE schema_version < 57;');
    // 058：老板端共享核心（编号 058）。只新增 ops_job、agent_identity 与译文、员工语言、审计摘要字段；旧 release 读不到即忽略（RB01）。
    await this.db.query(loadSchema('058-owner-end.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 58 WHERE schema_version < 58;');
    // 059：移除 runner / automation 字段守卫（老板定：员工有任务即可执行老板端全部操作）。
    await this.db.query(loadSchema('059-drop-runner-field-guards.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 59 WHERE schema_version < 59;');
    // 060：删除模型评分、排序与本地网关的账本；员工会话绑定任务（session_task）。
    await this.db.query(loadSchema('060-drop-scoring-gateway.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 60 WHERE schema_version < 60;');
    // 061：节点记录与升级回退记录（每台执行端一行 node_release；node_rollback 追加写）。只新增表与索引，不改任何既有行；旧 release 读不到即忽略（RB01）。
    await this.db.query(loadSchema('061-node-release.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 61 WHERE schema_version < 61;');
    // 062：删除 outbox 事件表、序号索引与计数器（0.7.1）。0.7.0 起核心不再写 outbox；前提是所有执行端已是 0.7.0 或更新。
    await this.db.query(loadSchema('062-drop-outbox.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 62 WHERE schema_version < 62;');
    await this.db.query(loadSchema('063-product-iteration.surql'));
    await this.db.query(loadSchema('064-runner-lifecycle.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 63 WHERE schema_version < 63;');
  }

  /** Selects the configured namespace/database without touching schema (runtimes that only query). */
  async useDatabase(): Promise<void> {
    await useDb(this.db, this.target());
  }

  private reconnecting: Promise<void> | undefined;
  private keepalive: ReturnType<typeof setInterval> | undefined;

  /** Remote WSS rots silently while idle (peer times out, local socket stays ESTABLISHED);
   *  probe periodically so a dead connection is rebuilt before a request walks into it. */
  private ensureKeepalive(): void {
    if (this.keepalive) return;
    this.keepalive = setInterval(() => { void this.ensureConnected().catch(() => {}); }, 25_000);
    this.keepalive.unref?.();
  }

  /** Half-open WSS (peer gone, local socket still ESTABLISHED) makes a query hang forever;
   *  bound every step so a dead connection fails fast and rebuilds instead of wedging callers. */
  private static withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      promise.then(v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); });
    });
  }

  /** Probes the connection; on failure rebuilds it. The SDK may silently re-establish the WS
   *  transport while dropping ns/db/auth session state, so the probe must require scope. */
  async ensureConnected(): Promise<void> {
    this.ensureKeepalive();
    this.reconnecting ??= (async () => {
      try {
        await CompanyDatabase.withTimeout(this.db.query('INFO FOR DB;'), 10_000, 'db probe');
      } catch (probeError) {
        try {
          if (this.config.cloud) {
            await this.rebuild();
          } else {
            await CompanyDatabase.withTimeout(this.db.close().catch(() => {}), 5_000, 'db close').catch(() => {});
            await CompanyDatabase.withTimeout(this.connect(), 15_000, 'db connect');
            await CompanyDatabase.withTimeout(this.useDatabase(), 10_000, 'db use');
          }
          console.log(`database connection re-established (was: ${(probeError as Error).message.slice(0, 80)})`);
        } catch (error) {
          console.error(`database reconnect failed: ${(error as Error).message}`);
          throw error;
        }
      } finally {
        this.reconnecting = undefined;
      }
    })();
    return this.reconnecting;
  }

  private readonly buildSockets = new Set<Surreal>();
  /** Open build sockets that are not checked out, newest last. They count toward MAX_BUILD_CONNECTIONS with the active ones. */
  private readonly idleBuildSockets: Array<{ socket: Surreal; since: number }> = [];
  private buildSlotsInUse = 0;
  private readonly buildSlotWaiters: Array<() => void> = [];
  private closing = false;

  /**
   * The connections snapshot builds run on (SYS01 AC-D): a socket of their own for each read attempt, to the same namespace and
   * database. A large build then never queues ahead of control requests on the main socket, and an attempt that is abandoned or
   * cancelled closes only its own socket. At most MAX_BUILD_CONNECTIONS are open at once across the process: a socket keeps its
   * slot until it is closed, and a build that gets no slot within BUILD_QUEUE_MS is refused as temporarily_unavailable.
   */
  readonly buildChannel: SnapshotChannel = {
    open: async (): Promise<SnapshotLink> => {
      if (this.closing) throw new CompanyError('temporarily_unavailable', 'the database is closing; retry shortly', true);
      // Reuse a warm socket when one is idle: on the production WSS link a handshake costs seconds, and a build that pays it on
      // every first page cannot answer within its deadline (SYS01 AC02 production return).
      const warm = await this.takeIdleBuildSocket();
      if (warm) return this.linkFor(warm);
      await this.takeBuildSlot();
      if (this.closing) {
        this.freeBuildSlot();
        throw new CompanyError('temporarily_unavailable', 'the database is closing; retry shortly', true);
      }
      // A socket may have gone idle while this build waited for a slot: take it rather than opening another.
      const raced = await this.takeIdleBuildSocket(true);
      if (raced) return this.linkFor(raced);
      const socket = new Surreal();
      this.buildSockets.add(socket);
      const opening = this.openSocket(socket);
      try {
        await CompanyDatabase.withTimeout(opening, 15_000, 'build connect');
      } catch (error) {
        // The timeout does not cancel the connect. A socket that opens after its slot was freed is closed at once, so it cannot
        // outlive the build cap.
        void opening.then(() => this.closeLateSocket(socket), () => undefined);
        await this.closeBuildSocket(socket);
        throw error;
      }
      return this.linkFor(socket);
    },
  };

  /** The link a build holds: `close` drops the socket, `release` returns it warm for the next build. */
  private linkFor(socket: Surreal): SnapshotLink {
    return {
      db: socket,
      close: () => this.closeBuildSocket(socket),
      release: () => this.releaseBuildSocket(socket),
    };
  }

  /**
   * Pops one warm socket, closing the ones past BUILD_IDLE_TTL_MS. `holdsSlot` is true when the caller already owns an active slot
   * (the slot is handed over to this socket); otherwise the idle socket becomes active here. Returns undefined when none is usable.
   */
  private async takeIdleBuildSocket(holdsSlot = false): Promise<Surreal | undefined> {
    while (this.idleBuildSockets.length > 0) {
      const entry = this.idleBuildSockets.pop()!;
      if (this.closing || Date.now() - entry.since > BUILD_IDLE_TTL_MS) {
        await this.closeIdleBuildSocket(entry.socket);
        continue;
      }
      // One cheap statement proves the socket is still alive: a server that dropped the idle connection fails here, not in the build.
      const alive = await CompanyDatabase.withTimeout(
        entry.socket.query('RETURN true;').then(() => true, () => false), BUILD_REUSE_PROBE_MS, 'build reuse probe',
      ).catch(() => false);
      if (!alive) {
        await this.closeIdleBuildSocket(entry.socket);
        continue;
      }
      if (!holdsSlot) this.buildSlotsInUse++;
      return entry.socket;
    }
    return undefined;
  }

  /** Returns a build socket to the idle set; its slot is freed for the next waiter. A closing pool or a full idle set drops it. */
  private async releaseBuildSocket(socket: Surreal): Promise<void> {
    if (this.closing || !this.buildSockets.has(socket)) {
      await this.closeBuildSocket(socket);
      return;
    }
    this.idleBuildSockets.push({ socket, since: Date.now() });
    this.freeBuildSlot();
  }

  private async closeIdleBuildSocket(socket: Surreal): Promise<void> {
    if (!this.buildSockets.delete(socket)) return;
    await CompanyDatabase.withTimeout(socket.close().catch(() => {}), 5_000, 'idle build close').catch(() => undefined);
  }

  private readonly releaseSockets = new Set<Surreal>();

  /**
   * The connections releases and sweeps of listings run on, one for each, outside the build cap. A saturated build pool must not
   * hold back a release: a listing that is not released holds its quota until it expires.
   */
  readonly releaseChannel: SnapshotChannel = {
    open: async (): Promise<SnapshotLink> => {
      if (this.closing) throw new CompanyError('temporarily_unavailable', 'the database is closing; retry shortly', true);
      const socket = new Surreal();
      this.releaseSockets.add(socket);
      const opening = this.openSocket(socket);
      try {
        await CompanyDatabase.withTimeout(opening, 15_000, 'release connect');
      } catch (error) {
        void opening.then(() => this.closeLateSocket(socket), () => undefined);
        await this.closeReleaseSocket(socket);
        throw error;
      }
      return { db: socket, close: () => this.closeReleaseSocket(socket) };
    },
  };

  /**
   * Build connections open (active and idle), the slots checked out, the idle sockets kept warm, and the builds waiting for a slot
   * (for the tests and the measurements). `open` stays within MAX_BUILD_CONNECTIONS; after a build its slot returns to 0 while its
   * socket may stay warm until BUILD_IDLE_TTL_MS.
   */
  buildConnectionStats(): { open: number; slotsInUse: number; idle: number; queued: number } {
    return { open: this.buildSockets.size, slotsInUse: this.buildSlotsInUse, idle: this.idleBuildSockets.length, queued: this.buildSlotWaiters.length };
  }

  /** Takes a build slot now, or waits for one that a closing socket frees; a slot passes straight to the first waiter. */
  private takeBuildSlot(): Promise<void> {
    if (this.buildSlotsInUse + this.idleBuildSockets.length < MAX_BUILD_CONNECTIONS) {
      this.buildSlotsInUse++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.buildSlotWaiters.indexOf(waiter);
        if (index >= 0) this.buildSlotWaiters.splice(index, 1);
        reject(new CompanyError('temporarily_unavailable',
          `snapshot builds are busy: ${MAX_BUILD_CONNECTIONS} are running and none finished within ${BUILD_QUEUE_MS / 1000} seconds; narrow the query with state, tag, role or since, then retry`, true));
      }, BUILD_QUEUE_MS);
      this.buildSlotWaiters.push(waiter);
    });
  }

  private freeBuildSlot(): void {
    const next = this.buildSlotWaiters.shift();
    if (next) next();
    else this.buildSlotsInUse--;
  }

  private async openSocket(socket: Surreal): Promise<void> {
    await openDb(socket, this.target());
  }

  private async closeBuildSocket(socket: Surreal): Promise<void> {
    // Only the call that finds the socket still open closes it and frees its slot, so a link closed twice frees its slot once.
    if (!this.buildSockets.delete(socket)) return;
    try {
      await CompanyDatabase.withTimeout(socket.close().catch(() => {}), 5_000, 'build close').catch(() => {});
    } finally {
      this.freeBuildSlot();
    }
  }

  private async closeReleaseSocket(socket: Surreal): Promise<void> {
    if (!this.releaseSockets.delete(socket)) return;
    await CompanyDatabase.withTimeout(socket.close().catch(() => {}), 5_000, 'release close').catch(() => {});
  }

  /** Closes a socket whose connect finished after its owner had given up on it. Best effort, and bounded like the other closes. */
  private async closeLateSocket(socket: Surreal): Promise<void> {
    await CompanyDatabase.withTimeout(socket.close().catch(() => {}), 5_000, 'late close').catch(() => {});
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.keepalive);
    this.keepalive = undefined;
    clearTimeout(this.renewTimer);
    this.renewTimer = undefined;
    this.idleBuildSockets.length = 0;
    await Promise.all([...this.buildSockets].map(socket => this.closeBuildSocket(socket)));
    await Promise.all([...this.releaseSockets].map(socket => this.closeReleaseSocket(socket)));
    const current = this.current;
    this.current = undefined;
    if (current) {
      current.unwatch();
      await CompanyDatabase.unbindAll(current.bound);
    }
    // engine.close() awaits a 'disconnected' event that never arrives when the peer
    // silently dropped (close frame sent, no reply) — bound it so shutdown can't wedge.
    const clients = new Set<Surreal>([this.session, ...this.retiring]);
    this.retiring.clear();
    await Promise.all([...clients].map(client => CompanyDatabase.closeClient(client)));
  }
}
