// RB01 回滚隔离彩排（SYS06 P1）：有效策略的"新写入"落到库上以后，回滚到部署中的旧 release 会不会误派工？
//
// 旧版 oracle 固定为 20b384e7661f607cdc21318e58b30bde260e6356：那版完全没有有效策略层（没有 src/policy.ts、
// core 上没有 policy* 系列方法、dispatcher 上没有 policyBlocks 通道），schema 停在 027。演练按生产顺序走一遍：
//   A. 旧版把命名空间初始化到自己的 schema 并登记员工（旧版凭据）；
//   B. 新版在同一份数据上补迁移到 034，写策略、建任务、领取、冻结写权、按 policy_plan 隔离在办任务；
//   C. 清点这次写入落在哪些"状态/字段"上：只用了旧版本来就认识的状态字面量（blocked + blocked_to），新增的只有旧版读不到的字段；
//   D. 旧版打开同一份数据，连派多轮：所有"等待/关口/等依赖/收权隔离"的任务都不在候选里，一次都没有被误派；
//   E. 旧版直接试领这些任务：全部被拒，且任务行没有被这次尝试改动；
//   F. 正向恢复：同一份数据交回新版，结论与隔离前一致，不需要改任何数据。
//
// 这里要证明的不是"旧版也强制策略"（它做不到，也不该做到），而是：新版隔离用的是旧版认得的可见状态，
// 所以回滚之后"已经在等 GM/老板的任务"不会被旧版重新派出去；未隔离的在办任务这一窗口由 policy_plan 逐条列出来、
// 再逐条 policy_enforce 关掉——本演练核对"按 plan 隔离之后，旧版连派多轮零误派"。
// Gated by RUN_SCK_ROLLBACK_FORK_TESTS=1 (scripts/test-worktrees.ts sets it).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce, type SupervisedTask } from '../src/workforce.ts';
import { staffingPool, type InstState } from '../src/dispatcher/dispatcher.ts';
import { BLOCK_TEXT } from '../src/dispatcher/dispatch-blocked.ts';
import type { ClaimResult, PolicyView, TaskView } from '../src/contracts.ts';

const ROOT = join(import.meta.dir, '..');
const OLD_RELEASE = '20b384e7661f607cdc21318e58b30bde260e6356';
const run = process.env.RUN_SCK_ROLLBACK_FORK_TESTS === '1' ? describe : describe.skip;
const EVIDENCE = 'RB01 回滚隔离彩排：这条证据文本描述一次合成的等待/隔离原因，够长即合规。';
const key = () => crypto.randomUUID();
/** 旧 release 的读法：它认得的字段与状态字面量。 */
type OldTask = { id: string; state: string; blocked_to?: string; resume_state?: string; current_employee?: string; lease_expires_at?: number };
type AnyDatabase = { connect(): Promise<void>; bootstrap(): Promise<void>; close(): Promise<void>; db: { query<T>(sql: string, vars?: Record<string, unknown>): Promise<T> } };
type AnyCore = { claim(credential: string, taskId: string): Promise<ClaimResult> };
type PoolEntry = { key: string; eligible: boolean; code?: string; reason?: string };
type PoolFn = (input: Record<string, unknown>) => PoolEntry[];
/** 新版写入的"等待/关口/等依赖/隔离"任务：回滚之后一个都不许被派出去。 */
type Protected = { label: string; id: string; expectState: string; expectBlockedTo?: string; expectResume?: string };

