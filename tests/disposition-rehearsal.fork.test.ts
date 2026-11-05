// QA 独立重演（SYS03 验收）：真实 `sck` 进程 → 真实 sidecar → 真实 core → 公司 fork 库。
// 唯一替换的是网络：外部动作网关用真实的 createCompanyGithubGateway，只把 gh 运行器换成 fake 端点。
//
// 来源与改动（对 QA 完全公开，逐条列在这里，不藏）：
//   * 本文件是 evidence/8124b260-…/qa-round2/qa-sys03-rehearsal.fork.test.ts 的副本，原样纳入本 lane 的回归套件，
//     所以「QA 重演过的断言」从这一轮起也在 CI 里跑。
//   * H1 原本断言「非持有人拿着别人的 token 重放会拿到一个成功答复」（`expect(stranger.ok).toBe(true)`）——那条断言
//     把 QA 报的缺陷 D1 编码成了期望值，本轮按 AC02 反转成 forbidden，并说明它证明的是什么。
//   * G4 原本断言「还没落定的 run 重放一次就是 confirmed」。这做不到而不说谎：取消请求发出去了、但 provider 既没有
//     拒绝也没有把 run 落成终态，此时能诚实说的只有 result_unknown。所以改成断言诚实契约（result_unknown、只有一次
//     provider 请求），并补上「等 run 真的 cancelled 之后按同一个 key 再读一次变 confirmed」——比原来的断言更强。
//   * G7 原来只 record 不断言；本轮补成断言（含「登记了仓库 slug 就必须同仓库」），并加一条 P4（目标形状校验）。
// 其余断言一字未动。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore, id } from '../src/core.ts';
import type { Credential } from '../src/contracts.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { createCompanyGithubGateway } from '../src/external-actions.ts';
import type { ExternalActionGateway } from '../src/disposition.ts';
import { SidecarPool } from '../plugin/server/sidecar.ts';

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? describe : describe.skip;
const CLIENT_CLI = join(import.meta.dir, '..', 'src', 'mcp', 'client-cli.ts');
const TEXT = 'QA 独立重演：这段说明只用于读回断言，不驱动任何真实动作。';
const REPAIR = { title: 'QA repair chain', context: 'QA synthetic repair body', executorRole: 'engineering', reviewerRole: 'qa' };
const ROLES: Record<string, string> = { 'qa-gm-a': 'owner', 'qa-gm-b': 'owner', 'qa-eng-a': 'engineering', 'qa-eng-b': 'engineering' };

type Channel = { SCK_COMM_DIR: string; SCK_COMM_KEY: string };
type Answer = { ok: boolean; data?: any; code?: string; error?: string };
type Episode = { taskId: string; phase: 'execute'; sinceMs: number; version: number };
type FakeRun = { status: string; conclusion: string | null; headBranch: string; actor: string; windowMs: number; cancelAt?: number };

/** One real `sck` process per call, exactly as an employee runs it. */
async function sck(channel: Channel, tool: string, args: Record<string, unknown>): Promise<Answer> {
  const child = Bun.spawn([process.execPath, CLIENT_CLI, 'call', tool, JSON.stringify(args)], {
    env: { ...process.env, SCK_COMM_DIR: channel.SCK_COMM_DIR, SCK_COMM_KEY: channel.SCK_COMM_KEY },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  let body: any;
  try { body = stdout.trim() ? JSON.parse(stdout.trim()) : undefined; } catch { body = undefined; }
  if (code === 0) return { ok: true, data: body };
  return { ok: false, code: body?.code, error: body?.error ?? (stderr.trim() || 'sck failed') };
}

const tally = (values: string[]) => values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});

