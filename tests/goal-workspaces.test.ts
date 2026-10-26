import { expect, test } from 'bun:test';
import { world } from './dispatcher-sidecar.test.ts';

test('goal agents launch at the repository root with private comm and an explicit goal scope', async () => {
  const w = world();
  w.addTask('goal-task', { worktreePath: '/repo-task-goal-task' });
  Object.assign(w.rows[0], { goalId: 'goal-a', goalTitle: '优化目标' });
  await w.dispatcher().tick();
  const inst = w.instances[0];
  expect(inst.cwd).toBe('/repo');
  expect(inst.workspaceScope).toBe('goal-a');
  expect(w.envs.get(inst.paseoAgentId!)!.SCK_COMM_DIR).toBe(w.pool.commDirFor(inst.id));
  expect(w.views.get('goal-task')!.currentEmployee).toBe(inst.id);
});

test('different goals in one repository get independent seats, never reuse each other', async () => {
  const w = world();
  w.def.maxInstances = 1;
  w.addTask('a', { worktreePath: '/repo-task-a' });
  w.addTask('b', { worktreePath: '/repo-task-b' });
  Object.assign(w.rows[0], { goalId: 'goal-a', reviewerRole: 'owner' });
  Object.assign(w.rows[1], { goalId: 'goal-b', reviewerRole: 'owner' });
  w.views.get('a')!.reviewerRole = 'owner';
  w.views.get('b')!.reviewerRole = 'owner';
  await w.dispatcher().tick();
  expect(w.instances.map(i => i.workspaceScope).sort()).toEqual(['goal-a', 'goal-b']);
  expect(w.views.get('a')!.currentEmployee).not.toBe(w.views.get('b')!.currentEmployee);
});

test('goal agents retain identity and conversation across worktree moves and context rotation thresholds', async () => {
  const w = world();
  w.addTask('a', { worktreePath: '/repo-task-a' });
  Object.assign(w.rows[0], { goalId: 'goal-a' });
  await w.dispatcher().tick();
  const inst = w.instances[0];
  // Finish the first lease through the real sidecar fixture before assigning the next scene.
  await w.pool.releaseClaim(inst.id, 'a', 'fixture handoff');
  w.rows.splice(0, 1);
  w.agents.set(inst.paseoAgentId!, { id: inst.paseoAgentId!, status: 'idle' });
  inst.wakeCount = 999;
  inst.idleSince = 1;
  w.setConfig({ sessionMaxWakes: 1, sessionIdleMinutes: 1 });
  w.addTask('b', { worktreePath: '/repo-task-b' });
  Object.assign(w.rows[0], { goalId: 'goal-a' });
  const result = await w.dispatcher().tick();
  expect(result.retired).not.toContain(inst.id);
  expect(w.instances).toHaveLength(1);
  expect(w.events).toContain(`send:${inst.paseoAgentId}`);
  expect(w.views.get('b')!.currentEmployee).toBe(inst.id);
});

test('plugin adoption keeps a goal agent and its in-flight lease in place', async () => {
  const w = world();
  w.addTask('a', { worktreePath: '/repo-task-a' });
  Object.assign(w.rows[0], { goalId: 'goal-a' });
  await w.dispatcher().tick();
  const before = { ...w.instances[0] };
  await w.restart();
  const result = await w.dispatcher().tick();
  expect(result.retired).not.toContain(before.id);
  expect(w.views.get('a')!.currentEmployee).toBe(before.id);
  expect(w.instances[0]).toMatchObject({ paseoAgentId: before.paseoAgentId, cwd: '/repo', workspaceScope: 'goal-a' });
});

for (const failure of ['error', 'lost-channel'] as const) {
  test(`a ${failure} revokes a goal employee without archiving its conversation or workspace`, async () => {
    const w = world();
    w.addTask('a', { worktreePath: '/repo-task-a' });
    Object.assign(w.rows[0], { goalId: 'goal-a' });
    await w.dispatcher().tick();
    const inst = w.instances[0];
    await w.pool.releaseClaim(inst.id, 'a', 'fixture handoff');
    w.rows.splice(0, 1);
    w.agents.set(inst.paseoAgentId!, { id: inst.paseoAgentId!, status: failure === 'error' ? 'error' : 'idle' });
    if (failure === 'lost-channel') w.pool.detachAgent(inst.paseoAgentId!);
    w.setLastError('fixture internal fault');
    const result = await w.dispatcher().tick();
    expect(result.retired).toContain(inst.id);
    expect(w.events.some(e => e.startsWith('archive:'))).toBe(false);
    expect(w.pool.canReuse(inst)).toBe(false);
  });
}

test('a new maintenance task cannot borrow a legacy employee workspace', async () => {
  const w = world();
  const old = { id: 'legacy-seat', def: w.def.id, role: w.def.role, provider: w.def.provider, model: w.def.model,
    credential: 'legacy-fixture', paseoAgentId: 'legacy-agent', repoHome: '/repo' };
  w.instances.push(old);
  w.pool.env({ ...old, paseoAgentId: undefined }); w.pool.bindAgent(old.id, old.paseoAgentId);
  w.agents.set(old.paseoAgentId, { id: old.paseoAgentId, status: 'idle' });
  w.addTask('new-maintenance', { worktreePath: '/repo-task-new' });
  w.rows[0].reviewerRole = 'owner';
  await w.dispatcher().tick();
  expect(w.views.get('new-maintenance')!.currentEmployee).not.toBe(old.id);
  expect(w.instances.find(i => i.id !== old.id)!.workspaceScope).toBe('maintenance');
});