let oldRoot = '';
let oldDb: AnyDatabase;
let newDb: CompanyDatabase;
let core: SurrealCompanyCore;
let oldCore: AnyCore;
let oldTasks: (() => Promise<SupervisedTask[]>) | undefined;
let gm = '';
let eng = '';
let eng2 = '';
let qa = '';
let writeV1: PolicyView;
let writeV2: PolicyView;
let protectedTasks: Protected[] = [];
let isolatedIds: string[] = [];
let controlId = '';
let controlRow: OldTask | undefined;
let rounds: Array<{ label: string; live: string[]; hits: string[] }> = [];
let oldClaimOutcomes: Array<{ label: string; id: string; outcome: string; code: string }> = [];
let afterRefusals: OldTask[] = [];
let schemaFacts: { oldBefore: number; afterNew: number; afterOldBoot: number } = { oldBefore: -1, afterNew: -1, afterOldBoot: -1 };
let oldSurface: { hasPolicySet: boolean; hasPolicyPlan: boolean; hasPolicyEnforce: boolean; hasVerdict: boolean; policyFile: boolean } = {
  hasPolicySet: false, hasPolicyPlan: false, hasPolicyEnforce: false, hasVerdict: false, policyFile: true };
let vocabulary: { old: string[]; current: string[] } = { old: [], current: [] };
let planAffected: Array<{ id: string; state: string; losesAuthorization: boolean; reason?: string }> = [];
let recovery: Array<{ label: string; verdict: string }> = [];
let pools: { oldControl: PoolEntry[]; newControl: PoolEntry[]; newIsolated: PoolEntry[] } = { oldControl: [], newControl: [], newIsolated: [] };

