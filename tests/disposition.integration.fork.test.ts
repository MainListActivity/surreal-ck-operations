// SYS03 (经理处置原子认领、幂等与变更通知) on a real company fork (never production).
// Two namespaces: `ledger` runs the manager-tool surface (claim/lease/takeover/decide/notify/external action) and
// `dispatch` runs real Dispatcher ticks over the new states (pre-wake episode verification and holder-notice delivery).
// Gated by RUN_SCK_CHANNEL_FORK_TESTS=1 (scripts/test-worktrees.ts sets it).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore, id } from '../src/core.ts';
import type { Credential } from '../src/contracts.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { Workforce } from '../src/workforce.ts';
import { DispositionLedger, type DispositionApplier, type ExternalActionGateway } from '../src/disposition.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? describe : describe.skip;
const TEXT = 'SYS03 synthetic regression: this disposition text is only read back by the assertions below.';

type TaskFact = { state: string; version: number; blocked_to: string | null; current_employee: string | null;
  dispatch_blocked_phase: string | null; dispatch_blocked_since: number | null; dependencies: unknown[] };

async function openFork(namespace: string): Promise<CompanyDatabase> {
  const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace, database: 'control_plane' });
  await database.connect();
  await database.bootstrap();
  return database;
}

/** An idle-session fake Paseo: the surface the tick, the wake path and the notice pass read. */
function fakePaseo(agentRows: Map<string, string>, sends: Array<{ agent: string; text: string }>): PaseoGateway {
  return {
    list: async () => new Map([...agentRows].map(([agent, status]) => [agent, { id: agent, status, model: 'fixture' }])),
    status: async (agent: string) => agentRows.has(agent) ? { status: agentRows.get(agent)!, pendingPermissions: 0 } : undefined,
    lastError: async () => '', logsTail: async () => 'isolated synthetic transcript', lastInputTokens: async () => 0,
    spawn: async b => { const agent = `agent-${b.labels.employee_id}`; agentRows.set(agent, 'running'); return agent; },
    send: async (agent: string, text: string) => { agentRows.set(agent, 'running'); sends.push({ agent, text }); },
    stop: async (agent: string) => { agentRows.set(agent, 'idle'); },
    reload: async (agent: string) => { agentRows.set(agent, 'idle'); },
    archive: async (agent: string) => { agentRows.set(agent, 'archived'); },
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {},
  };
}

