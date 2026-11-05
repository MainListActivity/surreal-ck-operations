// SYS06 R1 回归（由运营复现脚本转正）：上线前**已经存在、没有策略登记**的在办任务，必须与判定同源地出现在 policy_plan
// 的受影响清单里，并被 policy_enforce 隔离成旧 release 也认得的 blocked + blocked_to=gm。
//
// 旧行为 → 新行为的对比（同一份数据、同一条命令）：
//   旧：policyPlan 的候选集带 `AND policy_hash != NONE` 预筛，这类任务既不进 plan、也就不会被 enforce 隔离；
//       而判定侧对所有任务无条件跑 dispatchVerdict，收权后判它 blocked。结果是"新版拒领、旧版照派"：回滚到不执行策略的
//       release 后，旧候选集把这条 ready/doing 任务当普通任务派工——违反 RB01 的零误派工。次要：同句 LIMIT 200 静默截断。
//   新：候选集去掉预筛（判定怎么判，plan 就怎么看），分页读到底，读满上限在视图里显式报告 truncated。
//
// 本演练里的两条旧任务由**旧 release 自己的代码**建（schema 027，那时没有 policy 表），所以它们的 policy_hash 是 NONE
// ——这正是旧预筛漏掉它们的原因，也是上线那一刻线上所有在办任务的样子。
// Gated by RUN_SCK_WORKTREE_FORK_TESTS=1 (scripts/test-worktrees.ts sets it).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce, type SupervisedTask } from '../src/workforce.ts';
import { scanInFlightTasks } from '../src/policy-store.ts';
import type { PolicyView } from '../src/contracts.ts';

const ROOT = join(import.meta.dir, '..');
const OLD_RELEASE = '20b384e7661f607cdc21318e58b30bde260e6356';
const run = process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1' ? describe : describe.skip;
const key = () => crypto.randomUUID();

type AnyDatabase = { connect(): Promise<void>; bootstrap(): Promise<void>; close(): Promise<void>;
  db: { query<T>(sql: string, vars?: Record<string, unknown>): Promise<T> } };
type AnyCore = {
  createTask(credential: string, input: Record<string, unknown>): Promise<{ id: string }>;
  claim(credential: string, taskId: string): Promise<{ task: { id: string; state: string } }>;
};
type OldRow = { id: string; state: string; blocked_to?: string; resume_state?: string; current_employee?: string;
  lease_expires_at?: number; policy_hash?: unknown };
type PlanEntry = { id: string; state: string; losesAuthorization: boolean; reason?: string };

let oldRoot = '';
let oldDb: AnyDatabase;
let newDb: CompanyDatabase;
let core: SurrealCompanyCore;
let oldCore: AnyCore;
let oldTasks: (() => Promise<SupervisedTask[]>) | undefined;
let gm = '';
let eng = '';
/** 旧 release 建的在办任务（没有策略登记）与新版建的对照任务（有登记）。 */
let legacyReadyId = '';
let legacyDoingId = '';
let controlId = '';
let legacyRows: OldRow[] = [];
let controlRow: OldRow | undefined;
let planEntries: PlanEntry[] = [];
let planScan = { scanned: -1, scanLimit: -1, truncated: true };
let verdicts: Array<{ label: string; verdict: string; reason?: string }> = [];
let enforced: { blocked: string[]; alreadyBlocked: string[]; absent: string[]; audited: number } =
  { blocked: [], alreadyBlocked: [], absent: [], audited: -1 };
let quarantined: OldRow[] = [];
let audits = 0;
let oldDeployable: string[] = [];
let oldClaimOutcomes: Array<{ label: string; outcome: string; code: string }> = [];
let vocabulary: { old: string[]; current: string[] } = { old: [], current: [] };

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

/** 旧版视角的一行任务：只读旧版认得的字段（新版加的字段它读不到也不影响它）。 */
const rowOf = async (db: AnyDatabase, taskId: string): Promise<OldRow | undefined> => {
  const [row] = await db.db.query<[Omit<OldRow, 'id'> | null]>(
    "SELECT state, blocked_to, resume_state, current_employee, lease_expires_at, policy_hash FROM ONLY type::record('task', $t);",
    { t: taskId });
  return row ? { id: taskId, ...row } : undefined;
};

/** 部署中 release 自己的派工候选规则：执行相位取 state ready/doing 且无人持有的任务，复核相位取 review 且无人持有。 */
const deployableIn = (tasks: readonly SupervisedTask[]): string[] =>
  tasks.filter(task => (task.state === 'ready' || task.state === 'doing' || task.state === 'review') && !task.currentEmployee)
    .map(task => task.id);

