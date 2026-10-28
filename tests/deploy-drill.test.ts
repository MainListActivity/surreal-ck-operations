import { expect, test } from 'bun:test';
import { validateDrillPlan, DRILL_PORT_MIN, DRILL_PORT_MAX, type DrillHostContext } from '../src/deploy-drill.ts';

const baseCtx = (over: Partial<DrillHostContext> = {}): DrillHostContext => {
  const taken = new Set<number>();
  return {
    serviceHome: '/fixture/service-home',
    existingRun: () => undefined,
    commitExists: async () => true,
    isAncestor: async () => true,
    portFree: async port => {
      if (taken.has(port)) return false;
      taken.add(port);
      return true;
    },
    ...over,
  };
};
const UUID = '0f1e2d3c-4b5a-4968-8776-657483920abc';
const BASE = 'a'.repeat(40);
const CANDIDATE = 'b'.repeat(40);

test('drill plan: canonical construction and happy path', async () => {
  const plan = await validateDrillPlan({ runId: UUID, baseSha: BASE, candidateSha: CANDIDATE }, baseCtx());
  expect(plan.root).toBe('/fixture/service-home/drills/' + UUID);
  expect(Number(plan.mcpPort)).toBeGreaterThanOrEqual(DRILL_PORT_MIN);
  expect(Number(plan.mcpPort)).toBeLessThanOrEqual(DRILL_PORT_MAX);
  expect(plan.mcpPort).not.toBe(plan.dbPort);
  expect(plan.namespace).toMatch(/^sck_drill_[0-9a-z]+$/);
});

test('drill plan rejects: malformed runId, non-40-hex sha, identical base and candidate', async () => {
  for (const bad of ['not-a-uuid', `${UUID}x`, '../../etc']) {
    await expect(validateDrillPlan({ runId: bad, baseSha: BASE, candidateSha: CANDIDATE }, baseCtx())).rejects.toMatchObject({ code: 'invalid' });
  }
  await expect(validateDrillPlan({ runId: UUID, baseSha: 'zz', candidateSha: CANDIDATE }, baseCtx())).rejects.toMatchObject({ code: 'invalid' });
  await expect(validateDrillPlan({ runId: UUID, baseSha: BASE, candidateSha: BASE }, baseCtx())).rejects.toMatchObject({ code: 'invalid' });
});

test('drill plan rejects: unknown commits and a candidate that is not a descendant', async () => {
  const ctx = baseCtx({ commitExists: async sha => sha === BASE || sha === CANDIDATE });
  await expect(validateDrillPlan({ runId: UUID, baseSha: 'c'.repeat(40), candidateSha: CANDIDATE }, ctx)).rejects.toMatchObject({ code: 'invalid' });
  const backward = baseCtx({ isAncestor: async () => false });
  await expect(validateDrillPlan({ runId: UUID, baseSha: BASE, candidateSha: CANDIDATE }, backward)).rejects.toMatchObject({ code: 'invalid' });
});

test('drill plan rejects: replay of an existing runId', async () => {
  const ctx = baseCtx({ existingRun: () => ({ status: 'passed' }) });
  await expect(validateDrillPlan({ runId: UUID, baseSha: BASE, candidateSha: CANDIDATE }, ctx)).rejects.toMatchObject({ code: 'conflict' });
  const incomplete = baseCtx({ existingRun: () => ({ status: 'incomplete' }) });
  await expect(validateDrillPlan({ runId: UUID, baseSha: BASE, candidateSha: CANDIDATE }, incomplete)).rejects.toMatchObject({ code: 'conflict' });
});

test('drill plan rejects when the whole dedicated port range is busy', async () => {
  const ctx = baseCtx({ portFree: async () => false });
  await expect(validateDrillPlan({ runId: UUID, baseSha: BASE, candidateSha: CANDIDATE }, ctx)).rejects.toMatchObject({ code: 'temporarily_unavailable' });
});

/** AC05: no caller input can name a production path, port or namespace — every target comes from the runId. */
test('drill plan cannot express a production target', async () => {
  const plan = await validateDrillPlan({ runId: UUID, baseSha: BASE, candidateSha: CANDIDATE }, baseCtx());
  // Every path is constructed under the drill root and nothing else; the caller supplied only the runId.
  for (const path of [plan.root, plan.releasesRoot, plan.logsRoot, plan.stagesRoot, plan.dbPath]) {
    expect(path.startsWith(`${'/fixture/service-home'}/drills/${UUID}`)).toBe(true);
  }
  // Ports are inside the drill range and distinct from the production MCP/DB ports.
  for (const port of [Number(plan.mcpPort), Number(plan.dbPort)]) {
    expect(port).toBeGreaterThanOrEqual(DRILL_PORT_MIN);
    expect(port).toBeLessThanOrEqual(DRILL_PORT_MAX);
  }
  // The namespace is derived and prefixed, so a drill cannot land in the production company namespace.
  expect(plan.namespace.startsWith('sck_drill_')).toBe(true);
  expect(plan.namespace).not.toBe('sck_agent_company');
  // A runId shaped like a path or an absolute target is refused before any path is built.
  for (const bad of ['/Users/y/IdeaProjects/surreal-ck-operations', '../../releases', `${UUID}/../../x`]) {
    await expect(validateDrillPlan({ runId: bad, baseSha: BASE, candidateSha: CANDIDATE }, baseCtx())).rejects.toMatchObject({ code: 'invalid' });
  }
});
