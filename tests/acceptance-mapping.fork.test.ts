// SYS-INT: versioned acceptance-mapping preview and authorized import, on the real company fork.
//
// Covered here: the registry classifies honestly (machine = the real CI baseline only), the preview is a zero-write
// dry-run that names every conflict, the import is gm-only under digest + version CAS with an audit row, and every
// bypass an auditor would try — executor/QA/eval authorization, a stale digest, a moved task version, an active
// lease, a done/void row, a downgrade of a required criterion, a second import over live criteria — is refused.
// Gated by RUN_SCK_WORKTREE_FORK_TESTS=1 (scripts/test-worktrees.ts sets it).
import { afterAll, beforeAll, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import {
  ACCEPTANCE_MAPPING_BUNDLES, ACCEPTANCE_MAPPING_KEY, ACCEPTANCE_MAPPING_SOURCE_KEY, SOURCE_CRITERIA, SYS_INT_GOAL_ID,
  SYS_REQUIRED_MAPPING, TOOL_CRITERIA, mappingBundle, mappingDigest,
} from '../src/acceptance-mapping.ts';
import { validateAcceptanceCriteria } from '../src/acceptance.ts';
import type { TaskView } from '../src/contracts.ts';

setDefaultTimeout(180_000);
const fork = process.env.RUN_SCK_WORKTREE_FORK_TESTS === '1' ? describe : describe.skip;
const NS = 'sck_acceptance_mapping_test';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
const credDir = mkdtempSync(join(tmpdir(), 'sck-acceptance-mapping-'));
const enrollment = new LocalEnrollmentAdmin(database);
const core = new SurrealCompanyCore(database);
const tokens: Record<string, string> = {};
const key = () => randomUUID();

const auditRows = async (taskId: string): Promise<Array<{ action: string }>> =>
  (await database.db.query<[Array<{ action: string; at?: unknown }>]>('SELECT action, at FROM audit WHERE task = $task;', { task: new RecordId('task', taskId) }))[0]
      ?.sort((left, right) => String(left.at ?? '').localeCompare(String(right.at ?? ''))) ?? [];
const taskRow = async (taskId: string): Promise<Record<string, unknown> | undefined> => {
  const rows = await database.db.query<[Array<Record<string, unknown>>]>('SELECT * FROM ONLY $task;', { task: new RecordId('task', taskId) });
  return (rows as unknown as Array<Record<string, unknown>>)?.[0];
};
const releaseKindTask = async (title: string): Promise<string> => {
  const id = randomUUID();
  await database.db.query(`CREATE ONLY $task CONTENT {
    title: $title, context: 'release 腿不支持映射导入', state: 'ready', kind: 'release', executor_role: 'engineering',
    reviewer_role: 'product', dependencies: [], version: 1, fence: 0, acceptance_legacy: true, acceptance_attempt: 0,
    created_at: time::now() };`, { task: new RecordId('task', id), title });
  return id;
};
const freshLegacyRow = async (title: string, version = 2, over: { executorRole?: string; goalId?: string } = {}): Promise<string> => {
  const id = randomUUID();
  await database.db.query(`CREATE ONLY $task CONTENT { title: $title, context: 'SYS-INT 夹具', state: 'ready',
    kind: 'task', executor_role: $executor_role, reviewer_role: 'engineering', dependencies: [], version: $version,
    fence: 0, acceptance_legacy: true, acceptance_attempt: 0, created_at: time::now()
    ${over.goalId ? ', goal: $goal' : ''} };`,
    { task: new RecordId('task', id), title, version, executor_role: over.executorRole ?? 'engineering',
      ...(over.goalId ? { goal: new RecordId('goal', over.goalId) } : {}) });
  return id;
};

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [name, role, caps] of [
    ['owner', 'owner', ['execute', 'review', 'manage']], ['eng', 'engineering', ['execute', 'review']],
    ['qa', 'qa', ['execute', 'review']], ['judge', 'eval', ['review']],
  ] as const) tokens[name] = await enrollment.enroll(`map-${name}`, role, caps);
}, 30_000);
afterAll(async () => { await database.close(); rmSync(credDir, { recursive: true, force: true }); });
beforeEach(async () => { await database.db.query('UPDATE employee SET active_task = NONE;'); });