run('QA rehearsal: SYS03 over real sck processes, the real sidecar and the company fork', () => {
  let db: CompanyDatabase;
  let core: SurrealCompanyCore;
  let pool: SidecarPool;
  let scratch = '';
  let channels: Record<string, Channel> = {};
  const creds: Record<string, Credential> = {};
  const evidence: Array<{ check: string; facts: unknown }> = [];
  const record = (check: string, facts: unknown) => { evidence.push({ check, facts }); };

  // ---- a fake provider behind the real gateway: the real readRun/cancel/observe logic runs, only the network is replaced
  const runs = new Map<string, FakeRun>();
  const posts: string[] = [];
  const failPost = new Set<string>();
  const providerCalls = (repo: string, runId: string) => posts.filter(p => p === `${repo}#${runId}`).length;
  const fakeGh = async (args: string[]): Promise<string> => {
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
    const path = args.find(arg => arg.startsWith('repos/')) ?? '';
    const match = /^repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(\/cancel)?$/.exec(path);
    if (!match) throw new Error('HTTP 404: Not Found');
    const key = `${match[1]}#${match[2]}`;
    const current = runs.get(key);
    if (!current) throw new Error('HTTP 404: Not Found');
    if (current.cancelAt !== undefined && Date.now() >= current.cancelAt && current.status !== 'completed') {
      current.status = 'completed';
      current.conclusion = 'cancelled';
    }
    if (method === 'POST' && match[3]) {
      posts.push(key);
      if (failPost.has(key)) throw new Error('HTTP 503: provider unavailable');
      if (current.status === 'completed') throw new Error('HTTP 409: Conflict');
      if (current.windowMs === 0) {
        current.status = 'completed';
        current.conclusion = 'cancelled';
      } else {
        current.status = 'in_progress';
        current.cancelAt = Date.now() + current.windowMs;
      }
      return '{}';
    }
    return JSON.stringify({ status: current.status, conclusion: current.conclusion, account: current.actor,
      createdAt: '2026-10-24T00:00:00Z', headBranch: current.headBranch, headSha: 'a'.repeat(40) });
  };
  const seed = (repo: string, runId: string, o: Partial<FakeRun> = {}) => {
    runs.set(`${repo}#${runId}`, { status: o.status ?? 'in_progress', conclusion: o.conclusion ?? null,
      headBranch: o.headBranch ?? 'task/qa-ci-fixture', actor: o.actor ?? 'shared-bot', windowMs: o.windowMs ?? 0 });
  };
  const realGateway = createCompanyGithubGateway(fakeGh);
  let crashAfterNextCancel = false;
  const gateway: ExternalActionGateway = {
    cancelRun: async (target, context) => {
      const result = await realGateway.cancelRun(target, context);
      if (crashAfterNextCancel) {
        crashAfterNextCancel = false;
        throw new Error('simulated crash after the provider accepted the cancel');
      }
      return result;
    },
    observeRun: target => realGateway.observeRun(target),
  };

  const q = (sql: string, vars: Record<string, unknown> = {}): Promise<any[]> => db.db.query(sql, vars) as unknown as Promise<any[]>;
  const count = async (sql: string, vars: Record<string, unknown>) => {
    const [rows] = await q(sql, vars);
    return Number(rows?.[0]?.n ?? 0);
  };
  /** The binding basis the ledger recorded for a controlled action's request (QA D5): 'repo+branch' or 'branch_only'. */
  const auditBinding = async (actionKey: string): Promise<string | null> => {
    const [rows] = await q("SELECT evidence FROM audit WHERE action = 'external_action_requested' AND string::contains(evidence, $k) LIMIT 1;",
      { k: actionKey });
    try { return JSON.parse(String(rows?.[0]?.evidence ?? '{}')).binding ?? null; } catch { return null; }
  };
  const newPool = () => new SidecarPool({
    core: core as never,
    workforce: { rotate: async () => { throw new Error('no rotation in the rehearsal'); } } as never,
    runDir: join(scratch, 'run'), heartbeatMs: 600_000, sweepMs: 20,
  });
  const openAll = () => {
    channels = {};
    for (const who of Object.keys(ROLES)) {
      const opened = pool.env({ id: who, role: ROLES[who], credential: creds[who] } as never);
      channels[who] = { SCK_COMM_DIR: opened.SCK_COMM_DIR!, SCK_COMM_KEY: opened.SCK_COMM_KEY! };
    }
  };

  /** A task blocked in an execute episode (the way the state machine leaves a manager gate), optionally held by someone. */
  async function episode(title: string, holder: string | null): Promise<Episode> {
    const task = await core.createTask(creds['qa-gm-a']!, { title, context: 'QA rehearsal: synthetic manager gate',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `qa-task-${title}-${randomUUID().slice(0, 8)}` });
    const since = Math.floor(Date.now() / 1000);
    await q(`UPDATE ONLY $t SET state = 'blocked', blocked_to = 'owner', resume_state = 'doing', current_employee = $holder,
      lease_expires_at = $lease, dispatch_blocked_phase = 'execute', dispatch_blocked_since = $since, version = version + 1;`,
    { t: id('task', task.id), holder, lease: since - 600, since });
    const [row] = await q('SELECT version FROM ONLY $t;', { t: id('task', task.id) });
    return { taskId: task.id, phase: 'execute', sinceMs: since * 1000, version: Number(row.version) };
  }

  /** A task that owns a registered branch and is held by `holder`: the party a controlled CI cancel binds to.
   *  `repo` is the repository identifier the task registers; omitted, the task registers no repository at all (QA D5). */
  async function prerequisite(holder: string, repo?: string) {
    const task = await core.createTask(creds['qa-gm-a']!, { title: 'QA CI prerequisite', context: 'QA rehearsal: prerequisite task',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `qa-prereq-${randomUUID().slice(0, 8)}` });
    await q(`UPDATE ONLY $t SET current_employee = $holder, worktree = $wt;`,
      { t: id('task', task.id), holder, wt: repo ? { branch: 'task/qa-ci-fixture', repo } : { branch: 'task/qa-ci-fixture' } });
    const [row] = await q('SELECT version FROM ONLY $t;', { t: id('task', task.id) });
    return { taskId: task.id, version: Number(row.version) };
  }

  const claimOf = (e: Episode, reason: string) => ({ taskId: e.taskId, phase: 'execute', sinceMs: e.sinceMs, reason });
  const decisionOf = (e: Episode, claim: { token?: string; episodeVersion?: number }, action: string, key: string,
    extra: Record<string, unknown> = {}) => ({ taskId: e.taskId, phase: 'execute', sinceMs: e.sinceMs,
    claimToken: claim.token, episodeVersion: claim.episodeVersion, action, expectedVersion: e.version, text: TEXT,
    idempotencyKey: key, ...extra });
  const episodeKey = (e: Episode) => `${e.taskId}:execute:${e.sinceMs}`;
  const cancelOf = (p: { taskId: string; version: number }, runId: string, actionKey: string) => ({
    repo: 'acme/ops', runId, reason: 'QA rehearsal: cancel the fixture run', prerequisiteTaskId: p.taskId,
    prerequisiteVersion: p.version, actionKey,
  });

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'qa-sys03-'));
    db = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: `qa_sys03_${randomUUID().slice(0, 8)}`, database: 'control_plane' });
    await db.connect();
    await db.bootstrap();
    const enrollment = new LocalEnrollmentAdmin(db);
    creds['qa-gm-a'] = await enrollment.enroll('qa-gm-a', 'owner', ['execute', 'review', 'manage']);
    creds['qa-gm-b'] = await enrollment.enroll('qa-gm-b', 'owner', ['execute', 'review', 'manage']);
    creds['qa-eng-a'] = await enrollment.enroll('qa-eng-a', 'engineering', ['execute', 'review']);
    creds['qa-eng-b'] = await enrollment.enroll('qa-eng-b', 'engineering', ['execute', 'review']);
    await db.db.upsert(new RecordId('company_meta', 'config')).content({ eval_enabled: false, jev_decisions: false,
      quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
    core = new SurrealCompanyCore(db, { externalActions: { gateway }, worktrees: { opsRepo: join(scratch, 'repo') } });
    pool = newPool();
    openAll();
  }, 600_000);

  afterAll(async () => {
    if (process.env.QA_REHEARSAL_OUT) writeFileSync(process.env.QA_REHEARSAL_OUT, JSON.stringify(evidence, null, 2));
    pool?.close();
    await db?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }, 120_000);

  // ---------------------------------------------------------------- AC01: two managers, the real channel
  test('AC01 (channel): two managers claim one episode at the same moment; exactly one wins and the other gets no token', async () => {
    const e = await episode('qa-a1-race', null);
    const [a, b] = await Promise.all([
      sck(channels['qa-gm-a']!, 'claim_disposition', claimOf(e, 'two managers race: A')),
      sck(channels['qa-gm-b']!, 'claim_disposition', claimOf(e, 'two managers race: B')),
    ]);
    const outcomes = [a, b].map(x => x.data?.outcome ?? `error:${x.code ?? x.error}`);
    record('A1 two-manager race', { outcomes });
    const winner = [a, b].find(x => x.data?.outcome === 'claimed');
    const loser = [a, b].find(x => x.data?.outcome === 'held_by_other');
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    expect(loser!.data.claim.token).toBeUndefined();
    expect(loser!.data.claim.holder).toBe(winner!.data.claim.holder);
  }, 180_000);

  test('AC01/AC05 (channel): twenty concurrent claims from two managers yield one claim and one token', async () => {
    const e = await episode('qa-a2-twenty-claims', null);
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      sck(channels[i % 2 === 0 ? 'qa-gm-a' : 'qa-gm-b']!, 'claim_disposition', claimOf(e, `twenty concurrent claims: ${i}`))));
    const failures = answers.filter(x => !x.ok).map(x => x.code ?? x.error);
    const outcomes = answers.map(x => x.data?.outcome ?? 'none');
    const tokens = new Set(answers.map(x => x.data?.claim?.token).filter(Boolean));
    record('A2 twenty claims', { outcomes: tally(outcomes), failures, distinctTokens: tokens.size });
    expect(failures).toEqual([]);
    expect(outcomes.filter(o => o === 'claimed')).toHaveLength(1);
    expect(tokens.size).toBe(1);
  }, 240_000);

  // ---------------------------------------------------------------- AC02/AC05: decisions, CAS, fences
  test('AC02/AC05 (channel): twenty concurrent repair decisions, half from the holder and half with the token leaked to a non-holder, build one chain and one receipt', async () => {
    const e = await episode('qa-b1-decision-race', 'qa-eng-a');
    const claim = (await sck(channels['qa-gm-a']!, 'claim_disposition', claimOf(e, 'holder for the decision race'))).data.claim;
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => sck(channels[i % 2 === 0 ? 'qa-gm-a' : 'qa-gm-b']!,
      'decide_disposition', decisionOf(e, claim, 'repair', `qa-b1-race-${i}-${randomUUID().slice(0, 8)}`, { repair: REPAIR }))));
    const holderAnswers = answers.filter((_, i) => i % 2 === 0);
    const leakedAnswers = answers.filter((_, i) => i % 2 === 1);
    const decided = answers.filter(x => x.data?.outcome === 'decided').length;
    const repairChains = await count('SELECT count() AS n FROM task WHERE title = $title AND string::contains(context, $source) GROUP ALL;',
      { title: REPAIR.title, source: e.taskId });
    const actions = await count('SELECT count() AS n FROM disposition_action WHERE episode = $episode GROUP ALL;', { episode: episodeKey(e) });
    const audits = await count("SELECT count() AS n FROM audit WHERE task = $task AND action = 'disposition_decided' GROUP ALL;",
      { task: id('task', e.taskId) });
    record('B1 twenty decisions', {
      holderOutcomes: tally(holderAnswers.map(x => x.data?.outcome ?? `error:${x.code}`)),
      leakedRefusals: tally(leakedAnswers.map(x => x.code ?? x.data?.outcome ?? 'ok')), decided, repairChains, actions, audits,
      holderCodes: tally(holderAnswers.map(x => x.data?.outcome ?? x.code ?? 'ok')),
      internalErrors: holderAnswers.filter(x => !x.ok && x.code === 'error').map(x => x.error),
      holderErrors: holderAnswers.filter(x => !x.ok).map(x => ({ code: x.code ?? null, error: x.error ?? null })),
      leakedAnswersDetail: leakedAnswers.map(x => ({ ok: x.ok, code: x.code ?? null, outcome: x.data?.outcome ?? null })),
    });
    // A non-holder never writes: exactly one decision and one repair chain exist, whoever held the leaked token.
    expect(decided).toBe(1);
    expect(leakedAnswers.every(x => !(x.data?.outcome === 'decided') && x.data?.outcome !== 'replayed')).toBe(true);
    // QA D1：拿到泄露 token 的调用连「在飞」都快照不到——重放/在飞答复只对当前持有人开放。
    expect(leakedAnswers.every(x => x.ok === false)).toBe(true);
    expect(holderAnswers.filter(x => !x.ok).map(x => x.code ?? x.error)).toEqual([]);
    expect(repairChains).toBe(1);
    expect(actions).toBe(1);
    expect(audits).toBe(1);
  }, 240_000);

  test('AC01 (channel): a late reminder for a disposed episode cannot claim it again', async () => {
    const e = await episode('qa-b2-late-reminder', 'qa-eng-a');
    const claim = (await sck(channels['qa-gm-a']!, 'claim_disposition', claimOf(e, 'holder who disposes the episode'))).data.claim;
    const decided = await sck(channels['qa-gm-a']!, 'decide_disposition', decisionOf(e, claim, 'resume', 'qa-b2-resume-0001'));
    const late = await sck(channels['qa-gm-b']!, 'claim_disposition', claimOf(e, 'late reminder after the decision'));
    record('B2 late reminder', { decided: decided.data?.outcome, late: late.data?.outcome ?? null, lateCode: late.code ?? null });
    expect(decided.data?.outcome).toBe('decided');
    expect(late.data?.outcome).not.toBe('claimed');
  }, 180_000);

  test('AC02 (channel): a stale expectedVersion, a stale episodeVersion and a leaked token from a non-holder are refused without writing', async () => {
    const e = await episode('qa-c-cas', 'qa-eng-a');
    const claim = (await sck(channels['qa-gm-a']!, 'claim_disposition', claimOf(e, 'holder for the CAS checks'))).data.claim;
    const staleVersion = await sck(channels['qa-gm-a']!, 'decide_disposition',
      decisionOf({ ...e, version: e.version - 1 }, claim, 'resume', 'qa-c-stale-version-01'));
    const staleEpisode = await sck(channels['qa-gm-a']!, 'decide_disposition',
      decisionOf(e, { ...claim, episodeVersion: claim.episodeVersion + 5 }, 'resume', 'qa-c-stale-episode-01'));
    const leaked = await sck(channels['qa-gm-b']!, 'decide_disposition', decisionOf(e, claim, 'resume', 'qa-c-leaked-token-01'));
    const actionsAfterRefusals = await count('SELECT count() AS n FROM disposition_action WHERE episode = $episode GROUP ALL;', { episode: episodeKey(e) });
    const good = await sck(channels['qa-gm-a']!, 'decide_disposition', decisionOf(e, claim, 'resume', 'qa-c-good-decision-01'));
    record('C1 CAS and fence', { staleVersion: staleVersion.code ?? staleVersion.data?.outcome, staleEpisode: staleEpisode.code ?? staleEpisode.data?.outcome,
      leaked: leaked.code ?? leaked.data?.outcome, actionsAfterRefusals, goodAfterRefusals: good.data?.outcome ?? good.error });
    expect(staleVersion).toMatchObject({ ok: false, code: 'conflict' });
    expect(staleEpisode).toMatchObject({ ok: false, code: 'conflict' });
    expect(leaked).toMatchObject({ ok: false, code: 'forbidden' });
    expect(actionsAfterRefusals).toBe(0);
    expect(good.data?.outcome).toBe('decided');
  }, 180_000);

  test('AC01 (channel): a live lease is never taken; an expired lease needs an explicit takeover, which notifies the replaced manager and revokes the old token', async () => {
    const e = await episode('qa-d-takeover', 'qa-eng-a');
    const first = (await sck(channels['qa-gm-a']!, 'claim_disposition', claimOf(e, 'manager A holds the episode'))).data.claim;
    await q('UPDATE disposition_claim SET lease_expires_at = time::unix(time::now()) - 10 WHERE episode = $episode;', { episode: episodeKey(e) });
    const plain = await sck(channels['qa-gm-b']!, 'claim_disposition', claimOf(e, 'manager B plain claim on an expired lease'));
    const noVersion = await sck(channels['qa-gm-b']!, 'claim_disposition', { ...claimOf(e, 'takeover without the episode version'), takeover: true });
    const taken = await sck(channels['qa-gm-b']!, 'claim_disposition',
      { ...claimOf(e, 'controlled takeover after expiry'), takeover: true, expectedEpisodeVersion: first.episodeVersion });
    const oldToken = await sck(channels['qa-gm-a']!, 'decide_disposition', decisionOf(e, first, 'resume', 'qa-d-old-token-0001'));
    const notices = await sck(channels['qa-gm-a']!, 'holder_notices', {});
    const replaced = (notices.data?.notices ?? []).filter((n: any) => n.kind === 'claim_taken_over' && n.taskId === e.taskId);
    const reclaim = await sck(channels['qa-gm-a']!, 'claim_disposition',
      { ...claimOf(e, 'manager A tries to take back a live lease'), takeover: true, expectedEpisodeVersion: taken.data?.claim?.episodeVersion });
    record('D1 takeover', { plain: plain.data?.outcome, noVersion: noVersion.code, taken: taken.data?.outcome, previousHolder: taken.data?.previousHolder,
      oldToken: oldToken.code ?? oldToken.data?.outcome, replacedNotices: replaced.length, reclaimOnLiveLease: reclaim.code ?? reclaim.data?.outcome });
    expect(plain.data?.outcome).toBe('held_by_other');
    expect(noVersion).toMatchObject({ ok: false, code: 'invalid' });
    expect(taken.data?.outcome).toBe('taken_over');
    expect(taken.data?.previousHolder).toBe('qa-gm-a');
    expect(oldToken).toMatchObject({ ok: false, code: 'forbidden' });
    expect(replaced).toHaveLength(1);
    // QA D9：接手通知与接手同事务落库，收件人就是被替换的那个持有人。
    expect(replaced[0]?.holder).toBe('qa-gm-a');
    expect(reclaim).toMatchObject({ ok: false, code: 'already_claimed' });
  }, 180_000);

  test('AC02/AC04 (channel): a decision whose receipt was lost is replayed by the holder under the same key once, and the holder is told it took effect', async () => {
    const e = await episode('qa-e-receipt-crash', 'qa-eng-a');
    const claim = (await sck(channels['qa-gm-a']!, 'claim_disposition', claimOf(e, 'holder who will lose the receipt'))).data.claim;
    const args = decisionOf(e, claim, 'resume', 'qa-e-receipt-crash-01');
    // The state machine writes the resume, then the process dies before the receipt is recorded.
    const realResume = (core as any).resumeRecord.bind(core);
    (core as any).resumeRecord = async (...a: unknown[]) => {
      await realResume(...a);
      throw new Error('simulated crash after the state machine write');
    };
    let crashed: string | undefined;
    try {
      await core.decideDisposition(creds['qa-gm-a']!, args as never);
    } catch (error) {
      crashed = String((error as Error).message);
    } finally {
      delete (core as any).resumeRecord;
    }
    const [afterCrash] = await q('SELECT state, current_employee FROM ONLY $t;', { t: id('task', e.taskId) });
    const [actions] = await q('SELECT state, holder_before FROM disposition_action WHERE episode = $episode;', { episode: episodeKey(e) });
    const replay = await sck(channels['qa-gm-a']!, 'decide_disposition', args);
    const resumeAudits = await count("SELECT count() AS n FROM audit WHERE task = $task AND action = 'resume' GROUP ALL;", { task: id('task', e.taskId) });
    const notices = await sck(channels['qa-eng-a']!, 'holder_notices', {});
    const resumed = (notices.data?.notices ?? []).filter((n: any) => n.taskId === e.taskId && n.kind === 'resumed');
    // Where did the receipt go instead? AC04 says the notice belongs to the task's current holder.
    const [noticeRows] = await q('SELECT kind, holder, text, payload FROM holder_notice WHERE task = $t;', { t: id('task', e.taskId) });
    record('E1 receipt-lost replay', { crashed, taskAfterCrash: afterCrash?.state, actionStateAfterCrash: actions?.[0]?.state,
      holderSnapshot: actions?.[0]?.holder_before ?? null,
      replayOk: replay.ok, replayOutcome: replay.data?.outcome ?? replay.error, resumeAudits, resumedNoticesForHolder: resumed.length,
      noticeRows: (noticeRows ?? []).map((n: any) => ({ kind: n.kind, holder: n.holder, backfill: n.payload?.backfill === true })) });
    expect(crashed).toBeString();
    expect(actions?.[0]?.state).toBe('requested');
    // QA D8：请求时的持有人快照与任务版本在同一个事务里落库，重放时通知的收件人从它读，而不是重读任务。
    expect(actions?.[0]?.holder_before).toBe('qa-eng-a');
    expect(replay.ok).toBe(true);
    expect(['decided', 'replayed']).toContain(replay.data?.outcome);
    expect(resumeAudits).toBe(1);
    expect(resumed).toHaveLength(1);
  }, 180_000);

  // ---------------------------------------------------------------- AC03/AC05: controlled external actions, real gateway
  test('AC03 (channel): the holder cancels its own run; the record keeps the employee, the run, the prerequisite version and the provider result; a replay never calls the provider again', async () => {
    const p = await prerequisite('qa-eng-a');
    seed('acme/ops', '9001');
    const args = cancelOf(p, '9001', 'qa-ci-cancel-9001');
    const first = await sck(channels['qa-eng-a']!, 'cancel_ci_run', args);
    const replay = await sck(channels['qa-eng-a']!, 'cancel_ci_run', args);
    record('G1 holder cancel', { state: first.data?.state, attribution: first.data?.attribution, requestedBy: first.data?.requestedBy,
      externalAccount: first.data?.externalAccount, prerequisiteVersion: first.data?.prerequisiteVersion, providerPosts: providerCalls('acme/ops', '9001'),
      replayState: replay.data?.state });
    expect(first.ok).toBe(true);
    expect(first.data).toMatchObject({ state: 'confirmed', attribution: 'internal_employee', requestedBy: 'qa-eng-a', externalAccount: 'shared-bot' });
    expect(providerCalls('acme/ops', '9001')).toBe(1);
    expect(replay.data?.state).toBe('confirmed');
    expect(providerCalls('acme/ops', '9001')).toBe(1);
  }, 180_000);

  test('AC03 (channel): a same-role employee who is not a party is refused, and so is a run on another branch; the provider is never called', async () => {
    const p = await prerequisite('qa-eng-a');
    seed('acme/ops', '9002');
    seed('acme/ops', '9007', { headBranch: 'main' });
    const stranger = await sck(channels['qa-eng-b']!, 'cancel_ci_run', cancelOf(p, '9002', 'qa-ci-stranger-0001'));
    const unbound = await sck(channels['qa-eng-a']!, 'cancel_ci_run', cancelOf(p, '9007', 'qa-ci-unbound-0001'));
    record('G2 authorization', { stranger: stranger.code, unbound: unbound.code, postsStranger: providerCalls('acme/ops', '9002'),
      postsUnbound: providerCalls('acme/ops', '9007') });
    expect(stranger).toMatchObject({ ok: false, code: 'forbidden' });
    expect(unbound).toMatchObject({ ok: false, code: 'forbidden' });
    expect(providerCalls('acme/ops', '9002')).toBe(0);
    expect(providerCalls('acme/ops', '9007')).toBe(0);
  }, 180_000);

  test('AC02/AC03 (channel): an action key reused for a different run is refused and never cancels that other run', async () => {
    const p = await prerequisite('qa-eng-a');
    seed('acme/ops', '9003');
    seed('acme/ops', '9004');
    failPost.add('acme/ops#9003');
    const first = await sck(channels['qa-eng-a']!, 'cancel_ci_run', cancelOf(p, '9003', 'qa-ci-reuse-0001'));
    failPost.delete('acme/ops#9003');
    const reused = await sck(channels['qa-eng-a']!, 'cancel_ci_run', cancelOf(p, '9004', 'qa-ci-reuse-0001'));
    record('G3 key reuse for another run', { first: first.data?.state, reusedOk: reused.ok, reusedCode: reused.code ?? null,
      reusedState: reused.data?.state ?? null, postsFor9004: providerCalls('acme/ops', '9004') });
    expect(first.data?.state).toBe('result_unknown');
    // QA D2：同一个 actionKey 指向另一条 run 是 conflict，而且那条 run 一次都不许被碰。
    expect(reused).toMatchObject({ ok: false, code: 'conflict' });
    expect(providerCalls('acme/ops', '9004')).toBe(0);
  }, 180_000);

  test('AC05 (channel): a cancel whose receipt was lost is replayed under the same key without a second cancel request while the run is still winding down', async () => {
    const p = await prerequisite('qa-eng-a');
    // The run needs a few hundred ms to wind down, so the replay below lands while it is still in progress.
    seed('acme/ops', '9005', { windowMs: 700 });
    const args = cancelOf(p, '9005', 'qa-ci-crash-replay-0001');
    crashAfterNextCancel = true;
    const lost = await sck(channels['qa-eng-a']!, 'cancel_ci_run', args);
    const replay = await sck(channels['qa-eng-a']!, 'cancel_ci_run', args);
    record('G4 lost receipt replay', { lost: lost.data?.state ?? lost.error, replay: replay.data?.state ?? replay.error,
      providerPosts: providerCalls('acme/ops', '9005') });
    expect(lost.data?.state).toBe('result_unknown');
    expect(providerCalls('acme/ops', '9005')).toBe(1);
    // AC05 要的是「不发第二次请求」，不是「重放必须立刻报 confirmed」。取消请求确实发出去了、provider 既没拒绝也没把
    // run 落成终态，这时唯一诚实的话是 result_unknown；伪报 confirmed 等于把一次没有确认过的取消记成已确认。
    expect(replay.data?.state).toBe('result_unknown');
    expect(providerCalls('acme/ops', '9005')).toBe(1);
    expect(replay.data?.confirmedResult).toMatchObject({ observed: { replay: 'not-settled-yet' } });
    // 等 provider 真的把运行落成 cancelled 之后，按**同一个 actionKey** 再读一次就是 confirmed——重放路径总会收尾，
    // 而且从头到尾只发过一次取消请求。
    await Bun.sleep(900);
    const settled = await sck(channels['qa-eng-a']!, 'cancel_ci_run', args);
    record('G4 lost receipt replay settles', { settled: settled.data?.state ?? settled.error, providerPosts: providerCalls('acme/ops', '9005') });
    expect(settled.data?.state).toBe('confirmed');
    expect(providerCalls('acme/ops', '9005')).toBe(1);
  }, 180_000);

  test('AC03 (channel): an out-of-band cancel stays unknown_actor through reconciliation and only gm can attribute it', async () => {
    seed('acme/ops', '9006', { status: 'completed', conclusion: 'cancelled', actor: 'github-bot', windowMs: 0 });
    const reconciled = await sck(channels['qa-gm-a']!, 'reconcile_ci_runs', { runs: [{ repo: 'acme/ops', runId: '9006' }] });
    const unknown = reconciled.data?.unknownActor?.[0];
    const engAttempt = await sck(channels['qa-eng-a']!, 'attribute_ci_run',
      { actionKey: unknown?.actionKey, employeeId: 'qa-eng-a', evidence: 'engineer tries to claim an out-of-band cancel' });
    const gmAttribute = await sck(channels['qa-gm-a']!, 'attribute_ci_run',
      { actionKey: unknown?.actionKey, employeeId: 'qa-eng-a', evidence: 'gm attributes after reading the audit trail of the run' });
    record('G5 out-of-band', { unknownActorCount: reconciled.data?.unknownActor?.length, attribution: unknown?.attribution,
      requestedBy: unknown?.requestedBy ?? null, externalAccount: unknown?.externalAccount ?? null, engAttempt: engAttempt.code,
      reconcileCode: reconciled.code ?? null, reconcileError: reconciled.error ?? null,
      gmAttribute: gmAttribute.data?.attribution ?? gmAttribute.error });
    expect(reconciled.data?.unknownActor).toHaveLength(1);
    expect(unknown).toMatchObject({ attribution: 'unknown_actor', externalAccount: 'github-bot' });
    expect(unknown.requestedBy).toBeUndefined();
    expect(engAttempt).toMatchObject({ ok: false, code: 'forbidden' });
    expect(gmAttribute.data).toMatchObject({ attribution: 'internal_employee', requestedBy: 'qa-eng-a' });
  }, 180_000);

  test('AC03 (channel): reconciliation is a read-only account of the provider, so a non-manager must not write ledger rows with it', async () => {
    seed('acme/ops', '9301', { status: 'completed', conclusion: 'cancelled', actor: 'github-bot', windowMs: 0 });
    const engReconcile = await sck(channels['qa-eng-a']!, 'reconcile_ci_runs', { runs: [{ repo: 'acme/ops', runId: '9301' }] });
    const [rows] = await q('SELECT action_key, requested_by, attribution, state FROM external_action WHERE action_key CONTAINS $frag;',
      { frag: 'acme/ops#9301' });
    record('G5b reconcile role gate', { engOk: engReconcile.ok, engCode: engReconcile.code ?? null,
      engChecked: engReconcile.data?.checked ?? null, engUnknown: engReconcile.data?.unknownActor?.length ?? null,
      ledgerRowsWritten: rows ?? [] });
    expect(engReconcile).toMatchObject({ ok: false, code: 'forbidden' });
    // 非经理连一行都不许写进账本：被拒绝的对账不能留下任何带外记录。
    expect(rows ?? []).toEqual([]);
  }, 180_000);

  test('AC03 (channel): gm cannot re-attribute an internal request, which would rewrite who asked for a real cancel', async () => {
    const p = await prerequisite('qa-eng-a');
    seed('acme/ops', '9302');
    const requested = await sck(channels['qa-eng-a']!, 'cancel_ci_run', cancelOf(p, '9302', 'qa-ci-reattribute-0001'));
    const overwrite = await sck(channels['qa-gm-a']!, 'attribute_ci_run',
      { actionKey: 'qa-ci-reattribute-0001', employeeId: 'qa-eng-b', evidence: 'gm tries to re-attribute an internal request' });
    const [row] = await q('SELECT requested_by, attribution FROM external_action WHERE action_key = $k;', { k: 'qa-ci-reattribute-0001' });
    record('G5c re-attribution', { internalState: requested.data?.state ?? null, overwriteOk: overwrite.ok, overwriteCode: overwrite.code ?? null,
      requestedByAfter: row?.[0]?.requested_by ?? null, attributionAfter: row?.[0]?.attribution ?? null });
    expect(overwrite.ok).toBe(false);
    // 拒绝之后记录必须原样：内部请求的 requested_by 是我们自己那次发起留下的真实员工，不是可以改判的字段（QA D7）。
    expect(row?.[0]?.requested_by).toBe('qa-eng-a');
    expect(row?.[0]?.attribution).toBe('internal_employee');
  }, 180_000);

  test('AC03 (channel): a run that does not exist at the provider is a definite refusal, not an unknown', async () => {
    const p = await prerequisite('qa-eng-a');
    const missing = await sck(channels['qa-eng-a']!, 'cancel_ci_run', cancelOf(p, '99999999', 'qa-ci-missing-run-0001'));
    record('G6 missing run', { ok: missing.ok, code: missing.code ?? null, state: missing.data?.state ?? null });
    expect(missing.data?.state).toBe('refused');
  }, 180_000);

  test('AC03 (channel): the binding check compares the repository when the task registers one, and records the basis when it does not', async () => {
    // 任务没有登记仓库：只能按分支绑定。依据照实记进审计证据，绝不把「只核了分支」说成「核了仓库」。
    const p = await prerequisite('qa-eng-a');
    seed('acme/other', '9101');
    const foreign = await sck(channels['qa-eng-a']!, 'cancel_ci_run',
      { ...cancelOf(p, '9101', 'qa-ci-foreign-repo-0001'), repo: 'acme/other' });
    const [row] = await q('SELECT target.repo AS repo, target.runId AS run FROM external_action WHERE action_key = $k;',
      { k: 'qa-ci-foreign-repo-0001' });
    const undeclaredBasis = await auditBinding('qa-ci-foreign-repo-0001');
    record('G7 repo binding (no registered repo)', { accepted: foreign.ok, state: foreign.data?.state ?? null, code: foreign.code ?? null,
      recordedTarget: row ?? null, posts: providerCalls('acme/other', '9101'), basis: undeclaredBasis });
    expect(foreign.data?.state).toBe('confirmed');
    expect(undeclaredBasis).toBe('branch_only');

    // 任务登记了仓库 slug：run 必须在同一个仓库里，另一个仓库同名分支的 run 一律拒绝，而且不碰 provider（QA D5）。
    const declared = await prerequisite('qa-eng-a', 'acme/ops');
    seed('acme/other', '9102');
    seed('acme/ops', '9103');
    const refusedForeign = await sck(channels['qa-eng-a']!, 'cancel_ci_run',
      { ...cancelOf(declared, '9102', 'qa-ci-foreign-repo-0002'), repo: 'acme/other' });
    const bound = await sck(channels['qa-eng-a']!, 'cancel_ci_run', cancelOf(declared, '9103', 'qa-ci-foreign-repo-0003'));
    record('G7 repo binding (registered repo)', { refusedOk: refusedForeign.ok, refusedCode: refusedForeign.code ?? null,
      postsForeign: providerCalls('acme/other', '9102'), boundState: bound.data?.state ?? bound.code ?? bound.error,
      basis: await auditBinding('qa-ci-foreign-repo-0003') });
    expect(refusedForeign).toMatchObject({ ok: false, code: 'forbidden' });
    expect(providerCalls('acme/other', '9102')).toBe(0);
    expect(bound.data?.state).toBe('confirmed');
  }, 180_000);

  test('AC03 (channel): a run that exists but is already terminal is the recorded refusal the three-state contract names', async () => {
    const p = await prerequisite('qa-eng-a');
    seed('acme/ops', '9201', { status: 'completed', conclusion: 'success', windowMs: 0 });
    const terminal = await sck(channels['qa-eng-a']!, 'cancel_ci_run', cancelOf(p, '9201', 'qa-ci-terminal-0001'));
    const [row] = await q('SELECT state, confirmed_result FROM external_action WHERE action_key = $k;', { k: 'qa-ci-terminal-0001' });
    record('G8 terminal refusal', { state: terminal.data?.state ?? terminal.code ?? terminal.error, ledger: row?.[0] ?? null,
      posts: providerCalls('acme/ops', '9201') });
    expect(terminal.data?.state).toBe('refused');
    expect(providerCalls('acme/ops', '9201')).toBe(0);
  }, 180_000);

  test('AC02 (channel) (QA D1): once an episode is decided, a non-holder presenting a token that is not theirs is refused, and reads nothing', async () => {
    const e = await episode('qa-h1-replay-fence', 'qa-eng-a');
    const claim = (await sck(channels['qa-gm-a']!, 'claim_disposition', claimOf(e, 'holder who decides first'))).data.claim;
    const args = decisionOf(e, claim, 'resume', 'qa-h1-replay-fence-01');
    const decided = await sck(channels['qa-gm-a']!, 'decide_disposition', args);
    // The same request, from an employee who is not the holder and whose token this is not.
    const stranger = await sck(channels['qa-gm-b']!, 'decide_disposition', args);
    const audits = await count("SELECT count() AS n FROM audit WHERE task = $task AND action = 'resume' GROUP ALL;", { task: id('task', e.taskId) });
    record('H1 replay fence', { decided: decided.data?.outcome, strangerOk: stranger.ok, strangerOutcome: stranger.data?.outcome ?? null,
      strangerCode: stranger.code ?? null, strangerActor: stranger.data?.decision?.actor ?? null, resumeAudits: audits });
    expect(decided.data?.outcome).toBe('decided');
    // AC02：重放读的是**别人**那条决定的内容，而「replayed」这个答复本身就在说这条决定属于你。非持有人拿别人的
    // token 重放只能是 forbidden——上一版这里返回成功，等于把别人的决定内容与「已重放」的假象交给了任何员工（QA D1）。
    expect(stranger).toMatchObject({ ok: false, code: 'forbidden' });
    expect(audits).toBe(1);
  }, 180_000);

  test('AC03 (channel) (QA P4): a target whose shape would escape the gh request path is refused before the provider is touched', async () => {
    const p = await prerequisite('qa-eng-a');
    seed('acme/ops', '9008');
    // repo/runId 直接进 `gh api` 的请求路径：形状不对就不是「参数写错了」，而是让调用方自己写路径。
    const badRepo = await sck(channels['qa-eng-a']!, 'cancel_ci_run',
      { ...cancelOf(p, '9008', 'qa-ci-bad-repo-0001'), repo: 'acme/ops/../../admin' });
    const badRunId = await sck(channels['qa-eng-a']!, 'cancel_ci_run',
      { ...cancelOf(p, '9008', 'qa-ci-bad-runid-0001'), runId: '9008?per_page=100' });
    const badReconcile = await sck(channels['qa-gm-a']!, 'reconcile_ci_runs',
      { runs: [{ repo: 'acme/ops/../../admin', runId: '9008' }] });
    record('P4 target shape', { badRepo: badRepo.code ?? null, badRunId: badRunId.code ?? null,
      badReconcile: badReconcile.code ?? null, posts: providerCalls('acme/ops', '9008') });
    expect(badRepo).toMatchObject({ ok: false, code: 'invalid' });
    expect(badRunId).toMatchObject({ ok: false, code: 'invalid' });
    expect(badReconcile).toMatchObject({ ok: false, code: 'invalid' });
    expect(providerCalls('acme/ops', '9008')).toBe(0);
  }, 180_000);

  // ---------------------------------------------------------------- AC04: the notice path through the channel
  test('AC04 (channel): a defer reaches the holder as a notice, a replayed decision adds none, and an acknowledged notice never comes back', async () => {
    const dependency = await core.createTask(creds['qa-gm-a']!, { title: 'QA dependency', context: 'QA rehearsal: dependency for defer',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `qa-dep-${randomUUID().slice(0, 8)}` });
    const e = await episode('qa-f1-defer', 'qa-eng-a');
    const claim = (await sck(channels['qa-gm-a']!, 'claim_disposition', claimOf(e, 'holder for the defer notice'))).data.claim;
    const args = decisionOf(e, claim, 'defer', 'qa-f1-defer-0001', { dependencies: [dependency.id] });
    const deferred = await sck(channels['qa-gm-a']!, 'decide_disposition', args);
    const seen = async () => ((await sck(channels['qa-eng-a']!, 'holder_notices', {})).data?.notices ?? [])
      .filter((n: any) => n.taskId === e.taskId);
    const first = await seen();
    const replayed = await sck(channels['qa-gm-a']!, 'decide_disposition', args);
    const afterReplay = await seen();
    const acked = await sck(channels['qa-eng-a']!, 'holder_notices', { ids: first.map((n: any) => n.noticeKey), ack: true });
    const afterAck = await seen();
    record('F1 defer notices', { deferred: deferred.data?.outcome, kinds: first.map((n: any) => n.kind), replayed: replayed.data?.outcome,
      afterReplay: afterReplay.length, acked: acked.ok, afterAck: afterAck.length });
    expect(deferred.data?.outcome).toBe('decided');
    expect(first.map((n: any) => n.kind)).toContain('dependency_wait');
    expect(afterReplay).toHaveLength(first.length);
    expect(acked.ok).toBe(true);
    expect(afterAck).toHaveLength(0);
  }, 180_000);

  test('AC04 (channel): after a plugin restart an unacknowledged notice is still delivered; the latest decision reads back through the status tool', async () => {
    const e = await episode('qa-f2-restart', 'qa-eng-a');
    const claim = (await sck(channels['qa-gm-a']!, 'claim_disposition', claimOf(e, 'holder for the restart check'))).data.claim;
    const resumed = await sck(channels['qa-gm-a']!, 'decide_disposition', decisionOf(e, claim, 'resume', 'qa-f2-resume-0001'));
    pool.close();
    pool = newPool();
    openAll();
    const afterRestart = ((await sck(channels['qa-eng-a']!, 'holder_notices', {})).data?.notices ?? [])
      .filter((n: any) => n.taskId === e.taskId);
    const status = await sck(channels['qa-eng-a']!, 'disposition_status', { taskId: e.taskId });
    const acked = await sck(channels['qa-eng-a']!, 'holder_notices', { ids: afterRestart.map((n: any) => n.noticeKey), ack: true });
    const afterAck = ((await sck(channels['qa-eng-a']!, 'holder_notices', {})).data?.notices ?? [])
      .filter((n: any) => n.taskId === e.taskId);
    record('F2 restart', { resumed: resumed.data?.outcome, kindsAfterRestart: afterRestart.map((n: any) => n.kind),
      statusLatestAction: status.data?.episodes?.[0]?.decision?.action ?? status.error, acked: acked.ok, afterAck: afterAck.length });
    expect(resumed.data?.outcome).toBe('decided');
    expect(afterRestart.map((n: any) => n.kind)).toContain('resumed');
    expect(status.data?.episodes?.[0]?.decision?.action).toBe('resume');
    expect(acked.ok).toBe(true);
    expect(afterAck).toHaveLength(0);
  }, 180_000);
});
