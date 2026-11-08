import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecordId, Surreal } from 'surrealdb';
import type { DatabaseConfig } from './config.ts';
import { connectDb, openDb, useDb, type DbTarget } from './db-connection.ts';
import { CompanyError } from './core-errors.ts';
import type { SnapshotChannel, SnapshotLink } from './snapshot-store.ts';

const OWNER = 'surreal-ck-operations/issue-23/v1';

// Lazy: runtimes that only query (e.g. the Paseo plugin subprocess) may not have schema/ beside the bundle.
const loadSchema = (file: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', file), 'utf8');

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

export class CompanyDatabase {
  readonly db = new Surreal();
  constructor(readonly config: DatabaseConfig) {}

  /** The configured server, namespace and database, logged in with the root account. */
  private target(): DbTarget {
    const { url, namespace, database, rootUser, rootPassword } = this.config;
    return { url, namespace, database, auth: { kind: 'root', username: rootUser, password: rootPassword } };
  }

  async connect(): Promise<void> {
    // The WS engine resolves its open promise only on socket 'close'; a connect that
    // stalls without ever firing close would wedge startup/reconnect forever.
    await CompanyDatabase.withTimeout(connectDb(this.db, this.target()), 15_000, 'db connect');
  }

  async bootstrap(): Promise<void> {
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
      const [dbInfo] = await this.db.query<[Record<string, unknown>]>('INFO FOR DB;');
      const tables = dbInfo.tables as Record<string, string> | undefined;
      const tableNames = Object.keys(tables ?? {});
      if (tableNames.length === 0) {
        // 'quota' is server metadata reported by newer SurrealDB versions, not a user-defined resource.
        const otherDefinitions = Object.entries(dbInfo).filter(([kind, definitions]) =>
          kind !== 'tables' && kind !== 'quota' && definitions !== null && typeof definitions === 'object' &&
          Object.keys(definitions as Record<string, unknown>).length > 0
        );
        if (otherDefinitions.length > 0) {
          throw new Error('Target database has resources but no ownership marker; refusing to alter it');
        }
        fresh = true;
      } else if (!tableNames.includes('company_meta')) {
        throw new Error('Target database has tables but no ownership marker; refusing to alter it');
      } else {
        const [markers] = await this.db.query<[Array<{ owner: string }>]>(
          'SELECT owner FROM company_meta:installation;'
        );
        if (!markers?.[0] || markers[0].owner !== OWNER) {
          throw new Error('Target database ownership marker mismatch; refusing to alter it');
        }
      }
    } else {
      await this.db.query(`DEFINE NAMESPACE ${this.config.namespace};`);
      await this.db.use({ namespace: this.config.namespace });
      await this.db.query(`DEFINE DATABASE ${this.config.database};`);
      await this.db.use({ namespace: this.config.namespace, database: this.config.database });
    }
    await this.db.query(loadSchema('001-control.surql'));
    if (fresh) {
      await this.db.query('CREATE company_meta:installation CONTENT { owner: $owner, schema_version: 1 };', { owner: OWNER });
    }
    await this.ensureOutboxSequence();
    await this.db.query(loadSchema('002-outbox-sequence.surql'));
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
    await this.db.query(loadSchema('041-company-upgrades.surql'));
    await this.db.query('UPDATE company_meta:installation SET schema_version = 41 WHERE schema_version < 41;');
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
  }

  private async ensureOutboxSequence(): Promise<void> {
    const counter = new RecordId('company_meta', 'outbox_counter');
    if (await this.db.select(counter)) {
      const marker = await this.db.select<{ schema_version: number }>(new RecordId('company_meta', 'installation'));
      if (marker && marker.schema_version < 2) {
        await this.db.query('UPDATE company_meta:installation SET schema_version = 2;');
      }
      return;
    }
    const [events] = await this.db.query<[Array<{ id: RecordId }>]>(
      'SELECT id, at FROM outbox ORDER BY at, id;'
    );
    for (const [index, event] of events.entries()) {
      await this.db.query('UPDATE $event SET sequence = $sequence;', {
        event: event.id, sequence: index + 1,
      });
    }
    await this.db.query('CREATE $counter CONTENT { value: $value };', {
      counter, value: events.length,
    });
    await this.db.query('UPDATE company_meta:installation SET schema_version = 2;');
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
          await CompanyDatabase.withTimeout(this.db.close().catch(() => {}), 5_000, 'db close').catch(() => {});
          await CompanyDatabase.withTimeout(this.connect(), 15_000, 'db connect');
          await CompanyDatabase.withTimeout(this.useDatabase(), 10_000, 'db use');
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
    this.idleBuildSockets.length = 0;
    await Promise.all([...this.buildSockets].map(socket => this.closeBuildSocket(socket)));
    await Promise.all([...this.releaseSockets].map(socket => this.closeReleaseSocket(socket)));
    // engine.close() awaits a 'disconnected' event that never arrives when the peer
    // silently dropped (close frame sent, no reply) — bound it so shutdown can't wedge.
    await CompanyDatabase.withTimeout(this.db.close(), 5_000, 'db close').catch(() => {});
  }
}