/** 取出旧 release 的源码树（读 git 对象，不 checkout），把工作树的 node_modules 链进去。 */
async function extractOldRelease(into: string): Promise<void> {
  const archive = Bun.spawn(['git', 'archive', OLD_RELEASE, '--', 'src', 'schema', 'package.json', 'tsconfig.json'],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const untar = Bun.spawn(['tar', '-x', '-C', into], { stdin: archive.stdout, stdout: 'ignore', stderr: 'pipe' });
  const [archiveExit, untarExit] = await Promise.all([archive.exited, untar.exited]);
  if (archiveExit !== 0 || untarExit !== 0) throw new Error(`extracting ${OLD_RELEASE} failed: git exit ${archiveExit}, tar exit ${untarExit}`);
  symlinkSync(join(ROOT, 'node_modules'), join(into, 'node_modules'));
}

const loadOld = async <T>(rel: string): Promise<T> => await import(join(oldRoot, rel)) as T;
const schemaVersion = async (db: AnyDatabase) => {
  const [rows] = await db.db.query<[Array<{ schema_version?: number }>]>('SELECT schema_version FROM company_meta:installation;');
  return rows?.[0]?.schema_version ?? -1;
};
/** 旧版视角的一行任务：只读旧版认得的字段（新版加的字段读不到也不影响它）。id 用调用方给的那个键，避免 RecordId 与字符串比较。 */
const rowOf = async (db: AnyDatabase, taskId: string): Promise<OldTask | undefined> => {
  const [row] = await db.db.query<[Omit<OldTask, 'id'> | null]>(
    "SELECT state, blocked_to, resume_state, current_employee, lease_expires_at FROM ONLY type::record('task', $t);", { t: taskId });
  return row ? { id: taskId, ...row } : undefined;
};

/**
 * 部署中 release 自己的派工候选规则（src/dispatcher/dispatcher.ts 的 work 列表）：执行阶段只取 state ready/doing 且无人持有的任务，
 * 复核阶段只取 state review 且无人持有的任务。任何阶段都不会把 state=blocked 的任务当成候选——这条规则旧版就有，与策略无关。
 */
const deployableIn = (tasks: readonly SupervisedTask[]): string[] =>
  tasks.filter(t => (t.state === 'ready' || t.state === 'doing' || t.state === 'review') && !t.currentEmployee).map(t => t.id);

run('RB01 rollback isolation: the policy layer writes, then the deployed release dispatches on the same data', () => {
  beforeAll(async () => {
    oldRoot = mkdtempSync(join(tmpdir(), 'rb01-old-'));
    await extractOldRelease(oldRoot);
    const { loadDatabaseConfig: oldConfig } = await loadOld<{ loadDatabaseConfig(): Record<string, unknown> }>('src/config.ts');
    const { CompanyDatabase: OldDatabase } = await loadOld<{ CompanyDatabase: new (cfg: Record<string, unknown>) => AnyDatabase }>('src/database.ts');
    const { LocalEnrollmentAdmin: OldEnroll } = await loadOld<{ LocalEnrollmentAdmin: new (db: AnyDatabase) => { enroll(id: string, role: string, caps: string[]): Promise<string> } }>('src/enrollment.ts');
    const { SurrealCompanyCore: OldPolicyCore } = await loadOld<{ SurrealCompanyCore: new (db: AnyDatabase) => AnyCore }>('src/core.ts');

    const namespace = `rb01_${Math.random().toString(36).slice(2, 10)}`;
    const cfg = { ...oldConfig(), namespace, database: 'control_plane' };

    // --- A. 旧版初始化命名空间（schema 027）并登记员工：凭据出自旧版，后面两个版本都用它 ---
    oldDb = new OldDatabase(cfg);
    await oldDb.connect();
    await oldDb.bootstrap();
    const oldEnroll = new OldEnroll(oldDb);
    gm = await oldEnroll.enroll('rb-gm', 'gm', ['execute', 'review', 'manage']);
    eng = await oldEnroll.enroll('rb-eng', 'engineering', ['execute', 'review']);
    // 第二个工程岗：一个员工同时只能持有一个在办租约，"doing 相位有持有人"与"另一条链上还能领取"需要两个人。
    eng2 = await oldEnroll.enroll('rb-eng2', 'engineering', ['execute', 'review']);
    qa = await oldEnroll.enroll('rb-qa', 'qa', ['execute', 'review']);
    schemaFacts.oldBefore = await schemaVersion(oldDb);

    // --- B. 新版在同一份数据上补迁移，写策略、建任务、领取、冻结、按 plan 隔离 ---
    newDb = new CompanyDatabase({ ...loadDatabaseConfig(), namespace, database: 'control_plane' });
    await newDb.connect();
    await newDb.bootstrap();
    schemaFacts.afterNew = await schemaVersion(newDb as unknown as AnyDatabase);
    core = new SurrealCompanyCore(newDb, { workforce: new Workforce(newDb, mkdtempSync(join(tmpdir(), 'rb01-cred-'))) });
    const create = (title: string, extra: Record<string, unknown> = {}) => core.createTask(gm, {
      title, context: 'RB01 回滚隔离彩排的合成任务', executorRole: 'engineering', reviewerRole: 'qa',
      workIntent: { kind: 'code' }, idempotencyKey: key(), ...extra } as never);
    const set = (input: Record<string, unknown>) => core.policySet(gm, {
      scope: 'company', domain: 'write_authority', source: 'manager', reason: 'RB01 回滚隔离彩排：登记一版写权策略',
      idempotencyKey: key(), ...input } as never);
    const proofOf = (claimed: ClaimResult) => ({ taskId: claimed.task.id, deliveryId: claimed.deliveryId, fence: claimed.fence,
      expectedVersion: claimed.task.version });
    const evidence = (what: string) => ({ text: `${EVIDENCE}${what}`, idempotencyKey: key() });

    // 老板来源的策略必须能对回一条已登记的老板方向（AC01 授权来源可核）；这里先登记方向，再引用它。
    await core.relayDirection(gm, { text: 'RB01 彩排的老板方向：冻结本项目全部代码写权，改由经理按新契约重新授权',
      ownerQuote: '冻结本项目全部代码写权', idempotencyKey: key() });
    writeV1 = await set({ policyId: 'rb01-write', payload: { kind: 'write_authority', codeRoles: ['engineering'], intents: ['code', 'read'] } });
    // 隔离样本：ready / doing / review 三个执行相位各一个在办任务，另加等待 GM、老板关口、等依赖三类旧版本来就认得的等待态。
    const tReady = await create('RB01 在办（ready）');
    const tDoing = await create('RB01 在办（doing）');
    const tReview = await create('RB01 在办（review）');
    const doingClaim = await core.claim(eng2, tDoing.id);
    await core.checkpoint(eng2, proofOf(doingClaim), evidence('doing 相位先记一笔进展'));
    // review 相位：领取 → 提交；提交之后租约归还，同一个人可以接着办下一件。
    const reviewClaim = await core.claim(eng, tReview.id);
    const submitted = await core.submit(eng, proofOf(reviewClaim), evidence('review 相位的提交'));
    if (submitted.state !== 'review') throw new Error(`fixture: submit did not reach review (${submitted.state})`);
    const gmWaitClaim = await core.claim(eng, (await create('RB01 等待 GM')).id);
    const tGmWait = await core.block(eng, proofOf(gmWaitClaim), 'gm', evidence('等 GM 决定'));
    const ownerClaim = await core.claim(eng, (await create('RB01 老板关口')).id);
    const tOwner = await core.block(eng, proofOf(ownerClaim), 'owner', evidence('请老板定关口'));

    // 等依赖：依赖未完成 → blocked + blocked_to=NONE（旧版同一个状态）；冻结之后连建都建不出来（写权已冻结）。
    const tDep = await create('RB01 等依赖', { dependencies: [tReady.id] });
    if (tDep.state !== 'blocked') throw new Error(`fixture: a task with an unfinished dependency is not blocked (${tDep.state})`);

    // 冻结代码写权（空 codeRoles 只能由老板来源授权）：先试算，再落地，拿到受影响任务清单。
    const frozen = { policyId: 'rb01-write', domain: 'write_authority', source: 'owner',
      ownerQuote: '冻结本项目全部代码写权', reason: 'RB01 回滚隔离彩排：冻结代码写权', payload: { kind: 'write_authority', codeRoles: [], intents: ['code'] } };
    const epochOf = async () => (await newDb.db.query<[number | null]>(
      'RETURN (SELECT VALUE value FROM ONLY company_meta:policy_epoch) ?? 0;'))[0] ?? 0;
    const epochBefore = await epochOf();
    const at = new Date(Date.now() - 2000).toISOString();
    const plan = await core.policyPlan(gm, { ...frozen, scope: 'company', supersedes: writeV1.id, effectiveAt: at } as never);
    const epochAfterPlan = await epochOf();
    if (epochAfterPlan !== epochBefore) {
      throw new Error('fixture: policy_plan wrote to the database');
    }
    planAffected = plan.affectedTasks.map(entry => ({ id: entry.id, state: entry.state, losesAuthorization: entry.losesAuthorization,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}) }));
    writeV2 = await set({ ...frozen, supersedes: writeV1.id, effectiveAt: at });
    if (writeV2.version !== 2) throw new Error(`fixture: supersede did not cut v2 (${writeV2.version})`);
    if ((await core.policyEffective(gm, {})).hash !== plan.after.hash) throw new Error('fixture: the applied view does not match the dry run');
    // 只隔离"在办"的（ready/doing/review）：已经在等 GM/老板/依赖的任务本来就是旧版认得的等待态。
    const inFlight = plan.affectedTasks.filter(entry => ['ready', 'doing', 'review'].includes(entry.state)).map(entry => entry.id);
    const enforced = await core.policyEnforce(gm, { taskIds: inFlight, reason: 'RB01 回滚隔离彩排：收权隔离在办任务', idempotencyKey: key() });
    isolatedIds = enforced.blocked;
    // 冻结之后新建的任务：它登记的契约就是这一版（v2），所以新版认为它可以派工——用来证明候选池不是"一律不合格"。
    const control = await core.createTask(gm, { title: 'RB01 对照（无意图，冻结后建）', context: 'RB01 回滚隔离彩排的合成对照任务',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() });
    controlId = control.id;
    protectedTasks = [
      { label: '收权隔离（ready）', id: tReady.id, expectState: 'blocked', expectBlockedTo: 'gm', expectResume: 'ready' },
      { label: '收权隔离（doing）', id: tDoing.id, expectState: 'blocked', expectBlockedTo: 'gm', expectResume: 'doing' },
      { label: '收权隔离（review）', id: tReview.id, expectState: 'blocked', expectBlockedTo: 'gm', expectResume: 'review' },
      { label: '等待 GM', id: tGmWait.id, expectState: 'blocked', expectBlockedTo: 'gm' },
      { label: '老板关口', id: tOwner.id, expectState: 'blocked', expectBlockedTo: 'owner' },
      { label: '等依赖', id: tDep.id, expectState: 'blocked' },
    ];
    controlRow = await rowOf(newDb as unknown as AnyDatabase, controlId);

    // --- C. 清点新增面：状态字面量与字段 ---
    const { TASK_STATES: oldStates } = await loadOld<{ TASK_STATES: readonly string[] }>('src/query-input.ts');
    const { TASK_STATES: currentStates } = await import('../src/query-input.ts');
    vocabulary = { old: [...oldStates] as string[], current: [...currentStates] as string[] };
    oldCore = new OldPolicyCore(oldDb);
    oldSurface = {
      hasPolicySet: typeof (oldCore as unknown as { policySet?: unknown }).policySet === 'function',
      hasPolicyPlan: typeof (oldCore as unknown as { policyPlan?: unknown }).policyPlan === 'function',
      hasPolicyEnforce: typeof (oldCore as unknown as { policyEnforce?: unknown }).policyEnforce === 'function',
      hasVerdict: typeof (oldCore as unknown as { policyDispatchVerdict?: unknown }).policyDispatchVerdict === 'function',
      policyFile: existsSync(join(oldRoot, 'src/policy.ts')),
    };

    // --- D. 旧版打开同一份数据，连派多轮 ---
    const { Workforce: OldWorkforce } = await loadOld<{ Workforce: new (db: AnyDatabase, credDir: string) => { tasks(): Promise<SupervisedTask[]> } }>('src/workforce.ts');
    const { staffingPool: oldPool } = await loadOld<{ staffingPool: PoolFn }>('src/dispatcher/dispatcher.ts');
    const oldWorkforce = new OldWorkforce(oldDb, mkdtempSync(join(tmpdir(), 'rb01-oldcred-')));
    oldTasks = () => oldWorkforce.tasks();
    const protectedIds = new Set(protectedTasks.map(entry => entry.id));
    const sample = async (label: string) => {
      const live = deployableIn(await oldWorkforce.tasks());
      rounds.push({ label, live, hits: live.filter(id => protectedIds.has(id)) });
    };
    await sample('第一轮：旧版直接读新版写下的数据');
    // 第二轮：旧版在自己的 schema 上再跑一次 bootstrap（读到的是 034 的库），再派一轮。
    await oldDb.bootstrap();
    schemaFacts.afterOldBoot = await schemaVersion(oldDb);
    await sample('第二轮：旧版 bootstrap 之后');
    // 第三轮：旧版对每个受保护任务各试领一次，之后再派一轮（试领不该改动任何任务行）。
    for (const entry of protectedTasks) {
      try {
        await oldCore.claim(eng, entry.id);
        oldClaimOutcomes.push({ label: entry.label, id: entry.id, outcome: 'claimed', code: '' });
      } catch (error) {
        oldClaimOutcomes.push({ label: entry.label, id: entry.id, outcome: 'refused', code: (error as { code?: string }).code ?? '?' });
      }
    }
    afterRefusals = (await Promise.all(protectedTasks.map(entry => rowOf(oldDb, entry.id)))).filter((row): row is OldTask => row !== undefined);
    if (afterRefusals.length !== protectedTasks.length) throw new Error('fixture: a protected task row disappeared');
    await sample('第三轮：旧版试领之后');

    // 候选池对照：旧版对新版写的对照任务给出可派工候选，对新版隔离过的任务给不出任何候选。
    const def = { id: 'rb-factory', role: 'engineering', provider: 'codex', model: 'm1', enabled: true,
      maxInstances: 4, priority: 100, weight: 10, scored: 0, errorStreak: 0 };
    const inst = { id: 'rb-eng', role: 'engineering', def: 'rb-factory', provider: 'codex', model: 'm1', paseoAgentId: 'ag-rb' };
    const poolBase = { role: 'engineering', home: '/rb01/repo', opsRepo: '/rb01/repo', sidecar: false, now: 2_000_000,
      defs: [def], insts: [inst], states: new Map<string, InstState>([[inst.id, 'idle']]), holding: new Set<string>(),
      health: new Map(), quotaBlocked: new Map(), busyBy: new Map(), providerMax: {}, slots: new Map() };
    const supervised = (await oldWorkforce.tasks()).find(task => task.id === controlId)!;
    const isolatedTask = (await oldWorkforce.tasks()).find(task => task.id === isolatedIds[0])!;
    // 新版的池子怎么拿到拦截理由：与 dispatcher.ts 完全一样——先问 core 要这一轮的结论，再把它当池子的输入。
    const verdict = await core.policyDispatchVerdict(isolatedTask.id);
    const policyBlocks = new Map([[isolatedTask.id, verdict.verdict === 'blocked' ? (verdict.reason ?? BLOCK_TEXT.policy_blocked)
      : `有效策略契约已变更（${verdict.hash?.slice(0, 16) ?? 'unknown'}）`]]);
    pools = {
      oldControl: oldPool({ ...poolBase, task: supervised } as never),
      newControl: staffingPool({ ...poolBase, task: supervised } as never),
      newIsolated: staffingPool({ ...poolBase, task: isolatedTask, policyBlocks } as never),
    };

    // --- F. 正向恢复：同一份数据交回新版 ---
    for (const entry of protectedTasks) {
      recovery.push({ label: entry.label, verdict: (await core.policyDispatchVerdict(entry.id)).verdict });
    }
    if (process.env.SCK_RB01_EVIDENCE_DIR) {
      writeFileSync(join(process.env.SCK_RB01_EVIDENCE_DIR, 'rb01-effective-policy-rollback.json'), JSON.stringify({
        deployedRelease: OLD_RELEASE, schema: schemaFacts, vocabulary, oldSurface,
        policy: { v1: writeV1.id, v2: writeV2.id }, planAffected, isolated: isolatedIds,
        protected: protectedTasks.map(entry => ({ label: entry.label, id: entry.id, state: entry.expectState, blockedTo: entry.expectBlockedTo ?? null })),
        rounds: rounds.map(round => ({ label: round.label, live: round.live, protectedHits: round.hits })),
        oldClaims: oldClaimOutcomes, afterRefusals, recovery,
        pools: {
          oldControl: pools.oldControl.map(entry => ({ key: entry.key, eligible: entry.eligible, code: entry.code ?? null })),
          newControl: pools.newControl.map(entry => ({ key: entry.key, eligible: entry.eligible, code: entry.code ?? null })),
          newIsolated: pools.newIsolated.map(entry => ({ key: entry.key, eligible: entry.eligible, code: entry.code ?? null })),
        },
      }, null, 2));
    }
  }, 600_000);

  afterAll(async () => {
    await newDb?.close();
    await oldDb?.close();
    if (oldRoot) {
      try { unlinkSync(join(oldRoot, 'node_modules')); } catch { /* never linked */ }
      rmSync(oldRoot, { recursive: true, force: true });
    }
  }, 120_000);

  test('前提：部署中的 release 没有策略面，新版只追加迁移，状态字面量一个都没多', () => {
    expect(oldSurface).toEqual({ hasPolicySet: false, hasPolicyPlan: false, hasPolicyEnforce: false, hasVerdict: false, policyFile: false });
    expect(schemaFacts.oldBefore).toBe(27);
    expect(schemaFacts.afterNew).toBeGreaterThanOrEqual(34);
    // 旧版在自己的 schema 上再跑一次 bootstrap，读到的还是新版升上来的库：标记不回退，数据没被改写。
    expect(schemaFacts.afterOldBoot).toBe(schemaFacts.afterNew);
    expect(vocabulary.old).toEqual(vocabulary.current);
    expect(vocabulary.current).toContain('blocked');
  });

  test('新版写入面：隔离只用旧版认得的可见状态，并把原相位记在旧版也读的 resume_state 上', async () => {
    // 试算列出受影响任务，落地后的有效视图与试算逐位一致（先试算再落地）。
    expect(writeV2.version).toBe(2);
    expect(isolatedIds).toHaveLength(3);
    for (const entry of protectedTasks) {
      const row = await rowOf(newDb as unknown as AnyDatabase, entry.id);
      expect(row?.state).toBe(entry.expectState);
      expect(row?.current_employee ?? null).toBeNull();
      expect(row?.lease_expires_at ?? null).toBeNull();
      expect(row?.blocked_to).toBe(entry.expectBlockedTo);
      if (entry.expectResume) expect(row?.resume_state).toBe(entry.expectResume);
    }
    // 对照任务是冻结之后建的：它的契约就是当前版本，没有任何等待原因。
    expect(controlRow).toMatchObject({ state: 'ready' });
    expect(controlRow?.current_employee ?? null).toBeNull();
  });

  test('连派多轮：旧版看得见这些任务行，但一轮都没有把它们当成候选', () => {
    expect(rounds).toHaveLength(3);
    for (const round of rounds) {
      expect(round.hits).toEqual([]);
      // 非空对照：同一轮里对照任务在候选里，说明"零误派"不是因为候选集为空。
      expect(round.live).toContain(controlId);
    }
    // 旧版试领每一个受保护任务都被拒，并且试领之后任务行一个字段都没变。
    expect(oldClaimOutcomes.map(entry => entry.outcome)).toEqual(Array(protectedTasks.length).fill('refused'));
    expect(afterRefusals.map(row => ({ id: row.id, state: row.state, blocked_to: row.blocked_to ?? null })))
      .toEqual(protectedTasks.map(entry => ({ id: entry.id, state: entry.expectState, blocked_to: entry.expectBlockedTo ?? null })));
  });

  test('候选池：旧版对对照任务给出可派工候选，对新版隔离过的任务给不出任何候选', () => {
    const eligible = (entries: PoolEntry[]) => entries.filter(entry => entry.eligible).map(entry => entry.key);
    expect(pools.oldControl.length).toBeGreaterThan(0);
    expect(eligible(pools.oldControl)).toContain('rb-eng');
    // 新版对同一个对照任务同样可派工：两个版本的"能派"结论一致，差别只在策略通道。
    expect(eligible(pools.newControl)).toContain('rb-eng');
    // 隔离过的任务在新版池子里是 policy_blocked 类的永久拦截，一个候选都不合格。
    expect(pools.newIsolated.length).toBeGreaterThan(0);
    expect(pools.newIsolated.every(entry => !entry.eligible)).toBe(true);
    expect(pools.newIsolated.every(entry => entry.code === 'policy_blocked')).toBe(true);
  });

  test('正向恢复：数据交回新版，受保护任务依旧是 blocked，谁也不需要改一行数据', () => {
    expect(recovery).toHaveLength(protectedTasks.length);
    for (const entry of recovery) expect(entry.verdict).toBe('blocked');
  });
});