run('SYS03 manager disposition on the company fork', () => {
  let db: CompanyDatabase | undefined;
  let dispatchDb: CompanyDatabase | undefined;
  let scratch = '';
  const obs: Record<string, unknown> = {};
  /** The claim-race task's id, recorded for the assertions that compare dependency references to it. */
  const e1Id = () => obs.e1Id as string;

  afterAll(async () => {
    await db?.close();
    await dispatchDb?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }, 120_000);

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'sys03-fork-'));
    const suffix = randomUUID().slice(0, 8);
    db = await openFork(`sys03_ledger_${suffix}`);
    dispatchDb = await openFork(`sys03_dispatch_${suffix}`);

    // ---------------------------------------------------------------- namespace 1: the ledger surface
    const gatewayCalls: Array<{ repo: string; runId: string }> = [];
    let gatewayMode: 'confirmed' | 'refused' | 'unknown' = 'confirmed';
    /** QA V2：受控外部动作要核对 run 的 head 分支与前置任务登记分支一致，所以这里的桩要能改分支。 */
    const FIXTURE_BRANCH = 'task/sys03-ci-fixture';
    let observedBranch = FIXTURE_BRANCH;
    const gateway: ExternalActionGateway = {
      cancelRun: async target => {
        gatewayCalls.push({ repo: target.repo, runId: target.runId });
        if (gatewayMode === 'confirmed') return { confirmed: true, runStatus: 'cancelled', externalAccount: 'shared-bot',
          observed: { before: 'in_progress', after: 'cancelled' } };
        if (gatewayMode === 'refused') return { refused: true, reason: 'run is already completed' };
        return { confirmed: false, error: 'provider endpoint unreachable' };
      },
      observeRun: async () => ({ readable: true, exists: true, runStatus: 'completed', conclusion: 'cancelled',
        externalAccount: 'shared-bot', headBranch: observedBranch, attribution: 'unknown_actor' }),
    };
    const core = new SurrealCompanyCore(db, { externalActions: { gateway } });
    const enrollment = new LocalEnrollmentAdmin(db);
    const gmA = await enrollment.enroll('sys03-gm-a', 'gm', ['execute', 'review', 'manage']);
    const gmB = await enrollment.enroll('sys03-gm-b', 'gm', ['execute', 'review', 'manage']);
    const gmC = await enrollment.enroll('sys03-gm-c', 'gm', ['execute', 'review', 'manage']);
    const product = await enrollment.enroll('sys03-product', 'product', ['execute', 'review', 'manage']);
    const eng = await enrollment.enroll('sys03-eng-a', 'engineering', ['execute', 'review']);
    // QA V2 负例：与前置任务执行岗**同岗位**、但不是这条任务当事人的工程员工。
    const engB = await enrollment.enroll('sys03-eng-b', 'engineering', ['execute', 'review']);
    const stranger = await enrollment.enroll('sys03-cs-a', 'cs', ['execute']);
    const byEmployee: Record<string, Credential> = { 'sys03-gm-a': gmA, 'sys03-gm-b': gmB, 'sys03-gm-c': gmC };
    await db.db.upsert(new RecordId('company_meta', 'config')).content({ eval_enabled: false, jev_decisions: false,
      quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
    const wf = new Workforce(db, join(scratch, 'ledger-credentials'));
    const rawQuery = db.db.query.bind(db.db) as unknown as typeof db.db.query;
    const rowOf = async (taskId: string): Promise<TaskFact> => (await rawQuery<[TaskFact]>(
      'SELECT state, version, blocked_to, current_employee, dispatch_blocked_phase, dispatch_blocked_since, dependencies FROM ONLY $t;',
      { t: id('task', taskId) }))[0] as TaskFact;
    const countRows = async (sql: string, vars: Record<string, unknown>): Promise<number> => {
      const [rows] = await rawQuery<[Array<{ n: number }>]>(sql, vars);
      return rows?.[0]?.n ?? 0;
    };

    /** A task blocked in an execute episode, the way the state machine leaves a manager gate. */
    const blocked = async (title: string, opts: { to?: 'gm' | 'owner'; resume?: string; holder?: string } = {}) => {
      const task = await core.createTask(gmA, { title, context: 'SYS03 synthetic regression only',
        executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `sys03-${title}` });
      const since = Math.floor(Date.now() / 1000);
      await rawQuery(`UPDATE ONLY $t SET state = 'blocked', blocked_to = $to, resume_state = $resume, current_employee = $holder,
        lease_expires_at = $lease, dispatch_blocked_phase = 'execute', dispatch_blocked_since = $since, version = version + 1;`, {
        t: id('task', task.id), to: opts.to ?? 'gm', resume: opts.resume ?? 'doing', holder: opts.holder ?? null,
        lease: since - 600, since });
      const row = await rowOf(task.id);
      return { id: task.id, sinceMs: (row.dispatch_blocked_since ?? 0) * 1000, version: row.version };
    };
    const claimOf = (task: { id: string; sinceMs: number }, reason: string) =>
      ({ taskId: task.id, phase: 'execute' as const, sinceMs: task.sinceMs, reason });
    const expireLease = (task: { id: string; sinceMs: number }) => rawQuery(
      'UPDATE disposition_claim SET lease_expires_at = time::unix(time::now()) - 10 WHERE episode = $episode;',
      { episode: `${task.id}:execute:${task.sinceMs}` });

      const e1 = await blocked('sys03-e1-claim-race');
    obs.e1Id = e1.id;
    const e2 = await blocked('sys03-e2-concurrent-decide', { resume: 'ready', holder: 'sys03-eng-a' });
    const e3 = await blocked('sys03-e3-repair', { holder: 'sys03-eng-a' });
    const e4 = await blocked('sys03-e4-stale-reminder');
    // A ready task with no open episode: nothing may be claimed or decided against it.
    const ready = await core.createTask(gmA, { title: 'sys03-e5-ready', context: 'SYS03 synthetic regression only',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'sys03-e5-ready' });

    // ---- AC01: two managers claim the same episode at once. Exactly one wins; the other reads who holds it.
    const race = await Promise.all([
      core.claimDisposition(gmA, claimOf(e1, '并发领取：经理 A 先读到旧提醒')),
      core.claimDisposition(gmB, claimOf(e1, '并发领取：经理 B 同时领取该 episode')),
    ]);
    const winners = race.filter(r => r.outcome === 'claimed');
    const losers = race.filter(r => r.outcome === 'held_by_other');
    const firstHolder = winners[0]!.claim.holder!;
    const firstToken = winners[0]!.claim.token!;
    const secondCredential = firstHolder === 'sys03-gm-a' ? gmB : gmA;
    obs.claimRace = { winners: winners.length, outcomes: race.map(r => r.outcome) };
    obs.claimRaceLoser = { holderSeen: losers[0]!.claim.holder, leakedToken: losers[0]!.claim.token ?? null };
    // The same holder claiming again is a renewal, never a second disposition right.
    obs.renew = await core.claimDisposition(byEmployee[firstHolder]!, claimOf(e1, '同一经理重复领取：只续租，不发第二个 token'));
    // A controlled release makes the episode immediately claimable again.
    obs.release = await core.releaseDisposition(byEmployee[firstHolder]!,
      { ...claimOf(e1, '撤租：交给另一位经理继续'), claimToken: firstToken })
      .then(view => ({ status: view.status, holder: view.holder ?? null }));
    const afterRelease = await core.claimDisposition(secondCredential, claimOf(e1, '撤租后由另一位经理领取'));
    obs.afterRelease = afterRelease.outcome;
    const secondHolder = afterRelease.claim.holder!;
    const leaseStatus = await core.dispositionStatus(secondCredential, claimOf(e1, ''));
    // A takeover of a live lease is refused; after the lease expires the same takeover is allowed and notified.
    obs.liveTakeoverRefused = await core.claimDisposition(gmC,
      { ...claimOf(e1, '受控接手：先尝试抢在活租约上'), takeover: true, expectedEpisodeVersion: leaseStatus.claim!.episodeVersion })
      .then(view => view.outcome, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`);
    await expireLease(e1);
    const takeover = await core.claimDisposition(gmC,
      { ...claimOf(e1, '受控接手：租约失效后接手该 episode'), takeover: true, expectedEpisodeVersion: leaseStatus.claim!.episodeVersion });
    obs.takeover = { outcome: takeover.outcome, previousHolder: 'previousHolder' in takeover ? takeover.previousHolder : undefined,
      episodeVersion: 'claim' in takeover ? takeover.claim.episodeVersion : undefined };

    // ---- AC01: a stale reminder, a phase mismatch and a task that moved on are refused before any claim is written.
    obs.refusals = {
      staleReminder: await core.claimDisposition(gmA, { ...claimOf(e4, '迟到旧提醒：episode 已经过去'), sinceMs: e4.sinceMs - 60_000 })
        .then(v => v.outcome, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
      phaseMismatch: await core.claimDisposition(gmA, { ...claimOf(e4, '阶段不匹配的领取尝试'), phase: 'review' })
        .then(v => v.outcome, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
      taskMovedOn: await core.claimDisposition(gmA, claimOf({ id: ready.id, sinceMs: e4.sinceMs }, '不在阻塞中时不得领取'))
        .then(v => v.outcome, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
      nonManager: await core.claimDisposition(eng, claimOf(e4, '非经理的领取尝试'))
        .then(v => v.outcome, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
    };
    obs.staleReadBack = await countRows('SELECT count() AS n FROM disposition_claim WHERE episode = $e GROUP ALL;',
      { e: `${e4.id}:execute:${e4.sinceMs - 60_000}` });
    obs.productMayClaim = await core.claimDisposition(product, claimOf(e4, '产品角色也可以处置该 episode')).then(v => v.outcome);

    // ---- AC02/AC05: twenty concurrent decisions on one episode. One disposition, one task transition.
    const e2Claim = await core.claimDisposition(gmA, claimOf(e2, '处置：二十个并发决定'));
    const e2Token = e2Claim.claim.token!;
    const e2VersionBefore = (await rowOf(e2.id)).version;
    const decideInput = { taskId: e2.id, phase: 'execute' as const, sinceMs: e2.sinceMs, claimToken: e2Token, episodeVersion: 1,
      action: 'defer' as const, expectedVersion: e2VersionBefore, dependencies: [e1.id], text: TEXT,
      idempotencyKey: 'sys03-decide-e2' };
    const decideRace = await Promise.all(Array.from({ length: 20 }, () =>
      core.decideDisposition(gmA, decideInput).then(v => v.outcome, (error: Error) => `error:${error.message}`)));
    const businessKey = `${e2.id}:execute:${e2.sinceMs}\0defer`;
    const e2After = await rowOf(e2.id);
    obs.decideRace = { outcomes: decideRace };
    obs.ledger = {
      actionRows: await countRows('SELECT count() AS n FROM disposition_action WHERE business_key = $k GROUP ALL;', { k: businessKey }),
      deferredAudits: await countRows("SELECT count() AS n FROM audit WHERE task = $t AND action = 'deferred' GROUP ALL;", { t: id('task', e2.id) }),
      decidedAudits: await countRows("SELECT count() AS n FROM audit WHERE task = $t AND action = 'disposition_decided' GROUP ALL;", { t: id('task', e2.id) }),
      versionMovedBy: e2After.version - e2VersionBefore,
    };
    // QA D1：重放只对**当前认领的持有人**开放，而且要它自己的 token。同一持有人（或重启后的同一个会话）重放读到
    // 同一份回执、不写第二条；另一个员工拿着别人的 token 重放只能被拒绝——上一版这里返回成功，等于把别人那条
    // 决定的内容连同「已重放」的假象交给任何员工。跨员工接手是另一条受控路径（claim_disposition 的 takeover）。
    const replay = await core.decideDisposition(gmA, { ...decideInput, idempotencyKey: 'sys03-decide-e2-replay' });
    const leakedReplay = await core.decideDisposition(gmB, { ...decideInput, idempotencyKey: 'sys03-decide-e2-leaked' })
      .then(() => 'allowed', (error: Error) => (error as { code?: string }).code ?? error.message);
    obs.replay = { outcome: replay.outcome, leaked: leakedReplay,
      taskVersion: (replay.decision?.result as { taskVersion?: number } | undefined)?.taskVersion };
    obs.replayMovedTask = (await rowOf(e2.id)).version - e2After.version;

    // ---- AC02: the repair decision builds exactly one chain and takes the source episode out of the gate.
    const e3Claim = await core.claimDisposition(gmA, claimOf(e3, '修复链处置：经理领取该 episode'));
    const e3Token = e3Claim.claim.token!;
    const repairInput = { taskId: e3.id, phase: 'execute' as const, sinceMs: e3.sinceMs, claimToken: e3Token, episodeVersion: 1,
      action: 'repair' as const, expectedVersion: (await rowOf(e3.id)).version, text: TEXT,
      repair: { title: 'sys03-e3 修复链', context: 'SYS03 synthetic repair chain', executorRole: 'engineering', reviewerRole: 'qa',
        dependencies: [e1.id] }, idempotencyKey: 'sys03-decide-e3-repair' };
    const repaired = await core.decideDisposition(gmA, repairInput);
    const repairTaskId = repaired.repairTaskId!;
    const e3After = await rowOf(e3.id);
    const repairRow = await rowOf(repairTaskId);
    obs.repair = { outcome: repaired.outcome, repairTaskId,
      source: { state: e3After.state, blockedTo: e3After.blocked_to, waitsOn: e3After.dependencies.map(d => String(d)), version: e3After.version },
      chain: { state: repairRow.state, blockedTo: repairRow.blocked_to, waitsOn: repairRow.dependencies.map(d => String(d)) } };
    obs.repairChains = await countRows("SELECT count() AS n FROM task WHERE title = 'sys03-e3 修复链' GROUP ALL;", {});
    // A repair chain that depends on the task it repairs would deadlock and is refused outright.
    obs.repairCycleRefused = await core.decideDisposition(gmA, { ...repairInput, idempotencyKey: 'sys03-decide-e3-cycle',
      repair: { ...repairInput.repair, dependencies: [e3.id] } })
      .then(v => v.outcome, (error: Error) => error.message);

    // ---- AC02/AC05: a crash between the state-machine write and its receipt is replayed, not repeated.
    const ledger = new DispositionLedger(db);
    const crashTask = await blocked('sys03-crash-replay', { resume: 'ready' });
    const crashClaim = await core.claimDisposition(gmA, claimOf(crashTask, '崩溃重放：经理领取该 episode'));
    const crashToken = crashClaim.claim.token!;
    const appliedKeys: string[] = [];
    let crash = true;
    const crashApplier = (): DispositionApplier => ({
      resume: async () => { throw new Error('unexpected resume'); },
      defer: async ({ idempotencyKey }) => {
        appliedKeys.push(idempotencyKey);
        if (crash) { crash = false; throw new Error('simulated crash after the task write, before the receipt'); }
        return { taskVersion: crashTask.version + 1, state: 'blocked' };
      },
      retire: async () => { throw new Error('unexpected retire'); },
      repair: async () => { throw new Error('unexpected repair'); },
    });
    const crashInput = { taskId: crashTask.id, phase: 'execute' as const, sinceMs: crashTask.sinceMs, claimToken: crashToken,
      episodeVersion: 1, action: 'defer' as const, expectedVersion: crashTask.version, dependencies: [e1.id], text: TEXT,
      idempotencyKey: 'sys03-crash-decide' };
    const crashOutcome = await ledger.decide({ employeeId: 'sys03-gm-a', role: 'gm' }, crashInput, crashApplier())
      .then(v => `outcome:${v.outcome}`, (error: Error) => `error:${error.message}`);
    const whileInterrupted = await core.dispositionStatus(gmA, claimOf(crashTask, ''));
    const replayed = await ledger.decide({ employeeId: 'sys03-gm-a', role: 'gm' }, crashInput, crashApplier());
    obs.crashReplay = { crashOutcome, statusWhilePending: whileInterrupted.claim?.status, replayOutcome: replayed.outcome,
      appliedKeys, confirmations: await countRows("SELECT count() AS n FROM audit WHERE task = $t AND action = 'disposition_decided' GROUP ALL;", { t: id('task', crashTask.id) }) };

    // A takeover after the crash continues the SAME business operation: one chain, one disposition, two employees.
    const takenTask = await blocked('sys03-crash-takeover', { resume: 'ready' });
    const takenClaim = await core.claimDisposition(gmA, claimOf(takenTask, '交接重放：经理 A 领取后中断'));
    const takenToken = takenClaim.claim.token!;
    const chains = new Set<string>();
    const chainApplier = (failFirst: boolean): DispositionApplier => {
      let first = failFirst;
      return {
        resume: async () => { throw new Error('unexpected resume'); },
        defer: async () => { throw new Error('unexpected defer'); },
        retire: async () => { throw new Error('unexpected retire'); },
        repair: async ({ repairKey }) => {
          chains.add(repairKey);
          if (first) { first = false; throw new Error('simulated crash: the chain was written, the receipt was not'); }
          return { taskId: `task-${repairKey}`, sourceTaskVersion: takenTask.version + 1, sourceState: 'blocked' };
        },
      };
    };
    const takenInput = { taskId: takenTask.id, phase: 'execute' as const, sinceMs: takenTask.sinceMs, claimToken: takenToken,
      episodeVersion: 1, action: 'repair' as const, expectedVersion: takenTask.version, text: TEXT,
      repair: { title: 'sys03 交接修复链', context: 'SYS03 synthetic takeover chain', executorRole: 'engineering', reviewerRole: 'qa' },
      idempotencyKey: 'sys03-takeover-decide' };
    const beforeTakeover = await ledger.decide({ employeeId: 'sys03-gm-a', role: 'gm' }, takenInput, chainApplier(true))
      .then(v => `outcome:${v.outcome}`, (error: Error) => `error:${error.message}`);
    await expireLease(takenTask);
    const takenOver = await core.claimDisposition(gmB,
      { ...claimOf(takenTask, '受控接手：继续同一条业务操作'), takeover: true, expectedEpisodeVersion: 1 });
    obs.takeoverContinue = { crashed: beforeTakeover,
      outcome: await ledger.decide({ employeeId: 'sys03-gm-b', role: 'gm' },
        { ...takenInput, claimToken: takenOver.claim.token! }, chainApplier(false))
        .then(v => ({ outcome: v.outcome, repairTaskId: v.repairTaskId }), (error: Error) => ({ outcome: `error:${error.message}` })),
      chains: [...chains] };

    // ---- QA V4: a crash between the REAL applier's task write and its receipt, replayed by ANOTHER manager.
    // 这一段刻意用真实应用器（不是注入的桩）：QA V4 的缺口就在真实应用器的幂等身份上——它按员工的 ID 算幂等键，
    // 于是接手者重放同一个业务键查不到记录，又拿旧版本去撞任务版本 CAS，决定永远卡在 requested。
    // 崩溃点用 DB 状态构造（等价于「任务写入已落库、回执没落」）：把已确认的处置回写成 requested，并把认领恢复成可接手。
    const v4Task = await blocked('sys03-v4-swap-replay', { resume: 'ready' });
    const v4ClaimA = await core.claimDisposition(gmA, claimOf(v4Task, 'QA V4：经理 A 领取该 episode'));
    const v4TokenA = v4ClaimA.claim.token!;
    const v4Seen = (await rowOf(v4Task.id)).version;
    const v4BusinessKey = `${v4Task.id}:execute:${v4Task.sinceMs}\0defer`;
    obs.v4SwapReplay = { first: await core.decideDisposition(gmA, { taskId: v4Task.id, phase: 'execute' as const,
      sinceMs: v4Task.sinceMs, claimToken: v4TokenA, episodeVersion: 1, action: 'defer' as const, expectedVersion: v4Seen,
      dependencies: [e1.id], text: TEXT, idempotencyKey: 'sys03-v4-decide' }).then(v => v.outcome) };
    await rawQuery(`UPDATE disposition_action SET state = 'requested', confirmed_at = NONE WHERE business_key = $k;`, { k: v4BusinessKey });
    await rawQuery(`UPDATE disposition_claim SET status = 'claimed', decision_action = NONE, decision_business_key = NONE,
      decision_actor = NONE, decision_at = NONE, decision_task_version = NONE, decision_result = NONE,
      lease_expires_at = time::unix(time::now()) - 10 WHERE episode = $e;`, { e: `${v4Task.id}:execute:${v4Task.sinceMs}` });
    // 认领行的记录号是 episode 的哈希，不按字面量拼；按 episode 字段读回来。
    const [v4Claims] = await rawQuery<[Array<{ episode_version: number }>]>(
      'SELECT episode_version FROM disposition_claim WHERE episode = $e;', { e: `${v4Task.id}:execute:${v4Task.sinceMs}` });
    const v4EpisodeVersion = v4Claims[0]!.episode_version;
    const v4Takeover = await core.claimDisposition(gmB,
      { ...claimOf(v4Task, 'QA V4：B 受控接手崩溃后的同一条业务操作'), takeover: true, expectedEpisodeVersion: v4EpisodeVersion });
    // 接手者拿的是**已经过期的 expectedVersion**（A 那次已经让任务版本动过），正是旧写法会卡死的地方。
    Object.assign(obs.v4SwapReplay as object, {
      takeover: v4Takeover.outcome,
      replay: await core.decideDisposition(gmB, { taskId: v4Task.id, phase: 'execute' as const, sinceMs: v4Task.sinceMs,
        claimToken: v4Takeover.claim.token!, episodeVersion: v4Takeover.claim.episodeVersion, action: 'defer' as const,
        expectedVersion: v4Seen, dependencies: [e1.id], text: TEXT, idempotencyKey: 'sys03-v4-decide' })
        .then(v => `outcome:${v.outcome}`, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
      deferredAudits: await countRows("SELECT count() AS n FROM audit WHERE task = $t AND action = 'deferred' GROUP ALL;", { t: id('task', v4Task.id) }),
      actionRows: await countRows('SELECT count() AS n FROM disposition_action WHERE business_key = $k GROUP ALL;', { k: v4BusinessKey }),
    });

    // ---- QA V6: twenty concurrent REPAIR decisions on one episode build one chain, like the defer case.
    const v6Task = await blocked('sys03-v6-repair-race', { resume: 'ready' });
    const v6Claim = await core.claimDisposition(gmA, claimOf(v6Task, 'QA V6：二十个并发修复决定'));
    const v6Input = { taskId: v6Task.id, phase: 'execute' as const, sinceMs: v6Task.sinceMs, claimToken: v6Claim.claim.token!,
      episodeVersion: 1, action: 'repair' as const, expectedVersion: (await rowOf(v6Task.id)).version, text: TEXT,
      repair: { title: 'sys03-v6 并发修复链', context: 'SYS03 synthetic concurrent repair', executorRole: 'engineering',
        reviewerRole: 'qa', dependencies: [e1.id] }, idempotencyKey: 'sys03-v6-decide-repair' };
    const v6Race = await Promise.all(Array.from({ length: 20 }, () =>
      core.decideDisposition(gmA, v6Input).then(v => v.outcome, (error: Error) => `error:${error.message}`)));
    obs.v6RepairRace = { outcomes: v6Race,
      chains: await countRows("SELECT count() AS n FROM task WHERE title = 'sys03-v6 并发修复链' GROUP ALL;", {}),
      actionRows: await countRows('SELECT count() AS n FROM disposition_action WHERE business_key = $k GROUP ALL;',
        { k: `${v6Task.id}:execute:${v6Task.sinceMs}\0repair` }),
      decidedAudits: await countRows("SELECT count() AS n FROM audit WHERE task = $t AND action = 'disposition_decided' GROUP ALL;", { t: id('task', v6Task.id) }) };

    // ---- AC04: the holder hears about the outcome, and only the holder may acknowledge it.
    const holderNotices = await core.dispositionNotices(eng);
    obs.notice = { count: holderNotices.length, kinds: holderNotices.map(n => n.kind), holder: holderNotices[0]?.holder,
      ofOther: (await core.dispositionNotices(gmC)).length,
      ackByOther: await core.ackDispositionNotices(gmC, { ids: holderNotices.map(n => n.noticeKey) })
        .then(v => `delivered:${v.delivered}`, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`) };
    obs.ackByHolder = await core.ackDispositionNotices(eng, { ids: holderNotices.map(n => n.noticeKey) }).then(v => v.delivered);
    obs.noticeAfterAck = (await core.dispositionNotices(eng)).length;
    obs.statusViews = {
      currentHolder: await core.dispositionStatus(gmC, claimOf(e1, '')),
      otherManager: await core.dispositionStatus(product, claimOf(e1, '')),
      replacedHolder: await core.dispositionStatus(byEmployee[secondHolder]!, claimOf(e1, '')),
      stranger: await core.dispositionStatus(stranger, claimOf(e1, '')).then(v => `read:${v.episodes.length}`,
        (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
    };

    // ---- AC03: the controlled external exit through the real core authorization.
    const ciTarget = { repo: 'surreal-ck/operations-fixture', runId: '4711' };
    // ---- QA V2: a controlled external action must be bound to the prerequisite task. Give e1 the registered branch
    // the run is on, and hand it to sys03-eng-a so there is a real party; sys03-eng-b is the same-role non-party
    // negative. Both facts are read by core.cancelCiRun's authorization before the gateway is ever asked to cancel.
    await rawQuery(`UPDATE ONLY $t SET worktree = $wt, current_employee = $holder;`, {
      t: id('task', e1.id),
      wt: { branch: FIXTURE_BRANCH, mode: 'exclusive', repo: ciTarget.repo, id: 'sys03-fixture-tree', intent: { kind: 'code' } },
      holder: 'sys03-eng-a' });
    const e1Version = (await rowOf(e1.id)).version;
    const confirmed = await core.cancelCiRun(gmA, { kind: 'ci-run-cancel', ...ciTarget, reason: '经理取消不再需要的 CI 运行',
      prerequisiteTaskId: e1.id, prerequisiteVersion: e1Version, actionKey: 'sys03-ci-cancel-1' });
    const replayCancel = await core.cancelCiRun(gmA, { kind: 'ci-run-cancel', ...ciTarget, reason: '经理取消不再需要的 CI 运行',
      prerequisiteTaskId: e1.id, prerequisiteVersion: e1Version, actionKey: 'sys03-ci-cancel-1' });
    const confirmedResult = confirmed.confirmedResult as { runStatus?: string; observed?: { before?: string; after?: string } } | undefined;
    obs.externalConfirmed = { state: confirmed.state, attribution: confirmed.attribution, account: confirmed.externalAccount,
      requestedBy: confirmed.requestedBy, prerequisiteVersion: confirmed.prerequisiteVersion,
      observed: { runStatus: confirmedResult?.runStatus, after: confirmedResult?.observed?.after },
      providerCalls: gatewayCalls.filter(c => c.runId === ciTarget.runId).length, replayState: replayCancel.state };
    gatewayMode = 'refused';
    obs.externalRefused = await core.cancelCiRun(gmA, { kind: 'ci-run-cancel', repo: ciTarget.repo, runId: '4712',
      reason: '经理取消一个 provider 已经结束的运行', prerequisiteTaskId: e1.id, prerequisiteVersion: e1Version,
      actionKey: 'sys03-ci-cancel-2' }).then(v => ({ state: v.state, result: v.confirmedResult }));
    gatewayMode = 'unknown';
    const unknown = await core.cancelCiRun(gmA, { kind: 'ci-run-cancel', repo: ciTarget.repo, runId: '4713',
      reason: '经理取消一个网关读不到结果的运行', prerequisiteTaskId: e1.id, prerequisiteVersion: e1Version,
      actionKey: 'sys03-ci-cancel-3' });
    const unknownRetry = await core.cancelCiRun(gmA, { kind: 'ci-run-cancel', repo: ciTarget.repo, runId: '4713',
      reason: '经理取消一个网关读不到结果的运行', prerequisiteTaskId: e1.id, prerequisiteVersion: e1Version,
      actionKey: 'sys03-ci-cancel-3' });
    obs.externalUnknown = { state: unknown.state, retryState: unknownRetry.state, attempts: unknownRetry.attempts,
      rows: await countRows('SELECT count() AS n FROM external_action WHERE action_key = $k GROUP ALL;', { k: 'sys03-ci-cancel-3' }),
      notices: (await wf.pendingHolderNotices()).filter(n => n.kind === 'external_action_unknown').length };
    gatewayMode = 'confirmed';
    obs.externalAuthz = {
      stranger: await core.cancelCiRun(stranger, { kind: 'ci-run-cancel', repo: ciTarget.repo, runId: '4714',
        reason: '无关员工的取消请求', prerequisiteTaskId: e1.id, prerequisiteVersion: e1Version, actionKey: 'sys03-ci-cancel-4' })
        .then(v => `state:${v.state}`, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
      taskParty: await core.cancelCiRun(eng, { kind: 'ci-run-cancel', repo: ciTarget.repo, runId: '4715',
        reason: '原任务实现者取消自己任务的 CI 运行', prerequisiteTaskId: e1.id, prerequisiteVersion: e1Version, actionKey: 'sys03-ci-cancel-5' })
        .then(v => `state:${v.state}`, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
      unboundRun: await core.cancelCiRun(gmC, { kind: 'ci-run-cancel', repo: ciTarget.repo, runId: '4716',
        reason: '没有前置任务时不放行取消请求', actionKey: 'sys03-ci-cancel-6' })
        .then(v => `state:${v.state}`, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
      stalePrerequisite: await core.cancelCiRun(gmA, { kind: 'ci-run-cancel', repo: ciTarget.repo, runId: '4717',
        reason: '前置任务版本已经变动时的取消请求', prerequisiteTaskId: e1.id, prerequisiteVersion: e1Version + 99, actionKey: 'sys03-ci-cancel-7' })
        .then(v => `state:${v.state}`, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
      // QA V2：同岗位但不是当事人——旧写法用「岗位 == 任务的执行岗」放行，任何一个工程员工都能取消任意 run。
      sameRoleNotParty: await core.cancelCiRun(engB, { kind: 'ci-run-cancel', repo: ciTarget.repo, runId: '4718',
        reason: '同岗位但不是这条任务当事人的取消请求', prerequisiteTaskId: e1.id, prerequisiteVersion: e1Version, actionKey: 'sys03-ci-cancel-8' })
        .then(v => `state:${v.state}`, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
      // QA V2：run 不在前置任务的登记分支上——即使调用者是当事人也不放行。
      runNotBound: await (async () => {
        observedBranch = 'task/someone-elses-branch';
        const outcome = await core.cancelCiRun(eng, { kind: 'ci-run-cancel', repo: ciTarget.repo, runId: '4719',
          reason: 'run 不在前置任务登记分支上的取消请求', prerequisiteTaskId: e1.id, prerequisiteVersion: e1Version, actionKey: 'sys03-ci-cancel-9' })
          .then(v => `state:${v.state}`, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`);
        observedBranch = FIXTURE_BRANCH;
        return outcome;
      })(),
    };
    const reconciled = await core.reconcileCiRuns(gmA, { runs: [{ repo: ciTarget.repo, runId: '9001' }] });
    obs.reconcile = { unknownActor: reconciled.unknownActor.length, attribution: reconciled.unknownActor[0]?.attribution,
      account: reconciled.unknownActor[0]?.externalAccount, requestedBy: reconciled.unknownActor[0]?.requestedBy ?? null,
      key: reconciled.unknownActor[0]?.actionKey };
    const evidence = '带外取消的运行与 sys03-eng-a 的本地会话记录时间一致（仅测试证据）';
    obs.attribute = {
      nonGm: await core.attributeCiRun(product, { actionKey: reconciled.unknownActor[0]!.actionKey, employeeId: 'sys03-eng-a', evidence })
        .then(v => `attribution:${v.attribution}`, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
      noEvidence: await core.attributeCiRun(gmA, { actionKey: reconciled.unknownActor[0]!.actionKey, employeeId: 'sys03-eng-a', evidence: 'too short' })
        .then(v => `attribution:${v.attribution}`, (error: Error) => `error:${(error as { code?: string }).code ?? error.message}`),
      gm: await core.attributeCiRun(gmA, { actionKey: reconciled.unknownActor[0]!.actionKey, employeeId: 'sys03-eng-a', evidence })
        .then(v => ({ attribution: v.attribution, requestedBy: v.requestedBy })),
    };
    obs.ownListingOnly = { requestedBy: (await core.listExternalActions(eng)).map(row => row.requestedBy),
      managerSeesAll: (await core.listExternalActions(gmC)).length };

    // ---------------------------------------------------------------- namespace 2: real dispatcher ticks
    const dCore = new SurrealCompanyCore(dispatchDb);
    const dEnrollment = new LocalEnrollmentAdmin(dispatchDb);
    const dGm = await dEnrollment.enroll('sys03-d-gm', 'gm', ['execute', 'review', 'manage']);
    await dispatchDb.db.upsert(new RecordId('company_meta', 'config')).content({ eval_enabled: false, jev_decisions: false,
      quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
    const dWf = new Workforce(dispatchDb, join(scratch, 'dispatch-credentials'));
    const owner = new OwnerDesk(dispatchDb);
    await dWf.upsertDef('sys03-d-gm', { role: 'gm', provider: 'codex', model: 'fixture', maxInstances: 2 });
    await dWf.upsertDef('sys03-d-product', { role: 'product', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const agentRows = new Map<string, string>();
    const sends: Array<{ agent: string; text: string }> = [];
    const paseo = fakePaseo(agentRows, sends);
    const rawDispatch = dispatchDb.db.query.bind(dispatchDb.db) as unknown as typeof dispatchDb.db.query;
    const dRowOf = async (taskId: string): Promise<TaskFact> => (await rawDispatch<[TaskFact]>(
      'SELECT state, version, blocked_to, current_employee, dispatch_blocked_phase, dispatch_blocked_since, dependencies FROM ONLY $t;',
      { t: id('task', taskId) }))[0] as TaskFact;
    const dBlocked = async (title: string, holder?: string) => {
      const task = await dCore.createTask(dGm, { title, context: 'SYS03 synthetic dispatch regression only',
        executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `sys03-d-${title}` });
      const since = Math.floor(Date.now() / 1000);
      await rawDispatch(`UPDATE ONLY $t SET state = 'blocked', blocked_to = 'gm', resume_state = 'doing', current_employee = $holder,
        lease_expires_at = $lease, dispatch_blocked_phase = 'execute', dispatch_blocked_since = $since, version = version + 1;`,
        { t: id('task', task.id), holder: holder ?? null, lease: since - 600, since });
      const row = await dRowOf(task.id);
      return { id: task.id, sinceMs: (row.dispatch_blocked_since ?? 0) * 1000, version: row.version };
    };
    const defs = await dWf.defs();
    const gmDef = defs.find(def => def.id === 'sys03-d-gm')!;
    const productDef = defs.find(def => def.id === 'sys03-d-product')!;
    // A live idle manager seat for the wake path, and a product seat that will hold a notice.
    const gmSeat = await dWf.spawnInst(gmDef);
    await dWf.bind(gmSeat.id, { agentId: 'agent-gm-seat', provider: 'codex', model: 'fixture' });
    agentRows.set('agent-gm-seat', 'idle');
    const holderSeat = await dWf.spawnInst(productDef);
    await dWf.bind(holderSeat.id, { agentId: 'agent-holder-seat', provider: 'codex', model: 'fixture' });
    // The holder session is busy for the first tick: the notice cannot be delivered yet and must stay pending.
    agentRows.set('agent-holder-seat', 'running');
    const newDispatcher = () => new Dispatcher({ workforce: dWf, owner, paseo, rand: () => 0,
      env: { opsRepo: scratch, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' } });

    const d1 = await dBlocked('sys03-d-wake');                   // no claim: the tick must wake a manager
    const d2 = await dBlocked('sys03-d-held');                   // live claim, no decision: no second manager
    const d3 = await dBlocked('sys03-d-race');                   // the manager decides during the pass
    const d4 = await dBlocked('sys03-d-notice', holderSeat.id);  // decided before the tick; the holder must hear about it
    // AC01 negative regression: a task whose episode E1 was disposed must be woken again once it forms a NEW episode E2.
    const d5 = await dBlocked('sys03-d-reblock');
    const d5Claim = await dCore.claimDisposition(dGm, { taskId: d5.id, phase: 'execute', sinceMs: d5.sinceMs, reason: 'E1：先处置一次，随后任务会形成新 episode' });
    const d5Decide = await dCore.decideDisposition(dGm, { taskId: d5.id, phase: 'execute', sinceMs: d5.sinceMs,
      claimToken: d5Claim.claim!.token!, episodeVersion: 1, action: 'defer', expectedVersion: d5.version,
      dependencies: [d1.id], text: TEXT, idempotencyKey: 'sys03-d-decide-d5' });
    // The task leaves that gate… and later blocks to gm again: a brand-new episode E2 with its own start.
    const d5E2Since = Math.floor(Date.now() / 1000) + 60;
    await rawDispatch(`UPDATE ONLY $t SET state = 'blocked', blocked_to = 'gm', resume_state = 'doing',
      current_employee = NONE, lease_expires_at = NONE, dispatch_blocked_phase = 'execute',
      dispatch_blocked_since = $since, dependencies = [], version = version + 1;`,
      { t: id('task', d5.id), since: d5E2Since });
    const d5E2 = await dRowOf(d5.id);
    const d6 = await dBlocked('sys03-d-reblock-control');        // never claimed: the pass must not be quiet for everyone
    const heldBefore = await dRowOf(d2.id);
    const d2Claim = await dCore.claimDisposition(dGm, { taskId: d2.id, phase: 'execute', sinceMs: d2.sinceMs, reason: '活租约：该 episode 正被处理' });
    const d3Claim = await dCore.claimDisposition(dGm, { taskId: d3.id, phase: 'execute', sinceMs: d3.sinceMs, reason: '竞态：该 episode 正在被处理' });
    const d4Claim = await dCore.claimDisposition(dGm, { taskId: d4.id, phase: 'execute', sinceMs: d4.sinceMs, reason: '通知：处置已在该轮之前完成' });
    const d4Decide = await dCore.decideDisposition(dGm, { taskId: d4.id, phase: 'execute', sinceMs: d4.sinceMs,
      claimToken: d4Claim.claim.token!, episodeVersion: 1, action: 'defer', expectedVersion: d4.version,
      dependencies: [d1.id], text: TEXT, idempotencyKey: 'sys03-d-decide-d4' });

    // The decision lands between the pass' task read and the pre-wake verification: the injection replays that window.
    const realFacts = dWf.dispositionFacts.bind(dWf);
    let injected = false;
    dWf.dispositionFacts = async (input: { episodes: readonly string[]; tasks: readonly string[] }) => {
      if (!injected && input.episodes.includes(`${d3.id}:execute:${d3.sinceMs}`)) {
        injected = true;
        await dCore.decideDisposition(dGm, { taskId: d3.id, phase: 'execute', sinceMs: d3.sinceMs, claimToken: d3Claim.claim.token!,
          episodeVersion: 1, action: 'defer', expectedVersion: d3.version, dependencies: [d1.id], text: TEXT,
          idempotencyKey: 'sys03-d-decide-d3-race' }).catch(() => undefined);
      }
      return realFacts(input);
    };

    const firstTick = await newDispatcher().tick();
    // The two diagnoses the negative regression rests on: the disposed E1 is what a by-task fallback would have found,
    // while the episode the task is in now (E2) has no claim of its own.
    const reblockFacts = await realFacts({ episodes: [`${d5.id}:execute:${d5E2Since * 1000}`], tasks: [d5.id, d6.id] });

    // AC01 negative regression, second shape: the very case where the fallback IS consulted — the dispatcher has just
    // cleared this gate's persisted start (`endStaleEpisodes` does that to every gm-gated task), so the reminder carries
    // only the task version and the ledger must answer by task. The disposed E1 must still not suppress E2.
    const d7 = await dBlocked('sys03-d-reblock-cleared');
    const d7Claim = await dCore.claimDisposition(dGm, { taskId: d7.id, phase: 'execute', sinceMs: d7.sinceMs, reason: 'E1：先处置一次，随后持久起点被调度器清掉' });
    await dCore.decideDisposition(dGm, { taskId: d7.id, phase: 'execute', sinceMs: d7.sinceMs,
      claimToken: d7Claim.claim!.token!, episodeVersion: 1, action: 'defer', expectedVersion: d7.version,
      dependencies: [d1.id], text: TEXT, idempotencyKey: 'sys03-d-decide-d7' });
    await rawDispatch(`UPDATE ONLY $t SET state = 'blocked', blocked_to = 'gm', resume_state = 'doing',
      current_employee = NONE, lease_expires_at = NONE, dispatch_blocked_phase = NONE,
      dispatch_blocked_since = NONE, dependencies = [], version = version + 1;`, { t: id('task', d7.id) });
    const d7Cleared = await dRowOf(d7.id);
    const clearedFacts = await realFacts({ episodes: [], tasks: [d7.id] });

    const heldAfterTick1 = await dRowOf(d2.id);
    const pendingAfterTick1 = await dWf.pendingHolderNotices();
    // The plugin/channel restarts: a new dispatcher over the same durable state. The holder session is idle now.
    agentRows.set('agent-holder-seat', 'idle');
    const restarted = newDispatcher();
    const secondTick = await restarted.tick();
    const thirdTick = await restarted.tick();
    obs.dispatch = {
      decideBeforeTick: d4Decide.outcome,
      ids: { wake: d1.id, held: d2.id, race: d3.id, notice: d4.id, reblock: d5.id, control: d6.id, reblockCleared: d7.id },
      tick1: { woke: firstTick.woke.map(w => w.task), handled: firstTick.decisions.filter(d => d.startsWith('gm-disposition-')) },
      tick2: { woke: secondTick.woke.map(w => w.task), handled: secondTick.decisions.filter(d => d.startsWith('gm-disposition-')),
        delivered: secondTick.decisions.filter(d => d.startsWith('holder-notice')) },
      tick3: { woke: thirdTick.woke.map(w => w.task), handled: thirdTick.decisions.filter(d => d.startsWith('gm-disposition-')) },
      reblock: { claim: d5Claim.outcome, decision: d5Decide.outcome, e2SinceMs: d5E2Since * 1000, e2: d5E2,
        facts: { byEpisodeForE2: reblockFacts.byEpisode.get(`${d5.id}:execute:${d5E2Since * 1000}`)?.status ?? null,
          byTaskStatus: reblockFacts.byTask.get(d5.id)?.status ?? null,
          byTaskSinceMs: reblockFacts.byTask.get(d5.id)?.sinceMs ?? null, e1SinceMs: d5.sinceMs,
          controlClaim: reblockFacts.byTask.has(d6.id) },
        claimRows: await rawDispatch('SELECT episode, status FROM disposition_claim WHERE task = $t;', { t: id('task', d5.id) }) },
      cleared: { episodeVersionBefore: d7Cleared.version, facts: { byTaskStatus: clearedFacts.byTask.get(d7.id)?.status ?? null,
        byTaskSinceMs: clearedFacts.byTask.get(d7.id)?.sinceMs ?? null, e1SinceMs: d7.sinceMs },
        startCleared: d7Cleared.dispatch_blocked_since ?? null },
      pendingAfterTick1: pendingAfterTick1.length,
      pendingAfterTick2: (await dWf.pendingHolderNotices()).length,
      sends: sends.map(s => ({ agent: s.agent, mentionsTask: s.text.includes(d4.id), mentionsTool: s.text.includes('disposition_status') })),
      openWakes: (await dWf.openManagerWakes()).map(row => row.key),
      held: { before: heldBefore, afterTick1: heldAfterTick1, after: await dRowOf(d2.id) },
      heldClaim: await rawDispatch('SELECT episode, status, holder, lease_expires_at FROM disposition_claim WHERE task = $t;', { t: id('task', d2.id) }),
      race: await dRowOf(d3.id),
    };
  }, 900_000);

  test('AC01: one of two simultaneous claims wins, the other reads the holder without a token', () => {
    const race = obs.claimRace as { winners: number; outcomes: string[] };
    expect(race.winners).toBe(1);
    expect(race.outcomes.filter(o => o === 'held_by_other')).toHaveLength(1);
    const loser = obs.claimRaceLoser as { holderSeen: string; leakedToken: string | null };
    expect(['sys03-gm-a', 'sys03-gm-b']).toContain(loser.holderSeen);
    expect(loser.leakedToken).toBeNull();
    expect((obs.renew as { outcome: string }).outcome).toBe('renewed');
    expect(obs.release as object).toMatchObject({ status: 'claimed', holder: null });
    expect(obs.afterRelease).toBe('claimed');
  });

  test('AC01: a controlled takeover needs an expired lease and an explicit episode version, and notifies the replaced holder', () => {
    expect(obs.liveTakeoverRefused).toMatch(/^error:/);
    const takeover = obs.takeover as { outcome: string; previousHolder?: string; episodeVersion?: number };
    expect(takeover.outcome).toBe('taken_over');
    expect(takeover.previousHolder).toBeString();
    expect(['sys03-gm-a', 'sys03-gm-b']).toContain(takeover.previousHolder!);
    expect(takeover.episodeVersion).toBe(3);

    const views = obs.statusViews as { replacedHolder: { undeliveredNotices: number } };
    expect(views.replacedHolder.undeliveredNotices).toBeGreaterThan(0);
  });

  test('AC01: stale reminders, phase mismatches, moved tasks and non-managers are refused before any claim row exists', () => {
    const refusals = obs.refusals as Record<string, string>;
    for (const outcome of Object.values(refusals)) expect(outcome).toMatch(/^error:/);
    // The stale reminder left no claim behind for the episode it named.
    expect(obs.staleReadBack).toBe(0);
    expect(obs.productMayClaim).toBe('claimed');
  });

  test('AC02/AC05: twenty concurrent decisions produce one disposition, and a restart or an employee swap reads the same result', () => {
    const outcomes = (obs.decideRace as { outcomes: string[] }).outcomes;
    expect(outcomes.filter(o => o === 'decided')).toHaveLength(1);
    expect(outcomes.filter(o => o.startsWith('error'))).toEqual([]);
    const ledger = obs.ledger as Record<string, number>;
    expect(ledger.actionRows).toBe(1);
    expect(ledger.deferredAudits).toBe(1);
    expect(ledger.decidedAudits).toBe(1);
    expect(ledger.versionMovedBy).toBe(1);
    const replay = obs.replay as { outcome: string; taskVersion?: number; leaked: string };
    expect(replay.outcome).toBe('replayed');
    expect(replay.taskVersion).toBeNumber();
    expect(obs.replayMovedTask).toBe(0);
    // QA D1：同一个 token 从别人手里交出来不算重放，只算越权读别人的决定。
    expect(replay.leaked).toBe('forbidden');
  });

  test('AC02: one repair decision builds one chain and takes the source episode out of the gate', () => {
    const repair = obs.repair as { outcome: string; repairTaskId: string;
      source: { blockedTo: string | null; waitsOn: string[] }; chain: { state: string; blockedTo: string | null; waitsOn: string[] } };
    expect(repair.outcome).toBe('decided');
    expect(repair.chain.state).toBe('blocked');
    expect(repair.chain.waitsOn).toHaveLength(1);
    expect(repair.chain.waitsOn[0]).toContain(e1Id());
    // The source leaves the manager gate and waits on its repair chain instead.
    expect(repair.source.blockedTo ?? null).toBeNull();
    expect(repair.source.waitsOn.some(dep => dep.includes(repair.repairTaskId))).toBe(true);
    expect(obs.repairChains).toBe(1);
    expect(String(obs.repairCycleRefused)).toContain('cannot depend on the task it repairs');
  });

  test('AC05: a crash between the task write and its receipt is replayed under one idempotency key, not repeated', () => {
    const crash = obs.crashReplay as { crashOutcome: string; statusWhilePending: string; replayOutcome: string; appliedKeys: string[]; confirmations: number };
    expect(crash.crashOutcome).toMatch(/^error:/);
    // The interrupted attempt left the episode claimed and nothing half-confirmed.
    expect(crash.statusWhilePending).toBe('claimed');
    expect(crash.replayOutcome).toBe('decided');
    expect(crash.confirmations).toBe(1);
    // Both attempts used the same business-derived key, so the state machine can only write once.
    expect(new Set(crash.appliedKeys).size).toBe(1);
  });

  test('AC02: a takeover continues the same business operation instead of building a second chain', () => {
    const outcome = obs.takeoverContinue as { crashed: string; outcome: { outcome: string; repairTaskId?: string }; chains: string[] };
    expect(outcome.crashed).toMatch(/^error:/);
    expect(outcome.outcome.outcome).toBe('decided');
    expect(outcome.outcome.repairTaskId).toBeString();
    expect(new Set(outcome.chains).size).toBe(1);
  });

  test('QA V4: after a receipt-only crash, another manager replays the same business key instead of stalling', () => {
    const v4 = obs.v4SwapReplay as { first: string; takeover: string; replay: string; deferredAudits: number; actionRows: number };
    expect(v4.first).toBe('decided');
    expect(v4.takeover).toBe('taken_over');
    // 修复前：接手者用的是按员工 ID 算的幂等键，查不到 A 的记录，于是又拿过期的 expectedVersion 去写，
    // 被任务版本 CAS 拒掉（error:conflict），决定永远停在 requested。修复后应读到同一结果。
    expect(v4.replay).toBe('outcome:decided');
    // 同一条业务操作只落一次任务变更、一条处置行。
    expect(v4.deferredAudits).toBe(1);
    expect(v4.actionRows).toBe(1);
  });

  test('QA V6: twenty concurrent repair decisions build one chain and one receipt', () => {
    const race = obs.v6RepairRace as { outcomes: string[]; chains: number; actionRows: number; decidedAudits: number };
    expect(race.outcomes.filter(o => o === 'decided')).toHaveLength(1);
    expect(race.outcomes.filter(o => o.startsWith('error'))).toEqual([]);
    expect(race.chains).toBe(1);
    expect(race.actionRows).toBe(1);
    expect(race.decidedAudits).toBe(1);
  });

  test('AC04: the outcome reaches the holder, nobody else may acknowledge it, and the tools read the latest decision', () => {
    const notice = obs.notice as { count: number; kinds: string[]; holder: string; ofOther: number; ackByOther: string };
    expect(notice.count).toBeGreaterThan(1);
    expect(notice.kinds).toContain('dependency_wait');
    expect(notice.kinds).toContain('disposition_decided');
    expect(notice.holder).toBe('sys03-eng-a');
    expect(notice.ofOther).toBe(0);
    expect(notice.ackByOther).toMatch(/^error:/);
    expect(obs.ackByHolder).toBe(notice.count);
    expect(obs.noticeAfterAck).toBe(0);
    const views = obs.statusViews as { currentHolder: { claim?: { holder?: string; token?: string } };
      otherManager: { claim?: { holder?: string; token?: string } }; stranger: string };
    expect(views.currentHolder.claim?.holder).toBe('sys03-gm-c');
    expect(views.currentHolder.claim?.token).toBeString();
    expect(views.otherManager.claim?.token).toBeUndefined();
    expect(views.stranger).toMatch(/^error:/);
  });

  test('AC03: a cancel records the employee, the run, the prerequisite version and the provider result, and never cancels twice on replay', () => {
    const external = obs.externalConfirmed as { state: string; attribution: string; account: string; requestedBy: string;
      prerequisiteVersion?: number; observed: { after?: string }; providerCalls: number; replayState: string };
    expect(external.state).toBe('confirmed');
    expect(external.attribution).toBe('internal_employee');
    expect(external.requestedBy).toBe('sys03-gm-a');
    expect(external.prerequisiteVersion).toBeNumber();
    // The shared provider login is only ever an account name, never a person.
    expect(external.account).toBe('shared-bot');
    expect(external.observed).toMatchObject({ runStatus: 'cancelled', after: 'cancelled' });
    expect(external.providerCalls).toBe(1);
    expect(external.replayState).toBe('confirmed');
    expect((obs.externalRefused as { state: string }).state).toBe('refused');
    const unknown = obs.externalUnknown as { state: string; attempts: number; rows: number; notices: number };
    expect(unknown.state).toBe('result_unknown');
    expect(unknown.attempts).toBe(2);
    expect(unknown.rows).toBe(1);
    expect(unknown.notices).toBeGreaterThan(0);
  });

  test('AC03: only a manager or a party of the task may cancel, and out-of-band changes stay unknown_actor until attributed with evidence', () => {
    const authz = obs.externalAuthz as Record<string, string>;
    expect(authz.stranger).toMatch(/^error:/);
    expect(authz.unboundRun).toMatch(/^error:/);
    expect(authz.stalePrerequisite).toMatch(/^error:/);
    // QA V2: a same-role employee who is not a party of the task is refused, and so is a run whose branch is not the
    // task's registered branch — the two holes the old role-equality check left open.
    expect(authz.sameRoleNotParty).toMatch(/^error:forbidden/);
    expect(authz.runNotBound).toMatch(/^error:forbidden/);
    expect(authz.taskParty).toBe('state:confirmed');
    const reconcile = obs.reconcile as { unknownActor: number; attribution: string; account: string; requestedBy: string | null };
    expect(reconcile.unknownActor).toBe(1);
    expect(reconcile.attribution).toBe('unknown_actor');
    expect(reconcile.account).toBe('shared-bot');
    expect(reconcile.requestedBy).toBeNull();
    const attribute = obs.attribute as { nonGm: string; noEvidence: string; gm: { attribution: string; requestedBy?: string } };
    expect(attribute.nonGm).toMatch(/^error:/);
    expect(attribute.noEvidence).toMatch(/^error:/);
    expect(attribute.gm).toMatchObject({ attribution: 'internal_employee', requestedBy: 'sys03-eng-a' });
    const listing = obs.ownListingOnly as { requestedBy: Array<string | undefined>; managerSeesAll: number };
    expect(listing.requestedBy.length).toBeGreaterThan(0);
    expect(listing.requestedBy.every(who => who === 'sys03-eng-a')).toBe(true);
    expect(listing.managerSeesAll).toBeGreaterThan(listing.requestedBy.length);
  });

  test('AC01: a real tick wakes a manager for a fresh episode, and never for a held or already-disposed one', () => {
    const dispatch = obs.dispatch as { ids: Record<string, string>; tick1: { woke: string[]; handled: string[] };
      held: { before: TaskFact; after: TaskFact }; race: TaskFact };
    expect(dispatch.ids.wake).toBeString();
    expect(dispatch.tick1.woke).toContain(dispatch.ids.wake);
    expect(dispatch.tick1.woke).not.toContain(dispatch.ids.held);
    expect(dispatch.tick1.woke).not.toContain(dispatch.ids.race);
    expect(dispatch.tick1.handled).toContain(`gm-disposition-held:${dispatch.ids.held}`);
    // The decision that landed mid-pass is honoured in the same tick: the episode is closed, no session is started.
    expect(dispatch.tick1.handled).toContain(`gm-disposition-handled:${dispatch.ids.race}`);
    // Zero duplicate dispatch: the held episode is untouched, and the disposed one left the gate.
    expect(dispatch.held.after.version).toBe(dispatch.held.before.version);
    expect(dispatch.held.after).toMatchObject({ state: 'blocked', blocked_to: 'gm' });
    expect(dispatch.race.state).toBe('blocked');
    expect(dispatch.race.blocked_to ?? null).toBeNull();
  });

  test('AC01: a disposed episode never suppresses the episode the task forms afterwards', () => {
    const dispatch = obs.dispatch as { ids: Record<string, string>;
      reblock: { claim: string; decision: string; e2SinceMs: number; e2: TaskFact; e1SinceMs: number;
        facts: { byEpisodeForE2: string | null; byTaskStatus: string | null; byTaskSinceMs: number | null; e1SinceMs: number; controlClaim: boolean };
        claimRows: Array<{ episode: string; status: string }> };
      cleared: { episodeVersionBefore: number; startCleared: number | null;
        facts: { byTaskStatus: string | null; byTaskSinceMs: number | null; e1SinceMs: number } };
      tick1: { woke: string[]; handled: string[] }; tick2: { woke: string[]; handled: string[] }; tick3: { woke: string[]; handled: string[] } };
    // The setup really is the reviewer's shape: the task is in a NEW episode (its own start), while the only row a
    // by-task lookup can reach is the one for the disposed E1.
    expect(dispatch.reblock.claim).toBe('claimed');
    expect(dispatch.reblock.decision).toBe('decided');
    expect(dispatch.reblock.facts.byEpisodeForE2).toBeNull();
    expect(dispatch.reblock.facts.byTaskStatus).toBe('decided');
    expect(dispatch.reblock.facts.byTaskSinceMs).toBe(dispatch.reblock.facts.e1SinceMs);
    expect(dispatch.reblock.e2.dispatch_blocked_since! * 1000).toBe(dispatch.reblock.e2SinceMs);
    expect(dispatch.reblock.e2SinceMs).not.toBe(dispatch.reblock.facts.e1SinceMs);
    expect(dispatch.reblock.claimRows).toHaveLength(1);
    // A task that formed a new episode is woken again, in the same pass and not only once.
    expect(dispatch.tick1.woke).toContain(dispatch.ids.reblock);
    expect(dispatch.tick1.handled).not.toContain(`gm-disposition-handled:${dispatch.ids.reblock}`);
    // The never-claimed control proves the pass was not quiet for everyone.
    expect(dispatch.reblock.facts.controlClaim).toBe(false);
    expect(dispatch.tick1.woke).toContain(dispatch.ids.control);
    // Second shape: the fallback IS consulted (the dispatcher cleared the gate's persisted start) and must answer
    // "unregistered", not "already disposed": the row by task is the decided E1, and the task is in a newer episode.
    expect(dispatch.cleared.startCleared).toBeNull();
    expect(dispatch.cleared.facts.byTaskStatus).toBe('decided');
    expect(dispatch.cleared.facts.byTaskSinceMs).toBe(dispatch.cleared.facts.e1SinceMs);
    expect(dispatch.tick2.woke).toContain(dispatch.ids.reblockCleared);
    for (const tick of [dispatch.tick1, dispatch.tick2, dispatch.tick3]) {
      expect(tick.handled).not.toContain(`gm-disposition-handled:${dispatch.ids.reblockCleared}`);
    }
  });

  test('AC04: a notice survives the tick that cannot deliver it and goes out after the restart, exactly once', () => {
    const dispatch = obs.dispatch as { ids: Record<string, string>; decideBeforeTick: string; tick2: { woke: string[]; delivered: string[] };
      pendingAfterTick1: number; pendingAfterTick2: number;
      sends: Array<{ agent: string; mentionsTask: boolean; mentionsTool: boolean }>; openWakes: string[] };
    expect(dispatch.decideBeforeTick).toBe('decided');
    // The holder was busy for the first tick: the notice stayed pending instead of being lost.
    expect(dispatch.pendingAfterTick1).toBe(1);
    expect(dispatch.tick2.woke).not.toContain(dispatch.ids.race);
    expect(dispatch.tick2.woke).not.toContain(dispatch.ids.held);
    expect(dispatch.tick2.delivered.some(d => d.startsWith('holder-notice:'))).toBe(true);
    const holderSends = dispatch.sends.filter(s => s.agent === 'agent-holder-seat');
    expect(holderSends).toHaveLength(1);
    expect(holderSends[0]).toMatchObject({ mentionsTask: true, mentionsTool: true });
    expect(dispatch.pendingAfterTick2).toBe(0);
    // After the restart the disposed episode holds no in-flight manager wake.
    expect(dispatch.openWakes.some(key => key.startsWith(`${dispatch.ids.race}:`))).toBe(false);
  });
});