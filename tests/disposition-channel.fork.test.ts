// SYS03 QA V1/V3：**经员工通道**的经理处置（MCP HTTP 与插件 sidecar 两面），在真实公司 fork 上跑。
//
// 起因（QA V1，阻塞项）：MCP 的 decide_disposition 入参叫 expectedVersion，而 src/disposition.ts 只读
// expectedTaskVersion，中间没有映射，于是经通道过来的决定永远被判非法入参；原有测试直接调 core，绕过了通道，
// 所以这个断口一直没被测到。这个文件只走通道，不再直接调 core 的处置方法。
//
// 起因（QA V3）：持有人通知原先写在确认事务**之后**，两步之间崩溃就会让一个已确认的处置永远不发通知；
// 撤租（release_disposition）没有产生 claim_revoked 通知。这里断言通知在决定落地时就已经存在，且撤租有通知。
//
// Gated by RUN_SCK_CHANNEL_FORK_TESTS=1 (scripts/test-worktrees.ts sets it).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore, id } from '../src/core.ts';
import type { Credential } from '../src/contracts.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { readJsonFile, reqDir, resDir, writeFileAtomic } from '../src/comm.ts';
import { connectCompanyClient } from '../src/mcp/client';
import { createMcpHttpService } from '../src/mcp/server';
import { SidecarPool } from '../plugin/server/sidecar.ts';

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? describe : describe.skip;
const TEXT = 'SYS03 通道级回归：这段处置说明只被下面的断言读回，不驱动任何真实动作。';

type Answer = { ok: boolean; code?: string; data?: unknown; error?: string; thrown?: string };