fork('SYS-INT registry: honest classification and stable digests', () => {
  test('the tool bundle carries the real CI baseline verbatim; the source bundle borrows no other leg', () => {
    const tool = mappingBundle(ACCEPTANCE_MAPPING_KEY)!;
    expect(validateAcceptanceCriteria(tool.criteria).length).toBe(tool.criteria.length);
    const baseline = validateAcceptanceCriteria([{ id: 'AC-BASE-IMPL-1', kind: 'machine', required: true, layer: 'ci', evidence: 'ci-run', verify: 'ci', risk: 'code' }]);
    expect(tool.criteria.some(item => item.id === baseline[0]!.id && item.kind === 'machine' && item.evidence === 'ci-run')).toBe(true);
    const source = mappingBundle(ACCEPTANCE_MAPPING_SOURCE_KEY)!;
    expect(source.criteria.some(item => item.id.startsWith('AC-BASE-'))).toBe(false);
    expect(source.criteria.every(item => item.kind === 'human')).toBe(true);
  });

  test('the INT supplement is human sign-off only; prose never pretends to be machine-verified', () => {
    expect(TOOL_CRITERIA.length).toBe(8);
    for (const criterion of TOOL_CRITERIA) {
      expect(criterion.kind).toBe('human');
      expect(criterion.evidence).toBe('review-signoff');
      expect(criterion.verify).toBe('independent-review');
      expect(criterion.required).toBe(true);
    }
    const bundle = mappingBundle(ACCEPTANCE_MAPPING_KEY)!;
    expect(bundle.criteria.filter(item => item.kind === 'machine').every(item => item.id.startsWith('AC-BASE-'))).toBe(true);
  });

  test('the source bundle states the business INT01–08 plus per-SYS01–07 and the audited RB01 contract, all required', () => {
    expect(SOURCE_CRITERIA.length).toBe(16);
    for (const criterion of SOURCE_CRITERIA) {
      expect(criterion.kind).toBe('human');
      expect(criterion.required).toBe(true);
      expect(criterion.verify).toBe('qa-production');
    }
    const ids = SOURCE_CRITERIA.map(item => item.id);
    for (let n = 1; n <= 8; n++) expect(ids).toContain(`AC-SRC-INT-${n}`);
    for (const sys of ['SYS01', 'SYS02', 'SYS03', 'SYS04', 'SYS05', 'SYS06', 'SYS07', 'RB01']) expect(ids).toContain(`AC-SRC-${sys}`);
    const source = mappingBundle(ACCEPTANCE_MAPPING_SOURCE_KEY)!;
    expect(source.appliesTo).toMatchObject({ goalId: SYS_INT_GOAL_ID, executorRole: 'qa' });
    expect(source.coverage!.length).toBe(16);
    expect(source.coverage!.find(entry => entry.criteriaId === 'AC-SRC-INT-1')!.sys).toContain('DEPLOY');
    expect(source.coverage!.find(entry => entry.criteriaId === 'AC-SRC-RB01')!.sys).toHaveLength(7);
  });

  test('the per-SYS required mapping is complete over SYS01–07, has SYS03 and keeps the SYS06 RB01 coverage', () => {
    const systems = SYS_REQUIRED_MAPPING.map(item => item.sys);
    for (const sys of ['SYS01', 'SYS02', 'SYS03', 'SYS04', 'SYS05', 'SYS06', 'SYS07']) expect(systems).toContain(sys);
    expect(SYS_REQUIRED_MAPPING.find(item => item.sys === 'SYS06')!.rb01).toBe(true);
    expect(SYS_REQUIRED_MAPPING.find(item => item.sys === 'SYS03')!.rb01).toBe(true);
  });

  test('the digest binds key, version, audience and criteria; a registry change invalidates previews', () => {
    const bundle = mappingBundle(ACCEPTANCE_MAPPING_KEY)!;
    expect(mappingDigest(bundle)).toMatch(/^[0-9a-f]{64}$/);
    expect(mappingDigest(bundle)).toBe(mappingDigest(mappingBundle(ACCEPTANCE_MAPPING_KEY)!));
    expect(mappingDigest({ ...bundle, version: bundle.version + 1 })).not.toBe(mappingDigest(bundle));
    expect(mappingDigest({ ...bundle, appliesTo: { ...bundle.appliesTo!, executorRole: 'qa' } })).not.toBe(mappingDigest(bundle));
    expect(mappingDigest(mappingBundle(ACCEPTANCE_MAPPING_SOURCE_KEY)!)).not.toBe(mappingDigest(bundle));
  });
});

