// IR06 rollback isolation drill on the company fork (never production). It pins 20b384e as its old-version oracle: that
// release carries NO independence code at all — src/independence.ts does not exist, core has no
// INDEPENDENCE_GUARD_SQL / independenceGate / setIndependence, contracts has no IndependencePolicy or
// IdentityPrincipalView, and its schema stops at 027. The drill proves what rolling back to it means for data that ALREADY
// holds a policy, and that a forward fix restores the isolation without touching the data.
//
// One namespace, in the production order:
//   A. the old code bootstraps the namespace to its own schema (027) and enrols the employees;
//   B. the new code (this worktree) re-bootstraps the SAME data (appending 028/029) and writes the policy and the
//      registered principal;
//   C. the new code refuses every excluded claimant, and still grants the independent engineer and a no-policy control;
//   D. the old code opens the SAME data and grants all three excluded people — the regression IR06 refused a rollback for;
//   E. the candidate pools differ: the old dispatcher has no independence channel, the new one excludes;
//   F. forward recovery: the same data under the new code is refused again, with no data change at all.
//
// The four required assertions are the dispatch pool, the direct claim/submit refusal, the no-policy control and the
// forward recovery. This is the isolation evidence for the independence gate; the paging isolation drill is
// tests/rollback-isolation.fork.test.ts, which pins 8d03d35 and never writes a policy.
// Gated by RUN_SCK_ROLLBACK_FORK_TESTS=1 (scripts/test-worktrees.ts sets it).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { readIndependenceSnapshot } from '../src/independence.ts';

const ROOT = join(import.meta.dir, '..');
/** The pinned pre-independence release (schema 027). Its git tree is the old-version oracle. */
const OLD_RELEASE = '20b384e7661f607cdc21318e58b30bde260e6356';
const run = process.env.RUN_SCK_ROLLBACK_FORK_TESTS === '1' ? describe : describe.skip;
const EVIDENCE = 'IR06 回滚隔离演练：来源经手人动态回避的合成证据文本。';
const key = () => crypto.randomUUID();

/** A core of either tree: the drill drives the same seam on both. */
type AnyCore = {
  claim(credential: string, taskId: string): Promise<{ task: { id: string; version: number; state: string; currentEmployee?: string }; deliveryId: string; fence: number }>;
  submit(credential: string, proof: unknown, evidence: unknown): Promise<{ state: string }>;
  createTask(credential: string, input: Record<string, unknown>): Promise<{ id: string; version: number }>;
  setIndependence(credential: string, input: Record<string, unknown>): Promise<{ independence?: unknown }>;
  setIdentityPrincipal(credential: string, input: Record<string, unknown>): Promise<{ id: string; employees: string[] }>;
  implementerTakeover(credential: string, input: Record<string, unknown>): Promise<unknown>;
  getTask(credential: string, taskId: string): Promise<{ id: string; version: number; state: string; currentEmployee?: string; independence?: Record<string, unknown> }>;
};
type AnyDatabase = { connect(): Promise<void>; bootstrap(): Promise<void>; close(): Promise<void>; db: { query<T>(sql: string, vars?: Record<string, unknown>): Promise<T> } };
type PoolEntry = { key: string; eligible: boolean; code?: string };
type PoolFn = (input: Record<string, unknown>) => PoolEntry[];
/** A granted claim, and the proof every later write of that lease must carry. */
type Claimed = Awaited<ReturnType<AnyCore['claim']>>;
/** One claim attempt against either core: the outcome, the refusal facts, and the claim when it was granted. */
type Attempt = {
  outcome: string;
  code?: string;
  via?: string;
  claim?: Claimed;
};
const proofOf = (claimed: Claimed) => ({ taskId: claimed.task.id, deliveryId: claimed.deliveryId,
  fence: claimed.fence, expectedVersion: claimed.task.version });

/** The old tree's own modules, loaded from the extracted release (never from this worktree). */
const loadOld = async <T>(rel: string): Promise<T> => await import(join(oldRoot, rel)) as T;