run('R1 plan coverage: a task built before the policy layer is listed, quarantined, and never dispatched by the old release', () => {
  beforeAll(async () => {
    oldRoot = mkdtempSync(join(tmpdir(), 'sys06-r1-old-'));
    await extractOldRelease(oldRoot);
    const { loadDatabaseConfig: oldConfig } = await loadOld<{ loadDatabaseConfig(): Record<string, unknown> }>('src/config.ts');
    const { CompanyDatabase: OldDatabase } = await loadOld<{ CompanyDatabase: new (cfg: Record<string, unknown>) => AnyDatabase }>('src/database.ts');
    const { LocalEnrollmentAdmin: OldEnroll } = await loadOld<{ LocalEnrollmentAdmin: new (db: AnyDatabase) => { enroll(id: string, role: string, caps: string[]): Promise<string> } }>('src/enrollment.ts');
    const { SurrealCompanyCore: OldPolicyCore } = await loadOld<{ SurrealCompanyCore: new (db: AnyDatabase) => AnyCore }>('src/core.ts');

    const namespace = `sys06_r1_${Math.random().toString(36).slice(2, 10)}`;
    // --- A. 旧 release 初始化命名空间（schema 027）并登记员工 ---
    oldDb = new OldDatabase({ ...oldConfig(), namespace, database: 'control_plane' });
    await oldDb.connect();
    await oldDb.bootstrap();
    const oldEnroll = new OldEnroll(oldDb);
    gm = await oldEnroll.enroll('r1-gm', 'owner', ['execute', 'review', 'manage']);
    eng = await oldEnroll.enroll('r1-eng', 'engineering', ['execute', 'review']);
    oldCore = new OldPolicyCore(oldDb);

    // --- B. 旧 release 建两条在办任务（ready / doing），它们没有 policy_* 登记：上线那一刻线上在办任务的样子 ---
    const legacy = (title: string) => oldCore.createTask(gm, { title, context: 'SYS06 R1：策略层上线前既存的任务',
      executorRole: 'engineering', reviewerRole: 'qa', workIntent: { kind: 'code' }, idempotencyKey: key() });
    legacyReadyId = (await legacy('R1 上线前既存（ready）')).id;
    legacyDoingId = (await legacy('R1 上线前既存（doing）')).id;
    const doingClaim = await oldCore.claim(eng, legacyDoingId);
    if (doingClaim.task.state !== 'doing') throw new Error(`fixture: the old lease did not reach doing (${doingClaim.task.state})`);
    legacyRows = (await Promise.all([legacyReadyId, legacyDoingId].map(id => rowOf(oldDb, id)))).filter((row): row is OldRow => row !== undefined);
    if (legacyRows.length !== 2) throw new Error('fixture: a legacy task row disappeared');

    // --- C. 新版在同一份数据上升级到 035、写 v1 策略，再建一条**有登记**的对照任务 ---
    newDb = new CompanyDatabase({ ...loadDatabaseConfig(), namespace, database: 'control_plane' });
    await newDb.connect();
    await newDb.bootstrap();
    core = new SurrealCompanyCore(newDb, { workforce: new Workforce(newDb, mkdtempSync(join(tmpdir(), 'sys06-r1-cred-'))) });
    const set = (input: Record<string, unknown>, supersedes?: string): Promise<PolicyView> => core.policySet(gm, {
      policyId: 'r1-write', scope: 'company', domain: 'write_authority', source: 'manager',
      reason: 'SYS06 R1 回归：登记一版写权策略', idempotencyKey: key(), ...input, ...(supersedes ? { supersedes } : {}),
    } as never);
    const v1 = await set({ payload: { kind: 'write_authority', codeRoles: ['engineering'], intents: ['code', 'read'] } });
    const control = await core.createTask(gm, { title: 'R1 对照（策略层之后建，有登记）',
      context: 'SYS06 R1：对照任务，证明被漏掉的不是"所有任务"，而是没有登记的那类',
      executorRole: 'engineering', reviewerRole: 'qa', workIntent: { kind: 'code' }, idempotencyKey: key() } as never);
    controlId = control.id;
    controlRow = await rowOf(newDb as unknown as AnyDatabase, controlId);

    // --- D. 试算"收权"（只留 qa 写码）：谁失去授权？这只看影响面，不写库 ---
    const at = new Date(Date.now() - 2000).toISOString();
    const plan = await core.policyPlan(gm, { policyId: 'r1-write', scope: 'company', domain: 'write_authority', source: 'manager',
      supersedes: v1.id, effectiveAt: at, payload: { kind: 'write_authority', codeRoles: ['qa'], intents: ['code', 'read'] } } as never);
    planEntries = plan.affectedTasks.map(entry => ({ id: entry.id, state: entry.state, losesAuthorization: entry.losesAuthorization,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}) }));
    planScan = { scanned: plan.scanned, scanLimit: plan.scanLimit, truncated: plan.truncated };

    // --- E. 落地 v2，问新版判定：这三条任务还能不能派工？ ---
    await set({ payload: { kind: 'write_authority', codeRoles: ['qa'], intents: ['code', 'read'] } }, v1.id);
    verdicts = [];
    for (const [label, id] of [['旧任务（ready）', legacyReadyId], ['旧任务（doing）', legacyDoingId], ['对照任务', controlId]] as const) {
      const verdict = await core.policyDispatchVerdict(id);
      verdicts.push({ label, verdict: verdict.verdict, ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) });
    }

    // --- F. 按 plan 的清单隔离，再看三条任务的落点与审计 ---
    enforced = await core.policyEnforce(gm, { taskIds: planEntries.map(entry => entry.id),
      reason: 'SYS06 R1 回归：收权后按 policy_plan 隔离在办任务', idempotencyKey: key() });
    quarantined = (await Promise.all([legacyReadyId, legacyDoingId, controlId].map(id => rowOf(newDb as unknown as AnyDatabase, id))))
      .filter((row): row is OldRow => row !== undefined);
    const [grouped] = await newDb.db.query<[Array<{ count: number }>]>("SELECT count() FROM audit WHERE action = 'policy_blocked' GROUP ALL;");
    audits = grouped?.[0]?.count ?? 0;

    // --- G. 旧 release 打开同一份数据：候选集里不该有它们，试领也该被拒 ---
    const { Workforce: OldWorkforce } = await loadOld<{ Workforce: new (db: AnyDatabase, credDir: string) => { tasks(): Promise<SupervisedTask[]> } }>('src/workforce.ts');
    const oldWorkforce = new OldWorkforce(oldDb, mkdtempSync(join(tmpdir(), 'sys06-r1-oldcred-')));
    oldTasks = () => oldWorkforce.tasks();
    oldDeployable = deployableIn(await oldWorkforce.tasks());
    for (const [label, id] of [['旧任务（ready）', legacyReadyId], ['旧任务（doing）', legacyDoingId], ['对照任务', controlId]] as const) {
      try {
        await oldCore.claim(eng, id);
        oldClaimOutcomes.push({ label, outcome: 'claimed', code: '' });
      } catch (error) {
        oldClaimOutcomes.push({ label, outcome: 'refused', code: (error as { code?: string }).code ?? '?' });
      }
    }

    // --- H. 状态字面量：隔离用的是旧版本来就认识的那两个字面量，没有引入新版专有状态 ---
    const { TASK_STATES: oldStates } = await loadOld<{ TASK_STATES: readonly string[] }>('src/query-input.ts');
    const { TASK_STATES: currentStates } = await import('../src/query-input.ts');
    vocabulary = { old: [...oldStates], current: [...currentStates] };
  }, 600_000);

  afterAll(async () => {
    if (oldDb) await oldDb.close();
    if (newDb) await newDb.close();
    if (oldRoot) rmSync(oldRoot, { recursive: true, force: true });
  });

  test('fixture: the tasks built by the old release carry no policy registration — the exact rows the old candidate filter dropped', () => {
    expect(legacyRows).toHaveLength(2);
    for (const row of legacyRows) {
      // 旧候选集的预筛条件 `policy_hash != NONE` 正是靠这个字段把它们筛掉的。
      expect(row.policy_hash ?? null).toBeNull();
      expect(['ready', 'doing']).toContain(row.state);
    }
    // 对照任务有登记：被漏掉的不是"所有任务"，而是这一类。
    expect(controlRow?.policy_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('R1/AC01: policy_plan lists the unregistered in-flight tasks and says they lose authorization', () => {
    const affected = planEntries.map(entry => entry.id);
    // 旧行为：这里只有对照任务（运营复现脚本复现的正是这一条）。新行为：两条旧任务也在清单里。
    expect(affected).toContain(controlId);
    expect(affected).toContain(legacyReadyId);
    expect(affected).toContain(legacyDoingId);
    const legacy = planEntries.filter(entry => entry.id === legacyReadyId || entry.id === legacyDoingId);
    expect(legacy.map(entry => entry.losesAuthorization)).toEqual([true, true]);
    for (const entry of legacy) expect(entry.reason ?? '').not.toBe('');
    // 候选集扫描的事实是显式字段：读了多少、上限多少、有没有被截断。
    expect(planScan.scanned).toBe(3);
    expect(planScan.scanLimit).toBe(200 * 50);
    expect(planScan.truncated).toBe(false);
  });

  test('R1/AC01: policy_enforce isolates them as blocked + blocked_to=gm and keeps the phase it interrupted', () => {
    expect(enforced.blocked).toEqual(expect.arrayContaining([legacyReadyId, legacyDoingId, controlId]));
    expect(enforced.audited).toBe(3);
    expect(audits).toBe(3);
    const by = new Map(quarantined.map(row => [row.id, row]));
    // 旧版认得的状态字面量 + 责任人；新版专有的解释只写在旧版读不到的字段里。
    expect(by.get(legacyReadyId)?.state).toBe('blocked');
    expect(by.get(legacyReadyId)?.blocked_to).toBe('owner');
    expect(by.get(legacyReadyId)?.resume_state).toBe('ready');
    expect(by.get(legacyDoingId)?.state).toBe('blocked');
    expect(by.get(legacyDoingId)?.resume_state).toBe('doing');
    expect(by.get(controlId)?.state).toBe('blocked');
    // 租约与持有人被清掉：旧版"state ∈ {ready,doing,review} 且无人持有"的候选规则读不到它们。
    for (const row of quarantined) {
      expect(row.state).toBe('blocked');
      expect(row.current_employee ?? null).toBeNull();
      expect(row.lease_expires_at ?? null).toBeNull();
    }
  });

  test('R1/AC01: paging against the real fork database walks every page — same rows, in the same order, none dropped', async () => {
    // 单元测试用假 DB 证明循环会翻页；这一条在真实 fork 库上证明那条 SQL（ORDER BY created_at DESC, id DESC
    // + LIMIT/START）逐页取回同一批任务：页大小 1 的多页走法与一次读到底逐位一致，且没有静默截断。
    const ids = (scan: { rows: Array<{ id: unknown }> }) => JSON.stringify(scan.rows.map(row => row.id));
    const oneShot = await scanInFlightTasks<{ id: unknown }>(newDb.db, 200, 1);
    const paged = await scanInFlightTasks<{ id: unknown }>(newDb.db, 1, 10);
    expect(paged.rows).toHaveLength(oneShot.rows.length);
    expect(ids(paged)).toBe(ids(oneShot));
    expect(paged.truncated).toBe(false);
    expect(paged.scanned).toBe(oneShot.scanned);
  });

  test('R1/AC01: 跨过 200 条扫描页边界、且时间戳全同毫秒时，keyset 续读不重不漏（真实 fork 库）', async () => {
    // 评审第 3 轮的建议项：仓库此前没有真实库用例跨过扫描页（POLICY_PLAN_SCAN_PAGE=200）。
    // 把在办任务压到同一个毫秒，排序退化成纯 id 序，(created_at, id) 续读必须仍然不重不漏——
    // 这正是"上线前既存任务挤在同一天创建"的样子。
    const idOf = (row: { id: unknown }) => String((row.id as { id?: unknown })?.id ?? row.id);
    const listInFlight = async () => (await newDb.db.query<[Array<{ id: unknown }>]>(
      "SELECT id, created_at FROM task WHERE state NOT IN ['done', 'void'] ORDER BY created_at DESC, id DESC;"))[0].map(idOf);
    const created: string[] = [];
    for (let index = 0; index < 260; index++) {
      const task = await core.createTask(gm, { title: `R1 扫描页边界样本 ${index}`,
        context: 'SYS06 R1：跨扫描页的合成样本', executorRole: 'engineering', reviewerRole: 'qa',
        workIntent: { kind: 'read' }, idempotencyKey: key() } as never);
      created.push(task.id);
    }
    // 全部压成同一毫秒：页边界落在同一个 created_at 的组里，id 成为唯一的分页依据。
    await newDb.db.query("UPDATE task SET created_at = d'2026-10-24T00:00:00.000Z' WHERE state NOT IN ['done', 'void'];");
    const expected = await listInFlight();
    expect(expected.length).toBeGreaterThan(200);            // 确实跨过了页边界（否则这条用例没有意义）
    expect(created.every(id => expected.includes(id))).toBe(true);
    const scan = await scanInFlightTasks<{ id: unknown; created_at?: unknown }>(newDb.db, 200, 5);
    const got = scan.rows.map(idOf);
    expect(got.length).toBe(expected.length);                 // 一条不少
    expect(new Set(got).size).toBe(got.length);               // 一条不重
    expect(got).toEqual(expected);                            // 顺序与库的全序逐位一致（含同毫秒的 id 续读）
    expect(scan.truncated).toBe(false);
    expect(scan.scanned).toBe(expected.length);
  });

  test('R1/AC05: the isolation uses no state literal the deployed release does not know, and the old release dispatches none of them', () => {
    expect(vocabulary.old).toEqual(vocabulary.current);
    expect(vocabulary.old).toContain('blocked');
    expect(oldDeployable.filter(id => [legacyReadyId, legacyDoingId, controlId].includes(id))).toEqual([]);
    expect(oldClaimOutcomes.map(entry => entry.outcome)).toEqual(['refused', 'refused', 'refused']);
  });
});