fork('SYS-INT import: preview is a zero-write dry-run and the import is gm-only, CAS- and digest-bound', () => {
  let taskId = '';
  let digest = '';
  let versionAtPreview = 0;
  const importInput = (over: Partial<{ taskId: string; expectedVersion: number; digest: string; idempotencyKey: string; mappingKey: string; reason: string }> = {}) => ({
    taskId: over.taskId ?? taskId, mappingKey: ACCEPTANCE_MAPPING_KEY, digest: over.digest ?? digest,
    expectedVersion: over.expectedVersion ?? versionAtPreview,
    reason: over.reason ?? 'SYS-INT：legacy 行按受审映射升级到版本化 criteria', idempotencyKey: over.idempotencyKey ?? key(),
  });

  beforeAll(async () => {
    const gate = await core.acceptanceGate(tokens.gm);
    if (gate.enabled) await core.setAcceptanceGate(tokens.gm, { enabled: false, reason: 'SYS-INT 测试：先建 legacy 行', expectedVersion: gate.version, idempotencyKey: key() });
    const legacy = await core.createTask(tokens.gm, { title: 'SYS-INT 映射导入目标', context: '门禁启用前创建的 legacy 行',
      executorRole: 'engineering', reviewerRole: 'engineering', idempotencyKey: key() });
    taskId = legacy.id;
    const enabled = await core.acceptanceGate(tokens.gm);
    if (!enabled.enabled) await core.setAcceptanceGate(tokens.gm, { enabled: true, reason: 'SYS-INT 测试：启用门禁', expectedVersion: enabled.version, idempotencyKey: key() });
    const preview = await core.acceptanceMappingPreview(tokens.eng, { taskId });
    expect(preview.legacy).toBe(true);
    expect(preview.conflicts).toEqual([]);
    digest = preview.proposal!.digest;
    versionAtPreview = (await taskRow(taskId))!.version as number;
  });

  test('the preview writes nothing: same task version, same audit rows', async () => {
    const auditsBefore = await auditRows(taskId);
    const before = await taskRow(taskId);
    const again = await core.acceptanceMappingPreview(tokens.gm, { taskId });
    expect(again.proposal!.digest).toBe(digest);
    expect(again.sysRequired.length).toBeGreaterThanOrEqual(8);
    expect((await taskRow(taskId))!.version).toBe(before!.version);
    expect(await auditRows(taskId)).toEqual(auditsBefore);
  });

  test('executor, qa and eval cannot import; only gm', async () => {
    await expect(core.acceptanceMappingImport(tokens.eng, importInput())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(core.acceptanceMappingImport(tokens.qa, importInput())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(core.acceptanceMappingImport(tokens.judge, importInput())).rejects.toMatchObject({ code: 'forbidden' });
    expect((await taskRow(taskId))!.version).toBe(versionAtPreview);
  });

  test('gm import succeeds once, is audited and idempotent, and the gate now judges the imported criteria', async () => {
    const imported: TaskView = await core.acceptanceMappingImport(tokens.gm, importInput({ idempotencyKey: 'sys-int-import-e7d08f27' }));
    const row = await taskRow(taskId);
    expect(row!.acceptance_legacy).toBe(false);
    expect((row!.acceptance_criteria as Array<{ id: string }>).map(item => item.id)).toContain('AC-MAP-8');
    expect(row!.version).toBe(versionAtPreview + 1);
    expect(imported.version).toBe(versionAtPreview + 1);
    expect((await auditRows(taskId)).some(entry => entry.action === 'acceptance_mapping_imported')).toBe(true);
    const replay = await core.acceptanceMappingImport(tokens.gm, importInput({ idempotencyKey: 'sys-int-import-e7d08f27' }));
    expect(replay.version).toBe(versionAtPreview + 1);
    await expect(core.acceptanceMappingImport(tokens.gm, importInput({ expectedVersion: versionAtPreview + 1, reason: '已有版本化 criteria 不得二次覆盖' })))
      .rejects.toMatchObject({ code: 'invalid' });
    const status = await core.acceptanceStatus(tokens.eng, { taskId });
    expect(status.verdict.legacy).toBe(false);
    expect(status.verdict.criteria.map(item => item.id)).toContain('AC-MAP-1');
    expect(status.verdict.ok).toBe(false);
    const unmet = new Set(status.verdict.unmet.map(item => item.acId));
    // Submit phase judges the machine criteria; the human sign-offs become unmet at the independent review.
    expect(unmet.has('AC-BASE-IMPL-1')).toBe(true);
    const intCriterion = status.verdict.criteria.find(item => item.id === 'AC-MAP-1');
    expect(intCriterion).toMatchObject({ kind: 'human', required: true, verify: 'independent-review' });
  });

  test('a stale digest and an unknown bundle are refused before anything else', async () => {
    await expect(core.acceptanceMappingImport(tokens.gm, importInput({ digest: 'f'.repeat(64), reason: '伪造 digest 必须被拒绝' })))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(core.acceptanceMappingImport(tokens.gm, importInput({ mappingKey: 'no-such-bundle', reason: '未知 bundle 必须被拒绝' })))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  test('a moved task version is refused by the CAS', async () => {
    const casId = await freshLegacyRow('CAS 陈旧版本夹具', 5);
    await expect(core.acceptanceMappingImport(tokens.gm, importInput({ taskId: casId, expectedVersion: 9, reason: '陈旧版本必须被 CAS 拒绝' })))
      .rejects.toThrow();
    expect(((await taskRow(casId))!.version as number)).toBe(5);
  });

  test('an occupied row is refused until its lease ends', async () => {
    const busyId = await freshLegacyRow('活动租约夹具', 2);
    await core.claim(tokens.eng, busyId);
    for (let attempt = 0; attempt < 40; attempt++) {
      const row = await taskRow(busyId);
      if (row?.current_employee && row?.state === 'doing') break;
      await Bun.sleep(50);
    }
    const leasedVersion = (await taskRow(busyId))!.version as number;
    await expect(core.acceptanceMappingImport(tokens.gm, importInput({ taskId: busyId, expectedVersion: leasedVersion, reason: '活动租约未结束，导入必须被拒绝' })))
      .rejects.toMatchObject({ code: 'conflict' });
    const preview = await core.acceptanceMappingPreview(tokens.gm, { taskId: busyId });
    expect(preview.conflicts).toContain('occupied');
  });

  test('a done row is never rewritten; release legs are unsupported', async () => {
    const doneId = await freshLegacyRow('已完成历史', 3);
    await database.db.query('UPDATE ONLY $task SET state = "done";', { task: new RecordId('task', doneId) });
    await expect(core.acceptanceMappingImport(tokens.gm, importInput({ taskId: doneId, expectedVersion: 3, reason: 'done/void 历史结论不得改写' })))
      .rejects.toMatchObject({ code: 'invalid' });
    const releaseId = await releaseKindTask('release 腿任务');
    const releasePreview = await core.acceptanceMappingPreview(tokens.gm, { taskId: releaseId });
    expect(releasePreview.proposal).toBeUndefined();
    expect(releasePreview.conflicts).toContain('unsupported-leg');
  });

  test('a legacy row carrying a required criterion the bundle lacks is a downgrade and is refused', async () => {
    const downId = await freshLegacyRow('带额外 required 的 legacy 行', 2);
    await database.db.query(`UPDATE ONLY $task SET acceptance_criteria =
      [{ id: 'AC-9', kind: 'human', required: true, layer: 'manual', evidence: 'review-signoff', verify: 'independent-review', risk: 'runtime' }];`,
      { task: new RecordId('task', downId) });
    const preview = await core.acceptanceMappingPreview(tokens.gm, { taskId: downId });
    expect(preview.conflicts).toContain('downgrade:AC-9');
    await expect(core.acceptanceMappingImport(tokens.gm, importInput({ taskId: downId, expectedVersion: 2, reason: '删除 required 项的导入必须被拒绝' })))
      .rejects.toMatchObject({ code: 'invalid' });
    expect(((await taskRow(downId))!.version as number)).toBe(2);
  });
});

fork('SYS-INT source bundle: audience-bound business QA contract for the SYS-INT goal', () => {
  let qaTaskId = '';
  let sourceDigest = '';
  let qaVersionAtPreview = 0;
  const sourceInput = (over: Partial<{ taskId: string; expectedVersion: number; digest: string; idempotencyKey: string; mappingKey: string; reason: string }> = {}) => ({
    taskId: over.taskId ?? qaTaskId, mappingKey: over.mappingKey ?? ACCEPTANCE_MAPPING_SOURCE_KEY,
    digest: over.digest ?? sourceDigest, expectedVersion: over.expectedVersion ?? qaVersionAtPreview,
    reason: over.reason ?? 'SYS-INT：源 QA 行按受审业务契约升级到版本化 criteria', idempotencyKey: over.idempotencyKey ?? key(),
  });

  beforeAll(async () => {
    qaTaskId = await freshLegacyRow('SYS-INT 源 QA 行', 2, { executorRole: 'qa', goalId: SYS_INT_GOAL_ID });
    const preview = await core.acceptanceMappingPreview(tokens.gm, { taskId: qaTaskId });
    expect(preview.proposal!.key).toBe(ACCEPTANCE_MAPPING_SOURCE_KEY);
    expect(preview.conflicts).toEqual([]);
    sourceDigest = preview.proposal!.digest;
    qaVersionAtPreview = (await taskRow(qaTaskId))!.version as number;
  });

  test('the preview shows the business contract with traceable coverage and no borrowed machine baseline', async () => {
    const preview = await core.acceptanceMappingPreview(tokens.qa, { taskId: qaTaskId });
    expect(preview.proposal!.criteria.every(item => item.kind === 'human' && item.required)).toBe(true);
    expect(preview.proposal!.coverage!.length).toBe(16);
    expect(preview.proposal!.coverage!.find(entry => entry.criteriaId === 'AC-SRC-INT-7')!.sys).toEqual(['SYS02', 'SYS03']);
    expect(preview.sysRequired.map(item => item.sys)).toContain('SYS03');
    expect(preview.proposal!.appliesTo).toMatchObject({ goalId: SYS_INT_GOAL_ID, executorRole: 'qa' });
  });

  test('a wrong bundle for a mismatched source task is refused before anything else', async () => {
    await expect(core.acceptanceMappingImport(tokens.gm, sourceInput({ mappingKey: ACCEPTANCE_MAPPING_KEY })))
      .rejects.toMatchObject({ code: 'invalid' });
    const engRow = await freshLegacyRow('工程行误用源 bundle', 2);
    await expect(core.acceptanceMappingImport(tokens.gm, sourceInput({ taskId: engRow })))
      .rejects.toMatchObject({ code: 'invalid' });
    const otherGoal = await freshLegacyRow('别的目标的 QA 行', 2, { executorRole: 'qa', goalId: 'not-the-sys-int-goal' });
    const foreign = await core.acceptanceMappingPreview(tokens.gm, { taskId: otherGoal });
    expect(foreign.conflicts).toContain('unsupported-leg');
    await expect(core.acceptanceMappingImport(tokens.gm, sourceInput({ taskId: otherGoal })))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  test('executor and qa cannot self-import; gm imports once under CAS, audited and idempotent', async () => {
    await expect(core.acceptanceMappingImport(tokens.eng, sourceInput())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(core.acceptanceMappingImport(tokens.qa, sourceInput())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(core.acceptanceMappingImport(tokens.judge, sourceInput())).rejects.toMatchObject({ code: 'forbidden' });
    const imported: TaskView = await core.acceptanceMappingImport(tokens.gm, sourceInput({ idempotencyKey: 'sys-int-source-import' }));
    const row = await taskRow(qaTaskId);
    expect(row!.acceptance_legacy).toBe(false);
    const ids = (row!.acceptance_criteria as Array<{ id: string }>).map(item => item.id);
    expect(ids).toContain('AC-SRC-INT-1');
    expect(ids).toContain('AC-SRC-SYS03');
    expect(ids).toContain('AC-SRC-RB01');
    expect(row!.version).toBe(qaVersionAtPreview + 1);
    expect(imported.version).toBe(qaVersionAtPreview + 1);
    expect((await auditRows(qaTaskId)).some(entry => entry.action === 'acceptance_mapping_imported')).toBe(true);
    const replay = await core.acceptanceMappingImport(tokens.gm, sourceInput({ idempotencyKey: 'sys-int-source-import' }));
    expect(replay.version).toBe(qaVersionAtPreview + 1);
    await expect(core.acceptanceMappingImport(tokens.gm, sourceInput({ expectedVersion: qaVersionAtPreview + 1, reason: '业务契约不得二次覆盖' })))
      .rejects.toMatchObject({ code: 'invalid' });
    const status = await core.acceptanceStatus(tokens.qa, { taskId: qaTaskId });
    expect(status.verdict.legacy).toBe(false);
    expect(status.verdict.criteria.map(item => item.id)).toContain('AC-SRC-INT-8');
  });
});