let oldRoot = '';
let oldDb: AnyDatabase;
let newDb: CompanyDatabase;
let gm = '';
let tokens: Record<string, string> = {};
let principalId = '';
let parentId = '';
let submitParentId = '';
let sourceFacts: { authors: string[]; implementer?: string; strictExcluded: string[] } = { authors: [], strictExcluded: [] };
let policyTasks: Record<string, string> = {};
let controlNew = '';
let controlOld = '';
let controlRecover = '';
let recoverTask = '';
let newRefusals: Array<{ who: string; task: string; outcome: string; code: string; via: string }> = [];
let newGrants: string[] = [];
let oldOutcomes: Array<{ who: string; task: string; outcome: string }> = [];
let oldSubmit: { task: string; state: string } | undefined;
let newSubmitRefusal: { code: string; message: string; via: string } | undefined;
let newSubmitHeld: { state: string; currentEmployee?: string } | undefined;
let pools: { old: PoolEntry[]; new: PoolEntry[] } = { old: [], new: [] };
let recovery: { contributor: { outcome: string; via: string }; control: string } = { contributor: { outcome: '', via: '' }, control: '' };
let schemaFacts: { oldBefore: number; afterNew: number; oldIndependenceField: boolean; oldPrincipalField: boolean } = { oldBefore: 0, afterNew: 0, oldIndependenceField: false, oldPrincipalField: false };
let oldSurface: { setIndependence: boolean; setIdentityPrincipal: boolean; independenceGate: boolean } = { setIndependence: false, setIdentityPrincipal: false, independenceGate: false };

/**
 * Extracts the previous release from git (a read of the repository objects, nothing is checked out) and links the
 * worktree's node_modules in; dependencies are unchanged since the release, so both trees resolve the same packages.
 */
async function extractOldRelease(into: string): Promise<void> {
  const archive = Bun.spawn(['git', 'archive', OLD_RELEASE, '--', 'src', 'schema', 'package.json', 'tsconfig.json'],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const untar = Bun.spawn(['tar', '-x', '-C', into], { stdin: archive.stdout, stdout: 'ignore', stderr: 'pipe' });
  const [archiveExit, untarExit] = await Promise.all([archive.exited, untar.exited]);
  if (archiveExit !== 0 || untarExit !== 0) throw new Error(`extracting ${OLD_RELEASE} failed: git exit ${archiveExit}, tar exit ${untarExit}`);
  symlinkSync(join(ROOT, 'node_modules'), join(into, 'node_modules'));
}

const attempt = async (phase: 'new' | 'old', who: string, label: string, core: AnyCore, employee: string, taskId: string): Promise<Attempt> => {
  try {
    const claimed = await core.claim(tokens[employee]!, taskId);
    return { outcome: 'claimed', claim: claimed };
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: { conflicts?: Array<{ via?: string }> } };
    return { outcome: `refused:${e.code ?? '?'}`, code: e.code ?? '', via: e.details?.conflicts?.[0]?.via ?? '' };
  }
};