run('SYS03 manager disposition over the real employee channels (MCP and sidecar)', () => {
  let db: CompanyDatabase | undefined;
  let scratch = '';
  let core: SurrealCompanyCore;
  let service: ReturnType<typeof createMcpHttpService> | undefined;
  let mcpUrl: URL;
  let pool: SidecarPool | undefined;
  let gm: Credential, gmB: Credential, holder: Credential;
  const channels = new Map<string, { SCK_COMM_DIR: string; SCK_COMM_KEY: string }>();
  let relaySeq = 0;

  /** One real MCP call over the HTTP service, as a caller sees it: the structured answer, or the transport failure. */
  const viaMcp = async (credential: Credential, name: string, args: Record<string, unknown>): Promise<Answer> => {
    const connection = await connectCompanyClient({ url: mcpUrl, credential, clientName: 'disposition-channel-fork' });
    try {
      const answer = await connection.client.callTool({ name, arguments: args });
      const body = answer.structuredContent as { ok?: boolean; code?: string; data?: unknown; error?: string } | undefined;
      if (!body) return { ok: false, thrown: `no structured answer: ${JSON.stringify(answer.content).slice(0, 300)}` };
      return { ok: body.ok === true, code: body.code, data: body.data, error: body.error };
    } catch (error) {
      return { ok: false, thrown: String(error) };
    } finally {
      await connection.close();
    }
  };

  /** One real sidecar relay: the request file goes through the pool's sweeper and the pool's own dispatch to core. */
  const viaSidecar = async (employeeId: string, tool: string, args: Record<string, unknown>): Promise<Answer> => {
    const channel = channels.get(employeeId);
    if (!channel) throw new Error(`no sidecar channel for ${employeeId}`);
    const name = `disp-${++relaySeq}-${tool}`;
    writeFileAtomic(join(reqDir(channel.SCK_COMM_DIR), `${name}.json`),
      JSON.stringify({ key: channel.SCK_COMM_KEY, tool, args }));
    const file = join(resDir(channel.SCK_COMM_DIR), `${name}.json`);
    const deadline = Date.now() + 20_000;
    while (!existsSync(file)) {
      if (Date.now() > deadline) throw new Error(`sidecar gave no answer to ${tool}`);
      await Bun.sleep(10);
    }
    const answer = readJsonFile<{ ok: boolean; data?: unknown; error?: string }>(file)!;
    return { ok: answer.ok, data: answer.data, error: answer.error };
  };

  const rawQuery = (sql: string, vars: Record<string, unknown>) => db!.db.query(sql, vars);

  /** A task sitting in an execute episode, the way the state machine leaves a manager gate. */
  const episode = async (title: string, holderId?: string) => {
    const task = await core.createTask(gm, { title, context: 'SYS03 synthetic channel regression only',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `chan-${title}` });
    const since = Math.floor(Date.now() / 1000);
    await rawQuery(`UPDATE ONLY $t SET state = 'blocked', blocked_to = 'owner', resume_state = 'doing',
      current_employee = $holder, lease_expires_at = $lease, dispatch_blocked_phase = 'execute',
      dispatch_blocked_since = $since, version = version + 1;`,
    { t: id('task', task.id), holder: holderId ?? null, lease: since - 600, since });
    return { taskId: task.id, phase: 'execute' as const, sinceMs: since * 1000 };
  };

  const data = (answer: Answer): Record<string, unknown> => (answer.data ?? {}) as Record<string, unknown>;
  const versionOf = async (taskId: string): Promise<number> => {
    // `FROM ONLY` 的单条结果就是记录本身（不是数组），与 src/policy-store.ts 的读法一致。
    const [row] = await rawQuery('SELECT version FROM ONLY $t;', { t: id('task', taskId) }) as [{ version: number } | undefined];
    return row!.version;
  };

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'disp-channel-'));
    db = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: `sys03_channel_${randomUUID().slice(0, 8)}`, database: 'control_plane' });
    await db.connect();
    await db.bootstrap();
    const enrollment = new LocalEnrollmentAdmin(db);
    gm = await enrollment.enroll('sys03-chan-gm-a', 'owner', ['execute', 'review', 'manage']);
    gmB = await enrollment.enroll('sys03-chan-gm-b', 'owner', ['execute', 'review', 'manage']);
    holder = await enrollment.enroll('sys03-chan-eng', 'engineering', ['execute', 'review']);
    core = new SurrealCompanyCore(db, { worktrees: { opsRepo: join(scratch, 'repo') } });
    pool = new SidecarPool({ core: core as never,
      // 这个文件只走通道转发，不碰员工会话：workforce 桩只需要在池子认为该轮换时明确报错。
      workforce: { rotate: async () => { throw new Error('fixture never rotates a credential'); } } as never,
      runDir: join(scratch, 'run'), heartbeatMs: 600_000, sweepMs: 20 });
    for (const [employeeId, role, credential] of [['sys03-chan-gm-a', 'owner', gm], ['sys03-chan-gm-b', 'owner', gmB],
      ['sys03-chan-eng', 'engineering', holder]] as const) {
      const opened = pool.env({ id: employeeId, role, credential } as never);
      channels.set(employeeId, { SCK_COMM_DIR: opened.SCK_COMM_DIR!, SCK_COMM_KEY: opened.SCK_COMM_KEY! });
    }
    service = createMcpHttpService({ core, port: 0 });
    mcpUrl = new URL(`http://127.0.0.1:${service.port}/mcp`);
  }, 600_000);

  afterAll(async () => {
    if (pool) pool.close();
    if (service) await service.close();
    if (db) await db.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }, 120_000);

  test('QA V1: MCP decide_disposition accepts the same expectedVersion field the schema publishes', async () => {
    const ep = await episode('chan-mcp-decide', 'sys03-chan-eng');
    const mcpDep = await episode('chan-mcp-decide-dep');
    const claimed = await viaMcp(gm, 'claim_disposition', { ...ep, reason: '通道级回归：MCP 认领' });
    expect(claimed.ok, `claim failed: ${claimed.error ?? claimed.thrown ?? ""} [${claimed.code ?? ""}]`).toBe(true);
    const claim = data(claimed).claim as { token?: string; episodeVersion?: number };
    expect(typeof claim?.token).toBe('string');

    const decided = await viaMcp(gm, 'decide_disposition', {
      ...ep, claimToken: claim.token, episodeVersion: claim.episodeVersion,
      action: 'defer', expectedVersion: await versionOf(ep.taskId),
      dependencies: [mcpDep.taskId], text: TEXT,
      idempotencyKey: `chan-mcp-decide-${randomUUID()}`.slice(0, 60),
    });
    // 修复前这里恒为 invalid（字段名对不上），所以通道里没有任何经理能完成处置。
    expect(decided.ok, `decide failed: ${decided.error ?? decided.thrown ?? ""} [${decided.code ?? ""}]`).toBe(true);
    expect(data(decided).outcome).toBe('decided');
  }, 240_000);

  test('QA V1: the sidecar decides through the same core, so both faces agree', async () => {
    const dep = await episode('chan-sidecar-dep', '');
    const ep = await episode('chan-sidecar-decide', 'sys03-chan-eng');
    const claimed = await viaSidecar('sys03-chan-gm-b', 'claim_disposition', { ...ep, reason: '通道级回归：sidecar 认领' });
    expect(claimed.ok, `claim failed: ${claimed.error ?? claimed.thrown ?? ""} [${claimed.code ?? ""}]`).toBe(true);
    const claim = data(claimed).claim as { token?: string; episodeVersion?: number };
    const decided = await viaSidecar('sys03-chan-gm-b', 'decide_disposition', {
      ...ep, claimToken: claim.token, episodeVersion: claim.episodeVersion,
      action: 'defer', expectedVersion: await versionOf(ep.taskId), dependencies: [dep.taskId], text: TEXT,
      idempotencyKey: `chan-sidecar-decide-${randomUUID()}`.slice(0, 60),
    });
    expect(decided.ok, `decide failed: ${decided.error ?? decided.thrown ?? ""} [${decided.code ?? ""}]`).toBe(true);
    expect(data(decided).outcome).toBe('decided');
    // 决定真的落到了任务与账本上：任务进入依赖等待，走的是既有状态机。
    const [task] = await rawQuery('SELECT state, dependencies FROM ONLY $t;', { t: id('task', ep.taskId) }) as
      [{ state: string; dependencies: unknown[] } | undefined];
    expect(task!.state).toBe('blocked');
    // 依赖以 record 存（`task:⟨uuid⟩`）：归一化后再比，id 形制的差异不该影响这条断言。
    const depIds = (task!.dependencies ?? []).map(value => String(value).replace(/^task:/, '').replace(/[⟨⟩]/g, ''));
    expect(depIds).toContain(dep.taskId);
  }, 240_000);

  test('QA V3: the holder notice lands with the decision, and a released claim notifies the task holder', async () => {
    const ep = await episode('chan-notice', 'sys03-chan-eng');
    const claimed = await viaMcp(gm, 'claim_disposition', { ...ep, reason: '通道级回归：通知与决定同事务' });
    const claim = data(claimed).claim as { token?: string; episodeVersion?: number };
    const decided = await viaMcp(gm, 'decide_disposition', {
      ...ep, claimToken: claim.token, episodeVersion: claim.episodeVersion,
      action: 'resume', expectedVersion: await versionOf(ep.taskId), text: TEXT,
      idempotencyKey: `chan-notice-${randomUUID()}`.slice(0, 60),
    });
    expect(decided.ok, `decide failed: ${decided.error ?? decided.thrown ?? ""} [${decided.code ?? ""}]`).toBe(true);
    // 决定一落地，通知就应该已经在 outbox 里（同事务），不是稍后补写。
    const [rows] = await rawQuery(
      'SELECT notice_key, kind, holder FROM holder_notice WHERE task = $t;', { t: id('task', ep.taskId) }) as
      [Array<{ notice_key: string; kind: string; holder: string }>];
    expect(rows?.map(row => row.kind)).toContain('resumed'); // noticeKindFor(resume)='resumed'
    expect(rows?.find(row => row.kind === 'resumed')?.holder).toBe('sys03-chan-eng');

    // 撤租（release_disposition）必须产生 claim_revoked，收件人是任务当前持有人。
    const ep2 = await episode('chan-release', 'sys03-chan-eng');
    const held = await viaMcp(gm, 'claim_disposition', { ...ep2, reason: '通道级回归：撤租通知' });
    const heldClaim = data(held).claim as { token?: string };
    const released = await viaMcp(gm, 'release_disposition', { ...ep2, claimToken: heldClaim.token, reason: '通道级回归：主动撤回认领' });
    expect(released.ok, `release failed: ${released.error ?? released.thrown ?? ""} [${released.code ?? ""}]`).toBe(true);
    const [revoked] = await rawQuery(
      'SELECT kind, holder FROM holder_notice WHERE task = $t AND kind = $k;',
      { t: id('task', ep2.taskId), k: 'claim_revoked' }) as [Array<{ kind: string; holder: string }>];
    expect(revoked?.length).toBe(1);
    expect(revoked?.[0]?.holder).toBe('sys03-chan-eng');
  }, 240_000);
});