run('IR06 rollback isolation: a policy written by the new code, then the deployed release on the same data', () => {
  beforeAll(async () => {
    oldRoot = mkdtempSync(join(tmpdir(), 'ir06-old-'));
    await extractOldRelease(oldRoot);
    const { loadDatabaseConfig: oldLoadConfig } = await loadOld<{ loadDatabaseConfig(): Record<string, unknown> }>('src/config.ts');
    const { CompanyDatabase: OldDatabase } = await loadOld<{ CompanyDatabase: new (cfg: Record<string, unknown>) => AnyDatabase }>('src/database.ts');
    const { SurrealCompanyCore: OldCore } = await loadOld<{ SurrealCompanyCore: new (db: AnyDatabase) => AnyCore }>('src/core.ts');
    const { LocalEnrollmentAdmin: OldEnroll } = await loadOld<{ LocalEnrollmentAdmin: new (db: AnyDatabase) => { enroll(id: string, role: string, caps: string[]): Promise<string> } }>('src/enrollment.ts');

    const namespace = `ir06_${Math.random().toString(36).slice(2, 10)}`;
    const cfg = { ...oldLoadConfig(), namespace, database: 'control_plane' };

    // --- A. the old code bootstraps the namespace to its own schema and enrols every employee ---
    oldDb = new OldDatabase(cfg);
    await oldDb.connect();
    await oldDb.bootstrap();
    const oldEnroll = new OldEnroll(oldDb);
    const enroll = async (employeeId: string) => { tokens[employeeId] = await oldEnroll.enroll(employeeId, 'engineering', ['execute', 'review']); };
    gm = await oldEnroll.enroll('ir-gm', 'gm', ['execute', 'review', 'manage']);
    await enroll('ir-src');
    await enroll('ir-alias');
    await enroll('ir-named');
    await enroll('ir-indep');
    await enroll('ir-ctrl');
    await enroll('ir-d-indep');
    await enroll('ir-d-ctrl');
    await enroll('ir-f-ctrl');
    const schemaVersion = async (db: AnyDatabase) => {
      const [rows] = await db.db.query<[Array<{ schema_version?: number }>]>('SELECT schema_version FROM company_meta:installation;');
      return rows?.[0]?.schema_version ?? -1;
    };
    schemaFacts.oldBefore = await schemaVersion(oldDb);

    // --- B. the new code re-bootstraps the SAME data, writes the policy and registers the principal ---
    newDb = new CompanyDatabase({ ...loadDatabaseConfig(), namespace, database: 'control_plane' });
    await newDb.connect();
    await newDb.bootstrap();
    schemaFacts.afterNew = await schemaVersion(newDb as unknown as AnyDatabase);
    const newCore = new (await import('../src/core.ts')).SurrealCompanyCore(newDb) as unknown as AnyCore;
    const mk = async (title: string) => newCore.createTask(gm, {
      title, context: 'IR06 rollback isolation fixture', executorRole: 'engineering', reviewerRole: 'engineering', idempotencyKey: key(),
    });
    const parent = await mk('ir06 parent');
    parentId = parent.id;
    const claimSrc = await newCore.claim(tokens['ir-src']!, parent.id);
    await newCore.submit(tokens['ir-src']!, { taskId: claimSrc.task.id, deliveryId: claimSrc.deliveryId, fence: claimSrc.fence, expectedVersion: claimSrc.task.version },
      { text: EVIDENCE, idempotencyKey: key() });
    const { readContributionView } = await import('../src/contributors.ts');
    sourceFacts = (await readContributionView(newDb.db, parent.id)).facts;
    // A second source, never submitted, for the submit-gate demonstration below: a takeover needs an execute-phase source,
    // and this one is already in review. Keeping it separate also keeps the claimant out of the candidate pool in phase E,
    // which reads the first source — otherwise the takeover would exclude the very engineer the pool must show as eligible.
    submitParentId = (await mk('ir06 parent for the submit gate')).id;
    // A registered principal is the ONLY cross-employee identity key: ir-alias is the same person as ir-src.
    const principal = await newCore.setIdentityPrincipal(gm, {
      employees: ['ir-src', 'ir-alias'], reason: 'IR06 回滚隔离演练：同一人的两个会话', idempotencyKey: key(),
    });
    principalId = principal.id;

    const policyFor = async (title: string, source: string = parent.id) => {
      const task = await mk(title);
      await newCore.setIndependence(gm, {
        taskId: task.id, stages: ['execute'], sources: [source], mode: 'execute_handlers', excluded: ['ir-named'],
        reason: 'IR06 回滚隔离演练：来源经手人、其 principal 同伴与点名员工必须回避', expectedVersion: task.version, idempotencyKey: key(),
      });
      policyTasks[title] = task.id;
      return task.id;
    };
    // Phase C tasks (the new code's own verdicts) and phase D tasks (the old code's regressions), one per claimant so a
    // lease from one attempt cannot decide the next.
    const cSrc = await policyFor('dep C contributor');
    const cAlias = await policyFor('dep C principal companion');
    const cNamed = await policyFor('dep C named employee');
    const cIndep = await policyFor('dep C independent engineer');
    const dSrc = await policyFor('dep D contributor');
    const dAlias = await policyFor('dep D principal companion');
    const dNamed = await policyFor('dep D named employee');
    const dIndep = await policyFor('dep D independent engineer');
    recoverTask = await policyFor('dep F forward recovery');
    // The submit-gate dependent names the second source, so its claimant is excluded only after the takeover below.
    const submitDep = await policyFor('dep C submit gate', submitParentId);
    controlNew = (await mk('control C no policy')).id;
    controlOld = (await mk('control D no policy')).id;
    controlRecover = (await mk('control F no policy')).id;

    // --- C. the new code: every excluded claimant is refused, the independent engineer and the control are granted ---
    for (const [who, label, taskId] of [
      ['ir-src', 'contributor of the source', cSrc],
      ['ir-alias', 'principal companion of the contributor', cAlias],
      ['ir-named', 'named employee', cNamed],
    ] as const) {
      const result = await attempt('new', who, label, newCore, who, taskId);
      newRefusals.push({ who, task: label, outcome: result.outcome, code: result.code ?? '', via: result.via ?? '' });
    }
    // The independent engineer is granted; its claim is the one the submit gate below is exercised on.
    const indepClaim = await newCore.claim(tokens['ir-indep']!, submitDep);
    const cCtrlResult = await attempt('new', 'ir-ctrl', 'no-policy control', newCore, 'ir-ctrl', controlNew);
    newGrants = ['claimed', cCtrlResult.outcome];
    // The submit gate: after the claim, the manager binds the claimant as the implementer of the second source, which makes
    // it a contributor of that source. Its submit is then refused, and the lease is not released silently.
    await newCore.implementerTakeover(gm, { taskId: submitParentId, toEmployee: 'ir-indep', expectedVersion: (await newCore.getTask(gm, submitParentId)).version,
      reason: 'IR06 回滚隔离演练：经理指定 indep 接手源任务（提交前新贡献）', idempotencyKey: key() });
    try {
      await newCore.submit(tokens['ir-indep']!, proofOf(indepClaim), { text: EVIDENCE, idempotencyKey: key() });
      newSubmitRefusal = undefined;
    } catch (error) {
      const e = error as { code?: string; message?: string; details?: { conflicts?: Array<{ via?: string }> } };
      newSubmitRefusal = { code: e.code ?? '', message: e.message ?? '', via: e.details?.conflicts?.[0]?.via ?? '' };
    }
    newSubmitHeld = await newCore.getTask(gm, submitDep);

    // --- D. the old code opens the SAME data: the three excluded people are let through ---
    const oldCore = new OldCore(oldDb);
    oldSurface = {
      setIndependence: typeof (oldCore as unknown as { setIndependence?: unknown }).setIndependence === 'function',
      setIdentityPrincipal: typeof (oldCore as unknown as { setIdentityPrincipal?: unknown }).setIdentityPrincipal === 'function',
      independenceGate: 'independenceGate' in (oldCore as unknown as object),
    };
    const [oldTaskFields] = await oldDb.db.query<[{ fields?: Record<string, unknown> }]>('INFO FOR TABLE task;');
    const [oldEmpFields] = await oldDb.db.query<[{ fields?: Record<string, unknown> }]>('INFO FOR TABLE employee;');
    schemaFacts.oldIndependenceField = Object.keys(oldTaskFields?.fields ?? {}).includes('independence');
    schemaFacts.oldPrincipalField = Object.keys(oldEmpFields?.fields ?? {}).includes('principal');
    const oldClaims = new Map<string, Claimed>();
    for (const [who, label, taskId] of [
      ['ir-src', 'contributor of the source', dSrc],
      ['ir-alias', 'principal companion of the contributor', dAlias],
      ['ir-named', 'named employee', dNamed],
      ['ir-d-indep', 'independent engineer', dIndep],
    ] as const) {
      const result = await attempt('old', who, label, oldCore, who, taskId);
      if (result.claim) oldClaims.set(taskId, result.claim);
      oldOutcomes.push({ who, task: label, outcome: result.outcome });
    }
    oldOutcomes.push({ who: 'ir-d-ctrl', task: 'no-policy control', outcome: (await attempt('old', 'ir-d-ctrl', 'no-policy control', oldCore, 'ir-d-ctrl', controlOld)).outcome });
    // The old write path too: the claim the old code granted to an excluded contributor also submits, with no gate anywhere.
    const granted = oldClaims.get(dSrc);
    if (!granted) oldSubmit = { task: dSrc, state: 'not granted' };
    else {
      try {
        oldSubmit = { task: dSrc, state: (await oldCore.submit(tokens['ir-src']!, proofOf(granted), { text: EVIDENCE, idempotencyKey: key() })).state };
      } catch (error) {
        oldSubmit = { task: dSrc, state: `refused:${(error as { code?: string }).code ?? '?'}` };
      }
    }

    // --- E. the candidate pools: the old dispatcher has no independence channel at all ---
    const { staffingPool: oldPool } = await loadOld<{ staffingPool: PoolFn }>('src/dispatcher/dispatcher.ts');
    const { staffingPool: newPool } = await import('../src/dispatcher/dispatcher.ts');
    const def = (id: string) => ({ id, role: 'engineering', provider: 'codex', model: 'm1', enabled: true,
      maxInstances: 4, priority: 100, weight: 10, scored: 0, errorStreak: 0 });
    const inst = (id: string, defId: string, principal?: string) => ({ id, role: 'engineering', def: defId, provider: 'codex',
      model: 'm1', paseoAgentId: `ag-${id}`, ...(principal ? { principal } : {}) });
    const defs = ['eng-factory'].map(def);
    const insts = [inst('ir-src', 'eng-factory', principalId), inst('ir-alias', 'eng-factory', principalId),
      inst('ir-named', 'eng-factory'), inst('ir-indep', 'eng-factory')];
    const base = { role: 'engineering', home: '/ops/repo', opsRepo: '/ops/repo', sidecar: false, now: 1_000_000,
      defs, insts, states: new Map(insts.map((i): [string, 'idle'] => [i.id, 'idle'])), holding: new Set<string>(),
      health: new Map(), quotaBlocked: new Map(), busyBy: new Map(), providerMax: { codex: 9 }, slots: new Map() };
    const task = { id: dSrc };
    const storedPolicy = (await newCore.getTask(gm, dSrc)).independence!;
    const scope = await readIndependenceSnapshot(newDb.db, storedPolicy as never);
    pools = {
      old: oldPool({ ...base, task, excludeSubmitter: true } as never),
      new: newPool({ ...base, task, excludeSubmitter: true, independence: scope } as never),
    };

    // --- F. forward recovery: the same data, the new code again, no data change ---
    const recovered = await attempt('new', 'ir-src', 'contributor of the source', newCore, 'ir-src', recoverTask);
    recovery = {
      contributor: { outcome: recovered.outcome, via: recovered.via ?? '' },
      control: (await attempt('new', 'ir-f-ctrl', 'no-policy control', newCore, 'ir-f-ctrl', controlRecover)).outcome,
    };
    if (process.env.SCK_RB01_EVIDENCE_DIR) {
      writeFileSync(join(process.env.SCK_RB01_EVIDENCE_DIR, 'ir06-rollback-independence-results.json'), JSON.stringify({
        deployedRelease: OLD_RELEASE, principal: principalId, source: parentId,
        sourceFacts: { authors: sourceFacts.authors, implementer: sourceFacts.implementer ?? null, strictExcluded: sourceFacts.strictExcluded },
        schema: schemaFacts, oldSurface,
        newRefusals, newGrants, newSubmit: { refusal: newSubmitRefusal ?? null, held: newSubmitHeld ?? null },
        oldOutcomes, oldSubmit,
        dispatch: {
          old: pools.old.map(e => ({ key: e.key, eligible: e.eligible, code: e.code ?? null })),
          new: pools.new.map(e => ({ key: e.key, eligible: e.eligible, code: e.code ?? null })),
        },
        recovery,
      }, null, 2));
    }
  }, 600_000);

  afterAll(async () => {
    await newDb?.close();
    await oldDb?.close();
    if (oldRoot) {
      // Unlink the node_modules symlink before removing the tree so nothing follows it into the worktree.
      try { unlinkSync(join(oldRoot, 'node_modules')); } catch { /* never linked */ }
      rmSync(oldRoot, { recursive: true, force: true });
    }
  }, 120_000);

  test('the premise: the deployed release has no independence surface, and the new bootstrap only appends to the data', () => {
    // The old tree is the oracle, not this worktree.
    expect(existsSync(join(oldRoot, 'src/independence.ts'))).toBe(false);
    expect(oldSurface).toEqual({ setIndependence: false, setIdentityPrincipal: false, independenceGate: false });
    // The data survives both bootstraps: the old schema already holds the policy and the principal link.
    expect(schemaFacts.oldBefore).toBe(27);
    // 新版 bootstrap 把标记推到本项目当前的 schema 版本：至少越过主干已收的模块  （SYS03 的 034 → 34）；合线后本线又加了模块，标记还会往上抬，所以只断言下界。
    expect(schemaFacts.afterNew).toBeGreaterThanOrEqual(34);
    expect(schemaFacts.oldIndependenceField).toBe(true);
    expect(schemaFacts.oldPrincipalField).toBe(true);
    // The source really has a contributor, and the registered principal really links the two sessions.
    expect(sourceFacts.authors).toEqual(['ir-src']);
    expect(sourceFacts.strictExcluded).toContain('ir-src');
    expect(principalId).toBeString();
  });

  test('the dispatch candidate pool: the new dispatcher excludes all three, the deployed one excludes none', () => {
    const byKey = (entries: PoolEntry[]) => Object.fromEntries(entries.map(e => [e.key, { eligible: e.eligible, code: e.code ?? null }]));
    // The deployed release's pool has no independence channel, so nobody reads as a conflict.
    expect(pools.old.filter(e => e.code === 'independence_conflict')).toEqual([]);
    expect(byKey(pools.old)['ir-src']).toMatchObject({ eligible: true });
    expect(byKey(pools.old)['ir-alias']).toMatchObject({ eligible: true });
    expect(byKey(pools.old)['ir-named']).toMatchObject({ eligible: true });
    // The new pool excludes the contributor, its registered principal companion and the named employee. A spawn of the
    // same definition stays eligible: a definition is a capacity template, never an identity (SYS-DISP Q3).
    expect(byKey(pools.new)['ir-src']).toMatchObject({ eligible: false, code: 'independence_conflict' });
    expect(byKey(pools.new)['ir-alias']).toMatchObject({ eligible: false, code: 'independence_conflict' });
    expect(byKey(pools.new)['ir-named']).toMatchObject({ eligible: false, code: 'independence_conflict' });
    expect(byKey(pools.new)['ir-indep']).toMatchObject({ eligible: true });
    // A spawn of the same definition is a new employee id with no principal, so a definition never excludes it
    // collectively (SYS-DISP Q3). Here the four seats are full, which is a capacity block — never an independence one.
    expect(byKey(pools.new)['spawn:eng-factory']).toMatchObject({ eligible: false, code: 'seat_full' });
    // Exactly the three excluded people carry the conflict code; nobody else does, on either side.
    expect(pools.new.filter(e => e.code === 'independence_conflict').map(e => e.key).sort())
      .toEqual(['ir-alias', 'ir-named', 'ir-src']);
    expect(pools.old.filter(e => e.code === 'independence_conflict')).toEqual([]);
  });

  test('direct claim and submit: the new code refuses every excluded person, the deployed release grants them', () => {
    // New code: three refusals, each forbidden with the structured conflict naming how the person matched.
    expect(newRefusals).toHaveLength(3);
    for (const refusal of newRefusals) {
      expect(refusal.outcome).toBe('refused:forbidden');
      expect(refusal.code).toBe('forbidden');
    }
    expect(newRefusals.map(r => r.via)).toEqual(['contributor', 'same_principal', 'explicit']);
    // New code: the independent engineer and a no-policy control are granted, so the refusal comes from the policy.
    expect(newGrants).toEqual(['claimed', 'claimed']);
    // New code: the submit gate holds after a source contribution lands, and the lease is not released silently.
    expect(newSubmitRefusal?.code).toBe('forbidden');
    expect(newSubmitRefusal?.message).toContain('independence conflict');
    expect(newSubmitRefusal?.via).toBe('contributor');
    expect(newSubmitHeld).toMatchObject({ state: 'doing', currentEmployee: 'ir-indep' });
    // Deployed release: the same three people claim on the same data. This is the regression IR06 refused a rollback for.
    const regressions = oldOutcomes.filter(o => o.task !== 'independent engineer' && o.task !== 'no-policy control');
    expect(regressions).toHaveLength(3);
    for (const regression of regressions) expect(regression.outcome).toBe('claimed');
    // And the write path is unguarded too: a claim the deployed release granted also submits.
    expect(oldSubmit?.state).toBe('review');
    expect(oldOutcomes.find(o => o.task === 'independent engineer')?.outcome).toBe('claimed');
    expect(oldOutcomes.find(o => o.task === 'no-policy control')?.outcome).toBe('claimed');
  });

  test('forward recovery: the same data under the new code is refused again, with no data change', () => {
    // Switching back to code that carries the contract re-enforces the policy on the data as it stands.
    expect(recovery.contributor.outcome).toBe('refused:forbidden');
    expect(recovery.contributor.via).toBe('contributor');
    // The no-policy control is still granted, so the refusal is the policy and not a broken task or a stale lease.
    expect(recovery.control).toBe('claimed');
  });
});
